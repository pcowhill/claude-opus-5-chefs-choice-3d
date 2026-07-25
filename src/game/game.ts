import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import { AudioEngine } from '../core/audio'
import { Input } from '../core/input'
import { clamp, clamp01, damp, lerp } from '../core/mathx'
import { Rng } from '../core/rng'
import { Fx } from '../fx/particles'
import { Ocean } from '../world/ocean'
import { PHASES, Sky, phaseForWave } from '../world/sky'
import { Reef } from '../world/reef'
import { Boat, type Shot } from './boat'
import { Projectiles, simulateArc, type ImpactInfo } from './projectiles'
import { EnemyManager, Leviathan, type EnemyCtx, type EnemyKind } from './enemies'
import { Flotsam } from './flotsam'
import { Director, TOTAL_WAVES, WAVES } from './director'
import type { Enemy } from './enemies'
import { baseStats, draftUpgrades, type Stats, type Upgrade } from './upgrades'
import { Hud, type HudState } from '../ui/hud'
import { Screens, type RunSummary } from '../ui/screens'

const ARENA_RADIUS = 54
const ARC_SAMPLES = 44
const BEST_KEY = 'salvo.best.v1'

type State = 'title' | 'playing' | 'paused' | 'draft' | 'end'

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private bloomOn = true

  private input = new Input()
  private audio = new AudioEngine()
  private rng = new Rng(Math.floor(Math.random() * 1e9))

  private fx = new Fx()
  private ocean = new Ocean()
  private sky: Sky
  private reef = new Reef(ARENA_RADIUS)
  private enemies = new EnemyManager(this.fx)
  private leviathan = new Leviathan(this.fx)
  private flotsam = new Flotsam(this.fx)
  private projectiles: Projectiles
  private boat: Boat
  private stats: Stats = baseStats()
  private director = new Director(this.rng)

  private hud: Hud
  private screens: Screens

  // --- run state
  private state: State = 'title'
  private score = 0
  private kills = 0
  private shotsFired = 0
  private shotsHit = 0
  private streak = 1
  private bestStreak = 1
  private streakTimer = 0
  private runTime = 0
  private taken: Upgrade[] = []
  private takenIds = new Set<string>()
  private waveClearedTimer = 0
  private bossPending = 0
  private best = 0

  // --- presentation
  private camFocus = new THREE.Vector3()
  private camShake = 0
  private hitstop = 0
  private waveFloat = 1
  private damageFlash = 0
  private whiteFlash = 0
  private lastFrameTime = 0
  private rawFrameSeconds = 1 / 60
  private frameAvg = 16
  private qualityTimer = 0

  // --- aim guide
  private arcPoints: THREE.Vector3[] = []
  private arcRibbon: THREE.Mesh
  private arcPos!: THREE.BufferAttribute
  private arcCol!: THREE.BufferAttribute
  private arcLanding: THREE.Group

  private elDamage: HTMLElement
  private elDrown: HTMLElement
  private elWhite: HTMLElement

  constructor(private container: HTMLElement, canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.96

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.35, 1600)
    this.camera.position.set(0, 12, -22)

    this.sky = new Sky(this.scene)
    this.sky.attachRenderer(this.renderer)
    this.sky.onLightning = (s) => {
      this.whiteFlash = Math.max(this.whiteFlash, s * 0.5)
      this.audio.thunder()
    }

    this.projectiles = new Projectiles(this.fx)
    this.boat = new Boat(this.stats, this.fx, {
      boom: (c) => this.audio.boom(c),
      grape: () => this.audio.grape(),
      jam: () => this.audio.jam(),
      bail: () => this.audio.bail(),
      flood: (a) => this.audio.flood(a),
    })

    this.scene.add(this.ocean.mesh, this.reef.group, this.boat.group)
    this.scene.add(this.enemies.group, this.leviathan.group, this.flotsam.group)
    this.scene.add(this.projectiles.group, this.fx.group)

    // Aim guide: a ballistic arc plus a landing ring. Without it, judging elevation
    // and depth over open water is pure guesswork. It is drawn as a camera-facing
    // ribbon rather than a THREE.Line because WebGL ignores lineWidth, and a
    // one-pixel dashed line all but disappears against foam.
    for (let i = 0; i < ARC_SAMPLES; i++) this.arcPoints.push(new THREE.Vector3())
    const arcGeo = new THREE.BufferGeometry()
    this.arcPos = new THREE.BufferAttribute(new Float32Array(ARC_SAMPLES * 2 * 3), 3)
    this.arcCol = new THREE.BufferAttribute(new Float32Array(ARC_SAMPLES * 2 * 4), 4)
    this.arcPos.setUsage(THREE.DynamicDrawUsage)
    this.arcCol.setUsage(THREE.DynamicDrawUsage)
    arcGeo.setAttribute('position', this.arcPos)
    arcGeo.setAttribute('color', this.arcCol)
    const arcIdx: number[] = []
    for (let i = 0; i < ARC_SAMPLES - 1; i++) {
      const a = i * 2
      arcIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    arcGeo.setIndex(arcIdx)
    arcGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    this.arcRibbon = new THREE.Mesh(
      arcGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    )
    this.arcRibbon.frustumCulled = false
    this.arcRibbon.renderOrder = 5
    this.scene.add(this.arcRibbon)

    this.arcLanding = new THREE.Group()
    const landingMat = new THREE.MeshBasicMaterial({
      color: 0xffe6b0,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    })
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.35, 36).rotateX(-Math.PI / 2), landingMat)
    this.arcLanding.add(ring)
    // Four ticks so the ring reads as a sight, not a decal.
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.75).rotateX(-Math.PI / 2), landingMat)
      const a = (i / 4) * Math.PI * 2
      tick.position.set(Math.cos(a) * 1.75, 0, Math.sin(a) * 1.75)
      tick.rotation.y = -a
      this.arcLanding.add(tick)
    }
    this.arcLanding.frustumCulled = false
    this.arcLanding.renderOrder = 5
    this.scene.add(this.arcLanding)

    // --- UI
    this.hud = new Hud(ui)
    this.screens = new Screens(ui)
    this.elDamage = ui.querySelector('#flash-damage') as HTMLElement
    this.elDrown = ui.querySelector('#flash-drown') as HTMLElement
    this.elWhite = ui.querySelector('#flash-white') as HTMLElement

    this.wireCallbacks()
    this.setupPost()

    this.input.attach(canvas)
    this.input.onLockLost = () => {
      if (this.state === 'playing') this.pause()
    }
    // A click on the sea re-acquires the pointer after any stray lock loss.
    canvas.addEventListener('mousedown', () => {
      this.audio.init()
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock()
    })
    window.addEventListener('resize', this.onResize)
    this.onResize()

    try {
      this.best = Number(localStorage.getItem(BEST_KEY) || 0) || 0
    } catch {
      this.best = 0
    }
  }

  // ------------------------------------------------------------------- wiring

  private wireCallbacks(): void {
    this.screens.bindAudio({
      getVolume: () => this.audio.volume,
      getMuted: () => this.audio.muted,
      setVolume: (v) => this.audio.setVolume(v),
      toggleMute: () => this.audio.toggleMute(),
    })
    this.screens.onUiSound = (k) => this.audio.ui(k)
    this.screens.onStart = () => this.startRun()
    this.screens.onRestart = () => this.startRun()
    this.screens.onResume = () => this.resume()
    this.screens.onQuitToTitle = () => this.toTitle()
    this.screens.onPick = (u) => this.takeUpgrade(u)

    this.boat.onFire = (shot) => this.emitShot(shot)

    this.projectiles.surfaceAt = (x, z) => this.ocean.heightAt(x, z)
    this.projectiles.blockedAt = (x, z, y) => this.reef.blocks(x, z, y)
    this.projectiles.hitTest = (kind, pos, radius, ignore) => this.hitTest(kind, pos, radius, ignore)
    this.projectiles.hitPlayer = (pos, radius) => {
      const dy = pos.y - (this.boat.group.position.y + 0.3)
      if (dy > 2.4 || dy < -2.4) return false
      return Math.hypot(pos.x - this.boat.pos.x, pos.z - this.boat.pos.z) < radius + 1.5
    }
    this.projectiles.onImpact = (info) => this.onImpact(info)

    this.enemies.onKill = (info) => this.onKill(info.kind, info.score, info.x, info.y, info.z, info.tier)
    this.flotsam.onCollect = (x, y, z) => {
      this.audio.pickup()
      this.boat.water = Math.max(0, this.boat.water - this.boat.maxWater * 0.14)
      this.addScore(220, x, y + 1.4, z, 'SALVAGE +220')
    }

    this.fx.surfaceAt = (x, z) => this.ocean.heightAt(x, z)
  }

  private setupPost(): void {
    try {
      const composer = new EffectComposer(this.renderer)
      composer.addPass(new RenderPass(this.scene, this.camera))
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.62, 0.86)
      composer.addPass(bloom)
      composer.addPass(new OutputPass())
      this.composer = composer
      this.bloom = bloom
    } catch {
      // Bloom is a garnish; a driver that refuses it still gets the whole game.
      this.composer = null
    }
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.bloom?.setSize(w, h)
    this.fx.setPixelRatio(this.renderer.getPixelRatio())
  }

  // ------------------------------------------------------------- run lifecycle

  toTitle(): void {
    this.state = 'title'
    this.input.releaseLock()
    this.input.setEnabled(true)
    this.hud.setVisible(false)
    this.hud.clearPops()
    this.hud.clearCoach()
    this.audio.setSuspended(false)
    this.audio.setMusicIntensity(0.12)
    this.screens.showTitle(this.best)
    this.resetWorld()
  }

  private resetWorld(): void {
    this.enemies.despawnAll()
    this.leviathan.despawn()
    this.projectiles.clear()
    this.flotsam.clear()
    this.fx.clear()
    this.boat.reset()
    this.waveFloat = 1
    this.applyPhase(1)
  }

  private startRun(): void {
    this.audio.init()
    this.audio.startMusic()
    this.audio.setSuspended(false)

    Object.assign(this.stats, baseStats())
    this.resetWorld()
    this.score = 0
    this.kills = 0
    this.shotsFired = 0
    this.shotsHit = 0
    this.streak = 1
    this.bestStreak = 1
    this.streakTimer = 0
    this.runTime = 0
    this.taken = []
    this.takenIds.clear()
    this.waveClearedTimer = 0
    this.bossPending = 0
    this.damageFlash = 0

    this.screens.hide()
    this.hud.setVisible(true)
    this.state = 'playing'
    this.input.setEnabled(true)
    this.input.requestLock()
    this.startWave(1)

    this.hud.coach('Hold <kbd>LEFT MOUSE</kbd> to charge — release to fire. The kick is your engine.', 9)
  }

  private startWave(n: number): void {
    this.director.startWave(n)
    this.enemies.hpScale = this.director.hpScale
    this.enemies.speedScale = this.director.speedScale
    this.waveClearedTimer = 0
    if (this.director.isBossWave) {
      this.bossPending = 3.4
      this.sky.triggerLightning(1)
    }
    if (n === 2) this.hud.coach('<kbd>RIGHT MOUSE</kbd> — grapeshot. A wide blast and the hardest shove you have.', 8)
    if (n === 3) this.hud.coach('Hold <kbd>SHIFT</kbd> to stream the sea anchor: kills your drift, cools the breech.', 8)
    if (n === 5) this.hud.coach('Something bigger is under you. Watch for the ring on the water — and get off it.', 8)
  }

  private takeUpgrade(u: Upgrade): void {
    u.apply(this.stats)
    this.taken.push(u)
    this.takenIds.add(u.id)
    // Topping the hull up on a draft keeps the run from spiralling on one bad wave.
    this.boat.water = Math.max(0, this.boat.water - this.boat.maxWater * 0.35)
    this.screens.hide()
    this.hud.setVisible(true)
    this.state = 'playing'
    this.input.setEnabled(true)
    this.input.requestLock()
    this.audio.setSuspended(false)
    this.startWave(this.director.wave + 1)
  }

  private pause(): void {
    if (this.state !== 'playing') return
    this.state = 'paused'
    this.input.releaseLock()
    this.input.clearHeld()
    this.audio.setSuspended(true)
    this.hud.setVisible(false)
    this.screens.showPause()
  }

  private resume(): void {
    if (this.state !== 'paused') return
    this.screens.hide()
    this.hud.setVisible(true)
    this.state = 'playing'
    this.audio.setSuspended(false)
    this.input.setEnabled(true)
    this.input.requestLock()
  }

  private endRun(victory: boolean): void {
    if (this.state === 'end') return
    this.state = 'end'
    this.input.releaseLock()
    this.input.clearHeld()
    this.hud.setVisible(false)
    this.hud.clearPops()
    this.audio.setSuspended(true)
    this.audio.setMusicIntensity(victory ? 0.5 : 0.05)

    if (victory) {
      this.score += 6000
      this.score += Math.round((1 - this.boat.flood) * 2500)
    }
    const newBest = this.score > this.best
    if (newBest) {
      this.best = this.score
      try {
        localStorage.setItem(BEST_KEY, String(this.best))
      } catch {
        /* private mode; the run still counts, it just won't persist */
      }
    }

    const summary: RunSummary = {
      score: this.score,
      wave: this.director.wave,
      totalWaves: TOTAL_WAVES,
      time: this.runTime,
      kills: this.kills,
      accuracy: this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0,
      bestStreak: this.bestStreak,
      upgrades: this.taken.map((u) => u.name),
      victory,
      best: this.best,
      newBest,
    }
    this.screens.showEnd(summary)
  }

  // -------------------------------------------------------------- combat glue

  private emitShot(shot: Shot): void {
    const n = shot.kind === 'ball' ? this.stats.mainBalls : 1
    for (let i = 0; i < n; i++) {
      _v.copy(shot.dir)
      if (i > 0) {
        // Second ball of a double-shotted load sprays slightly.
        _v.x += (Math.random() - 0.5) * 0.035
        _v.y += (Math.random() - 0.5) * 0.02
        _v.z += (Math.random() - 0.5) * 0.035
        _v.normalize()
      }
      this.projectiles.spawn(shot.kind, shot.origin, _v, shot.speed, shot.damage, {
        pierce: shot.pierce,
        splash: shot.splash,
        charge: shot.charge,
      })
    }
    // Accuracy tracks round shot only. Counting grape would be meaningless -- it is a
    // shotgun, and mixing whole-pellet hits with fractional volleys reads over 100%.
    if (shot.kind === 'ball') this.shotsFired += n

    this.camShake = Math.min(1.5, this.camShake + 0.16 + shot.charge * 0.4)
  }

  private hitTest(
    kind: 'ball' | 'grape' | 'glob',
    pos: THREE.Vector3,
    radius: number,
    ignore: number[],
  ): { id: number; x: number; y: number; z: number } | null {
    void kind
    for (const e of this.enemies.active) {
      if (!e.hittable || ignore.includes(e.id)) continue
      const dx = pos.x - e.pos.x
      const dy = pos.y - e.root.position.y
      const dz = pos.z - e.pos.z
      const r = e.radius + radius
      if (dx * dx + dy * dy + dz * dz < r * r) {
        _hit.id = e.id
        _hit.x = pos.x
        _hit.y = pos.y
        _hit.z = pos.z
        _lastEnemy = e
        _lastBossPart = -1
        return _hit
      }
    }
    if (this.leviathan.alive) {
      for (let i = 0; i < this.leviathan.parts.length; i++) {
        const p = this.leviathan.parts[i]
        const dx = pos.x - p.x
        const dy = pos.y - p.y
        const dz = pos.z - p.z
        const r = p.radius + radius
        if (dx * dx + dy * dy + dz * dz < r * r) {
          _hit.id = 100000 + i
          _hit.x = pos.x
          _hit.y = pos.y
          _hit.z = pos.z
          _lastEnemy = null
          _lastBossPart = i
          return _hit
        }
      }
    }
    return null
  }

  private onImpact(info: ImpactInfo): void {
    if (info.splash > 0) {
      this.enemies.damageArea(info.x, info.z, info.splash, info.damage * 0.62)
      this.fx.rings.spawn(info.x, info.z, 0.5, info.splash * 2.1, 0.45, 0xffbc6a, 0.6)
      this.fx.impact(info.x, info.y, info.z, 0xffa54a, 1.6)
      this.audio.splash(0.7, 0.8)
    }
    if (info.missed) {
      if (info.kind === 'ball') this.breakStreak()
      return
    }

    if (info.kind === 'ball') this.shotsHit += 1
    this.streak = Math.min(5, this.streak + 0.1)
    this.bestStreak = Math.max(this.bestStreak, this.streak)
    this.streakTimer = 3

    if (_lastEnemy) {
      this.enemies.damage(_lastEnemy, info.damage, info.x, info.y, info.z)
      this.audio.hit(1 + Math.random() * 0.2)
    } else if (_lastBossPart >= 0 && this.leviathan.alive) {
      const part = this.leviathan.parts[_lastBossPart]
      const dead = this.leviathan.damage(info.damage, part.weak, info.x, info.y, info.z)
      this.audio.hit(part.weak ? 1.5 : 0.7, part.weak ? 1 : 0.6)
      if (part.weak && this.leviathan.surfaced && Math.random() < 0.25) {
        const [sx, sy, vis] = this.toScreen(info.x, info.y, info.z)
        if (vis) this.hud.pop(sx, sy, 'WEAK POINT')
      }
      if (dead) this.killBoss()
    }
    this.camShake = Math.min(1.6, this.camShake + 0.06)
  }

  private killBoss(): void {
    const p = this.leviathan.pos.clone()
    this.leviathan.despawn()
    this.audio.roar(1)
    this.audio.kill(2)
    this.sky.triggerLightning(1)
    this.hitstop = 0.4
    this.camShake = 2.4
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 12
      this.fx.splash(p.x + Math.cos(a) * r, this.ocean.heightAt(p.x, p.z), p.z + Math.sin(a) * r, 2.2)
      this.fx.debris(p.x + Math.cos(a) * r, p.y + 2, p.z + Math.sin(a) * r, 0xffc247, 20, 1.6)
    }
    this.addScore(6000, p.x, p.y + 5, p.z, 'LEVIATHAN DOWN', true)
    this.kills += 1
    for (let i = 0; i < 6; i++) this.flotsam.drop(p.x + (Math.random() - 0.5) * 14, p.z + (Math.random() - 0.5) * 14)
  }

  private onKill(kind: EnemyKind, score: number, x: number, y: number, z: number, tier: number): void {
    this.kills += 1
    this.audio.kill(tier)
    this.hitstop = Math.max(this.hitstop, tier > 0 ? 0.14 : 0.05)
    this.camShake = Math.min(1.8, this.camShake + (tier > 0 ? 0.55 : 0.12))
    this.addScore(Math.round(score * this.streak), x, y + 1.5, z, null, tier > 0)
    if (this.stats.repairOnKill > 0) {
      this.boat.water = Math.max(0, this.boat.water - this.boat.maxWater * (this.stats.repairOnKill / 100))
    }
    const dropChance = kind === 'breacher' ? 1 : 0.13
    if (Math.random() < dropChance) this.flotsam.drop(x, z)
  }

  private addScore(amount: number, x: number, y: number, z: number, text: string | null, big = false): void {
    this.score += amount
    const [sx, sy] = this.toScreen(x, y, z)
    if (sx > -200) this.hud.pop(sx, sy, text ?? `+${amount}`, big)
  }

  private breakStreak(): void {
    this.streak = Math.max(1, this.streak - 0.25)
  }

  private damagePlayer(water: number, fromX: number, fromZ: number, push: number, lift = 0): void {
    if (!this.boat.alive || this.state !== 'playing') return
    this.boat.addWater(water)
    const dx = this.boat.pos.x - fromX
    const dz = this.boat.pos.z - fromZ
    const d = Math.hypot(dx, dz) || 1
    this.boat.push((dx / d) * push, (dz / d) * push, lift)
    this.damageFlash = Math.min(1, this.damageFlash + clamp01(water / 22) * 0.85)
    this.camShake = Math.min(2.2, this.camShake + clamp01(water / 20) * 0.85)
    this.streak = Math.max(1, this.streak - 0.5)
  }

  // ------------------------------------------------------------------ the loop

  start(): void {
    this.toTitle()
    this.lastFrameTime = performance.now()
    const tick = (now: number) => {
      requestAnimationFrame(tick)
      const raw = Math.max(0, (now - this.lastFrameTime) / 1000)
      this.lastFrameTime = now
      // A backgrounded tab returns a huge delta on return; never simulate it. The
      // quality governor still needs the *unclamped* figure, or a machine running at
      // 5fps looks identical to one running at 24 and nothing ever gets shed.
      this.rawFrameSeconds = raw
      this.frame(Math.min(raw, 1 / 24))
    }
    requestAnimationFrame(tick)
  }

  private frame(dt: number): void {
    this.handleGlobalKeys()

    let sim = dt
    if (this.hitstop > 0) {
      this.hitstop -= dt
      sim = dt * 0.12
    }

    if (this.state === 'playing') {
      this.updatePlaying(sim, dt)
    } else {
      this.updateIdle(dt)
    }

    this.updateCamera(dt)
    this.updateOverlays(dt)
    this.render()
    this.adaptQuality(dt)
    this.input.endFrame()
  }

  private handleGlobalKeys(): void {
    for (const code of this.input.justPressed) {
      if (this.screens.handleKey(code)) continue
      if (code === 'KeyM') {
        const muted = this.audio.toggleMute()
        if (this.state === 'playing') this.hud.coach(muted ? 'SOUND MUTED' : 'SOUND ON', 1.6)
        continue
      }
      if ((code === 'Escape' || code === 'KeyP') && this.state === 'playing') {
        this.pause()
      }
    }
  }

  /** Title / pause / draft / end: keep the world alive but don't advance the fight. */
  private updateIdle(dt: number): void {
    this.ocean.update(dt, this.camFocus.x, this.camFocus.z)
    this.sky.update(dt, this.camFocus, this.camera)
    this.fx.update(dt)
    this.fx.setFog(this.sky.fog.color, this.sky.fog.density)
    this.reef.update(dt, this.ocean, this.fx, this.camFocus)
    this.applySkyToOcean()

    if (this.state === 'title') {
      // Attract mode: the sea keeps rolling and the boat rides it, unmanned.
      this.boat.update(dt, this.ocean, {
        lookX: 0, lookY: 0, fireMain: false, fireMainJust: false, fireMainReleased: false,
        fireGrape: false, bail: false, anchor: false,
      })
      this.audio.setWeather(0.35, 0)
    }
    this.hud.update(this.hudState(), dt)
  }

  private updatePlaying(sim: number, realDt: number): void {
    this.runTime += sim

    // ---- weather / phase ramp
    const targetWave = this.director.wave
    this.waveFloat = damp(this.waveFloat, targetWave, 0.55, sim)
    this.applyPhase(this.waveFloat)

    // ---- input -> boat
    const sens = 0.0022
    this.boat.update(sim, this.ocean, {
      lookX: this.input.dx * sens,
      lookY: this.input.dy * sens,
      fireMain: this.input.mouseLeft,
      fireMainJust: this.input.mouseLeftJust,
      fireMainReleased: this.input.mouseLeftReleased,
      fireGrape: this.input.mouseRightJust,
      bail: this.input.isDown('Space'),
      anchor: this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight'),
    })

    // Browsers drop pointer lock on Escape and refuse to re-grab it without a fresh
    // click, so make the recovery obvious rather than leaving the mouse dead.
    if (!this.input.locked) {
      this.hud.coach('Mouse released — <kbd>CLICK</kbd> to take the gun again.', 1.2)
    }

    // ---- world
    this.ocean.update(sim, this.boat.pos.x, this.boat.pos.z)
    this.sky.update(sim, this.boat.group.position, this.camera)
    this.applySkyToOcean()
    this.reef.update(sim, this.ocean, this.fx, this.boat.pos)

    this.holdInsideReef(sim)

    const bounce = this.reef.collide(this.boat.pos, this.boat.vel, 2.1)
    if (bounce > 2.5) {
      const h = this.ocean.heightAt(this.boat.pos.x, this.boat.pos.z)
      this.fx.splash(this.boat.pos.x, h, this.boat.pos.z, 0.9)
      this.audio.splash(0.6)
      this.camShake = Math.min(1.6, this.camShake + clamp01(bounce / 14) * 0.7)
      this.boat.addWater(clamp01(bounce / 16) * 7)
    }

    // ---- enemies
    const ctx: EnemyCtx = {
      ocean: this.ocean,
      fx: this.fx,
      boat: this.boat.pos,
      boatVel: this.boat.vel,
      arenaRadius: ARENA_RADIUS,
      spawnGlob: (origin, target) => this.spawnGlob(origin, target),
      damagePlayer: (w, x, z, push, lift) => this.damagePlayer(w, x, z, push, lift),
      requestSpawn: (kind, x, z) => this.enemies.spawn(kind, x, z),
      roar: (d) => {
        if (Math.random() < 0.6) this.audio.roar(d)
      },
    }
    this.enemies.update(sim, ctx)
    if (this.leviathan.alive) this.leviathan.update(sim, ctx)
    this.projectiles.update(sim, (dmg, x, z) => this.damagePlayer(dmg, x, z, 4))
    this.flotsam.update(sim, this.ocean, this.boat.pos)
    this.fx.update(sim)

    // ---- wave director
    if (this.bossPending > 0) {
      this.bossPending -= sim
      if (this.bossPending <= 0) {
        this.leviathan.spawn(1800 + this.director.hpScale * 320)
        this.audio.roar(1)
        this.sky.triggerLightning(1)
        this.camShake = 1.4
        this.hud.coach('Its gills burn when it surfaces. That is the only time it truly bleeds.', 8)
      }
    }
    this.director.update(sim, this.enemies.active.length, this.leviathan.alive || this.bossPending > 0, (kind) =>
      this.spawnAtEdge(kind),
    )

    if (this.director.state === 'cleared') {
      if (this.waveClearedTimer === 0) this.onWaveCleared()
      this.waveClearedTimer += sim
      if (this.waveClearedTimer > 2.2) {
        if (this.director.wave >= TOTAL_WAVES) this.endRun(true)
        else this.openDraft()
      }
    }

    // ---- streak decay
    this.streakTimer -= sim
    if (this.streakTimer <= 0 && this.streak > 1) {
      this.streak = Math.max(1, this.streak - sim * 0.55)
    }

    // ---- coaching
    this.coachTick()

    // ---- lose condition
    if (!this.boat.alive) {
      this.sinkAndEnd()
      return
    }

    // ---- audio mood
    const threat = clamp01(this.enemies.active.length / 12) * 0.7 + (this.leviathan.alive ? 0.5 : 0)
    this.audio.setMusicIntensity(clamp01(threat + this.boat.flood * 0.3))
    this.audio.setMusicKey(this.waveFloat > 6 ? 1 : 0)
    this.audio.setWeather(clamp01((this.ocean.swell - 0.7) / 1.2), this.sky.live.rain)

    this.updateAimGuide()
    this.hud.update(this.hudState(), realDt)
  }

  /**
   * The reef is a ring of separate stacks, so a boat can and will thread the gaps.
   * Past the reef line an offshore set drags you back — firmly enough that you cannot
   * simply outrun the fight, gently enough that it never feels like an invisible wall.
   */
  private holdInsideReef(dt: number): void {
    const r = Math.hypot(this.boat.pos.x, this.boat.pos.z)
    const soft = ARENA_RADIUS - 6
    if (r <= soft || r < 0.001) {
      this.outsideReef = 0
      return
    }
    const nx = this.boat.pos.x / r
    const nz = this.boat.pos.z / r
    const over = (r - soft) / 9
    this.boat.vel.x -= nx * over * 46 * dt
    this.boat.vel.z -= nz * over * 46 * dt

    // Absolute backstop, in case a breach or a rock bounce flings the boat clear.
    const hard = ARENA_RADIUS + 4
    if (r > hard) {
      this.boat.pos.x = nx * hard
      this.boat.pos.z = nz * hard
      const vn = this.boat.vel.x * nx + this.boat.vel.z * nz
      if (vn > 0) {
        this.boat.vel.x -= vn * nx * 1.4
        this.boat.vel.z -= vn * nz * 1.4
      }
    }

    this.outsideReef += dt
    if (this.outsideReef > 0.3) {
      this.hud.coach('Past the reef — the set is dragging you back. Turn and fight.', 1.4)
      if (Math.random() < dt * 14) {
        const a = Math.atan2(nz, nx) + (Math.random() - 0.5) * 0.5
        const px = Math.cos(a) * (soft + 2.5)
        const pz = Math.sin(a) * (soft + 2.5)
        this.fx.wake(px, this.ocean.heightAt(px, pz), pz, 1)
      }
    }
  }
  private outsideReef = 0

  private sinkAndEnd(): void {
    const p = this.boat.pos
    const h = this.ocean.heightAt(p.x, p.z)
    this.fx.splash(p.x, h, p.z, 2.4)
    this.fx.debris(p.x, h + 0.5, p.z, 0x5c3a22, 26, 1.2)
    this.fx.rings.spawn(p.x, p.z, 1, 16, 1.4, 0x9fd8d2, 0.8)
    this.audio.flood(1)
    this.audio.splash(1)
    this.camShake = 1.8
    this.endRun(false)
  }

  /** Fires once, the instant the sea goes quiet. */
  private onWaveCleared(): void {
    const bonus = 250 * this.director.wave + Math.round((1 - this.boat.flood) * 200)
    this.score += bonus
    this.hud.pop(window.innerWidth / 2, window.innerHeight * 0.42, `WAVE CLEARED  +${bonus}`, true)
    this.audio.kill(2)
    this.audio.ui('confirm')
  }

  private openDraft(): void {
    this.state = 'draft'
    this.input.releaseLock()
    this.input.clearHeld()
    this.hud.setVisible(false)
    this.audio.setSuspended(true)
    const options = draftUpgrades(this.takenIds, this.rng, 3)
    const next = WAVES[Math.min(WAVES.length - 1, this.director.wave)]
    this.screens.showDraft(options, this.director.wave, next.name)
  }

  private spawnGlob(origin: THREE.Vector3, target: THREE.Vector3): void {
    // Solve the lob: pick a flight time, then the launch velocity that lands on target.
    //   y(t) = y0 + vy*t + 0.5*g*t²   =>   vy = dy/t - 0.5*g*t
    const G = -17
    const dx = target.x - origin.x
    const dz = target.z - origin.z
    const dy = target.y - origin.y
    const dist = Math.hypot(dx, dz)
    const t = clamp(dist / 22, 0.55, 2.4)
    const vx = dx / t
    const vz = dz / t
    const vy = dy / t - 0.5 * G * t
    _v.set(vx, vy, vz)
    const speed = _v.length()
    _v.normalize()
    this.projectiles.spawn('glob', origin, _v, speed, 9, { gravity: G })
    this.audio.splash(0.3, 0.5)
  }

  private spawnAtEdge(kind: EnemyKind): void {
    // Spawn on the reef line, biased to the far side so nothing materialises in your lap.
    const boatAngle = Math.atan2(this.boat.pos.z, this.boat.pos.x)
    let a = boatAngle + (Math.random() - 0.5) * 2 * Math.PI
    for (let i = 0; i < 4; i++) {
      const test = Math.random() * Math.PI * 2
      const dx = Math.cos(test) * (ARENA_RADIUS - 6) - this.boat.pos.x
      const dz = Math.sin(test) * (ARENA_RADIUS - 6) - this.boat.pos.z
      if (Math.hypot(dx, dz) > 26) {
        a = test
        break
      }
      a = test
    }
    const r = ARENA_RADIUS - 6 - Math.random() * 5
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const surf = this.ocean.heightAt(x, z)
    this.fx.splash(x, surf, z, kind === 'breacher' ? 1.6 : 0.7)
    this.fx.rings.spawn(x, z, 0.4, kind === 'breacher' ? 8 : 4, 0.7, 0xd94f2b, 0.55)
    this.enemies.spawn(kind, x, z)
    if (kind === 'breacher') this.audio.roar(0.7)
  }

  // -------------------------------------------------------------- presentation

  private applyPhase(waveFloat: number): void {
    const { a, b, t } = phaseForWave(waveFloat, TOTAL_WAVES)
    this.sky.applyPhase(PHASES[a], PHASES[b], t)
  }

  private applySkyToOcean(): void {
    const L = this.sky.live
    this.ocean.swell = L.swell
    this.ocean.setFoamAmount(L.foam)
    this.ocean.setPalette(L.ocean)
    this.fx.setFog(this.sky.fog.color, this.sky.fog.density)
  }

  private updateAimGuide(): void {
    const show = this.state === 'playing' && !this.boat.jammed && !this.boat.bailing
    this.arcRibbon.visible = show
    this.arcLanding.visible = show
    if (!show) return

    this.boat.muzzleWorld(_muzzle)
    this.boat.aimDir(_v)
    const charge = this.boat.charging ? this.boat.charge : 0
    const speed = lerp(46, 78, charge) * this.stats.projectileSpeed
    const res = simulateArc(_muzzle, _v, speed, (x, z) => this.ocean.heightAt(x, z), this.arcPoints)
    const n = Math.max(2, res.points)

    const pos = this.arcPos.array as Float32Array
    const col = this.arcCol.array as Float32Array
    const bright = 0.55 + charge * 0.85
    for (let i = 0; i < ARC_SAMPLES; i++) {
      const idx = Math.min(i, n - 1)
      const p = this.arcPoints[idx]
      const prev = this.arcPoints[Math.max(0, idx - 1)]
      const next = this.arcPoints[Math.min(n - 1, idx + 1)]
      _dir.subVectors(next, prev)
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1)
      _dir.normalize()
      _toCam.subVectors(this.camera.position, p)
      const camDist = _toCam.length() || 1
      _toCam.divideScalar(camDist)
      _side.crossVectors(_dir, _toCam)
      if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0)
      // Constant apparent thickness regardless of range.
      _side.normalize().multiplyScalar(Math.min(1.4, 0.011 * camDist + 0.05))

      const k = i * 6
      pos[k] = p.x - _side.x
      pos[k + 1] = p.y - _side.y
      pos[k + 2] = p.z - _side.z
      pos[k + 3] = p.x + _side.x
      pos[k + 4] = p.y + _side.y
      pos[k + 5] = p.z + _side.z

      // Dashes come from the alpha channel, and the tail fades out.
      const t = i / (ARC_SAMPLES - 1)
      const dash = i % 5 < 3 ? 1 : 0
      const fade = Math.min(1, i / 3) * (i >= n ? 0 : 1) * (1 - t * 0.55)
      const a = bright * dash * fade
      const c = i * 8
      for (let e = 0; e < 2; e++) {
        col[c + e * 4] = 1.0
        col[c + e * 4 + 1] = 0.86
        col[c + e * 4 + 2] = 0.62
        col[c + e * 4 + 3] = a
      }
    }
    this.arcPos.needsUpdate = true
    this.arcCol.needsUpdate = true

    if (res.landing) {
      this.arcLanding.visible = true
      this.arcLanding.position.copy(res.landing).setY(res.landing.y + 0.14)
      this.ocean.normalAt(res.landing.x, res.landing.z, _n)
      this.arcLanding.quaternion.setFromUnitVectors(_up, _n)
      this.arcLanding.scale.setScalar(0.8 + charge * 0.7)
      const lm = (this.arcLanding.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial
      lm.opacity = 0.42 + charge * 0.55
    } else {
      this.arcLanding.visible = false
    }
  }

  private updateCamera(dt: number): void {
    if (this.state === 'title') {
      // Slow cinematic orbit for the attract screen.
      const t = performance.now() * 0.00009
      const r = 26
      this.camFocus.lerp(this.boat.group.position, 1 - Math.exp(-2 * dt))
      this.camera.position.set(
        this.camFocus.x + Math.cos(t) * r,
        this.camFocus.y + 9.5 + Math.sin(t * 1.7) * 1.6,
        this.camFocus.z + Math.sin(t) * r,
      )
      const surf = this.ocean.heightAt(this.camera.position.x, this.camera.position.z)
      this.camera.position.y = Math.max(this.camera.position.y, surf + 2.4)
      this.camera.lookAt(this.camFocus.x, this.camFocus.y + 1.2, this.camFocus.z)
      return
    }

    const b = this.boat
    // Follow the hull with a spring, but take the aim rotation instantly so
    // looking around never feels rubbery.
    this.camFocus.x = damp(this.camFocus.x, b.group.position.x, 11, dt)
    this.camFocus.y = damp(this.camFocus.y, b.group.position.y, 7, dt)
    this.camFocus.z = damp(this.camFocus.z, b.group.position.z, 11, dt)

    // Elevation nudges the framing so a lobbed shot's arc stays visible, but only
    // gently -- letting it drive the look target hard pushes the boat off the bottom.
    const el = b.aimElev
    const dist = 10.8 - el * 0.4
    const height = 4.6 + el * 0.9
    const fx = Math.sin(b.aimYaw)
    const fz = Math.cos(b.aimYaw)

    let cx = this.camFocus.x - fx * dist
    let cy = this.camFocus.y + height
    let cz = this.camFocus.z - fz * dist

    // Never let the camera go under the swell or inside a sea stack.
    const surf = this.ocean.heightAt(cx, cz)
    cy = Math.max(cy, surf + 2.0)
    for (const rock of this.reef.rocks) {
      const dx = cx - rock.x
      const dz = cz - rock.z
      const min = rock.radius + 1.6
      const d2 = dx * dx + dz * dz
      if (d2 < min * min && d2 > 1e-4) {
        const d = Math.sqrt(d2)
        cx = rock.x + (dx / d) * min
        cz = rock.z + (dz / d) * min
      }
    }

    this.camShake = Math.max(0, this.camShake - dt * 3.2)
    const s = this.camShake * this.camShake * 0.42
    cx += (Math.random() - 0.5) * s
    cy += (Math.random() - 0.5) * s
    cz += (Math.random() - 0.5) * s

    this.camera.position.set(cx, cy, cz)
    this.camera.lookAt(
      this.camFocus.x + fx * (8.5 + el * 4.0),
      this.camFocus.y + 1.25 + el * 1.7,
      this.camFocus.z + fz * (8.5 + el * 4.0),
    )
    this.camera.rotateZ((Math.random() - 0.5) * this.camShake * 0.012)
  }

  private updateOverlays(dt: number): void {
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.1)
    this.whiteFlash = Math.max(0, this.whiteFlash - dt * 3.4)
    this.elDamage.style.opacity = this.damageFlash.toFixed(3)
    this.elWhite.style.opacity = (this.whiteFlash * 0.5).toFixed(3)
    const drown = this.state === 'playing' ? Math.pow(clamp01((this.boat.flood - 0.42) / 0.58), 1.5) : 0
    this.elDrown.style.opacity = (drown * 0.92).toFixed(3)
  }

  private coachTick(): void {
    if (this.director.wave > 3) return
    if (this.boat.flood > 0.22 && !this.coached.has('bail')) {
      this.coached.add('bail')
      this.hud.coach('Water in the hull <em>is</em> your health. Hold <kbd>SPACE</kbd> to bail — but you cannot fire while you do.', 8)
    }
    if (this.boat.heat > 74 && !this.coached.has('heat')) {
      this.coached.add('heat')
      this.hud.coach('The breech is glowing. A jammed gun means no shots — and no way to move.', 7)
    }
    if (this.boat.jammed && !this.coached.has('jam')) {
      this.coached.add('jam')
      this.hud.coach('Jammed. Rough water over the deck cools the barrel fastest — at a price.', 6)
    }
  }
  private coached = new Set<string>()

  private hudState(): HudState {
    const threats: { angle: number; urgency: number }[] = []
    if (this.state === 'playing') {
      const w = window.innerWidth
      const h = window.innerHeight
      for (const e of this.enemies.active) {
        if (!e.hittable) continue
        const [sx, sy, visible] = this.toScreen(e.pos.x, e.root.position.y, e.pos.z)
        if (visible && sx > 40 && sx < w - 40 && sy > 40 && sy < h - 40) continue
        const d = Math.hypot(e.pos.x - this.boat.pos.x, e.pos.z - this.boat.pos.z)
        if (d > 60) continue
        // Direction in the camera's screen frame.
        _v.set(e.pos.x - this.boat.pos.x, 0, e.pos.z - this.boat.pos.z).normalize()
        const fwdX = Math.sin(this.boat.aimYaw)
        const fwdZ = Math.cos(this.boat.aimYaw)
        const rightX = fwdZ
        const rightZ = -fwdX
        const ang = Math.atan2(-(_v.x * fwdX + _v.z * fwdZ), _v.x * rightX + _v.z * rightZ)
        threats.push({ angle: ang, urgency: clamp01(1 - d / 55) })
      }
      threats.sort((a, b) => b.urgency - a.urgency)
      threats.length = Math.min(threats.length, 8)
    }

    return {
      score: this.score,
      streak: this.streak,
      streakTime: this.streakTimer,
      time: this.runTime,
      wave: this.director.wave,
      totalWaves: TOTAL_WAVES,
      waveName: this.director.definition.name,
      enemiesLeft: this.enemies.active.length + this.director.pending + (this.leviathan.alive ? 1 : 0),
      weather: this.sky.live.name,
      water: this.boat.water,
      maxWater: this.boat.maxWater,
      heat: this.boat.heat,
      jammed: this.boat.jammed,
      jamLeft: Math.max(0, this.boat.jamTimer),
      charge: this.boat.charge,
      charging: this.boat.charging,
      bailing: this.boat.bailing,
      anchored: this.boat.anchored,
      bossHp: this.leviathan.hp,
      bossMax: this.leviathan.maxHp,
      bossActive: this.leviathan.alive,
      threats,
    }
  }

  /** World point -> CSS pixels. Returns [-9999,-9999,false] when behind the camera. */
  private toScreen(x: number, y: number, z: number): [number, number, boolean] {
    _v2.set(x, y, z).project(this.camera)
    const behind = _v2.z > 1
    const w = window.innerWidth
    const h = window.innerHeight
    if (behind) return [-9999, -9999, false]
    return [((_v2.x + 1) / 2) * w, ((1 - _v2.y) / 2) * h, true]
  }

  private render(): void {
    if (this.composer && this.bloomOn) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  /**
   * Dev helper (exposed on `window.__salvo`): jump the current run to a given wave.
   * Handy for looking at the storm phases or the Leviathan without a full playthrough.
   */
  jumpToWave(n: number): void {
    if (this.state !== 'playing') return
    const target = clamp(Math.round(n), 1, TOTAL_WAVES)
    this.enemies.despawnAll()
    this.leviathan.despawn()
    this.projectiles.clear()
    this.waveFloat = target
    this.applyPhase(target)
    this.startWave(target)
  }

  /** Root object of the player's boat. Exposed for inspection from the console. */
  get boatGroup(): THREE.Group {
    return this.boat.group
  }

  /** Snapshot of the live simulation. Used by the smoke tests and handy in the console. */
  debug(): Record<string, unknown> {
    return {
      state: this.state,
      wave: this.director.wave,
      waveState: this.director.state,
      pending: this.director.pending,
      enemies: this.enemies.active.length,
      bossAlive: this.leviathan.alive,
      bossHp: Math.round(this.leviathan.hp),
      score: this.score,
      kills: this.kills,
      shotsFired: Math.round(this.shotsFired),
      shotsHit: this.shotsHit,
      water: Number(this.boat.water.toFixed(1)),
      maxWater: Math.round(this.boat.maxWater),
      heat: Number(this.boat.heat.toFixed(1)),
      jammed: this.boat.jammed,
      alive: this.boat.alive,
      boatSpeed: Number(this.boat.speed.toFixed(2)),
      aimElev: Number(this.boat.aimElev.toFixed(3)),
      boatPos: [Number(this.boat.pos.x.toFixed(1)), Number(this.boat.pos.z.toFixed(1))],
      camY: Number(this.camera.position.y.toFixed(2)),
      swell: Number(this.ocean.swell.toFixed(2)),
      weather: this.sky.live.name,
      pointerLocked: this.input.locked,
      bloomOn: this.bloomOn,
      frameMs: Number(this.frameAvg.toFixed(1)),
      upgrades: this.taken.map((u) => u.id),
      nearest: this.nearestThreat(),
    }
  }

  /** Range and relative bearing (degrees, +right) to the closest live beast. */
  private nearestThreat(): { range: number; bearing: number } | null {
    let best: { range: number; bearing: number } | null = null
    const consider = (x: number, z: number) => {
      const dx = x - this.boat.pos.x
      const dz = z - this.boat.pos.z
      const range = Math.hypot(dx, dz)
      if (best && range >= best.range) return
      let bearing = ((Math.atan2(dx, dz) - this.boat.aimYaw) * 180) / Math.PI
      bearing = ((bearing + 540) % 360) - 180
      best = { range: Number(range.toFixed(1)), bearing: Number(bearing.toFixed(1)) }
    }
    for (const e of this.enemies.active) if (e.hittable) consider(e.pos.x, e.pos.z)
    if (this.leviathan.alive) consider(this.leviathan.pos.x, this.leviathan.pos.z)
    return best
  }

  /** If the frame budget slips, shed bloom first, then resolution. */
  private adaptQuality(dt: number): void {
    this.frameAvg = this.frameAvg * 0.94 + Math.min(400, this.rawFrameSeconds * 1000) * 0.06
    this.qualityTimer += dt
    if (this.qualityTimer < 3) return
    this.qualityTimer = 0
    if (this.frameAvg > 26 && this.bloomOn) {
      this.bloomOn = false
    } else if (this.frameAvg > 30 && this.renderer.getPixelRatio() > 1) {
      this.renderer.setPixelRatio(1)
      this.onResize()
    }
  }
}

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _n = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _muzzle = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _toCam = new THREE.Vector3()
const _side = new THREE.Vector3()
const _hit = { id: 0, x: 0, y: 0, z: 0 }
let _lastEnemy: Enemy | null = null
let _lastBossPart = -1

export { ARENA_RADIUS }
