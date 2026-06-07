"""One-shot: re-measure the prop tables (SPECIES_SURVIVAL_BY_COUNT,
FIRST_BLOOD_BY_SPD_DIFF) from the live (budget-200, post-P6) sim, so the
arena_props models match the new event distribution. Prints paste-ready dicts."""
import sys
from collections import defaultdict

from arena_balance_sim import run_varied_with_configs
from arena_species import Species, SPECIES_STATS

N = int(sys.argv[1]) if len(sys.argv) > 1 else 6000
records = run_varied_with_configs(N)

SPD = {s.value: SPECIES_STATS[s].spd for s in Species}

# --- species survival by count (>=1 of species survives, count across both teams) ---
surv = defaultdict(lambda: [0, 0])  # (species, count) -> [survived, total]
fb = defaultdict(lambda: [0, 0])    # spd_diff -> [red_first, total_with_a_first_blood]

for r in records:
    red, blue = r["red_config"], r["blue_config"]
    species_count = defaultdict(int)
    for c in red + blue:
        species_count[c["species"].lower()] += 1
    survivors = set(s.lower() for s in r["surviving_species"])
    for sp, cnt in species_count.items():
        k = max(1, min(cnt, 4))
        surv[(sp, k)][1] += 1
        if sp in survivors:
            surv[(sp, k)][0] += 1

    rmax = max((SPD.get(c["species"].lower(), 0) for c in red), default=0)
    bmax = max((SPD.get(c["species"].lower(), 0) for c in blue), default=0)
    diff = max(-3, min(3, rmax - bmax))
    fbt = r.get("first_blood_team")
    if fbt in ("red", "blue"):
        fb[diff][1] += 1
        if fbt == "red":
            fb[diff][0] += 1

print(f"# measured from {N} budget-200 varied matches (P6 + re-tuned stats)")
print("SPECIES_SURVIVAL_BY_COUNT = {")
for sp in [s.value for s in Species]:
    row = []
    for k in (1, 2, 3, 4):
        won, tot = surv[(sp, k)]
        p = won / tot if tot else 0.0
        row.append(f"{k}: {p:.3f}")
    samples = "  ".join(f"n{k}={surv[(sp,k)][1]}" for k in (1, 2, 3, 4))
    print(f'    "{sp}":{" "*(12-len(sp))}{{{", ".join(row)}}},   # {samples}')
print("}")

print("\nFIRST_BLOOD_BY_SPD_DIFF = {")
cells = []
for d in range(-3, 4):
    red_first, tot = fb[d]
    p = red_first / tot if tot else 0.5
    cells.append(f"{d}: {p:.3f}")
print("    " + ", ".join(cells))
print("}  # samples: " + "  ".join(f"d{d}={fb[d][1]}" for d in range(-3, 4)))
