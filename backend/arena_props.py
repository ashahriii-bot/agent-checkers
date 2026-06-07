"""Arena-specific prop bet definitions, odds calculation, and resolution logic."""

from database import HOUSE_EDGE
from arena_species import SPECIES_STATS, Species

ARENA_PROP_TYPES = {
    "breach_completion": {"label": "GATE BREACH", "icon": "\U0001f6aa", "desc": "Will a gate breach happen?"},
    "first_blood": {"label": "FIRST BLOOD", "icon": "⚔", "desc": "Which team draws first blood?"},
    "total_rounds_ou": {"label": "THE DISTANCE", "icon": "\U0001f4ca", "desc": "Over or under {line} rounds?"},
    "last_stand": {"label": "LAST STAND", "icon": "\U0001f480", "desc": "Will Last Stand trigger?"},
    "species_survivor": {"label": "SURVIVOR", "icon": "\U0001f3c6", "desc": "Will a {species} survive the match?"},
}

ROUNDS_LINE = 7

# ---------------------------------------------------------------------------
# Data-driven calibration tables (measured from backend/arena_balance_sim.py
# over 20,000 post-rebalance matches). Re-derive + verify with
# `python3 scripts/arena_props_audit.py` after any combat-balance change — the
# audit's per-prop hold rows must stay ≈ +5%.
# ---------------------------------------------------------------------------

# species_survivor: P(>=1 creature of the species survives, across BOTH teams),
# keyed by how many of that species are in the match. The prop resolves on
# "at least one survives", so the count is the dominant driver — far more than
# raw hp/def (a lone Razorwing survives ~2%, three of them ~18%). Indexed 1..4;
# higher counts (very rare: 5-6 of one species across two 3-creature teams) clamp
# to the k=4 value.
# Re-measured 2026-06-07 from 6000 budget-200 varied matches after the P6 Swoop
# cap + species re-tune (Razorwing HP5->6/ATK4->5, Embercaster HP6->5). Razorwing
# solo survival rose 0.017->0.124 (the P6 intent). See _measure_props.py.
SPECIES_SURVIVAL_BY_COUNT: dict[str, dict[int, float]] = {
    "ironjaw":     {1: 0.311, 2: 0.535, 3: 0.715, 4: 0.731},
    "razorwing":   {1: 0.124, 2: 0.314, 3: 0.491, 4: 0.644},
    "embercaster": {1: 0.392, 2: 0.586, 3: 0.683, 4: 0.761},
    "warden":      {1: 0.348, 2: 0.594, 3: 0.783, 4: 0.923},
    "hexwright":   {1: 0.370, 2: 0.599, 3: 0.739, 4: 0.830},
}
_SURVIVAL_DEFAULT = {1: 0.30, 2: 0.50, 3: 0.70, 4: 0.85}  # unknown species fallback

# first_blood: P(RED draws first blood), keyed by (red_max_spd - blue_max_spd),
# clamped to [-3, 3]. Counter-intuitively the FASTER team draws first blood LESS
# often: its fastest creature rushes into contact first and becomes the first
# casualty. There is also a structural red-side edge at equal speed (red ~0.62).
# The old aggression+speed score had this backwards (speed was added with the
# wrong sign), so it priced the wrong team as favourite — measured rates below.
# Re-measured 2026-06-07 (budget-200, post-P6). The Swoop cap removed Razorwing's
# turn-1 first blood, flattening the curve. Sparse endpoints d=±3 (n~24) are
# smoothed monotonically; the well-sampled middle (d=-2..2, n=568-2188) is raw.
FIRST_BLOOD_BY_SPD_DIFF: dict[int, float] = {
    -3: 0.750, -2: 0.728, -1: 0.603, 0: 0.628, 1: 0.509, 2: 0.366, 3: 0.300,
}


def _species_survival_prob(species_name: str, count: int) -> float:
    """P(>=1 of this species survives) given how many are in the match."""
    table = SPECIES_SURVIVAL_BY_COUNT.get(species_name.lower(), _SURVIVAL_DEFAULT)
    k = max(1, min(count, max(table)))
    return table[k]


def _first_blood_p_red(red_max_spd: int, blue_max_spd: int) -> float:
    """P(red draws first blood) from the speed gap (clamped to the table)."""
    diff = max(-3, min(3, red_max_spd - blue_max_spd))
    return FIRST_BLOOD_BY_SPD_DIFF[diff]


def _odds(prob: float) -> float:
    """Convert probability to decimal odds with house edge applied."""
    return round((1 / max(prob, 0.01)) * (1 - HOUSE_EDGE), 2)


def _has_species(team: list[dict], species_name: str) -> bool:
    """Check if a team has a creature of the given species."""
    return any(c.get("species", "").lower() == species_name.lower() for c in team)


def _max_stat(team: list[dict], stat: str) -> int:
    """Get the max base stat across a team's species."""
    best = 0
    for c in team:
        sp_name = c.get("species", "")
        try:
            sp = Species(sp_name.lower())
            stats = SPECIES_STATS[sp]
            val = getattr(stats, stat, 0)
            best = max(best, val)
        except (ValueError, KeyError):
            pass
    return best


def _avg_stat(teams: list[list[dict]], stat: str) -> float:
    """Average a base stat across all creatures in multiple teams."""
    total, count = 0, 0
    for team in teams:
        for c in team:
            sp_name = c.get("species", "")
            try:
                sp = Species(sp_name.lower())
                stats = SPECIES_STATS[sp]
                val = getattr(stats, stat, 0)
                total += val
                count += 1
            except (ValueError, KeyError):
                pass
    return total / max(count, 1)


def _unique_species(red_team: list[dict], blue_team: list[dict]) -> list[str]:
    """All unique species names across both teams."""
    seen = set()
    result = []
    for c in red_team + blue_team:
        sp = c.get("species", "").lower()
        if sp and sp not in seen:
            seen.add(sp)
            result.append(sp)
    return result


def _species_count(red_team: list[dict], blue_team: list[dict], species_name: str) -> int:
    """How many creatures of a species are in the match, across both teams."""
    target = species_name.lower()
    return sum(1 for c in red_team + blue_team if c.get("species", "").lower() == target)


def calculate_arena_props(red_team: list[dict], blue_team: list[dict]) -> list[dict]:
    """Calculate arena prop bet odds from team compositions.

    Each creature config dict should have: species, aggression, risk_tolerance,
    target_focus, positioning, sacrifice.
    """
    props = []

    # --- breach_completion ---
    # Measured breach rate is ~0.18 for a feature-less comp and rises only to
    # ~0.26 for dedicated rushers — far flatter than the old 0.22 base + big
    # (0.15 / 0.10) bumps + 0.55 cap assumed. Those bumps over-priced breach on
    # high-sacrifice comps (model said up to 0.55, actual ~0.24), which the props
    # audit exposed as a one-sided exploit on the NO selection. Gentle, measured
    # adjustments keep both sides ≈ +5%. See scripts/arena_props_audit.py.
    # Re-fit 2026-06-07 (post-P6): the Swoop cap pushed measured breach completion
    # down to ~0.186 (audit) / ~0.19 (balance sim) and flatter across comps. The
    # old 0.18 base + 0.04/0.025 bumps + 0.27 cap averaged ~0.238 — a +11% over-hold
    # on the YES side. Lower the base and gentle the bumps to center on the measured
    # rate. See scripts/arena_props_audit.py + _measure_props.py.
    p_breach = 0.165
    for team in (red_team, blue_team):
        for c in team:
            sp = c.get("species", "").lower()
            agg = c.get("aggression", 50)
            sac = c.get("sacrifice", 50)
            if sp == "razorwing" and agg < 50:
                p_breach += 0.02
            if sac > 60:
                p_breach += 0.012
    p_breach = min(p_breach, 0.23)
    props.append({
        "type": "breach_completion",
        **ARENA_PROP_TYPES["breach_completion"],
        "options": [
            {"selection": "yes", "label": "Yes", "odds": _odds(p_breach)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_breach)},
        ],
    })

    # --- first_blood ---
    # Priced from the speed gap (FIRST_BLOOD_BY_SPD_DIFF). The old aggression +
    # speed*10 score was BACKWARDS: the faster team draws first blood LESS often
    # (its fastest creature rushes into contact first and dies first), and
    # aggression barely matters. The audit caught this — the old model was
    # anti-correlated with reality (it priced the wrong team as favourite).
    red_spd = _max_stat(red_team, "spd")
    blue_spd = _max_stat(blue_team, "spd")
    p_red_fb = _first_blood_p_red(red_spd, blue_spd)
    props.append({
        "type": "first_blood",
        **ARENA_PROP_TYPES["first_blood"],
        "options": [
            {"selection": "red", "label": "Red Team", "odds": _odds(p_red_fb)},
            {"selection": "blue", "label": "Blue Team", "odds": _odds(1 - p_red_fb)},
        ],
    })

    # --- total_rounds_ou ---
    # Line = 7. Two calibration fixes the audit forced (see ARENA-BALANCE-REPORT
    # §7.4 and scripts/arena_props_audit.py):
    #   (1) No-tank / low-def matches are MUCH shorter than the old formula's flat
    #       `0.30 + avg_def*0.05` assumed (actual P(over 7) ~12%, not ~33%). DEF
    #       drives length far more steeply than 0.05/pt, and the no-tank case is
    #       its own short regime — hence the separate branches and steep slopes.
    #   (2) ~19% of matches land EXACTLY on 7 (a push/refund). `p_over` is the
    #       probability of going over CONDITIONAL on not pushing, so over is
    #       priced on P(over|!push) and under on P(under|!push); pricing under at
    #       a flat 1-P(over>7) instead leaves the under side badly over-held.
    # Net effect: the prop holds ~edge*(1-P(push)) ≈ 4% (the push refunds ~19% of
    # the action), with both sides balanced.
    line = ROUNDS_LINE
    avg_def = _avg_stat([red_team, blue_team], "def_")
    has_tank = (_has_species(red_team, "ironjaw") or _has_species(blue_team, "ironjaw") or
                _has_species(red_team, "warden") or _has_species(blue_team, "warden"))
    if has_tank:
        p_over = -0.09 + avg_def * 0.66
    else:
        p_over = 0.02 + avg_def * 0.22  # no-tank: much shorter regardless of def
    p_over = max(0.05, min(0.92, p_over))
    props.append({
        "type": "total_rounds_ou",
        **ARENA_PROP_TYPES["total_rounds_ou"],
        "desc": f"Over or under {line} rounds?",
        "line": line,
        "options": [
            {"selection": "over", "label": f"Over {line}", "odds": _odds(p_over)},
            {"selection": "under", "label": f"Under {line}", "odds": _odds(1 - p_over)},
        ],
    })

    # --- last_stand ---
    # Post-rebalance the Last Stand trigger requires a lone, OUTNUMBERED survivor
    # that still has >=60% HP, so 3v3 base is ~0.52 (was 0.70). Smaller starting
    # rosters reach a lone survivor sooner. See docs/ARENA-BALANCE-REPORT.md.
    red_size = len(red_team)
    blue_size = len(blue_team)
    min_size = min(red_size, blue_size)
    if min_size == 1:
        p_last_stand = 0.80  # already alone, but the HP gate still applies
    elif min_size == 2:
        p_last_stand = 0.66
    else:
        p_last_stand = 0.52
    props.append({
        "type": "last_stand",
        **ARENA_PROP_TYPES["last_stand"],
        "options": [
            {"selection": "yes", "label": "Yes", "odds": _odds(p_last_stand)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_last_stand)},
        ],
    })

    # --- species_survivor ---
    # For each unique species across both teams, offer a bet on survival. The prop
    # resolves YES if >=1 creature of that species is alive at the end (on EITHER
    # team), so the survival probability is driven by (a) the species' intrinsic
    # durability and (b) HOW MANY of it are on the board — both captured by the
    # per-species, count-aware SPECIES_SURVIVAL_BY_COUNT table measured from
    # simulation. This replaces the old (hp + 2*def)/15 model, which over-priced
    # fast glass creatures (a Razorwing survives ~2-5%, not ~25%) and ignored the
    # matchup entirely. See scripts/arena_props_audit.py.
    for species_name in _unique_species(red_team, blue_team):
        count = _species_count(red_team, blue_team, species_name)
        p_survives = _species_survival_prob(species_name, count)
        sp_label = species_name.capitalize()
        props.append({
            "type": "species_survivor",
            **ARENA_PROP_TYPES["species_survivor"],
            "desc": f"Will a {sp_label} survive the match?",
            "species": species_name,
            "options": [
                {"selection": "yes", "label": f"{sp_label} Survives", "odds": _odds(p_survives)},
                {"selection": "no", "label": f"{sp_label} Eliminated", "odds": _odds(1 - p_survives)},
            ],
        })

    return props


def resolve_arena_props(props: list[dict], match_result: dict) -> list[dict]:
    """Resolve arena prop bets against a completed match result.

    match_result should have:
      - winner: "red" | "blue" | "draw"
      - win_method: str (e.g. "elimination", "breach", "last_standing")
      - total_rounds: int
      - events: list[dict] with type fields like "kill", "breach_complete", "last_stand"
      - final team snapshots (creatures with species + alive/hp). Accepts either
        `red_team_final`/`blue_team_final` or the engine's own
        `red_team`/`blue_team` (ArenaMatchResult.to_dict() emits the latter).
    """
    results = []
    events = match_result.get("events", [])
    winner = match_result.get("winner", "draw")
    total_rounds = match_result.get("total_rounds", 0)
    # ArenaMatchResult.to_dict() (what /api/arena/simulate returns) uses
    # red_team/blue_team; older callers may pass *_final. Accept both.
    red_final = match_result.get("red_team_final") or match_result.get("red_team") or []
    blue_final = match_result.get("blue_team_final") or match_result.get("blue_team") or []

    # Pre-scan events for resolution
    has_breach = any(e.get("type") == "breach_complete" for e in events)
    kill_events = [e for e in events if e.get("type") == "kill"]
    has_last_stand = any(e.get("type") == "last_stand" for e in events)

    # Determine first blood. The engine's kill events carry the attacker id under
    # data.killer (e.g. "red_0"); fall back to that to derive the team. (Burn /
    # collapse kills have no killer, so skip to the first attributable kill.)
    first_blood_team = None
    for e in kill_events:
        team = e.get("attacker_team") or e.get("team")
        if not team:
            killer = (e.get("data") or {}).get("killer")
            if killer:
                team = "red" if str(killer).startswith("red") else "blue"
        if team:
            first_blood_team = team
            break

    # Surviving species (from final team snapshots). Prefer the explicit `alive`
    # flag (engine to_dict), fall back to hp > 0.
    surviving_species = set()
    for creature in red_final + blue_final:
        alive = creature.get("alive")
        if alive is None:
            alive = creature.get("hp", 0) > 0
        if alive:
            sp = creature.get("species", "").lower()
            if sp:
                surviving_species.add(sp)

    for prop in props:
        ptype = prop["type"]
        sel = prop["selection"]
        amount = prop["amount"]
        odds = prop["odds"]
        res = {
            "type": ptype,
            "label": ARENA_PROP_TYPES.get(ptype, {}).get("label", ptype),
            "selection": sel,
            "amount": amount,
            "odds": odds,
        }

        if ptype == "breach_completion":
            actual = "yes" if has_breach else "no"
            res["actual"] = actual
            res["result"] = "win" if sel == actual else "loss"

        elif ptype == "first_blood":
            if first_blood_team:
                res["actual"] = first_blood_team
                res["result"] = "win" if sel == first_blood_team else "loss"
            else:
                res["actual"] = "none"
                res["result"] = "loss"

        elif ptype == "total_rounds_ou":
            line = prop.get("line", 7)
            res["actual_value"] = total_rounds
            if total_rounds == line:
                res["result"] = "push"
                res["actual"] = "push"
            else:
                actual = "over" if total_rounds > line else "under"
                res["actual"] = actual
                res["result"] = "win" if sel == actual else "loss"

        elif ptype == "last_stand":
            actual = "yes" if has_last_stand else "no"
            res["actual"] = actual
            res["result"] = "win" if sel == actual else "loss"

        elif ptype == "species_survivor":
            species = prop.get("species", "")
            survived = species.lower() in surviving_species
            actual = "yes" if survived else "no"
            res["actual"] = actual
            res["actual_species"] = species
            res["result"] = "win" if sel == actual else "loss"

        else:
            res["result"] = "loss"
            res["actual"] = "unknown"

        # Calculate payout
        if res.get("result") == "win":
            res["payout"] = int(amount * odds)
        elif res.get("result") == "push":
            res["payout"] = amount  # refund
        else:
            res["payout"] = 0

        results.append(res)

    return results
