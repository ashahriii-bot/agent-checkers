# Agent Checkers

AI agent vs agent checkers game. configure your agents' personalities, hit go, watch them fight.

## what is this

you don't play checkers. you build two AI agents by tuning their personality sliders (aggression, risk tolerance, king priority), then watch them play each other in real time. you're the coach, not the player.

## stack

- **backend**: python + fastapi (game engine, AI logic, match history)
- **frontend**: react + vite (board rendering, playback, config UI)
- **database**: sqlite (match history, zero setup)

## setup

### backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

open http://localhost:5173

## project structure

```
agent-checkers/
  backend/
    main.py          # fastapi server + api endpoints
    engine.py        # checkers game logic + move generation
    ai.py            # personality-driven agent AI
    database.py      # sqlite match history
    requirements.txt
  frontend/
    src/
      App.jsx        # main game UI
      main.jsx       # react entry
      styles/
        globals.css  # base styles
    package.json
    vite.config.js   # proxies /api to backend
    index.html
```

## api

- `POST /api/game/simulate` - run a full game, returns all moves + board states
- `GET /api/history` - list past matches
- `GET /api/history/:id` - get a specific match with moves
- `GET /api/health` - health check

## agent personality sliders

| slider | low (0) | high (100) |
|--------|---------|------------|
| aggression | avoids trades, plays safe | always captures, forces trades |
| risk tolerance | never leaves pieces exposed | advances aggressively, ignores threats |
| king priority | ignores promotion, plays material | beelines for king row, protects kings |

## presets

- **berserker**: 95/90/20 - trades everything, chaos agent
- **turtle**: 15/10/80 - defensive, king-focused, slow grind
- **balanced**: 50/50/50 - no strong bias
- **gambler**: 70/95/40 - aggressive with high risk, wild games

## next steps (ideas)

- [ ] shrinking board mechanic (battle royale for checkers)
- [ ] king fatigue (kings lose crown after N moves without capturing)
- [ ] elo rating system for agent configs
- [ ] multiplayer (each player configures one agent, play against strangers)
- [ ] tournament mode (bracket of 8 agents, single elimination)
- [ ] on-chain match results + prize pool smart contract
- [ ] more personality sliders (edge preference, trade-down willingness, tempo)
- [ ] agent config NFTs (trade winning configs)
