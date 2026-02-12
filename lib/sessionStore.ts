import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpherePayload, SpotifyProfile, SpotifyTokenSet, SyncProgress } from "@/lib/types";

type SessionData = {
  tokens?: SpotifyTokenSet;
  profile?: SpotifyProfile;
  sphere?: SpherePayload;
  syncProgress?: SyncProgress;
};

const SESSIONS_DIR = path.join(process.cwd(), ".cache", "sessions");

function sessionFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

export async function getSessionData(sessionId: string): Promise<SessionData> {
  await ensureSessionsDir();
  try {
    const raw = await readFile(sessionFilePath(sessionId), "utf8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return {};
  }
}

async function writeSessionData(sessionId: string, data: SessionData): Promise<void> {
  await ensureSessionsDir();
  await writeFile(sessionFilePath(sessionId), JSON.stringify(data), "utf8");
}

export async function setSessionTokens(sessionId: string, tokens: SpotifyTokenSet): Promise<void> {
  const prev = await getSessionData(sessionId);
  await writeSessionData(sessionId, { ...prev, tokens });
}

export async function setSessionProfile(sessionId: string, profile: SpotifyProfile): Promise<void> {
  const prev = await getSessionData(sessionId);
  await writeSessionData(sessionId, { ...prev, profile });
}

export async function setSessionSphere(sessionId: string, sphere: SpherePayload): Promise<void> {
  const prev = await getSessionData(sessionId);
  await writeSessionData(sessionId, { ...prev, sphere });
}

export async function setSessionSyncProgress(sessionId: string, syncProgress: SyncProgress): Promise<void> {
  const prev = await getSessionData(sessionId);
  await writeSessionData(sessionId, { ...prev, syncProgress });
}

export async function clearSession(sessionId: string): Promise<void> {
  await ensureSessionsDir();
  await rm(sessionFilePath(sessionId), { force: true });
}
