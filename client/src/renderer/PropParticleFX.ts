import { Container, Sprite, Graphics } from 'pixi.js'
import type { Application, Texture } from 'pixi.js'
import type { Prop } from '../data/levels'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'

// ─── Constants ────────────────────────────────────────────────────────────────

/** World-unit radii matching physics zones. */
const ATTRACTOR_R = 4
const REPULSOR_R  = 2

/** Particle count per attractor/repulsor prop. All share one texture → 1 batch draw call. */
const PARTICLES_PER_PROP = 32

/** Visual radius (pixels) of each particle dot in the generated texture. */
const DOT_RADIUS_PX = 6

// ─── Internal types ───────────────────────────────────────────────────────────

interface Particle {
  sprite:    Sprite
  angle:     number   // direction in screen-space radians (Y-down, so screen-right = 0, screen-down = π/2)
  t:         number   // journey progress 0 → 1
  tSpeed:    number   // progress / second (1 / journey duration)
  radiusPx:  number   // max travel radius in worldContainer-local pixels
  inward:    boolean  // true = repulsor: outer→center; false = attractor: center→outer
  cx:        number   // prop center X in worldContainer-local pixels
  cy:        number   // prop center Y in worldContainer-local pixels
}

// ─── Class ────────────────────────────────────────────────────────────────────

/**
 * Particle effects for Attractor and Repulsor props.
 *
 * Attractor (green): particles spawn near the center and drift outward toward
 *   the influence ring, fading away as they reach it.
 *
 * Repulsor (red): particles spawn on the outer influence ring and sink inward
 *   toward the center, fading out as they converge.
 *
 * All particles share a single generated white-circle texture (PixiJS batches them).
 * The container must be added to worldContainer by the caller at the desired z-level.
 */
export class PropParticleFX {
  /** Add this to worldContainer at the desired z-level before calling loadLevel(). */
  readonly container = new Container()

  private particles: Particle[] = []
  private dotTex: Texture | null = null

  /**
   * Generate the shared particle dot texture.
   * Call once after the PixiJS Application is ready.
   */
  async init(app: Application): Promise<void> {
    const g = new Graphics()
    g.circle(0, 0, DOT_RADIUS_PX)
    g.fill(0xffffff)                    // white — tinted per-prop type
    this.dotTex = app.renderer.generateTexture(g)
    g.destroy()
  }

  /** Build particles for all attractor/repulsor props in the current level. */
  loadLevel(props: Prop[]): void {
    for (const p of this.particles) p.sprite.destroy()
    this.particles = []

    if (!this.dotTex) return

    for (const prop of props) {
      if (prop.Type !== 'Attractor' && prop.Type !== 'Repulsor') continue

      const isAttractor = prop.Type === 'Attractor'
      const maxR        = isAttractor ? ATTRACTOR_R : REPULSOR_R
      const tint        = isAttractor ? 0xff4444 : 0x44ff88

      // World → worldContainer-local (Y-down)
      const cx       = prop.Transform.Position.x * PIXELS_PER_UNIT
      const cy       = -prop.Transform.Position.y * PIXELS_PER_UNIT
      const radiusPx = maxR * PIXELS_PER_UNIT

      for (let i = 0; i < PARTICLES_PER_PROP; i++) {
        const sprite = new Sprite(this.dotTex)
        sprite.anchor.set(0.5)
        sprite.tint  = tint
        sprite.alpha = 0
        this.container.addChild(sprite)

        const p: Particle = {
          sprite,
          angle:    Math.random() * Math.PI * 2,
          t:        Math.random(),                       // stagger so not all in sync
          tSpeed:   0.35 + Math.random() * 0.35,        // 0.35–0.70 → 1.4–2.9 s journey
          radiusPx,
          inward:   isAttractor,
          cx,
          cy,
        }
        this.particles.push(p)
      }
    }
  }

  /** Call every render frame with frame delta time in seconds. */
  update(dt: number): void {
    for (const p of this.particles) {
      p.t += p.tSpeed * dt

      if (p.t >= 1) {
        // Restart with a fresh random angle and duration, hide while resetting.
        p.sprite.alpha = 0
        p.angle  = Math.random() * Math.PI * 2
        p.tSpeed = 0.35 + Math.random() * 0.35
        p.t      = 0
        continue
      }

      // Distance from prop center
      const r = p.inward
        ? (1 - p.t) * p.radiusPx   // repulsor:  outer ring → center
        : p.t       * p.radiusPx   // attractor: center     → outer ring

      p.sprite.x = p.cx + Math.cos(p.angle) * r
      p.sprite.y = p.cy + Math.sin(p.angle) * r

      // Bell-curve alpha: 0 at spawn, peaks mid-journey, 0 at destination.
      // sin(t·π) = 0 at t=0 and t=1, peaks 1.0 at t=0.5.
      p.sprite.alpha = Math.sin(p.t * Math.PI) * 0.82

      // Slight size variation: repulsor particles shrink as they converge;
      // attractor particles grow as they expand outward.
      const scale = p.inward
        ? 0.4 + (1 - p.t) * 0.6   // 1.0 at outer rim, 0.4 at center
        : 0.4 + p.t        * 0.6   // 0.4 at center, 1.0 at outer rim
      p.sprite.scale.set(scale)
    }
  }

  destroy(): void {
    for (const p of this.particles) p.sprite.destroy()
    this.particles = []
    this.dotTex?.destroy()
    this.dotTex = null
  }
}
