import * as THREE from 'three'
import { Rng } from '../core/rng'
import type { Ocean } from './ocean'
import type { Fx } from '../fx/particles'

export interface Rock {
  x: number
  z: number
  radius: number
  height: number
  mesh: THREE.Mesh
}

/**
 * The reef: a ring of sea stacks that fences the arena, plus a few pillars inside it.
 * Bouncing off a stack is a legitimate way to change direction without spending heat,
 * so the boundary is a tool rather than just a wall.
 */
export class Reef {
  readonly group = new THREE.Group()
  readonly rocks: Rock[] = []
  private foamTimer = 0

  constructor(public readonly arenaRadius: number, fxSeed = 7) {
    const rng = new Rng(fxSeed)
    // Clusters rather than an even palisade: gaps let you see out, and clumps of
    // two or three read as a real reef instead of a row of fence posts.
    const clusters = 15
    for (let i = 0; i < clusters; i++) {
      const baseA = (i / clusters) * Math.PI * 2 + rng.range(-0.09, 0.09)
      const n = rng.next() < 0.45 ? 3 : rng.next() < 0.6 ? 1 : 2
      for (let k = 0; k < n; k++) {
        const a = baseA + rng.range(-0.075, 0.075)
        const r = arenaRadius + rng.range(1.0, 7.5)
        const radius = rng.range(2.6, 5.4)
        const height = rng.range(7, 17)
        this.add(Math.cos(a) * r, Math.sin(a) * r, radius, height, rng)
      }
    }
    // Interior pillars: cover, bank shots, and something to read scale against.
    const inner: [number, number, number, number][] = [
      [0.6, 0.55, 4.0, 17],
      [2.35, 0.46, 3.2, 12],
      [3.95, 0.62, 4.4, 20],
      [5.3, 0.4, 2.9, 10],
    ]
    for (const [a, rf, rad, h] of inner) {
      this.add(Math.cos(a) * arenaRadius * rf, Math.sin(a) * arenaRadius * rf, rad, h, rng)
    }
    this.group.name = 'reef'
  }

  /**
   * A sea stack lofted from a subdivided icosahedron. Because every vertex is
   * displaced by a smooth function of its own unit direction, the surface stays
   * seam-free -- displacing a cylinder instead splits open along the UV seam.
   */
  private add(x: number, z: number, radius: number, height: number, rng: Rng): void {
    const geo = new THREE.IcosahedronGeometry(1, 2)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const colors: number[] = []
    const wet = new THREE.Color(0x161c1e)
    const stone = new THREE.Color(0x3b3831)
    const lit = new THREE.Color(0x736958)
    const c = new THREE.Color()

    const s1 = rng.range(0, 40)
    const s2 = rng.range(0, 40)
    const s3 = rng.range(0, 40)
    const half = height / 2

    for (let i = 0; i < pos.count; i++) {
      const ux = pos.getX(i)
      const uy = pos.getY(i)
      const uz = pos.getZ(i)

      // Narrower toward the top, flared at the base -- a weathered stack profile.
      const taper = 1 - 0.42 * Math.max(0, uy) + 0.2 * Math.max(0, -uy)
      const lumps =
        1 +
        0.3 * Math.sin(ux * 3.1 + s1) * Math.sin(uz * 2.7 + s2) +
        0.17 * Math.sin(uy * 5.3 + s3) +
        0.1 * Math.sin(ux * 8.2 + uz * 7.1 + s1 * 2)
      const rr = radius * taper * lumps
      const py = uy * half * (0.92 + 0.16 * Math.sin(ux * 4.4 + s2))
      pos.setXYZ(i, ux * rr, py, uz * rr)

      const up = (py + half) / height
      // A dark, wet band at the waterline sells the stack as sitting *in* the sea.
      const worldY = py + half - 2.9
      if (worldY < 1.6) c.copy(wet).lerp(stone, Math.max(0, worldY) / 1.6)
      else c.copy(stone).lerp(lit, Math.pow(up, 2.0))
      colors.push(c.r, c.g, c.b)
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.94, metalness: 0.02 }),
    )
    mesh.position.set(x, half - 2.9, z)
    mesh.rotation.y = rng.range(0, Math.PI * 2)
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.group.add(mesh)
    this.rocks.push({ x, z, radius: radius * 0.95, height, mesh })
  }

  /** True if a point is inside a stack (used by projectiles). */
  blocks(x: number, z: number, y: number): boolean {
    for (const r of this.rocks) {
      if (y > r.height - 2.9) continue
      const dx = x - r.x
      const dz = z - r.z
      if (dx * dx + dz * dz < r.radius * r.radius) return true
    }
    return false
  }

  /**
   * Pushes a moving body out of any stack it has entered and reflects its velocity.
   * Returns the impact speed, or 0 if there was no collision.
   */
  collide(pos: THREE.Vector3, vel: THREE.Vector3, bodyRadius: number, restitution = 0.62): number {
    let impact = 0
    for (const r of this.rocks) {
      const dx = pos.x - r.x
      const dz = pos.z - r.z
      const min = r.radius + bodyRadius
      const d2 = dx * dx + dz * dz
      if (d2 >= min * min || d2 < 1e-6) continue
      const d = Math.sqrt(d2)
      const nx = dx / d
      const nz = dz / d
      pos.x = r.x + nx * min
      pos.z = r.z + nz * min
      const vn = vel.x * nx + vel.z * nz
      if (vn < 0) {
        impact = Math.max(impact, -vn)
        vel.x -= (1 + restitution) * vn * nx
        vel.z -= (1 + restitution) * vn * nz
      }
    }
    return impact
  }

  update(dt: number, ocean: Ocean, fx: Fx, focus: THREE.Vector3): void {
    // Surf breaking on the nearest stacks -- purely for life, capped for cost.
    this.foamTimer -= dt
    if (this.foamTimer > 0) return
    this.foamTimer = 0.07
    for (const r of this.rocks) {
      const d = Math.hypot(r.x - focus.x, r.z - focus.z)
      if (d > 70) continue
      if (Math.random() > 0.34) continue
      const a = Math.random() * Math.PI * 2
      const px = r.x + Math.cos(a) * r.radius
      const pz = r.z + Math.sin(a) * r.radius
      fx.wake(px, ocean.heightAt(px, pz) + 0.1, pz, 0.55 + ocean.swell * 0.25)
    }
  }
}
