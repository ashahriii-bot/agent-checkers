"""Arena balance simulation harness.

Runs many matches with varied team compositions and personality configs,
scans the event stream, and reports the metrics needed for balance tuning:

  - average match length (rounds)
  - win-method distribution (elimination / breach / collapse / draw)
  - species win rates (per-creature and a clean mono-species matchup matrix)
  - species kill rates (kills credited per creature of that species)
  - most common winning team comps
  - Last Stand trigger frequency
  - breach-attempt frequency (a CHANNEL was ever chosen -> meter started filling)
  - "a creature dies by round 3" frequency
  - first-blood round distribution

Pure stdlib. Run from the backend/ directory:

    python3 arena_balance_sim.py            # full report, 1000 varied + matchup matrix
    python3 arena_balance_sim.py 2000       # 2000 varied matches
    python3 arena_balance_sim.py 1000 out.json   # also dump raw stats to out.json
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict

from arena_species import Species
from arena_engine import CreatureConfig, simulate_match

SPECIES_LIST = list(Species)

# ---------------------------------------------------------------------------
# Personality config generation
# ---------------------------------------------------------------------------

# Archetype presets exercise the temperament system, including dedicated
# gate-rushers (low aggression + low focus => high channel desire in the AI).
ARCHETYPES = {
    "berserker":  dict(aggression=80, risk_tolerance=20, target_focus=50, positioning=30, sacrifice=60),
    "headhunter": dict(aggression=75, risk_tolerance=50, target_focus=82, positioning=40, sacrifice=50),
    "rusher":     dict(aggression=20, risk_tolerance=72, target_focus=18, positioning=40, sacrifice=70),
    "turtle":     dict(aggression=20, risk_tolerance=30, target_focus=50, positioning=80, sacrifice=30),
    "tactician":  dict(aggression=50, risk_tolerance=50, target_focus=72, positioning=78, sacrifice=40),
    "martyr":     dict(aggression=60, risk_tolerance=25, target_focus=50, positioning=40, sacrifice=82),
    "balanced":   dict(aggression=50, risk_tolerance=50, target_focus=50, positioning=50, sacrifice=50),
}
ARCHETYPE_NAMES = list(ARCHETYPES)


def _random_sliders(rng: random.Random) -> dict:
    return dict(
        aggression=rng.randint(0, 100),
        risk_tolerance=rng.randint(0, 100),
        target_focus=rng.randint(0, 100),
        positioning=rng.randint(0, 100),
        sacrifice=rng.randint(0, 100),
    )


_BUDGET_KEYS = ["aggression", "risk_tolerance", "target_focus", "positioning", "sacrifice"]


def _budget(sliders: dict) -> dict:
    """Coerce a slider dict to the live 200-point budget (G&E §2.2/§2.6) so the sim
    measures the real shipping distribution, not the old 0-100 independent space."""
    from arena_budget import normalize_list
    vals = normalize_list([sliders[k] for k in _BUDGET_KEYS])
    return dict(zip(_BUDGET_KEYS, vals))


def _make_creature(rng: random.Random, species: Species, mode: str) -> CreatureConfig:
    if mode == "random":
        sliders = _random_sliders(rng)
    else:
        sliders = dict(ARCHETYPES[rng.choice(ARCHETYPE_NAMES)])
    return CreatureConfig(species=species, **_budget(sliders))


def _make_team(rng: random.Random, mode: str, species: list[Species] | None = None) -> list[CreatureConfig]:
    if species is None:
        species = [rng.choice(SPECIES_LIST) for _ in range(3)]
    return [_make_creature(rng, sp, mode) for sp in species]


# ---------------------------------------------------------------------------
# Event-stream parsing -> per-match record
# ---------------------------------------------------------------------------

def _species_by_id(red: list[CreatureConfig], blue: list[CreatureConfig]) -> dict[str, Species]:
    m = {}
    for i, c in enumerate(red):
        m[f"red_{i}"] = c.species
    for i, c in enumerate(blue):
        m[f"blue_{i}"] = c.species
    return m


def _analyze_match(result, red: list[CreatureConfig], blue: list[CreatureConfig]) -> dict:
    sp_by_id = _species_by_id(red, blue)
    events = result.events

    death_rounds: list[int] = []
    kills_by_species: Counter = Counter()
    last_stand = False
    breach_attempted = False
    channel_count = 0
    breach_denied = 0
    first_blood_team: str | None = None

    for ev in events:
        et = ev.get("type")
        if et == "kill":
            death_rounds.append(ev.get("round", 0))
            killer = (ev.get("data") or {}).get("killer")
            if killer:
                # First attributable kill = which team drew first blood. Burn /
                # collapse kills carry no killer, so they don't count as "blood".
                if first_blood_team is None:
                    first_blood_team = "red" if killer.startswith("red") else "blue"
                if killer in sp_by_id:
                    kills_by_species[sp_by_id[killer].value] += 1
        elif et == "collapse_kill":
            death_rounds.append(ev.get("round", 0))
        elif et == "last_stand":
            last_stand = True
        elif et == "activation":
            act = (((ev.get("data") or {}).get("result") or {}).get("action") or {})
            if act.get("type") == "channel":
                breach_attempted = True
                channel_count += 1
        elif et == "breach_denied":
            breach_denied += 1

    first_death = min(death_rounds) if death_rounds else None
    # Per-species survival: the set of species with >=1 creature still alive at the
    # end, across BOTH teams. This is exactly what the `species_survivor` prop
    # resolves on, so the props audit reads it straight from the harness.
    surviving_species = sorted({
        c["species"] for c in (result.red_team + result.blue_team) if c.get("alive")
    })
    return {
        "winner": result.winner,
        "win_method": result.win_method,
        "rounds": result.total_rounds,
        "red_species": [c.species.value for c in red],
        "blue_species": [c.species.value for c in blue],
        "last_stand": last_stand,
        "breach_attempted": breach_attempted,
        "breach_completed": result.win_method == "breach",
        "channel_count": channel_count,
        "breach_denied": breach_denied,
        "first_death_round": first_death,
        "first_blood_team": first_blood_team,
        "surviving_species": surviving_species,
        "death_by_round3": first_death is not None and first_death <= 3,
        "total_deaths": len(death_rounds),
        "kills_by_species": dict(kills_by_species),
    }


# ---------------------------------------------------------------------------
# Batch runners
# ---------------------------------------------------------------------------

def _config_dict(c: CreatureConfig) -> dict:
    """A CreatureConfig as the plain dict that arena_props.calculate_arena_props
    expects (species + the five personality sliders)."""
    return {
        "species": c.species.value,
        "aggression": c.aggression,
        "risk_tolerance": c.risk_tolerance,
        "target_focus": c.target_focus,
        "positioning": c.positioning,
        "sacrifice": c.sacrifice,
    }


def _simulate_varied_match(rng: random.Random, seed: int, i: int):
    """One varied match: 40% random sliders, 60% archetype; species random per
    slot. Returns (red_configs, blue_configs, result)."""
    mode = "random" if rng.random() < 0.4 else "archetype"
    red = _make_team(rng, mode)
    blue = _make_team(rng, mode)
    # Seed the engine's global RNG (used for AI jitter) deterministically.
    random.seed(seed * 1_000_003 + i)
    result = simulate_match(red, blue)
    return red, blue, result


def run_varied(n: int, seed: int = 1234) -> list[dict]:
    """Run n matches with varied comps + personalities. 40% random sliders,
    60% archetype-based. Species randomly assigned per slot."""
    rng = random.Random(seed)
    records = []
    for i in range(n):
        red, blue, result = _simulate_varied_match(rng, seed, i)
        records.append(_analyze_match(result, red, blue))
    return records


def run_varied_with_configs(n: int, seed: int = 1234) -> list[dict]:
    """Same matches and RNG stream as run_varied(), but each record also carries
    the exact team configs that were simulated (keys `red_config`/`blue_config`,
    lists of dicts ready for arena_props.calculate_arena_props). This is what the
    arena-props economy audit consumes: re-price the props from the same comp,
    then resolve them against the per-match facts already in the record
    (`rounds`, `breach_completed`, `last_stand`, `first_blood_team`,
    `surviving_species`)."""
    rng = random.Random(seed)
    records = []
    for i in range(n):
        red, blue, result = _simulate_varied_match(rng, seed, i)
        rec = _analyze_match(result, red, blue)
        rec["red_config"] = [_config_dict(c) for c in red]
        rec["blue_config"] = [_config_dict(c) for c in blue]
        records.append(rec)
    return records


def run_matchup_matrix(per_cell: int = 120, seed: int = 99) -> dict:
    """Mono-species team A (3xA) vs mono-species team B (3xB) for every ordered
    pair, with balanced (40/40/40/40/40 = the neutral 200-budget centroid)
    personalities. Gives a clean per-species win-rate matrix that isolates species
    strength from comp/personality noise."""
    rng = random.Random(seed)
    # wins[a][b] = fraction of matches where the 3xA team beat the 3xB team
    wins = {a.value: {b.value: 0.0 for b in SPECIES_LIST} for a in SPECIES_LIST}
    raw = {a.value: {b.value: [0, 0, 0] for b in SPECIES_LIST} for a in SPECIES_LIST}  # [a_wins, b_wins, draws]
    k = 0
    for a in SPECIES_LIST:
        for b in SPECIES_LIST:
            for _ in range(per_cell):
                red = [CreatureConfig(species=a, aggression=40, risk_tolerance=40,
                                      target_focus=40, positioning=40, sacrifice=40) for _ in range(3)]
                blue = [CreatureConfig(species=b, aggression=40, risk_tolerance=40,
                                       target_focus=40, positioning=40, sacrifice=40) for _ in range(3)]
                random.seed(seed * 7_777 + k)
                k += 1
                res = simulate_match(red, blue)
                if res.winner == "red":
                    raw[a.value][b.value][0] += 1
                elif res.winner == "blue":
                    raw[a.value][b.value][1] += 1
                else:
                    raw[a.value][b.value][2] += 1
            aw, bw, dr = raw[a.value][b.value]
            wins[a.value][b.value] = (aw + 0.5 * dr) / per_cell
    # Overall per-species win rate = average over opponents (excluding self-mirror,
    # which is 0.5 by symmetry anyway).
    overall = {}
    for a in SPECIES_LIST:
        vals = [wins[a.value][b.value] for b in SPECIES_LIST if b != a]
        overall[a.value] = sum(vals) / len(vals)
    return {"matrix": wins, "overall": overall, "raw": raw, "per_cell": per_cell}


# ---------------------------------------------------------------------------
# Aggregation / reporting
# ---------------------------------------------------------------------------

def summarize(records: list[dict]) -> dict:
    n = len(records)
    rounds = [r["rounds"] for r in records]
    methods = Counter(r["win_method"] for r in records)

    # Collapse "draw" winners aside; group methods into the 3 design buckets.
    # elimination bucket = elimination + mutual_elimination
    # collapse bucket    = collapse + timeout (the "goes the distance" outcome)
    bucket = Counter()
    for r in records:
        m = r["win_method"]
        if m in ("elimination", "mutual_elimination"):
            bucket["elimination"] += 1
        elif m == "breach":
            bucket["breach"] += 1
        elif m in ("collapse", "timeout"):
            bucket["collapse"] += 1
        else:
            bucket[m] += 1

    # Species win rate (per-creature: did this creature's team win?)
    sp_team_games = Counter()
    sp_team_wins = defaultdict(float)
    for r in records:
        w = r["winner"]
        for sp in r["red_species"]:
            sp_team_games[sp] += 1
            if w == "red":
                sp_team_wins[sp] += 1
            elif w == "draw":
                sp_team_wins[sp] += 0.5
        for sp in r["blue_species"]:
            sp_team_games[sp] += 1
            if w == "blue":
                sp_team_wins[sp] += 1
            elif w == "draw":
                sp_team_wins[sp] += 0.5
    sp_winrate = {sp: sp_team_wins[sp] / sp_team_games[sp] for sp in sp_team_games}

    # Species kill rate (kills per creature-appearance of that species)
    sp_kills = Counter()
    for r in records:
        for sp, k in r["kills_by_species"].items():
            sp_kills[sp] += k
    sp_killrate = {sp: sp_kills[sp] / sp_team_games[sp] for sp in sp_team_games}

    # Winning comps (sorted-species tuple of the winning team)
    winning_comps = Counter()
    for r in records:
        if r["winner"] == "red":
            winning_comps[tuple(sorted(r["red_species"]))] += 1
        elif r["winner"] == "blue":
            winning_comps[tuple(sorted(r["blue_species"]))] += 1

    first_death_rounds = [r["first_death_round"] for r in records if r["first_death_round"] is not None]

    return {
        "n": n,
        "avg_rounds": sum(rounds) / n,
        "round_hist": dict(sorted(Counter(rounds).items())),
        "methods_raw": dict(methods),
        "methods_bucket": {k: v / n for k, v in bucket.items()},
        "last_stand_rate": sum(r["last_stand"] for r in records) / n,
        "breach_attempt_rate": sum(r["breach_attempted"] for r in records) / n,
        "breach_complete_rate": sum(r["breach_completed"] for r in records) / n,
        "death_by_round3_rate": sum(r["death_by_round3"] for r in records) / n,
        "avg_first_death_round": (sum(first_death_rounds) / len(first_death_rounds)) if first_death_rounds else None,
        "no_death_rate": sum(1 for r in records if r["first_death_round"] is None) / n,
        "avg_total_deaths": sum(r["total_deaths"] for r in records) / n,
        "avg_channels": sum(r["channel_count"] for r in records) / n,
        "draw_rate": sum(1 for r in records if r["winner"] == "draw") / n,
        "sp_winrate": sp_winrate,
        "sp_killrate": sp_killrate,
        "top_winning_comps": winning_comps.most_common(8),
    }


def _bar(x: float, width: int = 28) -> str:
    return "#" * int(round(x * width))


def print_report(s: dict, matrix: dict | None = None, title: str = "ARENA BALANCE REPORT") -> None:
    print("=" * 72)
    print(f"  {title}   (n={s['n']} varied matches)")
    print("=" * 72)
    print(f"\nAVG MATCH LENGTH : {s['avg_rounds']:.2f} rounds")
    print("Round distribution:")
    for rnd, cnt in s["round_hist"].items():
        print(f"  R{rnd:>2}: {cnt:>4}  {_bar(cnt / s['n'])}")

    print("\nWIN METHOD (design buckets):")
    for m in ("elimination", "breach", "collapse"):
        v = s["methods_bucket"].get(m, 0.0)
        print(f"  {m:<12}: {v*100:5.1f}%  {_bar(v)}")
    other = {k: v for k, v in s["methods_bucket"].items() if k not in ("elimination", "breach", "collapse")}
    for k, v in other.items():
        print(f"  {k:<12}: {v*100:5.1f}%  {_bar(v)}")
    print(f"  (raw methods: {s['methods_raw']})")
    print(f"  draw rate    : {s['draw_rate']*100:.1f}%")

    print("\nKEY EVENT RATES:")
    print(f"  Last Stand triggers     : {s['last_stand_rate']*100:5.1f}%")
    print(f"  Breach attempted (meter): {s['breach_attempt_rate']*100:5.1f}%")
    print(f"  Breach completed        : {s['breach_complete_rate']*100:5.1f}%")
    print(f"  A death by round 3      : {s['death_by_round3_rate']*100:5.1f}%")
    print(f"  Avg first-death round   : {s['avg_first_death_round']}")
    print(f"  No-death (whole match)  : {s['no_death_rate']*100:5.1f}%")
    print(f"  Avg total deaths/match  : {s['avg_total_deaths']:.2f}  (max 6)")
    print(f"  Avg channels/match      : {s['avg_channels']:.2f}")

    print("\nSPECIES WIN RATE (per-creature, team result):")
    for sp, wr in sorted(s["sp_winrate"].items(), key=lambda x: -x[1]):
        print(f"  {sp:<12}: {wr*100:5.1f}%  {_bar(wr)}")
    print("\nSPECIES KILL RATE (kills per creature-appearance):")
    for sp, kr in sorted(s["sp_killrate"].items(), key=lambda x: -x[1]):
        print(f"  {sp:<12}: {kr:5.2f}  {_bar(min(1.0, kr/2))}")

    print("\nTOP WINNING COMPS:")
    for comp, cnt in s["top_winning_comps"]:
        print(f"  {cnt:>4}  {'+'.join(comp)}")

    if matrix:
        print("\nMONO-SPECIES MATCHUP MATRIX  (row team win% vs column team, "
              f"{matrix['per_cell']}/cell):")
        cols = [sp.value[:4] for sp in SPECIES_LIST]
        print("            " + "  ".join(f"{c:>5}" for c in cols))
        for a in SPECIES_LIST:
            row = "  ".join(f"{matrix['matrix'][a.value][b.value]*100:5.0f}" for b in SPECIES_LIST)
            print(f"  {a.value:<10}{row}")
        print("\n  OVERALL per-species win rate (avg vs other species):")
        for sp, wr in sorted(matrix["overall"].items(), key=lambda x: -x[1]):
            flag = "  <-- >55%!" if wr > 0.55 else ("  <-- <45%!" if wr < 0.45 else "")
            print(f"    {sp:<12}: {wr*100:5.1f}%  {_bar(wr)}{flag}")
    print("=" * 72)


# ---------------------------------------------------------------------------
# Target check
# ---------------------------------------------------------------------------

TARGETS = {
    "avg_rounds": (7.0, 8.0),
    "elim_pct": (0.50, 0.70),       # ~60%
    "breach_pct": (0.18, 0.32),     # ~25%
    "collapse_pct": (0.08, 0.22),   # ~15%
    "last_stand": (0.40, 0.60),
    "breach_attempt": (0.50, 1.0),
    "death_by_r3": (0.80, 1.0),
    "max_species_winrate": (0.0, 0.55),
}


def check_targets(s: dict, matrix: dict | None) -> list[tuple[str, bool, str]]:
    out = []

    def chk(name, val, lo, hi, fmt="{:.2f}"):
        ok = lo <= val <= hi
        out.append((name, ok, f"{fmt.format(val)} (target {fmt.format(lo)}-{fmt.format(hi)})"))

    chk("avg match length", s["avg_rounds"], *TARGETS["avg_rounds"])
    chk("elimination %", s["methods_bucket"].get("elimination", 0), *TARGETS["elim_pct"])
    chk("breach %", s["methods_bucket"].get("breach", 0), *TARGETS["breach_pct"])
    chk("collapse %", s["methods_bucket"].get("collapse", 0), *TARGETS["collapse_pct"])
    chk("last stand rate", s["last_stand_rate"], *TARGETS["last_stand"])
    chk("breach attempt rate", s["breach_attempt_rate"], *TARGETS["breach_attempt"])
    chk("death by round 3", s["death_by_round3_rate"], *TARGETS["death_by_r3"])
    # Primary species balance: per-creature win rate across ALL varied matchups —
    # the representative, real-play reading of "no species wins >55% across all
    # matchups". (The 3-of-a-kind mono matrix below is an artificial stress test.)
    pc_hi = max(s["sp_winrate"].values()); pc_hi_sp = max(s["sp_winrate"], key=s["sp_winrate"].get)
    pc_lo = min(s["sp_winrate"].values()); pc_lo_sp = min(s["sp_winrate"], key=s["sp_winrate"].get)
    out.append(("max species winrate", pc_hi <= 0.55,
                f"{pc_hi*100:.1f}% ({pc_hi_sp})  [low {pc_lo*100:.1f}% {pc_lo_sp}]  (target 45-55%)"))
    if matrix:
        worst = max(matrix["overall"].values())
        worst_sp = max(matrix["overall"], key=matrix["overall"].get)
        out.append(("mono-swarm worst (info)", worst <= 0.62,
                    f"{worst*100:.1f}% ({worst_sp}) (soft <=62%; mono 3x is degenerate/rare)"))
    return out


def print_targets(checks: list[tuple[str, bool, str]]) -> None:
    print("\nTARGET CHECK:")
    allok = True
    for name, ok, detail in checks:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            allok = False
        print(f"  [{mark}] {name:<22}: {detail}")
    print(f"\n  >>> {'ALL TARGETS HIT' if allok else 'SOME TARGETS MISSED'} <<<")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    do_matrix = "--no-matrix" not in sys.argv

    records = run_varied(n)
    s = summarize(records)
    matrix = run_matchup_matrix() if do_matrix else None

    print_report(s, matrix)
    checks = check_targets(s, matrix)
    print_targets(checks)

    if out_path:
        with open(out_path, "w") as f:
            json.dump({"summary": s, "matrix": matrix,
                       "checks": [(c[0], c[1], c[2]) for c in checks]}, f, indent=2, default=str)
        print(f"\n[wrote {out_path}]")
