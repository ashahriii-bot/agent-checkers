"""2v2 Tag Team: two agents per side share one set of pieces via consensus.

Both agents evaluate every legal move; their scores are averaged and the team plays
the highest combined score. The team's behavior EMERGES from the two personalities.

Design note on the diversity bonus: as a uniform multiplier on a team's own combined
scores it is INERT for move selection (scaling every move's score equally cannot change
which ranks highest, and teams never compare scores across the board). So the multiplier
is kept for elo / odds / display, and the real win-rate lever is consensus SHARPNESS:
a diverse pair's averaged evaluation cancels each agent's blind spots, so it plays its
top consensus move more reliably. A clone pair (diversity 0) stays on the baseline
uniform top-3 pick. This is what makes diverse teams win ~52-55% (spec scenarios 3/10).
"""

import random

from ai import evaluate_move, calc_overextension_factor

SLIDERS = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]

# How strongly config diversity sharpens the consensus pick. At diversity 0 (clones) the
# team always uses the baseline uniform top-3 choice; at full diversity it favors its top
# consensus move with probability (diversity_frac * this). The lever saturates fast in this
# engine, so a small value suffices: tuned to ~54% for a berserker+turtle pair vs a double
# berserker -- diverse teams win slightly more (spec's 52-55%), never oppressively.
DIVERSITY_SHARPNESS = 0.10

# A move counts as "agreement" (neither agent led) only when the two scores are within
# ~8% of each other (agreement score >= this). Otherwise the higher scorer led it. This
# makes clone pairs agree on almost everything while diverse pairs rarely agree -- so the
# lead %s and Alpha Dog tell the real story of who drove the team.
AGREEMENT_THRESHOLD = 0.92
# The piece-flash on the frontend uses a stricter 1.3x ratio (decisive dominance only) so
# the flash stays subtle; it is computed there directly from score_a/score_b.
DOMINANCE_RATIO = 1.3


def slider_diversity(config_a, config_b) -> float:
    """Average absolute slider difference, normalized to 0.0 (identical) .. 1.0 (max)."""
    total = sum(abs(getattr(config_a, s) - getattr(config_b, s)) for s in SLIDERS)
    return total / 500.0  # 5 sliders * 100 max diff


def calculate_diversity_bonus(config_a, config_b, perk_a=None, perk_b=None) -> float:
    """1.000 (identical) up to ~1.055. Sliders give up to +5%; different edges add +0.5%."""
    bonus = 1.0 + slider_diversity(config_a, config_b) * 0.05
    if perk_a != perk_b and perk_a and perk_b:
        bonus += 0.005
    return round(bonus, 3)


def team_elo(elo_a: float, elo_b: float, diversity_bonus: float) -> float:
    """Team elo = average of both agents' elo, scaled by the diversity bonus."""
    return round(((elo_a + elo_b) / 2) * diversity_bonus, 1)


def _dominant(score_a: float, score_b: float, agreement: float) -> str:
    if agreement >= AGREEMENT_THRESHOLD:
        return "equal"
    return "a" if score_a > score_b else "b"


def consensus_move(board, side, eff_a, eff_b, fam_a, fam_b,
                   diversity_bonus, diversity_frac, phase="midgame"):
    """Select a move via consensus between two agents (already-effective configs).

    Returns a dict {move, score_a, score_b, combined, dominant, agreement} or None.
    eff_a/eff_b already have perk overrides + progression edges applied by the caller,
    mirroring how the 1v1 loop layers them before pick_move.
    """
    from engine import get_all_moves
    moves = get_all_moves(board, side)
    if not moves:
        return None

    overext_a = calc_overextension_factor(eff_a.aggression, eff_a.risk_tolerance)
    overext_b = calc_overextension_factor(eff_b.aggression, eff_b.risk_tolerance)

    scored = []
    for m in moves:
        # each agent evaluates independently (evaluate_move applies its own familiarity
        # factor + jitter internally, so we pass familiarity through rather than re-scaling)
        score_a = evaluate_move(board, m, eff_a, side, phase, overext_a, fam_a)
        score_b = evaluate_move(board, m, eff_b, side, phase, overext_b, fam_b)
        combined = ((score_a + score_b) / 2) * diversity_bonus
        agreement = max(0.0, min(1.0, 1.0 - abs(score_a - score_b) / max(abs(score_a) + abs(score_b), 0.01)))
        scored.append({
            "move": m,
            "score_a": round(score_a, 2),
            "score_b": round(score_b, 2),
            "combined": combined,
            "dominant": _dominant(score_a, score_b, agreement),
            "agreement": round(agreement, 3),
        })

    scored.sort(key=lambda x: x["combined"], reverse=True)
    top_n = scored[:min(3, len(scored))]
    # diversity sharpens consensus: diverse pairs favor their top move (real win-rate lever)
    if len(top_n) > 1 and diversity_frac > 0 and random.random() < diversity_frac * DIVERSITY_SHARPNESS:
        return top_n[0]
    return random.choice(top_n)


def aggregate_team_dynamics(influence_list, edge_counts) -> dict:
    """Roll up per-move influence for one side into lead %s, agreement %, avg scores.

    influence_list: list of per-move dicts ({dominant, score_a, score_b, ...}).
    edge_counts: {"a": int, "b": int} perk-activation counts for this side's two agents.
    """
    n = len(influence_list)
    a_lead = sum(1 for x in influence_list if x["dominant"] == "a")
    b_lead = sum(1 for x in influence_list if x["dominant"] == "b")
    agreed = sum(1 for x in influence_list if x["dominant"] == "equal")
    a_scores = [x["score_a"] for x in influence_list]
    b_scores = [x["score_b"] for x in influence_list]
    pct = lambda k: round(k / n * 100) if n else 0
    return {
        "moves": n,
        "agent_a_lead": a_lead,
        "agent_b_lead": b_lead,
        "agreed": agreed,
        "agent_a_lead_pct": pct(a_lead),
        "agent_b_lead_pct": pct(b_lead),
        "agreement_pct": pct(agreed),
        "agent_a_avg_score": round(sum(a_scores) / n, 2) if n else 0,
        "agent_b_avg_score": round(sum(b_scores) / n, 2) if n else 0,
        "agent_a_edge_count": edge_counts.get("a", 0),
        "agent_b_edge_count": edge_counts.get("b", 0),
    }


def resolve_team_props(prop_bets, winner, team_dynamics) -> list[dict]:
    """Resolve the three 2v2-specific props against final team dynamics.

    team_dynamics: {"red": {...}, "black": {...}} from aggregate_team_dynamics.
    Alpha Dog / Team Clash resolve on the WINNING team; Double Edge on the player's
    (red) team. Draw falls back to the red team for Alpha Dog / Team Clash.
    """
    from props import TEAM_PROP_TYPES
    win_dyn = team_dynamics.get(winner) if winner in ("red", "black") else team_dynamics.get("red", {})
    red_dyn = team_dynamics.get("red", {})
    results = []
    for prop in prop_bets:
        ptype, sel = prop["type"], prop["selection"]
        amount, odds = prop["amount"], prop["odds"]
        res = {"type": ptype, "label": TEAM_PROP_TYPES.get(ptype, {}).get("label", ptype),
               "selection": sel, "amount": amount, "odds": odds, "line": None}

        if ptype == "alpha_dog":
            actual = "agent_a" if win_dyn.get("agent_a_lead", 0) >= win_dyn.get("agent_b_lead", 0) else "agent_b"
            res["actual"] = actual
            res["detail"] = f"A led {win_dyn.get('agent_a_lead_pct', 0)}% / B led {win_dyn.get('agent_b_lead_pct', 0)}% (winning team)"
            res["result"] = "win" if sel == actual else "loss"

        elif ptype == "team_clash":
            actual = "over" if win_dyn.get("agreement_pct", 0) >= 50 else "under"
            res["actual"] = actual
            res["actual_value"] = win_dyn.get("agreement_pct", 0)
            res["detail"] = f"winning team agreed {win_dyn.get('agreement_pct', 0)}% of moves"
            res["result"] = "win" if sel == actual else "loss"

        elif ptype == "double_edge":
            both = red_dyn.get("agent_a_edge_count", 0) > 0 and red_dyn.get("agent_b_edge_count", 0) > 0
            actual = "yes" if both else "no"
            res["actual"] = actual
            res["detail"] = f"A activated {red_dyn.get('agent_a_edge_count', 0)}x, B activated {red_dyn.get('agent_b_edge_count', 0)}x"
            res["result"] = "win" if sel == actual else "loss"

        res["payout"] = int(amount * odds) if res.get("result") == "win" else 0
        results.append(res)
    return results
