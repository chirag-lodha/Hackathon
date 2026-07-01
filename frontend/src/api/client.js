/* ============================================================
   API client. Flip USE_MOCK = false once the Go backend is live.
   Real endpoints (proposed contract for the Go side):
     POST /api/frames            -> { frames[], cursors }
     POST /api/super-resolve     -> { imageUrl, ... }
     POST /api/alternate         -> { imageUrl, sources[] }
   ============================================================ */

import { mockFetchFrames, mockSuperResolve, mockAlternateOperation, mockFetchHistory } from './mock.js'

export const USE_MOCK = false

async function post(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

/**
 * Fetch a ±5s window of frames for a camera.
 * direction: 'around' (initial), 'left', or 'right' (paging via cursor).
 */
export function fetchFrames(params) {
  if (USE_MOCK) return mockFetchFrames(params)
  return post('/frames', params)
}

/** Poll one trial's current state + result. */
export async function getTrial(id) {
  const res = await fetch(`/api/trials/${id}`)
  if (!res.ok) throw new Error(`trial ${id} failed: ${res.status}`)
  return res.json()
}

/**
 * Super-resolve a frame. The backend is asynchronous: it creates the trial,
 * triggers the model, and returns immediately with an id + state=CREATED. We
 * then poll GET /api/trials/{id} until SUCCESS (returns the result) or FAILURE.
 * onState(state) is called on every poll so the UI can show progress.
 */
export async function superResolve(params, onState) {
  if (USE_MOCK) {
    onState?.('PROCESSING')
    return mockSuperResolve(params)
  }
  const submitted = await post('/super-resolve', params) // { id, state: "CREATED" }
  onState?.(submitted.state || 'CREATED')

  const deadline = Date.now() + 90_000 // give up after 90s
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600))
    const t = await getTrial(submitted.id)
    onState?.(t.state)
    if (t.state === 'SUCCESS') return t   // {type, imageUrl, sourceUrl, scale, roi, ms}
    if (t.state === 'FAILURE') throw new Error(t.error || 'Enhancement failed')
  }
  throw new Error('Timed out waiting for the enhancement')
}

/** Build a holistic multi-camera view of the same scene/location. */
export function alternateOperation(params) {
  if (USE_MOCK) return mockAlternateOperation(params)
  return post('/alternate', params)
}

/** All previously-converted results (super-res + holistic) stored server-side. */
export function fetchHistory(params = {}) {
  if (USE_MOCK) return mockFetchHistory(params)
  return post('/history', params)
}

async function del(path) {
  const res = await fetch(`/api${path}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json().catch(() => ({}))
}

/** Hidden admin: permanently delete one trial (and its output file). */
export function deleteTrial(id) {
  if (USE_MOCK) return Promise.resolve({ deleted: id })
  return del(`/trials/${id}`)
}

/** Hidden admin: wipe all trials. */
export function deleteAllTrials() {
  if (USE_MOCK) return Promise.resolve({ deleted: 'all' })
  return del('/trials')
}

/** Goku agent: send conversation + app context, get {reply, actions}. */
export function chatAgent(payload) {
  return post('/chat', payload)
}

// ---------- auth ----------

/** Signup-or-login: creates the user if new, else verifies the password. */
export function authSubmit(username, password) {
  return post('/auth', { username, password })
}

/** Current logged-in user, or null if not authenticated. */
export async function fetchMe() {
  const res = await fetch('/api/me')
  if (!res.ok) return null
  return res.json()
}

export function logout() {
  return fetch('/api/logout', { method: 'POST' })
}

/** Persist a named session (camera auth key) against the logged-in user (24h). */
export function createSession(name, authKey) {
  return post('/sessions', { name, authKey })
}

// ---------- cameras & preview images (EEN pipeline) ----------

/** List the session's account cameras; kicks off latest-preview downloads.
 *  Returns { cameras:[{esn,name,location,status,imageId}], images:{esn:imageId} }. */
export function fetchCameras(sessionId) {
  return post('/cameras', { sessionId: String(sessionId) })
}

/** Fetch N preview frames around a camera's frame (walks prev/next).
 *  params: { sessionId, cameraEsn, aroundTs?, direction?, count? } */
export function fetchPreviews(params) {
  return post('/previews', { ...params, sessionId: String(params.sessionId) })
}

/** Cameras sharing the given camera's physical location (Command View wall).
 *  params: { sessionId, cameraEsn, aroundTs? } → { location, cameras:[{esn,name,location,status,imageId}] } */
export function fetchLocationCameras(params) {
  return post('/location-cameras', { ...params, sessionId: String(params.sessionId) })
}

/** Poll a preview/image download's state → { id, state, ts, error }. */
export async function imageStatus(imageId) {
  const res = await fetch(`/api/image/status?imageId=${encodeURIComponent(imageId)}`)
  if (!res.ok) throw new Error(`image status ${imageId}: ${res.status}`)
  return res.json()
}

/** Browser URL to load a downloaded preview image. */
export function imageURL(imageId) {
  return `/api/images?imageId=${encodeURIComponent(imageId)}`
}
