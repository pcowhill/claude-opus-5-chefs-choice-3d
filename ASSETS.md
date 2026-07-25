# Assets

Everything the game needs is in this repository. There are **no runtime requests to any
external host** — no CDN fonts, no hotlinked textures, no streamed audio. The build output
is self-contained.

## Downloaded assets

Three typefaces, all under the **SIL Open Font License 1.1**, which permits use,
modification, and redistribution (including bundled with software) provided the fonts
themselves are not sold on their own. Only the `latin` subsets were taken, straight from
the Google Fonts CDN, and they are committed to the repo.

| File | Family | Source | Licence | Creator | Used for |
| --- | --- | --- | --- | --- | --- |
| `src/assets/fonts/AlfaSlabOne-Regular-latin.woff2` | Alfa Slab One | https://fonts.google.com/specimen/Alfa+Slab+One | OFL 1.1 | JM Sole / Sorkin Type | The `SALVO` wordmark, screen titles, wave names, upgrade card names, buttons — the heavy wood-type voice of the game. |
| `src/assets/fonts/IMFellEnglishSC-Regular-latin.woff2` | IM Fell English SC | https://fonts.google.com/specimen/IM+Fell+English+SC | OFL 1.1 | Igino Marini (digitisation of a 17th-century Fell type) | All body copy, HUD labels, control lists, coach prompts. Its genuine letterpress irregularity is what makes the interface read as a printed broadside rather than a web page. |
| `src/assets/fonts/IBMPlexMono-Medium-latin.woff2`<br>`src/assets/fonts/IBMPlexMono-SemiBold-latin.woff2` | IBM Plex Mono 500 / 600 | https://fonts.google.com/specimen/IBM+Plex+Mono | OFL 1.1 | Mike Abbink, Bold Monday / IBM | Every number: score, clock, gauge percentages, end-screen stats. A machined mono against the old serif reads as brass instrumentation bolted to a wooden boat. |

Licence text: https://openfontlicense.org — attribution is not required by the OFL for
software use, but is given here anyway.

Nothing else is downloaded. No models, textures, HDRIs, sprites, icons or audio files.

## Procedural / code-generated assets

Everything else is generated at runtime from code. There is no asset loader and therefore
no loading-failure path for 3D assets — the boot screen only waits on fonts and shader
compilation.

**Geometry** (`src/game/boat.ts`, `src/game/enemies.ts`, `src/world/reef.ts`,
`src/game/flotsam.ts`)
- **The boat** is lofted from a table of station lines the way a real boat plan works —
  nine cross-sections from transom to stem, each a rounded-V, skinned into a hull. The
  gunwale rail is a tube swept along the sheer curve; floorboards, thwarts, keel, swivel
  gun, and stern lantern are built from primitives.
- **The five beast types and the Leviathan** are assembled from icosahedra, cones and
  spheres, all flat-shaded for hard silhouettes. The Leviathan's seventeen segments follow
  the head along an arc-length-sampled trail.
- **Sea stacks** are subdivided icosahedra displaced by a smooth function of each vertex's
  own unit direction (so they never split along a seam), tapered into weathered stack
  profiles, with vertex colours darkening to a wet band at the waterline.

**Shaders** (`src/world/waves.ts`, `src/world/ocean.ts`, `src/world/sky.ts`,
`src/fx/particles.ts`)
- The **Gerstner wave field** is defined once and emitted as both a JavaScript sampler and
  a GLSL function, so physics and pixels cannot disagree.
- The **ocean** is `MeshStandardMaterial` patched via `onBeforeCompile`: depth tint,
  backlit-crest subsurface, and noise-dissolved whitecaps, keeping real lighting, fog and
  shadow-receiving.
- The **sky** is a gradient dome with a sun disc, a value-noise cloud deck, and a lightning
  flash term. It is pre-filtered with `PMREMGenerator` at runtime into the scene
  environment map, so reflections track the live weather.
- **Particles** are two pooled point-sprite systems (alpha and additive) with hand-written
  vertex/fragment shaders including manual fog.

**Icons** (`src/game/upgrades.ts`) — the eight engraved marks on the salvage cards are
hand-written inline SVG paths. The favicon in `index.html` is an inline SVG data URI.

**Audio** (`src/core/audio.ts`) — 100% synthesised with WebAudio primitives at runtime;
there are no audio files anywhere in the project.
- *Cannon*: a sine body pitch-dropping under a noise crack through a falling lowpass, plus
  a delayed slap-back off the water. Length and pitch scale with charge.
- *Grapeshot*: brighter bandpass noise sweep with a triangle thump.
- *Splashes*: bandpass noise bursts whose body and length scale with impact power.
- *Beast calls*: a tremolo-modulated formant growl.
- *Thunder*: brown noise under a long exponential lowpass sweep.
- *Ambience*: looping brown-noise sea wash on a wandering lowpass, band-limited wind, and
  highpassed rain, all crossfaded by weather phase.
- *Music*: a generative bed — i–VI–III–VII in D natural minor (dropping to A minor for the
  storm), one detuned pad voicing per bar, with a kick, rope-creak percussion and a sparse
  high answer that fade in with combat intensity.

Noise buffers are generated once at startup (white via `Math.random`, brown via a
one-pole integrator).

## Content

All creatures, names, typography and copy are original to this project. No copyrighted
characters, trademarks, fan art, or third-party IP. No gambling mechanics, sexual content,
or gore — beasts burst into stylised luminous brine and driftwood.
