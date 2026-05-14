import { Container, Sprite, Graphics, Texture, Assets } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { TouchStyle } from './InputManager'

const UI = '/assets/ui'

const IDLE_ALPHA   = 0.55
const ACTIVE_ALPHA = 0.95

interface PixiButton {
  container: Container
  bgNormal:  Texture
  bgPressed: Texture
  bg:        Sprite
}

async function loadTextures(): Promise<{
  btnNormal: Texture; btnPressed: Texture
  btnSecNormal: Texture; btnSecPressed: Texture
  arrow: Texture
}> {
  const [btnNormal, btnPressed, btnSecNormal, btnSecPressed, arrow] = await Promise.all([
    Assets.load<Texture>(`${UI}/PrimaryButtonNormal.png`),
    Assets.load<Texture>(`${UI}/PrimaryButtonPressed.png`),
    Assets.load<Texture>(`${UI}/SecondaryButtonNormal.png`),
    Assets.load<Texture>(`${UI}/SecondaryButtonPressed.png`),
    Assets.load<Texture>(`${UI}/ArrowUp.png`),
  ])
  return { btnNormal, btnPressed, btnSecNormal, btnSecPressed, arrow }
}

function makePixiButton(
  bgNormal: Texture,
  bgPressed: Texture,
  arrowTex: Texture,
  size: number,
  arrowRotDeg: number,
): PixiButton {
  const container = new Container()

  const bg = new Sprite(bgNormal)
  bg.width = size
  bg.height = size
  bg.anchor.set(0.5)
  container.addChild(bg)

  const arrowSize = size * 0.52
  const arrow = new Sprite(arrowTex)
  arrow.width = arrowSize
  arrow.height = arrowSize
  arrow.anchor.set(0.5)
  arrow.rotation = (arrowRotDeg * Math.PI) / 180
  arrow.alpha = 0.92
  container.addChild(arrow)

  container.alpha = IDLE_ALPHA
  return { container, bgNormal, bgPressed, bg }
}

/** PixiJS touch overlay — lives in a fixed UI container on top of the game stage. */
export class TouchOverlay {
  private uiLayer = new Container()
  private app: Application | null = null
  private currentStyle: TouchStyle = 'Button+DPAD'
  private built = false

  // Datawing
  private dwLeft:  PixiButton | null = null
  private dwRight: PixiButton | null = null

  // Button+DPAD
  private btnUp:       PixiButton | null = null
  private btnDown:     PixiButton | null = null
  private joyBase:     Graphics | null = null
  private joyKnob:     Graphics | null = null
  private joyBasePos   = { x: 0, y: 0 }
  private joyBaseR     = 0

  // Cached textures
  private tex: Awaited<ReturnType<typeof loadTextures>> | null = null

  static isTouchDevice(): boolean {
    return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches
  }

  async init(app: Application): Promise<void> {
    this.app = app
    if (!TouchOverlay.isTouchDevice()) return  // skip entirely on non-touch devices
    this.tex = await loadTextures()
    app.stage.addChild(this.uiLayer)
    this.rebuild()
  }

  setStyle(style: TouchStyle): void {
    if (style === this.currentStyle && this.built) return
    this.currentStyle = style
    this.rebuild()
  }

  onResize(): void {
    if (this.built) this.rebuild()
  }

  private rebuild(): void {
    if (!this.tex || !this.app) return
    this.uiLayer.removeChildren()
    this.dwLeft = this.dwRight = null
    this.btnUp = this.btnDown = null
    this.joyBase = this.joyKnob = null
    this.built = true

    if (this.currentStyle === 'Datawing') {
      this.buildDatawing()
    } else {
      this.buildButtonDPAD()
    }
  }

  private get W(): number { return this.app!.screen.width }
  private get H(): number { return this.app!.screen.height }

  private buildDatawing(): void {
    const tex = this.tex!
    const size = Math.min(this.W, this.H) * 0.28
    const margin = this.W * 0.04
    const bottom = this.H * 0.06

    this.dwLeft = makePixiButton(tex.btnSecNormal, tex.btnSecPressed, tex.arrow, size, -90)
    this.dwLeft.container.x = margin + size / 2
    this.dwLeft.container.y = this.H - bottom - size / 2
    this.uiLayer.addChild(this.dwLeft.container)

    this.dwRight = makePixiButton(tex.btnSecNormal, tex.btnSecPressed, tex.arrow, size, 90)
    this.dwRight.container.x = this.W - margin - size / 2
    this.dwRight.container.y = this.H - bottom - size / 2
    this.uiLayer.addChild(this.dwRight.container)
  }

  private buildButtonDPAD(): void {
    const tex = this.tex!
    const short = Math.min(this.W, this.H)
    const size   = short * 0.22
    const margin = this.W * 0.04
    const bottom = this.H * 0.06

    // Up button — stacked above down
    this.btnUp = makePixiButton(tex.btnNormal, tex.btnPressed, tex.arrow, size, 0)
    this.btnUp.container.x = margin + size / 2
    this.btnUp.container.y = this.H - bottom - size * 1.5 - 12
    this.uiLayer.addChild(this.btnUp.container)

    // Down button
    this.btnDown = makePixiButton(tex.btnSecNormal, tex.btnSecPressed, tex.arrow, size, 180)
    this.btnDown.container.x = margin + size / 2
    this.btnDown.container.y = this.H - bottom - size / 2
    this.uiLayer.addChild(this.btnDown.container)

    // Joystick — right side
    const joyR = short * 0.13
    const knobR = joyR * 0.42
    this.joyBaseR = joyR
    this.joyBasePos = {
      x: this.W - margin - joyR,
      y: this.H - bottom - joyR,
    }

    this.joyBase = new Graphics()
      .circle(0, 0, joyR)
      .fill({ color: 0x0a001e, alpha: 0.4 })
      .stroke({ color: 0xffdc64, alpha: 0.35, width: 3 })
    this.joyBase.x = this.joyBasePos.x
    this.joyBase.y = this.joyBasePos.y
    this.uiLayer.addChild(this.joyBase)

    this.joyKnob = new Graphics()
      .circle(0, 0, knobR)
      .fill({ color: 0xffc83c, alpha: 0.6 })
      .stroke({ color: 0xffdc64, alpha: 0.75, width: 2 })
    this.joyKnob.x = this.joyBasePos.x
    this.joyKnob.y = this.joyBasePos.y
    this.uiLayer.addChild(this.joyKnob)
  }

  /**
   * Returns which control a screen point (CSS pixels) lands on, or null if none.
   * Used by InputManager to reject touches outside button bounds.
   */
  hitTest(x: number, y: number): 'left' | 'right' | 'up' | 'down' | 'joy' | null {
    if (!this.app) return null
    if (this.currentStyle === 'Datawing') {
      const size = Math.min(this.W, this.H) * 0.28
      const margin = this.W * 0.04
      const bottom = this.H * 0.06
      const lx = margin + size / 2
      const ly = this.H - bottom - size / 2
      const rx = this.W - margin - size / 2
      const ry = ly
      const r = size / 2
      if (Math.hypot(x - lx, y - ly) <= r) return 'left'
      if (Math.hypot(x - rx, y - ry) <= r) return 'right'
      return null
    }
    // Button+DPAD
    const short = Math.min(this.W, this.H)
    const size   = short * 0.22
    const margin = this.W * 0.04
    const bottom = this.H * 0.06
    const lx = margin + size / 2
    const r  = size / 2
    if (Math.hypot(x - lx, y - (this.H - bottom - size * 1.5 - 12)) <= r) return 'up'
    if (Math.hypot(x - lx, y - (this.H - bottom - size / 2))         <= r) return 'down'
    if (Math.hypot(x - this.joyBasePos.x, y - this.joyBasePos.y) <= this.joyBaseR) return 'joy'
    return null
  }

  /**
   * Call each frame.
   * @param surge         1=forward, -1=back, 0=neutral (Button+DPAD left side)
   * @param leftPressed   left half held (Datawing)
   * @param rightPressed  right half held (Datawing)
   * @param joyDelta      normalised -1..1 drag offset for knob (Button+DPAD right side)
   */
  update(
    surge: number,
    leftPressed: boolean,
    rightPressed: boolean,
    joyDelta: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    if (!this.built) return

    if (this.currentStyle === 'Datawing') {
      setBtn(this.dwLeft,  leftPressed && !rightPressed)
      setBtn(this.dwRight, rightPressed && !leftPressed)
    } else {
      setBtn(this.btnUp,   surge > 0)
      setBtn(this.btnDown, surge < 0)

      if (this.joyKnob) {
        const maxOff = this.joyBaseR * 0.7
        this.joyKnob.x = this.joyBasePos.x + joyDelta.x * maxOff
        this.joyKnob.y = this.joyBasePos.y + joyDelta.y * maxOff
      }
    }
  }

  destroy(): void {
    this.uiLayer.destroy({ children: true })
  }
}

function setBtn(btn: PixiButton | null, pressed: boolean): void {
  if (!btn) return
  btn.bg.texture = pressed ? btn.bgPressed : btn.bgNormal
  btn.container.alpha = pressed ? ACTIVE_ALPHA : IDLE_ALPHA
}
