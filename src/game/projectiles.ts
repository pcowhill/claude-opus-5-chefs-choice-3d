import * as THREE from 'three'
import type { Fx } from '../fx/particles'

export const SHOT_GRAVITY = -21.5
export const GLOB_GRAVITY = -17

export type ProjectileKind = 'ball' | 'grape' | 'glob'

interface Proj {
  active: boolean
  kind: ProjectileKind
  pos: THREE.Vector3
  vel: THREE.Vector3
  gravity: number
  damage: number
  pierce: number
  splash: number
  radius: number
  life: number
  charge: number
  hitIds: number[]
  trailTimer: number
}

const MAX = 420

export interface ImpactInfo {
  x: number
  y: number
  z: number
  damage: number
  splash: number
  kind: ProjectileKind
  charge: number
  /** True when it struck water/rock rather than a beast. */
  missed: boolean
}

/**
 * Every projectile in the game -- yours and theirs -- in three instanced meshes.
 * Motion is plain ballistics against the analytic wave surface; nothing here needs
 * a rigid-body solver, and doing it by hand keeps the arcs perfectly predictable
 * for the aiming guide.
 */
export class Projectiles {
  readonly group = new THREE.Group()
  private items: Proj[] = []
  private meshes: Record<ProjectileKind, THREE.InstancedMesh>

  onImpact: ((info: ImpactInfo) => void) | null = null
  /** Return the beast hit, if any. Implemented by the game so this file stays dumb. */
  hitTest:
    | ((kind: ProjectileKind, pos: THREE.Vector3, radius: number, ignore: number[]) => { id: number; x: number; y: number; z: number } | null)
    | null = null
  /** Player hull test for enemy globs. */
  hitPlayer: ((pos: THREE.Vector3, radius: number) => boolean) | null = null
  surfaceAt: (x: number, z: number) => number = () => 0
  blockedAt: ((x: number, z: number, y: number) => boolean) | null = null

  constructor(private fx: Fx) {
    for (let i = 0; i < MAX; i++) {
      this.items.push({
        active: false,
        kind: 'ball',
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        gravity: SHOT_GRAVITY,
        damage: 0,
        pierce: 0,
        splash: 0,
        radius: 0.3,
        life: 0,
        charge: 0,
        hitIds: [],
        trailTimer: 0,
      })
    }

    const iron = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.45, metalness: 0.75, flatShading: true })
    const glob = new THREE.MeshStandardMaterial({
      color: 0x6fe0a0,
      emissive: 0x2ba86a,
      emissiveIntensity: 1.8,
      roughness: 0.25,
      flatShading: true,
    })

    this.meshes = {
      ball: new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.24, 1), iron, MAX),
      grape: new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 0), iron, MAX),
      glob: new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 1), glob, MAX),
    }
    for (const m of Object.values(this.meshes)) {
      m.castShadow = true
      m.frustumCulled = false
      m.count = 0
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(m)
    }
  }

  clear(): void {
    for (const p of this.items) p.active = false
  }

  spawn(
    kind: ProjectileKind,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    damage: number,
    opts: { pierce?: number; splash?: number; charge?: number; gravity?: number } = {},
  ): void {
    const p = this.items.find((q) => !q.active)
    if (!p) return
    p.active = true
    p.kind = kind
    p.pos.copy(origin)
    p.vel.copy(dir).multiplyScalar(speed)
    p.gravity = opts.gravity ?? (kind === 'glob' ? GLOB_GRAVITY : SHOT_GRAVITY)
    p.damage = damage
    p.pierce = opts.pierce ?? 0
    p.splash = opts.splash ?? 0
    p.charge = opts.charge ?? 0
    p.radius = kind === 'grape' ? 0.34 : kind === 'glob' ? 0.7 : 0.55 + p.charge * 0.35
    p.life = kind === 'grape' ? 2.2 : 6
    p.hitIds.length = 0
    p.trailTimer = 0
  }

  update(dt: number, onPlayerHit: (damage: number, x: number, z: number) => void): void {
    const counts: Record<ProjectileKind, number> = { ball: 0, grape: 0, glob: 0 }

    for (const p of this.items) {
      if (!p.active) continue
      p.life -= dt
      if (p.life <= 0) {
        p.active = false
        continue
      }

      // Substep so fast rounds cannot tunnel through a beast or the surface.
      const steps = Math.min(4, 1 + Math.floor((p.vel.length() * dt) / 0.8))
      const h = dt / steps
      let dead = false
      for (let s = 0; s < steps && !dead; s++) {
        p.vel.y += p.gravity * h
        p.pos.addScaledVector(p.vel, h)

        if (p.kind === 'glob') {
          if (this.hitPlayer?.(p.pos, p.radius)) {
            onPlayerHit(p.damage, p.pos.x, p.pos.z)
            this.fx.splash(p.pos.x, p.pos.y, p.pos.z, 0.85, 0x88f0b4)
            dead = true
            break
          }
        } else {
          const hit = this.hitTest?.(p.kind, p.pos, p.radius, p.hitIds)
          if (hit) {
            p.hitIds.push(hit.id)
            this.onImpact?.({
              x: p.pos.x, y: p.pos.y, z: p.pos.z,
              damage: p.damage, splash: p.splash, kind: p.kind, charge: p.charge, missed: false,
            })
            if (p.pierce > 0) {
              p.pierce -= 1
              p.vel.multiplyScalar(0.82)
            } else {
              dead = true
              break
            }
          }
          if (this.blockedAt?.(p.pos.x, p.pos.z, p.pos.y)) {
            this.fx.debris(p.pos.x, p.pos.y, p.pos.z, 0x6a6560, 8, 0.7)
            this.onImpact?.({
              x: p.pos.x, y: p.pos.y, z: p.pos.z,
              damage: 0, splash: p.splash, kind: p.kind, charge: p.charge, missed: true,
            })
            dead = true
            break
          }
        }

        const surf = this.surfaceAt(p.pos.x, p.pos.z)
        if (p.pos.y <= surf) {
          const power = p.kind === 'grape' ? 0.32 : 0.55 + p.charge * 1.05
          this.fx.splash(p.pos.x, surf, p.pos.z, power, p.kind === 'glob' ? 0xa8f0c8 : 0xdff2ef)
          this.onImpact?.({
            x: p.pos.x, y: surf, z: p.pos.z,
            damage: p.damage, splash: p.splash, kind: p.kind, charge: p.charge, missed: true,
          })
          dead = true
          break
        }
      }
      if (dead) {
        p.active = false
        continue
      }

      // Trails.
      p.trailTimer -= dt
      if (p.trailTimer <= 0) {
        p.trailTimer = 0.026
        if (p.kind === 'ball' && p.charge > 0.25) {
          this.fx.glow(p.pos.x, p.pos.y, p.pos.z, 0xff9a3c, 1, 0.12, 0.2)
        } else if (p.kind === 'glob') {
          this.fx.glow(p.pos.x, p.pos.y, p.pos.z, 0x5fe098, 1, 0.2, 0.1)
        }
      }

      const i = counts[p.kind]++
      const scale = p.kind === 'ball' ? 1 + p.charge * 0.55 : 1
      _m.makeScale(scale, scale, scale)
      _m.setPosition(p.pos)
      this.meshes[p.kind].setMatrixAt(i, _m)
    }

    for (const k of ['ball', 'grape', 'glob'] as const) {
      const m = this.meshes[k]
      m.count = counts[k]
      m.instanceMatrix.needsUpdate = true
    }
  }
}

const _m = new THREE.Matrix4()

/**
 * Traces the exact same ballistic path the gun will fire, for the on-screen
 * aiming guide. Returns sample points and the predicted splashdown.
 */
export function simulateArc(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  speed: number,
  surfaceAt: (x: number, z: number) => number,
  out: THREE.Vector3[],
  maxPoints = 44,
  step = 0.045,
): { points: number; landing: THREE.Vector3 | null } {
  _p.copy(origin)
  _v.copy(dir).multiplyScalar(speed)
  let n = 0
  for (let i = 0; i < maxPoints; i++) {
    _v.y += SHOT_GRAVITY * step
    _p.addScaledVector(_v, step)
    const surf = surfaceAt(_p.x, _p.z)
    if (_p.y <= surf) {
      _landing.set(_p.x, surf, _p.z)
      return { points: n, landing: _landing }
    }
    if (n < out.length) {
      out[n].copy(_p)
      n++
    }
  }
  return { points: n, landing: null }
}

const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _landing = new THREE.Vector3()
