import type { ShipDetails } from '../data/ships'

/** Fixed physics timestep — 50 Hz, matching ANXRacers. */
export const FIXED_DT = 1 / 50

/** Pixels rendered per Unity unit. */
export const PIXELS_PER_UNIT = 60

export interface ShipState {
  /** World position in Unity units. */
  pos: { x: number; y: number }
  /** World velocity in Unity units/s. */
  vel: { x: number; y: number }
  /**
   * Angle in radians, Unity convention:
   *   0 = facing +Y (up), positive = counter-clockwise.
   */
  angle: number
  /** Angular velocity in rad/s, positive = CCW. */
  angVel: number
}

export interface InputState {
  /** -1 (turn left/CCW) … +1 (turn right/CW) */
  torque: number
  /** -1 (backward) … +1 (forward) */
  surge: number
  /** -1 (strafe left) … +1 (strafe right) */
  strafe: number
}

export function createShipState(): ShipState {
  return { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, angle: 0, angVel: 0 }
}

/**
 * Direct port of Spaceship.cs FixedUpdate().
 *
 * Key findings from source:
 *   - surgeForwardMultiplier  = ShipDetails.SurgeForward
 *   - surgeBackwardMultiplier = ShipDetails.SurgeBackward
 *   - strafeMultiplier        = ShipDetails.Strafe
 *   - torqueMultiplier        = ShipDetails.Torque
 *   - rb.AddRelativeForce(strafe * Strafe, surge)
 *   - rb.AddTorque(-torque * Torque)
 *   - drag/angDrag active only when torque ≠ 0 or surge ≠ 0
 */
export function stepShip(
  state: ShipState,
  input: InputState,
  d: ShipDetails,
): ShipState {
  const { Mass: m, LDrag, ADrag, SurgeForward, SurgeBackward, Strafe, Torque, Radius } = d

  // --- Mirror of FixedUpdate ---
  let surge = input.surge > 0 ? input.surge * SurgeForward : input.surge * SurgeBackward
  const hasInput = surge !== 0 || input.torque !== 0

  // rb.AddRelativeForce(strafe * Strafe, surge)  — local space
  const localFx = input.strafe * Strafe
  const localFy = surge

  // Rotate local force to world space (angle=0 → facing +Y)
  // right  = ( cos(a),  sin(a))
  // forward = (-sin(a),  cos(a))
  const a = state.angle
  const wFx = localFx * Math.cos(a) - localFy * Math.sin(a)
  const wFy = localFx * Math.sin(a) + localFy * Math.cos(a)

  // rb.AddTorque(-torque * Torque)
  const torqueNm = -input.torque * Torque

  // Circle collider moment of inertia: I = ½mr²
  const I = 0.5 * m * Radius * Radius

  const linDrag = hasInput ? LDrag : 0
  const angDrag = hasInput ? ADrag : 0.001

  // Integrate velocity
  let vx = state.vel.x + (wFx / m) * FIXED_DT
  let vy = state.vel.y + (wFy / m) * FIXED_DT
  let av = state.angVel + (torqueNm / I) * FIXED_DT

  // Apply drag: v *= (1 - drag * dt)
  const lf = Math.max(0, 1 - linDrag * FIXED_DT)
  const af = Math.max(0, 1 - angDrag * FIXED_DT)
  vx *= lf
  vy *= lf
  av *= af

  return {
    pos: { x: state.pos.x + vx * FIXED_DT, y: state.pos.y + vy * FIXED_DT },
    vel: { x: vx, y: vy },
    angle: state.angle + av * FIXED_DT,
    angVel: av,
  }
}
