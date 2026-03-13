/**
 * computeIsochrones.ts
 *
 * Queries GraphHopper's isochrone API for every station and writes the results
 * as static GeoJSON files.
 *
 * Coordinate snapping: OSM station nodes sit on railway tracks/platforms, not
 * street exits. This script snaps each station to its nearest GTFS stop (which
 * uses street-level coordinates from KTDB) within 800 m before querying.
 *
 * Multi-direction departures: A station may serve multiple lines and directions.
 * For each nearby GTFS stop (within 400 m), the script finds the first departure
 * at or after 14:00 (off-peak weekday). GraphHopper is queried once per unique
 * departure time and the results are unioned. This gives each direction the full
 * time budget — equivalent to "every train departs at the target time."
 *
 * Degenerate recovery: If the primary coordinate fails, the script retries with
 * alternative nearby GTFS stops, then cardinal/diagonal nudges (~100m offsets).
 *
 * Post-processing: interior rings stripped, MultiPolygon islands preserved
 * (they represent real transit-reachable corridors), light simplification.
 *
 * Prerequisites:
 *   - GraphHopper running at http://localhost:8989 (via docker compose)
 *   - public/data/stations.geojson
 *   - docker/gtfs/seoul-metro.gtfs.zip  (for coordinate snapping + departure lookup)
 *
 * Run: npx tsx scripts/computeIsochrones.ts
 * Output: public/data/isochrones/*.geojson
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { union, simplify, featureCollection, feature as turfFeature } from "@turf/turf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GeoFeature = { type: "Feature"; properties: Record<string, any>; geometry: { type: string; coordinates: unknown } };

const GH_URL = process.env.GH_URL || "http://localhost:8989";
const ROOT = join(import.meta.dirname, "..");
const STATIONS_PATH = join(ROOT, "public", "data", "stations.geojson");
const GTFS_ZIP = join(ROOT, "docker", "gtfs", "seoul-metro.gtfs.zip");
const OUT_DIR = join(ROOT, "public", "data", "isochrones");

const INTERVALS = [15, 30, 60]; // minutes
const INTERVAL_SECONDS = INTERVALS.map((m) => m * 60);

// Off-peak weekday 14:00 — single profile
const TARGET_TIME = "14:00:00";
const DATE_PREFIX = "2024-06-05T"; // Wednesday — GraphHopper uses this for GTFS calendar matching

const MIN_BBOX_METERS = 500;
const CONCURRENCY = 2;

interface StationGeoJSON {
  type: "FeatureCollection";
  features: Array<{
    properties: { id: string; name_ko: string };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

interface GtfsStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
}

// ── GTFS loading ──────────────────────────────────────────────────────────

function loadGtfsStops(): GtfsStop[] {
  try {
    const csv = execSync(`unzip -p "${GTFS_ZIP}" stops.txt`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const lines = csv.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const idx = (name: string) => headers.indexOf(name);
    const iId = idx("stop_id"), iName = idx("stop_name"), iLat = idx("stop_lat"), iLon = idx("stop_lon");
    return lines.slice(1).flatMap((line) => {
      const parts = line.split(",");
      const lat = parseFloat(parts[iLat]);
      const lon = parseFloat(parts[iLon]);
      if (isNaN(lat) || isNaN(lon)) return [];
      return [{ stop_id: parts[iId]?.trim(), stop_name: parts[iName]?.trim(), lat, lon }];
    });
  } catch {
    console.warn("⚠ Could not load GTFS stops — will use OSM coordinates");
    return [];
  }
}

type DepartureIndex = Map<string, string[]>;

function loadDepartureIndex(): DepartureIndex {
  const index: DepartureIndex = new Map();
  try {
    const csv = execSync(`unzip -p "${GTFS_ZIP}" stop_times.txt`, { maxBuffer: 50 * 1024 * 1024 }).toString();
    const lines = csv.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const iStop = headers.indexOf("stop_id");
    const iDep = headers.indexOf("departure_time");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      const stopId = parts[iStop]?.trim();
      const dep = parts[iDep]?.trim();
      if (!stopId || !dep) continue;
      let arr = index.get(stopId);
      if (!arr) { arr = []; index.set(stopId, arr); }
      arr.push(dep);
    }
    index.forEach((arr) => arr.sort());
    console.log(`  ${index.size} stops with departure times indexed.`);
  } catch {
    console.warn("⚠ Could not load GTFS stop_times");
  }
  return index;
}

// ── Coordinate + departure helpers ────────────────────────────────────────

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestGtfsStop(lat: number, lon: number, stops: GtfsStop[], maxDist = 800): GtfsStop | null {
  let best: GtfsStop | null = null;
  let bestDist = maxDist;
  for (const s of stops) {
    const d = distanceM(lat, lon, s.lat, s.lon);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function nearbyGtfsStops(lat: number, lon: number, stops: GtfsStop[], maxDist = 400): GtfsStop[] {
  return stops.filter((s) => distanceM(lat, lon, s.lat, s.lon) <= maxDist);
}

function firstDeparture(stopId: string, targetTime: string, depIndex: DepartureIndex): string | null {
  const deps = depIndex.get(stopId);
  if (!deps || deps.length === 0) return null;
  let lo = 0, hi = deps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (deps[mid] < targetTime) lo = mid + 1;
    else hi = mid;
  }
  return lo < deps.length ? deps[lo] : null;
}

function allFirstDepartures(stops: GtfsStop[], targetTime: string, depIndex: DepartureIndex): string[] {
  const seen = new Set<string>();
  for (const s of stops) {
    const dep = firstDeparture(s.stop_id, targetTime, depIndex);
    if (dep !== null) seen.add(dep);
  }
  return Array.from(seen).sort();
}

// ── Geometry helpers ──────────────────────────────────────────────────────

async function fetchPolygon(
  lat: number, lon: number, timeLimitSeconds: number, departure: string
): Promise<{ type: string; coordinates: unknown } | null> {
  const params = new URLSearchParams({
    point: `${lat},${lon}`,
    profile: "pt",
    "pt.earliest_departure_time": departure,
    reverse_flow: "false",
    time_limit: String(timeLimitSeconds),
  });
  try {
    const res = await fetch(`${GH_URL}/isochrone?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const poly = data.polygons?.[0] ?? data.features?.[0] ?? null;
    return poly?.geometry ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripHoles(geometry: any): any {
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: [geometry.coordinates[0]] };
  }
  if (geometry.type === "MultiPolygon") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...geometry, coordinates: geometry.coordinates.map((poly: any) => [poly[0]]) };
  }
  return geometry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bboxDiagM(geometry: any): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rings: number[][][] = geometry.type === "MultiPolygon"
    ? geometry.coordinates.map((p: number[][][]) => p[0])
    : [geometry.coordinates?.[0]];
  const allCoords = rings.flat().filter(Boolean);
  if (allCoords.length < 3) return 0;
  const lons = allCoords.map((p) => p[0]);
  const lats = allCoords.map((p) => p[1]);
  const w = (Math.max(...lons) - Math.min(...lons)) * 111_000;
  const h = (Math.max(...lats) - Math.min(...lats)) * 111_000;
  return Math.sqrt(w * w + h * h);
}

// ── Per-station processing ──────────────────────────────────────────────

const COORD_NUDGES: [number, number][] = [
  [0.001, 0], [-0.001, 0], [0, 0.001], [0, -0.001],
  [0.0007, 0.0007], [-0.0007, 0.0007], [0.0007, -0.0007], [-0.0007, -0.0007],
];

async function computeIsochrone(
  lat: number, lon: number, departures: string[], id: string
): Promise<GeoFeature[] | null> {
  // Fire ALL queries in parallel: every interval × every departure
  type Query = { intervalIdx: number; dep: string };
  const queries: Query[] = [];
  for (let i = 0; i < INTERVAL_SECONDS.length; i++) {
    for (const dep of departures) {
      queries.push({ intervalIdx: i, dep });
    }
  }

  const results = await Promise.all(
    queries.map((q) => fetchPolygon(lat, lon, INTERVAL_SECONDS[q.intervalIdx], q.dep))
  );

  // Group results by interval
  const features: GeoFeature[] = [];
  for (let i = 0; i < INTERVAL_SECONDS.length; i++) {
    const geometries = queries
      .map((q, idx) => q.intervalIdx === i ? results[idx] : null)
      .filter(Boolean);

    if (geometries.length === 0) continue;

    let finalGeometry = geometries[0];
    if (geometries.length > 1) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const merged = union(featureCollection(geometries.map((g) => turfFeature(g as any))) as any);
        if (merged) finalGeometry = merged.geometry;
      } catch { /* keep first on failure */ }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let smoothed: any = stripHoles(finalGeometry);
    try {
      smoothed = simplify(turfFeature(smoothed), { tolerance: 0.0005, highQuality: true }).geometry;
    } catch { /* keep unsimplified */ }

    features.push({
      type: "Feature",
      properties: { interval: INTERVALS[i], stationId: id },
      geometry: smoothed,
    });
  }

  if (features.length === 0) return null;
  const diags = features.map((f) => bboxDiagM(f.geometry));
  if (Math.max(...diags) < MIN_BBOX_METERS) return null;
  return features;
}

async function processStation(
  lat: number, lon: number, id: string,
  departures: string[], outDir: string, nearbyStops: GtfsStop[]
): Promise<{ status: "ok" | "skip" | "degenerate"; retryNote: string }> {
  // 1st: primary snapped coordinate
  let features = await computeIsochrone(lat, lon, departures, id);
  if (features) {
    writeFileSync(join(outDir, `${id}.geojson`), JSON.stringify({ type: "FeatureCollection", features }));
    return { status: "ok", retryNote: "" };
  }

  // 2nd: try other nearby GTFS stops
  for (const stop of nearbyStops) {
    if (stop.lat === lat && stop.lon === lon) continue;
    features = await computeIsochrone(stop.lat, stop.lon, departures, id);
    if (features) {
      writeFileSync(join(outDir, `${id}.geojson`), JSON.stringify({ type: "FeatureCollection", features }));
      return { status: "ok", retryNote: " (retry: alt stop)" };
    }
  }

  // 3rd: nudge coordinates ~100m
  for (const [dlat, dlon] of COORD_NUDGES) {
    features = await computeIsochrone(lat + dlat, lon + dlon, departures, id);
    if (features) {
      writeFileSync(join(outDir, `${id}.geojson`), JSON.stringify({ type: "FeatureCollection", features }));
      return { status: "ok", retryNote: " (retry: nudge)" };
    }
  }

  return { status: "degenerate", retryNote: "" };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading GTFS stops...");
  const gtfsStops = loadGtfsStops();
  console.log(`  ${gtfsStops.length} stops loaded.`);

  console.log("Loading GTFS departure times...");
  const depIndex = loadDepartureIndex();

  let stations: StationGeoJSON;
  try {
    stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"));
  } catch {
    console.error(`Cannot read ${STATIONS_PATH}. Run fetchStations.ts first.`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\nComputing isochrones for ${stations.features.length} stations (off-peak 14:00)...\n`);

  const total = stations.features.length;
  let done = 0;
  const counts = { ok: 0, skip: 0, degenerate: 0 };

  for (let i = 0; i < stations.features.length; i += CONCURRENCY) {
    const batch = stations.features.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (feature) => {
      const { id, name_ko } = feature.properties;
      const [osmLon, osmLat] = feature.geometry.coordinates;

      const snap = nearestGtfsStop(osmLat, osmLon, gtfsStops);
      const lat = snap ? snap.lat : osmLat;
      const lon = snap ? snap.lon : osmLon;
      const snapNote = snap ? ` (snapped ${Math.round(distanceM(osmLat, osmLon, lat, lon))}m)` : " (OSM)";

      const nearbyStops = nearbyGtfsStops(lat, lon, gtfsStops, 400);
      const depTimes = nearbyStops.length > 0
        ? allFirstDepartures(nearbyStops, TARGET_TIME, depIndex)
        : [TARGET_TIME];
      const departures = depTimes.map((t) => `${DATE_PREFIX}${t}+09:00`);
      const depNote = depTimes.length > 1 ? ` ${depTimes.length}dirs` : "";

      const { status, retryNote } = await processStation(lat, lon, id, departures, OUT_DIR, nearbyStops);
      counts[status]++;
      done++;
      console.log(`[${done}/${total}] ${name_ko}${snapNote}${depNote}${retryNote}: ${status.toUpperCase()}`);
    }));
  }

  console.log(`\nDone.`);
  console.log(`  OK:          ${counts.ok}`);
  console.log(`  DEGENERATE:  ${counts.degenerate}  (no walkable network)`);
  console.log(`  SKIP:        ${counts.skip}  (GraphHopper returned nothing)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
