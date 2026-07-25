import * as THREE from 'three'
import { clamp01 } from '../core/mathx'

/**
 * Pooled CPU-simulated point sprites. Two pools exist (alpha-blended for spray,
 * smoke and debris; additive for embers, muzzle flash and glow) because blend mode
 * has to be fixed per draw call.
 */

const VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_PointSize = aSize * (420.0 / max(0.001, vDepth)) * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = (additive: boolean) => /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uSoftness;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = dot(uv, uv);
  float a = smoothstep(0.25, uSoftness, d) * vAlpha;
  if (a < 0.004) discard;
  float fogF = 1.0 - exp(-pow(uFogDensity * vDepth, 2.0));
  vec3 col = vColor;
  ${
    additive
      ? 'a *= (1.0 - fogF);'
      : 'col = mix(col, uFogColor, fogF);'
  }
  gl_FragColor = vec4(col, a);
}
`

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  size: number
  endSize: number
  r: number
  g: number
  b: number
  alpha: number
  drag: number
  gravity: number
  /** Kill the particle when it drops below the surface (spray, debris). */
  sink: boolean
}

class Pool {
  readonly points: THREE.Points
  private parts: Particle[] = []
  private cursor = 0
  private posAttr: THREE.BufferAttribute
  private sizeAttr: THREE.BufferAttribute
  private colorAttr: THREE.BufferAttribute
  private alphaAttr: THREE.BufferAttribute
  readonly material: THREE.ShaderMaterial

  constructor(max: number, additive: boolean, softness: number) {
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(max * 3)
    const col = new Float32Array(max * 3)
    const siz = new Float32Array(max)
    const alp = new Float32Array(max)
    this.posAttr = new THREE.BufferAttribute(pos, 3)
    this.colorAttr = new THREE.BufferAttribute(col, 3)
    this.sizeAttr = new THREE.BufferAttribute(siz, 1)
    this.alphaAttr = new THREE.BufferAttribute(alp, 1)
    geo.setAttribute('position', this.posAttr)
    geo.setAttribute('aColor', this.colorAttr)
    geo.setAttribute('aSize', this.sizeAttr)
    geo.setAttribute('aAlpha', this.alphaAttr)
    geo.setDrawRange(0, 0)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG(additive),
      uniforms: {
        uPixelRatio: { value: 1 },
        uFogColor: { value: new THREE.Color(0x000000) },
        uFogDensity: { value: 0.008 },
        uSoftness: { value: softness },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })

    for (let i = 0; i < max; i++) {
      this.parts.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 1, endSize: 1,
        r: 1, g: 1, b: 1, alpha: 1, drag: 0.6, gravity: -9.8, sink: false,
      })
    }
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 10
  }

  spawn(p: Partial<Particle>): void {
    const q = this.parts[this.cursor]
    this.cursor = (this.cursor + 1) % this.parts.length
    q.x = p.x ?? 0
    q.y = p.y ?? 0
    q.z = p.z ?? 0
    q.vx = p.vx ?? 0
    q.vy = p.vy ?? 0
    q.vz = p.vz ?? 0
    q.maxLife = p.maxLife ?? 1
    q.life = q.maxLife
    q.size = p.size ?? 1
    q.endSize = p.endSize ?? q.size
    q.r = p.r ?? 1
    q.g = p.g ?? 1
    q.b = p.b ?? 1
    q.alpha = p.alpha ?? 1
    q.drag = p.drag ?? 0.7
    q.gravity = p.gravity ?? -9.8
    q.sink = p.sink ?? false
  }

  update(dt: number, surfaceAt: (x: number, z: number) => number, onSink?: (x: number, y: number, z: number, speed: number) => void): void {
    const pos = this.posAttr.array as Float32Array
    const col = this.colorAttr.array as Float32Array
    const siz = this.sizeAttr.array as Float32Array
    const alp = this.alphaAttr.array as Float32Array
    let n = 0
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]
      if (p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) continue
      const damp = Math.exp(-p.drag * dt)
      p.vx *= damp
      p.vz *= damp
      p.vy = (p.vy + p.gravity * dt) * damp
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.sink && p.vy < 0) {
        const h = surfaceAt(p.x, p.z)
        if (p.y < h) {
          onSink?.(p.x, h, p.z, -p.vy)
          p.life = 0
          continue
        }
      }
      const t = 1 - p.life / p.maxLife
      const k = n * 3
      pos[k] = p.x
      pos[k + 1] = p.y
      pos[k + 2] = p.z
      col[k] = p.r
      col[k + 1] = p.g
      col[k + 2] = p.b
      siz[n] = p.size + (p.endSize - p.size) * t
      // Quick attack, long tail.
      alp[n] = p.alpha * Math.min(1, (1 - t) * 2.2) * (t < 0.08 ? t / 0.08 : 1)
      n++
    }
    this.posAttr.needsUpdate = true
    this.colorAttr.needsUpdate = true
    this.sizeAttr.needsUpdate = true
    this.alphaAttr.needsUpdate = true
    this.points.geometry.setDrawRange(0, n)
  }

  clear(): void {
    for (const p of this.parts) p.life = 0
    this.points.geometry.setDrawRange(0, 0)
  }
}

/** Expanding rings laid flat on the water: impact rings, telegraphs, wake pulses. */
class RingPool {
  readonly group = new THREE.Group()
  private items: {
    mesh: THREE.Mesh
    life: number
    maxLife: number
    from: number
    to: number
    alpha: number
    follow: (() => THREE.Vector3) | null
    color: THREE.Color
  }[] = []

  constructor(count: number) {
    const geo = new THREE.RingGeometry(0.72, 1.0, 40, 1)
    geo.rotateX(-Math.PI / 2)
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: true,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.renderOrder = 6
      this.group.add(mesh)
      this.items.push({ mesh, life: 0, maxLife: 1, from: 1, to: 4, alpha: 1, follow: null, color: new THREE.Color() })
    }
    this.group.frustumCulled = false
  }

  spawn(
    x: number,
    z: number,
    from: number,
    to: number,
    duration: number,
    color: number,
    alpha = 1,
    follow: (() => THREE.Vector3) | null = null,
  ): void {
    let best = this.items[0]
    for (const it of this.items) {
      if (it.life <= 0) {
        best = it
        break
      }
      if (it.life < best.life) best = it
    }
    best.life = duration
    best.maxLife = duration
    best.from = from
    best.to = to
    best.alpha = alpha
    best.follow = follow
    best.color.setHex(color)
    best.mesh.position.set(x, 0, z)
    best.mesh.visible = true
  }

  update(dt: number, surfaceAt: (x: number, z: number) => number): void {
    for (const it of this.items) {
      if (it.life <= 0) continue
      it.life -= dt
      const mat = it.mesh.material as THREE.MeshBasicMaterial
      if (it.life <= 0) {
        it.mesh.visible = false
        mat.opacity = 0
        continue
      }
      const t = 1 - it.life / it.maxLife
      if (it.follow) {
        const p = it.follow()
        it.mesh.position.x = p.x
        it.mesh.position.z = p.z
      }
      const s = it.from + (it.to - it.from) * (1 - Math.pow(1 - t, 2.2))
      it.mesh.scale.setScalar(s)
      it.mesh.position.y = surfaceAt(it.mesh.position.x, it.mesh.position.z) + 0.09
      mat.color.copy(it.color)
      mat.opacity = it.alpha * Math.pow(1 - t, 1.5)
    }
  }

  clear(): void {
    for (const it of this.items) {
      it.life = 0
      it.mesh.visible = false
    }
  }
}

const _c = new THREE.Color()

/** Facade over the pools: named, tuned effects the game calls by intent. */
export class Fx {
  readonly group = new THREE.Group()
  private alpha = new Pool(1400, false, 0.02)
  private additive = new Pool(800, true, 0.0)
  readonly rings = new RingPool(28)

  /** Set by the game each frame so particles can die on the water surface. */
  surfaceAt: (x: number, z: number) => number = () => 0

  constructor() {
    this.group.add(this.alpha.points, this.additive.points, this.rings.group)
    this.group.frustumCulled = false
  }

  setFog(color: THREE.Color, density: number): void {
    for (const m of [this.alpha.material, this.additive.material]) {
      ;(m.uniforms.uFogColor.value as THREE.Color).copy(color)
      m.uniforms.uFogDensity.value = density
    }
  }

  setPixelRatio(r: number): void {
    this.alpha.material.uniforms.uPixelRatio.value = r
    this.additive.material.uniforms.uPixelRatio.value = r
  }

  update(dt: number): void {
    this.alpha.update(dt, this.surfaceAt, (x, y, z, speed) => {
      // Falling spray that lands makes its own little plop.
      if (speed > 5 && Math.random() < 0.22) {
        this.rings.spawn(x, z, 0.15, 0.55 + speed * 0.03, 0.5, 0xbfe6e2, 0.16)
        void y
      }
    })
    this.additive.update(dt, this.surfaceAt)
    this.rings.update(dt, this.surfaceAt)
  }

  clear(): void {
    this.alpha.clear()
    this.additive.clear()
    this.rings.clear()
  }

  /** Water thrown up by an impact. `power` roughly 0.3 (pebble) .. 2.5 (breach). */
  splash(x: number, y: number, z: number, power = 1, tint = 0xdff2ef): void {
    _c.setHex(tint)
    const n = Math.min(46, Math.round(9 + power * 15))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (2.2 + Math.random() * 5.5) * power
      this.alpha.spawn({
        x, y, z,
        vx: Math.cos(a) * sp * (0.5 + Math.random() * 0.9),
        vy: (3.5 + Math.random() * 6.5) * power,
        vz: Math.sin(a) * sp * (0.5 + Math.random() * 0.9),
        maxLife: 0.5 + Math.random() * 0.75,
        size: (0.16 + Math.random() * 0.22) * (0.7 + power * 0.5),
        endSize: 0.05,
        r: _c.r, g: _c.g, b: _c.b,
        alpha: 0.92,
        drag: 0.55,
        gravity: -17,
        sink: true,
      })
    }
    // Foam collar sitting on the surface.
    for (let i = 0; i < Math.round(6 + power * 6); i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (1.4 + Math.random() * 2.6) * power
      this.alpha.spawn({
        x, y: y + 0.1, z,
        vx: Math.cos(a) * sp,
        vy: 0.5 + Math.random() * 1.2,
        vz: Math.sin(a) * sp,
        maxLife: 0.65 + Math.random() * 0.6,
        size: 0.5 * power + Math.random() * 0.4,
        endSize: 1.5 * power,
        r: _c.r, g: _c.g, b: _c.b,
        alpha: 0.42,
        drag: 2.4,
        gravity: -1.2,
      })
    }
    this.rings.spawn(x, z, 0.3 * power, 2.6 * power + 1.4, 0.55 + power * 0.16, 0x9fd8d2, 0.4 + power * 0.12)
  }

  /** Cannon discharge: hot flash, ember shower, rolling powder smoke. */
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, charge: number): void {
    const scale = 0.75 + charge * 1.1
    for (let i = 0; i < Math.round(16 + charge * 20); i++) {
      const sp = (7 + Math.random() * 22) * scale
      this.additive.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * sp + (Math.random() - 0.5) * 7,
        vy: dir.y * sp + (Math.random() - 0.5) * 7 + 1,
        vz: dir.z * sp + (Math.random() - 0.5) * 7,
        maxLife: 0.16 + Math.random() * 0.4,
        size: (0.11 + Math.random() * 0.2) * scale,
        endSize: 0.02,
        r: 1.0, g: 0.72 + Math.random() * 0.25, b: 0.28,
        alpha: 1,
        drag: 2.4,
        gravity: -7,
      })
    }
    // Flash core -- kept small: with bloom on, a large one wipes out the boat behind it.
    for (let i = 0; i < 5; i++) {
      this.additive.spawn({
        x: pos.x + dir.x * 0.35, y: pos.y + dir.y * 0.35, z: pos.z + dir.z * 0.35,
        vx: dir.x * 6, vy: dir.y * 6, vz: dir.z * 6,
        maxLife: 0.085,
        size: 0.85 * scale, endSize: 1.7 * scale,
        r: 1, g: 0.88, b: 0.6, alpha: 0.85,
        drag: 6, gravity: 0,
      })
    }
    for (let i = 0; i < Math.round(10 + charge * 12); i++) {
      const sp = (2.5 + Math.random() * 7) * scale
      this.alpha.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * sp + (Math.random() - 0.5) * 3.5,
        vy: dir.y * sp + (Math.random() - 0.5) * 2.5 + 1.4,
        vz: dir.z * sp + (Math.random() - 0.5) * 3.5,
        maxLife: 0.9 + Math.random() * 1.1,
        size: 0.4 * scale,
        endSize: 2.6 * scale,
        r: 0.76, g: 0.75, b: 0.72,
        alpha: 0.38,
        drag: 1.9,
        gravity: 0.5,
      })
    }
  }

  /** Non-gory hit burst: a spray of luminous brine. */
  impact(x: number, y: number, z: number, color: number, power = 1): void {
    _c.setHex(color)
    for (let i = 0; i < Math.round(10 + power * 14); i++) {
      const a = Math.random() * Math.PI * 2
      const el = Math.random() * Math.PI * 0.5
      const sp = (3 + Math.random() * 9) * power
      this.additive.spawn({
        x, y, z,
        vx: Math.cos(a) * Math.cos(el) * sp,
        vy: Math.sin(el) * sp + 1.5,
        vz: Math.sin(a) * Math.cos(el) * sp,
        maxLife: 0.2 + Math.random() * 0.42,
        size: 0.13 + Math.random() * 0.17,
        endSize: 0.02,
        r: _c.r, g: _c.g, b: _c.b,
        alpha: 0.95,
        drag: 2.0,
        gravity: -9,
      })
    }
  }

  /** Chunky debris on a kill. */
  debris(x: number, y: number, z: number, color: number, count = 12, power = 1): void {
    _c.setHex(color)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (2.5 + Math.random() * 7) * power
      this.alpha.spawn({
        x, y, z,
        vx: Math.cos(a) * sp,
        vy: 4 + Math.random() * 8 * power,
        vz: Math.sin(a) * sp,
        maxLife: 0.9 + Math.random() * 0.8,
        size: 0.18 + Math.random() * 0.3,
        endSize: 0.12,
        r: _c.r * (0.7 + Math.random() * 0.5),
        g: _c.g * (0.7 + Math.random() * 0.5),
        b: _c.b * (0.7 + Math.random() * 0.5),
        alpha: 1,
        drag: 0.35,
        gravity: -19,
        sink: true,
      })
    }
  }

  /** A single wake puff behind the boat. */
  wake(x: number, y: number, z: number, strength: number): void {
    this.alpha.spawn({
      x: x + (Math.random() - 0.5) * 0.9,
      y: y + 0.05,
      z: z + (Math.random() - 0.5) * 0.9,
      vx: (Math.random() - 0.5) * 1.2,
      vy: 0.25 + Math.random() * 0.4,
      vz: (Math.random() - 0.5) * 1.2,
      maxLife: 0.7 + Math.random() * 0.7,
      size: 0.3 + strength * 0.5,
      endSize: 1.1 + strength * 1.3,
      r: 0.88, g: 0.95, b: 0.94,
      alpha: 0.28 + strength * 0.22,
      drag: 2.6,
      gravity: -0.35,
    })
  }

  /** Glowing motes, e.g. flare light or the boss's gills. */
  glow(x: number, y: number, z: number, color: number, count = 6, spread = 1, rise = 1): void {
    _c.setHex(color)
    for (let i = 0; i < count; i++) {
      this.additive.spawn({
        x: x + (Math.random() - 0.5) * spread,
        y: y + (Math.random() - 0.5) * spread * 0.6,
        z: z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 1.4,
        vy: rise * (0.6 + Math.random() * 1.4),
        vz: (Math.random() - 0.5) * 1.4,
        maxLife: 0.5 + Math.random() * 0.9,
        size: 0.16 + Math.random() * 0.24,
        endSize: 0.02,
        r: _c.r, g: _c.g, b: _c.b,
        alpha: 0.85,
        drag: 1.2,
        gravity: 0.4,
      })
    }
  }

  smoke(x: number, y: number, z: number, count = 4, size = 0.5, tint = 0.7): void {
    for (let i = 0; i < count; i++) {
      this.alpha.spawn({
        x: x + (Math.random() - 0.5) * 0.6,
        y, z: z + (Math.random() - 0.5) * 0.6,
        vx: (Math.random() - 0.5) * 1.6,
        vy: 1.4 + Math.random() * 1.8,
        vz: (Math.random() - 0.5) * 1.6,
        maxLife: 1.0 + Math.random() * 1.2,
        size,
        endSize: size * 4,
        r: tint, g: tint, b: tint * 0.98,
        alpha: 0.3,
        drag: 1.5,
        gravity: 0.6,
      })
    }
  }
}

export { clamp01 }
