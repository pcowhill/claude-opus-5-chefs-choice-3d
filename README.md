# SALVO

### *your cannon is your only oar*

A 3D arcade sea-survival game for desktop browsers. You are alone in a small boat inside
a ring of sea stacks, with one swivel gun and ten waves of things that want you under the
water. There are no oars aboard.

**Firing the gun is the only way the boat moves.**

---

## Why this concept

The brief asked for an original twist on a legible genre. The genre here is the
wave-survival arena shooter — instantly readable, nobody needs a tutorial for *boat,
cannon, sea monsters*. The twist is that **aiming and moving are the same action**, and
it's not decoration: it is the entire moment-to-moment game.

Want to back away from a Snapper closing on your bow? You have to shoot *at* it, and the
recoil carries you clear. Want to cross the arena? Turn your back on the fight and fire
into open water. Every shot is a decision about two things at once, and the two are
usually in tension.

Three further systems interlock with it, so the twist compounds instead of being a
one-note gimmick:

1. **Damage is water, not hit points.** Every bite and every boarding sea puts water in
   your hull. You bail it out by hand — but **a bailing hand is not a firing hand**, so
   healing means you cannot move. Water also makes the boat heavier, which weakens your
   recoil and lowers your freeboard, which makes you ship *more* water. The death spiral
   is real and escapable, and you can watch it in the hull gauge.
2. **The breech overheats.** Fire too fast and the gun jams — and a jammed gun means no
   shots *and* no propulsion, which is the worst two seconds in the game. The barrel
   cools fastest when the sea washes over the deck, so **the same boarding wave that
   drowns you is the only thing that cools you.**
3. **The sea itself pushes.** The boat rides a real Gerstner wave field and slides
   downhill off the swell. As the run escalates from an evening calm to a night squall,
   the water stops being a backdrop and becomes a third party in the fight.

And one more knot, small but it changes how you aim: recoil only shoves you along the
*horizontal* component of the barrel. Lob a high arc to reach something far away and you
barely move. Fire flat and you go flying. Range and mobility are the same resource.

The chosen look is deliberately not a neon sci-fi arena: a low sun over a stylised ocean,
flat-shaded timber and brass, and an interface built like an 18th-century printed
broadside — heavy wood-type display, letterpress small caps, hairline double rules, hard
corners, no rounded cards anywhere.

## Controls

| Input | Action |
| --- | --- |
| **Mouse** | Traverse and elevate the gun (pointer is captured) |
| **Left mouse** | Hold to charge, release to fire. Longer charge = more damage, more range, more kick |
| **Right mouse** | Grapeshot — wide short-range blast and the hardest shove you have |
| **Space** *(hold)* | Bail. Empties the hull fast, but you cannot fire while bailing |
| **Shift** *(hold)* | Sea anchor — kills your drift and cools the breech, at the cost of shipping more water |
| **1 / 2 / 3** | Take a salvage card between waves |
| **Esc** or **P** | Pause |
| **M** | Mute |
| **Enter** | Confirm on menus / play again |

Everything above is also printed on the title screen and the pause screen, so no one has
to read this file to play. Contextual prompts introduce bailing, heat and the sea anchor
during the first three waves.

## The run

Ten waves, roughly 12–18 minutes. Between each you take one of three **salvage** cards
from a draft of nineteen upgrades, so builds diverge: a glass-cannon Long Nine + Rifled
Bore rig plays nothing like a Ballast Stones + Twin Bilge Pumps tank.

Enemies: **Snappers** (fast chasers), **Brine Spitters** (lobbers that lead your drift),
**Urchin Mines** (drifting hazards you can shoot to chain-detonate into the swarm),
**Bloom Jellies** (swarm), **Breachers** (dive, mark the water under you, and erupt), and
on wave ten **the Leviathan** — a segmented serpent that is only truly vulnerable at the
gills while it is surfaced.

The weather escalates with the waves through four hand-tuned phases: `EVENING CALM` →
`GATHERING CHOP` → `BLACK SQUALL` → `THE EYE`. Sea state, fog, rain, lightning, palette
and the music's key all move together.

**Win:** survive all ten waves and put the Leviathan down.
**Lose:** the hull fills.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build it

```bash
npm run build    # typechecks, then bundles to dist/
npm run preview  # serve the production build
npm run typecheck
```

Desktop browsers only, targeted at 1080p; it scales down cleanly to common laptop
heights. No backend, no accounts, no network calls at runtime.

## What was verified

Checked in a real headless Chromium (Playwright) against the production build, at 1920×1080,
1280×720 and 480×280:

- `npm install`, `npm run build` and `npm run typecheck` all clean, no TS errors.
- First screen is not blank: the boot sequence completes and the title screen renders over
  a live 3D attract-mode scene.
- WebGL context acquires; **zero shader compile/link errors** and zero page errors across
  full runs (an earlier ocean-shader failure was found this way and fixed).
- Title → gameplay via the button *and* via Enter; pointer lock engages.
- Controls confirmed by driving the real DOM events: charged and tapped main fire,
  grapeshot, bailing, sea anchor, pause, mute, `1/2/3` drafting.
- **Recoil actually propels the boat** — measured travel across the arena with no other
  input, peaking around 18 m/s.
- Full combat chain: shot → hit registration → damage → kill → score → streak multiplier.
  A scripted bot cleared wave 1 at 77% accuracy.
- Wave clear → salvage draft → upgrade applied → next wave starts, with sea state and
  palette ramping.
- Boss: spawns on wave 10, takes weak-point damage, phase transitions, no errors.
- Loss flow: hull fills → boat sinks → end screen with stats → **play again** restarts cleanly.
- Pause/resume, and pointer-lock loss auto-pauses rather than leaving a dead mouse.
- The boat is contained by the reef (a bug where it escaped through the gaps in the rock
  ring was found and fixed with an offshore set that drags you back).

## Known limitations

- **Performance was not measured on real GPU hardware.** The verification environment only
  has SwiftShader (software rasterisation), which runs this at roughly 3 fps regardless of
  content — so the frame-rate numbers from testing say nothing about a real machine. The
  scene is budgeted conservatively for 1080p60 (one ~180k-triangle ocean patch, a single
  shadow-casting light, pooled particles, instanced projectiles), and there is an automatic
  quality governor that sheds bloom and then resolution if frames run long, but the honest
  statement is that it is untested on a GPU.
- Bloom is disabled automatically on slow frames; on a capable GPU it stays on.
- Desktop only. There is no touch input and the layout assumes a landscape window; below
  about 760px of height the menus compact but the HUD is not designed for phones.
- Audio needs a user gesture to start (browser policy). It begins on the first click.
- The high score is kept in `localStorage` and is per-browser.
- Dev console helpers: `__salvo.debug()` dumps live run state, and `__salvo.jumpToWave(n)`
  jumps an in-progress run to any wave — handy for looking at the storm or the Leviathan
  without a full playthrough.

## Layout

```
src/
  main.ts              boot, font/WebGL preflight, fatal-error screen
  core/                math, seeded RNG, input (pointer lock), procedural audio
  world/               Gerstner wave field, ocean material, sky/weather/lighting, reef
  fx/                  pooled particles and expanding water rings
  game/                boat, projectiles, enemies + boss, upgrades, wave director, orchestration
  ui/                  HUD, screens, stylesheet
  assets/fonts/        three vendored OFL typefaces
```

See `RESEARCH.md` for the concept selection and references, `ASSETS.md` for asset
provenance and licensing, and `DELIVERY_NOTES.md` for the implementation summary.
