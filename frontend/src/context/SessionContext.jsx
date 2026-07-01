import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { fetchMe } from '../api/client.js'

const SessionContext = createContext(null)

const HISTORY_KEY = 'lumina.history'
const ADMIN_KEY = 'lumina.admin'
// Secret sequence: type this (outside any text field) to toggle hidden delete mode.
const SECRET = 'delete'

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

export function SessionProvider({ children }) {
  // Auth: logged-in user (null = logged out). authChecked flips once /api/me resolves.
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    fetchMe().then((u) => setUser(u)).finally(() => setAuthChecked(true))
  }, [])

  // The active session config submitted from the New form.
  const [session, setSession] = useState(null)
  const [history, setHistory] = useState(loadHistory)

  // Hidden admin (delete) mode — revealed only via the secret key sequence.
  const [adminMode, setAdminMode] = useState(() => {
    try {
      return sessionStorage.getItem(ADMIN_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggleAdmin = useCallback(() => {
    setAdminMode((v) => {
      const next = !v
      try {
        sessionStorage.setItem(ADMIN_KEY, next ? '1' : '0')
      } catch {}
      return next
    })
  }, [])

  // Listen for the secret sequence. Ignored while typing in an input/textarea.
  useEffect(() => {
    let buf = ''
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return
      if (e.key && e.key.length === 1) {
        buf = (buf + e.key.toLowerCase()).slice(-SECRET.length)
        if (buf === SECRET) {
          toggleAdmin()
          buf = ''
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleAdmin])

  const addHistory = useCallback((entry) => {
    setHistory((prev) => {
      const next = [{ ...entry, id: entry.id || `${entry.createdAt}-${Math.round(performance.now())}` }, ...prev].slice(0, 100)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  const removeHistory = useCallback((id) => {
    setHistory((prev) => {
      const next = prev.filter((h) => String(h.id) !== String(id))
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {}
  }, [])

  // Command QUEUE: Goku (the voice agent, mounted app-wide) enqueues UI commands
  // that the Workspace consumes one-by-one (select frame, super-res, holistic, 3D).
  // A queue (not a single slot) preserves order for multi-step actions.
  const [commandQueue, setCommandQueue] = useState([])
  const dispatchCommand = useCallback((cmd) => {
    setCommandQueue((q) => [...q, { ...cmd, _id: `${cmd.type}-${Math.round(performance.now())}-${Math.random()}` }])
  }, [])
  const shiftCommand = useCallback(() => setCommandQueue((q) => q.slice(1)), [])

  // Workspace publishes its live status here so the assistant knows the state.
  const [workspaceStatus, setWorkspaceStatus] = useState({})

  return (
    <SessionContext.Provider
      value={{
        user, setUser, authChecked,
        session, setSession, history, addHistory, removeHistory, clearHistory,
        adminMode, toggleAdmin, commandQueue, dispatchCommand, shiftCommand,
        workspaceStatus, setWorkspaceStatus,
      }}
    >
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
