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


class MatchmakingQueue:
    def __init__(self):
        self.entries: list[QueueEntry] = []
        self._lock = asyncio.Lock()

    async def add(self, entry: QueueEntry) -> Optional[tuple[QueueEntry, QueueEntry]]:
        """Add to queue. Returns (red, black) if a match is found, else None."""
        async with self._lock:
            match = self._find_match(entry)
            if match:
                self.entries.remove(match)
                return (match, entry) if match.agent_elo >= entry.agent_elo else (entry, match)
            self.entries.append(entry)
            return None

    async def remove(self, player_id: int):
        async with self._lock:
            self.entries = [e for e in self.entries if e.player_id != player_id]

    async def remove_by_ws(self, ws: WebSocket):
        async with self._lock:
            self.entries = [e for e in self.entries if e.websocket != ws]

    def _find_match(self, entry: QueueEntry) -> Optional[QueueEntry]:
        now = time.time()
        for e in self.entries:
            if e.player_id == entry.player_id:
                continue
            wait_a = now - e.joined_at
            wait_b = now - entry.joined_at
            max_wait = max(wait_a, wait_b)
            elo_range = 200 + int(max_wait / 15) * 50
            if abs(e.agent_elo - entry.agent_elo) <= elo_range:
                return e
        return None

    async def get_status(self, player_id: int) -> dict:
        async with self._lock:
            for i, e in enumerate(self.entries):
                wait = time.time() - e.joined_at
                elo_range = 200 + int(wait / 15) * 50
                if e.player_id == player_id:
                    return {"position": i + 1, "wait_time": int(wait), "elo_range": elo_range}
        return {"position": 0, "wait_time": 0, "elo_range": 200}

    @property
    def size(self) -> int:
        return len(self.entries)


queue = MatchmakingQueue()


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
