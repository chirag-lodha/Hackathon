import { useState, useRef } from 'react'

/** Before/after drag-to-compare slider. */
export default function Compare({ before, after, beforeLabel = 'Original', afterLabel = 'Enhanced', radius = 'var(--radius)' }) {
  const [pos, setPos] = useState(50)
  const ref = useRef(null)
  const move = (clientX) => {
    const r = ref.current.getBoundingClientRect()
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)))
  }
  return (
    <div
      className="cmp"
      ref={ref}
      style={{ borderRadius: radius }}
      onMouseMove={(e) => e.buttons === 1 && move(e.clientX)}
      onMouseDown={(e) => move(e.clientX)}
    >
      <img className="cmp-after" src={after} alt="enhanced" draggable={false} />
      <div className="cmp-before-wrap" style={{ width: `${pos}%` }}>
        <img className="cmp-before" src={before} alt="original" draggable={false} />
        <span className="cmp-tag left">{beforeLabel}</span>
      </div>
      <span className="cmp-tag right">{afterLabel}</span>
      <div className="cmp-handle" style={{ left: `${pos}%` }}><span /></div>
      <style>{`
        .cmp { position: relative; width: 100%; height: 100%; aspect-ratio: 16/10; overflow: hidden; cursor: ew-resize; user-select: none; background: #000; }
        .cmp img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        .cmp-before-wrap { position: absolute; inset: 0; overflow: hidden; border-right: 2px solid rgba(255,255,255,.8); }
        .cmp-before-wrap .cmp-before { position: absolute; inset: 0; height: 100%; width: auto; }
        .cmp-handle { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,.8); transform: translateX(-1px); pointer-events: none; }
        .cmp-handle span { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,.95); box-shadow: 0 2px 12px rgba(0,0,0,.5); display: grid; place-items: center; }
        .cmp-handle span::before, .cmp-handle span::after { content: ''; position: absolute; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
        .cmp-handle span::before { border-right: 7px solid #333; left: 7px; }
        .cmp-handle span::after { border-left: 7px solid #333; right: 7px; }
        .cmp-tag { position: absolute; bottom: 10px; font-size: 11px; font-weight: 600; letter-spacing: .5px; padding: 4px 10px; border-radius: 99px; background: rgba(0,0,0,.6); color: #fff; }
        .cmp-tag.left { left: 10px; } .cmp-tag.right { right: 10px; }
      `}</style>
    </div>
  )
}
