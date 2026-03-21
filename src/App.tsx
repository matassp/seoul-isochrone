import { useEffect, useState } from "react";
import MapView from "./components/MapView";
import Sidebar from "./components/Sidebar";
import StatsPanel from "./components/StatsPanel";
import { useMapStore } from "./store/useMapStore";
import { STATIONS } from "./data/stations";
import { NAME_OVERRIDES } from "./data/nameOverrides";
import "./App.css";

const PATCHED_STATIONS = STATIONS.map((s) =>
  NAME_OVERRIDES[s.id] ? { ...s, name: NAME_OVERRIDES[s.id] } : s
);

// Read once at module load — before any renders or effects
const INITIAL_URL_STATION_ID = new URLSearchParams(window.location.search).get("s");

export default function App() {
  const setStations = useMapStore((s) => s.setStations);
  const stations = useMapStore((s) => s.stations);
  const selectedStation = useMapStore((s) => s.selectedStation);
  const selectStation = useMapStore((s) => s.selectStation);
  const sidebarOpen = useMapStore((s) => s.sidebarOpen);

  // Starts false when there is a station ID in the URL (restore must happen first)
  const [urlRestored, setUrlRestored] = useState(!INITIAL_URL_STATION_ID);

  useEffect(() => {
    setStations(PATCHED_STATIONS);
  }, [setStations]);

  // Restore selected station from URL (or default to City Hall), then mark restore as done
  useEffect(() => {
    if (stations.length === 0) return;
    const targetId = INITIAL_URL_STATION_ID ?? "1797562528"; // City Hall (시청)
    const station = stations.find((s) => s.id === targetId);
    if (station) selectStation(station);
    setUrlRestored(true);
  }, [stations]);

  // Sync selected station to URL — only after initial restore is settled
  useEffect(() => {
    if (!urlRestored) return;
    const params = new URLSearchParams(window.location.search);
    if (selectedStation) {
      params.set("s", selectedStation.id);
    } else {
      params.delete("s");
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [selectedStation, urlRestored]);

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <Sidebar />
      <MapView />
      <StatsPanel />
    </div>
  );
}
