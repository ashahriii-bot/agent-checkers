"""Matchmaking queue and multiplayer match orchestration."""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import WebSocket


@dataclass
class QueueEntry:
    player_id: int
    agent_id: int
    agent_elo: float
    bet_amount: int
    joined_at: float
    websocket: WebSocket
    agent_name: str = ""
    display_name: str = ""
    mode: str = "free"          # "free" or "real"
    bet_micros: int = 0         # USDC stake in micro-USDC (real mode only)


# Elo-band widening schedule: seconds waited -> max allowed elo gap.
# Tight when the pool is large, loosening over time so nobody waits forever.
# None means "match anyone available" (elo no longer a constraint).
def elo_band_for_wait(wait: float) -> Optional[int]:
    if wait < 15:
        return 100
    if wait < 30:
        return 200
    if wait < 60:
        return 400
    return None  # 60s+: pool is thin, match anyone available


# Seconds until the next widening step (drives the lobby's "widening in Xs" hint).
def seconds_until_widen(wait: float) -> int:
    for threshold in (15, 30, 60):
        if wait < threshold:
            return int(threshold - wait)
    return 0


MATCH_TIMEOUT_SECONDS = 120  # after this with no opponent: "no opponents found"


class MatchmakingQueue:
    def __init__(self):
        self.entries: list[QueueEntry] = []
        self._lock = asyncio.Lock()

    @staticmethod
    def _compatible(a: QueueEntry, b: QueueEntry) -> bool:
        """Two entries may ever be paired: different players, same economy, and for
        real-money the SAME bet tier (never match a $0.10 player with a $1.00 player)."""
        if a.player_id == b.player_id:
            return False
        if a.mode != b.mode:
            return False
        if a.mode == "real" and a.bet_micros != b.bet_micros:
            return False
        return True

    @staticmethod
    def _in_band(a: QueueEntry, b: QueueEntry, now: float) -> bool:
        wait = max(now - a.joined_at, now - b.joined_at)
        band = elo_band_for_wait(wait)
        if band is None:
            return True
        return abs(a.agent_elo - b.agent_elo) <= band

    @staticmethod
    def _ordered(a: QueueEntry, b: QueueEntry) -> tuple[QueueEntry, QueueEntry]:
        # higher elo plays red
        return (a, b) if a.agent_elo >= b.agent_elo else (b, a)

    async def add(self, entry: QueueEntry) -> Optional[tuple[QueueEntry, QueueEntry]]:
        """Add to queue, attempting an immediate match against waiting players.
        Returns (red, black) if matched on join, else None (entry is enqueued)."""
        async with self._lock:
            now = time.time()
            for e in self.entries:
                if self._compatible(entry, e) and self._in_band(entry, e, now):
                    self.entries.remove(e)
                    return self._ordered(entry, e)
            self.entries.append(entry)
            return None

    async def pop_ready_match(self) -> Optional[tuple[QueueEntry, QueueEntry]]:
        """Scan ALL waiting pairs for one now within band. Because bands widen with
        wait time, two players who were out-of-band at join become matchable later —
        add() only re-checks the newcomer, so without this periodic re-scan they'd
        never re-evaluate. Returns one (red, black) pair per call, or None."""
        async with self._lock:
            now = time.time()
            n = len(self.entries)
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = self.entries[i], self.entries[j]
                    if self._compatible(a, b) and self._in_band(a, b, now):
                        self.entries.remove(a)
                        self.entries.remove(b)
                        return self._ordered(a, b)
            return None

    async def pop_timed_out(self, max_wait: float = MATCH_TIMEOUT_SECONDS) -> list[QueueEntry]:
        """Remove and return entries that have waited longer than max_wait with no match."""
        async with self._lock:
            now = time.time()
            timed_out = [e for e in self.entries if now - e.joined_at > max_wait]
            if timed_out:
                drop = {id(e) for e in timed_out}
                self.entries = [e for e in self.entries if id(e) not in drop]
            return timed_out

    async def remove(self, player_id: int):
        async with self._lock:
            self.entries = [e for e in self.entries if e.player_id != player_id]

    async def remove_by_ws(self, ws: WebSocket):
        async with self._lock:
            self.entries = [e for e in self.entries if e.websocket != ws]

    async def get_status(self, player_id: int) -> dict:
        async with self._lock:
            size = len(self.entries)
            for i, e in enumerate(self.entries):
                if e.player_id == player_id:
                    wait = time.time() - e.joined_at
                    band = elo_band_for_wait(wait)
                    return {
                        "position": i + 1,
                        "wait_time": int(wait),
                        "elo_range": band,                  # None => matching anyone now
                        "matching_anyone": band is None,
                        "widen_in": seconds_until_widen(wait),
                        "players_in_queue": size,
                    }
        return {"position": 0, "wait_time": 0, "elo_range": 100,
                "matching_anyone": False, "widen_in": 15, "players_in_queue": 0}

    @property
    def size(self) -> int:
        return len(self.entries)


queue = MatchmakingQueue()


# --- Arena queue (separate from Checkers) ---

@dataclass
class ArenaQueueEntry:
    player_id: int
    display_name: str
    websocket: WebSocket
    team: list[dict]        # [{species, aggression, risk_tolerance, target_focus, positioning, sacrifice, agent_id?}]
    team_elo: float = 1200  # average of agents' elo, or 1200 if custom
    joined_at: float = 0


class ArenaMatchmakingQueue:
    """Same elo-banded matching as Checkers, but for Arena 3v3 teams."""

    def __init__(self):
        self.entries: list[ArenaQueueEntry] = []
        self._lock = asyncio.Lock()

    @staticmethod
    def _compatible(a: ArenaQueueEntry, b: ArenaQueueEntry) -> bool:
        return a.player_id != b.player_id

    @staticmethod
    def _in_band(a: ArenaQueueEntry, b: ArenaQueueEntry, now: float) -> bool:
        wait = max(now - a.joined_at, now - b.joined_at)
        band = elo_band_for_wait(wait)
        if band is None:
            return True
        return abs(a.team_elo - b.team_elo) <= band

    @staticmethod
    def _ordered(a: ArenaQueueEntry, b: ArenaQueueEntry) -> tuple[ArenaQueueEntry, ArenaQueueEntry]:
        return (a, b) if a.team_elo >= b.team_elo else (b, a)

    async def add(self, entry: ArenaQueueEntry) -> Optional[tuple[ArenaQueueEntry, ArenaQueueEntry]]:
        async with self._lock:
            now = time.time()
            for e in self.entries:
                if self._compatible(entry, e) and self._in_band(entry, e, now):
                    self.entries.remove(e)
                    return self._ordered(entry, e)
            self.entries.append(entry)
            return None

    async def pop_ready_match(self) -> Optional[tuple[ArenaQueueEntry, ArenaQueueEntry]]:
        async with self._lock:
            now = time.time()
            n = len(self.entries)
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = self.entries[i], self.entries[j]
                    if self._compatible(a, b) and self._in_band(a, b, now):
                        self.entries.remove(a)
                        self.entries.remove(b)
                        return self._ordered(a, b)
            return None

    async def pop_timed_out(self, max_wait: float = MATCH_TIMEOUT_SECONDS) -> list[ArenaQueueEntry]:
        async with self._lock:
            now = time.time()
            timed_out = [e for e in self.entries if now - e.joined_at > max_wait]
            if timed_out:
                drop = {id(e) for e in timed_out}
                self.entries = [e for e in self.entries if id(e) not in drop]
            return timed_out

    async def remove(self, player_id: int):
        async with self._lock:
            self.entries = [e for e in self.entries if e.player_id != player_id]

    async def remove_by_ws(self, ws: WebSocket):
        async with self._lock:
            self.entries = [e for e in self.entries if e.websocket != ws]

    async def get_status(self, player_id: int) -> dict:
        async with self._lock:
            size = len(self.entries)
            for i, e in enumerate(self.entries):
                if e.player_id == player_id:
                    wait = time.time() - e.joined_at
                    band = elo_band_for_wait(wait)
                    return {
                        "position": i + 1,
                        "wait_time": int(wait),
                        "elo_range": band,
                        "matching_anyone": band is None,
                        "widen_in": seconds_until_widen(wait),
                        "players_in_queue": size,
                    }
        return {"position": 0, "wait_time": 0, "elo_range": 100,
                "matching_anyone": False, "widen_in": 15, "players_in_queue": 0}

    @property
    def size(self) -> int:
        return len(self.entries)


arena_queue = ArenaMatchmakingQueue()


# --- online player tracking ---

class OnlineTracker:
    def __init__(self):
        self.connections: dict[int, dict] = {}

    def connect(self, player_id: int, display_name: str, ws: WebSocket):
        self.connections[player_id] = {"display_name": display_name, "ws": ws, "status": "idle"}

    def disconnect(self, player_id: int):
        self.connections.pop(player_id, None)

    def set_status(self, player_id: int, status: str):
        if player_id in self.connections:
            self.connections[player_id]["status"] = status

    def get_online(self) -> list[dict]:
        return [{"display_name": c["display_name"], "status": c["status"]} for c in self.connections.values()]

    @property
    def count(self) -> int:
        return len(self.connections)


online = OnlineTracker()
