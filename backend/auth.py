"""JWT authentication and password hashing."""

import os
import time
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request

SECRET_KEY = os.environ.get("JWT_SECRET", "agent-checkers-dev-secret-change-in-prod")
ALGORITHM = "HS256"
TOKEN_EXPIRY = 86400  # 24 hours


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_token(player_id: int) -> str:
    payload = {"player_id": player_id, "exp": int(time.time()) + TOKEN_EXPIRY}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "invalid token")


def get_current_player_id(request: Request) -> int:
    """FastAPI dependency: extract player_id from Authorization header."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing or invalid authorization header")
    payload = decode_token(auth[7:])
    return payload["player_id"]


def get_optional_player_id(request: Request) -> Optional[int]:
    """FastAPI dependency: extract player_id if present, else None."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        payload = decode_token(auth[7:])
        return payload["player_id"]
    except HTTPException:
        return None
