"""Blockchain interactions for real-play (USDC on Base).

Dark by default: if web3 is not installed OR the env vars are not configured,
`crypto_service.available` is False and every method raises CryptoUnavailable.
The rest of the app (free play) is completely unaffected.

USDC has 6 decimals. Internally everything is integer micro-USDC (1 USDC = 1_000_000).
"""

import os
import time

try:
    from web3 import Web3
    from eth_account import Account
    _WEB3_INSTALLED = True
except ImportError:  # web3 not in the (production) image — that's fine
    Web3 = None
    Account = None
    _WEB3_INSTALLED = False


class CryptoUnavailable(Exception):
    pass


# Minimal ABIs (only the methods we call).
ERC20_ABI = [
    {"constant": True, "inputs": [{"name": "_owner", "type": "address"}],
     "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}], "type": "function"},
    {"constant": True, "inputs": [], "name": "decimals",
     "outputs": [{"name": "", "type": "uint8"}], "type": "function"},
    {"constant": False, "inputs": [{"name": "_to", "type": "address"}, {"name": "_value", "type": "uint256"}],
     "name": "transfer", "outputs": [{"name": "", "type": "bool"}], "type": "function"},
]

ESCROW_ABI = [
    {"inputs": [{"name": "matchId", "type": "bytes32"}, {"name": "betAmount", "type": "uint256"}],
     "name": "createMatch", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "matchId", "type": "bytes32"}],
     "name": "joinMatch", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "matchId", "type": "bytes32"}, {"name": "winner", "type": "address"}],
     "name": "settleMatch", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "matchId", "type": "bytes32"}],
     "name": "cancelMatch", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]

USDC_DECIMALS = 6
MICRO = 10 ** USDC_DECIMALS


def usdc_to_micros(amount_usdc: float) -> int:
    return int(round(amount_usdc * MICRO))


def micros_to_usdc(micros: int) -> float:
    return micros / MICRO


class CryptoService:
    def __init__(self):
        self.rpc_url = os.environ.get("BASE_RPC_URL", "")
        self.escrow_address = os.environ.get("ESCROW_CONTRACT_ADDRESS", "")
        self.usdc_address = os.environ.get("USDC_CONTRACT_ADDRESS", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
        self.house_wallet = os.environ.get("HOUSE_WALLET_ADDRESS", "")
        self._house_key = os.environ.get("HOUSE_PRIVATE_KEY", "")
        self._w3 = None  # lazy
        # availability is config + library presence only; no network call here.
        self.available = bool(
            _WEB3_INSTALLED and self.rpc_url and self.escrow_address and self.house_wallet and self._house_key
        )

    def _require(self):
        if not self.available:
            raise CryptoUnavailable("real-play crypto is not configured on this server")

    def _web3(self):
        self._require()
        if self._w3 is None:
            self._w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        return self._w3

    def _escrow(self):
        w3 = self._web3()
        return w3.eth.contract(address=Web3.to_checksum_address(self.escrow_address), abi=ESCROW_ABI)

    def _usdc(self):
        w3 = self._web3()
        return w3.eth.contract(address=Web3.to_checksum_address(self.usdc_address), abi=ERC20_ABI)

    # --- reads ---

    def get_usdc_balance_micros(self, address: str) -> int:
        self._require()
        bal = self._usdc().functions.balanceOf(Web3.to_checksum_address(address)).call()
        return int(bal)

    def make_match_id(self, player_a: str, player_b: str, nonce: int | None = None) -> str:
        """keccak256(timestamp + playerA + playerB + nonce) -> 0x-prefixed bytes32 hex."""
        self._require()
        n = nonce if nonce is not None else int(time.time() * 1000)
        packed = f"{n}:{player_a.lower()}:{player_b.lower()}".encode()
        return Web3.keccak(packed).hex()

    # --- writes (signed by the house key) ---

    def _send(self, fn):
        w3 = self._web3()
        acct = Account.from_key(self._house_key)
        tx = fn.build_transaction({
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "chainId": w3.eth.chain_id,
        })
        signed = acct.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        return tx_hash.hex()

    def settle_escrow_match(self, match_id: str, winner_address: str) -> str:
        """Owner-only on-chain settlement. winner_address == zero address for a draw."""
        self._require()
        winner = winner_address or "0x0000000000000000000000000000000000000000"
        return self._send(self._escrow().functions.settleMatch(match_id, Web3.to_checksum_address(winner)))

    def settle_draw(self, match_id: str) -> str:
        return self.settle_escrow_match(match_id, "0x0000000000000000000000000000000000000000")

    def cancel_escrow_match(self, match_id: str) -> str:
        self._require()
        return self._send(self._escrow().functions.cancelMatch(match_id))

    def withdraw_usdc(self, to_address: str, amount_micros: int) -> str:
        """Send USDC from the house/custody wallet to an external address (house sponsors gas)."""
        self._require()
        return self._send(self._usdc().functions.transfer(Web3.to_checksum_address(to_address), amount_micros))


crypto_service = CryptoService()
