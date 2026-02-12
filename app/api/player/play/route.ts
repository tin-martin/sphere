import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData, setSessionTokens } from "@/lib/sessionStore";
import { ensureValidAccessToken } from "@/lib/spotify";

type PlayBody = {
  deviceId?: string;
  trackUri?: string;
};

async function spotifyRequest(endpoint: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const session = await getSessionData(sessionId);

  if (!session.tokens) {
    return NextResponse.json({ error: "Not authenticated with Spotify." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as PlayBody;
  const deviceId = body.deviceId;
  const trackUri = body.trackUri;

  if (!deviceId || !trackUri) {
    return NextResponse.json({ error: "Missing deviceId or trackUri." }, { status: 400 });
  }

  const tokens = await ensureValidAccessToken(session.tokens);
  if (tokens.accessToken !== session.tokens.accessToken || tokens.expiresAt !== session.tokens.expiresAt) {
    await setSessionTokens(sessionId, tokens);
  }

  const transfer = await spotifyRequest(
    "/me/player",
    {
      method: "PUT",
      body: JSON.stringify({
        device_ids: [deviceId],
        play: false
      })
    },
    tokens.accessToken
  );

  if (!transfer.ok && transfer.status !== 204) {
    const text = await transfer.text();
    return NextResponse.json({ error: `Transfer failed (${transfer.status}): ${text}` }, { status: transfer.status });
  }

  const play = await spotifyRequest(
    `/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ uris: [trackUri] })
    },
    tokens.accessToken
  );

  if (!play.ok && play.status !== 204) {
    const text = await play.text();
    return NextResponse.json({ error: `Play failed (${play.status}): ${text}` }, { status: play.status });
  }

  return NextResponse.json({ ok: true });
}
