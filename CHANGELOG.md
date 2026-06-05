# Changelog — Product Coherence Pass (2026-06-05)

Goal of this pass: make the features that were built across many sessions feel like **one coherent
product** — not add features. I played the game as a new user, tested cross-system integration seams,
and audited the visual design.

**Method.** Ran the app locally (FastAPI :8000 + Vite :5173) against a fresh DB and drove it through the
real new-user flow in a browser (landing → pick opponent → bet → watch → result, plus mobile). Mapped the
backend (~40 routes, 15 modules) and the frontend↔backend seam with two read-only survey agents, then
**verified every candidate issue against the actual code or the running app before changing anything** —
several flagged "bugs" were false positives and were corrected, not patched.

**Scope note.** This is a live, real-money-adjacent app, so fixes were kept high-confidence and low-risk.
Lower-confidence or higher-risk findings are documented below as **Deferred** with rationale rather than
changed blind. Every fix was verified (see each entry).

---

## UX — new-user confusion

**Fixed**

1. **Stale "How it works" copy.** It read *"Pick two AI agents… personality: aggressive, defensive,
   reckless, calculated… Hit GO."* But VS BOT picks one agent + an opponent (not two), there are **5**
   sliders (not those 4 adjectives), and there is no button literally labeled "GO". Rewrote all three
   steps to match reality (pick agent → choose opponent / Sandbox, 5 named sliders, optional bet → watch).
   `frontend/src/App.jsx` (help panel). *Verified live: new copy renders.*

2. **Unclear "start match" affordance.** After choosing an opponent, the only way to start *without*
   betting was a button labeled **"SKIP"** sitting beside BET RED/BLACK/DRAW — it reads as "skip betting,"
   not "start the match." Relabeled to **"WATCH ▶"** with a `title="Start the match without betting"`
   tooltip. `frontend/src/App.jsx`. *Verified live: button shows "WATCH ▶" and starts the match.*

3. **README badly out of date.** Listed **3** of the **5** sliders, **4** of the **42** API routes, **4** of
   the **6** presets, and a "next steps (ideas)" list whose items (ELO, multiplayer, tournaments, on-chain
   prizes, extra sliders, shrinking board) are **all already shipped**. Rewrote `README.md` to describe the
   actual product, modes, stack, progression, two-economy betting, and a correct API summary. *(The
   `engine.py` reference it contained is correct and was kept.)*

4. **Missing `CLAUDE.md`.** The project had no `CLAUDE.md` despite tasks referencing "read CLAUDE.md for
   context." Added one: architecture, run/deploy instructions, the two-economy rule, progression model, and
   gotchas — so future work starts coherent.

**Deferred (documented)**

- **Roster/coach name overlap.** Preset agents **"Shark"** and **"Wall"** collide conceptually with coaches
  **"The Shark"** and **"The Fortress"**. Mild; presets are seeded archetypes. Rename in a follow-up.
- **Empty board on mobile.** Before a match starts, the full-size board still renders, pushing content far
  down on a 375px screen. Intentional "stable board container," so left as-is; consider collapsing it
  pre-match on mobile.

---

## Bugs — features built separately not connecting

**Fixed**

1. **Match result showed "BLACK wins" instead of the opponent's name** (vs-bot and Mirror).
   `App.jsx:2291` used `result.black_agent?.name || "BLACK"`, but for bot/Mirror matches `black_agent` is
   `null` and the opponent's name lives in `result.bot_opponent.name` (the result panel already used that
   field). Added the fallback: `black_agent?.name || bot_opponent?.name || "BLACK"`. *Verified: logic check
   across all branches → bot-win renders "Reckless Blaze wins", sandbox renders the black agent's name, red
   renders the red name, draw renders "DRAW".*

2. **Mirror "series record" was a broken placeholder.** `mirror.py:228` built
   `f"You {total_bouts - sum(1 for _ in [] if True)} - ? Mirror"` — `sum(... [] ...)` is always 0, so it
   printed *"You {total_bouts} - ? Mirror"* (total bouts mislabeled as wins; a literal "?" for the Mirror).
   Now derives real counts from the profile: `mirror_wins = round(win_rate × total)`, `player_wins = total −
   mirror_wins`. *Verified: `generate_mirror_agent()` returns "You 0 - 0 Mirror" on a fresh profile, no "?".*

3. **Dead/misleading guard in prop-odds.** `main.py:1523` had
   `calculate_prop_odds(rc, bc, red_perk if 'red_perk' in dir() else None, …)`. `red_perk`/`black_perk` are
   always in local scope there, so the `in dir()` guard was pointless cruft that *looked* like it might pass
   `None`. Simplified to pass the perks directly. *Verified: parses; prop bets resolve correctly (below).*

**Verified NOT a bug (false positives from the automated survey — corrected, not patched)**

- *"Mirror response reads `strategy_description` but the dict only sets `tendencies_exploited`."* — Both keys
  are set (`mirror.py:224-225`) and both are read (`main.py:1387-1388`). No bug.
- *"`/api/bets/tournament-settle` doesn't feed the jackpot."* — It does (`jackpot_add` accumulates and writes
  to the `jackpot` table). No bug.
- *"Streak multiplier is computed but unused / stale doc."* — Intentional: the streak payout multiplier was
  removed in the prior economy-fix task (it reversed the house edge); the table is retained **display-only**
  with a guardrail comment. Working as intended.
- *"`/api/wallet`, `/api/history`, `/api/jackpot` response shapes unclear."* — Verified against
  `database.py`: `get_wallet()` returns `balance`/`win_streak`, `get_jackpot()` returns `pool`,
  `get_matches()` returns the array the frontend iterates. All match.

**Deferred (documented — real cross-mode wiring gaps, no wrong output, higher-risk to wire)**

- **Tournaments don't accrue progression.** 1v1 and 2v2 tournament matches don't run evolution/familiarity,
  don't set personal **records**, and don't update **rivalries** (those only fire in single vs-bot matches).
  This appears intentional (tournaments use ephemeral ELO snapshots), produces no incorrect output, and
  wiring it touches the complex bracket sim loop — deferred to avoid regressions. Listed here so it's tracked.
- **Multiplayer familiarity never decays.** `ws.py` updates familiarity but never calls `decay_familiarity()`
  (single-player does, every 50 matches), so multiplayer agents slowly over-train. Low impact; deferred.
- **`/api/suggest-names` is dead.** The frontend generates names locally (`localSuggestNames`) and never calls
  it. Harmless; remove or wire up later.

---

## Visual — consistency

**Fixed**

1. **Nav tab bar overflowed on mobile.** At 375px the MATCH/TOURNAMENT/MULTIPLAYER/TAG TEAM row had no wrap
   and clipped against the screen edge (first tab flush to x=0, "TAG TEAM" broken). Added `flexWrap: "wrap"`
   to the nav container (`App.jsx:2061`). *Verified live at 375px: tabs wrap to two centered rows, no clipping.*

2. **Type-scale outlier.** The roster ELO used a one-off `fontSize: 13` (`App.jsx:1024`) where every other
   prominent number uses 14/16. Normalized to 14. *Verified live.*

**Audited & documented (left as-is to avoid visible regressions; recommended for a token pass)**

- **Color palette.** 73 distinct hex literals *sounds* chaotic, but ~half are **intentional**: alpha variants
  of one base (e.g. `#ffd700` + `#ffd70022/33/44/66`) and gradient end-stops (e.g. `#2ecc71 → #27ae60`,
  `#9b59b6 → #8e44ad`). The real base set is ≈ **16 accents + 9 backgrounds + 10 text grays**. The only
  genuine redundancy is a handful of near-duplicate text grays — `#6b7280`, `#8b949e`, `#95a5a6` ≈ `#8892a0`,
  and `#bdc3c7` ≈ `#c8d0da` (≈19 uses total). Left unmerged because the slight differences encode emphasis
  levels and a blind merge risks visible shifts. **Recommendation:** extract a small named token set
  (`bg.0/1/2`, `text.dim/muted/bright`, semantic accents) and migrate over a dedicated pass.
- **Type scale.** 12 sizes in use (6,7,8,9,10,11,12,13,14,16,18,20). Removed the 13. Heavy **6–8px** text is a
  readability concern, especially on mobile; not bulk-bumped here (layout risk). Recommend collapsing to a
  ~6-step scale (e.g. 8/9/10/12/14/16/20) in a follow-up.
- **Border radius** varies (3/4/6px) across similar buttons/cards. Recommend one radius token.

---

## Performance

**Fixed**

1. **Loop-invariant recomputation in prop settlement.** `main.py` rebuilt `red_cfg.to_dict()`,
   `black_cfg.to_dict()`, and called `calculate_prop_odds(...)` **inside** the `for pb in req.prop_bets` loop,
   though all three are identical every iteration. Hoisted them out (compute once). *Verified: a 2-prop match
   still settles both props correctly (first_blood:red → win, total_moves_ou:over → loss), no errors.*

**Audited — clean**

- Only **one** polling `setInterval` (online count, 10s) and it's cleaned up properly (`clearInterval` on
  unmount). The remaining timers are match-playback animation (`setTimeout` chains) — no leak observed.
- Frontend bundle ~277 KB (77 KB gzip) — fine for this app.

---

## Verification summary

| Area | How verified |
|---|---|
| Help copy, WATCH button, nav wrap, ELO size | Live in browser at desktop (1280) and mobile (375) |
| Winner-name fix | Branch logic check (bot / sandbox / red / draw) + live red-win render |
| Mirror series_record | Unit call to `generate_mirror_agent()` → clean "You N - M Mirror" |
| Prop-odds hoist | Live API match with 2 prop bets → both resolve, no error |
| Backend changes | `ast.parse` of `main.py` + `mirror.py`; frontend `npm run build` clean |

## Files changed

- `frontend/src/App.jsx` — help copy, WATCH label, winner name, nav `flexWrap`, ELO font size
- `backend/main.py` — prop-odds hoist + guard cleanup
- `backend/mirror.py` — series_record
- `README.md` — accurate rewrite
- `CLAUDE.md` — new (project context)
- `CHANGELOG.md` — this file

## Deploy

Railway deploys via `railway up` (manual; **not** GitHub auto-deploy) — documented in `CLAUDE.md`.
