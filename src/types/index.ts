export interface Station {
  id: string;
  name: string;
  nameKo: string;
  lat: number;
  lng: number;
  lines: LineId[];
}

export type LineId =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "gyeongui"
  | "airport"
  | "bundang"
  | "shinbundang";

export type TimeProfile = "off-peak" | "peak";

export interface IsochroneFeature {
  type: "Feature";
  properties: {
    interval: number; // minutes
    stationId: string;
    profile: TimeProfile;
  };
  geometry: GeoJSON.Polygon;
}

export interface IsochroneCollection {
  type: "FeatureCollection";
  features: IsochroneFeature[];
}
