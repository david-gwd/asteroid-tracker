from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from .nasa import get_asteroids

MAX_RANGE_DAYS = 31
app = FastAPI(title="NEO Tracker")


@app.get("/api/asteroids")
async def asteroids(start: date, end: date):
    if end < start or (end - start).days > MAX_RANGE_DAYS:
        raise HTTPException(400, f"Invalid range (end >= start, max {MAX_RANGE_DAYS} days)")
    records, complete = await get_asteroids(start, end)
    return {"complete": complete, "count": len(records), "asteroids": records}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
