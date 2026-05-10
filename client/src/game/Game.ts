import { GameRenderer } from '../renderer/GameRenderer'
import { InputManager } from '../input/InputManager'
import { stepShip, createShipState, FIXED_DT } from '../physics/ShipPhysics'
import type { ShipState } from '../physics/ShipPhysics'
import { loadShipData } from '../data/ships'
import { loadLevel, DEFAULT_LEVEL_ID } from '../data/levels'
import { buildColliders, buildForceZones, resolveCollisions, applyForceZones, applyProps, initialPropState } from '../physics/Collision'
import type { ObstacleCollider, ForceZone, PropState } from '../physics/Collision'
import type { Prop } from '../data/levels'

export class Game {
  private renderer = new GameRenderer()
  private input = new InputManager()
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
          for (const h of hits) this.renderer.setColliding(h.nx, h.ny)
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
    this.rafId = requestAnimationFrame(this.loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.input.destroy()
    this.renderer.destroy()
  }
}
