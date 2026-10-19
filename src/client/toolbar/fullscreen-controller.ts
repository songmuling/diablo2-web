/**
 * Document fullscreen controller backing the toolbar's fullscreen toggle button
 * (`#d2-toolbar-fullscreen-btn`, right after the `60 FPS / 30 FPS` selector).
 *
 * NOT 1.13c behaviour: web-port affordance only.
 *
 * - `toggle()` must run synchronously inside the click handler (user-activation requirement).
 * - Exiting with Esc / F11 is left entirely to the browser (no Keyboard Lock), so Esc always
 *   restores the window; `fullscreenchange` keeps the button state in sync either way.
 * - Rejections are reported through `onError`, never swallowed.
 */

/** Minimal `Document` surface used by the controller (kept small for node-env tests). */
export interface FullscreenDocLike {
  readonly fullscreenElement: Element | null
  exitFullscreen(): Promise<void>
  addEventListener(type: 'fullscreenchange' | 'fullscreenerror', listener: () => void): void
  removeEventListener(type: 'fullscreenchange' | 'fullscreenerror', listener: () => void): void
}

/** Element that goes fullscreen (normally `document.documentElement`). */
export interface FullscreenTargetLike {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>
}

export type FullscreenErrorKind = 'unsupported' | 'enter' | 'exit' | 'rejected'

export interface FullscreenControllerOptions {
  readonly doc: FullscreenDocLike
  readonly target: FullscreenTargetLike
  /** Called after every `fullscreenchange` (browser- or button-driven). */
  readonly onChange: (active: boolean) => void
  readonly onError: (kind: FullscreenErrorKind, detail: string) => void
}

export class FullscreenController {
  private readonly doc: FullscreenDocLike
  private readonly target: FullscreenTargetLike
  private readonly onChange: (active: boolean) => void
  private readonly onError: (kind: FullscreenErrorKind, detail: string) => void
  private readonly handleChange = (): void => {
    this.onChange(this.isActive())
  }
  private readonly handleError = (): void => {
    this.onError('rejected', 'fullscreenerror')
  }

  constructor(opts: FullscreenControllerOptions) {
    this.doc = opts.doc
    this.target = opts.target
    this.onChange = opts.onChange
    this.onError = opts.onError
    this.doc.addEventListener('fullscreenchange', this.handleChange)
    this.doc.addEventListener('fullscreenerror', this.handleError)
  }

  /** Whether fullscreen can be requested at all in this browser. */
  isSupported(): boolean {
    return typeof this.target.requestFullscreen === 'function'
  }

  isActive(): boolean {
    return this.doc.fullscreenElement != null
  }

  /** Enter or exit fullscreen. Call synchronously from the click handler. */
  toggle(): void {
    if (this.isActive()) {
      this.doc.exitFullscreen().catch((err: unknown) => {
        this.onError('exit', describeError(err))
      })
      return
    }
    const request = this.target.requestFullscreen
    if (typeof request !== 'function') {
      this.onError('unsupported', 'requestFullscreen is not available')
      return
    }
    request.call(this.target, { navigationUI: 'hide' }).catch((err: unknown) => {
      this.onError('enter', describeError(err))
    })
  }

  dispose(): void {
    this.doc.removeEventListener('fullscreenchange', this.handleChange)
    this.doc.removeEventListener('fullscreenerror', this.handleError)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
