"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MusicSphereCanvas from "@/components/MusicSphereCanvas";
import { SpherePayload, SphereTrack, SpotifyProfile, SyncProgress } from "@/lib/types";

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

type SpotifyPlayer = {
  addListener: (event: string, cb: (state: unknown) => void) => void;
  connect: () => Promise<boolean>;
  disconnect: () => void;
  togglePlay?: () => Promise<void>;
};

function feature(value: number): string {
  return value.toFixed(2);
}

function selectedTrack(tracks: SphereTrack[], trackId: string | null): SphereTrack | null {
  if (!trackId) {
    return null;
  }
  return tracks.find((track) => track.id === trackId) ?? null;
}

function formatSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0:00";
  }
  const whole = Math.floor(totalSeconds);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clampRetryAfterMs(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.max(1000, Math.min(180_000, Math.ceil(numeric)));
}

async function readResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 240) };
  }
}

function readStringField(state: unknown, field: string): string | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const value = (state as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

export default function HomePage() {
  const [sphere, setSphere] = useState<SpherePayload | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadingSphere, setLoadingSphere] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    status: "idle",
    percent: 0,
    phase: "idle",
    message: "Waiting to sync.",
    updatedAt: new Date().toISOString()
  });
  const [status, setStatus] = useState<string>("Connect Spotify and sync to build your personal vibe sphere.");
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playMode, setPlayMode] = useState<"none" | "preview" | "spotify">("none");
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [sdkReady, setSdkReady] = useState(false);
  const [playerDeviceId, setPlayerDeviceId] = useState<string | null>(null);
  const [fullPlaybackError, setFullPlaybackError] = useState<string | null>(null);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const transitionMs = 700;
  const [syncCooldownUntil, setSyncCooldownUntil] = useState(0);
  const [cooldownNow, setCooldownNow] = useState(Date.now());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spotifyPlayerRef = useRef<SpotifyPlayer | null>(null);
  const autoPlayTimerRef = useRef<number | null>(null);
  const autoPlayLastTrackRef = useRef<string | null>(null);

  const track = useMemo(() => selectedTrack(sphere?.tracks ?? [], selectedTrackId), [sphere, selectedTrackId]);
  const playbackTrack = useMemo(() => track, [track]);

  async function refreshAuthStatus(): Promise<void> {
    setCheckingAuth(true);
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      const payload = await readResponsePayload(response);
      const authenticated = payload.authenticated === true;
      setConnected(authenticated);
      const incomingProfile = payload.profile as Record<string, unknown> | null;
      if (authenticated && incomingProfile) {
        setProfile({
          id: typeof incomingProfile.id === "string" ? incomingProfile.id : "unknown",
          displayName: typeof incomingProfile.displayName === "string" ? incomingProfile.displayName : "Spotify User",
          email: typeof incomingProfile.email === "string" ? incomingProfile.email : null,
          country: typeof incomingProfile.country === "string" ? incomingProfile.country : null,
          product: typeof incomingProfile.product === "string" ? incomingProfile.product : null
        });
      } else {
        setProfile(null);
      }
      if (authenticated) {
        setConnecting(false);
        setStatus("Spotify connected. Sync your library to build the sphere.");
      } else {
        setStatus("Connect Spotify first, then sync your library.");
      }
    } catch {
      setConnected(false);
      setProfile(null);
    } finally {
      setCheckingAuth(false);
    }
  }

  useEffect(() => {
    void refreshAuthStatus();
    void refreshSyncProgress();
  }, []);

  useEffect(() => {
    setIsPlaying(false);
    setPlayMode("none");
    setPreviewCurrentTime(0);
    setPreviewDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
    }
  }, [playbackTrack?.id]);

  useEffect(() => {
    if (syncCooldownUntil <= Date.now()) {
      return;
    }
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [syncCooldownUntil]);

  useEffect(() => {
    if (!connected) {
      setSdkReady(false);
      setPlayerDeviceId(null);
      return;
    }

    let cancelled = false;
    const scriptId = "spotify-web-playback-sdk";

    async function getToken(): Promise<string> {
      const response = await fetch("/api/player/token", { cache: "no-store" });
      const payload = await readResponsePayload(response);
      if (!response.ok || typeof payload.accessToken !== "string") {
        throw new Error(typeof payload.error === "string" ? payload.error : "Could not fetch playback token.");
      }
      return payload.accessToken;
    }

    function initPlayer(): void {
      if (!window.Spotify || spotifyPlayerRef.current || cancelled) {
        return;
      }

      const player = new window.Spotify.Player({
        name: "Music Sphere Browser Player",
        getOAuthToken: (cb) => {
          void getToken()
            .then((token) => cb(token))
            .catch(() => cb(""));
        },
        volume: 0.8
      });

      player.addListener("ready", (state) => {
        const deviceId = readStringField(state, "device_id");
        if (!cancelled && deviceId) {
          setPlayerDeviceId(deviceId);
          setSdkReady(true);
          setFullPlaybackError(null);
        }
      });
      player.addListener("not_ready", () => {
        if (!cancelled) {
          setSdkReady(false);
        }
      });
      player.addListener("account_error", (state) => {
        const message = readStringField(state, "message");
        if (!cancelled) {
          setFullPlaybackError(message ?? "Spotify account error. Premium may be required for browser playback.");
        }
      });
      player.addListener("authentication_error", (state) => {
        const message = readStringField(state, "message");
        if (!cancelled) {
          setFullPlaybackError(message ?? "Spotify authentication error. Reconnect Spotify.");
        }
      });
      player.addListener("initialization_error", (state) => {
        const message = readStringField(state, "message");
        if (!cancelled) {
          setFullPlaybackError(message ?? "Spotify SDK initialization failed.");
        }
      });
      player.addListener("player_state_changed", (state) => {
        if (cancelled || !state || typeof state !== "object") {
          return;
        }
        if ("paused" in state) {
          const paused = Boolean((state as { paused: boolean }).paused);
          setIsPlaying(!paused);
          setPlayMode("spotify");
        }
      });

      spotifyPlayerRef.current = player;
      void player.connect().then((ok) => {
        if (!ok && !cancelled) {
          setFullPlaybackError("Could not connect Spotify browser player.");
        }
      });
    }

    if (window.Spotify) {
      initPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = initPlayer;
      if (!document.getElementById(scriptId)) {
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (spotifyPlayerRef.current) {
        spotifyPlayerRef.current.disconnect();
        spotifyPlayerRef.current = null;
      }
    };
  }, [connected]);

  async function refreshSyncProgress(): Promise<void> {
    try {
      const response = await fetch("/api/library/progress", { cache: "no-store" });
      const payload = await readResponsePayload(response);
      if (response.ok) {
        const parsedPercent = Number(payload.percent ?? 0);
        setSyncProgress({
          status: payload.status === "running" || payload.status === "done" || payload.status === "error" ? payload.status : "idle",
          percent: Number.isFinite(parsedPercent) ? parsedPercent : 0,
          phase: typeof payload.phase === "string" ? payload.phase : "idle",
          message: typeof payload.message === "string" ? payload.message : "Working...",
          updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
          trackCount: typeof payload.trackCount === "number" ? payload.trackCount : undefined,
          error: typeof payload.error === "string" ? payload.error : undefined
        });
      }
    } catch {
      // Best-effort polling.
    }
  }

  async function fetchSphere(): Promise<void> {
    setLoadingSphere(true);
    setError(null);

    try {
      const response = await fetch("/api/sphere", { cache: "no-store" });
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load sphere.");
      }

      setSphere(payload as SpherePayload);
      setSelectedTrackId((payload as SpherePayload).tracks[0]?.id ?? null);
      setStatus(`Loaded ${(payload as SpherePayload).trackCount} tracks.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setLoadingSphere(false);
    }
  }

  async function syncLibrary(mode: "quick" | "full"): Promise<void> {
    setSyncing(true);
    setError(null);
    setSyncProgress({
      status: "running",
      percent: 2,
      phase: "starting",
      message: "Starting sync...",
      updatedAt: new Date().toISOString()
    });
    setStatus(mode === "quick" ? "Quick sync in progress..." : "Full sync in progress...");
    const pollHandle = window.setInterval(() => {
      void refreshSyncProgress();
    }, 800);
    void refreshSyncProgress();

    try {
      const response = await fetch("/api/library/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          mode,
          limit: mode === "quick" ? 20 : 180
        })
      });

      const payload = await readResponsePayload(response);
      if (!response.ok) {
        if (response.status === 401) {
          setConnected(false);
        }
        if (response.status === 429) {
          const retryAfterMs = clampRetryAfterMs(payload.retryAfterMs);
          if (retryAfterMs > 0) {
            setSyncCooldownUntil(Date.now() + retryAfterMs);
          }
        }
        throw new Error(typeof payload.error === "string" ? payload.error : "Sync failed.");
      }

      setConnected(true);
      setStatus(
        `${mode === "quick" ? "Quick" : "Full"} sync complete: ${String(payload.trackCount ?? 0)} tracks. Loading sphere...`
      );
      await refreshSyncProgress();
      await fetchSphere();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
      await refreshSyncProgress();
    } finally {
      window.clearInterval(pollHandle);
      setSyncing(false);
    }
  }

  async function logout(): Promise<void> {
    setError(null);
    await fetch("/api/auth/spotify/logout", { method: "POST" });
    setSphere(null);
    setSelectedTrackId(null);
    setConnected(false);
    setConnecting(false);
    setProfile(null);
    setIsPlaying(false);
    setPlayMode("none");
    setPreviewCurrentTime(0);
    setPreviewDuration(0);
    setSdkReady(false);
    setPlayerDeviceId(null);
    setFullPlaybackError(null);
    if (spotifyPlayerRef.current) {
      spotifyPlayerRef.current.disconnect();
      spotifyPlayerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setSyncProgress({
      status: "idle",
      percent: 0,
      phase: "idle",
      message: "Waiting to sync.",
      updatedAt: new Date().toISOString()
    });
    setStatus("Session cleared. Reconnect Spotify to continue.");
  }

  function seekPreview(nextTime: number): void {
    const player = audioRef.current;
    if (!player || !Number.isFinite(nextTime)) {
      return;
    }
    player.currentTime = nextTime;
    setPreviewCurrentTime(nextTime);
  }

  const playFullTrackInBrowser = useCallback(async (trackOverride?: SphereTrack | null): Promise<void> => {
    const targetTrack = trackOverride ?? track;
    setFullPlaybackError(null);
    if (!targetTrack?.uri) {
      setFullPlaybackError("Selected track cannot be played through Spotify Web Playback.");
      return;
    }
    if (!playerDeviceId) {
      setFullPlaybackError("Spotify browser player is not ready yet.");
      return;
    }

    const response = await fetch("/api/player/play", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        deviceId: playerDeviceId,
        trackUri: targetTrack.uri
      })
    });
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      setFullPlaybackError(typeof payload.error === "string" ? payload.error : "Could not start Spotify playback.");
      return;
    }
    setPlayMode("spotify");
    setIsPlaying(true);
    setStatus(`Playing in browser: ${targetTrack.name}`);
  }, [playerDeviceId, track]);

  async function toggleMainPlayback(): Promise<void> {
    setError(null);
    setFullPlaybackError(null);

    if (sdkReady && track?.uri && playerDeviceId) {
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      if (playMode === "spotify" && spotifyPlayerRef.current?.togglePlay) {
        await spotifyPlayerRef.current.togglePlay().catch(() => {
          setFullPlaybackError("Could not toggle Spotify playback.");
        });
        return;
      }
      await playFullTrackInBrowser(track);
      return;
    }

    const player = audioRef.current;
    if (!player || !playbackTrack?.previewUrl) {
      setError("No playable audio available for this track right now.");
      return;
    }
    if (player.paused) {
      await player.play().catch(() => {
        setError("Browser blocked playback. Click Play again.");
      });
    } else {
      player.pause();
    }
  }

  useEffect(() => {
    if (!autoPlayEnabled || !sdkReady || !playerDeviceId || !track?.uri) {
      return;
    }
    const targetTrack = track;

    if (autoPlayLastTrackRef.current === track.id) {
      return;
    }

    if (autoPlayTimerRef.current) {
      window.clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }

    autoPlayTimerRef.current = window.setTimeout(() => {
      autoPlayLastTrackRef.current = targetTrack.id;
      void playFullTrackInBrowser(targetTrack);
    }, Math.max(150, transitionMs));

    return () => {
      if (autoPlayTimerRef.current) {
        window.clearTimeout(autoPlayTimerRef.current);
        autoPlayTimerRef.current = null;
      }
    };
  }, [autoPlayEnabled, sdkReady, playerDeviceId, track, track?.id, track?.uri, transitionMs, playFullTrackInBrowser]);

  const progressPct = Math.max(0, Math.min(100, syncProgress.percent));
  const cooldownRemainingMs = Math.max(0, syncCooldownUntil - cooldownNow);
  const cooldownRemainingSec = Math.ceil(cooldownRemainingMs / 1000);
  const syncDisabled = syncing || cooldownRemainingMs > 0;

  return (
    <main className="futuristFrame">
      <header className="minimalTop panel">
        <div>
          <h1>Music Sphere</h1>
          <p className="meta">Spatial browser for your Spotify library.</p>
        </div>
        <div className="controlRow">
          <button
            className="primary"
            type="button"
            onClick={() => {
              setConnecting(true);
              setStatus("Opening Spotify login...");
              window.location.assign("/api/auth/spotify/login");
            }}
            disabled={connecting}
          >
            {connecting ? "Opening..." : connected ? "Reconnect" : "Connect"}
          </button>
          <button
            type="button"
            onClick={() => { void syncLibrary("quick"); }}
            disabled={syncDisabled}
          >
            {cooldownRemainingMs > 0 ? `Wait ${cooldownRemainingSec}s` : "Quick Sync"}
          </button>
          <button
            type="button"
            onClick={() => { void syncLibrary("full"); }}
            disabled={syncDisabled}
          >
            {cooldownRemainingMs > 0 ? `Wait ${cooldownRemainingSec}s` : "Full Sync"}
          </button>
          <button type="button" onClick={fetchSphere} disabled={loadingSphere}>
            {loadingSphere ? "Loading..." : "Load"}
          </button>
          <button type="button" onClick={() => { setAutoPlayEnabled((prev) => !prev); }} disabled={!sdkReady}>
            Auto {autoPlayEnabled ? "On" : "Off"}
          </button>
          <button type="button" onClick={logout}>Logout</button>
        </div>
      </header>

      <section className="sphereStage panel">
        {sphere?.tracks.length ? (
          <MusicSphereCanvas
            tracks={sphere.tracks}
            selectedTrackId={selectedTrackId}
            onSelectTrack={setSelectedTrackId}
          />
        ) : (
          <div className="emptyState">
            <p>No sphere loaded yet.</p>
            <p className="meta">Connect Spotify and run Quick Sync.</p>
          </div>
        )}

        <div className="hudLeft hudBlock">
          <p className="meta">Status</p>
          <p className="hudValue">{checkingAuth ? "Checking..." : connected ? "Connected" : "Not connected"}</p>
          {connected && profile ? (
            <p className="meta">
              {profile.displayName} {profile.country ? `• ${profile.country}` : ""}
            </p>
          ) : null}
          <div className="progressWrap">
            <div className="progressMeta">
              <span>{syncProgress.message}</span>
              <span>{Math.round(progressPct)}%</span>
            </div>
            <div className="progressTrack">
              <div
                className={`progressFill ${syncProgress.status === "error" ? "errorFill" : ""}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <p className="meta">{status}</p>
          {error ? <p className="error">{error}</p> : null}
          <p className="meta">Up/Down: energy • Left/Right: valence</p>
        </div>

      </section>

      <footer className="minimalBottom panel">
        <div className="nowPlayingMini">
          {track?.albumArtUrl ? (
            <Image src={track.albumArtUrl} alt={track.name} width={52} height={52} unoptimized />
          ) : (
            <div className="placeholderTile" />
          )}
          <div>
            <strong>{track?.name ?? "No track selected"}</strong>
            <small>{track ? track.artists.join(", ") : "Rotate the sphere to choose a track"}</small>
          </div>
        </div>

        <div className="playerCenter">
          <div className="playerActions">
            <button type="button" className="roundIcon" onClick={() => { void toggleMainPlayback(); }} disabled={!track}>
              {isPlaying ? "⏸" : "▶"}
            </button>
          </div>
          <div className="barRow">
            <span className="meta barTime">{playbackTrack?.previewUrl ? formatSeconds(previewCurrentTime) : "--:--"}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, previewDuration)}
              step={0.01}
              value={Math.min(previewCurrentTime, Math.max(1, previewDuration))}
              onChange={(event) => seekPreview(Number(event.target.value))}
              disabled={!playbackTrack?.previewUrl}
            />
            <span className="meta barTime">{playbackTrack?.previewUrl ? formatSeconds(previewDuration) : "--:--"}</span>
          </div>
          <p className="meta playerStatsText">
            Energy: {track ? feature(track.features.energy) : "--"} | Valence: {track ? feature(track.features.valence) : "--"}
            {fullPlaybackError ? ` | ${fullPlaybackError}` : ""}
          </p>
          <audio
            key={playbackTrack?.id ?? "none"}
            ref={audioRef}
            src={playbackTrack?.previewUrl ?? undefined}
            preload="metadata"
            className="hiddenAudio"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration;
              setPreviewDuration(Number.isFinite(duration) && duration > 0 ? duration : 0);
            }}
            onTimeUpdate={(event) => {
              setPreviewCurrentTime(event.currentTarget.currentTime);
            }}
            onPlay={() => {
              setPlayMode("preview");
              setIsPlaying(true);
            }}
            onPause={() => {
              if (playMode === "preview") {
                setIsPlaying(false);
              }
            }}
            onEnded={() => {
              setIsPlaying(false);
            }}
          />
        </div>
      </footer>
    </main>
  );
}
