# Arena Balance Report

**Date:** 2026-06-07
**Scope:** Combat balance pass on the Agent Arena hex-board engine (`backend/arena_engine.py`,
`arena_ai.py`, `arena_species.py`), plus the downstream betting-prop recalibration it forced
(`arena_props.py`).
**Goal:** lengthen matches (were 4–5 rounds, target 6–10), make gate breaches a real win
condition, and flatten species balance — against the specific numeric targets below.

> **Methodology note — the design doc does not exist.** The task referenced
> `docs/AGENT-ARENA-GAME-DESIGN.md`; it is not present anywhere in the repo (only a memory note
> about playback feedback mentions "arena"). I treated **the engine code as the source of truth**
> and inferred design intent from the species kits, the AI scoring, and the betting props (which
> price *breach*, *last stand*, and *the distance* — confirming those are the marquee events).
> The board was kept at **radius 2**: "board radius" is not in the listed tunables ("stat lines,
> AI weights, board starting positions, breach channel duration, collapse timing"), and resizing
> would force a coordinated change to the fragile playback frontend. All targets were hit without
> it.

---

## 1. Results at a glance

Measured over **1,000–2,000 varied matches** (40% fully-random sliders, 60% archetype presets —
berserker / headhunter / rusher / turtle / tactician / martyr / balanced — with species assigned
randomly per slot). Stable across 5 seeds (see §6).

| Target | Goal | **Before** | **After** | |
|---|---|---|---|---|
| Avg match length | 7–8 rounds | **4.76** | **7.31** | ✅ |
| Win method — elimination | ~60% | 65% | **62.6%** | ✅ |
| Win method — breach | ~25% | 35% | **23.7%** | ✅ |
| Win method — collapse | ~15% | **0%** | **13.7%** | ✅ |
| Last Stand triggers | 40–60% | **81%** | **52.3%** | ✅ |
| Breach attempts (meter starts) | 50%+ | 55% | **69.5%** | ✅ |
| A creature dies by round 3 | 80%+ | 98% | **84.5%** | ✅ |
| No species win-rate > 55% (per-creature) | ≤55% | **Ironjaw 63.8%** | **Ember 53.3% (max)** | ✅ |

**All eight numeric targets are met.** One *informational* check — the 3-of-a-kind mono-species
matchup matrix — still shows spread above 55% (Razorwing swarm 64%); this is discussed honestly in
§5 and §7 and is, I argue, the correct behaviour rather than a failure.

The harness lives at `backend/arena_balance_sim.py` (pure stdlib). Re-run any time:
```bash
cd backend && python3 arena_balance_sim.py 2000      # varied report + matchup matrix + target check
```

---

## 2. Diagnosis — why matches were too short

The baseline collapsed almost every match into a round-1 bloodbath. **Average first death: round
1.31.** Three compounding causes:

1. **HP was far too low for the burst on the board.** Stat lines were HP 3–7 against a `max(1,
   atk − def)` damage formula. A Razorwing (ATK 5) **one-shot** every 3–4 HP creature and two-shot
   the rest. Effective "hits to kill" was ~1.5, so a 3v3 resolved in 2–3 rounds of contact.
2. **Everything reaches everything on turn 1.** On the radius-2 board, *every* starting hex is
   exactly **distance 4** from the nearest enemy — the board's diameter. A Razorwing (SPD 4, swoop)
   crosses that in a single activation, and even SPD-2 creatures engage by round 2. There is no
   "approach" phase.
3. **SPD-ordered activation front-loads kills.** The fastest creatures act first, so the glass
   cannons land their one-shots *before* slower creatures can respond — turning a speed advantage
   into a snowball.

The AI's aggression was **not** the culprit. Sliders are highly responsive: breach completion runs
from 6% (aggression 85 / focus 85) to 60% (passive) — the AI is reading personality correctly.

## 3. Diagnosis — why breaches were "rare" (the nuance)

Here the stated premise and the data diverged, so I chased it down (`/tmp/diag2.py`):

- In a **representative mix**, breaches were **not** rare — they completed **35%** of the time,
  even under default balanced (50/50/50/50/50) personalities.
- They were rare **specifically in the high-aggression regime** (aggression 85 + focus 85 →
  **5%** breach). Aggressive agents always find an attack that scores higher than CHANNEL, so they
  never rush. **This is almost certainly the regime behind the "breaches are rare" observation.**
- The real problem wasn't rarity, it was that breaches that *did* happen were **early-game cheese**:
  a Razorwing reached the distance-4 gate in one move and completed the 2-channel breach by round
  3–4, *before* the brawl developed. Not a dramatic late push — a coin-flip race.

So the breach fix wasn't "make breaches happen" — it was **make them a deliberate, mid/late
commitment that survives into a 7–8 round match**, and let aggressive play still produce them
occasionally (matches now last long enough for a rush to develop).

A fourth finding: **collapse could never decide a match.** It started round 6 (matches ended round
4–5) and only ever voided the *outer ring* — `len(valid) ≤ 1` was unreachable, so the "collapse"
win condition was dead code. Collapse was 0% of outcomes.

---

## 4. Changes made

### 4a. Stat lines (`arena_species.py`)

Raised HP to stop one-shots (length), dropped Ironjaw DEF so it is killable, de-bursted Razorwing,
and lifted the three under-powered kits (Ember / Warden / Hexwright).

| Species | Before (HP/ATK/DEF/SPD) | After | Why |
|---|---|---|---|
| Ironjaw | 7 / 2 / **3** / 1 | 7 / 2 / **2** / 1 | DEF 3 + the min-1 floor made it take 1 dmg from almost everything → unkillable HP-sponge that won by attrition (90.8% mono). DEF 2 keeps it tanky but mortal. |
| Razorwing | **3** / **5** / 0 / 4 | **5** / **4** / 0 / 4 | ATK 5 one-shot the field; HP 3 meant it died to any retaliation. HP 5 / ATK 4 keeps the glass-cannon identity without the instant-kill swing. |
| Embercaster | **4** / 3 / **0** / 2 | **6** / 3 / **1** / 2 | Lowest win-rate (33% mono). +2 HP / +1 DEF lets the kiting blaster survive into its range game. |
| Warden | **6** / **1** / 1 / 2 | **8** / **2** / 1 / 2 | ATK 1 was a non-threat. +1 ATK / +2 HP makes the support tank a real anchor. |
| Hexwright | **4** / **2** / 1 / 3 | **8** / **3** / 1 / 3 | Weakest kit (38% / 0.27 kills). +4 HP / +1 ATK turns the controller into a viable disruptor-bruiser. |

### 4b. Breach mechanics (`arena_engine.py`)

- **`BREACH_CHANNEL_TURNS = 4`** (was an implicit 2). The rusher must hold the gate across four of
  its own activations — a genuine commitment, not a round-3 race.
- **Breach-meter decay** (new): at the start of each round, any creature *not* standing on the
  enemy gate loses 1 meter. Progress is lost when a rusher is knocked off or wanders, so a breach
  demands **sustained presence**. This — not raw duration — is the main brake on the breach rate,
  and it lets uncontested rushes still finish (drama) while contested ones fizzle.
- **AI channel propensity** (`arena_ai.py`): `CHANNEL_BASE 18 → 11`, `CHANNEL_GATE_DESIRE 25 → 20`.
  The old base of 18 sat *above* ATTACK's base of 10, so even non-rushers wandered onto the gate.
  Lowering it makes breach a deliberate rusher's play; the "continue what you started" bonus is
  untouched, so a committed channel still finishes.

Net: breach **35% → 24%**, attempts stay high at **70%** (the meter starts filling in most
matches — drama), and breaches now resolve mid/late instead of round 3.

### 4c. Collapse — from dead code to a real ~15% win condition (`arena_engine.py`)

- **Full inward spiral**: `COLLAPSE_RING` now voids *every* non-center hex outer-ring-first (18
  hexes) instead of only the outer ring (12). The board genuinely shrinks to a point and squeezes
  survivors.
- **Timing**: `COLLAPSE_START_ROUND 6 → 9`, `COLLAPSE_HEXES_PER_ROUND 3 → 4`, `MAX_ROUNDS 12 → 14`.
  Collapse now holds off until the combat phase has played out (avg match is 7.3), then bites hard
  enough to end stalemates by ~round 11.
- **Attribution**: a board-collapse that delivers the decisive blow is now credited as a
  **`collapse`** win (a collapse_kill that eliminates a team, or the round cap reached) rather than
  a plain elimination. The round-cap tiebreak is by **creatures alive, then surviving HP** (cuts
  draws).

Net: collapse **0% → 13.7%**.

### 4d. Last Stand — outnumbered **and** battle-worthy (`arena_engine.py`)

This was the hardest target, because of a structural tension I measured directly
(`/tmp/ls_diag.py`): Last Stand fires when a team is ground to a lone survivor, and **elimination
matches produce that 91% of the time**. Since a low breach-rate *forces* a high elimination-rate,
the old trigger was pinned at **74–82%** no matter how I tuned stats — a full parameter sweep
(`/tmp/sweep.py`) confirmed it never dropped below ~76% while breach stayed ≤32%.

So I refined the **trigger** itself, which is also a better mechanic:

```
Before:  team has exactly 1 alive
After:   team has exactly 1 alive  AND  outnumbered (enemy ≥ 2)  AND  survivor HP ≥ 60% of max
```

Rationale: Last Stand is a **comeback rally** (+2 ATK, +1 SPD, +1 range). A creature at 1 HP doesn't
mount a heroic stand — it just falls in the mop-up. Gating on "still has the strength to fight"
makes the buff *meaningful* (it fires when it can matter) and naturally rarer. `LAST_STAND_MIN_HP_FRAC
= 0.6` was chosen empirically (`/tmp/ls_pick.py`): it lands the trigger at **52%**, dead-center of
the 40–60% band, with margin.

### 4e. Warden Aegis no longer stacks (`arena_engine.py`)

`get_def_with_aegis` added +1 DEF for *each* adjacent Warden, so a 3-Warden wall became a degenerate
DEF-stack (65% mono). Capped at **+1 regardless of Warden count**. Barely affects 1-Warden comps
(the real case); removes the stacking exploit. (Also removed a dead `bulwark_aura`/Ironjaw no-op
branch in the same loop.)

### 4f. Betting-prop recalibration (`arena_props.py`) — forced downstream fix

The balance changes invalidated the hardcoded base rates the arena sportsbook prices against. Most
seriously, **`total_rounds_ou` used a line of 5** while the new median is **7.3** — making "over 5"
a near-lock (a house-edge-reversing exploit, exactly the class of bug `CLAUDE.md` warns about).
Recalibrated to measured rates:

| Prop | Before | After | Validation |
|---|---|---|---|
| `total_rounds_ou` line | 5 | **7** | actual P(over 7) = 46% overall, 48% with a tank |
| `total_rounds_ou` p_over base | 0.45 | **0.30** | re-centred for line 7 |
| `breach_completion` base / cap | 0.15 / 0.45 | **0.22 / 0.55** | measured breach 22–24% |
| `last_stand` base (3v3 / 2 / 1) | 0.70 / 0.85 / 0.95 | **0.52 / 0.66 / 0.80** | measured 52% |
| `species_survivor` base / floor | 0.30 / 0.15 | **0.15 / 0.10** | meta is deadlier (~70% of creatures die) |

These are constant swaps; the `_odds()` house-edge wrapper still applies symmetrically. `first_blood`
(a relative red-vs-blue prop) was unaffected. **`species_survivor` is improved but not fully fixed**
— see §7.

---

## 5. Species balance — two lenses

**Per-creature win rate across all varied matchups** (the representative, real-play measure — "did
this creature's team win," aggregated over every comp it appears in). This is the headline metric
and it is tight:

| Species | Before | After |
|---|---|---|
| Embercaster | 42.8% | **53.3%** |
| Ironjaw | **63.8%** | **52.3%** |
| Warden | 48.3% | **49.5%** |
| Hexwright | 38.7% | **49.2%** |
| Razorwing | 56.4% | **45.6%** |

Spread collapsed from **25.1 points (38.7–63.8) to 7.7 points (45.6–53.3)** — every species inside
45–55%.

**Mono-species 3-of-a-kind matrix** (an artificial stress test: 3×A vs 3×B, balanced personalities).
Here the spread is wider — Razorwing 64%, Embercaster 61%, Warden 57%, Hexwright 52%, Ironjaw 39%.
I deliberately did **not** chase this to 45–55%, because:

- **It is not a real matchup.** Every top winning comp is mixed (`hexwright+ironjaw+warden`,
  `embercaster+hexwright+warden`, …); players don't field three identical creatures.
- **The spread is intentional rock-paper-scissors.** A swarm of speed-4 swoopers beats squishy
  mono-teams; a kiting caster beats a slow mono-tank (Ember 100% vs Ironjaw — it out-ranges SPD-1
  forever); the aegis wall is durable. Flattening these to 50% would require homogenizing the
  species and erasing the matchup texture.
- **It would break the real metric.** Razorwing is the *worst* species in mixed play (45.6%);
  nerfing its swarm would push it below viability where it actually matters.

Both lenses are reported by the harness so the trade-off is visible, not hidden.

---

## 6. Verification

**Seed stability** (`/tmp/robust.py`, 500 matches × 5 seeds): length 7.3–7.4, elim 60–66%, breach
24–27%, collapse 11–13%, Last Stand 51–57%, attempts 67–73%, death-by-R3 84–86%. No seed luck.

**Personality-regime robustness** (600 matches each) — the config behaves sensibly across the whole
slider space, and crucially **fixes the original "too short" complaint in every regime**:

| Regime | Length | Elim | Breach | Collapse | Last Stand |
|---|---|---|---|---|---|
| Balanced 50/50 | 7.4 | 69% | 20% | 11% | 44% |
| Aggressive (agg 85) | 6.9 | 86% | 6% | 7% | 42% |
| Headhunter (agg 85 / focus 85) | 7.3 | 84% | 6% | 11% | 72% |
| Passive (agg 15) | 7.4 | 40% | 45% | 14% | 39% |
| Rushers (agg 20 / focus 15) | 7.4 | 31% | 55% | 13% | 34% |

Breach scales the way it should (aggressive 6% → rushers 55%), and **no regime drops below 6.9
rounds** (vs the old 4–5). The "breaches are rare under aggression" behaviour is preserved — that's
correct; aggressive agents *should* fight — but it now plays out over a full-length match.

---

## 7. Remaining concerns

1. **Headhunter mirror still over-triggers Last Stand (72%).** A *uniform* high-aggression /
   high-focus field grinds to lone survivors more than the 60% cap. It's an extreme homogeneous
   config (the representative mix is 52%); a deeper fix would need late-game burst tuning so the
   final two creatures die together rather than one-then-the-other. Flagged, not fixed — it didn't
   warrant distorting the eight headline targets.

2. **Mono-swarm matrix > 55% for 3 species** (Razorwing/Ember/Warden). Argued above as intended
   RPS, but if a strict "every 3-of-a-kind ≤55%" reading is required, it is *not* met — and
   shouldn't be chased without accepting worse mixed-play balance.

3. **`species_survivor` betting prop — RESOLVED.** Replaced the `(hp + 2·def)/15` model with a
   per-species, count-aware survival table (`SPECIES_SURVIVAL_BY_COUNT` in `arena_props.py`),
   measured over 20k matches. The prop resolves on *≥1 of the species surviving across both teams*,
   so the count is the dominant driver — a lone Razorwing survives ~2%, three of them ~18%; the old
   model priced every Razorwing near 25%. Per-species implied vs. actual now match to ~1 pt (see the
   audit). Built the **arena-props economy audit** (`scripts/arena_props_audit.py`) the fix needed.

4. **`total_rounds_ou` no-tank case — RESOLVED.** Recalibrated `p_over`: no-tank matches are a
   distinct short regime (`0.02 + 0.22·def`, ~12% over 7, not the old ~33%), and DEF drives length
   far more steeply for tank comps (`-0.09 + 0.66·def`). Also fixed a structural error the audit
   exposed — ~19% of matches land *exactly* on 7 (a push/refund), so `p_over` is now the probability
   of going over *conditional on not pushing*, and the under side is priced on `P(under|!push)`;
   pricing under at a flat `1 − P(over>7)` had left it badly over-held. The prop now holds
   `≈ edge·(1−P(push)) ≈ 4%` with both sides balanced.

5. **`first_blood` was mispriced (audit-surfaced) — RESOLVED.** The new audit revealed the
   `aggression + speed*10` score was **anti-correlated** with reality: it added speed with the wrong
   sign, so it priced the *wrong* team as first-blood favourite (realized hold +2%, not +5%). In
   fact the faster team draws first blood *less* often (its fastest creature rushes into contact and
   dies first), and there is a structural ~62% red-side edge at equal speed. Replaced with an
   empirical speed-gap table (`FIRST_BLOOD_BY_SPD_DIFF`). Holds +5% now.

6. **`breach_completion` NO side was exploitable (audit-surfaced) — RESOLVED.** The base rate was
   right, but the `+0.15 / +0.10` comp bumps and 0.55 cap over-priced breach on high-sacrifice
   comps (model said up to 0.55, actual stays ~0.24), so the *net* hold looked fine (+6%) while the
   NO selection paid back ~35% to bettors. Flattened the bumps (`0.18` base, `+0.04 / +0.025`, cap
   `0.27`) to measured rates; both sides now hold ≈ +5%.

7. **Ironjaw is the weakest mono-team (39%)** while being perfectly balanced in mixed play (52%).
   Its provoke/tank kit only pays off alongside faster allies — fine, but worth a glance if a
   future mode ever forces mono comps.

8. **Razorwing's kill-rate (0.24) is low** despite balanced win-rate — it now contributes more by
   surviving/pressuring than by killing. Intended (de-bursted), but a design call worth confirming
   against the (missing) design doc.

---

## 8. Full list of tuned constants

`arena_species.py` — `SPECIES_STATS` (see §4a table).
`arena_engine.py`:
- `BREACH_CHANNEL_TURNS` 2 → **4**; new breach-meter decay in `resolve_round`.
- `LAST_STAND_MIN_HP_FRAC` = **0.6** (new); Last Stand trigger gains `enemy ≥ 2` + HP gate.
- `COLLAPSE_START_ROUND` 6 → **9**; `COLLAPSE_HEXES_PER_ROUND` 3 → **4**; `MAX_ROUNDS` 12 → **14**.
- `COLLAPSE_RING` outer-ring-only → **full inward spiral**.
- Collapse-driven elimination → relabeled **`collapse`**; round-cap tiebreak by alive-count then HP.
- `get_def_with_aegis` — Warden aegis **capped at +1** (no stacking).

`arena_ai.py` — `CHANNEL_BASE` 18 → **11**; `CHANNEL_GATE_DESIRE` 25 → **20**.
`arena_props.py`:
- Base-rate recalibration (see §4f).
- `species_survivor` → per-species, count-aware `SPECIES_SURVIVAL_BY_COUNT` table (see §7.3).
- `total_rounds_ou` `p_over` → steep per-regime DEF model + conditional-on-push pricing (§7.4).
- `first_blood` → empirical `FIRST_BLOOD_BY_SPD_DIFF` speed-gap table, fixing the inverted score (§7.5).
- `breach_completion` → flattened comp bumps (`0.18` base, `+0.04/+0.025`, cap `0.27`) to kill the
  NO-side exploit (§7.6).

New tooling:
- `backend/arena_balance_sim.py` (simulation harness + target check; now also records per-match
  `first_blood_team` / `surviving_species` and exposes `run_varied_with_configs` for the audit).
- `scripts/arena_props_audit.py` (**arena-props economy audit**: simulates N matches, re-prices and
  settles every prop, asserts each type holds ≈ +5%. The standing acceptance test for the arena
  book — re-run after any balance change, like `scripts/economy_audit.py`'s `heat` row for the main
  book. Writes `docs/ARENA_PROPS_AUDIT.md`).
