import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export interface GCodeStats {
  lineCount: number
  rapidCount: number
  cutCount: number
  bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null
  estimatedTime: number
}

interface Segment {
  points: THREE.Vector3[]
  rapid: boolean
}

function parseWord(line: string, letter: string): number | null {
  const re = new RegExp(`${letter}([+-]?[\\d.]+)`, 'i')
  const m = line.match(re)
  return m ? parseFloat(m[1]) : null
}

function tessellateArc(
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  cx: number, cy: number,
  cw: boolean, segs = 36
): THREE.Vector3[] {
  let a0 = Math.atan2(sy - cy, sx - cx)
  let a1 = Math.atan2(ey - cy, ex - cx)
  const r = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2)
  if (cw  && a1 >= a0) a1 -= Math.PI * 2
  if (!cw && a1 <= a0) a1 += Math.PI * 2
  return Array.from({ length: segs + 1 }, (_, i) => {
    const t = i / segs, a = a0 + (a1 - a0) * t
    return new THREE.Vector3(cx + r * Math.cos(a), cy + r * Math.sin(a), sz + (ez - sz) * t)
  })
}

function parseGCode(gcode: string): { segments: Segment[]; stats: GCodeStats } {
  const segments: Segment[] = []
  let rapidCount = 0, cutCount = 0, totalDist = 0, feedSum = 0, feedSamples = 0
  let x = 0, y = 0, z = 0, motion = 'G0', abs = true, units = 1

  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase()
    if (!line) continue
    if (/G90\b/.test(line)) abs = true
    if (/G91\b/.test(line)) abs = false
    if (/G20\b/.test(line)) units = 25.4
    if (/G21\b/.test(line)) units = 1
    if (/G0\b/.test(line))  motion = 'G0'
    if (/G1\b/.test(line))  motion = 'G1'
    if (/G2\b/.test(line))  motion = 'G2'
    if (/G3\b/.test(line))  motion = 'G3'
    const f = parseWord(line, 'F')
    if (f !== null) { feedSum += f * units; feedSamples++ }

    const nx = parseWord(line, 'X'), ny = parseWord(line, 'Y'), nz = parseWord(line, 'Z')
    if (nx === null && ny === null && nz === null) continue

    const tx = (nx !== null ? (abs ? nx : x + nx) : x) * units
    const ty = (ny !== null ? (abs ? ny : y + ny) : y) * units
    const tz = (nz !== null ? (abs ? nz : z + nz) : z) * units

    if (motion === 'G0' || motion === 'G1') {
      const rapid = motion === 'G0'
      segments.push({ points: [new THREE.Vector3(x, y, z), new THREE.Vector3(tx, ty, tz)], rapid })
      rapid ? rapidCount++ : (cutCount++, totalDist += Math.sqrt((tx-x)**2+(ty-y)**2+(tz-z)**2))
    } else if (motion === 'G2' || motion === 'G3') {
      const i = (parseWord(line, 'I') ?? 0) * units
      const j = (parseWord(line, 'J') ?? 0) * units
      const pts = tessellateArc(x, y, z, tx, ty, tz, x + i, y + j, motion === 'G2')
      segments.push({ points: pts, rapid: false })
      cutCount++
      for (let k = 1; k < pts.length; k++) totalDist += pts[k].distanceTo(pts[k-1])
    }
    x = tx; y = ty; z = tz
  }

  const avgFeed = feedSamples > 0 ? feedSum / feedSamples : 0
  let bounds: GCodeStats['bounds'] = null
  if (segments.length) {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (const seg of segments) for (const p of seg.points) { min.min(p); max.max(p) }
    bounds = { min, max }
  }

  return {
    segments,
    stats: {
      lineCount: gcode.split('\n').filter(l => l.trim()).length,
      rapidCount, cutCount, bounds,
      estimatedTime: avgFeed > 0 ? (totalDist / avgFeed) * 60 : 0,
    },
  }
}

// ---------- custom thick axis arrows ----------

function makeAxis(dir: THREE.Vector3, color: number, len: number): THREE.Group {
  const g = new THREE.Group()
  const shaftR = len * 0.012, headR = len * 0.03, headL = len * 0.12
  const shaftL = len - headL

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftR, shaftR, shaftL, 8),
    new THREE.MeshBasicMaterial({ color })
  )
  shaft.position.copy(dir.clone().multiplyScalar(shaftL / 2))
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  g.add(shaft)

  const head = new THREE.Mesh(
    new THREE.ConeGeometry(headR, headL, 8),
    new THREE.MeshBasicMaterial({ color })
  )
  head.position.copy(dir.clone().multiplyScalar(shaftL + headL / 2))
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  g.add(head)
  return g
}

function makeAxes(len: number): THREE.Group {
  const g = new THREE.Group()
  g.add(makeAxis(new THREE.Vector3(1, 0, 0), 0xef4444, len)) // X red
  g.add(makeAxis(new THREE.Vector3(0, 1, 0), 0x22c55e, len)) // Y green
  g.add(makeAxis(new THREE.Vector3(0, 0, 1), 0x3b82f6, len)) // Z blue
  return g
}

// ---------- orientation cube ----------

function buildOrientationCube(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene()

  // Six faces: +X red, -X dark red, +Y green, -Y dark green, +Z blue, -Z dark blue
  const faces = [
    { pos: [ 0.5,  0,    0  ], rot: [0,  Math.PI/2, 0], color: 0xef4444 },
    { pos: [-0.5,  0,    0  ], rot: [0, -Math.PI/2, 0], color: 0x7f1d1d },
    { pos: [0,     0.5,  0  ], rot: [-Math.PI/2, 0, 0], color: 0x22c55e },
    { pos: [0,    -0.5,  0  ], rot: [ Math.PI/2, 0, 0], color: 0x14532d },
    { pos: [0,     0,    0.5], rot: [0, 0, 0],           color: 0x3b82f6 },
    { pos: [0,     0,   -0.5], rot: [Math.PI, 0, 0],     color: 0x1e3a5f },
  ]

  faces.forEach(({ pos, rot, color }) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.95),
      new THREE.MeshBasicMaterial({ color, side: THREE.FrontSide })
    )
    m.position.set(pos[0], pos[1], pos[2])
    m.rotation.set(rot[0], rot[1], rot[2])
    scene.add(m)
  })

  // Edge frame
  scene.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x444444 })
  ))

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.up.set(0, 0, 1)

  return { scene, camera }
}

// ---------- component ----------

interface Props {
  gcode: string | null
  onStats?: (stats: GCodeStats) => void
  toolPosition?: { x: number; y: number; z: number }
}

export function GCodeVisualizer({ gcode, onStats, toolPosition }: Props) {
  const mountRef    = useRef<HTMLDivElement>(null)
  const cubeRef     = useRef<HTMLDivElement>(null)
  const toolArrowRef = useRef<THREE.Group | null>(null)

  useEffect(() => {
    const el = mountRef.current
    const cubeEl = cubeRef.current
    if (!el || !cubeEl) return

    // ---- main scene ----
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xfafafa)

    const w = el.clientWidth, h = el.clientHeight
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100000)
    camera.up.set(0, 0, 1)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.screenSpacePanning = true

    // ---- toolpath & grid ----
    let gridSize = 200
    if (gcode) {
      const { segments, stats } = parseGCode(gcode)
      onStats?.(stats)

      if (stats.bounds) {
        const { min, max } = stats.bounds
        const size = new THREE.Vector3().subVectors(max, min)
        gridSize = Math.max(size.x, size.y, 50) * 2
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5)
        const d = Math.max(size.x, size.y, size.z, 10) * 1.8
        camera.position.set(center.x, center.y - d * 0.5, center.z + d * 0.9)
        controls.target.copy(center)
      } else {
        camera.position.set(0, -80, 100)
      }

      const rapidMat = new THREE.LineBasicMaterial({ color: 0x22c55e })
      const cutMat   = new THREE.LineBasicMaterial({ color: 0x3b82f6 })
      for (const seg of segments) {
        if (seg.points.length < 2) continue
        const geo = new THREE.BufferGeometry().setFromPoints(seg.points)
        const mat = seg.rapid ? rapidMat : cutMat
        scene.add(seg.points.length === 2
          ? new THREE.LineSegments(geo, mat)
          : new THREE.Line(geo, mat))
      }
    } else {
      camera.position.set(0, -80, 100)
    }

    const divisions = Math.min(40, Math.max(10, Math.round(gridSize / 10)))
    const grid = new THREE.GridHelper(gridSize, divisions, 0xcccccc, 0xe0e0e0)
    grid.rotation.x = Math.PI / 2
    scene.add(grid)

    const axisLen = gridSize * 0.12
    scene.add(makeAxes(axisLen))

    // Cyan tool-tip arrow (points downward, tip at tool position)
    const arrowLen  = axisLen * 0.7
    const headLen   = arrowLen * 0.4
    const shaftLen  = arrowLen * 0.6
    const headR     = arrowLen * 0.09
    const shaftR    = arrowLen * 0.035
    const cyanMat   = new THREE.MeshBasicMaterial({ color: 0x06b6d4 })
    const headMesh  = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 8), cyanMat)
    // ConeGeometry tip at +Y; rotate so tip points -Z (downward in scene)
    headMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1))
    headMesh.position.set(0, 0, headLen / 2)  // tip at (0,0,0), base at (0,0,headLen)
    const shaftMesh = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 6), cyanMat)
    shaftMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1))
    shaftMesh.position.set(0, 0, headLen + shaftLen / 2)
    const tg = new THREE.Group()
    tg.add(headMesh, shaftMesh)
    const tp = toolPosition ?? { x: 0, y: 0, z: 0 }
    tg.position.set(tp.x, tp.y, tp.z)
    scene.add(tg)
    toolArrowRef.current = tg

    controls.update()

    // ---- orientation cube scene ----
    const { scene: cubeScene, camera: cubeCam } = buildOrientationCube()
    const cubeSize = 80
    const cubeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    cubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    cubeRenderer.setSize(cubeSize, cubeSize)
    cubeRenderer.setClearColor(0x000000, 0)
    cubeEl.appendChild(cubeRenderer.domElement)

    // ---- animation ----
    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)

      // sync cube cam rotation with main cam
      cubeCam.position.copy(
        camera.position.clone().sub(controls.target).normalize().multiplyScalar(4)
      )
      cubeCam.lookAt(0, 0, 0)
      cubeRenderer.render(cubeScene, cubeCam)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      cubeRenderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
      if (cubeEl.contains(cubeRenderer.domElement)) cubeEl.removeChild(cubeRenderer.domElement)
      toolArrowRef.current = null
    }
  }, [gcode, onStats])

  useEffect(() => {
    if (!toolArrowRef.current) return
    const p = toolPosition ?? { x: 0, y: 0, z: 0 }
    toolArrowRef.current.position.set(p.x, p.y, p.z)
  }, [toolPosition])

  return (
    <div className="relative w-full h-full">
      <div ref={mountRef} className="w-full h-full" />
      <div ref={cubeRef} className="absolute top-2 right-2 w-20 h-20 rounded-lg overflow-hidden" />
    </div>
  )
}
