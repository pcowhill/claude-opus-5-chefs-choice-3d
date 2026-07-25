import { clamp01, formatInt, formatTime, lerp } from '../core/mathx'

export interface HudState {
  score: number
  streak: number
  streakTime: number
  time: number
  wave: number
  totalWaves: number
  waveName: string
  enemiesLeft: number
  weather: string
  water: number
  maxWater: number
  heat: number
  jammed: boolean
  jamLeft: number
  charge: number
  charging: boolean
  bailing: boolean
  anchored: boolean
  bossHp: number
  bossMax: number
  bossActive: boolean
  /** Screen-space threats that are off-camera: angle in radians + urgency 0..1. */
  threats: { angle: number; urgency: number }[]
}

const RETICLE_R = 26
const CIRC = 2 * Math.PI * RETICLE_R

/** The in-game overlay: gauges, banner, reticle, threat arrows, score popups. */
export class Hud {
  readonly root: HTMLElement

  private elScore: HTMLElement
  private elStreak: HTMLElement
  private elClock: HTMLElement
  private elWeather: HTMLElement
  private elWaveNo: HTMLElement
  private elWaveName: HTMLElement
  private elWaveLeft: HTMLElement
  private elHullBox: HTMLElement
  private elHullPct: HTMLElement
  private elHullWater: SVGGElement
  private elHullNote: HTMLElement
  private elHeatBox: HTMLElement
  private elHeatFill: HTMLElement
  private elHeatPct: HTMLElement
  private elHeatNote: HTMLElement
  private elReticle: HTMLElement
  private elCharge: SVGCircleElement
  private elBoss: HTMLElement
  private elBossFill: HTMLElement
  private elThreats: HTMLElement
  private elCoach: HTMLElement
  private elCoachInner: HTMLElement
  private elPops: HTMLElement

  private threatEls: HTMLElement[] = []
  private pops: { el: HTMLElement; life: number; max: number; x: number; y: number; vy: number }[] = []
  private popPool: HTMLElement[] = []
  private lastText = { score: '', clock: '', wave: -1, left: -1, weather: '', hull: '', note: '', heat: '', heatNote: '' }
  private coachText = ''
  private coachTimer = 0

  constructor(parent: HTMLElement) {
    const el = document.createElement('div')
    el.id = 'hud'
    el.innerHTML = `
      <div class="corner" id="score-box">
        <div class="label">SALVAGE</div>
        <div id="score" class="num">0</div>
        <div id="streak">&nbsp;</div>
      </div>

      <div class="corner" id="clock-box">
        <div class="label">WATCH</div>
        <div id="clock" class="num">0:00</div>
        <div id="weather">EVENING CALM</div>
      </div>

      <div id="wave-box">
        <div id="wave-no">WAVE I OF X</div>
        <div id="wave-name">—</div>
        <hr class="rule" id="wave-rule" />
        <div id="wave-left"><b>0</b> IN THE WATER</div>
      </div>

      <div id="boss">
        <div id="boss-name">THE LEVIATHAN</div>
        <div id="boss-track"><div id="boss-fill"></div></div>
      </div>

      <div class="corner" id="hull-box">
        <div class="gauge-head">
          <span class="label">HULL</span>
          <span class="num" id="hull-pct">0%</span>
        </div>
        <svg id="hull-svg" viewBox="0 0 220 76" preserveAspectRatio="none">
          <defs>
            <clipPath id="hullClip">
              <path d="M14 4 L30 56 Q110 74 190 56 L206 4 Z" />
            </clipPath>
          </defs>
          <g clip-path="url(#hullClip)">
            <g id="hull-water">
              <path class="fill-crest" d="M0 0 Q28 -7 56 0 T112 0 T168 0 T224 0 L224 8 L0 8 Z" />
              <rect class="fill" x="0" y="6" width="224" height="90" />
            </g>
          </g>
          <path class="rib" d="M60 12 L66 62 M110 12 L110 68 M160 12 L154 62" />
          <path class="outline" d="M14 4 L30 56 Q110 74 190 56 L206 4" />
          <path class="outline" d="M8 4 L212 4" />
        </svg>
        <div id="hull-note">&nbsp;</div>
      </div>

      <div class="corner" id="heat-box">
        <div class="gauge-head">
          <span class="label">BREECH HEAT</span>
          <span class="num" id="heat-pct">0%</span>
        </div>
        <div id="heat-track">
          <div id="heat-fill"></div>
          <div id="heat-jam-txt">JAMMED</div>
        </div>
        <div id="heat-note">&nbsp;</div>
      </div>

      <div id="reticle">
        <svg viewBox="-40 -40 80 80">
          <circle class="charge" cx="0" cy="0" r="${RETICLE_R}"
                  transform="rotate(-90)"
                  stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" />
          <circle class="ring" cx="0" cy="0" r="${RETICLE_R}" stroke-dasharray="9 8.5" />
          <path class="tick" d="M0 -34 L0 -30 M0 34 L0 30 M-34 0 L-30 0 M34 0 L30 0" />
          <circle class="dot" cx="0" cy="0" r="1.7" />
        </svg>
      </div>

      <div id="threats"></div>
      <div id="pops"></div>

      <div id="coach"><div class="inner"></div></div>
    `
    parent.appendChild(el)
    this.root = el

    const q = <T extends HTMLElement | SVGElement>(sel: string): T => el.querySelector(sel) as T
    this.elScore = q('#score')
    this.elStreak = q('#streak')
    this.elClock = q('#clock')
    this.elWeather = q('#weather')
    this.elWaveNo = q('#wave-no')
    this.elWaveName = q('#wave-name')
    this.elWaveLeft = q('#wave-left')
    this.elHullBox = q('#hull-box')
    this.elHullPct = q('#hull-pct')
    this.elHullWater = q<SVGGElement>('#hull-water')
    this.elHullNote = q('#hull-note')
    this.elHeatBox = q('#heat-box')
    this.elHeatFill = q('#heat-fill')
    this.elHeatPct = q('#heat-pct')
    this.elHeatNote = q('#heat-note')
    this.elReticle = q('#reticle')
    this.elCharge = q<SVGCircleElement>('#reticle .charge')
    this.elBoss = q('#boss')
    this.elBossFill = q('#boss-fill')
    this.elThreats = q('#threats')
    this.elCoach = q('#coach')
    this.elCoachInner = q('#coach .inner')
    this.elPops = q('#pops')

    for (let i = 0; i < 8; i++) {
      const t = document.createElement('div')
      t.className = 'threat'
      t.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2 L21 21 L12 16.5 L3 21 Z"
        fill="rgba(224,84,50,0.92)" stroke="rgba(255,232,200,0.9)" stroke-width="1.4" stroke-linejoin="round"/></svg>`
      t.style.display = 'none'
      this.elThreats.appendChild(t)
      this.threatEls.push(t)
    }
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('on', on)
  }

  /** Shows a tutorial line. Repeat calls with the same text just refresh the timer. */
  coach(text: string, seconds = 5): void {
    if (this.coachText === text && this.coachTimer > 0) {
      this.coachTimer = Math.max(this.coachTimer, seconds)
      return
    }
    this.coachText = text
    this.coachTimer = seconds
    this.elCoachInner.innerHTML = text
    this.elCoach.classList.add('on')
  }

  clearCoach(): void {
    this.coachTimer = 0
    this.coachText = ''
    this.elCoach.classList.remove('on')
  }

  /** Floating number at a screen position. */
  pop(x: number, y: number, text: string, big = false): void {
    let el = this.popPool.pop()
    if (!el) {
      el = document.createElement('div')
      this.elPops.appendChild(el)
    }
    el.className = big ? 'pop big' : 'pop'
    el.textContent = text
    el.style.display = 'block'
    el.style.opacity = '1'
    this.pops.push({ el, life: big ? 1.5 : 1.05, max: big ? 1.5 : 1.05, x, y, vy: big ? -64 : -50 })
  }

  clearPops(): void {
    for (const p of this.pops) {
      p.el.style.display = 'none'
      this.popPool.push(p.el)
    }
    this.pops.length = 0
  }

  update(s: HudState, dt: number): void {
    // --- text (only touch the DOM when the string actually changed)
    const scoreTxt = formatInt(s.score)
    if (scoreTxt !== this.lastText.score) {
      this.elScore.textContent = scoreTxt
      this.lastText.score = scoreTxt
    }
    const clockTxt = formatTime(s.time)
    if (clockTxt !== this.lastText.clock) {
      this.elClock.textContent = clockTxt
      this.lastText.clock = clockTxt
    }
    if (s.weather !== this.lastText.weather) {
      this.elWeather.textContent = s.weather
      this.lastText.weather = s.weather
    }
    if (s.wave !== this.lastText.wave) {
      this.elWaveNo.textContent = `WAVE ${roman(s.wave)} OF ${roman(s.totalWaves)}`
      this.elWaveName.textContent = s.waveName
      this.lastText.wave = s.wave
    }
    if (s.enemiesLeft !== this.lastText.left) {
      this.elWaveLeft.innerHTML = `<b>${s.enemiesLeft}</b> ${s.enemiesLeft === 1 ? 'STILL IN THE WATER' : 'IN THE WATER'}`
      this.lastText.left = s.enemiesLeft
    }

    // --- streak
    const streakOn = s.streak > 1
    this.elStreak.classList.toggle('on', streakOn)
    if (streakOn) {
      const txt = `STREAK ×${s.streak.toFixed(1)}`
      if (this.elStreak.textContent !== txt) this.elStreak.textContent = txt
    }

    // --- hull gauge
    const flood = clamp01(s.water / s.maxWater)
    const pctTxt = `${Math.round(flood * 100)}%`
    if (pctTxt !== this.lastText.hull) {
      this.elHullPct.textContent = pctTxt
      this.lastText.hull = pctTxt
    }
    // Water surface travels from y=76 (dry) to y=2 (gunwale).
    const wy = lerp(78, 2, flood)
    const sway = Math.sin(performance.now() * 0.0022) * 1.6 * (0.3 + flood)
    this.elHullWater.setAttribute('transform', `translate(${sway.toFixed(2)} ${wy.toFixed(1)})`)
    const critical = flood > 0.7
    this.elHullBox.classList.toggle('critical', critical)
    const note = s.bailing
      ? 'BAILING —'
      : critical
        ? 'FOUNDERING! HOLD SPACE'
        : flood > 0.35
          ? 'SHIPPING WATER'
          : ''
    if (note !== this.lastText.note) {
      this.elHullNote.innerHTML = note || '&nbsp;'
      this.lastText.note = note
    }

    // --- heat gauge
    const heat = clamp01(s.heat / 100)
    this.elHeatFill.style.transform = `scaleX(${heat.toFixed(3)})`
    const heatPct = `${Math.round(heat * 100)}%`
    if (heatPct !== this.lastText.heat) {
      this.elHeatPct.textContent = heatPct
      this.lastText.heat = heatPct
    }
    this.elHeatBox.classList.toggle('hot', heat > 0.7)
    this.elHeatBox.classList.toggle('jam', s.jammed)
    const heatNote = s.jammed
      ? `FREEING IN ${s.jamLeft.toFixed(1)}s`
      : s.anchored
        ? 'SEA ANCHOR — COOLING FAST'
        : heat > 0.78
          ? 'EASE OFF THE GUN'
          : ''
    if (heatNote !== this.lastText.heatNote) {
      this.elHeatNote.innerHTML = heatNote || '&nbsp;'
      this.lastText.heatNote = heatNote
    }

    // --- reticle + charge
    this.elReticle.classList.toggle('jam', s.jammed)
    const c = s.charging ? s.charge : 0
    this.elCharge.style.strokeDashoffset = String(CIRC * (1 - c))
    const scale = 1 + (s.charging ? s.charge * 0.28 : 0)
    this.elReticle.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`

    // --- boss
    this.elBoss.classList.toggle('on', s.bossActive)
    if (s.bossActive) {
      this.elBossFill.style.transform = `scaleX(${clamp01(s.bossHp / Math.max(1, s.bossMax)).toFixed(3)})`
    }

    // --- threat arrows
    const w = window.innerWidth
    const h = window.innerHeight
    const cx = w / 2
    const cy = h / 2
    const rx = cx - 62
    const ry = cy - 62
    for (let i = 0; i < this.threatEls.length; i++) {
      const el = this.threatEls[i]
      const t = s.threats[i]
      if (!t) {
        if (el.style.display !== 'none') el.style.display = 'none'
        continue
      }
      if (el.style.display !== 'block') el.style.display = 'block'
      // Project the direction onto the screen-edge ellipse.
      const dx = Math.cos(t.angle)
      const dy = Math.sin(t.angle)
      const k = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
      const px = cx + dx * k
      const py = cy + dy * k
      const deg = (t.angle * 180) / Math.PI + 90
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${deg.toFixed(1)}deg) scale(${(0.65 + t.urgency * 0.55).toFixed(2)})`
      el.style.opacity = String(0.35 + t.urgency * 0.6)
    }

    // --- coach
    if (this.coachTimer > 0) {
      this.coachTimer -= dt
      if (this.coachTimer <= 0) this.elCoach.classList.remove('on')
    }

    // --- popups
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]
      p.life -= dt
      if (p.life <= 0) {
        p.el.style.display = 'none'
        this.popPool.push(p.el)
        this.pops.splice(i, 1)
        continue
      }
      const k = 1 - p.life / p.max
      p.y += p.vy * dt
      p.vy *= 0.94
      p.el.style.transform = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px) translate(-50%,-50%) scale(${(1 + (1 - k) * 0.16).toFixed(3)})`
      p.el.style.opacity = String(Math.min(1, (1 - k) * 2.4))
    }
  }
}

const ROMAN: [number, string][] = [
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
]

export function roman(n: number): string {
  let out = ''
  let v = Math.max(0, Math.round(n))
  for (const [val, sym] of ROMAN) {
    while (v >= val) {
      out += sym
      v -= val
    }
  }
  return out || '—'
}
