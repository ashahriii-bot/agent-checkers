"""Concurrency + idempotency test for the arena Best-of-N "play next game" flow.

Regression guard for the double-execution race in `arena_series_next` (§5.5): two
concurrent POSTs to /api/arena/series/{id}/next (the 12s auto-advance racing a KEEP
click, a retry, or a second tab) used to each pass the `status == active` guard and
both simulate a game — a lost score update plus a phantom arena_match row and
inflated Pilot per-game records. The fix is a per-process advance lock around the
read-modify-write plus a `game_index` precondition so a duplicate advance is a clean
409 instead of a second game.

This exercises the endpoint FUNCTIONS in-process (no HTTP/httpx dependency), because
the bug lives in Starlette's sync-endpoint threadpool — calling the functions from
threads reproduces exactly that. It asserts on the persistent arena_matches row
count, which increments once per game played regardless of lineup, so a phantom game
is caught even with un-owned (recordless) Pilots.

Usage:  python scripts/arena_series_concurrency_test.py [rounds]
stdlib only; safe to run in CI (exits non-zero on failure).
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

# Fresh throwaway DB before anything imports `database` (init_db runs at import).
_db_fd, _DB_PATH = tempfile.mkstemp(prefix="arena_series_conc_", suffix=".db")
os.close(_db_fd)
os.environ["DB_PATH"] = _DB_PATH

from fastapi import HTTPException  # noqa: E402
from main import (  # noqa: E402
    arena_series_start, arena_series_next,
    ArenaSeriesStartRequest, ArenaSeriesNextRequest, ArenaCreatureIn,
)
from database import get_series, get_db  # noqa: E402

# Custom builds: every slider in [5, 80], summing to exactly 200 (the arena budget),
# and agent_id=None so the anti-cheat path accepts them without a saved agent.
_SLIDERS = dict(aggression=40, risk_tolerance=40, target_focus=40, positioning=40, sacrifice=40)


def red_team():
    return [ArenaCreatureIn(species=s, **_SLIDERS) for s in ("ironjaw", "razorwing")]


def blue_team():
    return [ArenaCreatureIn(species=s, **_SLIDERS) for s in ("warden", "hexwright")]


def start_bo5() -> dict:
    return arena_series_start(ArenaSeriesStartRequest(
        format="bo5", red_team=red_team(), blue_team=blue_team()))


def call_next(series_id: int, game_index):
    """Returns ('ok', state) or ('err', status_code)."""
    try:
        st = arena_series_next(series_id, ArenaSeriesNextRequest(
            red_team=red_team(), blue_team=blue_team(), game_index=game_index))
        return ("ok", st)
    except HTTPException as e:
        return ("err", e.status_code)


def games_played(series_id: int) -> int:
    return len(get_series(series_id)["per_game_results"])


def match_count() -> int:
    conn = get_db()
    try:
        return conn.execute("SELECT COUNT(*) AS n FROM arena_matches").fetchone()["n"]
    finally:
        conn.close()


class Failure(AssertionError):
    pass


def check(cond: bool, msg: str):
    if not cond:
        raise Failure(msg)
    print(f"  ok  · {msg}")


def test_idempotency_sequential():
    """Deterministic (no threads): the game_index precondition rejects a stale-low
    token and a duplicate (post-advance) token, and a correct advance writes exactly
    one game + one arena_match."""
    print("[1] sequential idempotency precondition")
    s = start_bo5()
    sid = s["series_id"]
    check(s["game_index"] == 1, "start plays game 1 (game_index == 1)")
    played = s["game_index"]

    # stale-low: client expects an earlier game than the server has played
    kind, code = call_next(sid, played - 1)
    check(kind == "err" and code == 409, f"stale-low token (expected {played-1}) → 409")

    before = match_count()
    kind, st = call_next(sid, played)
    check(kind == "ok", f"correct token ({played}) advances the series")
    check(games_played(sid) == played + 1, "exactly one game appended")
    check(match_count() == before + 1, "exactly one arena_match persisted")

    # duplicate: replay the same token now that the series has moved on
    after = match_count()
    kind, code = call_next(sid, played)
    check(kind == "err" and code == 409, f"duplicate token ({played}) replayed → 409")
    check(match_count() == after, "no phantom arena_match from the duplicate")


def test_concurrent_double_fire(rounds: int):
    """Two threads POST /next for the SAME game simultaneously. The lock + precondition
    must collapse them to exactly one played game (one new arena_match), with the loser
    getting a 409 — proving the read-modify-write is atomic, not just serialized."""
    print(f"[2] concurrent double-fire ({rounds} rounds, fresh Bo5 each)")
    for r in range(rounds):
        s = start_bo5()
        sid = s["series_id"]
        expect = s["game_index"]  # both threads claim to play this same next game

        before = match_count()
        barrier = threading.Barrier(2)
        results: list = [None, None]

        def worker(i):
            barrier.wait()  # release both at once to force genuine lock contention
            results[i] = call_next(sid, expect)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        oks = [r for r in results if r and r[0] == "ok"]
        errs = [r for r in results if r and r[0] == "err"]
        played = games_played(sid)
        added = match_count() - before

        check(len(oks) == 1 and len(errs) == 1,
              f"round {r}: exactly one POST won, one rejected ({[x[1] for x in errs]})")
        check(all(e[1] == 409 for e in errs), f"round {r}: loser rejected with 409")
        check(played == expect + 1, f"round {r}: series advanced by exactly one game")
        check(added == 1, f"round {r}: exactly one arena_match persisted (no phantom)")


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    print(f"Arena series concurrency/idempotency test (DB={_DB_PATH})\n")
    failed = False
    try:
        test_idempotency_sequential()
        print()
        test_concurrent_double_fire(rounds)
    except Failure as e:
        print(f"  FAIL · {e}")
        failed = True
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(_DB_PATH + suffix)
            except OSError:
                pass

    print()
    if failed:
        print("[FAIL] arena series advance is NOT idempotent under concurrency")
        sys.exit(1)
    print("[PASS] double-fired advances collapse to a single game (lock + game_index precondition)")
    sys.exit(0)


if __name__ == "__main__":
    main()
