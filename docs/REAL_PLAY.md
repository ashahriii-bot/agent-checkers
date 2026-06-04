# Real Play (USDC on Base) — Operator Setup

Real play is **dark by default**. With none of the env vars below set, the server
runs free-play only and the REAL PLAY toggle never appears. Setting them "lights up"
real play. Do the steps in order; do **not** skip the audit before mainnet money.

## 1. Smart contract (testnet first)

See `contracts/README.md`. Summary:
1. `forge test` passes.
2. Deploy to **Base Sepolia** with testnet USDC, run the full flow.
3. `slither` the contract; fix high/medium findings.
4. Professional audit.
5. Deploy to Base mainnet, verify on BaseScan.

## 2. Privy

1. Create an app at privy.io, enable email login + embedded wallets.
2. Copy the App ID and App Secret.

## 3. Server dependencies

Real play needs `web3` + `eth-account`, deliberately kept out of the default image:

```bash
pip install -r backend/requirements-crypto.txt
```

When going live, add that line to the `Dockerfile` pip step so the deployed image
includes it. (Until then the Docker build stays lean and the crypto modules no-op.)

## 4. Environment variables (Railway)

```
BASE_RPC_URL=https://mainnet.base.org
ESCROW_CONTRACT_ADDRESS=0x...           # from step 1
HOUSE_WALLET_ADDRESS=0x...              # fee recipient + custody
HOUSE_PRIVATE_KEY=0x...                 # settlement oracle key — KMS in prod, NEVER in git
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...
USDC_CONTRACT_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
MOONPAY_API_KEY=...                     # optional, enables BUY WITH CARD
```

`GET /api/crypto/status` reports `enabled: true` once `BASE_RPC_URL`,
`ESCROW_CONTRACT_ADDRESS`, `HOUSE_WALLET_ADDRESS`, and `HOUSE_PRIVATE_KEY` are all set
and `web3` is installed.

## 5. What v1 does vs. defers

- **v1 (this build):** per-player USDC balances (server ledger), Privy wallet
  provisioning, deposits (address + MoonPay), withdrawals (house sponsors gas),
  real-money PvP matchmaking with 5% house fee, transaction history. Settlement is
  **custodial** against the server ledger.
- **Deferred (Phase 2):** per-match on-chain escrow (`createMatch`/`joinMatch`/
  `settleMatch`). The contract is built and tested; wiring it needs **client-side
  wallet signing** so each player funds the escrow directly. Until then the escrow
  contract is the settlement layer to migrate to, not the v1 path.
- Side action / props in real play settle on the server ledger (off-chain), by design.
- Tournaments are free-play only in v1.

## 6. Guardrails already enforced

- Bet range $0.01–$10.00; real queue separate from free, matched by exact stake tier.
- Real-play agents must be level 3+ with 10+ matches (anti-throwaway).
- Withdrawals: $1.00 minimum, balance reserved before send and refunded on failure.
- Settlement conserves value: players' combined net = −5% house fee per match.

## 7. Still your call (not done in code)

- Regulatory posture (real-money wagering = money-transmitter/gaming-license territory;
  jurisdiction gating, KYC via the onramp).
- Withdrawal delay for fresh card deposits (anti-fraud) — add if/when card onramp is live.
- Moving the `HOUSE_PRIVATE_KEY` into a KMS.
