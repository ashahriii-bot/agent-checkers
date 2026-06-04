# Betting Integrity Rules for Multiplayer

Amendment to the betting system. These rules apply ONLY when multiplayer is implemented. Single-player (sandbox and VS BOT) betting remains unrestricted.

## Betting modes by game type

### SANDBOX (player controls both sides)
- Bet on either side (red or black) or draw
- No restrictions. Player is competing against themselves.

### VS BOT (player vs AI coach)
- Bet on either side or draw
- No restrictions. Bot has no financial interest.

### MULTIPLAYER (player vs player)
- You can ONLY bet on yourself to win
- Cannot bet on your opponent winning
- Cannot bet on draw (removes incentive to collude on forced draws)
- Cannot bet on matches you are not participating in (no spectator betting)
- Bet is placed AFTER agent config is locked and BEFORE match simulation

## Implementation

Add a `mode` field to the bet validation logic:

```python
def validate_bet(bet, match_mode, player_side):
    if match_mode == "multiplayer":
        if bet["side"] != player_side:
            raise ValueError("In multiplayer, you can only bet on yourself to win")
        if bet["side"] == "draw":
            raise ValueError("Draw bets are not available in multiplayer")
    # sandbox and vs_bot: no restrictions
```

## UI changes for multiplayer betting

When in a multiplayer match, the betting panel simplifies:

```
         YOUR BET

  You: Savage Grinder (1347)
  Opponent: ??? (1310)

  Odds to win: 1.25x

  Amount: [10] [50] [100] [250] [ALL IN]

  [BET ON YOURSELF]     [SKIP]
```

No opponent bet button. No draw bet button. Just "bet on yourself" or skip.

## Future anti-fraud measures

Implement when adding real-money/crypto betting. NOT needed for in-game coins:

1. **Config viability check**: Reject agents with obviously degenerate configs (all sliders below 10, or configs with historical win rates below 15%). Prevents intentional tanking.
2. **Elo-gated paid matches**: Agents entering paid matches must have 10+ completed matches and 1000+ elo. Prevents throwaway agents.
3. **Graduated bet limits**: New accounts cap at 50 coins per bet. Cap increases with account age and match volume.
4. **Loss rate anomaly detection**: Flag accounts where paid-match win rate is 2+ standard deviations below elo-predicted win rate across 20+ matches.
5. **Smart contract enforcement**: Prize pool contracts accept bets only from matched players, only on their own side. Settlement is automatic.
