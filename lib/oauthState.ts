import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getSpotifyEnv } from "@/lib/env";

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  const { clientSecret } = getSpotifyEnv();
  return createHmac("sha256", clientSecret).update(payload).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createSpotifyStateForSession(sessionId: string): string {
  const nonce = randomUUID();
  const issuedAt = Date.now().toString();
  const payload = `${sessionId}.${nonce}.${issuedAt}`;
  return `${payload}.${sign(payload)}`;
}

export function extractSessionIdFromSpotifyState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const [sessionId, nonce, issuedAt, signature] = parts;
  if (!isUuid(sessionId) || !isUuid(nonce)) {
    return null;
  }
  if (!/^\d+$/.test(issuedAt) || !/^[a-f0-9]{64}$/.test(signature)) {
    return null;
  }

  const payload = `${sessionId}.${nonce}.${issuedAt}`;
  const expected = sign(payload);

  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) {
    return null;
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const age = Date.now() - Number(issuedAt);
  if (!(age >= 0 && age <= STATE_TTL_MS)) {
    return null;
  }

  return sessionId;
}
