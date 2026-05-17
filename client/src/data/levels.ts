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

export interface Prop {
  Type: 'Boost' | 'Attractor' | 'Repulsor'
  Transform: ObstacleTransform
}

export interface TrackData {
  Laps: number
  Difficulty: number
  Checkpoints: ObstacleTransform[]
}

export interface LevelData {
  LevelId: string
  LevelName: string
  Track: TrackData
  Obstacles: Obstacle[]
  Props: Prop[]
}

/**
 * Checkpoint circle radius in Unity units.
 * Matches Checkpoint.cs: radius = 1 / difficulty.
 * Difficulty 0 is treated as 0.5 (same default as Track.cs).
 */
export function checkpointRadius(difficulty: number): number {
  return 1 / (difficulty > 0 ? difficulty : 0.5)
}

/**
 * Build the flat ordered route the player must follow.
 * Mirrors Track.cs Load():
 *   - Always add all checkpoints once.
 *   - If Laps > 1: repeat all checkpoints for additional laps.
 *   - If Laps > 0: append Checkpoints[0] as the final finish gate.
 * For Laps = 0: finish is the last checkpoint (single-pass layout).
 */
export function buildCheckpointRoute(track: TrackData): Array<{ transform: ObstacleTransform; originalIdx: number }> {
  const cps = track.Checkpoints
  if (cps.length === 0) return []
  const route: Array<{ transform: ObstacleTransform; originalIdx: number }> = []
  for (let i = 0; i < cps.length; i++) route.push({ transform: cps[i], originalIdx: i })
  if (track.Laps > 1) {
    for (let lap = 1; lap < track.Laps; lap++)
      for (let i = 0; i < cps.length; i++) route.push({ transform: cps[i], originalIdx: i })
  }
  if (track.Laps > 0) route.push({ transform: cps[0], originalIdx: 0 })
  return route
}

/** Convert Unity quaternion (2D rotation around Z) to radians (CCW from +Y). */
export function quatToAngle(q: Quat): number {
  // Unity 2D rotation: q = (0, 0, sin(θ/2), cos(θ/2))
  return 2 * Math.atan2(q.z, q.w)
}

/** Per-type polygon collider vertices in Unity local space (CCW winding). */
export const OBSTACLE_POLYGON_VERTS: Record<string, Array<[number, number]>> = {
  // Small 128-unit rocks
  poly5Vert128ARock: [[-0.14, 0.62], [-0.64, 0.13], [0.035, -0.62], [0.485, -0.47], [0.635, 0.31]],
  poly5Vert128BRock: [[0.035, 0.53], [-0.52, 0.46], [-0.575, -0.17], [0.225, -0.53], [0.575, 0.02]],
  poly7Vert128ARock: [[0.28, 0.46], [-0.28, 0.46], [-0.535, -0.02], [-0.28, -0.46], [0.29, -0.46], [0.285, -0.13], [0.535, 0.02]],
  // Large 512-unit rocks
  poly4Vert512ALargeRock: [[-2.1, -1.85], [2.1, -2.15], [1.4, 2.145], [-1.7, 1.72]],
  poly5Vert512ALargeRock: [[1.055, 2.145], [-2.095, 1.735], [-2.335, 0.015], [-1.865, -1.235], [-0.655, -2.155], [1.025, -2.045], [2.345, -0.105]],
  poly7Vert512ALargeRock: [[1.055, 2.145], [-2.095, 1.735], [-2.335, 0.015], [-1.865, -1.235], [-0.655, -2.155], [1.025, -2.045], [2.345, -0.105]],
  // Brown meteors (128-unit, polygon colliders)
  meteorBrown_big1: [[-0.345, 0.41], [-0.505, -0.1], [-0.215, -0.41], [0.105, -0.3], [0.345, -0.33], [0.505, 0.01], [0.245, 0.41]],
  meteorBrown_big2: [[-0.4, 0.41], [-0.6, 0.06], [-0.55, -0.26], [-0.26, -0.49], [-0.07, -0.33], [0.46, -0.18], [0.6, 0.3], [0.06, 0.49]],
  meteorBrown_big3: [[-0.095, 0.41], [-0.445, 0.19], [-0.425, -0.15], [-0.275, -0.34], [0.215, -0.41], [0.445, -0.01], [0.295, 0.28]],
  meteorBrown_big4: [[-0.36, 0.34], [-0.49, -0.1], [-0.2, -0.47], [0.3, -0.43], [0.49, 0.12], [0.17, 0.47]],
  // Space meteors (512-unit, polygon colliders)
  spaceMeteors_001: [[0.055, 2.27], [-1.215, 1.63], [-2.135, 0.67], [-2.035, -0.72], [-1.375, -1.85], [0.055, -2.27], [1.375, -2.03], [2.055, -0.85], [2.135, 0.5], [1.415, 1.67]],
  spaceMeteors_002: [[-1.455, 1.63], [-2.155, 0.68], [-2.085, -0.55], [-1.455, -1.96], [-0.045, -2.11], [1.325, -1.7], [2.055, -0.82], [2.155, 0.59], [1.295, 1.72], [0.065, 2.11]],
  spaceMeteors_003: [[0.03, 2.21], [-1.22, 1.72], [-2.2, 0.41], [-2.13, -0.8], [-1.35, -1.82], [-0.07, -2.21], [1.13, -2], [2.2, -0.82], [2.06, 0.6], [1.3, 1.73]],
  spaceMeteors_004: [[1.305, 1.835], [0.025, 2.175], [-1.475, 1.915], [-2.115, 0.775], [-2.075, -0.635], [-1.365, -1.905], [0.065, -2.175], [1.395, -1.855], [2.015, -0.675], [2.115, 0.655]],
  // Glass boxes (BoxCollider2D → 4-corner polygon, local-space half-extents)
  elementGlass70x70:        [[0.35, 0.35], [-0.35, 0.35], [-0.35, -0.35], [0.35, -0.35]],
  elementGlass220x70:       [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementGlass220x70Accel:  [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  // Explosive boxes (BoxCollider2D 0.7 × 2.2)
  elementExplosive016: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive020: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive025: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive029: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive032: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive036: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive041: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
  elementExplosive055: [[0.35, 1.1], [-0.35, 1.1], [-0.35, -1.1], [0.35, -1.1]],
}

/** Circle collider radius for obstacle types using CircleCollider2D. */
export const OBSTACLE_CIRCLE_RADIUS: Record<string, number> = {
  circle100x100Rock:   0.5,
  circle100x100Metal:  0.5,
  circle100x100Ice:    0.5,
  elementGlassCircle35: 0.35,
}

/** Size in Unity units for each obstacle type: [width, height] (used for sprite display) */
export const OBSTACLE_SIZE: Record<string, [number, number]> = {
  capsule100x300Rock: [1, 3], capsule100x300Metal: [1, 3], capsule100x300Ice: [1, 3],
  capsule100x200Rock: [1, 2], capsule100x200Metal: [1, 2], capsule100x200Ice: [1, 2],
  capsule100x100Rock: [1, 1], capsule100x100Metal: [1, 1], capsule100x100Ice: [1, 1],
  circle100x100Rock:  [1, 1], circle100x100Metal:  [1, 1], circle100x100Ice:  [1, 1],
  poly5Vert128ARock: [1.28, 1.28], poly5Vert128BRock: [1.28, 1.28], poly7Vert128ARock: [1.28, 1.28],
  poly4Vert512ALargeRock: [5.12, 5.12], poly5Vert512ALargeRock: [5.12, 5.12], poly7Vert512ALargeRock: [5.12, 5.12],
  meteorBrown_big1: [1.28, 1.28], meteorBrown_big2: [1.28, 1.28], meteorBrown_big3: [1.28, 1.28], meteorBrown_big4: [1.28, 1.28],
  spaceMeteors_001: [5.12, 5.12], spaceMeteors_002: [5.12, 5.12], spaceMeteors_003: [5.12, 5.12], spaceMeteors_004: [5.12, 5.12],
  elementGlassCircle35: [1.28, 1.28],
  elementGlass70x70: [1.28, 1.28],
  elementGlass220x70: [1.28, 2.56], elementGlass220x70Accel: [1.28, 2.56],
  elementExplosive016: [1.28, 2.56], elementExplosive020: [1.28, 2.56], elementExplosive025: [1.28, 2.56],
  elementExplosive029: [1.28, 2.56], elementExplosive032: [1.28, 2.56], elementExplosive036: [1.28, 2.56],
  elementExplosive041: [1.28, 2.56], elementExplosive055: [1.28, 2.56],
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
 * size: outer trigger capsule/box [w, h] in Unity units
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
  elementGlass220x70Accel:        { size: [1, 2.5], magnitude: 100, localAngleDeg: 90 },
}

export async function loadLevel(levelId: string): Promise<LevelData> {
  const res = await fetch(`/assets/levels/${levelId}.json`)
  if (!res.ok) throw new Error(`Failed to load level ${levelId}`)
  return res.json()
}

export const DEFAULT_LEVEL_ID = '5b9146fc-3612-43e9-8e96-f671ca63e611' // Alpha-2
