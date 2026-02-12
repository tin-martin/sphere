import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData, setSessionTokens } from "@/lib/sessionStore";
import { ensureValidAccessToken, spotifyRateLimitState } from "@/lib/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

type ProbeResult = {
  endpoint: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  bodyPreview: string;
  bodyJson?: unknown;
};

async function probe(endpoint: string, accessToken: string, timeoutMs = 15000): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${SPOTIFY_API}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store",
      signal: controller.signal
    });

    const text = await response.text();
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(text);
    } catch {
      bodyJson = undefined;
    }

    return {
      endpoint,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
      bodyPreview: text.slice(0, 240),
      bodyJson
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      endpoint,
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      bodyPreview: `ERROR: ${message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const session = await getSessionData(sessionId);

  if (!session.tokens) {
    return NextResponse.json({
      authenticated: false,
      error: "Not authenticated with Spotify."
    }, { status: 401 });
  }

  let tokens = session.tokens;
  try {
    tokens = await ensureValidAccessToken(tokens);
    if (tokens.accessToken !== session.tokens.accessToken || tokens.expiresAt !== session.tokens.expiresAt) {
      await setSessionTokens(sessionId, tokens);
    }
  } catch (error) {
    return NextResponse.json({
      authenticated: true,
      tokenRefreshOk: false,
      refreshError: error instanceof Error ? error.message : "Token refresh failed"
    }, { status: 500 });
  }

  const me = await probe("/me", tokens.accessToken);
  const tracks = await probe("/me/tracks?limit=1", tokens.accessToken);
  const recent = await probe("/me/player/recently-played?limit=1", tokens.accessToken);

  let firstTrackId: string | null = null;
  if (tracks.ok && tracks.bodyJson && typeof tracks.bodyJson === "object") {
    const parsed = tracks.bodyJson as { items?: Array<{ track?: { id?: string } }> };
    firstTrackId = parsed.items?.[0]?.track?.id ?? null;
  }

  const features = firstTrackId
    ? await probe(`/audio-features?ids=${encodeURIComponent(firstTrackId)}`, tokens.accessToken)
    : null;

  return NextResponse.json({
    authenticated: true,
    tokenRefreshOk: true,
    sessionId,
    rateLimitState: spotifyRateLimitState(),
    probes: {
      me,
      tracks,
      recent,
      features
    }
  });
}
