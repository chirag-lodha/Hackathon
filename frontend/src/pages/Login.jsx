import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { User, Lock, ArrowRight, Loader2 } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { authSubmit } from '../api/client.js'

const fade = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 } }

export default function Login() {
  const nav = useNavigate()
  const { setUser } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError('Enter a username and password')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await authSubmit(username.trim(), password)
      setUser({ userId: res.userId, username: res.username })
      nav('/', { replace: true })
    } catch (err) {
      setError(err.message?.includes('401') ? 'Incorrect password' : 'Could not sign in. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.div className="login" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.35 }}>
      <div className="login-wrap">
        <motion.form className="login-card glass" onSubmit={submit} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
          <div className="login-logo"><Logo size={40} /></div>
          <span className="label-eyebrow">Welcome</span>
          <h2>Sign in or create an account</h2>
          <p className="login-lead">New username? We'll create your account. Existing? We'll log you in.</p>

          <div className="field">
            <label><User size={15} /> Username</label>
            <div className="field-input"><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. chirag" autoFocus autoComplete="username" /></div>
          </div>
          <div className="field">
            <label><Lock size={15} /> Password</label>
            <div className="field-input"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" /></div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button className="btn btn-primary login-btn" type="submit" disabled={loading}>
            {loading ? <><Loader2 size={18} className="spin-ico" /> Please wait…</> : <>Continue <ArrowRight size={18} /></>}
          </button>
        </motion.form>
      </div>

      <style>{`
        .login { flex: 1; display: grid; place-items: center; padding: 28px; }
        .login-card { width: 100%; max-width: 420px; padding: 36px; border-radius: var(--radius-lg); box-shadow: var(--shadow); }
        .login-logo { display: flex; justify-content: center; margin-bottom: 22px; }
        .login-card h2 { font-size: 24px; font-weight: 800; letter-spacing: -.5px; margin: 8px 0 6px; }
        .login-lead { color: var(--text-2); font-size: 13px; margin-bottom: 24px; line-height: 1.5; }
        .field { margin-bottom: 16px; }
        .field label { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-1); margin-bottom: 8px; }
        .field-input { background: rgba(0,0,0,.25); border: 1px solid var(--border); border-radius: var(--radius-sm); transition: border-color .2s, box-shadow .2s; }
        .field-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .field-input input { width: 100%; padding: 13px 15px; background: transparent; border: none; outline: none; color: var(--text-0); font-size: 14px; }
        .login-btn { width: 100%; margin-top: 10px; padding: 14px; font-size: 15px; }
        .login-error { margin-bottom: 14px; padding: 11px 13px; border-radius: var(--radius-sm); background: rgba(255,93,115,.12); border: 1px solid rgba(255,93,115,.3); color: #ffb3bd; font-size: 13px; }
        .spin-ico { animation: spin .7s linear infinite; }
      `}</style>
    </motion.div>
  )
}
