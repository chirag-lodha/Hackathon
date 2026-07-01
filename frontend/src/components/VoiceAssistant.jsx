import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic, X, Bot, Loader2, Volume2, Send } from 'lucide-react'
import { useSession } from '../context/SessionContext.jsx'
import { createSession, chatAgent } from '../api/client.js'

/**
 * "Brivo" — a Gemini-powered voice agent. It listens (browser STT), sends the
 * conversation + current app context to the backend /api/chat (Gemini), then
 * speaks the reply (browser TTS) and executes the returned UI actions:
 * navigation/session here, in-workspace actions via the command bus.
 */

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
const speechOK = typeof window !== 'undefined' && 'speechSynthesis' in window

let greetedThisLoad = false
let welcomeSpoken = false

export default function VoiceAssistant() {
  const nav = useNavigate()
  const loc = useLocation()
  const { session, setSession, camera, setCamera, addHistory, dispatchCommand, workspaceStatus } = useSession()

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([]) // {role:'user'|'model', text}
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [typed, setTyped] = useState('')
  const [conversing, setConversing] = useState(false)
  const conversingRef = useRef(false)
  const [voices, setVoices] = useState([])
  const [voiceURI, setVoiceURI] = useState('')
  const voiceURIRef = useRef('')
  voiceURIRef.current = voiceURI

  const recRef = useRef(null)
  const messagesRef = useRef([])
  messagesRef.current = messages
  const sessionRef = useRef(session)
  sessionRef.current = session
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const wsRef = useRef(workspaceStatus)
  wsRef.current = workspaceStatus

  const pushMsg = (role, text) => setMessages((m) => [...m, { role, text }])

  // ---- speech: TTS ----
  const speak = useCallback((text) => {
    return new Promise((resolve) => {
      if (!speechOK || !text) { resolve(); return }
      const synth = window.speechSynthesis
      const utter = () => {
        try {
          synth.cancel()
          const u = new SpeechSynthesisUtterance(text)
          u.lang = 'en-US'
          u.rate = 1.06   // a touch quicker + livelier
          u.pitch = 0.9   // a bit deeper for a more heroic/male tone
          const all = synth.getVoices()
          const v = all.find((x) => x.voiceURI === voiceURIRef.current) || all.find((x) => /^en([-_]|$)/i.test(x.lang))
          if (v) u.voice = v
          u.onstart = () => setSpeaking(true)
          u.onend = () => { setSpeaking(false); resolve() }
          u.onerror = () => { setSpeaking(false); resolve() }
          synth.resume()
          synth.speak(u)
        } catch { resolve() }
      }
      if (synth.getVoices().length === 0) {
        let fired = false
        const go = () => { if (!fired) { fired = true; utter() } }
        try { synth.addEventListener('voiceschanged', go, { once: true }) } catch {}
        setTimeout(go, 350)
      } else utter()
    })
  }, [])

  // ---- speech: STT (one phrase) ----
  const listen = useCallback(() => {
    return new Promise((resolve, reject) => {
      if (!SR) { reject(new Error('no-stt')); return }
      const rec = new SR()
      recRef.current = rec
      rec.lang = 'en-US'
      rec.interimResults = false
      rec.maxAlternatives = 1
      setListening(true)
      let done = false
      rec.onresult = (e) => { done = true; resolve(e.results[0][0].transcript) }
      rec.onerror = (e) => { done = true; reject(new Error(e.error || 'speech-error')) }
      rec.onend = () => { setListening(false); if (!done) reject(new Error('no-speech')) }
      try { rec.start() } catch (e) { reject(e) }
    })
  }, [])

  const buildContext = () => {
    const s = sessionRef.current
    const c = cameraRef.current
    const ws = wsRef.current || {}
    return {
      route: loc.pathname,
      hasSession: !!s,
      sessionName: s?.name || '',
      hasCamera: !!c,
      cameraEsn: c?.esn || '',
      cameraName: c?.name || '',
      frameCount: ws.frameCount ?? 0,
      frameSelected: !!ws.frameSelected,
      hasResult: !!ws.hasResult,
      mode: ws.mode || '',
    }
  }

  // ---- execute one action returned by the agent ----
  const runAction = useCallback(async (action) => {
    const p = action.params || {}
    switch (action.type) {
      case 'create_session': {
        // New flow: a session is just a name + account auth key; the cameras page
        // loads next. The auth key must be provided (spoken/typed) by the user.
        if (!p.authKey) return
        const name = (p.sessionName || 'Voice session').trim()
        const authKey = String(p.authKey).trim()
        const res = await createSession(name, authKey) // { id, name }
        setSession({ id: res.id, name, authKey })
        setCamera(null)
        addHistory({ type: 'session', createdAt: new Date().toISOString(), sessionName: name })
        nav('/cameras')
        break
      }
      case 'select_camera': {
        // Open a specific camera by ESN (the cameras grid feeds ESNs into context).
        if (!p.cameraEsn) return
        const esn = String(p.cameraEsn).trim()
        setCamera({ esn, name: p.cameraName || esn, anchorTs: p.aroundTs || '' })
        nav('/workspace')
        break
      }
      case 'open_cameras': nav('/cameras'); break
      case 'open_history': nav('/history'); break
      case 'go_home': nav('/'); break
      // in-workspace actions → command bus (Workspace executes)
      case 'select_frame':
      case 'set_roi':
      case 'clear_roi':
      case 'super_res':
      case 'gemini_enhance':
      case 'holistic':
      case 'super_saiyan':
        if (loc.pathname !== '/workspace') nav('/workspace')
        dispatchCommand({ type: action.type, params: p })
        break
      default:
        break
    }
  }, [loc.pathname, nav, setSession, setCamera, addHistory, dispatchCommand])

  // ---- one turn: send user text to Gemini, speak reply, run actions ----
  const sendToAgent = useCallback(async (userText) => {
    pushMsg('user', userText)
    setThinking(true)
    try {
      const history = [...messagesRef.current, { role: 'user', text: userText }]
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text }))
      const res = await chatAgent({ messages: history, context: buildContext() })
      setThinking(false)
      if (res.reply) pushMsg('model', res.reply)
      await speak(res.reply)
      for (const a of res.actions || []) {
        try { await runAction(a) } catch (e) { console.error('action failed', a, e) }
      }
    } catch (e) {
      setThinking(false)
      const msg = 'Sorry, I had trouble reaching my brain.'
      pushMsg('model', msg)
      await speak(msg)
    }
  }, [speak, runAction]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- continuous conversation: listen → respond → listen again (hands-free) ----
  const stopConversation = useCallback(() => {
    conversingRef.current = false
    setConversing(false)
    try { recRef.current && recRef.current.abort() } catch {}
    setListening(false)
  }, [])

  const conversationLoop = useCallback(async () => {
    while (conversingRef.current) {
      let text
      try {
        text = await listen()
      } catch (e) {
        if (!conversingRef.current) break
        if (e.message === 'no-speech') continue // stay listening through silence
        break // permission denied / fatal → stop
      }
      if (!conversingRef.current) break
      if (text && text.trim()) await sendToAgent(text) // speaks reply + runs actions
    }
    setConversing(false)
  }, [listen, sendToAgent])

  const toggleConversation = useCallback(async () => {
    if (conversingRef.current) { stopConversation(); return }
    if (!SR) return
    conversingRef.current = true
    setConversing(true)
    if (!welcomeSpoken) {
      welcomeSpoken = true
      const greet = "Hey! I'm Brivo. Which camera should we enhance today?"
      pushMsg('model', greet)
      await speak(greet)
    }
    conversationLoop()
  }, [conversationLoop, stopConversation, speak])

  const submitTyped = async (e) => {
    e.preventDefault()
    const t = typed.trim()
    if (!t) return
    setTyped('')
    await sendToAgent(t)
  }

  // Load voices; default to a male English voice (closest to a "Goku" tone).
  useEffect(() => {
    if (!speechOK) return
    const MALE = /(\bmale\b|david|george|james|daniel|fred|guy|arthur|rishi|mark|paul|alex|man\b)/i
    const update = () => {
      const list = window.speechSynthesis.getVoices()
      setVoices(list)
      setVoiceURI((cur) => {
        if (cur && list.some((v) => v.voiceURI === cur)) return cur
        const en = list.filter((v) => /^en/i.test(v.lang))
        const pick = en.find((v) => MALE.test(v.name)) || en[0] || list[0]
        return pick ? pick.voiceURI : ''
      })
    }
    update()
    try { window.speechSynthesis.addEventListener('voiceschanged', update) } catch {}
    return () => { try { window.speechSynthesis.removeEventListener('voiceschanged', update) } catch {} }
  }, [])

  // Tap the FAB → open + greet + start listening hands-free.
  const wakeBrivo = useCallback(() => {
    setOpen(true)
    if (!conversingRef.current) toggleConversation() // greets (first time) + listens
  }, [toggleConversation])

  // Welcome on app start: open + show text; speak on first interaction (browsers
  // gate audio behind a gesture) or via best-effort autoplay if allowed.
  useEffect(() => {
    const welcome = "Hi! I'm Brivo, your super-resolution assistant. Tap the mic and just talk to me — tell me a camera and let's enhance some footage!"
    if (!greetedThisLoad) { greetedThisLoad = true; setOpen(true); pushMsg('model', welcome) }
    if (welcomeSpoken) return
    const evs = ['pointerdown', 'keydown', 'touchstart']
    const fire = () => { if (welcomeSpoken) return; welcomeSpoken = true; evs.forEach((e) => window.removeEventListener(e, fire)); speak(welcome) }
    evs.forEach((e) => window.addEventListener(e, fire))
    const timer = setTimeout(() => {
      if (welcomeSpoken) return
      const synth = window.speechSynthesis
      if (!synth || synth.getVoices().length === 0) return
      try {
        const u = new SpeechSynthesisUtterance(welcome)
        u.lang = 'en-US'; u.pitch = 0.9; u.rate = 1.06
        u.onstart = () => { welcomeSpoken = true; setSpeaking(true); evs.forEach((e) => window.removeEventListener(e, fire)) }
        u.onend = () => setSpeaking(false)
        synth.cancel(); synth.resume(); synth.speak(u)
      } catch {}
    }, 600)
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, fire)) }
  }, [speak])

  const close = () => {
    stopConversation()
    try { window.speechSynthesis.cancel() } catch {}
    setSpeaking(false)
    setOpen(false)
  }

  return (
    <>
      <button className="va-fab" onClick={wakeBrivo} title="Talk to Brivo">
        <Mic size={22} />
        <span className="va-fab-ring" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="va-panel glass"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          >
            <div className="va-head">
              <div className="va-head-l">
                <div className="va-ava"><Bot size={18} /></div>
                <div>
                  <strong>Brivo</strong>
                  <span className="va-status">
                    {speaking ? <><Volume2 size={12} /> speaking…</> : listening ? <><Mic size={12} /> listening…</> : thinking ? <><Loader2 size={12} className="va-spin" /> thinking…</> : conversing ? <><Mic size={12} /> live · tap mic to stop</> : 'AI super-res assistant'}
                  </span>
                </div>
              </div>
              <button className="va-x" onClick={close}><X size={18} /></button>
            </div>

            <div className="va-thread">
              {messages.map((m, i) => (
                <div key={i} className={`va-msg ${m.role}`}>{m.text}</div>
              ))}
              {(listening || speaking || thinking) && (
                <div className="va-wave">{[0,1,2,3,4].map((b) => <span key={b} style={{ animationDelay: `${b * 0.12}s` }} />)}</div>
              )}
            </div>

            <form className="va-input" onSubmit={submitTyped}>
              <button type="button" className={`va-mic ${conversing ? 'on' : ''}`} onClick={toggleConversation} disabled={!SR} title={SR ? (conversing ? 'Tap to stop' : 'Tap to talk (hands-free)') : 'Voice not supported'}>
                <Mic size={18} />
              </button>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={SR ? (conversing ? 'Listening… just speak' : 'Tap mic to talk, or type…') : 'Type a message…'} disabled={thinking || speaking} />
              <button type="submit" className="va-send" disabled={thinking || speaking || !typed.trim()}><Send size={16} /></button>
            </form>
            <div className="va-foot">
              <label className="va-voice">
                🔊
                <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)} disabled={!voices.length}>
                  {!voices.length && <option>no voices</option>}
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                  ))}
                </select>
                <button type="button" className="va-voice-test" onClick={() => speak("Hi, I'm Brivo! Let's enhance those cameras!")}>Try</button>
              </label>
              <span className="va-hint">{conversing ? 'Live — just talk' : 'Tap the mic for a hands-free chat'}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .va-fab { position: fixed; right: 26px; bottom: 26px; z-index: 40; width: 58px; height: 58px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--accent-grad); box-shadow: var(--accent-glow); }
        .va-fab-ring { position: absolute; inset: -6px; border-radius: 50%; border: 1px solid rgba(124,92,255,.5); animation: vapulse 2.4s ease-in-out infinite; }
        @keyframes vapulse { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }

        .va-panel { position: fixed; right: 26px; bottom: 26px; z-index: 41; width: 390px; max-width: calc(100vw - 32px); height: 70vh; max-height: 620px; display: flex; flex-direction: column; border-radius: var(--radius-lg); box-shadow: var(--shadow); overflow: hidden; }
        .va-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); }
        .va-head-l { display: flex; align-items: center; gap: 10px; }
        .va-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-2); }
        .va-dot.live { background: var(--success); box-shadow: 0 0 0 4px rgba(61,220,151,.2); animation: vapulse 1.2s ease-in-out infinite; }
        .va-head-l strong { display: block; font-size: 14px; }
        .va-status { font-size: 11px; color: var(--text-2); display: inline-flex; align-items: center; gap: 5px; }
        .va-x { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--text-1); }
        .va-x:hover { background: var(--surface-2); }

        .goku-stage { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px 16px 8px;
          background: radial-gradient(120% 90% at 50% 0%, rgba(255,180,60,.10), transparent 60%); transition: background .4s ease; }
        .goku-stage.ss { background: radial-gradient(120% 100% at 50% 0%, rgba(255,215,90,.28), transparent 65%); }
        .goku-bubble { max-width: 92%; padding: 11px 15px; border-radius: 16px; border-top-left-radius: 5px; font-size: 14px; line-height: 1.5;
          background: var(--surface-2); border: 1px solid var(--border); color: var(--text-0); text-align: center;
          animation: goku-pop .3s ease; }
        @keyframes goku-pop { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }

        .va-thread { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; opacity: .85; }
        .va-msg { max-width: 84%; padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 1.45; }
        .va-msg.model { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--border); border-bottom-left-radius: 5px; }
        .va-msg.user { align-self: flex-end; background: var(--accent-grad); color: #fff; border-bottom-right-radius: 5px; }
        .va-wave { display: flex; gap: 4px; align-self: flex-start; padding: 6px 4px; }
        .va-wave span { width: 4px; height: 16px; border-radius: 4px; background: var(--accent-2); animation: vabar .9s ease-in-out infinite; }
        @keyframes vabar { 0%,100% { transform: scaleY(.4); opacity: .5; } 50% { transform: scaleY(1); opacity: 1; } }

        .va-input { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
        .va-mic { width: 40px; height: 40px; flex-shrink: 0; border-radius: 11px; display: grid; place-items: center; background: var(--accent-grad); color: #fff; }
        .va-mic.on { animation: vapulse 1s ease-in-out infinite; }
        .va-mic:disabled { opacity: .5; }
        .va-input input { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,.25); border: 1px solid var(--border); color: var(--text-0); font-size: 13px; outline: none; }
        .va-input input:focus { border-color: var(--accent); }
        .va-send { width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-0); }
        .va-send:disabled { opacity: .4; }
        .va-foot { padding: 8px 12px 12px; font-size: 10px; color: var(--text-2); display: flex; flex-direction: column; gap: 5px; }
        .va-voice { display: flex; align-items: center; gap: 6px; }
        .va-voice select { flex: 1; min-width: 0; font-size: 11px; padding: 5px 7px; border-radius: 7px; background: rgba(0,0,0,.25); color: var(--text-0); border: 1px solid var(--border); color-scheme: dark; }
        .va-voice-test { flex-shrink: 0; font-size: 11px; font-weight: 600; padding: 5px 10px; border-radius: 7px; background: var(--accent-soft); color: #c3b4ff; border: 1px solid rgba(124,92,255,.3); }
        .va-voice-test:hover { background: rgba(124,92,255,.22); }
        .va-hint { color: var(--text-2); }
        .va-spin { animation: spin .7s linear infinite; }
      `}</style>
    </>
  )
}
