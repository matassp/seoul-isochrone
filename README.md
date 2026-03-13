# Seoul Metro Isochrone

**Where can you reach from any Seoul Metro station in 15, 30, or 60 minutes?**

An interactive map showing transit reachability across the Seoul Metro network — useful for apartment hunting, commute planning, or exploring the city.

## Features

- **516 stations** across Lines 1–9, Bundang, Shinbundang, Gyeongui-Jungang, and Airport Railroad
- **Isochrone rings** at 15, 30, and 60 minutes (subway + walking)
- **Peak / off-peak toggle** — pre-computed for 08:00 and 14:00 weekday departures
- **Line filter** — show/hide individual lines
- **Station search** — Korean (강남역) and English (Gangnam)
- Fast — isochrones are static GeoJSON served from CDN, no routing server at runtime

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | React 18 + TypeScript |
| Map | MapLibre GL JS |
| Basemap | MapTiler Dataviz |
| Routing (build-time) | GraphHopper + Seoul GTFS + South Korea OSM |
| State | Zustand |
| Build | Vite |
| Deploy | Vercel |

## Architecture

Isochrones are **pre-computed once** and shipped as static GeoJSON files. No routing server runs at runtime.

```
Build pipeline (local Docker, run once / on GTFS update)
├── GraphHopper + Seoul Metro GTFS + South Korea OSM (Geofabrik)
├── For each of 516 stations × 2 time profiles (off-peak, peak)
│   └── Query isochrone at 15 / 30 / 60 min → save GeoJSON
└── Output: public/data/isochrones/{off-peak,peak}/*.geojson

Runtime (static site, Vercel CDN)
└── User clicks station → fetch /data/isochrones/{profile}/{id}.geojson (~200ms)
```

## Local Development

### Prerequisites

- Node.js 18+, pnpm
- Docker (for building isochrones)
- [MapTiler API key](https://cloud.maptiler.com) (free tier)
- KTDB GTFS download (free, from [ktdb.go.kr](https://www.ktdb.go.kr))

### Setup

```bash
git clone https://github.com/matassp/seoul-isochrone.git
cd seoul-isochrone
pnpm install
cp .env.example .env
# Add your VITE_MAPTILER_KEY to .env
pnpm dev
```

The app will load with station dots but no isochrones (those are gitignored due to size). To regenerate isochrones, follow the build pipeline below.

### Build Pipeline

```bash
# 1. Fetch station data from OpenStreetMap
pnpm run fetch-stations

# 2. Download GTFS from ktdb.go.kr → place as docker/gtfs/seoul-metro.gtfs.zip

# 3. Start GraphHopper (ingests GTFS + OSM, takes ~5 min first run)
docker compose -f docker/docker-compose.yml up graphhopper

# 4. Compute isochrones (both profiles, ~1000 GraphHopper requests)
pnpm run compute-isochrones

# 5. Shut down Docker, run the app
docker compose -f docker/docker-compose.yml down
pnpm dev
```

The OSM extract (`south-korea-latest.osm.pbf`) must be placed in `docker/data/` before starting GraphHopper. Download from [Geofabrik](https://download.geofabrik.de/asia/south-korea.html).

## Data Sources

| Data | Source | License |
|------|--------|---------|
| Station locations | OpenStreetMap Overpass API | ODbL |
| Metro timetables | KTDB 대중교통 GTFS (`ktdb.go.kr`) | Public |
| Street network | Geofabrik South Korea OSM extract | ODbL |
| Basemap tiles | MapTiler | Commercial (free tier) |
