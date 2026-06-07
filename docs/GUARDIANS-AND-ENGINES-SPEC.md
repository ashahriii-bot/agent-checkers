# Pilots & Guardians — Master Design Specification

**Author:** Creative Director
**Status:** Build-ready master spec. All future Arena development follows this document.
**Supersedes / incorporates:** `docs/AGENT-IDENTITY-SPEC.md` (which specced Proposals 1 & 2 in depth). That doc's fine-grained UX mechanics are carried forward by reference; where this master doc changes a decision (terminology, budget number), **this doc wins.**
**Grounded in:** a full read of `arena_engine.py`, `arena_species.py`, `arena_ai.py`, `arena_props.py`, `arena_balance_sim.py`, `ai.py`, `evolution.py`, `familiarity.py`, `database.py`, `main.py`, `ws.py`, `matchmaking.py`, `Arena.jsx`, `Arena3D.jsx`. Every number below is the real value in code unless marked **NEW** or **CHANGE**.

> **Codename note:** the file is `GUARDIANS-AND-ENGINES-SPEC.md` per the original brief. The shipped terminology is **Pilot / Guardian** (§1) — "Engine" is rejected. The filename is left as the codename; do not surface "Engine" in product.

---

## 0. Executive summary — the seven proposals, judged

The brief's core identity shift is **correct and is the spine of the product**: the thing the player authored, owns, evolves, and bets on is the AI personality — not the body it wears. Everything here serves that. But four of the seven proposals contain factual errors against the codebase, and three are net-new systems with no backing data model. Verdicts:

| # | Proposal | Verdict | The decisive reason |
|---|---|---|---|
| **P1** | Point budget for sliders | **KEEP, re-tuned** | Trade-offs = identity is right. But 250/max-90 doesn't bite, and the real hole is the **missing arena overextension penalty** (it exists only in checkers). → **200 / min 5 / max 80 + port overextension to the arena.** Evolution stays per-slider (zero-sum reallocation homogenizes toward all-50). |
| **P2** | "The brain is the star" | **KEEP, hardened** | Right diagnosis. But a **3-line label over every body is illegible on mobile** (there is zero 3D text today and the canvas is ~289px tall on a phone), the **0.3s radar pentagon reads as noise and often lies** (the AI picks weighted-random among near-best), and a **3–4s ceremony every match kills the real-money loop**. All three are fixable (§6). |
| **P3** | Series (Bo1/3/5) | **KEEP, deferred to R2** | Great for variance/comebacks. **No series/best-of data model exists anywhere** — this is greenfield backend. Default **Bo3**; Bo5 = high-stakes only. |
| **P4** | Pilot swapping between games | **KEEP, deferred to R2** | Strong depth. **Hard-blocked by unenforced ownership** — `create_agent` never sets `player_id`; `get_agents` returns all agents globally. Ownership is a prerequisite. |
| **P5** | Death = benched for series | **KEEP, rewritten, ships LAST, opt-in** | The headline idea, but the raw rule is a **feel-bad snowball**: elimination (~60% of wins) damages the *winner* too, while breach/ring-out (~40%) preserves the roster → rewards cheese. Razorwing's **1.7% solo survival** makes "best Pilot on the tank" a *solved* deployment. → **loser-only benching**, opt-in "Survival Series," after P6 fixes Razorwing. |
| **P6** | Razorwing Swoop range limit | **KEEP, corrected** | Premise true, **fix wrong.** On the real radius-2 board, start-distance is 4 and melee needs adjacency (a **3-hex move**) — so a 3-hex cap (and even SPD-3) still kills turn 1. And both Razorwings share the top SPD bucket → **simultaneous** resolution, so "1 turn to react" is a no-op in the mirror. → **cap Swoop reach at 2 + make it a 2-phase commit; keep printed SPD 4.** |
| **P7** | Ability upgrades in lobby | **KEEP — ~80% already built** | `SPECIES_UPGRADES` already exists and **exactly matches** the L5/L15/L25 tiers in the brief (Iron Will / Bulwark Aura / Final Detonation, etc.). Missing only the **UI selector + level-lock + inline effect text.** Cheapest win on the board. |

**The single most important correction:** the brief's ability list (Counter, Surge, Frenzy, Anchor, Phantom, Siege, Flux) is from the **wrong game** — those are *checkers* edges (`ai.py` `EDGE_DEFINITIONS`). The Arena's real abilities are **Swoop, Provoke, Blast, Displace, Glitch, Bulwark Pulse, Channel/Breach** + the per-species upgrades. Never reference checkers edges in Arena design.

**The single biggest economic risk:** P5 death-benching makes Game 2/3 **structurally predictable** (after Game 1 the surviving-roster delta is largely known), and **every** proposed series market is correlated to it. The static marginal prop models (`arena_props.py`) cannot price that. Series betting requires a new **lineup-conditional pricer** and a new standing audit (§7).

**Build order in one line:** Foundations (ownership + arena bet hardening + arena→Pilot write-back) → **R1: P6, P1, P7, P2** (all single-match, ship independently) → **R2: P3+P4** (series + swapping) → **R3: P5** (Survival Series, opt-in). Full detail in §11.

---

## 1. Terminology & identity system

### 1.1 The decision

| Concept | **Shipped term** | Was (brief) | Was (code / prior doc) | Why |
|---|---|---|---|---|
| The AI personality you build, own, tune, evolve, bet on | **PILOT** | "Engine" | "agent" | "Engine" is fatally overloaded in an AI board-game (the "checkers engine"), and an engine is a *component inside* a machine — which fights the whole thesis that the brain is **separable** and **deployed into rental bodies**. A **Pilot** boards, controls, and can leave one body for another. It is also the prior doc's *own* metaphor ("the agent is the pilot"), now made literal. Unambiguous; bet-relevant; IP-clean. |
| The holographic combat body (one of 5 species) | **GUARDIAN** | "Guardian" | "creature" / "chassis" | Adopt the brief's word — it fits the **fantasy holographic beasts** (Ironjaw, Razorwing…) far better than "Mech"/"chassis," which imply machinery. PILOT + GUARDIAN reads cleanly as controller + controlled. |
| The 5 species | **Guardian species** | — | species | Ironjaw, Razorwing, Embercaster, Warden, Hexwright. |
| The build's archetype | **Temperament** | "temperament" | `derive_temperament()` (already exists) | Keep. 7 temperaments (§2.4). |

**Rejected:** "Engine" (overloaded, anti-thesis), "Mech"/"Chassis" for the body (the bodies are beasts, not machines). **Runner-up if brand objects to "Pilot":** MIND / BODY (clean, pairs with temperament-as-the-Mind's-personality). Do **not** use Driver/Machine ("driver" collides with software drivers).

**One-line definition surfaced on first use:** *"Pilots are the AIs you tuned — they decide every move. You can't. Guardians are the bodies they fly."*

### 1.2 The Identity Stack (carried from `AGENT-IDENTITY-SPEC.md` §0, retitled)

A Pilot becomes a *character* through four things, all already half-present in code:

1. **NAME** — build-derived, player-editable (`suggest_names()` exists; surface it live).
2. **TEMPERAMENT** — the archetype the build resolves to (`derive_temperament()`, thresholds 65/35).
3. **SILHOUETTE** — the radar pentagon of the 5 sliders; the *same* shape in create → watch → results.
4. **RECORD** — persistence: the Pilot survives the match, accrues W/L + kills + evolution, redeploys. **A one-match Pilot cannot be loved.**

The Pilot's **accent color** = `TEMPERAMENT_COLORS[temperament]` and its **sigil** = its radar shrunk to 16px. One color, one shape, everywhere. (Full mechanics: `AGENT-IDENTITY-SPEC.md` §4.A — carried forward unchanged except "agent"→"Pilot", "creature/chassis"→"Guardian".)

---

## 2. Pilot personality & the point budget (P1)

### 2.1 The shared-config reality (read before building)

There are **two 5-slider systems sharing one stored row.** The DB `agents` table stores 5 ints under *checkers* names: `aggression, risk_tolerance, king_priority, edge_affinity, trade_down`. The Arena **remaps** them (`ws.py:577-579`): `king_priority→target_focus`, `edge_affinity→positioning`, `trade_down→sacrifice`. Only `aggression`/`risk_tolerance` keep their meaning across both games.

**Decision:** the budget governs the **single shared config**. A Pilot is *one* personality across the whole product (this is the identity thesis, and the constraint "same Pilots carry over from Agent Checkers" demands it). **Implication:** this is a balance change to **both** games, so both standing audits must re-run before ship (§2.6). *(Open alternative in §12 if stakeholders want Arena-only sliders.)*

### 2.2 Budget mechanics — exact numbers

- **Total = 200, conserved exactly** (`sum(sliders) == 200 ± 1 rounding`). **CHANGE** from the prior doc's 250.
- **Per slider: min 5, max 80.** **CHANGE** from 10/90.
- **New-Pilot default = 40 × 5 = 200** (a valid, neutral centroid → derives ADAPTIVE temperament). **CHANGE** from 50×5.
- **Why these numbers (verified):** at 250/max-90 the floor is 50, leaving 200 discretionary — you can run **90/90** and still fund three dimensions, so the "trade-off" never bites; aggression is the dominant lever on the dominant (elimination ≈60%) win condition. At 200/min-5/max-80, maxing two sliders (75 over floor each = 150 of 175 discretionary) leaves only ~25 for the other three — maxing one dimension now *forces* a real sacrifice. Max 80 still clears the temperament `SLIDER_HIGH=65` threshold, so all 7 temperaments still trigger.
- **The number is provisional until the sim confirms it.** Per the prior doc's own gate: re-run `arena_balance_sim.py` + `arena_props_audit.py`; if the field collapses to 2-stat specialists or any species win-rate exits 45–55%, retune the total in the 180–220 band. Ship the **mechanism** at 200; treat the exact value as a tuning constant.

### 2.3 The real fix — arena overextension term (**NEW, non-negotiable**)

The budget alone does **not** fix aggression dominance, because **the Arena has no overextension counterbalance** — `calc_overextension_factor` exists only in checkers `ai.py` (when `agg>70 AND risk>70` it *punishes* greedy capture over-valuation). `arena_ai.py` has the opposite: the landing-danger penalty is `danger * (1.5 − risk)`, so high risk only ever *shrinks* danger.

**Build:** in `arena_ai.py`, add an overextension term mirroring checkers: when `aggression>70 AND risk_tolerance>70`, **increase** the landing-danger penalty (e.g. multiply the danger term by `1 + overext*0.6`, where `overext = ((agg-70)/30)*((risk-70)/30)`), so the glass berserker actually trades deaths for its damage. Without this, **any** budget just reshapes the same dominant build. This is the load-bearing balance change of P1.

### 2.4 Slider → behavior (for the decision driver-word, §6.4, and post-match attribution, §6.6)

Arena scoring (`arena_ai.py`, sliders normalized `/100`):
- **aggression** — `ATTACK base = 10 + 15*agg` (+25 if it kills, +30 vs a channeler); `MOVE-toward = 8*agg`. The biggest single lever.
- **risk_tolerance** — de-risks landings: `danger penalty × (1.5 − risk)` (now also gated by overextension, §2.3).
- **target_focus** — drives **gate-rush inverse** (`gate_approach = 1 − focus`); high focus prefers low-HP kills and stunning the carry.
- **positioning** — formation/ally-proximity bonus, own-gate retreat tolerance, displace-to-save-ally.
- **sacrifice** — `+8*sac` on channel and on lethal attacks; reduces splash friendly-fire aversion.

### 2.5 Evolution — keep it per-slider; budget at save-time only (**CHANGE to P1**)

The brief wants evolution to be **zero-sum reallocation** (one up → another down). **Reject.** Verified failure mode: the existing `evolve_sliders` already pulls extremes toward center when losing; layering a zero-sum constraint ratchets every Pilot toward the **all-50 centroid** over successive windows — the blandest possible build — and breaks the per-slider `MAX_DRIFT` semantics (drift is defined vs each slider's *own original*, not as a conserved pool).

**Rules (real constants):** `EVOLUTION_WINDOW=20`, `MAX_DRIFT=±10` from original per slider, magnitude ±2/slider, learns only when `wins≥3`.
- **Keep evolution per-slider and independent**, exactly as today.
- Enforce the budget **only at save/edit time** and as a **post-drift trim**: if a 20-match window pushes the total over 200, subtract the overflow **proportionally from the sliders farthest above their own original value** (preserves character; trims only drift) — never from the lowest absolute slider.
- **Only winners reallocate up:** gate any upward drift behind `win_rate>0.6 & wins≥3`; losers keep the pull-to-center. Cap net per-window movement at **±4 total**. Keep the ±10 clamp as the hard rail.
- **Legibility:** never animate reallocation mid-match. Show it on the post-match / between-game card as `AGGRESSION +2 / POSITIONING −2`.

### 2.6 Carryover, validation, re-audit

- **Migration:** existing agents (checkers 0–100, current Arena defaults sum 230–305) are normalized to 200 via the shape-preserving algorithm in `AGENT-IDENTITY-SPEC.md` §4.I (clamp to [5,80]; distribute the delta proportionally to headroom; round; ±1 to most-headroom slider) — **retarget 250→200**. Present once as **"Arena Re-attunement"** (before→after radar morph), a feature, not a silent nerf. Grandfather un-edited agents until next save.
- **Anti-cheat (mandatory, real money rides on it):** server asserts every deployed Pilot has each slider ∈ [5,80] and `sum==200 (±1)`; reject otherwise.
- **HARD GATE:** P1 does not reach real money until `python scripts/arena_props_audit.py` (Arena book) **and** `python scripts/economy_audit.py` (checkers `heat` row) hold ≈ +5% under the new 200-simplex slider distribution. The prop tables in `arena_props.py` were measured on the *current* 0–100 independent distribution; constraining to a 200-sum [5,80] simplex removes the tail builds they were calibrated on → re-fit any prop that drifts outside `FAIL_TOL=2.0`.

The live-sculpting UX (proportional drain with visible `−N` ticks, wall-thunk, live name/temperament/radar crystallization, presets) is unchanged from `AGENT-IDENTITY-SPEC.md` §4.B — apply it with the 200/5/80 numbers.

---

## 3. Guardian roster & combat reference (build-critical ground truth)

The board is an **axial hex grid, radius 2 = 19 hexes** (widest row 5 across; max hex-distance 4 = "diameter 4"). Red starts top row `r=-2`, Blue bottom `r=2`; gates `RED_GATE=(1,-2)`, `BLUE_GATE=(-1,2)`; each team fields **1–3 Guardians**.

| Guardian | HP | ATK | DEF | SPD | Signature | Solo survival (k=1) |
|---|---|---|---|---|---|---|
| **Ironjaw** (Bulwark) | 7 | 2 | 2 | 1 | **Provoke** — enemies within range 1 are forced/biased to target it | **0.316** (tankiest) |
| **Razorwing** (Diver) | 5 | 4 | 0 | 4 | **Swoop** — flies over occupancy when moving | **0.017** (glass) |
| **Embercaster** (Artillery) | 6 | 3 | 1 | 2 | **Blast** — ranged at distance *exactly* 2, +1 splash to hexes adjacent to target | 0.412 |
| **Warden** (Anchor) | 8 | 2 | 1 | 2 | **Aegis** (+1 DEF aura, non-stacking) + **Bulwark Pulse** (1 charge: shield adjacent allies) | 0.341 |
| **Hexwright** (Disruptor) | 8 | 3 | 1 | 3 | **Displace** (shove 1 hex; into void = **ring-out kill**) + **Glitch** (1 charge: stun + reset breach) | 0.450 |

**Core rules:** damage `= max(1, atk − def)` (min 1 always lands). Round structure: up to **14 rounds**; activations in **SPD order, highest first; ties resolve SIMULTANEOUSLY** (this is the crux of P6). **Win conditions:** `breach` (channel the enemy gate **4** times — meter decays 1/round off-gate; Glitch resets it), `elimination`, `collapse` (ring voids from **round 9**, 4 hexes/round; also the round-14 tiebreak: most alive, then total HP). **No "timeout" win exists.** **Last Stand:** a lone outnumbered survivor with ≥60% HP gets +2 ATK / +1 SPD / +1 range. Melee has **no retaliation** (so a Razorwing trade is a *mutual first-strike race*, not a trade — see §5.1).

---

## 4. Ability upgrades (P7) — ~80% already built

`SPECIES_UPGRADES` already exists and the Arena `CreatureConfig` already accepts an `upgrade` key. The three tiers per species map to the **real** edge-unlock levels (`L5/L15/L25`):

| Guardian | L5 | L15 | L25 |
|---|---|---|---|
| Ironjaw | **Iron Will** — Provoke range → 2 | **Bulwark Aura** — adjacent allies −1 dmg | **Final Detonation** — on death, 2 dmg to all adjacent |
| Razorwing | **Chain Dive** — +1 SPD the turn after a kill | **First Strike** — first attack each match +2 | **Shadow Step** — after a kill, move 1 hex |
| Embercaster | **Wide Blast** — splash → all within 1 | **Close Quarters** — Blast can fire at range 1 | **Scorch** — Blast applies 1 dmg/turn burn (2 turns) |
| Warden | **Extended Aegis** — Aegis range → 2 | **Double Pulse** — 2 pulse charges | **Reflect** — allies under Aegis reflect 1 dmg to melee attackers |
| Hexwright | **Long Arm** — Displace range → 2 | **Double Glitch** — 2 glitch charges | **Translocate** — Displace can swap two creatures |

**What to build:**
1. **Lobby selector** — one segmented control per Guardian on the draft card. **Render the effect inline**, never just the name: *"Iron Will — Provoke reaches 2 hexes."* (Names alone are meaningless to new players.)
2. **Level lock** — a tier is selectable only if the controlling **Pilot's level ≥ tier** (level gate already in data via `EDGE_UNLOCK_LEVELS`). Locked tiers show greyed with *"Pilot Lv 15 needed."* This is the leveling carrot: "get this Pilot to L25 to unlock Final Detonation on any Ironjaw it flies."
3. **Mid-match legibility** — show the equipped upgrade as a small icon on each `TeamPanel` row, so a bettor can see what each Guardian is running.
4. **Between-games swap + opponent visibility** = a **Series-only** feature (§5.4); in single matches just persist the last pick.

**Balance gate:** First Strike (Razorwing, effective ATK 6 vs DEF 0/1) and Chain Dive (effective SPD 5) make the turn-1 one-shot *worse*. **Do not expose Razorwing upgrades until P6 ships** (§5.1). After P7, re-run the matchup matrix with each upgrade equipped (mono-species 3v3) and assert max species win-rate ≤ 0.55.

---

## 5. Series, swapping & Survival (P3, P4, P5)

> **All of §5 is greenfield.** No series/best-of/roster/ownership concept exists in code. These ship in **Release 2 (P3+P4)** and **Release 3 (P5)**, after the Foundations in §11.

### 5.1 P6 first — Razorwing Swoop (corrected) — this gates everything in §5

**The bug in the proposal:** capping Swoop at 3 does **not** fix turn-1 kamikaze. Verified on the real board: every Razorwing starts **distance 4** from every enemy starter; melee ATTACK is **range 1**, so it only needs to *move to an adjacent hex* — a **3-hex move**. SPD-4 reaches it (need 3, have 4) **and SPD-3 still reaches it** (need 3, have 3). A 3-hex cap only blocks the irrelevant turn-1 gate-channel (needs 4). And because both Razorwings sit in the **same SPD bucket → simultaneous resolution**, a "1 turn to react" helps only the slower side; in the mirror neither side ever gets it.

**The fix:**
1. **Cap Swoop *reach* at 2 hexes** (the `board.walkable` swoop path length), **not** base SPD. From any start the nearest enemy is dist 4 → adjacency needs a 3-hex move → a 2-hex Swoop **cannot** reach an attack on turn 1. Keep **printed SPD 4** for the chase/reposition fantasy (non-swoop movement unchanged; chain_dive/last-stand speed buffs still read).
2. **Make Swoop a 2-phase commit:** turn 1 = **reposition + telegraphed intent** (the intent-beam already exists), attack enabled **turn 2**. In the symmetric mirror, both flyers park mid-board, then *both* teams get a full round of Provoke / Displace / Glitch counterplay. This must be a **hard mechanical rule**, not an AI danger-nudge, because a risk-80 build shrugs off the soft danger penalty.
3. **Visual** (mostly exists): fly 2 hexes with the existing crimson trail, then a distinct **brace/hover** pose 1 hex short (do **not** reuse the lunge-and-return; that reads as a completed attack). A thin intent beam from the hovering Razorwing to its intended target shows the threat forming.

**Reprice trigger:** P6 shifts `first_blood`, `SPECIES_SURVIVAL_BY_COUNT` (Razorwing rows especially — 0.017 will rise), and rounds/breach rates. Re-run `arena_props_audit.py` and re-measure those tables before shipping P6 alongside any survival/first-blood market.

### 5.2 Series format (P3)

- **Formats:** Single · **Best of 3 (default competitive)** · Best of 5 (high-stakes only, labeled "~10 min").
- **Guardian species are locked for the whole series** (you cannot change bodies mid-series); Pilots and upgrades can change between games (§5.3, §4).
- **New data model (greenfield):** a `series` table — `series_id, format (bo1|bo3|bo5), red_owner, blue_owner, per_game_results[], running_score, status, winner` — plus a series-aware orchestrator (today `_run_game`/`_run_multiplayer_match` return after exactly one game) and a win check (first to `ceil(N/2)`). Series-level ELO/payout settle once at series end.
- **Timing:** a series is 3–10 min of *playback*: ~60–90s per game (the watched event playback; the sim itself is instantaneous server-side) + between-games interstitials (§5.5).

### 5.3 Pilot swapping (P4)

- Between games, reassign which **Pilot** flies which Guardian from your roster. **Rules:** species locked; upgrades swappable; **each Pilot flies only one Guardian at a time** (no cloning); benched Pilots (Survival mode) cannot be reassigned.
- **Prerequisite (hard):** real **agent ownership**, which does **not** exist (`create_agent` never sets `player_id`; `get_agents` returns all globally; the lone `ws.py:206` ownership check is a dead no-op). Build ownership in Foundations (§11) first.
- **Roster model:** Standard Series reuses the existing **inline 1–3 Guardian lineup per game** (no persisted 6/9 roster needed). Persisted per-user rosters arrive only with Survival Series (§5.4).

### 5.4 Survival Series — death = benched (P5), rewritten

**Default Series has NO benching.** Comebacks come from adaptation (swaps + upgrade changes). Benching is an **advanced, opt-in ruleset** ("SURVIVAL SERIES"), **off by default, never auto-applied**, shipped **last**.

When Survival Series is on:
- **Loser-only benching (CHANGE — the core fix):** a Pilot is grounded for the rest of the series **only if its Guardian died AND its team LOST that game.** Winners keep **all** Pilots regardless of casualties. This removes the perverse "winning by elimination weakens you" penalty and the "breach-cheese preserves your whole roster" snowball, and turns benching into the **structural comeback** P3 wants: a team that loses cleanly (ring-out/breach, few deaths) keeps its roster to retool, while a team wiped in an elimination loss pays the attrition.
- **Roster minimums (CHANGE):** Single **3**, Bo3 **4**, Bo5 **5** — **not** 3/6/9. You can lose at most N−1 Pilots across N games, so a +1/+2 buffer suffices; 6/9 just creates sacrificial fodder behind the 3 tank bodies. Enforced only in Survival Series, and only after ownership + a persisted roster table exist.
- **Sequencing (hard):** P6 must land first. With Razorwing at 1.7% solo survival, "best Pilot on the tank, worst on the Razorwing" is a *solved* turn-0 decision; P6 raises Razorwing survivability so the deployment choice becomes real before any economy is tied to death.
- **Legibility (mandatory):** a one-time explainer; a literal **BENCH shelf** of grayscaled Pilot faces with a lock chip (reuse the existing dead-creature grayscale treatment); and authored result-card framing of the asymmetry — *"You won — but lost 2 Pilots"* vs *"You lost — Pilots preserved (ring-out)."* The win-can-weaken-you dynamic must read as **intentional**, never as a bug.

### 5.5 Between-games flow (one scalable screen)

ONE screen, progressively populated by which rulesets are active. Strict sequence (the order matters for betting integrity, §7):

```
GAME ENDS
  1. RESULT CARD: series score header (●●○ vs ●○○), the single most important prev-game stat,
     and — if Survival on — the BENCH shelf + win-cost framing.
  2. ADJUST (12s default, skippable via READY; auto-advances with current lineup if untouched):
     - "Adjust lineup" expander (only if P4 on): tap-to-assign roster tray (NOT per-Guardian dropdowns
       on mobile). Available Pilot cards on top, 3 Guardian slots below; benched Pilots greyed + non-tappable.
     - Upgrade controls (only if P7 on).
     - A permanent "KEEP LINEUP" one-tap default for meta-uninterested bettors.
  3. LOCK LINEUP  →  reveal BOTH lineups+upgrades to both sides (symmetric public info).
  4. Server kicks off the lineup-CONDITIONAL re-sim (started the instant Game 1 ended; see §7).
  5. BETTING window opens ONLY when the conditional price lands ("Pricing Game 2…" until then).
  6. Next game: <1s power-up (not the full neural-link), then playback.
```

**Why not the brief's 15–20s:** the conditional re-sim needed to price the next game cannot run inside 15–20s, and a stale marginal-priced line is sharp-exploitable. Decouple **market-open from the adjust timer** — adjust is 12s for the *player*; betting opens when pricing is ready (allow a 20–30s intermission). Default **Bo3, not Bo5**, anywhere a new user can reach it.

---

## 6. Visual hierarchy & UX flows (P2, hardened) + onboarding

### 6.1 Onboarding — the progressive-disclosure spine (**NEW**, and it IS the release plan)

8+ novel systems cannot land before a new spectator-bettor's first wager. Hard-gate disclosure:

| Tier | Unlocks at | Player sees |
|---|---|---|
| **0** | First session | **Spectate-only.** Land on a live/sample SINGLE match already in progress; place ONE moneyline bet from a 2-button RED/BLUE bar. No team-building. Teaches "it's AI-vs-AI and you bet" in 60–90s. |
| **1** | After 1 bet settles | SINGLE-match build with **preset Pilots only** (the 6 starters) + species pick. **Sliders collapsed** behind "Customize." |
| **2** | After ~3 single matches | Custom sliders (**P1 budget**) + prop bets. |
| **3** | Explicit **"SERIES" opt-in** (requires ≥3 singles) | Bo3, between-games screen, Pilot swap (P4), upgrade swaps (P7), series bets (P3). |
| **4** | Advanced toggle, OFF by default | **Survival Series** (P5) + its survival props. |

This tier ramp **is** the build sequence: R1 = Tiers 0–2, R2 = Tier 3, R3 = Tier 4.

### 6.2 Draft screen → "DEPLOY YOUR PILOTS"

Pilot-first card hierarchy (per `AGENT-IDENTITY-SPEC.md` §4.C, "agent"→"Pilot", species→"Guardian"): **PILOT NAME** (18px/700/accent, editable, 🎲 re-roll) → **TEMPERAMENT** chip → **RADAR silhouette** (~120px) → **"GAVE UP:" line** → **GUARDIAN** species selector (demoted, ~40px) + upgrade segmented control (§4) → **sliders** with budget bar (Tier 2+). Header: **"DEPLOY YOUR PILOTS."** Sub: *"You design the Pilot. The Guardian is just a body."*

### 6.3 Neural-link summon (loading → bet-lock) — spec

It runs **while the backend simulates**, so it hides latency instead of adding it. It **is** the loading screen, with the bet bar live on top.

| Stage | First match of session | Games 2..N of a series |
|---|---|---|
| Duration | **1.8s** (skippable; tap to skip) | **0.8s power-up** (existing `spawnCreature` fade/scale) |
| 0.0–0.3s | Board materializes faint; hexes empty; env dims | — |
| 0.3–0.9s | Pilot **NAME** types in above its hex (accent) + temperament icon | — |
| 0.9–1.6s | **Neural-link line** shoots from name into hex; Guardian holo-materializes along it (drive shader `uDissolve` 1→0); sigil flash | models fade/scale in |
| 1.6–1.8s | Snap to full opacity; accent bloom; idle begins | idle begins |

- **Concurrent overlay:** a **"FINAL BETS — locking in N"** countdown rides on top (the last-call window). The ceremony is never dead time.
- **Mandatory portion hard-capped at 1.5s.** User pref "Instant summon" → 0.3s. Returning real-money users default to instant board + 0.8s power-up. The full 3–4s cinematic is reserved for the **very first match a new user ever sees** (teaches brain/body once). **Never** play the full version on every game of a Bo5.

### 6.4 In-match identity & labels (mobile-safe — **CHANGE to P2**)

There is **zero text in the 3D scene today** and a phone canvas is ~289px tall over an animated shader with auto-orbit. **Do not render 3 lines over every Guardian — ever.** Hierarchy:

1. **Always:** the existing HP bar + a 2px team-color dot above each model. The Pilot's accent also subtly tints its projection pool, so *your* Pilot is findable among five.
2. **Active only:** a **single** screen-space pill — **Pilot name** (12–13px, accent, bold, dark pill) — appears on the **acting** Guardian (tie to `activeCreatureId`, `Arena.jsx:1327`) and fades when its activation ends. This doubles as the missing active-creature highlight (a standing complaint). One line, not three.
3. **Full identity** (Pilot / temperament / species) lives in the **side TeamPanel** and the **action-description bar** — which already names the actor every beat. *That bar is your legible label channel; reuse it, don't duplicate into 3D.*
4. **On tap (mobile) / hover (desktop):** full Pilot card as an **HTML overlay** anchored to the model (Pilot/temperament/species/equipped-upgrade/record) — never a 3D sprite.

### 6.5 Decision insight — kill the 0.3s pentagon (**CHANGE to P2**)

A 0.3s pentagon firing every activation reads as noise (faster than humans parse a 5-axis shape, amid an already-dense effect layer) and **often lies** (the AI picks weighted-random among all actions within 10% of best, so single-slider attribution is frequently false). Replace with three honest, cheap signals:

1. **Primary — driver-word in the action bar:** append a slider-colored tag to the action the user already reads: *"BERSERKER RAZORWING attacks — `[AGGRESSION]`"* in the slider's existing color. Dwell = the action's own dwell. **Honesty rule:** the driver is read from the **real** per-slider contribution (`arena_ai._score_action` accumulates a `drivers` dict for the chosen action; engine attaches it to the activation event). If `drivers` is absent, **show nothing** — never fabricate (real-money product).
2. **Pre-match "Pilot fingerprint":** show each Pilot's 5-slider pentagon once on the draft card, so the shape is already familiar by match time (also the slider-tuning feedback the Arena currently lacks).
3. **Optional pulse:** a slow (≥0.8s) radar pulse **only on signature moments** (kills, breaches — already high-dwell at 2×–4× speed), throttled ≤1 per 2.5s. **Opt-in** ("Decision insights"), default **off** for Tier 0–1 and during real-money playback.

### 6.6 Post-match — the Pilot earns it

Pilot performance cards (not species standings): name (accent) + temperament + radar + stat line (kills, damage, survived/how-it-died). **Honest attribution** from the `drivers` data: *"AGGRESSION-LED — 2 of 2 kills came from aggressive engages"* (count actions whose dominant driver matched), **never** "aggression drove 2 kills." Winner's Pilots get a hero frame; losers get a temperament-keyed epitaph (static table: BERSERKER → *"Charged the gate and never looked back."*). Record update (`Savage Grinder 7–2 · +1 kill`). One-tap **share card** → PNG. (Full layout: `AGENT-IDENTITY-SPEC.md` §4.F.)

### 6.7 Betting legibility (protect the money flow)

Every bettable surface that names a species/team **also shows the Pilot name + sigil** (props are species/team-keyed, so the name↔species map must be explicit at the moment money is on the line): `🏆 SURVIVOR · Ironjaw (Savage Grinder 🛡)`.

---

## 7. Betting markets — the full book

**Existing, keep as-is (single match):** moneyline (ELO-priced), and the Arena prop book — `breach_completion`, `first_blood`, `total_rounds_ou` (line 7, push-aware), `last_stand`, `species_survivor` — all model-priced to hold +5% and covered by `arena_props_audit.py`. Live in-play **breach bet** stays. Flat 5% edge applied as `odds = (1/p)*(1−0.05)`.

### 7.1 Integrity fixes — BEFORE any new market (Foundations)

1. **Arena bet path is client-trusted — fix first.** `/api/arena/bet/place` (main.py:2524-2562) stores **client-supplied odds** verbatim (only checks `odds>0`; the "server-side to prevent manipulation" comment is false), and `/api/arena/bet/resolve` (main.py:2565-2592) settles against a **client-supplied `match_result`**. On free-play this is bounded; on USDC it is **direct theft** (price your own odds, declare your own winner). Server **must** recompute odds (mirror the main book at main.py:1771-1785) and settle from a **server-trusted sim record** keyed by `series_id`.
2. **Settlement-accounting bug.** Prop settle uses `settle_bet(0,'win',…)` with `bet_id=0` → matches no row, **miscounts PUSH as win**, and **never records prop losses** (streak never resets). Fix to settle real bet rows and record losses.
3. **Streak must stay cosmetic.** Stop incrementing `win_streak` on any prop/arena/series settlement (the heat/streak fix is the standing economy doctrine; re-running it as +EV is the exact bug that flipped the edge to −3%).

### 7.2 Series & engine markets — verdicts

| Market | Verdict | How |
|---|---|---|
| **Series moneyline** | **KEEP** | Free-play: house-banked, conditional-priced. Real-money: **bettor-vs-bettor pot-split** (Team-A backers' pool vs Team-B backers' pool; winner-pool splits loser-pool − 5%) — preserves zero counterparty risk, needs no USDC reserve (none exists). |
| **Per-game bets** | **KEEP, conditional** | Price each game from the **lineup-conditional** re-sim opened *after* lineup lock (§5.5); never carry a pre-series price into a later game. |
| **Go the distance** | **KEEP, repriced** | Define drawn-game + forfeit rules first (`mutual_elimination` is a real outcome). **Void on walkover**; price conditional on not-void, exactly as `total_rounds_ou` prices `P(over\|!push)`. |
| **Either team sweeps** | **KEEP, jointly priced** | Sweep ⊂ series-win ⊂ per-game — totally correlated. Derive from **one** simulated series distribution so odds are mutually consistent. |
| **Will Pilot X survive (this game)** | **CUT as-is; reprice if wanted** | Can't reuse the per-species table; per-slot survival floors at p=0.017 (Razorwing) → ~55× payouts + a NO-side leak from the `max(prob,0.01)` floor. If kept: clamp p at **0.05** (max ~19×), price from the conditional sim, settle from server per-creature alive flags, free-play only. |
| **Engines available for Game 3** | **CUT (as a between-game market)** | Near-deterministic once prior games are in the record. Only a *pre-series* forward line ("how many will the loser have after Game 2") is priceable. |
| **Will either team field a benched engine** | **CUT entirely** | **Logically impossible** under P5's own rule (benched Pilots can't be reassigned). Any nonzero YES is a giveaway. |

### 7.3 The lineup-conditional series pricer + new audit (**NEW, the gating dependency**)

- **Pricer:** a Monte-Carlo that simulates the full Bo-N from the **exact surviving + swapped lineup** (reuse `arena_balance_sim`), run the instant a game ends, emitting **mutually-consistent** odds for series-win / sweep / go-distance / per-game / per-creature-survival. This replaces the static marginal tables for *all* series markets — the only way to hold +5% once P5 couples games.
- **New standing audit** (sibling of `arena_props_audit.py`): simulate full series, price every market from the conditional model, bet **both sides AND correlated baskets** (series-win + sweep + distance-NO together), assert each holds within `FAIL_TOL=2.0` of +5%, **exit non-zero to gate CI**. The existing audits test props *independently* and would miss the correlation exploit.
- **Same-series parlay block:** forbid combining legs that share a `series_id` (analog of the 4-prop/match cap).
- **No series market ships real-money until this audit passes; free-play coins only in the interim.**

### 7.4 Real-money constraints (real values)

USDC is multiplayer-only, pot-split, fee `500bps`, stakes `$0.01–$10` in fixed tiers, matched at **exact** equal stake (pot = 2× stake), eligibility **level ≥ 3 AND ≥ 10 matches**. **House-banked variable-odds books need a reserve that does not exist** — so all variable-odds series/survival markets are **free-play only** unless reformulated as pot-split (§7.2).

---

## 8. What I'm adding (beyond the seven)

1. **Pilot persistence across BOTH games (highest-value, foundational).** The Arena currently does **not** write ELO/XP back to agents — so Arena play doesn't grow your Pilot. Wire Arena results into the **same** Pilot record (ELO, XP→levels→upgrade unlocks, evolution, familiarity). Now every Arena match *counts* toward the thing you own. This is also the prerequisite for series/roster, and it's the deepest attachment lever ("Savage Grinder, 7–2, 14 career kills" is a character).
2. **The sigil/accent fingerprint** — a procedural mark (the radar, miniaturized) in the Pilot's own color, so you can find *your* Pilot among five and recognize it across create → watch → results.
3. **Deploy survival preview** — surface each Guardian's solo survival probability (already measured in `SPECIES_SURVIVAL_BY_COUNT`) on the deploy screen. Makes the P5 deployment decision legible to players **and** exposes to designers when a slot (Razorwing 1.7%) is a non-choice that needs rebalancing before economy is tied to it.
4. **Signature-moment auto-capture** — the Pilot's single best play (highest driver contribution) auto-clipped from playback for the share card. Attachment + virality in one.
5. **Pilot voice by temperament** — pre-match taunt, death line, and `commentary` attribution keyed off the 7 temperaments. A static line table = enormous personality for near-zero cost.
6. **Rivalries** via `familiarity.py` — a named Pilot "remembers" a recurring opponent ("Savage Grinder is 3–1 vs Iron Bastion"). Stakes and story across matches.
7. **One radar through-line** — commit to a single pentagon shared by build, decision insight, and results; the cheapest way to make a Pilot feel like one continuous entity.

---

## 9. Cross-proposal synergies & conflicts (the map)

**Synergies**
- **P3 + P4 + P5 + P7 are one gated bundle, meaningful only together inside a series.** Sequence: P3 (series exists) → P7 (something to swap) → P4 (swap Pilots) → P5 (death makes the swap consequential). Build **one** between-games screen that scales: series-score header always; "Adjust lineup" only if P4 on; BENCH shelf only if P5 on; upgrade controls only if P7 on.
- **P5 + P3 (with the loser-only fix) = the comeback engine** Bo3/Bo5 needs: a trailing player who lost cleanly keeps their roster and retools.
- **P4 + P7** *help* pricing **iff** lineup+upgrades are LOCKED and revealed before the betting window — the conditional pricer then has a fully-specified, symmetric-info comp to simulate.
- **P2 + P6** share one visual grammar: the active-Pilot pill and the telegraphed-swoop intent beam are the same screen-space callout tied to `activeCreatureId`/`intentData` — the bettor reads the whole threat in one glance.
- **P1 + P2:** the budget *produces* identity content (sharp name, clear temperament, distinct silhouette); the reframe is the spotlight. Ship as a unit.

**Conflicts (and resolutions)**
- **P5 × P3 (economic):** death-benching makes later games structurally predictable → static-priced series lines go stale → sharp-exploitable. **Resolve:** lineup-conditional pricer + open markets only after lineup lock + the new audit (§7.3).
- **P6 × P5 × P7:** Razorwing's 1.7% survival is the hinge — P5 makes deploying a good Pilot there irrational, the brief's P6 fails to fix it, P7 makes it deadlier/frailer. **Resolve:** strict order — **P6 (2-hex) → P5 economy → P7 Razorwing upgrades.**
- **P1 × P5:** the budget's dominant build (max-agg) is the worst to bench, pushing players to park aggression on the safe tank (the brief's own anti-pattern). **Resolve:** the arena overextension term (§2.3) — shared root cause — makes high-agg carry real death risk.
- **P1/P6 × the prop book:** both change the slider/event distribution the prop tables were calibrated on. **Resolve:** treat each as a balance change that triggers the standing audits (§2.6, §5.1).
- **P1 × P2 (load):** the budget needs sliders open; new-user disclosure needs them collapsed. **Resolve:** presets carry an implicit valid 200 budget; the slider drawer stays collapsed until Tier 2.
- **P2 ceremony × P3 cadence:** full neural-link every game × up to 5 games = pre-roll fatigue. **Resolve:** full only on game 1; 0.8s power-up for 2..N; overlap with load+betting; 12s skippable between-games (§6.3, §5.5).

---

## 10. Per-screen UX summary (build checklist)

- **First-run (Tier 0):** live/sample single match + 2-button moneyline. Nothing else.
- **Deploy screen:** "DEPLOY YOUR PILOTS"; Pilot-first cards; presets in Tier 1; budget+sliders in Tier 2; upgrade selector with inline effects; format selector (Single/Bo3/Bo5) in Tier 3; Survival toggle in Tier 4; deploy survival preview.
- **Summon:** 1.8s skippable cinematic (first) / 0.8s power-up (rest), overlapping the sim + the "FINAL BETS" countdown.
- **In-match HUD:** HP bar + team dot always; active-only Pilot pill; driver-word in the action bar; full identity in TeamPanel + on tap; optional signature-only radar pulse (off by default in real money).
- **Between-games (Series):** result card (+ BENCH shelf if Survival) → 12s adjust (roster tray, KEEP LINEUP default) → LOCK → reveal → conditional price → bet window → power-up → play.
- **Post-match / series:** Pilot performance cards, honest attribution, epitaphs, record update, share card.
- **Bet surfaces:** Pilot name + sigil alongside every species/team-keyed market.

---

## 11. Build priority order & dependencies

### Phase 0 — Foundations (prerequisites; unblock everything)
- **F1. Enforce agent ownership** — set `player_id` on `create_agent`, owner-filter `get_agents`, make the `ws.py:206` check real. *Blocks all roster/series features (P4/P5).*
- **F2. Harden the Arena bet path** — server recompute odds; settle from a server-trusted record; fix the `settle_bet(0)` accounting bug; stop incrementing the cosmetic streak (§7.1). *Blocks all real-money Arena markets.*
- **F3. Pilot unification & write-back** — rename agent→**Pilot**, creature→**Guardian** in all UI strings; wire Arena results into the shared Pilot record (ELO/XP/evolution). *Foundation for identity, leveling-gated upgrades, and series.*

### Release 1 — Single-match depth (each ships independently; no series)
1. **P6 Swoop fix** (2-hex cap + 2-phase commit, keep SPD 4). Pure combat, no deps. → re-run `arena_props_audit` + matchup matrix.
2. **P1 budget** (200/5/80 on the shared config) **+ arena overextension term + save-time evolution trim.** → re-run **both** audits + checkers balance.
3. **P7 single-equip upgrades** (mechanics exist; add selector + level-lock + inline effects + TeamPanel icon). Expose Razorwing upgrades **after** #1.
4. **P2 (single-match parts):** terminology, "Deploy your Pilots," active-only label, driver-word + kill-the-pentagon, pre-match fingerprint, post-match Pilot attribution, neural-link as overlapped skippable loader.
5. **Onboarding Tiers 0–2.**

### Release 2 — Series + swapping (depends on F1, F3, and the conditional pricer)
6. **Series data model + orchestrator** (Bo3 default, Bo5 high-stakes) + the **one scalable between-games screen**.
7. **P4 Pilot swapping** (roster tray UI, KEEP LINEUP default).
8. **P7 between-games swaps** + opponent visibility.
9. **Series betting:** build the **conditional pricer + new series audit first**; ship **series moneyline only** (free-play house-banked; real-money via pot-split); add go-distance/sweep/per-game behind "More markets," jointly priced; block same-series parlays.
10. **Onboarding Tier 3.**

### Release 3 — Survival Series (advanced, opt-in, off by default)
11. **P5 death-benching** (loser-only), roster minimums **3/4/5**, BENCH shelf, result-card asymmetry framing, deploy survival preview.
12. **Survival props** (survive-Pilot with clamped odds; engines-available only as a pre-series forward line) — via the conditional pricer + correlated-basket audit, free-play first.
13. **Onboarding Tier 4.**

**Critical dependency chain:** F1 → P4/P5 · F2 → all real-money markets · P6 → P5 · P1-overextension → P7 Razorwing upgrades · conditional pricer + series audit → any series market real-money · P1 & P6 → re-run standing audits.

---

## 12. Open decisions (need a human call)

1. **Budget scope:** §2.1 applies the 200 budget to the **shared** config (both games). Alternative: add **Arena-only** slider storage (checkers stays uncapped) — preserves checkers balance but splits a Pilot into two personalities (weakens the identity thesis, adds migration). **Recommendation: shared.**
2. **Final budget value:** ship the mechanism at **200/5/80**; confirm or retune (180–220) from the balance sim before real-money exposure.
3. **Terminology sign-off:** **Pilot / Guardian** (recommended) vs MIND / BODY (runner-up). One call, then global string swap.
4. **Real-money series model:** bettor-vs-bettor **pot-split** (recommended, no reserve) vs provisioning + auditing a house USDC reserve for variable-odds series books.

---

## Appendix — doc/code discrepancies found (fix separately)

- `CLAUDE.md` (and team memory) reference **`config/settings.py` for path constants — that file does not exist.** Constants are scattered module-level literals; `DB_PATH` (`database.py:12`) is the only env path. New tunables should follow the existing pattern (module-level constants near their system) until/unless a settings module is created.
- `arena_engine.py:118` comment says the breach meter caps at 2 ("at 2 = gate breaks"); the **real threshold is `BREACH_CHANNEL_TURNS=4`.** Stale comment.
- `ArenaMatchResult.win_method` docstring + `arena_balance_sim` list a **`timeout`** outcome that `simulate_match` never emits (round-cap → `collapse` tiebreak). Don't design around a timeout win.
