import asyncio
from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from . import horizons
from .nasa import get_asteroids

MAX_RANGE_DAYS = 31
VECTOR_BUDGET_S = 5  # wait this long for Horizons, then continue in the background
_tasks: set[asyncio.Task] = set()
app = FastAPI(title="NEO Tracker")


@app.get("/api/asteroids")
async def asteroids(start: date, end: date):
    if end < start or (end - start).days > MAX_RANGE_DAYS:
        raise HTTPException(400, f"Invalid range (end >= start, max {MAX_RANGE_DAYS} days)")
    records, complete = await get_asteroids(start, end)
    task = asyncio.create_task(horizons.fill_vectors(records))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    await asyncio.wait({task}, timeout=VECTOR_BUDGET_S)
    pending = horizons.merge(records)
    return {"complete": complete, "count": len(records), "vectors_pending": pending, "asteroids": records}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
