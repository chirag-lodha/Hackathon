import { useState, useEffect } from 'react'
import { Cctv, Wifi, LayoutGrid } from 'lucide-react'

/**
 * Command View — a synchronized multi-camera wall for a location. It takes a
 * holistic result (whose `sources` are every camera covering the same scene at
 * the same moment) and shows one enlarged focus feed plus a labeled grid of the
 * rest. Click any tile to promote it to the focus. Pure DOM/CSS — no 3D.
 */
export default function CommandView({ result, moment }) {
  const sources = result?.sources || []
  const [focus, setFocus] = useState(0)

  // Reset the focus when a new result loads.
  useEffect(() => setFocus(0), [result])

  // Fallback: no per-camera sources → just show the fused image full-bleed.
  if (!sources.length) {
    return (
      <div className="cmd">
        <img className="cmd-solo" src={result?.imageUrl} alt="fused view" />
        <style>{styles}</style>
      </div>
    )
  }

  const main = sources[Math.min(focus, sources.length - 1)]
  const label = (s, i) => s.esn || `CAM ${String(i + 1).padStart(2, '0')}`

  return (
    <div className="cmd">
      <div className="cmd-main">
        <img src={main.thumb} alt={label(main, focus)} />
        <div className="cmd-main-tag">
          <span className="cmd-live"><span className="dot" /> LIVE</span>
          <span className="mono">{label(main, focus)}</span>
          {main.angle && <span className="cmd-angle">{main.angle}</span>}
        </div>
      </div>

      <aside className="cmd-side">
        <div className="cmd-head">
          <div className="cmd-title"><LayoutGrid size={15} /> Command View</div>
          <div className="cmd-sub">
            <span>{sources.length} cameras · same location</span>
            {moment && <span className="mono">{moment}</span>}
          </div>
        </div>
        <div className="cmd-grid">
          {sources.map((s, i) => (
            <button
              key={s.esn ? `${s.esn}-${i}` : i}
              className={`cmd-tile ${i === focus ? 'active' : ''}`}
              onClick={() => setFocus(i)}
            >
              <div className="cmd-thumb">
                <img src={s.thumb} alt={label(s, i)} loading="lazy" />
                <span className="cmd-dot"><Wifi size={9} /></span>
              </div>
              <div className="cmd-tile-meta">
                <span className="mono"><Cctv size={10} /> {label(s, i)}</span>
                {s.angle && <span className="cmd-tile-angle">{s.angle}</span>}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <style>{styles}</style>
    </div>
  )
}

const styles = `
  .cmd { position: absolute; inset: 0; display: flex; gap: 12px; padding: 12px; background: #07070c; }
  .cmd-solo { width: 100%; height: 100%; object-fit: contain; }
  .cmd-main { position: relative; flex: 1; min-width: 0; border-radius: var(--radius); overflow: hidden; background: #000; border: 1px solid var(--border-strong); }
  .cmd-main img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cmd-main-tag { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 10px; padding: 6px 11px; border-radius: 8px; background: rgba(0,0,0,.6); backdrop-filter: blur(8px); font-size: 12px; color: #fff; }
  .cmd-live { display: inline-flex; align-items: center; gap: 6px; font-weight: 800; letter-spacing: .5px; color: #ff5d73; font-size: 11px; }
  .cmd-live .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff3b52; box-shadow: 0 0 8px #ff3b52; animation: cmdpulse 1.4s ease-in-out infinite; }
  .cmd-angle { color: var(--text-2); }
  .cmd-side { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; }
  .cmd-head { padding: 4px 2px; }
  .cmd-title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800; }
  .cmd-sub { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; font-size: 12px; color: var(--text-2); }
  .cmd-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-content: start; padding-right: 2px; }
  .cmd-tile { text-align: left; border-radius: 10px; overflow: hidden; background: var(--surface); border: 1px solid var(--border); cursor: pointer; transition: border-color .15s, transform .15s; padding: 0; }
  .cmd-tile:hover { transform: translateY(-2px); border-color: var(--border-strong); }
  .cmd-tile.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .cmd-thumb { position: relative; aspect-ratio: 16/10; background: #000; }
  .cmd-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cmd-dot { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(61,220,151,.25); color: #b6f5da; }
  .cmd-tile-meta { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; }
  .cmd-tile-meta .mono { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--accent-2); }
  .cmd-tile-angle { font-size: 10px; color: var(--text-2); }
  @keyframes cmdpulse { 50% { opacity: .35; } }
  @media (max-width: 1080px) { .cmd-side { width: 220px; } .cmd-grid { grid-template-columns: 1fr; } }
`
