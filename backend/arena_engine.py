"""Arena hex-board engine: board geometry, creature state, turn resolution,
breach channel, collapse, body decay, last stand, and match simulation."""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Optional

from arena_species import (
    Species, SpeciesStats, ActionType, Temperament,
    SPECIES_STATS, damage, derive_temperament,
)

# ---------------------------------------------------------------------------
# Hex grid geometry  (axial coordinates, radius-2, 19 hexes)
# ---------------------------------------------------------------------------

Hex = tuple[int, int]

BOARD_RADIUS = 2

ALL_HEXES: set[Hex] = {
    (q, r)
    for q in range(-BOARD_RADIUS, BOARD_RADIUS + 1)
    for r in range(-BOARD_RADIUS, BOARD_RADIUS + 1)
    if abs(q + r) <= BOARD_RADIUS
}

NEIGHBOR_DIRS: list[Hex] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]


def hex_neighbors(h: Hex) -> list[Hex]:
    q, r = h
    return [(q + dq, r + dr) for dq, dr in NEIGHBOR_DIRS if (q + dq, r + dr) in ALL_HEXES]


def hex_distance(a: Hex, b: Hex) -> int:
    dq = a[0] - b[0]
    dr = a[1] - b[1]
    return max(abs(dq), abs(dr), abs(dq + dr))


def hex_ring(center: Hex, radius: int) -> list[Hex]:
    return [h for h in ALL_HEXES if hex_distance(center, h) == radius]


def hexes_within(center: Hex, radius: int) -> list[Hex]:
    return [h for h in ALL_HEXES if hex_distance(center, h) <= radius]


# Starting positions (Red = top row r=-2, Blue = bottom row r=2)
RED_START: list[Hex] = [(0, -2), (1, -2), (2, -2)]
BLUE_START: list[Hex] = [(-2, 2), (-1, 2), (0, 2)]

RED_GATE: Hex = (1, -2)
BLUE_GATE: Hex = (-1, 2)

# Collapse order: full inward spiral — outer ring first, then the next ring in,
# leaving only the center hex. This lets the shrinking board genuinely squeeze
# survivors and force a resolution (the "collapse" win), instead of only nibbling
# the outer ring (the old behaviour, where collapse could never decide a match).
COLLAPSE_RING = sorted(
    [h for h in ALL_HEXES if h != (0, 0)],
    key=lambda h: (-hex_distance((0, 0), h), h[1], h[0]),
)

# Collapse timing (tunable). With ~7-8 round matches, collapse must hold off until
# the combat phase has played out, then bite hard enough to end stalemates.
COLLAPSE_START_ROUND = 9
COLLAPSE_HEXES_PER_ROUND = 4

# Breach: number of CHANNEL activations on the enemy gate required to break it
# (tunable). Higher = breach is a bigger commitment / easier to interrupt. At 4,
# combined with the off-gate meter decay (see resolve_round), the rusher must
# hold the gate across four of its activations — keeping breach a real-but-
# uncommon win (~25%) instead of an early-game cheese.
BREACH_CHANNEL_TURNS = 4

# P6 (G&E §5.1): Razorwing's Swoop REACH is hard-capped at this many hexes per
# activation, independent of its printed SPD. Every enemy starts dist 4 away and
# melee needs adjacency (a 3-hex move), so a 2-hex swoop cannot reach an attack
# on turn 1 — forcing a 2-phase commit (reposition, then strike next turn) and
# giving both sides a round of Provoke/Displace/Glitch counterplay. Printed SPD
# stays 4 for initiative order and the chase fantasy.
SWOOP_REACH_CAP = 2

# Last Stand only fires for a lone, outnumbered survivor that still has the
# strength to rally (HP at/above this fraction of max). A creature already at
# death's door doesn't mount a heroic stand — this is what keeps the trigger in
# the intended ~50% band instead of firing on essentially every match's mop-up.
LAST_STAND_MIN_HP_FRAC = 0.6

# ---------------------------------------------------------------------------
# Creature & board state
# ---------------------------------------------------------------------------

@dataclass
class Creature:
    id: str
    team: str              # "red" or "blue"
    species: Species
    pos: Hex
    hp: int
    max_hp: int
    atk: int
    def_: int
    spd: int
    agent_name: str = ""

    # personality sliders (0-100)
    aggression: int = 50
    risk_tolerance: int = 50
    target_focus: int = 50
    positioning: int = 50
    sacrifice: int = 50
    temperament: Temperament = Temperament.ADAPTIVE

    # per-match state
    alive: bool = True
    provoked_by: Optional[str] = None  # creature_id that provoked this creature
    shielded: bool = False             # Bulwark Pulse shield active
    stunned: bool = False              # Glitch stun
    burn_remaining: int = 0
    breach_meter: int = 0              # 0, 1, or 2 (at 2 = gate breaks)
    channeling: bool = False

    # ability charges
    pulse_charges: int = 1
    glitch_charges: int = 1
    first_strike_available: bool = True
    chain_dive_active: bool = False    # +1 SPD this turn

    # upgrade equipped (key or None)
    upgrade: Optional[str] = None

    # last stand
    in_last_stand: bool = False

    # body state (after death)
    body_rounds_remaining: int = 0

    @property
    def effective_spd(self) -> int:
        spd = self.spd
        if self.in_last_stand:
            spd += 1
        if self.chain_dive_active:
            spd += 1
        return spd

    @property
    def effective_atk(self) -> int:
        atk = self.atk
        if self.in_last_stand:
            atk += 2
        return atk

    @property
    def effective_def(self, board_state: "BoardState | None" = None) -> int:
        return self.def_

    def provoke_range(self) -> int:
        base = 1
        if self.upgrade == "iron_will":
            base = 2
        if self.in_last_stand:
            base += 1
        return base

    def aegis_range(self) -> int:
        base = 1
        if self.upgrade == "extended_aegis":
            base = 2
        return base

    def displace_range(self) -> int:
        base = 1
        if self.upgrade == "long_arm":
            base = 2
        if self.in_last_stand:
            base += 1
        return base

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "team": self.team,
            "species": self.species.value,
            "pos": list(self.pos),
            "hp": self.hp,
            "max_hp": self.max_hp,
            "atk": self.effective_atk,
            "def": self.def_,
            "spd": self.effective_spd,
            "alive": self.alive,
            "agent_name": self.agent_name,
            "temperament": self.temperament.value,
            "shielded": self.shielded,
            "stunned": self.stunned,
            "burn_remaining": self.burn_remaining,
            "breach_meter": self.breach_meter,
            "channeling": self.channeling,
            "in_last_stand": self.in_last_stand,
            "provoked_by": self.provoked_by,
            "upgrade": self.upgrade,
            # Pilot sliders — drives the radar silhouette through-line (create/watch/results).
            "aggression": self.aggression,
            "risk_tolerance": self.risk_tolerance,
            "target_focus": self.target_focus,
            "positioning": self.positioning,
            "sacrifice": self.sacrifice,
        }


@dataclass
class Body:
    """Dead creature body on the board (obstacle for 3 rounds)."""
    pos: Hex
    rounds_remaining: int = 3
    creature_id: str = ""


@dataclass
class BoardState:
    creatures: list[Creature] = field(default_factory=list)
    bodies: list[Body] = field(default_factory=list)
    voided_hexes: set[Hex] = field(default_factory=set)
    round_num: int = 0

    def creature_at(self, pos: Hex) -> Optional[Creature]:
        for c in self.creatures:
            if c.alive and c.pos == pos:
                return c
        return None

    def body_at(self, pos: Hex) -> Optional[Body]:
        for b in self.bodies:
            if b.pos == pos:
                return b
        return None

    def occupied(self, pos: Hex) -> bool:
        return self.creature_at(pos) is not None or self.body_at(pos) is not None

    def walkable(self, pos: Hex, swoop: bool = False) -> bool:
        if pos in self.voided_hexes or pos not in ALL_HEXES:
            return False
        if swoop:
            return True
        return not self.occupied(pos)

    def team_creatures(self, team: str, alive_only: bool = True) -> list[Creature]:
        return [c for c in self.creatures
                if c.team == team and (not alive_only or c.alive)]

    def enemy_gate(self, team: str) -> Hex:
        return BLUE_GATE if team == "red" else RED_GATE

    def ally_gate(self, team: str) -> Hex:
        return RED_GATE if team == "red" else BLUE_GATE

    def get_def_with_aegis(self, creature: Creature) -> int:
        """Calculate effective DEF including Warden Aegis aura and channel bonus."""
        def_ = creature.def_
        # Channeling DEF bonus: creatures channeling on the gate get +1 DEF
        if creature.channeling:
            def_ += 1
        # Warden Aegis aura: +1 DEF, but does NOT stack across multiple Wardens
        # (otherwise a 3-Warden wall becomes a degenerate def-stack).
        for c in self.creatures:
            if (c.alive and c.team == creature.team
                    and c.id != creature.id
                    and c.species == Species.WARDEN
                    and hex_distance(c.pos, creature.pos) <= c.aegis_range()):
                def_ += 1
                break
        # Ironjaw Bulwark Aura (L15): allies within 1 hex take -1 damage
        for c in self.creatures:
            if (c.alive and c.team == creature.team
                    and c.id != creature.id
                    and c.species == Species.IRONJAW
                    and c.upgrade == "bulwark_aura"
                    and hex_distance(c.pos, creature.pos) <= 1):
                def_ += 1
        return def_

    def snapshot(self) -> dict:
        return {
            "creatures": [c.to_dict() for c in self.creatures],
            "bodies": [{"pos": list(b.pos), "rounds_remaining": b.rounds_remaining,
                        "creature_id": b.creature_id} for b in self.bodies],
            "voided_hexes": [list(h) for h in self.voided_hexes],
            "round_num": self.round_num,
        }


# ---------------------------------------------------------------------------
# Pathfinding / reachability
# ---------------------------------------------------------------------------

def reachable_hexes(pos: Hex, max_dist: int, board: BoardState,
                    swoop: bool = False) -> set[Hex]:
    """BFS to find all hexes reachable within max_dist steps."""
    visited: set[Hex] = {pos}
    frontier = [pos]
    for _ in range(max_dist):
        next_frontier = []
        for h in frontier:
            for n in hex_neighbors(h):
                if n not in visited and board.walkable(n, swoop=swoop):
                    visited.add(n)
                    next_frontier.append(n)
        frontier = next_frontier
    return visited


def find_path(start: Hex, end: Hex, max_dist: int, board: BoardState,
              swoop: bool = False) -> Optional[list[Hex]]:
    """BFS shortest path. Returns path including end, excluding start."""
    if start == end:
        return []
    if end not in ALL_HEXES or end in board.voided_hexes:
        return None
    if not board.walkable(end, swoop=swoop):
        return None

    visited: dict[Hex, Hex] = {start: start}
    frontier = [start]
    for depth in range(max_dist):
        next_frontier = []
        for h in frontier:
            for n in hex_neighbors(h):
                if n not in visited and board.walkable(n, swoop=swoop):
                    visited[n] = h
                    if n == end:
                        path = []
                        cur = end
                        while cur != start:
                            path.append(cur)
                            cur = visited[cur]
                        path.reverse()
                        return path
                    next_frontier.append(n)
        frontier = next_frontier
    return None


# ---------------------------------------------------------------------------
# Action definitions
# ---------------------------------------------------------------------------

@dataclass
class Action:
    type: ActionType
    creature_id: str
    move_to: Optional[Hex] = None       # hex to move to before acting
    target_id: Optional[str] = None     # target creature id
    target_hex: Optional[Hex] = None    # target hex (for displace direction)
    displace_dir: Optional[Hex] = None  # direction to shove (dq, dr)

    def to_dict(self) -> dict:
        d: dict = {"type": self.type.value, "creature_id": self.creature_id}
        if self.move_to:
            d["move_to"] = list(self.move_to)
        if self.target_id:
            d["target_id"] = self.target_id
        if self.target_hex:
            d["target_hex"] = list(self.target_hex)
        if self.displace_dir:
            d["displace_dir"] = list(self.displace_dir)
        return d


@dataclass
class ActionResult:
    action: Action
    damage_dealt: int = 0
    target_killed: bool = False
    splash_damage: dict = field(default_factory=dict)  # creature_id -> dmg
    splash_kills: list[str] = field(default_factory=list)
    breach_meter_value: int = 0
    effects: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {
            "action": self.action.to_dict(),
            "damage_dealt": self.damage_dealt,
            "target_killed": self.target_killed,
            "effects": self.effects,
        }
        if self.splash_damage:
            d["splash_damage"] = self.splash_damage
        if self.splash_kills:
            d["splash_kills"] = self.splash_kills
        if self.breach_meter_value:
            d["breach_meter_value"] = self.breach_meter_value
        return d


# ---------------------------------------------------------------------------
# Match events (for playback)
# ---------------------------------------------------------------------------

@dataclass
class MatchEvent:
    type: str
    round: int
    turn: int = 0
    creature_id: str = ""
    data: dict = field(default_factory=dict)
    board_snapshot: Optional[dict] = None

    def to_dict(self) -> dict:
        d = {"type": self.type, "round": self.round, "turn": self.turn}
        if self.creature_id:
            d["creature_id"] = self.creature_id
        if self.data:
            d["data"] = self.data
        if self.board_snapshot:
            d["board_state"] = self.board_snapshot
        return d


# ---------------------------------------------------------------------------
# Available actions for a creature
# ---------------------------------------------------------------------------

def get_available_actions(creature: Creature, board: BoardState) -> list[Action]:
    """Return all legal actions for a creature this activation."""
    if not creature.alive or creature.stunned:
        return [Action(type=ActionType.HOLD, creature_id=creature.id)]

    actions: list[Action] = []
    cid = creature.id
    swoop = creature.species == Species.RAZORWING
    spd = creature.effective_spd
    # Swoop reach is capped at SWOOP_REACH_CAP (P6); other species move full SPD.
    move_reach = min(spd, SWOOP_REACH_CAP) if swoop else spd
    reach = reachable_hexes(creature.pos, move_reach, board, swoop=swoop)
    enemy_team = "blue" if creature.team == "red" else "red"
    enemy_gate = board.enemy_gate(creature.team)
    provoked_target = creature.provoked_by

    # --- HOLD (always available) ---
    actions.append(Action(type=ActionType.HOLD, creature_id=cid))

    # --- MOVE (move without acting) ---
    for h in reach:
        if h != creature.pos and not board.occupied(h):
            actions.append(Action(type=ActionType.MOVE, creature_id=cid, move_to=h))

    # If provoked, creature must target the provoker
    if provoked_target:
        provoker = next((c for c in board.creatures if c.id == provoked_target and c.alive), None)
        if provoker:
            # Must attack provoker if possible (move adjacent + attack)
            for h in reach:
                if h == creature.pos or not board.occupied(h):
                    land = h if h != creature.pos else creature.pos
                    if hex_distance(land, provoker.pos) == 1:
                        actions.append(Action(type=ActionType.ATTACK, creature_id=cid,
                                              move_to=land if land != creature.pos else None,
                                              target_id=provoker.id))
            # Even if can't reach, the provoke restriction is advisory to AI
            # (AI will prioritize, but we still return other actions)

    # --- ATTACK (melee, range 1) ---
    if creature.species != Species.EMBERCASTER:
        enemies = board.team_creatures(enemy_team)
        for enemy in enemies:
            for h in reach:
                land = h if h != creature.pos else creature.pos
                if board.occupied(land) and land != creature.pos:
                    continue
                if hex_distance(land, enemy.pos) == 1:
                    actions.append(Action(type=ActionType.ATTACK, creature_id=cid,
                                          move_to=land if land != creature.pos else None,
                                          target_id=enemy.id))

    # --- BLAST (Embercaster, range exactly 2, dead zone at 1) ---
    if creature.species == Species.EMBERCASTER:
        can_range_1 = creature.upgrade == "close_quarters"
        enemies = board.team_creatures(enemy_team)
        for h in reach:
            land = h if h != creature.pos else creature.pos
            if board.occupied(land) and land != creature.pos:
                continue
            for enemy in enemies:
                dist = hex_distance(land, enemy.pos)
                if dist == 2 or (can_range_1 and dist == 1):
                    actions.append(Action(type=ActionType.BLAST, creature_id=cid,
                                          move_to=land if land != creature.pos else None,
                                          target_id=enemy.id))
        # Embercaster can also melee if adjacent (weak, but possible)
        for enemy in enemies:
            for h in reach:
                land = h if h != creature.pos else creature.pos
                if board.occupied(land) and land != creature.pos:
                    continue
                if hex_distance(land, enemy.pos) == 1:
                    actions.append(Action(type=ActionType.ATTACK, creature_id=cid,
                                          move_to=land if land != creature.pos else None,
                                          target_id=enemy.id))

    # --- DISPLACE (Hexwright) ---
    if creature.species == Species.HEXWRIGHT:
        disp_range = creature.displace_range()
        all_alive = [c for c in board.creatures if c.alive and c.id != creature.id]
        for h in reach:
            land = h if h != creature.pos else creature.pos
            if board.occupied(land) and land != creature.pos:
                continue
            for target in all_alive:
                if hex_distance(land, target.pos) <= disp_range:
                    for dq, dr in NEIGHBOR_DIRS:
                        dest = (target.pos[0] + dq, target.pos[1] + dr)
                        if dest in ALL_HEXES and dest not in board.voided_hexes and not board.occupied(dest):
                            actions.append(Action(
                                type=ActionType.DISPLACE, creature_id=cid,
                                move_to=land if land != creature.pos else None,
                                target_id=target.id,
                                displace_dir=(dq, dr),
                            ))
                        elif dest in board.voided_hexes:
                            # Ring-out: can shove into void
                            actions.append(Action(
                                type=ActionType.DISPLACE, creature_id=cid,
                                move_to=land if land != creature.pos else None,
                                target_id=target.id,
                                displace_dir=(dq, dr),
                            ))

    # --- BULWARK PULSE (Warden) ---
    if creature.species == Species.WARDEN and creature.pulse_charges > 0:
        allies_in_range = [c for c in board.team_creatures(creature.team)
                           if c.alive and c.id != creature.id
                           and hex_distance(creature.pos, c.pos) <= 1]
        if allies_in_range:
            actions.append(Action(type=ActionType.BULWARK_PULSE, creature_id=cid))
        # Also from reachable positions
        for h in reach:
            if h == creature.pos or board.occupied(h):
                continue
            nearby = [c for c in board.team_creatures(creature.team)
                       if c.alive and c.id != creature.id
                       and hex_distance(h, c.pos) <= 1]
            if nearby:
                actions.append(Action(type=ActionType.BULWARK_PULSE, creature_id=cid,
                                      move_to=h))

    # --- GLITCH (Hexwright) ---
    if creature.species == Species.HEXWRIGHT and creature.glitch_charges > 0:
        enemies = board.team_creatures(enemy_team)
        for h in reach:
            land = h if h != creature.pos else creature.pos
            if board.occupied(land) and land != creature.pos:
                continue
            for enemy in enemies:
                if hex_distance(land, enemy.pos) <= 2:
                    actions.append(Action(type=ActionType.GLITCH, creature_id=cid,
                                          move_to=land if land != creature.pos else None,
                                          target_id=enemy.id))

    # --- CHANNEL (at enemy gate) ---
    if enemy_gate in reach and not board.occupied(enemy_gate):
        actions.append(Action(type=ActionType.CHANNEL, creature_id=cid,
                              move_to=enemy_gate if enemy_gate != creature.pos else None))
    elif creature.pos == enemy_gate:
        actions.append(Action(type=ActionType.CHANNEL, creature_id=cid))

    # Deduplicate (same type + same move_to + same target)
    seen = set()
    unique = []
    for a in actions:
        key = (a.type, a.move_to, a.target_id, a.displace_dir)
        if key not in seen:
            seen.add(key)
            unique.append(a)
    return unique


# ---------------------------------------------------------------------------
# Action resolution
# ---------------------------------------------------------------------------

def resolve_action(action: Action, board: BoardState) -> ActionResult:
    """Resolve a single creature action. Mutates board state. Returns result."""
    creature = next(c for c in board.creatures if c.id == action.creature_id)
    result = ActionResult(action=action)

    # Move first (if specified)
    if action.move_to and action.move_to != creature.pos:
        creature.pos = action.move_to

    if action.type == ActionType.HOLD:
        pass

    elif action.type == ActionType.MOVE:
        pass  # movement already handled above

    elif action.type == ActionType.ATTACK:
        target = next(c for c in board.creatures if c.id == action.target_id)
        atk = creature.effective_atk
        # First Strike (Razorwing L15)
        if creature.first_strike_available and creature.upgrade == "first_strike":
            atk += 2
            creature.first_strike_available = False
            result.effects.append("first_strike")
        target_def = board.get_def_with_aegis(target)
        # Reflect (Warden L25): allies under Aegis reflect 1 dmg to melee
        reflect_dmg = 0
        for w in board.creatures:
            if (w.alive and w.team == target.team and w.species == Species.WARDEN
                    and w.upgrade == "reflect"
                    and hex_distance(w.pos, target.pos) <= w.aegis_range()):
                reflect_dmg = 1
        if target.shielded:
            target.shielded = False
            result.effects.append("shield_absorbed")
        else:
            dmg = damage(atk, target_def)
            target.hp -= dmg
            result.damage_dealt = dmg
            if reflect_dmg > 0:
                creature.hp -= reflect_dmg
                result.effects.append("reflected")
        if target.hp <= 0:
            _kill_creature(target, board)
            result.target_killed = True
            # Shadow Step (Razorwing L25): after kill, move 1 hex
            if creature.upgrade == "shadow_step" and creature.alive:
                _shadow_step(creature, board)
                result.effects.append("shadow_step")
            # Chain Dive: mark for next turn
            if creature.upgrade == "chain_dive":
                creature.chain_dive_active = True
                result.effects.append("chain_dive")
        if creature.hp <= 0:
            _kill_creature(creature, board)
            result.effects.append("attacker_died")

    elif action.type == ActionType.BLAST:
        target = next(c for c in board.creatures if c.id == action.target_id)
        atk = creature.effective_atk
        target_def = board.get_def_with_aegis(target)
        if target.shielded:
            target.shielded = False
            result.effects.append("shield_absorbed")
        else:
            dmg = damage(atk, target_def)
            target.hp -= dmg
            result.damage_dealt = dmg
            # Scorch (L25): apply burn
            if creature.upgrade == "scorch":
                target.burn_remaining = 2
                result.effects.append("scorch_applied")
        if target.hp <= 0:
            _kill_creature(target, board)
            result.target_killed = True
        # Splash: 1 damage to all creatures adjacent to target
        splash_hexes = hex_neighbors(target.pos)
        if creature.upgrade == "wide_blast":
            splash_hexes = hexes_within(target.pos, 1)
        for sh in splash_hexes:
            splash_target = board.creature_at(sh)
            if splash_target and splash_target.id != target.id and splash_target.alive:
                if splash_target.shielded:
                    splash_target.shielded = False
                    result.effects.append(f"shield_absorbed:{splash_target.id}")
                else:
                    s_def = board.get_def_with_aegis(splash_target)
                    s_dmg = max(1, 1 - s_def)  # splash is 1, reduced by DEF
                    splash_target.hp -= s_dmg
                    result.splash_damage[splash_target.id] = s_dmg
                    if splash_target.hp <= 0:
                        _kill_creature(splash_target, board)
                        result.splash_kills.append(splash_target.id)

    elif action.type == ActionType.DISPLACE:
        target = next(c for c in board.creatures if c.id == action.target_id)
        dq, dr = action.displace_dir
        dest = (target.pos[0] + dq, target.pos[1] + dr)
        if dest in board.voided_hexes:
            # Ring-out!
            _kill_creature(target, board)
            result.target_killed = True
            result.effects.append("ring_out")
        elif dest in ALL_HEXES and not board.occupied(dest):
            # Displaced off gate: stop channeling but preserve breach meter
            enemy_gate = board.enemy_gate(target.team)
            if target.pos == enemy_gate and target.channeling:
                target.channeling = False
                result.effects.append("breach_denied")
            target.pos = dest
            result.effects.append("displaced")
        # Clear provoke if target was provoked by displaced creature... no, provoker is the one displaced

    elif action.type == ActionType.BULWARK_PULSE:
        creature.pulse_charges -= 1
        allies_near = [c for c in board.team_creatures(creature.team)
                        if c.alive and c.id != creature.id
                        and hex_distance(creature.pos, c.pos) <= 1]
        for ally in allies_near:
            ally.shielded = True
        result.effects.append(f"pulse_shielded:{len(allies_near)}")

    elif action.type == ActionType.GLITCH:
        target = next(c for c in board.creatures if c.id == action.target_id)
        target.stunned = True
        creature.glitch_charges -= 1
        # If target was channeling, reset breach
        if target.channeling:
            target.breach_meter = 0
            target.channeling = False
            result.effects.append("breach_denied")
        result.effects.append("glitch_applied")

    elif action.type == ActionType.CHANNEL:
        creature.channeling = True
        creature.breach_meter += 1
        result.breach_meter_value = creature.breach_meter
        if creature.breach_meter == 1:
            result.effects.append("breach_start")
        if creature.breach_meter >= BREACH_CHANNEL_TURNS:
            result.effects.append("breach_complete")

    return result


def _kill_creature(creature: Creature, board: BoardState) -> None:
    """Kill a creature and place its body."""
    creature.alive = False
    creature.hp = 0
    body_pos = creature.pos
    # Gate hex never holds a body
    ally_gate = board.ally_gate(creature.team)
    enemy_gate = board.enemy_gate(creature.team)
    if body_pos == ally_gate or body_pos == enemy_gate:
        adj = [h for h in hex_neighbors(body_pos)
               if h not in board.voided_hexes and not board.occupied(h)]
        if adj:
            body_pos = adj[0]
        else:
            body_pos = None
    if body_pos:
        board.bodies.append(Body(pos=body_pos, rounds_remaining=3,
                                  creature_id=creature.id))
    # Final Detonation (Ironjaw L25): on death, 2 damage to all adjacent
    if creature.species == Species.IRONJAW and creature.upgrade == "final_detonation":
        for h in hex_neighbors(creature.pos):
            adj_creature = board.creature_at(h)
            if adj_creature and adj_creature.alive:
                adj_creature.hp -= 2
                if adj_creature.hp <= 0:
                    _kill_creature(adj_creature, board)


def _shadow_step(creature: Creature, board: BoardState) -> None:
    """Razorwing shadow step: move 1 hex after a kill."""
    options = [h for h in hex_neighbors(creature.pos)
               if h not in board.voided_hexes and not board.occupied(h)]
    if options:
        enemy_gate = board.enemy_gate(creature.team)
        options.sort(key=lambda h: hex_distance(h, enemy_gate))
        creature.pos = options[0]


# ---------------------------------------------------------------------------
# Round resolution
# ---------------------------------------------------------------------------

def resolve_round(board: BoardState, ai_fn) -> list[MatchEvent]:
    """Resolve one round. ai_fn(creature, board, actions) -> Action."""
    events: list[MatchEvent] = []
    board.round_num += 1
    turn = 0
    # Honest decision attribution (P2/§6.5): the slider that drove each action.
    try:
        from arena_ai import action_drivers, dominant_driver
    except Exception:  # custom ai_fn / import issue -> no drivers (UI shows nothing)
        def action_drivers(*_a):
            return {}
        def dominant_driver(_d):
            return None

    events.append(MatchEvent(
        type="round_start", round=board.round_num,
        data={"round": board.round_num},
        board_snapshot=board.snapshot(),
    ))

    # --- Pre-round effects ---
    for c in board.creatures:
        if not c.alive:
            continue
        # Burn tick
        if c.burn_remaining > 0:
            c.hp -= 1
            c.burn_remaining -= 1
            events.append(MatchEvent(
                type="burn_tick", round=board.round_num, creature_id=c.id,
                data={"damage": 1, "burn_remaining": c.burn_remaining},
            ))
            if c.hp <= 0:
                _kill_creature(c, board)
                events.append(MatchEvent(
                    type="kill", round=board.round_num, creature_id=c.id,
                    data={"cause": "burn"},
                    board_snapshot=board.snapshot(),
                ))
        # Clear stun
        if c.stunned:
            c.stunned = False
        # Clear chain dive bonus
        c.chain_dive_active = False
        # Clear provoke
        c.provoked_by = None
        # Breach meter decays whenever the creature isn't holding the enemy gate.
        # Progress is lost when a rusher is knocked off or wanders away, so a
        # breach demands SUSTAINED presence rather than scattered taps — this
        # (not raw channel duration) is the main brake on the breach win-rate.
        if c.breach_meter > 0 and c.pos != board.enemy_gate(c.team):
            c.breach_meter -= 1
            c.channeling = False

    # --- Check Last Stand ---
    # A lone survivor only mounts a "Last Stand" when genuinely OUTNUMBERED
    # (enemy has 2+ alive). A 1v1 is a duel, not a last stand — this stops the
    # buff (and the trigger metric) from firing on essentially every match.
    for team in ("red", "blue"):
        alive = board.team_creatures(team)
        enemy = board.team_creatures("blue" if team == "red" else "red")
        if (len(alive) == 1 and len(enemy) >= 2
                and alive[0].hp >= alive[0].max_hp * LAST_STAND_MIN_HP_FRAC
                and not alive[0].in_last_stand):
            survivor = alive[0]
            survivor.in_last_stand = True
            # Supercharge abilities
            if survivor.species == Species.WARDEN:
                survivor.pulse_charges = max(survivor.pulse_charges, 1)
            if survivor.species == Species.HEXWRIGHT:
                survivor.glitch_charges = max(survivor.glitch_charges, 1)
            events.append(MatchEvent(
                type="last_stand", round=board.round_num, creature_id=survivor.id,
                data={"atk_bonus": 2, "spd_bonus": 1},
                board_snapshot=board.snapshot(),
            ))

    # --- Provoke resolution (Ironjaw) ---
    for c in board.creatures:
        if c.alive and c.species == Species.IRONJAW:
            enemy_team = "blue" if c.team == "red" else "red"
            provoke_r = c.provoke_range()
            for enemy in board.team_creatures(enemy_team):
                if hex_distance(c.pos, enemy.pos) <= provoke_r:
                    enemy.provoked_by = c.id

    # --- Sequential activations (SPD order, highest first) ---
    alive = [c for c in board.creatures if c.alive]
    # Group by SPD for simultaneous resolution of ties
    spd_groups: dict[int, list[Creature]] = {}
    for c in alive:
        s = c.effective_spd
        spd_groups.setdefault(s, []).append(c)

    for spd_val in sorted(spd_groups.keys(), reverse=True):
        group = spd_groups[spd_val]
        if len(group) == 1:
            c = group[0]
            if not c.alive:
                continue
            turn += 1
            actions = get_available_actions(c, board)
            chosen = ai_fn(c, board, actions)
            drv = action_drivers(c, board, chosen)   # computed pre-resolution

            # Intent event (for telegraphing)
            intent_data = {"action": chosen.to_dict()}
            events.append(MatchEvent(
                type="intent", round=board.round_num, turn=turn,
                creature_id=c.id, data=intent_data,
            ))

            # Resolve
            result = resolve_action(chosen, board)
            events.append(MatchEvent(
                type="activation", round=board.round_num, turn=turn,
                creature_id=c.id,
                data={"result": result.to_dict(), "drivers": drv,
                      "dominant_driver": dominant_driver(drv)},
                board_snapshot=board.snapshot(),
            ))

            # Kill events
            if result.target_killed:
                events.append(MatchEvent(
                    type="kill", round=board.round_num, turn=turn,
                    creature_id=result.action.target_id,
                    data={"killer": c.id, "cause": result.action.type.value},
                    board_snapshot=board.snapshot(),
                ))
            for sk in result.splash_kills:
                events.append(MatchEvent(
                    type="kill", round=board.round_num, turn=turn,
                    creature_id=sk,
                    data={"killer": c.id, "cause": "splash"},
                    board_snapshot=board.snapshot(),
                ))
            if "breach_complete" in result.effects:
                events.append(MatchEvent(
                    type="breach_complete", round=board.round_num, turn=turn,
                    creature_id=c.id,
                    data={"team": c.team},
                    board_snapshot=board.snapshot(),
                ))
            if "breach_denied" in result.effects:
                events.append(MatchEvent(
                    type="breach_denied", round=board.round_num, turn=turn,
                    creature_id=result.action.target_id or c.id,
                    board_snapshot=board.snapshot(),
                ))
            if "breach_start" in result.effects:
                events.append(MatchEvent(
                    type="breach_start", round=board.round_num, turn=turn,
                    creature_id=c.id,
                    data={"team": c.team, "breach_meter": result.breach_meter_value},
                    board_snapshot=board.snapshot(),
                ))
        else:
            # Speed tie: resolve simultaneously
            turn += 1
            chosen_actions = []
            for c in group:
                if not c.alive:
                    continue
                actions = get_available_actions(c, board)
                chosen = ai_fn(c, board, actions)
                chosen_actions.append((c, chosen))

            # Telegraph all intents (and capture drivers pre-resolution)
            sim_drivers = {}
            for c, chosen in chosen_actions:
                sim_drivers[c.id] = action_drivers(c, board, chosen)
                events.append(MatchEvent(
                    type="intent", round=board.round_num, turn=turn,
                    creature_id=c.id,
                    data={"action": chosen.to_dict(), "simultaneous": True},
                ))

            # Resolve all simultaneously (collect damage, apply after)
            results = []
            for c, chosen in chosen_actions:
                if c.alive:
                    result = resolve_action(chosen, board)
                    results.append((c, result))

            for c, result in results:
                events.append(MatchEvent(
                    type="activation", round=board.round_num, turn=turn,
                    creature_id=c.id,
                    data={"result": result.to_dict(), "simultaneous": True,
                          "drivers": sim_drivers.get(c.id, {}),
                          "dominant_driver": dominant_driver(sim_drivers.get(c.id, {}))},
                    board_snapshot=board.snapshot(),
                ))
                if result.target_killed:
                    events.append(MatchEvent(
                        type="kill", round=board.round_num, turn=turn,
                        creature_id=result.action.target_id,
                        data={"killer": c.id, "cause": result.action.type.value,
                              "simultaneous": True},
                    ))

    # --- Post-round: body decay ---
    decayed = []
    for b in board.bodies:
        b.rounds_remaining -= 1
        if b.rounds_remaining <= 0:
            decayed.append(b)
    for b in decayed:
        board.bodies.remove(b)

    # --- Post-round: Collapse ---
    if board.round_num >= COLLAPSE_START_ROUND:
        collapse_idx = board.round_num - COLLAPSE_START_ROUND
        start = collapse_idx * COLLAPSE_HEXES_PER_ROUND
        end = start + COLLAPSE_HEXES_PER_ROUND
        collapsing = [h for h in COLLAPSE_RING[start:end]
                       if h not in board.voided_hexes]
        if collapsing:
            for h in collapsing:
                board.voided_hexes.add(h)
                victim = board.creature_at(h)
                if victim:
                    _kill_creature(victim, board)
                    events.append(MatchEvent(
                        type="collapse_kill", round=board.round_num,
                        creature_id=victim.id,
                        data={"hex": list(h)},
                        board_snapshot=board.snapshot(),
                    ))
                # Remove bodies on voided hexes
                board.bodies = [b for b in board.bodies if b.pos != h]
            events.append(MatchEvent(
                type="collapse", round=board.round_num,
                data={"hexes": [list(h) for h in collapsing],
                      "total_voided": len(board.voided_hexes)},
                board_snapshot=board.snapshot(),
            ))

    events.append(MatchEvent(
        type="round_end", round=board.round_num,
        board_snapshot=board.snapshot(),
    ))
    return events


# ---------------------------------------------------------------------------
# Win condition checks
# ---------------------------------------------------------------------------

def check_winner(board: BoardState) -> Optional[tuple[str, str]]:
    """Returns (winner_team, method) or None if no winner yet."""
    # Breach complete
    for c in board.creatures:
        if c.breach_meter >= BREACH_CHANNEL_TURNS:
            return (c.team, "breach")

    red_alive = board.team_creatures("red")
    blue_alive = board.team_creatures("blue")

    # Elimination
    if not red_alive and not blue_alive:
        return ("draw", "mutual_elimination")
    if not red_alive:
        return ("blue", "elimination")
    if not blue_alive:
        return ("red", "elimination")

    # Collapse: all hexes voided (shouldn't happen but safety)
    valid = ALL_HEXES - board.voided_hexes
    if len(valid) <= 1:
        # Whoever is alive wins
        if red_alive and not blue_alive:
            return ("red", "collapse")
        if blue_alive and not red_alive:
            return ("blue", "collapse")
        return ("draw", "collapse")

    return None


# ---------------------------------------------------------------------------
# Match setup
# ---------------------------------------------------------------------------

@dataclass
class CreatureConfig:
    species: Species
    agent_name: str = ""
    aggression: int = 50
    risk_tolerance: int = 50
    target_focus: int = 50
    positioning: int = 50
    sacrifice: int = 50
    upgrade: Optional[str] = None
    level: int = 1


def setup_board(red_team: list[CreatureConfig],
                blue_team: list[CreatureConfig]) -> BoardState:
    """Create initial board state from team configurations."""
    board = BoardState()

    for i, cfg in enumerate(red_team[:3]):
        stats = SPECIES_STATS[cfg.species]
        creature = Creature(
            id=f"red_{i}",
            team="red",
            species=cfg.species,
            pos=RED_START[i],
            hp=stats.hp,
            max_hp=stats.hp,
            atk=stats.atk,
            def_=stats.def_,
            spd=stats.spd,
            agent_name=cfg.agent_name,
            aggression=cfg.aggression,
            risk_tolerance=cfg.risk_tolerance,
            target_focus=cfg.target_focus,
            positioning=cfg.positioning,
            sacrifice=cfg.sacrifice,
            temperament=derive_temperament(
                cfg.aggression, cfg.risk_tolerance,
                cfg.target_focus, cfg.positioning, cfg.sacrifice,
            ),
            upgrade=cfg.upgrade,
        )
        # Upgrade-based charge adjustments
        if cfg.upgrade == "double_pulse":
            creature.pulse_charges = 2
        if cfg.upgrade == "double_glitch":
            creature.glitch_charges = 2
        board.creatures.append(creature)

    for i, cfg in enumerate(blue_team[:3]):
        stats = SPECIES_STATS[cfg.species]
        creature = Creature(
            id=f"blue_{i}",
            team="blue",
            species=cfg.species,
            pos=BLUE_START[i],
            hp=stats.hp,
            max_hp=stats.hp,
            atk=stats.atk,
            def_=stats.def_,
            spd=stats.spd,
            agent_name=cfg.agent_name,
            aggression=cfg.aggression,
            risk_tolerance=cfg.risk_tolerance,
            target_focus=cfg.target_focus,
            positioning=cfg.positioning,
            sacrifice=cfg.sacrifice,
            temperament=derive_temperament(
                cfg.aggression, cfg.risk_tolerance,
                cfg.target_focus, cfg.positioning, cfg.sacrifice,
            ),
            upgrade=cfg.upgrade,
        )
        if cfg.upgrade == "double_pulse":
            creature.pulse_charges = 2
        if cfg.upgrade == "double_glitch":
            creature.glitch_charges = 2
        board.creatures.append(creature)

    return board


# ---------------------------------------------------------------------------
# Full match simulation
# ---------------------------------------------------------------------------

MAX_ROUNDS = 14

@dataclass
class ArenaMatchResult:
    winner: str             # "red", "blue", or "draw"
    win_method: str         # "elimination", "breach", "collapse", "mutual_elimination", "timeout"
    total_rounds: int
    events: list[dict]
    red_team: list[dict]
    blue_team: list[dict]
    drama_beats: list[dict]
    final_board: dict

    def to_dict(self) -> dict:
        return {
            "winner": self.winner,
            "win_method": self.win_method,
            "total_rounds": self.total_rounds,
            "events": self.events,
            "red_team": self.red_team,
            "blue_team": self.blue_team,
            "drama_beats": self.drama_beats,
            "final_board": self.final_board,
        }


def simulate_match(red_team: list[CreatureConfig],
                   blue_team: list[CreatureConfig],
                   ai_fn=None) -> ArenaMatchResult:
    """Run a full arena match. ai_fn defaults to random action selection."""
    if ai_fn is None:
        from arena_ai import choose_action as default_ai
        ai_fn = default_ai

    board = setup_board(red_team, blue_team)
    all_events: list[MatchEvent] = []
    drama_beats: list[dict] = []

    # Setup event
    all_events.append(MatchEvent(
        type="match_start", round=0,
        data={
            "red_team": [c.to_dict() for c in board.team_creatures("red")],
            "blue_team": [c.to_dict() for c in board.team_creatures("blue")],
        },
        board_snapshot=board.snapshot(),
    ))

    winner_info = None

    for _ in range(MAX_ROUNDS):
        round_events = resolve_round(board, ai_fn)
        all_events.extend(round_events)

        # Score drama beats
        for ev in round_events:
            beat = _score_drama(ev)
            if beat:
                drama_beats.append(beat)

        # Check winner after each round
        winner_info = check_winner(board)
        if winner_info:
            # If the shrinking board delivered the decisive blow this round,
            # credit the win to "collapse" rather than a clean elimination — the
            # arena closed in on them.
            if winner_info[1] in ("elimination", "mutual_elimination"):
                if any(ev.type == "collapse_kill" for ev in round_events):
                    winner_info = (winner_info[0], "collapse")
            break

    if winner_info is None:
        # The board collapsed in on the survivors (or the round cap was reached)
        # without a clean kill/breach — decide by who weathered it better: most
        # creatures still standing, then total surviving HP. This is the
        # "collapse" win: the arena itself forced the issue.
        red_alive = board.team_creatures("red")
        blue_alive = board.team_creatures("blue")
        red_key = (len(red_alive), sum(c.hp for c in red_alive))
        blue_key = (len(blue_alive), sum(c.hp for c in blue_alive))
        if red_key > blue_key:
            winner_info = ("red", "collapse")
        elif blue_key > red_key:
            winner_info = ("blue", "collapse")
        else:
            winner_info = ("draw", "collapse")

    all_events.append(MatchEvent(
        type="match_end", round=board.round_num,
        data={"winner": winner_info[0], "method": winner_info[1]},
        board_snapshot=board.snapshot(),
    ))

    return ArenaMatchResult(
        winner=winner_info[0],
        win_method=winner_info[1],
        total_rounds=board.round_num,
        events=[e.to_dict() for e in all_events],
        red_team=[c.to_dict() for c in board.creatures if c.team == "red"],
        blue_team=[c.to_dict() for c in board.creatures if c.team == "blue"],
        drama_beats=sorted(drama_beats, key=lambda b: -b.get("score", 0))[:5],
        final_board=board.snapshot(),
    )


def _score_drama(event: MatchEvent) -> Optional[dict]:
    """Score an event for drama value. Returns beat dict or None."""
    if event.type == "kill":
        return {"type": "kill", "round": event.round, "turn": event.turn,
                "creature_id": event.creature_id, "score": 5,
                "data": event.data}
    if event.type == "breach_complete":
        return {"type": "breach_complete", "round": event.round,
                "creature_id": event.creature_id, "score": 10,
                "data": event.data}
    if event.type == "breach_denied":
        return {"type": "breach_denied", "round": event.round,
                "creature_id": event.creature_id, "score": 8}
    if event.type == "last_stand":
        return {"type": "last_stand", "round": event.round,
                "creature_id": event.creature_id, "score": 7}
    if event.type == "collapse_kill":
        return {"type": "ring_out", "round": event.round,
                "creature_id": event.creature_id, "score": 6}
    return None
