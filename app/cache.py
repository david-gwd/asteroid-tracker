"""SQLite cache: one row per asteroid approach, plus a log of which days were fetched."""
import json
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "cache.sqlite"
FUTURE_TTL_S = 24 * 3600  # today/future days may change; refresh daily


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, fetched_at REAL)")
    conn.execute("CREATE TABLE IF NOT EXISTS asteroids (id TEXT, day TEXT, data TEXT, PRIMARY KEY (id, day))")
    return conn


def _is_fresh(day: str, fetched_at: float) -> bool:
    if date.fromisoformat(day) < date.today() - timedelta(days=1):
        return True  # past days never change
    return time.time() - fetched_at < FUTURE_TTL_S


def missing_days(start: date, end: date) -> list[date]:
    with _conn() as c:
        rows = dict(c.execute("SELECT day, fetched_at FROM days WHERE day BETWEEN ? AND ?",
                              (start.isoformat(), end.isoformat())))
    out, d = [], start
    while d <= end:
        iso = d.isoformat()
        if iso not in rows or not _is_fresh(iso, rows[iso]):
            out.append(d)
        d += timedelta(days=1)
    return out


def store(start: date, end: date, records: list[dict]) -> None:
    """Replace everything in [start, end] (also marks empty days as fetched)."""
    now = time.time()
    with _conn() as c:
        c.execute("DELETE FROM asteroids WHERE day BETWEEN ? AND ?",
                  (start.isoformat(), end.isoformat()))
        d = start
        while d <= end:
            c.execute("INSERT OR REPLACE INTO days VALUES (?, ?)", (d.isoformat(), now))
            d += timedelta(days=1)
        c.executemany("INSERT OR REPLACE INTO asteroids VALUES (?, ?, ?)",
                      [(r["id"], r["approach_date"], json.dumps(r)) for r in records])


def load(start: date, end: date) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT data FROM asteroids WHERE day BETWEEN ? AND ?",
                         (start.isoformat(), end.isoformat())).fetchall()
    return sorted((json.loads(r[0]) for r in rows), key=lambda r: r["miss_km"])


def _vectors_table(c: sqlite3.Connection) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS vectors (id TEXT, epoch_ms INTEGER, data TEXT, PRIMARY KEY (id, epoch_ms))")


def load_vectors(keys: list[tuple[str, int]]) -> dict[tuple[str, int], dict]:
    """Cached Horizons results for (id, epoch_ms) keys; never expire (the epoch is part of the key)."""
    with _conn() as c:
        _vectors_table(c)
        rows = c.execute("SELECT id, epoch_ms, data FROM vectors").fetchall()
    wanted = set(keys)
    return {(i, e): json.loads(d) for i, e, d in rows if (i, e) in wanted}


def store_vector(id: str, epoch_ms: int, data: dict) -> None:
    with _conn() as c:
        _vectors_table(c)
        c.execute("INSERT OR REPLACE INTO vectors VALUES (?, ?, ?)", (id, epoch_ms, json.dumps(data)))
