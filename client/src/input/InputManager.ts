import type { InputState } from '../physics/ShipPhysics'

function clamp(v: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 'Button+DPAD': left-half drag (vertical) = surge, right-half drag (horizontal) = torque.
 *  'Datawing': always surge=1; left touch = turn left, right touch = turn right, both = brake. */
export type TouchStyle = 'Button+DPAD' | 'Datawing'

interface TouchPoint {
  start: { x: number; y: number }
  current: { x: number; y: number }
}

/** Subset of TouchOverlay needed for hit-testing without a circular import. */
export interface HitTester {
  hitTest(x: number, y: number): 'left' | 'right' | 'up' | 'down' | 'joy' | null
}

/** Keyboard + gamepad + touch input manager. Produces -1..1 per axis each frame. */
export class InputManager {
  private keys = new Set<string>()
  private touchPoints = new Map<number, TouchPoint>()
  private touchStyle: TouchStyle = 'Datawing'
  private shipAngle = 0  // radians, kept in sync from Game each physics tick
  /** Degrees of misalignment that produce full (1.0) torque. Match ANXRacers DPADSensitivity. */
  dpadSensitivity = 45
  private hitTester: HitTester | null = null

  setHitTester(ht: HitTester): void {
    this.hitTester = ht
  }

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('touchstart', this.onTouchStart, { passive: false })
    window.addEventListener('touchmove', this.onTouchMove, { passive: false })
    window.addEventListener('touchend', this.onTouchEnd)
    window.addEventListener('touchcancel', this.onTouchEnd)
  }

  setTouchStyle(style: TouchStyle): void {
    this.touchStyle = style
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Prevent arrow keys scrolling the page
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.code)) {
      e.preventDefault()
    }
    this.keys.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault()
    for (const t of e.changedTouches) {
      // Reject touches that don't land on a control
      if (this.hitTester && this.hitTester.hitTest(t.clientX, t.clientY) === null) continue
      this.touchPoints.set(t.identifier, {
        start: { x: t.clientX, y: t.clientY },
        current: { x: t.clientX, y: t.clientY },
      })
    }
  }

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault()
    for (const t of e.changedTouches) {
      const pt = this.touchPoints.get(t.identifier)
      if (pt) pt.current = { x: t.clientX, y: t.clientY }
    }
  }

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of e.changedTouches) {
      this.touchPoints.delete(t.identifier)
    }
  }

  get hasTouches(): boolean {
    return this.touchPoints.size > 0
  }

  get currentTouchStyle(): TouchStyle {
    return this.touchStyle
  }

  /** Call once per physics tick so DPAD torque can use the current ship heading. */
  setShipAngle(angle: number): void {
    this.shipAngle = angle
  }

  /** Returns the current touch-derived axes plus overlay hint data. */
  getTouchState(): {
    torque: number
    surge: number
    leftPressed: boolean
    rightPressed: boolean
    joystickDelta: { x: number; y: number }
  } {
    const w = window.innerWidth
    const dragRadius = Math.min(w, window.innerHeight) * 0.15
    const deadzone = dragRadius * 0.08
    const points = [...this.touchPoints.values()]

    if (this.touchStyle === 'Datawing') {
      const left = points.some(p => p.start.x < w / 2)
      const right = points.some(p => p.start.x >= w / 2)
      const both = left && right
      return {
        surge: both ? -1 : 1,   // always forward; both = reverse
        torque: both ? 0 : (right ? 1 : 0) - (left ? 1 : 0),
        leftPressed: left,
        rightPressed: right,
        joystickDelta: { x: 0, y: 0 },
      }
    }

    // Button+DPAD
    // Left half: vertical drag = surge (drag up = forward)
    // Right half: drag direction = desired heading → SignedAngle(dragDir, shipHeading) = torque
    const leftPts = points.filter(p => p.start.x < w / 2)
    const rightPts = points.filter(p => p.start.x >= w / 2)
    let surge = 0
    let torque = 0
    let joystickDelta = { x: 0, y: 0 }

    if (leftPts.length > 0) {
      const p = leftPts[0]
      surge = clamp((p.start.y - p.current.y) / dragRadius)
    }

    if (rightPts.length > 0) {
      const p = rightPts[0]
      const screenDx = p.current.x - p.start.x
      const screenDy = p.current.y - p.start.y
      const len = Math.sqrt(screenDx * screenDx + screenDy * screenDy)

      // Knob visual delta (screen coords, clamped to circle)
      const clampedLen = Math.min(len, dragRadius)
      if (clampedLen > 0) {
        joystickDelta = {
          x: (screenDx / len) * (clampedLen / dragRadius),
          y: (screenDy / len) * (clampedLen / dragRadius),
        }
      }

      if (len > deadzone) {
        // Convert screen drag to world-space direction (flip screen Y → world Y)
        const worldDx = screenDx / len
        const worldDy = -screenDy / len  // screen Y is inverted vs world Y

        // Ship heading in world space: angle=0 → (0,1), matching Unity transform.up
        const shipHx = -Math.sin(this.shipAngle)
        const shipHy =  Math.cos(this.shipAngle)

        // Port of: Vector2.SignedAngle(joystickDir, spaceship.transform.up) / DPADSensitivity
        // SignedAngle(from, to) = atan2(cross(from,to), dot(from,to)) in degrees
        const cross = worldDx * shipHy - worldDy * shipHx  // sin component
        const dot   = worldDx * shipHx + worldDy * shipHy  // cos component
        const angleDeg = Math.atan2(cross, dot) * (180 / Math.PI)
        torque = clamp(angleDeg / this.dpadSensitivity)
      }
    }

    return { surge, torque, leftPressed: leftPts.length > 0, rightPressed: rightPts.length > 0, joystickDelta }
  }

  private getTouchAxes(): { torque: number; surge: number } {
    const s = this.getTouchState()
    return { torque: s.torque, surge: s.surge }
  }

  getInput(): InputState {
    const k = this.keys
    let torque = 0
    let surge = 0
    let strafe = 0

    // Keyboard: W/↑ forward, S/↓ backward, A/← turn left, D/→ turn right, Q/E strafe
    if (k.has('ArrowUp') || k.has('KeyW')) surge += 1
    if (k.has('ArrowDown') || k.has('KeyS')) surge -= 1
    if (k.has('ArrowLeft') || k.has('KeyA')) torque -= 1
    if (k.has('ArrowRight') || k.has('KeyD')) torque += 1
    if (k.has('KeyQ')) strafe -= 1
    if (k.has('KeyE')) strafe += 1

    // Gamepad (first connected pad)
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
    const gp = gamepads[0]
    if (gp) {
      // Left stick: X = torque, Y = surge (inverted Y axis)
      const stickX = gp.axes[0] ?? 0
      const stickY = gp.axes[1] ?? 0
      if (Math.abs(stickX) > 0.1) torque += stickX
      if (Math.abs(stickY) > 0.1) surge += -stickY // invert Y

      // RT (index 7) = forward, LT (index 6) = backward
      const rt = gp.buttons[7]?.value ?? 0
      const lt = gp.buttons[6]?.value ?? 0
      surge += rt - lt

      // Right stick X = strafe
      const rsX = gp.axes[2] ?? 0
      if (Math.abs(rsX) > 0.1) strafe += rsX
    }

    // Touch overrides keyboard/gamepad when fingers are on screen,
    // or always for Datawing (always-accelerate mode)
    if (this.touchPoints.size > 0) {
      const touch = this.getTouchAxes()
      torque = touch.torque
      surge = touch.surge
      strafe = 0
    } else if (this.touchStyle === 'Datawing' && this.hitTester !== null) {
      // No fingers on screen: keep accelerating, no turning (touch devices only)
      torque = 0
      surge = 1
      strafe = 0
    }

    return {
      torque: clamp(torque),
      surge: clamp(surge),
      strafe: clamp(strafe),
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('touchstart', this.onTouchStart)
    window.removeEventListener('touchmove', this.onTouchMove)
    window.removeEventListener('touchend', this.onTouchEnd)
    window.removeEventListener('touchcancel', this.onTouchEnd)
  }
}
