# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Brivo Lumina** — camera super-resolution app. React (Vite) frontend + Go backend
+ Postgres. Pull a ±5s window of camera frames, draw an optional ROI, and enhance
to high-res ("Super-Res") or fuse co-located cameras ("Holistic View"). Each action
is a *Trial* persisted in Postgres. See `README.md` for the full feature/usage write-up.

## Commands

```bash
# Full stack in one container command (UI+API served by the Go binary):
docker compose up --build            # app on :8088, postgres on :5433

# Local dev (hot reload): Postgres + Go backend (:8090) + Vite (:5173)
./scripts/dev.sh

# Backend only (Postgres must be up):
cd backend && LUMINA_ADDR=:8090 go run .
go build ./...                       # compile-check everything

# Frontend only:
cd frontend && npm install && npm run dev   # :5173
npm run build                        # production bundle -> frontend/dist
```

There is **no test suite yet** (no `go test` targets, no frontend tests). Verify
changes by building (`go build ./...`, `npm run build`) and exercising the API with
`curl` or the UI.

## Port gotcha (this machine)

`5432` and `8080` are occupied by **other** projects here. This repo therefore uses
**Postgres host `5433`**, **dev backend `8090`**, and the **Docker app on `8088`**.
The Go default `LUMINA_ADDR` is still `:8080`; the dev script and compose override it.
The Vite proxy (`frontend/vite.config.js`) targets `:8090` — keep it in sync with
whatever port the dev backend uses.

## Architecture (big picture)

Request flow for an enhancement (read these together to understand it):
`server/handlers.go` → `db` (create Trial, set state) → `model` (run pipeline) →
`store`/`imaging` (write PNG) → Trial updated → JSON response with a `/files/...` URL.

- **Frontend ↔ backend contract** lives in two places that MUST agree:
  `frontend/src/api/client.js` (+ `mock.js`) and `backend/internal/types/types.go`.
  Field names are camelCase JSON on both sides.
- **`frontend/src/api/client.js` has `USE_MOCK`** — when `true`, the UI runs fully
  offline against `mock.js` (no backend/DB needed); when `false` it calls the real
  `/api`. Changing the API contract means updating client.js, mock.js, AND types.go.
- **Image serving:** the backend writes PNGs under `data/{captures,outputs}` and
  serves them at `/files/...`. API responses return URLs, never image bytes. In dev,
  Vite proxies BOTH `/api` and `/files` to the backend.
- **Dummy boundary (the part to replace for real data):**
  - `internal/camera` synthesizes frames per `(ESN, timestamp)`, **softened** so the
    stored frame looks low-res (the same capture feeds the filmstrip, main preview,
    and super-res "before" — keep them consistent). Real camera fetch (ESN + auth
    key) goes in `camera.ensureFrame` — marked with `LATER:` comments.
  - `internal/model` has an `Upscaler` interface; `DummyUpscaler` simulates detail
    recovery by regenerating the scene at high resolution (the soft source can't be
    sharpened into detail). It derives the scene seed from the capture path
    (`seedFromPath`); non-generated/real frames fall back to sharpen-upscale. Swap a
    real model in `model.NewEngine`.
  - `imaging.GenerateFrame` uses **fractional** positions so the same seed renders an
    identical composition at any resolution (low-res capture vs high-res output align).
  - `imaging` is pure stdlib (no native deps) — keep it that way so it builds offline.

## Database conventions (important)

- **GORM for queries, golang-migrate for schema — NEVER `AutoMigrate`.** Schema is
  explicit SQL in `backend/internal/db/migrations/*.sql`, embedded via `go:embed` and
  applied on startup by `db.Migrate`. To change the schema, add a new numbered
  `*.up.sql`/`*.down.sql` pair; do not edit applied migrations.
- One table: **`trials`** (one row per enhancement). Uses `gorm.Model` for
  `id/created_at/updated_at/deleted_at` — do not redeclare those columns.
- **State lifecycle** is updated in the handler: `CREATED` → `PROCESSING` →
  `SUCCESS`/`FAILURE`. The op is currently **synchronous** (instant with the dummy
  model); the schema already supports an async return-then-poll flow.
- **ROI is stored as two-point coords `[{x,y},{x,y}]`** (normalized) in the `coords`
  jsonb column, but the API wire format is `{x,y,w,h}`. Conversion happens in
  `internal/db/repo.go` (`CoordsFromROI` / `ROIFromCoords`) — don't leak one format
  into the other.

## Conventions

- React components are self-contained with a co-located `<style>` block (no external
  CSS framework); shared design tokens are CSS variables in `src/styles/global.css`.
- **Hidden admin delete:** typing the word `delete` (outside a text field) toggles
  delete controls — implemented as a keydown sequence listener in
  `src/context/SessionContext.jsx`. The `DELETE /api/trials[...]` endpoints are
  unauthenticated; gate them behind auth before any real deployment.
- Docker app and local dev share the **same Postgres** but **different image stores**
  (named volume vs `backend/data`), so don't run both against the same data at once.
