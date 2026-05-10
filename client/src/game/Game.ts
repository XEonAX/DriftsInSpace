import { GameRenderer } from '../renderer/GameRenderer'
import { InputManager } from '../input/InputManager'
import { stepShip, createShipState, FIXED_DT } from '../physics/ShipPhysics'
import type { ShipState } from '../physics/ShipPhysics'
import { loadShipData } from '../data/ships'
import { loadLevel, DEFAULT_LEVEL_ID } from '../data/levels'
import { buildColliders, buildForceZones, resolveCollisions, applyForceZones, applyProps, initialPropState, frictionToMaterial } from '../physics/Collision'
import type { ObstacleCollider, ForceZone, PropState } from '../physics/Collision'
import type { Prop } from '../data/levels'
import { AudioManager } from '../audio/AudioManager'
import type { CollisionMaterial } from '../audio/AudioManager'

export class Game {
  private renderer = new GameRenderer()
  private input = new InputManager()
  private audio = new AudioManager()
  private shipState: ShipState = createShipState()
  private accumulator = 0
  private lastTime = 0
  private rafId = 0
  private running = false
  private shipId: string
  private colliders: ObstacleCollider[] = []
  private forceZones: ForceZone[] = []
  private props: Prop[] = []
  private propState: PropState = initialPropState()
  private audioStarted = false
  // No per-prop boolean state needed — all props now use continuous proximity

  constructor(shipId: string, _displayName: string) {
    this.shipId = shipId
  }

  async start(): Promise<void> {
    // Create and attach canvas
    const canvas = document.createElement('canvas')
    canvas.id = 'game-canvas'
    document.body.appendChild(canvas)

    await this.renderer.init(canvas, this.shipId)

    // Load ship physics data + skin
    const shipData = await loadShipData(this.shipId)
    this.renderer.setShipRadius(shipData.ShipDetails.Radius)
    await this.renderer.loadSkin(this.shipId)

    // Load the default level
    const level = await loadLevel(DEFAULT_LEVEL_ID)
    await this.renderer.loadLevel(level)
    this.colliders = buildColliders(level.Obstacles)
    this.forceZones = buildForceZones(level.Obstacles)
    this.props = level.Props
    this.propState = initialPropState()

    // Handle window resize
    window.addEventListener('resize', () => this.renderer.resizeBg())

    // Unlock AudioContext on first user gesture then load audio
    const unlockAudio = (): void => {
      if (this.audioStarted) return
      this.audioStarted = true
      void this.audio.init()
      window.removeEventListener('keydown', unlockAudio)
      window.removeEventListener('pointerdown', unlockAudio)
    }
    window.addEventListener('keydown', unlockAudio)
    window.addEventListener('pointerdown', unlockAudio)

    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.loop)

    const details = shipData.ShipDetails

    // Store details for use in loop
    this._details = details
  }

  // Stored after init — avoids closure allocation in loop
  private _details: import('../data/ships').ShipDetails | null = null

  private prevShipState: ShipState = createShipState()

  private loop = (timestamp: number): void => {
    if (!this.running) return

    const elapsed = Math.min((timestamp - this.lastTime) / 1000, 0.1) // cap at 100ms
    this.lastTime = timestamp
    this.accumulator += elapsed

    const details = this._details
    if (details) {
      while (this.accumulator >= FIXED_DT) {
        this.prevShipState = this.shipState
        const input = this.input.getInput()
        this.renderer.setInput(input)
        this.shipState = stepShip(this.shipState, input, details)
        if (this.forceZones.length > 0) {
          this.shipState = applyForceZones(this.shipState, details, this.forceZones, FIXED_DT)
        }
        if (this.props.length > 0) {
          this.shipState = applyProps(this.shipState, details, this.props, this.propState, FIXED_DT)
        }
        if (this.colliders.length > 0) {
          const { state, hits } = resolveCollisions(this.shipState, details, this.colliders)
          this.shipState = state
          for (const h of hits) {
            this.renderer.setColliding(h.nx, h.ny)
            const mat: CollisionMaterial = frictionToMaterial(h.friction)
            this.audio.playCollision(mat, h.impactSpeed)
          }
        }
        this.accumulator -= FIXED_DT
      }
    }

    // Sub-frame interpolation: blend between prev and current physics state
    // so rendering is smooth even at 50Hz physics / 60Hz display.
    const alpha = this.accumulator / FIXED_DT
    const prev = this.prevShipState
    const curr = this.shipState
    const interpolated: ShipState = {
      pos:    { x: prev.pos.x + (curr.pos.x - prev.pos.x) * alpha,
                y: prev.pos.y + (curr.pos.y - prev.pos.y) * alpha },
      vel:    curr.vel,
      angle:  prev.angle + (curr.angle - prev.angle) * alpha,
      angVel: curr.angVel,
    }

    this.renderer.render(interpolated)

    // ── Engine audio (every frame, uses smoothed input) ──────────────────
    if (this.audioStarted) {
      const input = this.input.getInput()
      const speed = Math.sqrt(curr.vel.x ** 2 + curr.vel.y ** 2)
      this.audio.updateEngine(input, speed, curr.angVel, elapsed)

      // Prop zone proximity (use real physics state, not interpolated)
      let boostProximity    = 0   // 0 = outside, 1 = center, r=2
      let attractorProximity = 0  // r=4
      let repulsorProximity  = 0  // r=2
      for (const p of this.props) {
        const dx = curr.pos.x - p.Transform.Position.x
        const dy = curr.pos.y - p.Transform.Position.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (p.Type === 'Boost') {
          const t = Math.max(0, 1 - dist / 2)
          if (t > boostProximity) boostProximity = t
        }
        if (p.Type === 'Attractor') {
          const t = Math.max(0, 1 - dist / 4)
          if (t > attractorProximity) attractorProximity = t
        }
        if (p.Type === 'Repulsor') {
          const t = Math.max(0, 1 - dist / 2)
          if (t > repulsorProximity) repulsorProximity = t
        }
      }
      // Force-zone obstacles (e.g. capsuleForce200x400_100x300Ice) also play boost audio.
      // Compute signed distance from ship to each force-zone capsule surface.
      for (const z of this.forceZones) {
        const cosA = Math.cos(z.angle), sinA = Math.sin(z.angle)
        const dx = curr.pos.x - z.cx, dy = curr.pos.y - z.cy
        // Capsule axis is local +Y, which in world space = (-sinA, cosA)
        const axisX = -sinA, axisY = cosA
        const along = dx * axisX + dy * axisY
        const clamped = Math.max(-z.halfLen, Math.min(z.halfLen, along))
        const closestX = z.cx + axisX * clamped
        const closestY = z.cy + axisY * clamped
        const surfDist = Math.sqrt((curr.pos.x - closestX) ** 2 + (curr.pos.y - closestY) ** 2) - z.endRadius
        // t = 1.0 inside the zone, fades to 0 over 1 unit outside the boundary
        const t = Math.max(0, 1 - Math.max(0, surfDist))
        if (t > boostProximity) boostProximity = t
      }

      this.audio.setBoostProximity(boostProximity, speed)
      this.audio.setAttractorProximity(attractorProximity, speed)
      this.audio.setRepulsorProximity(repulsorProximity, speed)
    }

    this.rafId = requestAnimationFrame(this.loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.input.destroy()
    this.renderer.destroy()
    this.audio.destroy()
  }
}
