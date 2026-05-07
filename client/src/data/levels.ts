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

/** Size in Unity units for each obstacle type: [width, height] */
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
}

export async function loadLevel(levelId: string): Promise<LevelData> {
  const res = await fetch(`/assets/levels/${levelId}.json`)
  if (!res.ok) throw new Error(`Failed to load level ${levelId}`)
  return res.json()
}

export const DEFAULT_LEVEL_ID = '000000a0-0e7e-4003-9913-4aedc38e1ba5' // Alpha-1
