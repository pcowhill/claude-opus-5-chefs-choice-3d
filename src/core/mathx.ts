export const TAU = Math.PI * 2
export const DEG = Math.PI / 180

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a))
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x)
  return t * t * (3 - 2 * t)
}

/** Frame-rate independent exponential approach. `rate` = how much of the gap is closed per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt))
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + Math.sign(d) * maxDelta
}

/** Shortest signed angular difference from a to b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt))
}

export function randRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
