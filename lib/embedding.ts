import { RawTrack } from "@/lib/spotify";
import { SpherePayload, SphereTrack, TrackAudioFeatures } from "@/lib/types";

const FEATURE_KEYS = [
  "energy",
  "tempo",
  "valence",
  "danceability",
  "acousticness",
  "instrumentalness",
  "speechiness",
  "liveness"
] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildFeatureMatrix(features: TrackAudioFeatures[]): number[][] {
  const columns = FEATURE_KEYS.map((key) => {
    const values = features.map((f) => (key === "tempo" ? f.tempo / 220 : f[key]));
    const sorted = [...values].sort((a, b) => a - b);
    const low = percentile(sorted, 0.02);
    const high = percentile(sorted, 0.98);
    const clamped = values.map((v) => clamp(v, low, high));
    const mean = clamped.reduce((sum, v) => sum + v, 0) / Math.max(clamped.length, 1);
    const variance = clamped.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(clamped.length - 1, 1);
    const sd = Math.sqrt(variance) || 1;
    return clamped.map((v) => (v - mean) / sd);
  });

  return features.map((_, rowIndex) => columns.map((column) => column[rowIndex]));
}


function simplePositionFromEnergyValence(features: TrackAudioFeatures): [number, number, number] {
  let x = (features.valence * 2 - 1) * 0.92;
  let y = (features.energy * 2 - 1) * 0.92;
  const maxRadius = 0.96;
  const radius = Math.sqrt(x * x + y * y);
  if (radius > maxRadius) {
    const scale = maxRadius / radius;
    x *= scale;
    y *= scale;
  }
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [x, y, z];
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackFeaturesFromTrack(track: RawTrack): TrackAudioFeatures {
  const base = hashString(`${track.id}:${track.name}:${track.artists.join(",")}`);
  const u1 = seededUnit(base + 11);
  const u2 = seededUnit(base + 23);
  const u3 = seededUnit(base + 37);
  const u4 = seededUnit(base + 53);
  const u5 = seededUnit(base + 71);
  const u6 = seededUnit(base + 89);
  const u7 = seededUnit(base + 101);
  const u8 = seededUnit(base + 131);

  return {
    id: track.id,
    danceability: u1,
    energy: u2,
    key: Math.floor(u3 * 12),
    loudness: -60 + u4 * 60,
    mode: u5 > 0.5 ? 1 : 0,
    speechiness: u6,
    acousticness: u7,
    instrumentalness: u8,
    liveness: seededUnit(base + 149),
    valence: seededUnit(base + 167),
    tempo: 70 + seededUnit(base + 191) * 110,
    time_signature: 4
  };
}

export function createSpherePayload(rawTracks: RawTrack[], featureMap: Map<string, TrackAudioFeatures>): SpherePayload {
  const merged = rawTracks
    .map((track) => {
      const features = featureMap.get(track.id) ?? fallbackFeaturesFromTrack(track);
      return { track, features };
    })
    .filter((value): value is { track: RawTrack; features: TrackAudioFeatures } => Boolean(value));

  if (!merged.length) {
    return {
      generatedAt: new Date().toISOString(),
      trackCount: 0,
      tracks: [],
      semanticAxes: {
        energy: [0, 1, 0],
        tempo: [1, 0, 0],
        valence: [0, 0, 1],
        acousticness: [-1, 0, 0]
      }
    };
  }
  const featureMatrix = buildFeatureMatrix(merged.map((item) => item.features));
  const positions = merged.map((item) => simplePositionFromEnergyValence(item.features));
  const semanticAxes = {
    energy: [0, 1, 0] as [number, number, number],
    tempo: [0, 0, 1] as [number, number, number],
    valence: [1, 0, 0] as [number, number, number],
    acousticness: [-1, 0, 0] as [number, number, number]
  };

  const tracks: SphereTrack[] = merged.map((item, index) => ({
    id: item.track.id,
    name: item.track.name,
    uri: item.track.uri,
    artists: item.track.artists,
    albumName: item.track.albumName,
    albumArtUrl: item.track.albumArtUrl,
    externalUrl: item.track.externalUrl,
    previewUrl: item.track.previewUrl,
    features: item.features,
    vector: featureMatrix[index],
    position: positions[index]
  }));

  return {
    generatedAt: new Date().toISOString(),
    trackCount: tracks.length,
    tracks,
    semanticAxes
  };
}
