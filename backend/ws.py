"""WebSocket endpoint for multiplayer matchmaking and match delivery."""

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auth import decode_token
from ai import AgentConfig
from database import (
    get_agent, update_agent_after_match, update_elo, save_match,
    calculate_match_odds, get_player, update_player_coins,
    get_player_usdc, adjust_player_usdc, record_crypto_tx,
    process_agent_evolution, update_familiarity, get_familiarity_score, decay_familiarity,
)
from familiarity import categorize_opponent
from matchmaking import queue, online, QueueEntry, arena_queue, ArenaQueueEntry
from crypto import crypto_service, micros_to_usdc

import logging
import sys

# Dedicated stdout logger so multiplayer steps + tracebacks are always visible in
# uvicorn/Railway logs (independent of whatever root logging config is active).
log = logging.getLogger("ac.ws")
if not log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(asctime)s [ws] %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

REAL_MIN_MICROS = 10_000        # $0.01
REAL_MAX_MICROS = 10_000_000    # $10.00
REAL_HOUSE_FEE_BPS = 500        # 5%
REAL_MIN_LEVEL = 3
REAL_MIN_MATCHES = 10

router = APIRouter()

# import _run_game lazily to avoid circular imports
_run_game_fn = None


def _get_run_game():
    global _run_game_fn
    if _run_game_fn is None:
        from main import _run_game
        _run_game_fn = _run_game
    return _run_game_fn


# --- background matchmaker ---------------------------------------------------
# queue.add() matches on join, but two players who are OUT of elo band at join
# never re-evaluate as their bands widen with wait time. This loop periodically
# re-scans the whole queue so widening actually takes effect, and times players
# out after MATCH_TIMEOUT_SECONDS with a "no opponents" message.
_matchmaker_task = None


def _ensure_matchmaker():
    global _matchmaker_task
    if _matchmaker_task is None:
        _matchmaker_task = asyncio.create_task(_matchmaker_loop())


async def _matchmaker_loop():
    log.info("matchmaker loop started (checkers + arena)")
    while True:
        await asyncio.sleep(3)
        try:
            # --- Checkers queue ---
            while True:
                pair = await queue.pop_ready_match()
                if not pair:
                    break
                red_entry, black_entry = pair
                log.info("matcher: pairing player %s (elo %s) vs player %s (elo %s)",
                         red_entry.player_id, red_entry.agent_elo, black_entry.player_id, black_entry.agent_elo)
                online.set_status(red_entry.player_id, "in_match")
                online.set_status(black_entry.player_id, "in_match")
                asyncio.create_task(_run_multiplayer_match(red_entry, black_entry))
            for e in await queue.pop_timed_out():
                online.set_status(e.player_id, "idle")
                log.info("matcher: timing out player %s (no opponent)", e.player_id)
                try:
                    await e.websocket.send_json({
                        "type": "queue_timeout",
                        "message": "No opponents found. Try again later.",
                    })
                except Exception:
                    log.exception("matcher: failed to send queue_timeout to %s", e.player_id)

            # --- Arena queue ---
            while True:
                pair = await arena_queue.pop_ready_match()
                if not pair:
                    break
                red_entry, blue_entry = pair
                log.info("arena matcher: pairing player %s vs player %s",
                         red_entry.player_id, blue_entry.player_id)
                online.set_status(red_entry.player_id, "in_match")
                online.set_status(blue_entry.player_id, "in_match")
                asyncio.create_task(_run_arena_match(red_entry, blue_entry))
            for e in await arena_queue.pop_timed_out():
                online.set_status(e.player_id, "idle")
                log.info("arena matcher: timing out player %s", e.player_id)
                try:
                    await e.websocket.send_json({
                        "type": "arena_queue_timeout",
                        "message": "No arena opponents found. Try again later.",
                    })
                except Exception:
                    log.exception("arena matcher: failed to send timeout to %s", e.player_id)

        except Exception:
            log.exception("matchmaker loop iteration failed")


@router.websocket("/ws/play")
async def ws_play(ws: WebSocket):
    await ws.accept()
    _ensure_matchmaker()
    token = ws.query_params.get("token", "")
    try:
        payload = decode_token(token)
    except Exception:
        await ws.send_json({"type": "error", "message": "invalid token"})
        await ws.close()
        return

    player_id = payload["player_id"]
    player = get_player(player_id)
    if not player:
        await ws.send_json({"type": "error", "message": "player not found"})
        await ws.close()
        return

    display_name = player["display_name"]
    online.connect(player_id, display_name, ws)
    log.info("connect: player %s (%s); online=%d", player_id, display_name, online.count)

    try:
        await ws.send_json({"type": "connected", "player_id": player_id, "display_name": display_name})

        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                msg_type = msg.get("type")
                log.info("recv: player %s msg=%s", player_id, msg_type)

                if msg_type == "queue_join":
                    await _handle_queue_join(ws, player_id, display_name, msg)

                elif msg_type == "queue_cancel":
                    await queue.remove(player_id)
                    online.set_status(player_id, "idle")
                    await ws.send_json({"type": "queue_cancelled"})

                elif msg_type == "arena_queue_join":
                    await _handle_arena_queue_join(ws, player_id, display_name, msg)

                elif msg_type == "arena_queue_cancel":
                    await arena_queue.remove(player_id)
                    online.set_status(player_id, "idle")
                    await ws.send_json({"type": "arena_queue_cancelled"})

                elif msg_type == "ping":
                    await ws.send_json({"type": "pong"})

            except WebSocketDisconnect:
                raise
            except Exception:
                # A single bad message must NOT tear down the socket (that was the
                # "both go offline" bug). Log the full traceback, notify, keep going.
                log.exception("handler error: player %s raw=%r", player_id, raw[:200])
                try:
                    await ws.send_json({"type": "error", "message": "internal error — please try again"})
                except Exception:
                    pass

    except WebSocketDisconnect:
        log.info("disconnect: player %s", player_id)
    except Exception:
        log.exception("connection loop crashed: player %s", player_id)
    finally:
        await queue.remove_by_ws(ws)
        await arena_queue.remove_by_ws(ws)
        online.disconnect(player_id)
        log.info("cleanup: player %s; online=%d", player_id, online.count)


async def _handle_queue_join(ws: WebSocket, player_id: int, display_name: str, msg: dict):
    agent_id = msg.get("agent_id")
    bet_amount = msg.get("bet_amount", 0)
    mode = msg.get("mode", "free")
    log.info("queue_join: player %s agent_id=%s mode=%s bet=%s", player_id, agent_id, mode, bet_amount)

    agent = get_agent(agent_id)
    if not agent:
        log.info("queue_join: agent %s not found for player %s", agent_id, player_id)
        await ws.send_json({"type": "error", "message": "agent not found"})
        return
    if agent.get("player_id") and agent["player_id"] != player_id:
        await ws.send_json({"type": "error", "message": "not your agent"})
        return

    # Free play has NO eligibility gate — brand-new starter agents can queue. The
    # level/matches requirement applies ONLY to real-money (USDC) play.
    bet_micros = 0
    if mode == "real":
        log.info("queue_join: real-money path player %s (agent level=%s matches=%s)", player_id, agent.get("level"), agent.get("matches"))
        if not crypto_service.available:
            await ws.send_json({"type": "error", "message": "real play is not available"})
            return
        # eligibility: prevents throwaway agents from entering real-money matches
        if (agent.get("level", 1) < REAL_MIN_LEVEL) or (agent.get("matches", 0) < REAL_MIN_MATCHES):
            await ws.send_json({"type": "error", "message": f"real play requires a level {REAL_MIN_LEVEL}+ agent with {REAL_MIN_MATCHES}+ matches"})
            return
        bet_micros = int(round(float(bet_amount) * 1_000_000))
        if bet_micros < REAL_MIN_MICROS or bet_micros > REAL_MAX_MICROS:
            await ws.send_json({"type": "error", "message": "bet outside allowed range ($0.01-$10.00)"})
            return
        if get_player_usdc(player_id) < bet_micros:
            await ws.send_json({"type": "error", "message": "insufficient USDC balance"})
            return

    entry = QueueEntry(
        player_id=player_id, agent_id=agent_id, agent_elo=agent["elo"],
        bet_amount=bet_amount, joined_at=time.time(), websocket=ws,
        agent_name=agent["name"], display_name=display_name,
        mode=mode, bet_micros=bet_micros,
    )

    online.set_status(player_id, "in_queue")
    await ws.send_json({"type": "queue_joined", "agent_name": agent["name"]})

    match_pair = await queue.add(entry)

    if match_pair:
        red_entry, black_entry = match_pair
        log.info("queue_join: INSTANT match player %s vs player %s", red_entry.player_id, black_entry.player_id)
        online.set_status(red_entry.player_id, "in_match")
        online.set_status(black_entry.player_id, "in_match")
        await _run_multiplayer_match(red_entry, black_entry)
    else:
        log.info("queue_join: player %s queued; queue size=%d", player_id, queue.size)
        # immediate status so the lobby reflects the queue at once, then stream updates
        try:
            await ws.send_json({"type": "queue_status", **(await queue.get_status(player_id))})
        except Exception:
            log.exception("queue_join: failed sending immediate status to %s", player_id)
        asyncio.create_task(_queue_wait_loop(ws, player_id))


async def _queue_wait_loop(ws: WebSocket, player_id: int):
    """Stream queue status (position, wait, current elo band, players in queue) to a
    waiting player until they're matched, cancel, or time out. Matching and the 120s
    timeout themselves are handled by the global _matchmaker_loop."""
    while True:
        await asyncio.sleep(2)
        status = await queue.get_status(player_id)
        if status["position"] == 0:
            return  # no longer in queue (matched, cancelled, or timed out)
        try:
            await ws.send_json({"type": "queue_status", **status})
        except Exception:
            return


async def _run_multiplayer_match(red: QueueEntry, black: QueueEntry):
    """Resilient wrapper. A failure inside the match must NOT (a) tear down the joining
    player's socket — the instant-match path awaits this inline — nor (b) vanish silently
    in the background path. Log the full traceback and tell both players to requeue."""
    try:
        await _run_multiplayer_match_inner(red, black)
    except Exception:
        log.exception("MATCH FAILED: red_player=%s red_agent=%s black_player=%s black_agent=%s",
                      red.player_id, red.agent_id, black.player_id, black.agent_id)
        for e in (red, black):
            online.set_status(e.player_id, "idle")
            try:
                await e.websocket.send_json({"type": "error", "message": "the match failed to start — please queue again"})
            except Exception:
                pass


async def _run_multiplayer_match_inner(red: QueueEntry, black: QueueEntry):
    """Simulate match, settle bets, send results to both players."""
    log.info("match: start red_agent=%s black_agent=%s", red.agent_id, black.agent_id)
    red_agent = get_agent(red.agent_id)
    black_agent = get_agent(black.agent_id)
    if not red_agent or not black_agent:
        raise RuntimeError(f"agent row missing: red={red.agent_id} found={bool(red_agent)}, black={black.agent_id} found={bool(black_agent)}")

    # notify match found
    odds = calculate_match_odds(red.agent_elo, black.agent_elo)
    for entry, side, opp_entry in [(red, "red", black), (black, "black", red)]:
        try:
            await entry.websocket.send_json({
                "type": "match_found",
                "your_side": side,
                "opponent": {"display_name": opp_entry.display_name, "agent_name": opp_entry.agent_name, "agent_elo": opp_entry.agent_elo},
                "odds": odds[side],
                "bet_amount": entry.bet_amount,
                "potential_win": int(entry.bet_amount * odds[side]) if entry.bet_amount > 0 else 0,
            })
        except Exception:
            pass

    await asyncio.sleep(3)  # countdown

    # simulate
    run_game = _get_run_game()
    red_cfg = AgentConfig(aggression=red_agent["aggression"], risk_tolerance=red_agent["risk_tolerance"],
                          king_priority=red_agent["king_priority"], edge_affinity=red_agent["edge_affinity"],
                          trade_down=red_agent["trade_down"])
    black_cfg = AgentConfig(aggression=black_agent["aggression"], risk_tolerance=black_agent["risk_tolerance"],
                            king_priority=black_agent["king_priority"], edge_affinity=black_agent["edge_affinity"],
                            trade_down=black_agent["trade_down"])
    # matchup familiarity (multiplayer is always competitive): each side vs the other's type
    red_type = categorize_opponent(black_agent)
    black_type = categorize_opponent(red_agent)
    red_fam = get_familiarity_score(red.agent_id, red_type)
    black_fam = get_familiarity_score(black.agent_id, black_type)

    log.info("match: running game (red_perk=%s black_perk=%s)", red_agent.get("perk"), black_agent.get("perk"))
    game = run_game(red_cfg, black_cfg,
                    red_perk=red_agent.get("perk"), black_perk=black_agent.get("perk"),
                    red_familiarity=red_fam, black_familiarity=black_fam)
    log.info("match: game done winner=%s moves=%s", game.get("winner"), game.get("move_count"))

    # optional AI commentary (no-op without ANTHROPIC_API_KEY); run off the event loop so
    # the blocking HTTP call never freezes other WS connections.
    try:
        from main import generate_commentary, build_commentary_summary
        _summary = build_commentary_summary(
            red_agent["name"], red_cfg, red_agent.get("perk"),
            black_agent["name"], black_cfg, black_agent.get("perk"), game)
        commentary = await asyncio.to_thread(generate_commentary, _summary)
    except Exception:
        log.exception("commentary generation failed")
        commentary = []

    # elo update
    result_red = 1.0 if game["winner"] == "red" else (0.0 if game["winner"] == "black" else 0.5)
    red_elo_after, black_elo_after = update_elo(red.agent_elo, black.agent_elo, result_red)
    red_result_str = "win" if game["winner"] == "red" else ("loss" if game["winner"] == "black" else "draw")
    black_result_str = "win" if game["winner"] == "black" else ("loss" if game["winner"] == "red" else "draw")
    update_agent_after_match(red.agent_id, red_elo_after, red_result_str)
    update_agent_after_match(black.agent_id, black_elo_after, black_result_str)

    # progression: evolution + familiarity for both player agents
    for aid, res_str, mtype in [(red.agent_id, red_result_str, red_type), (black.agent_id, black_result_str, black_type)]:
        process_agent_evolution(aid, res_str)
        update_familiarity(aid, mtype, won=(res_str == "win"))
        fa = get_agent(aid)
        if fa and fa["matches"] > 0 and fa["matches"] % 50 == 0:
            decay_familiarity(aid)

    # save match
    match_id = save_match(
        red_config=red_cfg.to_dict(), black_config=black_cfg.to_dict(),
        winner=game["winner"], move_count=game["move_count"],
        final_red=game["final_red"], final_black=game["final_black"],
        moves=game["moves"], shrink_events=game["events"],
        red_elo_before=red.agent_elo, red_elo_after=red_elo_after,
        black_elo_before=black.agent_elo, black_elo_after=black_elo_after,
        red_agent_id=red.agent_id, black_agent_id=black.agent_id,
    )

    # --- real-play (USDC) settlement ---
    # v1 is custodial: stakes are settled against the server USDC ledger and the house
    # takes 5%. The escrow contract (createMatch/joinMatch/settleMatch) is wired in once
    # client-side wallet signing is added (Phase 2); it requires both players to fund the
    # on-chain escrow, which needs their wallets to sign — out of scope for v1.
    real_results = {}
    if red.mode == "real" and black.mode == "real":
        pot = red.bet_micros + black.bet_micros
        fee = pot * REAL_HOUSE_FEE_BPS // 10000
        winner_side = game["winner"]
        for entry, side in [(red, "red"), (black, "black")]:
            stake = entry.bet_micros
            if winner_side == "draw":
                ret = (pot - fee) // 2
                kind = "match_draw"
            elif winner_side == side:
                ret = pot - fee
                kind = "match_win"
            else:
                ret = 0
                kind = "match_loss"
            net = ret - stake
            adjust_player_usdc(entry.player_id, net)
            record_crypto_tx(entry.player_id, kind, net, match_id=match_id)
            real_results[side] = {
                "result": ("draw" if winner_side == "draw" else ("win" if winner_side == side else "loss")),
                "stake_usdc": micros_to_usdc(stake),
                "return_usdc": micros_to_usdc(ret),
                "net_usdc": micros_to_usdc(net),
                "balance_usdc": micros_to_usdc(get_player_usdc(entry.player_id)),
                "house_fee_usdc": micros_to_usdc(fee),
            }

    # settle bets and build per-player results
    for entry, side, agent_data, opp_agent, elo_before, elo_after in [
        (red, "red", red_agent, black_agent, red.agent_elo, red_elo_after),
        (black, "black", black_agent, red_agent, black.agent_elo, black_elo_after),
    ]:
        won = game["winner"] == side
        is_blocked_draw = game.get("draw_reason") == "blocked"
        bet_result = None
        if entry.mode == "free" and entry.bet_amount > 0:
            side_odds = odds[side]
            if is_blocked_draw:
                payout = entry.bet_amount  # refund
                net = 0
                bet_outcome = "push"
            elif won:
                payout = int(entry.bet_amount * side_odds)
                net = payout - entry.bet_amount
                bet_outcome = "win"
            else:
                payout = 0
                net = -entry.bet_amount
                bet_outcome = "loss"
            update_player_coins(entry.player_id, net)
            bet_result = {"result": bet_outcome, "amount": entry.bet_amount,
                          "odds": side_odds, "payout": payout, "net": net}

        result_msg = {
            "type": "match_result",
            "winner": game["winner"],
            "draw_reason": game.get("draw_reason"),
            "your_side": side,
            "boards": game["boards"],
            "moves": game["moves"],
            "events": game["events"],
            "win_probability": game.get("win_probability"),
            "commentary": commentary,
            "move_count": game["move_count"],
            "final_red": game["final_red"],
            "final_black": game["final_black"],
            "opponent_reveal": {
                "agent_name": opp_agent["name"],
                "aggression": opp_agent["aggression"], "risk_tolerance": opp_agent["risk_tolerance"],
                "king_priority": opp_agent["king_priority"], "edge_affinity": opp_agent["edge_affinity"],
                "trade_down": opp_agent["trade_down"],
                "perk": opp_agent.get("perk"), "level": opp_agent.get("level", 1),
            },
            "elo_change": {"before": elo_before, "after": elo_after, "delta": round(elo_after - elo_before, 1)},
            "bet_result": bet_result,
            "mode": entry.mode,
            "real_result": real_results.get(side),
        }

        try:
            await entry.websocket.send_json(result_msg)
            log.info("match: result sent to player %s (side=%s won=%s)", entry.player_id, side, won)
        except Exception:
            log.exception("match: failed sending result to player %s", entry.player_id)

        online.set_status(entry.player_id, "idle")


# =============================================================================
# Arena multiplayer
# =============================================================================

async def _handle_arena_queue_join(ws: WebSocket, player_id: int, display_name: str, msg: dict):
    """Handle arena_queue_join: validate team, compute team elo, enqueue."""
    team = msg.get("team", [])
    if not team or len(team) < 1 or len(team) > 3:
        await ws.send_json({"type": "error", "message": "arena team must have 1-3 creatures"})
        return

    from arena_species import Species as ArenaSpecies
    valid_species = {s.value for s in ArenaSpecies}
    for c in team:
        if c.get("species") not in valid_species:
            await ws.send_json({"type": "error", "message": f"invalid species: {c.get('species')}"})
            return

    # Compute team elo: average of agents' elo if agents assigned, else 1200
    elos = []
    for c in team:
        if c.get("agent_id"):
            agent = get_agent(c["agent_id"])
            if agent:
                elos.append(agent.get("elo", 1200))
            else:
                elos.append(1200)
        else:
            elos.append(1200)
    team_elo = sum(elos) / len(elos)

    entry = ArenaQueueEntry(
        player_id=player_id,
        display_name=display_name,
        websocket=ws,
        team=team,
        team_elo=team_elo,
        joined_at=time.time(),
    )

    online.set_status(player_id, "in_queue")
    await ws.send_json({"type": "arena_queue_joined", "team_elo": round(team_elo)})

    match_pair = await arena_queue.add(entry)

    if match_pair:
        red_entry, blue_entry = match_pair
        log.info("arena_queue_join: INSTANT match player %s vs player %s", red_entry.player_id, blue_entry.player_id)
        online.set_status(red_entry.player_id, "in_match")
        online.set_status(blue_entry.player_id, "in_match")
        asyncio.create_task(_run_arena_match(red_entry, blue_entry))
    else:
        log.info("arena_queue_join: player %s queued; arena queue size=%d", player_id, arena_queue.size)
        try:
            await ws.send_json({"type": "arena_queue_status", **(await arena_queue.get_status(player_id))})
        except Exception:
            log.exception("arena_queue_join: failed sending status to %s", player_id)
        asyncio.create_task(_arena_queue_wait_loop(ws, player_id))


async def _arena_queue_wait_loop(ws: WebSocket, player_id: int):
    """Stream arena queue status updates to a waiting player."""
    while True:
        await asyncio.sleep(2)
        status = await arena_queue.get_status(player_id)
        if status["position"] == 0:
            return
        try:
            await ws.send_json({"type": "arena_queue_status", **status})
        except Exception:
            return


async def _run_arena_match(red: ArenaQueueEntry, blue: ArenaQueueEntry):
    """Resilient wrapper for arena multiplayer matches."""
    try:
        await _run_arena_match_inner(red, blue)
    except Exception:
        log.exception("ARENA MATCH FAILED: red_player=%s blue_player=%s", red.player_id, blue.player_id)
        for e in (red, blue):
            online.set_status(e.player_id, "idle")
            try:
                await e.websocket.send_json({"type": "error", "message": "arena match failed — please queue again"})
            except Exception:
                pass


async def _run_arena_match_inner(red: ArenaQueueEntry, blue: ArenaQueueEntry):
    """Simulate arena match, send results to both players."""
    log.info("arena match: start red_player=%s blue_player=%s", red.player_id, blue.player_id)

    from arena_engine import CreatureConfig, simulate_match as arena_simulate
    from arena_species import Species as ArenaSpecies, derive_temperament

    def _build_configs(team_data: list[dict]) -> list[CreatureConfig]:
        configs = []
        for c in team_data:
            agent_name = ""
            agg = c.get("aggression", 50)
            risk = c.get("risk_tolerance", 50)
            tgt = c.get("target_focus", 50)
            pos = c.get("positioning", 50)
            sac = c.get("sacrifice", 50)
            if c.get("agent_id"):
                agent = get_agent(c["agent_id"])
                if agent:
                    agent_name = agent["name"]
                    agg = agent["aggression"]
                    risk = agent["risk_tolerance"]
                    tgt = agent.get("king_priority", 50)
                    pos = agent.get("edge_affinity", 50)
                    sac = agent.get("trade_down", 50)
            configs.append(CreatureConfig(
                species=ArenaSpecies(c["species"]),
                agent_name=agent_name,
                aggression=agg, risk_tolerance=risk,
                target_focus=tgt, positioning=pos, sacrifice=sac,
                upgrade=c.get("upgrade"),
            ))
        return configs

    red_configs = _build_configs(red.team)
    blue_configs = _build_configs(blue.team)

    # --- Opponent reveal ---
    red_team_reveal = []
    for c, cfg in zip(red.team, red_configs):
        temp = derive_temperament(cfg.aggression, cfg.risk_tolerance, cfg.target_focus, cfg.positioning, cfg.sacrifice)
        red_team_reveal.append({
            "species": c["species"], "temperament": temp.value,
            "agent_name": cfg.agent_name,
        })

    blue_team_reveal = []
    for c, cfg in zip(blue.team, blue_configs):
        temp = derive_temperament(cfg.aggression, cfg.risk_tolerance, cfg.target_focus, cfg.positioning, cfg.sacrifice)
        blue_team_reveal.append({
            "species": c["species"], "temperament": temp.value,
            "agent_name": cfg.agent_name,
        })

    for entry, side, opp_entry, opp_reveal in [
        (red, "red", blue, blue_team_reveal),
        (blue, "blue", red, red_team_reveal),
    ]:
        try:
            await entry.websocket.send_json({
                "type": "arena_match_found",
                "your_side": side,
                "opponent": {
                    "display_name": opp_entry.display_name,
                    "team": opp_reveal,
                    "team_elo": round(opp_entry.team_elo),
                },
            })
        except Exception:
            pass

    # Reveal pause + countdown
    await asyncio.sleep(2)  # opponent reveal
    for i in (3, 2, 1):
        for entry in (red, blue):
            try:
                await entry.websocket.send_json({"type": "arena_countdown", "count": i})
            except Exception:
                pass
        await asyncio.sleep(1)

    # Simulate
    log.info("arena match: running simulation")
    result = await asyncio.to_thread(arena_simulate, red_configs, blue_configs)
    result_dict = result.to_dict()
    log.info("arena match: done winner=%s rounds=%s", result_dict["winner"], result_dict["total_rounds"])

    # Optional AI commentary
    try:
        from main import generate_arena_commentary
        commentary = await asyncio.to_thread(generate_arena_commentary, result_dict)
    except Exception:
        log.exception("arena commentary generation failed")
        commentary = []

    # Send results to both players
    for entry, side in [(red, "red"), (blue, "blue")]:
        result_msg = {
            "type": "arena_match_result",
            "your_side": side,
            **result_dict,
            "commentary": commentary,
        }
        try:
            await entry.websocket.send_json(result_msg)
            log.info("arena match: result sent to player %s (side=%s)", entry.player_id, side)
        except Exception:
            log.exception("arena match: failed sending result to player %s", entry.player_id)
        online.set_status(entry.player_id, "idle")
