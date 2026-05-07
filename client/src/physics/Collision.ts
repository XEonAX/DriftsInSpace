/**
 * Collision detection and response for DriftsInSpace.
 *
 * Ship: circle with radius = ShipDetails.Radius
 * Capsule obstacles: stadium shape — two hemicircles with a rectangle body
 *   width = w, height = h → end radius = w/2, body segment length = h - w
 * Poly obstacles: treated as circles (radius = half the shorter side)
 *
 * Collision response: elastic impulse with restitution from ShipDetails.Bounce.
 * Friction tangential damping from ShipDetails.Friction.
 */

import type { ShipState } from './ShipPhysics'
import type { ShipDetails } from '../data/ships'
import type { Obstacle } from '../data/levels'
import { OBSTACLE_SIZE, quatToAngle } from '../data/levels'

// Bounce/friction defaults when not present in ShipDetails
const DEFAULT_BOUNCE = 0.4
const DEFAULT_FRICTION = 0.3

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Closest point on line segment AB to point P */
function closestPointOnSegment(
  ax: number, ay: number,
  bx: number, by: number,
  px: number, py: number,
): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { x: ax, y: ay }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return { x: ax + t * dx, y: ay + t * dy }
}

interface CollisionResult {
  /** Penetration depth (> 0 means overlapping) */
  depth: number
  /** Collision normal pointing FROM obstacle TOWARD ship */
  nx: number
  ny: number
}

/** Circle vs capsule (stadium) test.
 *  Capsule centre at (cx, cy), oriented at angle `a` (CCW from +Y).
 *  Half-extent along main axis = halfLen, end radius = endRadius.
 */
function circleVsCapsule(
  sx: number, sy: number, sr: number,
  cx: number, cy: number, a: number,
  halfLen: number, endRadius: number,
): CollisionResult | null {
  // Capsule axis in world space: angle=0 means axis points along +Y
  const axisX = -Math.sin(a)
  const axisY =  Math.cos(a)

  const p0x = cx - axisX * halfLen
  const p0y = cy - axisY * halfLen
  const p1x = cx + axisX * halfLen
  const p1y = cy + axisY * halfLen

  const { x: closestX, y: closestY } = closestPointOnSegment(p0x, p0y, p1x, p1y, sx, sy)

  const dxv = sx - closestX
  const dyv = sy - closestY
  const dist = Math.sqrt(dxv * dxv + dyv * dyv)
  const minDist = sr + endRadius

  if (dist >= minDist) return null

  const invDist = dist < 1e-6 ? 1 : 1 / dist
  return {
    depth: minDist - dist,
    nx: dxv * invDist,
    ny: dyv * invDist,
  }
}

/** Circle vs circle test */
function circleVsCircle(
  sx: number, sy: number, sr: number,
  cx: number, cy: number, cr: number,
): CollisionResult | null {
  const dx = sx - cx
  const dy = sy - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  const minDist = sr + cr
  if (dist >= minDist) return null
  const invDist = dist < 1e-6 ? 1 : 1 / dist
  return {
    depth: minDist - dist,
    nx: dx * invDist,
    ny: dy * invDist,
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Pre-processed obstacle for fast collision queries. */
export interface ObstacleCollider {
  type: 'capsule' | 'circle'
  cx: number
  cy: number
  angle: number     // capsule axis angle
  halfLen: number   // capsule only
  endRadius: number // capsule end radius (= half width)
  radius: number    // circle only
  bounce: number
  friction: number
}

/** Build colliders from a level obstacle list (call once at level load). */
export function buildColliders(obstacles: Obstacle[]): ObstacleCollider[] {
  return obstacles.map(obs => {
    const [wu, hu] = OBSTACLE_SIZE[obs.Type] ?? [1.28, 1.28]
    const angle = quatToAngle(obs.Transform.Rotation)
    const cx = obs.Transform.Position.x
    const cy = obs.Transform.Position.y

    if (obs.Type.startsWith('capsule')) {
      const endRadius = wu / 2
      const halfLen = Math.max(0, (hu - wu) / 2)
      return { type: 'capsule', cx, cy, angle, halfLen, endRadius, radius: 0, bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
    } else {
      // poly — approximate as circle
      const radius = Math.min(wu, hu) / 2
      return { type: 'circle', cx, cy, angle: 0, halfLen: 0, endRadius: 0, radius, bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
    }
  })
}

/**
 * Resolve all collisions for the ship against the obstacle list.
 * Returns a new ShipState (position depenetrated, velocity reflected).
 */
export function resolveCollisions(
  state: ShipState,
  details: ShipDetails,
  colliders: ObstacleCollider[],
): ShipState {
  let { pos, vel, angle, angVel } = state
  const sr = details.Radius
  const bounce = (details as unknown as Record<string, number>)['Bounce'] ?? DEFAULT_BOUNCE
  const friction = (details as unknown as Record<string, number>)['Friction'] ?? DEFAULT_FRICTION

  for (const col of colliders) {
    let result: CollisionResult | null

    if (col.type === 'capsule') {
      result = circleVsCapsule(pos.x, pos.y, sr, col.cx, col.cy, col.angle, col.halfLen, col.endRadius)
    } else {
      result = circleVsCircle(pos.x, pos.y, sr, col.cx, col.cy, col.radius)
    }

    if (!result) continue

    const { depth, nx, ny } = result

    // ── 1. Depenetrate ──────────────────────────────────────────────────────
    pos = {
      x: pos.x + nx * (depth + 0.001),
      y: pos.y + ny * (depth + 0.001),
    }

    // ── 2. Impulse ──────────────────────────────────────────────────────────
    const vDotN = vel.x * nx + vel.y * ny

    // Only respond if moving INTO the surface
    if (vDotN >= 0) continue

    // Normal impulse (elastic with restitution)
    const jn = -(1 + bounce) * vDotN

    // Tangential (friction) impulse
    const tx = vel.x - vDotN * nx
    const ty = vel.y - vDotN * ny
    const tLen = Math.sqrt(tx * tx + ty * ty)
    const invT = tLen < 1e-6 ? 0 : 1 / tLen

    vel = {
      x: vel.x + jn * nx - friction * tLen * tx * invT,
      y: vel.y + jn * ny - friction * tLen * ty * invT,
    }
  }

  return { pos, vel, angle, angVel }
}
