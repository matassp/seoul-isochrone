/**
 * fetchStations.ts
 *
 * Fetches Seoul Metro station data from the Overpass API by querying
 * route relations (which carry the line info) and resolving their
 * member station nodes.
 *
 * Run: npx tsx scripts/fetchStations.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Seoul metro area bounding box
const BBOX = "37.41,126.76,37.70,127.18";

// Map of OSM route relation names/refs to our line IDs.
// We query route=subway relations in the Seoul bbox.
// IMPORTANT: shinbundang MUST come before bundang (신분당 contains 분당).
// Matchers are checked in order, first match wins.
const LINE_MATCHERS: Array<{ id: string; patterns: RegExp[] }> = [
  { id: "shinbundang", patterns: [/신분당/, /Shinbundang/i, /Sinbundang/i] },
  { id: "1", patterns: [/수도권 전철 1호선/, /Seoul Metro Line 1/i] },
  { id: "2", patterns: [/서울 지하철 2호선/, /Seoul Metro Line 2/i] },
  { id: "3", patterns: [/수도권 전철 3호선/, /Seoul Metro Line 3/i, /3호선/] },
  { id: "4", patterns: [/수도권 전철 4호선/, /Seoul Metro Line 4/i, /4호선/] },
  { id: "5", patterns: [/서울 지하철 5호선/, /Seoul Metro Line 5/i, /5호선/] },
  { id: "6", patterns: [/서울 지하철 6호선/, /Seoul Metro Line 6/i, /6호선/] },
  { id: "7", patterns: [/서울 지하철 7호선/, /Seoul Metro Line 7/i, /7호선/] },
  { id: "8", patterns: [/서울 지하철 8호선/, /Seoul Metro Line 8/i, /8호선/] },
  { id: "9", patterns: [/서울 지하철 9호선/, /Seoul Metro Line 9/i, /9호선/] },
  { id: "gyeongui", patterns: [/경의/, /중앙/, /Gyeongui/i, /Jungang/i] },
  { id: "airport", patterns: [/인천국제공항철도/, /Airport Railroad/i, /AREX/i, /골드라인/] },
  { id: "bundang", patterns: [/수인.*분당/, /수인분당/, /Bundang/i] },
];

// Two-phase query:
// Phase 1: Get all subway route relations in the bbox
// Phase 2: For each relation, get its stop nodes
const QUERY = `
[out:json][timeout:300];

// Get subway/light_rail route relations in the Seoul bbox
(
  relation["route"="subway"](${BBOX});
  relation["route"="light_rail"](${BBOX});
  relation["route"="train"]["network"~"수도권|Metropolitan"](${BBOX});
);

// Output relations with their members
out body;

// Recurse down to get ways and nodes (for route geometries)
>;
out skel qt;
`;

interface OverpassRelation {
  type: "relation";
  id: number;
  tags: Record<string, string>;
  members: Array<{
    type: string;
    ref: number;
    role: string;
  }>;
}

interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

type OverpassElement = OverpassRelation | OverpassNode | OverpassWay;

function matchLine(tags: Record<string, string>): string | null {
  const name = tags["name"] || "";
  const nameKo = tags["name:ko"] || "";
  const nameEn = tags["name:en"] || "";
  const ref = tags["ref"] || "";
  const allText = `${name} ${nameKo} ${nameEn} ${ref}`;

  for (const matcher of LINE_MATCHERS) {
    for (const pattern of matcher.patterns) {
      if (pattern.test(allText)) {
        return matcher.id;
      }
    }
  }
  return null;
}

async function main() {
  console.log("Fetching route relations + station nodes from Overpass API...");

  let data: { elements: OverpassElement[] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  Attempt ${attempt}...`);
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(QUERY)}`,
    });

    if (res.status === 429 || res.status === 504) {
      const wait = attempt * 15;
      console.warn(`  Got ${res.status}, waiting ${wait}s before retry...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
    }

    data = await res.json();
    break;
  }

  if (!data!) {
    throw new Error("Failed to fetch data from Overpass API after 3 attempts");
  }
  const elements: OverpassElement[] = data.elements;

  // Separate relations, ways, and nodes
  const relations = elements.filter((e): e is OverpassRelation => e.type === "relation");
  const wayMap = new Map<number, OverpassWay>();
  const nodeMap = new Map<number, OverpassNode>();
  for (const el of elements) {
    if (el.type === "node") {
      nodeMap.set(el.id, el as OverpassNode);
    } else if (el.type === "way") {
      wayMap.set(el.id, el as OverpassWay);
    }
  }

  console.log(`Got ${relations.length} route relations, ${wayMap.size} ways, ${nodeMap.size} nodes.`);

  // Build nodeId -> Set<lineId> mapping from relations
  // Also build lineId -> way refs for route geometries
  const nodeLines = new Map<number, Set<string>>();
  const lineWays = new Map<string, number[][]>(); // lineId -> array of way node arrays

  for (const rel of relations) {
    const lineId = matchLine(rel.tags || {});
    if (!lineId) {
      const name = rel.tags?.["name"] || rel.tags?.["name:ko"] || `(id: ${rel.id})`;
      console.log(`  Skipping unmatched relation: ${name}`);
      continue;
    }

    console.log(`  Matched line "${lineId}" <- ${rel.tags?.["name:ko"] || rel.tags?.["name"] || rel.id}`);

    for (const member of rel.members) {
      if (member.type === "node") {
        // Station stop members
        const role = member.role || "";
        if (role && !role.includes("stop") && role !== "halt" && role !== "station") continue;

        if (!nodeLines.has(member.ref)) {
          nodeLines.set(member.ref, new Set());
        }
        nodeLines.get(member.ref)!.add(lineId);
      } else if (member.type === "way") {
        // Track/route geometry members
        const way = wayMap.get(member.ref);
        if (way && way.nodes.length > 1) {
          if (!lineWays.has(lineId)) {
            lineWays.set(lineId, []);
          }
          lineWays.get(lineId)!.push(way.nodes);
        }
      }
    }
  }

  console.log(`\nFound ${nodeLines.size} station node references across all lines.`);

  // Now we need the station nodes with their tags (names, coordinates).
  // The `>; out skel qt;` only gives us coordinates, not tags.
  // Let's do a second query for the actual station nodes with tags.

  const stationNodeIds = Array.from(nodeLines.keys());
  console.log(`Fetching details for ${stationNodeIds.length} station nodes...`);

  // Batch into chunks to avoid URL length limits. Add retry for 429s.
  const BATCH_SIZE = 200;
  const allStationNodes = new Map<number, OverpassNode>();

  async function fetchBatchWithRetry(batch: number[], batchNum: number, retries = 5): Promise<void> {
    const nodeQuery = `[out:json][timeout:60];node(id:${batch.join(",")});out body;`;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const nodeRes = await fetch(OVERPASS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(nodeQuery)}`,
        });

        if (nodeRes.status === 429 || nodeRes.status === 504) {
          const wait = attempt * 10;
          console.warn(`  Batch ${batchNum}: ${nodeRes.status}, waiting ${wait}s (attempt ${attempt}/${retries})...`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }

        if (!nodeRes.ok) {
          console.warn(`  Batch ${batchNum} failed: ${nodeRes.status}`);
          return;
        }

        const nodeData = await nodeRes.json();
        for (const el of nodeData.elements) {
          if (el.type === "node") {
            allStationNodes.set(el.id, el);
          }
        }
        console.log(`  Batch ${batchNum}: got ${nodeData.elements.length} nodes`);
        return;
      } catch (err) {
        const wait = attempt * 10;
        console.warn(`  Batch ${batchNum}: network error, waiting ${wait}s (attempt ${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    console.warn(`  Batch ${batchNum}: exhausted retries`);
  }

  for (let i = 0; i < stationNodeIds.length; i += BATCH_SIZE) {
    const batch = stationNodeIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    await fetchBatchWithRetry(batch, batchNum);
    // Generous delay between batches to avoid rate limits
    if (i + BATCH_SIZE < stationNodeIds.length) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Also keep coordinate-only nodes from the skeleton output as fallback
  for (const [id, node] of nodeMap) {
    if (!allStationNodes.has(id) && nodeLines.has(id)) {
      allStationNodes.set(id, node);
    }
  }

  // Build features, deduplicating by Korean name (transfer stations merge)
  // Normalize names: strip parenthetical suffixes like 구의(광진구청) -> 구의
  function normalizeName(name: string): string {
    return name.replace(/\(.*\)$/, "").trim();
  }

  interface StationAccum {
    id: string;
    nameKo: string;
    nameEn: string;
    lat: number;
    lng: number;
    lines: Set<string>;
  }

  const byName = new Map<string, StationAccum>();

  for (const [nodeId, lines] of nodeLines) {
    const node = allStationNodes.get(nodeId);
    if (!node || !node.lat || !node.lon) continue;

    const tags = node.tags || {};
    const rawNameKo = tags["name:ko"] || tags["name"] || "";
    const nameEn = tags["name:en"] || tags["name:roman"] || "";

    if (!rawNameKo) continue;

    // Normalize: 구의(광진구청) -> 구의, to merge duplicate station nodes
    const nameKo = normalizeName(rawNameKo);

    if (byName.has(nameKo)) {
      // Merge lines for transfer stations
      const existing = byName.get(nameKo)!;
      for (const l of lines) existing.lines.add(l);
      // Prefer the English name that has more info
      if (nameEn && nameEn.length > existing.nameEn.length) {
        existing.nameEn = nameEn;
      }
    } else {
      byName.set(nameKo, {
        id: String(nodeId),
        nameKo,
        nameEn,
        lat: node.lat,
        lng: node.lon,
        lines: new Set(lines),
      });
    }
  }

  // Convert to GeoJSON
  const features = Array.from(byName.values()).map((s) => ({
    type: "Feature" as const,
    properties: {
      id: s.id,
      name_ko: s.nameKo,
      name_en: s.nameEn,
      lines: Array.from(s.lines).sort(),
    },
    geometry: {
      type: "Point" as const,
      coordinates: [s.lng, s.lat] as [number, number],
    },
  }));

  console.log(`\nProcessed ${features.length} unique stations.`);

  // Print line stats
  const lineCounts = new Map<string, number>();
  for (const f of features) {
    for (const l of f.properties.lines) {
      lineCounts.set(l, (lineCounts.get(l) || 0) + 1);
    }
  }
  console.log("Line distribution:");
  for (const [line, count] of Array.from(lineCounts).sort()) {
    console.log(`  ${line}: ${count} stations`);
  }

  const geojson = { type: "FeatureCollection" as const, features };

  const outDir = join(import.meta.dirname, "..", "public", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "stations.geojson");
  writeFileSync(outPath, JSON.stringify(geojson, null, 2));
  console.log(`\nWritten to ${outPath}`);

  // ── Build line geometries ──
  console.log("\nBuilding line geometries...");

  const lineFeatures: Array<{
    type: "Feature";
    properties: { lineId: string };
    geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
  }> = [];

  for (const [lineId, wayNodeArrays] of lineWays) {
    // Convert each way's node IDs to [lng, lat] coordinates
    const segments: [number, number][][] = [];
    const seenSegments = new Set<string>();

    for (const nodeIds of wayNodeArrays) {
      const coords: [number, number][] = [];
      for (const nid of nodeIds) {
        const node = nodeMap.get(nid);
        if (node) {
          coords.push([node.lon, node.lat]);
        }
      }
      if (coords.length >= 2) {
        // Deduplicate segments (many route variants share the same ways)
        const key = `${nodeIds[0]}-${nodeIds[nodeIds.length - 1]}`;
        if (!seenSegments.has(key)) {
          seenSegments.add(key);
          segments.push(coords);
        }
      }
    }

    if (segments.length > 0) {
      lineFeatures.push({
        type: "Feature",
        properties: { lineId },
        geometry: {
          type: "MultiLineString",
          coordinates: segments,
        },
      });
      console.log(`  ${lineId}: ${segments.length} segments`);
    }
  }

  const linesGeojson = { type: "FeatureCollection" as const, features: lineFeatures };
  const linesPath = join(outDir, "lines.geojson");
  writeFileSync(linesPath, JSON.stringify(linesGeojson));
  console.log(`Written line geometries to ${linesPath}`);

  // Generate TypeScript station array
  const tsStations = features.map((f) => ({
    id: f.properties.id,
    name: f.properties.name_en || f.properties.name_ko,
    nameKo: f.properties.name_ko,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    lines: f.properties.lines,
  }));

  const tsContent = `// Auto-generated by scripts/fetchStations.ts — do not edit manually
import type { Station } from "../types";

export const STATIONS: Station[] = ${JSON.stringify(tsStations, null, 2)} as Station[];
`;

  const tsPath = join(import.meta.dirname, "..", "src", "data", "stations.ts");
  writeFileSync(tsPath, tsContent);
  console.log(`Written TypeScript stations to ${tsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
