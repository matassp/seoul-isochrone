import { create } from "zustand";
import type { LineId, Station, IsochroneCollection } from "../types";
import { ISOCHRONE_INTERVALS } from "../constants/lines";

interface MapState {
  stations: Station[];
  selectedStation: Station | null;
  intervals: number[];
  enabledLines: Set<LineId>;
  isochrones: IsochroneCollection | null;
  isochronesLoading: boolean;
  sidebarOpen: boolean;
  statsPanelOpen: boolean;

  setStations: (stations: Station[]) => void;
  selectStation: (station: Station | null) => void;
  setIntervals: (intervals: number[]) => void;
  toggleLine: (line: LineId) => void;
  setIsochrones: (iso: IsochroneCollection | null) => void;
  setIsochronesLoading: (loading: boolean) => void;
  toggleSidebar: () => void;
  toggleStatsPanel: () => void;
}

const ALL_LINES = new Set<LineId>([
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "gyeongui", "airport", "bundang", "shinbundang",
]);

export const useMapStore = create<MapState>((set) => ({
  stations: [],
  selectedStation: null,
  intervals: ISOCHRONE_INTERVALS,
  enabledLines: new Set(ALL_LINES),
  isochrones: null,
  isochronesLoading: false,
  sidebarOpen: true,
  statsPanelOpen: false,

  setStations: (stations) => set({ stations }),
  // Spread to ensure a new reference on every call so [selectedStation] effects always re-run,
  // even when the same station is re-selected (e.g. clicking it again after it was already active).
  selectStation: (station) => set({ selectedStation: station ? { ...station } : null, isochrones: null }),
  setIntervals: (intervals) => set({ intervals }),
  toggleLine: (line) =>
    set((state) => {
      const next = new Set(state.enabledLines);
      if (next.has(line)) {
        next.delete(line);
      } else {
        next.add(line);
      }
      return { enabledLines: next };
    }),
  setIsochrones: (iso) => set({ isochrones: iso, isochronesLoading: false }),
  setIsochronesLoading: (loading) => set({ isochronesLoading: loading }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleStatsPanel: () => set((state) => ({ statsPanelOpen: !state.statsPanelOpen })),
}));
