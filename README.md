# Brivo Lumina

**AI camera super-resolution.** Enter an account auth key, browse its cameras,
pull a window of preview frames around any moment, draw an optional region of
interest, and enhance it to high resolution — or build a **holistic** multi-camera
fused view of the same location. Every action is recorded as a *Trial* in Postgres
and browsable in a history gallery.

> Status: **live Eagle Eye Networks (EEN) integration** — real cameras, real
> preview frames (downloaded asynchronously), fed to a **stand-in** super-resolution
> model. The EEN pipeline lives in its own `internal/brivo` package; the real
> super-res model plugs in behind a clean `Upscaler` interface (see
> [What's dummy vs real](#whats-dummy-vs-real)).

---

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Using the app](#using-the-app)
- [Features](#features-ready)
- [Pending / roadmap](#pending--roadmap)
- [Data model — `trials`](#data-model--trials)
- [API reference](#api-reference)
- [Hidden admin delete](#hidden-admin-delete)
- [What's dummy vs real](#whats-dummy-vs-real)
- [Configuration](#configuration-env-vars)
- [Project structure](#project-structure)
- [How to run](#how-to-run)

---

## Overview

Brivo Lumina turns low-resolution camera frames into crisp, high-fidelity imagery.

1. **Log in** (username/password — signup-or-login), then **start a session** —
   give it a name and the account **auth key** (stored against your user for 24h).
2. **Pick a camera** — the session loads every camera on the account into a grid;
   each tile downloads its latest preview in the background (shows a loader, then
   the live thumbnail). Optionally choose a date & time, then open a camera.
3. **Browse frames** — the backend walks the archiver's prev/next preview links to
   return a window of frames around that moment; scroll the filmstrip left/right to
   fetch more.
4. **Enhance** — pick a frame, optionally draw a region of interest, then run:
   - **Super-Res** — enhance that frame (or just the ROI) to high resolution.
   - **Holistic View** — fuse every camera pointing at the same location into one
     wide, high-res composite.
5. **Review history** — every enhancement is stored and shown in a gallery you can
   scroll through and open full-screen (before/after compare for super-res, the
   composite + contributing cameras for holistic).

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
   Browser      │                React SPA (Vite)                    │
  ┌────────┐    │  Landing → New Session → Cameras → Workspace → Hist │
  │  UI    │◄──►│  camera grid · ROI draw · filmstrip · compare · ... │
  └────────┘    └───────────────┬────────────────────────────────────┘
       │ HTTP (JSON + image URLs)│
       ▼                         ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                     Go backend (net/http)                    │
  │  server/   router · CORS · logging · SPA + /files static     │
  │  brivo/    EEN pipeline: cameras · archiver health · previews │
  │  camera/   dummy frame source (legacy /api/frames fallback)  │
  │  model/    Upscaler iface · DummyUpscaler · holistic fusion  │
  │  imaging/  resize · crop · enhance · composite (pure stdlib)  │
  │  store/    images + Postgres (GORM repo, migrations, models) │
  │  hires/    async super-res worker  ·  agent/  Gemini chat    │
  └───────────────┬─────────────────────────────┬────────────────┘
                  │                             │
                  ▼                             ▼
        ┌──────────────────┐         ┌────────────────────────┐
        │  Postgres        │         │  Filesystem / volume    │
        │ trials · images  │         │ sessions/…/images/ etc. │
        └──────────────────┘         └────────────────────────┘
```

**Preview flow (async download → poll → serve):**

1. `POST /api/cameras {sessionId}` → `brivo.Cameras(authKey)` lists the account's
   cameras. For each, the server creates an `images` row (`state = PROCESSING`),
   returns a **uuid `imageId`** per camera, and kicks off a background goroutine
   (bounded by a semaphore) that picks the healthiest **archiver**
   (`brivo.Archiver`), downloads the latest preview (`brivo.FetchPreview`), writes
   it to `sessions/{id}/images/{imageId}.jpeg`, and flips the row to `SUCCESS`.
2. The UI polls `GET /api/image/status?imageId=…` until `SUCCESS`/`FAILURE`, then
   loads the image from `GET /api/images?imageId=…`.
3. Opening a camera calls `POST /api/previews` which walks the archiver's
   `prev`/`next` links (`x-ee-prev` / `x-ee-next` headers) to fetch N frames around
   the chosen moment; scrolling the filmstrip fetches more `older`/`newer`.

**Request flow for a super-res enhancement (async, return-then-poll):**

1. UI `POST /api/super-resolve` with the frame path + optional ROI.
2. Handler creates a **Trial** row (`state = CREATED`), hands it to the **HiRes
   processor** (`internal/hires`), and returns **`202`** immediately with the trial id.
3. In the background, the processor flips the trial to `PROCESSING`, then
   `model.DummyUpscaler` loads the source image → crops the ROI → bilinear-upscales
   → applies a sharpen/contrast "enhance" pass → writes a high-res PNG to
   `data/outputs/`.
4. Trial updated to `SUCCESS` with the result path/URL (or `FAILURE` + error).
5. The UI polls `GET /api/trials/{id}` until `SUCCESS`/`FAILURE`, then renders the
   image URL. The image bytes are served from `/files/...`.

> Holistic (`POST /api/alternate`) still runs the pipeline **synchronously** and
> returns the result in one response.

**Two ways the stack is wired:**

- **Containerized (one command):** the Go binary serves the API *and* the built
  React app from a single origin — no proxy needed.
- **Local dev:** Vite serves the UI with hot reload on `:5173` and proxies `/api`
  and `/files` to the Go backend.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | React 18, Vite, React Router, Framer Motion, lucide-react; custom CSS design system |
| Backend | Go 1.24, standard-library `net/http` (method-aware routing) |
| Imaging | Pure Go standard library (no native deps) |
| ORM / queries | GORM |
| Migrations | golang-migrate with explicit SQL files (embedded; **no AutoMigrate**) |
| Database | PostgreSQL 16 |
| Packaging | Multi-stage Docker image + Docker Compose |

---

## Using the app

1. **Log in / sign up** — enter a username + password and hit **Continue**. A new
   username creates an account; an existing one logs you in. You stay signed in via
   a cookie; log out from the Landing top-right.
2. **Landing** — choose **New capture** or **History**.
3. **New session** — only *Session name* and the account *Auth key* are required.
   The session (name + auth key) is stored against your user for 24h.
4. **Cameras** — the account's cameras load into a grid; each tile shows a loader
   while its latest preview downloads, then the live thumbnail (offline cameras are
   marked and unclickable). Optionally set a *Date & time* (defaults to latest),
   then click a camera to open it.
5. **Workspace**
   - The **filmstrip** at the bottom holds the frames fetched around the chosen
     moment; scroll to either edge to walk the archiver's prev/next links for more.
   - Click a frame to load it into the stage. **Drag on the image** to draw an ROI
     rectangle (drag again to redraw; *Clear* to remove → enhances the full frame).
   - Click **Super-Res** or **Holistic View**. The result appears in the right
     panel. **Changing the ROI re-runs the current operation automatically.**
   - Super-res shows a **before/after compare slider**; holistic shows the fused
     image plus thumbnails of the contributing cameras.
6. **History** — a gallery of all successful conversions (newest first), with filter
   tabs (All / Super-Res / Holistic). Click any card to open the **full-screen
   viewer**; navigate with the on-screen arrows or **←/→**, close with **Esc**.

---

## Features (ready)

- **Accounts** — username/password login (one button = signup-or-login), cookie
  session, and **user-owned sessions** (name + camera auth key, valid 24h)
- **Live EEN integration** (`internal/brivo`) — list an account's real cameras,
  pick the healthiest archiver per camera, and download real preview frames; the
  auth key lives server-side with the session (the UI only passes `sessionId`)
- **Async preview downloads** — cameras return immediately with a per-camera
  `imageId`; previews download on background goroutines and the UI polls status
- **Brivo voice assistant** — a Gemini-powered agent (hands-free voice or typed)
  that drives the whole UI: sessions, frame select, ROI, Super-Res, Holistic, 3D
- Landing, Login, New Session, Camera grid, Workspace, and History pages
- Frame window with **infinite filmstrip paging** (walks prev/next, de-duped)
- **ROI drawing** on the source frame (normalized, resolution-independent)
- **Super-Res** and **Holistic View** operations, with auto re-run on ROI change
- **Before/after compare slider** and holistic composite + source cameras
- **History gallery** + full-screen lightbox with keyboard navigation
- **Super-Saiyan mode** — view a holistic result as an orbitable 3D scene (main
  image centered, source cameras placed by their direction); appears only after a
  holistic run. Renders whatever cameras/angles the API returns.
- **Trials persisted in Postgres** with a `CREATED → PROCESSING → SUCCESS/FAILURE`
  lifecycle; ROI stored as two-point coords `[{x,y},{x,y}]`
- **Async super-res** via the **HiRes processor** (`internal/hires`): the endpoint
  returns `202` immediately and the job runs on a background dispatcher goroutine;
  poll `GET /api/trials/{id}` for the result
- **Hidden admin delete** (type `delete`) — per-item + delete-all, removes rows and
  output files
- Real image pipeline (load → crop → upscale → enhance → save) producing real files
- **Single-binary production mode** and a **one-command Docker stack**

## Pending / roadmap

- ✅ **Real camera integration** — done: `internal/brivo` lists real cameras and
  downloads real preview frames via the account auth key + archiver health API
- **Real super-resolution model** — replace `DummyUpscaler` (implement `Upscaler`);
  real JPEG previews currently get a load → sharpen-upscale pass
- **Real holistic logic** — resolve the actual co-located cameras and fuse them
- **Async processing** — super-res is fully async end-to-end: backend returns `202`
  + `CREATED`, and the frontend (`client.js` `superResolve`) polls
  `GET /api/trials/{id}` (showing "we're working on it") until `SUCCESS`, then renders
  the high-res image. Still pending: make holistic (`/api/alternate`) async too.
- **Trials not yet user-scoped** — login + user-owned sessions exist, but `trials`
  (history) aren't linked to `user_id` yet, so history is global. The `delete`
  endpoints are *hidden*, **not secured**.
- **Tests & CI**, structured error/toast handling, holistic thumbnail cleanup on
  delete

---

## Data model — `trials`

One row per enhancement action. `id / created_at / updated_at / deleted_at` come
from `gorm.Model`. The ROI is stored as two normalized corner points
`[{x,y},{x,y}]` (top-left, bottom-right); `state` is updated through the lifecycle.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | gorm.Model |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | gorm.Model (soft delete) |
| `esn` | text **NOT NULL** | camera ESN |
| `session_name` | text | session label |
| `file_path` | text **NOT NULL** | source (low-res) frame path |
| `frame_timestamp` | timestamptz | source frame time |
| `frame_label` | text | human-readable frame time |
| `coords` | jsonb | ROI `[{x,y},{x,y}]` (normalized); null = full frame |
| `state` | text **NOT NULL** | `CREATED` / `PROCESSING` / `SUCCESS` / `FAILURE` |
| `type` | text **NOT NULL** | `super_res` / `holistic` |
| `result_path` / `result_url` | text | output (set on SUCCESS) |
| `source_url` | text | source URL for before/after compare |
| `scale` | integer | upscale factor |
| `sources` | jsonb | holistic contributing cameras |
| `duration_ms` | bigint | model latency |
| `error` | text | message on FAILURE |

Schema is defined in `backend/internal/store/migrations/*.sql` and applied
by golang-migrate on startup. The GORM struct in `backend/internal/store/models.go`
maps to it for queries only. (Postgres access lives in the `store` package — see
`store/postgres.go`, `store/repo.go`.)

### `images` (preview downloads)

One row per downloaded preview frame (`000003_images`). The `id` is a **uuid**
(not a bigint) so the frontend can reference the download before it finishes.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | uuid (v4) |
| `created_at` / `updated_at` | timestamptz | |
| `session_id` | bigint | owning session |
| `camera_esn` | text | source camera |
| `een_ts` | text | EEN timestamp of the frame (`YYYYMMDDhhmmss.fff`) |
| `kind` | text | e.g. `preview` |
| `state` | text | `PROCESSING` / `SUCCESS` / `FAILURE` |
| `path` | text | on-disk path once downloaded |
| `error` | text | message on FAILURE |

---

## API reference

All endpoints are JSON. Generated images are served under `/files/...`.

| Method | Endpoint | Body | Returns |
|--------|----------|------|---------|
| POST | `/api/cameras` | `{sessionId, authKey?}` | `{cameras:[{esn,name,location,status,imageId}], images:{esn:imageId}}` — lists account cameras; kicks off latest-preview downloads |
| POST | `/api/previews` | `{sessionId, cameraEsn, aroundTs?, direction?, count?, authKey?}` | `{previews:[{imageId,ts,state}], oldestTs, newestTs}` — walks prev/next; `direction` = `around`/`older`/`newer` |
| GET | `/api/image/status` | `?imageId=` | `{id, state, ts, error?}` — poll a preview download |
| GET | `/api/images` | `?imageId=` | the downloaded preview JPEG (or `202` if not ready) |
| POST | `/api/super-resolve` | `{imagePath, cameraEsn, sessionName?, frameTimestamp?, frameLabel?, roi?}` | **`202`** `{id, type, state:"CREATED", roi}` — enqueued; poll for the result |
| GET | `/api/trials/{id}` | — | `{id, type, state, imageUrl?, sourceUrl?, scale?, sources?, roi, ms, error?}` — poll an async trial |
| POST | `/api/alternate` | `{imagePath, cameraEsn, sessionName?, ..., roi?}` | `{id, state, imageUrl, sources[], ms}` — holistic (synchronous) |
| POST | `/api/history` | `{}` | `{records[]}` — successful trials, newest first |
| POST | `/api/chat` | `{messages[], context}` | `{reply, actions[]}` — Brivo (Gemini) agent |
| POST | `/api/auth` | `{username, password}` | signup if new else login; sets auth cookie |
| GET | `/api/me` | — | current user (from cookie) or 401 |
| POST | `/api/logout` | — | clears the auth cookie |
| POST | `/api/sessions` | `{name, authKey}` | store a session for the user (24h) |
| DELETE | `/api/trials/{id}` | — | delete one trial + its output file (hidden admin) |
| DELETE | `/api/trials` | — | wipe all trials + output files (hidden admin) |
| GET | `/api/health` | — | `{status:"ok"}` |

`roi` is normalized `{x, y, w, h}` in `[0,1]` (stored as two-point `coords`).
For `/api/previews`, `direction` is `around` (anchor + N each side), `older`, or
`newer` (paging via the `oldestTs`/`newestTs` cursors). `aroundTs` is an EEN
timestamp `YYYYMMDDhhmmss.fff` (UTC); empty = latest. `authKey` is optional on all
EEN endpoints — if omitted, the key stored on the session is used.

> The legacy `POST /api/frames` (dummy synthesized window, `internal/camera`)
> remains registered as a fallback but is no longer used by the UI.

---

## Brivo — the AI voice assistant (Gemini)

Brivo is an app-wide voice agent (Google Gemini) that understands free speech and
drives the UI: create a session, select a frame, draw an ROI, run Super-Res /
Holistic / Super-Saiyan 3D, open history. Tap the mic once for a hands-free
conversation, or type in the panel.

**Every collaborator uses their own free Gemini key.** The key lives only in
`backend/.env` (gitignored) — it is never committed or shared:

```bash
# 1. get a free key (no billing needed): https://aistudio.google.com/apikey
# 2. create your local env file from the template
cp backend/.env.example backend/.env
# 3. edit backend/.env → set GEMINI_API_KEY=<your key>
#    (free tier: GEMINI_MODEL=gemini-2.5-flash-lite has the biggest free quota;
#     if you ever see "quota exceeded", switch to gemini-flash-latest)
# 4. start the backend — it auto-loads backend/.env
cd backend && LUMINA_ADDR=:8090 go run .   # logs "Brivo agent enabled"
```

Without a key, Brivo still loads but says "my AI brain isn't configured yet" — the
rest of the app works normally. For Docker, add the key to the `app` service via
`env_file: backend/.env` or an `environment:` entry.

## Hidden admin delete

Delete controls are hidden by default. On any page (outside a text field), **type
the word `delete`** to toggle admin mode: the History gallery then shows a trash
button on each result (on hover) and a **Delete all** button. Type `delete` again
(or click the banner ✕) to hide them. State is per browser tab (`sessionStorage`).

> These endpoints are unauthenticated — fine for internal/demo use; gate them
> behind auth before any real deployment.

---

## What's dummy vs real

- **Cameras & preview frames** (`internal/brivo`): **real** — this package is the
  reusable EEN pipeline. `Cameras(authKey)` lists the account's cameras (legacy
  `/g/device/list` cookie auth on the cluster host derived from the `cXXX~` key
  prefix); `Archiver(esn)` polls the archiver health API and picks the highest-score
  node (5-min cached); `FetchPreview(...)` downloads `/asset/prev|next/image.jpeg`
  and reads the `x-ee-timestamp` / `x-ee-prev` / `x-ee-next` headers to walk frames.
  Downloaded JPEGs are stored under `data/sessions/{id}/images/`. The old dummy
  synthesizer in `internal/camera` is kept only for the legacy `/api/frames` route.
- **Super-resolution** (`internal/model`): still a **stand-in**. `DummyUpscaler`
  regenerates *generated* `.png` scenes at high resolution (a soft source can't be
  sharpened into detail), and for **real `.jpg` previews** falls back to a load →
  crop → sharpen-upscale pass. Output is written to `data/outputs/`. **Later:**
  implement the `Upscaler` interface with a real model and swap it in `NewEngine`.
- **Holistic** (`internal/model`): derives co-located cameras from the ESN and
  composites enhanced views. **Later:** resolve the real camera set for the location
  and fuse their frames.

---

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `LUMINA_ADDR` | `:8080` | listen address |
| `LUMINA_DATA_DIR` | `data` | root for `captures/` and `outputs/` image files |
| `LUMINA_FRONTEND_DIR` | _(empty)_ | built UI dir; serves the SPA when set |
| `LUMINA_SR_SCALE` | `4` | super-resolution upscale factor |
| `LUMINA_CAMERA_API` | _(empty)_ | optional override for the camera/VMS base URL (unused by `brivo`, which derives the cluster host from the auth key's `cXXX~` prefix) |
| `LUMINA_CAMERA_AUTHKEY` | _(empty)_ | optional fallback auth key (normally the key comes from the user's session) |
| `DATABASE_URL` | `postgres://lumina:lumina@localhost:5433/lumina?sslmode=disable` | Postgres connection |
| `LUMINA_AUTH_SECRET` | `lumina-dev-secret-change-me` | signs the login cookie (set in prod) |
| `GEMINI_API_KEY` | _(empty)_ | Brivo AI assistant — free key from Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model — use `gemini-2.5-flash-lite` (biggest free quota) |

---

## Project structure

```
hackathon/
├── docker-compose.yml      # postgres + app (full stack)
├── Dockerfile              # multi-stage: build UI + API → single image
├── scripts/dev.sh          # local dev: Postgres + backend + frontend together
├── frontend/               # React + Vite UI
│   ├── src/
│   │   ├── pages/          # Landing, NewSession, CameraSelect, Workspace, History
│   │   ├── components/     # Filmstrip, RoiCanvas, ResultViewer, Compare, ...
│   │   ├── context/        # SessionContext (session + camera + hidden-admin listener)
│   │   └── api/            # client.js (USE_MOCK flag) + mock.js
│   └── vite.config.js      # dev proxy → backend
└── backend/                # Go API + image pipeline
    ├── main.go
    └── internal/
        ├── config/ types/ imaging/ brivo/ camera/ model/ agent/ hires/ server/
        └── store/  (image layout + Postgres: models, repo, migrations/*.sql)
```

---

## How to run

> **Ports on this machine:** `5432` and `8080` are already used by other services,
> so this project uses **Postgres host `5433`** and the **Docker app on `8088`** /
> **local dev backend on `8090`**. Adjust via the env vars above if needed.

### Option A — Everything with Docker (recommended, one command)

Requires Docker + Docker Compose. Builds the UI and API, runs Postgres, applies
migrations on startup, and serves UI + API from one origin.

```bash
docker compose up --build
```

Then open **http://localhost:8088**. Stop with `docker compose down` (add `-v` to
also drop the database + image volumes).

### Option B — Local development (one script, hot reload)

Requires Docker (for Postgres only), Go 1.24+, and Node 18+.

```bash
./scripts/dev.sh
```

This starts Postgres in Docker, installs frontend deps if needed, runs the Go
backend on `:8090`, and the Vite dev server on **http://localhost:5173**.
Ctrl-C stops the backend and frontend (Postgres keeps running; `docker compose down`
to stop it).

### Option C — Manual (run each piece yourself)

**1. Database**

```bash
docker compose up -d postgres          # Postgres on host :5433
```

**2. Backend** (Go 1.24+)

```bash
cd backend
go mod download                        # first time
cp .env.example .env                   # then add your own GEMINI_API_KEY (see "Brivo" below)
LUMINA_ADDR=:8090 go run .             # API on :8090; runs migrations on startup
```

> 🔑 To enable the Brivo AI assistant, put **your own** free Gemini key in
> `backend/.env`. See [Brivo — the AI voice assistant](#brivo--the-ai-voice-assistant-gemini).
> The app runs fine without it (Brivo just says it's not configured).

**3. Frontend** (Node 18+)

```bash
cd frontend
npm install                            # first time
npm run dev                            # UI on http://localhost:5173 (proxies → :8090)
```

The dev frontend talks to the real backend because `USE_MOCK = false` in
`frontend/src/api/client.js`. Set it to `true` to run the UI standalone with offline
mock data (no backend/DB needed).

### Option D — Production single binary (no Docker)

```bash
cd frontend && npm run build           # → frontend/dist
cd ../backend && go build -o lumina .
LUMINA_FRONTEND_DIR=../frontend/dist \
  DATABASE_URL=postgres://lumina:lumina@localhost:5433/lumina?sslmode=disable \
  ./lumina                             # serves UI + API on :8080 (needs Postgres)
```
