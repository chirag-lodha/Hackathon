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

/** Super-resolve a single frame, optionally constrained to an ROI. */
export function superResolve(params) {
  if (USE_MOCK) return mockSuperResolve(params)
  return post('/super-resolve', params)
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
