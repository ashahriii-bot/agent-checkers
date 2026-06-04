"""Matchup familiarity: agents build a small, capped, decaying edge against
opponent types they've faced often. Pure logic; storage lives in database.py.
"""

import math

MATCHUP_TYPES = ["aggressive", "defensive", "king_focused", "trading", "reckless"]

# short labels for the UI
MATCHUP_LABELS = {
    "aggressive": "Aggressive",
    "defensive": "Defensive",
    "king_focused": "King-focused",
    "trading": "Trading",
    "reckless": "Reckless",
}

MAX_FAMILIARITY_BONUS = 0.05  # +5% to the deterministic eval signal at full familiarity


def categorize_opponent(config: dict) -> str:
    """Categorize an opponent config into a matchup type by its dominant slider."""
    candidates = [
        ("aggressive", config.get("aggression", 50)),
        ("defensive", config.get("edge_affinity", 50)),
        ("king_focused", config.get("king_priority", 50)),
        ("trading", config.get("trade_down", 50)),
        ("reckless", config.get("risk_tolerance", 50)),
    ]
    return max(candidates, key=lambda x: x[1])[0]


def calculate_familiarity(matches_faced: int) -> float:
    """0.0-1.0, fast ramp then plateau. <5 faced => 0.0."""
    if matches_faced < 5:
        return 0.0
    raw = math.log(matches_faced / 5 + 1) / math.log(21)
    return min(raw, 1.0)


def familiarity_eval_factor(familiarity_score: float) -> float:
    """Multiplier applied to the deterministic eval signal (max 1.05)."""
    return 1.0 + familiarity_score * MAX_FAMILIARITY_BONUS
