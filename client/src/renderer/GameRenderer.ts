import {
  Application,
  Container,
  Sprite,
  TilingSprite,
  Texture,
  Assets,
  Text,
  TextStyle,
} from 'pixi.js'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'
import type { ShipState, InputState } from '../physics/ShipPhysics'
import type { LevelData, Obstacle } from '../data/levels'
import { OBSTACLE_SIZE, quatToAngle } from '../data/levels'
import { ThrusterFX } from './ThrusterFX'
import type { ShipSkinData } from './ThrusterFX'

/**
 * Convert game angle (radians, CCW from +Y) to PixiJS sprite rotation.
 *
 * Sprite textures face UP (+Y) in the image, so PixiJS rotation=0 already
 * points up on screen. Unity angle is CCW-positive; PixiJS is CW-positive.
 * So: pixi_rotation = -gameAngle
 */
function gameAngleToPixi(a: number): number {
  return -a
}

/** Convert world position (Y-up) to PixiJS container local position (Y-down). */
function worldToLocal(wx: number, wy: number): { x: number; y: number } {
  return { x: wx * PIXELS_PER_UNIT, y: -wy * PIXELS_PER_UNIT }
}

export class GameRenderer {
  app!: Application
  private worldContainer!: Container
  private bgSprite!: TilingSprite
  private shipSprite!: Sprite
  private obstacleSprites: Sprite[] = []
  private thrusterFX!: ThrusterFX
  private shieldSprite!: Sprite          // static ring, always visible
  private shieldHitSprites: Sprite[] = []   // 3 round-robin collision ring instances
  private shieldHitAlphas: number[] = []    // per-instance fade state
  private shieldHitIdx = 0                  // next instance to use
  private lastInput: InputState = { torque: 0, surge: 0, strafe: 0 }
  private debugText!: Text

  async init(canvas: HTMLCanvasElement, shipId: string): Promise<void> {
    this.app = new Application()
    await this.app.init({
      canvas,
      resizeTo: window,
      antialias: true,
      background: '#05050f',
    })

    // ─── World container (camera space) ────────────────────────────────────
    this.worldContainer = new Container()
    this.app.stage.addChild(this.worldContainer)

    // ─── Tiling background ─────────────────────────────────────────────────
    const bgTexture = await Assets.load('/assets/textures/GameBackground.png')
    this.bgSprite = new TilingSprite({
      texture: bgTexture,
      width: this.app.screen.width,
      height: this.app.screen.height,
    })
    this.bgSprite.tileScale.set(0.5)
    // Background is in stage space (not world), so it always fills the viewport
    this.app.stage.addChildAt(this.bgSprite, 0)

    // ─── Ship sprite ───────────────────────────────────────────────────────
    const shipTexture = await Assets.load(`/assets/ships/${shipId}.png`)
    this.shipSprite = new Sprite(shipTexture)
    this.shipSprite.anchor.set(0.5)
    // Ship sprite is 1×1 Unity unit; will be confirmed in setShipRadius
    this.shipSprite.width = PIXELS_PER_UNIT
    this.shipSprite.height = PIXELS_PER_UNIT
    this.worldContainer.addChild(this.shipSprite)

    // ─── Static shield ring (always visible, behind ship) ─────────────────
    const shieldTexture = await Assets.load('/assets/textures/Shield128.png')
    this.shieldSprite = new Sprite(shieldTexture)
    this.shieldSprite.anchor.set(0.5)
    this.shieldSprite.tint = 0x60b0ff
    this.shieldSprite.alpha = 0.85
    this.worldContainer.addChildAt(this.shieldSprite, this.worldContainer.children.indexOf(this.shipSprite))

    // ─── Collision rings — 3 round-robin instances, drawn above ship ────────
    const shieldHitTexture = await Assets.load('/assets/textures/ShieldCollision128.png')
    for (let i = 0; i < 3; i++) {
      const s = new Sprite(shieldHitTexture)
      s.anchor.set(0.5)
      s.tint = 0xffffff
      s.alpha = 0
      this.worldContainer.addChild(s)
      this.shieldHitSprites.push(s)
      this.shieldHitAlphas.push(0)
    }

    // ─── Thruster FX — parented to shipSprite so it inherits its transform ──
    this.thrusterFX = new ThrusterFX(this.shipSprite)
    await this.thrusterFX.init()

    // ─── Debug overlay ─────────────────────────────────────────────────────
    const style = new TextStyle({ fill: '#88ff88', fontSize: 12, fontFamily: 'monospace' })
    this.debugText = new Text({ text: '', style })
    this.debugText.position.set(8, 8)
    this.app.stage.addChild(this.debugText)
  }

  /** Resize background to match window. Called on window resize. */
  resizeBg(): void {
    if (!this.bgSprite) return
    this.bgSprite.width = this.app.screen.width
    this.bgSprite.height = this.app.screen.height
  }

  /** Load thruster skin data. */
  async loadSkin(shipId: string): Promise<void> {
    const url = `/assets/ships/${shipId}.skin.json`
    const skin: ShipSkinData = await Assets.load(url)
    this.thrusterFX.loadSkin(skin)
  }

  /** Set ship sprite size. The ship sprite occupies 1×1 Unity units in the game world. */
  setShipRadius(radius: number): void {
    // Sprite is 1 Unity unit wide/tall → display at exactly PIXELS_PER_UNIT pixels.
    // This ensures skin JSON positions (in Unity units) map correctly to texture pixels.
    const px = PIXELS_PER_UNIT
    this.shipSprite.width = px
    this.shipSprite.height = px
    // Shield rings match the actual collision radius
    const shieldPx = radius * 2 * PIXELS_PER_UNIT
    this.shieldSprite.width = shieldPx
    this.shieldSprite.height = shieldPx
    for (const s of this.shieldHitSprites) {
      s.width = shieldPx
      s.height = shieldPx
    }
    // Compensate so ThrusterFX children are sized in screen pixels, not ship-sprite-local pixels
    this.thrusterFX.setParentScale(this.shipSprite.scale.x, this.shipSprite.scale.y)
  }

  /** Signal a collision with contact normal (nx,ny) pointing from obstacle to ship. */
  setColliding(nx: number, ny: number): void {
    // Round-robin: pick next instance
    this.shieldHitIdx = (this.shieldHitIdx + 1) % this.shieldHitSprites.length
    const s = this.shieldHitSprites[this.shieldHitIdx]
    // Orient toward contact point (opposite of normal)
    s.rotation = Math.atan2(-nx, -ny)
    this.shieldHitAlphas[this.shieldHitIdx] = 1.0
    s.alpha = 1.0
  }

  /** Load and add obstacle sprites from a level. */
  async loadLevel(level: LevelData): Promise<void> {
    // Remove existing obstacle sprites
    for (const s of this.obstacleSprites) this.worldContainer.removeChild(s)
    this.obstacleSprites = []

    // Pre-load all needed textures
    const types = [...new Set(level.Obstacles.map(o => o.Type))]
    const textureMap: Record<string, Texture> = {}
    await Promise.all(
      types.map(async (type) => {
        const url = `/assets/textures/${type}.png`
        textureMap[type] = await Assets.load(url)
      }),
    )

    for (const obs of level.Obstacles) {
      const sprite = this.createObstacleSprite(obs, textureMap[obs.Type])
      this.worldContainer.addChildAt(sprite, 0) // below ship
      this.obstacleSprites.push(sprite)
    }
  }

  private createObstacleSprite(obs: Obstacle, texture: Texture): Sprite {
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5)

    const [wu, hu] = OBSTACLE_SIZE[obs.Type] ?? [1.28, 1.28]
    sprite.width = wu * PIXELS_PER_UNIT
    sprite.height = hu * PIXELS_PER_UNIT

    const { x, y } = worldToLocal(obs.Transform.Position.x, obs.Transform.Position.y)
    sprite.position.set(x, y)

    const gameAngle = quatToAngle(obs.Transform.Rotation)
    sprite.rotation = gameAngleToPixi(gameAngle)

    return sprite
  }

  /** Store the latest input so render() can drive thruster FX. */
  setInput(input: InputState): void {
    this.lastInput = input
  }

  /**
   * Render one frame given the current physics state.
   * Called after physics has been stepped.
   */
  private lastRenderTime = 0

  render(ship: ShipState): void {
    const W = this.app.screen.width
    const H = this.app.screen.height

    // ─── Camera: center on ship ────────────────────────────────────────────
    const shipScreenX = ship.pos.x * PIXELS_PER_UNIT
    const shipScreenY = -ship.pos.y * PIXELS_PER_UNIT
    this.worldContainer.position.set(W / 2 - shipScreenX, H / 2 - shipScreenY)

    // Background tiles scroll opposite to camera (world-space feel)
    this.bgSprite.tilePosition.set(-shipScreenX * 0.15, -shipScreenY * 0.15)

    // ─── Ship sprite + shield rings ────────────────────────────────────────
    this.shipSprite.position.set(shipScreenX, shipScreenY)
    this.shipSprite.rotation = gameAngleToPixi(ship.angle)
    this.shieldSprite.position.set(shipScreenX, shipScreenY)

    // Collision rings: each fades independently
    for (let i = 0; i < this.shieldHitSprites.length; i++) {
      const s = this.shieldHitSprites[i]
      s.position.set(shipScreenX, shipScreenY)
      if (this.shieldHitAlphas[i] > 0) {
        this.shieldHitAlphas[i] = Math.max(0, this.shieldHitAlphas[i] - 0.06)
        s.alpha = this.shieldHitAlphas[i]
      }
    }

    // ─── Thruster FX (parented to shipSprite — position/rotation inherited) ─
    const now = performance.now()
    const dt  = this.lastRenderTime > 0 ? Math.min((now - this.lastRenderTime) / 1000, 0.1) : 0
    this.lastRenderTime = now
    this.thrusterFX.update(this.lastInput, dt)

    // ─── Debug text ────────────────────────────────────────────────────────
    const speed = Math.sqrt(ship.vel.x ** 2 + ship.vel.y ** 2)
    this.debugText.text =
      `pos: (${ship.pos.x.toFixed(1)}, ${ship.pos.y.toFixed(1)})  ` +
      `spd: ${speed.toFixed(1)} u/s  ` +
      `ang: ${((ship.angle * 180) / Math.PI).toFixed(0)}°`
  }

  destroy(): void {
    this.thrusterFX.destroy()
    this.app.destroy()
  }
}
