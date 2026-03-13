import type { LineId } from "../types";

export const LINE_COLORS: Record<LineId, string> = {
  "1": "#0052A4",
  "2": "#00A84D",
  "3": "#EF7C1C",
  "4": "#00A5DE",
  "5": "#996CAC",
  "6": "#CD7C2F",
  "7": "#747F00",
  "8": "#E6186C",
  "9": "#BDB092",
  gyeongui: "#77C4A3",
  airport: "#0090D2",
  bundang: "#FABE00",
  shinbundang: "#D31145",
};

export const LINE_NAMES: Record<LineId, string> = {
  "1": "Line 1",
  "2": "Line 2",
  "3": "Line 3",
  "4": "Line 4",
  "5": "Line 5",
  "6": "Line 6",
  "7": "Line 7",
  "8": "Line 8",
  "9": "Line 9",
  gyeongui: "Gyeongui-Jungang",
  airport: "Airport Railroad",
  bundang: "Bundang",
  shinbundang: "Shinbundang",
};

export const ISOCHRONE_INTERVALS = [15, 30, 60]; // minutes

export const ISOCHRONE_COLORS = [
  "rgba(34, 197, 94, 0.25)",   // 15 min — green
  "rgba(249, 115, 22, 0.18)",  // 30 min — orange
  "rgba(239, 68, 68, 0.13)",   // 60 min — red
];

export const ISOCHRONE_STROKES = [
  "#16a34a", // 15 min
  "#ea580c", // 30 min
  "#dc2626", // 60 min
];
