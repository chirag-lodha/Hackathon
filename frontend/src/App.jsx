import { Routes, Route } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { useLocation } from 'react-router-dom'
import Landing from './pages/Landing.jsx'
import NewSession from './pages/NewSession.jsx'
import Workspace from './pages/Workspace.jsx'
import History from './pages/History.jsx'
import VoiceAssistant from './components/VoiceAssistant.jsx'

export default function App() {
  const location = useLocation()
  return (
    <div className="app-shell">
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Landing />} />
          <Route path="/new" element={<NewSession />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/history" element={<History />} />
        </Routes>
      </AnimatePresence>
      {/* Goku — app-wide voice agent */}
      <VoiceAssistant />
    </div>
  )
}
