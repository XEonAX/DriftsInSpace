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
  setShipRadius(_radius: number): void {
    // Sprite is 1 Unity unit wide/tall → display at exactly PIXELS_PER_UNIT pixels.
    // This ensures skin JSON positions (in Unity units) map correctly to texture pixels.
    const px = PIXELS_PER_UNIT
    this.shipSprite.width = px
    this.shipSprite.height = px
    // Compensate so ThrusterFX children are sized in screen pixels, not ship-sprite-local pixels
    this.thrusterFX.setParentScale(this.shipSprite.scale.x, this.shipSprite.scale.y)
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
  render(ship: ShipState): void {
    const W = this.app.screen.width
    const H = this.app.screen.height

    // ─── Camera: center on ship ────────────────────────────────────────────
    const shipScreenX = ship.pos.x * PIXELS_PER_UNIT
    const shipScreenY = -ship.pos.y * PIXELS_PER_UNIT
    this.worldContainer.position.set(W / 2 - shipScreenX, H / 2 - shipScreenY)

    // Background tiles scroll opposite to camera (world-space feel)
    this.bgSprite.tilePosition.set(-shipScreenX * 0.15, -shipScreenY * 0.15)

    // ─── Ship sprite ───────────────────────────────────────────────────────
    this.shipSprite.position.set(shipScreenX, shipScreenY)
    this.shipSprite.rotation = gameAngleToPixi(ship.angle)

    // ─── Thruster FX (parented to shipSprite — position/rotation inherited) ─
    this.thrusterFX.update(this.lastInput)

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
