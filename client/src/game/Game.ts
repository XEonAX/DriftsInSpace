import { GameRenderer } from '../renderer/GameRenderer'
import { InputManager } from '../input/InputManager'
import { stepShip, createShipState, FIXED_DT } from '../physics/ShipPhysics'
import type { ShipState } from '../physics/ShipPhysics'
import { loadShipData } from '../data/ships'
import { loadLevel, DEFAULT_LEVEL_ID, checkpointRadius, buildCheckpointRoute } from '../data/levels'
import type { ObstacleTransform } from '../data/levels'
import { buildColliders, buildForceZones, resolveCollisions, applyForceZones, applyProps, initialPropState, frictionToMaterial } from '../physics/Collision'
import type { ObstacleCollider, ForceZone, PropState } from '../physics/Collision'
import type { Prop } from '../data/levels'
import { AudioManager } from '../audio/AudioManager'
import type { CollisionMaterial } from '../audio/AudioManager'
import { NetClient } from '../net/NetClient'
import { TouchOverlay } from '../input/TouchOverlay'

export class Game {
  private renderer = new GameRenderer()
  private input = new InputManager()
  private audio = new AudioManager()
  private touchOverlay = new TouchOverlay()
  private shipState: ShipState = createShipState()
  private accumulator = 0
  private lastTime = 0
  private rafId = 0
  private running = false
  private shipId: string
  private skinId: string
  private colliders: ObstacleCollider[] = []
  private forceZones: ForceZone[] = []
  private props: Prop[] = []
  private propState: PropState = initialPropState()
  // ── Checkpoint route ───────────────────────────────────────────────────────
  private route: Array<{ transform: ObstacleTransform; originalIdx: number }> = []
  private cpRadius = 2                      // Unity units; set from level difficulty
  private routeIdx  = 0                     // index into route[] of the next checkpoint to hit
  private raceFinished = false
  private passedCheckpoints = new Set<number>()  // original indices already triggered
  private lastPassedIdx = -1                     // original index most recently triggered
  private audioStarted = false
  private net = new NetClient()
  private netTick = 0
  private readonly displayName: string
  // ── Race timer + lap tracking ─────────────────────────────────────────────────
  private raceStartTime = -1    // rAF timestamp when countdown ends
  private raceEndTime   = 0     // rAF timestamp when race finished
  private trackLaps     = 1     // total laps (≥1)
  private trackCpCount  = 0     // checkpoints per lap
  private countdownSec  = 3.0   // counts down to 0; goes slightly negative for GO! display
  private _loopTimestamp = 0    // current rAF timestamp, available to helpers

  constructor(shipId: string, skinId: string, displayName: string) {
    this.shipId = shipId
    this.skinId = skinId
    this.displayName = displayName
  }

  async start(): Promise<void> {
    // Unlock AudioContext immediately — start() is called from a user gesture (ShipPicker click).
    this.audioStarted = true
    void this.audio.init()

    // Create and attach canvas
    const canvas = document.createElement('canvas')
    canvas.id = 'game-canvas'
    document.body.appendChild(canvas)

    await this.renderer.init(canvas, this.skinId)
    await this.touchOverlay.init(this.renderer.app)
    if (TouchOverlay.isTouchDevice()) {
      this.input.setHitTester(this.touchOverlay)
    }

    // Load ship physics data + skin
    const shipData = await loadShipData(this.shipId)
    this.renderer.setShipRadius(shipData.ShipDetails.Radius)
    await this.renderer.loadSkin(this.skinId)

    // Load the default level
    const level = await loadLevel(DEFAULT_LEVEL_ID)
    await this.renderer.loadLevel(level)
    this.colliders = buildColliders(level.Obstacles)
    this.forceZones = buildForceZones(level.Obstacles)
    this.props = level.Props
    this.propState = initialPropState()

    // ── Checkpoint route ─────────────────────────────────────────────────────
    this.route            = buildCheckpointRoute(level.Track)
    this.cpRadius         = checkpointRadius(level.Track.Difficulty)
    this.routeIdx         = 0
    this.raceFinished     = false
    this.passedCheckpoints = new Set<number>()
    this.lastPassedIdx     = -1
    this.renderer.setCheckpointState(this.route[0]?.originalIdx ?? -1, this.passedCheckpoints, -1)

    // ── Race timer init ───────────────────────────────────────────────────────────
    this.raceStartTime  = -1
    this.raceEndTime    = 0
    this.countdownSec   = 3.0
    this.trackLaps      = Math.max(1, level.Track.Laps)
    this.trackCpCount   = Math.max(1, level.Track.Checkpoints.length)

    // Handle window resize
    window.addEventListener('resize', () => {
      this.renderer.resizeBg()
      // Defer overlay rebuild one frame so PixiJS has updated app.screen first
      requestAnimationFrame(() => this.touchOverlay.onResize())
    })

    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.countdownLoop)

    const details = shipData.ShipDetails

    // Store details for use in loop
    this._details = details

    // Connect to multiplayer server (non-blocking — game works offline too)
    const userId = this.getOrCreateUserId()
    const wsUrl  = import.meta.env.VITE_WS_URL as string | undefined ?? 'ws://localhost:5839/ws'
    this.net.connect(wsUrl, userId, this.displayName, this.shipId, {
      onGalaxy: async (data) => {
        for (const p of data.players) {
          await this.renderer.addRemotePlayer(p.mpId, p.displayName, p.skinId)
        }
      },
      onPlayerStates: (data) => {
        this.renderer.serverTimeMs = data.serverTimeMs
        for (const s of data.states) {
          if (s.mpId === this.net.myMPId) continue
          this.renderer.receiveRemoteState(
            s.mpId,
            s.posX / 1000, s.posY / 1000,
            s.angle / 1000,
            data.serverTimeMs,
            { surge: s.surge / 100, strafe: s.strafe / 100, torque: s.turn / 100 },
          )
        }
      },
      onPlayerJoin: async (player) => {
        await this.renderer.addRemotePlayer(player.mpId, player.displayName, player.skinId)
      },
      onPlayerLeft: (mpId) => {
        this.renderer.removeRemotePlayer(mpId)
      },
      onDisconnected: () => {
        console.log('Disconnected from server')
      },
    })
  }

  // Stored after init — avoids closure allocation in loop
  private _details: import('../data/ships').ShipDetails | null = null

  private prevShipState: ShipState = createShipState()

  /** Runs during the 3-second countdown: ticks the display, renders the static scene, no physics/audio. */
  private countdownLoop = (timestamp: number): void => {
    if (!this.running) return
    const elapsed = Math.min((timestamp - this.lastTime) / 1000, 0.1)
    this.lastTime = timestamp
    this.countdownSec -= elapsed
    this.renderer.setCountdown(this.countdownSec)
    this.renderer.render(this.shipState)
    this.touchOverlay.setStyle(this.input.currentTouchStyle)
    this.touchOverlay.update(0, false, false)
    if (this.countdownSec <= -0.7) {
      // Hand off to the main loop
      this.renderer.setCountdown(-1)
      this.raceStartTime  = timestamp
      this.lastTime       = timestamp
      this.accumulator    = 0
      this.prevShipState  = this.shipState
      this.rafId = requestAnimationFrame(this.loop)
    } else {
      this.rafId = requestAnimationFrame(this.countdownLoop)
    }
  }

  private loop = (timestamp: number): void => {
    if (!this.running) return

    this._loopTimestamp = timestamp
    const elapsed = Math.min((timestamp - this.lastTime) / 1000, 0.1) // cap at 100ms
    this.lastTime = timestamp

    this.accumulator += elapsed

    const details = this._details
    if (details) {
      while (this.accumulator >= FIXED_DT) {
        this.prevShipState = this.shipState
        this.input.setShipAngle(this.shipState.angle)
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
        this.checkCheckpoint()
        this.accumulator -= FIXED_DT
        // Send our state to the server every physics tick (50 Hz)
        this.net.sendShipUpdate(
          this.netTick++,
          this.shipState.pos.x, this.shipState.pos.y,
          this.shipState.angle,
          this.shipState.vel.x, this.shipState.vel.y,
          this.shipState.angVel,
          input.surge, input.strafe, input.torque,
        )
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
    // ── Stats HUD ────────────────────────────────────────────────────────────────────
    const raceTimeMs = this.raceStartTime < 0
      ? 0
      : this.raceFinished
        ? this.raceEndTime - this.raceStartTime
        : timestamp - this.raceStartTime
    const currentLap   = Math.min(this.trackLaps, Math.floor(this.routeIdx / this.trackCpCount) + 1)
    this.renderer.setHudStats(currentLap, this.trackLaps, raceTimeMs)
    // ── Touch overlay visual update ───────────────────────────────────────
    this.touchOverlay.setStyle(this.input.currentTouchStyle)
    if (this.input.hasTouches) {
      const ts = this.input.getTouchState()
      this.touchOverlay.update(ts.surge, ts.leftPressed, ts.rightPressed, ts.joystickDelta)
    } else {
      this.touchOverlay.update(0, false, false)
    }

    // ── Engine audio (every frame, uses smoothed input) ──────────────────
    if (this.audioStarted) {
      const input = this.input.getInput()
      const speed = Math.sqrt(curr.vel.x ** 2 + curr.vel.y ** 2)
      this.audio.updateEngine(input, speed, curr.angVel, elapsed)

      // Drift score: |heading × vel_normalized| — 0 when aligned, 1 at 90° sideslip.
      // Weighted by speed so slow ships don't trigger it (ramp 0→1 from 1–5 u/s).
      // Forward world vector = (-sin(a), cos(a)) — matches ShipPhysics rotation matrix.
      const hx = -Math.sin(curr.angle)   // heading vector (angle=0 → +Y)
      const hy =  Math.cos(curr.angle)
      let driftScore = 0
      if (speed > 0.5) {
        const vxn = curr.vel.x / speed
        const vyn = curr.vel.y / speed
        const cross = hx * vyn - hy * vxn        // sin(angle between heading and vel)
        const speedW = Math.max(0, Math.min(1, (speed - 1) / 4))   // 0 at 1 u/s, 1 at 5 u/s
        const surge = Math.max(0, Math.min(1, input.surge))
        driftScore = Math.abs(cross) * speedW * surge
      }
      this.audio.setDrift(driftScore)
      this.renderer.setDrift(driftScore)

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

  private checkCheckpoint(): void {
    if (this.raceFinished || this.route.length === 0) return
    const target = this.route[this.routeIdx]
    const dx = this.shipState.pos.x - target.transform.Position.x
    const dy = this.shipState.pos.y - target.transform.Position.y
    if (dx * dx + dy * dy > this.cpRadius * this.cpRadius) return

    this.lastPassedIdx = target.originalIdx
    this.passedCheckpoints.add(target.originalIdx)
    this.routeIdx++
    const finished = this.routeIdx >= this.route.length
    if (finished) {
      this.raceFinished = true
      this.raceEndTime  = this._loopTimestamp
      console.log('Race finished!')
    }
    this.audio.playCheckpoint(finished ? 1.5 : 1.0)
    const nextOriginalIdx = finished ? -1 : this.route[this.routeIdx].originalIdx
    this.renderer.setCheckpointState(nextOriginalIdx, this.passedCheckpoints, this.lastPassedIdx)
  }

  /** Stable anonymous user ID, stored in localStorage. */
  private getOrCreateUserId(): string {
    const key = 'drifts_user_id'
    let id = localStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(key, id)
    }
    return id
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.input.destroy()
    this.net.disconnect()
    this.renderer.destroy()
    this.audio.destroy()
    this.touchOverlay.destroy()
  }
}
