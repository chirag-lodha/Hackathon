import { useState, useEffect } from 'react'
import { imageStatus } from '../api/client.js'

/**
 * Polls an image's Gemini vision caption until it resolves (SUCCESS/FAILURE) or
 * we give up. Returns { caption, state } where state is
 * '' | 'PROCESSING' | 'SUCCESS' | 'FAILURE'. Enable only once the image itself is
 * downloaded (the caption is generated after the download).
 */
export function useImageCaption(imageId, enabled = true) {
  const [caption, setCaption] = useState('')
  const [state, setState] = useState('')

  useEffect(() => {
    setCaption('')
    setState('')
    if (!imageId || !enabled) return
    let alive = true
    let tries = 0
    let timer = null

    const poll = async () => {
      try {
        const s = await imageStatus(imageId)
        if (!alive) return
        if (s.caption) setCaption(s.caption)
        setState(s.captionState || '')
        if (s.captionState === 'SUCCESS' || s.captionState === 'FAILURE') {
          clearInterval(timer)
          return
        }
      } catch {
        /* keep polling */
      }
      if (++tries > 30) clearInterval(timer) // ~45s cap
    }

    poll()
    timer = setInterval(poll, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [imageId, enabled])

  return { caption, state }
}
