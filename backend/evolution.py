"""Adaptive sliders: agents nudge their config toward what works over time.

Pure logic only. DB read/write lives in database.py (process_agent_evolution),
which feeds this the agent dict + recent competitive results and applies the
returned adjustments under the +/-10 cap.
"""

import random

SLIDERS = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]
EVOLUTION_WINDOW = 20      # competitive matches between evolutions
MAX_DRIFT = 10             # a slider may drift at most +/-10 from its original value


def evolve_sliders(agent: dict, wins: int, losses: int) -> dict:
    """Analyze the recent competitive window and nudge sliders toward what worked.

    Returns {slider: adjustment} where each adjustment is in [-2, 2]. The agent's
    config is constant per match, so the signal is the agent's win rate over the
    window: winning -> reinforce (hold); losing -> pull extremes toward center;
    near 50/50 -> small drift.
    """
    if wins < 3:
        return {}  # not enough wins to learn from

    win_rate = wins / max(wins + losses, 1)
    adjustments = {}

    for slider in SLIDERS:
        current = agent.get(slider, 50)
        if win_rate > 0.6:
            adjustments[slider] = 0  # working; don't fix it
        elif win_rate < 0.4:
            if current > 60:
                adjustments[slider] = random.choice([-1, -2])
            elif current < 40:
                adjustments[slider] = random.choice([1, 2])
            else:
                adjustments[slider] = random.choice([-1, 0, 1])
        else:
            adjustments[slider] = random.choice([-1, 0, 0, 1])

    # drop no-ops to keep the change set tight
    return {k: v for k, v in adjustments.items() if v != 0}


def clamp_to_cap(current: int, adjustment: int, original: int) -> int:
    """Apply adjustment, clamped to original +/- MAX_DRIFT and to 0-100."""
    target = current + adjustment
    lo = max(0, original - MAX_DRIFT)
    hi = min(100, original + MAX_DRIFT)
    return max(lo, min(hi, target))
