import { useRef, useState, useCallback } from 'react'

/**
 * Source image with an interactive ROI rectangle overlay.
 * Reports the ROI as normalized coords {x, y, w, h} in [0,1] so the
 * backend can map it onto the full-resolution source regardless of display size.
 */
export default function RoiCanvas({ src, roi, onChange }) {
  const wrapRef = useRef(null)
  const [drag, setDrag] = useState(null) // {x0,y0,x1,y1} in normalized coords

  const toNorm = useCallback((e) => {
    const r = wrapRef.current.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }, [])

  const onDown = (e) => {
    e.preventDefault()
    const p = toNorm(e)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const onMove = (e) => {
    if (!drag) return
    const p = toNorm(e)
    setDrag((d) => ({ ...d, x1: p.x, y1: p.y }))
  }
  const onUp = () => {
    if (!drag) return
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    setDrag(null)
    if (w > 0.02 && h > 0.02) onChange({ x, y, w, h })
    else onChange(null)
  }

  const live = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : roi

  const pct = (v) => `${v * 100}%`

  return (
    <div
      className="roi-wrap"
      ref={wrapRef}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
    >
      <img src={src} alt="source frame" draggable={false} />
      {!live && <div className="roi-hint">Drag to draw a region of interest</div>}
      {live && live.w > 0 && (
        <>
          <div className="roi-shade" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 ${pct(live.y)},${pct(live.x)} ${pct(live.y)},${pct(live.x)} ${pct(live.y + live.h)},${pct(live.x + live.w)} ${pct(live.y + live.h)},${pct(live.x + live.w)} ${pct(live.y)},0 ${pct(live.y)})` }} />
          <div className="roi-rect" style={{ left: pct(live.x), top: pct(live.y), width: pct(live.w), height: pct(live.h) }}>
            <span className="roi-corner tl" /><span className="roi-corner tr" /><span className="roi-corner bl" /><span className="roi-corner br" />
            <span className="roi-dim">{Math.round(live.w * 100)}% × {Math.round(live.h * 100)}%</span>
          </div>
        </>
      )}

      <style>{`
        .roi-wrap { position: relative; width: 100%; height: 100%; cursor: crosshair; user-select: none; border-radius: var(--radius); overflow: hidden; background: #000; }
        .roi-wrap img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
        .roi-hint { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 99px; background: rgba(0,0,0,.6); border: 1px solid var(--border); font-size: 12px; color: var(--text-1); pointer-events: none; }
        .roi-shade { position: absolute; inset: 0; background: rgba(0,0,0,.5); pointer-events: none; }
        .roi-rect { position: absolute; border: 2px solid var(--accent-2); box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 0 22px rgba(74,214,255,.35); pointer-events: none; }
        .roi-corner { position: absolute; width: 9px; height: 9px; background: var(--accent-2); border-radius: 2px; }
        .roi-corner.tl { left: -5px; top: -5px; } .roi-corner.tr { right: -5px; top: -5px; }
        .roi-corner.bl { left: -5px; bottom: -5px; } .roi-corner.br { right: -5px; bottom: -5px; }
        .roi-dim { position: absolute; top: -26px; left: 0; font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 5px; background: var(--accent-2); color: #001018; font-weight: 600; }
      `}</style>
    </div>
  )
}
