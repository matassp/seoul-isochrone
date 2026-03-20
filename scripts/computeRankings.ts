// Reads all isochrone GeoJSON files, computes polygon area per interval,
// and writes public/data/rankings.json sorted by 30-min area descending.

import fs from "fs";
import path from "path";
import { area } from "@turf/turf";
import { STATIONS } from "../src/data/stations.js";
import { NAME_OVERRIDES } from "../src/data/nameOverrides.js";

const ISOCHRONES_DIR = path.resolve("public/data/isochrones");
const OUT_FILE = path.resolve("public/data/rankings.json");
const INTERVALS = [15, 30, 60];

const stations = STATIONS.map((s) =>
  NAME_OVERRIDES[s.id] ? { ...s, name: NAME_OVERRIDES[s.id] } : s
);

const stationMap = new Map(stations.map((s) => [s.id, s]));

const files = fs.readdirSync(ISOCHRONES_DIR).filter((f) => f.endsWith(".geojson"));

const rows: { id: string; nameKo: string; name: string; lines: string[]; area15: number; area30: number; area60: number }[] = [];

let done = 0;
for (const file of files) {
  const id = file.replace(".geojson", "");
  const station = stationMap.get(id);
  if (!station) continue;

  const raw = fs.readFileSync(path.join(ISOCHRONES_DIR, file), "utf-8");
  const fc = JSON.parse(raw);

  const areas: Record<number, number> = {};
  for (const interval of INTERVALS) {
    const feature = fc.features.find((f: { properties: { interval: number } }) => f.properties.interval === interval);
    areas[interval] = feature ? Math.round(area(feature) / 1_000_000 * 10) / 10 : 0; // km², 1dp
  }

  rows.push({
    id,
    nameKo: station.nameKo,
    name: station.name,
    lines: station.lines,
    area15: areas[15],
    area30: areas[30],
    area60: areas[60],
  });

  done++;
  if (done % 50 === 0) process.stdout.write(`  ${done}/${files.length}\n`);
}

// Sort by 15-min area descending
rows.sort((a, b) => b.area15 - a.area15);

// Add rank
const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

fs.writeFileSync(OUT_FILE, JSON.stringify(ranked, null, 2));
console.log(`\nWrote ${ranked.length} entries → ${OUT_FILE}`);
