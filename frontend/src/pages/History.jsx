import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Wand2, Layers, Cctv, Clock, Trash2, Inbox, Loader2, Square, Maximize2, ShieldAlert, X } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import HistoryViewer from '../components/HistoryViewer.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { fetchHistory, deleteTrial, deleteAllTrials } from '../api/client.js'

const fade = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'super_res', label: 'Super-Res', icon: Wand2 },
  { key: 'holistic', label: 'Holistic', icon: Layers },
]

export default function History() {
  const nav = useNavigate()
  const { history: localHistory, clearHistory, removeHistory, adminMode, toggleAdmin } = useSession()

  const [remote, setRemote] = useState([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [viewIndex, setViewIndex] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchHistory()
      .then((res) => alive && setRemote(res.records || []))
      .catch(() => alive && setRemote([]))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  // Merge server-stored conversions with ones run this session (localStorage),
  // keep only conversions, dedupe by id, newest first.
  const items = useMemo(() => {
    const local = localHistory.filter((h) => h.type === 'super_res' || h.type === 'holistic')
    const seen = new Set()
    const all = [...local, ...remote].filter((r) => {
      const k = r.id || `${r.createdAt}-${r.framePath}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return all
  }, [localHistory, remote])

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.type === filter)),
    [items, filter],
  )

  const counts = useMemo(
    () => ({
      all: items.length,
      super_res: items.filter((i) => i.type === 'super_res').length,
      holistic: items.filter((i) => i.type === 'holistic').length,
    }),
    [items],
  )

  const navView = (dir) =>
    setViewIndex((i) => {
      const n = i + dir
      return n >= 0 && n < filtered.length ? n : i
    })

  // ----- hidden admin delete -----
  const deleteOne = async (e, item) => {
    e.stopPropagation()
    setRemote((prev) => prev.filter((r) => String(r.id) !== String(item.id)))
    removeHistory(item.id)
    try {
      await deleteTrial(item.id)
    } catch (err) {
      console.error('delete failed', err)
    }
  }

  const deleteEverything = async () => {
    if (!window.confirm('Permanently delete ALL conversions from the database? This cannot be undone.')) return
    setBusy(true)
    setRemote([])
    clearHistory()
    try {
      await deleteAllTrials()
    } catch (err) {
      console.error('delete all failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div className="hist" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.35 }}>
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => nav('/')}><ArrowLeft size={18} /> Back</button>
        <Logo size={34} />
        <button className="btn" onClick={() => nav('/new')}>New capture</button>
      </header>

      <div className="hist-wrap">
        <div className="hist-head">
          <div>
            <span className="label-eyebrow">Gallery</span>
            <h2>Converted results</h2>
            <p className="hist-sub">
              {loading ? 'Loading from backend…' : `${items.length} enhanced result${items.length === 1 ? '' : 's'} · scroll through and open any to view`}
            </p>
          </div>
          {adminMode && items.length > 0 && (
            <button className="btn hist-delete-all" onClick={deleteEverything} disabled={busy}>
              {busy ? <Loader2 size={16} className="hd-spin" /> : <Trash2 size={16} />} Delete all
            </button>
          )}
        </div>

        {adminMode && (
          <div className="admin-banner">
            <ShieldAlert size={16} />
            <span>Admin delete mode is <strong>on</strong> — hover a result to remove it, or use “Delete all”.</span>
            <button className="admin-banner-close" onClick={toggleAdmin} title="Hide (or type the secret again)"><X size={15} /></button>
          </div>
        )}

        <div className="hist-filters">
          {FILTERS.map((f) => {
            const Icon = f.icon
            return (
              <button key={f.key} className={`hist-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
                {Icon && <Icon size={14} />} {f.label}
                <span className="hist-filter-count">{counts[f.key]}</span>
              </button>
            )
          })}
        </div>

        {loading ? (
          <div className="hist-grid">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="hist-card-skel skeleton" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="hist-empty glass">
            <div className="hist-empty-ico"><Inbox size={30} /></div>
            <h3>No conversions yet</h3>
            <p>Run a Super-Res or Holistic View on a frame and it will appear here.</p>
            <button className="btn btn-primary" onClick={() => nav('/new')}>Start a new capture</button>
          </div>
        ) : (
          <div className="hist-grid">
            {filtered.map((it, i) => {
              const isHol = it.type === 'holistic'
              const Icon = isHol ? Layers : Wand2
              return (
                <motion.button
                  className="hist-card"
                  key={it.id || i}
                  onClick={() => setViewIndex(i)}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.025, 0.3) }}
                >
                  <div className="hist-card-img">
                    <img src={it.thumb || it.imageUrl} alt={it.type} />
                    <span className={`hist-card-badge ${it.type}`}><Icon size={12} /> {isHol ? `Holistic · ${it.sources?.length || ''}` : `${it.scale}×`}</span>
                    {it.roi && <span className="hist-card-roi"><Square size={11} /> ROI</span>}
                    {adminMode && (
                      <span className="hist-card-del" role="button" tabIndex={0} onClick={(e) => deleteOne(e, it)} title="Delete permanently">
                        <Trash2 size={15} />
                      </span>
                    )}
                    <div className="hist-card-hover"><Maximize2 size={22} /></div>
                  </div>
                  <div className="hist-card-body">
                    <strong>{it.sessionName}</strong>
                    <div className="hist-card-meta">
                      <span><Cctv size={11} /> {it.cameraEsn}</span>
                      <span><Clock size={11} /> {it.frameLabel ? it.frameLabel.slice(11) : new Date(it.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </motion.button>
              )
            })}
          </div>
        )}
      </div>

      <HistoryViewer items={filtered} index={viewIndex} onClose={() => setViewIndex(null)} onNav={navView} />

      <style>{`
        .hist { flex: 1; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        .topbar { display: flex; align-items: center; justify-content: space-between; padding: 20px 28px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .hist-wrap { flex: 1; overflow-y: auto; padding: 32px; max-width: 1180px; width: 100%; margin: 0 auto; }
        .hist-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 22px; }
        .hist-head h2 { font-size: 32px; font-weight: 800; letter-spacing: -1px; margin: 6px 0 2px; }
        .hist-sub { color: var(--text-2); font-size: 13px; }
        .hist-clear:hover { color: var(--danger); }

        .hist-delete-all { background: rgba(255,93,115,.14); border-color: rgba(255,93,115,.4); color: #ffb3bd; }
        .hist-delete-all:hover { background: rgba(255,93,115,.24); }
        .hd-spin { animation: spin .7s linear infinite; }

        .admin-banner { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; padding: 11px 14px; border-radius: var(--radius);
          background: rgba(255,93,115,.1); border: 1px solid rgba(255,93,115,.3); color: #ffc2cb; font-size: 13px; }
        .admin-banner strong { color: #fff; }
        .admin-banner-close { margin-left: auto; color: inherit; opacity: .7; display: grid; place-items: center; }
        .admin-banner-close:hover { opacity: 1; }

        .hist-card-del { position: absolute; bottom: 9px; right: 9px; z-index: 3; width: 30px; height: 30px; border-radius: 8px;
          display: grid; place-items: center; background: rgba(255,93,115,.92); color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.4);
          transform: translateY(4px); opacity: 0; transition: opacity .18s ease, transform .18s ease, background .18s ease; }
        .hist-card:hover .hist-card-del { opacity: 1; transform: translateY(0); }
        .hist-card-del:hover { background: #ff5d73; }

        .hist-filters { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
        .hist-filter { display: inline-flex; align-items: center; gap: 7px; padding: 9px 15px; border-radius: 99px; font-size: 13px; font-weight: 600; background: var(--surface); border: 1px solid var(--border); color: var(--text-1); transition: all .18s ease; }
        .hist-filter:hover { border-color: var(--border-strong); }
        .hist-filter.active { background: var(--accent-soft); border-color: rgba(124,92,255,.4); color: #fff; }
        .hist-filter-count { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 99px; background: rgba(0,0,0,.3); color: var(--text-2); }
        .hist-filter.active .hist-filter-count { background: rgba(124,92,255,.3); color: #d6ccff; }

        .hist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
        .hist-card { text-align: left; border-radius: var(--radius); overflow: hidden; background: var(--surface); border: 1px solid var(--border); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
        .hist-card:hover { transform: translateY(-4px); border-color: var(--border-strong); box-shadow: var(--shadow); }
        .hist-card-img { position: relative; aspect-ratio: 16/10; overflow: hidden; background: #000; }
        .hist-card-img img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .3s ease; }
        .hist-card:hover .hist-card-img img { transform: scale(1.05); }
        .hist-card-badge { position: absolute; top: 9px; left: 9px; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 99px; backdrop-filter: blur(6px); border: 1px solid; }
        .hist-card-badge.super_res { background: rgba(74,214,255,.2); color: #aef0ff; border-color: rgba(74,214,255,.4); }
        .hist-card-badge.holistic { background: rgba(61,220,151,.2); color: #b6f5da; border-color: rgba(61,220,151,.4); }
        .hist-card-roi { position: absolute; top: 9px; right: 9px; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 99px; background: rgba(0,0,0,.55); color: #fff; }
        .hist-card-hover { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(124,92,255,.25); color: #fff; opacity: 0; transition: opacity .2s ease; }
        .hist-card:hover .hist-card-hover { opacity: 1; }
        .hist-card-body { padding: 13px 14px; }
        .hist-card-body strong { display: block; font-size: 14px; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .hist-card-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--text-2); }
        .hist-card-meta span { display: inline-flex; align-items: center; gap: 4px; }
        .hist-card-skel { aspect-ratio: 16/12; border-radius: var(--radius); }

        .hist-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 60px 30px; border-radius: var(--radius-lg); }
        .hist-empty-ico { width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-2); border: 1px solid rgba(124,92,255,.25); margin-bottom: 6px; }
        .hist-empty h3 { font-size: 19px; font-weight: 700; }
        .hist-empty p { font-size: 14px; color: var(--text-2); margin-bottom: 12px; }
      `}</style>
    </motion.div>
  )
}
