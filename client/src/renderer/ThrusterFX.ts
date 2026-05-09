import { Container, Sprite, Assets } from 'pixi.js'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'
import type { InputState } from '../physics/ShipPhysics'

// ─── Internal types ────────────────────────────────────────────────────────

interface ThrusterDef {
  localX: number
  localY: number
  scaleX: number
  scaleY: number
  /** 0 = main thruster (fires on forward surge), ~180 = reverse */
  rotationDeg: number
  tint: number
  side: 'main' | 'left' | 'right'
}

// The trail ribbon was 0.11 Unity units (≈7px) — that's the narrow tapered tail.
// The nozzle glow sprite is wider; 28px gives main(scaleX=0.5)→14px with soft gradient edges.
const BASE_WIDTH  = 28
const BASE_HEIGHT = 220

// ─── Class ────────────────────────────────────────────────────────────────

export class ThrusterFX {
  private container: Container
  private defs: ThrusterDef[] = []
  private sprites: Sprite[] = []
  private currentPowers: number[] = []   // smoothed power per thruster
  private texW = 1
  private texH = 1

  /** parent should be the ship Sprite so the container inherits its transform. */
  constructor(parent: Container) {
    this.container = new Container()
    parent.addChild(this.container)
  }

  async init(): Promise<void> {
    const texture = await Assets.load('/assets/textures/spaceEffects_010.png')
    this.texW = texture.width
    this.texH = texture.height
  }

  /**
   * Call this after the ship sprite scale is set (i.e. after setShipRadius).
   * Applies the inverse of the parent sprite's scale so that sprite positions
   * and sizes are in screen pixels rather than inheriting the ship's shrink factor.
   */
  setParentScale(sx: number, sy: number): void {
    this.container.scale.set(1 / sx, 1 / sy)
  }

  loadSkin(skinData: ShipSkinData): void {
    for (const s of this.sprites) s.destroy()
    this.sprites = []
    this.defs = []
    this.currentPowers = []

    const push = (t: ThrusterEntry, side: ThrusterDef['side']) => {
      const def: ThrusterDef = {
        localX: t.Position.x,
        localY: t.Position.y,
        scaleX: t.Scale.x,
        scaleY: t.Scale.y,
        rotationDeg: t.Rotation,
        tint: rgbaToHex(t.Color),
        side,
      }
      this.defs.push(def)

      const sprite = Sprite.from('/assets/textures/spaceEffects_010.png')
      sprite.anchor.set(0.5, 0)
      sprite.tint = def.tint

      // Position in ship-local space: Unity (x, y) Y-up → screen (x, -y) Y-down.
      // The container is parented to shipSprite so ship rotation is inherited
      // automatically — no per-frame world-space math needed.
      sprite.position.set(def.localX * PIXELS_PER_UNIT, -def.localY * PIXELS_PER_UNIT)

      // Rotation in ship-local space: convert skin JSON rotationDeg directly to radians.
      // 0°   = main thruster, plume extends in sprite's +Y = ship backward ✓
      // 180° = reverse thruster, plume extends forward ✓
      // 200°/160° = Squid reverse thrusters, angled inward ✓
      sprite.rotation = def.rotationDeg * -(Math.PI / 180)

      sprite.visible = false
      this.container.addChild(sprite)
      this.sprites.push(sprite)
      this.currentPowers.push(0)
    }

    for (const t of skinData.MainThrusters ?? []) push(t, 'main')
    if (skinData.LeftReverseThruster)  push(skinData.LeftReverseThruster,  'left')
    if (skinData.RightReverseThruster) push(skinData.RightReverseThruster, 'right')
  }

  /**
   * Called every render frame. Smoothly lerps power toward the target at 5/s
   * (0→1 in 0.2 s) so thrust length ramps up/down rather than snapping.
   */
  update(input: InputState, dt: number): void {
    const rate = dt * 5  // 1/0.2s = 5 per second
    for (let i = 0; i < this.defs.length; i++) {
      const def    = this.defs[i]
      const sprite = this.sprites[i]
      const target = thrusterPower(def, input)

      // Lerp current power toward target
      const prev = this.currentPowers[i]
      const cur  = prev + (target - prev) * Math.min(1, rate)
      this.currentPowers[i] = cur

      if (cur <= 0.01) {
        sprite.visible = false
        continue
      }

      const flicker = 0.92 + Math.random() * 0.16
      sprite.scale.set(
        BASE_WIDTH  * def.scaleX * cur * flicker / this.texW,
        BASE_HEIGHT * def.scaleY * cur * flicker / this.texH,
      )
      sprite.alpha   = 0.85 + Math.random() * 0.15
      sprite.visible = true
    }
  }

  destroy(): void {
    this.container.destroy()
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface ThrusterEntry {
  Position: { x: number; y: number; z: number }
  Scale: { x: number; y: number; z: number }
  Rotation: number
  Color: { r: number; g: number; b: number; a: number }
}

export interface ShipSkinData {
  MainThrusters?: ThrusterEntry[]
  LeftReverseThruster?: ThrusterEntry
  RightReverseThruster?: ThrusterEntry
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function thrusterPower(def: ThrusterDef, input: InputState): number {
  const reverse = Math.max(0, -input.surge)
  const torque  = input.torque  // +1 = CCW/left, -1 = CW/right
  switch (def.side) {
    case 'main':
      return Math.max(0, input.surge)
    case 'left': {
      const turnFire       = Math.max(0, -torque)                         // fires when turning right
      const reducedReverse = reverse * (1 - Math.max(0, torque))          // reduced when turning left
      const floor          = reverse * 0.5                               // never drops below 25% of reverse
      return Math.min(1, Math.max(floor, reducedReverse + turnFire))
    }
    case 'right': {
      const turnFire       = Math.max(0, torque)                          // fires when turning left
      const reducedReverse = reverse * (1 - Math.max(0, -torque))         // reduced when turning right
      const floor          = reverse * 0.5
      return Math.min(1, Math.max(floor, reducedReverse + turnFire))
    }
  }
}

function rgbaToHex(c: { r: number; g: number; b: number }): number {
  return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255)
}
