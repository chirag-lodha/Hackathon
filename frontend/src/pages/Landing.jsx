import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Plus, History as HistoryIcon, ArrowRight, Sparkles, LogOut } from 'lucide-react'
import { useSession } from '../context/SessionContext.jsx'

const fade = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
}

export default function Landing() {
  const nav = useNavigate()
  const { user, logout } = useSession()

  const doLogout = () => logout() // clears cookie + persisted session/camera

  return (
    <motion.div className="landing" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.4 }}>
      {user && (
        <div className="landing-topbar">
          <span className="landing-user">{user.username}</span>
          <button className="btn btn-ghost landing-logout" onClick={doLogout}><LogOut size={15} /> Logout</button>
        </div>
      )}
      <div className="landing-inner">
        <motion.img
          className="hero-brivo"
          src="/brivo-logo-light.svg"
          alt="Brivo"
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 140, damping: 14 }}
        />

        <motion.span className="chip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <Sparkles size={13} /> AI camera intelligence
        </motion.span>

        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          Lumina
        </motion.h1>
        <motion.p className="hero-tag" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}>
          Pull any moment from your cameras and turn low-resolution frames into crisp, high-fidelity imagery.
        </motion.p>

        <motion.div className="choice-grid" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }}>
          <button className="choice-card primary" onClick={() => nav('/new')}>
            <div className="choice-icon"><Plus size={26} /></div>
            <div className="choice-body">
              <h3>New capture</h3>
              <p>Start a session, pick a camera & moment, and enhance frames.</p>
            </div>
            <ArrowRight className="choice-arrow" size={20} />
          </button>

          <button className="choice-card" onClick={() => nav('/history')}>
            <div className="choice-icon"><HistoryIcon size={24} /></div>
            <div className="choice-body">
              <h3>History</h3>
              <p>Revisit past sessions, enhancements, and holistic views.</p>
            </div>
            <ArrowRight className="choice-arrow" size={20} />
          </button>
        </motion.div>
      </div>

      <style>{`
        .landing { position: relative; flex: 1; display: grid; place-items: center; padding: 32px; }
        .landing-topbar { position: absolute; top: 20px; right: 24px; display: flex; align-items: center; gap: 12px; }
        .landing-user { font-size: 13px; color: var(--text-1); font-weight: 600; }
        .landing-logout { padding: 8px 14px; font-size: 13px; }
        .landing-logout:hover { color: var(--danger); }
        .landing-inner { width: 100%; max-width: 760px; display: flex; flex-direction: column; align-items: center; text-align: center; }
        .hero-brivo { height: 58px; width: auto; margin-bottom: 28px; filter: drop-shadow(0 8px 28px rgba(115,157,210,.35)); }

        h1 { font-size: 58px; font-weight: 800; letter-spacing: -2px; margin: 16px 0 8px;
             background: linear-gradient(180deg, #fff, #b9b9cc); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .hero-tag { color: var(--text-1); font-size: 17px; max-width: 520px; line-height: 1.55; margin-bottom: 40px; }

        .choice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; width: 100%; }
        .choice-card {
          position: relative; text-align: left; display: flex; align-items: center; gap: 16px;
          padding: 24px; border-radius: var(--radius-lg);
          background: var(--surface); border: 1px solid var(--border);
          backdrop-filter: blur(18px); transition: all .22s ease; overflow: hidden;
        }
        .choice-card::before {
          content: ''; position: absolute; inset: 0; opacity: 0; transition: opacity .25s ease;
          background: radial-gradient(400px 200px at 0% 0%, rgba(124,92,255,.15), transparent 70%);
        }
        .choice-card:hover { transform: translateY(-3px); border-color: var(--border-strong); box-shadow: var(--shadow); }
        .choice-card:hover::before { opacity: 1; }
        .choice-card.primary { border-color: rgba(124,92,255,.35); }
        .choice-icon {
          flex-shrink: 0; width: 54px; height: 54px; border-radius: 16px; display: grid; place-items: center;
          background: var(--accent-soft); color: var(--accent-2); border: 1px solid rgba(124,92,255,.25);
        }
        .choice-card.primary .choice-icon { background: var(--accent-grad); color: #fff; border: none; }
        .choice-body { flex: 1; }
        .choice-body h3 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
        .choice-body p { font-size: 13px; color: var(--text-2); line-height: 1.5; }
        .choice-arrow { color: var(--text-2); transition: transform .2s ease, color .2s ease; }
        .choice-card:hover .choice-arrow { transform: translateX(4px); color: var(--accent-2); }

        @media (max-width: 640px) { .choice-grid { grid-template-columns: 1fr; } h1 { font-size: 44px; } }
      `}</style>
    </motion.div>
  )
}
