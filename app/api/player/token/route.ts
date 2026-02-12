import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData, setSessionTokens } from "@/lib/sessionStore";
import { ensureValidAccessToken } from "@/lib/spotify";

export async function GET(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const session = await getSessionData(sessionId);

  if (!session.tokens) {
    return NextResponse.json({ error: "Not authenticated with Spotify." }, { status: 401 });
  }

  const tokens = await ensureValidAccessToken(session.tokens);
  if (tokens.accessToken !== session.tokens.accessToken || tokens.expiresAt !== session.tokens.expiresAt) {
    await setSessionTokens(sessionId, tokens);
  }

  return NextResponse.json({
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt
  });
}
