import * as THREE from 'https://esm.sh/three@0.180.0';
import Globe from 'https://esm.sh/globe.gl@2.46.2?deps=three@0.180.0';

const EARTH_R_KM = 6371, MOON_KM = 384400, GLOBE_R = 100;
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
const sizeOf = a => Math.max(1.2, 0.8 + 0.9 * Math.log10(Math.max(a.diameter_max_m, 10) / 10));

const globe = Globe()($('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .showAtmosphere(true)
  .customLayerData([])
  .customThreeObject(a => new THREE.Mesh(
    new THREE.IcosahedronGeometry(sizeOf(a), 1),
    new THREE.MeshLambertMaterial({ color: a.hazardous ? 0xff4d4d : 0xaaaaaa })))
  .customThreeObjectUpdate((obj, a) => Object.assign(obj.position, globe.getCoords(a.lat, a.lng, a.alt)))
  .customLayerLabel(a => `<b>${a.name}</b><br>${a.miss_lunar.toFixed(1)} lunar distances`)
  .onCustomLayerClick(showInfo);

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.3;
globe.controls().addEventListener('start', () => globe.controls().autoRotate = false);
globe.pointOfView({ altitude: 4 });

// Dashed ring at the Moon's (log-scaled) distance, as a scale reference.
(function addMoonRing() {
  const r = GLOBE_R * (1 + altitudeOf(MOON_KM));
  const pts = Array.from({ length: 129 }, (_, i) => {
    const t = i / 128 * Math.PI * 2;
    return new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t));
  });
  const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x88aaff, dashSize: 3, gapSize: 3 }));
  ring.computeLineDistances();
  globe.scene().add(ring);
})();

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
$('close').onclick = () => $('info').classList.add('hidden');

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
