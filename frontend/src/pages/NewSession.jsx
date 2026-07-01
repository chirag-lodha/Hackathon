import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Tag, KeyRound, ArrowRight, Loader2 } from 'lucide-react'
import Logo from '../components/Logo.jsx'
import { useSession } from '../context/SessionContext.jsx'
import { createSession } from '../api/client.js'

const fade = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 } }

export default function NewSession() {
  const nav = useNavigate()
  const { setSession } = useSession()

  const [form, setForm] = useState({ sessionName: '', authKey: '' })
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(false)

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  const validate = () => {
    const e = {}
    if (!form.sessionName.trim()) e.sessionName = 'Session name is required'
    if (!form.authKey.trim()) e.authKey = 'Auth key is required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async (ev) => {
    ev.preventDefault()
    if (!validate()) return
    setLoading(true)
    try {
      const name = form.sessionName.trim()
      const authKey = form.authKey.trim()
      const res = await createSession(name, authKey) // { id, name, expiresAt }
      setSession({ id: res.id, name, authKey })
      nav('/cameras')
    } catch (err) {
      setErrors({ submit: err.message || 'Failed to create session' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.div className="new-page" variants={fade} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.35 }}>
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => nav('/')}><ArrowLeft size={18} /> Back</button>
        <Logo size={34} />
        <div style={{ width: 90 }} />
      </header>

      <div className="form-wrap">
        <motion.form className="form-card glass" onSubmit={submit} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
          <span className="label-eyebrow">Configure capture</span>
          <h2>New session</h2>
          <p className="form-lead">Name your session and enter the account auth key — we'll load its cameras next.</p>

          <Field icon={<Tag size={16} />} label="Session name" required error={errors.sessionName}>
            <input value={form.sessionName} onChange={set('sessionName')} placeholder="e.g. Parking-lot incident" autoFocus />
          </Field>

          <Field icon={<KeyRound size={16} />} label="Auth key" required error={errors.authKey}>
            <input value={form.authKey} onChange={set('authKey')} placeholder="account auth key" type="password" className="mono-input" />
          </Field>

          {errors.submit && <div className="form-error-banner">{errors.submit}</div>}

          <button className="btn btn-primary submit-btn" type="submit" disabled={loading}>
            {loading ? (<><Loader2 size={18} className="spin-ico" /> Loading cameras…</>) : (<>Continue <ArrowRight size={18} /></>)}
          </button>
        </motion.form>
      </div>

      <style>{`
        .new-page { flex: 1; display: flex; flex-direction: column; }
        .topbar { display: flex; align-items: center; justify-content: space-between; padding: 20px 28px; border-bottom: 1px solid var(--border); }
        .form-wrap { flex: 1; display: grid; place-items: center; padding: 28px; }
        .form-card { width: 100%; max-width: 520px; padding: 38px; border-radius: var(--radius-lg); box-shadow: var(--shadow); }
        .form-card h2 { font-size: 30px; font-weight: 800; letter-spacing: -0.8px; margin: 8px 0 6px; }
        .form-lead { color: var(--text-2); font-size: 14px; margin-bottom: 28px; line-height: 1.55; }
        .submit-btn { width: 100%; margin-top: 20px; padding: 15px; font-size: 15px; }
        .spin-ico { animation: spin .7s linear infinite; }
        .form-error-banner { margin-top: 18px; padding: 12px 14px; border-radius: var(--radius-sm); background: rgba(255,93,115,.12); border: 1px solid rgba(255,93,115,.3); color: #ffb3bd; font-size: 13px; }
      `}</style>
    </motion.div>
  )
}

function Field({ icon, label, required, error, children }) {
  return (
    <div className="field">
      <div className="field-head">
        <label>{icon} {label} {required && <span className="req">*</span>}</label>
      </div>
      <div className={`field-input ${error ? 'has-error' : ''}`}>{children}</div>
      {error && <span className="field-err">{error}</span>}
      <style>{`
        .field { margin-bottom: 18px; }
        .field-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .field label { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-1); }
        .field label .req { color: var(--accent-2); }
        .field-input { background: rgba(0,0,0,.25); border: 1px solid var(--border); border-radius: var(--radius-sm); transition: border-color .2s ease, box-shadow .2s ease; }
        .field-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .field-input.has-error { border-color: var(--danger); }
        .field-input input { width: 100%; padding: 13px 15px; background: transparent; border: none; outline: none; color: var(--text-0); font-size: 14px; }
        .field-input input::placeholder { color: var(--text-2); }
        .field-input .mono-input { font-family: var(--mono); letter-spacing: .5px; }
        .field-err { display: block; margin-top: 6px; font-size: 12px; color: #ffb3bd; }
      `}</style>
    </div>
  )
}
