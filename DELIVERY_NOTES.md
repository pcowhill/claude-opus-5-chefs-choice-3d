# Delivery notes — SALVO

## Final concept

**SALVO — *your cannon is your only oar*.** A 3D arcade sea-survival game. You hold one
small boat inside a reef of sea stacks against ten escalating waves of sea beasts, and
**firing your gun is the only way the boat moves.**

Three systems interlock with that one rule so it compounds instead of staying a gimmick:

1. **Recoil is propulsion.** Aiming and moving are the same action, and they are usually
   in tension. Only the *horizontal* component of the barrel pushes you, so lobbing a long
   arc costs mobility — range and movement are one resource.
2. **Damage is water in the hull, not hit points.** You bail it out by hand, but bailing
   locks the gun, so healing means you cannot move. Water also adds mass (weaker recoil)
   and lowers freeboard (more water comes aboard) — a legible, escapable death spiral you
   can watch in the hull gauge and on the boat itself as it settles.
3. **The breech overheats and can jam** — no shots *and* no propulsion. It cools fastest
   when the sea washes over the deck, so the boarding wave that drowns you is also the
   only thing that cools you.

Plus the sea itself: the boat rides a real Gerstner field and slides downhill off the
swell, which escalates from an evening calm to a night squall over the run.

Genre framing is a wave-survival arena shooter — instantly legible, no tutorial needed for
"boat, cannon, sea monsters" — so all the novelty budget goes into the one rule that
changes everything. Art direction is deliberately anti-default: low sun over a stylised
sea, flat-shaded timber and brass, and an interface built like an 18th-century printed
broadside (heavy wood type, letterpress small caps, hairline double rules, hard corners).

## Implementation summary

Vite + TypeScript (strict) + Three.js `0.185`, npm, no backend, no runtime network calls.
~5,000 lines across a flat, readable module layout. No external 3D assets — everything but
the three OFL typefaces is generated in code.

**Wave field (`src/world/waves.ts`)** — a five-component Gerstner field with deep-water
dispersion, defined **once** and exported as both a JS sampler and a GLSL function from the
same constants. Buoyancy, splashes, cannonball impacts, enemy bobbing and the aim guide's
landing ring all read the surface the vertex shader actually displaces.

**Ocean (`src/world/ocean.ts`)** — `MeshStandardMaterial` patched through
`onBeforeCompile` rather than a bespoke `ShaderMaterial`. Displacing `transformed` inside
`begin_vertex` means projection, world position, **shadow-receiving** and fog all follow
for free. Fragment stage adds depth tint, backlit-crest subsurface and noise-dissolved
whitecaps. The 460×460 patch re-centres on the player each frame, snapped to the vertex
lattice so it slides under a stationary wave field instead of swimming through it.

**Sky & weather (`src/world/sky.ts`)** — four hand-tuned phase presets (`EVENING CALM` →
`GATHERING CHOP` → `BLACK SQUALL` → `THE EYE`) continuously blended by wave number, driving
sky gradient, cloud deck, sun angle/colour, fog, ambient, sea state, foam, rain, lightning
and the music's key together. The dome is pre-filtered at runtime with `PMREMGenerator`
into the scene environment map, so water and brass reflect the live weather.

**Boat (`src/game/boat.ts`)** — hull lofted from a nine-station table like a real boat
plan; tube-swept gunwale, floorboards, thwarts, swivel gun on a pintle, stern lantern.
Four-point buoyancy sampling gives real pitch and roll; a recoil spring kicks the bow.
Ride height carries the flooding state, so the boat visibly settles as it fills.

**Combat** — `Projectiles` runs substepped ballistics against the analytic surface in three
instanced meshes. `EnemyManager` pools five behaviour-distinct beasts; `Leviathan` is a
17-segment serpent following an arc-length-sampled trail with weak-point gills, three
attack patterns and two phase transitions. `Director` owns the roster schedule and the
difficulty ramp; `upgrades.ts` holds nineteen draftable cards.

**Physics is hand-rolled on purpose.** Point mass + drag, sphere overlaps, ballistic arcs,
circle-vs-circle rock bounces — simple enough that a solver would add a dependency with no
payoff, and hand-rolling gives a projectile path the on-screen aim guide can predict
*exactly*.

**Feel** — screen shake, kill hit-stop, muzzle light, pooled particles, expanding water
rings, damage/drowning vignettes, score popups, streak multiplier, contextual coach lines,
off-screen threat arrows, and a dotted ballistic arc + landing ring drawn as a
camera-facing ribbon (a 1px `THREE.Line` disappears against foam).

**Audio (`src/core/audio.ts`)** — 100% procedural WebAudio: cannon report that changes
pitch and length with charge, splashes, beast calls, thunder, weather-crossfaded ambience,
and a generative i–VI–III–VII bed whose intensity tracks combat. Volume + mute persist.

**Robustness** — WebGL preflight with a styled fatal-error screen, bundled-font preload,
pointer-lock loss auto-pauses, backgrounded-tab deltas are clamped, and a quality governor
sheds bloom then resolution if frames run long.

## Verification checklist

Run against the **production build** (`vite preview`) in real headless Chromium via
Playwright, at 1920×1080, 1280×720, 760×440 and 480×280.

| Check | Result |
| --- | --- |
| `npm install` | clean, 0 vulnerabilities |
| `npm run typecheck` (`tsc --noEmit`, strict + `noUnusedLocals`/`noUnusedParameters`) | clean |
| `npm run build` | clean |
| Boot completes; no fatal screen | pass |
| WebGL context acquires; canvas sized | pass |
| First screen is **not blank** — real 3D frame behind the title | pass |
| **Zero shader compile/link errors**; zero uncaught page errors across full runs | pass |
| Title → gameplay (button and Enter); pointer lock engages | pass |
| Mouse look drives gun traverse and elevation | pass |
| Main gun fires (tap and charged); grapeshot fires | pass |
| **Recoil actually propels the boat** — measured travel with no other input, peaks ~18 m/s | pass |
| Breech heats, jams at 100, recovers | pass |
| Bail and sea anchor behave; bailing locks the gun | pass |
| Hit → damage → kill → score → streak multiplier | pass (bot cleared wave 1 at 77% accuracy) |
| Wave clear → salvage draft (3 distinct cards) → upgrade applied → wave 2 | pass |
| Weather/sea-state ramp across phases (`BLACK SQUALL`, swell 1.75 at wave 8) | pass |
| Leviathan spawns on wave 10, takes weak-point damage, no errors | pass |
| Loss: hull fills → boat sinks → end screen with four stat tiles | pass |
| **Play again** restarts a clean run (wave 1, score 0, empty hull) | pass |
| Pause/resume via Esc; pointer-lock loss auto-pauses | pass |
| `M` toggles mute and persists to `localStorage` | pass |
| Boat is contained by the reef boundary over long runs | pass |
| Layout holds at 1080p and common laptop heights | pass |

### Bugs found by this process and fixed

1. **Ocean shader failed to compile** — `uOceanOffset` was declared as a JS uniform but
   never in GLSL, so the entire ocean material silently fell back and spammed
   `useProgram: program not valid`. Found by capturing console output, not by looking.
2. **The boat escaped the arena.** The reef is discrete stacks with gaps, and the boat
   sailed straight through to radius 160 while the beasts stayed clamped inside. Fixed with
   an offshore set that drags you back, plus a hard backstop.
3. **Boss crashed on respawn.** `Leviathan.despawn()` emptied the hit-part array, which is
   built once in the constructor — so a second spawn (or any restart after wave 10) wrote
   into an empty array and threw every frame.
4. **The boat was invisible.** It floated so low that only the gunwale cleared the opaque
   water surface, reading as a hollow ring. Fixed by raising ride height so the hull
   *settles* as it floods — which turned a bug into the clearest reading of the health bar.
5. **HUD gauges collapsed to the top-left.** A `#hud > *` rule (id specificity) beat
   `.corner { position: absolute }`.
6. **Quality governor was blind.** It averaged the *clamped* frame delta, so a machine at
   5fps looked identical to one at 24 and nothing was ever shed.
7. **Heat percentage never updated** — the element was built but never wired.
8. **The coach prompt covered the boat**, and the enemy lob solver had a sign error that
   put the gravity term the wrong way.

## Issues and limitations

- **Performance is untested on real GPU hardware.** The verification environment only
  offers SwiftShader (software rasterisation), which runs this at roughly 3–4 fps
  regardless of content — so no frame-rate figure from testing means anything about a real
  machine. The scene is budgeted conservatively for 1080p60 (one ~180k-triangle ocean
  patch, a single shadow-casting light, pooled particles, instanced projectiles) and the
  quality governor sheds bloom then resolution automatically, but this is the one claim I
  cannot make from evidence.
- That slowness also warped input timing during testing (a 300ms click can land inside one
  250ms frame). Both input paths were verified separately; at 60fps this is moot.
- Desktop only, by design. No touch input; below ~760px height the menus compact but the
  HUD is not laid out for phones.
- Audio requires a user gesture to start (browser autoplay policy); it begins on first click.
- High score is `localStorage`, per-browser.
- Bundle is ~683 kB (~181 kB gzipped), nearly all Three.js. Not tree-shaken further because
  the postprocessing chain and the standard material patching both pull broadly.
- `__salvo.debug()` and `__salvo.jumpToWave(n)` are left on `window` as console helpers —
  documented in the README, useful for reviewing the storm phases and the Leviathan without
  a full playthrough.

## Branch and commit

- Repository: `pcowhill/claude-opus-5-chefs-choice-3d`
- Branch: `claude/3d-browser-game-cnrd48`
- Commit: recorded in the final response (single commit containing the whole project).
