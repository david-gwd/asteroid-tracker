# Near-Earth Asteroid Tracker: Code Documentation

![Asteroid Tracker Dashboard Screenshot](/static/images/dashboard.png?raw=true "Asteroid Tracker Dashboard")

## 1. Purpose and overview

The Near-Earth Asteroid Tracker visualises asteroids that pass close to Earth in a chosen date range. It consists of two parts:

- **Backend (Python / FastAPI)** fetches close-approach data from NASA's NeoWs (Near Earth Object Web Service), normalises it into flat records, caches it in SQLite, and exposes it through one JSON endpoint. It also serves the frontend files.
- **Frontend (plain JavaScript + Globe.gl / Three.js)** shows a rotatable 3D globe. Each asteroid is a small sphere placed around the Earth at a logarithmically scaled distance. Clicking one shows its details.

### Data flow

```
Browser (app.js)
   │  GET /api/asteroids?start=YYYY-MM-DD&end=YYYY-MM-DD
   ▼
main.py: asteroids()           validates the range
   ▼
nasa.py: get_asteroids()       asks the cache which days are missing
   │        ├─ cache.missing_days()
   │        ├─ (for each 7-day chunk) _fetch_chunk() → NASA NeoWs → _normalize()
   │        ├─ cache.store()
   │        └─ cache.load()    returns everything from SQLite, sorted by distance
   ▼
JSON {complete, count, asteroids[]}  →  render() → globe
```

### File layout

| File | Role |
|---|---|
| `app/main.py` | FastAPI app, the `/api/asteroids` endpoint, static file serving |
| `app/nasa.py` | NASA NeoWs client: chunking, normalisation, cache fallback |
| `app/cache.py` | SQLite cache of asteroid records and fetched days |
| `static/index.html` | Page structure: globe container, date panel, info popup, legend |
| `static/app.js` | Globe setup, asteroid placement, UI logic, API calls |
| `static/style.css` | Styling of the panels and layout |
| `.env` / `.env.example` | `NASA_API_KEY` (`DEMO_KEY` is limited to about 30 requests per hour) |
| `data/cache.sqlite` | Created automatically at runtime (gitignored) |

### Running it

```
.venv/bin/uvicorn app.main:app --reload
```

Then open http://localhost:8000. The server must be started from the project root, because `StaticFiles(directory="static")` is resolved relative to the working directory.

---

## 2. Backend

### 2.1 `app/main.py`

**Module-level setup.** The module defines `MAX_RANGE_DAYS = 31`, creates the `FastAPI` application `app` (titled "NEO Tracker"), and mounts the `static/` directory at `/` with `html=True`, so `/` serves `static/index.html`. The mount is registered after the API route. FastAPI matches routes in registration order, so `/api/...` is handled by the endpoint and everything else falls through to the static files.

#### `asteroids(start: date, end: date)`

This is the only HTTP endpoint, `GET /api/asteroids`. FastAPI parses the `start` and `end` query parameters into `datetime.date` objects, and malformed dates are rejected automatically with a 422 error. The function then validates the range. `end` must not be earlier than `start`, and the span must not exceed 31 days. The cap protects the NASA quota, since each 7-day chunk is one API request, and keeps the number of objects on the globe manageable. An invalid range raises an `HTTPException` with status 400 and an explanatory message, which the frontend shows in its status line. For a valid range it awaits `get_asteroids()` and returns `{"complete": bool, "count": int, "asteroids": [...]}`. `complete` is `false` when NASA could not be reached and only cached data was returned. The function is `async`, so waiting on NASA does not block other requests.

### 2.2 `app/nasa.py`

**Module-level setup.** On import it calls `load_dotenv()` so that `NASA_API_KEY` from `.env` is available through `os.getenv`. It defines `FEED_URL` (the NeoWs feed endpoint) and `MAX_SPAN = 7`, the maximum number of days NeoWs accepts per request.

#### `class NasaError(Exception)`

A minimal custom exception raised when NASA answers with a non-200 HTTP status, for example 429 when the rate limit is exceeded or 403 for a bad key. It exists so `get_asteroids()` can catch "NASA said no" in the same `except` clause as network-level `httpx.HTTPError`s and treat both as "fall back to cache".

#### `_normalize(neo: dict, day: str) -> dict | None`

This function converts one raw NeoWs object into the flat record used by the rest of the app. A NeoWs object carries a list of `close_approach_data` entries covering all of its known approaches, past and future, to various bodies. The function selects the single entry where `orbiting_body == "Earth"` and `close_approach_date == day`, where `day` is the date key under which NASA listed the object. If no entry matches it returns `None`, and the caller drops the object. Otherwise it builds a dictionary with these fields:

- `id` and `name`, where the name has its surrounding parentheses stripped (NASA writes e.g. `(2023 AB)`).
- `diameter_min_m` and `diameter_max_m`, the estimated diameter range in metres.
- `hazardous`, from `is_potentially_hazardous_asteroid`.
- `approach_date` and `approach_datetime` (the full timestamp, which may be absent for old or future entries).
- `miss_km`, `miss_lunar` and `miss_au`, the miss distance in kilometres, lunar distances and astronomical units. NASA delivers these as strings, so they are converted with `float`.
- `velocity_kms`, the relative velocity in km/s.
- `jpl_url`, a link to the JPL small-body database page.

#### `_fetch_chunk(client, start, end) -> list[dict]`

Fetches one contiguous block of at most 7 days from NASA. It issues a GET request to the feed URL with `start_date`, `end_date` and the API key (`NASA_API_KEY` from the environment, defaulting to `DEMO_KEY`). A non-200 response raises `NasaError`. On success it walks the `near_earth_objects` mapping, which is keyed by date string and holds a list of objects per day. It runs each object through `_normalize()` with that day and collects the non-`None` results in a flat list. It shares the `httpx.AsyncClient` passed in by the caller, so the connection can be reused across chunks.

#### `get_asteroids(start, end) -> tuple[list[dict], bool]`

This is the public entry point of the NASA module and implements the "cache first, fetch what is missing, degrade gracefully" strategy. It first asks `cache.missing_days()` which days in the range are not cached or are stale. If any are missing, it fetches from the first missing day to the last missing day. Days in between that are already cached are re-fetched too, which is simpler than fetching disjoint ranges. The fetch loop splits that span into chunks of at most `MAX_SPAN` (7) days, fetches each with `_fetch_chunk()`, and writes it to the cache with `cache.store()` straight away. If a later chunk fails, the earlier chunks are therefore kept. If any `httpx.HTTPError` or `NasaError` occurs, the loop stops and `complete` is set to `False`. Finally it returns `cache.load(start, end)`, which always reads from the database, together with the `complete` flag. The UI uses this to tell the user that the data may be partial.

### 2.3 `app/cache.py`

**Module-level setup.** `DB_PATH` is `data/cache.sqlite` next to the `app/` folder, resolved from the file's location, so it does not depend on the working directory. `FUTURE_TTL_S` is 24 hours, the lifetime of cached entries for days that can still change.

The database has two tables:

- `days(day PRIMARY KEY, fetched_at)` records which days have been fetched and when. This lets the cache distinguish "fetched, no asteroids" from "never fetched".
- `asteroids(id, day, data, PRIMARY KEY (id, day))` holds one row per asteroid approach, with the full record as a JSON string in `data`.

#### `_conn() -> sqlite3.Connection`

Opens a new SQLite connection and makes sure everything exists. It creates the `data/` directory if needed (`mkdir(exist_ok=True)`), connects to the database file, and runs `CREATE TABLE IF NOT EXISTS` for both tables. Because the schema is created on every connection, there is no separate setup step, and the cache works on first start and survives deletion of the `data/` folder. All other functions in the module use it as a context manager (`with _conn() as c`), which commits on success and rolls back on an exception. Note that `sqlite3`'s context manager does not close the connection. Each call leaves cleanup to garbage collection, which is fine at this scale.

#### `_is_fresh(day: str, fetched_at: float) -> bool`

Decides whether a cached day can still be trusted. Days older than yesterday (`day < today - 1`) are always fresh, because NASA's data for past approaches does not change, so they are cached permanently. Yesterday, today and future days are fresh only if they were fetched less than `FUTURE_TTL_S` (24 hours) ago, because predicted approaches get refined as new observations arrive. The one-day margin around today avoids caching a day permanently before it is fully over in every time zone.

#### `missing_days(start: date, end: date) -> list[date]`

Returns the days in `[start, end]` that need to be fetched. It reads the `days` rows for the range into a dictionary of `day → fetched_at`, then walks the range day by day. A day is missing if it has no row or if its row fails `_is_fresh()`. The result is an ascending list of `date` objects, empty if everything is cached and fresh. `get_asteroids()` uses only the first and last element, as described above.

#### `store(start: date, end: date, records: list[dict]) -> None`

Writes freshly fetched data for a range into the cache, replacing anything previously stored there. In one transaction it deletes all asteroid rows in `[start, end]`, so approaches that disappeared from NASA's data do not linger. It then inserts or updates a `days` row for every day in the range with the current timestamp. This includes days with no asteroids, which is what makes an empty day count as cached. Finally it inserts one `asteroids` row per record, using `(id, approach_date)` as the key and the JSON-serialised record as the payload. The single transaction keeps the cache consistent if the process dies halfway.

#### `load(start: date, end: date) -> list[dict]`

Reads all stored asteroid records for the date range, parses each JSON payload back into a dictionary, and returns them sorted by `miss_km` ascending, so the closest approaches come first. It does no freshness checks. It returns whatever is in the database, which is what makes the offline fallback in `get_asteroids()` work.

---

## 3. Frontend

### 3.1 `static/index.html`

A single page with no inline logic. It contains the `#globe` container (filling the screen), the `#controls` form (start date, end date, "Show" button, "only hazardous" checkbox, and a `#status` line), the `#info` popup (hidden until an asteroid is clicked), and the `#legend`. It loads `app.js` as an ES module (`<script type="module">`). The libraries are not loaded by script tags but imported inside `app.js`.

### 3.2 `static/style.css`

Dark theme. `#globe` is `position: fixed; inset: 0` so the canvas fills the viewport. `.panel` gives the floating panels their translucent, blurred look. The controls sit top-right, the info popup at the left edge (vertically centred), and the legend bottom-left. A media query for narrow screens turns the info popup into a full-width bar above the legend. `.dot` and `.dot.haz` are the grey and red colour markers in the legend.

### 3.3 `static/app.js`

**Imports and constants.** The file imports `THREE` from `three@0.180.0` and `Globe` from `globe.gl@2.46.2`, both via esm.sh. The `deps=three@0.180.0` parameter makes globe.gl use the same Three.js copy as `app.js`. If two copies were loaded, the meshes created here would not be compatible with the globe's scene. The constants are `EARTH_R_KM` (6371), `MOON_KM` (384400), `GLOBE_R` (100, the globe radius in Three.js units used by Globe.gl), and `K = 0.5`, the scale factor for the altitude formula. The module state is `asteroids`, the list of records from the last successful API call. The helper `$` is shorthand for `document.getElementById`.

#### `altitudeOf(km)`

Converts a miss distance in kilometres into a globe altitude, expressed in globe radii: `K · log10(1 + km / 6371)`. A linear scale would be unusable. The Moon is about 60 Earth radii away, while many asteroids pass at only a few Earth radii, so everything would either hug the surface or fly off-screen. The logarithm compresses the range, and the `1 +` makes a miss distance of 0 map to altitude 0 instead of minus infinity. The legend tells users that the scale is logarithmic, so distances should not be compared by eye.

#### `hash(str, seed)`

A deterministic pseudo-random number generator seeded by a string, using the 32-bit FNV-1a hash. It starts from the FNV offset basis XORed with `seed`. For each character it XORs in the character code and multiplies by the FNV prime with `Math.imul` (32-bit integer multiplication). It returns the result as an unsigned value divided by 2³², giving a number in [0, 1). Different seeds give independent values for the same string. This is what makes asteroid positions stable between page loads without storing anything.

#### `place(a)`

Adds map coordinates to an asteroid record. NASA's feed contains no usable direction from Earth, so `place` invents one in a reproducible way. Latitude is `asin(2·u − 1)` for `u = hash(id, 1)`, which spreads points uniformly over the sphere. Picking latitude uniformly would bunch points at the poles. Longitude is `hash(id, 2) · 360 − 180`. It also sets `alt` using `altitudeOf(miss_km)`. It returns a copy of the record extended with `lat`, `lng` and `alt`, leaving the original unchanged. The legend states that the direction is illustrative only.

#### `sizeOf(a)`

Returns the sphere radius for an asteroid, scaled logarithmically from its maximum diameter: `max(1.2, 0.8 + 0.9 · log10(max(d, 10) / 10))`. Diameters range from a few metres to kilometres, so a log scale keeps both small and large objects visible. The inner `max(d, 10)` avoids negative logarithms for very small objects, and the outer `max(1.2, …)` sets a minimum radius so tiny asteroids can still be clicked. The sizes are visual, not physical.

#### Globe construction (top-level code)

Not a function but the core setup. `Globe()($('globe'))` creates the globe in the container and configures it with:

- Textures: a blue-marble Earth image, a topology bump map, and a night-sky background, all loaded from unpkg.
- An atmosphere glow.
- An empty custom layer: `customLayerData([])` holds the asteroids.
- `customThreeObject`, a callback that builds a Three.js object for each datum. Here it is an icosahedron mesh (detail level 1, which gives a rounded rock-like shape) sized by `sizeOf`, with a Lambert material. The material is red (`0xff4d4d`) for hazardous asteroids and grey (`0xaaaaaa`) otherwise.
- `customThreeObjectUpdate`, which positions each mesh with `globe.getCoords(lat, lng, alt)`, converting geographic coordinates and altitude to 3D coordinates.
- `customLayerLabel`, the hover tooltip with name and distance in lunar distances.
- `onCustomLayerClick(showInfo)`, which opens the detail popup.

Afterwards it enables slow auto-rotation, stops it permanently on the first user interaction (the controls' `start` event), and sets the camera altitude to 4 globe radii.

#### `addMoonRing()` (immediately invoked)

Draws a dashed circle that marks the Moon's distance as a scale reference. It computes the ring radius as `GLOBE_R · (1 + altitudeOf(MOON_KM))`, using the same log formula as the asteroids so the ring is consistent with them. It generates 129 points around a circle in the x–z plane (the equatorial plane), builds a `BufferGeometry` from them, and wraps that in a `THREE.Line` with a dashed blue material. `computeLineDistances()` is required for dashed lines to render. The line is added directly to the globe's Three.js scene. It runs once at start-up, so it is an IIFE and not a named, reusable function.

#### `showInfo(a)`

Fills in and shows the detail popup for the clicked asteroid. It sets the title, builds a list of label/value rows (diameter range, approach time, miss distance in km, lunar distances and AU, velocity, hazard flag), and sets the JPL link. The rows are created as `<dt>`/`<dd>` elements with `textContent`, not `innerHTML`, which avoids HTML injection from data fields. They replace the existing content with `replaceChildren`. Finally it removes the `hidden` class from `#info`. An empty label is used for the second and third distance rows, so they appear as continuation lines under "Miss distance".

#### `$('close').onclick`

A small handler (not a named function) that hides the popup again by adding the `hidden` class.

#### `render()`

Pushes the current data into the globe. It reads the state of the "only hazardous" checkbox, filters the `asteroids` array accordingly, maps each record through `place()`, and passes the result to `globe.customLayerData()`. Globe.gl then diffs the data and creates, updates and removes meshes as needed. It is called after each successful load and whenever the checkbox changes, so toggling the filter needs no new network request.

#### `load(start, end)` (async)

Fetches data for a date range and updates the UI. It sets the status text to "Loading…", calls `/api/asteroids?start=…&end=…`, and on a non-OK response throws an error carrying the server's `detail` message (for example the 400 range error) or the HTTP status text. On success it stores `data.asteroids` in the module-level `asteroids` and sets the status line to the asteroid count. The line adds "NASA unreachable: cached data only" if `complete` is false, or "No asteroids in this range." if the list is empty. It then calls `render()`. Any exception, including network failures, is shown in the status line as "Error: …", so the page never fails silently.

#### Initialisation and event wiring (top-level code)

Not a named function. `iso(d)` formats a `Date` as `YYYY-MM-DD`. The code then pre-fills the date inputs with today and today + 7 days, attaches a `submit` handler to the form that prevents the default page reload and calls `load()` with the entered dates, attaches a `change` handler to the checkbox that calls `render()`, and finally triggers the first `load()` with the default range. `iso` uses UTC (`toISOString`), so in time zones far from UTC the default "today" can be off by one day near midnight.

---

## 4. Design decisions and limitations

- **Cache granularity is per day.** A single `days` table makes "already fetched" explicit, including for empty days. Past days never expire. Today and future days refresh every 24 hours.
- **Graceful degradation.** If NASA fails (rate limit, outage, no network), the app serves what is cached and flags it with `complete: false`.
- **Rate limits.** `DEMO_KEY` allows only about 30 requests per hour. A 31-day range needs up to 5 chunks, so getting your own free key at https://api.nasa.gov and putting it in `.env` is recommended.
- **Positions are illustrative.** Only the distance is real data (and it is log-scaled). The direction comes from a hash of the asteroid ID. The roadmap item "real approach directions via JPL Horizons" would address this.
- **Dependency on CDNs.** The frontend needs internet access for the esm.sh libraries and the unpkg textures. The Three.js version must stay compatible with Globe.gl's internals (a version that is too old fails with a missing `Timer` export).
- **Unauthenticated API.** The endpoint has no auth or rate limiting of its own, which is fine for local use but needs attention before public deployment.
