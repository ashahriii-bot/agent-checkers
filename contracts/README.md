# Agent Checkers Escrow Contract

USDC match-escrow for real-play mode on Base. The server (owner) reports results;
the contract holds stakes and pays out 95% to the winner, 5% to the house.

## Setup

```bash
# install foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup

cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
```

`lib/` mappings are auto-detected; if not, add `remappings.txt`:
```
@openzeppelin/=lib/openzeppelin-contracts/
forge-std/=lib/forge-std/src/
```

## Test

```bash
forge test -vvv
```

Covers: escrow on create/join, 95/5 winner split, draw split, owner-only settle,
invalid-winner rejection, creator cancel delay, fee cap.

## Deploy (testnet FIRST)

USDC addresses:
- Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

```bash
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export HOUSE_WALLET=0xYourHouseWallet
export DEPLOYER_PRIVATE_KEY=0x...        # deployer becomes owner (the settlement oracle)
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export BASESCAN_API_KEY=...

forge script script/Deploy.s.sol:DeployEscrow \
  --rpc-url base_sepolia --broadcast --verify
```

Then set the deployed address as `ESCROW_CONTRACT_ADDRESS` in the server env.

## Pre-mainnet checklist (do NOT skip)

1. `forge test` passes.
2. `slither src/AgentCheckersEscrow.sol` — resolve all high/medium findings.
3. Full testnet run of the live flow (create → join → settle → cancel) with testnet USDC.
4. Professional audit before any real money on mainnet.
5. The owner key (settlement oracle) = `HOUSE_PRIVATE_KEY` on the server. Store in a
   KMS for production, never in git. It can release escrowed funds, so treat it as
   the most sensitive secret in the system.

## Trust model

Financial trustlessness: once funded, only the contract releases funds, and every
settlement emits an auditable on-chain event. The server is the *match* oracle (same
model as online poker). On-chain match verification is a future upgrade, not v1.
