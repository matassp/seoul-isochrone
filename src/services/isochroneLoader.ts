import type { IsochroneCollection, TimeProfile } from "../types";

const cache = new Map<string, IsochroneCollection>();
const MAX_CACHE = 50;

function cacheKey(stationId: string, profile: TimeProfile): string {
  return `${stationId}__${profile}`;
}

function evictOldest() {
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

export async function loadIsochrone(
  stationId: string,
  profile: TimeProfile
): Promise<IsochroneCollection | null> {
  const key = cacheKey(stationId, profile);

  if (cache.has(key)) {
    return cache.get(key)!;
  }

  try {
    const url = `/data/isochrones/${profile}/${stationId}.geojson`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: IsochroneCollection = await res.json();
    evictOldest();
    cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}
