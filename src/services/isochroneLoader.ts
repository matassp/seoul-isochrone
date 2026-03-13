import type { IsochroneCollection } from "../types";

const cache = new Map<string, IsochroneCollection>();
const MAX_CACHE = 50;

function evictOldest() {
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

export async function loadIsochrone(
  stationId: string
): Promise<IsochroneCollection | null> {
  if (cache.has(stationId)) {
    return cache.get(stationId)!;
  }

  try {
    const url = `/data/isochrones/${stationId}.geojson`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: IsochroneCollection = await res.json();
    evictOldest();
    cache.set(stationId, data);
    return data;
  } catch {
    return null;
  }
}
