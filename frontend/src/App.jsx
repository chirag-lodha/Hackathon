import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Landing from './pages/Landing.jsx'
import Login from './pages/Login.jsx'
import NewSession from './pages/NewSession.jsx'
import CameraSelect from './pages/CameraSelect.jsx'
import Workspace from './pages/Workspace.jsx'
import History from './pages/History.jsx'
import VoiceAssistant from './components/VoiceAssistant.jsx'
import { useSession } from './context/SessionContext.jsx'

export default function App() {
  const location = useLocation()
  const { user, authChecked } = useSession()

  // Wait for the initial /api/me check before deciding where to send the user.
  if (!authChecked) {
    return <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}><div className="spinner" /></div>
  }

  // Not logged in → only the login page is reachable.
  if (!user) {
    return (
      <div className="app-shell">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </AnimatePresence>
      </div>
    )
  }

  // Logged in → the full app (and Goku).
  return (
    <div className="app-shell">
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Landing />} />
          <Route path="/new" element={<NewSession />} />
          <Route path="/cameras" element={<CameraSelect />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/history" element={<History />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>
      {/* Brivo — app-wide voice agent */}
      <VoiceAssistant />
    </div>
  )
}
