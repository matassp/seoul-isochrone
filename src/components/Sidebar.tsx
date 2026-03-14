import { useState, useMemo, useRef } from "react";
import Fuse from "fuse.js";
import { useMapStore } from "../store/useMapStore";
import { LINE_COLORS, LINE_NAMES, ISOCHRONE_INTERVALS, ISOCHRONE_STROKES } from "../constants/lines";
import type { LineId, Station } from "../types";

export default function Sidebar() {
  const stations = useMapStore((s) => s.stations);
  const selectedStation = useMapStore((s) => s.selectedStation);
  const intervals = useMapStore((s) => s.intervals);
  const enabledLines = useMapStore((s) => s.enabledLines);
  const isochronesLoading = useMapStore((s) => s.isochronesLoading);
  const sidebarOpen = useMapStore((s) => s.sidebarOpen);
  const selectStation = useMapStore((s) => s.selectStation);
  const setIntervals = useMapStore((s) => s.setIntervals);
  const toggleLine = useMapStore((s) => s.toggleLine);
  const toggleSidebar = useMapStore((s) => s.toggleSidebar);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(
    () =>
      new Fuse(stations, {
        keys: ["name", "nameKo"],
        threshold: 0.3,
      }),
    [stations]
  );

  const results: Station[] = useMemo(() => {
    if (!query.trim()) return [];
    return fuse.search(query).slice(0, 8).map((r) => r.item);
  }, [query, fuse]);

  function handleSelectStation(station: Station) {
    selectStation(station);
    setQuery("");
    setActiveIndex(-1);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const target = activeIndex >= 0 ? results[activeIndex] : results[0];
      if (target) handleSelectStation(target);
    } else if (e.key === "Escape") {
      setQuery("");
      setActiveIndex(-1);
      inputRef.current?.blur();
    }
  }

  function toggleInterval(interval: number) {
    if (intervals.includes(interval)) {
      setIntervals(intervals.filter((i) => i !== interval));
    } else {
      setIntervals([...intervals, interval].sort((a, b) => a - b));
    }
  }

  const lineIds = Object.keys(LINE_NAMES) as LineId[];

  return (
    <>
      <button
        className="sidebar-toggle"
        onClick={toggleSidebar}
        style={{ left: sidebarOpen ? 332 : 12 }}
      >
        {sidebarOpen ? "\u2039" : "\u203A"}
      </button>
      <div className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <h1 className="sidebar-title">Seoul Isochrone</h1>

        {/* Search */}
        <div className="search-section">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search station..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(-1); }}
            onKeyDown={handleSearchKeyDown}
          />
          {results.length > 0 && (
            <ul className="search-results">
              {results.map((s, idx) => (
                <li
                  key={s.id}
                  className={idx === activeIndex ? "active" : ""}
                  onClick={() => handleSelectStation(s)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span className="result-name">{s.nameKo}</span>
                  {s.name !== s.nameKo && <span className="result-en">{s.name}</span>}
                  <span className="result-lines">
                    {s.lines.map((l) => (
                      <span
                        key={l}
                        className="line-badge"
                        style={{ backgroundColor: LINE_COLORS[l] }}
                      >
                        {LINE_NAMES[l]}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Selected station */}
        {selectedStation && (
          <div className="selected-station">
            <div className="selected-header">
              <h2>{selectedStation.nameKo}</h2>
              {selectedStation.name !== selectedStation.nameKo && (
                <span className="selected-en">{selectedStation.name}</span>
              )}
              <button className="deselect" onClick={() => selectStation(null)}>
                &times;
              </button>
            </div>
            <div className="selected-lines">
              {selectedStation.lines.map((l) => (
                <span
                  key={l}
                  className="line-badge"
                  style={{ backgroundColor: LINE_COLORS[l] }}
                >
                  {LINE_NAMES[l]}
                </span>
              ))}
            </div>
            {isochronesLoading && <div className="loading">Loading isochrones...</div>}
          </div>
        )}

        {/* Travel Time Intervals */}
        <div className="section">
          <h3>Travel Time</h3>
          <div className="interval-pills">
            {ISOCHRONE_INTERVALS.map((min, i) => (
              <button
                key={min}
                className={`interval-pill ${intervals.includes(min) ? "active" : ""}`}
                style={{
                  borderColor: ISOCHRONE_STROKES[i],
                  ...(intervals.includes(min)
                    ? { backgroundColor: ISOCHRONE_STROKES[i], color: "#fff" }
                    : {}),
                }}
                onClick={() => toggleInterval(min)}
              >
                {min}m
              </button>
            ))}
          </div>
        </div>

        {/* Line Filter */}
        <div className="section">
          <h3>Lines</h3>
          <div className="line-filters">
            {lineIds.map((id) => (
              <label key={id} className="line-filter">
                <input
                  type="checkbox"
                  checked={enabledLines.has(id)}
                  onChange={() => toggleLine(id)}
                />
                <span
                  className="line-dot"
                  style={{ backgroundColor: LINE_COLORS[id] }}
                />
                {LINE_NAMES[id]}
              </label>
            ))}
          </div>
        </div>

      </div>
    </>
  );
}
