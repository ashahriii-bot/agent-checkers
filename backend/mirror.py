"""The Mirror: adaptive AI that learns from player match history."""

import json
import random
from dataclasses import dataclass
from datetime import datetime, timezone

from database import get_db

TARGET_WIN_RATE = 0.55
TOLERANCE = 0.05

MIRROR_NAMES = ["Shade", "Whisper", "Phantom", "Wraith", "Specter", "Glitch", "Void", "Null", "Echo", "Static"]

MILESTONES = {
    0: "First encounter. I don't know you yet. But I will.",
    10: "Beginning to understand your tendencies.",
    25: "Strong read on your playstyle.",
    50: "Fully adapted. Outthink me.",
}


def _clamp(val, lo=5, hi=95):
    return max(lo, min(hi, int(val)))


def get_mirror_profile() -> dict:
    conn = get_db()
    r = conn.execute("SELECT * FROM mirror_profile WHERE id = 1").fetchone()
    if not r:
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("INSERT OR IGNORE INTO mirror_profile (id, total_bouts, player_wins, mirror_wins, draws, adaptation_level, current_read, updated_at) VALUES (1,0,0,0,0,0,'{}',?)", (now,))
        conn.commit()
        r = conn.execute("SELECT * FROM mirror_profile WHERE id = 1").fetchone()
    conn.close()
    current_read = {}
    try:
        current_read = json.loads(r["current_read"]) if r["current_read"] else {}
    except (json.JSONDecodeError, TypeError):
        pass
    return {
        "total_bouts": r["total_bouts"],
        "player_wins": r["player_wins"],
        "mirror_wins": r["mirror_wins"],
        "draws": r["draws"],
        "mirror_win_rate": round(r["mirror_wins"] / max(r["total_bouts"], 1), 2),
        "adaptation_level": r["adaptation_level"],
        "current_read": current_read,
    }


def get_mirror_history(limit: int = 20) -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM mirror_history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [{
        "id": r["id"], "created_at": r["created_at"], "winner": r["winner"],
        "player_config": json.loads(r["player_config"]),
        "mirror_config": json.loads(r["mirror_config"]),
        "player_edge": r["player_edge"], "mirror_edge": r["mirror_edge"],
    } for r in rows]


def _compute_player_profile() -> dict:
    """Analyze all match history to build player profile."""
    conn = get_db()
    # get recent Mirror history
    rows = conn.execute("SELECT * FROM mirror_history ORDER BY id DESC LIMIT 100").fetchall()
    conn.close()

    if not rows:
        return {
            "avg_config": {"aggression": 50, "risk_tolerance": 50, "king_priority": 50, "edge_affinity": 50, "trade_down": 50},
            "preferred_edge": None,
            "edge_distribution": {},
            "weakness": None,
            "archetype": "unknown",
            "mirror_win_rate": 0.5,
            "total_bouts": 0,
        }

    # weighted average config (recent = higher weight)
    sliders = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]
    weighted_sums = {s: 0.0 for s in sliders}
    total_weight = 0.0
    edge_counts = {}
    loss_archetype_counts = {}

    for i, r in enumerate(rows):
        weight = 0.95 ** i
        total_weight += weight
        cfg = json.loads(r["player_config"])
        for s in sliders:
            weighted_sums[s] += cfg.get(s, 50) * weight

        edge = r["player_edge"]
        if edge:
            edge_counts[edge] = edge_counts.get(edge, 0) + 1

        # track what beats the player
        if r["winner"] == "mirror":
            mcfg = json.loads(r["mirror_config"])
            agg = mcfg.get("aggression", 50)
            if agg > 65:
                loss_archetype_counts["aggressive"] = loss_archetype_counts.get("aggressive", 0) + 1
            elif agg < 35:
                loss_archetype_counts["defensive"] = loss_archetype_counts.get("defensive", 0) + 1
            elif mcfg.get("trade_down", 50) > 70:
                loss_archetype_counts["trading"] = loss_archetype_counts.get("trading", 0) + 1
            else:
                loss_archetype_counts["balanced"] = loss_archetype_counts.get("balanced", 0) + 1

    avg_config = {s: round(weighted_sums[s] / max(total_weight, 0.01)) for s in sliders}

    # preferred edge
    total_edges = sum(edge_counts.values())
    edge_dist = {k: round(v / max(total_edges, 1), 2) for k, v in edge_counts.items()}
    preferred = max(edge_counts, key=edge_counts.get) if edge_counts else None

    # weakness
    weakness = max(loss_archetype_counts, key=loss_archetype_counts.get) if loss_archetype_counts else None

    # archetype
    avg_agg = avg_config["aggression"]
    if avg_agg > 65:
        archetype = "aggressive"
    elif avg_agg < 35:
        archetype = "defensive"
    elif avg_config["trade_down"] > 65:
        archetype = "trading"
    else:
        archetype = "balanced"

    mirror_wins = sum(1 for r in rows if r["winner"] == "mirror")
    total = len(rows)

    return {
        "avg_config": avg_config,
        "preferred_edge": preferred,
        "edge_distribution": edge_dist,
        "weakness": weakness,
        "archetype": archetype,
        "mirror_win_rate": round(mirror_wins / max(total, 1), 2),
        "total_bouts": total,
    }


def generate_mirror_agent(player_config: dict, player_edge: str | None = None) -> dict:
    """Generate a counter-agent based on player profile."""
    profile = _compute_player_profile()
    avg = profile["avg_config"]

    # base counter: invert dominant sliders
    counter = {}
    sliders = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]
    for s in sliders:
        player_val = avg.get(s, 50)
        counter[s] = _clamp(100 - player_val + random.randint(-15, 15))

    # counter-edge
    pref = profile["preferred_edge"] or player_edge
    if pref == "rope_a_dope":
        mirror_edge = "press"
    elif pref == "press":
        mirror_edge = "momentum"
    elif pref == "momentum":
        mirror_edge = "rope_a_dope"
    else:
        mirror_edge = random.choice(["rope_a_dope", "press", "momentum"])

    # exploit weaknesses
    weakness = profile["weakness"]
    if weakness == "aggressive":
        counter["aggression"] = _clamp(counter["aggression"] + 20)
        counter["risk_tolerance"] = _clamp(counter["risk_tolerance"] + 10)
    elif weakness == "defensive":
        counter["edge_affinity"] = _clamp(counter["edge_affinity"] + 20)
        counter["aggression"] = max(counter["aggression"] - 15, 5)
    elif weakness == "trading":
        counter["trade_down"] = _clamp(counter["trade_down"] + 25)

    # difficulty calibration
    win_rate = profile["mirror_win_rate"]
    total = profile["total_bouts"]
    if total < 5:
        noise = 25  # barely any data, play loose
    elif win_rate > TARGET_WIN_RATE + TOLERANCE:
        noise = 20  # winning too much, add noise
    elif win_rate < TARGET_WIN_RATE - TOLERANCE:
        noise = 5   # losing too much, tighten up
    else:
        noise = 12  # sweet spot

    for s in sliders:
        counter[s] = _clamp(counter[s] + random.randint(-noise, noise))

    # name
    name = f"Mirror's {random.choice(MIRROR_NAMES)}"

    # virtual elo near player's
    player_elo = 1200  # will be overridden by caller
    adaptation = min(100, (total or 0) * 2)

    # milestone
    milestone = None
    for threshold in sorted(MILESTONES.keys(), reverse=True):
        if total >= threshold:
            milestone = MILESTONES[threshold]
            break

    # build current_read for display
    current_read = {
        f"avg_{s}": avg.get(s, 50) for s in sliders
    }
    current_read["preferred_edge"] = pref
    current_read["edge_distribution"] = profile["edge_distribution"]
    current_read["detected_weakness"] = weakness
    current_read["player_archetype"] = profile["archetype"]

    # series record from the player's perspective (draws fold into the player side for display)
    mirror_wins = round(profile.get("mirror_win_rate", 0.0) * (total or 0))
    player_wins = max(0, (total or 0) - mirror_wins)

    return {
        "name": name, "config": counter, "edge": mirror_edge,
        "adaptation_level": adaptation,
        "current_read": current_read,
        "tendencies_exploited": _describe_tendencies(profile),
        "strategy_description": _describe_strategy(counter, mirror_edge, profile),
        "milestone": milestone,
        "bout_number": (total or 0) + 1,
        "series_record": f"You {player_wins} - {mirror_wins} Mirror",
    }


_MIRROR_SLIDERS = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]


def _counter_edge(edge: str | None) -> str:
    return {"rope_a_dope": "press", "press": "momentum", "momentum": "rope_a_dope"}.get(
        edge) or random.choice(["rope_a_dope", "press", "momentum"])


def _agent_label(cfg: dict) -> str:
    agg = cfg.get("aggression", 50)
    if agg > 65:
        return "aggressive"
    if agg < 35:
        return "defensive"
    if cfg.get("trade_down", 50) > 65:
        return "trading"
    return "balanced"


def _pair_archetype(a: dict, b: dict) -> str:
    return f"{_agent_label(a)} + {_agent_label(b)}"


def generate_mirror_team(team_a: dict, team_b: dict,
                         edge_a: str | None = None, edge_b: str | None = None) -> dict:
    """Generate a counter-PAIR tailored to the player's specific 2v2 team composition.

    The Mirror reads the presented pairing (its archetype + each agent's config) and
    builds two agents that each counter one of the player's agents, calibrated to the
    same target win rate as the 1v1 Mirror. This is deeper adaptation: it exploits the
    team dynamic, not just an individual agent.
    """
    profile = _compute_player_profile()
    total = profile["total_bouts"]
    win_rate = profile["mirror_win_rate"]
    if total < 5:
        noise = 25
    elif win_rate > TARGET_WIN_RATE + TOLERANCE:
        noise = 20
    elif win_rate < TARGET_WIN_RATE - TOLERANCE:
        noise = 5
    else:
        noise = 12

    def counter(target: dict) -> dict:
        return {s: _clamp(100 - target.get(s, 50) + random.randint(-noise, noise)) for s in _MIRROR_SLIDERS}

    names = random.sample(MIRROR_NAMES, 2)
    pair_arch = _pair_archetype(team_a, team_b)
    adaptation = min(100, (total or 0) * 2)
    return {
        "agent_a": {"name": f"Mirror's {names[0]}", "config": counter(team_a), "edge": _counter_edge(edge_a)},
        "agent_b": {"name": f"Mirror's {names[1]}", "config": counter(team_b), "edge": _counter_edge(edge_b)},
        "adaptation_level": adaptation,
        "pair_read": pair_arch,
        "strategy_description": f"Built a counter-pair to exploit your {pair_arch} duo",
        "bout_number": (total or 0) + 1,
    }


def _describe_tendencies(profile: dict) -> str:
    parts = []
    avg = profile["avg_config"]
    if avg.get("aggression", 50) > 65:
        parts.append("high aggression")
    elif avg.get("aggression", 50) < 35:
        parts.append("defensive style")
    pref = profile.get("preferred_edge")
    if pref:
        edge_names = {"rope_a_dope": "Counter", "press": "Surge", "momentum": "Frenzy"}
        parts.append(f"{edge_names.get(pref, pref)} edge preference")
    return ", ".join(parts) if parts else "still learning your style"


def _describe_strategy(counter: dict, edge: str, profile: dict) -> str:
    edge_names = {"rope_a_dope": "Counter", "press": "Surge", "momentum": "Frenzy"}
    agg = counter.get("aggression", 50)
    if agg > 65:
        style = "aggressive"
    elif agg < 35:
        style = "defensive"
    else:
        style = "balanced"
    return f"Deployed {style} build with {edge_names.get(edge, edge)} to counter your tendencies"


def record_mirror_bout(match_id: int, player_agent_id: int, player_config: dict,
                       player_edge: str | None, mirror_config: dict, mirror_edge: str,
                       winner: str):
    """Record a Mirror bout and update the profile."""
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()

    # determine winner label
    winner_label = "player" if winner == "red" else ("mirror" if winner == "black" else "draw")

    conn.execute("""
        INSERT INTO mirror_history (created_at, match_id, player_agent_id, player_config, player_edge,
            mirror_config, mirror_edge, winner, player_archetype)
        VALUES (?,?,?,?,?,?,?,?,?)
    """, (now, match_id, player_agent_id, json.dumps(player_config), player_edge,
          json.dumps(mirror_config), mirror_edge, winner_label, ""))

    # update profile
    profile = conn.execute("SELECT * FROM mirror_profile WHERE id = 1").fetchone()
    if profile:
        tb = profile["total_bouts"] + 1
        pw = profile["player_wins"] + (1 if winner_label == "player" else 0)
        mw = profile["mirror_wins"] + (1 if winner_label == "mirror" else 0)
        dr = profile["draws"] + (1 if winner_label == "draw" else 0)
        adapt = min(100, tb * 2)
        conn.execute("""
            UPDATE mirror_profile SET total_bouts=?, player_wins=?, mirror_wins=?, draws=?,
            adaptation_level=?, updated_at=? WHERE id=1
        """, (tb, pw, mw, dr, adapt, now))
    else:
        pw = 1 if winner_label == "player" else 0
        mw = 1 if winner_label == "mirror" else 0
        dr = 1 if winner_label == "draw" else 0
        conn.execute("""
            INSERT INTO mirror_profile (id, total_bouts, player_wins, mirror_wins, draws, adaptation_level, current_read, updated_at)
            VALUES (1, 1, ?, ?, ?, 2, '{}', ?)
        """, (pw, mw, dr, now))

    conn.commit()

    # update cached current_read
    new_profile = _compute_player_profile()
    current_read_json = json.dumps({
        f"avg_{s}": new_profile["avg_config"].get(s, 50)
        for s in ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]
    } | {
        "preferred_edge": new_profile["preferred_edge"],
        "edge_distribution": new_profile["edge_distribution"],
        "detected_weakness": new_profile["weakness"],
        "player_archetype": new_profile["archetype"],
    })
    conn2 = get_db()
    conn2.execute("UPDATE mirror_profile SET current_read=? WHERE id=1", (current_read_json,))
    conn2.commit()
    conn2.close()
    conn.close()
