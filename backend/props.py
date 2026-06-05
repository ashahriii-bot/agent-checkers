"""Prop bet definitions, odds calculation, and resolution logic."""

from database import HOUSE_EDGE

PROP_TYPES = {
    "first_blood": {"label": "FIRST BLOOD", "icon": "⚔", "desc": "Which side draws first blood?"},
    "king_race": {"label": "CROWN RACE", "icon": "👑", "desc": "Which side crowns a king first?"},
    "total_moves_ou": {"label": "THE DISTANCE", "icon": "📊", "desc": "Will it go the distance? Over or under {line} moves"},
    "total_captures_ou": {"label": "BODY COUNT", "icon": "💥", "desc": "How many pieces fall? Over or under {line} captures"},
    "clean_sweep": {"label": "BLOWOUT", "icon": "🧹", "desc": "Will the winner have 5+ pieces standing?"},
    "shrink_casualty": {"label": "HAZARD KILL", "icon": "💀", "desc": "Will the shrinking board claim a piece?"},
    "comeback": {"label": "THE COMEBACK", "icon": "🔄", "desc": "Will either side overcome a 3+ piece deficit?"},
    "perk_frenzy": {"label": "POWER SURGE", "icon": "⚡", "desc": "Will perks activate 8+ times combined?"},
}


# 2v2-specific props (resolved in team.resolve_team_props against team dynamics)
TEAM_PROP_TYPES = {
    "alpha_dog": {"label": "ALPHA DOG", "icon": "🐺", "desc": "Which agent leads more moves on the winning team?"},
    "team_clash": {"label": "TEAM CLASH", "icon": "⚔", "desc": "Will the winning team agree on over 50% of moves?"},
    "double_edge": {"label": "DOUBLE EDGE", "icon": "⚡", "desc": "Will both of your agents' edges activate at least once?"},
}


def _odds(prob):
    return round((1 / max(prob, 0.01)) * (1 - HOUSE_EDGE), 2)


def calculate_prop_odds(red_config: dict, black_config: dict,
                        red_perk: str | None = None, black_perk: str | None = None) -> list[dict]:
    props = []
    ra = red_config.get("aggression", 50) / 100
    ba = black_config.get("aggression", 50) / 100
    rk = red_config.get("king_priority", 50) / 100
    bk = black_config.get("king_priority", 50) / 100
    rr = red_config.get("risk_tolerance", 50) / 100
    br = black_config.get("risk_tolerance", 50) / 100

    # first blood
    p_red_fb = (ra + 0.1) / (ra + ba + 0.2)
    props.append({
        "type": "first_blood", **PROP_TYPES["first_blood"],
        "options": [
            {"selection": "red", "label": "Red", "odds": _odds(p_red_fb)},
            {"selection": "black", "label": "Black", "odds": _odds(1 - p_red_fb)},
        ],
    })

    # king race
    p_red_kr = (rk + 0.1) / (rk + bk + 0.2)
    p_neither = 0.05
    props.append({
        "type": "king_race", **PROP_TYPES["king_race"],
        "options": [
            {"selection": "red", "label": "Red", "odds": _odds(p_red_kr * (1 - p_neither))},
            {"selection": "black", "label": "Black", "odds": _odds((1 - p_red_kr) * (1 - p_neither))},
            {"selection": "neither", "label": "Neither", "odds": _odds(p_neither)},
        ],
    })

    # total moves over/under
    avg_aggro = (ra + ba) / 2
    avg_risk = (rr + br) / 2
    move_line = round(75 - 20 * avg_aggro + 10 * (1 - avg_risk))
    props.append({
        "type": "total_moves_ou", **PROP_TYPES["total_moves_ou"],
        "desc": f"Over or under {move_line} moves?", "line": move_line,
        "options": [
            {"selection": "over", "label": f"Over {move_line}", "odds": 1.82},
            {"selection": "under", "label": f"Under {move_line}", "odds": 1.88},
        ],
    })

    # total captures over/under
    cap_line = round(16 + 4 * avg_aggro - 2)
    props.append({
        "type": "total_captures_ou", **PROP_TYPES["total_captures_ou"],
        "desc": f"Over or under {cap_line} total captures?", "line": cap_line,
        "options": [
            {"selection": "over", "label": f"Over {cap_line}", "odds": 1.82},
            {"selection": "under", "label": f"Under {cap_line}", "odds": 1.88},
        ],
    })

    # clean sweep
    p_sweep = 0.35
    props.append({
        "type": "clean_sweep", **PROP_TYPES["clean_sweep"],
        "options": [
            {"selection": "yes", "label": "Yes (5+ left)", "odds": _odds(p_sweep)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_sweep)},
        ],
    })

    # shrink casualty
    expected_moves = move_line
    p_shrink = 0.55 if expected_moves > 70 else 0.30 if expected_moves > 60 else 0.10
    props.append({
        "type": "shrink_casualty", **PROP_TYPES["shrink_casualty"],
        "options": [
            {"selection": "yes", "label": "Yes", "odds": _odds(p_shrink)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_shrink)},
        ],
    })

    # comeback
    p_comeback = 0.18
    props.append({
        "type": "comeback", **PROP_TYPES["comeback"],
        "options": [
            {"selection": "yes", "label": "Yes", "odds": _odds(p_comeback)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_comeback)},
        ],
    })

    # perk frenzy (only if both have perks)
    if red_perk and black_perk:
        p_frenzy = 0.4 if (ra > 0.6 or ba > 0.6) else 0.2
        props.append({
            "type": "perk_frenzy", **PROP_TYPES["perk_frenzy"],
            "options": [
                {"selection": "yes", "label": "Yes (8+)", "odds": _odds(p_frenzy)},
                {"selection": "no", "label": "No", "odds": _odds(1 - p_frenzy)},
            ],
        })

    return props


def resolve_props(boards: list, moves: list, events: list, prop_bets: list, winner: str) -> list[dict]:
    results = []
    RED, RED_KING, BLACK, BLACK_KING = 1, 3, 2, 4

    for prop in prop_bets:
        ptype = prop["type"]
        sel = prop["selection"]
        amount = prop["amount"]
        odds = prop["odds"]
        line = prop.get("line")
        res = {"type": ptype, "label": PROP_TYPES.get(ptype, {}).get("label", ptype),
               "selection": sel, "amount": amount, "odds": odds, "line": line}

        if ptype == "first_blood":
            for i, m in enumerate(moves):
                if len(m.get("captures", [])) > 0:
                    actual = m["side"]
                    res["actual"] = actual
                    res["result"] = "win" if sel == actual else "loss"
                    res["resolved_at_move"] = i + 1
                    break
            else:
                res["actual"] = "none"
                res["result"] = "loss"

        elif ptype == "king_race":
            first_promo_side = None
            first_promo_move = None
            for i in range(1, len(boards)):
                prev_rk = sum(1 for row in boards[i - 1] for c in row if c == RED_KING)
                prev_bk = sum(1 for row in boards[i - 1] for c in row if c == BLACK_KING)
                cur_rk = sum(1 for row in boards[i] for c in row if c == RED_KING)
                cur_bk = sum(1 for row in boards[i] for c in row if c == BLACK_KING)
                if cur_rk > prev_rk and not first_promo_side:
                    first_promo_side = "red"
                    first_promo_move = i
                    break
                if cur_bk > prev_bk and not first_promo_side:
                    first_promo_side = "black"
                    first_promo_move = i
                    break
            actual = first_promo_side or "neither"
            res["actual"] = actual
            res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = first_promo_move

        elif ptype == "total_moves_ou":
            total = len(moves)
            res["actual_value"] = total
            if total == line:
                res["result"] = "push"
                res["actual"] = "push"
            else:
                actual = "over" if total > line else "under"
                res["actual"] = actual
                res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = total

        elif ptype == "total_captures_ou":
            total_caps = sum(len(m.get("captures", [])) for m in moves)
            res["actual_value"] = total_caps
            if total_caps == line:
                res["result"] = "push"
                res["actual"] = "push"
            else:
                actual = "over" if total_caps > line else "under"
                res["actual"] = actual
                res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = len(moves)

        elif ptype == "clean_sweep":
            if winner == "draw":
                res["actual"] = "no"
                res["result"] = "win" if sel == "no" else "loss"
            else:
                fb = boards[-1] if boards else []
                rc = sum(1 for row in fb for c in row if c in (RED, RED_KING))
                bc = sum(1 for row in fb for c in row if c in (BLACK, BLACK_KING))
                winner_pieces = rc if winner == "red" else bc
                actual = "yes" if winner_pieces >= 5 else "no"
                res["actual"] = actual
                res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = len(moves)

        elif ptype == "shrink_casualty":
            casualties = any(
                any(k.get("had_piece") for k in e.get("killed", []))
                for e in events if e.get("type") == "shrink"
            )
            actual = "yes" if casualties else "no"
            res["actual"] = actual
            res["result"] = "win" if sel == actual else "loss"
            # find the move where it happened
            for e in events:
                if e.get("type") == "shrink" and any(k.get("had_piece") for k in e.get("killed", [])):
                    res["resolved_at_move"] = e.get("move")
                    break

        elif ptype == "comeback":
            had_comeback = False
            if winner != "draw":
                worst_deficit = 0
                for b in boards:
                    rc = sum(1 for row in b for c in row if c in (RED, RED_KING))
                    bc = sum(1 for row in b for c in row if c in (BLACK, BLACK_KING))
                    deficit = (bc - rc) if winner == "red" else (rc - bc)
                    worst_deficit = max(worst_deficit, deficit)
                had_comeback = worst_deficit >= 3
            actual = "yes" if had_comeback else "no"
            res["actual"] = actual
            res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = len(moves)

        elif ptype == "perk_frenzy":
            perk_count = len([e for e in events if e.get("type") == "perk_activate"])
            actual = "yes" if perk_count >= 8 else "no"
            res["actual"] = actual
            res["actual_value"] = perk_count
            res["result"] = "win" if sel == actual else "loss"
            res["resolved_at_move"] = len(moves)

        # calculate payout
        if res.get("result") == "win":
            res["payout"] = int(amount * odds)
        elif res.get("result") == "push":
            res["payout"] = amount  # refund
        else:
            res["payout"] = 0

        results.append(res)

    return results


def calculate_team_prop_odds(red_a: dict, red_b: dict, perk_a, perk_b,
                             diversity_frac: float) -> list[dict]:
    """Odds for the three 2v2-specific props, from the player's (red) team composition."""
    props = []

    # ALPHA DOG: the more decisive personality (aggression + risk) tends to dominate eval
    proxy_a = red_a.get("aggression", 50) + red_a.get("risk_tolerance", 50) + 1
    proxy_b = red_b.get("aggression", 50) + red_b.get("risk_tolerance", 50) + 1
    p_a = proxy_a / (proxy_a + proxy_b)
    props.append({
        "type": "alpha_dog", **TEAM_PROP_TYPES["alpha_dog"],
        "options": [
            {"selection": "agent_a", "label": "Agent A", "odds": _odds(p_a)},
            {"selection": "agent_b", "label": "Agent B", "odds": _odds(1 - p_a)},
        ],
    })

    # TEAM CLASH: more diverse pairs disagree more, so "under 50% agreement" gets likelier
    p_under = min(0.9, 0.45 + diversity_frac * 0.45)
    props.append({
        "type": "team_clash", **TEAM_PROP_TYPES["team_clash"],
        "options": [
            {"selection": "over", "label": "Over 50% (harmonious)", "odds": _odds(1 - p_under)},
            {"selection": "under", "label": "Under 50% (one carried)", "odds": _odds(p_under)},
        ],
    })

    # DOUBLE EDGE: needs both agents to own an edge; aggression drives activations
    if perk_a and perk_b:
        avg_aggro = (red_a.get("aggression", 50) + red_b.get("aggression", 50)) / 200
        p_yes = min(0.9, 0.45 + avg_aggro * 0.4)
    else:
        p_yes = 0.04  # an agent with no edge can never activate one
    props.append({
        "type": "double_edge", **TEAM_PROP_TYPES["double_edge"],
        "options": [
            {"selection": "yes", "label": "Yes (both fire)", "odds": _odds(p_yes)},
            {"selection": "no", "label": "No", "odds": _odds(1 - p_yes)},
        ],
    })

    return props
