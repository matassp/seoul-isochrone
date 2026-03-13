/**
 * computeIsochrones.ts
 *
 * Queries GraphHopper's isochrone API for every station × profile combination
 * and writes the results as static GeoJSON files.
 *
 * Coordinate snapping: OSM station nodes sit on railway tracks/platforms, not
 * street exits. GraphHopper cannot snap those to the pedestrian network, producing
 * degenerate tiny polygons. This script first loads GTFS stops.txt (which uses
 * street-level coordinates from the Seoul Open Data timetable API) and snaps each
 * station to its nearest GTFS stop within 800 m before querying GraphHopper.
 *
 * Wait-time approximation: each profile is queried at two departure offsets
 * (0 and half the typical headway). The union of both polygons represents
 * "reachable area if you arrive at a random point in the headway window".
 *
 * Post-processing: interior rings stripped, MultiPolygon islands discarded
 * (keep largest sub-polygon), simplify geometry, skip degenerate results.
 *
 * Prerequisites:
 *   - GraphHopper running at http://localhost:8989 (via docker compose)
 *   - public/data/stations.geojson
 *   - docker/gtfs/seoul-metro.gtfs.zip  (for coordinate snapping)
 *
 * Run: npx tsx scripts/computeIsochrones.ts
 * Output: public/data/isochrones/{off-peak,peak}/*.geojson
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
const OUT_BASE = join(ROOT, "public", "data", "isochrones");

const INTERVALS = [15, 30, 60]; // minutes
const INTERVAL_SECONDS = INTERVALS.map((m) => m * 60);

// Minimum bounding box diagonal (meters) for a polygon to be considered valid.
// Anything smaller is a degenerate result (GraphHopper couldn't reach the street network).
const MIN_BBOX_METERS = 500;

interface Profile {
  id: string;
  departure: string;    // ISO datetime with timezone
  offsets: number[];    // additional departure offsets in seconds (for headway union)
}

const PROFILES: Profile[] = [
  {
    id: "off-peak",
    departure: "2024-06-05T14:00:00+09:00", // Wednesday 2pm KST
    offsets: [0, 150],                        // 0 + 2.5 min — covers ~5-min off-peak headway
  },
  {
    id: "peak",
    departure: "2024-06-05T08:00:00+09:00",  // Wednesday 8am KST
    offsets: [0, 90],                          // 0 + 1.5 min — covers ~3-min peak headway
  },
];

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

// ── GTFS coordinate snapping ────────────────────────────────────────────────

/** Load all stops from the GTFS zip via `unzip -p`. */
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
    console.warn("⚠ Could not load GTFS stops — will use OSM coordinates (expect degenerate results)");
    return [];
  }
}

/** Haversine distance in metres between two lat/lon points. */
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Return the nearest GTFS stop within maxDist metres, or null. */
function nearestGtfsStop(lat: number, lon: number, stops: GtfsStop[], maxDist = 800): GtfsStop | null {
  let best: GtfsStop | null = null;
  let bestDist = maxDist;
  for (const s of stops) {
    const d = distanceM(lat, lon, s.lat, s.lon);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// ── Geometry helpers ────────────────────────────────────────────────────────

/** Add seconds to an ISO datetime string with offset, e.g. "2024-06-05T14:00:00+09:00" */
function addSeconds(iso: string, seconds: number): string {
  const date = new Date(iso);
  date.setSeconds(date.getSeconds() + seconds);
  const offsetMatch = iso.match(/([+-]\d{2}:\d{2})$/);
  const tz = offsetMatch ? offsetMatch[1] : "+09:00";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${tz}`;
}

/** Fetch a single polygon for one (lat, lon, timeLimitSeconds, departure) combo. */
async function fetchPolygon(
  lat: number,
  lon: number,
  timeLimitSeconds: number,
  departure: string
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

/** Strip interior rings and discard small island fragments.
 *  MultiPolygon → keep only the largest sub-polygon (by vertex count), return as Polygon.
 *  Polygon → strip holes, return exterior ring only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fillHoles(geometry: any): any {
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: [geometry.coordinates[0]] };
  }
  if (geometry.type === "MultiPolygon") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const largest = geometry.coordinates.reduce((best: any, poly: any) =>
      poly[0].length > best[0].length ? poly : best
    );
    return { type: "Polygon", coordinates: [largest[0]] };
  }
  return geometry;
}

/** Return the bounding-box diagonal in metres for a Polygon geometry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bboxDiagM(geometry: any): number {
  const ring = geometry.coordinates?.[0];
  if (!ring || ring.length < 3) return 0;
  const lons = ring.map((p: number[]) => p[0]);
  const lats = ring.map((p: number[]) => p[1]);
  const w = (Math.max(...lons) - Math.min(...lons)) * 111_000;
  const h = (Math.max(...lats) - Math.min(...lats)) * 111_000;
  return Math.sqrt(w * w + h * h);
}

// ── Per-station processing ──────────────────────────────────────────────────

const CONCURRENCY = 8;

async function processStation(
  lat: number, lon: number, id: string,
  profile: Profile, outDir: string
): Promise<"ok" | "skip" | "degenerate"> {
  const departures = profile.offsets.map((s) => addSeconds(profile.departure, s));
  const mergedFeatures: GeoFeature[] = [];

  for (let i = 0; i < INTERVAL_SECONDS.length; i++) {
    const t = INTERVAL_SECONDS[i];
    const geometries = (
      await Promise.all(departures.map((dep) => fetchPolygon(lat, lon, t, dep)))
    ).filter(Boolean);

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
    let smoothed: any = fillHoles(finalGeometry);
    try {
      smoothed = simplify(turfFeature(smoothed), { tolerance: 0.003, highQuality: false }).geometry;
    } catch { /* keep unsimplified */ }

    mergedFeatures.push({
      type: "Feature",
      properties: { interval: INTERVALS[i], stationId: id, profile: profile.id },
      geometry: smoothed,
    });
  }

  if (mergedFeatures.length === 0) return "skip";

  // Reject degenerate results: all intervals produce the same tiny polygon
  // (GraphHopper couldn't reach the pedestrian network from this point).
  const diags = mergedFeatures.map((f) => bboxDiagM(f.geometry));
  const maxDiag = Math.max(...diags);
  if (maxDiag < MIN_BBOX_METERS) return "degenerate";

  writeFileSync(join(outDir, `${id}.geojson`), JSON.stringify({ type: "FeatureCollection", features: mergedFeatures }));
  return "ok";
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading GTFS stops for coordinate snapping...");
  const gtfsStops = loadGtfsStops();
  console.log(`  ${gtfsStops.length} stops loaded.`);

  let stations: StationGeoJSON;
  try {
    stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"));
  } catch {
    console.error(`Cannot read ${STATIONS_PATH}. Run fetchStations.ts first.`);
    process.exit(1);
  }

  console.log(`Computing isochrones for ${stations.features.length} stations × ${PROFILES.length} profiles...\n`);

  const total = stations.features.length * PROFILES.length;
  let done = 0;
  const counts = { ok: 0, skip: 0, degenerate: 0 };

  for (const profile of PROFILES) {
    const outDir = join(OUT_BASE, profile.id);
    mkdirSync(outDir, { recursive: true });

    for (let i = 0; i < stations.features.length; i += CONCURRENCY) {
      const batch = stations.features.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (feature) => {
        const { id, name_ko } = feature.properties;
        const [osmLon, osmLat] = feature.geometry.coordinates;

        // Prefer GTFS street-level coords over OSM platform/track coords
        const snap = nearestGtfsStop(osmLat, osmLon, gtfsStops);
        const lat = snap ? snap.lat : osmLat;
        const lon = snap ? snap.lon : osmLon;
        const snapNote = snap ? ` (snapped ${Math.round(distanceM(osmLat, osmLon, lat, lon))}m)` : " (OSM)";

        const result = await processStation(lat, lon, id, profile, outDir);
        counts[result]++;
        done++;
        console.log(`[${done}/${total}] ${profile.id} — ${name_ko}${snapNote}: ${result.toUpperCase()}`);
      }));
    }
  }

  console.log(`\nDone.`);
  console.log(`  OK:          ${counts.ok}`);
  console.log(`  DEGENERATE:  ${counts.degenerate}  (no walkable network at this location)`);
  console.log(`  SKIP:        ${counts.skip}  (GraphHopper returned nothing)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
