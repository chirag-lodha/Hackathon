import { useState, useRef } from 'react'

/**
 * Before/after drag-to-compare slider.
 *
 * Both images fill the container identically (object-fit: cover) and the
 * "before" image is revealed from the left with clip-path. This keeps the two
 * halves pixel-aligned — the previous width:auto approach made the preview
 * render a different scale/region than the enhanced output.
 */
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
      <img className="cmp-img" src={after} alt="enhanced" draggable={false} />
      <img
        className="cmp-img cmp-before"
        src={before}
        alt="original"
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="cmp-tag left">{beforeLabel}</span>
      <span className="cmp-tag right">{afterLabel}</span>
      <div className="cmp-handle" style={{ left: `${pos}%` }}><span /></div>
      <style>{`
        .cmp { position: relative; width: 100%; height: 100%; aspect-ratio: 16/10; overflow: hidden; cursor: ew-resize; user-select: none; background: #000; }
        .cmp-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        .cmp-before { z-index: 1; }
        .cmp-handle { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,.85); transform: translateX(-1px); pointer-events: none; z-index: 2; }
        .cmp-handle span { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,.95); box-shadow: 0 2px 12px rgba(0,0,0,.5); display: grid; place-items: center; }
        .cmp-handle span::before, .cmp-handle span::after { content: ''; position: absolute; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
        .cmp-handle span::before { border-right: 7px solid #333; left: 7px; }
        .cmp-handle span::after { border-left: 7px solid #333; right: 7px; }
        .cmp-tag { position: absolute; bottom: 10px; z-index: 3; font-size: 11px; font-weight: 600; letter-spacing: .5px; padding: 4px 10px; border-radius: 99px; background: rgba(0,0,0,.6); color: #fff; }
        .cmp-tag.left { left: 10px; } .cmp-tag.right { right: 10px; }
      `}</style>
    </div>
  )
}
