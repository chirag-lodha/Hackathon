# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Brivo Lumina** — camera super-resolution app. React (Vite) frontend + Go backend
+ Postgres. Enter an account auth key → browse the account's **real Eagle Eye
Networks cameras** → pull a window of preview frames around any moment → draw an
optional ROI → enhance to high-res ("Super-Res") or fuse co-located cameras
("Holistic View"). Each enhancement is a *Trial* persisted in Postgres; each
downloaded preview is an *Image* row. Has **username/password auth** (user-owned
sessions) and **"Brivo"**, an app-wide **Gemini-powered voice agent** that drives
the UI. The live EEN integration lives in `internal/brivo`. See `README.md` for the
full feature/usage write-up.

**Frontend flow:** Login → New Session (name + auth key only) → **Cameras** (grid;
each tile async-downloads its latest preview) → Workspace (filmstrip of previews +
Super-Res/Holistic). `SessionContext` holds `session` `{id,name,authKey}` and the
separately-selected `camera` `{esn,name,anchorTs}`.

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

**Secrets / `.env`:** `config.Load` auto-loads `backend/.env` then `../.env`
(repo root) at startup, and never overrides a value already in the environment.
Put `GEMINI_API_KEY` (and any other secrets) in `backend/.env` — it is gitignored;
copy `backend/.env.example` to start. Do not hardcode keys.

## Port gotcha (this machine)

`5432` and `8080` are occupied by **other** projects here. This repo therefore uses
**Postgres host `5433`**, **dev backend `8090`**, and the **Docker app on `8088`**.
The Go default `LUMINA_ADDR` is still `:8080`; the dev script and compose override it.
The Vite proxy (`frontend/vite.config.js`) targets `:8090` — keep it in sync with
whatever port the dev backend uses.

## Architecture (big picture)

Request flow for an enhancement (read these together to understand it):
`server/handlers.go` → `store` (create Trial via `Repo`, set state) → `model`
(run pipeline) → `store`/`imaging` (write PNG) → Trial updated → JSON response
with a `/files/...` URL. The `store` package is the whole persistence layer:
Postgres (Repo/models/migrations) **and** the on-disk image store. Super-res
runs this pipeline **asynchronously** via the HiRes processor (see below);
holistic runs it inline.

- **Frontend ↔ backend contract** lives in two places that MUST agree:
  `frontend/src/api/client.js` (+ `mock.js`) and `backend/internal/types/types.go`.
  Field names are camelCase JSON on both sides.
- **`frontend/src/api/client.js` has `USE_MOCK`** — when `true`, the UI runs fully
  offline against `mock.js` (no backend/DB needed); when `false` it calls the real
  `/api`. Changing the API contract means updating client.js, mock.js, AND types.go.
- **Image serving:** the backend writes PNGs under `data/{captures,outputs}` and
  serves them at `/files/...`. API responses return URLs, never image bytes. In dev,
  Vite proxies BOTH `/api` and `/files` to the backend.
- **HiRes processor** (`internal/hires`): the async job runner for super-res.
  `hires.New(engine, repo)` is constructed in `main.go` and `Init()` starts a
  single **dispatcher goroutine** that ranges over a buffered channel of `*HiRes`
  (each carries only a `TrialID`). Handlers call `s.hires.Submit(...)`; the
  dispatcher injects deps and calls `execute()`, which spins up its own goroutine
  to load the trial, run the model (branching on `trial.Type`), and persist the
  result. The `Processor` is passed into `server.New` so handlers can reach it.
  Note: `width`/`height` are not persisted on `trials`, so the async poll does not
  return them (add columns + a migration if needed).
- **EEN pipeline (`internal/brivo`) — the REAL camera/preview integration.**
  Reusable, stateless client (auth key passed per call). Key exports: `IsKey` (does
  the key contain `~`), `Cameras(authKey)` (GET `<cluster>/g/device/list`, cluster
  host = `https://<prefix-before-~>.eagleeyenetworks.com`), `Archiver(authKey, esn)`
  (archiver **health API** → highest-score node, 5-min cache), `FetchPreview(authKey,
  archiver, esn, ts, mode)` where `mode` is `PrevMode`/`NextMode` — returns
  `{Bytes, TS, PrevTS, NextTS}` read from the `x-ee-timestamp`/`x-ee-prev`/`x-ee-next`
  headers (this is the walk primitive for the filmstrip). Timestamps are EEN format
  `YYYYMMDDhhmmss.fff` (UTC) — `TimeLayout`, `Now()`, `ParseTS`.
- **Async preview flow (`internal/server/previews.go`):**
  - `POST /api/cameras {sessionId}` → `brivo.Cameras` → per camera create an `images`
    row (`state=PROCESSING`, uuid id), return `{cameras[], images:{esn:imageId}}`,
    and start `downloadPreviewAsync` (goroutine, bounded by `Server.dlSem`) which
    picks the archiver, fetches the latest preview, writes it to
    `sessions/{id}/images/{imageId}.jpeg`, and sets the row `SUCCESS`/`FAILURE`.
  - UI polls `GET /api/image/status?imageId=` then loads `GET /api/images?imageId=`
    (serves the JPEG, or `202` until ready).
  - `POST /api/previews {sessionId, cameraEsn, aroundTs, direction, count}` walks
    prev/next to fetch a window (`around` = anchor + N each side; `older`/`newer` for
    filmstrip paging). Each fetched frame is saved as a SUCCESS `images` row.
  - **Auth key resolution:** `resolveAuthKey(reqKey, sessionID)` prefers a request
    key else falls back to the session's stored key — the frontend normally passes
    only `sessionId`, keeping the key server-side.
- **Dummy boundary (still stand-in):**
  - `internal/camera` (legacy) synthesizes frames per `(ESN, timestamp)`, **softened**
    so the stored frame looks low-res. Now only backs the legacy `/api/frames` route
    (the UI uses `brivo` previews instead). `FetchFrames` ignores the auth key.
  - `internal/model` has an `Upscaler` interface; `DummyUpscaler` simulates detail
    recovery by regenerating the scene at high resolution (the soft source can't be
    sharpened into detail). It derives the scene seed from the capture path
    (`seedFromPath`, which requires a `.png` suffix); **real `.jpg` previews from
    `brivo` fall back to load → crop → sharpen-upscale**. Swap a real model in
    `model.NewEngine`.
  - `imaging.GenerateFrame` uses **fractional** positions so the same seed renders an
    identical composition at any resolution (low-res capture vs high-res output align).
  - `imaging` is pure stdlib (no native deps) — keep it that way so it builds offline.
- **Auth** (`internal/server/auth.go`): `POST /api/auth` is signup-or-login (bcrypt),
  sets a signed HTTP-only cookie `lumina_auth` (`<uid>.<hmac(uid, LUMINA_AUTH_SECRET)>`).
  `GET /api/me` restores the user; `POST /api/sessions` stores a user-owned session
  (name + camera auth key, 24h). Cookies are same-origin (work through the Vite proxy).
- **Brivo voice agent** (`internal/agent`): `POST /api/chat` sends the conversation +
  app context to Gemini and returns `{reply, actions[]}`. Needs `GEMINI_API_KEY` in
  `backend/.env` (gitignored; loaded by `config.loadDotEnv`); use
  `GEMINI_MODEL=gemini-2.5-flash-lite` (biggest free quota). The frontend agent lives
  in `components/VoiceAssistant.jsx` (browser STT/TTS); in-workspace actions flow
  through a **command queue** in `SessionContext` that `Workspace` consumes in order.

## Brivo — the AI agent (`internal/agent` + `/api/chat`)

Brivo is a conversational agent (Google Gemini) that **drives the UI**, not the
backend. `internal/agent` sends the message history + a `Context` snapshot of the
current app state to Gemini with `responseMimeType: application/json`, and parses
back `{reply, actions[]}`. The backend returns that verbatim over `POST /api/chat`;
the **frontend executes the actions** (`create_session`, `select_frame`, `set_roi`,
`super_res`, `holistic`, `super_saiyan`, `open_history`, ...).

- The list of valid action types + their params lives in the `systemPrompt` in
  `internal/agent/agent.go`. Adding a UI capability means updating BOTH that prompt
  AND the action dispatcher in `frontend/src/components/VoiceAssistant.jsx` — they
  must agree on action names and param shapes.
- No key → `Agent.Enabled()` is false and Brivo returns a friendly "not configured"
  reply; the rest of the app works normally. `GEMINI_MODEL` defaults to
  `gemini-2.0-flash` (use `gemini-2.5-flash-lite` for the biggest free quota).
- **Super-Saiyan** is the `super_saiyan` action: renders a holistic result as an
  orbitable 3D scene (`frontend/src/components/Holistic3D.jsx`); requires a prior
  holistic run.

## Database conventions (important)

- **Postgres access lives in the `store` package** (alongside the on-disk image
  layout): connection + migrations in `store/postgres.go`, the `Trial` model in
  `store/models.go`, the `Repo` in `store/repo.go`. `store` is the single
  persistence layer for both files and the database.
- **GORM for queries, golang-migrate for schema — NEVER `AutoMigrate`.** Schema is
  explicit SQL in `backend/internal/store/migrations/*.sql`, embedded via `go:embed`
  and applied on startup by `store.Migrate`. To change the schema, add a new numbered
  `*.up.sql`/`*.down.sql` pair; do not edit applied migrations.
- Tables: **`trials`** (one row per enhancement), **`users`** (bcrypt), **`sessions`**
  (user_id, name, auth_key, expires_at = +24h), **`images`** (one row per downloaded
  preview). Migrations: `000001_init` (trials), `000002_auth` (users, sessions),
  `000003_images` (images). `trials`/`users`/`sessions` use `gorm.Model`
  (`id/created_at/updated_at/deleted_at` — do not redeclare). **`images` is the
  exception:** its `id` is a **TEXT uuid** (not a bigint) so the frontend can
  reference a download before it completes — set it via `store.NewUUID()`, don't use
  `gorm.Model`. Repo helpers: `CreateImage`, `GetImage`, `ImageDone(id,path,eenTs)`,
  `ImageFailed(id,msg)`.
- **State lifecycle**: `CREATED` → `PROCESSING` → `SUCCESS`/`FAILURE`.
  - **`super_res` is async** (return-then-poll): `POST /api/super-resolve` creates
    the trial as `CREATED`, enqueues it on the **HiRes processor** (`internal/hires`),
    and returns **`202`** immediately. The processor drives it to `PROCESSING` then
    `SUCCESS`/`FAILURE` in the background; the client polls **`GET /api/trials/{id}`**
    (`TrialStatusResponse`) for the result. See the HiRes bullet under Architecture.
  - **`holistic` is still synchronous** — `POST /api/alternate` runs the model inline
    and returns the result in one response.
- **ROI is stored as two-point coords `[{x,y},{x,y}]`** (normalized) in the `coords`
  jsonb column, but the API wire format is `{x,y,w,h}`. Conversion happens in
  `internal/store/repo.go` (`CoordsFromROI` / `ROIFromCoords`) — don't leak one format
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
