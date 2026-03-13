import { useEffect } from "react";
import MapView from "./components/MapView";
import Sidebar from "./components/Sidebar";
import { useMapStore } from "./store/useMapStore";
import { STATIONS } from "./data/stations";
import "./App.css";

export default function App() {
  const setStations = useMapStore((s) => s.setStations);

  useEffect(() => {
    setStations(STATIONS);
  }, [setStations]);

  return (
    <div className="app">
      <Sidebar />
      <MapView />
    </div>
  );
}
