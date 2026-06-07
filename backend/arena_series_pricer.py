"""Lineup-conditional series pricer (P3, §7.3 — the gating dependency for series betting).

A Monte-Carlo that plays out a full Bo-N from the *current* series state and the
*exact* current lineup (the only lineup the player has committed for the rest of
the series), emitting **mutually-consistent** probabilities for every series
market in ONE pass: series-win, sweep, go-the-distance, the next game, and
per-creature survival in the next game.

Why this exists: the static marginal prop tables in `arena_props.py` were
calibrated on *single* games and cannot see game-to-game correlation. A series
line priced off them is sharp-exploitable (e.g. sweep vs series-win vs per-game
are totally correlated — §7.2). Deriving them all from ONE simulated series
distribution is the only way to hold the +5% edge once games are coupled.

Odds carry the standard flat house edge: ``odds = (1/p) * (1 - EDGE)`` — exactly
the main book's formula, so the series book holds the same +5% the audits assert.

This is reused by the new standing audit (`scripts/arena_series_audit.py`); no
series market ships real-money until that audit passes (§7.3). Free-play only in
the interim.
"""
from __future__ import annotations

import random

from arena_engine import simulate_match

EDGE = 0.05
# §7.2: clamp per-creature survival so a Razorwing floor (~p=0.02) can't mint a
# ~55x payout (and the matching NO-side leak). p>=0.05 caps survival at ~19x.
SURVIVE_FLOOR = 0.05
# Default Monte-Carlo depth for the live (between-games) price. The audit prices
# at this depth and settles against a larger independent sample, so if this is
# too coarse the audit fails — i.e. this constant is itself under test.
DEFAULT_PRICE_SIMS = 1500


def _alive_ids(team_list: list[dict]) -> set[str]:
    """Ids of creatures still alive at match end (engine dicts carry id + alive)."""
    return {c["id"] for c in team_list if c.get("alive")}


def simulate_series_once(red_cfgs, blue_cfgs, red_score, blue_score, games_played,
                         games_needed, max_games):
    """Play out the remaining games of ONE series from the given state.

    Mirrors the orchestrator's completion rule exactly (main.py `_advance_series`):
    first to ceil(N/2), or higher score once all max_games are played; drawn games
    count for neither side. Returns a dict of this run's outcomes.
    """
    rs, bs, gp = red_score, blue_score, games_played
    first_winner = None
    first_survivors: set[str] = set()
    while rs < games_needed and bs < games_needed and gp < max_games:
        result = simulate_match(red_cfgs, blue_cfgs)
        w = result.winner
        if first_winner is None:
            first_winner = w
            first_survivors = _alive_ids(result.red_team) | _alive_ids(result.blue_team)
        if w == "red":
            rs += 1
        elif w == "blue":
            bs += 1
        gp += 1
    winner = "red" if rs > bs else ("blue" if bs > rs else "draw")
    return {
        "winner": winner,
        "games_played": gp,
        "first_winner": first_winner,
        "first_survivors": first_survivors,
        "final_red": rs,
        "final_blue": bs,
    }


def price_series(red_cfgs, blue_cfgs, *, red_score=0, blue_score=0, games_played=0,
                 games_needed, max_games, n_sims=DEFAULT_PRICE_SIMS, seed=None):
    """Return mutually-consistent probabilities + odds for every series market,
    derived from one Monte-Carlo over the full remaining series.

    Markets (all conditional on the current state + the current locked lineup):
      - series_win: P(red), P(blue)
      - sweep: P(the series ends with the loser on zero games)
      - go_distance: P(all max_games are played)
      - next_game: P(red), P(blue) for the immediately upcoming game
      - survive_next: P(creature still alive at the end of the next game), clamped
    """
    # simulate_match draws from the module-global `random`, so a local Random(seed)
    # would never reach the engine. Seed the global RNG instead — but ONLY when a
    # seed is explicitly given (the audit does, for reproducibility); live pricing
    # passes seed=None and stays nondeterministic so back-to-back games differ.
    if seed is not None:
        random.seed(seed)
    # CreatureConfig has no id; the engine assigns each slot {team}_{index}.
    red_ids = [f"red_{i}" for i in range(len(red_cfgs))]
    blue_ids = [f"blue_{i}" for i in range(len(blue_cfgs))]
    all_ids = red_ids + blue_ids

    red_series = blue_series = draw_series = 0
    sweep = go_distance = 0
    red_next = blue_next = draw_next = 0
    next_played = 0
    survive = {cid: 0 for cid in all_ids}

    for _ in range(n_sims):
        r = simulate_series_once(red_cfgs, blue_cfgs, red_score, blue_score,
                                 games_played, games_needed, max_games)
        if r["winner"] == "red":
            red_series += 1
        elif r["winner"] == "blue":
            blue_series += 1
        else:
            draw_series += 1
        # Sweep ⊂ series-win: won in the MINIMUM number of games (loser on zero,
        # no drawn games padding the count). Naturally zero once the series is
        # already split (e.g. 1-1) or any game drew.
        if r["games_played"] == games_needed and (r["final_red"] == 0 or r["final_blue"] == 0):
            sweep += 1
        if r["games_played"] >= max_games:
            go_distance += 1
        fw = r["first_winner"]
        if fw is not None:
            next_played += 1
            if fw == "red":
                red_next += 1
            elif fw == "blue":
                blue_next += 1
            else:
                draw_next += 1
            for cid in all_ids:
                if cid in r["first_survivors"]:
                    survive[cid] += 1

    def p(count, denom=n_sims):
        return (count / denom) if denom else 0.0

    # series-win & next-game VOID on a draw (§7.2 "price conditional on not-void"),
    # so they are priced on the DECISIVE subset; sweep / go-distance / survival are
    # clean yes/no over every sim (a draw is simply a NO / a survival outcome).
    dec_series = red_series + blue_series
    dec_next = red_next + blue_next
    markets = {
        "series_win": {"red": p(red_series, dec_series), "blue": p(blue_series, dec_series),
                       "void": p(draw_series)},
        "sweep": p(sweep),
        "go_distance": p(go_distance),
        "next_game": {"red": p(red_next, dec_next), "blue": p(blue_next, dec_next),
                      "void": p(draw_next, next_played)},
        "survive_next": {cid: max(SURVIVE_FLOOR, p(survive[cid], next_played)) for cid in all_ids},
    }
    return {"n_sims": n_sims, "next_played": next_played, "markets": markets}


def odds_from_prob(prob: float) -> float:
    """Flat-edge decimal odds, mirroring the main book (main.py:1771-1785)."""
    prob = max(1e-6, min(1.0, prob))
    return round((1.0 / prob) * (1.0 - EDGE), 2)


def price_to_odds(priced: dict) -> dict:
    """Convert a price_series() result into a flat odds book the frontend renders
    and the server settles against. Two-sided where applicable."""
    m = priced["markets"]
    sw, gd = m["sweep"], m["go_distance"]
    return {
        "series_win": {
            "red": odds_from_prob(m["series_win"]["red"]),
            "blue": odds_from_prob(m["series_win"]["blue"]),
        },
        "sweep": {"yes": odds_from_prob(sw), "no": odds_from_prob(1.0 - sw)},
        "go_distance": {"yes": odds_from_prob(gd), "no": odds_from_prob(1.0 - gd)},
        "next_game": {
            "red": odds_from_prob(m["next_game"]["red"]),
            "blue": odds_from_prob(m["next_game"]["blue"]),
        },
        "survive_next": {
            cid: {"yes": odds_from_prob(sp), "no": odds_from_prob(1.0 - sp)}
            for cid, sp in m["survive_next"].items()
        },
    }
