import { useRef, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * Horizontal frame slider. Fetches more frames in ±5s sets as the user
 * scrolls toward either edge (infinite both directions).
 */
export default function Filmstrip({ frames, selectedId, onSelect, onNeedMore, loadingLeft, loadingRight }) {
  const scrollRef = useRef(null)
  const prevWidthRef = useRef(0)
  const prependingRef = useRef(false)

  const checkEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 240
    if (el.scrollLeft < threshold && !loadingLeft) {
      prependingRef.current = true
      prevWidthRef.current = el.scrollWidth
      onNeedMore('left')
    }
    if (el.scrollWidth - el.scrollLeft - el.clientWidth < threshold && !loadingRight) {
      onNeedMore('right')
    }
  }, [onNeedMore, loadingLeft, loadingRight])

  // Preserve scroll position when prepending older frames to the left.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prependingRef.current && prevWidthRef.current) {
      el.scrollLeft += el.scrollWidth - prevWidthRef.current
      prependingRef.current = false
    }
  }, [frames])

  // Auto-fill: if the strip doesn't overflow yet (e.g. only the initial ~4 frames
  // at the latest moment), onScroll never fires — so proactively ask for more
  // after each render and on resize until it becomes scrollable. loadMore() guards
  // against exhausted directions, so this converges.
  useEffect(() => {
    const id = requestAnimationFrame(checkEdges)
    return () => cancelAnimationFrame(id)
  }, [frames, checkEdges])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => checkEdges())
    ro.observe(el)
    return () => ro.disconnect()
  }, [checkEdges])

  return (
    <div className="filmstrip glass">
      <div className="filmstrip-edge left">{loadingLeft && <Loader2 className="fs-spin" size={16} />}</div>
      <div className="filmstrip-scroll" ref={scrollRef} onScroll={checkEdges}>
        {frames.map((f) => (
          <button
            key={f.id}
            className={`fs-frame ${selectedId === f.id ? 'active' : ''}`}
            onClick={() => onSelect(f)}
            title={f.label}
          >
            <img src={f.thumb} alt={f.label} draggable={false} />
            <span className="fs-time">{f.label.slice(11)}</span>
          </button>
        ))}
      </div>
      <div className="filmstrip-edge right">{loadingRight && <Loader2 className="fs-spin" size={16} />}</div>

      <style>{`
        .filmstrip { position: relative; display: flex; align-items: center; height: 140px; border-radius: var(--radius); overflow: hidden; }
        .filmstrip-edge { width: 36px; flex-shrink: 0; display: grid; place-items: center; color: var(--accent-2); }
        .filmstrip-edge.left { background: linear-gradient(90deg, rgba(124,92,255,.08), transparent); }
        .filmstrip-edge.right { background: linear-gradient(270deg, rgba(124,92,255,.08), transparent); }
        .filmstrip-scroll { flex: 1; display: flex; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 12px 4px; scroll-behavior: smooth; height: 100%; align-items: center; }
        .fs-frame {
          position: relative; flex-shrink: 0; width: 168px; height: 100px; border-radius: 10px; overflow: hidden;
          border: 2px solid transparent; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
          background: var(--bg-2);
        }
        .fs-frame img { width: 100%; height: 100%; object-fit: cover; display: block; filter: saturate(1.05); }
        .fs-frame:hover { transform: translateY(-3px); border-color: var(--border-strong); }
        .fs-frame.active { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), var(--accent-glow); transform: translateY(-3px); }
        .fs-time { position: absolute; bottom: 5px; left: 6px; font-family: var(--mono); font-size: 10px; padding: 2px 6px; border-radius: 5px; background: rgba(0,0,0,.6); color: #fff; }
        .fs-spin { animation: spin .7s linear infinite; }
      `}</style>
    </div>
  )
}
