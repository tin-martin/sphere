import { NextResponse } from "next/server";
import { getOrCreateSessionId, clearSessionCookie } from "@/lib/session";
import { clearSession } from "@/lib/sessionStore";

export async function POST(): Promise<NextResponse> {
  const sessionId = await getOrCreateSessionId();
  await clearSession(sessionId);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
