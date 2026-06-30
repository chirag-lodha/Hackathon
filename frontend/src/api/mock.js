/* ============================================================
   Mock backend — generates fully offline placeholder data so the
   entire UI is demoable before the Go backend exists.
   Every shape here mirrors what the real /api endpoints will return.
   ============================================================ */

const PALETTES = [
  ['#1e3a8a', '#7c5cff'],
  ['#0f766e', '#4ad6ff'],
  ['#9d174d', '#f97316'],
  ['#4338ca', '#06b6d4'],
  ['#7c2d12', '#fbbf24'],
  ['#155e75', '#a3e635'],
]

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Build a data-URL "frame" image. blur simulates low-res capture. */
function makeFrame({ seed, w, h, blur = 0, label = '', sharp = false }) {
  const p = PALETTES[hashStr(seed) % PALETTES.length]
  const cx = (hashStr(seed + 'x') % 80) + 10
  const cy = (hashStr(seed + 'y') % 80) + 10
  const noiseOpacity = sharp ? 0.04 : 0.14
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${p[0]}"/>
        <stop offset="1" stop-color="${p[1]}"/>
      </linearGradient>
      <radialGradient id="r" cx="${cx}%" cy="${cy}%" r="60%">
        <stop offset="0" stop-color="rgba(255,255,255,.35)"/>
        <stop offset="1" stop-color="rgba(255,255,255,0)"/>
      </radialGradient>
      <filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter>
    </defs>
    <g ${blur ? 'filter="url(#b)"' : ''}>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <rect width="${w}" height="${h}" fill="url(#r)"/>
      ${Array.from({ length: 7 }).map((_, i) => {
        const rx = (hashStr(seed + i) % w)
        const ry = (hashStr(seed + 'a' + i) % h)
        const rs = (hashStr(seed + 'b' + i) % (w / 5)) + 12
        return `<rect x="${rx}" y="${ry}" width="${rs}" height="${rs}" rx="6" fill="rgba(255,255,255,${noiseOpacity})"/>`
      }).join('')}
      <rect x="${w * 0.32}" y="${h * 0.42}" width="${w * 0.36}" height="${h * 0.34}" rx="8" fill="rgba(0,0,0,.25)"/>
      <circle cx="${w * 0.5}" cy="${h * 0.4}" r="${w * 0.07}" fill="rgba(255,255,255,.5)"/>
    </g>
    ${label ? `<text x="12" y="${h - 14}" font-family="monospace" font-size="${Math.round(w/26)}" fill="rgba(255,255,255,.85)">${label}</text>` : ''}
  </svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

function fmtTime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

/** ±5s window of frames around an anchor time (default 2 fps -> ~21 frames). */
export function mockFetchFrames({ cameraEsn, sessionName, anchorTime, direction = 'around', cursor }) {
  const fps = 2
  const half = 5 // seconds each side
  let base
  if (direction === 'around') {
    base = anchorTime ? new Date(anchorTime) : new Date()
  } else {
    base = new Date(cursor)
  }

  const frames = []
  const total = half * 2 * fps + 1 // ~21
  let startOffset
  if (direction === 'around') startOffset = -half * fps
  else if (direction === 'left') startOffset = -total
  else startOffset = 1

  for (let i = 0; i < total; i++) {
    const tickMs = (startOffset + i) * (1000 / fps)
    const t = new Date(base.getTime() + tickMs)
    const seed = `${cameraEsn}-${t.getTime()}`
    frames.push({
      id: seed,
      path: `/captures/${cameraEsn}/${t.getTime()}.jpg`,
      timestamp: t.toISOString(),
      label: fmtTime(t),
      thumb: makeFrame({ seed, w: 200, h: 120, blur: 1.4, label: fmtTime(t).slice(11) }),
    })
  }

  const earliest = new Date(base.getTime() + startOffset * (1000 / fps)).toISOString()
  const latest = new Date(base.getTime() + (startOffset + total - 1) * (1000 / fps)).toISOString()
  return Promise.resolve({
    frames,
    cursors: { left: earliest, right: latest },
    cameraEsn,
    sessionName,
  })
}

export function mockSuperResolve({ imagePath, roi }) {
  const seed = imagePath + JSON.stringify(roi || 'full')
  return new Promise((res) =>
    setTimeout(
      () =>
        res({
          type: 'super_res',
          imageUrl: makeFrame({ seed, w: 1024, h: 640, blur: 0, sharp: true, label: 'SUPER-RES 4×' }),
          sourceUrl: makeFrame({ seed, w: 256, h: 160, blur: 2.2 }),
          width: 1024,
          height: 640,
          scale: 4,
          roi: roi || null,
          ms: 1400,
        }),
      1300,
    ),
  )
}

/** Seeded set of previously-converted results, as if stored server-side. */
export function mockFetchHistory() {
  const sessions = [
    { name: 'Parking-lot incident', esn: '1001A2B3' },
    { name: 'Lobby entrance', esn: '2044C7D1' },
    { name: 'Loading dock sweep', esn: '3098E5F2' },
    { name: 'North gate plates', esn: '4012B9A6' },
  ]
  const baseTs = Date.parse('2026-06-29T09:00:00Z')
  const records = []
  for (let i = 0; i < 14; i++) {
    const s = sessions[i % sessions.length]
    const isHolistic = i % 3 === 0
    const ts = new Date(baseTs - i * 1000 * 60 * 37) // ~37 min apart, descending
    const frameTs = new Date(ts.getTime() - 4000 + (i % 9) * 1000)
    const seed = `${s.esn}-${frameTs.getTime()}-${i}`
    const roi = i % 2 === 0 ? { x: 0.28 + (i % 3) * 0.05, y: 0.3, w: 0.34, h: 0.3 } : null
    const common = {
      id: `hist-${seed}`,
      createdAt: ts.toISOString(),
      sessionName: s.name,
      cameraEsn: s.esn,
      framePath: `/captures/${s.esn}/${frameTs.getTime()}.jpg`,
      frameLabel: fmtTime(frameTs),
      roi,
    }
    if (isHolistic) {
      const camCount = 3 + (hashStr(seed) % 3)
      records.push({
        ...common,
        type: 'holistic',
        ms: 1800 + (hashStr(seed) % 900),
        imageUrl: makeFrame({ seed: seed + 'holistic', w: 1024, h: 640, sharp: true, label: `HOLISTIC · ${camCount} CAMS` }),
        thumb: makeFrame({ seed: seed + 'holistic', w: 320, h: 200, sharp: true }),
        sources: Array.from({ length: camCount }).map((_, j) => ({
          esn: `${s.esn.slice(0, 4)}${(hashStr(seed + j) % 9000) + 1000}`,
          angle: ['Front', 'Left 30°', 'Right 30°', 'Overhead', 'Rear'][j % 5],
          thumb: makeFrame({ seed: seed + 'cam' + j, w: 220, h: 140, blur: 0.6, sharp: true }),
        })),
      })
    } else {
      records.push({
        ...common,
        type: 'super_res',
        scale: 4,
        ms: 1100 + (hashStr(seed) % 800),
        imageUrl: makeFrame({ seed, w: 1024, h: 640, sharp: true, label: 'SUPER-RES 4×' }),
        sourceUrl: makeFrame({ seed, w: 256, h: 160, blur: 2.2 }),
        thumb: makeFrame({ seed, w: 320, h: 200, sharp: true }),
      })
    }
  }
  return Promise.resolve({ records })
}

export function mockAlternateOperation({ imagePath, cameraEsn, roi }) {
  const seed = imagePath + (roi ? JSON.stringify(roi) : '')
  const camCount = 3 + (hashStr(cameraEsn) % 3)
  const sources = Array.from({ length: camCount }).map((_, i) => ({
    esn: `${cameraEsn.slice(0, 4)}${(hashStr(cameraEsn + i) % 9000) + 1000}`,
    angle: ['Front', 'Left 30°', 'Right 30°', 'Overhead', 'Rear'][i % 5],
    thumb: makeFrame({ seed: seed + 'cam' + i, w: 220, h: 140, blur: 0.6, sharp: true }),
  }))
  return new Promise((res) =>
    setTimeout(
      () =>
        res({
          type: 'holistic',
          imageUrl: makeFrame({ seed: seed + 'holistic', w: 1024, h: 640, blur: 0, sharp: true, label: `HOLISTIC · ${camCount} CAMS` }),
          sources,
          roi: roi || null,
          ms: 2100,
        }),
      1900,
    ),
  )
}
