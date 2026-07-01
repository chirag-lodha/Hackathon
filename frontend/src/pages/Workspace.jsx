import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Cctv, Clock, Wand2, Layers, Square, XCircle, ImageIcon, Zap, Loader2, Box } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import Filmstrip from '../components/Filmstrip.jsx'
import RoiCanvas from '../components/RoiCanvas.jsx'
import ResultViewer from '../components/ResultViewer.jsx'
import Holistic3D from '../components/Holistic3D.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { superResolve, alternateOperation, fetchPreviews, imageURL } from '../api/client.js'

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

const PREVIEW_NEIGHBORS = 3 // frames per side fetched on open / scroll

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
  // Super-Saiyan: show the holistic result as an orbitable 3D scene in the stage.
  const [superSaiyan, setSuperSaiyan] = useState(false)

  const seenIds = useRef(new Set())

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
    setSuperSaiyan(false)
  }

  // Standard 2D ops (Super-Res / Holistic) — exit 3D first.
  const run2D = (op) => {
    setSuperSaiyan(false)
    runOp(op)
  }

  // Super-Saiyan: toggle the 3D holistic stage. Runs holistic if we don't
  // already have a holistic result to feed the scene.
  const runSuperSaiyan = () => {
    if (superSaiyan) {
      setSuperSaiyan(false)
      return
    }
    setSuperSaiyan(true)
    if (!(mode === 'holistic' && result)) runOp('holistic')
  }

  const runOp = useCallback(
    async (op) => {
      if (!selected) return
      setMode(op)
      setResultLoading(true)
      setResultError(null)
      setResult(null)
      setProcNote(op === 'holistic' ? '' : 'Queued…')
      try {
        const params = {
          imagePath: selected.path,
          cameraEsn: camera.esn,
          sessionName: session.name,
          frameTimestamp: selected.timestamp,
          frameLabel: selected.label,
          roi,
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
      case 'super_res': if (ensureFrame()) { run2D('super_res'); shiftCommand() } break
      case 'holistic': if (ensureFrame()) { run2D('holistic'); shiftCommand() } break
      case 'super_saiyan': if (ensureFrame()) { runSuperSaiyan(); shiftCommand() } break
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
          {superSaiyan ? (
            resultLoading || !(result && result.type === 'holistic') ? (
              <div className="ws-stage-empty">
                <div className="ss-orb"><Zap size={28} /></div>
                <h3>Charging Super-Saiyan…</h3>
                <p>Fusing every camera on this location into a 3D scene.</p>
              </div>
            ) : (
              <>
                <Holistic3D result={result} />
                <div className="ss-badge"><Zap size={13} /> Super-Saiyan · 3D</div>
                <button className="ss-exit" onClick={() => setSuperSaiyan(false)}><XCircle size={15} /> Exit 3D</button>
              </>
            )
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
          {selected && !superSaiyan && (
            <div className="ws-stage-foot">
              <span className="chip mono">{selected.label}</span>
              <span className="ws-stage-path">{selected.path}</span>
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
                  <button className={`ws-action ${!superSaiyan && mode === 'super_res' && result ? 'active' : ''}`} onClick={() => run2D('super_res')} disabled={resultLoading}>
                    <div className="ws-action-ico"><Wand2 size={20} /></div>
                    <div className="ws-action-txt"><strong>Super-Res</strong><span>Enhance this frame to high resolution</span></div>
                  </button>
                  <button className={`ws-action ${!superSaiyan && mode === 'holistic' && result ? 'active' : ''}`} onClick={() => run2D('holistic')} disabled={resultLoading}>
                    <div className="ws-action-ico alt"><Layers size={20} /></div>
                    <div className="ws-action-txt"><strong>Holistic View</strong><span>Fuse all cameras on this location</span></div>
                  </button>
                  {mode === 'holistic' && result && (
                    <button className={`ws-action ss-action ${superSaiyan ? 'active' : ''}`} onClick={runSuperSaiyan} disabled={resultLoading}>
                      <div className="ws-action-ico ss"><Zap size={20} /></div>
                      <div className="ws-action-txt">
                        <strong>Super-Saiyan {superSaiyan ? '· ON' : ''}</strong>
                        <span>View this holistic fusion in interactive 3D</span>
                      </div>
                      <Box size={16} className="ss-corner" />
                    </button>
                  )}
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
        .ws-stage-foot { position: absolute; top: 12px; left: 12px; display: flex; align-items: center; gap: 10px; }
        .ws-stage-path { font-family: var(--mono); font-size: 11px; color: var(--text-2); background: rgba(0,0,0,.5); padding: 4px 9px; border-radius: 6px; }

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

        /* Super-Saiyan: full-width golden energy action */
        .ss-action { position: relative; grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 14px; overflow: hidden; }
        .ss-action::before { content: ''; position: absolute; inset: 0; opacity: 0; transition: opacity .25s ease;
          background: radial-gradient(280px 120px at 100% 0%, rgba(255,193,84,.18), transparent 70%); }
        .ss-action:hover::before { opacity: 1; }
        .ss-action.active { border-color: rgba(255,193,84,.6); box-shadow: 0 0 0 2px rgba(255,193,84,.2), 0 0 26px rgba(255,193,84,.25); }
        .ws-action-ico.ss { background: linear-gradient(135deg, #ffd454, #ff8a3c); color: #2a1800; box-shadow: 0 0 18px rgba(255,170,60,.5); }
        .ss-action.active .ws-action-ico.ss { animation: sspulse 1.1s ease-in-out infinite; }
        @keyframes sspulse { 0%,100% { box-shadow: 0 0 14px rgba(255,170,60,.45); } 50% { box-shadow: 0 0 30px rgba(255,170,60,.85); } }
        .ss-corner { position: absolute; right: 12px; top: 12px; color: var(--text-2); }

        /* 3D stage overlays */
        .ss-orb { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 8px;
          background: radial-gradient(circle at 50% 40%, #ffe08a, #ff8a3c); color: #2a1800; box-shadow: 0 0 36px rgba(255,170,60,.7); animation: sspulse 1s ease-in-out infinite; }
        .ss-badge { position: absolute; top: 12px; left: 12px; z-index: 5; display: inline-flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 700; letter-spacing: .3px; padding: 6px 12px; border-radius: 99px; color: #2a1800;
          background: linear-gradient(135deg, #ffd454, #ff8a3c); box-shadow: 0 4px 16px rgba(255,140,60,.4); }
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
