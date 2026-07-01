import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Cctv, Clock, Wand2, Layers, Square, XCircle, ImageIcon, Loader2, LayoutGrid, Sparkles } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import Filmstrip from '../components/Filmstrip.jsx'
import RoiCanvas from '../components/RoiCanvas.jsx'
import ResultViewer from '../components/ResultViewer.jsx'
import CommandView from '../components/CommandView.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { superResolve, alternateOperation, fetchPreviews, imageURL } from '../api/client.js'
import { useImageCaption } from '../hooks/useImageCaption.js'

const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

// Friendly messages for the async super-res states.
const STATE_MSG = {
  CREATED: 'Queued — starting up…',
  PROCESSING: "Enhancing — we're working on it…",
  SUCCESS: 'Done!',
  FAILURE: 'Failed',
}

const PREVIEW_NEIGHBORS = 6 // frames per side fetched on open / scroll

// Human label from an EEN timestamp (YYYYMMDDhhmmss.fff, UTC).
function eenLabel(ts) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(ts || '')
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : ts || ''
}

// Map an API preview {imageId, ts} to a filmstrip frame.
function previewToFrame(sessionId, p) {
  return {
    id: p.imageId,
    path: `sessions/${sessionId}/images/${p.imageId}.jpeg`, // source path for super-res
    thumb: imageURL(p.imageId),
    timestamp: p.ts,
    label: eenLabel(p.ts),
  }
}

export default function Workspace() {
  const nav = useNavigate()
  const { session, camera, addHistory, commandQueue, shiftCommand, dispatchCommand, setWorkspaceStatus } = useSession()

  const [frames, setFrames] = useState([])
  const [cursors, setCursors] = useState(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingLeft, setLoadingLeft] = useState(false)
  const [loadingRight, setLoadingRight] = useState(false)

  const [selected, setSelected] = useState(null)
  const [roi, setRoi] = useState(null)
  const [mode, setMode] = useState('super_res') // 'super_res' | 'holistic'
  const [result, setResult] = useState(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [resultError, setResultError] = useState(null)
  const [procNote, setProcNote] = useState('') // live async status message
  // Command View: show the holistic result as a synchronized multi-camera wall.
  const [commandView, setCommandView] = useState(false)

  const seenIds = useRef(new Set())
  // Once a direction returns no new frames, stop asking (prevents the auto-fill
  // loop from hammering a dry edge, e.g. "newer" when already at the latest).
  const exhausted = useRef({ left: false, right: false })

  // Gemini vision caption for the frame currently on the stage.
  const { caption: frameCaption, state: captionState } = useImageCaption(selected?.id, !!selected)

  // Route guards: need a session (id) and a selected camera.
  useEffect(() => {
    if (!session) nav('/new', { replace: true })
    else if (!camera) nav('/cameras', { replace: true })
  }, [session, camera, nav])

  // Initial load: fetch previews around the chosen moment (or latest) and
  // auto-select the anchor frame so a preview is visible right away.
  useEffect(() => {
    if (!session || !camera) return
    let alive = true
    setInitialLoading(true)
    // Fresh camera → reset the de-dupe set and edge-exhaustion flags.
    seenIds.current = new Set()
    exhausted.current = { left: false, right: false }
    fetchPreviews({ sessionId: session.id, cameraEsn: camera.esn, aroundTs: camera.anchorTs || '', direction: 'around', count: PREVIEW_NEIGHBORS })
      .then((res) => {
        if (!alive) return
        const fr = (res.previews || []).map((p) => previewToFrame(session.id, p))
        fr.forEach((f) => seenIds.current.add(f.id))
        setFrames(fr)
        setCursors({ left: res.oldestTs, right: res.newestTs })
        if (fr.length) selectFrame(fr[Math.floor(fr.length / 2)])
      })
      .catch((e) => setResultError(e.message))
      .finally(() => alive && setInitialLoading(false))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, camera])

  const loadMore = useCallback(
    async (direction) => {
      if (!cursors) return
      if (exhausted.current[direction]) return
      if (direction === 'left' && loadingLeft) return
      if (direction === 'right' && loadingRight) return
      direction === 'left' ? setLoadingLeft(true) : setLoadingRight(true)
      try {
        const res = await fetchPreviews({
          sessionId: session.id,
          cameraEsn: camera.esn,
          aroundTs: direction === 'left' ? cursors.left : cursors.right,
          direction: direction === 'left' ? 'older' : 'newer',
          count: PREVIEW_NEIGHBORS,
        })
        const fresh = (res.previews || []).map((p) => previewToFrame(session.id, p)).filter((f) => !seenIds.current.has(f.id))
        fresh.forEach((f) => seenIds.current.add(f.id))
        if (fresh.length) {
          setFrames((prev) => (direction === 'left' ? [...fresh, ...prev] : [...prev, ...fresh]))
          setCursors((c) => ({
            left: direction === 'left' ? res.oldestTs : c.left,
            right: direction === 'right' ? res.newestTs : c.right,
          }))
        } else {
          // Dry edge — no more frames this way; stop the auto-fill from retrying.
          exhausted.current[direction] = true
        }
      } finally {
        direction === 'left' ? setLoadingLeft(false) : setLoadingRight(false)
      }
    },
    [cursors, session, camera, loadingLeft, loadingRight],
  )

  const selectFrame = (f) => {
    setSelected(f)
    setRoi(null)
    setResult(null)
    setResultError(null)
    setCommandView(false)
  }

  // Standard 2D ops (Super-Res / Gemini / Holistic) — exit Command View first.
  const run2D = (op, engine) => {
    setCommandView(false)
    runOp(op, engine)
  }

  // Command View: toggle the multi-camera wall. It fetches the real co-located
  // cameras itself (by EEN location), so no holistic run is needed.
  const runCommandView = () => setCommandView((v) => !v)

  const runOp = useCallback(
    async (op, engine) => {
      if (!selected) return
      setMode(op)
      setResultLoading(true)
      setResultError(null)
      setResult(null)
      setProcNote(op === 'holistic' ? '' : engine === 'gemini' ? 'Asking Gemini…' : 'Queued…')
      try {
        const params = {
          imagePath: selected.path,
          cameraEsn: camera.esn,
          sessionName: session.name,
          frameTimestamp: selected.timestamp,
          frameLabel: selected.label,
          roi,
          engine, // '' | 'dummy' | 'gemini' (Nano Banana) — ignored for holistic
        }
        // Super-res is async: submit → poll → SUCCESS. Holistic is synchronous.
        const res =
          op === 'holistic'
            ? await alternateOperation(params)
            : await superResolve(params, (state) => setProcNote(STATE_MSG[state] || state))
        setResult(res)
        addHistory({
          // full payload so the History gallery can render the viewer offline
          ...res,
          createdAt: new Date().toISOString(),
          sessionName: session.name,
          cameraEsn: camera.esn,
          framePath: selected.path,
          frameLabel: selected.label,
          roi,
          thumb: res.imageUrl,
        })
      } catch (err) {
        setResultError(err.message || 'Inference failed')
      } finally {
        setResultLoading(false)
        setProcNote('')
      }
    },
    [selected, roi, session, camera, addHistory],
  )

  // Re-run automatically when the ROI changes after a result already exists,
  // so source preview and result stay in sync.
  const lastRoiRun = useRef(null)
  useEffect(() => {
    if (result && selected && JSON.stringify(roi) !== JSON.stringify(lastRoiRun.current)) {
      lastRoiRun.current = roi
      runOp(mode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roi])

  // Publish live status so Goku (the agent) knows the current workspace state.
  useEffect(() => {
    setWorkspaceStatus({ frameSelected: !!selected, frameCount: frames.length, hasResult: !!result, mode })
    return () => setWorkspaceStatus({})
  }, [selected, frames.length, result, mode, setWorkspaceStatus])

  // Consume Goku's command queue one-by-one (order preserved across renders).
  useEffect(() => {
    if (!commandQueue.length) return
    const cmd = commandQueue[0]
    const mid = () => frames[Math.floor(frames.length / 2)]
    // If an enhance is requested with no frame selected, pick the middle frame
    // first and re-queue the command for the next cycle (when state has updated).
    const ensureFrame = () => {
      if (!selected && frames.length) { selectFrame(mid()); dispatchCommand(cmd); shiftCommand(); return false }
      return true
    }
    switch (cmd.type) {
      case 'select_frame': {
        const pos = cmd.params?.position
        let idx = typeof cmd.params?.index === 'number' ? cmd.params.index : 0
        if (pos === 'last') idx = frames.length - 1
        else if (pos === 'middle') idx = Math.floor(frames.length / 2)
        const f = frames[Math.max(0, Math.min(idx, frames.length - 1))]
        if (f) selectFrame(f)
        shiftCommand()
        break
      }
      case 'set_roi': {
        const { x, y, w, h } = cmd.params || {}
        if ([x, y, w, h].every((n) => typeof n === 'number')) setRoi({ x, y, w, h })
        shiftCommand()
        break
      }
      case 'clear_roi': setRoi(null); shiftCommand(); break
      case 'super_res': if (ensureFrame()) { run2D('super_res', cmd.params?.engine); shiftCommand() } break
      case 'gemini_enhance': if (ensureFrame()) { run2D('super_res', 'gemini'); shiftCommand() } break
      case 'holistic': if (ensureFrame()) { run2D('holistic'); shiftCommand() } break
      case 'command_view': if (ensureFrame()) { runCommandView(); shiftCommand() } break
      default: shiftCommand(); break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandQueue])

  if (!session || !camera) return null

  return (
    <motion.div className="ws" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.3 }}>
      <header className="ws-top">
        <div className="ws-top-left">
          <button className="btn btn-ghost" onClick={() => nav('/cameras')}><ArrowLeft size={18} /></button>
          <Logo size={32} withWordmark={false} />
          <div className="ws-session">
            <strong>{camera.name || session.name}</strong>
            <div className="ws-session-meta">
              <span><Cctv size={12} /> {camera.esn}</span>
              <span><Clock size={12} /> {camera.anchorTs ? eenLabel(camera.anchorTs) : 'Latest'}</span>
            </div>
          </div>
        </div>
        <button className="btn" onClick={() => nav('/history')}>History</button>
      </header>

      <div className="ws-body">
        <section className="ws-stage">
          {commandView && selected ? (
            <>
              <CommandView
                sessionId={session.id}
                cameraEsn={camera.esn}
                aroundTs={selected.timestamp}
                moment={selected.label}
              />
              <button className="ss-exit" onClick={() => setCommandView(false)}><XCircle size={15} /> Exit</button>
            </>
          ) : selected ? (
            <RoiCanvas src={selected.thumb} roi={roi} onChange={setRoi} />
          ) : initialLoading ? (
            <div className="ws-stage-empty">
              <Loader2 size={30} className="spin-ico" />
              <h3>Loading previews…</h3>
              <p>Pulling frames around this moment from the camera.</p>
            </div>
          ) : (
            <div className="ws-stage-empty">
              <div className="ws-empty-ico"><ImageIcon size={30} /></div>
              <h3>No frames available</h3>
              <p>This camera has no footage at this time. Try another camera or time.</p>
            </div>
          )}
          {selected && !commandView && (
            <div className="ws-stage-foot">
              <div className="ws-stage-foot-row">
                <span className="chip mono">{selected.label}</span>
                <span className="ws-stage-path">{selected.path}</span>
              </div>
              <div className="ws-caption">
                <Sparkles size={13} />
                {frameCaption ? (
                  <span>{frameCaption}</span>
                ) : captionState === 'FAILURE' ? (
                  <span className="ws-caption-muted">No description available.</span>
                ) : (
                  <span className="ws-caption-muted">Analyzing the scene…</span>
                )}
              </div>
            </div>
          )}
        </section>

        <AnimatePresence>
          {selected && (
            <motion.aside
              className="ws-panel glass"
              initial={{ x: 60, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 60, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 220, damping: 26 }}
            >
              <div className="ws-panel-scroll">
                <span className="label-eyebrow">Enhance</span>
                <h2 className="ws-panel-title">Region of interest</h2>

                <div className="roi-status">
                  {roi ? (
                    <>
                      <Square size={15} />
                      <span className="mono">
                        x{Math.round(roi.x * 100)} y{Math.round(roi.y * 100)} · {Math.round(roi.w * 100)}×{Math.round(roi.h * 100)}
                      </span>
                      <button className="roi-clear" onClick={() => setRoi(null)}><XCircle size={15} /> Clear</button>
                    </>
                  ) : (
                    <span className="roi-status-empty">Full frame · draw a box on the image to focus</span>
                  )}
                </div>

                <div className="ws-actions">
                  <button className={`ws-action ${!commandView && mode === 'super_res' && result && result.engine !== 'gemini' ? 'active' : ''}`} onClick={() => run2D('super_res', 'dummy')} disabled={resultLoading}>
                    <div className="ws-action-ico"><Wand2 size={20} /></div>
                    <div className="ws-action-txt"><strong>Super-Res</strong><span>Fast built-in upscale to high resolution</span></div>
                  </button>
                  <button className={`ws-action gm-action ${!commandView && mode === 'super_res' && result && result.engine === 'gemini' ? 'active' : ''}`} onClick={() => run2D('super_res', 'gemini')} disabled={resultLoading}>
                    <div className="ws-action-ico gm"><Sparkles size={20} /></div>
                    <div className="ws-action-txt"><strong>Gemini Enhance</strong><span>AI high-res via Gemini “Nano Banana”</span></div>
                  </button>
                  <button className={`ws-action hol-action ${!commandView && mode === 'holistic' && result ? 'active' : ''}`} onClick={() => run2D('holistic')} disabled={resultLoading}>
                    <div className="ws-action-ico alt"><Layers size={20} /></div>
                    <div className="ws-action-txt"><strong>Holistic View</strong><span>Fuse all cameras on this location</span></div>
                  </button>
                  <button className={`ws-action cv-action ${commandView ? 'active' : ''}`} onClick={runCommandView}>
                    <div className="ws-action-ico cv"><LayoutGrid size={20} /></div>
                    <div className="ws-action-txt">
                      <strong>Command View {commandView ? '· ON' : ''}</strong>
                      <span>Every camera at this location, live, as a wall</span>
                    </div>
                    <Cctv size={16} className="cv-corner" />
                  </button>
                </div>

                <div className="ws-result">
                  <ResultViewer mode={mode} loading={resultLoading} note={procNote} result={result} error={resultError} />
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <footer className="ws-foot">
        <Filmstrip
          frames={frames}
          selectedId={selected?.id}
          onSelect={selectFrame}
          onNeedMore={loadMore}
          loadingLeft={loadingLeft}
          loadingRight={loadingRight}
        />
      </footer>

      <style>{`
        .ws { flex: 1; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        .ws-top { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .ws-top-left { display: flex; align-items: center; gap: 14px; }
        .ws-session { display: flex; flex-direction: column; line-height: 1.25; }
        .ws-session strong { font-size: 15px; }
        .ws-session-meta { display: flex; gap: 14px; font-size: 12px; color: var(--text-2); }
        .ws-session-meta span { display: inline-flex; align-items: center; gap: 5px; }
        .ws .spin-ico { animation: spin .7s linear infinite; }

        .ws-body { flex: 1; display: flex; gap: 16px; padding: 16px 22px 0; min-height: 0; }
        .ws-stage { flex: 1; min-width: 0; position: relative; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
        .ws-stage-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 8px; color: var(--text-1); }
        .ws-stage-empty h3 { font-size: 18px; font-weight: 700; }
        .ws-stage-empty p { font-size: 13px; color: var(--text-2); }
        .ws-empty-ico { width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-2); margin-bottom: 8px; border: 1px solid rgba(124,92,255,.25); }
        .ws-stage-foot { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; pointer-events: none; }
        .ws-stage-foot-row { display: flex; align-items: center; gap: 10px; }
        .ws-stage-path { font-family: var(--mono); font-size: 11px; color: var(--text-2); background: rgba(0,0,0,.5); padding: 4px 9px; border-radius: 6px; }
        .ws-caption { max-width: min(560px, 90%); display: flex; align-items: flex-start; gap: 7px; font-size: 12.5px; line-height: 1.45; color: #eaeaff; background: rgba(10,10,20,.62); backdrop-filter: blur(8px); border: 1px solid var(--border); padding: 8px 11px; border-radius: 9px; }
        .ws-caption svg { flex-shrink: 0; margin-top: 2px; color: var(--accent-2); }
        .ws-caption-muted { color: var(--text-2); font-style: italic; }

        .ws-panel { width: 440px; flex-shrink: 0; border-radius: var(--radius); overflow: hidden; }
        .ws-panel-scroll { height: 100%; overflow-y: auto; padding: 22px; }
        .ws-panel-title { font-size: 20px; font-weight: 800; letter-spacing: -.5px; margin: 6px 0 16px; }
        .roi-status { display: flex; align-items: center; gap: 9px; padding: 11px 13px; border-radius: var(--radius-sm); background: rgba(0,0,0,.25); border: 1px solid var(--border); font-size: 13px; min-height: 44px; }
        .roi-status .mono { font-family: var(--mono); color: var(--accent-2); }
        .roi-status-empty { color: var(--text-2); }
        .roi-clear { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--text-1); font-size: 12px; }
        .roi-clear:hover { color: var(--danger); }

        .ws-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0 22px; }
        .ws-action { display: flex; flex-direction: column; gap: 10px; text-align: left; padding: 16px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); transition: all .18s ease; }
        .ws-action:hover:not(:disabled) { border-color: var(--border-strong); transform: translateY(-2px); background: var(--surface-hover); }
        .ws-action.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
        .ws-action:disabled { opacity: .5; cursor: wait; }
        .ws-action-ico { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-grad); color: #fff; }
        .ws-action-ico.alt { background: linear-gradient(135deg, #4ad6ff, #3ddc97); }
        .ws-action-ico.gm { background: linear-gradient(135deg, #ffd454, #a855f7 60%, #4285f4); color: #fff; }
        .gm-action.active { border-color: rgba(168,85,247,.6); box-shadow: 0 0 0 2px rgba(168,85,247,.22); }
        .hol-action { grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 14px; }

        /* Command View: full-width action that opens the multi-camera wall */
        .cv-action { position: relative; grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 14px; overflow: hidden; }
        .cv-action.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
        .ws-action-ico.cv { background: linear-gradient(135deg, #4ad6ff, #7c5cff); color: #fff; }
        .cv-corner { position: absolute; right: 12px; top: 12px; color: var(--text-2); }

        /* Command View exit button (over the stage) */
        .ss-exit { position: absolute; top: 12px; right: 12px; z-index: 5; display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 10px; color: var(--text-0);
          background: rgba(0,0,0,.5); border: 1px solid var(--border); backdrop-filter: blur(8px); }
        .ss-exit:hover { background: rgba(0,0,0,.7); border-color: var(--border-strong); }
        .ws-action-txt strong { display: block; font-size: 14px; }
        .ws-action-txt span { font-size: 11px; color: var(--text-2); line-height: 1.4; }

        .ws-result { border-top: 1px solid var(--border); padding-top: 18px; }
        .ws-foot { flex-shrink: 0; padding: 14px 22px 18px; }

        @media (max-width: 1080px) { .ws-panel { width: 360px; } .ws-actions { grid-template-columns: 1fr; } }
      `}</style>
    </motion.div>
  )
}
