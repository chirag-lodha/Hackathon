import { Loader2, ImageOff, Download, Layers } from 'lucide-react'
import Compare from './Compare.jsx'
import { imageURL } from '../api/client.js'

export default function ResultViewer({ mode, loading, note, result, error }) {
  if (loading) {
    return (
      <div className="rv-state">
        <Loader2 className="rv-spin" size={30} />
        <p>{mode === 'holistic' ? 'Fusing camera views…' : 'Super-resolving…'}</p>
        <span className="rv-sub">{note || 'Running inference on the selected frame'}</span>
        <div className="rv-skeleton skeleton" />
      </div>
    )
  }
  if (error) {
    return <div className="rv-state"><ImageOff size={30} /><p>Couldn't generate result</p><span className="rv-sub">{error}</span></div>
  }
  if (!result) {
    return (
      <div className="rv-state empty">
        <div className="rv-empty-ico"><Layers size={26} /></div>
        <p>No result yet</p>
        <span className="rv-sub">Draw an ROI (optional), then run Super-Res or Holistic View.</span>
      </div>
    )
  }

  // Prefer the tracked crop/output images (served via /api/images) and fall back
  // to the raw result URLs (holistic, mock, older history records).
  const afterUrl = result.outputImageId ? imageURL(result.outputImageId) : result.imageUrl
  const beforeUrl = result.sourceImageId ? imageURL(result.sourceImageId) : result.sourceUrl

  const download = () => {
    const a = document.createElement('a')
    a.href = afterUrl
    a.download = `${result.type}-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="rv">
      <div className="rv-head">
        <div className="rv-meta">
          {result.type === 'super_res' ? (
            <span className="chip">⚡ {result.scale}× Super-Resolution</span>
          ) : (
            <span className="chip">🛰 Holistic · {result.sources?.length} cameras</span>
          )}
          <span className="rv-ms">{result.ms} ms</span>
        </div>
        <button className="btn btn-ghost rv-dl" onClick={download}><Download size={15} /> Save</button>
      </div>

      {result.type === 'super_res' ? (
        <Compare before={beforeUrl} after={afterUrl} />
      ) : (
        <>
          <img className="rv-main" src={afterUrl} alt="holistic view" />
          <div className="rv-sources">
            <span className="rv-sources-label">Fused from</span>
            <div className="rv-source-grid">
              {result.sources?.map((s) => (
                <div className="rv-source" key={s.esn}>
                  <img src={s.thumb} alt={s.angle} />
                  <div className="rv-source-info">
                    <span className="mono">{s.esn}</span>
                    <span>{s.angle}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <style>{`
        .rv { display: flex; flex-direction: column; gap: 14px; }
        .rv-head { display: flex; align-items: center; justify-content: space-between; }
        .rv-meta { display: flex; align-items: center; gap: 10px; }
        .rv-ms { font-family: var(--mono); font-size: 11px; color: var(--text-2); }
        .rv-dl { padding: 8px 12px; font-size: 13px; }
        .rv-main { width: 100%; border-radius: var(--radius); display: block; aspect-ratio: 16/10; object-fit: cover; }
        .rv-sources-label { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--text-2); }
        .rv-source-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 9px; margin-top: 9px; }
        .rv-source { border-radius: 10px; overflow: hidden; border: 1px solid var(--border); background: var(--surface); }
        .rv-source img { width: 100%; height: 72px; object-fit: cover; display: block; }
        .rv-source-info { display: flex; flex-direction: column; padding: 7px 9px; font-size: 11px; gap: 1px; }
        .rv-source-info .mono { font-family: var(--mono); color: var(--accent-2); }
        .rv-source-info span:last-child { color: var(--text-2); }

        .rv-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; padding: 40px 20px; color: var(--text-1); min-height: 300px; }
        .rv-state p { font-weight: 600; font-size: 15px; }
        .rv-sub { font-size: 13px; color: var(--text-2); max-width: 280px; line-height: 1.5; }
        .rv-spin { animation: spin .8s linear infinite; color: var(--accent-2); }
        .rv-skeleton { width: 100%; height: 200px; border-radius: var(--radius); margin-top: 8px; }
        .rv-empty-ico { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-2); border: 1px solid rgba(124,92,255,.25); }
      `}</style>
    </div>
  )
}
