"""NASA NeoWs client: 7-day chunking + normalisation into flat records."""
import os
from datetime import date, timedelta

import httpx
from dotenv import load_dotenv

from . import cache

load_dotenv()
FEED_URL = "https://api.nasa.gov/neo/rest/v1/feed"
MAX_SPAN = 7  # NeoWs allows at most 7 days per request (inclusive range of 8 days is rejected)


class NasaError(Exception):
    pass


def _normalize(neo: dict, day: str) -> dict | None:
    approach = next((a for a in neo["close_approach_data"]
                     if a["orbiting_body"] == "Earth" and a["close_approach_date"] == day), None)
    if approach is None:
        return None
    diam = neo["estimated_diameter"]["meters"]
    miss = approach["miss_distance"]
    return {
        "id": neo["id"],
        "name": neo["name"].strip("()"),
        "diameter_min_m": diam["estimated_diameter_min"],
        "diameter_max_m": diam["estimated_diameter_max"],
        "hazardous": neo["is_potentially_hazardous_asteroid"],
        "approach_date": day,
        "approach_datetime": approach.get("close_approach_date_full"),
        "approach_epoch_ms": int(approach["epoch_date_close_approach"]),
        "miss_km": float(miss["kilometers"]),
        "miss_lunar": float(miss["lunar"]),
        "miss_au": float(miss["astronomical"]),
        "velocity_kms": float(approach["relative_velocity"]["kilometers_per_second"]),
        "jpl_url": neo["nasa_jpl_url"],
    }


async def _fetch_chunk(client: httpx.AsyncClient, start: date, end: date) -> list[dict]:
    resp = await client.get(FEED_URL, params={
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "api_key": os.getenv("NASA_API_KEY", "DEMO_KEY")})
    if resp.status_code != 200:
        raise NasaError(f"NASA returned HTTP {resp.status_code}")
    records = []
    for day, neos in resp.json()["near_earth_objects"].items():
        records += [r for n in neos if (r := _normalize(n, day))]
    return records


async def get_asteroids(start: date, end: date) -> tuple[list[dict], bool]:
    """Return (records, complete). complete=False if NASA failed and cache was used."""
    missing = cache.missing_days(start, end)
    complete = True
    if missing:
        lo, hi = missing[0], missing[-1]
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                d = lo
                while d <= hi:
                    chunk_end = min(d + timedelta(days=MAX_SPAN - 1), hi)
                    cache.store(d, chunk_end, await _fetch_chunk(client, d, chunk_end))
                    d = chunk_end + timedelta(days=1)
        except (httpx.HTTPError, NasaError):
            complete = False  # fall back to whatever is cached
    return cache.load(start, end), complete
