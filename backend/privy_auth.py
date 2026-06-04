"""Privy integration: verify auth tokens and provision embedded wallets.

Dark by default: if PRIVY_APP_ID / PRIVY_APP_SECRET are unset, `available` is False
and the methods raise PrivyUnavailable. Token verification uses Privy's JWKS with
PyJWT (already a dependency) so no extra SDK is required for v1.

NOTE: Privy's REST API shapes evolve; verify the wallet endpoints against current
Privy docs (https://docs.privy.io) when wiring real credentials. Token verification
(ES256 against the app JWKS) is stable and implemented fully here.
"""

import json
import os
import urllib.request
import base64

try:
    import jwt  # PyJWT
    from jwt import PyJWKClient
    _JWT_OK = True
except ImportError:
    jwt = None
    PyJWKClient = None
    _JWT_OK = False


class PrivyUnavailable(Exception):
    pass


class PrivyService:
    def __init__(self):
        self.app_id = os.environ.get("PRIVY_APP_ID", "")
        self.app_secret = os.environ.get("PRIVY_APP_SECRET", "")
        self.available = bool(_JWT_OK and self.app_id and self.app_secret)
        self._jwks = None

    def _require(self):
        if not self.available:
            raise PrivyUnavailable("Privy is not configured on this server")

    def _jwks_client(self):
        if self._jwks is None:
            url = f"https://auth.privy.io/api/v1/apps/{self.app_id}/jwks.json"
            self._jwks = PyJWKClient(url)
        return self._jwks

    def verify_token(self, token: str) -> dict:
        """Verify a Privy access token. Returns the decoded claims (incl. 'sub' = user id)."""
        self._require()
        signing_key = self._jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, signing_key, algorithms=["ES256"],
            audience=self.app_id, issuer="privy.io",
        )
        return claims

    def _auth_header(self) -> str:
        raw = f"{self.app_id}:{self.app_secret}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    def _api(self, method: str, path: str, body: dict | None = None) -> dict:
        self._require()
        url = f"https://api.privy.io{path}"
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": self._auth_header(),
            "privy-app-id": self.app_id,
            "Content-Type": "application/json",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())

    def get_wallet_address(self, user_id: str) -> str | None:
        """Return the user's embedded wallet address, or None if not provisioned yet."""
        self._require()
        try:
            user = self._api("GET", f"/v1/users/{user_id}")
        except Exception:
            return None
        for acct in user.get("linked_accounts", []):
            if acct.get("type") == "wallet" and acct.get("address"):
                return acct["address"]
        return None

    def create_embedded_wallet(self, user_id: str) -> str | None:
        """Provision an embedded wallet for the user; returns its address."""
        self._require()
        try:
            res = self._api("POST", f"/v1/users/{user_id}/wallets", {"chain_type": "ethereum"})
            return res.get("address")
        except Exception:
            return None


privy_service = PrivyService()
