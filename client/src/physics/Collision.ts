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
import type { Obstacle, Prop } from '../data/levels'
import { OBSTACLE_SIZE, OBSTACLE_COLLISION_SIZE, OBSTACLE_FORCE_ZONES, OBSTACLE_POLYGON_VERTS, OBSTACLE_CIRCLE_RADIUS, quatToAngle } from '../data/levels'

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
  const dx = sx - cx, dy = sy - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  const minDist = sr + cr
  if (dist >= minDist) return null
  const invDist = dist < 1e-6 ? 1 : 1 / dist
  return { depth: minDist - dist, nx: dx * invDist, ny: dy * invDist }
}

/**
 * Circle vs convex polygon. Vertices are pre-transformed to world space (CCW winding, Y-up).
 *
 * Phase 1 — inside test: if circle centre is inside the polygon (all outward face distances ≤ 0),
 *   push out through the shallowest face.
 * Phase 2 — outside test: find the closest point on the polygon boundary; if within radius,
 *   resolve from there. This correctly handles both edge and vertex (corner) contacts without
 *   the false-positive / false-negative issues of a pure SAT vertex-axis test.
 */
function circleVsPolygon(
  sx: number, sy: number, sr: number,
  verts: Array<[number, number]>,
): CollisionResult | null {
  const n = verts.length
  let inside = true
  let maxFaceDist = -Infinity
  let faceNx = 0, faceNy = 0

  for (let i = 0; i < n; i++) {
    const [ax, ay] = verts[i]
    const [bx, by] = verts[(i + 1) % n]
    const ex = bx - ax, ey = by - ay
    const len = Math.sqrt(ex * ex + ey * ey)
    if (len < 1e-9) continue
    const nx = ey / len, ny = -ex / len  // outward normal (CCW, Y-up)
    const d = (sx - ax) * nx + (sy - ay) * ny  // signed dist: + = outside

    if (d > 0) inside = false
    if (d > maxFaceDist) { maxFaceDist = d; faceNx = nx; faceNy = ny }
  }

  if (inside) {
    // Centre is inside; push out through shallowest (least-negative) face.
    // maxFaceDist ≤ 0 here, so depth = sr - maxFaceDist ≥ sr.
    return { depth: sr - maxFaceDist, nx: faceNx, ny: faceNy }
  }

  // Centre is outside; find closest point on each edge (including endpoints).
  let closestDist2 = Infinity
  let cpx = sx, cpy = sy

  for (let i = 0; i < n; i++) {
    const [ax, ay] = verts[i]
    const [bx, by] = verts[(i + 1) % n]
    const ex = bx - ax, ey = by - ay
    const len2 = ex * ex + ey * ey
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((sx - ax) * ex + (sy - ay) * ey) / len2)) : 0
    const px = ax + t * ex, py = ay + t * ey
    const dx = sx - px, dy = sy - py
    const d2 = dx * dx + dy * dy
    if (d2 < closestDist2) { closestDist2 = d2; cpx = px; cpy = py }
  }

  const closestDist = Math.sqrt(closestDist2)
  if (closestDist >= sr) return null

  const dx = sx - cpx, dy = sy - cpy
  if (closestDist < 1e-9) return { depth: sr, nx: faceNx, ny: faceNy }
  return { depth: sr - closestDist, nx: dx / closestDist, ny: dy / closestDist }
}
// ─── Public API ──────────────────────────────────────────────────────────────

/** Pre-processed force zone — a trigger capsule that accelerates the ship. */
export interface ForceZone {
  cx: number; cy: number
  angle: number     // capsule axis angle (CCW from +Y)
  halfLen: number   // half the capsule body length
  endRadius: number // capsule end radius (= half width)
  /** World-space force vector (game units/s²) — precomputed at build time. */
  fwx: number; fwy: number
}

/** Pre-processed obstacle for fast collision queries. */
export interface ObstacleCollider {
  type: 'capsule' | 'circle' | 'polygon'
  cx: number
  cy: number
  angle: number     // capsule axis angle
  halfLen: number   // capsule only
  endRadius: number // capsule end radius (= half width)
  radius: number    // circle only
  /** World-space polygon vertices (pre-transformed, polygon type only). */
  verts: Array<[number, number]>
  bounce: number
  friction: number
}

/** Build colliders from a level obstacle list (call once at level load). */
export function buildColliders(obstacles: Obstacle[]): ObstacleCollider[] {
  return obstacles.map(obs => {
    const [wu, hu] = OBSTACLE_SIZE[obs.Type] ?? [1.28, 1.28]
    const [cwu, chu] = OBSTACLE_COLLISION_SIZE[obs.Type] ?? [wu, hu]
    const angle = quatToAngle(obs.Transform.Rotation)
    const cx = obs.Transform.Position.x
    const cy = obs.Transform.Position.y

    if (obs.Type.startsWith('capsule')) {
      const endRadius = cwu / 2
      const halfLen = Math.max(0, (chu - cwu) / 2)
      return { type: 'capsule', cx, cy, angle, halfLen, endRadius, radius: 0, verts: [], bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
    }
    const circleRadius = OBSTACLE_CIRCLE_RADIUS[obs.Type]
    if (circleRadius !== undefined) {
      return { type: 'circle', cx, cy, angle: 0, halfLen: 0, endRadius: 0, radius: circleRadius, verts: [], bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
    }
    // Polygon obstacle — transform local vertices to world space once at build time
    const localVerts = OBSTACLE_POLYGON_VERTS[obs.Type]
    if (!localVerts) {
      // Fallback: diamond approximation
      const r = Math.min(wu, hu) / 2
      const wv: Array<[number, number]> = [[0, r], [-r, 0], [0, -r], [r, 0]]
      return { type: 'polygon', cx, cy, angle: 0, halfLen: 0, endRadius: 0, radius: 0, verts: wv, bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
    }
    const cosA = Math.cos(angle), sinA = Math.sin(angle)
    const verts: Array<[number, number]> = localVerts.map(([lx, ly]) => [
      cx + lx * cosA - ly * sinA,
      cy + lx * sinA + ly * cosA,
    ])
    return { type: 'polygon', cx, cy, angle, halfLen: 0, endRadius: 0, radius: 0, verts, bounce: DEFAULT_BOUNCE, friction: DEFAULT_FRICTION }
  })
}

/** Build force zones from a level obstacle list (call once at level load). */
export function buildForceZones(obstacles: Obstacle[]): ForceZone[] {
  const zones: ForceZone[] = []
  for (const obs of obstacles) {
    const cfg = OBSTACLE_FORCE_ZONES[obs.Type]
    if (!cfg) continue
    const angle = quatToAngle(obs.Transform.Rotation)
    const cx = obs.Transform.Position.x
    const cy = obs.Transform.Position.y
    const [fw, fh] = cfg.size
    const endRadius = fw / 2
    const halfLen   = Math.max(0, (fh - fw) / 2)

    // Force direction: localAngleDeg in local space (0=local+X, 90=local+Y, CCW).
    // Local +X in world = (cos(angle), sin(angle)); local +Y in world = (-sin(angle), cos(angle)).
    const localRad = cfg.localAngleDeg * (Math.PI / 180)
    // Rotate local direction (cos(localRad), sin(localRad)) by object angle:
    const fwx = Math.cos(localRad) * Math.cos(angle) - Math.sin(localRad) * Math.sin(angle)
    const fwy = Math.cos(localRad) * Math.sin(angle) + Math.sin(localRad) * Math.cos(angle)
    const accel = cfg.magnitude  // will divide by mass when applying

    zones.push({ cx, cy, angle, halfLen, endRadius, fwx: fwx * accel, fwy: fwy * accel })
  }
  return zones
}

/**
 * Apply continuous force zones to the ship for one physics step.
 * Returns updated ShipState with velocity modified by any zones the ship is inside.
 */
export function applyForceZones(
  state: ShipState,
  details: ShipDetails,
  zones: ForceZone[],
  dt: number,
): ShipState {
  let { pos, vel, angle, angVel } = state
  const mass = details.Mass

  for (const z of zones) {
    const result = circleVsCapsule(pos.x, pos.y, details.Radius, z.cx, z.cy, z.angle, z.halfLen, z.endRadius)
    // circleVsCapsule returns a result when ship overlaps; here we need "ship is inside zone".
    // The zone is much larger than the ship, so if the capsule test shows depth > 0 (overlap),
    // the ship is inside the zone. But since the ship is smaller than the zone, we check
    // whether the closest point on the capsule axis is within range — ship is inside if
    // dist(ship, capsule surface) > 0 (i.e. ship center is inside the capsule).
    // circleVsCapsule returns null when NOT overlapping, so invert: inside = result !== null.
    if (result === null) continue  // ship outside this zone

    // Apply acceleration: a = F/m, dv = a * dt
    vel = {
      x: vel.x + (z.fwx / mass) * dt,
      y: vel.y + (z.fwy / mass) * dt,
    }
  }

  return { pos, vel, angle, angVel }
}

/**
 * Resolve all collisions for the ship against the obstacle list.
 * Returns a new ShipState (position depenetrated, velocity reflected) and
 * whether any collision was detected this step.
 */
export function resolveCollisions(
  state: ShipState,
  details: ShipDetails,
  colliders: ObstacleCollider[],
): { state: ShipState; hits: Array<{ nx: number; ny: number }> } {
  let { pos, vel, angle, angVel } = state
  const sr = details.Radius
  const bounce = (details as unknown as Record<string, number>)['Bounce'] ?? DEFAULT_BOUNCE
  const friction = (details as unknown as Record<string, number>)['Friction'] ?? DEFAULT_FRICTION
  const hits: Array<{ nx: number; ny: number }> = []

  for (const col of colliders) {
    let result: CollisionResult | null

    if (col.type === 'capsule') {
      result = circleVsCapsule(pos.x, pos.y, sr, col.cx, col.cy, col.angle, col.halfLen, col.endRadius)
    } else if (col.type === 'circle') {
      result = circleVsCircle(pos.x, pos.y, sr, col.cx, col.cy, col.radius)
    } else {
      result = circleVsPolygon(pos.x, pos.y, sr, col.verts)
    }

    if (!result) continue

    const { depth, nx, ny } = result
    hits.push({ nx, ny })

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

  return { state: { pos, vel, angle, angVel }, hits }
}

// ─── Prop physics ─────────────────────────────────────────────────────────────

/**
 * Boost: AreaEffector2D, m_ForceAngle=90 (local +Y), m_UseGlobalAngle=0, m_ForceMagnitude=100.
 * Radius 2u circle trigger — continuous force while inside, in prop's local +Y direction.
 * Attractor: PointEffector2D m_ForceMagnitude=-500, m_ForceMode=2 (InverseSquared), radius=2u.
 * Repulsor: same but m_ForceMagnitude=500.
 */
const BOOST_RADIUS = 2          // m_Radius from Boost.prefab CircleCollider2D
const BOOST_MAGNITUDE = 100     // m_ForceMagnitude
// Attractor/Repulsor: PointEffector2D InverseSquared, no fixed radius cutoff
const ATTRACTOR_MAGNITUDE = -500
const REPULSOR_MAGNITUDE = 500

export interface PropState {
  _unused?: never   // kept for future per-prop state if needed
}

export function initialPropState(): PropState {
  return {}
}

/**
 * Apply prop effects (Boost, Attractor, Repulsor) to the ship.
 * Returns the updated ShipState.
 */
export function applyProps(
  state: ShipState,
  details: ShipDetails,
  props: Prop[],
  _propState: PropState,
  dt: number,
): ShipState {
  let { pos, vel, angle, angVel } = state

  for (const p of props) {
    const px = p.Transform.Position.x
    const py = p.Transform.Position.y
    const dx = pos.x - px
    const dy = pos.y - py
    const dist2 = dx * dx + dy * dy

    if (p.Type === 'Boost') {
      // AreaEffector2D: continuous force while ship is within radius.
      // ForceAngle=90 = local +Y. UseGlobalAngle=0 → rotated by prop orientation.
      if (dist2 >= BOOST_RADIUS * BOOST_RADIUS) continue
      const propAngle = quatToAngle(p.Transform.Rotation)
      // Local +Y rotated by propAngle: wx=-sin(a)*0+cos(a)*1... in Y-up: fwx=sin(a), fwy=cos(a)
      // (same formula as AreaEffector2D force zones: localAngleDeg=90)
      const fwx = -Math.sin(propAngle)   // local +Y x-component in world space
      const fwy =  Math.cos(propAngle)   // local +Y y-component in world space
      const accel = BOOST_MAGNITUDE / details.Mass
      vel = { x: vel.x + fwx * accel * dt, y: vel.y + fwy * accel * dt }
    } else {
      // PointEffector2D: only applies force inside the CircleCollider2D trigger.
      // Attractor: root scale (2,2) × m_Radius 2 → world r=4.
      // Repulsor:  root scale (1,1) × m_Radius 2 → world r=2.
      const ATTRACTOR_REPULSOR_RADIUS = p.Type === 'Attractor' ? 4 : 2
      if (dist2 >= ATTRACTOR_REPULSOR_RADIUS * ATTRACTOR_REPULSOR_RADIUS) continue
      if (dist2 < 1e-6) continue
      const dist = Math.sqrt(dist2)
      // Direction: ship - prop (outward). Attractor magnitude is negative → pulls inward.
      const nx = dx / dist
      const ny = dy / dist
      const magnitude = p.Type === 'Attractor' ? ATTRACTOR_MAGNITUDE : REPULSOR_MAGNITUDE
      // InverseSquared: a = magnitude / dist²  (DistanceScale=1)
      const accel = (magnitude / details.Mass) / dist2
      vel = { x: vel.x + nx * accel * dt, y: vel.y + ny * accel * dt }
    }
  }

  return { pos, vel, angle, angVel }
}
