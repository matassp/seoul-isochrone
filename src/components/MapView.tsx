import { useEffect, useRef, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useMapStore } from "../store/useMapStore";
import { LINE_COLORS, ISOCHRONE_COLORS, ISOCHRONE_STROKES, ISOCHRONE_INTERVALS } from "../constants/lines";
import { loadIsochrone } from "../services/isochroneLoader";
import type { LineId } from "../types";

/**
 * Draw a pill / rounded-rect path on a canvas context.
 */
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

/**
 * Generate a canvas ImageData for a station marker.
 * Single-line  → solid colored circle with white border.
 * Multi-line   → colored dots inside a rounded pill (like Naver Maps transfer markers).
 */
function createStationImage(lines: string[]): ImageData {
  const dotR = 4;           // radius of each colored dot

  if (lines.length <= 1) {
    // Single dot with white border
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

  // Multi-line: pill capsule containing colored dots
  const n = lines.length;
  const gap = 2;              // space between dots
  const padX = 5;             // horizontal padding inside pill
  const padY = 3.5;           // vertical padding inside pill
  const borderW = 1.5;        // pill outline thickness

  const dotsWidth = n * dotR * 2 + (n - 1) * gap;
  const pillW = dotsWidth + padX * 2;
  const pillH = dotR * 2 + padY * 2;
  const cornerR = pillH / 2;  // fully rounded ends

  const width = Math.ceil(pillW + borderW * 2) + 2;
  const height = Math.ceil(pillH + borderW * 2) + 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const ox = (width - pillW) / 2;
  const oy = (height - pillH) / 2;

  // Pill border
  drawPill(ctx, ox - borderW, oy - borderW, pillW + borderW * 2, pillH + borderW * 2, cornerR + borderW);
  ctx.fillStyle = "#c8c8c8";
  ctx.fill();

  // Pill fill
  drawPill(ctx, ox, oy, pillW, pillH, cornerR);
  ctx.fillStyle = "#fff";
  ctx.fill();

  // Colored dots
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

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "DEMO_KEY";
const STYLE_LIGHT = `https://api.maptiler.com/maps/dataviz/style.json?key=${MAPTILER_KEY}`;
const STYLE_DARK  = `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`;

function getStyleUrl() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? STYLE_DARK : STYLE_LIGHT;
}

const SEOUL_CENTER: [number, number] = [126.978, 37.5665];
const INITIAL_ZOOM = 11;

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // Stores the layer-setup function so it can be re-called after a style change
  const setupLayersRef = useRef<(() => void) | null>(null);
  const stations = useMapStore((s) => s.stations);
  const enabledLines = useMapStore((s) => s.enabledLines);
  const selectedStation = useMapStore((s) => s.selectedStation);
  const isochrones = useMapStore((s) => s.isochrones);
  const intervals = useMapStore((s) => s.intervals);
  const selectStation = useMapStore((s) => s.selectStation);
  const setIsochrones = useMapStore((s) => s.setIsochrones);
  const setIsochronesLoading = useMapStore((s) => s.setIsochronesLoading);

  // Init map
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

    // Switch map style when OS theme changes; re-add layers after style reloads
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

  // Add station source + layers once map + stations are ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || stations.length === 0) return;

    const handler = async () => {
      // Remove existing sources/layers before re-adding (needed after style change)
      ["subway-lines-casing", "subway-lines-inner", "station-icons", "station-labels"].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource("subway-lines")) map.removeSource("subway-lines");
      if (map.getSource("stations")) map.removeSource("stations");

      // ── Subway line routes ──
      try {
        const linesRes = await fetch("/data/lines.geojson");
        if (linesRes.ok) {
          const linesData = await linesRes.json();
          map.addSource("subway-lines", { type: "geojson", data: linesData });

          const lineColorEntries = Object.entries(LINE_COLORS).flat();
          const lineColorExpr = [
            "match",
            ["get", "lineId"],
            ...lineColorEntries,
            "#888",
          ] as unknown as maplibregl.ExpressionSpecification;

          // White casing for legibility on the basemap
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
              "line-color": lineColorExpr as maplibregl.ExpressionSpecification,
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2, 17, 3.5],
              "line-opacity": 1,
            },
          });
        }
      } catch {
        console.warn("Could not load subway line geometries");
      }

      // ── Station points ──
      // Pre-generate and register a canvas image for every unique line-combo
      const uniqueCombos = new Set(stations.map((s) => [...s.lines].sort().join(",")));
      uniqueCombos.forEach((combo) => {
        const key = `station-${combo}`;
        if (!map.hasImage(key)) {
          const imgData = createStationImage(combo.split(","));
          map.addImage(key, imgData);
        }
      });

      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: stations.map((s) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lng, s.lat] },
          properties: {
            id: s.id,
            name: s.name,
            nameKo: s.nameKo,
            lines: s.lines.join(","),
            linesSorted: [...s.lines].sort().join(","),
          },
        })),
      };

      map.addSource("stations", { type: "geojson", data: geojson });

      // Station icons — canvas sprite per line combo
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
        paint: {
          "icon-opacity": 1,
        },
      });

      // Station labels (visible at higher zoom)
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      map.addLayer({
        id: "station-labels",
        type: "symbol",
        source: "stations",
        minzoom: 14,
        layout: {
          "text-field": ["get", "nameKo"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
        },
        paint: {
          "text-color": isDark ? "#c8c8d8" : "#1a1a2e",
          "text-halo-color": isDark ? "#1a1a24" : "#fff",
          "text-halo-width": 1.5,
        },
      });

      // Click handler
      map.on("click", "station-icons", (e) => {
        const feature = e.features?.[0];
        if (!feature || !feature.properties) return;
        const id = feature.properties.id;
        const station = stations.find((s) => s.id === id);
        if (station) selectStation(station);
      });

      map.on("mouseenter", "station-icons", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "station-icons", () => {
        map.getCanvas().style.cursor = "";
      });
    };

    // Register for re-use after style changes
    setupLayersRef.current = handler;

    if (map.isStyleLoaded()) {
      handler();
    } else {
      map.on("load", handler);
    }
  }, [stations, selectStation]);

  // Filter stations and lines by enabled lines
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("station-icons")) return;

    const lineArr = Array.from(enabledLines);

    // Show station if any of its lines are enabled
    const stationFilter: maplibregl.FilterSpecification = [
      "any",
      ...lineArr.map(
        (line) =>
          ["in", line, ["get", "lines"]] as maplibregl.ExpressionSpecification
      ),
    ];
    map.setFilter("station-icons", stationFilter);
    map.setFilter("station-labels", stationFilter);

    if (map.getLayer("subway-lines-casing")) {
      const lineFilter: maplibregl.FilterSpecification = [
        "in",
        ["get", "lineId"],
        ["literal", lineArr],
      ];
      map.setFilter("subway-lines-casing", lineFilter);
      map.setFilter("subway-lines-inner", lineFilter);
    }
  }, [enabledLines]);

  // Pulse marker element factory
  const createPulseEl = useCallback((color: string) => {
    const el = document.createElement("div");
    el.className = "station-pulse-marker";
    el.style.cssText = `
      width: 20px; height: 20px; position: relative;
      display: flex; align-items: center; justify-content: center;
    `;
    const ring = document.createElement("div");
    ring.style.cssText = `
      position: absolute; width: 20px; height: 20px; border-radius: 50%;
      border: 2.5px solid ${color}; animation: pulse-ring 1.6s ease-out infinite;
      opacity: 0;
    `;
    const dot = document.createElement("div");
    dot.style.cssText = `
      width: 10px; height: 10px; border-radius: 50%;
      background: ${color}; border: 2px solid #fff;
      box-shadow: 0 0 0 2px ${color};
    `;
    el.appendChild(ring);
    el.appendChild(dot);
    return el;
  }, []);

  // Highlight selected station
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove old marker
    if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }

    if (selectedStation) {
      map.flyTo({ center: [selectedStation.lng, selectedStation.lat], zoom: 14, duration: 800 });
      const color = LINE_COLORS[selectedStation.lines[0] as keyof typeof LINE_COLORS] ?? "#333";
      const el = createPulseEl(color);
      markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([selectedStation.lng, selectedStation.lat])
        .addTo(map);
    }
  }, [selectedStation, createPulseEl]);

  // Load isochrones when selected station changes
  useEffect(() => {
    if (!selectedStation) {
      setIsochrones(null);
      return;
    }
    setIsochronesLoading(true);
    loadIsochrone(selectedStation.id).then(setIsochrones);
  }, [selectedStation]);

  // Rebuild isochrone source + layers when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    // Remove existing isochrone layers and source
    for (let i = 0; i < ISOCHRONE_INTERVALS.length; i++) {
      if (map.getLayer(`isochrone-fill-${i}`)) map.removeLayer(`isochrone-fill-${i}`);
      if (map.getLayer(`isochrone-line-${i}`)) map.removeLayer(`isochrone-line-${i}`);
    }
    if (map.getSource("isochrones")) map.removeSource("isochrones");

    if (!isochrones || isochrones.features.length === 0) return;

    map.addSource("isochrones", { type: "geojson", data: isochrones });

    // Add layers largest-first so smaller rings render on top
    const sorted = [...ISOCHRONE_INTERVALS].reverse();
    sorted.forEach((interval) => {
      const colorIdx = ISOCHRONE_INTERVALS.indexOf(interval);
      const visible = intervals.includes(interval);
      const beforeId = map.getLayer("subway-lines-casing") ? "subway-lines-casing" : "station-icons";

      map.addLayer(
        {
          id: `isochrone-fill-${colorIdx}`,
          type: "fill",
          source: "isochrones",
          filter: ["==", ["get", "interval"], interval],
          layout: { visibility: visible ? "visible" : "none" },
          paint: { "fill-color": ISOCHRONE_COLORS[colorIdx] },
        },
        beforeId
      );
      map.addLayer(
        {
          id: `isochrone-line-${colorIdx}`,
          type: "line",
          source: "isochrones",
          filter: ["==", ["get", "interval"], interval],
          layout: { visibility: visible ? "visible" : "none" },
          paint: { "line-color": ISOCHRONE_STROKES[colorIdx], "line-width": 1.5 },
        },
        beforeId
      );
    });
  }, [isochrones]);

  // Update layer visibility when interval toggles change (no layer rebuild)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    ISOCHRONE_INTERVALS.forEach((interval, i) => {
      const vis = intervals.includes(interval) ? "visible" : "none";
      if (map.getLayer(`isochrone-fill-${i}`)) map.setLayoutProperty(`isochrone-fill-${i}`, "visibility", vis);
      if (map.getLayer(`isochrone-line-${i}`)) map.setLayoutProperty(`isochrone-line-${i}`, "visibility", vis);
    });
  }, [intervals]);

  // Dim stations + hide labels when isochrones are showing
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const hasIso = isochrones && isochrones.features.length > 0;
    if (map.getLayer("station-icons")) {
      map.setPaintProperty("station-icons", "icon-opacity", hasIso ? 0.3 : 1);
    }
    if (map.getLayer("station-labels")) {
      map.setLayoutProperty("station-labels", "visibility", hasIso ? "none" : "visible");
    }
    if (map.getLayer("subway-lines-inner")) {
      map.setPaintProperty("subway-lines-inner", "line-opacity", hasIso ? 0.3 : 1);
    }
    if (map.getLayer("subway-lines-casing")) {
      map.setPaintProperty("subway-lines-casing", "line-opacity", hasIso ? 0.2 : 0.7);
    }
  }, [isochrones]);

  return <div ref={mapContainer} className="map-container" />;
}
