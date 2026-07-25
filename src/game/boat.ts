import * as THREE from 'three'
import { clamp, clamp01, damp, dampAngle, lerp } from '../core/mathx'
import type { Ocean } from '../world/ocean'
import type { Fx } from '../fx/particles'
import type { Stats } from './upgrades'

const WOOD_DARK = 0x774d2b
const WOOD_MID = 0xa2743f
const RAIL = 0xba8b55
const BRASS = 0xb98a3a
const IRON = 0x2b2724

export const HULL_LENGTH = 5.4
export const HULL_BEAM = 2.05

/** Stern-to-bow station lines: [t, halfBeamFactor, keelY, sheerY]. */
const STATIONS: readonly [number, number, number, number][] = [
  [0.0, 0.60, -0.40, 0.44],
  [0.10, 0.76, -0.50, 0.42],
  [0.26, 0.92, -0.57, 0.40],
  [0.44, 1.0, -0.58, 0.39],
  [0.60, 0.96, -0.55, 0.40],
  [0.74, 0.82, -0.48, 0.44],
  [0.86, 0.58, -0.35, 0.51],
  [0.94, 0.34, -0.20, 0.58],
  [1.0, 0.08, 0.0, 0.64],
]
const RADIAL = 11

/**
 * Lofts a rowboat hull from the station table: pointed bow, full transom stern,
 * rounded-V sections. Flat-shaded, so it reads as carved timber rather than plastic.
 */
function buildHull(): THREE.BufferGeometry {
  const pos: number[] = []
  const idx: number[] = []
  const cols: number[] = []
  const cDark = new THREE.Color(WOOD_DARK)
  const cMid = new THREE.Color(WOOD_MID)

  const stationPoint = (s: number, j: number): [number, number, number] => {
    const [t, hw, keelY, sheerY] = STATIONS[s]
    const p = (j / (RADIAL - 1)) * 2 - 1 // -1 port .. +1 starboard
    const ap = Math.abs(p)
    const x = p * hw * (HULL_BEAM / 2)
    const y = keelY + (sheerY - keelY) * Math.pow(ap, 1.55)
    const z = (t - 0.42) * HULL_LENGTH
    return [x, y, z]
  }

  for (let s = 0; s < STATIONS.length; s++) {
    for (let j = 0; j < RADIAL; j++) {
      const [x, y, z] = stationPoint(s, j)
      pos.push(x, y, z)
      // Two-tone planking: a lighter strake just under the rail.
      const [, , keelY, sheerY] = STATIONS[s]
      const up = (y - keelY) / Math.max(0.01, sheerY - keelY)
      const c = up > 0.72 ? cMid : cDark
      cols.push(c.r, c.g, c.b)
    }
  }
  for (let s = 0; s < STATIONS.length - 1; s++) {
    for (let j = 0; j < RADIAL - 1; j++) {
      const a = s * RADIAL + j
      const b = a + 1
      const c = a + RADIAL
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }

  // Transom: fan-fill the stern opening.
  const base = pos.length / 3
  const [, , keelY0, sheerY0] = STATIONS[0]
  pos.push(0, (keelY0 + sheerY0) * 0.5, -0.42 * HULL_LENGTH)
  cols.push(cDark.r, cDark.g, cDark.b)
  for (let j = 0; j < RADIAL - 1; j++) {
    idx.push(base, j + 1, j)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

/** Closed loop following the sheer line, used for the gunwale rail. */
function sheerCurve(): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = []
  for (let s = 0; s < STATIONS.length; s++) {
    const [t, hw, , sheerY] = STATIONS[s]
    pts.push(new THREE.Vector3(-hw * (HULL_BEAM / 2), sheerY, (t - 0.42) * HULL_LENGTH))
  }
  for (let s = STATIONS.length - 1; s >= 0; s--) {
    const [t, hw, , sheerY] = STATIONS[s]
    pts.push(new THREE.Vector3(hw * (HULL_BEAM / 2), sheerY, (t - 0.42) * HULL_LENGTH))
  }
  return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.2)
}

export interface Shot {
  kind: 'ball' | 'grape'
  origin: THREE.Vector3
  dir: THREE.Vector3
  speed: number
  damage: number
  charge: number
  pierce: number
  splash: number
}

export class Boat {
  readonly group = new THREE.Group()
  readonly cannonPivot = new THREE.Group()
  private cannonElev = new THREE.Group()
  private barrelTipLocal = new THREE.Vector3(0, 0, 1.62)
  private muzzleLight: THREE.PointLight
  private lanternLight: THREE.PointLight
  private innerWater: THREE.Mesh
  private hullMat: THREE.MeshStandardMaterial
  private barrelMat: THREE.MeshStandardMaterial

  // --- kinematics
  readonly pos = new THREE.Vector3(0, 0, 0)
  readonly vel = new THREE.Vector3(0, 0, 0)
  heading = 0
  aimYaw = 0
  aimElev = 0.18
  private visualPitch = 0
  private visualRoll = 0
  private recoilPitch = 0
  private recoilPitchVel = 0
  private vertical = 0

  // --- combat state
  heat = 0
  water = 0
  charge = 0
  charging = false
  jamTimer = 0
  grapeCooldown = 0
  mainCooldown = 0
  bailing = false
  anchored = false
  alive = true
  /** Rises while the deck is being swamped; drives the HUD warning. */
  swampPulse = 0

  onFire: ((shot: Shot) => void) | null = null

  private bailSoundTimer = 0
  private wakeTimer = 0

  constructor(
    private stats: Stats,
    private fx: Fx,
    private sfx: {
      boom: (c: number) => void
      grape: () => void
      jam: () => void
      bail: () => void
      flood: (a: number) => void
    },
  ) {
    this.hullMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.72,
      metalness: 0.05,
      side: THREE.DoubleSide,
    })
    const hull = new THREE.Mesh(buildHull(), this.hullMat)
    hull.castShadow = true
    hull.receiveShadow = true
    this.group.add(hull)

    // Gunwale rail.
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(sheerCurve(), 100, 0.105, 5, true),
      new THREE.MeshStandardMaterial({ color: RAIL, flatShading: true, roughness: 0.62 }),
    )
    rail.castShadow = true
    this.group.add(rail)

    // Keel + stem: a dark spine that reads the boat's axis from above.
    const keel = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.16, HULL_LENGTH * 0.9),
      new THREE.MeshStandardMaterial({ color: 0x3a2412, flatShading: true, roughness: 0.8 }),
    )
    keel.position.set(0, -0.6, 0.05)
    keel.castShadow = true
    this.group.add(keel)

    // Thwarts.
    const thwartMat = new THREE.MeshStandardMaterial({ color: RAIL, flatShading: true, roughness: 0.7 })
    for (const [z, w] of [
      [-0.9, 1.75],
      [0.5, 1.85],
    ] as const) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 0.34), thwartMat)
      t.position.set(0, 0.28, z)
      t.castShadow = true
      this.group.add(t)
    }

    // Floorboards. Without a sole, you are looking down into an unlit trough from the
    // chase camera and the boat reads as a hollow ring rather than a vessel.
    const soleMat = new THREE.MeshStandardMaterial({ color: 0xa87f48, flatShading: true, roughness: 0.8 })
    for (let i = 0; i < 7; i++) {
      const t = i / 6
      const w = 1.62 * (0.42 + 0.58 * Math.sin(Math.PI * (0.16 + 0.72 * t)))
      const plank = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, 0.62), soleMat)
      plank.position.set(0, -0.18 + Math.abs(t - 0.5) * 0.12, (t - 0.44) * 4.5)
      plank.receiveShadow = true
      this.group.add(plank)
    }

    // Bilge water: a plane inside the hull that climbs as you flood.
    this.innerWater = new THREE.Mesh(
      new THREE.PlaneGeometry(HULL_BEAM * 0.74, HULL_LENGTH * 0.72),
      new THREE.MeshStandardMaterial({
        color: 0x0d3a44,
        transparent: true,
        opacity: 0.88,
        roughness: 0.08,
        metalness: 0.0,
      }),
    )
    this.innerWater.rotation.x = -Math.PI / 2
    this.innerWater.position.set(0, -0.12, 0.05)
    this.innerWater.visible = false
    this.group.add(this.innerWater)

    // ---- swivel gun on a pintle at the bow
    this.cannonPivot.position.set(0, 0.46, 1.55)
    this.group.add(this.cannonPivot)

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.15, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: IRON, flatShading: true, roughness: 0.5, metalness: 0.6 }),
    )
    post.position.y = 0.0
    post.castShadow = true
    this.cannonPivot.add(post)

    this.cannonElev.position.y = 0.3
    this.cannonPivot.add(this.cannonElev)

    this.barrelMat = new THREE.MeshStandardMaterial({
      color: BRASS,
      flatShading: true,
      roughness: 0.34,
      metalness: 0.85,
      emissive: 0x000000,
    })
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.225, 1.9, 12), this.barrelMat)
    barrel.rotation.x = Math.PI / 2
    barrel.position.z = 0.62
    barrel.castShadow = true
    this.cannonElev.add(barrel)

    const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.05, 6, 14), this.barrelMat)
    muzzleRing.position.z = 1.55
    this.cannonElev.add(muzzleRing)

    const breech = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), this.barrelMat)
    breech.position.z = -0.34
    breech.castShadow = true
    this.cannonElev.add(breech)

    const yoke = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.055, 6, 14, Math.PI),
      new THREE.MeshStandardMaterial({ color: IRON, flatShading: true, roughness: 0.45, metalness: 0.7 }),
    )
    yoke.rotation.y = Math.PI / 2
    this.cannonElev.add(yoke)

    this.muzzleLight = new THREE.PointLight(0xffb85c, 0, 26, 2)
    this.muzzleLight.position.set(0, 0, 1.8)
    this.cannonElev.add(this.muzzleLight)

    // Stern lantern -- the only warm light once the storm rolls in.
    const lantern = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.15, 0),
      new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb45e, emissiveIntensity: 2.4, flatShading: true }),
    )
    lantern.position.set(0, 0.78, -2.05)
    this.group.add(lantern)
    const post2 = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6),
      new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.6 }),
    )
    post2.position.set(0, 0.5, -2.05)
    this.group.add(post2)
    this.lanternLight = new THREE.PointLight(0xffb45e, 8, 20, 2)
    this.lanternLight.position.set(0, 0.85, -2.0)
    this.group.add(this.lanternLight)
  }

  get maxWater(): number {
    return this.stats.maxWater
  }

  /** 0..1 flooded. 1 = sunk. */
  get flood(): number {
    return clamp01(this.water / this.stats.maxWater)
  }

  /** Height of the gunwale above the hull origin. The flood effect lives in the
   *  waterline itself (see `update`), so this stays constant. */
  get freeboard(): number {
    return 0.46
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z)
  }

  get jammed(): boolean {
    return this.jamTimer > 0
  }

  /** World-space muzzle position. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.barrelTipLocal).applyMatrix4(this.cannonElev.matrixWorld)
  }

  /** World-space aim direction (unit). */
  aimDir(out: THREE.Vector3): THREE.Vector3 {
    const ce = Math.cos(this.aimElev)
    return out.set(Math.sin(this.aimYaw) * ce, Math.sin(this.aimElev), Math.cos(this.aimYaw) * ce)
  }

  reset(): void {
    this.pos.set(0, 0, 0)
    this.vel.set(0, 0, 0)
    this.heading = 0
    this.aimYaw = 0
    this.aimElev = 0.2
    this.heat = 0
    this.water = 0
    this.charge = 0
    this.charging = false
    this.jamTimer = 0
    this.grapeCooldown = 0
    this.mainCooldown = 0
    this.alive = true
    this.recoilPitch = 0
    this.recoilPitchVel = 0
    this.vertical = 0
    this.swampPulse = 0
  }

  addWater(amount: number, loud = true): void {
    if (!this.alive) return
    const before = this.water
    this.water = clamp(this.water + amount * this.stats.floodResist, 0, this.stats.maxWater)
    if (loud && this.water > before + 0.5) this.sfx.flood(clamp01(amount / 18))
    if (this.water >= this.stats.maxWater) this.alive = false
  }

  /** External impulse (breaches, explosions, rock bounces). */
  push(x: number, z: number, y = 0): void {
    const m = this.mass
    this.vel.x += x / m
    this.vel.z += z / m
    this.vertical += y / m
  }

  private get mass(): number {
    return 1 + this.flood * 1.15
  }

  // ------------------------------------------------------------------ update

  update(
    dt: number,
    ocean: Ocean,
    ctrl: {
      lookX: number
      lookY: number
      fireMain: boolean
      fireMainJust: boolean
      fireMainReleased: boolean
      fireGrape: boolean
      bail: boolean
      anchor: boolean
    },
  ): void {
    if (!this.alive) return

    // ---- aim
    this.aimYaw += ctrl.lookX
    this.aimElev = clamp(this.aimElev - ctrl.lookY, -0.14, 0.62)
    this.heading = dampAngle(this.heading, this.aimYaw, 3.4, dt)

    // ---- timers
    this.jamTimer = Math.max(0, this.jamTimer - dt)
    this.grapeCooldown = Math.max(0, this.grapeCooldown - dt)
    this.mainCooldown = Math.max(0, this.mainCooldown - dt)
    this.anchored = ctrl.anchor
    this.bailing = ctrl.bail && this.water > 0.05

    // ---- bailing (blocks the gun: you cannot move while you bail)
    if (this.bailing) {
      this.water = Math.max(0, this.water - this.stats.bailRate * dt)
      this.bailSoundTimer -= dt
      if (this.bailSoundTimer <= 0) {
        this.bailSoundTimer = 0.3
        this.sfx.bail()
        const wh = ocean.heightAt(this.pos.x, this.pos.z)
        this.fx.splash(
          this.pos.x + Math.sin(this.heading + 1.5) * 1.1,
          wh + 0.35,
          this.pos.z + Math.cos(this.heading + 1.5) * 1.1,
          0.35,
        )
      }
    }

    // ---- heat
    const surfaceY = ocean.heightAt(this.pos.x, this.pos.z)
    const deckY = this.group.position.y + this.freeboard
    const awash = clamp01((surfaceY + 0.1 - deckY) / 0.45)
    let cool = this.stats.coolRate * (1 + awash * 1.15) * (this.anchored ? 1.6 : 1)
    if (this.charging) cool *= 0.25
    this.heat = clamp(this.heat - cool * dt, 0, 100)

    // ---- firing
    //
    // Charging starts on the press and the shot goes off on the release, so a quick
    // tap and a held charge are the same gesture at two different lengths. Handling
    // the press explicitly means a click and release inside one frame still fires.
    const canFire = !this.jammed && !this.bailing
    if (canFire && ctrl.fireMainJust && this.mainCooldown <= 0) {
      this.charging = true
      this.charge = 0
    }
    if (this.charging && ctrl.fireMain && canFire) {
      this.charge = clamp01(this.charge + dt / this.stats.chargeTime)
    }
    if (this.charging && (ctrl.fireMainReleased || !ctrl.fireMain || !canFire)) {
      if (canFire) this.fireMain()
      this.charging = false
      this.charge = 0
    }

    if (canFire && ctrl.fireGrape && this.grapeCooldown <= 0) {
      this.fireGrape()
    }

    if (this.heat >= 100 && !this.jammed) {
      this.jamTimer = this.stats.jamDuration
      this.heat = 52
      this.charging = false
      this.charge = 0
      this.sfx.jam()
      this.fx.smoke(
        this.muzzleWorld(_v1).x,
        _v1.y,
        _v1.z,
        14,
        0.35,
        0.85,
      )
    }

    // ---- wave-slope drift: the sea itself pushes the boat downhill
    ocean.normalAt(this.pos.x, this.pos.z, _n)
    const slopeGain = (this.anchored ? 3.0 : 6.6) / this.mass
    this.vel.x += -_n.x * slopeGain * dt * 9.81
    this.vel.z += -_n.z * slopeGain * dt * 9.81

    // ---- drag
    const dragK = (0.62 + this.flood * 0.55) * (this.anchored ? 3.3 : 1)
    const d = Math.exp(-dragK * dt)
    this.vel.x *= d
    this.vel.z *= d

    const maxSpeed = 20
    const sp = this.speed
    if (sp > maxSpeed) {
      this.vel.x *= maxSpeed / sp
      this.vel.z *= maxSpeed / sp
    }

    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt

    // ---- riding the wave: 4-point buoyancy sample
    const fx = Math.sin(this.heading)
    const fz = Math.cos(this.heading)
    const rx = Math.cos(this.heading)
    const rz = -Math.sin(this.heading)
    const half = HULL_LENGTH * 0.44
    const beamHalf = HULL_BEAM * 0.48
    const hBow = ocean.heightAt(this.pos.x + fx * half, this.pos.z + fz * half)
    const hStern = ocean.heightAt(this.pos.x - fx * half, this.pos.z - fz * half)
    const hStbd = ocean.heightAt(this.pos.x + rx * beamHalf, this.pos.z + rz * beamHalf)
    const hPort = ocean.heightAt(this.pos.x - rx * beamHalf, this.pos.z - rz * beamHalf)
    const centre = (hBow + hStern + hStbd + hPort) * 0.25

    // A short vertical spring lets breaches and big shots actually launch the boat.
    this.vertical += -this.vertical * Math.min(1, dt * 5) + 0
    this.vertical -= 22 * dt * Math.sign(this.vertical) * (Math.abs(this.vertical) > 0.02 ? 1 : 0)
    // Ride height. Empty, the boat sits high enough that the planking, thwarts and
    // floorboards all clear the water; as it floods it settles until the rail is awash.
    // This *is* the health bar -- you can read your condition off the hull itself.
    const targetY = centre + lerp(0.34, -0.32, this.flood) + this.vertical
    this.group.position.y = damp(this.group.position.y, targetY, 14, dt)
    this.group.position.x = this.pos.x
    this.group.position.z = this.pos.z

    const targetPitch = -Math.atan2(hBow - hStern, half * 2)
    const targetRoll = Math.atan2(hStbd - hPort, beamHalf * 2)
    this.visualPitch = damp(this.visualPitch, targetPitch, 9, dt)
    this.visualRoll = damp(this.visualRoll, targetRoll, 7, dt)

    // Recoil kick spring on the bow.
    this.recoilPitchVel -= this.recoilPitch * 130 * dt
    this.recoilPitchVel *= Math.exp(-9 * dt)
    this.recoilPitch += this.recoilPitchVel * dt

    this.group.rotation.set(
      this.visualPitch + this.recoilPitch + (this.anchored ? -0.05 : 0),
      this.heading,
      this.visualRoll,
      'YXZ',
    )

    // ---- cannon transform
    this.cannonPivot.rotation.y = -this.heading + this.aimYaw
    this.cannonElev.rotation.x = -this.aimElev - this.visualPitch - this.recoilPitch
    this.group.updateMatrixWorld(true)

    // ---- swamping: waves break over a low freeboard
    const swamp = clamp01((surfaceY - (this.group.position.y + this.freeboard)) / 0.4)
    this.swampPulse = damp(this.swampPulse, swamp, 6, dt)
    if (swamp > 0.02) {
      const rate = swamp * (5.5 + ocean.swell * 5.0) * (this.anchored ? 1.5 : 1)
      this.addWater(rate * dt, false)
      if (Math.random() < swamp * dt * 12) {
        this.fx.splash(
          this.pos.x + (Math.random() - 0.5) * 2,
          surfaceY + 0.2,
          this.pos.z + (Math.random() - 0.5) * 2,
          0.45,
        )
      }
    }

    // ---- wake
    this.wakeTimer -= dt
    const spd = this.speed
    if (this.wakeTimer <= 0 && spd > 1.2) {
      this.wakeTimer = 0.045
      const bx = this.pos.x - fx * 2.4
      const bz = this.pos.z - fz * 2.4
      this.fx.wake(bx, ocean.heightAt(bx, bz), bz, clamp01(spd / 10))
    }
    if (this.anchored && spd > 0.6 && Math.random() < dt * 22) {
      const bx = this.pos.x - fx * 2.6
      const bz = this.pos.z - fz * 2.6
      this.fx.wake(bx, ocean.heightAt(bx, bz), bz, 0.9)
    }

    // ---- visual feedback
    this.muzzleLight.intensity = damp(this.muzzleLight.intensity, 0, 22, dt)
    const heatN = clamp01((this.heat - 45) / 55)
    _col.setRGB(heatN * 1.5, heatN * heatN * 0.35, 0)
    this.barrelMat.emissive.copy(_col)
    this.barrelMat.emissiveIntensity = this.jammed ? 2.6 : 1.4

    const f = this.flood
    this.innerWater.visible = f > 0.02
    this.innerWater.position.y = lerp(-0.12, 0.36, f)
    ;(this.innerWater.material as THREE.MeshStandardMaterial).opacity = 0.55 + f * 0.35
    this.hullMat.color.setRGB(1 - f * 0.35, 1 - f * 0.42, 1 - f * 0.4)
    this.lanternLight.intensity = 8 + this.flood * 5

    if (this.jammed && Math.random() < dt * 26) {
      this.muzzleWorld(_v1)
      this.fx.smoke(_v1.x, _v1.y, _v1.z, 1, 0.22, 0.9)
    }
  }

  private fireMain(): void {
    const charge = this.charge
    const st = this.stats
    this.mainCooldown = 0.14
    this.heat = clamp(this.heat + lerp(st.heatPerShot, st.heatPerShot * 2.15, charge), 0, 100)

    this.muzzleWorld(_v1)
    this.aimDir(_v2)

    const speed = lerp(46, 78, charge) * st.projectileSpeed
    const damage = lerp(st.damage, st.damage * 3.1, charge)

    this.onFire?.({
      kind: 'ball',
      origin: _v1.clone(),
      dir: _v2.clone(),
      speed,
      damage,
      charge,
      pierce: st.pierce + (charge > 0.85 ? 1 : 0),
      splash: st.splash * lerp(1, 1.8, charge),
    })

    // Recoil: only the horizontal component shoves the hull, so lobbing high
    // trades away your mobility. The vertical component rears the bow instead.
    const impulse = lerp(3.4, 10.5, charge) * st.recoil
    const horiz = Math.cos(this.aimElev)
    this.push(-_v2.x * impulse * horiz, -_v2.z * impulse * horiz)
    this.vertical += impulse * Math.sin(this.aimElev) * 0.09
    this.recoilPitchVel += impulse * 0.055

    this.muzzleLight.intensity = 14 + charge * 26
    this.fx.muzzle(_v1, _v2, charge)
    this.sfx.boom(charge)
  }

  private fireGrape(): void {
    const st = this.stats
    this.grapeCooldown = 0.62
    this.heat = clamp(this.heat + st.heatPerShot * 2.0, 0, 100)

    this.muzzleWorld(_v1)
    this.aimDir(_v2)

    const n = st.grapePellets
    for (let i = 0; i < n; i++) {
      const spread = 0.135
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * spread
      _v3.copy(_v2)
      _q.setFromAxisAngle(_up, Math.cos(a) * r)
      _v3.applyQuaternion(_q)
      _side.crossVectors(_v2, _up).normalize()
      _q.setFromAxisAngle(_side, Math.sin(a) * r)
      _v3.applyQuaternion(_q).normalize()
      this.onFire?.({
        kind: 'grape',
        origin: _v1.clone(),
        dir: _v3.clone(),
        speed: 52 * st.projectileSpeed * (0.88 + Math.random() * 0.24),
        damage: st.damage * 0.52,
        charge: 0,
        pierce: 0,
        splash: 0,
      })
    }

    const impulse = 9.2 * st.recoil
    const horiz = Math.cos(this.aimElev)
    this.push(-_v2.x * impulse * horiz, -_v2.z * impulse * horiz)
    this.vertical += impulse * Math.sin(this.aimElev) * 0.08
    this.recoilPitchVel += impulse * 0.05

    this.muzzleLight.intensity = 22
    this.fx.muzzle(_v1, _v2, 0.55)
    this.sfx.grape()
  }
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _n = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _col = new THREE.Color()
