# Research

A short pass before building — enough to steal the right ideas and avoid the known
traps, not enough to become the project.

## 1. Picking the concept

I wanted an **original twist on a legible genre**, not a novel genre. Legible means the
player understands the fiction in one glance and needs no tutorial for the premise. So
the interesting question was: *which single rule can I change in a well-worn genre so
that every second of play is different?*

Candidates I sketched and scored on (a) instant legibility, (b) how surprising the twist
is, (c) whether 3D is essential or decorative, (d) achievable game feel, (e) visual
identity that avoids the default AI look:

| Concept | Twist | Verdict |
| --- | --- | --- |
| Ghost-echo arena shooter | each wave spawns a replay of your own previous wave as an enemy | Great twist, but movement stays vanilla and it needs a lot of recording infrastructure before it's fun once. |
| Planetoid survival (Mario Galaxy-ish gravity) | fight around a tiny sphere, enemies come over the horizon | Spectacular in 3D, but the camera is a research project on its own and the twist is a camera trick, not a rule. |
| Chain-reaction swarm | your gun is weak; kills discharge into nearby enemies, so you sculpt the swarm | Genuinely novel, but "will this chain?" is hard to read in 3D and frustrating when wrong. |
| Light/shadow duel on a rotating planet | enemies vulnerable only in moving shadow | Beautiful, but it plays like a puzzle rather than an action game. |
| **Recoil-as-propulsion** | **firing the gun is the only way you move** | **Chosen.** |

**Recoil-as-propulsion won** because it is the only candidate where the twist is *load
bearing on every single input*. It is also one sentence to explain and zero sentences to
learn — the first time you fire and slide backwards, you understand the entire game.

The known failure mode of the idea is the moment you want to retreat *and* shoot the
thing chasing you, and can't. That is the point, but it can feel bad rather than tense.
Two design answers, both in the build: a short-range grapeshot that doubles as the panic
escape (it damages what's in your face *and* launches you away from it), and the fact
that recoil only uses the horizontal component of the barrel — so lobbing long-range
arcs deliberately costs you mobility. Range and movement become one resource you spend.

### Why a boat

The mechanic is genre-agnostic — the obvious skin is a zero-g spaceship. I rejected that
deliberately. "Neon space shooter" is the single most common Three.js demo subject, and a
dark scene with glowing purple UI is exactly the default-AI aesthetic the brief warns
against. A rowboat with one swivel gun is funnier, more physical, immediately legible,
and unlocks a much stronger art direction: low sun, stylised sea, flat-shaded timber and
brass, and a UI built like an 18th-century printed broadside.

It also pays a design dividend. A boat naturally suggests **water in the hull as the
health bar** — and bailing by hand, which cannot be done while firing, gave me the second
mechanic almost for free. Once the health bar is water, the sea state becomes a combat
system rather than scenery.

## 2. Technical references

**Gerstner / trochoidal waves.** The standard formulation is GPU Gems 1, ch. 1 (Finch),
which the Three.js community has ported many times over
([three.js forum: Classic ocean shader with Gerstner waves](https://discourse.threejs.org/t/classic-ocean-shader-example-with-gestner-waves/29227),
[sbcode Gerstner water tutorial](https://sbcode.net/threejs/gerstnerwater/),
[madblade/waves-gerstner](https://github.com/madblade/waves-gerstner)).

The single most useful thing I found was the buoyancy warning: *if the boat floats on a
flat CPU plane while the GPU displaces the visual water, the boat clips through waves or
hovers in mid-air — you must run the same wave function on both sides*
([Interactive Ocean Physics: Vertex Shaders and Buoyancy](https://salivity.github.io/game-development/article/interactive-ocean-physics-vertex-shaders-and-buoyancy)).
I took that seriously and made it structural: `src/world/waves.ts` defines the field once
and exports both the JS sampler and the GLSL, from the same constants. Everything that
touches the surface — hull buoyancy, splashes, cannonball impacts, enemy bobbing, the
landing ring on the aim guide — samples the same function the vertex shader displaces by.

**Ocean shading style.** Stylised-ocean writeups
([Faraz Shaikh, "Generating a stylized ocean"](https://blog.farazshaikh.com/stories/generating-a-stylized-ocean/),
[three.js forum: low-poly ocean/water](https://discourse.threejs.org/t/low-poly-ocean-water/33513),
[gameidea: 3D ocean shader using Gerstner waves](https://gameidea.org/2023/12/01/3d-ocean-shader-using-gerstner-waves/))
converge on the same recipe: tint by wave height for depth, whitecaps from crest height ×
slope, and a warm rim where a thin crest is backlit. I used all three.

The implementation choice I made differently: instead of a bespoke `ShaderMaterial`, I
patch `MeshStandardMaterial` through `onBeforeCompile`. Displacing `transformed` inside
`begin_vertex` means every downstream chunk — projection, `worldpos_vertex`,
`shadowmap_vertex`, fog — sees the displaced position for free. So the ocean keeps real
PBR lighting, real scene fog, tone mapping, and correct **shadow receiving** from the boat
and the beasts, which a hand-rolled shader would have cost a day to reproduce.

**Small 3D web games.** Skimming the Three.js corners of itch.io and the jam entries
([itch.io: top rated games made with Three.js](https://itch.io/games/top-rated/made-with-threejs),
[itch.io: Three.js jam entries](https://itch.io/games/free/in-jam/made-with-threejs))
the pattern in the ones that felt finished rather than demo-ish was consistent, and I
copied it wholesale:

- **A smooth, boring, reliable camera.** The good entries use a damped third-person chase
  and nothing clever. I damp the *positional* follow but take aim rotation instantly, so
  looking around never feels rubbery, and I clamp the camera above the swell and out of
  the rocks so it can never clip.
- **Readability beats fidelity.** Strong silhouettes, flat shading, and contact cues.
- **Juice is the whole difference.** Screen shake, hit-stop, muzzle light, splash rings,
  score popups. Cheap to add, and it is most of what "finished" feels like.

The other lesson, from the ones that felt bad: over open water with a ballistic weapon,
players cannot judge depth or elevation at all. That's why there's a **dotted arc and a
landing ring** drawn with the exact same integrator the gun uses. It started as a debug
overlay and turned out to be the single biggest usability win in the project.

**Physics.** I deliberately did not pull in Rapier or Cannon. The brief allows hand-rolled
physics when the mechanics are simple, and these are: a point mass with drag, sphere
overlap tests, ballistic arcs, and circle-vs-circle rock bounces. Hand-rolling bought
exact, tunable control over recoil feel, and — more importantly — a projectile path the
aim guide can predict *perfectly*, which a rigid-body solver would have made approximate.
A physics engine here would have been a dependency with no payoff.

## 3. Asset sources considered

I looked at the usual CC0 libraries — [Poly Haven](https://polyhaven.com) (HDRIs and
textures, CC0), [Kenney](https://kenney.nl) (CC0 game assets),
[ambientCG](https://ambientcg.com) (CC0 materials), and [freesound](https://freesound.org)
for audio — and ended up using almost none of them, on purpose:

- **No HDRI.** The sky is a procedural shader that has to shift through four weather
  phases and flash with lightning. A fixed HDRI can't do that. Instead the sky dome is
  pre-filtered at runtime with `PMREMGenerator` into the scene environment map, so the
  water and the brass reflect whatever weather is actually overhead — better than any
  static HDRI would have been, and it costs nothing in repo size.
- **No downloaded models.** Every object is generated from code: the hull is lofted from a
  station table like a real boat plan, the sea stacks are noise-displaced icosahedra, the
  beasts are assembled from primitives. This keeps silhouettes consistent, the download
  tiny, and load time effectively zero — no loader, no missing-asset failure mode.
- **No audio files.** All sound is synthesised at runtime with WebAudio, which sidesteps
  sample licensing entirely and lets the cannon's report actually change pitch and length
  with charge level rather than playing one of three canned clips.
- **Fonts are the exception**, and the one thing genuinely worth downloading: three
  Open Font License typefaces, vendored into the repo. Type is the backbone of the visual
  identity and there is no procedural substitute for a good wood-type face.

See `ASSETS.md` for exact files, sources and licences.
