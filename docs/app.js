import * as THREE from 'https://esm.sh/three@0.180.0';
import { Line2 } from 'https://esm.sh/three@0.180.0/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'https://esm.sh/three@0.180.0/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'https://esm.sh/three@0.180.0/examples/jsm/lines/LineGeometry.js';
import Globe from 'https://esm.sh/globe.gl@2.46.2?deps=three@0.180.0';

const EARTH_R_KM = 6371;
const K = 0.5; // altitude = K * log10(1 + miss_km / EARTH_R_KM), in globe radii
const ZOOM_IN_TIME_MS = 3000
const ZOOM_OUT_TIME_MS = 3000

const $ = id => document.getElementById(id);
let asteroids = [];

const altitudeOf = km => K * Math.log10(1 + km / EARTH_R_KM);

// Deterministic pseudo-random direction from the asteroid id (FNV-1a hash).
function hash(str, seed) {
  let h = 2166136261 ^ seed;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function place(a) {
  if (a.lat !== undefined) return { ...a, alt: altitudeOf(a.miss_km), approx: false }; // real position from JPL Horizons
  const lat = Math.asin(2 * hash(a.id, 1) - 1) * 180 / Math.PI; // uniform on sphere
  const lng = hash(a.id, 2) * 360 - 180;
  return { ...a, lat, lng, alt: altitudeOf(a.miss_km), approx: true };
}
// Angular, cratered rock: a lumpy ellipsoid, cut by a few flat planes (sharp edges and corners),
// pitted with craters and roughened by ridged noise. Displacement depends only on the vertex
// direction, so the faceted mesh stays closed.
function asteroidGeometry(a) {
  const size = sizeOf(a), id = a.id, h = (i, j = 0) => hash(id, i + j);
  const unit = i => new THREE.Vector3(h(i) - .5, h(i, 100) - .5, h(i, 200) - .5).normalize();
  const axes = [0, 1, 2].map(i => 0.65 + 0.55 * h(20 + i));
  const bumps = Array.from({ length: 5 }, (_, i) => ({
    dir: unit(30 + i), freq: 2 + 5 * h(60 + i), phase: 6.28 * h(70 + i), amp: 0.16 / (1 + i * 0.6),
  }));
  const cuts = Array.from({ length: 9 }, (_, i) => ({ n: unit(300 + i), c: 0.72 + 0.22 * h(320 + i) }));
  const craters = Array.from({ length: 7 }, (_, i) => ({
    dir: unit(400 + i), rho: 0.18 + 0.4 * h(420 + i), depth: 0.05 + 0.1 * h(440 + i),
  }));
  const noise = Array.from({ length: 4 }, (_, i) => ({ dir: unit(500 + i), freq: 9 + 6 * i, phase: 6.28 * h(520 + i) }));
  const geo = new THREE.IcosahedronGeometry(1, 5);
  const p = geo.attributes.position, d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    let r = 1;
    for (const b of bumps) r += b.amp * Math.sin(b.freq * d.dot(b.dir) * Math.PI + b.phase);
    for (const c of cuts) { const k = d.dot(c.n); if (k > 0) r = Math.min(r, c.c / k); }
    for (const c of craters) {
      const t = Math.acos(Math.min(1, d.dot(c.dir))) / c.rho;
      if (t < 1) r -= c.depth * (1 - t * t);
      r += 0.35 * c.depth * Math.exp(-(((t - 1) / 0.18) ** 2)); // raised rim
    }
    for (const n of noise) r += 0.012 * (1 - 2 * Math.abs(Math.sin(n.freq * d.dot(n.dir) + n.phase)));
    p.setXYZ(i, d.x * r * axes[0] * size, d.y * r * axes[1] * size, d.z * r * axes[2] * size);
  }
  geo.computeVertexNormals();
  return geo;
}
const rockTexture = new THREE.TextureLoader().load('https://threejs.org/examples/textures/planets/moon_1024.jpg');
rockTexture.colorSpace = THREE.SRGBColorSpace;
const rockMaterial = new THREE.MeshLambertMaterial({
  map: rockTexture, bumpMap: rockTexture, bumpScale: 2, color: 0x8a8a8a, flatShading: true });

// Sharper texture, loaded on first focus and swapped in once the camera has arrived.
let rockTextureHi = null, zoomedIn = false;
function useRockTexture(tex) {
  rockMaterial.map = rockMaterial.bumpMap = tex;
  rockMaterial.needsUpdate = true;
}
function loadRockTextureHi() {
  if (rockTextureHi) return;
  rockTextureHi = new THREE.TextureLoader().load('textures/rock_4k.jpg', tex => zoomedIn && useRockTexture(tex));
  rockTextureHi.colorSpace = THREE.SRGBColorSpace;
  rockTextureHi.anisotropy = globe.renderer().capabilities.getMaxAnisotropy();
}

const sizeOf = a => Math.max(1.2, 0.8 + 0.9 * Math.log10(Math.max(a.diameter_max_m, 10) / 10));

// Hypothetical flight path: a straight, fading trail ending at the asteroid, tangent to Earth's
// radial direction, with length proportional to its speed. Like the position, it is illustrative.
const PATH_LEN_PER_KMS = 6, pathMats = new Map(); // asteroid id -> LineMaterial
function pathLine(a) {
  const c = globe.getCoords(a.lat, a.lng, a.alt);
  const radial = new THREE.Vector3(c.x, c.y, c.z).normalize();
  let v;
  if (a.from_lat !== undefined) { // real: the direction it came from, made tangent to the radial
    const f = globe.getCoords(a.from_lat, a.from_lng, 0);
    v = new THREE.Vector3(f.x, f.y, f.z).normalize();
    v.addScaledVector(radial, -v.dot(radial));
  } else {
    const rnd = new THREE.Vector3(hash(a.id, 80) - .5, hash(a.id, 81) - .5, hash(a.id, 82) - .5);
    v = new THREE.Vector3().crossVectors(radial, rnd);
  }
  if (v.lengthSq() < 1e-6) v.set(1, 0, 0);
  v.normalize();
  const len = PATH_LEN_PER_KMS * a.velocity_kms;
  const tail = v.clone().multiplyScalar(len), head = new THREE.Vector3(); // ends at the asteroid
  const col = new THREE.Color(a.hazardous ? 0xff5a3c : 0x4fd8ff);
  const geo = new LineGeometry();
  geo.setPositions([tail.x, tail.y, tail.z, head.x, head.y, head.z]);
  geo.setColors([0, 0, 0, col.r, col.g, col.b]); // fades from black (invisible when additive) to full colour
  const mat = new LineMaterial({
    linewidth: 2, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.resolution.set(innerWidth, innerHeight);
  pathMats.set(a.id, mat);
  return new Line2(geo, mat);
}

const HIT_MIN_R = 6; // globe units; minimum radius of the invisible click target around an asteroid
const globe = Globe()($('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .showAtmosphere(true)
  .customLayerData([])
  .customThreeObject(a => {
    const group = new THREE.Group();
    // Invisible sphere that enlarges the clickable/hoverable area (raycasting ignores material.visible).
    const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(HIT_MIN_R, sizeOf(a) * 2.5), 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }));
    group.add(new THREE.Mesh(asteroidGeometry(a), rockMaterial), pathLine(a), hit);
    return group;
  })
  .customThreeObjectUpdate((obj, a) => Object.assign(obj.position, globe.getCoords(a.lat, a.lng, a.alt)))
  .customLayerLabel(a => `<b>${a.name}</b><br>${a.miss_lunar.toFixed(1)} lunar distances`)
  .onCustomLayerClick(focusAsteroid);

globe.controls().autoRotate = false;
globe.controls().autoRotateSpeed = 0.15;
globe.controls().addEventListener('start', () => globe.controls().autoRotate = false);
globe.pointOfView({ altitude: 7 }); // 8 Earth radii from the centre

function showInfo(a) {
  $('i-name').textContent = a.name;
  const rows = [
    ['Diameter', `${a.diameter_min_m.toFixed(0)} - ${a.diameter_max_m.toFixed(0)} m`],
    ['Closest approach', a.approach_datetime || a.approach_date],
    ['Miss distance', `${Math.round(a.miss_km).toLocaleString()} km`],
    ['', `${a.miss_lunar.toFixed(2)} lunar distances`],
    ['', `${a.miss_au.toFixed(4)} AU`],
    ['Velocity', `${a.velocity_kms.toFixed(1)} km/s`],
    ['Hazardous', a.hazardous ? 'yes' : 'no'],
    ['Position', a.approx ? 'approximate (illustrative)' : 'JPL Horizons'],
  ];
  $('i-body').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; return [dt, dd];
  }));
  $('i-link').href = a.jpl_url;
  $('info').classList.remove('hidden');
}

// --- Focus view: fly to the clicked asteroid, info box left, asteroid right ---
const camera = globe.camera(), controls = globe.controls();
let saved = null, offsetFrac = 0, flight = 0;
const ROTATE_FACTOR = 0.5; // mouse-drag rotation speed relative to globe.gl's default
const wantTarget = new THREE.Vector3(); // globe.gl resets controls.target to the origin on every change

controls.addEventListener('change', () => {
  controls.target.copy(wantTarget);
  controls.rotateSpeed = saved ? 0.5 : controls.rotateSpeed * ROTATE_FACTOR;
});

function applyOffset(f) {
  offsetFrac = f;
  const W = innerWidth, H = innerHeight;
  if (f) camera.setViewOffset(W, H, -W / 4 * f, 0, W, H); // shifts the view centre toward the right half
  else camera.clearViewOffset();
}
addEventListener('resize', () => {
  offsetFrac && applyOffset(offsetFrac);
  pathMats.forEach(m => m.resolution.set(innerWidth, innerHeight));
});

// The camera orbits around Earth (direction slerp + radius lerp) so it never cuts through the
// globe; the look-at point reaches the asteroid early on the way in and leaves it late on the way out.
function fly(toPos, toTarget, toOffset, ms, done, targetEarly = true) {
  const t0 = performance.now(), id = ++flight;
  const fromTarget = controls.target.clone(), fromOffset = offsetFrac;
  const len0 = camera.position.length(), len1 = toPos.length();
  const dir0 = camera.position.clone().normalize();
  const rot = new THREE.Quaternion().setFromUnitVectors(dir0, toPos.clone().normalize());
  const q = new THREE.Quaternion(), identity = new THREE.Quaternion();
  const smooth = x => x * x * (3 - 2 * x);
  controls.enabled = false;
  (function step(now) {
    if (id !== flight) return;
    const k = Math.min(1, (now - t0) / ms), e = smooth(k);
    const te = smooth(targetEarly ? Math.min(1, k / 0.7) : Math.max(0, (k - 0.3) / 0.7));
    controls.target.lerpVectors(fromTarget, toTarget, te);
    wantTarget.copy(controls.target);
    q.slerpQuaternions(identity, rot, e);
    camera.position.copy(dir0).applyQuaternion(q).multiplyScalar(len0 + (len1 - len0) * e);
    applyOffset(fromOffset + (toOffset - fromOffset) * e);
    if (k < 1) requestAnimationFrame(step); else { controls.enabled = true; done && done(); }
  })(t0);
}

let focusedId = null;
const highlightPath = id => pathMats.forEach((m, k) => m.linewidth = k === id ? 4 : 2);

function focusAsteroid(a) {
  highlightPath(focusedId = a.id);
  if (!saved) saved = {
    pos: camera.position.clone(), target: controls.target.clone(),
    min: controls.minDistance, max: controls.maxDistance, zoomToCursor: controls.zoomToCursor,
  };
  controls.autoRotate = false;
  showInfo(a);
  document.body.classList.add('focused');
  const c = globe.getCoords(a.lat, a.lng, a.alt), pos = new THREE.Vector3(c.x, c.y, c.z);
  // Look at it from the side (not toward Earth) so the backdrop is empty space.
  let side = new THREE.Vector3().crossVectors(pos, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  controls.minDistance = 1; controls.maxDistance = 1000; controls.zoomToCursor = false;
  loadRockTextureHi();
  fly(pos.clone().addScaledVector(side, sizeOf(a) * 3.4), pos, 1, ZOOM_IN_TIME_MS, () => {
    zoomedIn = true;
    if (rockTextureHi.image) useRockTexture(rockTextureHi); // else swapped in by its load callback
  });
}

function unfocus() {
  document.body.classList.remove('focused');
  $('info').classList.add('hidden');
  if (!saved) return;
  highlightPath(focusedId = null);
  zoomedIn = false;
  useRockTexture(rockTexture);
  const s = saved; saved = null;
  fly(s.pos, s.target, 0, ZOOM_OUT_TIME_MS, () => { controls.minDistance = s.min; controls.maxDistance = s.max; controls.zoomToCursor = s.zoomToCursor; }, false);
}
$('close').onclick = unfocus;
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (openPanel) showPanel(null); else unfocus();
});

function render() {
  const only = $('onlyHazardous').checked;
  pathMats.clear(); // objects are rebuilt below
  visible = asteroids.filter(a => !only || a.hazardous).map(place);
  globe.customLayerData(visible);
  renderTable();
}

// --- Navigation: date range / asteroid list / information ---
let visible = [], openPanel = null, sort = { key: 'miss_km', desc: false };
const PANELS = ['controls', 'list', 'about'];
function showPanel(name) {
  openPanel = name === openPanel ? null : name;
  PANELS.forEach(p => $(p).classList.toggle('hidden', p !== openPanel));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.target === openPanel));
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => showPanel(b.dataset.target));
document.querySelectorAll('.modal-close').forEach(b => b.onclick = () => showPanel(null));

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'approach_datetime', label: 'Closest approach', get: a => a.approach_datetime || a.approach_date },
  { key: 'diameter_max_m', label: 'Diameter', get: a => `${a.diameter_min_m.toFixed(0)} - ${a.diameter_max_m.toFixed(0)} m` },
  { key: 'miss_km', label: 'Miss distance', get: a => `${Math.round(a.miss_km).toLocaleString()} km` },
  { key: 'miss_lunar', label: 'Lunar distances', get: a => a.miss_lunar.toFixed(2) },
  { key: 'miss_au', label: 'AU', get: a => a.miss_au.toFixed(4) },
  { key: 'velocity_kms', label: 'Velocity', get: a => `${a.velocity_kms.toFixed(1)} km/s` },
  { key: 'hazardous', label: 'Hazardous', get: a => a.hazardous ? 'yes' : 'no' },
  { key: 'approx', label: 'Position', get: a => a.approx ? 'approximate' : 'JPL Horizons' },
];
function renderTable() {
  $('list-count').textContent = `(${visible.length})`;
  $('list-head').replaceChildren(...COLUMNS.map(c => {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.classList.toggle('sorted', sort.key === c.key);
    th.classList.toggle('desc', sort.key === c.key && sort.desc);
    th.onclick = () => { sort = { key: c.key, desc: sort.key === c.key && !sort.desc }; renderTable(); };
    return th;
  }));
  const dir = sort.desc ? -1 : 1;
  const rows = [...visible].sort((x, y) => {
    const u = x[sort.key], v = y[sort.key];
    return dir * (typeof u === 'string' ? u.localeCompare(v) : Number(u) - Number(v));
  });
  $('list-body').replaceChildren(...rows.map(a => {
    const tr = document.createElement('tr');
    tr.append(...COLUMNS.map(c => {
      const td = document.createElement('td');
      td.textContent = c.get ? c.get(a) : a[c.key];
      if (c.key === 'hazardous' && a.hazardous) td.className = 'haz';
      return td;
    }));
    tr.onclick = () => { showPanel(null); focusAsteroid(a); };
    return tr;
  }));
}

// Static hosting (GitHub Pages) has no backend: query NASA NeoWs from the browser instead.
// DEMO_KEY is rate-limited per visitor IP (~30 requests/hour); no Horizons, so positions are hashed.
const NASA_FEED = 'https://api.nasa.gov/neo/rest/v1/feed';
const NASA_KEY = 'DEMO_KEY';
const MAX_SPAN = 7, MAX_RANGE_DAYS = 31;
let hasBackend = true;

function normalize(neo, day) { // mirrors app/nasa.py _normalize
  const ap = neo.close_approach_data.find(x => x.orbiting_body === 'Earth' && x.close_approach_date === day);
  if (!ap) return null;
  const diam = neo.estimated_diameter.meters, miss = ap.miss_distance;
  return {
    id: neo.id, name: neo.name.replace(/^\(|\)$/g, ''),
    diameter_min_m: diam.estimated_diameter_min, diameter_max_m: diam.estimated_diameter_max,
    hazardous: neo.is_potentially_hazardous_asteroid,
    approach_date: day, approach_datetime: ap.close_approach_date_full ?? null,
    approach_epoch_ms: Number(ap.epoch_date_close_approach),
    miss_km: +miss.kilometers, miss_lunar: +miss.lunar, miss_au: +miss.astronomical,
    velocity_kms: +ap.relative_velocity.kilometers_per_second, jpl_url: neo.nasa_jpl_url,
  };
}

async function fetchNasa(start, end) {
  const s = new Date(start), e = new Date(end), days = (e - s) / 864e5;
  if (!(days >= 0) || days > MAX_RANGE_DAYS) throw new Error(`Invalid range (end >= start, max ${MAX_RANGE_DAYS} days)`);
  const records = [];
  for (let d = s; d <= e; d = new Date(d.getTime() + MAX_SPAN * 864e5)) {
    const chunkEnd = new Date(Math.min(d.getTime() + (MAX_SPAN - 1) * 864e5, e.getTime()));
    const res = await fetch(`${NASA_FEED}?start_date=${iso(d)}&end_date=${iso(chunkEnd)}&api_key=${NASA_KEY}`);
    if (res.status === 429) throw new Error('NASA rate limit reached (DEMO_KEY), try again later');
    if (!res.ok) throw new Error(`NASA returned HTTP ${res.status}`);
    for (const [day, neos] of Object.entries((await res.json()).near_earth_objects))
      for (const n of neos) { const r = normalize(n, day); if (r) records.push(r); }
  }
  records.sort((x, y) => x.miss_km - y.miss_km);
  return { complete: true, count: records.length, vectors_pending: 0, asteroids: records };
}

async function fetchAsteroids(start, end) {
  if (hasBackend) {
    const res = await fetch(`/api/asteroids?start=${start}&end=${end}`);
    if (res.status !== 404) {
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      return res.json();
    }
    hasBackend = false;
  }
  return fetchNasa(start, end);
}

let loadId = 0;
async function load(start, end, poll = false) {
  const id = poll ? loadId : ++loadId;
  if (!poll) $('status').textContent = 'Loading...';
  try {
    const data = await fetchAsteroids(start, end);
    if (id !== loadId) return; // a newer range was requested
    asteroids = data.asteroids;
    $('status').textContent = asteroids.length
      ? `${asteroids.length} asteroids` + (data.complete ? '' : ' (NASA unreachable: cached data only)')
      : 'No asteroids in this range.';
    if (data.vectors_pending) {
      $('status').textContent += ` - resolving positions (${data.vectors_pending} left)`;
      setTimeout(() => id === loadId && load(start, end, true), 3000);
    }
    if (!(poll && focusedId)) render(); // a rebuild during a poll would reset an open focus view
  } catch (e) { $('status').textContent = 'Error: ' + e.message; }
}

const iso = d => d.toISOString().slice(0, 10);
const today = new Date(), weekLater = new Date(Date.now() + 7 * 864e5);
$('start').value = iso(today); $('end').value = iso(weekLater);
$('controls').addEventListener('submit', e => { e.preventDefault(); load($('start').value, $('end').value); });
// Picking a start date pre-fills the end date with start + 7 days and moves focus there.
$('start').addEventListener('change', () => {
  if (!$('start').value) return;
  $('end').value = iso(new Date(new Date($('start').value).getTime() + 7 * 864e5));
  $('end').focus();
  try { $('end').showPicker?.(); } catch {} // needs a recent user gesture; focus alone is the fallback
});
$('onlyHazardous').addEventListener('change', render);
load($('start').value, $('end').value);
