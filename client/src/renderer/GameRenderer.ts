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
import { loadShipData } from '../data/ships'
import { BackgroundRenderer } from './BackgroundRenderer'
import { PropParticleFX } from './PropParticleFX'

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

/** Clamp-normalised lerp factor: 0 when v<=a, 1 when v>=b. */
function inverseLerp(a: number, b: number, v: number): number {
  return b !== a ? Math.max(0, Math.min(1, (v - a) / (b - a))) : 0
}

/** One decoded state snapshot stored in the jitter buffer. */
interface BufferedState {
  posX: number; posY: number
  angle: number
  serverTimeMs: number
  input: InputState
}

interface RemotePlayerView {
  shipSprite:   Sprite
  nameLabel:    Text
  shieldSprite: Sprite
  thrusterFX:   ThrusterFX
  // ── Jitter buffer (ANXRacers-style adaptive playback) ──────────────────
  /** FIFO queue of incoming state snapshots, capped at BUFFER_MAX. */
  buffer:        BufferedState[]
  /** Last dequeued state — interpolation "from" point. */
  currentState:  BufferedState | null
  /** Virtual clock that advances at timespeed × real-dt. */
  virtualTimeMs: number
  /** Playback rate: <1 slows down when buffer is thin, >1 speeds up when full. */
  timespeed:     number
  lastInput:     InputState
}

export class GameRenderer {
  app!: Application
  private worldContainer!: Container
  private bgRenderer = new BackgroundRenderer()
  private shipSprite!: Sprite
  private obstacleSprites: Sprite[] = []
  private propSprites: Sprite[] = []
  private thrusterFX!: ThrusterFX
  private propParticles = new PropParticleFX()
  private shieldSprite!: Sprite          // static ring, always visible
  private shieldHitSprites: Sprite[] = []   // 3 round-robin collision ring instances
  private shieldHitAlphas: number[] = []    // per-instance fade state
  private shieldHitIdx = 0                  // next instance to use
  private cometSprite!: Sprite             // drift comet trail
  private cometAlpha = 0                   // smoothed target alpha
  private lastInput: InputState = { torque: 0, surge: 0, strafe: 0 }
  // Remote players keyed by MPId
  private remoteShipTextures: Map<string, Texture> = new Map()
  private remotePlayers: Map<number, RemotePlayerView> = new Map()
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

    // ─── Comet trail (drift FX) — behind ship, anchor at circular head ──────
    const cometTexture = await Assets.load('/assets/textures/Comet300.png')
    this.cometSprite = new Sprite(cometTexture)
    // Anchor at center of circular top: (0.5, radius/height) where radius = width/2
    this.cometSprite.anchor.set(0.5, cometTexture.width / (2 * cometTexture.height))
    this.cometSprite.alpha = 0
    this.worldContainer.addChild(this.cometSprite)

    // ─── Thruster FX — parented to shipSprite so it inherits its transform ──
    this.thrusterFX = new ThrusterFX(this.shipSprite)
    await this.thrusterFX.init()

    // ─── Prop particle FX — texture generated here; container z-ordered in loadLevel ──
    await this.propParticles.init(this.app)

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

  /** Drive the comet trail opacity. score 0–1 from drift calculation. */
  setDrift(score: number): void {
    this.cometAlpha = Math.max(0, Math.min(1, score))
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

    // ─── Particle FX container ─ inserted at the very bottom so particles
    // appear behind prop rings, obstacles, and the ship. ──────────────────
    if (this.propParticles.container.parent) {
      this.propParticles.container.parent.removeChild(this.propParticles.container)
    }
    this.worldContainer.addChildAt(this.propParticles.container, 0)
    this.propParticles.loadLevel(level.Props)
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
  private prevSpeed  = 0
  private prevAngVel = 0
  /** Last server time received — used to interpolate remote players. */
  serverTimeMs = 0

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
    // LOOKAHEAD: how far ahead of the ship (in seconds of travel) the camera
    //   tries to look. Raw desired camera = smoothedPos + vel * LOOKAHEAD.
    //
    // SOFT_ZONE: the ship must always land within this fraction of the half-screen
    //   from the camera centre. We clamp the *camera position* — not just the
    //   lookahead offset — so that the ship stays inside the zone regardless of
    //   how much smoothedPos lags behind the actual ship position.
    //
    //   Screen half-extents in world units (accounts for zoom):
    //     halfW = (W/2) / (PPU * zoom)
    //   Soft zone radius:
    //     softW = halfW * SOFT_ZONE
    //   Camera is clamped so that:
    //     ship.pos - softW  <=  cameraX  <=  ship.pos + softW
    //   This guarantees the ship stays within SOFT_ZONE * half-screen pixels of
    //   centre at any zoom level.
    const LOOKAHEAD = 0.5    // m_LookaheadTime
    const SOFT_ZONE = 0.35   // fraction of half-screen each axis

    // Desired camera target: smoothedPos pushed ahead by velocity.
    // Uses smoothedVel so collision spikes don't snap the camera.
    const desiredCamX = this.smoothedPos.x + this.smoothedVel.x * LOOKAHEAD
    const desiredCamY = this.smoothedPos.y + this.smoothedVel.y * LOOKAHEAD

    // Soft-zone radius in world units (scales with zoom so pixel bound is constant).
    const halfW = (W / 2) / (PIXELS_PER_UNIT * zoomScale)
    const halfH = (H / 2) / (PIXELS_PER_UNIT * zoomScale)
    const softW = halfW * SOFT_ZONE
    const softH = halfH * SOFT_ZONE

    // Clamp camera so ship.pos stays within the soft zone.
    const cameraX = Math.max(ship.pos.x - softW, Math.min(ship.pos.x + softW, desiredCamX))
    const cameraY = Math.max(ship.pos.y - softH, Math.min(ship.pos.y + softH, desiredCamY))
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

    // ─── Comet trail — oriented in velocity direction, tail drags behind ─────
    // Sprite anchor is at the circular head; head placed at ship center.
    // rotation: sprite local +Y points in velocity direction (screen-space).
    // gameAngleToPixi(atan2(vx, vy)) maps world-up velocity to screen rotation.
    {
      const speed2d = Math.sqrt(ship.vel.x ** 2 + ship.vel.y ** 2)
      const FADE_IN  = 6.0   // alpha units/s — fast in
      const FADE_OUT = 2.5   // alpha units/s — slower out
      const target = this.cometAlpha
      const prev   = this.cometSprite.alpha
      const rate   = target > prev ? FADE_IN : FADE_OUT
      this.cometSprite.alpha = prev + (target - prev) * Math.min(1, rate * dt)
      this.cometSprite.position.set(shipScreenX, shipScreenY)
      if (speed2d > 0.01) {
        this.cometSprite.rotation = Math.atan2(ship.vel.x, ship.vel.y)
      }
      // Scale with speed: comet grows slightly as ship moves faster
      const s = 1 + Math.min(1, speed2d / 10) * 0.4
      this.cometSprite.scale.set(s * PIXELS_PER_UNIT / 128, s * PIXELS_PER_UNIT / 128)
    }

    // Collision rings: each fades independently
    for (let i = 0; i < this.shieldHitSprites.length; i++) {
      const s = this.shieldHitSprites[i]
      s.position.set(shipScreenX, shipScreenY)
      if (this.shieldHitAlphas[i] > 0) {
        this.shieldHitAlphas[i] = Math.max(0, this.shieldHitAlphas[i] - 0.06)
        s.alpha = this.shieldHitAlphas[i]
      }
    }

    // ─── Remote players ────────────────────────────────────────────────────
    this.renderRemotePlayers(this.serverTimeMs, dt)

    // ─── Prop particle FX ────────────────────────────────────────────────────
    this.propParticles.update(dt)

    // ─── Thruster FX (parented to shipSprite — position/rotation inherited) ─
    this.thrusterFX.update(this.lastInput, dt)

    // ─── Debug text ────────────────────────────────────────────────────────
    const speed    = Math.sqrt(ship.vel.x ** 2 + ship.vel.y ** 2)
    const accel    = dt > 0 ? (speed - this.prevSpeed) / dt : 0
    const angDeg   = (ship.angle  * 180) / Math.PI
    const omegaDeg = (ship.angVel * 180) / Math.PI
    const alphaDeg = dt > 0 ? ((ship.angVel - this.prevAngVel) * 180) / Math.PI / dt : 0
    this.prevSpeed  = speed
    this.prevAngVel = ship.angVel
    this.debugText.text =
      `pos: (${ship.pos.x.toFixed(1)}, ${ship.pos.y.toFixed(1)})  spd: ${speed.toFixed(1)} u/s  accel: ${accel.toFixed(1)} u/s²\n` +
      `ang: ${angDeg.toFixed(0)}°  ω: ${omegaDeg.toFixed(1)}°/s  α: ${alphaDeg.toFixed(1)}°/s²`
  }

  // ─── Remote player management ─────────────────────────────────────────────

  /** Load a ship texture by skinId (cached). */
  private async loadRemoteTexture(skinId: string): Promise<Texture> {
    if (!this.remoteShipTextures.has(skinId)) {
      const tex = await Assets.load(`/assets/ships/${skinId}.png`)
      this.remoteShipTextures.set(skinId, tex)
    }
    return this.remoteShipTextures.get(skinId)!
  }

  async addRemotePlayer(mpId: number, displayName: string, skinId: string): Promise<void> {
    if (this.remotePlayers.has(mpId)) return

    const tex = await this.loadRemoteTexture(skinId)

    // Load ship data to get the real collision radius (same as local player)
    let shieldRadius = 0.63  // safe fallback
    try {
      const shipData = await loadShipData(skinId)
      shieldRadius = shipData.ShipDetails.Radius
    } catch { /* unknown ship — keep fallback */ }

    // Shield ring
    const shieldTex = await Assets.load('/assets/textures/Shield128.png')
    const shield = new Sprite(shieldTex)
    shield.anchor.set(0.5)
    shield.tint = 0x4488ff
    shield.alpha = 0.6
    shield.width = shield.height = shieldRadius * 2 * PIXELS_PER_UNIT

    const ship = new Sprite(tex)
    ship.anchor.set(0.5)
    ship.width = ship.height = PIXELS_PER_UNIT

    // Insert both below the local ship sprite so local player is always on top
    const localShipIdx = this.worldContainer.children.indexOf(this.shipSprite)
    this.worldContainer.addChildAt(ship,   localShipIdx)
    this.worldContainer.addChildAt(shield, localShipIdx)

    // Thruster FX parented to remote ship sprite
    const thrusterFX = new ThrusterFX(ship)
    await thrusterFX.init()
    thrusterFX.setParentScale(ship.scale.x, ship.scale.y)
    // Load skin data for this ship
    try {
      const skinData: ShipSkinData = await Assets.load(`/assets/ships/${skinId}.skin.json`)
      thrusterFX.loadSkin(skinData)
    } catch { /* no skin data — thrusters stay empty */ }

    const label = new Text({
      text: displayName,
      style: new TextStyle({ fill: '#ccddff', fontSize: 11, fontFamily: 'monospace' }),
    })
    label.anchor.set(0.5, 1)
    this.app.stage.addChild(label)

    const deadInput: InputState = { torque: 0, surge: 0, strafe: 0 }
    this.remotePlayers.set(mpId, {
      shipSprite:   ship,
      shieldSprite: shield,
      nameLabel:    label,
      thrusterFX,
      buffer:        [],
      currentState:  null,
      virtualTimeMs: 0,
      timespeed:     1,
      lastInput:     { ...deadInput },
    })
  }

  removeRemotePlayer(mpId: number): void {
    const v = this.remotePlayers.get(mpId)
    if (!v) return
    v.thrusterFX.destroy()
    this.worldContainer.removeChild(v.shipSprite)
    this.worldContainer.removeChild(v.shieldSprite)
    this.app.stage.removeChild(v.nameLabel)
    this.remotePlayers.delete(mpId)
  }

  // Maximum number of states held per remote player (~1.4 s at 22 Hz)
  private static readonly BUFFER_MAX = 30

  /**
   * Feed a server-broadcast state snapshot for one remote player.
   * Called when a PlayerStates packet arrives.
   */
  receiveRemoteState(mpId: number, posX: number, posY: number, angle: number, serverTimeMs: number, input: InputState): void {
    const v = this.remotePlayers.get(mpId)
    if (!v) return
    if (v.buffer.length >= GameRenderer.BUFFER_MAX) v.buffer.shift()
    v.buffer.push({ posX, posY, angle, serverTimeMs, input })
  }

  /**
   * Render all remote players using a jitter-buffer with adaptive playback speed.
   *
   * Ported from ANXRacers RemotePlayer.cs (FixedUpdate + ApplyState):
   * - Each remote player maintains a FIFO buffer of received state snapshots.
   * - A per-player virtual clock (`virtualTimeMs`) advances at `timespeed × dt`.
   * - `timespeed` is adjusted each frame based on buffer health:
   *     low buffer  → slow down (< 1×) to avoid running out of states
   *     full buffer → speed up  (> 1×) to drain the backlog
   * - States are dequeued when virtualTimeMs passes the front of the buffer;
   *   the renderer interpolates between the last dequeued state and the next.
   */
  private renderRemotePlayers(_serverTimeMs: number, dt: number): void {
    // Target number of buffered states (~135 ms at 22 Hz send rate)
    const TARGET    = 3
    const TARGET_HI = TARGET + 6  // above this: max 2× speed-up
    const TARGET_LO = TARGET - 3  // below this: approaching full stop

    for (const v of this.remotePlayers.values()) {
      // ── Bootstrap: wait until we have at least 2 states ─────────────────
      if (v.currentState === null) {
        if (v.buffer.length < 2) continue
        v.currentState  = v.buffer.shift()!
        v.virtualTimeMs = v.currentState.serverTimeMs
      }

      // ── Adaptive playback speed based on buffer health ───────────────────
      // Mirrors the ANXRacers Mathf.InverseLerp logic exactly.
      const h = v.buffer.length
      if (h > TARGET) {
        v.timespeed = 1 + inverseLerp(TARGET, TARGET_HI, h)  // 1× → 2×
      } else if (h < TARGET) {
        v.timespeed = 1 - (1 - inverseLerp(TARGET_LO, TARGET, h))  // ~0× → 1×
      } else {
        v.timespeed = 1
      }

      // ── Advance virtual clock ─────────────────────────────────────────────
      v.virtualTimeMs += dt * 1000 * v.timespeed

      // ── Drain: advance currentState while virtual time has passed it ──────
      // Shift buffer[0] → currentState only when virtualTime has moved past it,
      // so buffer[0] always remains the "next" interpolation target.
      while (v.buffer.length > 0 && v.virtualTimeMs > v.buffer[0].serverTimeMs) {
        v.currentState = v.buffer.shift()!
      }

      // ── Interpolate between currentState and buffer[0] ───────────────────
      let posX  = v.currentState.posX
      let posY  = v.currentState.posY
      let angle = v.currentState.angle
      let inputTarget = v.currentState.input

      if (v.buffer.length > 0) {
        const next = v.buffer[0]
        const gap  = next.serverTimeMs - v.currentState.serverTimeMs
        const ratio = gap > 0
          ? Math.max(0, Math.min(1, (v.virtualTimeMs - v.currentState.serverTimeMs) / gap))
          : 0
        posX  = v.currentState.posX  + (next.posX  - v.currentState.posX)  * ratio
        posY  = v.currentState.posY  + (next.posY  - v.currentState.posY)  * ratio
        let da = next.angle - v.currentState.angle
        while (da >  Math.PI) da -= Math.PI * 2
        while (da < -Math.PI) da += Math.PI * 2
        angle = v.currentState.angle + da * ratio
        inputTarget = next.input
      }

      // ── Apply to sprites ──────────────────────────────────────────────────
      const sx = posX * PIXELS_PER_UNIT
      const sy = -posY * PIXELS_PER_UNIT
      v.shipSprite.position.set(sx, sy)
      v.shipSprite.rotation = gameAngleToPixi(angle)
      v.shieldSprite.position.set(sx, sy)

      // Smooth thruster input (~80 ms exp lag) so FX don't snap between states
      const LI = 1 - Math.exp(-dt / 0.08)
      v.lastInput.surge  += (inputTarget.surge  - v.lastInput.surge)  * LI
      v.lastInput.strafe += (inputTarget.strafe - v.lastInput.strafe) * LI
      v.lastInput.torque += (inputTarget.torque - v.lastInput.torque) * LI
      v.thrusterFX.update(v.lastInput, dt)

      // Name label: project world → screen
      const wx = this.worldContainer.position.x + sx * this.worldContainer.scale.x
      const wy = this.worldContainer.position.y + sy * this.worldContainer.scale.y
      const labelOffsetY = -PIXELS_PER_UNIT * 0.9 * this.worldContainer.scale.y
      v.nameLabel.position.set(wx, wy + labelOffsetY)
    }
  }

  destroy(): void {
    this.thrusterFX.destroy()
    this.propParticles.destroy()
    this.bgRenderer.destroy()
    for (const v of this.remotePlayers.values()) {
      v.thrusterFX.destroy()
      this.worldContainer.removeChild(v.shipSprite)
      this.worldContainer.removeChild(v.shieldSprite)
      this.app.stage.removeChild(v.nameLabel)
    }
    this.remotePlayers.clear()
    this.app.destroy()
  }
}
