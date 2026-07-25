import './ui/styles.css'
import { Game } from './game/game'

const bootEl = document.getElementById('boot')!
const bootBar = document.getElementById('boot-bar')!
const bootMsg = document.getElementById('boot-msg')!

function progress(p: number, msg: string): void {
  bootBar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`
  bootMsg.textContent = msg
}

function fatal(message: string, detail?: unknown): void {
  const el = document.getElementById('fatal')!
  const msg = document.getElementById('fatal-msg')!
  const det = document.getElementById('fatal-detail')!
  msg.textContent = message
  const text = detail instanceof Error ? `${detail.name}: ${detail.message}\n${detail.stack ?? ''}` : String(detail ?? '')
  det.textContent = text.slice(0, 1200)
  det.style.display = text ? 'block' : 'none'
  el.classList.add('on')
  bootEl.classList.add('hide')
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

async function boot(): Promise<void> {
  progress(0.12, 'MAKING READY')

  if (!hasWebGL()) {
    fatal(
      'This browser cannot open a WebGL context, so the sea has nowhere to be drawn. Try a desktop Chrome, Edge, Firefox or Safari window with hardware acceleration enabled.',
    )
    return
  }

  // Fonts are bundled locally; wait for them so the first frame of UI is not a reflow.
  progress(0.3, 'SETTING THE TYPE')
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, 2500)),
    ])
  } catch {
    /* font loading is best-effort */
  }

  progress(0.55, 'RAISING THE SEA')
  const container = document.getElementById('app') as HTMLElement
  const canvas = document.getElementById('gl') as HTMLCanvasElement
  const ui = document.getElementById('ui') as HTMLElement

  let game: Game
  try {
    game = new Game(container, canvas, ui)
  } catch (err) {
    fatal('The renderer failed to start.', err)
    return
  }

  progress(0.9, 'LOADING THE GUN')
  // One frame of breathing room so shaders compile before the title fades in.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  try {
    game.start()
  } catch (err) {
    fatal('The game loop failed to start.', err)
    return
  }

  // Console handle: `__salvo.debug()` dumps live run state. Also drives the smoke tests.
  ;(window as unknown as { __salvo: unknown }).__salvo = {
    debug: () => game.debug(),
    jumpToWave: (n: number) => game.jumpToWave(n),
    boatGroup: () => game.boatGroup,
  }

  progress(1, 'READY')
  setTimeout(() => bootEl.classList.add('hide'), 260)
}

window.addEventListener('error', (e) => {
  if (!document.getElementById('fatal')!.classList.contains('on') && !bootEl.classList.contains('hide')) {
    fatal('Something went wrong while starting up.', e.error ?? e.message)
  }
})

void boot()
