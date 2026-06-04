"""AI agent with board-level evaluation, phase-aware weights, and overextension mechanics."""

import random
from dataclasses import dataclass

from engine import (
    DEAD, Board, Move, SIZE, Piece,
    get_all_moves, apply_move, count_pieces,
    is_red, is_black, is_king, belongs, opponent,
    calc_material_balance, calc_advancement, calc_back_rank_integrity,
    calc_center_control, calc_formation_quality,
)


@dataclass
class AgentConfig:
    aggression: int = 50
    risk_tolerance: int = 50
    king_priority: int = 50
    edge_affinity: int = 50
    trade_down: int = 50

    def to_dict(self):
        return {
            "aggression": self.aggression,
            "risk_tolerance": self.risk_tolerance,
            "king_priority": self.king_priority,
            "edge_affinity": self.edge_affinity,
            "trade_down": self.trade_down,
        }

    def config_key(self) -> str:
        return f"{self.aggression}:{self.risk_tolerance}:{self.king_priority}:{self.edge_affinity}:{self.trade_down}"


# Phase multipliers: how much each personality dimension matters per phase
PHASE_WEIGHTS = {
    "opening": {
        "aggression": 0.65,
        "king_priority": 0.4,
        "edge_affinity": 1.0,
        "trade_down": 0.6,
        "center_bonus": 1.5,
        "back_rank_bonus": 1.3,
    },
    "midgame": {
        "aggression": 1.0,
        "king_priority": 1.0,
        "edge_affinity": 1.0,
        "trade_down": 1.0,
        "center_bonus": 1.0,
        "back_rank_bonus": 1.0,
    },
    "endgame": {
        "aggression": 0.8,
        "king_priority": 1.6,
        "edge_affinity": 0.5,
        "trade_down": 1.5,
        "center_bonus": 0.7,
        "back_rank_bonus": 0.3,
    },
}


ADJECTIVE_POOLS = {
    "aggression": ["Reckless", "Savage", "Furious", "Relentless", "Vicious"],
    "risk_tolerance": ["Bold", "Fearless", "Daring", "Wild", "Rogue"],
    "king_priority": ["Crowned", "Royal", "Ascending", "Noble", "Imperial"],
    "edge_affinity": ["Fortified", "Walled", "Flanking", "Guarded", "Anchored"],
    "trade_down": ["Grinding", "Patient", "Calculated", "Ruthless", "Efficient"],
}
NOUN_POOLS = {
    "aggression": ["Striker", "Raider", "Blitz", "Fang", "Storm"],
    "risk_tolerance": ["Gambit", "Maverick", "Drifter", "Ace", "Phantom"],
    "king_priority": ["Crown", "Monarch", "Regent", "Ascent", "Throne"],
    "edge_affinity": ["Sentinel", "Bastion", "Wall", "Keep", "Rampart"],
    "trade_down": ["Grinder", "Vise", "Strangler", "Anvil", "Press"],
}


def suggest_names(aggression: int, risk_tolerance: int, king_priority: int,
                  edge_affinity: int, trade_down: int) -> list[str]:
    sliders = [
        ("aggression", aggression), ("risk_tolerance", risk_tolerance),
        ("king_priority", king_priority), ("edge_affinity", edge_affinity),
        ("trade_down", trade_down),
    ]
    sliders.sort(key=lambda x: x[1], reverse=True)
    primary, secondary = sliders[0][0], sliders[1][0]
    if abs(sliders[0][1] - sliders[1][1]) <= 5 and random.random() > 0.5:
        primary, secondary = secondary, primary

    suggestions: list[str] = []
    used_adjs: set[str] = set()
    used_nouns: set[str] = set()
    for _ in range(3):
        avail_adj = [a for a in ADJECTIVE_POOLS[primary] if a not in used_adjs]
        avail_noun = [n for n in NOUN_POOLS[secondary] if n not in used_nouns]
        if not avail_adj:
            avail_adj = ADJECTIVE_POOLS[primary]
        if not avail_noun:
            avail_noun = NOUN_POOLS[secondary]
        adj = random.choice(avail_adj)
        noun = random.choice(avail_noun)
        used_adjs.add(adj)
        used_nouns.add(noun)
        suggestions.append(f"{adj} {noun}")
    return suggestions


def apply_perk_overrides(config: AgentConfig, perk_state: dict | None) -> AgentConfig:
    """Return a config with temporary perk slider overrides applied. Never mutates the original."""
    if not perk_state or perk_state.get("active_moves", 0) <= 0:
        return config
    perk = perk_state["perk"]
    c = AgentConfig(**config.to_dict())
    if perk == "rope_a_dope":
        c.risk_tolerance = max(0, config.risk_tolerance - 40)
        c.edge_affinity = min(100, config.edge_affinity + 20)
    elif perk == "press":
        c.aggression = min(100, config.aggression + 40)
        c.king_priority = min(100, config.king_priority + 20)
    elif perk == "momentum":
        c.aggression = min(100, config.aggression + 25)
        c.risk_tolerance = min(100, config.risk_tolerance + 15)
    return c


def detect_phase(move_count: int, red_count: int, black_count: int) -> str:
    if red_count <= 4 or black_count <= 4:
        return "endgame"
    if move_count >= 46:
        return "endgame"
    if (5 <= red_count <= 10 and 5 <= black_count <= 10) or move_count >= 16:
        return "midgame"
    return "opening"


def calc_overextension_factor(aggression: int, risk_tolerance: int) -> float:
    if aggression <= 70 or risk_tolerance <= 70:
        return 0.0
    return ((aggression - 70) / 30) * ((risk_tolerance - 70) / 30)


def _risk_amplify(value: float, risk_tolerance: int) -> float:
    """Risk tolerance amplifies deviation from 50. Returns clamped 0-100."""
    amp = 0.5 + risk_tolerance / 100
    return max(0.0, min(100.0, 50 + (value - 50) * amp))


def evaluate_position(board: Board, side: str, config: AgentConfig, phase: str) -> float:
    """Score the overall board position for a side."""
    pw = PHASE_WEIGHTS[phase]

    agg = _risk_amplify(config.aggression, config.risk_tolerance) / 100
    kp = _risk_amplify(config.king_priority, config.risk_tolerance) / 100
    ea = _risk_amplify(config.edge_affinity, config.risk_tolerance) / 100
    td = _risk_amplify(config.trade_down, config.risk_tolerance) / 100
    risk = config.risk_tolerance / 100

    material = calc_material_balance(board, side)
    advancement = calc_advancement(board, side)
    back_rank = calc_back_rank_integrity(board, side)
    center = calc_center_control(board, side)
    formation = calc_formation_quality(board, side)

    opp_moves = get_all_moves(board, opponent(side))
    opp_capture_pieces = sum(len(m.captures) for m in opp_moves if m.captures)

    score = 0.0

    # material balance: base weight + aggression bonus
    mat_weight = 10 + agg * 6
    score += material * mat_weight * pw["aggression"]

    # advancement toward promotion
    adv_weight = 4 + kp * 10
    score += advancement * adv_weight * pw["king_priority"]

    # back-rank integrity: inversely weighted by aggression
    br_weight = 6 * (1 - agg * 0.5)
    score += back_rank * br_weight * pw.get("back_rank_bonus", 1.0)

    # center control: inversely weighted by edge affinity
    ctr_weight = 6 * (1 - ea * 0.6)
    score += center * ctr_weight * pw.get("center_bonus", 1.0)

    # formation quality: weighted by edge affinity
    form_weight = 4 + ea * 6
    score += formation * form_weight * pw["edge_affinity"]

    # trade-down: when ahead, bonus for reducing opponent material
    if material > 0:
        counts = count_pieces(board)
        opp_total = counts["black"] if side == "red" else counts["red"]
        scarcity = 1 - opp_total / 12
        score += material * scarcity * 5 * td * pw["trade_down"]

    # opponent threat penalty (reduced by risk tolerance)
    threat_weight = 5 * (1 - risk * 0.6)
    score -= opp_capture_pieces * threat_weight

    # mobility: count of own legal moves available
    my_moves = get_all_moves(board, side)
    mob_weight = 0.3 + agg * 0.4
    # when behind and high trade-down, mobility matters less
    if material < 0:
        mob_weight *= (1 - td * 0.4)
    score += len(my_moves) * mob_weight * pw["aggression"]

    return score


def evaluate_move(board: Board, move: Move, config: AgentConfig, side: str,
                  phase: str, overext_factor: float) -> float:
    """Score a candidate move combining tactical value and resulting position."""
    pw = PHASE_WEIGHTS[phase]

    agg = _risk_amplify(config.aggression, config.risk_tolerance) / 100
    kp = _risk_amplify(config.king_priority, config.risk_tolerance) / 100
    td = _risk_amplify(config.trade_down, config.risk_tolerance) / 100
    risk = config.risk_tolerance / 100

    tactical = 0.0

    # capture bonus with overextension inflation
    if move.captures:
        base_capture = len(move.captures) * 12 * (0.3 + agg * 0.7 * pw["aggression"])
        tactical += base_capture * (1 + overext_factor * 0.6)

        counts = count_pieces(board)
        my_count = counts["red"] if side == "red" else counts["black"]
        opp_count = counts["black"] if side == "red" else counts["red"]
        if my_count > opp_count:
            tactical += (my_count - opp_count) * 3 * td * pw["trade_down"]

    # king creation bonus
    dest = move.path[-1]
    piece = board[move.from_pos.row][move.from_pos.col]
    if (is_red(piece) and dest.row == 0) or (is_black(piece) and dest.row == SIZE - 1):
        tactical += 14 * (0.3 + kp * 0.7 * pw["king_priority"])

    # advancement for non-kings
    if not is_king(piece):
        if is_red(piece):
            tactical += (SIZE - 1 - dest.row) * 0.5 * kp * pw["king_priority"]
        elif is_black(piece):
            tactical += dest.row * 0.5 * kp * pw["king_priority"]

    # forward pressure: aggressive agents get bonus for advancing
    if not move.captures and not is_king(piece):
        if is_red(piece):
            forward = move.from_pos.row - dest.row
        else:
            forward = dest.row - move.from_pos.row
        if forward > 0:
            tactical += forward * 2.5 * agg * pw["aggression"]

    # dead zone avoidance
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            nr, nc = dest.row + dr, dest.col + dc
            if 0 <= nr < SIZE and 0 <= nc < SIZE and board[nr][nc] == DEAD:
                tactical -= 2 * (1 - risk * 0.5)

    # position evaluation of resulting board
    new_board = apply_move(board, move)
    pos_score = evaluate_position(new_board, side, config, phase)

    score = tactical + pos_score

    # randomness for variety
    score += (random.random() - 0.5) * 2.5

    return score


def pick_move(board: Board, side: str, config: AgentConfig,
              phase: str = "midgame") -> Move | None:
    moves = get_all_moves(board, side)
    if not moves:
        return None

    overext = calc_overextension_factor(config.aggression, config.risk_tolerance)
    scored = [
        (m, evaluate_move(board, m, config, side, phase, overext))
        for m in moves
    ]
    scored.sort(key=lambda x: x[1], reverse=True)

    top_n = scored[:min(2, len(scored))]
    return random.choice(top_n)[0]
