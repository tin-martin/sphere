import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { getSessionData } from "@/lib/sessionStore";

export async function GET(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  const session = await getSessionData(sessionId);

  return NextResponse.json(
    session.syncProgress ?? {
      status: "idle",
      percent: 0,
      phase: "idle",
      message: "Waiting to sync.",
      updatedAt: new Date().toISOString()
    }
  );
}
