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
from matchmaking import queue, online, QueueEntry
from crypto import crypto_service, micros_to_usdc

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
    while True:
        await asyncio.sleep(3)
        try:
            # 1) pair everyone currently within band (bands widen over time)
            while True:
                pair = await queue.pop_ready_match()
                if not pair:
                    break
                red_entry, black_entry = pair
                online.set_status(red_entry.player_id, "in_match")
                online.set_status(black_entry.player_id, "in_match")
                asyncio.create_task(_run_multiplayer_match(red_entry, black_entry))
            # 2) time out anyone who has waited too long with no opponent
            for e in await queue.pop_timed_out():
                online.set_status(e.player_id, "idle")
                try:
                    await e.websocket.send_json({
                        "type": "queue_timeout",
                        "message": "No opponents found. Try again later.",
                    })
                except Exception:
                    pass
        except Exception:
            # never let the matchmaker die on a transient error
            pass


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

    try:
        await ws.send_json({"type": "connected", "player_id": player_id, "display_name": display_name})

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "queue_join":
                await _handle_queue_join(ws, player_id, display_name, msg)

            elif msg_type == "queue_cancel":
                await queue.remove(player_id)
                online.set_status(player_id, "idle")
                await ws.send_json({"type": "queue_cancelled"})

            elif msg_type == "ping":
                await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await queue.remove_by_ws(ws)
        online.disconnect(player_id)


async def _handle_queue_join(ws: WebSocket, player_id: int, display_name: str, msg: dict):
    agent_id = msg.get("agent_id")
    bet_amount = msg.get("bet_amount", 0)
    mode = msg.get("mode", "free")

    agent = get_agent(agent_id)
    if not agent:
        await ws.send_json({"type": "error", "message": "agent not found"})
        return
    if agent.get("player_id") and agent["player_id"] != player_id:
        await ws.send_json({"type": "error", "message": "not your agent"})
        return

    bet_micros = 0
    if mode == "real":
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
        online.set_status(red_entry.player_id, "in_match")
        online.set_status(black_entry.player_id, "in_match")
        await _run_multiplayer_match(red_entry, black_entry)
    else:
        # immediate status so the lobby reflects the queue at once, then stream updates
        try:
            await ws.send_json({"type": "queue_status", **(await queue.get_status(player_id))})
        except Exception:
            pass
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
    """Simulate match, settle bets, send results to both players."""
    red_agent = get_agent(red.agent_id)
    black_agent = get_agent(black.agent_id)

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

    game = run_game(red_cfg, black_cfg,
                    red_perk=red_agent.get("perk"), black_perk=black_agent.get("perk"),
                    red_familiarity=red_fam, black_familiarity=black_fam)

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
        bet_result = None
        if entry.mode == "free" and entry.bet_amount > 0:
            side_odds = odds[side]
            payout = int(entry.bet_amount * side_odds) if won else 0
            net = payout - entry.bet_amount if won else -entry.bet_amount
            update_player_coins(entry.player_id, net)
            bet_result = {"result": "win" if won else "loss", "amount": entry.bet_amount,
                          "odds": side_odds, "payout": payout, "net": net}

        result_msg = {
            "type": "match_result",
            "winner": game["winner"],
            "your_side": side,
            "boards": game["boards"],
            "moves": game["moves"],
            "events": game["events"],
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
        except Exception:
            pass

        online.set_status(entry.player_id, "idle")
