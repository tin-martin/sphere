import { NextRequest, NextResponse } from "next/server";
import { extractSessionIdFromSpotifyState } from "@/lib/oauthState";
import { exchangeCodeForToken } from "@/lib/spotify";
import { setSessionIdCookie } from "@/lib/session";
import { setSessionTokens } from "@/lib/sessionStore";

export const runtime = "nodejs";

function safeRedirect(request: NextRequest, pathWithQuery: string): NextResponse {
  try {
    return NextResponse.redirect(new URL(pathWithQuery, request.url));
  } catch {
    return NextResponse.redirect(pathWithQuery);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const spotifyError = url.searchParams.get("error");
    if (spotifyError) {
      return safeRedirect(request, `/?error=spotify_oauth_${encodeURIComponent(spotifyError)}`);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return safeRedirect(request, "/?error=missing_oauth_params");
    }

    const sessionId = extractSessionIdFromSpotifyState(state);
    if (!sessionId) {
      return safeRedirect(request, "/?error=invalid_oauth_state");
    }

    await setSessionIdCookie(sessionId);
    const tokenSet = await exchangeCodeForToken(code);
    await setSessionTokens(sessionId, tokenSet);

    return safeRedirect(request, "/");
  } catch {
    return safeRedirect(request, "/?error=spotify_callback_failed");
  }
}
