import { useEffect, useRef, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useMapStore } from "../store/useMapStore";
import { LINE_COLORS, LINE_NAMES, ISOCHRONE_COLORS, ISOCHRONE_STROKES, ISOCHRONE_INTERVALS } from "../constants/lines";
import { loadIsochrone } from "../services/isochroneLoader";
import type { LineId, IsochroneCollection } from "../types";

// ─── Canvas helpers (unchanged) ─────────────────────────────────────────────

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function createStationImage(lines: string[]): ImageData {
  const dotR = 4;

  if (lines.length <= 1) {
    const border = 1.5;
    const size = Math.ceil((dotR + border) * 2) + 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const c = size / 2;
    ctx.beginPath();
    ctx.arc(c, c, dotR + border, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, dotR, 0, Math.PI * 2);
    ctx.fillStyle = LINE_COLORS[lines[0] as LineId] ?? "#888";
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  }

  const n = lines.length;
  const gap = 2;
  const padX = 5;
  const padY = 3.5;
  const borderW = 1.5;
  const dotsWidth = n * dotR * 2 + (n - 1) * gap;
  const pillW = dotsWidth + padX * 2;
  const pillH = dotR * 2 + padY * 2;
  const cornerR = pillH / 2;
  const width = Math.ceil(pillW + borderW * 2) + 2;
  const height = Math.ceil(pillH + borderW * 2) + 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const ox = (width - pillW) / 2;
  const oy = (height - pillH) / 2;

  drawPill(ctx, ox - borderW, oy - borderW, pillW + borderW * 2, pillH + borderW * 2, cornerR + borderW);
  ctx.fillStyle = "#c8c8c8";
  ctx.fill();
  drawPill(ctx, ox, oy, pillW, pillH, cornerR);
  ctx.fillStyle = "#fff";
  ctx.fill();

  const cy = height / 2;
  lines.forEach((line, i) => {
    const cx = ox + padX + dotR + i * (dotR * 2 + gap);
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = LINE_COLORS[line as LineId] ?? "#888";
    ctx.fill();
  });

  return ctx.getImageData(0, 0, width, height);
}

// ─── Map config ─────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "DEMO_KEY";
const STYLE_LIGHT = `https://api.maptiler.com/maps/dataviz/style.json?key=${MAPTILER_KEY}`;
const STYLE_DARK  = `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`;

function getStyleUrl() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? STYLE_DARK : STYLE_LIGHT;
}

const SEOUL_CENTER: [number, number] = [126.978, 37.5665];
const INITIAL_ZOOM = 12.5;
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// ─── Declarative map-property update functions ──────────────────────────────
// These only set properties on existing sources/layers. They never add/remove.
// If the source/layer doesn't exist yet, they're no-ops. Safe to call anytime.

function applyIsochroneData(map: maplibregl.Map, isochrones: IsochroneCollection | null) {
  const src = map.getSource("isochrones") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  src.setData(isochrones ?? EMPTY_FC);
}

function applyIntervalVisibility(map: maplibregl.Map, intervals: number[]) {
  ISOCHRONE_INTERVALS.forEach((interval, i) => {
    const vis = intervals.includes(interval) ? "visible" : "none";
    if (map.getLayer(`isochrone-fill-${i}`)) map.setLayoutProperty(`isochrone-fill-${i}`, "visibility", vis);
    if (map.getLayer(`isochrone-line-${i}`)) map.setLayoutProperty(`isochrone-line-${i}`, "visibility", vis);
  });
}

function applyDimming(map: maplibregl.Map, hasIso: boolean) {
  if (map.getLayer("station-icons"))
    map.setPaintProperty("station-icons", "icon-opacity", hasIso ? 0.3 : 1);
  if (map.getLayer("station-labels"))
    map.setLayoutProperty("station-labels", "visibility", hasIso ? "none" : "visible");
  if (map.getLayer("subway-lines-inner"))
    map.setPaintProperty("subway-lines-inner", "line-opacity", hasIso ? 0.3 : 1);
  if (map.getLayer("subway-lines-casing"))
    map.setPaintProperty("subway-lines-casing", "line-opacity", hasIso ? 0.2 : 0.7);
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const setupLayersRef = useRef<(() => void) | null>(null);

  const stations = useMapStore((s) => s.stations);
  const enabledLines = useMapStore((s) => s.enabledLines);
  const selectedStation = useMapStore((s) => s.selectedStation);
  const isochrones = useMapStore((s) => s.isochrones);
  const intervals = useMapStore((s) => s.intervals);
  const isochronesLoading = useMapStore((s) => s.isochronesLoading);
  const selectStation = useMapStore((s) => s.selectStation);
  const setIsochrones = useMapStore((s) => s.setIsochrones);
  const setIsochronesLoading = useMapStore((s) => s.setIsochronesLoading);

  // ── 1. Init map ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: getStyleUrl(),
      center: SEOUL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 9,
      maxZoom: 17,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onThemeChange = () => {
      map.setStyle(getStyleUrl());
      map.once("styledata", () => {
        if (setupLayersRef.current) setupLayersRef.current();
      });
    };
    mq.addEventListener("change", onThemeChange);

    return () => {
      mq.removeEventListener("change", onThemeChange);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── 2. Create all sources + layers once (stations + isochrones) ───────────
  //    Isochrone layers are created with empty data. Updates go through setData().
  //    Layer order (bottom→top): isochrones → subway-lines → station-icons → labels
  useEffect(() => {
    const map = mapRef.current;
    if (!map || stations.length === 0) return;

    const handler = async () => {
      // ── Cleanup all our layers/sources (needed for style-change re-init) ──
      const layerIds = [
        ...ISOCHRONE_INTERVALS.flatMap((_, i) => [`isochrone-fill-${i}`, `isochrone-line-${i}`]),
        "subway-lines-casing", "subway-lines-inner", "station-hit-area", "station-icons", "station-labels",
      ];
      layerIds.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      ["isochrones", "subway-lines", "stations"].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });

      // ── Isochrone source + layers (empty, bottom of our stack) ──
      map.addSource("isochrones", { type: "geojson", data: EMPTY_FC });
      [...ISOCHRONE_INTERVALS].reverse().forEach((interval) => {
        const i = ISOCHRONE_INTERVALS.indexOf(interval);
        map.addLayer({
          id: `isochrone-fill-${i}`,
          type: "fill",
          source: "isochrones",
          filter: ["==", ["get", "interval"], interval],
          paint: { "fill-color": ISOCHRONE_COLORS[i] },
        });
        map.addLayer({
          id: `isochrone-line-${i}`,
          type: "line",
          source: "isochrones",
          filter: ["==", ["get", "interval"], interval],
          paint: { "line-color": ISOCHRONE_STROKES[i], "line-width": 1.5 },
        });
      });

      // ── Subway line routes (on top of isochrones) ──
      try {
        const linesRes = await fetch(`${import.meta.env.BASE_URL}data/lines.geojson`);
        if (linesRes.ok) {
          const linesData = await linesRes.json();
          map.addSource("subway-lines", { type: "geojson", data: linesData });

          const lineColorExpr = [
            "match", ["get", "lineId"],
            ...Object.entries(LINE_COLORS).flat(),
            "#888",
          ] as unknown as maplibregl.ExpressionSpecification;

          map.addLayer({
            id: "subway-lines-casing",
            type: "line",
            source: "subway-lines",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": "#fff",
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 4, 17, 6],
              "line-opacity": 0.7,
            },
          });
          map.addLayer({
            id: "subway-lines-inner",
            type: "line",
            source: "subway-lines",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": lineColorExpr,
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2, 17, 3.5],
              "line-opacity": 1,
            },
          });
        }
      } catch {
        console.warn("Could not load subway line geometries");
      }

      // ── Station dots + labels (on top of everything) ──
      const uniqueCombos = new Set(stations.map((s) => [...s.lines].sort().join(",")));
      uniqueCombos.forEach((combo) => {
        const key = `station-${combo}`;
        if (!map.hasImage(key)) {
          map.addImage(key, createStationImage(combo.split(",")));
        }
      });

      map.addSource("stations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: stations.map((s) => ({
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
            properties: {
              id: s.id,
              name: s.name,
              nameKo: s.nameKo,
              lines: s.lines.join(","),
              linesSorted: [...s.lines].sort().join(","),
            },
          })),
        },
      });

      map.addLayer({
        id: "station-icons",
        type: "symbol",
        source: "stations",
        layout: {
          "icon-image": ["concat", "station-", ["get", "linesSorted"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 13, 0.8, 17, 1.0],
          "icon-anchor": "center",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": 1 },
      });

      // Invisible wider hit-area circle layer to make stations easier to click
      map.addLayer({
        id: "station-hit-area",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 16, 17, 22],
          "circle-opacity": 0,
          "circle-stroke-opacity": 0,
        },
      }, "station-icons");

      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      map.addLayer({
        id: "station-labels",
        type: "symbol",
        source: "stations",
        minzoom: 12,
        layout: {
          "text-field": ["step", ["zoom"], ["get", "nameKo"], 14, ["format", ["get", "nameKo"], {}, "\n", {}, ["get", "name"], { "text-font": ["literal", ["Noto Sans Regular"]], "font-scale": 0.85 }]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 14, 13, 17, 15],
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-max-width": 8,
        },
        paint: {
          "text-color": isDark ? "#e0e0f0" : "#0f0f1a",
          "text-halo-color": isDark ? "#18181e" : "#ffffff",
          "text-halo-width": 2,
        },
      });

      const handleStationClick = (e: maplibregl.MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature || !feature.properties) return;
        const station = stations.find((s) => s.id === feature.properties!.id);
        if (station) selectStation(station);
      };
      const setCursorPointer = () => { map.getCanvas().style.cursor = "pointer"; };
      const setCursorDefault = () => { map.getCanvas().style.cursor = ""; };

      map.on("click", "station-hit-area", handleStationClick);
      map.on("click", "station-icons", handleStationClick);
      map.on("mouseenter", "station-hit-area", setCursorPointer);
      map.on("mouseleave", "station-hit-area", setCursorDefault);
      map.on("mouseenter", "station-icons", setCursorPointer);
      map.on("mouseleave", "station-icons", setCursorDefault);

      // ── Apply current state to freshly-created layers ──
      const state = useMapStore.getState();
      applyIsochroneData(map, state.isochrones);
      applyIntervalVisibility(map, state.intervals);
      applyDimming(map, state.isochrones != null && state.isochrones.features.length > 0);
    };

    setupLayersRef.current = handler;

    if (map.isStyleLoaded()) {
      handler();
    } else {
      map.once("load", handler);
    }
  }, [stations, selectStation]);

  // ── 3. Sync isochrone data + dimming to map (pure property updates) ───────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyIsochroneData(map, isochrones);
    const hasIso = isochrones != null && isochrones.features.length > 0;
    applyDimming(map, hasIso);
  }, [isochrones]);

  // ── 4. Sync interval visibility (pure property update) ───────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyIntervalVisibility(map, intervals);
  }, [intervals]);

  // ── 5. Filter stations by enabled lines ──────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("station-icons")) return;

    const lineArr = Array.from(enabledLines);
    const stationFilter: maplibregl.FilterSpecification = [
      "any",
      ...lineArr.map(
        (line) => ["in", line, ["get", "lines"]] as maplibregl.ExpressionSpecification
      ),
    ];
    map.setFilter("station-hit-area", stationFilter);
    map.setFilter("station-icons", stationFilter);
    map.setFilter("station-labels", stationFilter);

    if (map.getLayer("subway-lines-casing")) {
      const lineFilter: maplibregl.FilterSpecification = [
        "in", ["get", "lineId"], ["literal", lineArr],
      ];
      map.setFilter("subway-lines-casing", lineFilter);
      map.setFilter("subway-lines-inner", lineFilter);
    }
  }, [enabledLines]);

  // ── 6. Pulse marker on selected station ──────────────────────────────────
  const createPulseEl = useCallback((lines: string[]) => {
    const el = document.createElement("div");
    el.className = "station-pulse-marker";
    const primaryColor = LINE_COLORS[lines[0] as LineId] ?? "#333";

    if (lines.length <= 1) {
      el.style.cssText = `width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center;`;
      const ring = document.createElement("div");
      ring.style.cssText = `position:absolute;width:20px;height:20px;border-radius:50%;border:2.5px solid ${primaryColor};animation:pulse-ring 1.6s ease-out infinite;opacity:0;`;
      const dot = document.createElement("div");
      dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${primaryColor};border:2px solid #fff;box-shadow:0 0 0 2px ${primaryColor};`;
      el.appendChild(ring);
      el.appendChild(dot);
    } else {
      el.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;";
      const pill = document.createElement("div");
      pill.style.cssText = `display:flex;align-items:center;gap:3px;padding:4px 7px;background:#fff;border-radius:999px;border:1.5px solid #c8c8c8;box-shadow:0 1px 4px rgba(0,0,0,0.25);animation:pulse-pill 1.6s ease-out infinite;`;
      lines.forEach((line) => {
        const dot = document.createElement("div");
        dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${LINE_COLORS[line as LineId] ?? "#888"};flex-shrink:0;`;
        pill.appendChild(dot);
      });
      el.appendChild(pill);
    }
    return el;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }

    if (selectedStation) {
      map.flyTo({ center: [selectedStation.lng, selectedStation.lat], zoom: 12, duration: 800 });
      const el = createPulseEl([...selectedStation.lines]);
      markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([selectedStation.lng, selectedStation.lat])
        .addTo(map);
    }
  }, [selectedStation, createPulseEl]);

  // ── 7. Load isochrone data when station changes ──────────────────────────
  useEffect(() => {
    if (!selectedStation) {
      setIsochrones(null);
      return;
    }
    let stale = false;
    setIsochronesLoading(true);

    const attempt = async (retries: number): Promise<void> => {
      const data = await loadIsochrone(selectedStation.id);
      if (stale) return;
      if (data) {
        setIsochrones(data);
      } else if (retries > 0) {
        await new Promise((r) => setTimeout(r, 500));
        if (!stale) await attempt(retries - 1);
      } else {
        setIsochrones(null);
      }
    };

    attempt(2);
    return () => { stale = true; };
  }, [selectedStation]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="map-wrapper">
      <div ref={mapContainer} className="map-container" />
      {selectedStation && (
        <div className="station-chip" key={selectedStation.id}>
          <div className="station-chip-names">
            <span className="station-chip-ko">{selectedStation.nameKo}</span>
            {selectedStation.name !== selectedStation.nameKo && (
              <span className="station-chip-en">{selectedStation.name}</span>
            )}
          </div>
          <div className="station-chip-lines">
            {selectedStation.lines.map((l) => (
              <span key={l} className="line-badge" style={{ backgroundColor: LINE_COLORS[l] }}>
                {LINE_NAMES[l]}
              </span>
            ))}
          </div>
          {isochronesLoading && <span className="chip-spinner" />}
          <button className="station-chip-close" onClick={() => selectStation(null)}>✕</button>
        </div>
      )}
      <div className="map-legend">
        <div className="map-legend-title">Fig. 1 — Isochrone Zones</div>
        {ISOCHRONE_INTERVALS.map((min, i) => (
          <div key={min} className="legend-row">
            <span
              className="legend-swatch"
              style={{ background: ISOCHRONE_COLORS[i], border: `1.5px solid ${ISOCHRONE_STROKES[i]}` }}
            />
            <span>≤ {min} min</span>
          </div>
        ))}
      </div>
    </div>
  );
}
