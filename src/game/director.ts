import type { Rng } from '../core/rng'
import type { EnemyKind } from './enemies'

export const TOTAL_WAVES = 10

export interface WaveDef {
  name: string
  /** What the wave is made of, spawned in small groups over time. */
  roster: Partial<Record<EnemyKind, number>>
  /** Seconds between spawn groups. */
  interval: number
  groupSize: number
  boss?: boolean
}

/** Hand-authored so the pacing has a shape: teach, complicate, threaten, resolve. */
export const WAVES: readonly WaveDef[] = [
  { name: 'FIRST BLOOD IN THE WATER', roster: { snapper: 7 }, interval: 3.4, groupSize: 2 },
  { name: 'DRIFTING IRON', roster: { snapper: 8, mine: 3 }, interval: 3.1, groupSize: 2 },
  { name: 'THEY SPIT BRINE', roster: { snapper: 6, spitter: 4, mine: 2 }, interval: 3.0, groupSize: 2 },
  { name: 'THE BLOOM', roster: { bloom: 12, snapper: 6, spitter: 2 }, interval: 2.7, groupSize: 3 },
  { name: 'SOMETHING LARGER', roster: { breacher: 1, snapper: 8, mine: 3 }, interval: 2.8, groupSize: 2 },
  { name: 'CROSSFIRE', roster: { spitter: 6, snapper: 10, bloom: 10 }, interval: 2.4, groupSize: 3 },
  { name: 'TWO SHADOWS', roster: { breacher: 2, snapper: 8, spitter: 4, mine: 4 }, interval: 2.4, groupSize: 3 },
  { name: 'BOILING SEA', roster: { bloom: 14, spitter: 8, snapper: 10 }, interval: 2.1, groupSize: 4 },
  { name: 'THE GATHERING', roster: { breacher: 3, snapper: 12, spitter: 6, mine: 6 }, interval: 2.0, groupSize: 4 },
  { name: 'THE LEVIATHAN', roster: { snapper: 6, spitter: 3 }, interval: 9.0, groupSize: 2, boss: true },
]

export type WaveState = 'spawning' | 'clearing' | 'cleared'

/**
 * Owns the spawn schedule and the difficulty ramp for one run.
 * A wave is cleared once its roster is exhausted *and* the sea is empty.
 */
export class Director {
  wave = 0
  private queue: EnemyKind[] = []
  private timer = 0
  private def: WaveDef = WAVES[0]
  state: WaveState = 'cleared'
  /** Seconds elapsed in the current wave, for the end-screen stats. */
  waveTime = 0

  constructor(private rng: Rng) {}

  get definition(): WaveDef {
    return this.def
  }

  get isBossWave(): boolean {
    return this.def.boss === true
  }

  get hpScale(): number {
    return 1 + (this.wave - 1) * 0.17
  }

  get speedScale(): number {
    return 1 + (this.wave - 1) * 0.048
  }

  /** Enemies still owed by the roster (excludes ones already in the water). */
  get pending(): number {
    return this.queue.length
  }

  startWave(n: number): void {
    this.wave = n
    this.def = WAVES[Math.min(WAVES.length - 1, n - 1)]
    this.waveTime = 0
    this.queue = []
    for (const [kind, count] of Object.entries(this.def.roster)) {
      for (let i = 0; i < (count as number); i++) this.queue.push(kind as EnemyKind)
    }
    // Shuffle, then float the cheap fodder to the front so waves open gently.
    this.queue = this.rng.shuffled(this.queue)
    const order: EnemyKind[] = ['bloom', 'snapper', 'mine', 'spitter', 'breacher']
    this.queue.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    // ...but not perfectly sorted, or every wave plays identically.
    for (let i = 0; i < this.queue.length - 1; i += 3) {
      if (this.rng.next() < 0.5) {
        const t = this.queue[i]
        this.queue[i] = this.queue[i + 1]
        this.queue[i + 1] = t
      }
    }
    this.timer = 1.2
    this.state = 'spawning'
  }

  update(dt: number, aliveCount: number, bossAlive: boolean, spawn: (kind: EnemyKind) => void): void {
    if (this.state === 'cleared') return
    this.waveTime += dt
    this.timer -= dt

    if (this.queue.length > 0) {
      // Hold back if the sea is already crowded -- prevents an unreadable pile-up.
      const crowd = this.isBossWave ? 8 : 16
      if (this.timer <= 0 && aliveCount < crowd) {
        this.timer = this.def.interval
        const n = Math.min(this.def.groupSize, this.queue.length)
        for (let i = 0; i < n; i++) {
          const kind = this.queue.shift()
          if (kind) spawn(kind)
        }
      }
    } else {
      this.state = 'clearing'
    }

    if (this.queue.length === 0 && aliveCount === 0 && !bossAlive) {
      this.state = 'cleared'
    }
  }
}
