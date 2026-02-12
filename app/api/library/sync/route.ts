import { NextRequest, NextResponse } from "next/server";
import { createSpherePayload } from "@/lib/embedding";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData, setSessionSphere, setSessionSyncProgress, setSessionTokens } from "@/lib/sessionStore";
import { ensureValidAccessToken, fetchAudioFeatures, fetchUserTracks, spotifyRateLimitState } from "@/lib/spotify";

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let sessionId = "";
  try {
    sessionId = await getOrCreateSessionId();
    const session = await getSessionData(sessionId);

    if (!session.tokens) {
      return NextResponse.json({ error: "Not authenticated with Spotify." }, { status: 401 });
    }

    const json = await request.json().catch(() => ({}));
    const mode = json.mode === "full" ? "full" : "quick";
    const defaultLimit = mode === "full" ? 180 : 20;
    const requestedLimit = Number(json.limit ?? defaultLimit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(20, Math.min(1000, requestedLimit)) : defaultLimit;
    const quickMode = mode === "quick";
    const rateLimit = spotifyRateLimitState();
    if (rateLimit.limited) {
      const waitSec = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
      const message = `Spotify rate-limited requests (429). Wait ${waitSec}s and sync again.`;
      await setSessionSyncProgress(sessionId, {
        status: "error",
        percent: 100,
        phase: "error",
        message,
        updatedAt: new Date().toISOString(),
        error: message
      });
      return NextResponse.json({ error: message, retryAfterMs: rateLimit.retryAfterMs }, { status: 429 });
    }

    await setSessionSyncProgress(sessionId, {
      status: "running",
      percent: 8,
      phase: "auth",
      message: "Verifying Spotify access...",
      updatedAt: new Date().toISOString()
    });

    const tokens = await ensureValidAccessToken(session.tokens);
    await setSessionTokens(sessionId, tokens);
    await setSessionSyncProgress(sessionId, {
      status: "running",
      percent: 20,
      phase: "tracks",
      message: "Fetching tracks from Spotify...",
      updatedAt: new Date().toISOString()
    });

    const rawTracks = await withTimeout(
      fetchUserTracks(tokens.accessToken, {
        limit,
        // Quick mode: use liked tracks first for a smaller, more stable call.
        includeLikedSongs: quickMode ? true : true,
        includeSavedAlbums: mode === "full",
        includeRecentlyPlayed: quickMode ? false : true,
        onProgress: async (fetched) => {
          const pct = Math.min(55, 20 + Math.round((Math.min(fetched, limit) / Math.max(limit, 1)) * 35));
          await setSessionSyncProgress(sessionId, {
            status: "running",
            percent: pct,
            phase: "tracks",
            message: quickMode
              ? `Fetching liked tracks... (${fetched}/${limit})`
              : `Fetching tracks from Spotify... (${fetched}/${limit})`,
            updatedAt: new Date().toISOString()
          });
        }
      }),
      quickMode ? 28_000 : 60_000,
      "Timed out while fetching tracks from Spotify."
    );
    await setSessionSyncProgress(sessionId, {
      status: "running",
      percent: 58,
      phase: "features",
      message: `Fetched ${rawTracks.length} tracks. Fetching audio features...`,
      updatedAt: new Date().toISOString()
    });

    const featureMap = await withTimeout(
      fetchAudioFeatures(rawTracks.map((t) => t.id), tokens.accessToken),
      quickMode ? 35_000 : 50_000,
      "Timed out while fetching audio features from Spotify."
    );
    await setSessionSyncProgress(sessionId, {
      status: "running",
      percent: 84,
      phase: "embedding",
      message: "Computing sphere layout...",
      updatedAt: new Date().toISOString()
    });
    const sphere = createSpherePayload(rawTracks, featureMap);

    await setSessionSphere(sessionId, sphere);
    await setSessionSyncProgress(sessionId, {
      status: "done",
      percent: 100,
      phase: "done",
      message: "Sync complete.",
      updatedAt: new Date().toISOString(),
      trackCount: sphere.trackCount
    });

    return NextResponse.json({
      ok: true,
      mode,
      generatedAt: sphere.generatedAt,
      trackCount: sphere.trackCount
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Sync failed unexpectedly.";
    const is429 = rawMessage.includes("HTTP 429");
    const rateLimit = spotifyRateLimitState();
    const message = rawMessage.includes("HTTP 403")
      ? "Spotify returned 403. Ensure your Spotify account is added to your app users in Spotify Dashboard, then reconnect and try again."
      : is429
        ? (() => {
          const waitSec = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
          return `Spotify rate-limited requests (429). Wait ${waitSec}s and sync again.`;
        })()
      : rawMessage.includes("Spotify request failed")
        ? "Spotify request timed out. Please retry Quick Sync; if it repeats, reconnect Spotify and try again."
      : rawMessage.includes("Timed out while fetching tracks")
        ? "Spotify took too long to return your tracks. Retry Quick Sync."
      : rawMessage.includes("Fallback track fetch timed out")
        ? "Spotify fallback fetch also timed out. Reconnect Spotify and retry Quick Sync in a minute."
      : rawMessage.includes("Timed out while fetching audio features")
        ? "Spotify took too long to return audio features. Retry Quick Sync."
      : rawMessage;
    if (sessionId) {
      await setSessionSyncProgress(sessionId, {
        status: "error",
        percent: 100,
        phase: "error",
        message,
        updatedAt: new Date().toISOString(),
        error: message
      });
    }
    return NextResponse.json(
      { error: message, retryAfterMs: is429 ? rateLimit.retryAfterMs : 0 },
      { status: is429 ? 429 : 500 }
    );
  }
}
