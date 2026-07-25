import * as THREE from 'three'
import { clamp01, lerp } from '../core/mathx'
import type { OceanPalette } from './ocean'

export interface Phase {
  name: string
  zenith: number
  horizon: number
  sunColor: number
  sunIntensity: number
  ambSky: number
  ambGround: number
  ambIntensity: number
  fogDensity: number
  /** Degrees above the horizon. */
  sunElevation: number
  sunAzimuth: number
  cloud: number
  haze: number
  rain: number
  swell: number
  foam: number
  ocean: OceanPalette
}

/** Four hand-tuned times of day, one per act of the run. */
export const PHASES: readonly Phase[] = [
  {
    name: 'EVENING CALM',
    zenith: 0x11365e,
    horizon: 0xf3a25a,
    sunColor: 0xffd8a0,
    sunIntensity: 3.1,
    ambSky: 0xa9cbe8,
    ambGround: 0x2b4a4e,
    ambIntensity: 0.85,
    fogDensity: 0.0042,
    sunElevation: 7,
    sunAzimuth: 118,
    cloud: 0.34,
    haze: 1.0,
    rain: 0,
    swell: 0.78,
    foam: 0.85,
    ocean: { deep: 0x04202e, shallow: 0x2a94a0, foam: 0xfaf1e2, sss: 0x3fc296 },
  },
  {
    name: 'GATHERING CHOP',
    zenith: 0x2c3f5c,
    horizon: 0x8e9aa6,
    sunColor: 0xcdd6dd,
    sunIntensity: 2.0,
    ambSky: 0x8d9dad,
    ambGround: 0x27383e,
    ambIntensity: 1.0,
    fogDensity: 0.0062,
    sunElevation: 15,
    sunAzimuth: 96,
    cloud: 0.72,
    haze: 0.55,
    rain: 0.15,
    swell: 1.25,
    foam: 1.15,
    ocean: { deep: 0x05192a, shallow: 0x2a7486, foam: 0xe8eeef, sss: 0x33998c },
  },
  {
    name: 'BLACK SQUALL',
    zenith: 0x060b16,
    horizon: 0x1d2c44,
    sunColor: 0x8fb2d8,
    sunIntensity: 1.45,
    ambSky: 0x35507a,
    ambGround: 0x0e1a28,
    ambIntensity: 1.1,
    fogDensity: 0.0104,
    sunElevation: 34,
    sunAzimuth: 60,
    cloud: 0.95,
    haze: 0.3,
    rain: 1.0,
    swell: 1.85,
    foam: 1.45,
    ocean: { deep: 0x030c15, shallow: 0x18475c, foam: 0xcfdbe0, sss: 0x1f6e83 },
  },
  {
    name: 'THE EYE',
    zenith: 0x0a0f1f,
    horizon: 0x3d3350,
    sunColor: 0xd8c6ff,
    sunIntensity: 2.6,
    ambSky: 0x554b80,
    ambGround: 0x151022,
    ambIntensity: 0.95,
    fogDensity: 0.0084,
    sunElevation: 52,
    sunAzimuth: 200,
    cloud: 0.86,
    haze: 0.75,
    rain: 0.55,
    swell: 1.55,
    foam: 1.35,
    ocean: { deep: 0x050814, shallow: 0x22406e, foam: 0xdad3f0, sss: 0x5a4aa0 },
  },
]

function lerpHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  _ca.setHex(a, THREE.SRGBColorSpace)
  _cb.setHex(b, THREE.SRGBColorSpace)
  return out.copy(_ca).lerp(_cb, t)
}
const _ca = new THREE.Color()
const _cb = new THREE.Color()

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uCloud;
uniform float uHaze;
uniform float uTime;
uniform float uFlash;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.62, h));
  col = mix(col, uHorizon * 0.42, smoothstep(0.0, -0.30, h));

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 1600.0) * 4.2;
  col += uSunColor * pow(sd, 46.0) * 0.42 * uHaze;
  col += uSunColor * pow(sd, 7.0) * 0.09 * uHaze;

  // Cloud deck: planar projection, thicker toward the horizon.
  if (h > -0.03) {
    vec2 cp = d.xz / max(h + 0.16, 0.06);
    float n = fbm(cp * 0.55 + vec2(uTime * 0.008, uTime * 0.013));
    float n2 = fbm(cp * 1.7 - vec2(uTime * 0.02, uTime * 0.011));
    float deck = smoothstep(0.52 - uCloud * 0.42, 0.92 - uCloud * 0.22, n * 0.72 + n2 * 0.28);
    deck *= smoothstep(-0.03, 0.16, h) * uCloud;
    // Clouds catch the sun on the side facing it.
    vec3 lit = mix(uHorizon * 0.75, uSunColor, 0.35 + 0.5 * pow(sd, 3.0) * uHaze);
    vec3 shade = mix(uZenith * 0.72, uHorizon * 0.5, 0.5);
    col = mix(col, mix(shade, lit, 0.35 + 0.45 * pow(sd, 1.5)), deck * 0.88);
  }

  col += vec3(0.55, 0.62, 0.85) * uFlash;
  gl_FragColor = vec4(col, 1.0);
}
`

/**
 * Sky dome, sun/ambient lighting, fog, rain and lightning.
 * Also generates the scene environment map by pre-filtering the live sky, so the
 * water and the brass on the gun reflect whatever weather is actually overhead.
 */
export class Sky {
  readonly dome: THREE.Mesh
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly rain: THREE.LineSegments
  readonly sunDir = new THREE.Vector3()

  /** 0..1 lightning flash, decays each frame. */
  flash = 0
  /** Set by the game; drives rain/wind/lightning frequency. */
  private rainAmount = 0
  private strikeTimer = 6

  onLightning: ((intensity: number) => void) | null = null

  private uniforms: Record<string, THREE.IUniform>
  private pmrem: THREE.PMREMGenerator | null = null
  private envScene = new THREE.Scene()
  private envTarget: THREE.WebGLRenderTarget | null = null
  private envDirty = 0
  private time = 0

  readonly live: Phase = structuredClone(PHASES[0]) as Phase
  readonly fog: THREE.FogExp2

  private rainVel: Float32Array
  private rainPos: Float32Array

  constructor(private scene: THREE.Scene) {
    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloud: { value: 0.4 },
      uHaze: { value: 1 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    }

    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = -1000
    this.dome.scale.setScalar(900)
    scene.add(this.dome)

    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.near = 1
    sc.far = 320
    sc.left = -48
    sc.right = 48
    sc.top = 48
    sc.bottom = -48
    sc.updateProjectionMatrix()
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.9
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.hemi = new THREE.HemisphereLight(0xa9cbe8, 0x2b4a4e, 0.9)
    scene.add(this.hemi)

    this.fog = new THREE.FogExp2(0xf3a25a, 0.0078)
    scene.fog = this.fog

    // ---- rain: short slanted streaks recentred on the camera each frame
    const N = 2400
    const pos = new Float32Array(N * 6)
    this.rainPos = new Float32Array(N * 3)
    this.rainVel = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      this.rainPos[i * 3 + 0] = (Math.random() - 0.5) * 130
      this.rainPos[i * 3 + 1] = Math.random() * 62
      this.rainPos[i * 3 + 2] = (Math.random() - 0.5) * 130
      this.rainVel[i] = 42 + Math.random() * 34
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200)
    this.rain = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xc8dcea,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: true,
      }),
    )
    this.rain.frustumCulled = false
    this.rain.visible = false
    scene.add(this.rain)

    this.applyPhase(PHASES[0], PHASES[0], 0)
  }

  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()
    this.envScene.add(this.dome.clone())
    this.refreshEnvironment()
  }

  /** Blend two phase presets and push the result into every consumer. */
  applyPhase(a: Phase, b: Phase, t: number): void {
    const L = this.live
    L.name = t < 0.5 ? a.name : b.name
    lerpHex(a.zenith, b.zenith, t, this.uniforms.uZenith.value as THREE.Color)
    lerpHex(a.horizon, b.horizon, t, this.uniforms.uHorizon.value as THREE.Color)
    lerpHex(a.sunColor, b.sunColor, t, this.uniforms.uSunColor.value as THREE.Color)
    this.uniforms.uCloud.value = lerp(a.cloud, b.cloud, t)
    this.uniforms.uHaze.value = lerp(a.haze, b.haze, t)

    L.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t)
    L.ambIntensity = lerp(a.ambIntensity, b.ambIntensity, t)
    L.fogDensity = lerp(a.fogDensity, b.fogDensity, t)
    L.sunElevation = lerp(a.sunElevation, b.sunElevation, t)
    L.sunAzimuth = lerp(a.sunAzimuth, b.sunAzimuth, t)
    L.rain = lerp(a.rain, b.rain, t)
    L.swell = lerp(a.swell, b.swell, t)
    L.foam = lerp(a.foam, b.foam, t)
    L.cloud = lerp(a.cloud, b.cloud, t)

    this.sun.color.copy(this.uniforms.uSunColor.value as THREE.Color)
    this.sun.intensity = L.sunIntensity
    lerpHex(a.ambSky, b.ambSky, t, this.hemi.color)
    lerpHex(a.ambGround, b.ambGround, t, this.hemi.groundColor)
    this.hemi.intensity = L.ambIntensity

    this.fog.density = L.fogDensity

    const el = L.sunElevation * (Math.PI / 180)
    const az = L.sunAzimuth * (Math.PI / 180)
    this.sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
    ;(this.uniforms.uSunDir.value as THREE.Vector3).copy(this.sunDir)

    this.rainAmount = L.rain
    this.envDirty = Math.max(this.envDirty, 0.001)

    // Blended ocean palette.
    lerpHex(a.ocean.deep as number, b.ocean.deep as number, t, _oceanDeep)
    lerpHex(a.ocean.shallow as number, b.ocean.shallow as number, t, _oceanShallow)
    lerpHex(a.ocean.foam as number, b.ocean.foam as number, t, _oceanFoam)
    lerpHex(a.ocean.sss as number, b.ocean.sss as number, t, _oceanSss)
    L.ocean = { deep: _oceanDeep.clone(), shallow: _oceanShallow.clone(), foam: _oceanFoam.clone(), sss: _oceanSss.clone() }

    // Fog is horizon light pulled toward the sea colour. Pure horizon colour turns the
    // whole middle distance into flat sky and the water stops reading as water.
    this.fog.color.copy(this.uniforms.uHorizon.value as THREE.Color).lerp(_oceanShallow, 0.46)
  }

  triggerLightning(strength = 1): void {
    this.flash = Math.max(this.flash, strength)
    this.onLightning?.(strength)
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera): void {
    this.time += dt
    this.uniforms.uTime.value = this.time

    this.dome.position.copy(camera.position)

    // Sun follows the player so the shadow frustum stays tight around the action.
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 150)
    this.sun.target.position.copy(focus)
    this.sun.target.updateMatrixWorld()

    this.flash = Math.max(0, this.flash - dt * 4.2)
    const f = this.flash * this.flash
    this.uniforms.uFlash.value = f * 0.85
    this.sun.intensity = this.live.sunIntensity + f * 5.5
    this.hemi.intensity = this.live.ambIntensity + f * 1.6

    // Lightning cadence scales with storminess.
    if (this.rainAmount > 0.25) {
      this.strikeTimer -= dt * (0.35 + this.rainAmount)
      if (this.strikeTimer <= 0) {
        this.strikeTimer = 3.5 + Math.random() * 9 * (1.2 - this.rainAmount)
        this.triggerLightning(0.6 + Math.random() * 0.55)
      }
    }

    this.updateRain(dt, camera)

    if (this.envDirty > 0) {
      this.envDirty += dt
      if (this.envDirty > 0.6) {
        this.envDirty = 0
        this.refreshEnvironment()
      }
    }
  }

  private updateRain(dt: number, camera: THREE.Camera): void {
    const mat = this.rain.material as THREE.LineBasicMaterial
    const target = this.rainAmount
    mat.opacity += (target * 0.42 - mat.opacity) * Math.min(1, dt * 2)
    this.rain.visible = mat.opacity > 0.01
    if (!this.rain.visible) return

    const cx = camera.position.x
    const cz = camera.position.z
    const attr = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const N = this.rainVel.length
    const slant = 0.24 + this.rainAmount * 0.2
    for (let i = 0; i < N; i++) {
      const p = i * 3
      this.rainPos[p + 1] -= this.rainVel[i] * dt * (0.5 + this.rainAmount)
      this.rainPos[p + 0] += this.rainVel[i] * dt * slant
      if (this.rainPos[p + 1] < -4) {
        this.rainPos[p + 1] = 58 + Math.random() * 8
        this.rainPos[p + 0] = (Math.random() - 0.5) * 130
        this.rainPos[p + 2] = (Math.random() - 0.5) * 130
      }
      // Wrap horizontally around the camera.
      let wx = this.rainPos[p + 0]
      if (wx > 65) wx = this.rainPos[p + 0] = wx - 130
      const x = cx + wx
      const y = this.rainPos[p + 1]
      const z = cz + this.rainPos[p + 2]
      const len = 1.6 + this.rainVel[i] * 0.03
      const q = i * 6
      arr[q + 0] = x
      arr[q + 1] = y
      arr[q + 2] = z
      arr[q + 3] = x - slant * len
      arr[q + 4] = y + len
      arr[q + 5] = z
    }
    attr.needsUpdate = true
  }

  private refreshEnvironment(): void {
    if (!this.pmrem) return
    const domeClone = this.envScene.children[0] as THREE.Mesh
    domeClone.material = this.dome.material
    domeClone.position.set(0, 0, 0)
    try {
      const next = this.pmrem.fromScene(this.envScene, 0.04, 1, 2000)
      this.envTarget?.dispose()
      this.envTarget = next
      this.scene.environment = next.texture
      this.scene.environmentIntensity = 0.38
    } catch {
      // Environment lighting is a nicety; never let it take the frame down.
    }
  }

  dispose(): void {
    this.envTarget?.dispose()
    this.pmrem?.dispose()
  }
}

const _oceanDeep = new THREE.Color()
const _oceanShallow = new THREE.Color()
const _oceanFoam = new THREE.Color()
const _oceanSss = new THREE.Color()

/** Phase index (0..3) and blend for a given wave number. */
export function phaseForWave(wave: number, totalWaves: number): { a: number; b: number; t: number } {
  const stops = [1, 4, 7, totalWaves]
  if (wave >= totalWaves) return { a: 3, b: 3, t: 0 }
  for (let i = 0; i < stops.length - 1; i++) {
    if (wave >= stops[i] && wave < stops[i + 1]) {
      const t = clamp01((wave - stops[i]) / Math.max(1, stops[i + 1] - stops[i]))
      return { a: i, b: i + 1, t }
    }
  }
  return { a: 0, b: 0, t: 0 }
}
