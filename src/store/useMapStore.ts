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

  setStations: (stations: Station[]) => void;
  selectStation: (station: Station | null) => void;
  setIntervals: (intervals: number[]) => void;
  toggleLine: (line: LineId) => void;
  setIsochrones: (iso: IsochroneCollection | null) => void;
  setIsochronesLoading: (loading: boolean) => void;
  toggleSidebar: () => void;
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

  setStations: (stations) => set({ stations }),
  selectStation: (station) => set({ selectedStation: station, isochrones: null }),
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
}));
