# Personal Spotify Music Sphere

## 1. Product Definition

Personal Spotify Music Sphere is a 3D music browser that maps a user's own Spotify tracks to points on a sphere. Users rotate the sphere to navigate music by vibe (energy, tempo, mood, acoustic/electronic), and the app selects the track closest to the current camera direction.

## 2. Primary UX

1. User logs in with Spotify.
2. App imports tracks from liked songs, saved albums, and optionally recent listening history.
3. Tracks are mapped to 3D vectors and positioned on a sphere.
4. User rotates the sphere.
5. The nearest track to the camera direction is highlighted.
6. On hover/select, show metadata; on click, play 30s preview or open in Spotify.

## 3. Functional Scope

### MVP
- Spotify OAuth login.
- Import up to N tracks (e.g., 500 to 2000).
- Retrieve audio features and metadata.
- Compute normalized musical feature vectors.
- Project tracks to sphere surface.
- Render interactive 3D sphere with smooth rotation and nearest-song selection.
- Display currently selected song card (title, artist, album art, features).

### V2
- Real Spotify playback control (Premium + Web Playback SDK).
- Session persistence of sphere layout.
- Dynamic filtering (genre/year/artist).
- Explainability labels ("more energetic", "more acoustic").

## 4. Data Inputs (Spotify)

### Required endpoints
- `GET /me/tracks` (liked songs)
- `GET /me/albums` (saved albums)
- `GET /me/player/recently-played` (optional)
- `GET /audio-features?ids=...` (audio features)
- `GET /tracks?ids=...` (track metadata if needed)

### Minimum OAuth scopes
- `user-library-read`
- `user-read-recently-played` (optional)
- `streaming` (only if in-app playback)
- `user-read-email`, `user-read-private` (optional for account identity)

## 5. Feature Space

For each track, build a feature vector from Spotify audio features:

- `energy`
- `valence`
- `tempo`
- `danceability`
- `acousticness`
- `instrumentalness`
- `speechiness`
- `liveness`

Recommended preprocessing:
- Standardize each feature to zero mean / unit variance across the user dataset.
- Clamp outliers (e.g., at p2/p98).
- Scale tempo separately so it does not dominate.

## 6. Mapping Tracks to Sphere

Goal: preserve similarity neighborhoods while forcing positions onto sphere surface.

### Option A (fast MVP): PCA -> normalize to unit sphere
1. Build matrix `X` with preprocessed feature vectors.
2. Run PCA to 3 dimensions: `Y = PCA3(X)`.
3. Normalize each point: `p_i = Y_i / ||Y_i||`.
4. `p_i` is the track position on sphere.

Pros: simple and deterministic.
Cons: less faithful for nonlinear structure.

### Option B (higher quality): UMAP/t-SNE to 3D -> spherical projection
1. Compute 3D embedding preserving local neighbors.
2. Normalize each point to unit vector.

Pros: often better local clusters.
Cons: more compute, less stable run-to-run.

Recommendation: use Option A for MVP.

## 7. Directional Semantics

Define semantic axes in embedding space by regressing known features onto 3D coordinates.

Example:
- positive Y approximately correlates with energy
- positive X approximately correlates with tempo
- positive Z approximately correlates with valence

Implementation:
1. Fit linear model from 3D coordinates to each normalized feature.
2. Derive gradient vectors for each trait.
3. Use them for labels and UI hints.

This creates explainable direction cues like "rotate up for more energetic songs".

## 8. Song Selection From Camera Direction

Let `d` be the normalized camera forward direction (world space).
For each track position `p_i` on unit sphere, compute similarity:

- `score_i = dot(d, p_i)`

Nearest track is argmax score.

Smooth behavior:
- Apply hysteresis: only switch tracks when new score exceeds current by threshold.
- Or blend selection with short debounce window (100–250 ms).
- Optional: weight by recency or play count if user wants familiar tracks prioritized.

## 9. 3D Rendering Model

### Suggested stack
- Frontend: React + TypeScript
- 3D: `three.js` + `@react-three/fiber` + `@react-three/drei`
- State: Zustand or React context
- Backend: Node.js/Express or Next.js API routes

### Scene composition
- Unit sphere guide (subtle mesh or only points)
- Track points (`THREE.Points` or instanced meshes)
- Highlight ring/halo on selected track
- Camera orbit controls with damping

### Performance notes
- Prefer GPU-friendly points/instancing for 1000+ tracks.
- Keep metadata lookup in CPU structures keyed by track ID.
- Throttle selection calculations to animation frames.

## 10. System Architecture

### Frontend
- Auth flow initiation
- Sphere rendering and interaction
- Song card + controls

### Backend
- OAuth token exchange / refresh
- Spotify API aggregation (pagination + batching)
- Feature extraction and embedding pipeline
- Caching in DB/kv store

### Storage
- User profile and tokens (encrypted at rest)
- Track snapshot + computed embedding
- Optional last-updated timestamp

## 11. API Contract (app-internal)

- `POST /api/auth/spotify/callback`
- `POST /api/library/sync`
- `GET /api/sphere` -> returns:
  - `tracks[]` with id, name, artist, albumArt, previewUrl
  - `position` (x, y, z)
  - `features`
  - `semanticAxes`

## 12. Security and Privacy

- Use least-privilege Spotify scopes.
- Encrypt refresh tokens.
- Allow user to delete imported data.
- Respect Spotify platform policy: do not expose full-track streaming unless authorized.

## 13. MVP Milestones

1. Auth + token refresh.
2. Library fetch + pagination + dedupe.
3. Audio-feature fetch and normalization.
4. PCA embedding + sphere projection.
5. 3D renderer and camera-direction selection.
6. Song detail panel and preview/open-in-Spotify action.
7. Basic QA and usability tuning.

## 14. Acceptance Criteria (MVP)

- User can sign in and sync at least 500 tracks.
- Sphere renders interactively at >= 50 FPS on typical laptop.
- Rotating camera updates selected song smoothly.
- Similar songs are generally spatially clustered.
- Directional movement changes vibe in expected way.
- No token leakage and refresh works across sessions.

## 15. Known Risks

- Spotify audio features may be unavailable/limited for some tracks.
- PCA may flatten nuanced genre boundaries.
- Very large libraries can impact render performance without LOD/instancing.
- Directional semantics may drift per user profile and require calibration.
