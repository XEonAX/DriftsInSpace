import type { InputState } from '../physics/ShipPhysics'

function clamp(v: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Keyboard + gamepad input manager. Produces -1..1 per axis each frame. */
export class InputManager {
  private keys = new Set<string>()

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
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

    return {
      torque: clamp(torque),
      surge: clamp(surge),
      strafe: clamp(strafe),
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}
