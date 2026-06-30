import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * "Super-Saiyan" 3D view of a holistic result. We do NOT reconstruct 3D
 * geometry — the fused result + each source camera image are placed as flat
 * panels in an orbitable 3D scene (center = fused, arc = source cameras, with
 * lines feeding in). Pure Three.js so it stays light.
 */
export default function Holistic3D({ result }) {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !result) return

    const w = mount.clientWidth || 800
    const h = mount.clientHeight || 500

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#07070c')
    scene.fog = new THREE.Fog('#07070c', 9, 24)

    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100)
    camera.position.set(1.4, 1.2, 7.6)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.7
    controls.target.set(0, 0.4, 0)
    controls.minDistance = 3
    controls.maxDistance = 18

    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const p1 = new THREE.PointLight(0x7c5cff, 60, 40); p1.position.set(-4, 5, 4); scene.add(p1)
    const p2 = new THREE.PointLight(0x4ad6ff, 40, 40); p2.position.set(5, 3, -3); scene.add(p2)

    const grid = new THREE.GridHelper(28, 28, 0x3a3a5a, 0x1a1a2a)
    grid.position.y = -1.6
    scene.add(grid)

    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    const disposables = [grid.geometry, grid.material]

    // A framed image panel: image plane + a glowing colored border behind it.
    const panel = (url, pw, ph, accent) => {
      const grp = new THREE.Group()
      const borderGeo = new THREE.PlaneGeometry(pw + 0.12, ph + 0.12)
      const borderMat = new THREE.MeshBasicMaterial({ color: accent })
      const border = new THREE.Mesh(borderGeo, borderMat)
      border.position.z = -0.02
      const tex = loader.load(url)
      tex.colorSpace = THREE.SRGBColorSpace
      const imgGeo = new THREE.PlaneGeometry(pw, ph)
      const imgMat = new THREE.MeshBasicMaterial({ map: tex })
      const img = new THREE.Mesh(imgGeo, imgMat)
      grp.add(border, img)
      disposables.push(borderGeo, borderMat, imgGeo, imgMat, tex)
      return grp
    }

    // Center: ONLY the main image (primary camera). Falls back to the fused
    // result if there are no individual sources.
    const sources = result.sources || []
    const mainUrl = sources[0]?.thumb || result.imageUrl
    const center = panel(mainUrl, 3.0, 1.9, 0x7c5cff)
    center.position.set(0, 0.4, 0)
    scene.add(center)

    // All other source cameras placed BY THEIR DIRECTION (whatever the API
    // returns). Each direction has a base position + a spread axis so multiple
    // cameras in the same direction don't overlap. Unknown labels fall back to
    // an even arc, so any source/angle the API sends still renders sensibly.
    const buckets = {
      left: { base: [-3.0, 0.3, -0.2], spread: [-1.7, 0, -0.5] },
      right: { base: [3.0, 0.3, -0.2], spread: [1.7, 0, -0.5] },
      overhead: { base: [0, 2.5, -0.9], spread: [1.8, 0, 0] },
      rear: { base: [0, 0.4, -3.6], spread: [1.8, 0, 0] },
      front: { base: [0, -1.7, 2.4], spread: [1.8, 0, 0] },
    }
    const classify = (angle) => {
      const a = (angle || '').toLowerCase()
      if (a.includes('left')) return 'left'
      if (a.includes('right')) return 'right'
      if (a.includes('over') || a.includes('top') || a.includes('above') || a.includes('ceil')) return 'overhead'
      if (a.includes('rear') || a.includes('back') || a.includes('behind')) return 'rear'
      if (a.includes('front')) return 'front'
      return null
    }

    const others = sources.slice(1)
    const used = {}
    others.forEach((s, i) => {
      const b = classify(s.angle)
      let px, py, pz
      if (b) {
        const k = used[b] || 0
        used[b] = k + 1
        const { base, spread } = buckets[b]
        px = base[0] + spread[0] * k
        py = base[1] + spread[1] * k
        pz = base[2] + spread[2] * k
      } else {
        // unknown direction → even arc by order among unknowns
        const k = used.__unknown || 0
        used.__unknown = k + 1
        const t = k / Math.max(others.length - 1, 1) - 0.5
        const ang = t * Math.PI * 0.9
        const R = 3.8
        px = Math.sin(ang) * R
        py = 0.3
        pz = -Math.cos(ang) * R + 0.2
      }

      const cam = panel(s.thumb, 1.5, 0.95, 0x4ad6ff)
      cam.position.set(px, py, pz)
      cam.lookAt(0, 0.4, 0)
      cam.scale.setScalar(0.82)
      scene.add(cam)

      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(0, 0.4, 0),
      ])
      const lineMat = new THREE.LineBasicMaterial({ color: 0x4ad6ff, transparent: true, opacity: 0.25 })
      scene.add(new THREE.Line(lineGeo, lineMat))
      disposables.push(lineGeo, lineMat)
    })

    const onResize = () => {
      const nw = mount.clientWidth || 800
      const nh = mount.clientHeight || 500
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    let raf
    const loop = () => {
      raf = requestAnimationFrame(loop)
      controls.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      disposables.forEach((d) => d.dispose && d.dispose())
      renderer.dispose()
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    }
  }, [result])

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
}
