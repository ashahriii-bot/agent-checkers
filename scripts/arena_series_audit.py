"""Standing audit for the lineup-conditional SERIES book (P3, §7.3).

The sibling of `arena_props_audit.py`, but for series markets. Where the props
audit proves each *single-game* prop holds the +5% edge, this proves the
*series* markets do — and, crucially, that the correlated ones (sweep ⊂
series-win, go-distance) priced from ONE conditional distribution can't be
arbitraged against each other.

Method (mirrors the props audit's held-out design):
  1. For each test series (varied lineups, Bo3 + Bo5), PRICE every market with
     the conditional Monte-Carlo (`arena_series_pricer.price_series`).
  2. SETTLE those fixed odds against a large, independently-seeded sample of full
     series (a genuine held-out test — pricing noise shows up as drift).
  3. Bet BOTH sides of every market, plus a correlated BASKET
     (series-win-RED + sweep-YES + go-distance-NO) — the legs the spec calls out
     as totally correlated. A calibrated, mutually-consistent book holds +5% on
     each bucket; any drift means the conditional model is stale or the pricing
     depth (`DEFAULT_PRICE_SIMS`) is too coarse.
  4. Assert each market type holds within ±FAIL_TOL of +5%. Exit non-zero so this
     gates CI.

Draw handling: series-win and next-game VOID on a drawn result (refunded, not
counted in the hold denominator) — exactly as the pricer prices them conditional
on a decisive result. Sweep / go-distance / survival are clean yes/no.

**No series market ships real-money until this audit passes; free-play coins only
in the interim (§7.3).** stdlib only; safe to run in CI.

Usage:  python scripts/arena_series_audit.py [settle_sims] [price_sims]
"""
from __future__ import annotations

import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("DB_PATH", "/tmp/arena_series_audit_dummy.db")

from database import HOUSE_EDGE  # noqa: E402
from arena_species import Species  # noqa: E402
from arena_engine import CreatureConfig  # noqa: E402
from arena_budget import normalize_to_budget  # noqa: E402
import random  # noqa: E402
from arena_series_pricer import (  # noqa: E402
    price_series, price_to_odds, odds_from_prob, simulate_series_once,
)

SEED = 20260607
TARGET = HOUSE_EDGE * 100        # +5.0
FAIL_TOL = 2.0                   # hard fail outside [3%, 7%] (spec §7.3)
WARN_TOL = 1.0

DEFAULT_SETTLE = 4000
DEFAULT_PRICE = 1200

MARKET_ORDER = ["series_win", "next_game", "sweep", "go_distance", "survive_next",
                "correlated_basket"]


def _team(specs, sliders=None):
    s = sliders or {"aggression": 40, "risk_tolerance": 40, "target_focus": 40,
                    "positioning": 40, "sacrifice": 40}
    s = normalize_to_budget(s)  # keep every build a legal 200-point lineup
    return [CreatureConfig(species=Species(sp), **s) for sp in specs]


# Varied test series — different comps + a glass-cannon build + both formats, so
# the book is audited across a spread of true probabilities, not one matchup.
TEST_SERIES = [
    {"name": "bo3 · balanced 3v3", "format": "bo3", "needed": 2, "max": 3,
     "red": _team(["ironjaw", "razorwing", "embercaster"]),
     "blue": _team(["warden", "hexwright", "razorwing"])},
    {"name": "bo3 · tanks vs glass", "format": "bo3", "needed": 2, "max": 3,
     "red": _team(["warden", "ironjaw"]),
     "blue": _team(["razorwing", "embercaster"],
                   {"aggression": 80, "risk_tolerance": 70, "target_focus": 20,
                    "positioning": 15, "sacrifice": 15})},
    {"name": "bo5 · balanced 3v3", "format": "bo5", "needed": 3, "max": 5,
     "red": _team(["ironjaw", "razorwing", "embercaster"]),
     "blue": _team(["warden", "hexwright", "razorwing"])},
]


def _settle_two_sided(bucket, won_selection, odds_by_sel, live=True):
    """Stake 1 on every selection of a market; a non-live (void) bet is refunded
    (excluded from the hold denominator). `won_selection` is the selection that
    pays; None means no side won (still counts — the house keeps the stakes)."""
    if not live:
        return
    for sel, odds in odds_by_sel.items():
        bucket[0] += 1.0
        if sel == won_selection:
            bucket[1] += odds


def run_audit(settle_sims=DEFAULT_SETTLE, price_sims=DEFAULT_PRICE, seed=SEED):
    # bucket[market] = [staked, returned]
    buckets = defaultdict(lambda: [0.0, 0.0])
    per_config = []

    for ci, ts in enumerate(TEST_SERIES):
        needed, maxg = ts["needed"], ts["max"]
        priced = price_series(ts["red"], ts["blue"], games_needed=needed, max_games=maxg,
                              n_sims=price_sims, seed=seed + ci)
        odds = price_to_odds(priced)
        cfg_bucket = defaultdict(lambda: [0.0, 0.0])
        # Independent, reproducible held-out settle stream. The engine draws from
        # the module-global RNG, so seed THAT (price_series already reseeded it to
        # seed+ci; this moves to a disjoint stream for settlement).
        random.seed(seed + 1000 + ci)

        for _ in range(settle_sims):
            r = simulate_series_once(ts["red"], ts["blue"], 0, 0, 0, needed, maxg)
            winner = r["winner"]
            sweep = r["games_played"] == needed and (r["final_red"] == 0 or r["final_blue"] == 0)
            dist = r["games_played"] >= maxg
            fw = r["first_winner"]

            for b in (buckets, cfg_bucket):
                # series-win — void on a drawn series
                _settle_two_sided(b["series_win"],
                                  winner if winner in ("red", "blue") else None,
                                  odds["series_win"], live=(winner != "draw"))
                # next-game — void on a drawn opening game
                _settle_two_sided(b["next_game"],
                                  fw if fw in ("red", "blue") else None,
                                  odds["next_game"], live=(fw in ("red", "blue")))
                # sweep / go-distance — clean yes/no
                _settle_two_sided(b["sweep"], "yes" if sweep else "no", odds["sweep"])
                _settle_two_sided(b["go_distance"], "yes" if dist else "no", odds["go_distance"])
                # per-creature survival in the next game — all creatures in one bucket
                if fw is not None:
                    for cid, o in odds["survive_next"].items():
                        alive = cid in r["first_survivors"]
                        _settle_two_sided(b["survive_next"], "yes" if alive else "no", o)
                # correlated basket: the three legs the spec says are totally
                # correlated, bet together. Must still hold ~+5% combined.
                if winner != "draw":
                    b["correlated_basket"][0] += 1.0
                    if winner == "red":
                        b["correlated_basket"][1] += odds["series_win"]["red"]
                b["correlated_basket"][0] += 1.0
                if sweep:
                    b["correlated_basket"][1] += odds["sweep"]["yes"]
                b["correlated_basket"][0] += 1.0
                if not dist:
                    b["correlated_basket"][1] += odds["go_distance"]["no"]

        per_config.append({"name": ts["name"], "priced": priced["markets"],
                           "holds": {m: _hold(*cfg_bucket[m]) for m in MARKET_ORDER}})

    type_rows = {m: {"hold": _hold(*buckets[m]), "n_bets": int(buckets[m][0])} for m in MARKET_ORDER}
    return {"type_rows": type_rows, "per_config": per_config,
            "settle_sims": settle_sims, "price_sims": price_sims}


def _hold(staked, returned):
    return 100 * (staked - returned) / staked if staked else 0.0


def _verdict(h):
    if abs(h - TARGET) <= WARN_TOL:
        return "PASS", True
    if abs(h - TARGET) <= FAIL_TOL:
        return "PASS*", True
    return "FAIL", False


def build_report(stats):
    out = []
    w = out.append
    tr = stats["type_rows"]
    w("# Arena Series Book Audit\n")
    w(f"_Held-out test: each series market priced by the lineup-conditional "
      f"Monte-Carlo ({stats['price_sims']:,} sims/config), then settled against "
      f"{stats['settle_sims']:,} independently-seeded full series per config._\n")
    w("Both sides of every market are bet, plus the correlated basket "
      "(series-win-RED + sweep-YES + go-distance-NO). A calibrated, mutually-"
      f"consistent book holds the **+{TARGET:.0f}% edge** on each — every row must "
      f"land within ±{FAIL_TOL:.0f} pts.\n")

    w("## Realized hold by market (the acceptance test)\n")
    w("| Market | Realized hold | Bets | Verdict |")
    w("|---|---|---|---|")
    all_ok = True
    for m in MARKET_ORDER:
        h = tr[m]["hold"]
        label, ok = _verdict(h)
        all_ok = all_ok and ok
        w(f"| `{m}` | {h:+.2f}% | {tr[m]['n_bets']:,} | {label} |")
    w(f"\n_Band: PASS within ±{WARN_TOL:.0f} pt of +{TARGET:.0f}%, PASS\\* within "
      f"±{FAIL_TOL:.0f} pt, FAIL beyond._\n")

    w("## Per-config hold\n")
    w("| Series | " + " | ".join(f"`{m}`" for m in MARKET_ORDER) + " |")
    w("|---|" + "|".join(["---"] * len(MARKET_ORDER)) + "|")
    for c in stats["per_config"]:
        w(f"| {c['name']} | " + " | ".join(f"{c['holds'][m]:+.1f}%" for m in MARKET_ORDER) + " |")

    w("\n## Sample priced lines\n")
    for c in stats["per_config"]:
        pm = c["priced"]
        w(f"- **{c['name']}** — series-win red {pm['series_win']['red']:.0%} / "
          f"blue {pm['series_win']['blue']:.0%} (void {pm['series_win']['void']:.0%}); "
          f"sweep {pm['sweep']:.0%}; distance {pm['go_distance']:.0%}")

    w("")
    if all_ok:
        w(f"**PASS** — every series market holds within ±{FAIL_TOL:.0f} pts of "
          f"+{TARGET:.0f}%. Real-money series markets are cleared by §7.3 "
          "(pot-split form only; free-play house-banked otherwise).")
    else:
        w(f"**FAIL** — a series market holds outside ±{FAIL_TOL:.0f} pts of "
          f"+{TARGET:.0f}%. Do NOT ship series betting real-money; raise "
          "`DEFAULT_PRICE_SIMS` or re-fit before retrying (§7.3).")
    w(f"\n_survive_next is the noisiest row (Razorwing floors near the p=0.05 clamp "
      f"→ ~19x payouts); it is aggregated across all creatures to tame variance._")
    return "\n".join(out), all_ok


def main():
    settle = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SETTLE
    price = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PRICE
    print(f"Running arena-series audit (price {price:,}/cfg, settle {settle:,}/cfg, "
          f"seed {SEED})...", file=sys.stderr)
    stats = run_audit(settle, price)
    report, ok = build_report(stats)
    out_path = ROOT / "docs" / "ARENA_SERIES_AUDIT.md"
    out_path.write_text(report)
    print(report)
    print(f"\n[report written to {out_path}]", file=sys.stderr)
    print(f"[{'PASS' if ok else 'FAIL'}]", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
