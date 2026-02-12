import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData } from "@/lib/sessionStore";

export async function GET(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const session = await getSessionData(sessionId);
  const authenticated = Boolean(session.tokens);

  return NextResponse.json({
    sessionId,
    authenticated,
    profile: authenticated ? session.profile ?? null : null,
    hasSphere: Boolean(session.sphere),
    trackCount: session.sphere?.trackCount ?? 0
  });
}
