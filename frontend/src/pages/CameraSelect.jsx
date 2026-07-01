import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Cctv, Clock, Loader2, Wifi, WifiOff, ImageOff, ArrowRight, Sparkles } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { fetchCameras, imageStatus, imageURL } from '../api/client.js'
import { useImageCaption } from '../hooks/useImageCaption.js'

const fade = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 } }

// Convert a JS Date to EEN timestamp (UTC): YYYYMMDDhhmmss.fff
export function toEEN(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.000`
}

export default function CameraSelect() {
  const nav = useNavigate()
  const { session, setCamera } = useSession()

  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dateTime, setDateTime] = useState('')

  useEffect(() => {
    if (!session) nav('/new', { replace: true })
  }, [session, nav])

  useEffect(() => {
    if (!session) return
    let alive = true
    setLoading(true)
    fetchCameras(session.id)
      .then((res) => alive && setCameras(res.cameras || []))
      .catch((e) => alive && setError(e.message || 'Could not load cameras'))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [session])

  const open = (cam) => {
    if (cam.status === 'offline') return
    const anchorTs = dateTime ? toEEN(new Date(dateTime)) : ''
    setCamera({ esn: cam.esn, name: cam.name, anchorTs })
    nav('/workspace')
  }

  if (!session) return null

  return (
    <motion.div className="cams" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.35 }}>
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => nav('/new')}><ArrowLeft size={18} /> Back</button>
        <Logo size={34} />
        <div style={{ width: 90 }} />
      </header>

      <div className="cams-wrap">
        <div className="cams-head">
          <div>
            <span className="label-eyebrow">{session.name}</span>
            <h2>Select a camera</h2>
            <p className="cams-sub">{loading ? 'Loading cameras from the account…' : `${cameras.length} camera${cameras.length === 1 ? '' : 's'}`}</p>
          </div>
          <label className="cams-time">
            <span><Clock size={13} /> Date &amp; time <em>· optional, defaults to latest</em></span>
            <input type="datetime-local" value={dateTime} onChange={(e) => setDateTime(e.target.value)} />
          </label>
        </div>

        {error && <div className="cams-error">{error}</div>}

        <div className="cams-grid">
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="cam-skel skeleton" />)
            : cameras.map((cam, i) => <CameraTile key={cam.esn} cam={cam} delay={Math.min(i * 0.04, 0.3)} onOpen={() => open(cam)} />)}
        </div>
      </div>

      <style>{`
        .cams { flex: 1; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        .topbar { display: flex; align-items: center; justify-content: space-between; padding: 20px 28px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .cams-wrap { flex: 1; overflow-y: auto; padding: 32px; max-width: 1120px; width: 100%; margin: 0 auto; }
        .cams-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; flex-wrap: wrap; }
        .cams-head h2 { font-size: 30px; font-weight: 800; letter-spacing: -1px; margin: 6px 0 2px; }
        .cams-sub { color: var(--text-2); font-size: 13px; }
        .cams-time { display: flex; flex-direction: column; gap: 6px; }
        .cams-time span { font-size: 12px; font-weight: 600; color: var(--text-1); display: inline-flex; align-items: center; gap: 6px; }
        .cams-time em { color: var(--text-2); font-weight: 400; font-style: normal; }
        .cams-time input { padding: 10px 12px; border-radius: var(--radius-sm); background: rgba(0,0,0,.25); border: 1px solid var(--border); color: var(--text-0); font-size: 13px; color-scheme: dark; }
        .cams-error { margin-bottom: 16px; padding: 11px 14px; border-radius: var(--radius-sm); background: rgba(255,93,115,.12); border: 1px solid rgba(255,93,115,.3); color: #ffb3bd; font-size: 13px; }
        .cams-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
        .cam-skel { aspect-ratio: 16/12; border-radius: var(--radius); }
      `}</style>
    </motion.div>
  )
}

// CameraTile polls the preview download status, showing a loader until the
// image is ready, then the live preview.
function CameraTile({ cam, delay, onOpen }) {
  const [state, setState] = useState('PROCESSING')
  const timer = useRef(null)

  useEffect(() => {
    if (!cam.imageId) { setState('FAILURE'); return }
    let tries = 0
    const poll = async () => {
      try {
        const s = await imageStatus(cam.imageId)
        if (s.state === 'SUCCESS' || s.state === 'FAILURE') {
          setState(s.state)
          clearInterval(timer.current)
          return
        }
      } catch {}
      if (++tries > 40) { setState('FAILURE'); clearInterval(timer.current) }
    }
    poll()
    timer.current = setInterval(poll, 1000)
    return () => clearInterval(timer.current)
  }, [cam.imageId])

  // Gemini vision caption — only once the preview itself is downloaded.
  const { caption } = useImageCaption(cam.imageId, state === 'SUCCESS')

  const off = cam.status === 'offline'
  return (
    <motion.button
      className={`cam-card ${off ? 'off' : ''}`}
      onClick={onOpen}
      disabled={off}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
    >
      <div className="cam-thumb">
        {state === 'SUCCESS' ? (
          <img src={imageURL(cam.imageId)} alt={cam.name} />
        ) : state === 'FAILURE' ? (
          <div className="cam-ph"><ImageOff size={24} /><span>no preview</span></div>
        ) : (
          <div className="cam-ph loading"><Loader2 size={22} className="spin-ico" /><span>loading…</span></div>
        )}
        <span className={`cam-status ${cam.status}`}>{off ? <WifiOff size={11} /> : <Wifi size={11} />} {cam.status}</span>
        {state === 'SUCCESS' && caption && (
          <div className="cam-caption"><Sparkles size={11} /> <span>{caption}</span></div>
        )}
        {state === 'SUCCESS' && !off && <div className="cam-hover"><ArrowRight size={20} /></div>}
      </div>
      <div className="cam-body">
        <strong>{cam.name}</strong>
        <div className="cam-meta">
          <span className="mono"><Cctv size={11} /> {cam.esn}</span>
          <span>{cam.location}</span>
        </div>
      </div>
      <style>{`
        .cam-card { text-align: left; border-radius: var(--radius); overflow: hidden; background: var(--surface); border: 1px solid var(--border); transition: transform .18s, border-color .18s, box-shadow .18s; }
        .cam-card:hover:not(:disabled) { transform: translateY(-4px); border-color: var(--border-strong); box-shadow: var(--shadow); }
        .cam-card:disabled { cursor: not-allowed; }
        .cam-card.off { opacity: .55; }
        .cam-thumb { position: relative; aspect-ratio: 16/10; overflow: hidden; background: #000; }
        .cam-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .cam-ph { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 6px; color: var(--text-2); font-size: 11px; }
        .cam-ph.loading { color: var(--accent-2); }
        .cam-status { position: absolute; top: 9px; left: 9px; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; padding: 3px 8px; border-radius: 99px; backdrop-filter: blur(6px); }
        .cam-status.online { background: rgba(61,220,151,.22); color: #b6f5da; border: 1px solid rgba(61,220,151,.4); }
        .cam-status.offline { background: rgba(255,93,115,.2); color: #ffb3bd; border: 1px solid rgba(255,93,115,.4); }
        .cam-hover { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(124,92,255,.25); color: #fff; opacity: 0; transition: opacity .2s; }
        .cam-card:hover:not(:disabled) .cam-hover { opacity: 1; }
        .cam-caption { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: flex-start; gap: 5px; padding: 16px 10px 8px; font-size: 11px; line-height: 1.35; color: #eef; background: linear-gradient(to top, rgba(0,0,0,.82), rgba(0,0,0,0)); }
        .cam-caption svg { flex-shrink: 0; margin-top: 2px; color: var(--accent-2); }
        .cam-caption span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .cam-body { padding: 13px 14px; }
        .cam-body strong { display: block; font-size: 14px; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .cam-meta { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
        .cam-meta .mono { font-family: var(--mono); color: var(--accent-2); display: inline-flex; align-items: center; gap: 5px; }
        .spin-ico { animation: spin .7s linear infinite; }
      `}</style>
    </motion.button>
  )
}
