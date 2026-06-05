# Agent Checkers

AI agent vs agent checkers. You don't move pieces — you tune two AI personalities, then watch them fight. You're the coach.

## What is this

You build agents by tuning **5 personality sliders**, pick an opponent (a coach bot, the adaptive Mirror, or another of your agents), optionally bet on the outcome, then watch a minimax-style match play out move by move. Agents earn ELO, level up, evolve, and unlock edges over time.

## Modes

- **Match** — your agent vs a **coach bot** (VS BOT) or another of your agents (SANDBOX). Bet on the winner and place side props.
- **Tournament** — a 4- or 8-agent single-elimination bracket with champion bets, parlays, and a jackpot.
- **Multiplayer** — live PvP: two players each bring an agent and watch them clash (free-play, or real USDC).
- **Tag Team (2v2)** — two agents per side play by **consensus**; a diverse pair sharpens decisions.

## Stack

- **backend**: Python + FastAPI — game engine, AI, betting/economy, progression, match history (`backend/`, ~15 modules)
- **frontend**: React + Vite — board rendering, playback, config UI (`frontend/src/App.jsx`, inline-styled dark theme)
- **database**: SQLite (WAL), zero setup; persists on a Railway volume in prod
- **deploy**: multi-stage Docker (Node build → Python runtime) on Railway via `railway up`

## Setup

### backend
```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### frontend (new terminal)
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173 (Vite proxies `/api` → `:8000`).

## Project structure

```
agent-checkers/
  backend/
    main.py         # FastAPI app + ~40 REST routes
    engine.py       # checkers rules + move generation
    ai.py           # personality-driven move evaluation, perks/edges
    database.py     # SQLite: agents, matches, wallet, betting, progression
    team.py         # 2v2 consensus + diversity
    coaches.py      # bot-opponent archetypes
    mirror.py       # adaptive "Mirror" AI
    props.py        # side-bet props
    evolution.py    # adaptive slider drift
    familiarity.py  # matchup experience
    matchmaking.py  # multiplayer queue
    ws.py           # multiplayer WebSocket + USDC pot-split
    crypto.py / auth.py / privy_auth.py   # real-play (USDC on Base) + accounts
  frontend/
    src/App.jsx     # entire UI
    vite.config.js  # proxies /api → backend
  Dockerfile, railway.toml
```

## Agent personality sliders

| slider | low (0) | high (100) |
|--------|---------|------------|
| aggression | avoids trades, plays safe | always captures, forces trades |
| risk tolerance | never leaves pieces exposed | advances aggressively, ignores threats |
| king priority | plays material, ignores promotion | beelines for the king row |
| edge affinity | plays the center | hugs the edges, builds walls |
| trade down | preserves every piece | forces trades when ahead |

## Presets

berserker · turtle · balanced · gambler · wall · shark — starter archetypes you can play as-is or clone and tweak.

## Progression

Agents gain 1 XP per competitive match (level cap 25). Edges unlock with level: basic perks at **L5** (Counter / Surge / Frenzy), mid-game edges at **L15** (Anchor / Phantom), veteran edges at **L25** (Siege / Flux). Sliders also drift slightly over time (evolution), and agents build matchup familiarity against opponent archetypes.

## Betting economy

Free-play coins, variable-odds sportsbook: a flat **5% house edge** on every matchup, side props, and a jackpot fed by turnover. The hot-streak counter is **visual only** (no payout multiplier — see `docs/ECONOMY_AUDIT.md`). Real-money multiplayer (USDC) settles as a **5% pot split** with no counterparty risk.

## API

~40 REST endpoints under `/api` plus a `WS /ws/play` multiplayer socket. Highlights:

- `POST /api/game/simulate` — run a 1v1 or 2v2 match (returns every board state + moves + bet/prop settlement)
- `POST /api/tournaments` · `POST /api/tournaments/team` — bracket play
- `GET /api/coaches` · `GET /api/edges` · `GET /api/leaderboard` · `GET /api/history`
- `GET /api/odds/match` · `GET /api/odds/props` · `GET /api/wallet` · `GET /api/jackpot`
- agent CRUD under `/api/agents`

Run the server and open `/docs` for the full interactive OpenAPI spec.
