export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export interface ObstacleTransform {
  Position: Vec3
  Rotation: Quat
}

export interface Obstacle {
  Type: string
  Transform: ObstacleTransform
}

export interface LevelData {
  LevelId: string
  LevelName: string
  Obstacles: Obstacle[]
  Props: unknown[]
}

/** Convert Unity quaternion (2D rotation around Z) to radians (CCW from +Y). */
export function quatToAngle(q: Quat): number {
  // Unity 2D rotation: q = (0, 0, sin(θ/2), cos(θ/2))
  return 2 * Math.atan2(q.z, q.w)
}

/** Size in Unity units for each obstacle type: [width, height] (used for sprite display) */
export const OBSTACLE_SIZE: Record<string, [number, number]> = {
  capsule100x300Rock: [1, 3],
  capsule100x300Metal: [1, 3],
  capsule100x300Ice: [1, 3],
  capsule100x200Rock: [1, 2],
  capsule100x200Metal: [1, 2],
  capsule100x200Ice: [1, 2],
  capsule100x100Rock: [1, 1],
  capsule100x100Metal: [1, 1],
  capsule100x100Ice: [1, 1],
  poly5Vert128ARock: [1.28, 1.28],
  poly5Vert128BRock: [1.28, 1.28],
  poly7Vert128ARock: [1.28, 1.28],
  capsuleForce200x400_100x300Ice: [2, 4],
}

/**
 * Collision size (Unity units) when different from sprite size.
 * Keys are obstacle types where the inner collision shape differs from the sprite bounds.
 */
export const OBSTACLE_COLLISION_SIZE: Record<string, [number, number]> = {
  capsuleForce200x400_100x300Ice: [1, 3],
}

/**
 * Force zone config for obstacle types that carry an AreaEffector2D.
 * size: outer trigger capsule [w, h] in Unity units
 * magnitude: AreaEffector2D.m_ForceMagnitude
 * localAngleDeg: AreaEffector2D.m_ForceAngle (0=local+X, 90=local+Y, CCW positive)
 */
export interface ForceZoneConfig {
  size: [number, number]
  magnitude: number
  localAngleDeg: number
}

export const OBSTACLE_FORCE_ZONES: Record<string, ForceZoneConfig> = {
  capsuleForce200x400_100x300Ice: { size: [2, 4], magnitude: 100, localAngleDeg: 90 },
}

export async function loadLevel(levelId: string): Promise<LevelData> {
  const res = await fetch(`/assets/levels/${levelId}.json`)
  if (!res.ok) throw new Error(`Failed to load level ${levelId}`)
  return res.json()
}

export const DEFAULT_LEVEL_ID = '000000a1-5573-49ba-94bc-e9dd14d3181a' // Alpha-2
