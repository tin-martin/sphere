import { RawTrack } from "@/lib/spotify";
import { SemanticAxes, SpherePayload, SphereTrack, TrackAudioFeatures } from "@/lib/types";

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

type FeatureKey = (typeof FEATURE_KEYS)[number];

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function magnitude(vector: number[]): number {
  return Math.sqrt(dot(vector, vector));
}

function normalize(vector: number[]): number[] {
  const mag = magnitude(vector);
  if (mag === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / mag);
}

function transpose(matrix: number[][]): number[][] {
  if (!matrix.length) {
    return [];
  }
  return matrix[0].map((_, colIndex) => matrix.map((row) => row[colIndex]));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function covarianceMatrix(matrix: number[][]): number[][] {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const cov = Array.from({ length: cols }, () => Array.from({ length: cols }, () => 0));

  for (let i = 0; i < cols; i += 1) {
    for (let j = i; j < cols; j += 1) {
      let sum = 0;
      for (let r = 0; r < rows; r += 1) {
        sum += matrix[r][i] * matrix[r][j];
      }
      const value = rows > 1 ? sum / (rows - 1) : 0;
      cov[i][j] = value;
      cov[j][i] = value;
    }
  }

  return cov;
}

function powerIteration(matrix: number[][], iterations = 60): number[] {
  const size = matrix.length;
  let vector = normalize(Array.from({ length: size }, () => Math.random() + 1e-4));

  for (let i = 0; i < iterations; i += 1) {
    const next = multiplyMatrixVector(matrix, vector);
    vector = normalize(next);
  }

  return vector;
}

function deflate(matrix: number[][], eigenvector: number[], eigenvalue: number): number[][] {
  return matrix.map((row, i) =>
    row.map((value, j) => value - eigenvalue * eigenvector[i] * eigenvector[j])
  );
}

function project(matrix: number[][], components: number[][]): number[][] {
  const componentsT = transpose(components);
  return matrix.map((row) => componentsT.map((component) => dot(row, component)));
}

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

function runPca3(matrix: number[][]): number[][] {
  const cov = covarianceMatrix(matrix);
  const components: number[][] = [];
  let working = cov;

  for (let i = 0; i < 3; i += 1) {
    const eigenvector = powerIteration(working);
    const eigenvalue = dot(eigenvector, multiplyMatrixVector(working, eigenvector));
    components.push(eigenvector);
    working = deflate(working, eigenvector, eigenvalue);
  }

  return project(matrix, components);
}

function vectorToTuple3(vector: number[]): [number, number, number] {
  return [vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0];
}

function featureCorrelations(positions: number[][], values: number[]): [number, number, number] {
  const cols = [0, 1, 2].map((index) => positions.map((p) => p[index] ?? 0));
  const meanV = values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);

  const correlations = cols.map((col) => {
    const meanC = col.reduce((sum, v) => sum + v, 0) / Math.max(col.length, 1);
    let numerator = 0;
    let denomC = 0;
    let denomV = 0;

    for (let i = 0; i < col.length; i += 1) {
      const dc = col[i] - meanC;
      const dv = values[i] - meanV;
      numerator += dc * dv;
      denomC += dc * dc;
      denomV += dv * dv;
    }

    const denom = Math.sqrt(denomC * denomV);
    return denom === 0 ? 0 : numerator / denom;
  });

  return vectorToTuple3(normalize(correlations));
}

function computeSemanticAxes(positions: number[][], features: TrackAudioFeatures[]): SemanticAxes {
  return {
    energy: featureCorrelations(positions, features.map((f) => f.energy)),
    tempo: featureCorrelations(positions, features.map((f) => f.tempo)),
    valence: featureCorrelations(positions, features.map((f) => f.valence)),
    acousticness: featureCorrelations(positions, features.map((f) => f.acousticness))
  };
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

function fibonacciSpherePoint(index: number, total: number): [number, number, number] {
  const n = Math.max(total, 1);
  const i = index + 0.5;
  const phi = Math.acos(1 - (2 * i) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  const x = Math.cos(theta) * Math.sin(phi);
  const y = Math.sin(theta) * Math.sin(phi);
  const z = Math.cos(phi);
  return [x, y, z];
}

function ensureVisiblePositions(rawPositions: number[][]): [number, number, number][] {
  let zeroCount = 0;
  for (const pos of rawPositions) {
    if (magnitude(pos) < 1e-6) {
      zeroCount += 1;
    }
  }

  const mostlyCollapsed = zeroCount > rawPositions.length * 0.3;
  if (mostlyCollapsed) {
    return rawPositions.map((_, index) => fibonacciSpherePoint(index, rawPositions.length));
  }

  const normalized = rawPositions.map((pos, index) => {
    if (magnitude(pos) < 1e-6) {
      return fibonacciSpherePoint(index, rawPositions.length);
    }
    return vectorToTuple3(normalize(pos));
  });

  const centroid: [number, number, number] = normalized.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
    [0, 0, 0]
  ).map((v) => v / Math.max(normalized.length, 1)) as [number, number, number];
  const avgDist = normalized.reduce((sum, p) => {
    const dx = p[0] - centroid[0];
    const dy = p[1] - centroid[1];
    const dz = p[2] - centroid[2];
    return sum + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }, 0) / Math.max(normalized.length, 1);

  if (avgDist < 0.22) {
    return normalized.map((_, index) => fibonacciSpherePoint(index, normalized.length));
  }

  return normalized;
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
