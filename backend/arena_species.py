"""Arena creature species: stats, abilities, upgrades, and temperament derivation."""

from dataclasses import dataclass
from enum import Enum


class Species(str, Enum):
    IRONJAW = "ironjaw"
    RAZORWING = "razorwing"
    EMBERCASTER = "embercaster"
    WARDEN = "warden"
    HEXWRIGHT = "hexwright"


class ActionType(str, Enum):
    MOVE = "move"
    ATTACK = "attack"
    BLAST = "blast"
    DISPLACE = "displace"
    BULWARK_PULSE = "bulwark_pulse"
    GLITCH = "glitch"
    CHANNEL = "channel"
    HOLD = "hold"


class Temperament(str, Enum):
    BERSERKER = "BERSERKER"
    HEADHUNTER = "HEADHUNTER"
    STALKER = "STALKER"
    TURTLE = "TURTLE"
    MARTYR = "MARTYR"
    TACTICIAN = "TACTICIAN"
    ADAPTIVE = "ADAPTIVE"


@dataclass(frozen=True)
class SpeciesStats:
    hp: int
    atk: int
    def_: int
    spd: int


@dataclass(frozen=True)
class UpgradeInfo:
    level: int
    name: str
    key: str
    description: str


# NOTE: Original (pre-balance) stat lines, kept for reference:
#   IRONJAW hp7 atk2 def3 spd1 | RAZORWING hp3 atk5 def0 spd4 | EMBERCASTER hp4 atk3 def0 spd2
#   WARDEN hp6 atk1 def1 spd2 | HEXWRIGHT hp4 atk2 def1 spd3
# Rebalanced 2026-06-07: HP raised to stop one-shots (longer matches), Ironjaw DEF 3->2 so
# it is killable, Razorwing ATK 5->4 to de-burst, weak species (Ember/Warden/Hex) buffed.
# Re-tuned 2026-06-07 (P6 Swoop 2-hex cap): the cap removed Razorwing's turn-1 dive, dropping
# it to 37% and floating Embercaster (its natural counter) to 58%. Razorwing HP 5->6 lets it
# survive the new 2-turn commit (also raises its solo-survival per G&E §5.1); Embercaster HP
# 6->5 returns artillery to fragile. See docs/ARENA-BALANCE-REPORT.md.
SPECIES_STATS: dict[Species, SpeciesStats] = {
    Species.IRONJAW:     SpeciesStats(hp=7, atk=2, def_=2, spd=1),
    Species.RAZORWING:   SpeciesStats(hp=6, atk=5, def_=0, spd=4),
    Species.EMBERCASTER: SpeciesStats(hp=5, atk=3, def_=1, spd=2),
    Species.WARDEN:      SpeciesStats(hp=8, atk=2, def_=1, spd=2),
    Species.HEXWRIGHT:   SpeciesStats(hp=8, atk=3, def_=1, spd=3),
}

SPECIES_UPGRADES: dict[Species, list[UpgradeInfo]] = {
    Species.IRONJAW: [
        UpgradeInfo(5,  "Iron Will",        "iron_will",        "Provoke range extends to 2 hexes"),
        UpgradeInfo(15, "Bulwark Aura",     "bulwark_aura",     "Allies within 1 hex take -1 damage while Ironjaw lives"),
        UpgradeInfo(25, "Final Detonation", "final_detonation", "On death, deal 2 damage to all adjacent creatures"),
    ],
    Species.RAZORWING: [
        UpgradeInfo(5,  "Chain Dive",   "chain_dive",   "+1 SPD on the turn after a kill"),
        UpgradeInfo(15, "First Strike", "first_strike", "First attack each match crits for +2 damage"),
        UpgradeInfo(25, "Shadow Step",  "shadow_step",  "After a kill, immediately move 1 hex"),
    ],
    Species.EMBERCASTER: [
        UpgradeInfo(5,  "Wide Blast",      "wide_blast",      "Splash radius extends to more adjacent hexes"),
        UpgradeInfo(15, "Close Quarters",  "close_quarters",  "Can fire Blast at range 1 (closes dead zone)"),
        UpgradeInfo(25, "Scorch",          "scorch",          "Blast applies 1 dmg/turn burn for 2 turns to primary target"),
    ],
    Species.WARDEN: [
        UpgradeInfo(5,  "Extended Aegis", "extended_aegis", "Aegis range extends to 2 hexes"),
        UpgradeInfo(15, "Double Pulse",   "double_pulse",   "Bulwark Pulse can be used twice per match"),
        UpgradeInfo(25, "Reflect",        "reflect",        "Allies under Aegis reflect 1 damage to melee attackers"),
    ],
    Species.HEXWRIGHT: [
        UpgradeInfo(5,  "Long Arm",       "long_arm",       "Displace range extends to 2 hexes"),
        UpgradeInfo(15, "Double Glitch",  "double_glitch",  "Glitch can be used twice per match"),
        UpgradeInfo(25, "Translocate",    "translocate",    "Displace can swap positions of two creatures"),
    ],
}


SLIDER_HIGH = 65
SLIDER_LOW = 35


def derive_temperament(aggression: int, risk_tolerance: int,
                        target_focus: int, positioning: int,
                        sacrifice: int) -> Temperament:
    """Derive a one-word temperament tag from the dominant slider combination."""
    h_agg = aggression >= SLIDER_HIGH
    l_agg = aggression <= SLIDER_LOW
    l_risk = risk_tolerance <= SLIDER_LOW
    h_focus = target_focus >= SLIDER_HIGH
    h_pos = positioning >= SLIDER_HIGH
    h_sac = sacrifice >= SLIDER_HIGH

    if h_agg and l_risk:
        return Temperament.BERSERKER
    if h_agg and h_focus:
        return Temperament.HEADHUNTER
    if l_agg and h_focus and h_sac:
        return Temperament.STALKER
    if h_pos and l_agg:
        return Temperament.TURTLE
    if h_sac and l_risk:
        return Temperament.MARTYR
    if h_pos and h_focus:
        return Temperament.TACTICIAN
    return Temperament.ADAPTIVE


def get_available_upgrades(species: Species, level: int) -> list[UpgradeInfo]:
    """Return all upgrades unlocked at the given level for a species."""
    return [u for u in SPECIES_UPGRADES[species] if u.level <= level]


def damage(atk: int, def_: int) -> int:
    """Core damage formula. Minimum 1 damage always gets through."""
    return max(1, atk - def_)


SPECIES_COLORS = {
    Species.IRONJAW:     "#5B8FA8",
    Species.RAZORWING:   "#DC143C",
    Species.EMBERCASTER: "#FF8C00",
    Species.WARDEN:      "#DAA520",
    Species.HEXWRIGHT:   "#8A2BE2",
}

SPECIES_ICONS = {
    Species.IRONJAW:     "\U0001f9b7",
    Species.RAZORWING:   "\U0001f985",
    Species.EMBERCASTER: "\U0001f525",
    Species.WARDEN:      "\U0001f6e1️",
    Species.HEXWRIGHT:   "⬡",
}
