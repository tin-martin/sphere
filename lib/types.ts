export type SpotifyTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type TrackAudioFeatures = {
  id: string;
  danceability: number;
  energy: number;
  key: number;
  loudness: number;
  mode: number;
  speechiness: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  valence: number;
  tempo: number;
  time_signature: number;
};

export type SphereTrack = {
  id: string;
  name: string;
  uri: string | null;
  artists: string[];
  albumName: string;
  albumArtUrl: string | null;
  externalUrl: string | null;
  previewUrl: string | null;
  features: TrackAudioFeatures;
  vector: number[];
  position: [number, number, number];
};

export type SemanticAxes = {
  energy: [number, number, number];
  tempo: [number, number, number];
  valence: [number, number, number];
  acousticness: [number, number, number];
};

export type SpherePayload = {
  generatedAt: string;
  trackCount: number;
  tracks: SphereTrack[];
  semanticAxes: SemanticAxes;
};

export type SyncProgress = {
  status: "idle" | "running" | "done" | "error";
  percent: number;
  phase: string;
  message: string;
  updatedAt: string;
  trackCount?: number;
  error?: string;
};

export type SpotifyProfile = {
  id: string;
  displayName: string;
  email: string | null;
  country: string | null;
  product: string | null;
};
