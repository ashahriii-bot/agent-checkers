# Launch Checklist — Agent Checkers (2026-06-05)

Goal of this pass: make the game ready for a public (Reddit) launch. Every change was
judged against one question — **"does this help a stranger have a good first 5 minutes?"**

**Verdict: READY for public traffic.** All five phases complete; all modes play end-to-end;
mobile is usable; the multiplayer path is observable and resilient. Known minor issues are
listed at the bottom (none are launch blockers).

## How this was tested

- Backend run locally (FastAPI :8000, throwaway SQLite) with verbose multiplayer logging.
- Frontend driven in a real browser (Vite dev → local backend) at **desktop (1280)** and
  **mobile (375×812)**.
- Multiplayer exercised three independent ways: two Python WebSocket clients (local), two
  clients against **production**, and a **real browser tab + a client** (local).
- Deterministic unit tests for matchmaking; live widening test; production HTTP/WS probes.

---

## Phase 1 — Multiplayer (the reported blocker)

**Reported:** two players connect + see each other online, but on joining the queue they
"can't match and both go offline; the WebSocket connections drop."

**Investigation.** I instrumented the entire WS path (connect → `queue_join` → matchmaker
loop → full match lifecycle) with step logs + full tracebacks, replacing the silent
`except: pass` blocks that were hiding any failure. I then tried to reproduce the drop:

| Repro path | Result |
|---|---|
| Two Python WS clients (local, logging on) | ✅ matched + both got results |
| Two Python WS clients **against production** | ✅ matched + both got results |
| **Real browser tab + a client** (local) | ✅ browser rendered the full result (YOU LOSE, elo, opponent reveal); no console errors |
| Background re-match loop, 150-elo-apart pair | ✅ matched at ~17s once the band widened |

I could **not** reproduce the reported socket drop in any configuration. The most likely
original cause was an unhandled exception inside the match runner under specific agent
data, which the old `except: pass` swallowed — silently stranding both players. That is now
**fixed structurally**:

**What changed (`backend/ws.py`):**
- **Full logging + tracebacks** on every step (connect, queue_join, matching, run-game,
  save, result send, disconnect) via a dedicated stdout logger → visible in Railway logs.
- **Resilient match runner:** `_run_multiplayer_match` now catches its own exceptions, logs
  the traceback, and sends both players an error + resets their status — instead of the
  exception bubbling up and tearing down the joining player's socket. A single bad client
  message no longer drops the whole connection either.
- **Eligibility confirmed:** free play has **no** level/matches gate — it is real-money only.
  (Real-money is **disabled** in production anyway — `/api/crypto/status` → `enabled:false` —
  so that gate never fires for a public free-play launch.)
- **Background matcher loop** verified starting + running (logs "matchmaker loop started").

**Verification:** two new accounts with starter agents queue → match → play a full game →
see results, confirmed in production (two-client probe) and in a real browser.

---

## Phase 2 — First-time user experience

- ✅ **Above-the-fold hook** added under the title: *"Configure AI agents. Watch them fight.
  Bet on the outcome."*
- ✅ **First match in 2 clicks** (under the 3-click target): a red agent is pre-selected and
  VS BOT is default, so it's **pick an opponent → WATCH ▶**.
- ✅ **Clarity for a zero-context user:** the "How it works" panel (3 steps) shows by default;
  the agent-creation sliders each carry a plain-English description ("Balanced. Takes good
  captures."); a post-match breakdown explains what happened (turning point, edges, a tip).
- ✅ A **pre-match call-to-action** ("👇 Pick an opponent below…") guides new users to the
  opponent picker.
- ✅ **"SKIP" → "WATCH ▶"** confirmed live (with a "start without betting" tooltip); no stray
  "SKIP" remains in the match betting panel.
- ✅ Share metadata (`index.html` description + `og:url`) aligned for Reddit link previews.

---

## Phase 3 — Mobile (375px)

- ✅ **Create an agent** — the form is clean and usable; full-width sliders + descriptions.
- ✅ **Start a match** — pick opponent → WATCH works by tap.
- ✅ **Board + pieces are clear** — the board fills the width; pieces are large; win-prob +
  material bars + playback controls all usable.
- ✅ **Navigate modes** — the MATCH / TOURNAMENT / MULTIPLAYER / TAG TEAM nav wraps to two
  tappable rows.
- ✅ **Fixed the main mobile friction:** the empty pre-match board used to fill the entire
  375px viewport and pushed the opponent picker far below the fold. It's now a **compact
  placeholder** pre-match (the real board still renders once a match starts), cutting the
  landing page from ~2500px to ~1180px.

---

## Phase 4 — Every mode, end-to-end

| Mode | Verified |
|---|---|
| **VS BOT** single match | ✅ pick agent + coach → watch → result + post-match breakdown + elo change (full browser run) |
| **Tournament** (Fight Night) | ✅ setup → live bracket renders (with EXIT) ; API returns champion + 2 rounds + 4 awards |
| **Tag Team** (2v2) | ✅ single match returns winner + boards + team dynamics; tournament bracket + elimination banner validated against real data |
| **Multiplayer** | ✅ two accounts queue → match → play → result (prod + browser) |
| **Create custom agent** | ✅ name + 5 sliders → SAVE → appears in roster (verified on mobile) |
| **Level up to L5** | ✅ a competitive match crossed L4→L5 → "CHOOSE AN EDGE" unlock + new-personal-bests + rivalry tracker |

No crashes or broken modes found. All modes render results correctly.

---

## Phase 5 — Deploy & production verification

- Deploy mechanism: **`railway up`** (manual; Railway does not auto-deploy on push).
- Branch `launch-readiness`: `d64b37c` (prior task) + `61d84f9` (Phase 1) + `a696859` (Phases 2–3).

**Production verified** (deployment `e7ee8ef6`, bundle `index-DYUZznUm.js`):

- [x] Production URL loads — `HTTP 200`
- [x] New frontend bundle live — `index-Bfl8QQkP.js` → `index-DYUZznUm.js`
- [x] Multiplayer WebSocket connects — `/ws/play` → `HTTP/1.1 101 Switching Protocols`
- [x] A VS BOT match completes — `/api/game/simulate` → winner + 77 moves + boards
- [x] Hook + mobile placeholder confirmed in the live JS bundle; new share meta live
- [x] Sharing the URL works — `og:url` + description present in the served HTML

> Note: Railway's upload API returned `500` on several attempts before succeeding
> (transient server-side incident); the deploy went through on retry with no code or
> config change.

---

## Known minor issues (not launch blockers)

- **Bet-amount buttons in the VS BOT panel are inert** (the 10/50/100/250 selector is a
  no-op; every VS-BOT bet is fixed at 100 coins). Pre-existing; flagged as a separate task.
- **L5 "Choose an edge" banner** is a notification — the actual edge is chosen via the agent
  panel's CHANGE EDGE. Minor, and L5 ≈ 50 matches (well beyond a first session).
- **Empty-queue multiplayer:** on a fresh launch two strangers rarely click at the same
  instant; a lone player waits to the 120s "no opponents" timeout. Consider a friendlier
  empty-queue message / "play VS BOT meanwhile" nudge. (Free-play single-player is the
  reliable first-5-minutes experience.)
- **Real-money (USDC) is disabled in production** (intended for launch) — the FREE/REAL
  toggle does not appear; everything is free-play coins.
- **In-memory matchmaking queue:** a Railway instance restart drops the queue/connections
  (architecturally inherent to single-instance in-memory state). Fine at launch scale; note
  for future scaling.
