import { useState, useEffect, useRef } from 'react'
import { Cctv, Wifi, WifiOff, LayoutGrid, Loader2, ImageOff } from 'lucide-react'
import { fetchLocationCameras, imageStatus, imageURL } from '../api/client.js'

/**
 * Command View — a synchronized multi-camera wall for a physical location. It
 * asks the backend for every camera that shares the selected camera's EEN
 * `location`, each with a preview downloading at the chosen moment, then shows
 * one enlarged focus feed plus a labeled grid of the rest. Click a tile to focus.
 * Real cameras + real previews — no dummy data, no 3D.
 */
export default function CommandView({ sessionId, cameraEsn, aroundTs, moment }) {
  const [cams, setCams] = useState([])
  const [location, setLocation] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [focus, setFocus] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setFocus(0)
    fetchLocationCameras({ sessionId, cameraEsn, aroundTs: aroundTs || '' })
      .then((res) => {
        if (!alive) return
        setLocation(res.location || '')
        // Put the camera we came from first so it's the default focus.
        const list = res.cameras || []
        list.sort((a, b) => (a.esn === cameraEsn ? -1 : b.esn === cameraEsn ? 1 : 0))
        setCams(list)
      })
      .catch((e) => alive && setError(e.message || 'Could not load location cameras'))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [sessionId, cameraEsn, aroundTs])

  if (loading) {
    return (
      <div className="cmd cmd-center">
        <Loader2 size={30} className="cmd-spin" />
        <h3>Finding cameras at this location…</h3>
        <style>{styles}</style>
      </div>
    )
  }
  if (error || !cams.length) {
    return (
      <div className="cmd cmd-center">
        <ImageOff size={28} />
        <h3>No co-located cameras</h3>
        <p>{error || 'No other cameras share this location.'}</p>
        <style>{styles}</style>
      </div>
    )
  }

  const main = cams[Math.min(focus, cams.length - 1)]

  return (
    <div className="cmd">
      <div className="cmd-main">
        <CamImage cam={main} big />
        <div className="cmd-main-tag">
          <span className="cmd-live"><span className="dot" /> LIVE</span>
          <span className="mono">{main.name || main.esn}</span>
          <span className="cmd-esn mono"><Cctv size={11} /> {main.esn}</span>
        </div>
      </div>

      <aside className="cmd-side">
        <div className="cmd-head">
          <div className="cmd-title"><LayoutGrid size={15} /> Command View</div>
          <div className="cmd-sub">
            <span>{cams.length} cameras · {location || 'this location'}</span>
            {moment && <span className="mono">{moment}</span>}
          </div>
        </div>
        <div className="cmd-grid">
          {cams.map((c, i) => (
            <button key={c.esn} className={`cmd-tile ${i === focus ? 'active' : ''}`} onClick={() => setFocus(i)}>
              <CamImage cam={c} />
              <div className="cmd-tile-meta">
                <span className="mono"><Cctv size={10} /> {c.esn}</span>
                <span className="cmd-tile-name">{c.name}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <style>{styles}</style>
    </div>
  )
}

// CamImage polls the preview download for a camera and shows it once ready.
function CamImage({ cam, big }) {
  const [state, setState] = useState('PROCESSING')
  const timer = useRef(null)

  useEffect(() => {
    setState('PROCESSING')
    if (!cam?.imageId) { setState('FAILURE'); return }
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
  }, [cam?.imageId])

  const off = cam?.status === 'offline'
  return (
    <div className={`cam-img ${big ? 'big' : ''}`}>
      {state === 'SUCCESS' ? (
        <img src={imageURL(cam.imageId)} alt={cam.name || cam.esn} />
      ) : state === 'FAILURE' ? (
        <div className="cam-img-ph">{off ? <WifiOff size={big ? 26 : 18} /> : <ImageOff size={big ? 26 : 18} />}<span>no feed</span></div>
      ) : (
        <div className="cam-img-ph loading"><Loader2 size={big ? 24 : 16} className="cmd-spin" /></div>
      )}
    </div>
  )
}

const styles = `
  .cmd { position: absolute; inset: 0; display: flex; gap: 12px; padding: 12px; background: #07070c; }
  .cmd-center { flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-2); text-align: center; }
  .cmd-center h3 { color: var(--text-0); }
  .cmd-spin { animation: spin .8s linear infinite; color: var(--accent-2); }
  .cmd-main { position: relative; flex: 1; min-width: 0; border-radius: var(--radius); overflow: hidden; background: #000; border: 1px solid var(--border-strong); }
  .cam-img { width: 100%; height: 100%; }
  .cam-img.big { position: absolute; inset: 0; }
  .cam-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cam-img-ph { width: 100%; height: 100%; display: grid; place-items: center; align-content: center; gap: 6px; color: var(--text-2); font-size: 11px; background: #0b0b14; }
  .cam-img-ph.loading { color: var(--accent-2); }
  .cmd-main-tag { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 10px; padding: 6px 11px; border-radius: 8px; background: rgba(0,0,0,.6); backdrop-filter: blur(8px); font-size: 12px; color: #fff; }
  .cmd-live { display: inline-flex; align-items: center; gap: 6px; font-weight: 800; letter-spacing: .5px; color: #ff5d73; font-size: 11px; }
  .cmd-live .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff3b52; box-shadow: 0 0 8px #ff3b52; animation: cmdpulse 1.4s ease-in-out infinite; }
  .cmd-esn { color: var(--accent-2); display: inline-flex; align-items: center; gap: 4px; }
  .cmd-side { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; }
  .cmd-head { padding: 4px 2px; }
  .cmd-title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800; }
  .cmd-sub { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; font-size: 12px; color: var(--text-2); }
  .cmd-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-content: start; padding-right: 2px; }
  .cmd-tile { text-align: left; border-radius: 10px; overflow: hidden; background: var(--surface); border: 1px solid var(--border); cursor: pointer; transition: border-color .15s, transform .15s; padding: 0; }
  .cmd-tile:hover { transform: translateY(-2px); border-color: var(--border-strong); }
  .cmd-tile.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .cmd-tile .cam-img { aspect-ratio: 16/10; }
  .cmd-tile-meta { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; }
  .cmd-tile-meta .mono { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--accent-2); }
  .cmd-tile-name { font-size: 10px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes cmdpulse { 50% { opacity: .35; } }
  @media (max-width: 1080px) { .cmd-side { width: 220px; } .cmd-grid { grid-template-columns: 1fr; } }
`
