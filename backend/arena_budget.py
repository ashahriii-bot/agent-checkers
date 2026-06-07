"""Point-budget: the 250-point conservation rule for agents.

An agent spends exactly ARENA_BUDGET points across its five sliders, each
constrained to [SLIDER_MIN, SLIDER_MAX]. The core operates on a plain list of 5
ints (name-agnostic), so both the arena sliders (aggression, risk_tolerance,
target_focus, positioning, sacrifice) and the Agent-Checkers sliders
(aggression, risk_tolerance, king_priority, edge_affinity, trade_down) — the
same five DB columns — share one implementation.

- normalize_list(): shape-preserving coercion to the budget. Used for carryover
  (legacy agents are 0-100, unconstrained), the one-time migration, evolution
  re-normalization, and seeding. This is the "Re-attunement."
- validate_list(): strict check for client-supplied custom builds (anti-cheat).

Mirrors the frontend helpers (redistribute / normalizeBudget) so a build that is
legal in the forge is legal on the server.
"""

ARENA_BUDGET = 200
SLIDER_MIN = 5
SLIDER_MAX = 80
BUDGET_SLIDERS = ["aggression", "risk_tolerance", "target_focus", "positioning", "sacrifice"]


def _clamp(v, lo, hi):
    return max(lo, min(hi, int(round(v))))


def normalize_list(vals, locked=None):
    """Coerce a list of 5 ints to sum == ARENA_BUDGET with every value in range,
    preserving shape as closely as the constraints allow. `locked` is an optional
    set of indices excluded from adjustment."""
    locked = locked or set()
    cur = [_clamp(v if v is not None else 50, SLIDER_MIN, SLIDER_MAX) for v in vals]
    adj = [i for i in range(len(cur)) if i not in locked]

    for _ in range(60):
        diff = ARENA_BUDGET - sum(cur)
        if diff == 0:
            break
        direction = 1 if diff > 0 else -1
        headroom = (lambda i: (SLIDER_MAX - cur[i]) if direction > 0 else (cur[i] - SLIDER_MIN))
        pool = sum(headroom(i) for i in adj)
        if pool <= 0:
            break
        move = min(abs(diff), pool)
        raws = {i: move * headroom(i) / pool for i in adj}
        bases = {i: int(raws[i]) for i in adj}
        for i in adj:
            cur[i] += direction * bases[i]
        remaining = move - sum(bases.values())
        order = sorted(adj, key=lambda i: raws[i] - bases[i], reverse=True)
        k = 0
        while remaining > 0 and k < len(order) * 5:
            i = order[k % len(order)]
            if (cur[i] < SLIDER_MAX) if direction > 0 else (cur[i] > SLIDER_MIN):
                cur[i] += direction
                remaining -= 1
            k += 1
        cur = [_clamp(v, SLIDER_MIN, SLIDER_MAX) for v in cur]

    # Final ±remainder push onto the slider with the most headroom.
    diff = ARENA_BUDGET - sum(cur)
    if diff != 0:
        direction = 1 if diff > 0 else -1
        room = (lambda i: (SLIDER_MAX - cur[i]) if direction > 0 else (cur[i] - SLIDER_MIN))
        order = sorted(adj, key=room, reverse=True)
        n, k = abs(diff), 0
        while n > 0 and order and k < len(order) * 6:
            i = order[k % len(order)]
            if room(i) > 0:
                cur[i] += direction
                n -= 1
            k += 1

    return cur


def validate_list(vals, tol=1):
    """True iff exactly 5 values, each in [10,90], summing to 250 (±tol)."""
    try:
        vs = [int(v) for v in vals]
    except (TypeError, ValueError):
        return False
    if len(vs) != 5:
        return False
    if any(v < SLIDER_MIN or v > SLIDER_MAX for v in vs):
        return False
    return abs(sum(vs) - ARENA_BUDGET) <= tol


# --- arena-keyed dict convenience wrappers ---

def normalize_to_budget(sliders: dict) -> dict:
    out = normalize_list([sliders.get(k) for k in BUDGET_SLIDERS])
    return {k: out[i] for i, k in enumerate(BUDGET_SLIDERS)}


def validate_budget(sliders: dict, tol: int = 1) -> bool:
    return validate_list([sliders.get(k) for k in BUDGET_SLIDERS], tol)
