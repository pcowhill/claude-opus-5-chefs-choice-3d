import * as THREE from 'three'
import { clamp, clamp01, damp, dampAngle, lerp } from '../core/mathx'
import type { Ocean } from '../world/ocean'
import type { Fx } from '../fx/particles'

export type EnemyKind = 'snapper' | 'spitter' | 'mine' | 'bloom' | 'breacher'

export interface EnemyDef {
  hp: number
  radius: number
  speed: number
  score: number
  /** Water shipped by the player on contact. */
  contact: number
  tint: number
  tier: 0 | 1 | 2
  label: string
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  snapper: { hp: 22, radius: 1.4, speed: 8.4, score: 100, contact: 11, tint: 0x7fd8e8, tier: 0, label: 'Snapper' },
  spitter: { hp: 30, radius: 1.2, speed: 5.0, score: 150, contact: 8, tint: 0x8ef0b0, tier: 0, label: 'Brine Spitter' },
  mine: { hp: 12, radius: 1.2, speed: 1.7, score: 60, contact: 26, tint: 0xff9a5c, tier: 0, label: 'Urchin Mine' },
  bloom: { hp: 10, radius: 1.05, speed: 3.6, score: 40, contact: 5, tint: 0xc79bff, tier: 0, label: 'Bloom Jelly' },
  breacher: { hp: 190, radius: 2.7, speed: 7.2, score: 400, contact: 30, tint: 0x9fc6e8, tier: 1, label: 'Breacher' },
}

export interface EnemyCtx {
  ocean: Ocean
  fx: Fx
  boat: THREE.Vector3
  boatVel: THREE.Vector3
  arenaRadius: number
  spawnGlob: (origin: THREE.Vector3, target: THREE.Vector3) => void
  /** `push` shoves the boat away from (fromX, fromZ); `lift` throws it upward. */
  damagePlayer: (water: number, fromX: number, fromZ: number, push: number, lift?: number) => void
  requestSpawn: (kind: EnemyKind, x: number, z: number) => void
  roar: (depth: number) => void
}

let NEXT_ID = 1

export class Enemy {
  id = NEXT_ID++
  kind: EnemyKind = 'snapper'
  def: EnemyDef = ENEMY_DEFS.snapper
  alive = false
  hp = 1
  maxHp = 1
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  heading = 0
  state = 0
  timer = 0
  flash = 0
  wasFlashing = false
  bob = Math.random() * 10
  /** Vertical offset from the water surface; breachers dive with this. */
  depth = 0
  root!: THREE.Group
  mats: THREE.MeshStandardMaterial[] = []
  telegraph = new THREE.Vector3()
  scoreValue = 0

  get hittable(): boolean {
    return this.alive && this.depth > -2.2
  }

  get radius(): number {
    return this.def.radius
  }
}

// --------------------------------------------------------------------- meshes

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.62, ...opts })
}

function buildSnapper(): { root: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const g = new THREE.Group()
  const skin = mat(0x2b3d4a, { roughness: 0.5 })
  const belly = mat(0x8fa5ad, { roughness: 0.55 })
  const finM = mat(0x1b2a34, { roughness: 0.45 })

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), skin)
  body.scale.set(0.62, 0.5, 1.5)
  body.castShadow = true
  g.add(body)

  const bel = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), belly)
  bel.scale.set(0.5, 0.26, 1.2)
  bel.position.y = -0.22
  g.add(bel)

  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.9, 6), skin)
  snout.rotation.x = Math.PI / 2
  snout.position.z = 1.24
  snout.castShadow = true
  g.add(snout)

  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 3), finM)
  fin.position.set(0, 0.62, -0.1)
  fin.rotation.y = Math.PI / 2
  fin.scale.z = 0.24
  fin.castShadow = true
  g.add(fin)

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.95, 3), finM)
  tail.position.set(0, 0.05, -1.35)
  tail.rotation.x = -Math.PI / 2
  tail.rotation.z = Math.PI / 2
  tail.scale.z = 0.22
  g.add(tail)

  const eye = mat(0xffb347, { emissive: 0xff8c1a, emissiveIntensity: 2.6, roughness: 0.3 })
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), eye)
    e.position.set(sx * 0.22, 0.14, 0.82)
    g.add(e)
  }
  return { root: g, mats: [skin, belly, finM, eye] }
}

function buildSpitter(): { root: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const g = new THREE.Group()
  const skin = mat(0x4d7a4b, { roughness: 0.7 })
  const sac = mat(0x9ad46f, { emissive: 0x2f7a3a, emissiveIntensity: 0.5, roughness: 0.5 })
  const dark = mat(0x24361f)

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.92, 1), skin)
  body.scale.set(1, 0.78, 1)
  body.castShadow = true
  g.add(body)

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), sac)
    b.position.set(Math.cos(a) * 0.68, 0.34, Math.sin(a) * 0.68)
    g.add(b)
  }

  const siphon = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.28, 1.0, 7), dark)
  siphon.rotation.x = Math.PI / 2
  siphon.position.set(0, 0.16, 0.86)
  siphon.castShadow = true
  g.add(siphon)

  const eye = mat(0xd8ff9a, { emissive: 0x8ef04a, emissiveIntensity: 2.2 })
  const e = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 6), eye)
  e.position.set(0, 0.5, 0.42)
  g.add(e)

  return { root: g, mats: [skin, sac, dark, eye] }
}

function buildMine(): { root: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const g = new THREE.Group()
  const shell = mat(0x4a3226, { roughness: 0.85 })
  const spike = mat(0x8a3a22, { roughness: 0.6, metalness: 0.3 })
  const eye = mat(0xff5a3c, { emissive: 0xff3a1a, emissiveIntensity: 3.0 })

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0), shell)
  core.castShadow = true
  g.add(core)

  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -0.6, 0],
    [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0],
    [0, 0.7, 0.7], [0, 0.7, -0.7],
  ]
  for (const d of dirs) {
    const v = new THREE.Vector3(d[0], d[1], d[2]).normalize()
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.55, 5), spike)
    s.position.copy(v).multiplyScalar(0.7)
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v)
    g.add(s)
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 7, 6), eye)
  lamp.position.set(0, 0.62, 0)
  g.add(lamp)

  return { root: g, mats: [shell, spike, eye] }
}

function buildBloom(): { root: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const g = new THREE.Group()
  const bell = mat(0xb98ef0, {
    emissive: 0x7a48c8,
    emissiveIntensity: 1.4,
    roughness: 0.3,
    transparent: true,
    opacity: 0.88,
  })
  const tend = mat(0x8f6bd0, { emissive: 0x5a34a0, emissiveIntensity: 0.9, roughness: 0.4 })

  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), bell)
  dome.castShadow = true
  g.add(dome)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.01, 0.85, 4), tend)
    t.position.set(Math.cos(a) * 0.3, -0.42, Math.sin(a) * 0.3)
    g.add(t)
  }
  return { root: g, mats: [bell, tend] }
}

function buildBreacher(): { root: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const g = new THREE.Group()
  const skin = mat(0x1f2c36, { roughness: 0.55 })
  const belly = mat(0x9fb3bd, { roughness: 0.6 })
  const maw = mat(0xd88a92, { roughness: 0.5, emissive: 0x3a0f14, emissiveIntensity: 0.4 })
  const eye = mat(0xffe08a, { emissive: 0xffb400, emissiveIntensity: 2.6 })

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 2), skin)
  body.scale.set(1.0, 0.9, 2.15)
  body.castShadow = true
  g.add(body)

  const bel = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 1), belly)
  bel.scale.set(0.82, 0.42, 1.75)
  bel.position.y = -0.75
  g.add(bel)

  const jaw = new THREE.Mesh(new THREE.ConeGeometry(1.05, 2.0, 5), skin)
  jaw.rotation.x = Math.PI / 2
  jaw.position.z = 3.1
  jaw.castShadow = true
  g.add(jaw)

  const mouth = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.1, 5), maw)
  mouth.rotation.x = -Math.PI / 2
  mouth.position.z = 3.0
  g.add(mouth)

  const fluke = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.6, 3), skin)
  fluke.position.set(0, 0.1, -3.5)
  fluke.rotation.x = -Math.PI / 2
  fluke.rotation.z = Math.PI / 2
  fluke.scale.z = 0.2
  g.add(fluke)

  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.2, 7, 6), eye)
    e.position.set(sx * 0.85, 0.5, 1.9)
    g.add(e)
  }
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.5, 3), skin)
  dorsal.position.set(0, 1.35, -0.6)
  dorsal.rotation.y = Math.PI / 2
  dorsal.scale.z = 0.22
  g.add(dorsal)

  return { root: g, mats: [skin, belly, maw, eye] }
}

const BUILDERS: Record<EnemyKind, () => { root: THREE.Group; mats: THREE.MeshStandardMaterial[] }> = {
  snapper: buildSnapper,
  spitter: buildSpitter,
  mine: buildMine,
  bloom: buildBloom,
  breacher: buildBreacher,
}

// ------------------------------------------------------------------- manager

export interface KillInfo {
  kind: EnemyKind
  score: number
  x: number
  y: number
  z: number
  tier: number
}

export class EnemyManager {
  readonly group = new THREE.Group()
  readonly active: Enemy[] = []
  private pools: Record<EnemyKind, Enemy[]> = {
    snapper: [], spitter: [], mine: [], bloom: [], breacher: [],
  }
  /** Multiplier applied to spawned HP -- the run's difficulty ramp. */
  hpScale = 1
  speedScale = 1

  onKill: ((info: KillInfo) => void) | null = null

  constructor(private fx: Fx) {}

  spawn(kind: EnemyKind, x: number, z: number): Enemy {
    const pool = this.pools[kind]
    let e = pool.pop()
    if (!e) {
      e = new Enemy()
      const built = BUILDERS[kind]()
      e.root = built.root
      e.mats = built.mats
    }
    const def = ENEMY_DEFS[kind]
    e.kind = kind
    e.def = def
    e.alive = true
    e.maxHp = def.hp * this.hpScale
    e.hp = e.maxHp
    e.pos.set(x, 0, z)
    e.vel.set(0, 0, 0)
    e.state = 0
    e.timer = 0
    e.flash = 0
    e.depth = kind === 'breacher' ? -6 : 0
    e.bob = Math.random() * 10
    e.heading = Math.random() * Math.PI * 2
    e.scoreValue = def.score
    e.root.visible = true
    e.root.scale.setScalar(1)
    this.group.add(e.root)
    this.active.push(e)
    return e
  }

  despawnAll(): void {
    for (const e of this.active) {
      e.alive = false
      this.group.remove(e.root)
      this.pools[e.kind].push(e)
    }
    this.active.length = 0
  }

  /** Direct damage. Returns true if this blow killed it. */
  damage(e: Enemy, amount: number, x: number, y: number, z: number): boolean {
    if (!e.alive) return false
    e.hp -= amount
    e.flash = 1
    this.fx.impact(x, y, z, e.def.tint, Math.min(1.6, 0.5 + amount / 40))
    if (e.hp <= 0) {
      this.kill(e)
      return true
    }
    return false
  }

  damageArea(x: number, z: number, radius: number, amount: number, ignoreId = -1): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i]
      if (!e.alive || e.id === ignoreId || !e.hittable) continue
      const d = Math.hypot(e.pos.x - x, e.pos.z - z)
      if (d < radius + e.radius) {
        const falloff = 1 - clamp01((d - e.radius) / Math.max(0.001, radius))
        this.damage(e, amount * (0.45 + 0.55 * falloff), e.pos.x, e.root.position.y, e.pos.z)
      }
    }
  }

  kill(e: Enemy): void {
    if (!e.alive) return
    e.alive = false
    const y = e.root.position.y
    this.fx.debris(e.pos.x, y, e.pos.z, e.def.tint, e.kind === 'breacher' ? 34 : 14, e.kind === 'breacher' ? 1.8 : 1)
    this.fx.splash(e.pos.x, y, e.pos.z, e.kind === 'breacher' ? 2.0 : 0.85, e.def.tint)
    this.fx.impact(e.pos.x, y, e.pos.z, e.def.tint, 1.6)
    this.onKill?.({ kind: e.kind, score: e.scoreValue, x: e.pos.x, y, z: e.pos.z, tier: e.def.tier })
    const idx = this.active.indexOf(e)
    if (idx >= 0) this.active.splice(idx, 1)
    this.group.remove(e.root)
    this.pools[e.kind].push(e)
  }

  /** Mines detonate rather than simply dying. */
  private detonate(e: Enemy, ctx: EnemyCtx): void {
    const y = e.root.position.y
    this.fx.splash(e.pos.x, y, e.pos.z, 1.9, 0xffb066)
    this.fx.impact(e.pos.x, y, e.pos.z, 0xff8a3c, 2.2)
    this.fx.rings.spawn(e.pos.x, e.pos.z, 0.5, 9, 0.6, 0xffb066, 0.7)
    this.damageArea(e.pos.x, e.pos.z, 7, 55, e.id)
    const d = Math.hypot(ctx.boat.x - e.pos.x, ctx.boat.z - e.pos.z)
    if (d < 7.5) {
      const f = 1 - clamp01(d / 7.5)
      ctx.damagePlayer(e.def.contact * f, e.pos.x, e.pos.z, 16 * f, 5 * f)
    }
  }

  update(dt: number, ctx: EnemyCtx): void {
    const ocean = ctx.ocean
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i]
      if (!e.alive) continue
      e.timer -= dt
      e.bob += dt
      e.flash = Math.max(0, e.flash - dt * 4.5)

      const toBoatX = ctx.boat.x - e.pos.x
      const toBoatZ = ctx.boat.z - e.pos.z
      const dist = Math.hypot(toBoatX, toBoatZ) || 0.0001
      const dirX = toBoatX / dist
      const dirZ = toBoatZ / dist

      switch (e.kind) {
        case 'snapper':
          this.updateSnapper(e, dt, ctx, dirX, dirZ, dist)
          break
        case 'spitter':
          this.updateSpitter(e, dt, ctx, dirX, dirZ, dist)
          break
        case 'mine':
          this.updateMine(e, dt, ctx, dist)
          break
        case 'bloom':
          this.updateBloom(e, dt, ctx, dirX, dirZ, dist)
          break
        case 'breacher':
          this.updateBreacher(e, dt, ctx, dirX, dirZ, dist)
          break
      }

      // Separation so the swarm spreads instead of stacking into one silhouette.
      for (let j = 0; j < this.active.length; j++) {
        const o = this.active[j]
        if (o === e || !o.alive) continue
        const dx = e.pos.x - o.pos.x
        const dz = e.pos.z - o.pos.z
        const min = e.radius + o.radius
        const d2 = dx * dx + dz * dz
        if (d2 < min * min && d2 > 0.0001) {
          const d = Math.sqrt(d2)
          const push = ((min - d) / min) * 14 * dt
          e.vel.x += (dx / d) * push
          e.vel.z += (dz / d) * push
        }
      }

      e.pos.x += e.vel.x * dt
      e.pos.z += e.vel.z * dt

      // Keep them inside the reef.
      const r = Math.hypot(e.pos.x, e.pos.z)
      const lim = ctx.arenaRadius - 2
      if (r > lim) {
        const k = lim / r
        e.pos.x *= k
        e.pos.z *= k
        e.vel.x *= 0.4
        e.vel.z *= 0.4
      }

      // Sit on the water.
      const surf = ocean.heightAt(e.pos.x, e.pos.z)
      const bobAmt = e.kind === 'bloom' ? 0.22 : e.kind === 'mine' ? 0.16 : 0.06
      const targetY = surf + e.depth + Math.sin(e.bob * 1.7) * bobAmt + this.restY(e.kind)
      e.root.position.set(e.pos.x, damp(e.root.position.y, targetY, 16, dt), e.pos.z)

      ocean.normalAt(e.pos.x, e.pos.z, _n)
      const speed = Math.hypot(e.vel.x, e.vel.z)
      if (speed > 0.35) e.heading = dampAngle(e.heading, Math.atan2(e.vel.x, e.vel.z), 7, dt)
      const pitch = -Math.asin(clamp(_n.x * Math.sin(e.heading) + _n.z * Math.cos(e.heading), -1, 1))
      const roll = Math.asin(clamp(_n.x * Math.cos(e.heading) - _n.z * Math.sin(e.heading), -1, 1))
      e.root.rotation.set(pitch * 0.8, e.heading, roll * 0.8, 'YXZ')
      if (e.kind === 'bloom') e.root.rotation.set(Math.sin(e.bob) * 0.15, e.heading, Math.cos(e.bob * 0.8) * 0.15, 'YXZ')

      // Damage flash: blow out every material's emissive toward white, then settle back.
      if (e.flash > 0.001 || e.wasFlashing) {
        const f = e.flash * e.flash
        for (const m of e.mats) {
          const base = baseEmissive(m)
          m.emissiveIntensity = base.intensity + f * 5
          m.emissive.copy(base.color).lerp(_white, f * 0.9)
        }
        e.wasFlashing = e.flash > 0.001
      }

      // Contact.
      if (e.hittable && dist < e.radius + 1.9) {
        if (e.kind === 'mine') {
          this.detonate(e, ctx)
          this.kill(e)
        } else if (e.kind !== 'breacher' && e.timer <= 0 && e.state !== 9) {
          ctx.damagePlayer(e.def.contact, e.pos.x, e.pos.z, e.kind === 'snapper' ? 9 : 3)
          e.timer = e.kind === 'bloom' ? 0.85 : 1.05
          e.state = 9
          // Snappers back off after a bite so they read as "lunge, chew, circle".
          e.vel.x = -dirX * 11
          e.vel.z = -dirZ * 11
        }
      }
      if (e.state === 9 && e.timer <= 0) e.state = 0
    }
  }

  private restY(kind: EnemyKind): number {
    switch (kind) {
      case 'snapper': return -0.18
      case 'spitter': return 0.1
      case 'mine': return -0.05
      case 'bloom': return 0.05
      case 'breacher': return -0.7
    }
  }

  // -------------------------------------------------------------- behaviours

  private updateSnapper(e: Enemy, dt: number, ctx: EnemyCtx, dirX: number, dirZ: number, dist: number): void {
    const sp = e.def.speed * this.speedScale
    if (e.state === 9) {
      // Recovering from a bite.
      e.vel.x = damp(e.vel.x, 0, 2.5, dt)
      e.vel.z = damp(e.vel.z, 0, 2.5, dt)
      return
    }
    // Slight weave so they don't converge on one line.
    const weave = Math.sin(e.bob * 2.4 + e.id) * 0.5
    const tx = dirX + -dirZ * weave
    const tz = dirZ + dirX * weave
    const l = Math.hypot(tx, tz) || 1
    const lunge = dist < 9 ? 1.5 : 1
    e.vel.x = damp(e.vel.x, (tx / l) * sp * lunge, 3.2, dt)
    e.vel.z = damp(e.vel.z, (tz / l) * sp * lunge, 3.2, dt)
    if (dist < 14 && Math.random() < dt * 0.35) ctx.roar(0.15)
  }

  private updateSpitter(e: Enemy, dt: number, ctx: EnemyCtx, dirX: number, dirZ: number, dist: number): void {
    const sp = e.def.speed * this.speedScale
    const want = 24
    // Close if far, back off if near, and always strafe.
    const radial = clamp((dist - want) / 10, -1, 1)
    const strafe = Math.sin(e.bob * 0.5 + e.id) > 0 ? 1 : -1
    const tx = dirX * radial + -dirZ * strafe * 0.8
    const tz = dirZ * radial + dirX * strafe * 0.8
    const l = Math.hypot(tx, tz) || 1
    e.vel.x = damp(e.vel.x, (tx / l) * sp, 2.4, dt)
    e.vel.z = damp(e.vel.z, (tz / l) * sp, 2.4, dt)
    e.heading = dampAngle(e.heading, Math.atan2(dirX, dirZ), 4, dt)

    if (e.timer <= 0 && dist < 44 && dist > 6) {
      e.timer = lerp(3.0, 1.6, clamp01(this.speedScale - 1))
      _v1.set(e.pos.x, e.root.position.y + 0.5, e.pos.z)
      // Lead the target: the boat is usually drifting.
      const travel = dist / 26
      _v2.set(ctx.boat.x + ctx.boatVel.x * travel * 0.65, ctx.boat.y + 0.4, ctx.boat.z + ctx.boatVel.z * travel * 0.65)
      ctx.spawnGlob(_v1, _v2)
      ctx.fx.glow(_v1.x, _v1.y, _v1.z, 0x8ef0b0, 8, 0.5, 0.6)
    }
    // Charging tell.
    if (e.timer < 0.55) ctx.fx.glow(e.pos.x, e.root.position.y + 0.5, e.pos.z, 0x8ef0b0, 1, 0.6, 0.5)
  }

  private updateMine(e: Enemy, dt: number, ctx: EnemyCtx, dist: number): void {
    // Drifts with the swell, creeping slowly toward the boat when close.
    const drift = Math.sin(e.bob * 0.3 + e.id) * 0.6
    const pull = dist < 22 ? 1 : 0.15
    const dx = (ctx.boat.x - e.pos.x) / dist
    const dz = (ctx.boat.z - e.pos.z) / dist
    e.vel.x = damp(e.vel.x, dx * e.def.speed * pull + drift, 1.2, dt)
    e.vel.z = damp(e.vel.z, dz * e.def.speed * pull - drift, 1.2, dt)
    e.root.rotation.x += dt * 0.4
    const lamp = e.mats[2]
    if (lamp) lamp.emissiveIntensity = 2 + Math.abs(Math.sin(e.bob * (dist < 14 ? 9 : 3))) * 4
  }

  private updateBloom(e: Enemy, dt: number, ctx: EnemyCtx, dirX: number, dirZ: number, dist: number): void {
    const sp = e.def.speed * this.speedScale
    const pulse = 0.55 + 0.75 * Math.max(0, Math.sin(e.bob * 2.2))
    e.vel.x = damp(e.vel.x, dirX * sp * pulse, 1.6, dt)
    e.vel.z = damp(e.vel.z, dirZ * sp * pulse, 1.6, dt)
    e.root.scale.setScalar(1 + Math.sin(e.bob * 2.2) * 0.12)
    if (dist < 20 && Math.random() < dt * 2) {
      ctx.fx.glow(e.pos.x, e.root.position.y + 0.3, e.pos.z, 0xc79bff, 1, 0.6, 0.4)
    }
  }

  /**
   * Breacher loop: cruise submerged -> mark a spot under the boat -> erupt.
   * The telegraph ring is the whole fight; if you are still standing on it, that is on you.
   */
  private updateBreacher(e: Enemy, dt: number, ctx: EnemyCtx, dirX: number, dirZ: number, dist: number): void {
    const sp = e.def.speed * this.speedScale
    switch (e.state) {
      case 0: {
        // Approach, submerged.
        e.depth = damp(e.depth, -5.5, 2.5, dt)
        e.vel.x = damp(e.vel.x, dirX * sp, 1.8, dt)
        e.vel.z = damp(e.vel.z, dirZ * sp, 1.8, dt)
        if (dist < 22 && e.timer <= 0) {
          e.state = 1
          e.timer = 2.1
          e.telegraph.set(ctx.boat.x + ctx.boatVel.x * 0.5, 0, ctx.boat.z + ctx.boatVel.z * 0.5)
          ctx.roar(0.85)
          ctx.fx.rings.spawn(e.telegraph.x, e.telegraph.z, 1.2, 6.6, 2.1, 0xff7a4a, 0.85)
          ctx.fx.rings.spawn(e.telegraph.x, e.telegraph.z, 6.6, 1.4, 2.1, 0xffc46a, 0.55)
        }
        break
      }
      case 1: {
        // Winding up under the mark.
        e.depth = damp(e.depth, -7.5, 3, dt)
        const tdx = e.telegraph.x - e.pos.x
        const tdz = e.telegraph.z - e.pos.z
        const td = Math.hypot(tdx, tdz) || 1
        e.vel.x = damp(e.vel.x, (tdx / td) * sp * 1.4, 3, dt)
        e.vel.z = damp(e.vel.z, (tdz / td) * sp * 1.4, 3, dt)
        if (e.timer <= 0.9 && Math.random() < dt * 26) {
          ctx.fx.glow(e.telegraph.x + (Math.random() - 0.5) * 5, ctx.ocean.heightAt(e.telegraph.x, e.telegraph.z), e.telegraph.z + (Math.random() - 0.5) * 5, 0xff9a5c, 1, 1, 0.6)
        }
        if (e.timer <= 0) {
          e.state = 2
          e.timer = 1.25
          e.pos.x = e.telegraph.x
          e.pos.z = e.telegraph.z
          e.vel.set(0, 0, 0)
          // ERUPT.
          const surf = ctx.ocean.heightAt(e.pos.x, e.pos.z)
          ctx.fx.splash(e.pos.x, surf, e.pos.z, 2.6)
          ctx.fx.rings.spawn(e.pos.x, e.pos.z, 1, 20, 1.1, 0xdff2ef, 0.8)
          ctx.roar(1)
          const d = Math.hypot(ctx.boat.x - e.pos.x, ctx.boat.z - e.pos.z)
          if (d < 7.5) {
            const f = 1 - clamp01(d / 7.5)
            ctx.damagePlayer(e.def.contact * f, e.pos.x, e.pos.z, 20 * f, 15 * f)
          }
        }
        break
      }
      case 2: {
        // Airborne / arcing over -- this is the window to shoot it.
        e.depth = lerp(e.depth, 3.4, Math.min(1, dt * 9))
        e.vel.x = damp(e.vel.x, dirX * 3, 1, dt)
        e.vel.z = damp(e.vel.z, dirZ * 3, 1, dt)
        if (e.timer <= 0) {
          e.state = 3
          e.timer = 3.0
        }
        break
      }
      case 3: {
        // Wallowing on the surface, still vulnerable.
        e.depth = damp(e.depth, -0.35, 3, dt)
        e.vel.x = damp(e.vel.x, dirX * sp * 0.35, 1, dt)
        e.vel.z = damp(e.vel.z, dirZ * sp * 0.35, 1, dt)
        if (e.timer <= 0) {
          e.state = 0
          e.timer = 1.4
        }
        break
      }
    }
  }
}

// ------------------------------------------------------------------ leviathan

export interface BossHitPart {
  x: number
  y: number
  z: number
  radius: number
  /** Damage multiplier: gills take full, armoured hide takes a fraction. */
  weak: boolean
}

interface Trail {
  x: number
  y: number
  z: number
  s: number
}

/**
 * The Leviathan: a segmented serpent that arcs in and out of the sea.
 * It is only properly vulnerable while surfaced, which turns the fight into a
 * rhythm -- bail and reposition while it is under, unload while it is up.
 */
export class Leviathan {
  readonly group = new THREE.Group()
  readonly pos = new THREE.Vector3(0, 0, 40)
  private vel = new THREE.Vector3(0, 0, -1)
  private segments: THREE.Group[] = []
  private gillMats: THREE.MeshStandardMaterial[] = []
  private bodyMats: THREE.MeshStandardMaterial[] = []
  private trail: Trail[] = []
  private arc = 0
  private heading = Math.PI
  private depth = -8
  private travelled = 0
  private flash = 0
  private contactCooldown = 0
  private shockTimer = 0
  private shockRadius = 0

  hp = 2600
  maxHp = 2600
  alive = false
  phase = 0
  state: 'enter' | 'cruise' | 'charge' | 'dive' | 'slam' = 'enter'
  timer = 3
  /** Populated each frame for the projectile hit-test. */
  readonly parts: BossHitPart[] = []

  private static readonly SEGMENTS = 17
  private static readonly SPACING = 1.72

  constructor(private fx: Fx) {
    const hide = mat(0x1a2e33, { roughness: 0.5 })
    const plate = mat(0x2f4a4a, { roughness: 0.42, metalness: 0.2 })
    this.bodyMats.push(hide, plate)

    for (let i = 0; i < Leviathan.SEGMENTS; i++) {
      const g = new THREE.Group()
      const t = i / (Leviathan.SEGMENTS - 1)
      const r = i === 0 ? 1.55 : lerp(1.35, 0.28, Math.pow(t, 0.85))
      const seg = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), i % 2 === 0 ? hide : plate)
      seg.scale.set(1, 0.92, 1.1)
      seg.castShadow = true
      g.add(seg)

      if (i > 0) {
        const fin = new THREE.Mesh(new THREE.ConeGeometry(r * 0.7, r * 1.7, 3), plate)
        fin.rotation.y = Math.PI / 2
        fin.scale.z = 0.18
        fin.position.y = r * 0.75
        g.add(fin)
      }

      // Glowing gills on the forward segments: the weak points.
      if (i >= 1 && i <= 7) {
        const gm = mat(0xffd166, { emissive: 0xff8c2a, emissiveIntensity: 2.4, roughness: 0.3 })
        this.gillMats.push(gm)
        for (const sx of [-1, 1]) {
          const gl = new THREE.Mesh(new THREE.SphereGeometry(r * 0.3, 7, 6), gm)
          gl.position.set(sx * r * 0.85, 0.1, 0)
          gl.scale.set(0.5, 1, 0.7)
          g.add(gl)
        }
      }

      if (i === 0) {
        const jaw = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.6, 5), hide)
        jaw.rotation.x = Math.PI / 2
        jaw.position.z = 1.9
        jaw.castShadow = true
        g.add(jaw)
        const maw = mat(0xff6b4a, { emissive: 0xc42a1a, emissiveIntensity: 1.6 })
        this.gillMats.push(maw)
        const inner = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.6, 5), maw)
        inner.rotation.x = -Math.PI / 2
        inner.position.z = 1.85
        g.add(inner)
        const eyeM = mat(0xfff0c0, { emissive: 0xffc247, emissiveIntensity: 3.2 })
        this.gillMats.push(eyeM)
        for (const sx of [-1, 1]) {
          const e = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), eyeM)
          e.position.set(sx * 0.78, 0.55, 0.85)
          g.add(e)
        }
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.5, 5), plate)
        horn.position.set(0, 1.2, -0.1)
        horn.rotation.x = -0.5
        g.add(horn)
      }

      this.segments.push(g)
      this.group.add(g)
      this.parts.push({ x: 0, y: 0, z: 0, radius: r * 1.1, weak: i >= 1 && i <= 7 })
    }
    this.group.visible = false
  }

  spawn(hp: number): void {
    this.alive = true
    this.hp = hp
    this.maxHp = hp
    this.phase = 0
    this.state = 'enter'
    this.timer = 2.6
    this.pos.set(0, 0, 46)
    this.vel.set(0, 0, -8)
    this.heading = Math.PI
    this.depth = -9
    this.arc = 0
    this.travelled = 0
    this.trail.length = 0
    this.group.visible = true
  }

  despawn(): void {
    this.alive = false
    this.group.visible = false
    this.contactCooldown = 0
    this.shockTimer = 0
    // `parts` is one entry per segment and is built once in the constructor -- clearing
    // it here would leave the next spawn writing into an empty array.
  }

  get surfaced(): boolean {
    return this.depth > -1.6
  }

  damage(amount: number, weak: boolean, x: number, y: number, z: number): boolean {
    if (!this.alive) return false
    const mult = weak ? (this.surfaced ? 1 : 0.5) : this.surfaced ? 0.42 : 0.16
    this.hp -= amount * mult
    this.flash = 1
    this.fx.impact(x, y, z, weak ? 0xffc247 : 0x8fd8d8, weak ? 1.5 : 0.7)
    const frac = this.hp / this.maxHp
    const newPhase = frac < 0.34 ? 2 : frac < 0.67 ? 1 : 0
    if (newPhase > this.phase) {
      this.phase = newPhase
      this.timer = Math.min(this.timer, 0.4)
    }
    if (this.hp <= 0) {
      this.hp = 0
      return true
    }
    return false
  }

  update(dt: number, ctx: EnemyCtx): void {
    if (!this.alive) return
    this.timer -= dt
    this.arc += dt
    this.flash = Math.max(0, this.flash - dt * 4)

    const speedBoost = 1 + this.phase * 0.24
    const toX = ctx.boat.x - this.pos.x
    const toZ = ctx.boat.z - this.pos.z
    const dist = Math.hypot(toX, toZ) || 0.0001

    switch (this.state) {
      case 'enter': {
        this.depth = damp(this.depth, -1.0, 1.6, dt)
        this.steer(dt, Math.atan2(toX, toZ), 9 * speedBoost)
        if (this.timer <= 0) {
          this.state = 'cruise'
          this.timer = 4.5
        }
        break
      }
      case 'cruise': {
        // Serpentine orbit, porpoising in and out of the water.
        const orbit = Math.atan2(toX, toZ) + (dist > 34 ? 0 : 0.85)
        this.steer(dt, orbit + Math.sin(this.arc * 0.6) * 0.5, 10.5 * speedBoost)
        this.depth = lerp(-3.6, 1.1, 0.5 + 0.5 * Math.sin(this.arc * 1.15))
        if (this.timer <= 0) {
          const roll = Math.random()
          if (roll < 0.42) {
            this.state = 'charge'
            this.timer = 3.2
            ctx.roar(1)
          } else if (roll < 0.72) {
            this.state = 'slam'
            this.timer = 1.5
            ctx.roar(0.6)
          } else {
            this.state = 'dive'
            this.timer = 2.6
          }
        }
        break
      }
      case 'charge': {
        this.depth = damp(this.depth, 1.5, 4, dt)
        this.steer(dt, Math.atan2(toX, toZ), 19 * speedBoost, 2.6)
        if (Math.random() < dt * 30) {
          const s = ctx.ocean.heightAt(this.pos.x, this.pos.z)
          this.fx.splash(this.pos.x, s, this.pos.z, 1.1)
        }
        if (this.timer <= 0) {
          this.state = 'cruise'
          this.timer = 3.4 - this.phase * 0.7
        }
        break
      }
      case 'slam': {
        this.depth = damp(this.depth, 2.6, 5, dt)
        this.steer(dt, this.heading, 4, 1.2)
        if (this.timer <= 0) {
          // Tail slam: a shock ring that swamps anything it washes over.
          const s = ctx.ocean.heightAt(this.pos.x, this.pos.z)
          this.fx.splash(this.pos.x, s, this.pos.z, 3.0)
          this.fx.rings.spawn(this.pos.x, this.pos.z, 1, 46, 1.6, 0xcfe9ff, 0.9)
          ctx.roar(0.9)
          _shock.set(this.pos.x, 0, this.pos.z)
          this.shockTimer = 1.6
          this.shockRadius = 1
          this.state = 'cruise'
          this.timer = 3.6 - this.phase * 0.7
        }
        break
      }
      case 'dive': {
        this.depth = damp(this.depth, -6.5, 3, dt)
        this.steer(dt, Math.atan2(toX, toZ) + 1.2, 12 * speedBoost)
        if (this.timer <= 0) {
          const n = 2 + this.phase
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2
            const r = 18 + Math.random() * 18
            ctx.requestSpawn(this.phase >= 1 && i % 2 === 0 ? 'spitter' : 'snapper', Math.cos(a) * r, Math.sin(a) * r)
          }
          this.state = 'cruise'
          this.timer = 4.0 - this.phase * 0.8
        }
        break
      }
    }

    // Expanding shockwave from a tail slam.
    if (this.shockTimer > 0) {
      this.shockTimer -= dt
      const prev = this.shockRadius
      this.shockRadius += dt * 30
      const d = Math.hypot(ctx.boat.x - _shock.x, ctx.boat.z - _shock.z)
      if (d >= prev && d < this.shockRadius) {
        const dx = (ctx.boat.x - _shock.x) / (d || 1)
        const dz = (ctx.boat.z - _shock.z) / (d || 1)
        ctx.damagePlayer(17, ctx.boat.x - dx * 4, ctx.boat.z - dz * 4, 22)
      }
    }

    // ---- integrate + trail
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    const r = Math.hypot(this.pos.x, this.pos.z)
    const lim = ctx.arenaRadius - 5
    if (r > lim) {
      this.pos.x *= lim / r
      this.pos.z *= lim / r
      this.heading = Math.atan2(-this.pos.x, -this.pos.z)
    }
    const surf = ctx.ocean.heightAt(this.pos.x, this.pos.z)
    this.pos.y = surf + this.depth

    const step = Math.hypot(this.vel.x, this.vel.z) * dt
    this.travelled += step
    this.trail.unshift({ x: this.pos.x, y: this.pos.y, z: this.pos.z, s: this.travelled })
    if (this.trail.length > 900) this.trail.length = 900

    // ---- place segments along the trail by arc length
    for (let i = 0; i < this.segments.length; i++) {
      const want = this.travelled - i * Leviathan.SPACING
      const p = this.sampleTrail(want)
      const seg = this.segments[i]
      seg.position.set(p.x, p.y, p.z)
      const ahead = this.sampleTrail(want + 1.0)
      seg.lookAt(ahead.x, ahead.y, ahead.z)
      // Body ripples so it reads as a living thing rather than a chain of balls.
      const wob = Math.sin(this.arc * 3.2 - i * 0.55) * 0.14
      seg.rotation.z += wob
      const part = this.parts[i]
      part.x = p.x
      part.y = p.y
      part.z = p.z

      if (p.y > surf - 0.6 && Math.random() < dt * 5) {
        this.fx.wake(p.x, ctx.ocean.heightAt(p.x, p.z), p.z, 0.9)
      }
    }

    // ---- charge contact
    if (this.surfaced) {
      for (let i = 0; i < this.parts.length; i += 2) {
        const part = this.parts[i]
        const d = Math.hypot(ctx.boat.x - part.x, ctx.boat.z - part.z)
        if (d < part.radius + 2.6 && this.contactCooldown <= 0) {
          this.contactCooldown = 1.1
          const charging = this.state === 'charge'
          ctx.damagePlayer(charging ? 24 : 14, part.x, part.z, charging ? 28 : 12, charging ? 10 : 4)
          break
        }
      }
    }
    this.contactCooldown = Math.max(0, this.contactCooldown - dt)

    // ---- looks
    const f = this.flash * this.flash
    const gillPulse = 1.6 + Math.sin(this.arc * 3) * 0.6 + (this.surfaced ? 1.8 : 0)
    for (const m of this.gillMats) m.emissiveIntensity = gillPulse + f * 6
    for (const m of this.bodyMats) {
      m.emissive.setRGB(f * 0.9, f * 0.85, f * 0.8)
      m.emissiveIntensity = 1
    }
    if (this.surfaced && Math.random() < dt * 8) {
      this.fx.glow(this.pos.x, this.pos.y + 1.5, this.pos.z, 0xffb347, 2, 2.2, 0.7)
    }
    void dist
  }

  private steer(dt: number, targetHeading: number, speed: number, turnRate = 1.5): void {
    this.heading = dampAngle(this.heading, targetHeading, turnRate, dt)
    const tx = Math.sin(this.heading) * speed
    const tz = Math.cos(this.heading) * speed
    this.vel.x = damp(this.vel.x, tx, 2.2, dt)
    this.vel.z = damp(this.vel.z, tz, 2.2, dt)
  }

  private sampleTrail(s: number): Trail {
    const t = this.trail
    if (t.length === 0) return { x: this.pos.x, y: this.pos.y, z: this.pos.z, s: 0 }
    if (s >= t[0].s) return t[0]
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i].s >= s && t[i + 1].s <= s) {
        const span = t[i].s - t[i + 1].s
        const k = span > 0.0001 ? (t[i].s - s) / span : 0
        _tr.x = lerp(t[i].x, t[i + 1].x, k)
        _tr.y = lerp(t[i].y, t[i + 1].y, k)
        _tr.z = lerp(t[i].z, t[i + 1].z, k)
        _tr.s = s
        return _tr
      }
    }
    return t[t.length - 1]
  }
}

const _n = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _shock = new THREE.Vector3()
const _white = new THREE.Color(1, 1, 1)
const _tr: Trail = { x: 0, y: 0, z: 0, s: 0 }

interface EmissiveBase {
  color: THREE.Color
  intensity: number
}

/** Remembers a material's authored emissive so the hit flash can return to it. */
function baseEmissive(m: THREE.MeshStandardMaterial): EmissiveBase {
  let base = m.userData.emissiveBase as EmissiveBase | undefined
  if (!base) {
    base = { color: m.emissive.clone(), intensity: m.emissiveIntensity }
    m.userData.emissiveBase = base
  }
  return base
}
