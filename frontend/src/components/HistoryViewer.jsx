import { useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronLeft, ChevronRight, Wand2, Layers, Cctv, Clock, Square, Download } from 'lucide-react'
import Compare from './Compare.jsx'

/**
 * Full-screen lightbox to browse converted results. Shows the super-res
 * before/after compare or the holistic composite + contributing cameras.
 * Navigate with the arrows or ← / → / Esc keys.
 */
export default function HistoryViewer({ items, index, onClose, onNav }) {
  const item = index != null ? items[index] : null

  const handleKey = useCallback(
    (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onNav(-1)
      else if (e.key === 'ArrowRight') onNav(1)
    },
    [onClose, onNav],
  )

  useEffect(() => {
    if (item) {
      window.addEventListener('keydown', handleKey)
      return () => window.removeEventListener('keydown', handleKey)
    }
  }, [item, handleKey])

  const download = () => {
    if (!item) return
    const a = document.createElement('a')
    a.href = item.imageUrl
    a.download = `${item.type}-${item.id || Date.now()}.svg`
    a.click()
  }

  return (
    <>
    <style>{styles}</style>
    <AnimatePresence>
      {item && (
        <motion.div className="lb-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <button className="lb-nav left" onClick={(e) => { e.stopPropagation(); onNav(-1) }} disabled={index <= 0}><ChevronLeft size={26} /></button>
          <button className="lb-nav right" onClick={(e) => { e.stopPropagation(); onNav(1) }} disabled={index >= items.length - 1}><ChevronRight size={26} /></button>

          <motion.div
            className="lb-card glass"
            initial={{ scale: 0.96, opacity: 0, y: 14 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 14 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            key={item.id}
          >
            <div className="lb-stage">
              {item.type === 'super_res' ? (
                <Compare before={item.sourceUrl} after={item.imageUrl} radius="0" />
              ) : (
                <img className="lb-main" src={item.imageUrl} alt="holistic" />
              )}
            </div>

            <aside className="lb-side">
              <div className="lb-side-top">
                <span className={`lb-badge ${item.type}`}>
                  {item.type === 'super_res' ? <><Wand2 size={13} /> {item.scale}× Super-Res</> : <><Layers size={13} /> Holistic · {item.sources?.length} cams</>}
                </span>
                <button className="lb-close" onClick={onClose}><X size={18} /></button>
              </div>

              <h3 className="lb-title">{item.sessionName}</h3>
              <div className="lb-meta">
                <span><Cctv size={13} /> {item.cameraEsn}</span>
                <span><Clock size={13} /> {item.frameLabel || new Date(item.createdAt).toLocaleString()}</span>
                {item.roi && <span><Square size={13} /> ROI {Math.round(item.roi.w * 100)}×{Math.round(item.roi.h * 100)}</span>}
                {item.ms != null && <span className="mono">{item.ms} ms</span>}
              </div>
              {item.framePath && <code className="lb-path">{item.framePath}</code>}

              {item.type === 'holistic' && item.sources && (
                <div className="lb-sources">
                  <span className="lb-sources-label">Fused from</span>
                  <div className="lb-source-grid">
                    {item.sources.map((s) => (
                      <div className="lb-source" key={s.esn}>
                        <img src={s.thumb} alt={s.angle} />
                        <div className="lb-source-info"><span className="mono">{s.esn}</span><span>{s.angle}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="lb-actions">
                <button className="btn btn-primary" onClick={download}><Download size={16} /> Save image</button>
              </div>
              <div className="lb-counter">{index + 1} / {items.length}</div>
            </aside>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}

const styles = `
        .lb-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(4,4,9,.82); backdrop-filter: blur(8px); display: grid; place-items: center; padding: 40px; }
        .lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--border); color: #fff; z-index: 2; transition: background .2s ease; }
        .lb-nav:hover:not(:disabled) { background: var(--surface-hover); }
        .lb-nav:disabled { opacity: .25; cursor: not-allowed; }
        .lb-nav.left { left: 22px; } .lb-nav.right { right: 22px; }

        .lb-card { display: flex; width: min(1180px, 92vw); max-height: 86vh; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow); }
        .lb-stage { flex: 1; min-width: 0; background: #000; display: flex; align-items: center; justify-content: center; }
        .lb-stage .cmp { height: 100%; aspect-ratio: auto; }
        .lb-main { width: 100%; height: 100%; object-fit: contain; display: block; }

        .lb-side { width: 340px; flex-shrink: 0; padding: 22px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; border-left: 1px solid var(--border); background: var(--bg-1); }
        .lb-side-top { display: flex; align-items: center; justify-content: space-between; }
        .lb-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 5px 11px; border-radius: 99px; border: 1px solid; }
        .lb-badge.super_res { background: rgba(74,214,255,.14); color: #4ad6ff; border-color: rgba(74,214,255,.35); }
        .lb-badge.holistic { background: rgba(61,220,151,.14); color: #3ddc97; border-color: rgba(61,220,151,.35); }
        .lb-close { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); }
        .lb-close:hover { background: var(--surface-hover); color: #fff; }
        .lb-title { font-size: 21px; font-weight: 800; letter-spacing: -.5px; }
        .lb-meta { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-1); }
        .lb-meta span { display: inline-flex; align-items: center; gap: 8px; }
        .lb-meta .mono { font-family: var(--mono); color: var(--text-2); }
        .lb-path { font-family: var(--mono); font-size: 11px; color: var(--text-2); background: rgba(0,0,0,.3); padding: 8px 10px; border-radius: 8px; word-break: break-all; }
        .lb-sources-label { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--text-2); }
        .lb-source-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
        .lb-source { border-radius: 9px; overflow: hidden; border: 1px solid var(--border); background: var(--surface); }
        .lb-source img { width: 100%; height: 58px; object-fit: cover; display: block; }
        .lb-source-info { display: flex; flex-direction: column; padding: 6px 8px; font-size: 10px; }
        .lb-source-info .mono { font-family: var(--mono); color: var(--accent-2); }
        .lb-source-info span:last-child { color: var(--text-2); }
        .lb-actions { margin-top: auto; }
        .lb-actions .btn { width: 100%; }
        .lb-counter { text-align: center; font-size: 12px; color: var(--text-2); font-family: var(--mono); }

        @media (max-width: 860px) {
          .lb-card { flex-direction: column; max-height: 92vh; }
          .lb-side { width: 100%; border-left: none; border-top: 1px solid var(--border); }
          .lb-nav.left { left: 8px; } .lb-nav.right { right: 8px; }
        }
`
