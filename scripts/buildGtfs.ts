/**
 * buildGtfs.ts
 *
 * Fetches Seoul Metro timetable data from the Seoul Open Data Plaza API
 * and converts it into a standard GTFS zip file.
 *
 * Prerequisites:
 *   - SEOUL_DATA_API_KEY env var (free key from data.seoul.go.kr)
 *   - public/data/stations.geojson (run fetchStations.ts first)
 *
 * Run: npx tsx scripts/buildGtfs.ts
 * Output: docker/gtfs/seoul-metro.gtfs.zip
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const API_KEY = process.env.SEOUL_DATA_API_KEY;
if (!API_KEY) {
  console.error("Missing SEOUL_DATA_API_KEY env var.");
  console.error("Get a free key at: https://data.seoul.go.kr/");
  process.exit(1);
}

const ROOT = join(import.meta.dirname, "..");
const STATIONS_PATH = join(ROOT, "public", "data", "stations.geojson");
const OUT_DIR = join(ROOT, "docker", "gtfs");

// Seoul Open Data API for subway timetables
// API endpoint: http://openapi.seoul.go.kr:8088/{KEY}/json/SearchSTNTimeTableByFRCodeService/{start}/{end}/{station_code}/{week_type}/{direction}
const API_BASE = "http://openapi.seoul.go.kr:8088";

interface StationGeoJSON {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { id: string; name_ko: string; name_en: string; lines: string[] };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

interface TimetableEntry {
  STATION_CD: string;
  STATION_NM: string;
  LINE_NUM: string;
  ARRIVETIME: string; // HH:MM:SS
  LEFTTIME: string;   // HH:MM:SS
  TRAIN_NO: string;
  SUBWAYSNAME: string;
  SUBWAYENAME: string;
  FL_FLAG: string;     // "1" = up, "2" = down
  WEEK_TAG: string;    // "1" = weekday, "2" = saturday, "3" = sunday
  INOUT_TAG: string;   // "1" = up, "2" = down
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function fetchTimetable(stationCode: string, weekType: string, direction: string): Promise<TimetableEntry[]> {
  const url = `${API_BASE}/${API_KEY}/json/SearchSTNTimeTableByFRCodeService/1/500/${stationCode}/${weekType}/${direction}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.SearchSTNTimeTableByFRCodeService?.row || [];
  } catch {
    return [];
  }
}

async function main() {
  console.log("Building GTFS from Seoul Open Data API...");

  mkdirSync(OUT_DIR, { recursive: true });

  // Read stations
  let stations: StationGeoJSON;
  try {
    stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"));
  } catch {
    console.error(`Cannot read ${STATIONS_PATH}. Run fetchStations.ts first.`);
    process.exit(1);
  }

  // ── agency.txt ──
  const agencyTxt = [
    "agency_id,agency_name,agency_url,agency_timezone,agency_lang",
    "SM,Seoul Metro,https://www.seoulmetro.co.kr,Asia/Seoul,ko",
    "SM9,Seoul Metro Line 9 Corp,https://www.metro9.co.kr,Asia/Seoul,ko",
  ].join("\n");

  // ── calendar.txt ──
  const calendarTxt = [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "weekday,1,1,1,1,1,0,0,20240101,20261231",
    "saturday,0,0,0,0,0,1,0,20240101,20261231",
    "sunday,0,0,0,0,0,0,1,20240101,20261231",
  ].join("\n");

  // ── routes.txt ──
  const lineRoutes = [
    { id: "1", short: "1", long: "Line 1", color: "0052A4", agency: "SM" },
    { id: "2", short: "2", long: "Line 2", color: "00A84D", agency: "SM" },
    { id: "3", short: "3", long: "Line 3", color: "EF7C1C", agency: "SM" },
    { id: "4", short: "4", long: "Line 4", color: "00A5DE", agency: "SM" },
    { id: "5", short: "5", long: "Line 5", color: "996CAC", agency: "SM" },
    { id: "6", short: "6", long: "Line 6", color: "CD7C2F", agency: "SM" },
    { id: "7", short: "7", long: "Line 7", color: "747F00", agency: "SM" },
    { id: "8", short: "8", long: "Line 8", color: "E6186C", agency: "SM" },
    { id: "9", short: "9", long: "Line 9", color: "BDB092", agency: "SM9" },
  ];

  const routesTxt = [
    "route_id,agency_id,route_short_name,route_long_name,route_type,route_color",
    ...lineRoutes.map((r) => `${r.id},${r.agency},${r.short},${r.long},1,${r.color}`),
  ].join("\n");

  // ── stops.txt ──
  const stopsTxt = [
    "stop_id,stop_name,stop_lat,stop_lon",
    ...stations.features.map((f) => {
      const { id, name_ko } = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      return `${id},${name_ko},${lat},${lon}`;
    }),
  ].join("\n");

  // ── trips.txt + stop_times.txt ──
  // For MVP, we generate a placeholder structure.
  // A full implementation would iterate over all station codes,
  // fetch timetables for each weekday/weekend and direction,
  // and assemble trips + stop_times.

  console.log("Fetching sample timetable data to validate API access...");

  // Test with one station to validate API key works
  const testEntries = await fetchTimetable("0222", "1", "1"); // Gangnam, weekday, up
  if (testEntries.length > 0) {
    console.log(`API working. Got ${testEntries.length} timetable entries for Gangnam (weekday, up).`);
    console.log(`Sample entry:`, JSON.stringify(testEntries[0], null, 2));
  } else {
    console.warn("Warning: No timetable data returned. Check your API key.");
  }

  // For now, write the static GTFS files we can generate.
  // The full trip/stop_times generation requires iterating all stations
  // and is a longer-running process (~10 min for all stations).

  const tripsTxt = "trip_id,route_id,service_id,direction_id\n";
  const stopTimesTxt = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";

  // Write individual files first (will zip in a production build)
  const files: Record<string, string> = {
    "agency.txt": agencyTxt,
    "calendar.txt": calendarTxt,
    "routes.txt": routesTxt,
    "stops.txt": stopsTxt,
    "trips.txt": tripsTxt,
    "stop_times.txt": stopTimesTxt,
  };

  const gtfsDir = join(OUT_DIR, "seoul-metro-gtfs");
  mkdirSync(gtfsDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(gtfsDir, filename), content);
    console.log(`  Written ${filename}`);
  }

  console.log(`\nGTFS files written to ${gtfsDir}/`);
  console.log("Note: trips.txt and stop_times.txt are empty stubs.");
  console.log("Full implementation requires fetching timetables for all ~280 stations.");
  console.log("This will be completed in the next iteration.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
