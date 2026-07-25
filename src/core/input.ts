/**
 * Keyboard + mouse input with pointer lock.
 *
 * Frame-scoped edge state (`justPressed`, mouse deltas) is cleared by `endFrame()`,
 * which the game loop calls after every update.
 */
export class Input {
  readonly keys = new Set<string>()
  readonly justPressed = new Set<string>()

  mouseLeft = false
  mouseRight = false
  mouseLeftJust = false
  mouseRightJust = false
  mouseLeftReleased = false

  /** Accumulated pointer movement since the last `endFrame()`, in raw device units. */
  dx = 0
  dy = 0

  locked = false
  sensitivity = 1

  /** Fired when the pointer lock is lost while the game expected to own it. */
  onLockLost: (() => void) | null = null

  private el: HTMLElement | null = null
  private enabled = true

  attach(el: HTMLElement): void {
    this.el = el
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
    el.addEventListener('contextmenu', this.onContextMenu)
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.el?.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.el?.removeEventListener('contextmenu', this.onContextMenu)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }

  /** While disabled, held state is dropped so the player never returns to a stuck key. */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.clearHeld()
  }

  requestLock(): void {
    if (!this.el) return
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined
    // Chrome rejects if called too soon after an exit; that's harmless and recoverable.
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  isDown(code: string): boolean {
    return this.keys.has(code)
  }

  pressed(code: string): boolean {
    return this.justPressed.has(code)
  }

  endFrame(): void {
    this.justPressed.clear()
    this.mouseLeftJust = false
    this.mouseRightJust = false
    this.mouseLeftReleased = false
    this.dx = 0
    this.dy = 0
  }

  clearHeld(): void {
    this.keys.clear()
    this.mouseLeft = false
    this.mouseRight = false
    this.dx = 0
    this.dy = 0
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Never swallow devtools / reload shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (BLOCKED_DEFAULTS.has(e.code)) e.preventDefault()
    if (!this.enabled) return
    if (!e.repeat) this.justPressed.add(e.code)
    this.keys.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.clearHeld()
  }

  private onMouseDown = (e: MouseEvent) => {
    if (!this.enabled) return
    if (e.button === 0) {
      this.mouseLeft = true
      this.mouseLeftJust = true
    } else if (e.button === 2) {
      this.mouseRight = true
      this.mouseRightJust = true
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      if (this.mouseLeft) this.mouseLeftReleased = true
      this.mouseLeft = false
    } else if (e.button === 2) {
      this.mouseRight = false
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return
    this.dx += e.movementX * this.sensitivity
    this.dy += e.movementY * this.sensitivity
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault()
  }

  private onLockChange = () => {
    const wasLocked = this.locked
    this.locked = document.pointerLockElement === this.el
    if (wasLocked && !this.locked) {
      this.clearHeld()
      this.onLockLost?.()
    }
  }
}

/** Keys whose browser default (scroll, quick-find, tab-nav) would fight the game. */
const BLOCKED_DEFAULTS = new Set([
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Slash',
  'Quote',
])
