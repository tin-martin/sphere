import { getSpotifyEnv } from "@/lib/env";
import { chunks, safeJson } from "@/lib/http";
import { SpotifyProfile, SpotifyTokenSet, TrackAudioFeatures } from "@/lib/types";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const MAX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 20_000;
const MAX_RATE_LIMIT_DELAY_MS = 180_000;
let spotifyRateLimitedUntil = 0;

type SpotifyPaging<T> = {
  items: T[];
  next: string | null;
};

type SpotifyTrackObject = {
  id: string;
  name: string;
  uri?: string;
  artists: { name: string }[];
  album: {
    name: string;
    images: { url: string; height: number; width: number }[];
  };
  external_urls?: { spotify?: string };
  preview_url?: string | null;
};

type LikedTrackItem = {
  track: SpotifyTrackObject;
};

type SavedAlbumItem = {
  album: {
    tracks: {
      items: SpotifyTrackObject[];
    };
  };
};

type RecentlyPlayedItem = {
  track: SpotifyTrackObject;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
};

type SpotifyMeResponse = {
  id: string;
  display_name: string | null;
  email?: string | null;
  country?: string | null;
  product?: string | null;
};

export type RawTrack = {
  id: string;
  name: string;
  uri: string | null;
  artists: string[];
  albumName: string;
  albumArtUrl: string | null;
  externalUrl: string | null;
  previewUrl: string | null;
};

type FetchUserTracksOptions = {
  limit: number;
  includeLikedSongs?: boolean;
  includeSavedAlbums?: boolean;
  includeRecentlyPlayed?: boolean;
  onProgress?: (fetched: number) => Promise<void> | void;
};

function authHeaderClient(): string {
  const spotifyEnv = getSpotifyEnv();
  const basic = Buffer.from(`${spotifyEnv.clientId}:${spotifyEnv.clientSecret}`).toString("base64");
  return `Basic ${basic}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.ceil(seconds * 1000));
    }
  }

  const base = 500;
  const backoff = base * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(3_500, backoff + jitter);
}

function clampRateLimitDelayMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RATE_LIMIT_DELAY_MS;
  }
  return Math.max(1_000, Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.ceil(value)));
}

function normalizeRateLimitRemainingMs(): number {
  const remaining = spotifyRateLimitedUntil - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    spotifyRateLimitedUntil = 0;
    return 0;
  }
  const clamped = Math.min(MAX_RATE_LIMIT_DELAY_MS, remaining);
  spotifyRateLimitedUntil = Date.now() + clamped;
  return clamped;
}

function rateLimitDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRateLimitDelayMs(seconds * 1000);
    }
  }
  return DEFAULT_RATE_LIMIT_DELAY_MS;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const waitMs = normalizeRateLimitRemainingMs();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      lastResponse = response;

      if (response.ok) {
        spotifyRateLimitedUntil = 0;
        return response;
      }

      if (response.status === 429) {
        const delay = rateLimitDelayMs(response);
        const currentRemaining = normalizeRateLimitRemainingMs();
        spotifyRateLimitedUntil = Date.now() + Math.max(currentRemaining, delay);
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        return response;
      }

      const nextDelay = response.status === 429 ? rateLimitDelayMs(response) : retryDelayMs(response, attempt);
      await sleep(nextDelay);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Network request failed");
      if (attempt === MAX_RETRIES) {
        break;
      }
      await sleep(400 + attempt * 250);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError) {
    throw new Error(`Spotify request failed: ${lastError.message}`);
  }
  return lastResponse as Response;
}

export function buildSpotifyLoginUrl(state: string): string {
  const spotifyEnv = getSpotifyEnv();
  const scopes = [
    "user-library-read",
    "user-read-recently-played",
    "streaming",
    "user-read-playback-state",
    "user-modify-playback-state"
  ];

  const params = new URLSearchParams({
    client_id: spotifyEnv.clientId,
    response_type: "code",
    redirect_uri: spotifyEnv.redirectUri,
    scope: scopes.join(" "),
    state,
    show_dialog: "true"
  });

  return `${SPOTIFY_ACCOUNTS_URL}/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<SpotifyTokenSet> {
  const spotifyEnv = getSpotifyEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: spotifyEnv.redirectUri
  });

  const response = await fetchWithRetry(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: "POST",
    headers: {
      Authorization: authHeaderClient(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const json = await safeJson<TokenResponse>(response);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresAt: Date.now() + json.expires_in * 1000
  };
}

export async function refreshAccessToken(tokens: SpotifyTokenSet): Promise<SpotifyTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken
  });

  const response = await fetchWithRetry(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: "POST",
    headers: {
      Authorization: authHeaderClient(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const json = await safeJson<TokenResponse>(response);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000
  };
}

export async function ensureValidAccessToken(tokens: SpotifyTokenSet): Promise<SpotifyTokenSet> {
  const expiresSoon = tokens.expiresAt - Date.now() < 45_000;
  if (!expiresSoon) {
    return tokens;
  }
  return refreshAccessToken(tokens);
}

async function spotifyFetch<T>(endpoint: string, accessToken: string): Promise<T> {
  const response = await fetchWithRetry(`${SPOTIFY_API_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  return safeJson<T>(response);
}

async function collectPaged<T>(
  initialPath: string,
  accessToken: string,
  maxItems: number,
  onPage?: (count: number) => Promise<void> | void
): Promise<T[]> {
  let pathOrUrl: string | null = initialPath;
  const allItems: T[] = [];

  while (pathOrUrl && allItems.length < maxItems) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${SPOTIFY_API_URL}${pathOrUrl}`;
    const response = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });

    const page = await safeJson<SpotifyPaging<T>>(response);
    allItems.push(...page.items);
    await onPage?.(allItems.length);
    pathOrUrl = page.next;
  }

  return allItems.slice(0, maxItems);
}

async function collectPagedSafe<T>(
  initialPath: string,
  accessToken: string,
  maxItems: number,
  onPage?: (count: number) => Promise<void> | void
): Promise<T[]> {
  try {
    return await collectPaged<T>(initialPath, accessToken, maxItems, onPage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("HTTP 403")) {
      return [];
    }
    throw error;
  }
}

function toRawTrack(track: SpotifyTrackObject): RawTrack | null {
  if (!track?.id) {
    return null;
  }

  return {
    id: track.id,
    name: track.name,
    uri: track.uri ?? null,
    artists: track.artists?.map((artist) => artist.name) ?? [],
    albumName: track.album?.name ?? "",
    albumArtUrl: track.album?.images?.[0]?.url ?? null,
    externalUrl: track.external_urls?.spotify ?? null,
    previewUrl: track.preview_url ?? null
  };
}

export async function fetchUserTracks(accessToken: string, options: FetchUserTracksOptions): Promise<RawTrack[]> {
  const {
    limit,
    includeLikedSongs = true,
    includeSavedAlbums = true,
    includeRecentlyPlayed = true,
    onProgress
  } = options;
  let likedCount = 0;
  let savedCount = 0;
  let recentCount = 0;

  const reportProgress = async (): Promise<void> => {
    await onProgress?.(likedCount + savedCount + recentCount);
  };

  const likedPageLimit = Math.max(1, Math.min(50, limit));
  const recentPageLimit = Math.max(1, Math.min(50, limit));
  const savedPageLimit = Math.max(1, Math.min(20, Math.ceil(limit / 5)));

  const likedPromise = includeLikedSongs
    ? collectPagedSafe<LikedTrackItem>(`/me/tracks?limit=${likedPageLimit}`, accessToken, limit, async (count) => {
      likedCount = count;
      await reportProgress();
    })
    : Promise.resolve([]);
  const savedAlbumsPromise = includeSavedAlbums
    ? collectPagedSafe<SavedAlbumItem>(
      `/me/albums?limit=${savedPageLimit}`,
      accessToken,
      Math.max(1, Math.floor(limit / 5)),
      async (count) => {
      savedCount = count;
      await reportProgress();
    })
    : Promise.resolve([]);
  const recentPromise = includeRecentlyPlayed
    ? collectPagedSafe<RecentlyPlayedItem>(
      `/me/player/recently-played?limit=${recentPageLimit}`,
      accessToken,
      Math.max(1, Math.floor(limit / 2)),
      async (count) => {
      recentCount = count;
      await reportProgress();
    })
    : Promise.resolve([]);

  const [liked, savedAlbums, recent] = await Promise.all([likedPromise, savedAlbumsPromise, recentPromise]);

  const trackMap = new Map<string, RawTrack>();

  for (const item of liked) {
    const raw = toRawTrack(item.track);
    if (raw) {
      trackMap.set(raw.id, raw);
    }
  }

  for (const item of recent) {
    const raw = toRawTrack(item.track);
    if (raw) {
      trackMap.set(raw.id, raw);
    }
  }

  for (const albumItem of savedAlbums) {
    for (const track of albumItem.album?.tracks?.items ?? []) {
      const raw = toRawTrack(track);
      if (raw) {
        trackMap.set(raw.id, raw);
      }
    }
  }

  return [...trackMap.values()].slice(0, limit);
}

export async function fetchAudioFeatures(ids: string[], accessToken: string): Promise<Map<string, TrackAudioFeatures>> {
  const byId = new Map<string, TrackAudioFeatures>();

  for (const group of chunks(ids, 100)) {
    const endpoint = `/audio-features?ids=${encodeURIComponent(group.join(","))}`;
    let json: { audio_features: (TrackAudioFeatures | null)[] };
    try {
      json = await spotifyFetch<{ audio_features: (TrackAudioFeatures | null)[] }>(endpoint, accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("HTTP 403")) {
        // Some Spotify apps do not have access to audio-features. Fallback embedding handles this.
        return byId;
      }
      throw error;
    }

    for (const feature of json.audio_features) {
      if (!feature || !feature.id) {
        continue;
      }
      byId.set(feature.id, feature);
    }
  }

  return byId;
}

export async function fetchCurrentUserProfile(accessToken: string): Promise<SpotifyProfile> {
  const me = await spotifyFetch<SpotifyMeResponse>("/me", accessToken);
  return {
    id: me.id,
    displayName: me.display_name ?? me.id,
    email: me.email ?? null,
    country: me.country ?? null,
    product: me.product ?? null
  };
}

export function spotifyRateLimitState(): { limited: boolean; retryAfterMs: number } {
  const retryAfterMs = normalizeRateLimitRemainingMs();
  return {
    limited: retryAfterMs > 0,
    retryAfterMs
  };
}
