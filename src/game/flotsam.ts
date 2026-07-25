import * as THREE from 'three'
import { damp } from '../core/mathx'
import type { Ocean } from '../world/ocean'
import type { Fx } from '../fx/particles'

interface Crate {
  active: boolean
  x: number
  z: number
  vx: number
  vz: number
  spin: number
  life: number
  mesh: THREE.Group
}

const MAX = 16

/**
 * Salvage barrels shaken loose by a kill. Collecting one pumps water out of your
 * hull and pays score, which gives the player a reason to steer somewhere specific
 * rather than always backing away from the swarm.
 */
export class Flotsam {
  readonly group = new THREE.Group()
  private crates: Crate[] = []

  onCollect: ((x: number, y: number, z: number) => void) | null = null

  constructor(private fx: Fx) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5230, flatShading: true, roughness: 0.75 })
    const hoop = new THREE.MeshStandardMaterial({ color: 0x2f2a26, flatShading: true, roughness: 0.5, metalness: 0.6 })
    const glow = new THREE.MeshStandardMaterial({
      color: 0x9fe6ff,
      emissive: 0x49b7e0,
      emissiveIntensity: 2.6,
      flatShading: true,
      transparent: true,
      opacity: 0.85,
    })

    for (let i = 0; i < MAX; i++) {
      const g = new THREE.Group()
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.95, 9), wood)
      barrel.rotation.z = Math.PI / 2
      barrel.castShadow = true
      g.add(barrel)
      for (const z of [-0.28, 0.28]) {
        const h = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.05, 5, 12), hoop)
        h.rotation.y = Math.PI / 2
        h.position.x = z
        g.add(h)
      }
      const beacon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), glow)
      beacon.position.y = 0.55
      g.add(beacon)
      g.visible = false
      this.group.add(g)
      this.crates.push({ active: false, x: 0, z: 0, vx: 0, vz: 0, spin: 0, life: 0, mesh: g })
    }
  }

  drop(x: number, z: number): void {
    const c = this.crates.find((q) => !q.active)
    if (!c) return
    c.active = true
    c.x = x
    c.z = z
    const a = Math.random() * Math.PI * 2
    c.vx = Math.cos(a) * 2.4
    c.vz = Math.sin(a) * 2.4
    c.spin = Math.random() * Math.PI * 2
    c.life = 26
    c.mesh.visible = true
  }

  clear(): void {
    for (const c of this.crates) {
      c.active = false
      c.mesh.visible = false
    }
  }

  update(dt: number, ocean: Ocean, boat: THREE.Vector3): void {
    for (const c of this.crates) {
      if (!c.active) continue
      c.life -= dt
      if (c.life <= 0) {
        c.active = false
        c.mesh.visible = false
        continue
      }
      // Drift downhill on the swell, exactly like everything else afloat.
      ocean.normalAt(c.x, c.z, _n)
      c.vx += -_n.x * 30 * dt
      c.vz += -_n.z * 30 * dt
      const d = Math.exp(-1.6 * dt)
      c.vx *= d
      c.vz *= d
      c.x += c.vx * dt
      c.z += c.vz * dt
      c.spin += dt * 1.4

      const surf = ocean.heightAt(c.x, c.z)
      c.mesh.position.set(c.x, damp(c.mesh.position.y, surf + 0.16, 12, dt), c.z)
      c.mesh.rotation.set(Math.sin(c.spin) * 0.25, c.spin * 0.5, Math.cos(c.spin * 0.9) * 0.3, 'YXZ')

      // Blink out in the last few seconds so its disappearance isn't a surprise.
      const beacon = c.mesh.children[3] as THREE.Mesh
      const m = beacon.material as THREE.MeshStandardMaterial
      m.emissiveIntensity = c.life < 6 ? (Math.sin(c.life * 12) > 0 ? 3.4 : 0.3) : 2.2 + Math.sin(c.spin * 3) * 0.8

      if (Math.hypot(boat.x - c.x, boat.z - c.z) < 3.2) {
        c.active = false
        c.mesh.visible = false
        this.fx.glow(c.x, surf + 0.5, c.z, 0x9fe6ff, 16, 1.2, 1.4)
        this.fx.rings.spawn(c.x, c.z, 0.4, 5, 0.5, 0x9fe6ff, 0.7)
        this.onCollect?.(c.x, surf, c.z)
      }
    }
  }
}

const _n = new THREE.Vector3()
