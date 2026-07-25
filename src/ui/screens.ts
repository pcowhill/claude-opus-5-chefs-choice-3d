import { formatInt, formatTime } from '../core/mathx'
import { ICONS, type Upgrade } from '../game/upgrades'
import { roman } from './hud'

export interface RunSummary {
  score: number
  wave: number
  totalWaves: number
  time: number
  kills: number
  accuracy: number
  bestStreak: number
  upgrades: string[]
  victory: boolean
  best: number
  newBest: boolean
}

export type ScreenName = 'none' | 'title' | 'pause' | 'draft' | 'end'

export interface AudioBinding {
  getVolume: () => number
  getMuted: () => boolean
  setVolume: (v: number) => void
  toggleMute: () => void
}

const CONTROLS: [string, string][] = [
  ['<kbd>MOUSE</kbd>', 'Traverse and elevate the gun'],
  ['<kbd>LEFT MOUSE</kbd>', 'Hold to charge, release to fire — the kick moves the boat'],
  ['<kbd>RIGHT MOUSE</kbd>', 'Grapeshot — a wide blast and a hard shove'],
  ['<kbd>SPACE</kbd>', 'Hold to bail. You cannot fire while bailing'],
  ['<kbd>SHIFT</kbd>', 'Hold for the sea anchor — kills drift, cools the breech'],
  ['<kbd>ESC</kbd> <kbd>M</kbd>', 'Pause · mute · press 1 2 3 to take salvage'],
]

function controlRows(): string {
  return CONTROLS.map(
    ([k, d]) => `<div class="ctrl"><span class="keys">${k}</span><span class="desc">${d}</span></div>`,
  ).join('')
}

/** Title, pause, salvage draft and end screens. Owns its own keyboard shortcuts. */
export class Screens {
  readonly root: HTMLElement
  current: ScreenName = 'none'

  onStart: (() => void) | null = null
  onResume: (() => void) | null = null
  onRestart: (() => void) | null = null
  onQuitToTitle: (() => void) | null = null
  onPick: ((u: Upgrade) => void) | null = null
  onUiSound: ((kind: 'move' | 'confirm' | 'back') => void) | null = null

  private draftOptions: Upgrade[] = []
  private audio: AudioBinding | null = null

  constructor(parent: HTMLElement) {
    const el = document.createElement('div')
    el.id = 'screens'
    el.innerHTML = `<div class="scrim"></div><div class="sheet"><div class="panel" id="panel"></div></div>`
    parent.appendChild(el)
    this.root = el
  }

  bindAudio(a: AudioBinding): void {
    this.audio = a
  }

  private get panel(): HTMLElement {
    return this.root.querySelector('#panel') as HTMLElement
  }

  hide(): void {
    this.current = 'none'
    this.root.classList.remove('on')
    this.panel.innerHTML = ''
  }

  private show(name: ScreenName, html: string): void {
    this.current = name
    this.root.classList.add('on')
    this.panel.innerHTML = html
    this.wireAudioRow()
    // Focus the primary action so Enter/Space work without a click.
    const primary = this.panel.querySelector('button.btn') as HTMLButtonElement | null
    primary?.focus({ preventScroll: true })
  }

  private audioRowHtml(): string {
    const v = this.audio ? Math.round(this.audio.getVolume() * 100) : 70
    const m = this.audio ? this.audio.getMuted() : false
    return `
      <div class="audio-row">
        <span class="label">VOLUME</span>
        <input type="range" id="vol" min="0" max="100" value="${v}" />
        <button class="toggle" id="mute" data-on="${!m}">${m ? 'MUTED' : 'SOUND ON'}</button>
      </div>`
  }

  private wireAudioRow(): void {
    const vol = this.panel.querySelector('#vol') as HTMLInputElement | null
    const mute = this.panel.querySelector('#mute') as HTMLButtonElement | null
    if (vol && this.audio) {
      vol.addEventListener('input', () => {
        this.audio!.setVolume(Number(vol.value) / 100)
        if (mute) {
          const m = this.audio!.getMuted()
          mute.dataset.on = String(!m)
          mute.textContent = m ? 'MUTED' : 'SOUND ON'
        }
      })
    }
    if (mute && this.audio) {
      mute.addEventListener('click', () => {
        this.audio!.toggleMute()
        const m = this.audio!.getMuted()
        mute.dataset.on = String(!m)
        mute.textContent = m ? 'MUTED' : 'SOUND ON'
        this.onUiSound?.('move')
      })
    }
  }

  showTitle(best: number): void {
    this.show(
      'title',
      `
      <div class="kicker">A SMALL BOAT · A LARGE SEA · ONE GUN</div>
      <h1 class="title display">SALVO</h1>
      <div class="subtitle">YOUR CANNON IS YOUR ONLY OAR</div>
      <p class="blurb">
        There are no oars aboard and no sail worth the name. <em>Firing the gun is the only way you move.</em>
        Damage is water in the hull — bail it by hand, but a bailing hand is not a firing hand.
        And the breech overheats, so the same boarding sea that drowns you is the only thing cooling it.
      </p>
      <div class="controls">${controlRows()}</div>
      <div class="actions">
        <button class="btn" id="start">PUT TO SEA</button>
      </div>
      ${this.audioRowHtml()}
      <div class="hint">SURVIVE TEN WAVES · KILL WHAT COMES ON THE TENTH</div>
      ${best > 0 ? `<div class="best">BEST SALVAGE — ${formatInt(best)}</div>` : ''}
      `,
    )
    this.panel.querySelector('#start')?.addEventListener('click', () => {
      this.onUiSound?.('confirm')
      this.onStart?.()
    })
  }

  showPause(): void {
    this.show(
      'pause',
      `
      <div class="kicker">THE WATCH IS HELD</div>
      <h1 class="title display">BECALMED</h1>
      <div class="controls">${controlRows()}</div>
      <div class="actions">
        <button class="btn" id="resume">RESUME</button>
        <button class="btn ghost" id="restart">ABANDON &amp; RESTART</button>
        <button class="btn ghost" id="title">TO TITLE</button>
      </div>
      ${this.audioRowHtml()}
      <div class="hint">PRESS ESC TO RESUME</div>
      `,
    )
    this.panel.querySelector('#resume')?.addEventListener('click', () => {
      this.onUiSound?.('confirm')
      this.onResume?.()
    })
    this.panel.querySelector('#restart')?.addEventListener('click', () => {
      this.onUiSound?.('back')
      this.onRestart?.()
    })
    this.panel.querySelector('#title')?.addEventListener('click', () => {
      this.onUiSound?.('back')
      this.onQuitToTitle?.()
    })
  }

  showDraft(options: Upgrade[], waveJustCleared: number, nextWaveName: string): void {
    this.draftOptions = options
    this.show(
      'draft',
      `
      <div class="kicker">WAVE ${roman(waveJustCleared)} CLEARED · SALVAGE RECOVERED</div>
      <h1 class="title display draft-title">TAKE ONE</h1>
      <div class="cards">
        ${options
          .map(
            (u, i) => `
          <button class="card" data-i="${i}">
            <span class="card-num">${i + 1}</span>
            <span class="card-icon"><svg viewBox="0 0 48 48">${ICONS[u.icon]}</svg></span>
            <span class="card-name">${u.name}</span>
            <span class="card-rule"></span>
            <span class="card-desc">${u.desc}</span>
          </button>`,
          )
          .join('')}
      </div>
      <div class="hint">CLICK A CARD · OR PRESS <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></div>
      <div class="best">NEXT — ${nextWaveName}</div>
      `,
    )
    this.panel.querySelectorAll<HTMLButtonElement>('.card').forEach((btn) => {
      btn.addEventListener('click', () => this.pick(Number(btn.dataset.i)))
      btn.addEventListener('mouseenter', () => this.onUiSound?.('move'))
    })
  }

  private pick(i: number): void {
    const u = this.draftOptions[i]
    if (!u) return
    this.onUiSound?.('confirm')
    this.onPick?.(u)
  }

  showEnd(s: RunSummary): void {
    const verdict = s.victory
      ? 'The water goes quiet. Whatever it was, it is under you now and it is not coming back up.'
      : verdictFor(s.wave, s.totalWaves)
    this.show(
      'end',
      `
      <div class="kicker">${s.victory ? 'TEN WAVES WEATHERED' : `LOST ON WAVE ${roman(s.wave)} OF ${roman(s.totalWaves)}`}</div>
      <h1 class="title display">${s.victory ? 'SALVAGED' : 'FOUNDERED'}</h1>
      <div class="verdict">${verdict}</div>
      <div class="stats">
        <div class="stat">
          <div class="label">SALVAGE</div>
          <div class="val gold">${formatInt(s.score)}</div>
          <div class="sub">BEST STREAK ×${s.bestStreak.toFixed(1)}</div>
        </div>
        <div class="stat">
          <div class="label">WAVES HELD</div>
          <div class="val">${s.victory ? s.totalWaves : Math.max(0, s.wave - 1)}<span style="font-size:16px;color:var(--paper-faint)">/${s.totalWaves}</span></div>
          <div class="sub">${s.victory ? 'ALL OF THEM' : `REACHED ${roman(s.wave)}`}</div>
        </div>
        <div class="stat">
          <div class="label">BEASTS SUNK</div>
          <div class="val">${formatInt(s.kills)}</div>
          <div class="sub">${Math.round(s.accuracy * 100)}% OF ROUND SHOT ON TARGET</div>
        </div>
        <div class="stat">
          <div class="label">TIME AFLOAT</div>
          <div class="val">${formatTime(s.time)}</div>
          <div class="sub">&nbsp;</div>
        </div>
      </div>
      ${
        s.upgrades.length
          ? `<div class="taken">${s.upgrades.map((u) => `<span>${u}</span>`).join('')}</div>`
          : '<div class="taken"><span>NO SALVAGE TAKEN</span></div>'
      }
      <div class="actions">
        <button class="btn" id="again">PUT TO SEA AGAIN</button>
        <button class="btn ghost" id="title">TO TITLE</button>
      </div>
      <div class="best">${s.newBest ? '★ NEW BEST SALVAGE ★' : `BEST SALVAGE — ${formatInt(s.best)}`}</div>
      <div class="hint">PRESS <kbd>ENTER</kbd> TO SAIL AGAIN</div>
      `,
    )
    this.panel.querySelector('#again')?.addEventListener('click', () => {
      this.onUiSound?.('confirm')
      this.onRestart?.()
    })
    this.panel.querySelector('#title')?.addEventListener('click', () => {
      this.onUiSound?.('back')
      this.onQuitToTitle?.()
    })
  }

  /** Returns true if the key was consumed by the visible screen. */
  handleKey(code: string): boolean {
    switch (this.current) {
      case 'title':
        if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
          this.onUiSound?.('confirm')
          this.onStart?.()
          return true
        }
        return false
      case 'pause':
        if (code === 'Escape' || code === 'KeyP' || code === 'Enter') {
          this.onUiSound?.('confirm')
          this.onResume?.()
          return true
        }
        return false
      case 'draft': {
        const n = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[code]
        if (n !== undefined) {
          this.pick(n)
          return true
        }
        return false
      }
      case 'end':
        if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
          this.onUiSound?.('confirm')
          this.onRestart?.()
          return true
        }
        if (code === 'Escape') {
          this.onUiSound?.('back')
          this.onQuitToTitle?.()
          return true
        }
        return false
      default:
        return false
    }
  }
}

function verdictFor(wave: number, total: number): string {
  const frac = wave / total
  if (frac <= 0.2) return 'The sea barely noticed. Try keeping the gun cool and the hull dry.'
  if (frac <= 0.45) return 'A respectable drowning. The trick is that every shot is also a stroke of the oar.'
  if (frac <= 0.7) return 'You went down fighting, and in worse weather than most.'
  if (frac < 1) return 'So close you could hear it breathing. Bail earlier next time.'
  return 'You made it to the last wave and the last wave made it to you.'
}
