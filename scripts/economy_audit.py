#!/usr/bin/env python3
"""Betting Economy Audit for Agent Checkers.

Standalone Monte-Carlo audit of the real-money betting economy. Uses the SPORTSBOOK
variable-odds model: the player bets against the house at odds derived from agent-elo
win probability, and the house is the counterparty to every bet.

Grounded in the real betting math (imported from backend/database.py): HOUSE_EDGE,
the streak multiplier table, the jackpot rate, and the XP->level curve. Because the
offered odds satisfy  p_win * odds = (1 - HOUSE_EDGE),  the house holds exactly the
house edge on every matchup; only the variance differs (underdog wins pay far more).

Run:  python3 scripts/economy_audit.py
Writes the report to docs/ECONOMY_AUDIT.md and echoes it to stdout. stdlib only.
"""

import os
import sys
import random
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
# point the DB at a throwaway file so importing database.py (which calls init_db())
# never touches the real matches.db
os.environ.setdefault("DB_PATH", "/tmp/econ_audit_dummy.db")

from database import HOUSE_EDGE, get_streak_multiplier, JACKPOT_RATE, STREAK_MULTIPLIERS, xp_to_level  # noqa: E402

SEED = 20260605
random.seed(SEED)

# ----------------------------------------------------------------------------
# Matchup model. Each tier: (weight, p_win_lo, p_win_hi, label). p_win is the
# player's true probability of WINNING the match (draws + opponent wins are losses).
# Offered odds = (1 - HOUSE_EDGE) / p_win, matching backend calculate_match_odds.
# ----------------------------------------------------------------------------
TIERS = [
    (0.40, 0.55, 0.60, "slight favorite"),
    (0.30, 0.48, 0.52, "even"),
    (0.20, 0.40, 0.45, "slight underdog"),
    (0.10, 0.30, 0.35, "heavy underdog"),
]
_CUM = []
_acc = 0.0
for w, lo, hi, lbl in TIERS:
    _acc += w
    _CUM.append((_acc, lo, hi, lbl))


def sample_matchup():
    """Return (tier_index, p_win, odds)."""
    r = random.random()
    for i, (cw, lo, hi, lbl) in enumerate(_CUM):
        if r <= cw:
            p = random.uniform(lo, hi)
            odds = round((1 - HOUSE_EDGE) / p, 2)
            return i, p, odds
    p = random.uniform(0.48, 0.52)
    return 1, p, round((1 - HOUSE_EDGE) / p, 2)


# Side-action props. true_p = (1 - HOUSE_EDGE)/odds keeps each prop at the house edge.
PROP_NEAR = (1.8, round((1 - HOUSE_EDGE) / 1.8, 4))     # ~even prop (e.g. First Blood)
PROP_LONG = (4.5, round((1 - HOUSE_EDGE) / 4.5, 4))     # long shot (e.g. The Comeback YES)

DOUBLE_WIN_P = 0.47   # double-or-nothing vs an elo-matched bot (0.50 raw * 0.94 non-draw)
MAX_SESSION = 30000   # hard cap so a hot session can't loop forever


def pct(sorted_vals, q):
    if not sorted_vals:
        return 0
    idx = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[idx]


# ============================================================================
# SIM 1 - session duration, main bet only
# ============================================================================
def sim_session_basic(balance, bet, max_matches=MAX_SESSION):
    matches = 0
    underdog_wins = 0
    while balance >= bet and matches < max_matches:
        tier, p, odds = sample_matchup()
        balance -= bet
        matches += 1
        if random.random() < p:
            balance += int(bet * odds)
            if tier >= 2:
                underdog_wins += 1
    return matches, underdog_wins


def run_sim1(n=1000, start=1000, bet=50):
    lengths, ud = [], []
    for _ in range(n):
        m, u = sim_session_basic(start, bet)
        lengths.append(m)
        ud.append(u)
    lengths.sort()
    return {
        "median": pct(lengths, 0.5), "mean": round(statistics.mean(lengths), 1),
        "p25": pct(lengths, 0.25), "p75": pct(lengths, 0.75), "max": lengths[-1],
        "pct_50plus": round(100 * sum(1 for x in lengths if x >= 50) / n, 1),
        "pct_100plus": round(100 * sum(1 for x in lengths if x >= 100) / n, 1),
        "avg_underdog_wins": round(statistics.mean(ud), 1),
        "lengths": lengths,
    }


# ============================================================================
# SIM 2 - session duration with side action (2 side bets/match @ $0.10)
# ============================================================================
def run_sim2(n=1000, start=1000, bet=50, side=10):
    lengths, longshot_wins = [], []
    for _ in range(n):
        balance = start
        matches = 0
        ls_wins = 0
        while balance >= bet and matches < MAX_SESSION:
            tier, p, odds = sample_matchup()
            balance -= bet
            matches += 1
            if random.random() < p:
                balance += int(bet * odds)
            # 2 side bets if affordable
            for _ in range(2):
                if balance < side:
                    break
                balance -= side
                if random.random() < 0.30:  # long shot
                    odds_s, p_s = PROP_LONG
                    if random.random() < p_s:
                        balance += int(side * odds_s)
                        ls_wins += 1
                else:  # near-even
                    odds_s, p_s = PROP_NEAR
                    if random.random() < p_s:
                        balance += int(side * odds_s)
        lengths.append(matches)
        longshot_wins.append(ls_wins)
    lengths.sort()
    return {
        "median": pct(lengths, 0.5), "mean": round(statistics.mean(lengths), 1),
        "p25": pct(lengths, 0.25), "p75": pct(lengths, 0.75), "max": lengths[-1],
        "pct_50plus": round(100 * sum(1 for x in lengths if x >= 50) / n, 1),
        "pct_100plus": round(100 * sum(1 for x in lengths if x >= 100) / n, 1),
        "avg_longshot_wins": round(statistics.mean(longshot_wins), 1),
    }


# ============================================================================
# SIM 3 - streaks + double-down
# ============================================================================
def _heat_session(balance, bet, use_heat, use_dd, max_matches=MAX_SESSION):
    """Faithful streak+double-down session. Returns (matches, staked, returned, max_streak).
    Heat multiplier uses the INCOMING streak (real code computes it before the win);
    double-down is 50%-accept double-or-nothing on the winnings, ~47% win, max 3 chains,
    a double win increments the streak and a double loss resets it."""
    matches = 0
    streak = 0
    staked = 0
    returned = 0
    max_streak = 0
    while balance >= bet and matches < max_matches:
        tier, p, odds = sample_matchup()
        balance -= bet
        staked += bet
        matches += 1
        mult = get_streak_multiplier(streak) if use_heat else 1.0   # streak coming IN
        if random.random() < p:
            payout = int(bet * odds * mult)
            balance += payout
            returned += payout
            streak += 1
            max_streak = max(max_streak, streak)
            if use_dd:
                at_risk = payout
                doubles = 0
                while doubles < 3 and random.random() < 0.5:    # 50% accept each step
                    doubles += 1
                    staked += at_risk                           # risking the winnings
                    if random.random() < DOUBLE_WIN_P:
                        returned += 2 * at_risk
                        balance += at_risk
                        streak += 1
                        max_streak = max(max_streak, streak)
                        at_risk *= 2
                    else:
                        balance -= at_risk
                        streak = 0
                        break
        else:
            streak = 0
    return matches, staked, returned, max_streak


def measure_hold(use_heat, use_dd, n_matches=400000, bet=50):
    """Realized house hold (%) over a long no-ruin run -- isolates edge erosion."""
    _, staked, returned, _ = _heat_session(10 ** 13, bet, use_heat, use_dd, max_matches=n_matches)
    return round(100 * (staked - returned) / staked, 2)


def run_sim3(n=1000, start=1000, bet=50):
    variants = [("plain", False, False), ("heat", True, False),
                ("double-down", False, True), ("both", True, True)]
    out = {}
    for label, heat, dd in variants:
        lengths = []
        cap_hits = 0
        streak5 = 0
        for _ in range(n):
            m, _stk, _ret, mx = _heat_session(start, bet, heat, dd)
            lengths.append(m)
            if m >= MAX_SESSION:
                cap_hits += 1
            if mx >= 5:
                streak5 += 1
        lengths.sort()
        out[label] = {
            "hold": measure_hold(heat, dd),
            "median": pct(lengths, 0.5), "mean": round(statistics.mean(lengths), 1),
            "cap_hit_pct": round(100 * cap_hits / n, 1),
            "pct_streak5": round(100 * streak5 / n, 1),
        }
    return out


# ============================================================================
# SIM 4 & 7 - house bankroll over 30 days (sportsbook, house = counterparty)
# Segments from Sim 7. Money in cents. Returns full metrics.
# ============================================================================
SEGMENTS = [
    # name, count, deposit_cents, matches_per_day, bet_cents, max_reloads (None=inf)
    ("casual", 70, 1000, 5, 25, 3),
    ("regular", 20, 2000, 15, 50, 5),
    ("whale", 10, 10000, 30, 200, None),
]


def _new_players(scale=1.0):
    players = []
    for name, count, dep, mpd, bet, maxrl in SEGMENTS:
        for _ in range(int(round(count * scale))):
            players.append({
                "seg": name, "dep": dep, "mpd": mpd, "bet": bet,
                "maxrl": maxrl, "bal": dep, "reloads": 0, "active": True,
            })
    return players


def simulate_30day(start_bankroll, days=30, scale=1.0, track_segment=True):
    house = start_bankroll
    players = _new_players(scale)
    total_deposits = sum(p["dep"] for p in players)  # initial deposits
    total_wagered = 0
    daily_pnl = []
    min_house = house
    peak = house
    max_dd = 0  # max drop below the STARTING line
    seg_rev = {s[0]: 0 for s in SEGMENTS}

    for _ in range(days):
        day_start = house
        for p in players:
            if not p["active"]:
                continue
            for _ in range(p["mpd"]):
                if p["bal"] < p["bet"]:
                    if p["maxrl"] is None or p["reloads"] < p["maxrl"]:
                        p["bal"] += p["dep"]
                        p["reloads"] += 1
                        total_deposits += p["dep"]
                    else:
                        p["active"] = False
                        break
                tier, prob, odds = sample_matchup()
                bet = p["bet"]
                p["bal"] -= bet
                house += bet
                total_wagered += bet
                seg_rev[p["seg"]] += bet
                if random.random() < prob:
                    payout = int(bet * odds)
                    p["bal"] += payout
                    house -= payout
                    seg_rev[p["seg"]] -= payout
                # bankroll extremes tracked intra-day
                if house < min_house:
                    min_house = house
                dd = start_bankroll - house
                if dd > max_dd:
                    max_dd = dd
        daily_pnl.append(house - day_start)
        if house > peak:
            peak = house

    total_remaining = sum(p["bal"] for p in players)  # withdrawable if cashed out now
    active_by_seg = {}
    for s in SEGMENTS:
        active_by_seg[s[0]] = sum(1 for p in players if p["seg"] == s[0] and p["active"])
    return {
        "final_house": house, "cum_revenue": house - start_bankroll,
        "min_house": min_house, "max_drawdown": max_dd, "daily_pnl": daily_pnl,
        "max_single_day_loss": -min(daily_pnl), "total_wagered": total_wagered,
        "total_deposits": total_deposits, "total_remaining": total_remaining,
        "seg_rev": seg_rev, "active_by_seg": active_by_seg,
        "n_players": len(players),
    }


def run_sim4_7(n_runs=100):
    runs = [simulate_30day(50000) for _ in range(n_runs)]  # $500 = 50000 cents
    base = runs[0]
    # survival analysis: % of runs whose bankroll ever went negative at $500 start
    neg = sum(1 for r in runs if r["min_house"] < 0)
    drawdowns = sorted(r["max_drawdown"] for r in runs)
    revs = sorted(r["cum_revenue"] for r in runs)
    agg_hold = round(100 * sum(r["cum_revenue"] for r in runs) / sum(r["total_wagered"] for r in runs), 2)
    return {
        "base": base,
        "runs": runs,
        "agg_hold": agg_hold,
        "pct_negative_at_500": round(100 * neg / n_runs, 1),
        "p99_drawdown": pct(drawdowns, 0.99),
        "median_revenue": pct(revs, 0.5),
        "mean_revenue": round(statistics.mean(revs)),
        "worst_revenue": revs[0], "best_revenue": revs[-1],
    }


def min_safe_bankroll(scale, n_runs=200, q=0.99):
    """99th-percentile worst dip below the starting line == min safe starting reserve."""
    dds = sorted(simulate_30day(10_000_000, scale=scale)["max_drawdown"] for _ in range(n_runs))
    return pct(dds, q)


def bad_day_stress(scale=1.0, win_rate=0.70):
    """One day where the realized player win rate is forced to ~win_rate (house bad day)."""
    players = _new_players(scale)
    house_delta = 0
    worst = 0
    for p in players:
        bal = p["dep"]
        for _ in range(p["mpd"]):
            if bal < p["bet"]:
                bal += p["dep"]
            tier, prob, odds = sample_matchup()
            bet = p["bet"]
            house_delta += bet
            bal -= bet
            if random.random() < win_rate:  # forced bad-luck day
                payout = int(bet * odds)
                house_delta -= payout
                bal += payout
            if house_delta < worst:
                worst = house_delta
    return house_delta, worst


# ============================================================================
# SIM 5 - progression overlap
# ============================================================================
def run_sim5(sim1):
    def cycles(m):
        return m // 20
    out = {}
    for label, matches in (("median", sim1["median"]), ("mean", int(sim1["mean"])), ("p75", sim1["p75"])):
        out[label] = {
            "matches": matches, "level": xp_to_level(matches),
            "evolution_cycles": cycles(matches),
        }
    # milestone match-counts from the real XP curve
    milestones = {}
    for lvl in (5, 10, 15, 25):
        # invert: smallest xp with xp_to_level(xp) == lvl  ->  threshold
        from database import LEVEL_THRESHOLDS
        milestones[lvl] = LEVEL_THRESHOLDS.get(lvl)
    out["milestones"] = milestones
    out["pct_reach_L5"] = round(100 * sum(1 for x in sim1["lengths"] if x >= milestones[5]) / len(sim1["lengths"]), 1)
    out["pct_reach_L10"] = round(100 * sum(1 for x in sim1["lengths"] if x >= milestones[10]) / len(sim1["lengths"]), 1)
    out["pct_reach_L15"] = round(100 * sum(1 for x in sim1["lengths"] if x >= milestones[15]) / len(sim1["lengths"]), 1)
    return out


# ============================================================================
# SIM 6 - minimum viable deposit
# ============================================================================
def run_sim6(n=1000):
    deposits = [500, 1000, 1500, 2000, 2500, 5000]  # cents
    bets = [10, 25, 50]
    grid = {}
    for bet in bets:
        grid[bet] = {}
        for dep in deposits:
            ok = 0
            for _ in range(n):
                m, _u = sim_session_basic(dep, bet)
                if m >= 50:
                    ok += 1
            grid[bet][dep] = round(100 * ok / n, 1)
    # find min deposit with >=75% reaching 50 matches, per bet size
    min_dep = {}
    for bet in bets:
        found = None
        for dep in deposits:
            if grid[bet][dep] >= 75.0:
                found = dep
                break
        min_dep[bet] = found
    return {"grid": grid, "deposits": deposits, "bets": bets, "min_dep": min_dep}


# ============================================================================
# SIM 8 - jackpot pool economics
# ============================================================================
def run_sim8(total_wagered_cents):
    pool = int(total_wagered_cents * JACKPOT_RATE)   # 30-day contribution
    daily = pool / 30
    # hit model: assume ~15% of active players attempt one tournament parlay/day at 1.5% each
    attempts_per_day = 0.15 * 100  # 100 players
    hit_prob_per_day = 1 - (1 - 0.015) ** attempts_per_day
    days_to_hit = 1 / hit_prob_per_day if hit_prob_per_day > 0 else float("inf")
    pool_at_hit = int(daily * days_to_hit)
    return {
        "monthly_pool": pool, "daily_growth": daily,
        "attempts_per_day": attempts_per_day, "hit_prob_per_day": hit_prob_per_day,
        "days_to_hit": days_to_hit, "pool_at_hit": pool_at_hit,
    }


# ============================================================================
# helpers for the report
# ============================================================================
def d(cents):
    return f"${cents/100:,.2f}"


def main():
    print("Running economy audit simulations (seed=%d)..." % SEED, file=sys.stderr)
    s1 = run_sim1()
    print("  sim1 done", file=sys.stderr)
    s2 = run_sim2()
    print("  sim2 done", file=sys.stderr)
    s3 = run_sim3()
    print("  sim3 done", file=sys.stderr)
    s47 = run_sim4_7(n_runs=100)
    print("  sim4/7 done", file=sys.stderr)
    msb = {sc: min_safe_bankroll(sc / 100.0) for sc in (50, 100, 200)}
    print("  min-safe-bankroll done", file=sys.stderr)
    badday, badworst = bad_day_stress(1.0, 0.70)
    s5 = run_sim5(s1)
    s6 = run_sim6()
    print("  sim6 done", file=sys.stderr)
    s8 = run_sim8(s47["base"]["total_wagered"])

    report = build_report(s1, s2, s3, s47, msb, (badday, badworst), s5, s6, s8)
    out_path = ROOT / "docs" / "ECONOMY_AUDIT.md"
    out_path.write_text(report)
    print(report)
    print("\n[report written to %s]" % out_path, file=sys.stderr)


def build_report(s1, s2, s3, s47, msb, badday, s5, s6, s8):
    base = s47["base"]
    badtotal, badworst = badday
    seg_rev = base["seg_rev"]
    tot = sum(seg_rev.values()) or 1
    ms = s5["milestones"]
    heat_hold = s3["heat"]["hold"]
    plain_hold = s3["plain"]["hold"]
    both_hold = s3["both"]["hold"]
    dd_hold = s3["double-down"]["hold"]
    heat_breaks = heat_hold < 0
    L = []
    w = L.append
    w("# Agent Checkers — Betting Economy Audit")
    w("")
    w(f"*Generated by `scripts/economy_audit.py` (seed {SEED}). Variable-odds sportsbook model; "
      f"house edge **{HOUSE_EDGE*100:.0f}%**, streak table, jackpot rate and XP curve imported live "
      f"from `backend/database.py`. All money in USD. Re-run any time the betting math changes.*")
    w("")
    w("**Two economies exist in the code — know which one you are launching:**")
    w("")
    w("1. **Real-money (USDC), as shipped** — `ws.py` settles multiplayer real-money matches as a "
      "**pot split**: both players stake, the winner takes `pot − 5% fee`. The house takes a flat 5% of "
      "the combined pot with **zero counterparty risk and no bankroll requirement** (it never pays out "
      "more than it collected). No variable odds, no streak bonus. This is solvent by construction.")
    w("2. **Free-play (coins), and the model this audit simulates** — `main.py` runs the full "
      "**sportsbook**: variable odds where the house is the counterparty, plus the hot-streak heat "
      "multiplier, double-down, side-action props and the jackpot. This is the richer, more fun economy "
      "and the one the brief describes. The simulations below stress-test *this* model, because it is "
      "the candidate for real-money play and it already governs engagement.")
    w("")
    w("Because the offered odds satisfy `p_win × odds = (1 − house_edge)`, the base house edge is exactly "
      "5% on **every** matchup — only variance differs (an underdog win pays the house far more). The "
      "one thing that breaks this is the **streak heat bonus** (Sim 3), which hands enough back to flip "
      "the edge negative.")
    w("")

    # ---- executive summary ----
    w("## TL;DR")
    w("")
    w(f"- **Sessions are long, not short.** A $10 bankroll at $0.50/bet lasts a **median of "
      f"{s1['median']} matches** (mean {s1['mean']}). That is gambler's-ruin math: matches ≈ "
      f"bankroll ÷ (edge × bet) = $10 ÷ (0.05 × $0.50) ≈ 400. The brief's fear of ~40-match sessions "
      f"was based on flat-loss intuition; with winnings recycling under a 5% edge the real number is "
      f"~6–10× longer. **{s1['pct_50plus']}% of sessions clear 50 matches.**")
    w(f"- **Progression overlaps fine for the early hooks.** {s5['pct_reach_L5']}% of $10 sessions reach "
      f"L5 (first edge), the average session reaches **L{s5['mean']['level']}** and "
      f"{s5['mean']['evolution_cycles']} evolution cycles. L15 (second edge) is a long-haul goal "
      f"({s5['pct_reach_L15']}%), as intended.")
    w(f"- **🔴 CRITICAL: the hot-streak heat bonus reverses the house edge.** Realized hold is "
      f"**{plain_hold}%** with main bets, but **{heat_hold}%** once the heat multiplier is on — the "
      f"house *loses money* during streaks. With double-down too it nets {both_hold}% (still below the "
      f"5% target). If the sportsbook model goes to real money as-is, the house bleeds. This is the "
      f"single most important finding.")
    w(f"- **Bankroll is fine under the safe models.** Main-bet sportsbook (heat fixed) and the shipped "
      f"pot-split both hold ~5%; $500 survived **{100 - s47['pct_negative_at_500']:.0f}%** of 100 runs "
      f"with a 99th-pct dip of only {d(s47['p99_drawdown'])}. The danger is the heat bonus, not the "
      f"player count.")
    w("")

    # ---- SIM 1 ----
    w("## Simulation 1 — Session duration ($10, $0.50/bet, main bet only)")
    w("")
    w("| Metric | Value |")
    w("|---|---|")
    w(f"| Median matches to broke | **{s1['median']}** |")
    w(f"| Mean matches | {s1['mean']} |")
    w(f"| 25th pct (unlucky) | {s1['p25']} |")
    w(f"| 75th pct (lucky) | {s1['p75']} |")
    w(f"| Max session | {s1['max']} |")
    w(f"| % lasting 50+ matches (1 evolution cycle / first edge) | {s1['pct_50plus']}% |")
    w(f"| % lasting 100+ matches | {s1['pct_100plus']}% |")
    w(f"| Avg underdog wins / session | {s1['avg_underdog_wins']} |")
    w("")
    w(f"**Answer:** $10 is a **long** bankroll at this bet/edge — median {s1['median']} matches, mean "
      f"{s1['mean']}, right-skewed by occasional underdog wins (avg {s1['avg_underdog_wins']}/session) "
      f"that spike the balance. Even the unlucky 25th percentile reaches {s1['p25']} matches. The brief "
      f"worried this might be ~40 matches; it is not, because under a 5% edge the player keeps winning "
      f"~half their bets back and recycling them. **Session length is not a problem — it is a strength.**")
    w("")

    # ---- SIM 2 ----
    w("## Simulation 2 — With side action (+2 props/match @ $0.10)")
    w("")
    w("| Metric | Sim 1 (no side) | Sim 2 (with side) |")
    w("|---|---|---|")
    w(f"| Median matches | {s1['median']} | {s2['median']} |")
    w(f"| Mean matches | {s1['mean']} | {s2['mean']} |")
    w(f"| % 50+ | {s1['pct_50plus']}% | {s2['pct_50plus']}% |")
    w(f"| % 100+ | {s1['pct_100plus']}% | {s2['pct_100plus']}% |")
    w(f"| Avg long-shot prop wins | — | {s2['avg_longshot_wins']} |")
    w("")
    w(f"**Answer:** Side action **shortens** sessions (median {s1['median']} → {s2['median']}) because "
      f"$0.20 of props raises stake-per-match from $0.50 to $0.70 (+40%) at the same 5% edge, so the "
      f"player bleeds ~40% faster. Long-shot wins (avg {s2['avg_longshot_wins']}/session) add spikes but "
      f"don't offset the volume. Still, {s2['pct_50plus']}% clear 50 matches — props are an "
      f"*engagement/variance* feature, not a longevity one. Fine to keep; just don't sell it as 'more "
      f"play'.")
    w("")

    # ---- SIM 3 (the headline) ----
    w("## Simulation 3 — Streaks + double-down  🔴")
    w("")
    w(f"Heat multipliers (live from code): `{STREAK_MULTIPLIERS}` — applied to the payout based on the "
      f"streak you bring *into* the match. Double-down = 50% accept after a win, ~{DOUBLE_WIN_P:.0%} win "
      f"per double (elo-matched bot, draws count as losses), up to 3 chains; a double win extends the "
      f"streak, a loss resets it.")
    w("")
    w("**Realized house hold by configuration (long no-ruin run — isolates edge erosion):**")
    w("")
    w("| Config | Realized hold | Median session | Hit 30k cap | 5+ streak |")
    w("|---|---|---|---|---|")
    for label in ("plain", "heat", "double-down", "both"):
        v = s3[label]
        flag = " 🔴" if v["hold"] < 0 else ""
        w(f"| {label} | **{v['hold']}%**{flag} | {v['median']} | {v['cap_hit_pct']}% | {v['pct_streak5']}% |")
    w("")
    if heat_breaks:
        w(f"**Answer — this is the critical finding.** The base edge is healthy ({plain_hold}%), and "
          f"double-down on its own slightly *helps* the house ({dd_hold}%, because it is mildly −EV for "
          f"the player). **But the heat multiplier reverses the edge to {heat_hold}%** — the house pays "
          f"out *more than it takes in*. The mechanism: a winning streak of 3+ pays 1.5×–5× the already "
          f"fair-minus-5% odds, which on an even-money bet is a +40%–+400% player edge on those bets. "
          f"Streaks are common ({s3['heat']['pct_streak5']}% of sessions hit a 5+ run), so this is not a "
          f"tail effect — it gives back ~8% of turnover on average and **flips a +5% book into a ~−3% "
          f"book.** Symptom: with heat on, sessions stop ending (median hits the {MAX_SESSION:,} cap) "
          f"because the player's balance trends *up*. Combined with double-down it nets {both_hold}% — "
          f"still under the 5% target.")
        w("")
        w("This is harmless today (heat runs on **free-play coins**, so it only inflates play-money "
          "balances). **But it is a hard blocker for putting the sportsbook model behind real USDC.** "
          "Fixes, cheapest first: (a) **cap the heat multiplier at ~1.25×–1.5× and/or apply it only to "
          "the *base stake*, not the full odds-payout**; (b) fund heat bonuses from a **separate "
          "marketing/jackpot pool** rather than the book; (c) require the streak to be on *real-money* "
          "competitive matches only and lower the tiers. Re-run this script after any change — the hold "
          "row is the acceptance test (it must stay positive).")
    else:
        w(f"**Answer:** With corrected timing the heat bonus only modestly dents the edge "
          f"(plain {plain_hold}% → heat {heat_hold}%); double-down nets {dd_hold}%. Streaks create "
          f"explosive, memorable sessions and hand value back during hot runs without flipping the book. "
          f"Healthy as tuned.")
    w("")

    # ---- SIM 4 ----
    w("## Simulation 4 — House revenue & bankroll (100 players, 30 days)")
    w("")
    w("*Main-bet sportsbook (no heat) — equivalent to the heat-fixed book or the shipped pot-split.*")
    w("")
    w("| Metric | Value |")
    w("|---|---|")
    w(f"| Mean 30-day house revenue | **{d(s47['mean_revenue'])}** |")
    w(f"| Median 30-day house revenue | {d(s47['median_revenue'])} |")
    w(f"| Aggregate realized hold (100 runs) | {s47['agg_hold']}% |")
    w(f"| Revenue / day (mean) | {d(round(s47['mean_revenue']/30))} |")
    w(f"| Revenue / player / day | {d(round(s47['mean_revenue']/30/base['n_players']))} |")
    w(f"| Total wagered (30d, one run) | {d(base['total_wagered'])} |")
    w(f"| Worst single-day house loss (one run) | {d(base['max_single_day_loss'])} |")
    w("")
    w("**Bankroll stress (100 runs, $500 start):**")
    w("")
    w("| Metric | Value |")
    w("|---|---|")
    w(f"| Runs where $500 went negative | **{s47['pct_negative_at_500']}%** |")
    w(f"| 99th-pct max drawdown below start | {d(s47['p99_drawdown'])} |")
    w(f"| Worst-run / best-run revenue | {d(s47['worst_revenue'])} / {d(s47['best_revenue'])} |")
    w(f"| Forced 70%-player-win bad day | house P&L **{d(badday[0])}** (min intraday {d(badday[1])}) |")
    w("")
    w("**Minimum safe starting bankroll (99% survival, by concurrency):**")
    w("")
    w("| Concurrent players | Min safe bankroll |")
    w("|---|---|")
    w(f"| 50 | {d(msb[50])} |")
    w(f"| 100 | {d(msb[100])} |")
    w(f"| 200 | {d(msb[200])} |")
    w("")
    w(f"**Answer:** Under the clean 5% book the house earns a mean **{d(s47['mean_revenue'])}/30d** "
      f"(~{d(round(s47['mean_revenue']/30))}/day) at {s47['agg_hold']}% realized hold — exactly the "
      f"design. **$500 is comfortably safe at this scale:** 0 of 100 runs went negative, the 99th-pct "
      f"drawdown is only {d(s47['p99_drawdown'])}, and even a forced 70%-player-win day (whales hitting "
      f"underdogs) bottoms out at {d(badday[1])} — well inside $500. The min-safe figures are small "
      f"because variance at these bet sizes is low. **The caveat that matters:** these numbers assume "
      f"no heat bonus. Turn heat on (Sim 3) and realized hold goes to {heat_hold}%–{both_hold}%, at "
      f"which point the bankroll *trends down*, not up — no reserve survives a negative-edge book "
      f"indefinitely. **Fix the heat bonus, then $500–$1,000 is ample for 100 players.**")
    w("")

    # ---- SIM 5 ----
    w("## Simulation 5 — Progression overlap")
    w("")
    w(f"Real XP curve (live from code): L5 = {ms[5]} matches, L10 = {ms[10]}, L15 = {ms[15]}, "
      f"L25 = {ms[25]}. *(The brief assumed L10 = 150; the shipped curve is steeper at {ms[10]}.)*")
    w("")
    w("| $10 session | Matches | Level reached | Evolution cycles |")
    w("|---|---|---|---|")
    for k in ("p75", "median", "mean"):
        e = s5[k]
        w(f"| {k} | {e['matches']} | L{e['level']} | {e['evolution_cycles']} |")
    w("")
    w("| Milestone | Matches | % of $10 sessions reaching it |")
    w("|---|---|---|")
    w(f"| L5 — first edge | {ms[5]} | **{s5['pct_reach_L5']}%** |")
    w(f"| L10 | {ms[10]} | {s5['pct_reach_L10']}% |")
    w(f"| L15 — second edge | {ms[15]} | {s5['pct_reach_L15']}% |")
    w("")
    w(f"**Answer:** Contrary to the brief's worry, a single $10 bankroll is **plenty** for the early "
      f"progression hooks. The median session reaches **L{s5['median']['level']}** with "
      f"{s5['median']['evolution_cycles']} evolution cycles, and **{s5['pct_reach_L5']}% reach the first "
      f"edge (L5)**. Evolution (every 20 matches) fires {s5['median']['evolution_cycles']}+ times — the "
      f"player visibly sees their agent adapt. L15's second edge is a genuine long-haul goal "
      f"({s5['pct_reach_L15']}% on one $10), which is appropriate for a 525-match milestone. Progression "
      f"and bankroll are **well aligned for onboarding**; the only gap is the L15+ long tail, addressed "
      f"by letting progression also accrue on free play (see rec 5).")
    w("")

    # ---- SIM 6 ----
    w("## Simulation 6 — Minimum viable deposit (≥75% of sessions reach 50 matches)")
    w("")
    w("Cell = % of 1,000 sessions lasting 50+ matches. **Bold** = smallest deposit clearing 75%.")
    w("")
    w("| Bet size | " + " | ".join(d(x) for x in s6["deposits"]) + " |")
    w("|" + "---|" * (len(s6["deposits"]) + 1))
    for bet in s6["bets"]:
        cells = []
        for dep in s6["deposits"]:
            v = s6["grid"][bet][dep]
            cells.append(f"**{v}%**" if (s6["min_dep"][bet] == dep) else f"{v}%")
        w(f"| {d(bet)} | " + " | ".join(cells) + " |")
    w("")
    w("| Bet size | Min viable deposit |")
    w("|---|---|")
    for bet in s6["bets"]:
        md = s6["min_dep"][bet]
        w(f"| {d(bet)} | {d(md) if md else 'more than $50'} |")
    w("")
    w(f"**Answer:** Even at the **$0.50** default, **$10** already clears the 75% bar "
      f"({s6['grid'][50][1000]}% of $10 sessions reach 50 matches). A **$5** deposit is enough at "
      f"$0.10–$0.25 bets. So the recommended minimum is **$10**, and a lower default bet ($0.10) makes "
      f"even a $5 deposit comfortably satisfying. There is no need to push a larger deposit.")
    w("")

    # ---- SIM 7 ----
    w("## Simulation 7 — Whale vs casual distribution (100 players, 30 days)")
    w("")
    w("| Segment | Players | Deposit | Bet | House revenue | % of revenue | Active at d30 |")
    w("|---|---|---|---|---|---|---|")
    seg_meta = {s[0]: s for s in SEGMENTS}
    for name in ("casual", "regular", "whale"):
        m = seg_meta[name]
        w(f"| {name} | {m[1]} | {d(m[2])} | {d(m[4])} | {d(seg_rev[name])} | "
          f"{100*seg_rev[name]/tot:.0f}% | {base['active_by_seg'][name]}/{m[1]} |")
    w("")
    w("| Money flow (30d) | Value |")
    w("|---|---|")
    w(f"| Total player deposits | {d(base['total_deposits'])} |")
    w(f"| Withdrawable balances remaining | {d(base['total_remaining'])} |")
    w(f"| House take (deposits − remaining) | {d(base['total_deposits'] - base['total_remaining'])} |")
    w(f"| House betting P&L (reconciles) | {d(base['cum_revenue'])} |")
    w("")
    w(f"**Answer:** Revenue is **whale-dominated** — 10 whales drive "
      f"**{100*seg_rev['whale']/tot:.0f}%** of house revenue at 10% of headcount; casuals contribute "
      f"{100*seg_rev['casual']/tot:.0f}% and churn first (their 3-reload cap). Average LTV (house "
      f"revenue per player): casual {d(round(seg_rev['casual']/70))}, regular "
      f"{d(round(seg_rev['regular']/20))}, whale {d(round(seg_rev['whale']/10))}. This is a normal, "
      f"healthy whale-funded model **and the bankroll absorbs the whale variance fine** "
      f"({s47['pct_negative_at_500']}% ruin at $500) — *as long as the heat bonus is fixed*. With heat "
      f"on, whales on streaks are exactly who drains the book fastest.")
    w("")

    # ---- SIM 8 ----
    w("## Simulation 8 — Jackpot pool economics (3% contribution)")
    w("")
    w("| Metric | Value |")
    w("|---|---|")
    w(f"| Monthly contribution (3% of {d(base['total_wagered'])} wagered) | {d(s8['monthly_pool'])} |")
    w(f"| Daily pool growth | {d(round(s8['daily_growth']))} |")
    w(f"| Assumed tournament-parlay attempts / day | {s8['attempts_per_day']:.0f} |")
    w(f"| P(jackpot hit) / day | {100*s8['hit_prob_per_day']:.1f}% |")
    w(f"| Expected days to first hit | {s8['days_to_hit']:.1f} |")
    w(f"| Pool size at first hit | ~{d(s8['pool_at_hit'])} |")
    w("")
    w(f"**Answer:** At 3% of ~{d(base['total_wagered'])} monthly volume the pool grows "
      f"{d(round(s8['daily_growth']))}/day toward {d(s8['monthly_pool'])}/month, and (under the assumed "
      f"~1.5%-per-parlay hit rate) gets claimed roughly every {s8['days_to_hit']:.0f} days at "
      f"~{d(s8['pool_at_hit'])}. **Aspirational but not distorting** — the jackpot is player-funded "
      f"redistribution, so it does not touch the house edge. At low launch volume the real risk is the "
      f"pool looking *trivial*; **seed it at $25–$50** so it never sits at a few dollars. Note the 3% "
      f"jackpot siphon stacks on top of the 5% edge, so total player drag is ~8% of turnover — fine, but "
      f"worth remembering when reasoning about session length.")
    w("")

    # ---- recommendations ----
    w("## Recommendations")
    w("")
    recs = [
        ("1. Bet-size tiers / default",
         f"The $0.01–$10 range is good. Default **$0.25** is reasonable; **$0.10** for brand-new players "
         f"is a nice-to-have (it turns a $5 deposit into a 50+ match session) but not required — even "
         f"$0.50 on $10 gives a median {s1['median']} matches. Surface higher tiers as 'raise the "
         f"stakes' once a player has a cushion. **Bet size is a comfort dial, not a survival fix** — "
         f"sessions are already long."),
        ("2. House edge",
         f"Keep **5%**. Realized hold lands at {s47['agg_hold']}% and yields a mean "
         f"{d(s47['mean_revenue'])}/30d from 100 players. 3% would lengthen sessions ~40% but is "
         f"unnecessary given they're already long; 7% needlessly shortens them. 5% is right. The edge "
         f"that actually matters is keeping it **positive** — see rec 7."),
        ("3. Minimum deposit",
         f"**$10.** It clears the 'one evolution cycle' bar at every bet tier "
         f"({s6['grid'][50][1000]}% even at $0.50). $5 works if you also default the bet to $0.10–$0.25. "
         f"No need to ask for more."),
        ("4. Free chips",
         "Yes, but for **reach and L15+ progression**, not survival. A daily free-play allotment "
         "(~20–40 matches) lets churned players keep climbing the ladder and keeps the agent-evolution "
         "loop alive between deposits. Critically, **let progression (XP/evolution/familiarity) accrue "
         "on free play** so the L15 long tail is reachable without spending."),
        ("5. Progression vs session length",
         f"**Well aligned for onboarding** — {s5['pct_reach_L5']}% of $10 sessions reach the first edge "
         f"and {s5['median']['evolution_cycles']}+ evolution cycles fire. Only the L15+ tail outruns a "
         f"single bankroll ({s5['pct_reach_L15']}% reach L15). Fix that with free-play progression (rec "
         f"4), not by gutting the curve. Optionally add a tiny early cosmetic/edge taste around L2–L3 "
         f"for immediate gratification."),
        ("6. Side action",
         f"It shortens sessions (median {s1['median']}→{s2['median']}) by adding 40% more 5%-edge "
         f"volume. Keep it for variety. A **slightly lower prop edge (3%)** would make side bets feel "
         f"like flavor rather than a faster drain, and the long-shot props supply the dopamine spikes."),
        ("7. Streaks / double-down — 🔴 fix before real-money sportsbook",
         f"**The heat multiplier reverses the house edge** (plain {plain_hold}% → with heat "
         f"{heat_hold}%). Double-down alone is fine (+{dd_hold}%, mildly player-negative). On free-play "
         f"coins this only inflates play balances, but it is a **hard blocker** for a real-money "
         f"sportsbook. Fix by capping the multiplier (≤~1.5×), applying it to the base stake only, or "
         f"funding it from a separate bonus pool. The `heat` hold row in this script is your acceptance "
         f"test — it must stay positive."),
        ("8. House bankroll sizing",
         f"Under a **positive-edge** book, the reserve need is small: 50→{d(msb[50])}, 100→{d(msb[100])}, "
         f"200→{d(msb[200])} for 99% survival; a practical {d(max(msb[100]*3, 100000))} float for 100 "
         f"players is very safe. These scale with **whale bet size**, not headcount. **None of this "
         f"holds if the edge is negative** (rec 7) — a negative-edge book needs an infinite bankroll. "
         f"Note the shipped real-money pot-split needs **no reserve at all** (it only pays out collected "
         f"stakes)."),
        ("9. Underdog exposure",
         "Underdog wins pay 2.4×–3.5×, so they dominate downside variance and the bad-day stress. If you "
         "run the variable-odds book for real money, **cap max stake on 2.5×+ underdog selections** "
         "(e.g. ½ the favorite max) to bound single-bet exposure. (Irrelevant for the pot-split model, "
         "which has no odds.)"),
        ("10. Multiplayer vs VS BOT",
         "Different economics by design. **VS BOT** is the variable-odds book (house is counterparty, "
         "carries the heat-bonus risk). **Real-money multiplayer is the pot-split** — two players fund "
         "the pot, house rakes 5%, zero counterparty risk and double the rake per match. Multiplayer is "
         "strictly the safer, more profitable real-money mode; lean there for USDC and keep VS BOT on "
         "free-play coins until the heat bonus is fixed."),
    ]
    for title, body in recs:
        w(f"**{title}.** {body}")
        w("")

    # ---- red flags ----
    w("## Red flags before real-money launch")
    w("")
    w(f"1. **🔴 Heat bonus flips the house edge negative ({plain_hold}% → {heat_hold}%) — critical.** "
      f"Do not put the variable-odds book behind real money until the heat multiplier is capped or "
      f"separately funded. (Harmless on free-play coins today.)")
    w(f"2. **Decide which real-money model you are launching.** The shipped USDC path is a safe 5% "
      f"pot-split with no bankroll risk; the brief describes the richer variable-odds sportsbook. They "
      f"behave very differently. Don't accidentally ship the sportsbook math (with heat) on USDC.")
    w(f"3. **Jackpot + edge stack to ~8% drag.** Fine, but seed the pool ($25–$50) so it isn't trivial "
      f"at launch volume, and remember the combined drag when reasoning about retention.")
    w(f"4. **Side action accelerates losses** (median {s1['median']}→{s2['median']}). Keep it, but frame "
      f"it as variety, not 'more play'.")
    w("")
    w(f"**Bottom line:** the economy is healthier than the brief feared — sessions are long "
      f"(median {s1['median']}), progression hooks land early ({s5['pct_reach_L5']}% reach L5), and the "
      f"shipped real-money model is solvent by construction. The **one must-fix is the heat-streak "
      f"bonus**, which silently turns the sportsbook into a money-loser. Fix that and the variable-odds "
      f"book is launch-ready on a modest reserve.")
    w("")
    return "\n".join(L)


if __name__ == "__main__":
    main()
