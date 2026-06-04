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

LEVEL_THRESHOLDS = {1: 0, 2: 5, 3: 15, 4: 30, 5: 50}
VALID_PERKS = {"rope_a_dope", "press", "momentum"}


def xp_to_level(xp: int) -> int:
    level = 1
    for lv in (5, 4, 3, 2):
        if xp >= LEVEL_THRESHOLDS[lv]:
            level = lv
            break
    return level


def xp_for_next_level(level: int) -> int | None:
    if level >= 5:
        return None
    return LEVEL_THRESHOLDS[level + 1]

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
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            coin_balance INTEGER NOT NULL DEFAULT 1000,
            total_wins INTEGER NOT NULL DEFAULT 0,
            total_losses INTEGER NOT NULL DEFAULT 0,
            total_draws INTEGER NOT NULL DEFAULT 0
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wallet (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            balance INTEGER NOT NULL DEFAULT 1000,
            total_won INTEGER NOT NULL DEFAULT 0,
            total_lost INTEGER NOT NULL DEFAULT 0,
            total_bets INTEGER NOT NULL DEFAULT 0,
            biggest_win INTEGER NOT NULL DEFAULT 0,
            win_streak INTEGER NOT NULL DEFAULT 0,
            best_streak INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            bet_type TEXT NOT NULL,
            bet_on TEXT NOT NULL,
            amount INTEGER NOT NULL,
            odds REAL NOT NULL,
            result TEXT,
            payout INTEGER NOT NULL DEFAULT 0,
            match_id INTEGER,
            tournament_id INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS parlays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            tournament_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            predictions TEXT NOT NULL,
            total_odds REAL NOT NULL,
            correct INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            result TEXT DEFAULT 'pending',
            payout INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tournament_bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL,
            round INTEGER NOT NULL,
            match_index INTEGER NOT NULL,
            selection TEXT NOT NULL,
            amount INTEGER NOT NULL,
            odds REAL NOT NULL,
            is_lucky INTEGER DEFAULT 0,
            is_heat INTEGER DEFAULT 0,
            result TEXT,
            payout INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jackpot (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pool INTEGER NOT NULL DEFAULT 0,
            last_hit_at TEXT,
            last_hit_amount INTEGER DEFAULT 0,
            total_hits INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prop_bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            match_id INTEGER NOT NULL,
            prop_type TEXT NOT NULL,
            selection TEXT NOT NULL,
            amount INTEGER NOT NULL,
            odds REAL NOT NULL,
            line REAL,
            result TEXT,
            payout INTEGER NOT NULL DEFAULT 0,
            resolved_at_move INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS mirror_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            match_id INTEGER,
            player_agent_id INTEGER,
            player_config TEXT NOT NULL,
            player_edge TEXT,
            mirror_config TEXT NOT NULL,
            mirror_edge TEXT,
            winner TEXT NOT NULL,
            player_archetype TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS mirror_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            total_bouts INTEGER NOT NULL DEFAULT 0,
            player_wins INTEGER NOT NULL DEFAULT 0,
            mirror_wins INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            adaptation_level INTEGER NOT NULL DEFAULT 0,
            current_read TEXT DEFAULT '{}',
            updated_at TEXT NOT NULL DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rivalries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER NOT NULL,
            opponent_type TEXT NOT NULL,
            opponent_label TEXT NOT NULL,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            last_match_at TEXT NOT NULL,
            is_nemesis INTEGER NOT NULL DEFAULT 0,
            UNIQUE(agent_id, opponent_type)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_records (
            agent_id INTEGER NOT NULL,
            record_type TEXT NOT NULL,
            value INTEGER NOT NULL DEFAULT 0,
            match_id INTEGER,
            set_at TEXT NOT NULL,
            PRIMARY KEY (agent_id, record_type)
        )
    """)
    conn.execute("INSERT OR IGNORE INTO jackpot (id, pool) VALUES (1, 0)")
    conn.execute("INSERT OR IGNORE INTO wallet (id, balance) VALUES (1, 1000)")
    # migrations
    match_cols = {r[1] for r in conn.execute("PRAGMA table_info(matches)").fetchall()}
    if "red_agent_id" not in match_cols:
        conn.execute("ALTER TABLE matches ADD COLUMN red_agent_id INTEGER")
    if "black_agent_id" not in match_cols:
        conn.execute("ALTER TABLE matches ADD COLUMN black_agent_id INTEGER")
    agent_cols = {r[1] for r in conn.execute("PRAGMA table_info(agents)").fetchall()}
    if "xp" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
    if "level" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN level INTEGER NOT NULL DEFAULT 1")
    if "perk" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN perk TEXT DEFAULT NULL")
    if "player_id" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN player_id INTEGER")
    if "recent_results" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN recent_results TEXT DEFAULT '[]'")
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

def _calc_form(recent_results_json: str) -> str:
    try:
        results = json.loads(recent_results_json) if recent_results_json else []
    except (json.JSONDecodeError, TypeError):
        results = []
    if len(results) < 5:
        return "neutral"
    recent_5 = results[-5:]
    wins = sum(1 for r in recent_5 if r == "win")
    losses = sum(1 for r in recent_5 if r == "loss")
    if wins >= 4:
        return "hot"
    if losses >= 4:
        return "cold"
    return "neutral"


def _agent_row_to_dict(r) -> dict:
    xp = r["xp"] if "xp" in r.keys() else 0
    level = r["level"] if "level" in r.keys() else 1
    perk = r["perk"] if "perk" in r.keys() else None
    next_xp = xp_for_next_level(level)
    recent = r["recent_results"] if "recent_results" in r.keys() else "[]"
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
        "xp": xp,
        "level": level,
        "perk": perk,
        "xp_next": next_xp,
        "form": _calc_form(recent),
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


def update_agent_after_match(agent_id: int, new_elo: float, result: str) -> dict | None:
    """Update elo, record, and XP. Returns level-up info if one occurred, else None."""
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    wins_inc = 1 if result == "win" else 0
    losses_inc = 1 if result == "loss" else 0
    draws_inc = 1 if result == "draw" else 0
    row = conn.execute("SELECT xp, level, name, recent_results FROM agents WHERE id=?", (agent_id,)).fetchone()
    if not row:
        conn.close()
        return None
    old_level = row["level"] if row["level"] else 1
    old_xp = row["xp"] if row["xp"] else 0
    new_xp = old_xp + 1
    new_level = xp_to_level(new_xp)
    # update recent_results rolling window
    try:
        recent = json.loads(row["recent_results"]) if row["recent_results"] else []
    except (json.JSONDecodeError, TypeError):
        recent = []
    recent.append(result)
    if len(recent) > 10:
        recent = recent[-10:]
    conn.execute("""
        UPDATE agents SET elo=?, wins=wins+?, losses=losses+?, draws=draws+?, matches=matches+1,
        xp=?, level=?, recent_results=?, updated_at=? WHERE id=?
    """, (new_elo, wins_inc, losses_inc, draws_inc, new_xp, new_level, json.dumps(recent), now, agent_id))
    conn.commit()
    conn.close()
    if new_level > old_level:
        return {"agent_id": agent_id, "name": row["name"], "old_level": old_level,
                "new_level": new_level, "perk_unlocked": new_level >= 5}
    return None


def set_agent_perk(agent_id: int, perk: str | None) -> dict | None:
    if perk is not None and perk not in VALID_PERKS:
        return None
    conn = get_db()
    row = conn.execute("SELECT level FROM agents WHERE id=?", (agent_id,)).fetchone()
    if not row:
        conn.close()
        return None
    level = row["level"] if row["level"] else 1
    if perk is not None and level < 5:
        conn.close()
        return None
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("UPDATE agents SET perk=?, updated_at=? WHERE id=?", (perk, now, agent_id))
    conn.commit()
    updated = conn.execute("SELECT * FROM agents WHERE id=?", (agent_id,)).fetchone()
    conn.close()
    return _agent_row_to_dict(updated)


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


# --- players ---

def create_player(username: str, display_name: str, password_hash: str) -> dict | None:
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    try:
        cursor = conn.execute(
            "INSERT INTO players (username, display_name, password_hash, created_at, last_seen) VALUES (?,?,?,?,?)",
            (username, display_name, password_hash, now, now),
        )
        conn.commit()
        pid = cursor.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return None
    row = conn.execute("SELECT * FROM players WHERE id = ?", (pid,)).fetchone()
    conn.close()
    return _player_row_to_dict(row)


def get_player(player_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
    conn.close()
    return _player_row_to_dict(row) if row else None


def get_player_by_username(username: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM players WHERE username = ?", (username,)).fetchone()
    conn.close()
    if not row:
        return None
    d = _player_row_to_dict(row)
    d["password_hash"] = row["password_hash"]
    return d


def _player_row_to_dict(r) -> dict:
    return {
        "id": r["id"], "username": r["username"], "display_name": r["display_name"],
        "coin_balance": r["coin_balance"],
        "total_wins": r["total_wins"], "total_losses": r["total_losses"], "total_draws": r["total_draws"],
    }


def update_player_coins(player_id: int, delta: int):
    conn = get_db()
    conn.execute("UPDATE players SET coin_balance = MAX(0, coin_balance + ?) WHERE id = ?", (delta, player_id))
    conn.commit()
    conn.close()


def update_player_stats(player_id: int, result: str):
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    w = 1 if result == "win" else 0
    l = 1 if result == "loss" else 0
    d = 1 if result == "draw" else 0
    conn.execute("UPDATE players SET total_wins=total_wins+?, total_losses=total_losses+?, total_draws=total_draws+?, last_seen=? WHERE id=?",
                 (w, l, d, now, player_id))
    conn.commit()
    conn.close()


# --- wallet and betting ---

HOUSE_EDGE = 0.05
DRAW_PROBABILITY = 0.06
BANKRUPT_BONUS = 500
MIN_BET = 10


def calculate_match_odds(red_elo: float, black_elo: float) -> dict:
    p_red_raw = 1 / (1 + 10 ** ((black_elo - red_elo) / 400))
    p_black_raw = 1 - p_red_raw
    p_red = p_red_raw * (1 - DRAW_PROBABILITY)
    p_black = p_black_raw * (1 - DRAW_PROBABILITY)
    p_draw = DRAW_PROBABILITY
    return {
        "red": round((1 / p_red) * (1 - HOUSE_EDGE), 2),
        "black": round((1 / p_black) * (1 - HOUSE_EDGE), 2),
        "draw": round((1 / p_draw) * (1 - HOUSE_EDGE), 2),
    }


def calculate_tournament_odds(agents: list[dict]) -> dict:
    strengths = [10 ** (a["elo"] / 400) for a in agents]
    total = sum(strengths)
    return {
        a["id"]: round((1 / (strengths[i] / total)) * (1 - HOUSE_EDGE), 2)
        for i, a in enumerate(agents)
    }


def get_wallet() -> dict:
    conn = get_db()
    r = conn.execute("SELECT * FROM wallet WHERE id = 1").fetchone()
    conn.close()
    if not r:
        return {"balance": 1000, "total_won": 0, "total_lost": 0, "total_bets": 0, "biggest_win": 0, "win_streak": 0, "best_streak": 0}
    return {k: r[k] for k in ("balance", "total_won", "total_lost", "total_bets", "biggest_win", "win_streak", "best_streak")}


def place_bet(bet_type: str, bet_on: str, amount: int, odds: float,
              match_id: int | None = None, tournament_id: int | None = None) -> dict:
    conn = get_db()
    w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    bal = w["balance"] if w else 1000
    if amount < MIN_BET:
        conn.close()
        raise ValueError(f"minimum bet is {MIN_BET}")
    if amount > bal:
        conn.close()
        raise ValueError("insufficient balance")
    conn.execute("UPDATE wallet SET balance = balance - ? WHERE id = 1", (amount,))
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        "INSERT INTO bets (created_at, bet_type, bet_on, amount, odds, match_id, tournament_id) VALUES (?,?,?,?,?,?,?)",
        (now, bet_type, bet_on, amount, odds, match_id, tournament_id),
    )
    conn.commit()
    bet_id = cursor.lastrowid
    new_bal = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()["balance"]
    conn.close()
    return {"bet_id": bet_id, "balance": new_bal}


def settle_bet(bet_id: int, result: str, payout: int) -> dict:
    conn = get_db()
    conn.execute("UPDATE bets SET result = ?, payout = ? WHERE id = ?", (result, payout, bet_id))
    if result == "win" and payout > 0:
        conn.execute("UPDATE wallet SET balance = balance + ?, total_won = total_won + ?, total_bets = total_bets + 1, win_streak = win_streak + 1 WHERE id = 1", (payout, payout))
        w = conn.execute("SELECT * FROM wallet WHERE id = 1").fetchone()
        best = max(w["best_streak"], w["win_streak"])
        biggest = max(w["biggest_win"], payout)
        conn.execute("UPDATE wallet SET best_streak = ?, biggest_win = ? WHERE id = 1", (best, biggest))
    else:
        bet_row = conn.execute("SELECT amount FROM bets WHERE id = ?", (bet_id,)).fetchone()
        lost_amount = bet_row["amount"] if bet_row else 0
        conn.execute("UPDATE wallet SET total_lost = total_lost + ?, total_bets = total_bets + 1, win_streak = 0 WHERE id = 1", (lost_amount,))
    conn.commit()
    w = conn.execute("SELECT * FROM wallet WHERE id = 1").fetchone()
    bankrupt = False
    if w["balance"] <= 0:
        conn.execute("UPDATE wallet SET balance = ? WHERE id = 1", (BANKRUPT_BONUS,))
        conn.commit()
        bankrupt = True
    final_w = conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
    conn.close()
    return {"balance": final_w["balance"], "bankrupt": bankrupt}


def get_bet_history(limit: int = 50) -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM bets ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [{
        "id": r["id"], "created_at": r["created_at"], "bet_type": r["bet_type"],
        "bet_on": r["bet_on"], "amount": r["amount"], "odds": r["odds"],
        "result": r["result"], "payout": r["payout"],
        "net": (r["payout"] - r["amount"]) if r["result"] == "win" else -r["amount"] if r["result"] else 0,
    } for r in rows]


# --- jackpot ---

JACKPOT_RATE = 0.03  # 3% of every bet goes to jackpot


def get_jackpot() -> dict:
    conn = get_db()
    r = conn.execute("SELECT * FROM jackpot WHERE id = 1").fetchone()
    conn.close()
    if not r:
        return {"pool": 0, "last_hit_amount": 0, "total_hits": 0}
    return {"pool": r["pool"], "last_hit_amount": r["last_hit_amount"] or 0, "total_hits": r["total_hits"]}


def add_to_jackpot(amount: int):
    contribution = max(1, int(amount * JACKPOT_RATE))
    conn = get_db()
    conn.execute("UPDATE jackpot SET pool = pool + ? WHERE id = 1", (contribution,))
    conn.commit()
    conn.close()
    return contribution


def hit_jackpot() -> int:
    conn = get_db()
    r = conn.execute("SELECT pool FROM jackpot WHERE id = 1").fetchone()
    pool = r["pool"] if r else 0
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("UPDATE jackpot SET pool = 0, last_hit_at = ?, last_hit_amount = ?, total_hits = total_hits + 1 WHERE id = 1",
                 (now, pool))
    conn.commit()
    conn.close()
    return pool


# --- streak ---

STREAK_MULTIPLIERS = {0: 1.0, 3: 1.5, 5: 2.0, 7: 3.0, 10: 5.0}


def get_streak_multiplier(streak: int) -> float:
    mult = 1.0
    for threshold, m in sorted(STREAK_MULTIPLIERS.items()):
        if streak >= threshold:
            mult = m
    return mult


def increment_streak(amount: int = 1) -> dict:
    conn = get_db()
    conn.execute("UPDATE wallet SET win_streak = win_streak + ? WHERE id = 1", (amount,))
    w = conn.execute("SELECT win_streak, best_streak FROM wallet WHERE id = 1").fetchone()
    best = max(w["win_streak"], w["best_streak"])
    conn.execute("UPDATE wallet SET best_streak = ? WHERE id = 1", (best,))
    conn.commit()
    conn.close()
    return {"streak": w["win_streak"], "multiplier": get_streak_multiplier(w["win_streak"])}


def reset_streak() -> dict:
    conn = get_db()
    w = conn.execute("SELECT win_streak FROM wallet WHERE id = 1").fetchone()
    old_streak = w["win_streak"] if w else 0
    conn.execute("UPDATE wallet SET win_streak = 0 WHERE id = 1")
    conn.commit()
    conn.close()
    return {"old_streak": old_streak, "streak": 0, "multiplier": 1.0}


# --- parlays ---

def save_parlay(tournament_id: int, amount: int, predictions: list, total_odds: float,
                correct: int, total: int, result: str, payout: int) -> int:
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        "INSERT INTO parlays (created_at, tournament_id, amount, predictions, total_odds, correct, total, result, payout) VALUES (?,?,?,?,?,?,?,?,?)",
        (now, tournament_id, amount, json.dumps(predictions), total_odds, correct, total, result, payout),
    )
    conn.commit()
    pid = cursor.lastrowid
    conn.close()
    return pid


PARLAY_CONSOLATION = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0.5, 5: 1.0, 6: 3.0}


def calc_parlay_payout(correct: int, total: int, amount: int, total_odds: float) -> tuple[str, int]:
    if correct == total:
        return "full_hit", int(amount * total_odds)
    mult = PARLAY_CONSOLATION.get(correct, 0)
    if mult > 0:
        return "consolation", int(amount * mult)
    return "bust", 0


# --- rivalries ---

def update_rivalry(agent_id: int, opponent_type: str, opponent_label: str, result: str):
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    existing = conn.execute("SELECT * FROM rivalries WHERE agent_id=? AND opponent_type=?", (agent_id, opponent_type)).fetchone()
    if existing:
        w = existing["wins"] + (1 if result == "win" else 0)
        l = existing["losses"] + (1 if result == "loss" else 0)
        is_nem = 1 if (l >= 3 and l > w) else 0
        conn.execute("UPDATE rivalries SET wins=?, losses=?, last_match_at=?, is_nemesis=? WHERE id=?",
                     (w, l, now, is_nem, existing["id"]))
    else:
        w = 1 if result == "win" else 0
        l = 1 if result == "loss" else 0
        conn.execute("INSERT INTO rivalries (agent_id, opponent_type, opponent_label, wins, losses, last_match_at, is_nemesis) VALUES (?,?,?,?,?,?,0)",
                     (agent_id, opponent_type, opponent_label, w, l, now))
    conn.commit()
    conn.close()


def get_rivalry(agent_id: int, opponent_type: str) -> dict | None:
    conn = get_db()
    r = conn.execute("SELECT * FROM rivalries WHERE agent_id=? AND opponent_type=?", (agent_id, opponent_type)).fetchone()
    conn.close()
    if not r:
        return None
    return {"opponent_type": r["opponent_type"], "opponent_label": r["opponent_label"],
            "wins": r["wins"], "losses": r["losses"], "is_nemesis": bool(r["is_nemesis"])}


def get_agent_rivalries(agent_id: int) -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM rivalries WHERE agent_id=? ORDER BY is_nemesis DESC, losses DESC", (agent_id,)).fetchall()
    conn.close()
    return [{"opponent_type": r["opponent_type"], "opponent_label": r["opponent_label"],
             "wins": r["wins"], "losses": r["losses"], "is_nemesis": bool(r["is_nemesis"])} for r in rows]


# --- agent records / personal bests ---

def check_and_update_records(agent_id: int, records: dict, match_id: int | None = None) -> list[dict]:
    """Compare records dict against stored. Returns list of new personal bests."""
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    new_bests = []
    for rec_type, value in records.items():
        if value <= 0:
            continue
        existing = conn.execute("SELECT value FROM agent_records WHERE agent_id=? AND record_type=?",
                                (agent_id, rec_type)).fetchone()
        old_val = existing["value"] if existing else 0
        if value > old_val:
            conn.execute("INSERT OR REPLACE INTO agent_records (agent_id, record_type, value, match_id, set_at) VALUES (?,?,?,?,?)",
                         (agent_id, rec_type, value, match_id, now))
            new_bests.append({"record": rec_type, "value": value, "previous": old_val})
    conn.commit()
    conn.close()
    return new_bests


def get_agent_records(agent_id: int) -> dict:
    conn = get_db()
    rows = conn.execute("SELECT record_type, value FROM agent_records WHERE agent_id=?", (agent_id,)).fetchall()
    conn.close()
    return {r["record_type"]: r["value"] for r in rows}


init_db()
