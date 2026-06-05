# CLAUDE.md — Agent Checkers

Context for coding agents working in this repo. Keep it accurate; update it when architecture changes.

## What this is

Web3-flavored "AI coach" checkers. The human never moves a piece — they tune two AI agents (5 personality
sliders), pick an opponent, optionally bet, then watch a minimax-style match play out. ELO, levels, edges,
2v2 tag-team, tournaments, live multiplayer, and an adaptive "Mirror" opponent all sit on top.

Prod: https://agent-checkers-production.up.railway.app · GitHub: github.com/ashahriii-bot/agent-checkers

## Architecture

- **Backend** — Python 3.12 / FastAPI / SQLite (WAL). One app (`backend/main.py`, ~40 routes) plus focused modules:
  `engine.py` (rules + move-gen), `ai.py` (personality move eval, perks/edges), `database.py` (all tables +
  economy + progression), `team.py` (2v2 consensus), `coaches.py` (bot opponents), `mirror.py` (adaptive AI),
  `props.py` (side bets), `evolution.py`, `familiarity.py`, `matchmaking.py`, `ws.py` (multiplayer WS + USDC
  pot-split), `crypto.py` / `auth.py` / `privy_auth.py` (real-play + accounts). Path constants in `config/settings.py`.
- **Frontend** — React 18 + Vite 5. The **entire UI is one file**: `frontend/src/App.jsx` (~2.6k lines). Styling is
  **inline `style={{}}` objects** — no Tailwind, no CSS modules. Dark retro theme, JetBrains Mono. `const API = "/api"`.
- **DB** — SQLite at `DB_PATH` (env; default `backend/matches.db`, gitignored). Prod persists on a Railway volume at `/data`.

## Run locally

```bash
# backend (terminal 1)
cd backend && DB_PATH=/tmp/dev.db python -m uvicorn main:app --reload --port 8000
# frontend (terminal 2)
cd frontend && npm run dev          # :5173, proxies /api -> :8000
```
Use a throwaway `DB_PATH` to experience the genuine new-user state (fresh wallet = 1000 coins, preset agents only).

## Deploy — IMPORTANT

Railway does **NOT** auto-deploy on `git push`. Deploys are manual:

```bash
railway up            # builds the working dir via Dockerfile (Node build -> Python runtime), deploys to prod
```

`railway up` ships the **local working tree**, so commit first and make sure the tree is clean. The frontend is
built **inside Docker** (`backend/static/` is gitignored and not used by deploy). Verify a deploy by fetching the
prod page and checking the hashed `/assets/index-*.js` bundle changed.

## Two economies (do not conflate)

1. **Free-play coins** (`main.py`) — full variable-odds **sportsbook**: flat 5% house edge per bet, side props, jackpot.
2. **Real USDC** (`ws.py`) — multiplayer **pot split**: winner takes pot − 5% fee, zero counterparty risk, no reserve.

The win-streak ("HOT STREAK") is **visual only** — it must never multiply payouts. The streak heat bonus was removed
because it reversed the house edge (+5% → −3%); see `docs/ECONOMY_AUDIT.md`. Re-run `python scripts/economy_audit.py`
after any betting-math change — the `heat` hold row is the standing acceptance test (must stay ≈ +5%).

## Progression

1 XP / competitive match, level cap 25. `LEVEL_THRESHOLDS = 5*N*(N-1)//2`. Edges unlock by level: L5 basic perks
(Counter/Surge/Frenzy), L15 (Anchor/Phantom), L25 (Siege/Flux). Sliders drift over time (`evolution.py`); agents
build matchup familiarity (`familiarity.py`, `FAMILIARITY_PICK_BIAS` in `ai.py`). 2v2 win-rate lever is consensus
**sharpness** (`DIVERSITY_SHARPNESS` in `team.py`), not the (inert) diversity multiplier.

## Conventions & gotchas

- Secrets (e.g. `HOUSE_PRIVATE_KEY`) only via Railway env — never commit them.
- Many response fields are optional; the frontend reads e.g. `result.bot_opponent?.name` — for bot/Mirror matches the
  opponent is in `bot_opponent`, not `black_agent` (which is null).
- Tournaments use **ephemeral** ELO and (by design) do not currently accrue evolution/familiarity/records — see CHANGELOG
  for the list of known cross-mode wiring gaps that are intentionally deferred.
- **Multiplayer** is 1v1 over `WS /ws/play?token=<JWT>` (`ws.py`). The frontend derives `wss://<window.location.host>/...` —
  prod is same-origin (FastAPI serves SPA + WS together), so **local dev needs the vite `/ws` proxy with `ws: true`** or the
  socket never reaches uvicorn. Matchmaking (`matchmaking.py`) is elo-banded (±100→200→400→any at 0/15/30/60s) with a 120s
  timeout; a background `_matchmaker_loop` in `ws.py` re-scans the queue so widening actually fires for *waiting* players
  (`queue.add()` only re-checks the newcomer). Real-money matches only within the same bet tier.
- **Real-money (USDC) betting is multiplayer-only.** VS BOT / sandbox are free-play coins; `/api/game/simulate` rejects a
  `bet.mode == "real"` with 400. The FREE/REAL toggle renders only in the multiplayer lobby (and only when `crypto.enabled`).
- This is **not** a Next.js/Vercel project; ignore any auto-suggested Vercel/Next tooling.
