"""Arena creature AI: personality-driven action selection using the 5 slider system."""

from __future__ import annotations

import random
from typing import Optional

from arena_species import Species, ActionType, damage
from arena_engine import (
    Action, BoardState, Creature, Hex,
    hex_distance, hex_neighbors, reachable_hexes,
)

# Base desirability of starting/continuing a gate CHANNEL. Kept below ATTACK's
# base (10) so breach is a deliberate rusher's play, not a default wander.
CHANNEL_BASE = 11.0
CHANNEL_GATE_DESIRE = 20.0  # multiplier on (low-aggression + low-focus) gate pull


# Slider normalization: 0-100 -> 0.0-1.0
def _norm(val: int) -> float:
    return val / 100.0


def choose_action(creature: Creature, board: BoardState,
                   actions: list[Action]) -> Action:
    """Pick the best action for a creature based on its personality sliders."""
    if len(actions) == 1:
        return actions[0]

    scored = [(a, _score_action(creature, board, a)) for a in actions]
    scored.sort(key=lambda x: -x[1])

    # Small jitter for variety (top actions within 10% of best get a chance)
    best_score = scored[0][1]
    threshold = best_score * 0.9 if best_score > 0 else best_score - 1
    candidates = [(a, s) for a, s in scored if s >= threshold]

    if len(candidates) > 1:
        weights = [max(0.1, s) for _, s in candidates]
        total = sum(weights)
        weights = [w / total for w in weights]
        r = random.random()
        cumulative = 0
        for i, w in enumerate(weights):
            cumulative += w
            if r <= cumulative:
                return candidates[i][0]

    return scored[0][0]


def action_drivers(creature: Creature, board: BoardState, action: Action) -> dict:
    """Per-slider contribution to the CHOSEN action, read from the real scoring
    levers in `_score_action`. Used for honest post-match / in-match attribution —
    the dominant key is the slider that most drove this action. Returns {} when no
    single slider clearly drives the action (then the UI shows nothing — never
    fabricate). NOT a full score decomposition; it surfaces the primary levers."""
    agg = _norm(creature.aggression)
    risk = _norm(creature.risk_tolerance)
    focus = _norm(creature.target_focus)
    pos = _norm(creature.positioning)
    sac = _norm(creature.sacrifice)
    enemy_team = "blue" if creature.team == "red" else "red"
    enemies = board.team_creatures(enemy_team)
    target = next((c for c in board.creatures if c.id == action.target_id), None) if action.target_id else None
    d: dict[str, float] = {}
    t = action.type

    if t in (ActionType.ATTACK, ActionType.BLAST):
        d["aggression"] = (15 if t == ActionType.ATTACK else 12) * agg
        if target:
            dmg = damage(creature.effective_atk, board.get_def_with_aegis(target))
            if dmg >= target.hp and sac > 0.5:
                d["sacrifice"] = 8 * sac
            if enemies and focus > 0.5 and target.hp == min(e.hp for e in enemies):
                d["target_focus"] = 10 * focus
    elif t == ActionType.MOVE:
        d["aggression"] = 8 * agg
        d["target_focus"] = 10 * (1 - focus)   # gate-rush lever is LOW focus
        if pos > 0.5:
            d["positioning"] = 6 * pos
    elif t == ActionType.CHANNEL:
        d["sacrifice"] = 8 * sac
        d["target_focus"] = 10 * (1 - focus)
        d["aggression"] = 10 * (1 - agg)       # gate-rush = low aggression
    elif t == ActionType.DISPLACE:
        d["positioning"] = 10 * pos
        d["target_focus"] = 8 * focus
    elif t == ActionType.GLITCH:
        d["target_focus"] = 10 * focus
        d["positioning"] = 6 * pos
    elif t == ActionType.BULWARK_PULSE:
        d["positioning"] = 10 * pos
        d["sacrifice"] = 5 * sac

    return {k: round(v, 2) for k, v in d.items() if v > 0.5}


def dominant_driver(drivers: dict) -> Optional[str]:
    """The slider that most drove an action, or None if no drivers."""
    return max(drivers, key=drivers.get) if drivers else None


def _score_action(creature: Creature, board: BoardState,
                   action: Action) -> float:
    """Score an action for a creature. Higher = better."""
    agg = _norm(creature.aggression)
    risk = _norm(creature.risk_tolerance)
    focus = _norm(creature.target_focus)
    pos = _norm(creature.positioning)
    sac = _norm(creature.sacrifice)

    score = 0.0
    enemy_team = "blue" if creature.team == "red" else "red"
    enemy_gate = board.enemy_gate(creature.team)
    ally_gate = board.ally_gate(creature.team)
    enemies = board.team_creatures(enemy_team)
    allies = [c for c in board.team_creatures(creature.team) if c.id != creature.id]

    landing = action.move_to or creature.pos

    # If provoked, heavily favor attacking the provoker
    if creature.provoked_by and action.target_id == creature.provoked_by:
        score += 50

    if action.type == ActionType.HOLD:
        score += 1.0
        if creature.species == Species.IRONJAW:
            score += 5 * (1 - agg)

    elif action.type == ActionType.MOVE:
        score += _score_movement(creature, board, landing, agg, risk, focus, pos, sac,
                                  enemies, allies, enemy_gate, ally_gate)

    elif action.type == ActionType.ATTACK:
        score += _score_attack(creature, board, action, agg, risk, focus, sac, enemies)

    elif action.type == ActionType.BLAST:
        score += _score_blast(creature, board, action, agg, focus, sac)

    elif action.type == ActionType.DISPLACE:
        score += _score_displace(creature, board, action, agg, focus, pos, sac,
                                  enemies, allies, enemy_gate)

    elif action.type == ActionType.BULWARK_PULSE:
        score += _score_pulse(creature, board, action, pos, sac, allies)

    elif action.type == ActionType.GLITCH:
        score += _score_glitch(creature, board, action, focus, pos)

    elif action.type == ActionType.CHANNEL:
        score += _score_channel(creature, board, agg, risk, focus, sac,
                                 enemies, enemy_gate)

    # Breach defense: when an enemy is channeling, heavily prioritize interruption
    enemy_channelers = [e for e in enemies if e.channeling]
    if enemy_channelers:
        score += _breach_defense_modifier(creature, board, action,
                                           enemy_channelers[0])

    # Positioning bonus: prefer staying near allies (formation)
    if action.move_to:
        score += _position_score(landing, creature, board, pos, allies, enemy_gate, ally_gate)

    # Risk assessment: penalize landing in danger
    if action.move_to and action.type not in (ActionType.CHANNEL,):
        danger = _danger_at(landing, creature, board, enemies)
        risk_penalty = danger * (1.5 - risk)
        # Arena overextension (G&E §2.3): the arena had no counter to reckless
        # aggression (checkers has calc_overextension_factor; the arena had none),
        # so max-aggression was pure upside. Now a reckless dive carries a cost.
        risk_penalty += _overextension_penalty(creature, board, landing, enemies, allies, pos)
        score -= risk_penalty

    return score


# ---------------------------------------------------------------------------
# Movement scoring
# ---------------------------------------------------------------------------

def _score_movement(creature, board, landing, agg, risk, focus, pos, sac,
                     enemies, allies, enemy_gate, ally_gate):
    score = 2.0

    # Aggression: move toward enemies
    if enemies:
        nearest_enemy = min(enemies, key=lambda e: hex_distance(landing, e.pos))
        dist_to_enemy = hex_distance(landing, nearest_enemy.pos)
        old_dist = min(hex_distance(creature.pos, e.pos) for e in enemies)
        if dist_to_enemy < old_dist:
            score += 8 * agg
        else:
            score += 3 * (1 - agg)

    # Gate rush: move toward enemy gate
    dist_to_gate = hex_distance(landing, enemy_gate)
    old_gate_dist = hex_distance(creature.pos, enemy_gate)
    gate_approach = (1 - focus)  # low target_focus = high gate priority
    if creature.species == Species.RAZORWING:
        gate_approach *= 2.0
    if dist_to_gate < old_gate_dist:
        score += 10 * gate_approach

    # Low-aggression creatures near enemy gate get a gate rush bonus
    if dist_to_gate <= 2 and agg < 0.4:
        score += 6

    # Sacrifice: move into dangerous positions for strategic gain
    if sac > 0.6:
        if dist_to_gate <= 1:
            score += 4 * sac

    return score


# ---------------------------------------------------------------------------
# Attack scoring
# ---------------------------------------------------------------------------

def _score_attack(creature, board, action, agg, risk, focus, sac, enemies):
    target = next((c for c in board.creatures if c.id == action.target_id), None)
    if not target:
        return 0

    score = 10.0

    # Base: aggression drives attack desire
    score += 15 * agg

    # Damage potential
    target_def = board.get_def_with_aegis(target)
    dmg = damage(creature.effective_atk, target_def)
    can_kill = dmg >= target.hp

    if can_kill:
        score += 25  # kills are very valuable
        if target.channeling:
            score += 20  # killing a channeler is critical
    else:
        score += dmg * 3

    # Target focus: prefer low-HP targets
    if focus > 0.5 and enemies:
        lowest_hp = min(e.hp for e in enemies)
        if target.hp == lowest_hp:
            score += 10 * focus

    # Prioritize channelers
    if target.channeling:
        score += 30

    # Risk: attacking a dangerous target
    if target.effective_atk > creature.hp:
        score -= 5 * (1 - risk)

    # Sacrifice: worth dying to get the kill
    if can_kill and sac > 0.5:
        score += 8 * sac

    # Low-aggression creatures near enemy gate prefer rushing over fighting
    enemy_gate = board.enemy_gate(creature.team)
    if agg < 0.3 and hex_distance(creature.pos, enemy_gate) <= 2:
        score -= 5

    return score


# ---------------------------------------------------------------------------
# Blast scoring (Embercaster)
# ---------------------------------------------------------------------------

def _score_blast(creature, board, action, agg, focus, sac):
    target = next((c for c in board.creatures if c.id == action.target_id), None)
    if not target:
        return 0

    score = 12.0
    score += 12 * agg

    target_def = board.get_def_with_aegis(target)
    dmg = damage(creature.effective_atk, target_def)
    can_kill = dmg >= target.hp

    if can_kill:
        score += 20
    else:
        score += dmg * 3

    # Splash value: how many creatures near the target
    splash_targets = [c for c in board.creatures
                       if c.alive and c.id != target.id
                       and hex_distance(c.pos, target.pos) == 1]
    enemy_splash = [c for c in splash_targets if c.team != creature.team]
    ally_splash = [c for c in splash_targets if c.team == creature.team]

    score += len(enemy_splash) * 8
    # Friendly fire penalty (unless high sacrifice)
    score -= len(ally_splash) * (12 - 8 * sac)

    # Focus: target lowest HP
    if focus > 0.5:
        enemies = board.team_creatures("blue" if creature.team == "red" else "red")
        if enemies:
            lowest_hp = min(e.hp for e in enemies)
            if target.hp == lowest_hp:
                score += 8 * focus

    if target.channeling:
        score += 25

    return score


# ---------------------------------------------------------------------------
# Displace scoring (Hexwright)
# ---------------------------------------------------------------------------

def _score_displace(creature, board, action, agg, focus, pos, sac,
                     enemies, allies, enemy_gate):
    target = next((c for c in board.creatures if c.id == action.target_id), None)
    if not target:
        return 0

    dq, dr = action.displace_dir
    dest = (target.pos[0] + dq, target.pos[1] + dr)
    score = 5.0

    is_ally = target.team == creature.team
    is_enemy = not is_ally

    if is_enemy:
        # Shove enemy off gate (deny breach)
        if target.channeling:
            score += 40

        # Ring-out (into void)
        if dest in board.voided_hexes:
            score += 35
            return score

        # Shove enemy into danger (away from their allies, toward our team)
        if allies:
            for ally in allies:
                if hex_distance(dest, ally.pos) == 1:
                    score += 8  # push into ally attack range

        # Shove Ironjaw out of Provoke position
        if target.species == Species.IRONJAW:
            # Check if Ironjaw was blocking a gate approach
            if hex_distance(target.pos, enemy_gate) <= 2:
                score += 12

        score += 8 * agg

    else:
        # Shove ally toward enemy gate (offensive combo)
        ally_gate_dist_before = hex_distance(target.pos, enemy_gate)
        ally_gate_dist_after = hex_distance(dest, enemy_gate)
        if ally_gate_dist_after < ally_gate_dist_before:
            score += 15 * (1 - focus)  # gate rush assist
            if target.species == Species.RAZORWING:
                score += 8  # combo with diver

        # Peel: shove ally away from danger
        enemy_threats = [e for e in enemies if hex_distance(e.pos, target.pos) == 1]
        if enemy_threats and target.hp <= 2:
            score += 10 * pos  # positioning-aware peeling

    return score


# ---------------------------------------------------------------------------
# Bulwark Pulse scoring (Warden)
# ---------------------------------------------------------------------------

def _score_pulse(creature, board, action, pos, sac, allies):
    landing = action.move_to or creature.pos
    allies_in_range = [a for a in allies
                        if a.alive and hex_distance(landing, a.pos) <= 1]
    if not allies_in_range:
        return 2.0

    score = 8.0

    # Value based on how threatened the allies are
    for ally in allies_in_range:
        hp_pct = ally.hp / ally.max_hp
        if hp_pct <= 0.5:
            score += 15  # critical save
        elif hp_pct <= 0.75:
            score += 8
        else:
            score += 3

        # Extra value if ally is channeling
        if ally.channeling:
            score += 20

    score += 10 * pos  # positioning-minded players value shielding

    # Don't waste pulse early if no threat
    enemies = board.team_creatures("blue" if creature.team == "red" else "red")
    threat_near = any(hex_distance(a.pos, e.pos) <= 2
                       for a in allies_in_range for e in enemies)
    if not threat_near:
        score *= 0.3  # save it

    return score


# ---------------------------------------------------------------------------
# Glitch scoring (Hexwright)
# ---------------------------------------------------------------------------

def _score_glitch(creature, board, action, focus, pos):
    target = next((c for c in board.creatures if c.id == action.target_id), None)
    if not target:
        return 0

    score = 8.0

    # Stun a channeler (deny breach)
    if target.channeling:
        score += 35

    # Stun the biggest threat
    if target.effective_atk >= 4:
        score += 12

    # Stun a creature about to act (high SPD)
    if target.effective_spd >= 3:
        score += 6

    # Focus: stun the carry
    if focus > 0.6:
        enemies = board.team_creatures("blue" if creature.team == "red" else "red")
        if enemies:
            highest_atk = max(e.effective_atk for e in enemies)
            if target.effective_atk == highest_atk:
                score += 10 * focus

    return score


# ---------------------------------------------------------------------------
# Channel scoring
# ---------------------------------------------------------------------------

def _score_channel(creature, board, agg, risk, focus, sac, enemies, enemy_gate):
    # Lower base than ATTACK (10) so casual creatures don't wander onto the gate;
    # breach should be a deliberate rusher's play, not a default. The "continue"
    # bonus below still makes a committed channel finish fast (an early breach),
    # which is what keeps breach a *rare-but-early* win instead of a late grind.
    score = CHANNEL_BASE

    # Gate rush desire: inverse of aggression, amplified by low target_focus
    gate_desire = (1 - agg) * 0.5 + (1 - focus) * 0.5
    score += CHANNEL_GATE_DESIRE * gate_desire

    # Razorwing is the natural gate rusher
    if creature.species == Species.RAZORWING:
        score += 12

    # Already channeling: continue!
    if creature.channeling and creature.breach_meter >= 1:
        score += 35  # one more activation to win

    # Risk: how many enemies can reach the gate
    threats = [e for e in enemies
               if hex_distance(e.pos, enemy_gate) <= e.effective_spd + 1]
    if threats:
        # Each threat reduces appeal (unless high risk tolerance)
        score -= len(threats) * (5 - 4 * risk)

    # Open lane bonus: no enemies within 2 hexes of enemy gate
    enemies_near_gate = [e for e in enemies
                         if hex_distance(e.pos, enemy_gate) <= 2]
    if not enemies_near_gate:
        score += 10

    # Sacrifice: willing to die trying
    score += 8 * sac

    # If only 1 enemy left and it's far, channel is safe
    if len(enemies) == 1 and hex_distance(enemies[0].pos, enemy_gate) > 3:
        score += 15

    return score


# ---------------------------------------------------------------------------
# Position & danger scoring helpers
# ---------------------------------------------------------------------------

def _breach_defense_modifier(creature, board, action, channeler):
    """When breach is active, bias all defending creatures toward interrupting."""
    bonus = 0.0
    dist = hex_distance(creature.pos, channeler.pos)
    meter_urgency = 1.0 + channeler.breach_meter * 0.4

    if action.type == ActionType.MOVE and action.move_to:
        new_dist = hex_distance(action.move_to, channeler.pos)
        if new_dist < dist:
            bonus += 15
        elif new_dist > dist and dist > 1:
            bonus -= 8

    if action.type == ActionType.HOLD and dist > 1:
        bonus -= 10

    if action.target_id == channeler.id:
        bonus += 10

    return bonus * meter_urgency


def _position_score(landing, creature, board, pos, allies, enemy_gate, ally_gate):
    score = 0.0

    # Near allies (formation)
    if allies:
        avg_ally_dist = sum(hex_distance(landing, a.pos) for a in allies if a.alive) / max(1, len([a for a in allies if a.alive]))
        score += (3 - min(3, avg_ally_dist)) * pos * 2

    # Not too close to own gate (don't retreat too far)
    gate_dist = hex_distance(landing, ally_gate)
    if gate_dist <= 1:
        score -= 3 * (1 - pos)  # defensive players don't mind

    # Ironjaw: value being near own gate
    if creature.species == Species.IRONJAW:
        if hex_distance(landing, ally_gate) <= 1:
            score += 8 * (1 - creature.aggression / 100)

    # Warden: value being near allies for Aegis
    if creature.species == Species.WARDEN:
        adj_allies = [a for a in allies if a.alive and hex_distance(landing, a.pos) <= creature.aegis_range()]
        score += len(adj_allies) * 4 * pos

    return score


def _overextension_penalty(creature, board, landing, enemies, allies, pos):
    """Punish reckless overextension (G&E §2.3 + task 2.2). Returned value is ADDED
    to the landing-danger penalty (i.e. subtracted from the action score).

    (a) Glass berserker: when aggression>70 AND risk_tolerance>70, amplify the
        landing danger — mirrors checkers, where those two together flip greedy
        over-valuation into a penalty. This is the build that escapes the normal
        danger term (high risk shrinks `(1.5 - risk)`), so it must be re-priced.
    (b) Situational isolation: charging toward the enemy gate, no ally within 2,
        adjacent to 2+ enemies, at <=50% HP. Cost scales with low positioning —
        a high-positioning Pilot avoids this; a low-positioning one charges in
        anyway (its personality — now with a real cost)."""
    penalty = 0.0
    agg100, risk100 = creature.aggression, creature.risk_tolerance
    if agg100 > 70 and risk100 > 70:
        overext = ((agg100 - 70) / 30.0) * ((risk100 - 70) / 30.0)
        danger = _danger_at(landing, creature, board, enemies)
        penalty += danger * overext * 0.6

    enemy_gate = board.enemy_gate(creature.team)
    if hex_distance(landing, enemy_gate) < hex_distance(creature.pos, enemy_gate):
        ally_near = any(a.alive and hex_distance(landing, a.pos) <= 2 for a in allies)
        adj_enemies = sum(1 for e in enemies if hex_distance(landing, e.pos) == 1)
        if not ally_near and adj_enemies >= 2 and creature.hp <= creature.max_hp * 0.5:
            penalty += 6.0 * (1 - pos)

    return penalty


def _danger_at(pos, creature, board, enemies):
    """Estimate how much danger a creature faces at a given position."""
    danger = 0.0
    for e in enemies:
        dist = hex_distance(pos, e.pos)
        if dist <= e.effective_spd:
            # Enemy can reach us next turn
            potential_dmg = damage(e.effective_atk, board.get_def_with_aegis(creature))
            if potential_dmg >= creature.hp:
                danger += 8  # lethal threat
            else:
                danger += potential_dmg
        elif dist <= e.effective_spd + 1:
            danger += 1  # nearby threat
    return danger
