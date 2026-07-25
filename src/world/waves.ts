import * as THREE from 'three'

/**
 * Gerstner (trochoidal) wave field.
 *
 * The exact same wave definition drives BOTH the GPU vertex displacement and the
 * CPU-side buoyancy/gameplay sampling, so the boat, the enemies, the splashes and
 * the cannonball impacts all sit on the surface you can actually see.
 *
 * Formulation follows GPU Gems 1, ch.1 (Finch), with deep-water dispersion
 * (phase speed = sqrt(g / k)) so long swells travel faster than short chop.
 */

export const WAVE_COUNT = 5

export interface WaveDef {
  /** Unit direction in the XZ plane. */
  dirX: number
  dirZ: number
  /** Crest sharpness, 0..1. Total steepness across all waves must stay < 1 to avoid self-intersection. */
  steepness: number
  wavelength: number
  amplitude: number
}

export const WAVE_DEFS: readonly WaveDef[] = normalizeDefs([
  { dirX: 1.0, dirZ: 0.22, steepness: 0.30, wavelength: 62, amplitude: 1.05 },
  { dirX: 0.72, dirZ: -0.68, steepness: 0.26, wavelength: 37, amplitude: 0.62 },
  { dirX: -0.35, dirZ: 0.94, steepness: 0.22, wavelength: 21, amplitude: 0.33 },
  { dirX: 0.94, dirZ: 0.86, steepness: 0.18, wavelength: 12.5, amplitude: 0.17 },
  { dirX: -0.86, dirZ: -0.44, steepness: 0.14, wavelength: 7.0, amplitude: 0.085 },
])

function normalizeDefs(defs: WaveDef[]): WaveDef[] {
  for (const d of defs) {
    const l = Math.hypot(d.dirX, d.dirZ) || 1
    d.dirX /= l
    d.dirZ /= l
  }
  return defs
}

const G = 9.81

// Precomputed per-wave constants: k (wavenumber) and omega (angular frequency).
const K: number[] = []
const OMEGA: number[] = []
for (const d of WAVE_DEFS) {
  const k = (Math.PI * 2) / d.wavelength
  K.push(k)
  OMEGA.push(Math.sqrt(G * k))
}

/** Uniform payload shared with the ocean shader. xy = direction, z = steepness, w = wavelength. */
export const WAVE_UNIFORM_A: THREE.Vector4[] = WAVE_DEFS.map(
  (d) => new THREE.Vector4(d.dirX, d.dirZ, d.steepness, d.wavelength),
)
/** x = amplitude, y = wavenumber, z = omega. */
export const WAVE_UNIFORM_B: THREE.Vector4[] = WAVE_DEFS.map(
  (d, i) => new THREE.Vector4(d.amplitude, K[i], OMEGA[i], 0),
)

/**
 * Surface height at an (x, z) sample point.
 *
 * Note this evaluates the wave phase at the *undisplaced* horizontal position rather
 * than solving the Gerstner inverse. With the steepness values above the horizontal
 * error is well under a metre, which is imperceptible for buoyancy and keeps the
 * sampler branch-free and cheap enough to call a few hundred times per frame.
 */
export function waveHeight(x: number, z: number, time: number, swell: number): number {
  let y = 0
  for (let i = 0; i < WAVE_COUNT; i++) {
    const d = WAVE_DEFS[i]
    const phase = K[i] * (d.dirX * x + d.dirZ * z) + OMEGA[i] * time
    y += d.amplitude * swell * Math.sin(phase)
  }
  return y
}

const _tangent = new THREE.Vector3()
const _binormal = new THREE.Vector3()

/** Analytic surface normal (already normalized). */
export function waveNormal(
  x: number,
  z: number,
  time: number,
  swell: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  _tangent.set(1, 0, 0)
  _binormal.set(0, 0, 1)
  for (let i = 0; i < WAVE_COUNT; i++) {
    const d = WAVE_DEFS[i]
    const a = d.amplitude * swell
    const phase = K[i] * (d.dirX * x + d.dirZ * z) + OMEGA[i] * time
    const s = Math.sin(phase)
    const c = Math.cos(phase)
    const wa = K[i] * a
    const q = d.steepness
    _tangent.x -= q * d.dirX * d.dirX * wa * s
    _tangent.y += d.dirX * wa * c
    _tangent.z -= q * d.dirX * d.dirZ * wa * s
    _binormal.x -= q * d.dirX * d.dirZ * wa * s
    _binormal.y += d.dirZ * wa * c
    _binormal.z -= q * d.dirZ * d.dirZ * wa * s
  }
  return out.crossVectors(_binormal, _tangent).normalize()
}

/**
 * GLSL implementation of the same field. Injected into the ocean material.
 * `gerstner()` returns the displaced position and writes the normal + crest factor.
 */
export const WAVE_GLSL = /* glsl */ `
uniform vec4 uWaveA[${WAVE_COUNT}];
uniform vec4 uWaveB[${WAVE_COUNT}];
uniform float uTime;
uniform float uSwell;

vec3 gerstnerDisplace(vec3 pos, out vec3 oNormal, out float oCrest) {
  vec3 displaced = pos;
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;
  float ampSum = 0.0;

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec2 dir = uWaveA[i].xy;
    float steep = uWaveA[i].z;
    float amp = uWaveB[i].x * uSwell;
    float k = uWaveB[i].y;
    float omega = uWaveB[i].z;

    float phase = k * dot(dir, pos.xz) + omega * uTime;
    float s = sin(phase);
    float c = cos(phase);

    displaced.x += steep * amp * dir.x * c;
    displaced.z += steep * amp * dir.y * c;
    displaced.y += amp * s;

    float wa = k * amp;
    tangent.x -= steep * dir.x * dir.x * wa * s;
    tangent.y += dir.x * wa * c;
    tangent.z -= steep * dir.x * dir.y * wa * s;
    binormal.x -= steep * dir.x * dir.y * wa * s;
    binormal.y += dir.y * wa * c;
    binormal.z -= steep * dir.y * dir.y * wa * s;

    crest += amp * s;
    ampSum += amp;
  }

  oNormal = normalize(cross(binormal, tangent));
  oCrest = ampSum > 0.0001 ? crest / ampSum : 0.0;
  return displaced;
}
`
