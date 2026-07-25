import { clamp01, lerp } from './mathx'

/**
 * Fully procedural audio. Every sound in the game is synthesised at runtime with
 * WebAudio primitives (oscillators + shaped noise buffers) -- there are no audio
 * files in the repo, which keeps the download tiny and sidesteps sample licensing.
 *
 * Bus layout:  sources -> (sfx | music | ambience) -> master -> destination
 */

type Bus = 'sfx' | 'music' | 'amb'

const STORAGE_KEY = 'salvo.audio.v1'

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private buses!: Record<Bus, GainNode>
  private noiseBuf!: AudioBuffer
  private brownBuf!: AudioBuffer

  private ambSea: { gain: GainNode; filter: BiquadFilterNode } | null = null
  private ambRain: GainNode | null = null
  private ambWind: { gain: GainNode; filter: BiquadFilterNode } | null = null

  private musicTimer: number | null = null
  private nextNoteTime = 0
  private step = 0
  private musicIntensity = 0
  private musicTargetIntensity = 0
  private musicKey = 0

  volume = 0.75
  muted = false
  ready = false

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { volume?: number; muted?: boolean }
        if (typeof parsed.volume === 'number') this.volume = clamp01(parsed.volume)
        if (typeof parsed.muted === 'boolean') this.muted = parsed.muted
      }
    } catch {
      /* ignore malformed/blocked storage */
    }
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    try {
      this.ctx = new Ctor()
    } catch {
      return
    }
    const ctx = this.ctx

    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.volume
    // A gentle limiter keeps stacked explosions from clipping.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 22
    comp.ratio.value = 7
    comp.attack.value = 0.004
    comp.release.value = 0.22
    this.master.connect(comp)
    comp.connect(ctx.destination)

    this.buses = {
      sfx: ctx.createGain(),
      music: ctx.createGain(),
      amb: ctx.createGain(),
    }
    this.buses.sfx.gain.value = 1
    this.buses.music.gain.value = 0.42
    this.buses.amb.gain.value = 0.7
    for (const b of Object.values(this.buses)) b.connect(this.master)

    this.noiseBuf = makeNoise(ctx, 2, 'white')
    this.brownBuf = makeNoise(ctx, 4, 'brown')
    this.buildAmbience()
    this.ready = true
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }))
    } catch {
      /* ignore */
    }
  }

  setVolume(v: number): void {
    this.volume = clamp01(v)
    if (this.volume > 0) this.muted = false
    this.applyMaster()
    this.persist()
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    this.applyMaster()
    this.persist()
    return this.muted
  }

  setMuted(m: boolean): void {
    this.muted = m
    this.applyMaster()
    this.persist()
  }

  private applyMaster(): void {
    if (!this.ctx) return
    const target = this.muted ? 0 : this.volume
    this.master.gain.setTargetAtTime(target, this.now(), 0.02)
  }

  /** Ducks everything except UI clicks -- used while paused. */
  setSuspended(on: boolean): void {
    if (!this.ctx) return
    const t = this.now()
    this.buses.amb.gain.setTargetAtTime(on ? 0.06 : 0.7, t, 0.08)
    this.buses.music.gain.setTargetAtTime(on ? 0.14 : 0.42, t, 0.08)
  }

  // ---------------------------------------------------------------- ambience

  private buildAmbience(): void {
    const ctx = this.ctx
    if (!ctx) return

    // Sea: brown noise through a slowly wandering lowpass = swell wash.
    const seaSrc = ctx.createBufferSource()
    seaSrc.buffer = this.brownBuf
    seaSrc.loop = true
    const seaFilter = ctx.createBiquadFilter()
    seaFilter.type = 'lowpass'
    seaFilter.frequency.value = 420
    seaFilter.Q.value = 0.7
    const seaGain = ctx.createGain()
    seaGain.gain.value = 0.5
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.09
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 180
    lfo.connect(lfoGain)
    lfoGain.connect(seaFilter.frequency)
    lfo.start()
    seaSrc.connect(seaFilter)
    seaFilter.connect(seaGain)
    seaGain.connect(this.buses.amb)
    seaSrc.start()
    this.ambSea = { gain: seaGain, filter: seaFilter }

    // Wind: band-limited hiss, comes up in the storm phases.
    const windSrc = ctx.createBufferSource()
    windSrc.buffer = this.brownBuf
    windSrc.loop = true
    const windFilter = ctx.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 700
    windFilter.Q.value = 0.6
    const windGain = ctx.createGain()
    windGain.gain.value = 0
    const wlfo = ctx.createOscillator()
    wlfo.frequency.value = 0.13
    const wlfoGain = ctx.createGain()
    wlfoGain.gain.value = 320
    wlfo.connect(wlfoGain)
    wlfoGain.connect(windFilter.frequency)
    wlfo.start()
    windSrc.connect(windFilter)
    windFilter.connect(windGain)
    windGain.connect(this.buses.amb)
    windSrc.start()
    this.ambWind = { gain: windGain, filter: windFilter }

    // Rain: bright white noise, only audible under storm.
    const rainSrc = ctx.createBufferSource()
    rainSrc.buffer = this.noiseBuf
    rainSrc.loop = true
    const rainFilter = ctx.createBiquadFilter()
    rainFilter.type = 'highpass'
    rainFilter.frequency.value = 2600
    const rainGain = ctx.createGain()
    rainGain.gain.value = 0
    rainSrc.connect(rainFilter)
    rainFilter.connect(rainGain)
    rainGain.connect(this.buses.amb)
    rainSrc.start()
    this.ambRain = rainGain
  }

  /** `sea` 0..1 roughness, `rain` 0..1 storm intensity. */
  setWeather(sea: number, rain: number): void {
    if (!this.ctx) return
    const t = this.now()
    this.ambSea?.gain.gain.setTargetAtTime(lerp(0.34, 0.85, sea), t, 1.2)
    this.ambSea?.filter.frequency.setTargetAtTime(lerp(340, 900, sea), t, 1.2)
    this.ambWind?.gain.gain.setTargetAtTime(lerp(0.0, 0.34, sea * sea), t, 1.5)
    this.ambRain?.gain.setTargetAtTime(rain * 0.2, t, 1.5)
  }

  // ------------------------------------------------------------------- sfx

  private env(
    node: AudioNode,
    bus: Bus,
    peak: number,
    attack: number,
    decay: number,
    startAt?: number,
  ): GainNode {
    const ctx = this.ctx!
    const t = startAt ?? this.now()
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    node.connect(g)
    g.connect(this.buses[bus])
    return g
  }

  private noiseSource(buf: AudioBuffer, when: number, dur: number): AudioBufferSourceNode {
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.playbackRate.value = 0.8 + Math.random() * 0.4
    s.start(when, Math.random() * (buf.duration - 0.5))
    s.stop(when + dur)
    return s
  }

  /** Main gun. `charge` 0..1 deepens and lengthens the report. */
  boom(charge = 0, gain = 1): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const dur = lerp(0.42, 0.95, charge)

    // Low body: a fast pitch drop gives the "thump".
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(lerp(160, 110, charge), t)
    osc.frequency.exponentialRampToValueAtTime(lerp(38, 24, charge), t + dur * 0.7)
    const oscEnv = this.env(osc, 'sfx', 0.85 * gain, 0.006, dur)
    osc.start(t)
    osc.stop(t + dur + 0.05)
    fadeOut(oscEnv, t + dur + 0.05)

    // Crack: shaped noise through a falling lowpass.
    const n = this.noiseSource(this.noiseBuf, t, dur * 0.8)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(lerp(2600, 1700, charge), t)
    f.frequency.exponentialRampToValueAtTime(180, t + dur * 0.55)
    f.Q.value = 1.1
    n.connect(f)
    const nEnv = this.env(f, 'sfx', 0.55 * gain, 0.003, dur * 0.75)
    fadeOut(nEnv, t + dur)

    // Distant slap-back off the water.
    const tail = this.noiseSource(this.brownBuf, t + 0.13, 0.4)
    const tf = ctx.createBiquadFilter()
    tf.type = 'lowpass'
    tf.frequency.value = 420
    tail.connect(tf)
    const tEnv = this.env(tf, 'sfx', 0.16 * gain, 0.05, 0.36, t + 0.13)
    fadeOut(tEnv, t + 0.6)
  }

  /** Grapeshot: brighter, rattlier, shorter. */
  grape(gain = 1): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const n = this.noiseSource(this.noiseBuf, t, 0.36)
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.setValueAtTime(1800, t)
    f.frequency.exponentialRampToValueAtTime(420, t + 0.3)
    f.Q.value = 0.9
    n.connect(f)
    fadeOut(this.env(f, 'sfx', 0.62 * gain, 0.004, 0.32), t + 0.4)

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(210, t)
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.22)
    fadeOut(this.env(osc, 'sfx', 0.4 * gain, 0.004, 0.26), t + 0.35)
    osc.start(t)
    osc.stop(t + 0.35)
  }

  /** Water impact. `size` 0..1 scales body and length. */
  splash(size = 0.5, gain = 1): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const dur = lerp(0.18, 0.55, size)
    const n = this.noiseSource(this.noiseBuf, t, dur)
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.setValueAtTime(lerp(2200, 900, size), t)
    f.frequency.exponentialRampToValueAtTime(lerp(700, 240, size), t + dur)
    f.Q.value = 0.55
    n.connect(f)
    fadeOut(this.env(f, 'sfx', lerp(0.18, 0.5, size) * gain, 0.008, dur), t + dur + 0.1)
  }

  /** Cannonball landing on a hull / hide. */
  hit(pitch = 1, gain = 1): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(330 * pitch, t)
    osc.frequency.exponentialRampToValueAtTime(90 * pitch, t + 0.09)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 1400
    osc.connect(f)
    fadeOut(this.env(f, 'sfx', 0.3 * gain, 0.002, 0.12), t + 0.2)
    osc.start(t)
    osc.stop(t + 0.2)
  }

  /** Rising two-note sting on a kill; `tier` shifts it up for bigger beasts. */
  kill(tier = 0): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const base = [392, 330, 262][Math.min(2, tier)]
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      const at = t + i * 0.055
      osc.frequency.setValueAtTime(base * (i === 0 ? 1 : 1.5), at)
      fadeOut(this.env(osc, 'sfx', 0.2, 0.006, 0.16, at), at + 0.25)
      osc.start(at)
      osc.stop(at + 0.25)
    }
    this.splash(0.35, 0.6)
  }

  /** Overheat jam: a dry metallic clank. */
  jam(): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    for (const [freq, det] of [
      [523, 1.0],
      [770, 1.017],
      [1190, 0.993],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = freq * det
      fadeOut(this.env(osc, 'sfx', 0.09, 0.002, 0.28), t + 0.35)
      osc.start(t)
      osc.stop(t + 0.35)
    }
    const n = this.noiseSource(this.noiseBuf, t, 0.1)
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 2200
    n.connect(f)
    fadeOut(this.env(f, 'sfx', 0.16, 0.002, 0.09), t + 0.15)
  }

  /** Water coming aboard. */
  flood(amount = 1): void {
    this.splash(0.75, 0.5 + 0.5 * clamp01(amount))
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, t)
    osc.frequency.exponentialRampToValueAtTime(52, t + 0.4)
    fadeOut(this.env(osc, 'sfx', 0.28, 0.01, 0.42), t + 0.5)
    osc.start(t)
    osc.stop(t + 0.5)
  }

  /** Rhythmic bilge-pump chug while bailing. */
  bail(): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(72, t + 0.12)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 700
    osc.connect(f)
    fadeOut(this.env(f, 'sfx', 0.13, 0.008, 0.14), t + 0.22)
    osc.start(t)
    osc.stop(t + 0.22)
  }

  pickup(): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      const at = t + i * 0.045
      osc.frequency.value = [523, 659, 880][i]
      fadeOut(this.env(osc, 'sfx', 0.14, 0.005, 0.13, at), at + 0.2)
      osc.start(at)
      osc.stop(at + 0.2)
    }
  }

  /** Beast call: a low formant growl that reads as "something big is coming". */
  roar(depth = 0.5): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const dur = lerp(0.7, 1.5, depth)
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(lerp(96, 54, depth), t)
    osc.frequency.linearRampToValueAtTime(lerp(72, 38, depth), t + dur)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(900, t)
    f.frequency.exponentialRampToValueAtTime(220, t + dur)
    f.Q.value = 6
    const trem = ctx.createOscillator()
    trem.frequency.value = lerp(15, 7, depth)
    const tremGain = ctx.createGain()
    tremGain.gain.value = 240
    trem.connect(tremGain)
    tremGain.connect(f.frequency)
    trem.start(t)
    trem.stop(t + dur)
    osc.connect(f)
    fadeOut(this.env(f, 'sfx', 0.42, 0.09, dur), t + dur + 0.2)
    osc.start(t)
    osc.stop(t + dur + 0.2)
  }

  thunder(): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now() + 0.05
    const n = this.noiseSource(this.brownBuf, t, 2.2)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(1500, t)
    f.frequency.exponentialRampToValueAtTime(90, t + 1.9)
    n.connect(f)
    fadeOut(this.env(f, 'sfx', 0.5, 0.03, 2.0), t + 2.4)
  }

  /** UI feedback. */
  ui(kind: 'move' | 'confirm' | 'back' = 'move'): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.now()
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = kind === 'confirm' ? 660 : kind === 'back' ? 220 : 440
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 1800
    osc.connect(f)
    fadeOut(this.env(f, 'sfx', 0.07, 0.003, kind === 'confirm' ? 0.16 : 0.06), t + 0.25)
    osc.start(t)
    osc.stop(t + 0.25)
    if (kind === 'confirm') {
      const o2 = ctx.createOscillator()
      o2.type = 'square'
      o2.frequency.value = 990
      fadeOut(this.env(o2, 'sfx', 0.05, 0.004, 0.14, t + 0.06), t + 0.28)
      o2.start(t + 0.06)
      o2.stop(t + 0.28)
    }
  }

  // ----------------------------------------------------------------- music

  /**
   * A slow generative bed: i - VI - III - VII in D natural minor, one chord per bar,
   * with a drum pulse whose presence tracks combat intensity.
   */
  startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return
    this.nextNoteTime = this.now() + 0.1
    this.step = 0
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 90)
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer)
      this.musicTimer = null
    }
  }

  setMusicIntensity(v: number): void {
    this.musicTargetIntensity = clamp01(v)
  }

  /** 0 = calm palette, 1 = storm palette (shifts the root down a fourth). */
  setMusicKey(k: number): void {
    this.musicKey = k
  }

  private scheduleMusic(): void {
    const ctx = this.ctx
    if (!ctx) return
    const beat = 0.5 // 120 bpm
    while (this.nextNoteTime < ctx.currentTime + 0.35) {
      this.musicIntensity += (this.musicTargetIntensity - this.musicIntensity) * 0.06
      this.playStep(this.step, this.nextNoteTime)
      this.step = (this.step + 1) % 32
      this.nextNoteTime += beat
    }
  }

  private playStep(step: number, when: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const bar = Math.floor(step / 8) % 4
    const beatInBar = step % 8
    const root = this.musicKey > 0.5 ? 55.0 : 73.42 // A1 or D2
    const CHORDS: number[][] = [
      [0, 3, 7, 12],
      [8, 12, 15, 20],
      [3, 7, 10, 15],
      [10, 14, 17, 22],
    ]
    const chord = CHORDS[bar]

    // Pad: one long detuned voicing per bar.
    if (beatInBar === 0) {
      for (let i = 0; i < chord.length; i++) {
        const f = root * Math.pow(2, chord[i] / 12)
        for (const det of [0.996, 1.004]) {
          const osc = ctx.createOscillator()
          osc.type = i === 0 ? 'sawtooth' : 'triangle'
          osc.frequency.value = f * det
          const filt = ctx.createBiquadFilter()
          filt.type = 'lowpass'
          filt.frequency.setValueAtTime(320 + this.musicIntensity * 900, when)
          filt.Q.value = 1.2
          osc.connect(filt)
          const g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, when)
          g.gain.exponentialRampToValueAtTime(0.055 / chord.length + 0.02, when + 0.9)
          g.gain.exponentialRampToValueAtTime(0.0001, when + 4.0)
          filt.connect(g)
          g.connect(this.buses.music)
          osc.start(when)
          osc.stop(when + 4.1)
          fadeOut(g, when + 4.1)
        }
      }
    }

    const intensity = this.musicIntensity
    // Heartbeat kick -- always present, harder when the fight is on.
    if (beatInBar % 4 === 0 || (intensity > 0.45 && beatInBar === 6)) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(120, when)
      osc.frequency.exponentialRampToValueAtTime(42, when + 0.14)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, when)
      g.gain.exponentialRampToValueAtTime(0.2 + intensity * 0.3, when + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.3)
      osc.connect(g)
      g.connect(this.buses.music)
      osc.start(when)
      osc.stop(when + 0.35)
      fadeOut(g, when + 0.35)
    }

    // Rope-creak percussion enters with intensity.
    if (intensity > 0.3 && beatInBar % 2 === 1) {
      const n = this.noiseSource(this.noiseBuf, when, 0.08)
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 3200
      f.Q.value = 1.5
      n.connect(f)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, when)
      g.gain.exponentialRampToValueAtTime(0.035 * intensity, when + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.08)
      f.connect(g)
      g.connect(this.buses.music)
      fadeOut(g, when + 0.12)
    }

    // Sparse melodic answer high above the pad, only when things are tense.
    if (intensity > 0.55 && (step === 6 || step === 22)) {
      const f = root * 4 * Math.pow(2, chord[step === 6 ? 2 : 1] / 12)
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = f
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, when)
      g.gain.exponentialRampToValueAtTime(0.06 * intensity, when + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.9)
      osc.connect(g)
      g.connect(this.buses.music)
      osc.start(when)
      osc.stop(when + 1.0)
      fadeOut(g, when + 1.0)
    }
  }
}

/** Disconnects a node shortly after its envelope finishes so the graph doesn't grow. */
function fadeOut(node: GainNode, at: number): void {
  const ctx = node.context
  const delayMs = Math.max(0, (at - ctx.currentTime) * 1000) + 120
  setTimeout(() => {
    try {
      node.disconnect()
    } catch {
      /* already gone */
    }
  }, delayMs)
}

function makeNoise(ctx: AudioContext, seconds: number, kind: 'white' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  if (kind === 'white') {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  } else {
    let last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      last = (last + 0.02 * w) / 1.02
      data[i] = last * 3.2
    }
  }
  return buf
}
