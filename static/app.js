import * as THREE from 'https://esm.sh/three@0.180.0';
import Globe from 'https://esm.sh/globe.gl@2.46.2?deps=three@0.180.0';

const EARTH_R_KM = 6371;
const K = 0.5; // altitude = K * log10(1 + miss_km / EARTH_R_KM), in globe radii

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
  const lat = Math.asin(2 * hash(a.id, 1) - 1) * 180 / Math.PI; // uniform on sphere
  const lng = hash(a.id, 2) * 360 - 180;
  return { ...a, lat, lng, alt: altitudeOf(a.miss_km) };
}
// Lumpy, elongated rock: an ellipsoid with a few seeded low-frequency bumps.
// Displacement depends only on the vertex direction, so the faceted mesh stays closed.
function asteroidGeometry(a) {
  const size = sizeOf(a), id = a.id;
  const axes = [0, 1, 2].map(i => 0.65 + 0.55 * hash(id, 20 + i));
  const bumps = Array.from({ length: 5 }, (_, i) => ({
    dir: new THREE.Vector3(hash(id, 30 + i) - .5, hash(id, 40 + i) - .5, hash(id, 50 + i) - .5).normalize(),
    freq: 2 + 5 * hash(id, 60 + i), phase: 6.28 * hash(id, 70 + i), amp: 0.16 / (1 + i * 0.6),
  }));
  const geo = new THREE.IcosahedronGeometry(1, 4);
  const p = geo.attributes.position, d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    let r = 1;
    for (const b of bumps) r += b.amp * Math.sin(b.freq * d.dot(b.dir) * Math.PI + b.phase);
    p.setXYZ(i, d.x * r * axes[0] * size, d.y * r * axes[1] * size, d.z * r * axes[2] * size);
  }
  geo.computeVertexNormals();
  return geo;
}
const rockTexture = new THREE.TextureLoader().load('https://threejs.org/examples/textures/planets/moon_1024.jpg');
rockTexture.colorSpace = THREE.SRGBColorSpace;
const rockMaterial = new THREE.MeshLambertMaterial({
  map: rockTexture, bumpMap: rockTexture, bumpScale: 2, color: 0x8a8a8a, flatShading: true });

const sizeOf = a => Math.max(1.2, 0.8 + 0.9 * Math.log10(Math.max(a.diameter_max_m, 10) / 10));

const globe = Globe()($('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .showAtmosphere(true)
  .customLayerData([])
  .customThreeObject(a => new THREE.Mesh(
    asteroidGeometry(a),
    rockMaterial))
  .customThreeObjectUpdate((obj, a) => Object.assign(obj.position, globe.getCoords(a.lat, a.lng, a.alt)))
  .customLayerLabel(a => `<b>${a.name}</b><br>${a.miss_lunar.toFixed(1)} lunar distances`)
  .onCustomLayerClick(focusAsteroid);

globe.controls().autoRotate = true;
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
addEventListener('resize', () => offsetFrac && applyOffset(offsetFrac));

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

function focusAsteroid(a) {
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
  fly(pos.clone().addScaledVector(side, sizeOf(a) * 3.4), pos, 1, 2500);
}

function unfocus() {
  document.body.classList.remove('focused');
  $('info').classList.add('hidden');
  if (!saved) return;
  const s = saved; saved = null;
  fly(s.pos, s.target, 0, 2000, () => { controls.minDistance = s.min; controls.maxDistance = s.max; controls.zoomToCursor = s.zoomToCursor; }, false);
}
$('close').onclick = unfocus;
addEventListener('keydown', e => e.key === 'Escape' && unfocus());

function render() {
  const only = $('onlyHazardous').checked;
  globe.customLayerData(asteroids.filter(a => !only || a.hazardous).map(place));
}

async function load(start, end) {
  $('status').textContent = 'Loading...';
  try {
    const res = await fetch(`/api/asteroids?start=${start}&end=${end}`);
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    asteroids = data.asteroids;
    $('status').textContent = asteroids.length
      ? `${asteroids.length} asteroids` + (data.complete ? '' : ' (NASA unreachable: cached data only)')
      : 'No asteroids in this range.';
    render();
  } catch (e) { $('status').textContent = 'Error: ' + e.message; }
}

const iso = d => d.toISOString().slice(0, 10);
const today = new Date(), weekLater = new Date(Date.now() + 7 * 864e5);
$('start').value = iso(today); $('end').value = iso(weekLater);
$('controls').addEventListener('submit', e => { e.preventDefault(); load($('start').value, $('end').value); });
$('onlyHazardous').addEventListener('change', render);
load($('start').value, $('end').value);
