// Basemap for the map panel: land (its outline is the coastline) and country borders from Natural Earth 1:10m
// (world-atlas), clipped to a region and rounded, written to public/basemap/. Run once (npm run basemap).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { feature, mesh } from "topojson-client";

const REGION = [-15, 40, 30, 65]; // lon min, lat min, lon max, lat max; must contain the map view
const DIGITS = 3;
const OUT = new URL("../public/basemap/", import.meta.url);

const atlas = (name) => JSON.parse(readFileSync(new URL(`../node_modules/world-atlas/${name}`, import.meta.url)));
const inside = ([x, y]) => x >= REGION[0] && x <= REGION[2] && y >= REGION[1] && y <= REGION[3];
const dedupe = (pts) => pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
const round = (pts) => dedupe(pts.map((c) => c.map((v) => +v.toFixed(DIGITS))));

// Sutherland-Hodgman: a ring against the four edges of REGION
function clipRing(ring) {
  const edges = [
    [(p) => p[0] >= REGION[0], (a, b) => cut(a, b, 0, REGION[0])],
    [(p) => p[0] <= REGION[2], (a, b) => cut(a, b, 0, REGION[2])],
    [(p) => p[1] >= REGION[1], (a, b) => cut(a, b, 1, REGION[1])],
    [(p) => p[1] <= REGION[3], (a, b) => cut(a, b, 1, REGION[3])],
  ];
  let pts = ring.slice(0, -1);
  for (const [isIn, cross] of edges) {
    const out = [];
    pts.forEach((b, i) => {
      const a = pts[(i + pts.length - 1) % pts.length];
      if (isIn(b)) {
        if (!isIn(a)) out.push(cross(a, b));
        out.push(b);
      } else if (isIn(a)) out.push(cross(a, b));
    });
    pts = out;
    if (!pts.length) return null;
  }
  return pts.length >= 3 ? [...pts, pts[0]] : null;
}
function cut(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
// Lines: the runs of points inside REGION
const clipLine = (line) =>
  line.reduce((runs, p) => (inside(p) ? (runs.at(-1).push(p), runs) : (runs.at(-1).length && runs.push([]), runs)), [[]]);

const landTopo = atlas("land-10m.json");
const polygons = feature(landTopo, landTopo.objects.land)
  .features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates))
  .map((poly) => poly.map(clipRing).filter(Boolean).map(round).filter((r) => r.length >= 4))
  .filter((poly) => poly.length);
const countries = atlas("countries-10m.json");
const borders = mesh(countries, countries.objects.countries, (a, b) => a !== b)
  .coordinates.flatMap(clipLine).filter((l) => l.length >= 2).map(round);

mkdirSync(OUT, { recursive: true });
const write = (name, geometry) => {
  const text = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] });
  writeFileSync(new URL(name, OUT), text);
  console.log(name, (text.length / 1e3).toFixed(0), "kB");
};
write("land.geojson", { type: "MultiPolygon", coordinates: polygons });
write("borders.geojson", { type: "MultiLineString", coordinates: borders });
