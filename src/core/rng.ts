/** Small deterministic PRNG (mulberry32). Used so a run's spawn pattern is reproducible from a seed. */
export class Rng {
  private s: number

  constructor(seed = 1) {
    this.s = seed >>> 0
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  int(loInclusive: number, hiExclusive: number): number {
    return Math.floor(this.range(loInclusive, hiExclusive))
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]
  }

  /** Fisher-Yates, returns a new array. */
  shuffled<T>(arr: readonly T[]): T[] {
    const out = arr.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }
}
