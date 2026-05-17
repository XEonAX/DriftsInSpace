/**
 * AudioManager — Web Audio API sound system for DriftsInSpace.
 *
 * Engine sound — ports Spaceship.cs Update() audio logic exactly:
 *   enginePower  = lerp(enginePower, clamp(surge, 0, 1) * 0.5,  dt * 3)
 *   volume       = enginePower + 0.3
 *   pitch        = enginePower + 1.0 − 0.5 / (1 + speed*0.5 + |angVel|*0.5)
 *
 * Collision sounds — ports SpaceshipCollsions.cs ProcessCollision():
 *   vol = 1 − 1 / (1 + relativeVelocity.magnitude)
 *   pitch randomised in [0.5, 1.5]
 *   Separate clips for Rock / Metal / Ice.
 *
 * Prop sounds:
 *   Boost:    boostEngine.ogg looping, volume = proximity t∈[0,1] where
 *             t=0 at zone edge (r=2), t=1 at center. Fades to 0 outside zone.
 *   Attractor: forceField_000.ogg, looping while inside
 *   Repulsor: zap2.ogg, looping while inside
 */

import type { InputState } from '../physics/ShipPhysics'

// ─── Audio file paths ──────────────────────────────────────────────────────
const SOUNDS = {
  engine:          '/assets/sounds/engine.ogg',
  collisionRock:   '/assets/sounds/collision_rock.ogg',
  collisionMetal:  '/assets/sounds/collision_metal.ogg',
  collisionIce:    '/assets/sounds/collision_ice.ogg',
  boostEngine:     '/assets/sounds/boostEngine.ogg',
  attractorEngine: '/assets/sounds/attractorEngine.ogg',
  repulsorEngine:  '/assets/sounds/repulsorEngine.ogg',
  driftLoop:       '/assets/sounds/driftLoop.ogg',
  driftStart:      '/assets/sounds/driftStart.ogg',
  driftFlow:       '/assets/sounds/driftFlow.ogg',
  checkpoint:      '/assets/sounds/checkpoint.ogg',
} as const

// ─── Volume constants (master mixing levels) ──────────────────────────────
const ENGINE_MASTER    = 0.6   // Unity AudioMixer group scale (engine channel)
const COLLISION_MASTER = 0.9
const PROP_MASTER      = 0.7
const DRIFT_MASTER     = 0.45  // drift is prominent but sits under the engine

// ─── Collision throttle ───────────────────────────────────────────────────
// Mirror CollisionStaySkips=100 in SpaceshipCollsions.cs:
// sustain contacts only re-trigger audio after this many physics ticks.
const COLLISION_STAY_MIN_INTERVAL = 0.4   // seconds between sustained-contact hits

export type CollisionMaterial = 'rock' | 'metal' | 'ice' | 'default'

export class AudioManager {
  private ctx!: AudioContext
  private masterGain!: GainNode

  // Engine
  private engineBuf: AudioBuffer | null = null
  private engineNode: AudioBufferSourceNode | null = null
  private engineGain!: GainNode
  private enginePower = 0   // smoothed surge power, 0..0.5

  // Collision buffers
  private collisionBufs: Record<CollisionMaterial, AudioBuffer | null> = {
    rock: null, metal: null, ice: null, default: null,
  }
  private lastCollisionTime: Record<CollisionMaterial, number> = {
    rock: -Infinity, metal: -Infinity, ice: -Infinity, default: -Infinity,
  }

  // Drift loop — 3 layered channels
  private driftLoopBuf:  AudioBuffer | null = null
  private driftStartBuf: AudioBuffer | null = null
  private driftFlowBuf:  AudioBuffer | null = null
  private driftLoopNode:  AudioBufferSourceNode | null = null
  private driftFlowNode:  AudioBufferSourceNode | null = null
  private driftGain!:     GainNode   // core loop
  private driftFlowGain!: GainNode   // ambient layer (lower level)
  private prevDriftScore = 0         // for edge-detection of drift entry

  // Prop buffers + looping sources
  private boostEngineBuf:    AudioBuffer | null = null
  private attractorEngineBuf: AudioBuffer | null = null
  private repulsorEngineBuf:  AudioBuffer | null = null

  // Checkpoint one-shot
  private checkpointBuf: AudioBuffer | null = null

  private boostEngineNode:    AudioBufferSourceNode | null = null
  private attractorEngineNode: AudioBufferSourceNode | null = null
  private repulsorEngineNode:  AudioBufferSourceNode | null = null
  private boostEngineGain!:    GainNode
  private attractorEngineGain!: GainNode
  private repulsorEngineGain!:  GainNode

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.ctx = new AudioContext()

    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = 1.0
    this.masterGain.connect(this.ctx.destination)

    // Engine channel
    this.engineGain = this.ctx.createGain()
    this.engineGain.gain.value = 0.3 * ENGINE_MASTER   // idle volume
    this.engineGain.connect(this.masterGain)

    // Drift channels
    this.driftGain = this.ctx.createGain()
    this.driftGain.gain.value = 0
    this.driftGain.connect(this.masterGain)

    this.driftFlowGain = this.ctx.createGain()
    this.driftFlowGain.gain.value = 0
    this.driftFlowGain.connect(this.masterGain)

    // Prop channels
    this.boostEngineGain = this.ctx.createGain()
    this.boostEngineGain.gain.value = 0
    this.boostEngineGain.connect(this.masterGain)

    this.attractorEngineGain = this.ctx.createGain()
    this.attractorEngineGain.gain.value = 0
    this.attractorEngineGain.connect(this.masterGain)

    this.repulsorEngineGain = this.ctx.createGain()
    this.repulsorEngineGain.gain.value = 0
    this.repulsorEngineGain.connect(this.masterGain)

    // Load all buffers in parallel; missing files are silently ignored.
    await Promise.all([
      this.load(SOUNDS.engine).then(b => { this.engineBuf = b }),
      this.load(SOUNDS.collisionRock).then(b => { this.collisionBufs.rock = b }),
      this.load(SOUNDS.collisionMetal).then(b => { this.collisionBufs.metal = b }),
      this.load(SOUNDS.collisionIce).then(b => { this.collisionBufs.ice = b }),
      this.load(SOUNDS.boostEngine).then(b => { this.boostEngineBuf = b }),
      this.load(SOUNDS.attractorEngine).then(b => { this.attractorEngineBuf = b }),
      this.load(SOUNDS.repulsorEngine).then(b => { this.repulsorEngineBuf = b }),
      this.load(SOUNDS.driftLoop).then(b => { this.driftLoopBuf = b }),
      this.load(SOUNDS.driftStart).then(b => { this.driftStartBuf = b }),
      this.load(SOUNDS.driftFlow).then(b => { this.driftFlowBuf = b }),
      this.load(SOUNDS.checkpoint).then(b => { this.checkpointBuf = b }),
    ])

    this.startEngine()
  }

  /** Must be called from a user gesture (click/keydown) to unlock AudioContext on iOS/Safari. */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }

  destroy(): void {
    this.engineNode?.stop()
    this.driftLoopNode?.stop()
    this.driftFlowNode?.stop()
    this.boostEngineNode?.stop()
    this.attractorEngineNode?.stop()
    this.repulsorEngineNode?.stop()
    void this.ctx?.close()
  }

  // ─── Engine update (call every render frame) ─────────────────────────────

  /**
   * Update engine audio each frame.
   *
   * Ports Spaceship.cs Update() exactly:
   *   enginePower = Lerp(enginePower, Clamp(surge, 0, 1) * 0.5f, dt * 3)
   *   volume      = enginePower + 0.3
   *   pitch       = enginePower + 1.0 − 0.5 / (1 + speed*0.5 + |angVel|*0.5)
   */
  updateEngine(
    input: InputState,
    speed: number,
    angVel: number,
    dt: number,
  ): void {
    if (!this.engineNode) return

    const surge = Math.max(0, Math.min(1, input.surge))
    const targetPower = surge * 0.5
    // Lerp with rate = dt * 3  (same as Unity Lerp(a, b, dt*3) approximation)
    this.enginePower += (targetPower - this.enginePower) * Math.min(1, dt * 3)

    const volume = (this.enginePower + 0.3) * ENGINE_MASTER
    const pitch  = this.enginePower + 1.0
              - 0.5 / (1 + speed * 0.5 + Math.abs(angVel) * 0.5)

    this.engineGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05)
    this.engineNode.playbackRate.setTargetAtTime(Math.max(0.1, pitch), this.ctx.currentTime, 0.05)
  }

  // ─── Collision sounds ────────────────────────────────────────────────────

  /**
   * Play a collision sound.
   *
   * Ports SpaceshipCollsions.cs ProcessCollision():
   *   vol = 1 − 1/(1 + relativeVelocity.magnitude)
   *   pitch = Random(0.5, 1.5)
   *
   * @param material  Which collision surface type.
   * @param impactSpeed  Magnitude of relative velocity at contact (u/s).
   * @param isSustained  true = OnCollisionStay (throttled), false = OnCollisionEnter.
   */
  playCollision(
    material: CollisionMaterial,
    impactSpeed: number,
    isSustained = false,
  ): void {
    const now = this.ctx.currentTime
    if (isSustained && now - this.lastCollisionTime[material] < COLLISION_STAY_MIN_INTERVAL) return
    this.lastCollisionTime[material] = now

    const buf = this.collisionBufs[material] ?? this.collisionBufs.rock
    if (!buf) return

    const vol   = (1 - 1 / (1 + impactSpeed)) * COLLISION_MASTER
    const pitch = 0.5 + Math.random()   // [0.5, 1.5]

    const gain = this.ctx.createGain()
    gain.gain.value = vol
    gain.connect(this.masterGain)

    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = pitch
    src.connect(gain)
    src.start()
    // Auto-cleanup after playback
    src.onended = () => { gain.disconnect() }
  }

  // ─── Prop sounds ─────────────────────────────────────────────────────────

  // ─── Drift sound (call every render frame) ───────────────────────────────

  /**
   * Update the drift-loop sound — 3 layers:
   *   1. driftLoop  — core bandpass whoosh, volume = sqrt(score), pitch = 0.65→1.80
   *   2. driftFlow  — low ambient layer, volume = score^1.5 * 0.5 (fades in slowly)
   *   3. driftStart — one-shot entry cue, fired once when score crosses 0.25
   *
   * @param score  0 = aligned, 1 = perfect 90° sideslip at speed.
   */
  setDrift(score: number): void {
    // ── Core loop ──────────────────────────────────────────────────────────
    if (!this.driftLoopNode && this.driftLoopBuf) {
      this.driftLoopNode = this.makeLooping(this.driftLoopBuf, this.driftGain, 0)
    }
    const s     = Math.max(0, Math.min(1, score))
    const vol   = s * DRIFT_MASTER                      // linear — gentler rise than sqrt
    const pitch = 0.75 + Math.pow(s, 0.7) * 0.65       // 0.75 → 1.40, less extreme sweep
    this.driftGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05)
    if (this.driftLoopNode) {
      this.driftLoopNode.playbackRate.setTargetAtTime(Math.max(0.1, pitch), this.ctx.currentTime, 0.07)
    }

    // ── Flow layer ─────────────────────────────────────────────────────────
    // Fades in more slowly than the core loop — gives depth when drifting hard.
    if (!this.driftFlowNode && this.driftFlowBuf) {
      this.driftFlowNode = this.makeLooping(this.driftFlowBuf, this.driftFlowGain, 0)
    }
    const flowVol = Math.pow(s, 1.5) * DRIFT_MASTER * 0.55
    this.driftFlowGain.gain.setTargetAtTime(flowVol, this.ctx.currentTime, 0.12)

    // ── Entry cue — one-shot when crossing threshold ────────────────────────
    const ENTRY_THRESHOLD = 0.25
    if (s >= ENTRY_THRESHOLD && this.prevDriftScore < ENTRY_THRESHOLD) {
      this.playDriftStart()
    }
    this.prevDriftScore = s
  }

  private playDriftStart(): void {
    if (!this.driftStartBuf) return
    const gain = this.ctx.createGain()
    gain.gain.value = 0.7 * DRIFT_MASTER
    gain.connect(this.masterGain)
    const src = this.ctx.createBufferSource()
    src.buffer = this.driftStartBuf
    src.connect(gain)
    src.start()
    src.onended = () => gain.disconnect()
  }

  playCheckpoint(pitch = 1.0): void {
    if (!this.checkpointBuf) return
    const gain = this.ctx.createGain()
    gain.gain.value = 0.85
    gain.connect(this.masterGain)
    const src = this.ctx.createBufferSource()
    src.buffer = this.checkpointBuf
    src.playbackRate.value = pitch
    src.connect(gain)
    src.start()
    src.onended = () => gain.disconnect()
  }

  /**
   * Set boost engine volume by proximity and pitch by current speed.
   * @param t      0 = outside/edge, 1 = zone center.
   * @param speed  Ship speed in u/s — drives pitch up as the boost accelerates the ship.
   *               Pitch range: 0.9 (idle inside) → 2.0 (at ~10 u/s+).
   */
  setBoostProximity(t: number, speed: number): void {
    // Ensure looping node exists whenever we might need it
    if (!this.boostEngineNode && this.boostEngineBuf) {
      this.boostEngineNode = this.makeLooping(this.boostEngineBuf, this.boostEngineGain, 0)
    }
    const volume = Math.max(0, t) * PROP_MASTER
    this.boostEngineGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.08)
    // Pitch: 0.9 at rest, scales up with speed. Max pitch reached at 100 u/s.
    const pitch = 0.9 + Math.min(speed, 100) * 0.011   // 0.9 → 2.0 over 0–100 u/s
    if (this.boostEngineNode) {
      this.boostEngineNode.playbackRate.setTargetAtTime(pitch, this.ctx.currentTime, 0.12)
    }
  }

  /**
   * Set attractor engine volume by proximity and pitch by speed.
   * @param t      0 = outside/edge (r=4), 1 = zone center.
   * @param speed  Ship speed in u/s. Pitch: 0.9 → 2.0 over 0–100 u/s.
   */
  setAttractorProximity(t: number, speed: number): void {
    if (!this.attractorEngineNode && this.attractorEngineBuf) {
      this.attractorEngineNode = this.makeLooping(this.attractorEngineBuf, this.attractorEngineGain, 0)
    }
    this.attractorEngineGain.gain.setTargetAtTime(Math.max(0, t) * PROP_MASTER, this.ctx.currentTime, 0.08)
    const pitch = 0.9 + Math.min(speed, 100) * 0.011
    if (this.attractorEngineNode) {
      this.attractorEngineNode.playbackRate.setTargetAtTime(pitch, this.ctx.currentTime, 0.12)
    }
  }

  /**
   * Set repulsor engine volume by proximity and pitch by speed.
   * @param t      0 = outside/edge (r=2), 1 = zone center.
   * @param speed  Ship speed in u/s. Pitch: 0.9 → 2.0 over 0–100 u/s.
   */
  setRepulsorProximity(t: number, speed: number): void {
    if (!this.repulsorEngineNode && this.repulsorEngineBuf) {
      this.repulsorEngineNode = this.makeLooping(this.repulsorEngineBuf, this.repulsorEngineGain, 0)
    }
    this.repulsorEngineGain.gain.setTargetAtTime(Math.max(0, t) * PROP_MASTER, this.ctx.currentTime, 0.08)
    const pitch = 0.9 + Math.min(speed, 100) * 0.011
    if (this.repulsorEngineNode) {
      this.repulsorEngineNode.playbackRate.setTargetAtTime(pitch, this.ctx.currentTime, 0.12)
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async load(url: string): Promise<AudioBuffer | null> {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return null
      const arrayBuf = await resp.arrayBuffer()
      return await this.ctx.decodeAudioData(arrayBuf)
    } catch {
      console.warn(`AudioManager: failed to load ${url}`)
      return null
    }
  }

  private startEngine(): void {
    if (!this.engineBuf) return
    this.engineNode = this.ctx.createBufferSource()
    this.engineNode.buffer = this.engineBuf
    this.engineNode.loop = true
    this.engineNode.playbackRate.value = 0.5   // idle pitch
    this.engineNode.connect(this.engineGain)
    this.engineNode.start()
  }

  private makeLooping(
    buf: AudioBuffer,
    gainNode: GainNode,
    volume: number,
  ): AudioBufferSourceNode {
    gainNode.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.connect(gainNode)
    src.start()
    return src
  }
}
