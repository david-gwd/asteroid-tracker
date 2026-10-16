"""JPL Horizons client: real position and approach direction at each asteroid's closest approach."""
import asyncio
import math
import time
from datetime import datetime, timezone

import httpx

from . import cache

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
CONCURRENCY = 4
_semaphore = asyncio.Semaphore(CONCURRENCY)
_failed: dict[tuple[str, int], float] = {}  # key -> time of failure; retried after RETRY_S
RETRY_S = 600
_inflight: set[tuple[str, int]] = set()  # keys being fetched, so overlapping requests don't repeat work


def _jd(epoch_ms: int) -> float:
    return epoch_ms / 864e5 + 2440587.5


def _lat_lng(x: float, y: float, z: float) -> tuple[float, float]:
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def _to_earth_fixed(r: list[float], v: list[float], jd: float) -> dict:
    """Rotate ICRF geocentric vectors into the Earth-fixed frame (GMST rotation about Z)."""
    gmst = math.radians((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360)
    c, s = math.cos(gmst), math.sin(gmst)
    rot = lambda p: (c * p[0] + s * p[1], -s * p[0] + c * p[1], p[2])
    lat, lng = _lat_lng(*rot(r))
    from_lat, from_lng = _lat_lng(*rot([-v[0], -v[1], -v[2]]))  # where it came from
    return {"lat": lat, "lng": lng, "from_lat": from_lat, "from_lng": from_lng,
            "geo_km": math.sqrt(sum(p * p for p in r))}


async def _fetch_vector(client: httpx.AsyncClient, id: str, epoch_ms: int) -> dict:
    jd = _jd(epoch_ms)
    resp = await client.get(HORIZONS_URL, params={
        "format": "json", "COMMAND": f"'DES={id};'", "EPHEM_TYPE": "VECTORS", "CENTER": "'500@399'",
        "REF_PLANE": "FRAME", "OUT_UNITS": "KM-S", "VEC_TABLE": "2", "CSV_FORMAT": "YES",
        "OBJ_DATA": "NO", "TIME_TYPE": "UT", "TLIST": f"'{jd:.9f}'"})
    resp.raise_for_status()
    text = resp.json()["result"]
    block = text.split("$$SOE")[1].split("$$EOE")[0].strip()
    cols = [float(x) for x in block.split(",")[2:8]]
    return _to_earth_fixed(cols[:3], cols[3:], jd)


async def _fetch_and_store(client: httpx.AsyncClient, key: tuple[str, int]) -> None:
    try:
        async with _semaphore:
            data = await _fetch_vector(client, *key)
        cache.store_vector(*key, data)
    except Exception:
        _failed[key] = time.time()  # stays approximate; retried later
    finally:
        _inflight.discard(key)


def _key(r: dict) -> tuple[str, int] | None:
    """(id, epoch_ms) of the closest approach. Records cached before the epoch was stored use the date string."""
    ms = r.get("approach_epoch_ms")
    if ms is None and r.get("approach_datetime"):
        try:
            ms = int(datetime.strptime(r["approach_datetime"], "%Y-%b-%d %H:%M")
                     .replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            pass
    return (r["id"], ms) if ms is not None else None


def _recently_failed(key: tuple[str, int]) -> bool:
    return time.time() - _failed.get(key, 0) < RETRY_S


def merge(records: list[dict]) -> int:
    """Add cached vector fields to the records in place. Returns how many are still unresolved."""
    keys = [k for r in records if (k := _key(r))]
    found = cache.load_vectors(keys)
    pending = 0
    for r in records:
        key = _key(r)
        if key is None:
            continue  # no usable time: stays approximate, nothing to wait for
        if key in found:
            r.update(found[key])
        elif not _recently_failed(key):
            pending += 1
    return pending


async def fill_vectors(records: list[dict]) -> None:
    """Fetch every missing vector from Horizons (bounded concurrency) and cache it."""
    keys = [k for r in records if (k := _key(r))]
    have = cache.load_vectors(keys)
    todo = [k for k in keys if k not in have and k not in _inflight and not _recently_failed(k)]
    _inflight.update(todo)
    async with httpx.AsyncClient(timeout=30) as client:
        await asyncio.gather(*(_fetch_and_store(client, k) for k in todo))
