"""Bot coaches: named opponents with distinct agent-generation strategies."""

import random
from dataclasses import dataclass, field

from ai import suggest_names

ADJECTIVE_POOLS = {
    "aggression": ["Reckless", "Savage", "Furious", "Relentless", "Vicious"],
    "risk_tolerance": ["Bold", "Fearless", "Daring", "Wild", "Rogue"],
    "king_priority": ["Crowned", "Royal", "Ascending", "Noble", "Imperial"],
    "edge_affinity": ["Fortified", "Walled", "Flanking", "Guarded", "Anchored"],
    "trade_down": ["Grinding", "Patient", "Calculated", "Ruthless", "Efficient"],
}


@dataclass
class Coach:
    id: str
    name: str
    title: str
    strategy: str
    slider_ranges: dict
    preferred_perks: list[str]
    difficulty: str
    name_pool: list[str]
    icon: str = "?"


COACHES = {
    "blitz": Coach(
        id="blitz", name="Coach Blitz", title="All gas, no brakes", icon="⚔",
        strategy="Builds aggressive agents that attack relentlessly. Dangerous early but can overextend in long matches.",
        slider_ranges={"aggression": (75, 100), "risk_tolerance": (70, 95), "king_priority": (15, 40), "edge_affinity": (10, 35), "trade_down": (20, 50)},
        preferred_perks=["momentum"], difficulty="medium",
        name_pool=["Fury", "Blaze", "Storm", "Havoc", "Frenzy", "Inferno", "Thunder", "Rampage"],
    ),
    "fortress": Coach(
        id="fortress", name="The Fortress", title="Walls don't lose", icon="⛨",
        strategy="Builds defensive agents that hold position and grind. Slow to win but hard to beat.",
        slider_ranges={"aggression": (10, 30), "risk_tolerance": (5, 25), "king_priority": (60, 90), "edge_affinity": (70, 100), "trade_down": (50, 80)},
        preferred_perks=["rope_a_dope"], difficulty="medium",
        name_pool=["Bastion", "Rampart", "Shield", "Citadel", "Bulwark", "Ironclad", "Sentinel", "Anchor"],
    ),
    "shark": Coach(
        id="shark", name="The Shark", title="Smells blood in the water", icon="▶",
        strategy="Builds efficient agents that trade when ahead and strangle when behind. Clinical and ruthless.",
        slider_ranges={"aggression": (60, 85), "risk_tolerance": (30, 55), "king_priority": (40, 60), "edge_affinity": (20, 40), "trade_down": (80, 100)},
        preferred_perks=["momentum", "press"], difficulty="hard",
        name_pool=["Viper", "Razor", "Fang", "Talon", "Phantom", "Reaper", "Ghost", "Striker"],
    ),
    "professor": Coach(
        id="professor", name="The Professor", title="Always two steps ahead", icon="◈",
        strategy="Builds balanced agents with no obvious weakness. Adapts perk choice to counter your tendencies.",
        slider_ranges={"aggression": (40, 65), "risk_tolerance": (35, 55), "king_priority": (45, 70), "edge_affinity": (40, 60), "trade_down": (50, 70)},
        preferred_perks=["rope_a_dope", "press", "momentum"], difficulty="hard",
        name_pool=["Scholar", "Sage", "Oracle", "Strategos", "Arbiter", "Theorem", "Axiom", "Vector"],
    ),
    "wildcard": Coach(
        id="wildcard", name="Wildcard", title="Chaos is a ladder", icon="?",
        strategy="Builds completely unpredictable agents. Sometimes brilliant, usually not. Pure entertainment.",
        slider_ranges={"aggression": (10, 100), "risk_tolerance": (10, 100), "king_priority": (10, 100), "edge_affinity": (10, 100), "trade_down": (10, 100)},
        preferred_perks=["rope_a_dope", "press", "momentum"], difficulty="easy",
        name_pool=["Chaos", "Dice", "Glitch", "Jinx", "Flux", "Entropy", "Mayhem", "Scramble"],
    ),
}


def generate_bot_agent(coach: Coach, target_elo: float, player_config: dict | None = None,
                       used_names: set[str] | None = None) -> dict:
    if used_names is None:
        used_names = set()

    config = {}
    for key in ("aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"):
        lo, hi = coach.slider_ranges[key]
        config[key] = random.randint(lo, hi)

    # name from coach pool + adjective from dominant slider
    dominant = max(config, key=config.get)
    adj = random.choice(ADJECTIVE_POOLS.get(dominant, ["Bold"]))
    noun = random.choice(coach.name_pool)
    name = f"{adj} {noun}"
    suffix = 2
    while name in used_names:
        name = f"{adj} {noun} {suffix}"
        suffix += 1
    used_names.add(name)

    # virtual elo
    if coach.difficulty == "easy":
        elo_offset = random.randint(-50, 50)
    elif coach.difficulty == "medium":
        elo_offset = random.randint(-20, 20)
    else:
        elo_offset = random.randint(0, 80)
    virtual_elo = round(target_elo + elo_offset, 1)

    # perk selection
    if coach.id == "professor" and player_config:
        player_agg = player_config.get("aggression", 50)
        if player_agg > 65:
            perk = "rope_a_dope"
        elif player_agg < 35:
            perk = "press"
        else:
            perk = "momentum"
    else:
        perk = random.choice(coach.preferred_perks)

    return {
        "id": None, "name": name, "is_bot": True, "is_random": True,
        "coach_id": coach.id, "coach_name": coach.name,
        **config, "elo": virtual_elo, "level": 5, "perk": perk,
        "wins": 0, "losses": 0, "draws": 0, "matches": 0, "xp": 50, "xp_next": None,
    }


def get_coach_list() -> list[dict]:
    return [{
        "id": c.id, "name": c.name, "title": c.title,
        "strategy": c.strategy, "difficulty": c.difficulty, "icon": c.icon,
    } for c in COACHES.values()]
