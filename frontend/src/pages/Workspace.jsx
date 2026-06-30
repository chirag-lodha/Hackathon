import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Cctv, Clock, Wand2, Layers, Square, XCircle, ImageIcon } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import Filmstrip from '../components/Filmstrip.jsx'
import RoiCanvas from '../components/RoiCanvas.jsx'
import ResultViewer from '../components/ResultViewer.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { fetchFrames, superResolve, alternateOperation } from '../api/client.js'

const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

export default function Workspace() {
  const nav = useNavigate()
  const { session, addHistory } = useSession()

  const [frames, setFrames] = useState(session?.initialFrames || [])
  const [cursors, setCursors] = useState(session?.cursors || null)
  const [loadingLeft, setLoadingLeft] = useState(false)
  const [loadingRight, setLoadingRight] = useState(false)

  const [selected, setSelected] = useState(null)
  const [roi, setRoi] = useState(null)
  const [mode, setMode] = useState('super_res') // 'super_res' | 'holistic'
  const [result, setResult] = useState(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [resultError, setResultError] = useState(null)

  const seenIds = useRef(new Set((session?.initialFrames || []).map((f) => f.id)))

  useEffect(() => {
    if (!session) nav('/new', { replace: true })
  }, [session, nav])

  const loadMore = useCallback(
    async (direction) => {
      if (!cursors) return
      if (direction === 'left' && loadingLeft) return
      if (direction === 'right' && loadingRight) return
      direction === 'left' ? setLoadingLeft(true) : setLoadingRight(true)
      try {
        const res = await fetchFrames({
          sessionName: session.sessionName,
          cameraEsn: session.cameraEsn,
          direction,
          cursor: direction === 'left' ? cursors.left : cursors.right,
          authKey: session.authKey || undefined,
        })
        const fresh = res.frames.filter((f) => !seenIds.current.has(f.id))
        fresh.forEach((f) => seenIds.current.add(f.id))
        if (fresh.length) {
          setFrames((prev) => (direction === 'left' ? [...fresh, ...prev] : [...prev, ...fresh]))
          setCursors((c) => ({
            left: direction === 'left' ? res.cursors.left : c.left,
            right: direction === 'right' ? res.cursors.right : c.right,
          }))
        }
      } finally {
        direction === 'left' ? setLoadingLeft(false) : setLoadingRight(false)
      }
    },
    [cursors, session, loadingLeft, loadingRight],
  )

  const selectFrame = (f) => {
    setSelected(f)
    setRoi(null)
    setResult(null)
    setResultError(null)
  }

  const runOp = useCallback(
    async (op) => {
      if (!selected) return
      setMode(op)
      setResultLoading(true)
      setResultError(null)
      setResult(null)
      try {
        const fn = op === 'holistic' ? alternateOperation : superResolve
        const res = await fn({
          imagePath: selected.path,
          cameraEsn: session.cameraEsn,
          sessionName: session.sessionName,
          frameTimestamp: selected.timestamp,
          frameLabel: selected.label,
          roi,
        })
        setResult(res)
        addHistory({
          // full payload so the History gallery can render the viewer offline
          ...res,
          createdAt: new Date().toISOString(),
          sessionName: session.sessionName,
          cameraEsn: session.cameraEsn,
          framePath: selected.path,
          frameLabel: selected.label,
          roi,
          thumb: res.imageUrl,
        })
      } catch (err) {
        setResultError(err.message || 'Inference failed')
      } finally {
        setResultLoading(false)
      }
    },
    [selected, roi, session, addHistory],
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

  if (!session) return null

  return (
    <motion.div className="ws" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.3 }}>
      <header className="ws-top">
        <div className="ws-top-left">
          <button className="btn btn-ghost" onClick={() => nav('/')}><ArrowLeft size={18} /></button>
          <Logo size={32} withWordmark={false} />
          <div className="ws-session">
            <strong>{session.sessionName}</strong>
            <div className="ws-session-meta">
              <span><Cctv size={12} /> {session.cameraEsn}</span>
              <span><Clock size={12} /> {new Date(session.anchorTime).toLocaleString()}</span>
            </div>
          </div>
        </div>
        <button className="btn" onClick={() => nav('/history')}>History</button>
      </header>

      <div className="ws-body">
        <section className="ws-stage">
          {selected ? (
            <RoiCanvas src={selected.thumb} roi={roi} onChange={setRoi} />
          ) : (
            <div className="ws-stage-empty">
              <div className="ws-empty-ico"><ImageIcon size={30} /></div>
              <h3>Select a frame</h3>
              <p>Pick a frame from the strip below to inspect and enhance it.</p>
            </div>
          )}
          {selected && (
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
                  <button className={`ws-action ${mode === 'super_res' && result ? 'active' : ''}`} onClick={() => runOp('super_res')} disabled={resultLoading}>
                    <div className="ws-action-ico"><Wand2 size={20} /></div>
                    <div className="ws-action-txt"><strong>Super-Res</strong><span>Enhance this frame to high resolution</span></div>
                  </button>
                  <button className={`ws-action ${mode === 'holistic' && result ? 'active' : ''}`} onClick={() => runOp('holistic')} disabled={resultLoading}>
                    <div className="ws-action-ico alt"><Layers size={20} /></div>
                    <div className="ws-action-txt"><strong>Holistic View</strong><span>Fuse all cameras on this location</span></div>
                  </button>
                </div>

                <div className="ws-result">
                  <ResultViewer mode={mode} loading={resultLoading} result={result} error={resultError} />
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
        .ws-action-txt strong { display: block; font-size: 14px; }
        .ws-action-txt span { font-size: 11px; color: var(--text-2); line-height: 1.4; }

        .ws-result { border-top: 1px solid var(--border); padding-top: 18px; }
        .ws-foot { flex-shrink: 0; padding: 14px 22px 18px; }

        @media (max-width: 1080px) { .ws-panel { width: 360px; } .ws-actions { grid-template-columns: 1fr; } }
      `}</style>
    </motion.div>
  )
}
