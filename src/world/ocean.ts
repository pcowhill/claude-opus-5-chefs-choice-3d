import * as THREE from 'three'
import { WAVE_GLSL, WAVE_UNIFORM_A, WAVE_UNIFORM_B, waveHeight, waveNormal } from './waves'

const SIZE = 460
const SEGMENTS = 300
const QUAD = SIZE / SEGMENTS

export interface OceanPalette {
  deep: THREE.ColorRepresentation
  shallow: THREE.ColorRepresentation
  foam: THREE.ColorRepresentation
  /** Warm light bleeding through a thin, backlit wave crest. */
  sss: THREE.ColorRepresentation
}

/**
 * The ocean surface.
 *
 * Rather than a bespoke ShaderMaterial, this patches `MeshStandardMaterial` through
 * `onBeforeCompile`. That buys real PBR lighting, scene fog, tone mapping and -- most
 * importantly -- correct shadow *receiving* from the boat and the beasts, because the
 * shadow coordinates downstream of `begin_vertex` are derived from our displaced vertex.
 */
export class Ocean {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshStandardMaterial

  /** Global wave amplitude multiplier: the "sea state". */
  swell = 1

  private time = 0
  private uniforms: Record<string, THREE.IUniform> = {}

  constructor() {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS)
    geo.rotateX(-Math.PI / 2)
    geo.computeBoundingSphere()
    // The plane is re-centred on the player every frame; frustum culling would
    // otherwise use a stale bounding volume.
    geo.boundingSphere!.radius = SIZE

    // Rough enough that the sky does not mirror across the whole surface -- a true
    // mirror finish washes the sea out to sky colour and the water stops reading as water.
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.0,
    })

    this.uniforms = {
      uTime: { value: 0 },
      uSwell: { value: 1 },
      uWaveA: { value: WAVE_UNIFORM_A },
      uWaveB: { value: WAVE_UNIFORM_B },
      uOceanOffset: { value: new THREE.Vector2() },
      uDeep: { value: new THREE.Color(0x06202f) },
      uShallow: { value: new THREE.Color(0x1c6e79) },
      uFoam: { value: new THREE.Color(0xeef3f2) },
      uSss: { value: new THREE.Color(0x3aa08a) },
      uFoamAmount: { value: 1 },
    }

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec2 uOceanOffset;
${WAVE_GLSL}
varying float vCrest;
varying vec3 vWorldPos;
varying vec3 vWaveNormal;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec3 gWorld = vec3(position.x + uOceanOffset.x, 0.0, position.z + uOceanOffset.y);
vec3 gNormal;
float gCrest;
vec3 gDisplaced = gerstnerDisplace(gWorld, gNormal, gCrest);
vCrest = gCrest;
vWaveNormal = gNormal;
vWorldPos = gDisplaced;
vec3 objectNormal = gNormal;
#ifdef USE_TANGENT
vec3 objectTangent = vec3( tangent.xyz );
#endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(gDisplaced.x - uOceanOffset.x, gDisplaced.y, gDisplaced.z - uOceanOffset.y);`,
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uSss;
uniform float uFoamAmount;
uniform float uTime;
varying float vCrest;
varying vec3 vWorldPos;
varying vec3 vWaveNormal;

// Cheap value noise -- used only to break up the foam line so it isn't a clean band.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`,
        )
        .replace(
          '#include <map_fragment>',
          `// Depth tint: troughs read as deep water, shoulders as shallow.
float depthMix = smoothstep(-0.75, 0.85, vCrest);
vec3 water = mix(uDeep, uShallow, depthMix);

// Fake subsurface: thin, steep, backlit crests glow.
float steep = 1.0 - clamp(vWaveNormal.y, 0.0, 1.0);
water += uSss * smoothstep(0.18, 0.62, steep) * smoothstep(0.1, 0.9, vCrest) * 0.55;

// Whitecaps: crest height x slope, dissolved with drifting noise.
float n = vnoise(vWorldPos.xz * 0.42 + vec2(uTime * 0.28, uTime * -0.19));
float n2 = vnoise(vWorldPos.xz * 1.35 - vec2(uTime * 0.4, uTime * 0.22));
float crestMask = smoothstep(0.42, 0.95, vCrest) * smoothstep(0.10, 0.42, steep);
float foam = clamp(crestMask * (0.55 + 0.75 * n) * uFoamAmount, 0.0, 1.0);
foam = smoothstep(0.20, 0.72, foam) * (0.62 + 0.38 * n2);

diffuseColor.rgb = mix(water, uFoam, clamp(foam, 0.0, 1.0));
#include <map_fragment>`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
// Foam is matte; troughs stay glossy so the sun still lays a glint track down the swell.
float foamRough = smoothstep(0.42, 0.95, vCrest) * smoothstep(0.10, 0.42, 1.0 - clamp(vWaveNormal.y, 0.0, 1.0));
roughnessFactor = mix(roughnessFactor, 0.9, clamp(foamRough * uFoamAmount, 0.0, 1.0));
roughnessFactor = mix(roughnessFactor * 0.55, roughnessFactor, smoothstep(-0.9, 0.4, vCrest));`,
        )
    }

    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 0
    this.mesh.name = 'ocean'
  }

  setPalette(p: OceanPalette): void {
    ;(this.uniforms.uDeep.value as THREE.Color).set(p.deep)
    ;(this.uniforms.uShallow.value as THREE.Color).set(p.shallow)
    ;(this.uniforms.uFoam.value as THREE.Color).set(p.foam)
    ;(this.uniforms.uSss.value as THREE.Color).set(p.sss)
  }

  setFoamAmount(v: number): void {
    this.uniforms.uFoamAmount.value = v
  }

  update(dt: number, focusX: number, focusZ: number): void {
    this.time += dt
    this.uniforms.uTime.value = this.time
    this.uniforms.uSwell.value = this.swell

    // Snap to the vertex lattice so the mesh slides under a stationary wave field
    // instead of the vertices "swimming" through it.
    const ox = Math.round(focusX / QUAD) * QUAD
    const oz = Math.round(focusZ / QUAD) * QUAD
    this.mesh.position.set(ox, 0, oz)
    ;(this.uniforms.uOceanOffset.value as THREE.Vector2).set(ox, oz)
  }

  /** Current simulation time -- gameplay sampling must use this, not a wall clock. */
  get t(): number {
    return this.time
  }

  heightAt(x: number, z: number): number {
    return waveHeight(x, z, this.time, this.swell)
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return waveNormal(x, z, this.time, this.swell, out)
  }
}
