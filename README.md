# Brivo Lumina

**AI camera super-resolution.** Pull a ±5-second window of frames from a camera,
draw an optional region of interest, and enhance it to high resolution — or build
a **holistic** multi-camera fused view of the same location. Every action is
recorded as a *Trial* in Postgres and browsable in a history gallery.

> Status: fully working end-to-end with **dummy** frames + a **stand-in**
> super-resolution model. The real camera fetch and the real model plug in behind
> clean interfaces (see [What's dummy vs real](#whats-dummy-vs-real)).

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

1. **Start a session** — give it a name and a camera ESN (plus an optional moment
   in time and auth key).
2. **Browse frames** — the backend returns a ±5s window of preview frames around
   that moment; scroll the filmstrip left/right to fetch more in 5-second sets.
3. **Enhance** — pick a frame, optionally draw a region of interest, then run:
   - **Super-Res** — enhance that frame (or just the ROI) to high resolution.
   - **Holistic View** — fuse every camera pointing at the same location into one
     wide, high-res composite.
4. **Review history** — every enhancement is stored and shown in a gallery you can
   scroll through and open full-screen (before/after compare for super-res, the
   composite + contributing cameras for holistic).

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
   Browser      │                React SPA (Vite)              │
  ┌────────┐    │  Landing → New Session → Workspace → History │
  │  UI    │◄──►│  ROI draw · filmstrip · compare slider · ... │
  └────────┘    └───────────────┬──────────────────────────────┘
       │ HTTP (JSON + image URLs)│
       ▼                         ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                     Go backend (net/http)                    │
  │  server/   router · CORS · logging · SPA + /files static     │
  │  camera/   frame source  (dummy now → real ESN/authKey API)  │
  │  model/    Upscaler iface · DummyUpscaler · holistic fusion  │
  │  imaging/  resize · crop · enhance · composite (pure stdlib)  │
  │  store/    on-disk images  (data/captures, data/outputs)     │
  │  db/       GORM repo  +  golang-migrate (embedded SQL)        │
  └───────────────┬─────────────────────────────┬────────────────┘
                  │                             │
                  ▼                             ▼
        ┌──────────────────┐         ┌────────────────────────┐
        │  Postgres        │         │  Filesystem / volume    │
        │  trials table    │         │  captures/  outputs/    │
        └──────────────────┘         └────────────────────────┘
```

**Request flow for an enhancement:**

1. UI `POST /api/super-resolve` with the frame path + optional ROI.
2. Handler creates a **Trial** row (`state = CREATED`), flips it to `PROCESSING`.
3. `model.DummyUpscaler` loads the source image → crops the ROI → bilinear-upscales
   → applies a sharpen/contrast "enhance" pass → writes a high-res PNG to
   `data/outputs/`.
4. Trial updated to `SUCCESS` with the result path/URL (or `FAILURE` + error).
5. Response returns the image URL; the UI renders it. The image bytes are served
   from `/files/...`.

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

1. **Landing** — choose **New capture** or **History**.
2. **New session** — *Session name* and *Camera ESN* are required; *Date & time*
   (defaults to now) and *Auth key* are optional. Submit to fetch frames.
3. **Workspace**
   - The **filmstrip** at the bottom holds the ±5s window; scroll to either edge to
     load the next 5-second set in that direction.
   - Click a frame to load it into the stage. **Drag on the image** to draw an ROI
     rectangle (drag again to redraw; *Clear* to remove → enhances the full frame).
   - Click **Super-Res** or **Holistic View**. The result appears in the right
     panel. **Changing the ROI re-runs the current operation automatically.**
   - Super-res shows a **before/after compare slider**; holistic shows the fused
     image plus thumbnails of the contributing cameras.
4. **History** — a gallery of all successful conversions (newest first), with filter
   tabs (All / Super-Res / Holistic). Click any card to open the **full-screen
   viewer**; navigate with the on-screen arrows or **←/→**, close with **Esc**.

---

## Features (ready)

- Landing, New Session (with validation), Workspace, and History pages
- ±5s frame window with **infinite filmstrip paging** (both directions, de-duped)
- **ROI drawing** on the source frame (normalized, resolution-independent)
- **Super-Res** and **Holistic View** operations, with auto re-run on ROI change
- **Before/after compare slider** and holistic composite + source cameras
- **History gallery** + full-screen lightbox with keyboard navigation
- **Trials persisted in Postgres** with a `CREATED → PROCESSING → SUCCESS/FAILURE`
  lifecycle; ROI stored as two-point coords `[{x,y},{x,y}]`
- **Hidden admin delete** (type `delete`) — per-item + delete-all, removes rows and
  output files
- Real image pipeline (load → crop → upscale → enhance → save) producing real files
- **Single-binary production mode** and a **one-command Docker stack**

## Pending / roadmap

- **Real camera integration** — fetch actual frames via ESN + auth key (stubbed)
- **Real super-resolution model** — replace `DummyUpscaler` (implement `Upscaler`)
- **Real holistic logic** — resolve the actual co-located cameras and fuse them
- **Async processing** — return `CREATED` immediately and have the UI poll `state`
  (the schema already supports it; today the op is synchronous)
- **Auth / users** — no login yet; `trials` has no `user_id` (reserved for later).
  The delete endpoints are *hidden*, **not secured**
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

Schema is defined in `backend/internal/db/migrations/000001_init.up.sql` and applied
by golang-migrate on startup. The GORM struct in `backend/internal/db/models.go`
maps to it for queries only.

---

## API reference

All endpoints are JSON. Generated images are served under `/files/...`.

| Method | Endpoint | Body | Returns |
|--------|----------|------|---------|
| POST | `/api/frames` | `{sessionName, cameraEsn, anchorTime?, authKey?, direction, cursor?}` | `{frames[], cursors}` — ±5s window |
| POST | `/api/super-resolve` | `{imagePath, cameraEsn, sessionName?, frameTimestamp?, frameLabel?, roi?}` | `{id, state, imageUrl, sourceUrl, width, height, scale, ms}` |
| POST | `/api/alternate` | `{imagePath, cameraEsn, sessionName?, ..., roi?}` | `{id, state, imageUrl, sources[], ms}` — holistic |
| POST | `/api/history` | `{}` | `{records[]}` — successful trials, newest first |
| DELETE | `/api/trials/{id}` | — | delete one trial + its output file (hidden admin) |
| DELETE | `/api/trials` | — | wipe all trials + output files (hidden admin) |
| GET | `/api/health` | — | `{status:"ok"}` |

`roi` is normalized `{x, y, w, h}` in `[0,1]` (stored as two-point `coords`).
`direction` is `around` (initial), `left`, or `right` (paging via `cursor`).

---

## Hidden admin delete

Delete controls are hidden by default. On any page (outside a text field), **type
the word `delete`** to toggle admin mode: the History gallery then shows a trash
button on each result (on hover) and a **Delete all** button. Type `delete` again
(or click the banner ✕) to hide them. State is per browser tab (`sessionStorage`).

> These endpoints are unauthenticated — fine for internal/demo use; gate them
> behind auth before any real deployment.

---

## What's dummy vs real

- **Frames** (`internal/camera`): synthesized deterministically per `(ESN, timestamp)`
  and cached to `data/captures/`. **Later:** fetch real frames using the camera ESN
  + auth key — only `camera.ensureFrame` changes.
- **Super-resolution** (`internal/model`): `DummyUpscaler` runs a genuine
  load → crop(ROI) → bilinear upscale → enhance → save pipeline. **Later:** implement
  the `Upscaler` interface with a real model and swap it in `NewEngine`.
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
| `LUMINA_CAMERA_API` | _(empty)_ | upstream camera/VMS base URL (later) |
| `LUMINA_CAMERA_AUTHKEY` | _(empty)_ | default camera auth key (later) |
| `DATABASE_URL` | `postgres://lumina:lumina@localhost:5433/lumina?sslmode=disable` | Postgres connection |

---

## Project structure

```
hackathon/
├── docker-compose.yml      # postgres + app (full stack)
├── Dockerfile              # multi-stage: build UI + API → single image
├── scripts/dev.sh          # local dev: Postgres + backend + frontend together
├── frontend/               # React + Vite UI
│   ├── src/
│   │   ├── pages/          # Landing, NewSession, Workspace, History
│   │   ├── components/     # Filmstrip, RoiCanvas, ResultViewer, Compare, ...
│   │   ├── context/        # SessionContext (+ hidden-admin secret listener)
│   │   └── api/            # client.js (USE_MOCK flag) + mock.js
│   └── vite.config.js      # dev proxy → backend
└── backend/                # Go API + image pipeline
    ├── main.go
    └── internal/
        ├── config/  types/  imaging/  camera/  model/  store/  server/
        └── db/  (models, repo, migrations/*.sql)
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
LUMINA_ADDR=:8090 go run .             # API on :8090; runs migrations on startup
```

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
