import {
  Application,
  Container,
  Sprite,
  Texture,
  Assets,
  Text,
  TextStyle,
} from 'pixi.js'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'
import type { ShipState, InputState } from '../physics/ShipPhysics'
import type { LevelData, Obstacle, Prop } from '../data/levels'
import { OBSTACLE_SIZE, quatToAngle } from '../data/levels'
import { ThrusterFX } from './ThrusterFX'
import type { ShipSkinData } from './ThrusterFX'
import { BackgroundRenderer } from './BackgroundRenderer'

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
  private bgRenderer = new BackgroundRenderer()
  private shipSprite!: Sprite
  private obstacleSprites: Sprite[] = []
  private propSprites: Sprite[] = []
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
      antialias:  true,
      background: '#05050f',
      // Force WebGL2 — background shaders use GLSL only (no WebGPU/WGSL variant).
      preference: 'webgl',
    })

    // ─── World container (camera space) ────────────────────────────────────
    this.worldContainer = new Container()
    this.app.stage.addChild(this.worldContainer)

    // ─── Parallax background (3 procedural GLSL shader layers) ─────────────
    // Inserted at stage indices 0-2, behind worldContainer.
    this.bgRenderer.init(this.app, this.app.stage)

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
    this.bgRenderer.resize(this.app.screen.width, this.app.screen.height)
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
    for (const s of this.propSprites) this.worldContainer.removeChild(s)
    this.propSprites = []

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

    // ─── Props ──────────────────────────────────────────────────────────────
    const [arrowTex, ringTex] = await Promise.all([
      Assets.load('/assets/textures/ArrowUp.png'),
      Assets.load('/assets/textures/Ring128.png'),
    ])

    for (const prop of level.Props) {
      const sprites = this.createPropSprites(prop, arrowTex, ringTex)
      for (const s of sprites) {
        this.worldContainer.addChildAt(s, 0)
        this.propSprites.push(s)
      }
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

  /**
   * Create prop sprites.
   * Boost:     white ring (r=2u) + green arrow oriented along prop's local +Y.
   * Attractor: red ring (r=2u).
   * Repulsor:  green ring (r=2u).
   *
   * Ring texture is Ring128.png; scaled to diameter = 2*radius*PPU pixels.
   * Arrow texture is ArrowUp.png; displayed at 1×1 unity unit, rotated by prop angle.
   */
  private createPropSprites(prop: Prop, arrowTex: Texture, ringTex: Texture): Sprite[] {
    const { x, y } = worldToLocal(prop.Transform.Position.x, prop.Transform.Position.y)
    const gameAngle = quatToAngle(prop.Transform.Rotation)

    // Boost:     root scale (1,1) × m_Radius 2 → world r=2 → diameter=4u
    // Attractor: root scale (2,2) × m_Radius 2 → world r=4 → diameter=8u
    // Repulsor:  root scale (1,1) × m_Radius 2 → world r=2 → diameter=4u
    const ringDiameter = prop.Type === 'Attractor'
      ? 2 * 4 * PIXELS_PER_UNIT   // r=4
      : 2 * 2 * PIXELS_PER_UNIT   // r=2 (Boost and Repulsor)
    const result: Sprite[] = []

    // ── Ring (influence area indicator) ──────────────────────────────────
    const ring = new Sprite(ringTex)
    ring.anchor.set(0.5)
    ring.width = ringDiameter
    ring.height = ringDiameter
    ring.position.set(x, y)
    if (prop.Type === 'Boost') {
      ring.tint = 0xFFFFFF   // white ring for Boost
      ring.alpha = 0.45
    } else if (prop.Type === 'Attractor') {
      ring.tint = 0xFF2222   // red ring for Attractor
      ring.alpha = 0.55
    } else {
      ring.tint = 0x22FF44   // green ring for Repulsor
      ring.alpha = 0.55
    }
    result.push(ring)

    // ── Arrow (Boost only) ───────────────────────────────────────────────
    if (prop.Type === 'Boost') {
      const arrow = new Sprite(arrowTex)
      arrow.anchor.set(0.5)
      arrow.width = PIXELS_PER_UNIT        // 1×1 unity unit
      arrow.height = PIXELS_PER_UNIT
      arrow.position.set(x, y)
      arrow.rotation = gameAngleToPixi(gameAngle)
      arrow.tint = 0x44FF88               // green arrow
      arrow.alpha = 0.92
      result.push(arrow)
    }

    return result
  }

  /** Store the latest input so render() can drive thruster FX. */
  setInput(input: InputState): void {
    this.lastInput = input
  }

  /**
   * Render one frame given the current physics state.
   * Called after physics has been stepped.
   */
  // ─── Camera / zoom config ─────────────────────────────────────────────────
  // Set ZOOM_ENABLED = false to disable speed-based zoom out entirely.
  private static readonly ZOOM_ENABLED = true

  // ─── Cinemachine-style camera state ──────────────────────────────────────
  // - smoothedPos: exponential follow of ship.pos (snappy, DAMPING=0.12s)
  // - smoothedVel: exponential follow of ship.vel (~0.5s) — damps collision spikes
  // - smoothedZoom: exponential follow of target zoom scale (~0.4s)
  private smoothedPos  = { x: 0, y: 0 }
  private smoothedVel  = { x: 0, y: 0 }
  private smoothedZoom = 1.0
  private cameraReady  = false
  private lastRenderTime = 0

  render(ship: ShipState): void {
    const W = this.app.screen.width
    const H = this.app.screen.height

    // ─── Delta time ────────────────────────────────────────────────────────
    const now = performance.now()
    const dt  = this.lastRenderTime > 0 ? Math.min((now - this.lastRenderTime) / 1000, 0.1) : 0
    this.lastRenderTime = now

    // ─── Smooth position + velocity ────────────────────────────────────────
    const POS_DAMPING   = 0.12  // s — snappy position follow
    const VEL_SMOOTHING = 0.5   // s — damps collision-induced velocity spikes
    if (!this.cameraReady) {
      this.smoothedPos.x  = ship.pos.x
      this.smoothedPos.y  = ship.pos.y
      this.smoothedVel.x  = ship.vel.x
      this.smoothedVel.y  = ship.vel.y
      this.smoothedZoom   = 1.0
      this.cameraReady    = true
    } else {
      const kp = 1 - Math.exp(-dt / POS_DAMPING)
      this.smoothedPos.x += (ship.pos.x - this.smoothedPos.x) * kp
      this.smoothedPos.y += (ship.pos.y - this.smoothedPos.y) * kp
      const kv = 1 - Math.exp(-dt / VEL_SMOOTHING)
      this.smoothedVel.x += (ship.vel.x - this.smoothedVel.x) * kv
      this.smoothedVel.y += (ship.vel.y - this.smoothedVel.y) * kv
    }

    // ─── Speed-based zoom (ZoomCurve from ShipCamera.prefab) ──────────────
    // ZoomCurve: speed 0→5 u/s maps to ortho-size offset 0→5 (nearly linear).
    // Base ortho = 6. Scale factor = 6 / (6 + offset).
    // At speed=0: scale=1.0 (no zoom). At speed=5+: scale=6/11≈0.545 (zoomed out).
    // Uses smoothedVel magnitude so collisions don't cause zoom spikes.
    const BASE_ORTHO = 6
    const ZOOM_SPEED_MAX = 5   // u/s at which max zoom-out is reached
    const ZOOM_DAMPING = 0.4   // s — how fast zoom transitions

    let zoomScale = 1.0
    if (GameRenderer.ZOOM_ENABLED) {
      const speed = Math.sqrt(this.smoothedVel.x ** 2 + this.smoothedVel.y ** 2)
      const zoomOffset = Math.min(speed, ZOOM_SPEED_MAX)   // linear, matches ZoomCurve
      const targetZoom = BASE_ORTHO / (BASE_ORTHO + zoomOffset)
      const kz = 1 - Math.exp(-dt / ZOOM_DAMPING)
      this.smoothedZoom += (targetZoom - this.smoothedZoom) * kz
      zoomScale = this.smoothedZoom
    }
    this.worldContainer.scale.set(zoomScale)

    // ─── Lookahead + soft-zone clamp ───────────────────────────────────────
    const LOOKAHEAD = 0.5   // m_LookaheadTime
    const SOFT_ZONE = 0.35  // fraction of half-screen each axis (m_SoftZoneWidth=0.3)

    let laX = this.smoothedVel.x * LOOKAHEAD
    let laY = this.smoothedVel.y * LOOKAHEAD

    // Clamp in world units so ship stays within SOFT_ZONE of screen center.
    // Divide by zoomScale because zooming out makes the visible world larger.
    const halfW = (W / 2) / (PIXELS_PER_UNIT * zoomScale)
    const halfH = (H / 2) / (PIXELS_PER_UNIT * zoomScale)
    laX = Math.max(-halfW * SOFT_ZONE, Math.min(halfW * SOFT_ZONE, laX))
    laY = Math.max(-halfH * SOFT_ZONE, Math.min(halfH * SOFT_ZONE, laY))

    const cameraX = this.smoothedPos.x + laX
    const cameraY = this.smoothedPos.y + laY
    // worldContainer is scaled by zoomScale, so world-space pixel coords are
    // multiplied by zoomScale when placed on screen.
    const camPx = cameraX * PIXELS_PER_UNIT * zoomScale
    const camPy = -cameraY * PIXELS_PER_UNIT * zoomScale
    this.worldContainer.position.set(W / 2 - camPx, H / 2 - camPy)

    // Scroll all three background layers using world-space camera position.
    this.bgRenderer.update(cameraX, cameraY, W, H)

    // ─── Ship sprite + shield rings (world-space positions in worldContainer) ─
    const shipScreenX = ship.pos.x * PIXELS_PER_UNIT
    const shipScreenY = -ship.pos.y * PIXELS_PER_UNIT
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
    this.bgRenderer.destroy()
    this.app.destroy()
  }
}
