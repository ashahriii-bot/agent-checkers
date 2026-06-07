# Arena Series Book Audit

_Held-out test: each series market priced by the lineup-conditional Monte-Carlo (1,200 sims/config), then settled against 4,000 independently-seeded full series per config._

Both sides of every market are bet, plus the correlated basket (series-win-RED + sweep-YES + go-distance-NO). A calibrated, mutually-consistent book holds the **+5% edge** on each — every row must land within ±2 pts.

## Realized hold by market (the acceptance test)

| Market | Realized hold | Bets | Verdict |
|---|---|---|---|
| `series_win` | +4.50% | 22,978 | PASS |
| `next_game` | +4.90% | 23,292 | PASS |
| `sweep` | +5.04% | 24,000 | PASS |
| `go_distance` | +4.93% | 24,000 | PASS |
| `survive_next` | +4.43% | 128,000 | PASS |
| `correlated_basket` | +4.34% | 35,489 | PASS |

_Band: PASS within ±1 pt of +5%, PASS\* within ±2 pt, FAIL beyond._

## Per-config hold

| Series | `series_win` | `next_game` | `sweep` | `go_distance` | `survive_next` | `correlated_basket` |
|---|---|---|---|---|---|---|
| bo3 · balanced 3v3 | +4.8% | +5.3% | +4.7% | +4.7% | +3.7% | +3.9% |
| bo3 · tanks vs glass | +3.8% | +4.3% | +4.8% | +4.8% | +5.3% | +4.5% |
| bo5 · balanced 3v3 | +5.0% | +5.1% | +5.6% | +5.3% | +4.6% | +4.6% |

## Sample priced lines

- **bo3 · balanced 3v3** — series-win red 58% / blue 42% (void 8%); sweep 45%; distance 55%
- **bo3 · tanks vs glass** — series-win red 31% / blue 69% (void 0%); sweep 53%; distance 47%
- **bo5 · balanced 3v3** — series-win red 59% / blue 41% (void 8%); sweep 22%; distance 46%

**PASS** — every series market holds within ±2 pts of +5%. Real-money series markets are cleared by §7.3 (pot-split form only; free-play house-banked otherwise).

_survive_next is the noisiest row (Razorwing floors near the p=0.05 clamp → ~19x payouts); it is aggregated across all creatures to tame variance._