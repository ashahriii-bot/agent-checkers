#!/usr/bin/env python3
"""Arena-Props Economy Audit for Agent Checkers.

The sibling of `scripts/economy_audit.py`, for the **arena sportsbook** instead of
the main book. Where the main audit's `heat` hold row is the standing acceptance
test for the variable-odds book, THIS script is the standing acceptance test for
the arena prop bets (`backend/arena_props.py`): it proves every prop type still
holds the house edge after a combat-balance change.

How it works
------------
The arena props are priced from a *model* of each event's probability (e.g. the
chance a species survives, or a match goes over 7 rounds). Unlike the main book —
whose odds are derived from the same elo number it settles against, so the edge is
exact by construction — the arena odds are only as good as those models. If the
underlying event rates shift (a balance pass) the models go stale and the realized
hold drifts off +5%, opening an exploit (this is exactly the `total_rounds_ou`
line-5 bug `docs/ARENA-BALANCE-REPORT.md` describes).

So this audit closes the loop empirically:

  1. Simulate N matches through the real engine via the balance harness
     (`backend/arena_balance_sim.run_varied_with_configs`), which hands back, per
     match, both the team configs AND the resolved facts (rounds, breach, last
     stand, first blood, surviving species).
  2. Re-price every prop from the same comp with `calculate_arena_props`.
  3. Bet one unit on BOTH sides of every prop and settle it against the facts.
     A perfectly calibrated book holds exactly +5% on *every* selection, so an
     even-money book holds +5% per prop type; any drift means the model is stale.
  4. Assert each prop type holds ≈ +5% (HOUSE_EDGE). Re-run after any arena
     balance change — the per-type hold rows are the acceptance test.

We also report each prop's per-SELECTION hold and a calibration table (implied
probability vs. realized rate), because a healthy net hold can still hide a
one-sided exploit (a binary prop can net +6% while one side is deeply -EV).

Run from the repo root (or anywhere):
    python3 scripts/arena_props_audit.py            # default N
    python3 scripts/arena_props_audit.py 12000      # more matches (tighter)
Writes the report to docs/ARENA_PROPS_AUDIT.md and echoes it to stdout. Exits
non-zero if any prop type fails the hold band, so it can gate CI. stdlib only.
"""

import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
# Point the DB at a throwaway file so importing arena_props -> database (which
# runs init_db() at import) never touches the real matches.db.
os.environ.setdefault("DB_PATH", "/tmp/arena_props_audit_dummy.db")

from database import HOUSE_EDGE  # noqa: E402
from arena_props import calculate_arena_props  # noqa: E402
from arena_balance_sim import run_varied_with_configs  # noqa: E402

SEED = 20260607          # distinct from the model-fit seeds -> a genuine held-out test
DEFAULT_N = 8000

# Acceptance band around the house edge (percentage points). A prop type must hold
# within FAIL_TOL of +5%; WARN_TOL is the tighter "looks healthy" band. SIDE_WARN
# flags a single selection that is exploitably -EV even if the net type passes.
TARGET = HOUSE_EDGE * 100        # +5.0
FAIL_TOL = 2.0                   # hard fail outside [3%, 7%]
WARN_TOL = 1.0                   # soft warn outside [4%, 6%]
SIDE_WARN = -8.0                 # a selection paying back this much edge to the bettor

PROP_ORDER = ["breach_completion", "first_blood", "total_rounds_ou",
              "last_stand", "species_survivor"]


def _implied_p(odds: float) -> float:
    """Back out the model probability the offered odds imply: odds = (1-edge)/p."""
    return (1 - HOUSE_EDGE) / odds if odds else 0.0


def _prop_outcome(prop: dict, selection: str, rec: dict):
    """Did `selection` of `prop` win, given a match record's resolved facts?
    Returns True (win), False (loss), or None (push -> stake refunded).
    Mirrors backend/arena_props.resolve_arena_props against authoritative facts."""
    ptype = prop["type"]
    if ptype == "breach_completion":
        return (selection == "yes") == bool(rec["breach_completed"])
    if ptype == "first_blood":
        return rec["first_blood_team"] == selection      # None -> both sides lose
    if ptype == "total_rounds_ou":
        line = prop.get("line", 7)
        if rec["rounds"] == line:
            return None                                   # push
        over = rec["rounds"] > line
        return (selection == "over") == over
    if ptype == "last_stand":
        return (selection == "yes") == bool(rec["last_stand"])
    if ptype == "species_survivor":
        survived = prop["species"] in rec["surviving_species"]
        return (selection == "yes") == survived
    return False


def run_audit(n: int = DEFAULT_N, seed: int = SEED) -> dict:
    """Simulate n matches, price + settle every prop both ways, accumulate hold
    and calibration stats per prop type and per selection."""
    records = run_varied_with_configs(n, seed=seed)

    # type -> [staked, returned]; selection stats -> [staked, returned, wins, sum_implied_p, n, pushes]
    by_type = defaultdict(lambda: [0.0, 0.0])
    by_side = defaultdict(lambda: [0.0, 0.0, 0, 0.0, 0, 0])
    # species_survivor broken out per species: species -> selection -> stats
    by_species = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0, 0.0, 0, 0]))
    pushes = defaultdict(int)

    for rec in records:
        props = calculate_arena_props(rec["red_config"], rec["blue_config"])
        for prop in props:
            ptype = prop["type"]
            for opt in prop["options"]:
                sel = opt["selection"]
                odds = opt["odds"]
                outcome = _prop_outcome(prop, sel, rec)
                stake = 1.0
                if outcome is None:                       # push: stake refunded
                    payout = stake
                    pushes[ptype] += 1
                elif outcome:
                    payout = stake * odds
                else:
                    payout = 0.0
                is_push = outcome is None
                by_type[ptype][0] += stake
                by_type[ptype][1] += payout
                s = by_side[(ptype, sel)]
                s[0] += stake; s[1] += payout
                s[2] += 1 if outcome else 0
                s[3] += _implied_p(odds); s[4] += 1; s[5] += 1 if is_push else 0
                if ptype == "species_survivor":
                    ss = by_species[prop["species"]][sel]
                    ss[0] += stake; ss[1] += payout
                    ss[2] += 1 if outcome else 0
                    ss[3] += _implied_p(odds); ss[4] += 1; ss[5] += 1 if is_push else 0

    def hold(staked, returned):
        return 100 * (staked - returned) / staked if staked else 0.0

    type_rows = {}
    for ptype, (st, rt) in by_type.items():
        type_rows[ptype] = {"hold": hold(st, rt), "n_bets": int(st), "pushes": pushes[ptype]}
    # actual_p excludes pushes from the denominator so it is comparable to the
    # implied (conditional) probability the odds bake in.
    side_rows = {}
    for (ptype, sel), (st, rt, wins, simp, cnt, pu) in by_side.items():
        live = cnt - pu
        side_rows[(ptype, sel)] = {
            "hold": hold(st, rt), "n": cnt,
            "implied_p": (simp / cnt) if cnt else 0.0,
            "actual_p": (wins / live) if live else 0.0,
        }
    species_rows = {}
    for sp, sels in by_species.items():
        species_rows[sp] = {}
        for sel, (st, rt, wins, simp, cnt, pu) in sels.items():
            live = cnt - pu
            species_rows[sp][sel] = {
                "hold": hold(st, rt), "n": cnt,
                "implied_p": (simp / cnt) if cnt else 0.0,
                "actual_p": (wins / live) if live else 0.0,
            }
    return {"n": n, "seed": seed, "type": type_rows, "side": side_rows,
            "species": species_rows}


def _verdict(h: float) -> tuple[str, bool]:
    """(label, is_pass) for a hold value against the acceptance band."""
    if abs(h - TARGET) <= WARN_TOL:
        return "PASS", True
    if abs(h - TARGET) <= FAIL_TOL:
        return "WARN", True
    return "FAIL", False


def build_report(stats: dict) -> tuple[str, bool]:
    t = stats["type"]
    side = stats["side"]
    L = []
    w = L.append
    all_ok = True

    w("# Agent Checkers — Arena-Props Economy Audit")
    w("")
    w(f"*Generated by `scripts/arena_props_audit.py` (seed {stats['seed']}, "
      f"{stats['n']:,} simulated matches). House edge **{TARGET:.0f}%** imported live from "
      f"`backend/database.py`; props priced live by `backend/arena_props.py`; matches run through the "
      f"real engine via `backend/arena_balance_sim.py`. Re-run after any arena balance change.*")
    w("")
    w("## What this checks")
    w("")
    w("Arena prop odds are derived from **probability models** of combat events, not from a settled "
      "elo number, so a balance pass can silently invalidate them. This audit simulates matches, "
      "re-prices every prop from the same comp, bets **one unit on both sides**, and settles against "
      "the actual outcome. A calibrated book holds the **+5% edge on every selection**, so an "
      "even-money book holds +5% per prop type. The per-type **hold** rows below are the acceptance "
      f"test — each must land within ±{FAIL_TOL:.0f} pts of +{TARGET:.0f}%.")
    w("")

    # ---- headline: per-type hold ----
    w("## Realized hold by prop type (the acceptance test)")
    w("")
    w("| Prop type | Realized hold | Bets | Verdict |")
    w("|---|---|---|---|")
    for ptype in PROP_ORDER:
        if ptype not in t:
            continue
        h = t[ptype]["hold"]
        label, ok = _verdict(h)
        all_ok = all_ok and ok
        push_note = f" · {t[ptype]['pushes']} push" if t[ptype]["pushes"] else ""
        w(f"| `{ptype}` | **{h:+.2f}%** | {t[ptype]['n_bets']:,}{push_note} | {label} |")
    w("")
    w(f"*Band: PASS within ±{WARN_TOL:.0f} pt of +{TARGET:.0f}%, WARN within ±{FAIL_TOL:.0f} pt, "
      f"FAIL beyond. A push (rounds == line) refunds the stake.*")
    w("")

    # ---- per-selection holds + calibration ----
    w("## Per-selection calibration (implied vs. realized)")
    w("")
    w("Each prop both ways. `implied p` is the probability the offered odds bake in "
      "((1−edge)/odds); `actual` is how often that selection truly won. Calibrated ⇒ they match and "
      "each side holds ≈ +5%. A side far below +5% is a bettor-exploitable edge even when the net "
      "type passes.")
    w("")
    w("| Prop / selection | implied p | actual | side hold |")
    w("|---|---|---|---|")
    side_flags = []
    for ptype in PROP_ORDER:
        sels = sorted([s for (pt, s) in side if pt == ptype])
        for sel in sels:
            r = side[(ptype, sel)]
            flag = ""
            if r["hold"] < SIDE_WARN:
                flag = "  ⚠"
                side_flags.append((ptype, sel, r["hold"]))
            w(f"| `{ptype}` · {sel} | {r['implied_p']:.3f} | {r['actual_p']:.3f} | "
              f"{r['hold']:+.2f}%{flag} |")
    w("")

    # ---- species_survivor detail ----
    if stats["species"]:
        w("## `species_survivor` by species (the recalibrated prop)")
        w("")
        w("Old model priced survival from `(hp + 2·def)/15`, which over-priced fast glass creatures "
          "(Razorwing). The new model is a per-species, count-aware table measured from simulation — "
          "the prop resolves on *≥1 of that species surviving across both teams*, so the count in the "
          "matchup is the dominant driver.")
        w("")
        w("| Species | YES implied | YES actual | YES hold | NO hold |")
        w("|---|---|---|---|---|")
        order = ["razorwing", "ironjaw", "embercaster", "warden", "hexwright"]
        sp_rows = stats["species"]
        for sp in order + [s for s in sp_rows if s not in order]:
            if sp not in sp_rows:
                continue
            y = sp_rows[sp].get("yes", {})
            no = sp_rows[sp].get("no", {})
            w(f"| {sp} | {y.get('implied_p', 0):.3f} | {y.get('actual_p', 0):.3f} | "
              f"{y.get('hold', 0):+.2f}% | {no.get('hold', 0):+.2f}% |")
        w("")
        w("*Low-survival species (Razorwing) carry high variance on the rare YES win, so the YES-side "
          "realized hold is noisy and runs above +5% at this sample size even when the implied "
          "probability matches the actual rate — the implied-vs-actual columns are the cleaner "
          "calibration read for those.*")
        w("")

    # ---- verdict ----
    w("## Verdict")
    w("")
    if all_ok:
        w(f"**PASS** — every prop type holds within ±{FAIL_TOL:.0f} pts of the +{TARGET:.0f}% house "
          f"edge. The arena book is calibrated against the current combat balance.")
    else:
        w(f"**FAIL** — at least one prop type holds outside ±{FAIL_TOL:.0f} pts of +{TARGET:.0f}%. "
          f"The pricing model in `backend/arena_props.py` is stale for that prop; recalibrate it "
          f"against fresh simulation rates (see `docs/ARENA-BALANCE-REPORT.md` §4f for the pattern) "
          f"and re-run.")
    w("")
    if side_flags:
        w("**Per-side note:** "
          + "; ".join(f"`{pt}`·{sel} holds {h:+.1f}%" for pt, sel, h in side_flags)
          + ". The net type still passes, but this selection is one-sidedly generous — a sharp bettor "
            "could lean on it. Flatten that side's model when convenient (it is not a solvency risk on "
            "free-play coins).")
        w("")
    w(f"**Standing instruction:** re-run `python3 scripts/arena_props_audit.py` after any change to "
      f"the arena engine, species stats, AI weights, or `arena_props.py`. The per-type hold rows must "
      f"stay ≈ +{TARGET:.0f}% — they are to the arena book what the `heat` row is to the main book.")
    w("")
    return "\n".join(L), all_ok


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_N
    print(f"Running arena-props audit ({n:,} matches, seed {SEED})...", file=sys.stderr)
    stats = run_audit(n)
    report, ok = build_report(stats)
    out_path = ROOT / "docs" / "ARENA_PROPS_AUDIT.md"
    out_path.write_text(report)
    print(report)
    print(f"\n[report written to {out_path}]", file=sys.stderr)
    print(f"[{'PASS' if ok else 'FAIL'}]", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
