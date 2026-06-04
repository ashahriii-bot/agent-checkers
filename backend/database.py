"""SQLite storage for match history, elo ratings, and named agents."""

import json
import math
import random
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import os

DB_PATH = Path(os.environ.get("DB_PATH", str(Path(__file__).parent / "matches.db")))

K_FACTOR = 32
DEFAULT_ELO = 1200

STARTER_AGENTS = [
    ("Berserker", 95, 90, 20, 20, 30),
    ("Turtle", 15, 10, 80, 70, 40),
    ("Balanced", 50, 50, 50, 50, 50),
    ("Gambler", 70, 95, 40, 30, 60),
    ("Wall", 30, 15, 60, 95, 80),
    ("Shark", 80, 40, 50, 30, 95),
]


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            red_config TEXT NOT NULL,
            black_config TEXT NOT NULL,
            winner TEXT NOT NULL,
            move_count INTEGER NOT NULL,
            final_red INTEGER NOT NULL,
            final_black INTEGER NOT NULL,
            moves TEXT NOT NULL,
            shrink_events TEXT DEFAULT '[]',
            red_elo_before REAL DEFAULT 1200,
            red_elo_after REAL DEFAULT 1200,
            black_elo_before REAL DEFAULT 1200,
            black_elo_after REAL DEFAULT 1200,
            red_agent_id INTEGER,
            black_agent_id INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS elo_ratings (
            config_key TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            elo REAL NOT NULL DEFAULT 1200,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            matches INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            aggression INTEGER NOT NULL,
            risk_tolerance INTEGER NOT NULL,
            king_priority INTEGER NOT NULL,
            edge_affinity INTEGER NOT NULL,
            trade_down INTEGER NOT NULL,
            elo REAL NOT NULL DEFAULT 1200,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            matches INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tournaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            bracket_size INTEGER NOT NULL,
            seeding TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'finished',
            bracket TEXT NOT NULL,
            champion_agent_id INTEGER,
            awards TEXT,
            total_moves INTEGER DEFAULT 0,
            total_upsets INTEGER DEFAULT 0
        )
    """)
    # migrate: add agent_id columns to matches if missing
    cols = {r[1] for r in conn.execute("PRAGMA table_info(matches)").fetchall()}
    if "red_agent_id" not in cols:
        conn.execute("ALTER TABLE matches ADD COLUMN red_agent_id INTEGER")
    if "black_agent_id" not in cols:
        conn.execute("ALTER TABLE matches ADD COLUMN black_agent_id INTEGER")
    conn.commit()
    _seed_starter_agents(conn)
    conn.close()


def _seed_starter_agents(conn):
    count = conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    if count > 0:
        return
    now = datetime.now(timezone.utc).isoformat()
    for name, a, r, k, e, t in STARTER_AGENTS:
        conn.execute(
            "INSERT INTO agents (name, aggression, risk_tolerance, king_priority, edge_affinity, trade_down, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (name, a, r, k, e, t, now, now),
        )
    conn.commit()


# --- agents CRUD ---

def _agent_row_to_dict(r) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "aggression": r["aggression"],
        "risk_tolerance": r["risk_tolerance"],
        "king_priority": r["king_priority"],
        "edge_affinity": r["edge_affinity"],
        "trade_down": r["trade_down"],
        "elo": r["elo"],
        "wins": r["wins"],
        "losses": r["losses"],
        "draws": r["draws"],
        "matches": r["matches"],
        "win_rate": round(r["wins"] / r["matches"] * 100, 1) if r["matches"] > 0 else 0,
    }


def create_agent(name: str, aggression: int, risk_tolerance: int, king_priority: int,
                 edge_affinity: int, trade_down: int) -> dict:
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    try:
        cursor = conn.execute(
            "INSERT INTO agents (name, aggression, risk_tolerance, king_priority, edge_affinity, trade_down, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (name, aggression, risk_tolerance, king_priority, edge_affinity, trade_down, now, now),
        )
        conn.commit()
        agent_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return None
    row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    conn.close()
    return _agent_row_to_dict(row)


def get_agents() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM agents ORDER BY elo DESC").fetchall()
    conn.close()
    return [_agent_row_to_dict(r) for r in rows]


def get_agent(agent_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    conn.close()
    return _agent_row_to_dict(row) if row else None


def update_agent(agent_id: int, name: str | None = None, aggression: int | None = None,
                 risk_tolerance: int | None = None, king_priority: int | None = None,
                 edge_affinity: int | None = None, trade_down: int | None = None) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        conn.close()
        return None
    now = datetime.now(timezone.utc).isoformat()
    new_name = name if name is not None else row["name"]
    new_a = aggression if aggression is not None else row["aggression"]
    new_r = risk_tolerance if risk_tolerance is not None else row["risk_tolerance"]
    new_k = king_priority if king_priority is not None else row["king_priority"]
    new_e = edge_affinity if edge_affinity is not None else row["edge_affinity"]
    new_t = trade_down if trade_down is not None else row["trade_down"]
    config_changed = (
        new_a != row["aggression"] or new_r != row["risk_tolerance"] or
        new_k != row["king_priority"] or new_e != row["edge_affinity"] or new_t != row["trade_down"]
    )
    try:
        if config_changed:
            conn.execute(
                "UPDATE agents SET name=?, aggression=?, risk_tolerance=?, king_priority=?, edge_affinity=?, trade_down=?, elo=1200, wins=0, losses=0, draws=0, matches=0, updated_at=? WHERE id=?",
                (new_name, new_a, new_r, new_k, new_e, new_t, now, agent_id),
            )
        else:
            conn.execute(
                "UPDATE agents SET name=?, updated_at=? WHERE id=?",
                (new_name, now, agent_id),
            )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return None
    updated = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    conn.close()
    return _agent_row_to_dict(updated)


def delete_agent(agent_id: int) -> bool:
    conn = get_db()
    cursor = conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def update_agent_after_match(agent_id: int, new_elo: float, result: str):
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    wins_inc = 1 if result == "win" else 0
    losses_inc = 1 if result == "loss" else 0
    draws_inc = 1 if result == "draw" else 0
    conn.execute("""
        UPDATE agents SET elo=?, wins=wins+?, losses=losses+?, draws=draws+?, matches=matches+1, updated_at=?
        WHERE id=?
    """, (new_elo, wins_inc, losses_inc, draws_inc, now, agent_id))
    conn.commit()
    conn.close()


def get_agent_leaderboard(limit: int = 20) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM agents WHERE matches >= 3 ORDER BY elo DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [_agent_row_to_dict(r) for r in rows]


# --- elo math ---

def expected_score(ra: float, rb: float) -> float:
    return 1 / (1 + math.pow(10, (rb - ra) / 400))


def update_elo(ra: float, rb: float, result_a: float) -> tuple[float, float]:
    ea = expected_score(ra, rb)
    eb = 1 - ea
    new_ra = ra + K_FACTOR * (result_a - ea)
    new_rb = rb + K_FACTOR * ((1 - result_a) - eb)
    return round(new_ra, 1), round(new_rb, 1)


def get_elo(config_key: str) -> float:
    conn = get_db()
    row = conn.execute("SELECT elo FROM elo_ratings WHERE config_key = ?", (config_key,)).fetchone()
    conn.close()
    return row["elo"] if row else DEFAULT_ELO


def update_elo_record(config_key: str, config_dict: dict, new_elo: float, result: str):
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    existing = conn.execute("SELECT * FROM elo_ratings WHERE config_key = ?", (config_key,)).fetchone()
    if existing:
        wins = existing["wins"] + (1 if result == "win" else 0)
        losses = existing["losses"] + (1 if result == "loss" else 0)
        draws = existing["draws"] + (1 if result == "draw" else 0)
        matches = existing["matches"] + 1
        conn.execute("""
            UPDATE elo_ratings SET elo = ?, wins = ?, losses = ?, draws = ?, matches = ?, updated_at = ?
            WHERE config_key = ?
        """, (new_elo, wins, losses, draws, matches, now, config_key))
    else:
        wins = 1 if result == "win" else 0
        losses = 1 if result == "loss" else 0
        draws = 1 if result == "draw" else 0
        conn.execute("""
            INSERT INTO elo_ratings (config_key, config_json, elo, wins, losses, draws, matches, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        """, (config_key, json.dumps(config_dict), new_elo, wins, losses, draws, now))
    conn.commit()
    conn.close()


def get_leaderboard(limit: int = 20) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM elo_ratings WHERE matches >= 3 ORDER BY elo DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [
        {
            "config_key": r["config_key"],
            "config": json.loads(r["config_json"]),
            "elo": r["elo"],
            "wins": r["wins"],
            "losses": r["losses"],
            "draws": r["draws"],
            "matches": r["matches"],
            "win_rate": round(r["wins"] / r["matches"] * 100, 1) if r["matches"] > 0 else 0,
        }
        for r in rows
    ]


# --- match storage ---

def save_match(
    red_config: dict, black_config: dict, winner: str, move_count: int,
    final_red: int, final_black: int, moves: list[dict],
    shrink_events: list[dict] | None = None,
    red_elo_before: float = 1200, red_elo_after: float = 1200,
    black_elo_before: float = 1200, black_elo_after: float = 1200,
    red_agent_id: int | None = None, black_agent_id: int | None = None,
) -> int:
    conn = get_db()
    cursor = conn.execute(
        """
        INSERT INTO matches (created_at, red_config, black_config, winner, move_count,
            final_red, final_black, moves, shrink_events,
            red_elo_before, red_elo_after, black_elo_before, black_elo_after,
            red_agent_id, black_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now(timezone.utc).isoformat(),
            json.dumps(red_config), json.dumps(black_config),
            winner, move_count, final_red, final_black,
            json.dumps(moves), json.dumps(shrink_events or []),
            red_elo_before, red_elo_after, black_elo_before, black_elo_after,
            red_agent_id, black_agent_id,
        ),
    )
    conn.commit()
    match_id = cursor.lastrowid
    conn.close()
    return match_id


def get_matches(limit: int = 50) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM matches ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    results = []
    for r in rows:
        d = {
            "id": r["id"],
            "created_at": r["created_at"],
            "red_config": json.loads(r["red_config"]),
            "black_config": json.loads(r["black_config"]),
            "winner": r["winner"],
            "move_count": r["move_count"],
            "final_red": r["final_red"],
            "final_black": r["final_black"],
        }
        try:
            d["red_elo_after"] = r["red_elo_after"]
            d["black_elo_after"] = r["black_elo_after"]
            d["red_agent_id"] = r["red_agent_id"]
            d["black_agent_id"] = r["black_agent_id"]
        except (IndexError, KeyError):
            d["red_elo_after"] = 1200
            d["black_elo_after"] = 1200
        results.append(d)
    return results


def get_match(match_id: int) -> dict | None:
    conn = get_db()
    r = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    conn.close()
    if not r:
        return None
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "red_config": json.loads(r["red_config"]),
        "black_config": json.loads(r["black_config"]),
        "winner": r["winner"],
        "move_count": r["move_count"],
        "final_red": r["final_red"],
        "final_black": r["final_black"],
        "moves": json.loads(r["moves"]),
    }


# --- tournaments ---

def save_tournament(bracket_size: int, seeding: str, bracket_json: str,
                    champion_agent_id: int | None, awards_json: str,
                    total_moves: int, total_upsets: int) -> int:
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute("""
        INSERT INTO tournaments (created_at, bracket_size, seeding, status, bracket,
            champion_agent_id, awards, total_moves, total_upsets)
        VALUES (?, ?, ?, 'finished', ?, ?, ?, ?, ?)
    """, (now, bracket_size, seeding, bracket_json, champion_agent_id, awards_json, total_moves, total_upsets))
    conn.commit()
    tid = cursor.lastrowid
    conn.close()
    return tid


def get_tournaments(limit: int = 20) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT id, created_at, bracket_size, seeding, champion_agent_id, total_upsets, total_moves FROM tournaments ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_tournament(tid: int) -> dict | None:
    conn = get_db()
    r = conn.execute("SELECT * FROM tournaments WHERE id = ?", (tid,)).fetchone()
    conn.close()
    if not r:
        return None
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "bracket_size": r["bracket_size"],
        "seeding": r["seeding"],
        "bracket": json.loads(r["bracket"]),
        "champion_agent_id": r["champion_agent_id"],
        "awards": json.loads(r["awards"]) if r["awards"] else [],
        "total_moves": r["total_moves"],
        "total_upsets": r["total_upsets"],
    }


init_db()
