import { NextResponse } from "next/server";
import { createSpotifyStateForSession } from "@/lib/oauthState";
import { buildSpotifyLoginUrl } from "@/lib/spotify";
import { getOrCreateSessionId } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const state = createSpotifyStateForSession(sessionId);
  return NextResponse.redirect(buildSpotifyLoginUrl(state));
}
