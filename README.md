# Personal Spotify Music Sphere

Interactive app that maps your Spotify tracks onto a 3D sphere. Rotate the sphere to move through musical vibes and select the song closest to your viewing direction.

## Tech

- Next.js (App Router) + TypeScript
- three.js + react-three-fiber + drei
- Spotify Web API (OAuth + library/audio feature endpoints)

## Setup

1. Create a Spotify app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Set redirect URI to `http://127.0.0.1:3000/api/auth/spotify/callback`.
3. Copy `.env.example` to `.env.local` and fill values.
4. Install dependencies: `npm install`
5. Run: `npm run dev`
6. Open the app with `http://127.0.0.1:3000` (not `localhost`).

## User Flow

1. Click **Connect Spotify**.
2. Click **Sync Library** to import tracks and compute the sphere.
3. Rotate the sphere to browse songs by direction.
4. Current nearest song appears on the right panel.

## API Routes

- `GET /api/auth/spotify/login`
- `GET /api/auth/spotify/callback`
- `POST /api/auth/spotify/logout`
- `POST /api/library/sync`
- `GET /api/sphere`

## Notes

- Track placement uses normalized Spotify audio features + PCA(3D) + projection to unit sphere.
- Selection uses `argmax(dot(cameraDirection, trackPosition))` with hysteresis/debounce.
- Session and sphere data are stored in-memory for MVP.
- Full-track browser playback uses Spotify Web Playback SDK and requires Spotify Premium.
- After scope changes, use **Reconnect Spotify** to reauthorize `streaming`, `user-read-playback-state`, and `user-modify-playback-state`.
