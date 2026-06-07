# Agent Identity — Design Directive & Build Spec

**Author:** Creative Director
**Status:** Build-ready
**Scope:** Two proposals — (1) Point Budget for sliders, (2) Agent Identity Reframe — reviewed, improved, and merged into one directive.

---

## 0. The thesis, restated as a directive

The validated thing: people love *configuring AI agents and watching them compete*.
The broken thing: players bond with the **creature** (the 3D body they were given) and not the **agent** (the brain they built). The agent is the only thing in this product the player actually *authored*, and right now it reads as a settings panel.

> **Everything in this document serves one sentence: the agent is the pilot; the creature is the mech.** The player's creation is the consciousness; the species is the chassis it's poured into. We win when a player says *"that's **my** Savage Grinder"* and not *"that's the Ironjaw."*

To make a configuration feel like a character, it needs four things. Call this the **Identity Stack** — it is the spine of the whole spec:

1. **NAME** — an evocative, build-derived name ("Savage Grinder"), read first.
2. **TEMPERAMENT** — an archetype/class the build resolves to (BERSERKER, STALKER, …). *This already exists in the code and both proposals ignore it. It is the missing connective tissue.*
3. **SILHOUETTE** — the radar shape of the build: a unique fingerprint that is the SAME visual in creation, combat, and results.
4. **RECORD** — persistence: the agent survives the match, accrues a history, and is redeployed. *A one-match agent cannot be loved.*

Proposal 1 manufactures the raw material for #1–#3 (a build with a distinct shape and a clear dominant trait). Proposal 2 puts a spotlight on it. **Neither works without the other**, and both are missing #4. The synthesis (§6) delivers all four.

---

## 1. Proposal 1 — Point Budget — REVIEW

### 1a. What's right (keep exactly)
- **Trade-offs create identity.** This is correct and load-bearing. A maxed-everything agent has no silhouette and therefore no character. Constraint is what turns a slider panel into a *build*. Keep the core idea unconditionally.
- **`min 10 / max 90` per slider.** Correct and important: it prevents degenerate 0-stat builds that would break the AI scorer (`arena_ai._score_action` reads all five) and guarantees every agent is functional. Keep.
- **"Defined by what it sacrificed."** The emotional framing is right. A flaw is what makes a character lovable (audiences bond to characters with weaknesses, not to the invincible). The budget *manufactures a flaw on purpose.* Keep this as the headline.

### 1b. What's wrong / risky
1. **It silently de-calibrates the betting book — this is a hard gate, not a footnote.** `arena_props.py` prices every prop from probability *models* keyed on team stats (breach rate, `avg def`, `max spd`, species presence). Constraining the slider space to sum-250 changes how `arena_ai` behaves → changes breach rate, match length, first-blood, last-stand frequency, survival → **the prop holds drift off +5%.** Per `CLAUDE.md`, `scripts/arena_props_audit.py` is the standing acceptance test. **The budget cannot ship until that audit passes again.** (See §6.H.)
2. **The carryover constraint is violated on contact.** Spec says "same agents carry over from Agent Checkers." AC sliders are `0–100`, unconstrained; the current Arena default teams already sum to **230–305**, never 250. So *no existing agent satisfies the budget.* Forcibly rescaling an agent the player evolved = mutating their creation = the opposite of attachment. This must be handled as a deliberate, visible **re-attunement** moment, not a silent clamp (see §6.B.5).
3. **The "whack-a-mole" failure mode.** If raising one slider makes the others move in an opaque way, the creation moment — which should feel *creative* — feels like fighting the UI. The **redistribution model is the whole UX** and must be specified exactly (§6.B.2). Get this wrong and the budget is experienced as friction, not authorship.
4. **If the sacrifice isn't shown, it isn't felt.** Proportional auto-drain that just nudges numbers communicates nothing. The player must SEE the cost being paid (the other traits visibly falling) and READ what they gave up. Otherwise the central emotional promise ("the sacrifice is the character") never lands.
5. **Meta-collapse toward 2-stat specialists.** 250 across five with max 90 rewards dumping three sliders to floor and spiking two. That's *good* for identity but risks build sameness and a degenerate meta. `min 10` softens it; watch it in the balance sim and tune the budget if the field collapses.

### 1c. What's missing (this is where it gets good)
- **The temperament is the missing payoff.** `derive_temperament()` already turns sliders into one of 7 archetypes at thresholds 65/35. The budget makes builds *cross those thresholds reliably* — so as you sculpt, the agent should **resolve into a named class in real time.** The budget without the temperament readout is a math puzzle; with it, it's character creation.
- **Live naming.** `suggest_names()` already generates `{adjective from dominant slider} {noun from secondary}`. Nobody surfaced this. As the dominant trait shifts, the suggested name should shift with it (Savage → Vicious; Striker → Grinder). *The player should watch their agent name itself.*
- **The radar silhouette as identity.** The pentagon shape of the build is the fingerprint. Show it live in creation; reuse the exact same shape in combat (decision radar) and results. One visual language end to end.
- **Archetype presets** to kill the blank-slate cost: one-tap "Berserker / Turtle / Stalker…" starting points that are already budget-legal, then tweak.
- **An explicit "you sacrificed" line** ("Glass pilot — gave up all positioning and focus") so the trade is narrated, not just numeric.

### 1d. How it should FEEL
Adjusting a slider must feel like **zero-sum sculpting of a personality**, not data entry. Push aggression up and you *see* positioning and focus drain — animated, with a hair of weight/resistance — while the radar stretches into a new shape and the archetype label flickers toward BERSERKER. It should feel like spending a scarce, precious resource to forge something with a soul *and a flaw*. The target emotion: **"I made a choice. I gave up X to be great at Y. This is mine, and it has character because it has a wound."** The moment the name + temperament snap into place is a tiny reveal — the agent telling you who it is. Give that moment a micro-animation and a sound.

---

## 2. Proposal 2 — Agent Identity Reframe — REVIEW

### 2a. What's right (keep)
- **The diagnosis.** Foregrounding the agent over the creature is the correct strategic move. Keep the intent of all five sub-items.
- **Agent name as primary label** (name large, species small). Correct hierarchy — the authored thing is the hero. Keep.
- **"DEPLOY YOUR AGENTS," not "SELECT YOUR TEAM."** Language sets the frame: *deploy* casts the agent as the actor and the creature as the vehicle. Keep.
- **The neural-link metaphor.** "The brain powers the body" is exactly the right central image (pilot → mech, consciousness → host). Keep the metaphor; rework the execution (below).
- **Post-match attribution to agents.** Outcomes should accrue to the player's creation — this is what builds a track record and, with it, attachment and a betting identity. Keep the intent; fix the honesty (below).

### 2b. What's wrong / risky
1. **The neural-link ceremony will eat a 60–90s match.** A multi-second loading ritual *every* match is magical once and tedious by match 5, especially for bettors who want the action. **Fix:** cap it hard, fast-path it after first view, and make it do double duty as the **final bet-lock window** so it is never dead time. (§6.D)
2. **The decision radar pulse is the single biggest risk in either proposal.** During combat the screen is already dense (5 holographic creatures, abilities, HP, breach meter, banners, a moving camera). A pentagon flashing on *every* decision will (a) clutter, (b) pull the eye off the creature action that *is* the spectacle, (c) be unreadable at match speed, and (d) — worst — if it isn't derived from the real scorer it is **fabricated data in a real-money product.** Rework: subtle, throttled to *signature* decisions only, honest (derived from `_score_action`), and toggleable. (§6.E.2)
3. **Name-over-species can confuse betting.** Props are species/team-keyed ("Will a Razorwing survive?"). If the UI foregrounds "Savage Grinder," the bettor must mentally map name → species → prop *at the moment money is on the line.* Every bettable surface must keep the name↔species mapping explicit. (§6.G)
4. **The reframe collapses if names are weak or absent.** Today a *custom* Arena config has **no agent name at all** — foregrounding an empty/"Agent 3" label looks broken. **Naming is the dependency for the entire reframe** and must be solved first.
5. **"Aggression drove 2 kills" over-claims causation.** Outcomes are multi-causal and partly stochastic (`choose_action` softmaxes among near-best). Asserting a single slider *caused* a kill will read as wrong to an attentive player and erode trust. Attribute honestly, from real drivers (§6.F).

### 2c. What's missing
- **Persistence — the biggest miss.** The proposal treats agents as per-match. The deepest attachment lever is a **named agent that survives the match, carries a W/L record, kills, and signature moments, and is redeployed and evolves** (`evolution.py` and `familiarity.py` already exist for drift and matchup memory). "Savage Grinder, 7–2, 14 career kills" is a character; "the red Ironjaw" is not.
- **A portable visual fingerprint.** Team color is red/blue (shared). The agent needs *its own* mark — a **sigil/accent color** — so you can track *your* agent on a board of five and recognize it across screens.
- **A voice.** `commentary` exists; attribute it to temperament ("The Berserker doesn't know the word retreat"). Cheap, enormous personality.
- **Shareability.** An exportable agent card (name, temperament, radar, record, signature clip) = identity reinforcement + a viral loop. Free marketing for a betting product.

### 2d. How it should FEEL
Seeing your agent's name on a creature should feel like seeing **your pilot in the cockpit** — pride of authorship plus projection. The neural link should feel like **consciousness being poured into a body**, a summoning, not a progress bar. Watching it fight, you should read each decision as an expression of the personality you set — *"of course it dove in, that's who I built"* — and the (reworked) radar confirms it: recognition is attachment. Post-match, the agent should feel like it **earned** the result. A loss should land as character — *"my Berserker died charging the gate"* — not as "the red one lost." The reframe's job is to turn every outcome into a moment in your agent's story.

---

## 3. Interaction between the two proposals

- **They are one feature.** The budget (P1) produces the *identity content* — a build with a dominant trait, a sharp name, a clear temperament, a distinct silhouette. The reframe (P2) is the *spotlight*. Spotlight with no content = foregrounding bland configs. Content with no spotlight = a soul buried in a settings panel. **Ship them as a unit, sequenced (§8).**
- **The naming engine is the hinge.** Budget → one slider clearly dominates → `suggest_names` emits a sharper, truer name → the reframe reads that name first. Remove the budget and names regress to the mean ("Bold Drifter" for everyone).
- **The radar is the same object three times.** The build silhouette (P1), the in-match decision radar (P2.4), and the post-match performance chart (P2.5) are *the same pentagon.* Exploit this: one visual vocabulary across create → watch → results is what makes the agent feel continuous and real.
- **The sacrifice becomes the story.** The trait you dumped in P1 is the post-match narrative in P2.5: *"Savage Grinder had no positioning — it got cornered. But its aggression took two down with it."* The flaw you chose pays off as drama.
- **Conflict — combined cognitive load.** Budget-juggling + neural-link ceremony + live decision radar + relabeling can overwhelm. Resolution: front-load identity work into *creation* (where the player is acting, not spectating) and keep the *watch* phase visually clean — spectacle first, insight second and optional.

---

## 4. Definitive build spec

> Conventions: all UI is inline-styled React (no Tailwind), JetBrains Mono, dark theme — match existing `Arena.jsx`. Reuse `TEMPERAMENT_COLORS`/`TEMPERAMENT_ICONS` from `Arena.jsx` as each agent's accent. 3D is `Arena3D.jsx` (Three.js). Backend arena logic in `arena_ai.py`, `arena_species.py`, `arena_props.py`, `ai.py`.

### 4.A — Identity data model (the spine)

A deployed agent carries:

```
Agent {
  id            // stable, persists across matches
  name          // "Savage Grinder" — derived, player-editable
  sliders       // {aggression, risk_tolerance, target_focus, positioning, sacrifice}, each 10–90, sum == 250
  temperament   // derived via derive_temperament() — one of 7
  accent        // hex color = TEMPERAMENT_COLORS[temperament] (the agent's sigil color)
  sigil         // small procedural mark (see 4.A.1)
  record        // { wins, losses, matches, kills, deaths }
  level         // existing progression; evolution.py drives slider drift
  signature     // last best moment {matchId, label, clipRef?}
}
```

The board/event payload already carries `agent_name` on each creature (`Arena3D.jsx` reads it). Extend it to also carry `agent_id`, `accent`, and `temperament` so the 3D layer and result screen can render identity without a lookup.

**4.A.1 Sigil:** a small (16px) emblem = the agent's radar pentagon rendered as a filled micro-shape in `accent` color. Zero new art; it's the silhouette shrunk. Used as the agent's chip/marker everywhere.

### 4.B — Point Budget mechanics

- **Budget = 250, conserved exactly.** Per slider **10–90**. Mean 50 (so a "balanced" agent is unchanged; you simply can't max everything).
- **Redistribution model — proportional conservation (spec exactly):**
  - Invariant: `sum(sliders) === 250` at all times.
  - Raising slider *A* by Δ removes Δ total from the **other four**, split **proportionally to each other slider's headroom above its floor** (`value − 10`). A slider at 10 cannot be drained further; if all others are at 10, *A* resists at its current value (you've hit the wall — this is the felt limit).
  - Lowering *A* by Δ adds Δ back to the others **proportionally to headroom below cap** (`90 − value`).
  - Integer-only; resolve rounding drift by dumping the ±1 remainder onto the slider with the most headroom. Deterministic.
  - **Optional per-slider lock** (pin icon): a locked slider is excluded from drain/refill. Max 3 locks (can't lock all).
- **Live feedback (this is the emotional core, not chrome):**
  - A persistent budget readout: `ALLOCATED 250 / 250` with a thin bar.
  - When *A* rises, the draining sliders animate down over **180ms ease-out**, each emitting a floating `−N` tick in muted red that drifts up and fades (600ms). The player *watches the cost being paid.*
  - Hitting the wall: the dragged slider snaps back ~3px with a 1-frame red edge flash + a soft "thunk" (reuse `audio.js`).
- **Live crystallization (the payoff):**
  - **Temperament label** updates in real time from `derive_temperament()`. On a *change* of temperament, play a 250ms scale-pop on the label + temperament icon + a rising chime. This is the "it just told me who it is" moment.
  - **Name**: call `suggest_names()` live (debounced 150ms). Show the top suggestion large; a 🎲 button cycles the 3 suggestions; the field is editable. *Slider→naming-key mapping (required):* `target_focus → king_priority`, `positioning → edge_affinity`, `sacrifice → trade_down` (the rest are 1:1) — `CreatureDraft` already uses this mapping.
  - **Radar** redraws live (the silhouette).
  - **Sacrifice line**: auto-generated from the two lowest sliders, e.g. `GAVE UP: positioning, focus` in muted text under the name.
- **Presets:** a row of 7 archetype chips (the temperaments). Tapping one loads a canonical budget-legal build for that archetype as a starting point. Lowers blank-slate cost; teaches the system.

### 4.C — Draft screen → "Deploy Your Agents" (the Identity Forge)

This screen is the priority surface (§8). Replace the current `CreatureDraft` per-creature card with an **agent-first** card. Visual hierarchy, top to bottom, per card:

1. **AGENT NAME** — 18px / weight 700 / color = `accent`. Editable. With 🎲 re-roll. *(largest text on the card)*
2. **TEMPERAMENT** — `{icon} BERSERKER`, 10px / 700 / `accent`, in a faint `accent`+"15" pill.
3. **RADAR (silhouette)** — ~120px pentagon, filled `accent` at 18% alpha, stroked `accent`. The live build shape.
4. **SACRIFICE LINE** — `GAVE UP: …`, 8px muted.
5. **CHASSIS (species)** — small selector, labeled "CHASSIS," 8px. The species portrait is ~40px (demoted from today's 64px hero). Copy: it's the *body* the agent pilots.
6. **SLIDERS** with the budget bar above them. Same five sliders, now budget-bound (4.B).

Header copy: **"DEPLOY YOUR AGENTS"** (was "RED TEAM / SELECT"). Sub: "You design the pilot. The chassis is just a body."

### 4.D — Neural-link summon (loading → bet-lock)

Triggered on **FIGHT** (sandbox) / match-found (multiplayer). It runs *while the backend simulates*, so it hides latency instead of adding it.

Timeline (first view of a session = **1.8s**; subsequent = **0.8s**, and a user pref "Instant summon" skips to 0.3s):

| t (s) | Event |
|---|---|
| 0.0–0.3 | Board materializes faint; hexes empty; ambient dims (reuse `Arena3D` env-tint). |
| 0.3–0.9 | Each agent **NAME** types in above its hex in `accent`, with the temperament icon. |
| 0.9–1.6 | A **neural-link line** shoots from each name down into its hex; the creature holo-materializes *along* the line (drive the holographic shader's `uDissolve` from 1→0 as the line lands). Sigil flashes. |
| 1.6–1.8 | Snap to full opacity; brief `accent` bloom; idle begins. |

Concurrent: a **"FINAL BETS — locking in N"** countdown overlays the summon (the last-call window). When it hits 0, playback begins. This makes the ceremony *functional* (a bet beat), not dead time. After first view, compress to 0.8s by overlapping stages.

### 4.E — In-match identity

1. **Label swap (the core of P2).** Above each living creature in `Arena3D` (the billboarded label), the hierarchy inverts:
   - **AGENT NAME** — 11px / 700 / `accent` + 14px sigil. *(primary)*
   - species — 6px / muted, beneath. *(secondary)*
   - Keep HP bar as is. The agent's `accent` also tints its projection pool (subtle), so *your* agent is findable at a glance.
2. **Decision radar — REWORKED (subtle, throttled, honest).**
   - **Trigger only on SIGNATURE decisions**, never every action: a kill, a breach-channel start, a Last-Stand action, a major ability (blast/displace/bulwark_pulse), or a high-risk engage. Throttle to **≤1 per 2.5s**.
   - **Visual:** a small pentagon (the agent's silhouette) appears near the actor (or in a fixed "DECISION" slot), with the **dominant driver edge spiking** + one line of text: `▲ AGGRESSION — Savage Grinder commits.` In `accent`. Timing: fade-in 250ms, hold 1000ms, fade-out 400ms.
   - **HONESTY (non-negotiable):** the dominant driver is read from the **real** per-slider contribution to the chosen action (backend emits `drivers`, §6.H.1). If `drivers` is absent, **show nothing** — never fabricate. This is a real-money product; invented "insight" is a trust breach.
   - **Toggle:** a "DECISION INSIGHTS" on/off control (default on in sandbox, **off** during real-money playback to keep the board clean) so bettors choose their density.

### 4.F — Post-match: the agent earns it

Replace species-centric standings with **agent performance cards**:

- Per agent: name (in `accent`), temperament, the **radar silhouette**, and a stat line: kills, damage, survived/how-it-died.
- **Honest attribution** from real drivers: `AGGRESSION-LED — 2 of 2 kills came from aggressive engages` (count actions whose dominant driver matched), **not** "aggression drove 2 kills." If no clear driver, omit.
- **Winner's agents** get a hero frame + `accent` bloom. **Losers** get a one-line, temperament-flavored epitaph: e.g. BERSERKER → *"Charged the gate and never looked back."* MARTYR → *"Died so the others could push."* (Static table keyed by temperament; cheap, characterful.)
- **Record update** (if persistent, §6 add): `Savage Grinder  7–2  ·  +1 kill`.
- **Share card**: one button → render the card to PNG (name, temperament, radar, record, signature line). Identity reinforcement + viral loop.

### 4.G — Betting legibility (protect the money flow)

- Every bettable surface that names a species/team **also shows the agent name + sigil**. Prop chip example: `🏆 SURVIVOR · Ironjaw  (Savage Grinder 🛡)`.
- Bet-result lines attribute to the agent where possible: `Savage Grinder survived — SURVIVOR (Ironjaw) ✓ +N`.
- **New identity-driven prop is desirable but GATED.** "Will *your* agent get a kill?" / "Agent MVP" needs its own probability model and **must pass `arena_props_audit.py`** before going live. Do **not** ship identity props with guessed odds — it breaks the +5% hold guarantee. (Free-play first; real-money only after audit.)

### 4.H — Backend changes (precise)

1. **Emit decision drivers** — `arena_ai._score_action`: accumulate each sub-score into a `drivers` dict `{aggression, risk_tolerance, target_focus, positioning, sacrifice}`; `choose_action` returns `(action, drivers)` for the *chosen* action; the engine attaches `drivers` (and the dominant key) to the `activation` event/result. Powers §4.E.2 and §4.F honestly.
2. **Name on deploy** — when an agent has no name, seed it via `suggest_names()` (apply the slider→key mapping in 4.B). Persist on the agent; propagate to `board_state.agent_name` + result.
3. **Per-agent match stats** — aggregate from events by `agent_id`: kills, damage, deaths, and the **signature moment** = the action with the single highest driver contribution. Return in the match result.
4. **Budget validation (anti-cheat)** — server-side assert each deployed agent: every slider ∈ [10,90] **and** `sum == 250 (±1 rounding)`. Reject otherwise. Mandatory because real money rides on it.
5. **Re-audit (HARD GATE)** — after the budget lands, re-run `scripts/arena_props_audit.py`; re-tune the models in `arena_props.py` until every prop's hold ≈ **+5%**. The budget does not ship to real-money until this passes. Also re-check `docs/ARENA-BALANCE-REPORT.md` assumptions.
6. **Persistence (for the add in §7)** — store named agents with `record`/`level`; let `evolution.py` drift their sliders (re-normalized to 250 after drift) and `familiarity.py` track matchup memory.

### 4.I — Carryover & migration (resolve the constraint)

Imported AC agents (0–100, unconstrained) and the current Arena defaults (sum 230–305) must become budget-legal **without feeling mutated**:

**Normalization algorithm (preserves shape):**
1. Clamp each slider to [10, 90].
2. `s = sum`. If `s == 250`, done.
3. If `s > 250`: remove `(s−250)` distributed proportionally to headroom-above-floor `(value−10)`. If `s < 250`: add `(250−s)` proportionally to headroom-below-cap `(90−value)`. Clamp; iterate until total = 250 and all in range.
4. Round; push ±1 remainder to the slider with the most headroom.

Present it once as **"ARENA RE-ATTUNEMENT"**: show the before→after radar morph and copy *"Your agent has been calibrated for the Arena's power limits."* A *feature*, not a silent nerf. After this, the agent is its recognizable self, budget-legal.

### 4.J — Type scale & color (no ambiguity)

| Element | Size / weight | Color |
|---|---|---|
| Agent name (draft card) | 18 / 700 | `accent` |
| Agent name (in-match label) | 11 / 700 | `accent` |
| Temperament tag | 9–10 / 700 | `accent` on `accent`+"15" |
| Species / "chassis" | 6–8 / 400 | muted `#8892a0` |
| Radar fill / stroke | — | `accent` @18% / `accent` |
| Sacrifice line | 8 / 400 | `#6a7480` |
| Decision insight | 9 / 700 | `accent` |

`accent = TEMPERAMENT_COLORS[temperament]` everywhere. One identity color from create → watch → results.

---

## 5. What I'd add beyond the two proposals

1. **Persistent agents with a record + evolution** *(highest-value addition).* Named agents that survive matches, carry W/L + career kills, redeploy, and drift via `evolution.py`. Turns a config into a character with a history. Without this, every other identity flourish is rendered on something disposable.
2. **The sigil/accent fingerprint** — a procedural mark (the radar, miniaturized) + the agent's own color, so you can *find your agent* among five on the board and recognize it across every screen. (Spec'd in 4.A.1.)
3. **Signature-moment auto-capture** — the agent's single best play (highest driver contribution) auto-clipped from the 3D playback for the share card. Attachment + virality in one.
4. **Agent voice by temperament** — pre-match one-liner taunt, death line, and `commentary` attribution, keyed off the 7 temperaments. A static line table = enormous personality for near-zero cost.
5. **Rivalries** — using `familiarity.py`, let a named agent "remember" a recurring opponent ("Savage Grinder is 3–1 vs Iron Bastion"). Stakes + story across matches.
6. **The radar as the through-line** — commit to one pentagon shared by build, decision insight, and results. It is the cheapest, strongest way to make the agent feel like a single continuous entity.

---

## 6. Priority order

**Build first: the Identity Forge — Point Budget fused with live naming + temperament + radar in the draft screen (P1 + the creation half of P2.2/2.3), behind the props re-audit.**

Why this and not the in-match flourishes:
- **It's the dependency.** No identity content → nothing for the neural link, decision radar, or results to spotlight. Naming and temperament-on-build unblock everything downstream.
- **Attachment is forged at the moment of authorship, not spectatorship.** You bond with what you *make*. The creation screen is where the "settings panel → character" conversion literally happens — which *is* the unresolved problem in the thesis.
- **Lowest risk.** It costs no match-clock time and adds no combat clutter, so it dodges the two biggest hazards in P2 (the ceremony tax and the radar-clutter/trust risk).
- **It makes the existing system finally pay off.** `suggest_names`, `derive_temperament`, the temperament colors — all already in the codebase, currently invisible. This lights them up.

**Sequence after that:** (2) Persistent agents + record (§7.1) — gives the new identities somewhere to live and grow. (3) The in-match label swap + agent accent on the board (§4.E.1) — cheap, high-impact, low-risk. (4) Neural-link summon as bet-lock (§4.D). (5) Decision radar, reworked + honest (§4.E.2) — last, because it's the riskiest and depends on the backend `drivers` work. **Gate before any real-money exposure:** `arena_props_audit.py` green (§4.H.5).

---

## 7. One-paragraph build summary for the developer

Convert the slider panel into an **Identity Forge**: a 250-point conserved budget (sliders 10–90, proportional drain with visible `−N` ticks and a wall-thunk), with a live **temperament** label (`derive_temperament`), a live **name** (`suggest_names`, with the `target_focus→king_priority / positioning→edge_affinity / sacrifice→trade_down` mapping), a live **radar silhouette**, and a "GAVE UP" line — agent name 18px in `TEMPERAMENT_COLORS[temperament]`, species demoted to a small "chassis." Normalize carried-over agents to the budget via the shape-preserving algorithm shown as a one-time "Arena Re-attunement." Then, in order: persist named agents with a record; invert the in-match label to agent-name-primary with an `accent`-tinted pool; add the ≤1.8s neural-link summon that hosts the final bet-lock; and add an honest, throttled decision radar fed by a new `drivers` dict emitted from `arena_ai._score_action`. Validate `sum==250 & 10≤v≤90` server-side, and **do not ship to real money until `scripts/arena_props_audit.py` holds at +5% again.**
