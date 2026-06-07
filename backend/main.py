"""FastAPI server for Agent Checkers: matches, tournaments, elo, phase-aware AI."""

import json
import random
import re
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from engine import (
    init_board, apply_move, get_all_moves, count_pieces,
    board_to_list, shrink_board, apply_king_fatigue, Piece, is_king,
)
from ai import AgentConfig, pick_move, detect_phase, calc_overextension_factor, suggest_names, apply_perk_overrides, apply_progression_edges, EDGE_DEFINITIONS
from auth import hash_password, verify_password, create_token, get_current_player_id, get_optional_player_id
from coaches import COACHES, generate_bot_agent, get_coach_list, generate_bot_team
from mirror import get_mirror_profile, get_mirror_history, generate_mirror_agent, record_mirror_bout, generate_mirror_team
from props import calculate_prop_odds, resolve_props, calculate_team_prop_odds
from team import (
    consensus_move, calculate_diversity_bonus, slider_diversity, team_elo,
    aggregate_team_dynamics, resolve_team_props,
)
from ws import router as ws_router
from matchmaking import online
from crypto import crypto_service, micros_to_usdc, usdc_to_micros
from privy_auth import privy_service
from database import (
    save_match, save_team_match, get_matches, get_match, get_leaderboard, get_agent_leaderboard,
    get_elo, update_elo, update_elo_record,
    create_agent, get_agents, get_agent, update_agent, delete_agent, update_agent_after_match,
    update_arena_record,
    create_series, get_series, update_series,
    save_tournament, get_tournaments, get_tournament,
    set_agent_perk, VALID_PERKS,
    get_wallet, place_bet, settle_bet, get_bet_history,
    calculate_match_odds, calculate_tournament_odds,
    create_player, get_player, get_player_by_username, update_player_coins,
    get_jackpot, add_to_jackpot, hit_jackpot,
    increment_streak, reset_streak,
    save_parlay, calc_parlay_payout,
    update_rivalry, get_rivalry, get_agent_rivalries,
    check_and_update_records, get_agent_records,
    set_player_wallet, get_player_usdc, adjust_player_usdc, record_crypto_tx, get_crypto_txs,
    EDGE_UNLOCK_LEVELS,
    process_agent_evolution, update_familiarity, get_familiarity_score, decay_familiarity, get_agent_familiarity,
)
from familiarity import categorize_opponent

REAL_PLAY_MIN_BET_MICROS = 10_000      # $0.01
REAL_PLAY_MAX_BET_MICROS = 10_000_000  # $10.00
REAL_PLAY_MIN_WITHDRAW_MICROS = 1_000_000  # $1.00
MOONPAY_API_KEY = __import__("os").environ.get("MOONPAY_API_KEY", "")

app = FastAPI(title="Agent Checkers API", version="0.6.0")
app.include_router(ws_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_MOVES = 200
SHRINK_START = 60
SHRINK_INTERVAL = 8
SHRINK_COUNT = 4
KING_FATIGUE_LIMIT = 15

NAME_RE = re.compile(r"^[A-Za-z0-9 \-]{2,24}$")

ARCHETYPES = [
    {"aggression": 95, "risk_tolerance": 90, "king_priority": 20, "edge_affinity": 20, "trade_down": 30},
    {"aggression": 15, "risk_tolerance": 10, "king_priority": 80, "edge_affinity": 70, "trade_down": 40},
    {"aggression": 50, "risk_tolerance": 50, "king_priority": 50, "edge_affinity": 50, "trade_down": 50},
    {"aggression": 70, "risk_tolerance": 95, "king_priority": 40, "edge_affinity": 30, "trade_down": 60},
    {"aggression": 30, "risk_tolerance": 15, "king_priority": 60, "edge_affinity": 95, "trade_down": 80},
    {"aggression": 80, "risk_tolerance": 40, "king_priority": 50, "edge_affinity": 30, "trade_down": 95},
]


# --- schemas ---

class AgentConfigSchema(BaseModel):
    aggression: int = Field(default=50, ge=0, le=100)
    risk_tolerance: int = Field(default=50, ge=0, le=100)
    king_priority: int = Field(default=50, ge=0, le=100)
    edge_affinity: int = Field(default=50, ge=0, le=100)
    trade_down: int = Field(default=50, ge=0, le=100)


class CreateAgentRequest(BaseModel):
    name: str
    aggression: int = Field(ge=0, le=100)
    risk_tolerance: int = Field(ge=0, le=100)
    king_priority: int = Field(ge=0, le=100)
    edge_affinity: int = Field(ge=0, le=100)
    trade_down: int = Field(ge=0, le=100)


class UpdateAgentRequest(BaseModel):
    name: Optional[str] = None
    aggression: Optional[int] = Field(default=None, ge=0, le=100)
    risk_tolerance: Optional[int] = Field(default=None, ge=0, le=100)
    king_priority: Optional[int] = Field(default=None, ge=0, le=100)
    edge_affinity: Optional[int] = Field(default=None, ge=0, le=100)
    trade_down: Optional[int] = Field(default=None, ge=0, le=100)


class BetSchema(BaseModel):
    side: str
    amount: int = Field(ge=10)
    mode: str = "free"   # free-play coins only; "real" is rejected here (multiplayer-exclusive)


class ChampionBetSchema(BaseModel):
    agent_id: int
    amount: int = Field(ge=10)


class VsBotSchema(BaseModel):
    coach_id: str


class PropBetInput(BaseModel):
    type: str
    selection: str
    amount: int = Field(ge=10)


class TeamSpec(BaseModel):
    agent_a_id: int
    agent_b_id: int


class SimulateRequest(BaseModel):
    red: Optional[AgentConfigSchema] = None
    black: Optional[AgentConfigSchema] = None
    red_agent_id: Optional[int] = None
    black_agent_id: Optional[int] = None
    bet: Optional[BetSchema] = None
    vs_bot: Optional[VsBotSchema] = None
    prop_bets: Optional[list[PropBetInput]] = None
    # 2v2 tag team
    mode: str = "1v1"
    red_team: Optional[TeamSpec] = None
    black_team: Optional[TeamSpec] = None


class ParlayPrediction(BaseModel):
    round: int
    match_index: int
    predicted_winner_slot: int


class ParlaySchema(BaseModel):
    amount: int = Field(ge=10)
    predictions: list[ParlayPrediction]


class TournamentRequest(BaseModel):
    agent_ids: list[int]
    bracket_size: int = Field(default=8, ge=4, le=8)
    seeding: str = "elo"
    champion_bet: Optional[ChampionBetSchema] = None
    vs_bot: Optional[VsBotSchema] = None
    parlay: Optional[ParlaySchema] = None


class TeamTournamentRequest(BaseModel):
    team: TeamSpec
    bracket_size: int = Field(default=4, ge=4, le=4)  # 4 teams
    seeding: str = "elo"
    vs_bot: Optional[VsBotSchema] = None
    parlay: Optional[ParlaySchema] = None


# --- core game simulation (shared by single match and tournament) ---

def _init_perk_state(perk: str | None) -> dict | None:
    if not perk:
        return None
    return {"perk": perk, "active_moves": 0}


def _run_game(red_cfg: AgentConfig, black_cfg: AgentConfig,
              red_perk: str | None = None, black_perk: str | None = None,
              red_familiarity: float = 0.0, black_familiarity: float = 0.0) -> dict:
    board = init_board()
    turn = "black"
    moves = []
    boards = [board_to_list(board)]
    events = []
    move_count = 0
    winner = None
    draw_reason = None   # "blocked" when stalemate with material advantage → draw
    king_idle = {}
    current_phase = "opening"
    events.append({"type": "phase_change", "move": 0, "phase": "opening"})

    red_overext = calc_overextension_factor(red_cfg.aggression, red_cfg.risk_tolerance)
    black_overext = calc_overextension_factor(black_cfg.aggression, black_cfg.risk_tolerance)
    pending_overext = None

    # perk state
    perk_state = {"red": _init_perk_state(red_perk), "black": _init_perk_state(black_perk)}
    moves_since_capture = 0
    # progression-edge state (board-conditional / flux edges)
    edge_by_side = {"red": red_perk, "black": black_perk}
    familiarity_by_side = {"red": red_familiarity, "black": black_familiarity}
    flux_state = {"red": {}, "black": {}}
    prog_active = {"red": False, "black": False}

    while move_count < MAX_MOVES:
        if move_count >= SHRINK_START and (move_count - SHRINK_START) % SHRINK_INTERVAL == 0:
            board, killed = shrink_board(board, SHRINK_COUNT)
            if killed:
                events.append({"type": "shrink", "move": move_count, "killed": killed})
                boards[-1] = board_to_list(board)
                counts = count_pieces(board)
                if counts["red"] == 0:
                    winner = "black"; break
                if counts["black"] == 0:
                    winner = "red"; break

        board, demoted = apply_king_fatigue(board, king_idle, KING_FATIGUE_LIMIT)
        if demoted:
            events.append({"type": "fatigue", "move": move_count, "demoted": demoted})
            boards[-1] = board_to_list(board)
            for key in demoted:
                king_idle.pop(key, None)

        counts = count_pieces(board)
        new_phase = detect_phase(move_count, counts["red"], counts["black"])
        if new_phase != current_phase:
            current_phase = new_phase
            events.append({"type": "phase_change", "move": move_count, "phase": new_phase})

        # apply perk overrides for the current player
        base_cfg = red_cfg if turn == "red" else black_cfg
        effective_cfg = apply_perk_overrides(base_cfg, perk_state[turn])
        # progression edges (anchor/phantom/siege/flux) layer on top, board-conditional
        effective_cfg, prog_on, prog_detail = apply_progression_edges(
            effective_cfg, edge_by_side[turn], board, turn, move_count, flux_state[turn])
        if prog_on and not prog_active[turn]:
            events.append({"type": "perk_activate", "move": move_count, "side": turn,
                           "perk": edge_by_side[turn], "duration": 0, "detail": prog_detail})
        elif not prog_on and prog_active[turn]:
            events.append({"type": "perk_deactivate", "move": move_count, "side": turn, "perk": edge_by_side[turn]})
        prog_active[turn] = prog_on
        move = pick_move(board, turn, effective_cfg, phase=current_phase, familiarity=familiarity_by_side[turn])
        if move is None:
            # stalemate: blocked side has no legal moves
            other = "red" if turn == "black" else "black"
            counts_at_block = count_pieces(board)
            blocked_pieces = counts_at_block[turn]
            other_pieces = counts_at_block[other]
            if blocked_pieces > other_pieces:
                # blocked side has MORE pieces — shrink-induced paradox → draw
                winner = "draw"
                draw_reason = "blocked"
            else:
                winner = other
            break

        had_capture = len(move.captures) > 0
        board = apply_move(board, move)
        moves.append({"side": turn, **move.to_dict()})
        boards.append(board_to_list(board))
        move_count += 1

        # --- perk state updates ---
        opp = "black" if turn == "red" else "red"

        # decrement active perk moves for the player who just moved
        ps = perk_state[turn]
        if ps and ps["active_moves"] > 0:
            ps["active_moves"] -= 1
            if ps["active_moves"] == 0:
                events.append({"type": "perk_deactivate", "move": move_count, "side": turn, "perk": ps["perk"]})

        # rope-a-dope: activates on the DEFENDER when opponent captures their piece
        if had_capture and perk_state[opp] and perk_state[opp]["perk"] == "rope_a_dope":
            perk_state[opp]["active_moves"] = 3
            events.append({"type": "perk_activate", "move": move_count, "side": opp, "perk": "rope_a_dope", "duration": 3})

        # momentum: activates on the player who just captured
        if had_capture and ps and ps["perk"] == "momentum":
            ps["active_moves"] = 2
            events.append({"type": "perk_activate", "move": move_count, "side": turn, "perk": "momentum", "duration": 2})

        # press: track moves since last capture by either side
        if had_capture:
            moves_since_capture = 0
            # deactivate press immediately if a capture breaks the stalemate
            for side_key in ("red", "black"):
                sps = perk_state[side_key]
                if sps and sps["perk"] == "press" and sps["active_moves"] > 0:
                    sps["active_moves"] = 0
                    events.append({"type": "perk_deactivate", "move": move_count, "side": side_key, "perk": "press"})
        else:
            moves_since_capture += 1
            if moves_since_capture >= 5:
                for side_key in ("red", "black"):
                    sps = perk_state[side_key]
                    if sps and sps["perk"] == "press" and sps["active_moves"] == 0:
                        sps["active_moves"] = 4
                        events.append({"type": "perk_activate", "move": move_count, "side": side_key, "perk": "press", "duration": 4})

        # --- overextension tracking ---
        if pending_overext is not None and pending_overext["side"] != turn and had_capture:
            events.append({"type": "overextension", "move": pending_overext["move"],
                           "side": pending_overext["side"], "pieces_lost": len(move.captures)})
            pending_overext = None
        elif pending_overext is not None and pending_overext["side"] != turn:
            pending_overext = None

        overext = red_overext if turn == "red" else black_overext
        if overext > 0 and had_capture:
            pending_overext = {"move": move_count - 1, "side": turn, "my_captures": len(move.captures)}

        new_idle = {}
        for r in range(8):
            for c in range(8):
                if is_king(board[r][c]):
                    key = f"{r},{c}"
                    if had_capture:
                        dest = move.path[-1]
                        new_idle[key] = 0 if (r == dest.row and c == dest.col) else king_idle.get(key, 0) + 1
                    else:
                        new_idle[key] = king_idle.get(key, 0) + 1
        king_idle = new_idle

        counts = count_pieces(board)
        if counts["red"] == 0:
            winner = "black"; break
        if counts["black"] == 0:
            winner = "red"; break
        turn = "black" if turn == "red" else "red"

    if winner is None:
        winner = "draw"
    counts = count_pieces(board)

    # win probability series (red's probability at each board state)
    win_prob = []
    for b in boards:
        c = count_pieces(board_to_list(b) if not isinstance(b[0], list) else b)
        rm = (c["red"] - c["red_kings"]) + c["red_kings"] * 1.7
        bm = (c["black"] - c["black_kings"]) + c["black_kings"] * 1.7
        total_m = rm + bm
        if total_m == 0:
            win_prob.append(0.5)
        else:
            raw = rm / total_m
            adj = 1 / (1 + ((1 - raw) / max(raw, 0.01)) ** 1.8)
            win_prob.append(round(max(0.05, min(0.95, adj)), 3))
    # set final probabilities to 1.0/0.0 based on winner
    if winner == "red":
        win_prob[-1] = 1.0
    elif winner == "black":
        win_prob[-1] = 0.0

    resp = {
        "winner": winner, "move_count": move_count,
        "moves": moves, "boards": boards, "events": events,
        "final_red": counts["red"], "final_black": counts["black"],
        "win_probability": win_prob,
    }
    if draw_reason:
        resp["draw_reason"] = draw_reason
    return resp


# --- 2v2 tag-team consensus game ---

def _run_team_game(red_cfgs, black_cfgs, red_perks=(None, None), black_perks=(None, None),
                   red_fam=(0.0, 0.0), black_fam=(0.0, 0.0),
                   red_diversity_bonus=1.0, black_diversity_bonus=1.0,
                   red_diversity_frac=0.0, black_diversity_frac=0.0) -> dict:
    """Run a 2v2 match. Each side is two agents sharing one set of pieces; every move is
    chosen by consensus (averaged eval). Both agents' perk state machines run independently
    and are reported as separate events tagged with agent 'a'/'b'. Returns the standard game
    dict plus influence_per_move and per-side team_dynamics."""
    board = init_board()
    turn = "black"
    moves, boards, events, influence = [], [board_to_list(board)], [], []
    move_count = 0
    winner = None
    draw_reason = None
    king_idle = {}
    current_phase = "opening"
    events.append({"type": "phase_change", "move": 0, "phase": "opening"})

    AG = ("a", "b")
    cfgs = {"red": red_cfgs, "black": black_cfgs}
    perks = {"red": red_perks, "black": black_perks}
    fam = {"red": red_fam, "black": black_fam}
    div_bonus = {"red": red_diversity_bonus, "black": black_diversity_bonus}
    div_frac = {"red": red_diversity_frac, "black": black_diversity_frac}
    perk_state = {s: {"a": _init_perk_state(perks[s][0]), "b": _init_perk_state(perks[s][1])} for s in ("red", "black")}
    edge_of = {s: {"a": perks[s][0], "b": perks[s][1]} for s in ("red", "black")}
    flux_state = {s: {"a": {}, "b": {}} for s in ("red", "black")}
    prog_active = {s: {"a": False, "b": False} for s in ("red", "black")}
    moves_since_capture = 0

    while move_count < MAX_MOVES:
        if move_count >= SHRINK_START and (move_count - SHRINK_START) % SHRINK_INTERVAL == 0:
            board, killed = shrink_board(board, SHRINK_COUNT)
            if killed:
                events.append({"type": "shrink", "move": move_count, "killed": killed})
                boards[-1] = board_to_list(board)
                counts = count_pieces(board)
                if counts["red"] == 0:
                    winner = "black"; break
                if counts["black"] == 0:
                    winner = "red"; break

        board, demoted = apply_king_fatigue(board, king_idle, KING_FATIGUE_LIMIT)
        if demoted:
            events.append({"type": "fatigue", "move": move_count, "demoted": demoted})
            boards[-1] = board_to_list(board)
            for key in demoted:
                king_idle.pop(key, None)

        counts = count_pieces(board)
        new_phase = detect_phase(move_count, counts["red"], counts["black"])
        if new_phase != current_phase:
            current_phase = new_phase
            events.append({"type": "phase_change", "move": move_count, "phase": new_phase})

        # effective config per agent on the moving side (perk overrides + progression edges)
        eff = {}
        for ag, base in zip(AG, cfgs[turn]):
            e = apply_perk_overrides(base, perk_state[turn][ag])
            e, prog_on, prog_detail = apply_progression_edges(e, edge_of[turn][ag], board, turn, move_count, flux_state[turn][ag])
            if prog_on and not prog_active[turn][ag]:
                events.append({"type": "perk_activate", "move": move_count, "side": turn, "agent": ag,
                               "perk": edge_of[turn][ag], "duration": 0, "detail": prog_detail})
            elif not prog_on and prog_active[turn][ag]:
                events.append({"type": "perk_deactivate", "move": move_count, "side": turn, "agent": ag, "perk": edge_of[turn][ag]})
            prog_active[turn][ag] = prog_on
            eff[ag] = e

        chosen = consensus_move(board, turn, eff["a"], eff["b"], fam[turn][0], fam[turn][1],
                                div_bonus[turn], div_frac[turn], phase=current_phase)
        if chosen is None:
            other = "red" if turn == "black" else "black"
            counts_at_block = count_pieces(board)
            if counts_at_block[turn] > counts_at_block[other]:
                winner = "draw"
                draw_reason = "blocked"
            else:
                winner = other
            break
        move = chosen["move"]
        influence.append({"move": move_count, "side": turn, "score_a": chosen["score_a"],
                          "score_b": chosen["score_b"], "dominant": chosen["dominant"], "agreement": chosen["agreement"]})

        had_capture = len(move.captures) > 0
        board = apply_move(board, move)
        moves.append({"side": turn, **move.to_dict()})
        boards.append(board_to_list(board))
        move_count += 1
        opp = "black" if turn == "red" else "red"

        # decrement active perks for both moving-side agents
        for ag in AG:
            ps = perk_state[turn][ag]
            if ps and ps["active_moves"] > 0:
                ps["active_moves"] -= 1
                if ps["active_moves"] == 0:
                    events.append({"type": "perk_deactivate", "move": move_count, "side": turn, "agent": ag, "perk": ps["perk"]})
        if had_capture:
            # rope-a-dope: each defending-side agent with it activates independently
            for ag in AG:
                ps = perk_state[opp][ag]
                if ps and ps["perk"] == "rope_a_dope":
                    ps["active_moves"] = 3
                    events.append({"type": "perk_activate", "move": move_count, "side": opp, "agent": ag, "perk": "rope_a_dope", "duration": 3})
            # momentum: each attacking-side agent with it activates independently
            for ag in AG:
                ps = perk_state[turn][ag]
                if ps and ps["perk"] == "momentum":
                    ps["active_moves"] = 2
                    events.append({"type": "perk_activate", "move": move_count, "side": turn, "agent": ag, "perk": "momentum", "duration": 2})
            moves_since_capture = 0
            for sk in ("red", "black"):
                for ag in AG:
                    sps = perk_state[sk][ag]
                    if sps and sps["perk"] == "press" and sps["active_moves"] > 0:
                        sps["active_moves"] = 0
                        events.append({"type": "perk_deactivate", "move": move_count, "side": sk, "agent": ag, "perk": "press"})
        else:
            moves_since_capture += 1
            if moves_since_capture >= 5:
                for sk in ("red", "black"):
                    for ag in AG:
                        sps = perk_state[sk][ag]
                        if sps and sps["perk"] == "press" and sps["active_moves"] == 0:
                            sps["active_moves"] = 4
                            events.append({"type": "perk_activate", "move": move_count, "side": sk, "agent": ag, "perk": "press", "duration": 4})

        new_idle = {}
        for r in range(8):
            for c in range(8):
                if is_king(board[r][c]):
                    key = f"{r},{c}"
                    if had_capture:
                        dest = move.path[-1]
                        new_idle[key] = 0 if (r == dest.row and c == dest.col) else king_idle.get(key, 0) + 1
                    else:
                        new_idle[key] = king_idle.get(key, 0) + 1
        king_idle = new_idle

        counts = count_pieces(board)
        if counts["red"] == 0:
            winner = "black"; break
        if counts["black"] == 0:
            winner = "red"; break
        turn = "black" if turn == "red" else "red"

    if winner is None:
        winner = "draw"
    counts = count_pieces(board)

    win_prob = []
    for b in boards:
        c = count_pieces(board_to_list(b) if not isinstance(b[0], list) else b)
        rm = (c["red"] - c["red_kings"]) + c["red_kings"] * 1.7
        bm = (c["black"] - c["black_kings"]) + c["black_kings"] * 1.7
        total_m = rm + bm
        if total_m == 0:
            win_prob.append(0.5)
        else:
            raw = rm / total_m
            adj = 1 / (1 + ((1 - raw) / max(raw, 0.01)) ** 1.8)
            win_prob.append(round(max(0.05, min(0.95, adj)), 3))
    if winner == "red":
        win_prob[-1] = 1.0
    elif winner == "black":
        win_prob[-1] = 0.0

    def _edge_counts(side):
        return {ag: sum(1 for e in events if e.get("type") == "perk_activate"
                        and e.get("side") == side and e.get("agent") == ag) for ag in AG}
    red_dyn = aggregate_team_dynamics([x for x in influence if x["side"] == "red"], _edge_counts("red"))
    black_dyn = aggregate_team_dynamics([x for x in influence if x["side"] == "black"], _edge_counts("black"))

    resp = {
        "winner": winner, "move_count": move_count,
        "moves": moves, "boards": boards, "events": events,
        "final_red": counts["red"], "final_black": counts["black"],
        "win_probability": win_prob,
        "influence_per_move": influence,
        "team_dynamics": {"red": red_dyn, "black": black_dyn},
    }
    if draw_reason:
        resp["draw_reason"] = draw_reason
    return resp


# --- match tags ---

def _detect_tag(game: dict, red_elo: float, black_elo: float) -> str | None:
    winner = game["winner"]
    mc = game["move_count"]
    if winner == "draw":
        return None

    if winner == "red" and black_elo - red_elo >= 100:
        return "UPSET"
    if winner == "black" and red_elo - black_elo >= 100:
        return "UPSET"

    worst_deficit = 0
    for board_state in game["boards"]:
        rc = sum(1 for row in board_state for cell in row if cell in (1, 3))
        bc = sum(1 for row in board_state for cell in row if cell in (2, 4))
        deficit = (bc - rc) if winner == "red" else (rc - bc)
        worst_deficit = max(worst_deficit, deficit)
    if worst_deficit >= 3:
        return "COMEBACK"

    if mc > 90:
        return "NAIL_BITER"
    if mc < 35:
        return "DOMINANT"

    fr, fb = game["final_red"], game["final_black"]
    if (winner == "red" and fr == 1) or (winner == "black" and fb == 1):
        return "LAST_STAND"

    return None


# --- awards ---

def _compute_awards(bracket_agents, all_matches, champion_slot, elo_changes):
    awards = []
    champ = bracket_agents[champion_slot]
    champ_elo = next((e for e in elo_changes if e["name"] == champ["name"]), None)
    delta_str = ""
    if champ_elo:
        d = champ_elo["delta"]
        delta_str = f", {'+'if d > 0 else ''}{d:.0f} elo"
    awards.append({"award": "Champion", "agent_name": champ["name"],
                    "detail": f"Seed #{champ['seed']}{delta_str}"})

    agent_captures = {}
    agent_pieces_lost = {}
    agent_match_count = {}
    for m in all_matches:
        rn = m["red_name"]
        bn = m["black_name"]
        red_caps = sum(len(mv.get("captures", [])) for mv in m["game"]["moves"] if mv["side"] == "red")
        black_caps = sum(len(mv.get("captures", [])) for mv in m["game"]["moves"] if mv["side"] == "black")
        agent_captures[rn] = agent_captures.get(rn, 0) + red_caps
        agent_captures[bn] = agent_captures.get(bn, 0) + black_caps
        agent_pieces_lost[rn] = agent_pieces_lost.get(rn, 0) + (12 - m["game"]["final_red"])
        agent_pieces_lost[bn] = agent_pieces_lost.get(bn, 0) + (12 - m["game"]["final_black"])
        agent_match_count[rn] = agent_match_count.get(rn, 0) + 1
        agent_match_count[bn] = agent_match_count.get(bn, 0) + 1

    sorted_caps = sorted(agent_captures.items(), key=lambda x: x[1], reverse=True)
    for name, caps in sorted_caps:
        if name != champ["name"]:
            awards.append({"award": "Most Aggressive", "agent_name": name,
                            "detail": f"{caps} total captures"})
            break
    else:
        if sorted_caps:
            awards.append({"award": "Most Aggressive", "agent_name": sorted_caps[0][0],
                            "detail": f"{sorted_caps[0][1]} total captures"})

    winners_by_seed = {}
    for m in all_matches:
        w = m["winner_name"]
        s = m["winner_seed"]
        if s not in winners_by_seed or winners_by_seed[s]["seed"] > s:
            winners_by_seed[w] = {"name": w, "seed": s}
    cinderella = None
    for name, info in winners_by_seed.items():
        if info["seed"] >= 5:
            if cinderella is None or info["seed"] > cinderella["seed"]:
                cinderella = info
    if cinderella:
        awards.append({"award": "Cinderella", "agent_name": cinderella["name"],
                        "detail": f"Seed #{cinderella['seed']} won a match"})

    iron_candidates = [(n, lost) for n, lost in agent_pieces_lost.items()
                       if agent_match_count.get(n, 0) >= 2]
    if iron_candidates:
        iron_candidates.sort(key=lambda x: x[1])
        best = iron_candidates[0]
        if best[0] != champ["name"] or len(iron_candidates) == 1:
            awards.append({"award": "Iron Defense", "agent_name": best[0],
                            "detail": f"Lost only {best[1]} pieces across {agent_match_count[best[0]]} matches"})
        elif len(iron_candidates) > 1:
            awards.append({"award": "Iron Defense", "agent_name": iron_candidates[1][0],
                            "detail": f"Lost only {iron_candidates[1][1]} pieces across {agent_match_count[iron_candidates[1][0]]} matches"})

    for m in all_matches:
        if m["round_name"] == "Final" and m["game"]["winner"] != "draw":
            loser_name = m["black_name"] if m["game"]["winner"] == "red" else m["red_name"]
            awards.append({"award": "Heartbreaker", "agent_name": loser_name,
                            "detail": "Lost in the final"})

    return awards[:5]


# --- random agent generation ---

def _generate_random_agent(used_names: set[str]) -> dict:
    base = random.choice(ARCHETYPES)
    config = {k: max(0, min(100, v + random.randint(-15, 15))) for k, v in base.items()}
    names = suggest_names(**config)
    name = names[0]
    suffix = 2
    while name in used_names:
        name = f"{names[0]} {suffix}"
        suffix += 1
    used_names.add(name)
    return {"name": name, "config": config, "elo": 1200.0, "is_random": True, "agent_id": None}


# --- agent endpoints ---

@app.post("/api/agents")
def api_create_agent(req: CreateAgentRequest):
    if not NAME_RE.match(req.name):
        raise HTTPException(400, "name must be 2-24 chars: letters, numbers, spaces, hyphens")
    # Universal 250-point budget: coerce to a legal build so no agent is ever
    # stored over budget (anti-cheat; the forge UI sends valid 250 already).
    a, r, k, e, t = normalize_list([req.aggression, req.risk_tolerance,
                                    req.king_priority, req.edge_affinity, req.trade_down])
    agent = create_agent(req.name, a, r, k, e, t)
    if agent is None:
        raise HTTPException(400, "agent name already taken")
    return agent


@app.get("/api/agents")
def api_list_agents():
    return {"agents": get_agents()}


@app.get("/api/agents/{agent_id}")
def api_get_agent(agent_id: int):
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(404, "agent not found")
    return agent


@app.put("/api/agents/{agent_id}")
def api_update_agent(agent_id: int, req: UpdateAgentRequest):
    if req.name is not None and not NAME_RE.match(req.name):
        raise HTTPException(400, "name must be 2-24 chars: letters, numbers, spaces, hyphens")
    provided = [req.aggression, req.risk_tolerance, req.king_priority, req.edge_affinity, req.trade_down]
    if any(v is not None for v in provided):
        # A slider changed: merge with current, then coerce the full set to the
        # 250 budget so the stored agent stays legal.
        cur = get_agent(agent_id)
        if cur is None:
            raise HTTPException(404, "agent not found")
        cols = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"]
        eff = [provided[i] if provided[i] is not None else cur[cols[i]] for i in range(5)]
        a, r, k, e, t = normalize_list(eff)
        agent = update_agent(agent_id, name=req.name, aggression=a, risk_tolerance=r,
                             king_priority=k, edge_affinity=e, trade_down=t)
    else:
        agent = update_agent(agent_id, name=req.name)  # name-only edit
    if agent is None:
        raise HTTPException(404, "agent not found or name taken")
    return agent


@app.delete("/api/agents/{agent_id}")
def api_delete_agent(agent_id: int):
    if not delete_agent(agent_id):
        raise HTTPException(404, "agent not found")
    return {"deleted": True}


@app.get("/api/suggest-names")
def api_suggest_names_standalone(aggression: int = 50, risk_tolerance: int = 50,
                                 king_priority: int = 50, edge_affinity: int = 50, trade_down: int = 50):
    return {"suggestions": suggest_names(aggression, risk_tolerance, king_priority, edge_affinity, trade_down)}


# --- wallet and betting ---

@app.get("/api/wallet")
def api_get_wallet():
    return get_wallet()


@app.get("/api/odds/match")
def api_match_odds(red_elo: float = 1200, black_elo: float = 1200):
    return calculate_match_odds(red_elo, black_elo)


@app.get("/api/odds/props")
def api_prop_odds(red_agent_id: int = 0, black_agent_id: int = 0):
    red_a = get_agent(red_agent_id) if red_agent_id else None
    black_a = get_agent(black_agent_id) if black_agent_id else None
    rc = {k: (red_a or {}).get(k, 50) for k in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")}
    bc = {k: (black_a or {}).get(k, 50) for k in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")}
    rp = red_a.get("perk") if red_a else None
    bp = black_a.get("perk") if black_a else None
    return {"props": calculate_prop_odds(rc, bc, rp, bp)}


@app.get("/api/bets/history")
def api_bet_history(limit: int = 20):
    return {"bets": get_bet_history(limit)}


def _compute_records(game: dict, side: str) -> dict:
    records = {"longest_match": game["move_count"]}
    captures = sum(1 for m in game["moves"] if m["side"] == side and len(m.get("captures", [])) > 0)
    records["most_captures"] = captures
    # longest survival streak
    max_streak = 0
    cur_streak = 0
    for m in game["moves"]:
        if m["side"] != side:
            if len(m.get("captures", [])) > 0:
                cur_streak = 0
            else:
                cur_streak += 1
                max_streak = max(max_streak, cur_streak)
        else:
            cur_streak += 1
            max_streak = max(max_streak, cur_streak)
    records["longest_survival"] = max_streak
    if game["winner"] == side:
        records["fastest_win"] = game["move_count"]
    return records


@app.post("/api/game/revenge")
def api_revenge(body: dict):
    agent_id = body.get("agent_id")
    opponent_config = body.get("opponent_config")
    opponent_perk = body.get("opponent_perk")
    bet_amount = body.get("bet_amount", 0)
    perk_override = body.get("perk")

    if not agent_id or not opponent_config:
        raise HTTPException(400, "agent_id and opponent_config required")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(400, "agent not found")

    player_cfg = AgentConfig(aggression=agent["aggression"], risk_tolerance=agent["risk_tolerance"],
                             king_priority=agent["king_priority"], edge_affinity=agent["edge_affinity"],
                             trade_down=agent["trade_down"])
    opp_cfg = AgentConfig(**opponent_config)
    player_perk = perk_override if perk_override else agent.get("perk")

    game = _run_game(player_cfg, opp_cfg, red_perk=player_perk, black_perk=opponent_perk)

    result_red = 1.0 if game["winner"] == "red" else (0.0 if game["winner"] == "black" else 0.5)
    red_elo_after, _ = update_elo(agent["elo"], 1200, result_red)
    red_result = "win" if game["winner"] == "red" else ("loss" if game["winner"] == "black" else "draw")
    update_agent_after_match(agent_id, red_elo_after, red_result)

    match_id = save_match(
        red_config=player_cfg.to_dict(), black_config=opp_cfg.to_dict(),
        winner=game["winner"], move_count=game["move_count"],
        final_red=game["final_red"], final_black=game["final_black"],
        moves=game["moves"], shrink_events=game["events"],
        red_elo_before=agent["elo"], red_elo_after=red_elo_after,
        black_elo_before=1200, black_elo_after=1200,
        red_agent_id=agent_id,
    )

    bet_result = None
    if bet_amount > 0:
        odds = calculate_match_odds(agent["elo"], 1200)
        boosted_odds = round(odds["red"] * 1.5, 2)
        try:
            bet_info = place_bet("revenge", "red", bet_amount, boosted_odds, match_id=match_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        won = game["winner"] == "red"
        # base (revenge) odds only -- the win-streak no longer multiplies payout
        payout = int(bet_amount * boosted_odds) if won else 0
        settle_bet(bet_info["bet_id"], "win" if won else "loss", payout)
        add_to_jackpot(bet_amount)
        # streak counter is still tracked for engagement; it has no payout effect
        if won:
            increment_streak()
        else:
            reset_streak()
        bet_result = {"amount": bet_amount, "odds": boosted_odds,
                      "result": "win" if won else "loss", "payout": payout}

    records = _compute_records(game, "red")
    new_bests = check_and_update_records(agent_id, records, match_id)

    return {"match_id": match_id, **game, "bet": bet_result, "new_records": new_bests}


@app.get("/api/agents/{agent_id}/records")
def api_agent_records(agent_id: int):
    return get_agent_records(agent_id)


@app.get("/api/agents/{agent_id}/rivalries")
def api_agent_rivalries(agent_id: int):
    return {"rivalries": get_agent_rivalries(agent_id)}


@app.get("/api/agents/{agent_id}/familiarity")
def api_agent_familiarity(agent_id: int):
    return {"familiarity": get_agent_familiarity(agent_id)}


@app.get("/api/edges")
def api_edges():
    """Edge catalog with unlock levels and descriptions for the selection UI."""
    descriptions = {
        "rope_a_dope": "Tightens defense after being attacked",
        "press": "Forces action during stalemates",
        "momentum": "Captures breed more captures",
        "anchor": "Back-row pieces become a fortress. Strong vs aggressors.",
        "phantom": "Calculated counter-attack while behind. Strong vs grinders.",
        "siege": "Kings become assault weapons. Strong vs turtles.",
        "flux": "Playstyle shifts every 8 moves. Strong vs adaptive opponents.",
    }
    return {"edges": [
        {"id": eid, "name": d["name"], "icon": d["icon"], "unlock_level": d["unlock_level"],
         "description": descriptions.get(eid, "")}
        for eid, d in EDGE_DEFINITIONS.items()
    ]}


@app.get("/api/jackpot")
def api_get_jackpot():
    return get_jackpot()


@app.post("/api/bets/double")
def api_double_or_nothing(body: dict):
    previous_bet_id = body.get("previous_bet_id")
    agent_id = body.get("agent_id")
    if not previous_bet_id or not agent_id:
        raise HTTPException(400, "previous_bet_id and agent_id required")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(400, "agent not found")
    # get the amount at risk from wallet streak context
    risk_amount = body.get("amount", 0)
    if risk_amount <= 0:
        raise HTTPException(400, "no amount to double")

    # generate a bot opponent matched to agent elo
    from coaches import COACHES, generate_bot_agent
    coach = random.choice(list(COACHES.values()))
    bot = generate_bot_agent(coach, agent["elo"])
    bot_cfg = AgentConfig(aggression=bot["aggression"], risk_tolerance=bot["risk_tolerance"],
                          king_priority=bot["king_priority"], edge_affinity=bot["edge_affinity"],
                          trade_down=bot["trade_down"])
    player_cfg = AgentConfig(aggression=agent["aggression"], risk_tolerance=agent["risk_tolerance"],
                             king_priority=agent["king_priority"], edge_affinity=agent["edge_affinity"],
                             trade_down=agent["trade_down"])
    game = _run_game(player_cfg, bot_cfg, red_perk=agent.get("perk"), black_perk=bot.get("perk"))
    won = game["winner"] == "red"

    # XP for the player's agent
    update_agent_after_match(agent_id, agent["elo"], "win" if won else "loss")
    # jackpot contribution
    add_to_jackpot(risk_amount)

    if won:
        new_amount = risk_amount * 2
        streak_info = increment_streak()
        # credit the doubled amount
        w = get_wallet()
        settle_bet(previous_bet_id, "win", new_amount)
        return {"result": "win", "amount": new_amount, "next_double": new_amount * 2,
                "boards": game["boards"], "moves": game["moves"], "events": game["events"],
                "move_count": game["move_count"], "bot": bot, "streak": streak_info}
    else:
        streak_info = reset_streak()
        return {"result": "loss", "amount": 0,
                "boards": game["boards"], "moves": game["moves"], "events": game["events"],
                "move_count": game["move_count"], "bot": bot, "streak": streak_info}


@app.post("/api/bets/cashout")
def api_cashout(body: dict):
    amount = body.get("amount", 0)
    if amount <= 0:
        raise HTTPException(400, "nothing to cash out")
    conn = __import__("database").get_db()
    conn.execute("UPDATE wallet SET balance = balance + ? WHERE id = 1", (amount,))
    conn.commit()
    w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    conn.close()
    return {"cashed_out": amount, "balance": w["balance"]}


# --- auth ---

class RegisterRequest(BaseModel):
    username: str
    display_name: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/register")
def api_register(req: RegisterRequest):
    if len(req.username) < 3 or len(req.username) > 20:
        raise HTTPException(400, "username must be 3-20 characters")
    if len(req.password) < 4:
        raise HTTPException(400, "password must be at least 4 characters")
    hashed = hash_password(req.password)
    player = create_player(req.username, req.display_name, hashed)
    if not player:
        raise HTTPException(400, "username already taken")
    token = create_token(player["id"])
    return {"player_id": player["id"], "display_name": player["display_name"], "token": token, "coin_balance": player["coin_balance"]}


@app.post("/api/auth/login")
def api_login(req: LoginRequest):
    player = get_player_by_username(req.username)
    if not player or not verify_password(req.password, player["password_hash"]):
        raise HTTPException(401, "invalid username or password")
    token = create_token(player["id"])
    return {"player_id": player["id"], "display_name": player["display_name"], "token": token, "coin_balance": player["coin_balance"]}


@app.get("/api/auth/me")
def api_me(player_id: int = Depends(get_current_player_id)):
    player = get_player(player_id)
    if not player:
        raise HTTPException(404, "player not found")
    return player


@app.get("/api/players/online")
def api_online_players():
    return {"players": online.get_online(), "count": online.count}


# --- real play (USDC) ---

REAL_BET_TIERS = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000]


@app.get("/api/crypto/status")
def api_crypto_status():
    """Public. Tells the frontend whether real-play is available. Free play always works."""
    return {
        "enabled": crypto_service.available,
        "privy_enabled": privy_service.available,
        "min_bet_usdc": micros_to_usdc(REAL_PLAY_MIN_BET_MICROS),
        "max_bet_usdc": micros_to_usdc(REAL_PLAY_MAX_BET_MICROS),
        "bet_tiers_usdc": [micros_to_usdc(t) for t in REAL_BET_TIERS],
        "usdc_address": crypto_service.usdc_address,
        "chain": "base",
    }


def _ensure_wallet(player: dict) -> str | None:
    """Return the player's wallet address, provisioning via Privy if needed."""
    if player.get("wallet_address"):
        return player["wallet_address"]
    if not privy_service.available:
        return None
    # Provision via Privy using the player's id as the external user key.
    addr = privy_service.get_wallet_address(str(player["id"])) or privy_service.create_embedded_wallet(str(player["id"]))
    if addr:
        set_player_wallet(player["id"], addr)
    return addr


@app.get("/api/wallet/balance")
def api_wallet_balance(player_id: int = Depends(get_current_player_id)):
    player = get_player(player_id)
    if not player:
        raise HTTPException(404, "player not found")
    real = None
    if crypto_service.available:
        addr = _ensure_wallet(player)
        real = {"usdc": micros_to_usdc(player.get("usdc_micros", 0)), "wallet_address": addr}
    return {
        "free_play": {"chips": player["coin_balance"]},
        "real_play": real,  # null when real play is disabled on this server
    }


class DepositRequest(BaseModel):
    amount: float = Field(gt=0)


@app.post("/api/wallet/deposit")
def api_wallet_deposit(req: DepositRequest, player_id: int = Depends(get_current_player_id)):
    if not crypto_service.available:
        raise HTTPException(503, "real play is not available on this server")
    player = get_player(player_id)
    if not player:
        raise HTTPException(404, "player not found")
    addr = _ensure_wallet(player)
    if not addr:
        raise HTTPException(503, "could not provision a wallet")
    onramp = None
    if MOONPAY_API_KEY:
        onramp = (
            f"https://buy.moonpay.com?apiKey={MOONPAY_API_KEY}"
            f"&currencyCode=usdc_base&walletAddress={addr}&baseCurrencyCode=usd"
        )
    return {
        "deposit_address": addr,
        "amount_usdc": req.amount,
        "instructions": "Send USDC on the Base network to this address.",
        "onramp_url": onramp,
    }


class WithdrawRequest(BaseModel):
    amount: float = Field(gt=0)
    to_address: str


@app.post("/api/wallet/withdraw")
def api_wallet_withdraw(req: WithdrawRequest, player_id: int = Depends(get_current_player_id)):
    if not crypto_service.available:
        raise HTTPException(503, "real play is not available on this server")
    if not (req.to_address.startswith("0x") and len(req.to_address) == 42):
        raise HTTPException(400, "invalid destination address")
    micros = usdc_to_micros(req.amount)
    if micros < REAL_PLAY_MIN_WITHDRAW_MICROS:
        raise HTTPException(400, f"minimum withdrawal is {micros_to_usdc(REAL_PLAY_MIN_WITHDRAW_MICROS)} USDC")
    bal = get_player_usdc(player_id)
    if micros > bal:
        raise HTTPException(400, "insufficient balance")
    # Reserve first, then send on-chain; refund the ledger if the transfer fails.
    adjust_player_usdc(player_id, -micros)
    try:
        tx_hash = crypto_service.withdraw_usdc(req.to_address, micros)
    except Exception as e:
        adjust_player_usdc(player_id, micros)  # refund reservation
        raise HTTPException(502, f"withdrawal failed: {e}")
    record_crypto_tx(player_id, "withdraw", -micros, tx_hash=tx_hash, detail=req.to_address)
    return {"tx_hash": tx_hash, "amount": req.amount, "status": "pending"}


@app.get("/api/wallet/transactions")
def api_wallet_transactions(player_id: int = Depends(get_current_player_id)):
    txs = get_crypto_txs(player_id)
    return {"transactions": [{
        "id": t["id"], "kind": t["kind"], "amount_usdc": micros_to_usdc(t["amount_micros"]),
        "tx_hash": t["tx_hash"], "match_id": t["match_id"], "status": t["status"],
        "created_at": t["created_at"], "detail": t["detail"],
    } for t in txs]}


# --- the mirror ---

@app.get("/api/mirror")
def api_mirror_profile():
    return get_mirror_profile()


@app.get("/api/mirror/history")
def api_mirror_history(limit: int = 20):
    return {"history": get_mirror_history(limit)}


# --- coaches ---

@app.get("/api/coaches")
def api_list_coaches():
    return {"coaches": get_coach_list()}


# --- single match ---

def _resolve_side(agent_id, config, label):
    if agent_id is not None:
        agent = get_agent(agent_id)
        if not agent:
            raise HTTPException(400, f"{label} agent not found")
        cfg = AgentConfig(aggression=agent["aggression"], risk_tolerance=agent["risk_tolerance"],
                          king_priority=agent["king_priority"], edge_affinity=agent["edge_affinity"],
                          trade_down=agent["trade_down"])
        return cfg, agent
    if config is not None:
        cfg = AgentConfig(aggression=config.aggression, risk_tolerance=config.risk_tolerance,
                          king_priority=config.king_priority, edge_affinity=config.edge_affinity,
                          trade_down=config.trade_down)
        return cfg, None
    raise HTTPException(400, f"provide either {label}_agent_id or {label} config")


@app.post("/api/agents/{agent_id}/perk")
def api_set_perk(agent_id: int, body: dict):
    perk = body.get("perk")
    if perk is not None and perk not in VALID_PERKS:
        raise HTTPException(400, f"invalid perk, choose from: {', '.join(VALID_PERKS)}")
    result = set_agent_perk(agent_id, perk)
    if result is None:
        raise HTTPException(400, "agent not found or must be level 5 to set a perk")
    return result


_TEAM_SLIDERS = ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")


def _resolve_team(team_spec: "TeamSpec", label: str):
    a = get_agent(team_spec.agent_a_id)
    b = get_agent(team_spec.agent_b_id)
    if not a:
        raise HTTPException(400, f"{label} agent A not found")
    if not b:
        raise HTTPException(400, f"{label} agent B not found")
    return a, b


def _agent_cfg(agent: dict) -> AgentConfig:
    return AgentConfig(**{k: agent[k] for k in _TEAM_SLIDERS})


def _team_summary(agent_a, agent_b, div_bonus, div_frac, elo_after=None):
    """Build a team payload for the response. elo_after = (a_after, b_after) or None."""
    def one(agent, after):
        d = {k: agent[k] for k in _TEAM_SLIDERS}
        d.update({"id": agent.get("id"), "name": agent["name"], "perk": agent.get("perk"),
                  "level": agent.get("level", 1), "elo": round(agent["elo"], 1)})
        if after is not None:
            d["elo_after"] = round(after, 1)
        return d
    return {
        "agent_a": one(agent_a, elo_after[0] if elo_after else None),
        "agent_b": one(agent_b, elo_after[1] if elo_after else None),
        "diversity_bonus": div_bonus,
        "diversity_pct": round(div_frac * 100),
    }


def _simulate_team_game(req: SimulateRequest):
    if not req.red_team:
        raise HTTPException(400, "2v2 requires red_team {agent_a_id, agent_b_id}")
    red_a, red_b = _resolve_team(req.red_team, "red")
    red_a_cfg, red_b_cfg = _agent_cfg(red_a), _agent_cfg(red_b)
    red_div = calculate_diversity_bonus(red_a_cfg, red_b_cfg, red_a.get("perk"), red_b.get("perk"))
    red_frac = slider_diversity(red_a_cfg, red_b_cfg)

    competitive = False
    is_mirror = False
    mirror_meta = None
    bot_coach_id = None

    # resolve the opponent team: VS BOT (coach generates a pair) or sandbox (explicit ids)
    if req.vs_bot:
        coach_id = req.vs_bot.coach_id
        if coach_id == "random":
            coach_id = random.choice(list(COACHES.keys()))
        bot_coach_id = coach_id
        red_team_elo = team_elo(red_a["elo"], red_b["elo"], red_div)
        if coach_id == "mirror":
            is_mirror = True
            mt = generate_mirror_team(red_a_cfg.to_dict(), red_b_cfg.to_dict(),
                                      red_a.get("perk"), red_b.get("perk"))
            black_a = {**mt["agent_a"]["config"], "id": None, "name": mt["agent_a"]["name"],
                       "perk": mt["agent_a"]["edge"], "level": 5, "elo": red_team_elo + random.randint(-30, 30),
                       "coach_id": "mirror", "coach_name": "The Mirror"}
            black_b = {**mt["agent_b"]["config"], "id": None, "name": mt["agent_b"]["name"],
                       "perk": mt["agent_b"]["edge"], "level": 5, "elo": red_team_elo + random.randint(-30, 30),
                       "coach_id": "mirror", "coach_name": "The Mirror"}
            mirror_meta = {"adaptation_level": mt["adaptation_level"], "pair_read": mt["pair_read"],
                           "mirror_strategy": mt["strategy_description"], "bout_number": mt["bout_number"]}
        else:
            coach = COACHES.get(coach_id)
            if not coach:
                raise HTTPException(400, f"unknown coach: {coach_id}")
            black_a, black_b = generate_bot_team(coach, red_team_elo, used_names={red_a["name"], red_b["name"]})
        competitive = (coach_id == "mirror") or (COACHES.get(coach_id) is not None and COACHES[coach_id].difficulty in ("medium", "hard"))
    elif req.black_team:
        black_a, black_b = _resolve_team(req.black_team, "black")
    else:
        raise HTTPException(400, "2v2 requires vs_bot or black_team")

    black_a_cfg, black_b_cfg = _agent_cfg(black_a), _agent_cfg(black_b)
    black_div = calculate_diversity_bonus(black_a_cfg, black_b_cfg, black_a.get("perk"), black_b.get("perk"))
    black_frac = slider_diversity(black_a_cfg, black_b_cfg)

    # matchup familiarity (competitive VS BOT only): each red agent vs the opponent team's type
    red_fam = (0.0, 0.0)
    opp_type = None
    if competitive:
        avg_black = {k: (black_a_cfg.to_dict()[k] + black_b_cfg.to_dict()[k]) // 2 for k in _TEAM_SLIDERS}
        opp_type = categorize_opponent(avg_black)
        red_fam = (get_familiarity_score(red_a["id"], opp_type), get_familiarity_score(red_b["id"], opp_type))

    red_te_before = team_elo(red_a["elo"], red_b["elo"], red_div)
    black_te_before = team_elo(black_a["elo"], black_b["elo"], black_div)

    game = _run_team_game(
        (red_a_cfg, red_b_cfg), (black_a_cfg, black_b_cfg),
        red_perks=(red_a.get("perk"), red_b.get("perk")), black_perks=(black_a.get("perk"), black_b.get("perk")),
        red_fam=red_fam, black_fam=(0.0, 0.0),
        red_diversity_bonus=red_div, black_diversity_bonus=black_div,
        red_diversity_frac=red_frac, black_diversity_frac=black_frac,
    )
    winner = game["winner"]
    result_red = 1.0 if winner == "red" else (0.0 if winner == "black" else 0.5)
    red_result = "win" if winner == "red" else ("loss" if winner == "black" else "draw")
    black_result = "win" if winner == "black" else ("loss" if winner == "red" else "draw")

    # team elo update: apply the team-vs-team delta to BOTH agents on each side
    new_red_te, new_black_te = update_elo(red_te_before, black_te_before, result_red)
    red_delta = new_red_te - red_te_before
    black_delta = new_black_te - black_te_before

    level_ups = []
    red_after = (red_a["elo"] + red_delta, red_b["elo"] + red_delta)
    black_after = (black_a["elo"] + black_delta, black_b["elo"] + black_delta)
    for agent, new_elo in ((red_a, red_after[0]), (red_b, red_after[1])):
        lu = update_agent_after_match(agent["id"], new_elo, red_result)
        if lu:
            level_ups.append(lu)
    for agent, new_elo in ((black_a, black_after[0]), (black_b, black_after[1])):
        if agent.get("id"):  # sandbox opponent agents are real; bot agents are not
            lu = update_agent_after_match(agent["id"], new_elo, black_result)
            if lu:
                level_ups.append(lu)

    match_id = save_match(
        red_config=red_a_cfg.to_dict(), black_config=black_a_cfg.to_dict(),
        winner=winner, move_count=game["move_count"], final_red=game["final_red"], final_black=game["final_black"],
        moves=game["moves"], shrink_events=game["events"],
        red_elo_before=red_te_before, red_elo_after=new_red_te,
        black_elo_before=black_te_before, black_elo_after=new_black_te,
        red_agent_id=red_a.get("id"), black_agent_id=black_a.get("id"),
    )
    save_team_match(match_id, (red_a.get("id"), red_b.get("id")), (black_a.get("id"), black_b.get("id")),
                    red_div, black_div, game["team_dynamics"]["red"], game["team_dynamics"]["black"])

    # progression: evolution + familiarity for red agents (competitive only)
    if competitive:
        for agent in (red_a, red_b):
            process_agent_evolution(agent["id"], red_result)
            if opp_type:
                update_familiarity(agent["id"], opp_type, won=(red_result == "win"))
            fresh = get_agent(agent["id"])
            if fresh and fresh["matches"] > 0 and fresh["matches"] % 50 == 0:
                decay_familiarity(agent["id"])

    resp = {
        "mode": "2v2", "match_id": match_id, **game,
        "red_team": _team_summary(red_a, red_b, red_div, red_frac, red_after),
        "black_team": _team_summary(black_a, black_b, black_div, black_frac, black_after),
        "elo": {"red_before": red_te_before, "red_after": new_red_te,
                "black_before": black_te_before, "black_after": new_black_te},
    }
    if level_ups:
        resp["level_ups"] = level_ups
    if is_mirror:
        resp["mirror_data"] = mirror_meta
    if bot_coach_id:
        resp["bot_coach_id"] = bot_coach_id

    # main bet (team odds + streak), same flow as 1v1
    bet_result = None
    if req.bet:
        if req.bet.side not in ("red", "black", "draw"):
            raise HTTPException(400, "bet side must be red, black, or draw")
        odds = calculate_match_odds(red_te_before, black_te_before)
        side_odds = odds[req.bet.side]
        try:
            bet_info = place_bet("match", req.bet.side, req.bet.amount, side_odds, match_id=match_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        won = winner == req.bet.side
        # base odds only -- streak heat bonus removed (no payout multiplier)
        payout = int(req.bet.amount * side_odds) if won else 0
        settle_result = settle_bet(bet_info["bet_id"], "win" if won else "loss", payout)
        add_to_jackpot(req.bet.amount)
        # streak counter still tracked for engagement; no payout effect
        streak_info = increment_streak() if won else reset_streak()
        bet_result = {"side": req.bet.side, "amount": req.bet.amount, "odds": side_odds,
                      "result": "win" if won else "loss", "payout": payout,
                      "net": payout - req.bet.amount if won else -req.bet.amount,
                      "balance_after": settle_result["balance"], "streak": streak_info}
    resp["bet"] = bet_result

    # 2v2-specific props (alpha dog / team clash / double edge)
    if req.prop_bets:
        if len(req.prop_bets) > 4:
            raise HTTPException(400, "maximum 4 prop bets per match")
        all_props = calculate_team_prop_odds(red_a_cfg.to_dict(), red_b_cfg.to_dict(),
                                              red_a.get("perk"), red_b.get("perk"), red_frac)
        prop_inputs = []
        for pb in req.prop_bets:
            prop_def = next((p for p in all_props if p["type"] == pb.type), None)
            if not prop_def:
                continue
            opt = next((o for o in prop_def.get("options", []) if o["selection"] == pb.selection), None)
            if not opt:
                continue
            try:
                pb_info = place_bet("prop", f"{pb.type}:{pb.selection}", pb.amount, opt["odds"], match_id=match_id)
            except ValueError as e:
                raise HTTPException(400, str(e))
            add_to_jackpot(pb.amount)
            prop_inputs.append({"type": pb.type, "selection": pb.selection, "amount": pb.amount,
                                "odds": opt["odds"], "bet_id": pb_info["bet_id"]})
        prop_results = resolve_team_props(prop_inputs, winner, game["team_dynamics"])
        # Settle each prop against its OWN bet row; props never move the cosmetic
        # win-streak (affect_streak=False). resolve_team_props returns win/loss only.
        for pin, pr in zip(prop_inputs, prop_results):
            settle_bet(pin["bet_id"], pr["result"], pr["payout"], affect_streak=False)
        resp["prop_results"] = prop_results

    return resp


# --- AI commentary (optional enhancement; gated on ANTHROPIC_API_KEY) -------
import os as _os
import urllib.request as _urlreq

ANTHROPIC_API_KEY = _os.environ.get("ANTHROPIC_API_KEY", "")
COMMENTARY_MODEL = "claude-sonnet-4-20250514"


def build_commentary_summary(red_name, red_cfg, red_perk, black_name, black_cfg, black_perk, game):
    """Compact match summary for the commentary prompt."""
    moves = game.get("moves", []) or []
    events = game.get("events", []) or []
    wp = game.get("win_probability", []) or []
    key = []
    for i, mv in enumerate(moves, start=1):
        caps = len((mv or {}).get("captures", []) or [])
        if caps > 1:
            key.append(f"move {i}: {caps}x capture")
    for e in events:
        if e.get("type") == "perk_activate":
            key.append(f"move {e.get('move')}: {e.get('perk')} edge activated")

    def _at(i):
        return wp[i] if 0 <= i < len(wp) else None

    def _agg(c):
        return getattr(c, "aggression", None) if c is not None else None

    def _risk(c):
        return getattr(c, "risk_tolerance", None) if c is not None else None

    return {
        "red_name": red_name, "red_agg": _agg(red_cfg), "red_risk": _risk(red_cfg), "red_edge": red_perk or "none",
        "black_name": black_name, "black_agg": _agg(black_cfg), "black_risk": _risk(black_cfg), "black_edge": black_perk or "none",
        "total_moves": game.get("move_count"),
        "winner": game.get("winner"),
        "key_events": "; ".join(key[:10]) or "steady positional play, few captures",
        "win_probs": [_at(10), _at(20), _at(30), _at(40), _at(50)],
    }


def _commentary_prompt(s):
    return (
        "You are a sportscaster for Agent Checkers where AI agents with configurable "
        "personalities play checkers.\n\n"
        "Match data:\n"
        f"- Red agent: {s['red_name']}, aggression {s['red_agg']}, risk tolerance {s['red_risk']}, edge: {s['red_edge']}\n"
        f"- Black agent: {s['black_name']}, aggression {s['black_agg']}, risk tolerance {s['black_risk']}, edge: {s['black_edge']}\n"
        f"- Total moves: {s['total_moves']}\n"
        f"- Winner: {s['winner']}\n"
        f"- Key events: {s['key_events']}\n"
        f"- Win probability at moves 10, 20, 30, 40, 50: {s['win_probs']}\n\n"
        "Generate 6-8 commentary lines tied to specific move numbers. Rules:\n"
        "- Tell the STORY not the moves\n"
        "- Reference agents by name and personality\n"
        "- Note edge activations and what they mean\n"
        "- Call out momentum shifts and turning points\n"
        "- Build tension toward the conclusion\n"
        "- Each line is ONE sentence max 15 words\n"
        "- Be conversational like a sports commentator\n\n"
        "Respond in JSON only, no markdown:\n"
        '[{"move": 5, "text": "..."}, ...]'
    )


def generate_commentary(summary):
    """Call Claude for sportscaster commentary. Returns [] if no API key or on any error
    (commentary is an enhancement, never a hard requirement)."""
    if not ANTHROPIC_API_KEY:
        return []
    try:
        body = {
            "model": COMMENTARY_MODEL,
            "max_tokens": 700,
            "messages": [{"role": "user", "content": _commentary_prompt(summary)}],
        }
        req = _urlreq.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY,
                     "anthropic-version": "2023-06-01"},
            method="POST",
        )
        with _urlreq.urlopen(req, timeout=12) as r:
            data = json.load(r)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text[:4].lower() == "json":
                text = text[4:]
            text = text.strip()
        lines = json.loads(text)
        out = []
        for ln in lines:
            if isinstance(ln, dict) and "move" in ln and "text" in ln:
                out.append({"move": int(ln["move"]), "text": str(ln["text"])[:120]})
        return out[:8]
    except Exception:
        return []


# --- Arena commentary (uses same API key / model as checkers commentary) ------

def build_arena_summary(result_dict: dict) -> dict:
    """Compact arena match summary for the commentary prompt."""
    red = result_dict.get("red_team", [])
    blue = result_dict.get("blue_team", [])
    drama = result_dict.get("drama_beats", [])

    def _team_desc(team):
        return ", ".join(
            f"{c.get('temperament', 'ADAPTIVE')} {c.get('species', '?').upper()}"
            + (f" (agent: {c['agent_name']})" if c.get("agent_name") else "")
            for c in team
        )

    # Collect key moments from drama beats
    beats = []
    for d in drama[:5]:
        dtype = d.get("type", "")
        cid = d.get("creature_id", "?")
        rnd = d.get("round", "?")
        if dtype == "kill":
            victim = d.get("data", {}).get("victim_id", "?")
            beats.append(f"Round {rnd}: {cid} kills {victim}")
        elif dtype == "breach_complete":
            beats.append(f"Round {rnd}: {cid} breaches the gate")
        elif dtype == "breach_denied":
            beats.append(f"Round {rnd}: {cid}'s breach denied")
        elif dtype == "last_stand":
            beats.append(f"Round {rnd}: {cid} activates LAST STAND")
        elif dtype == "ring_out":
            beats.append(f"Round {rnd}: {cid} claimed by the void")

    return {
        "red_team": _team_desc(red),
        "blue_team": _team_desc(blue),
        "winner": result_dict.get("winner", "draw"),
        "win_method": result_dict.get("win_method", "unknown"),
        "total_rounds": result_dict.get("total_rounds", 0),
        "drama_beats": "; ".join(beats) or "no major drama beats",
    }


def _arena_commentary_prompt(s: dict) -> str:
    return (
        "You are a legendary arena sportscaster for THE ARENA, a hex-grid combat game "
        "where teams of 3 Guardians — each flown by a Pilot with a temperament like "
        "BERSERKER, HEADHUNTER, TURTLE, STALKER, MARTYR, TACTICIAN, or ADAPTIVE — fight to "
        "eliminate the enemy team or breach their gate. The Pilot is the AI personality "
        "calling every move; the Guardian (one of 5 species) is the body it flies.\n\n"
        "Match data:\n"
        f"- Red team: {s['red_team']}\n"
        f"- Blue team: {s['blue_team']}\n"
        f"- Winner: {s['winner']} by {s['win_method']}\n"
        f"- Total rounds: {s['total_rounds']}\n"
        f"- Key moments: {s['drama_beats']}\n\n"
        "Generate 5-7 commentary lines keyed to specific round numbers. Rules:\n"
        "- Reference each combatant by its Pilot's TEMPERAMENT + Guardian SPECIES (e.g. 'BERSERKER Razorwing')\n"
        "- Make temperament matter — a TURTLE Pilot playing cautious, a BERSERKER diving in\n"
        "- Call out kills, breaches, last stands, and ring outs with energy\n"
        "- Build tension: early setup → mid clash → climactic finish\n"
        "- Each line is ONE sentence, max 18 words\n"
        "- Be hype, conversational, dramatic — like a fight commentator\n\n"
        "Respond in JSON only, no markdown:\n"
        '[{"round": 1, "text": "..."}, ...]'
    )


def generate_arena_commentary(result_dict: dict) -> list[dict]:
    """Call Claude for arena sportscaster commentary. Returns [] if no API key or on error."""
    if not ANTHROPIC_API_KEY:
        return []
    try:
        summary = build_arena_summary(result_dict)
        body = {
            "model": COMMENTARY_MODEL,
            "max_tokens": 700,
            "messages": [{"role": "user", "content": _arena_commentary_prompt(summary)}],
        }
        req = _urlreq.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY,
                     "anthropic-version": "2023-06-01"},
            method="POST",
        )
        with _urlreq.urlopen(req, timeout=15) as r:
            data = json.load(r)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text[:4].lower() == "json":
                text = text[4:]
            text = text.strip()
        lines = json.loads(text)
        out = []
        for ln in lines:
            if isinstance(ln, dict) and "round" in ln and "text" in ln:
                out.append({"round": int(ln["round"]), "text": str(ln["text"])[:140]})
        return out[:8]
    except Exception:
        return []


@app.post("/api/game/simulate")
def simulate_game(req: SimulateRequest):
    # Real-money (USDC) betting is exclusive to multiplayer (human vs human, pot-split in
    # ws.py). VS BOT / sandbox are training mode and settle in free-play coins only.
    if req.bet and getattr(req.bet, "mode", "free") == "real":
        raise HTTPException(400, "Real-money bets are only available in multiplayer matches.")
    if req.mode == "2v2":
        return _simulate_team_game(req)
    bot_opponent = None

    is_mirror = False
    mirror_meta = None
    competitive = False   # only VS BOT medium+/mirror and multiplayer count for progression
    opp_type = None
    red_familiarity = 0.0

    if req.vs_bot:
        coach_id = req.vs_bot.coach_id
        if coach_id == "random":
            coach_id = random.choice(list(COACHES.keys()))

        red_cfg, red_agent = _resolve_side(req.red_agent_id, req.red, "red")
        red_elo_before = red_agent["elo"] if red_agent else get_elo(red_cfg.config_key())
        red_perk = red_agent["perk"] if red_agent else None
        player_config = red_agent if red_agent else red_cfg.to_dict()

        if coach_id == "mirror":
            is_mirror = True
            mirror_result = generate_mirror_agent(player_config, player_edge=red_perk)
            mc = mirror_result["config"]
            black_cfg = AgentConfig(**mc)
            black_agent = None
            black_elo_before = red_elo_before + random.randint(-30, 30)
            black_perk = mirror_result["edge"]
            bot_opponent = {
                "name": mirror_result["name"], "coach_id": "mirror", "coach_name": "The Mirror",
                **mc, "elo": black_elo_before, "perk": mirror_result["edge"],
            }
            mirror_meta = {
                "adaptation_level": mirror_result["adaptation_level"],
                "tendencies_exploited": mirror_result["tendencies_exploited"],
                "mirror_strategy": mirror_result["strategy_description"],
                "bout_number": mirror_result["bout_number"],
                "milestone": mirror_result["milestone"],
                "current_read": mirror_result["current_read"],
            }
        else:
            coach = COACHES.get(coach_id)
            if not coach:
                raise HTTPException(400, f"unknown coach: {coach_id}")
            bot = generate_bot_agent(coach, red_elo_before, player_config=player_config)
            black_cfg = AgentConfig(aggression=bot["aggression"], risk_tolerance=bot["risk_tolerance"],
                                    king_priority=bot["king_priority"], edge_affinity=bot["edge_affinity"],
                                    trade_down=bot["trade_down"])
            black_agent = None
            black_elo_before = bot["elo"]
            black_perk = bot["perk"]
            bot_opponent = {
                "name": bot["name"], "coach_id": bot["coach_id"], "coach_name": bot["coach_name"],
                "aggression": bot["aggression"], "risk_tolerance": bot["risk_tolerance"],
                "king_priority": bot["king_priority"], "edge_affinity": bot["edge_affinity"],
                "trade_down": bot["trade_down"], "elo": bot["elo"], "perk": bot["perk"],
            }
        # competitive = mirror or a medium/hard coach (wildcard/easy doesn't count)
        coach_obj = COACHES.get(coach_id)
        competitive = (coach_id == "mirror") or (coach_obj is not None and coach_obj.difficulty in ("medium", "hard"))
        if competitive and red_agent:
            opp_type = categorize_opponent(bot_opponent)
            red_familiarity = get_familiarity_score(red_agent["id"], opp_type)
    else:
        red_cfg, red_agent = _resolve_side(req.red_agent_id, req.red, "red")
        black_cfg, black_agent = _resolve_side(req.black_agent_id, req.black, "black")
        red_elo_before = red_agent["elo"] if red_agent else get_elo(red_cfg.config_key())
        black_elo_before = black_agent["elo"] if black_agent else get_elo(black_cfg.config_key())
        red_perk = red_agent["perk"] if red_agent else None
        black_perk = black_agent["perk"] if black_agent else None

    game = _run_game(red_cfg, black_cfg, red_perk=red_perk, black_perk=black_perk,
                     red_familiarity=red_familiarity)

    result_red = 1.0 if game["winner"] == "red" else (0.0 if game["winner"] == "black" else 0.5)
    red_elo_after, black_elo_after = update_elo(red_elo_before, black_elo_before, result_red)

    level_ups = []
    red_result = "win" if game["winner"] == "red" else ("loss" if game["winner"] == "black" else "draw")
    black_result = "win" if game["winner"] == "black" else ("loss" if game["winner"] == "red" else "draw")
    if red_agent:
        lu = update_agent_after_match(red_agent["id"], red_elo_after, red_result)
        if lu:
            level_ups.append(lu)
    else:
        update_elo_record(red_cfg.config_key(), red_cfg.to_dict(), red_elo_after, red_result)
    if black_agent:
        lu = update_agent_after_match(black_agent["id"], black_elo_after, black_result)
        if lu:
            level_ups.append(lu)
    elif not bot_opponent:
        update_elo_record(black_cfg.config_key(), black_cfg.to_dict(), black_elo_after, black_result)

    match_id = save_match(
        red_config=red_cfg.to_dict(), black_config=black_cfg.to_dict(),
        winner=game["winner"], move_count=game["move_count"],
        final_red=game["final_red"], final_black=game["final_black"],
        moves=game["moves"], shrink_events=game["events"],
        red_elo_before=red_elo_before, red_elo_after=red_elo_after,
        black_elo_before=black_elo_before, black_elo_after=black_elo_after,
        red_agent_id=red_agent["id"] if red_agent else None,
        black_agent_id=black_agent["id"] if black_agent else None,
    )

    # --- progression: evolution + familiarity (competitive matches only) ---
    evolution_result = None
    if competitive and red_agent:
        evolution_result = process_agent_evolution(red_agent["id"], red_result)
        if opp_type:
            update_familiarity(red_agent["id"], opp_type, won=(red_result == "win"))
        fresh = get_agent(red_agent["id"])
        if fresh and fresh["matches"] > 0 and fresh["matches"] % 50 == 0:
            decay_familiarity(red_agent["id"])

    # --- betting ---
    bet_result = None
    if req.bet:
        if req.bet.side not in ("red", "black", "draw"):
            raise HTTPException(400, "bet side must be red, black, or draw")
        odds = calculate_match_odds(red_elo_before, black_elo_before)
        side_odds = odds[req.bet.side]
        try:
            bet_info = place_bet("match", req.bet.side, req.bet.amount, side_odds, match_id=match_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        won = game["winner"] == req.bet.side
        is_blocked_draw = game.get("draw_reason") == "blocked"
        # blocked draws → push (refund): board-shrink forced the draw, nobody won
        if is_blocked_draw:
            payout = req.bet.amount  # full refund
            bet_outcome = "push"
        elif won:
            payout = int(req.bet.amount * side_odds)
            bet_outcome = "win"
        else:
            payout = 0
            bet_outcome = "loss"
        settle_result = settle_bet(bet_info["bet_id"], "win" if payout > 0 else "loss", payout)
        # jackpot contribution
        jp_add = add_to_jackpot(req.bet.amount)
        # streak counter still tracked for engagement; no payout effect
        if bet_outcome == "win":
            streak_info = increment_streak()
        elif bet_outcome == "push":
            streak_info = {"current": 0}  # push doesn't affect streak
        else:
            streak_info = reset_streak()
        bet_result = {
            "bet_id": bet_info["bet_id"], "side": req.bet.side,
            "amount": req.bet.amount, "odds": side_odds,
            "result": bet_outcome,
            "payout": payout, "net": 0 if is_blocked_draw else (payout - req.bet.amount if won else -req.bet.amount),
            "balance_after": settle_result["balance"], "bankrupt": settle_result["bankrupt"],
            "streak": streak_info, "jackpot_contribution": jp_add,
        }

    resp = {
        "match_id": match_id, **game,
        "elo": {"red_before": red_elo_before, "red_after": red_elo_after,
                "black_before": black_elo_before, "black_after": black_elo_after},
    }
    if red_agent:
        resp["red_agent"] = {"id": red_agent["id"], "name": red_agent["name"], "perk": red_perk}
    if black_agent:
        resp["black_agent"] = {"id": black_agent["id"], "name": black_agent["name"], "perk": black_perk}
    # optional AI commentary — no-op (returns []) unless ANTHROPIC_API_KEY is set
    _opp_name = black_agent["name"] if black_agent else (bot_opponent.get("name") if bot_opponent else "Black")
    resp["commentary"] = generate_commentary(build_commentary_summary(
        red_agent["name"] if red_agent else "Red", red_cfg, red_perk,
        _opp_name, black_cfg, black_perk, game))
    if level_ups:
        resp["level_ups"] = level_ups
    if evolution_result:
        resp["evolution"] = evolution_result
    resp["bet"] = bet_result

    # --- prop bets ---
    if req.prop_bets and len(req.prop_bets) > 0:
        if len(req.prop_bets) > 4:
            raise HTTPException(400, "maximum 4 prop bets per match")
        # deduct all prop bet amounts
        prop_inputs = []
        # prop odds depend only on the two configs + perks -- compute once, not once per bet
        all_props = calculate_prop_odds(red_cfg.to_dict(), black_cfg.to_dict(), red_perk, black_perk)
        for pb in req.prop_bets:
            prop_def = next((p for p in all_props if p["type"] == pb.type), None)
            if not prop_def:
                continue
            opt = next((o for o in prop_def.get("options", []) if o["selection"] == pb.selection), None)
            if not opt:
                continue
            try:
                pb_info = place_bet("prop", f"{pb.type}:{pb.selection}", pb.amount, opt["odds"], match_id=match_id)
            except ValueError as e:
                raise HTTPException(400, str(e))
            add_to_jackpot(pb.amount)
            prop_inputs.append({"type": pb.type, "selection": pb.selection, "amount": pb.amount,
                                "odds": opt["odds"], "line": prop_def.get("line"),
                                "bet_id": pb_info["bet_id"]})

        prop_results = resolve_props(game["boards"], game["moves"], game["events"], prop_inputs, game["winner"])

        # Settle each prop against its OWN bet row (resolve_props returns one result
        # per input, in order). A win/loss/push is recorded correctly and the
        # cosmetic win-streak is never moved by a prop (affect_streak=False).
        for pin, pr in zip(prop_inputs, prop_results):
            settle_bet(pin["bet_id"], pr["result"], pr["payout"], affect_streak=False)

        resp["prop_results"] = prop_results

    if bot_opponent:
        resp["bot_opponent"] = bot_opponent
        # mirror bout recording
        if is_mirror and red_agent:
            record_mirror_bout(
                match_id=match_id, player_agent_id=red_agent["id"],
                player_config=red_cfg.to_dict(), player_edge=red_perk,
                mirror_config=bot_opponent, mirror_edge=bot_opponent.get("perk"),
                winner=game["winner"],
            )
            mp = get_mirror_profile()
            mirror_meta["series_record"] = f"You {mp['player_wins']} - {mp['mirror_wins']} Mirror"
            if mp["draws"]:
                mirror_meta["series_record"] += f" ({mp['draws']} draws)"
            resp["mirror_data"] = mirror_meta
        # rivalry tracking for VS BOT
        if red_agent and bot_opponent.get("coach_id"):
            opp_type = f"coach:{bot_opponent['coach_id']}"
            opp_label = bot_opponent["coach_name"]
            update_rivalry(red_agent["id"], opp_type, opp_label, red_result)
            rivalry = get_rivalry(red_agent["id"], opp_type)
            if rivalry:
                resp["rivalry"] = rivalry
        # records
        if red_agent:
            records = _compute_records(game, "red")
            new_bests = check_and_update_records(red_agent["id"], records, match_id)
            if new_bests:
                resp["new_records"] = new_bests
        # revenge offer on loss
        if game["winner"] == "black" and red_agent and bot_opponent:
            resp["revenge_available"] = {
                "opponent_config": {k: bot_opponent[k] for k in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")},
                "opponent_perk": bot_opponent.get("perk"),
                "coach_id": bot_opponent.get("coach_id"),
                "odds_boost": 1.5,
            }
    return resp


# --- tournaments ---

@app.post("/api/tournaments")
def api_create_tournament(req: TournamentRequest):
    if req.bracket_size not in (4, 8):
        raise HTTPException(400, "bracket_size must be 4 or 8")
    if len(req.agent_ids) < 2:
        raise HTTPException(400, "need at least 2 agents")
    if len(req.agent_ids) > req.bracket_size:
        raise HTTPException(400, "too many agents for bracket size")

    # resolve named agents
    used_names: set[str] = set()
    participants = []
    for aid in req.agent_ids:
        a = get_agent(aid)
        if not a:
            raise HTTPException(400, f"agent {aid} not found")
        participants.append({
            "name": a["name"], "agent_id": a["id"], "is_random": False,
            "config": {k: a[k] for k in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")},
            "elo": a["elo"], "perk": a.get("perk"),
        })
        used_names.add(a["name"])

    # fill remaining slots
    bot_coach = None
    is_mirror_tournament = False
    if req.vs_bot:
        coach_id = req.vs_bot.coach_id
        if coach_id == "random":
            coach_id = random.choice(list(COACHES.keys()))

        if coach_id == "mirror":
            is_mirror_tournament = True
            player_avg_elo = sum(p["elo"] for p in participants) / len(participants) if participants else 1200
            # generate mirror counter-agents, each targeting a different player agent
            mirror_idx = 0
            while len(participants) < req.bracket_size:
                # cycle through player agents to target
                target = participants[mirror_idx % len(participants)] if participants else None
                target_config = target["config"] if target else None
                target_edge = target.get("perk") if target else None
                mirror_agent = generate_mirror_agent(target_config or {}, player_edge=target_edge)
                mc = mirror_agent["config"]
                elo = player_avg_elo + random.randint(-30, 30)
                participants.append({
                    "name": mirror_agent["name"], "agent_id": None, "is_random": True, "is_bot": True,
                    "config": mc, "elo": round(elo, 1), "perk": mirror_agent["edge"],
                    "coach_id": "mirror", "coach_name": "The Mirror",
                })
                used_names.add(mirror_agent["name"])
                mirror_idx += 1
        else:
            bot_coach = COACHES.get(coach_id)
            if not bot_coach:
                raise HTTPException(400, f"unknown coach: {coach_id}")
            player_avg_elo = sum(p["elo"] for p in participants) / len(participants) if participants else 1200
            while len(participants) < req.bracket_size:
                bot = generate_bot_agent(bot_coach, player_avg_elo, used_names=used_names)
                participants.append({
                    "name": bot["name"], "agent_id": None, "is_random": True, "is_bot": True,
                    "config": {k: bot[k] for k in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down")},
                    "elo": bot["elo"], "perk": bot["perk"], "coach_id": bot_coach.id, "coach_name": bot_coach.name,
                })
    else:
        while len(participants) < req.bracket_size:
            participants.append(_generate_random_agent(used_names))

    # seed
    if req.seeding == "elo":
        participants.sort(key=lambda p: p["elo"], reverse=True)
    else:
        random.shuffle(participants)
    for i, p in enumerate(participants):
        p["seed"] = i + 1

    # build bracket slot order
    if req.bracket_size == 8:
        slot_order = [0, 7, 3, 4, 1, 6, 2, 5]
        round_names = ["Quarterfinals", "Semifinals", "Final"]
    else:
        slot_order = [0, 3, 1, 2]
        round_names = ["Semifinals", "Final"]

    bracket_agents = [None] * req.bracket_size
    for slot, seed_idx in enumerate(slot_order):
        p = participants[seed_idx]
        p["slot"] = slot
        bracket_agents[slot] = p

    # simulate round by round
    all_match_data = []
    total_moves = 0
    total_upsets = 0
    current_winners = list(range(req.bracket_size))  # slot indices of alive agents
    elo_snapshot = {p["name"]: p["elo"] for p in bracket_agents}

    rounds_output = []
    num_rounds = len(round_names)
    matches_per_round = req.bracket_size // 2

    for round_idx in range(num_rounds):
        round_matches = []
        next_winners = []
        num_matches = matches_per_round // (2 ** round_idx)

        for mi in range(num_matches):
            r_slot = current_winners[mi * 2]
            b_slot = current_winners[mi * 2 + 1]
            red_p = bracket_agents[r_slot]
            black_p = bracket_agents[b_slot]

            red_cfg = AgentConfig(**red_p["config"])
            black_cfg = AgentConfig(**black_p["config"])
            red_elo = elo_snapshot[red_p["name"]]
            black_elo = elo_snapshot[black_p["name"]]

            game = _run_game(red_cfg, black_cfg,
                             red_perk=red_p.get("perk"), black_perk=black_p.get("perk"))
            # tournament bracket needs a winner — if blocked draw, side with more material advances
            if game["winner"] == "draw" and game.get("draw_reason") == "blocked":
                game["winner"] = "red" if game["final_red"] > game["final_black"] else "black"
                game["bracket_tiebreak"] = True
            tag = _detect_tag(game, red_elo, black_elo)
            if tag == "UPSET":
                total_upsets += 1
            total_moves += game["move_count"]

            result_red = 1.0 if game["winner"] == "red" else (0.0 if game["winner"] == "black" else 0.5)
            new_red_elo, new_black_elo = update_elo(red_elo, black_elo, result_red)
            elo_snapshot[red_p["name"]] = new_red_elo
            elo_snapshot[black_p["name"]] = new_black_elo

            if red_p["agent_id"] is not None:
                r_result = "win" if game["winner"] == "red" else ("loss" if game["winner"] == "black" else "draw")
                update_agent_after_match(red_p["agent_id"], new_red_elo, r_result)
            if black_p["agent_id"] is not None:
                b_result = "win" if game["winner"] == "black" else ("loss" if game["winner"] == "red" else "draw")
                update_agent_after_match(black_p["agent_id"], new_black_elo, b_result)

            winner_slot = r_slot if game["winner"] == "red" else b_slot
            winner_name = red_p["name"] if game["winner"] == "red" else black_p["name"]
            winner_seed = red_p["seed"] if game["winner"] == "red" else black_p["seed"]
            next_winners.append(winner_slot)

            match_record = {
                "match_index": mi,
                "red_slot": r_slot, "black_slot": b_slot, "winner_slot": winner_slot,
                "red_name": red_p["name"], "black_name": black_p["name"], "winner_name": winner_name,
                "red_seed": red_p["seed"], "black_seed": black_p["seed"], "winner_seed": winner_seed,
                "red_elo": red_elo, "black_elo": black_elo,
                "tag": tag,
                "game": game,
                "round_name": round_names[round_idx],
            }
            round_matches.append(match_record)
            all_match_data.append(match_record)

        rounds_output.append({"round": round_idx + 1, "name": round_names[round_idx], "matches": round_matches})
        current_winners = next_winners

    champion_slot = current_winners[0]
    champion = bracket_agents[champion_slot]

    # elo changes summary
    elo_changes = []
    for p in bracket_agents:
        before = p["elo"]
        after = elo_snapshot[p["name"]]
        elo_changes.append({
            "name": p["name"], "agent_id": p["agent_id"], "seed": p["seed"],
            "before": before, "after": after, "delta": round(after - before, 1),
        })

    awards = _compute_awards(bracket_agents, all_match_data, champion_slot, elo_changes)

    # strip full boards from bracket storage (keep for response)
    bracket_for_db = {
        "agents": [{k: v for k, v in a.items() if k != "config"} for a in bracket_agents],
        "rounds": [{
            "round": rd["round"], "name": rd["name"],
            "matches": [{k: v for k, v in m.items() if k != "game"} for m in rd["matches"]],
        } for rd in rounds_output],
    }

    tid = save_tournament(
        bracket_size=req.bracket_size, seeding=req.seeding,
        bracket_json=json.dumps(bracket_for_db),
        champion_agent_id=champion["agent_id"],
        awards_json=json.dumps(awards),
        total_moves=total_moves, total_upsets=total_upsets,
    )

    # build response with full match data
    response_rounds = {}
    for rd in rounds_output:
        key = f"round_{rd['round']}" if rd["name"] != "Final" else "final"
        response_rounds[key] = [{
            "match_index": m["match_index"],
            "red": {"name": m["red_name"], "seed": m["red_seed"], "elo": m["red_elo"], "slot": m["red_slot"]},
            "black": {"name": m["black_name"], "seed": m["black_seed"], "elo": m["black_elo"], "slot": m["black_slot"]},
            "winner": m["game"]["winner"], "winner_name": m["winner_name"],
            "move_count": m["game"]["move_count"],
            "final_red": m["game"]["final_red"], "final_black": m["game"]["final_black"],
            "boards": m["game"]["boards"], "moves": m["game"]["moves"], "events": m["game"]["events"],
            "tag": m["tag"],
        } for m in rd["matches"]]

    resp = {
        "tournament_id": tid,
        "bracket_size": req.bracket_size,
        "seeding": req.seeding,
        "bracket": {
            "agents": [{
                "slot": a["slot"], "agent_id": a["agent_id"], "name": a["name"],
                "seed": a["seed"], "is_random": a["is_random"], "elo_before": a["elo"],
                "config": a["config"],
            } for a in bracket_agents],
            "rounds": [{
                "round": rd["round"], "name": rd["name"],
                "matches": [{
                    "match_index": m["match_index"],
                    "red_slot": m["red_slot"], "black_slot": m["black_slot"],
                    "winner_slot": m["winner_slot"], "tag": m["tag"],
                    "move_count": m["game"]["move_count"],
                } for m in rd["matches"]],
            } for rd in rounds_output],
        },
        "matches": response_rounds,
        "champion": {"name": champion["name"], "agent_id": champion["agent_id"], "seed": champion["seed"]},
        "awards": awards,
        "elo_changes": elo_changes,
        "champion_bet": None,
        "lucky_match": {"round": 1, "match_index": random.randint(0, max(1, matches_per_round - 1)), "multiplier": 2.0} if random.random() < 0.25 else None,
        "final_heat": 1.5,
    }

    # --- tournament champion bet ---
    if req.champion_bet:
        t_odds = calculate_tournament_odds(participants)
        agent_odds = t_odds.get(req.champion_bet.agent_id)
        if not agent_odds:
            raise HTTPException(400, "bet agent not in tournament")
        picked_name = next((p["name"] for p in participants if p.get("agent_id") == req.champion_bet.agent_id), "?")
        try:
            bet_info = place_bet("tournament", picked_name, req.champion_bet.amount, agent_odds, tournament_id=tid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        won = champion["agent_id"] == req.champion_bet.agent_id
        payout = int(req.champion_bet.amount * agent_odds) if won else 0
        settle_result = settle_bet(bet_info["bet_id"], "win" if won else "loss", payout)
        resp["champion_bet"] = {
            "bet_id": bet_info["bet_id"], "agent_name": picked_name,
            "amount": req.champion_bet.amount, "odds": agent_odds,
            "result": "win" if won else "loss",
            "payout": payout, "net": payout - req.champion_bet.amount if won else -req.champion_bet.amount,
            "balance_after": settle_result["balance"], "bankrupt": settle_result["bankrupt"],
        }

    if bot_coach or is_mirror_tournament:
        player_wins = sum(1 for m in all_match_data if not bracket_agents[m["winner_slot"]].get("is_bot"))
        bot_wins = sum(1 for m in all_match_data if bracket_agents[m["winner_slot"]].get("is_bot"))
        coach_label = "The Mirror" if is_mirror_tournament else bot_coach.name
        coach_id_label = "mirror" if is_mirror_tournament else bot_coach.id
        resp["teams"] = {
            "player": {"wins": player_wins},
            "bot": {"coach_id": coach_id_label, "coach_name": coach_label, "wins": bot_wins},
            "team_result": "player" if player_wins > bot_wins else "bot" if bot_wins > player_wins else "split",
        }

    # --- parlay ---
    if req.parlay and req.parlay.predictions:
        try:
            parlay_bet = place_bet("parlay", "bracket", req.parlay.amount, 1.0, tournament_id=tid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        add_to_jackpot(req.parlay.amount)
        # check predictions vs actual results
        correct = 0
        total_predictions = len(req.parlay.predictions)
        per_match = []
        total_odds = 1.0
        for pred in req.parlay.predictions:
            rd_idx = pred.round - 1
            mi = pred.match_index
            if rd_idx < len(rounds_output) and mi < len(rounds_output[rd_idx]["matches"]):
                match_data = rounds_output[rd_idx]["matches"][mi]
                actual_winner = match_data["winner_slot"]
                is_correct = actual_winner == pred.predicted_winner_slot
                if is_correct:
                    correct += 1
                # calc individual match odds
                red_elo = match_data.get("red_elo", 1200)
                black_elo = match_data.get("black_elo", 1200)
                match_odds = calculate_match_odds(red_elo, black_elo)
                winner_side = "red" if actual_winner == match_data["red_slot"] else "black"
                this_odds = match_odds.get(winner_side, 1.8)
                total_odds *= this_odds
                per_match.append({"round": pred.round, "match_index": mi,
                                  "predicted_slot": pred.predicted_winner_slot,
                                  "actual_slot": actual_winner, "correct": is_correct})
            else:
                per_match.append({"round": pred.round, "match_index": mi, "correct": False})

        result_type, payout = calc_parlay_payout(correct, total_predictions, req.parlay.amount, total_odds)
        settle_bet(parlay_bet["bet_id"], "win" if payout > 0 else "loss", payout)
        if payout > 0:
            increment_streak(3 if result_type == "full_hit" else 1)
        else:
            reset_streak()

        # jackpot trigger: perfect 8-bracket parlay
        jackpot_payout = 0
        if result_type == "full_hit" and req.bracket_size == 8:
            jackpot_payout = hit_jackpot()

        save_parlay(tid, req.parlay.amount, [p.dict() for p in req.parlay.predictions],
                    total_odds, correct, total_predictions, result_type, payout)

        resp["parlay_result"] = {
            "predictions": total_predictions, "correct": correct,
            "result": result_type, "total_odds": round(total_odds, 2),
            "payout": payout, "jackpot_payout": jackpot_payout,
            "per_match": per_match,
        }

    return resp


@app.post("/api/tournaments/team")
def api_create_team_tournament(req: TeamTournamentRequest):
    """2v2 single-elimination bracket: the player's team + 3 bot teams (4 total)."""
    pa = get_agent(req.team.agent_a_id)
    pb = get_agent(req.team.agent_b_id)
    if not pa or not pb:
        raise HTTPException(400, "team agents not found")

    def make_team(a, b, is_player, coach_name=None):
        ca, cb = _agent_cfg(a), _agent_cfg(b)
        frac = slider_diversity(ca, cb)
        bonus = calculate_diversity_bonus(ca, cb, a.get("perk"), b.get("perk"))
        return {
            "name": f"{a['name']} + {b['name']}", "agent_a": a, "agent_b": b,
            "cfg_a": ca, "cfg_b": cb, "perk_a": a.get("perk"), "perk_b": b.get("perk"),
            "diversity_bonus": bonus, "diversity_pct": round(frac * 100), "diversity_frac": frac,
            "team_elo": team_elo(a["elo"], b["elo"], bonus),
            "is_player": is_player, "coach_name": coach_name,
        }

    teams = [make_team(pa, pb, True)]
    used_names = {pa["name"], pb["name"]}
    player_team_elo = teams[0]["team_elo"]

    coach_id = req.vs_bot.coach_id if req.vs_bot else "mixed"
    coach_ids = list(COACHES.keys())
    for i in range(3):
        cid = random.choice(coach_ids) if coach_id in ("mixed", "random") else coach_id
        coach = COACHES.get(cid) or COACHES["wildcard"]
        ba, bb = generate_bot_team(coach, player_team_elo, used_names=used_names)
        teams.append(make_team(ba, bb, False, coach.name))

    # seed by team elo
    if req.seeding == "elo":
        teams.sort(key=lambda t: t["team_elo"], reverse=True)
    else:
        random.shuffle(teams)
    for i, t in enumerate(teams):
        t["seed"] = i + 1

    slot_order = [0, 3, 1, 2]
    round_names = ["Semifinals", "Final"]
    bracket = [None] * 4
    for slot, seed_idx in enumerate(slot_order):
        bracket[slot] = teams[seed_idx]
    elo_snapshot = {t["name"]: t["team_elo"] for t in bracket}

    rounds_output = []
    current = list(range(4))
    for round_idx, rname in enumerate(round_names):
        num_matches = (4 // 2) // (2 ** round_idx)
        round_matches = []
        next_winners = []
        for mi in range(num_matches):
            r_slot, b_slot = current[mi * 2], current[mi * 2 + 1]
            red_t, black_t = bracket[r_slot], bracket[b_slot]
            game = _run_team_game(
                (red_t["cfg_a"], red_t["cfg_b"]), (black_t["cfg_a"], black_t["cfg_b"]),
                red_perks=(red_t["perk_a"], red_t["perk_b"]), black_perks=(black_t["perk_a"], black_t["perk_b"]),
                red_diversity_bonus=red_t["diversity_bonus"], black_diversity_bonus=black_t["diversity_bonus"],
                red_diversity_frac=red_t["diversity_frac"], black_diversity_frac=black_t["diversity_frac"],
            )
            # tournament bracket tiebreak for blocked draws
            if game["winner"] == "draw" and game.get("draw_reason") == "blocked":
                game["winner"] = "red" if game["final_red"] > game["final_black"] else "black"
                game["bracket_tiebreak"] = True
            re_before, be_before = elo_snapshot[red_t["name"]], elo_snapshot[black_t["name"]]
            result_red = 1.0 if game["winner"] == "red" else (0.0 if game["winner"] == "black" else 0.5)
            new_re, new_be = update_elo(re_before, be_before, result_red)
            elo_snapshot[red_t["name"]], elo_snapshot[black_t["name"]] = new_re, new_be
            red_word = "win" if game["winner"] == "red" else ("loss" if game["winner"] == "black" else "draw")
            black_word = "win" if game["winner"] == "black" else ("loss" if game["winner"] == "red" else "draw")
            for t, delta, res_word in ((red_t, new_re - re_before, red_word), (black_t, new_be - be_before, black_word)):
                if t["is_player"]:
                    for ag in (t["agent_a"], t["agent_b"]):
                        update_agent_after_match(ag["id"], ag["elo"] + delta, res_word)
            winner_slot = r_slot if game["winner"] == "red" else b_slot
            next_winners.append(winner_slot)
            round_matches.append({
                "match_index": mi, "red_slot": r_slot, "black_slot": b_slot, "winner_slot": winner_slot,
                "red_name": red_t["name"], "black_name": black_t["name"],
                "winner_name": bracket[winner_slot]["name"], "round_name": rname,
                "red_diversity": red_t["diversity_bonus"], "black_diversity": black_t["diversity_bonus"],
                "red_elo": round(re_before, 1), "black_elo": round(be_before, 1),
                "red_is_player": red_t["is_player"], "black_is_player": black_t["is_player"],
                # full team summaries so the client can render live playback (agent names/perks)
                "red_team": _team_summary(red_t["agent_a"], red_t["agent_b"], red_t["diversity_bonus"], red_t["diversity_frac"]),
                "black_team": _team_summary(black_t["agent_a"], black_t["agent_b"], black_t["diversity_bonus"], black_t["diversity_frac"]),
                "game": game, "team_dynamics": game["team_dynamics"],
            })
        rounds_output.append({"round": round_idx + 1, "name": rname, "matches": round_matches})
        current = next_winners

    champion = bracket[current[0]]
    bracket_display = [{
        "slot": i, "seed": t["seed"], "name": t["name"],
        "agent_a": t["agent_a"]["name"], "agent_b": t["agent_b"]["name"],
        "diversity_pct": t["diversity_pct"], "diversity_bonus": t["diversity_bonus"],
        "team_elo": round(t["team_elo"], 1), "is_player": t["is_player"], "coach_name": t["coach_name"],
    } for i, t in enumerate(bracket)]

    return {
        "mode": "2v2", "bracket_size": 4, "rounds": rounds_output,
        "bracket": bracket_display, "champion_slot": current[0],
        "champion": {"name": champion["name"], "is_player": champion["is_player"],
                     "diversity_bonus": champion["diversity_bonus"]},
    }


@app.post("/api/bets/tournament-settle")
def api_settle_tournament_bets(body: dict):
    bets = body.get("bets", [])
    if not bets:
        raise HTTPException(400, "no bets to settle")
    results = []
    total_payout = 0
    total_wagered = 0
    # all writes go through ONE connection -- the streak/jackpot helpers each open their
    # own connection and would deadlock against an open write transaction here (WAL allows
    # one writer).
    from database import get_db, JACKPOT_RATE
    conn = get_db()
    row = conn.execute("SELECT balance, win_streak, best_streak FROM wallet WHERE id = 1").fetchone()
    win_streak = row["win_streak"] if row else 0
    best_streak = row["best_streak"] if row else 0
    jackpot_add = 0
    for b in bets:
        amount = b.get("amount", 0)
        odds = b.get("odds", 1.0)
        won = b.get("won", False)
        # base odds only -- streak heat bonus removed. "lucky" (2x) is the separate
        # lucky-match tournament feature and is unaffected.
        effective_odds = round(odds * (2.0 if b.get("lucky") else 1.0), 2)
        payout = int(amount * effective_odds) if won else 0
        total_wagered += amount
        total_payout += payout
        conn.execute("UPDATE wallet SET balance = balance - ? WHERE id = 1", (amount,))
        if payout > 0:
            conn.execute("UPDATE wallet SET balance = balance + ? WHERE id = 1", (payout,))
        jackpot_add += max(1, int(amount * JACKPOT_RATE))
        results.append({"amount": amount, "odds": odds, "effective_odds": effective_odds, "won": won, "payout": payout})
    conn.execute("UPDATE jackpot SET pool = pool + ? WHERE id = 1", (jackpot_add,))
    # streak: any loss resets; an all-win slate extends by the number of wins
    wins_count = sum(1 for r in results if r["won"])
    losses = sum(1 for r in results if not r["won"])
    if losses > 0:
        conn.execute("UPDATE wallet SET win_streak = 0 WHERE id = 1")
    elif wins_count > 0:
        new_streak = win_streak + wins_count
        conn.execute("UPDATE wallet SET win_streak = ?, best_streak = ? WHERE id = 1", (new_streak, max(new_streak, best_streak)))
    conn.commit()
    final_w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    conn.close()
    net = total_payout - total_wagered
    return {"results": results, "total_wagered": total_wagered, "total_payout": total_payout, "net": net, "balance": final_w["balance"]}


@app.get("/api/tournaments")
def api_list_tournaments(limit: int = 20):
    return {"tournaments": get_tournaments(limit)}


@app.get("/api/tournaments/{tid}")
def api_get_tournament(tid: int):
    t = get_tournament(tid)
    if not t:
        raise HTTPException(404, "tournament not found")
    return t


# --- other endpoints ---

@app.get("/api/history")
def list_matches(limit: int = 50):
    return get_matches(limit)


@app.get("/api/history/{match_id}")
def get_match_detail(match_id: int):
    match = get_match(match_id)
    if not match:
        raise HTTPException(status_code=404, detail="match not found")
    return match


@app.get("/api/leaderboard")
def leaderboard(limit: int = 20):
    return {"agents": get_agent_leaderboard(limit)}


# ---------------------------------------------------------------------------
# Arena
# ---------------------------------------------------------------------------

from arena_species import Species as ArenaSpecies
from arena_engine import CreatureConfig, simulate_match as arena_simulate
from arena_props import calculate_arena_props, resolve_arena_props, ROUNDS_LINE
from arena_budget import normalize_to_budget, validate_budget, normalize_list


class ArenaCreatureIn(BaseModel):
    species: str
    agent_id: Optional[int] = None
    aggression: int = 50
    risk_tolerance: int = 50
    target_focus: int = 50
    positioning: int = 50
    sacrifice: int = 50
    upgrade: Optional[str] = None
    name: Optional[str] = None


class ArenaSimulateRequest(BaseModel):
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]


def _build_arena_configs(team_in: list[ArenaCreatureIn]) -> list[CreatureConfig]:
    """Turn arena creature inputs into validated CreatureConfigs.

    Saved agents (agent_id set) are re-attuned to the 200 arena budget preserving
    shape; custom builds are anti-cheat validated (every slider 5-80, sum 200).
    Shared by /api/arena/simulate and the server-authoritative bet path, so the
    comp a bet is priced and simulated against is always a legal one.
    """
    valid_species = {s.value for s in ArenaSpecies}
    configs: list[CreatureConfig] = []
    for c in team_in:
        if c.species not in valid_species:
            raise HTTPException(400, f"invalid species: {c.species}")
        agent_name = (c.name or "").strip()
        if c.agent_id:
            # Saved agent (AC sliders are 0-100, unconstrained) -> re-attune to
            # the arena's 200 budget, preserving shape.
            agent = get_agent(c.agent_id)
            if agent:
                agent_name = agent["name"]
                norm = normalize_to_budget({
                    "aggression": agent["aggression"],
                    "risk_tolerance": agent["risk_tolerance"],
                    "target_focus": agent.get("king_priority", 50),
                    "positioning": agent.get("edge_affinity", 50),
                    "sacrifice": agent.get("trade_down", 50),
                })
                c.aggression, c.risk_tolerance = norm["aggression"], norm["risk_tolerance"]
                c.target_focus, c.positioning, c.sacrifice = norm["target_focus"], norm["positioning"], norm["sacrifice"]
        else:
            # Custom build: anti-cheat — must spend exactly 200, every slider 5-80.
            if not validate_budget({
                "aggression": c.aggression, "risk_tolerance": c.risk_tolerance,
                "target_focus": c.target_focus, "positioning": c.positioning, "sacrifice": c.sacrifice,
            }):
                raise HTTPException(400, "each custom Pilot must spend exactly 200 points (every slider 5-80)")
        configs.append(CreatureConfig(
            species=ArenaSpecies(c.species),
            agent_name=agent_name,
            aggression=c.aggression,
            risk_tolerance=c.risk_tolerance,
            target_focus=c.target_focus,
            positioning=c.positioning,
            sacrifice=c.sacrifice,
            upgrade=c.upgrade,
        ))
    return configs


def _arena_price_dict(cfg: CreatureConfig) -> dict:
    """The plain slider dict calculate_arena_props prices from — derived from the
    SAME CreatureConfig that gets simulated, so the priced odds and the simulated
    comp can never diverge."""
    return {
        "species": cfg.species.value,
        "aggression": cfg.aggression,
        "risk_tolerance": cfg.risk_tolerance,
        "target_focus": cfg.target_focus,
        "positioning": cfg.positioning,
        "sacrifice": cfg.sacrifice,
    }


@app.post("/api/arena/simulate")
def arena_simulate_game(req: ArenaSimulateRequest):
    if len(req.red_team) < 1 or len(req.red_team) > 3:
        raise HTTPException(400, "red_team must have 1-3 creatures")
    if len(req.blue_team) < 1 or len(req.blue_team) > 3:
        raise HTTPException(400, "blue_team must have 1-3 creatures")

    red = _build_arena_configs(req.red_team)
    blue = _build_arena_configs(req.blue_team)
    result = arena_simulate(red, blue)
    resp = result.to_dict()

    # Optional AI commentary — no-op (returns []) unless ANTHROPIC_API_KEY is set
    resp["commentary"] = generate_arena_commentary(resp)

    # Persist the Arena result into each deployed Pilot's record (P5/§8): every
    # Arena match now counts toward the thing you own.
    _write_arena_records(resp, req.red_team, req.blue_team)

    return resp


def _write_arena_records(resp: dict, red_in: list, blue_in: list) -> None:
    """Accrue kills/deaths/W-L onto every deployed (agent_id) Pilot from the sim.
    Creature ids follow `{team}_{index}`, matching deploy order."""
    winner = resp.get("winner")
    kills: dict[str, int] = {}
    dead: set[str] = set()
    for e in resp.get("events", []):
        if e.get("type") == "kill":
            killer = (e.get("data") or {}).get("killer")
            if killer:
                kills[killer] = kills.get(killer, 0) + 1
            victim = e.get("creature_id")
            if victim:
                dead.add(victim)
    for team_in, team in ((red_in, "red"), (blue_in, "blue")):
        for i, c in enumerate(team_in):
            if not c.agent_id:
                continue
            cid = f"{team}_{i}"
            outcome = "win" if winner == team else ("loss" if winner in ("red", "blue") else "draw")
            update_arena_record(c.agent_id, outcome, kills.get(cid, 0), 1 if cid in dead else 0)


# --- Arena series (P3, §5.2) ---
# A series runs the same combat one game at a time so lineups can change between
# games (Pilot/upgrade swaps, §5.3). The arena_series row is the server-trusted
# record: it locks each side's Guardian species for the whole series and stores
# the sealed arena_matches id of every game. Free-play series bets are currently
# resolved client-side (like the existing prop book); those sealed per-game ids
# are the basis for SERVER-authoritative settlement when a real-money series
# market ships (gated on the series audit + pot-split, §7.3/§7.4). First to
# ceil(N/2) wins.

SERIES_FORMATS = {"bo1": 1, "bo3": 3, "bo5": 5}


def _series_games_needed(max_games: int) -> int:
    """First to ceil(N/2): bo1->1, bo3->2, bo5->3."""
    return (max_games // 2) + 1


# Serializes the per-series read-modify-write in arena_series_next. Sync FastAPI
# endpoints run concurrently in Starlette's threadpool with separate SQLite
# connections and no DB-level row lock, so two concurrent "play next game" POSTs
# could each pass the `status == active` guard and both simulate a game (lost
# update on the score + a phantom arena_match + inflated Pilot records). This is
# a single-process app, so one in-process lock around the critical section is
# enough; the game_index precondition (checked under the lock) makes a duplicate
# a clean no-op rather than a second game. §5.2/§5.5.
_series_advance_lock = threading.Lock()


class ArenaSeriesStartRequest(BaseModel):
    format: str = "bo3"
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]
    survival: bool = False  # P5 ruleset (opt-in, built in Phase 7); stored, inert here


class ArenaSeriesNextRequest(BaseModel):
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]
    # Idempotency token (§5.5): the number of games the client has already seen,
    # i.e. the game it expects to play next. The server rejects the POST if the
    # series has moved past it — so a double-fired "play next game" (12s
    # auto-advance racing a KEEP click, a retry, or a second tab) can't simulate
    # and persist a phantom game. Optional for back-compat; the UI always sends it.
    game_index: Optional[int] = None


def _validate_team_sizes(red_team: list, blue_team: list) -> None:
    if not (1 <= len(red_team) <= 3):
        raise HTTPException(400, "red_team must have 1-3 Guardians")
    if not (1 <= len(blue_team) <= 3):
        raise HTTPException(400, "blue_team must have 1-3 Guardians")


def _reject_clones(team_in: list) -> None:
    """§5.3: each Pilot flies only one Guardian — no duplicate agent_ids in a lineup."""
    ids = [c.agent_id for c in team_in if c.agent_id]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "each Pilot can fly only one Guardian (no cloning within a lineup)")


def _check_ownership(team_in: list, owner: int | None) -> None:
    """§5.3 hard prerequisite (F1): a player may only fly Pilots they own."""
    if not owner:
        return
    owned = {a["id"] for a in get_agents(owner)}
    for c in team_in:
        if c.agent_id and c.agent_id not in owned:
            raise HTTPException(403, f"Pilot {c.agent_id} is not owned by player {owner}")


def _require_owned_pilots(team_in: list) -> None:
    """Survival (§5.4): every Guardian must be flown by a SAVED Pilot, so benching
    has a durable identity to ground (custom one-off builds have none)."""
    if any(c.agent_id is None for c in team_in):
        raise HTTPException(400, "Survival Series requires every Guardian flown by a saved Pilot")


def _reject_benched(team_in: list, benched: list) -> None:
    """§5.3/§5.4: a benched Pilot is grounded for the rest of the series — it can't
    be re-fielded."""
    bset = set(benched or [])
    for c in team_in:
        if c.agent_id and c.agent_id in bset:
            raise HTTPException(400, f"Pilot {c.agent_id} is benched for the rest of the series")


def _run_arena_series_game(red_cfgs, blue_cfgs, red_in, blue_in):
    """Simulate one series game, seal it as the authoritative record, and accrue
    each deployed Pilot's per-game record. Returns (resp, arena_match_id)."""
    from database import save_arena_match
    result = arena_simulate(red_cfgs, blue_cfgs)
    resp = result.to_dict()
    resp["commentary"] = generate_arena_commentary(resp)
    red_ids = [c.agent_id for c in red_in]
    blue_ids = [c.agent_id for c in blue_in]
    match_id = save_arena_match(resp, red_agent_ids=red_ids, blue_agent_ids=blue_ids)
    _write_arena_records(resp, red_in, blue_in)
    return resp, match_id


def _roster_min(max_games: int) -> int:
    """Survival roster minimum (§5.4): Single 3, Bo3 4, Bo5 5 — field 3 + a buffer."""
    return 3 + (max_games - 1) // 2


def _survival_benched(series: dict, resp: dict, red_in: list) -> list:
    """Loser-only benching (§5.4): if RED LOST this game, ground every red Pilot
    whose Guardian died. Winners keep all Pilots; a drawn game grounds no one.
    (Single-player: only the player's red roster benches; the AI gauntlet does not.)"""
    if not series.get("survival") or resp.get("winner") != "blue":
        return []
    dead = {e.get("creature_id") for e in resp.get("events", [])
            if e.get("type") == "kill" and e.get("creature_id")}
    return [c.agent_id for i, c in enumerate(red_in)
            if c.agent_id and f"red_{i}" in dead]


def _advance_series(series: dict, resp: dict, match_id: int, newly_benched=()) -> dict:
    """Fold a freshly-played game into the series: bump the score, append the
    sealed-game summary, decide completion (first to ceil(N/2), or higher score
    once all games are played — drawn games count for neither side), and — in
    Survival — ground any newly-benched Pilots."""
    pgr = list(series["per_game_results"])
    game_no = len(pgr) + 1
    winner = resp.get("winner")
    red_score = series["red_score"] + (1 if winner == "red" else 0)
    blue_score = series["blue_score"] + (1 if winner == "blue" else 0)
    pgr.append({
        "game": game_no,
        "winner": winner,
        "win_method": resp.get("win_method", ""),
        "total_rounds": resp.get("total_rounds", 0),
        "arena_match_id": match_id,
        "benched": list(newly_benched),  # who this game grounded (for result framing)
    })
    needed, max_games = series["games_needed"], series["max_games"]
    status, swinner = "active", None
    if red_score >= needed:
        status, swinner = "complete", "red"
    elif blue_score >= needed:
        status, swinner = "complete", "blue"
    elif len(pgr) >= max_games:
        status = "complete"
        swinner = "red" if red_score > blue_score else ("blue" if blue_score > red_score else None)
    benched = sorted(set(series.get("benched", [])) | set(newly_benched))
    update_series(series["series_id"], red_score, blue_score, pgr, status, swinner,
                  benched=benched if series.get("survival") else None)
    return get_series(series["series_id"])


def _series_state(series: dict, latest_game: dict | None = None) -> dict:
    played = len(series["per_game_results"])
    out = {
        "series_id": series["series_id"],
        "format": series["format"],
        "games_needed": series["games_needed"],
        "max_games": series["max_games"],
        "red_score": series["red_score"],
        "blue_score": series["blue_score"],
        "game_index": played,
        "next_game": (played + 1) if series["status"] == "active" else None,
        "status": series["status"],
        "series_winner": series["winner"],
        "locked_species": {"red": series["red_species"], "blue": series["blue_species"]},
        "per_game_results": series["per_game_results"],
        "survival": series["survival"],
        "benched": series.get("benched", []),
        "roster_min": _roster_min(series["max_games"]),
    }
    # In Survival, surface whether the player still has 3 un-benched owned Pilots to
    # field the next game (else the series is forfeit — §5.4 attrition).
    if series["survival"] and series["status"] == "active":
        owned = {a["id"] for a in get_agents(series["red_owner"] or 1)}
        out["red_available"] = len(owned - set(series.get("benched", [])))
        out["red_can_field"] = out["red_available"] >= 3
    if latest_game is not None:
        out["game"] = latest_game
    return out


@app.post("/api/arena/series/start")
def arena_series_start(req: ArenaSeriesStartRequest):
    fmt = req.format.lower()
    if fmt not in SERIES_FORMATS:
        raise HTTPException(400, "format must be bo1, bo3, or bo5")
    _validate_team_sizes(req.red_team, req.blue_team)
    _reject_clones(req.red_team)
    _reject_clones(req.blue_team)
    _check_ownership(req.red_team, 1)  # single-player: red is owned by player 1
    max_games = SERIES_FORMATS[fmt]
    if req.survival:
        # Survival fields a full 3-Guardian lineup of owned Pilots and needs a bench
        # (§5.4): field 3, own >= roster_min. (The 3/4/5 roster math assumes 3 fielded.)
        if len(req.red_team) != 3:
            raise HTTPException(400, "Survival Series requires a full lineup of 3 Guardians")
        _require_owned_pilots(req.red_team)
        roster = len(get_agents(1))
        if roster < _roster_min(max_games):
            raise HTTPException(
                400, f"Survival {fmt.upper()} needs a roster of at least "
                     f"{_roster_min(max_games)} owned Pilots (you have {roster})")
    red_cfgs = _build_arena_configs(req.red_team)
    blue_cfgs = _build_arena_configs(req.blue_team)
    series = create_series(
        fmt, _series_games_needed(max_games), max_games,
        red_species=sorted(c.species.value for c in red_cfgs),
        blue_species=sorted(c.species.value for c in blue_cfgs),
        red_owner=1, blue_owner=None, survival=bool(req.survival),
    )
    resp, match_id = _run_arena_series_game(red_cfgs, blue_cfgs, req.red_team, req.blue_team)
    newly = _survival_benched(series, resp, req.red_team)
    return _series_state(_advance_series(series, resp, match_id, newly), latest_game=resp)


@app.post("/api/arena/series/{series_id}/next")
def arena_series_next(series_id: int, req: ArenaSeriesNextRequest):
    series = get_series(series_id)
    if not series:
        raise HTTPException(404, "series not found")
    if series["status"] != "active":
        raise HTTPException(400, "series is already complete")
    _validate_team_sizes(req.red_team, req.blue_team)
    _reject_clones(req.red_team)
    _reject_clones(req.blue_team)
    _check_ownership(req.red_team, series["red_owner"])
    red_cfgs = _build_arena_configs(req.red_team)
    blue_cfgs = _build_arena_configs(req.blue_team)
    # Guardian species are locked for the whole series (§5.2) — Pilots/upgrades swap, bodies don't.
    # (red_owner / red_species / blue_species are immutable after create_series, so these
    # request validations are safe to run before taking the advance lock.)
    if sorted(c.species.value for c in red_cfgs) != series["red_species"]:
        raise HTTPException(400, "red Guardian species are locked for the series")
    if sorted(c.species.value for c in blue_cfgs) != series["blue_species"]:
        raise HTTPException(400, "blue Guardian species are locked for the series")
    # Critical section: re-read the series under the lock and only advance if it is
    # still where this request expects it to be. Serializing get_series..update_series
    # turns a double-fired advance (12s auto-advance racing a KEEP click / a retry /
    # a second tab) into ONE game + a 409, instead of two games, a lost score update,
    # and a phantom arena_match + inflated Pilot records. §5.5.
    with _series_advance_lock:
        series = get_series(series_id)
        if not series or series["status"] != "active":
            raise HTTPException(409, "series already advanced")
        played = len(series["per_game_results"])
        if req.game_index is not None and req.game_index != played:
            raise HTTPException(
                409,
                f"stale advance: series is at game {played}, request expected {req.game_index}",
            )
        if series["survival"]:
            # Owned Pilots only, and no benched Pilot may be re-fielded (§5.4).
            _require_owned_pilots(req.red_team)
            _reject_benched(req.red_team, series["benched"])
        resp, match_id = _run_arena_series_game(red_cfgs, blue_cfgs, req.red_team, req.blue_team)
        newly = _survival_benched(series, resp, req.red_team)
        return _series_state(_advance_series(series, resp, match_id, newly), latest_game=resp)


@app.post("/api/arena/series/{series_id}/forfeit")
def arena_series_forfeit(series_id: int):
    """Concede a Survival series when the roster is depleted (§5.4 attrition): the
    player can no longer field 3 un-benched Pilots, so blue takes the series. Guarded
    so it can ONLY be called from a genuinely depleted state (no bet-blue-then-forfeit
    exploit) and serialized with the advance lock."""
    with _series_advance_lock:
        series = get_series(series_id)
        if not series:
            raise HTTPException(404, "series not found")
        if series["status"] != "active":
            raise HTTPException(400, "series is already complete")
        if not series["survival"]:
            raise HTTPException(400, "only Survival Series can be forfeited")
        owned = {a["id"] for a in get_agents(series["red_owner"] or 1)}
        if len(owned - set(series["benched"])) >= 3:
            raise HTTPException(400, "roster is not depleted — field your remaining Pilots")
        update_series(series["series_id"], series["red_score"], series["blue_score"],
                      series["per_game_results"], "complete", "blue", benched=series["benched"])
        return _series_state(get_series(series["series_id"]))


@app.get("/api/arena/series/{series_id}")
def arena_series_get(series_id: int):
    series = get_series(series_id)
    if not series:
        raise HTTPException(404, "series not found")
    return _series_state(series)


class ArenaSeriesPriceRequest(BaseModel):
    format: str = "bo3"
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]
    red_score: int = 0
    blue_score: int = 0
    games_played: int = 0


# Live (between-games / pre-series) pricing depth. The standing series audit
# (scripts/arena_series_audit.py) holds +5% with pricing this coarse, so it is
# fast enough for a click without sacrificing calibration. §7.3.
SERIES_PRICE_SIMS = 700


@app.post("/api/arena/series/price")
def arena_series_price(req: ArenaSeriesPriceRequest):
    """Server-authoritative conditional odds for every series market, from the
    lineup-conditional Monte-Carlo (§7.3). This is the ONLY priced source for
    series markets — the static prop tables can't see game-to-game correlation.
    Free-play only until the series audit ships real-money (§7.3/§7.4)."""
    fmt = req.format.lower()
    if fmt not in SERIES_FORMATS:
        raise HTTPException(400, "format must be bo1, bo3, or bo5")
    _validate_team_sizes(req.red_team, req.blue_team)
    red_cfgs = _build_arena_configs(req.red_team)
    blue_cfgs = _build_arena_configs(req.blue_team)
    max_games = SERIES_FORMATS[fmt]
    needed = _series_games_needed(max_games)
    rs, bs, gp = max(0, req.red_score), max(0, req.blue_score), max(0, req.games_played)
    # Reject self-inconsistent / already-decided states: there must be at least one
    # game left to price, and a side can't have more wins than games played. Without
    # this, the Monte-Carlo plays zero games (next_played==0) and emits degenerate
    # near-infinite odds. (Pre-series 0/0/0 passes; needed>=1, max_games>=1.)
    if rs >= needed or bs >= needed or gp >= max_games or rs + bs > gp:
        raise HTTPException(400, "inconsistent series state for pricing")
    from arena_series_pricer import price_series, price_to_odds
    priced = price_series(
        red_cfgs, blue_cfgs,
        red_score=rs, blue_score=bs, games_played=gp,
        games_needed=needed, max_games=max_games, n_sims=SERIES_PRICE_SIMS,
    )
    return {
        "format": fmt, "games_needed": needed, "max_games": max_games,
        "probabilities": priced["markets"],
        "odds": price_to_odds(priced),
        "free_play_only": True,  # §7.4 real-money series is multiplayer pot-split only
    }


@app.get("/api/arena/species")
def arena_species_list():
    from arena_species import SPECIES_STATS, SPECIES_UPGRADES, SPECIES_COLORS, SPECIES_ICONS
    species = []
    for s in ArenaSpecies:
        stats = SPECIES_STATS[s]
        upgrades = SPECIES_UPGRADES[s]
        species.append({
            "id": s.value,
            "name": s.value.capitalize(),
            "icon": SPECIES_ICONS[s],
            "color": SPECIES_COLORS[s],
            "hp": stats.hp,
            "atk": stats.atk,
            "def": stats.def_,
            "spd": stats.spd,
            "upgrades": [{"level": u.level, "name": u.name, "key": u.key,
                          "description": u.description} for u in upgrades],
        })
    return {"species": species}


# --- Arena betting ---

class ArenaPropRequest(BaseModel):
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]


class ArenaBetRequest(BaseModel):
    prop_type: str
    selection: str
    amount: int = Field(ge=10)


class ArenaBetPlaceRequest(BaseModel):
    """Place an arena prop bet. The full comp is required so the server can
    recompute the odds (never trusting a client-supplied number) and simulate +
    seal the match this bet will later be settled against."""
    red_team: list[ArenaCreatureIn]
    blue_team: list[ArenaCreatureIn]
    prop_type: str
    selection: str
    amount: int = Field(ge=10)
    species: Optional[str] = None   # disambiguates which species_survivor prop


class ArenaBetResolveRequest(BaseModel):
    bet_id: int


@app.post("/api/arena/props")
def arena_get_props(req: ArenaPropRequest):
    """Calculate arena prop bet odds from team compositions. Configs are
    normalized to the 250 budget first, so the odds match what will actually be
    simulated (agent-derived builds get re-attuned; legal customs are a no-op)."""
    def cfg(c) -> dict:
        if c.agent_id:
            a = get_agent(c.agent_id)
            if a:
                sl = {"aggression": a["aggression"], "risk_tolerance": a["risk_tolerance"],
                      "target_focus": a.get("king_priority", 50), "positioning": a.get("edge_affinity", 50),
                      "sacrifice": a.get("trade_down", 50)}
            else:
                sl = {"aggression": c.aggression, "risk_tolerance": c.risk_tolerance,
                      "target_focus": c.target_focus, "positioning": c.positioning, "sacrifice": c.sacrifice}
        else:
            sl = {"aggression": c.aggression, "risk_tolerance": c.risk_tolerance,
                  "target_focus": c.target_focus, "positioning": c.positioning, "sacrifice": c.sacrifice}
        return {"species": c.species, **normalize_to_budget(sl)}

    red_configs = [cfg(c) for c in req.red_team]
    blue_configs = [cfg(c) for c in req.blue_team]
    props = calculate_arena_props(red_configs, blue_configs)
    return {"props": props}


@app.post("/api/arena/bet")
def arena_place_bet(req: ArenaBetRequest):
    """DEPRECATED — superseded by /api/arena/bet/place. Stores odds=0 with no
    linked match, so bets placed here are not resolvable by the hardened
    /api/arena/bet/resolve. Kept only for backward compatibility; do not use for
    new clients (see docs/GUARDIANS-AND-ENGINES-SPEC.md §7.1 F2)."""
    from database import get_db, MIN_BET
    if req.amount < MIN_BET:
        raise HTTPException(400, f"minimum bet is {MIN_BET}")
    # look up odds: we need to validate the prop_type and selection exist
    # (the caller should have fetched /api/arena/props first to get valid odds)
    conn = get_db()
    w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    bal = w["balance"] if w else 1000
    if req.amount > bal:
        conn.close()
        raise HTTPException(400, "insufficient balance")
    # For arena bets, we accept the odds from the stored prop types
    # The frontend sends the prop_type and selection; we calculate odds server-side
    # to prevent manipulation. Use a default since we don't have team context here.
    # In practice, the frontend calls /api/arena/props first and shows the odds,
    # then we re-derive or trust the stored odds. For simplicity, store the bet
    # and let resolve compute the payout from the odds at bet time.
    # We'll accept an odds field or default.
    conn.execute("UPDATE wallet SET balance = balance - ? WHERE id = 1", (req.amount,))
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    # Store with odds=0 initially; the caller should include odds from the props response
    # We'll set a placeholder; the resolve endpoint uses the stored odds for payout
    cursor = conn.execute(
        "INSERT INTO arena_bets (created_at, prop_type, selection, amount, odds) VALUES (?,?,?,?,?)",
        (now, req.prop_type, req.selection, req.amount, 0.0),
    )
    conn.commit()
    bet_id = cursor.lastrowid
    new_bal = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()["balance"]
    conn.close()
    add_to_jackpot(req.amount)
    return {"bet_id": bet_id, "prop_type": req.prop_type, "selection": req.selection,
            "amount": req.amount, "balance": new_bal}


@app.post("/api/arena/bet/place")
def arena_place_bet_with_odds(req: ArenaBetPlaceRequest):
    """Place an arena prop bet — server-authoritative.

    The client sends the comp plus which prop/selection it wants and how much. The
    server then (a) recomputes the odds for that comp with `calculate_arena_props`
    — a client-supplied odds number is ignored entirely — (b) simulates the match
    and SEALS it as the record this bet resolves against, and (c) deducts the stake
    and stores the bet keyed to that sealed match. Returns the bet, the SERVER
    odds, and the sealed match for playback. (Mirrors the main book at
    `arena_get_props` / main.py prop pricing; see docs/GUARDIANS-AND-ENGINES-SPEC
    §7.1 F2.)
    """
    from database import get_db, MIN_BET, save_arena_match
    from datetime import datetime, timezone

    if len(req.red_team) < 1 or len(req.red_team) > 3:
        raise HTTPException(400, "red_team must have 1-3 creatures")
    if len(req.blue_team) < 1 or len(req.blue_team) > 3:
        raise HTTPException(400, "blue_team must have 1-3 creatures")
    if not req.prop_type or not req.selection:
        raise HTTPException(400, "prop_type and selection required")
    if req.amount < MIN_BET:
        raise HTTPException(400, f"minimum bet is {MIN_BET}")

    # Build configs once, then price AND simulate the SAME comp so the odds the
    # bet is booked at always match the match it is settled against.
    red_cfgs = _build_arena_configs(req.red_team)
    blue_cfgs = _build_arena_configs(req.blue_team)
    red_dicts = [_arena_price_dict(c) for c in red_cfgs]
    blue_dicts = [_arena_price_dict(c) for c in blue_cfgs]

    # Recompute odds server-side and locate the requested selection.
    props = calculate_arena_props(red_dicts, blue_dicts)
    want_species = (req.species or "").lower()
    prop_def, opt = None, None
    for p in props:
        if p["type"] != req.prop_type:
            continue
        if req.prop_type == "species_survivor" and p.get("species", "").lower() != want_species:
            continue
        opt = next((o for o in p.get("options", []) if o["selection"] == req.selection), None)
        if opt:
            prop_def = p
            break
    if not prop_def or not opt:
        raise HTTPException(400, "no such prop_type/selection for this comp")
    server_odds = opt["odds"]
    bet_species = prop_def.get("species")   # set only for species_survivor
    bet_line = prop_def.get("line")         # set only for total_rounds_ou

    conn = get_db()
    w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    bal = w["balance"] if w else 1000
    conn.close()
    if req.amount > bal:
        raise HTTPException(400, "insufficient balance")

    # Seal the outcome: the selection is already fixed (it is in this request), so
    # simulating now means the user cannot bet after seeing the result.
    result = arena_simulate(red_cfgs, blue_cfgs)
    match_dict = result.to_dict()
    red_agent_ids = [c.agent_id for c in req.red_team]
    blue_agent_ids = [c.agent_id for c in req.blue_team]
    arena_match_id = save_arena_match(match_dict, red_agent_ids, blue_agent_ids)

    conn = get_db()
    conn.execute("UPDATE wallet SET balance = balance - ? WHERE id = 1", (req.amount,))
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """INSERT INTO arena_bets
           (created_at, prop_type, selection, amount, odds, arena_match_id, species, line)
           VALUES (?,?,?,?,?,?,?,?)""",
        (now, req.prop_type, req.selection, req.amount, server_odds,
         arena_match_id, bet_species, bet_line),
    )
    conn.commit()
    bet_id = cursor.lastrowid
    new_bal = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()["balance"]
    conn.close()
    add_to_jackpot(req.amount)

    match_dict["commentary"] = generate_arena_commentary(match_dict)
    return {"bet_id": bet_id, "prop_type": req.prop_type, "selection": req.selection,
            "amount": req.amount, "odds": server_odds, "species": bet_species,
            "arena_match_id": arena_match_id, "balance": new_bal,
            "match_result": match_dict}


@app.post("/api/arena/bet/resolve")
def arena_resolve_bet(req: ArenaBetResolveRequest):
    """Resolve an arena bet against its SEALED server-side match record.

    The client supplies only the bet id; the outcome is read from the
    arena_matches row the bet was keyed to at placement — never from the request —
    so a bettor can neither price nor adjudicate their own bet. The cosmetic
    win-streak is never moved by an arena settlement (docs/ECONOMY_AUDIT.md;
    docs/GUARDIANS-AND-ENGINES-SPEC.md §7.1 F2).
    """
    from database import get_db, get_arena_match
    bet_id = req.bet_id
    if not bet_id:
        raise HTTPException(400, "bet_id required")

    conn = get_db()
    bet_row = conn.execute("SELECT * FROM arena_bets WHERE id = ?", (bet_id,)).fetchone()
    if not bet_row:
        conn.close()
        raise HTTPException(404, "bet not found")
    if bet_row["resolved"]:
        conn.close()
        raise HTTPException(400, "bet already resolved")
    arena_match_id = bet_row["arena_match_id"]
    conn.close()

    if not arena_match_id:
        raise HTTPException(400, "bet is not linked to a sealed match; cannot resolve")
    match_result = get_arena_match(arena_match_id)
    if not match_result:
        raise HTTPException(500, "sealed match record missing")

    # Resolve from the bet's own server-derived fields + the sealed match. `line`
    # and `species` come from the stored bet, not the request.
    prop_input = {
        "type": bet_row["prop_type"],
        "selection": bet_row["selection"],
        "amount": bet_row["amount"],
        "odds": bet_row["odds"],
        "line": bet_row["line"] if bet_row["line"] is not None else ROUNDS_LINE,
        "species": bet_row["species"],
    }
    resolved = resolve_arena_props([prop_input], match_result)
    if not resolved:
        raise HTTPException(500, "could not resolve bet")
    result = resolved[0]
    outcome = result["result"]            # "win" | "loss" | "push"
    payout = result.get("payout", 0)
    won = outcome == "win"

    conn = get_db()
    # Atomically CLAIM the bet: only the call that flips resolved 0->1 proceeds to
    # pay out. The wallet delta below runs in the same transaction as the claim, so
    # two concurrent /resolve calls for one bet can never both pay (no double-pay).
    claim = conn.execute(
        "UPDATE arena_bets SET resolved = 1, won = ?, payout = ? WHERE id = ? AND resolved = 0",
        (1 if won else 0, payout, bet_id),
    )
    if claim.rowcount != 1:
        conn.rollback()
        conn.close()
        raise HTTPException(400, "bet already resolved")
    # Wallet accounting — same rules as settle_bet's prop path: a push refunds the
    # stake (neither win nor loss); a loss is recorded; the win-streak is untouched.
    if outcome == "win":
        conn.execute("UPDATE wallet SET balance = balance + ?, total_won = total_won + ?, total_bets = total_bets + 1 WHERE id = 1",
                     (payout, payout))
        bw = conn.execute("SELECT biggest_win FROM wallet WHERE id = 1").fetchone()
        if payout > bw["biggest_win"]:
            conn.execute("UPDATE wallet SET biggest_win = ? WHERE id = 1", (payout,))
    elif outcome == "push":
        if payout > 0:
            conn.execute("UPDATE wallet SET balance = balance + ? WHERE id = 1", (payout,))
    else:  # loss — stake already deducted at placement; record it
        conn.execute("UPDATE wallet SET total_lost = total_lost + ?, total_bets = total_bets + 1 WHERE id = 1",
                     (bet_row["amount"],))
    conn.commit()
    final_w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    conn.close()

    return {
        "bet_id": bet_id,
        "prop_type": bet_row["prop_type"],
        "selection": bet_row["selection"],
        "amount": bet_row["amount"],
        "odds": bet_row["odds"],
        "result": outcome,
        "actual": result.get("actual"),
        "payout": payout,
        "won": won,
        "balance": final_w["balance"],
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.6.0"}


# --- serve React build in production ---

_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/assets", StaticFiles(directory=_static_dir / "assets"), name="assets")

    @app.get("/{path:path}")
    async def serve_spa(path: str):
        file_path = _static_dir / path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_static_dir / "index.html")
