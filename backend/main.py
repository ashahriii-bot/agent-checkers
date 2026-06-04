"""FastAPI server for Agent Checkers: matches, tournaments, elo, phase-aware AI."""

import json
import random
import re
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
from ai import AgentConfig, pick_move, detect_phase, calc_overextension_factor, suggest_names, apply_perk_overrides
from auth import hash_password, verify_password, create_token, get_current_player_id, get_optional_player_id
from coaches import COACHES, generate_bot_agent, get_coach_list
from ws import router as ws_router
from matchmaking import online
from database import (
    save_match, get_matches, get_match, get_leaderboard, get_agent_leaderboard,
    get_elo, update_elo, update_elo_record,
    create_agent, get_agents, get_agent, update_agent, delete_agent, update_agent_after_match,
    save_tournament, get_tournaments, get_tournament,
    set_agent_perk, VALID_PERKS,
    get_wallet, place_bet, settle_bet, get_bet_history,
    calculate_match_odds, calculate_tournament_odds,
    create_player, get_player, get_player_by_username, update_player_coins,
    get_jackpot, add_to_jackpot, hit_jackpot,
    increment_streak, reset_streak, get_streak_multiplier,
    save_parlay, calc_parlay_payout,
)

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


class ChampionBetSchema(BaseModel):
    agent_id: int
    amount: int = Field(ge=10)


class VsBotSchema(BaseModel):
    coach_id: str


class SimulateRequest(BaseModel):
    red: Optional[AgentConfigSchema] = None
    black: Optional[AgentConfigSchema] = None
    red_agent_id: Optional[int] = None
    black_agent_id: Optional[int] = None
    bet: Optional[BetSchema] = None
    vs_bot: Optional[VsBotSchema] = None


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


# --- core game simulation (shared by single match and tournament) ---

def _init_perk_state(perk: str | None) -> dict | None:
    if not perk:
        return None
    return {"perk": perk, "active_moves": 0}


def _run_game(red_cfg: AgentConfig, black_cfg: AgentConfig,
              red_perk: str | None = None, black_perk: str | None = None) -> dict:
    board = init_board()
    turn = "black"
    moves = []
    boards = [board_to_list(board)]
    events = []
    move_count = 0
    winner = None
    king_idle = {}
    current_phase = "opening"
    events.append({"type": "phase_change", "move": 0, "phase": "opening"})

    red_overext = calc_overextension_factor(red_cfg.aggression, red_cfg.risk_tolerance)
    black_overext = calc_overextension_factor(black_cfg.aggression, black_cfg.risk_tolerance)
    pending_overext = None

    # perk state
    perk_state = {"red": _init_perk_state(red_perk), "black": _init_perk_state(black_perk)}
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

        # apply perk overrides for the current player
        base_cfg = red_cfg if turn == "red" else black_cfg
        effective_cfg = apply_perk_overrides(base_cfg, perk_state[turn])
        move = pick_move(board, turn, effective_cfg, phase=current_phase)
        if move is None:
            winner = "red" if turn == "black" else "black"; break

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
    return {
        "winner": winner, "move_count": move_count,
        "moves": moves, "boards": boards, "events": events,
        "final_red": counts["red"], "final_black": counts["black"],
    }


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
    agent = create_agent(req.name, req.aggression, req.risk_tolerance,
                         req.king_priority, req.edge_affinity, req.trade_down)
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
    agent = update_agent(agent_id, name=req.name, aggression=req.aggression,
                         risk_tolerance=req.risk_tolerance, king_priority=req.king_priority,
                         edge_affinity=req.edge_affinity, trade_down=req.trade_down)
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


@app.get("/api/bets/history")
def api_bet_history(limit: int = 20):
    return {"bets": get_bet_history(limit)}


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


@app.post("/api/game/simulate")
def simulate_game(req: SimulateRequest):
    bot_opponent = None

    if req.vs_bot:
        coach_id = req.vs_bot.coach_id
        if coach_id == "random":
            coach_id = random.choice(list(COACHES.keys()))
        coach = COACHES.get(coach_id)
        if not coach:
            raise HTTPException(400, f"unknown coach: {coach_id}")
        red_cfg, red_agent = _resolve_side(req.red_agent_id, req.red, "red")
        red_elo_before = red_agent["elo"] if red_agent else get_elo(red_cfg.config_key())
        player_config = red_agent if red_agent else red_cfg.to_dict()
        bot = generate_bot_agent(coach, red_elo_before, player_config=player_config)
        black_cfg = AgentConfig(aggression=bot["aggression"], risk_tolerance=bot["risk_tolerance"],
                                king_priority=bot["king_priority"], edge_affinity=bot["edge_affinity"],
                                trade_down=bot["trade_down"])
        black_agent = None
        black_elo_before = bot["elo"]
        black_perk = bot["perk"]
        red_perk = red_agent["perk"] if red_agent else None
        bot_opponent = {
            "name": bot["name"], "coach_id": bot["coach_id"], "coach_name": bot["coach_name"],
            "aggression": bot["aggression"], "risk_tolerance": bot["risk_tolerance"],
            "king_priority": bot["king_priority"], "edge_affinity": bot["edge_affinity"],
            "trade_down": bot["trade_down"], "elo": bot["elo"], "perk": bot["perk"],
        }
    else:
        red_cfg, red_agent = _resolve_side(req.red_agent_id, req.red, "red")
        black_cfg, black_agent = _resolve_side(req.black_agent_id, req.black, "black")
        red_elo_before = red_agent["elo"] if red_agent else get_elo(red_cfg.config_key())
        black_elo_before = black_agent["elo"] if black_agent else get_elo(black_cfg.config_key())
        red_perk = red_agent["perk"] if red_agent else None
        black_perk = black_agent["perk"] if black_agent else None

    game = _run_game(red_cfg, black_cfg, red_perk=red_perk, black_perk=black_perk)

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
        # streak multiplier
        w = get_wallet()
        streak_mult = get_streak_multiplier(w["win_streak"])
        effective_odds = round(side_odds * streak_mult, 2)
        payout = int(req.bet.amount * effective_odds) if won else 0
        settle_result = settle_bet(bet_info["bet_id"], "win" if won else "loss", payout)
        # jackpot contribution
        jp_add = add_to_jackpot(req.bet.amount)
        # streak update
        if won:
            streak_info = increment_streak()
        else:
            streak_info = reset_streak()
        bet_result = {
            "bet_id": bet_info["bet_id"], "side": req.bet.side,
            "amount": req.bet.amount, "odds": side_odds, "streak_mult": streak_mult,
            "effective_odds": effective_odds,
            "result": "win" if won else "loss",
            "payout": payout, "net": payout - req.bet.amount if won else -req.bet.amount,
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
    if level_ups:
        resp["level_ups"] = level_ups
    resp["bet"] = bet_result
    if bot_opponent:
        resp["bot_opponent"] = bot_opponent
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
    if req.vs_bot:
        coach_id = req.vs_bot.coach_id
        if coach_id == "random":
            coach_id = random.choice(list(COACHES.keys()))
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

    if bot_coach:
        player_wins = sum(1 for m in all_match_data if not bracket_agents[m["winner_slot"]].get("is_bot"))
        bot_wins = sum(1 for m in all_match_data if bracket_agents[m["winner_slot"]].get("is_bot"))
        resp["teams"] = {
            "player": {"wins": player_wins},
            "bot": {"coach_id": bot_coach.id, "coach_name": bot_coach.name, "wins": bot_wins},
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


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.5.0"}


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
