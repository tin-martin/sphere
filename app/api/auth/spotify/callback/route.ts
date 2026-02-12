import { NextRequest, NextResponse } from "next/server";
import { extractSessionIdFromSpotifyState } from "@/lib/oauthState";
import { exchangeCodeForToken } from "@/lib/spotify";
import { setSessionIdCookie } from "@/lib/session";
import { setSessionTokens } from "@/lib/sessionStore";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.redirect(new URL("/?error=missing_oauth_params", request.url));
    }

    const sessionId = extractSessionIdFromSpotifyState(state);
    if (!sessionId) {
      return NextResponse.redirect(new URL("/?error=invalid_oauth_state", request.url));
    }

    await setSessionIdCookie(sessionId);
    const tokenSet = await exchangeCodeForToken(code);
    await setSessionTokens(sessionId, tokenSet);

    return NextResponse.redirect(new URL("/", request.url));
  } catch {
    return NextResponse.redirect(new URL("/?error=spotify_callback_failed", request.url));
  }
}
