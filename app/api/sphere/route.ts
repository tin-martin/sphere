import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData } from "@/lib/sessionStore";

export async function GET(): Promise<NextResponse> {
  try {
    const sessionId = await getOrCreateSessionId();
    const session = await getSessionData(sessionId);

    if (!session.tokens) {
      return NextResponse.json({ error: "Not authenticated with Spotify." }, { status: 401 });
    }

    if (!session.sphere) {
      return NextResponse.json({
        error: "No sphere data found. Sync your library first."
      }, { status: 404 });
    }

    return NextResponse.json(session.sphere);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load sphere.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
