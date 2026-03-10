"""Building Security Camera — Auth API + User Management CLI."""

from __future__ import annotations

import logging
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Generator

import bcrypt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24
BCRYPT_ROUNDS = 12
DB_PATH = Path(os.environ.get("DB_PATH", "/data/users.db"))
AUDIT_LOG = Path(os.environ.get("AUDIT_LOG", "/data/audit.log"))
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", "/recordings"))
MAX_DOWNLOAD_SECONDS = 1800  # 30 minutes max

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("auth")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def _init_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.commit()


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    _init_db(conn)
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def audit(event: str, username: str = "-", ip: str = "-", path: str = "-") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} | {event} | user={username} | ip={ip} | path={path}\n"
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_LOG, "a") as f:
        f.write(line)


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_token(username: str, is_admin: bool) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS)
    return jwt.encode(
        {"sub": username, "admin": is_admin, "exp": expire},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------

DEV_MODE = os.environ.get("DEV_MODE", "").lower() in ("1", "true", "yes")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
def _seed_dev_user() -> None:
    if not DEV_MODE:
        return
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM users WHERE username = 'root'").fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)",
                ("root", hash_password("admin")),
            )
            conn.commit()
            logger.info("DEV_MODE: created default admin root:admin")


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def require_auth(request: Request) -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        payload = decode_token(auth_header[7:])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username = ?", (payload["sub"],)
        ).fetchone()
    if not user or not user["enabled"]:
        raise HTTPException(status_code=401, detail="Account disabled")
    return payload


def require_admin(payload: dict = Depends(require_auth)) -> dict:
    if not payload.get("admin"):
        raise HTTPException(status_code=403, detail="Admin required")
    return payload


# --- Auth routes ---

@app.post("/auth/login")
def login(body: LoginRequest, request: Request):
    ip = get_client_ip(request)
    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username = ?", (body.username,)
        ).fetchone()
    if not user or not verify_password(body.password, user["password_hash"]):
        audit("login_failed", body.username, ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user["enabled"]:
        audit("login_disabled", body.username, ip)
        raise HTTPException(status_code=401, detail="Account disabled")
    token = create_token(user["username"], bool(user["is_admin"]))
    audit("login_success", user["username"], ip)
    return {"token": token, "username": user["username"], "is_admin": bool(user["is_admin"])}


@app.get("/auth/me")
def me(request: Request, payload: dict = Depends(require_auth)):
    ip = get_client_ip(request)
    audit("auth_check", payload["sub"], ip, "/auth/me")
    return {"username": payload["sub"], "is_admin": payload.get("admin", False)}


# --- nginx auth_request subrequest endpoint ---

@app.get("/auth/verify")
def verify_token(request: Request):
    """Called by nginx auth_request to validate JWT for static file access."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401)
    try:
        payload = decode_token(auth_header[7:])
    except JWTError:
        raise HTTPException(status_code=401)
    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username = ?", (payload["sub"],)
        ).fetchone()
    if not user or not user["enabled"]:
        raise HTTPException(status_code=401)
    ip = get_client_ip(request)
    original_uri = request.headers.get("X-Original-URI", "-")
    audit("video_access", payload["sub"], ip, original_uri)
    return {"status": "ok"}


# --- Admin routes ---

@app.post("/auth/users")
def create_user(body: CreateUserRequest, request: Request, payload: dict = Depends(require_admin)):
    ip = get_client_ip(request)
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (body.username,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="User already exists")
        conn.execute(
            "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
            (body.username, hash_password(body.password), int(body.is_admin)),
        )
        conn.commit()
    audit("user_created", payload["sub"], ip, f"new_user={body.username}")
    return {"status": "created", "username": body.username}


@app.post("/auth/users/{username}/disable")
def disable_user(username: str, request: Request, payload: dict = Depends(require_admin)):
    ip = get_client_ip(request)
    with get_db() as conn:
        result = conn.execute(
            "UPDATE users SET enabled = 0 WHERE username = ?", (username,)
        )
        conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="User not found")
    audit("user_disabled", payload["sub"], ip, f"target={username}")
    return {"status": "disabled", "username": username}


# --- API routes ---

@app.get("/api/days")
def list_days(request: Request, payload: dict = Depends(require_auth)):
    ip = get_client_ip(request)
    audit("list_days", payload["sub"], ip, "/api/days")
    days = []
    if RECORDINGS_DIR.exists():
        for d in sorted(RECORDINGS_DIR.iterdir(), reverse=True):
            if d.is_dir() and d.name[:2] == "20":
                days.append(d.name)
    return {"days": days}


@app.get("/api/segments/{date}")
def list_segments(date: str, request: Request, payload: dict = Depends(require_auth)):
    """Return segment timestamps for a given day, used by the timeline UI."""
    ip = get_client_ip(request)
    audit("list_segments", payload["sub"], ip, f"/api/segments/{date}")

    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    day_dir = RECORDINGS_DIR / date
    if not day_dir.exists() or not day_dir.is_dir():
        return {"segments": [], "first": None, "last": None}

    times: list[str] = []
    for seg in sorted(day_dir.glob("segment_*.ts")):
        ts = seg.stem.replace("segment_", "")  # HH-MM-SS
        times.append(ts)

    return {
        "segments": times,
        "first": times[0] if times else None,
        "last": times[-1] if times else None,
    }


@app.get("/api/download")
def download_clip(
    date: str,
    start: str,
    end: str,
    request: Request,
    payload: dict = Depends(require_auth),
):
    ip = get_client_ip(request)
    audit("download", payload["sub"], ip, f"date={date}&start={start}&end={end}")

    # Validate date format (YYYY-MM-DD)
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    # Validate time format (HH-MM-SS)
    try:
        start_time = datetime.strptime(start, "%H-%M-%S")
        end_time = datetime.strptime(end, "%H-%M-%S")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid time format, use HH-MM-SS")

    if end_time <= start_time:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    duration = (end_time - start_time).total_seconds()
    if duration > MAX_DOWNLOAD_SECONDS:
        raise HTTPException(status_code=400, detail=f"Max download duration is {MAX_DOWNLOAD_SECONDS // 60} minutes")

    # Verify the date directory exists
    day_dir = RECORDINGS_DIR / date
    if not day_dir.exists() or not day_dir.is_dir():
        raise HTTPException(status_code=404, detail="No recordings for this date")

    # Resolve to prevent path traversal
    try:
        day_dir = day_dir.resolve()
        if not str(day_dir).startswith(str(RECORDINGS_DIR.resolve())):
            raise HTTPException(status_code=403, detail="Forbidden")
    except (ValueError, OSError):
        raise HTTPException(status_code=403, detail="Forbidden")

    playlist = day_dir / "playlist.m3u8"
    if not playlist.exists():
        raise HTTPException(status_code=404, detail="No playlist found for this date")

    # Filter segments within time range
    segments = _get_segments_in_range(day_dir, start, end)
    if not segments:
        raise HTTPException(status_code=404, detail="No segments found in time range")

    # Create concat file for ffmpeg
    output_path = Path(f"/tmp/download_{date}_{start}_{end}_{int(time.time())}.mp4")
    concat_path = output_path.with_suffix(".txt")

    try:
        with open(concat_path, "w") as f:
            for seg in segments:
                f.write(f"file '{seg}'\n")

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_path),
            "-c", "copy",
            str(output_path),
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail="Failed to create download")

        return FileResponse(
            str(output_path),
            media_type="video/mp4",
            filename=f"recording_{date}_{start}_to_{end}.mp4",
            background=_cleanup_files(output_path, concat_path),
        )
    except subprocess.TimeoutExpired:
        _try_remove(output_path)
        _try_remove(concat_path)
        raise HTTPException(status_code=500, detail="Download timed out")
    except HTTPException:
        raise
    except Exception:
        _try_remove(output_path)
        _try_remove(concat_path)
        raise HTTPException(status_code=500, detail="Download failed")


def _get_segments_in_range(day_dir: Path, start: str, end: str) -> list[Path]:
    """Get .ts segment files whose timestamps fall within start-end range."""
    segments = sorted(day_dir.glob("segment_*.ts"))
    result = []
    for seg in segments:
        # Extract time from filename: segment_HH-MM-SS.ts
        name = seg.stem  # segment_HH-MM-SS
        ts = name.replace("segment_", "")
        if start <= ts <= end:
            result.append(seg)
    return result


def _try_remove(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


async def _cleanup_files(*paths: Path):
    """Background task to clean up temp files after response is sent."""
    from starlette.background import BackgroundTask

    async def cleanup():
        for p in paths:
            _try_remove(p)

    return BackgroundTask(cleanup)


# ---------------------------------------------------------------------------
# CLI — run directly for user management
# ---------------------------------------------------------------------------

def cli() -> None:
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python auth.py create-admin <username> <password>")
        print("  python auth.py create-user <username> <password>")
        print("  python auth.py disable-user <username>")
        print("  python auth.py enable-user <username>")
        print("  python auth.py reset-password <username> <new_password>")
        print("  python auth.py list-users")
        sys.exit(1)

    command = sys.argv[1]

    with get_db() as conn:
        if command == "create-admin" and len(sys.argv) == 4:
            username, password = sys.argv[2], sys.argv[3]
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)",
                (username, hash_password(password)),
            )
            conn.commit()
            print(f"Admin '{username}' created.")

        elif command == "create-user" and len(sys.argv) == 4:
            username, password = sys.argv[2], sys.argv[3]
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 0)",
                (username, hash_password(password)),
            )
            conn.commit()
            print(f"User '{username}' created.")

        elif command == "disable-user" and len(sys.argv) == 3:
            username = sys.argv[2]
            conn.execute("UPDATE users SET enabled = 0 WHERE username = ?", (username,))
            conn.commit()
            print(f"User '{username}' disabled.")

        elif command == "enable-user" and len(sys.argv) == 3:
            username = sys.argv[2]
            conn.execute("UPDATE users SET enabled = 1 WHERE username = ?", (username,))
            conn.commit()
            print(f"User '{username}' enabled.")

        elif command == "reset-password" and len(sys.argv) == 4:
            username, password = sys.argv[2], sys.argv[3]
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE username = ?",
                (hash_password(password), username),
            )
            conn.commit()
            print(f"Password reset for '{username}'.")

        elif command == "list-users":
            rows = conn.execute("SELECT username, is_admin, enabled, created_at FROM users").fetchall()
            for row in rows:
                status = "enabled" if row["enabled"] else "DISABLED"
                role = "admin" if row["is_admin"] else "user"
                print(f"  {row['username']} [{role}] [{status}] created={row['created_at']}")

        else:
            print(f"Unknown command or wrong args: {command}")
            sys.exit(1)


if __name__ == "__main__":
    cli()
