# DriftsInSpace — Development Plan

Browser-based 2D top-down spaceship racing game. Direct spiritual successor to ANXRacers, ported from Unity/C# to the browser.

---

## Overview

| Attribute | Value |
|---|---|
| Renderer | PixiJS v8 |
| Language | TypeScript |
| Tooling | Vite |
| Audio | Howler.js |
| Physics | Custom kinematic (no WASM, no Box2D) |
| Sim rate | 50 Hz fixed-step |
| Render rate | 60 fps (decoupled from sim) |
| Backend | ASP.NET Core (new service, same stack as ANXRacers server) |
| Networking | WebSocket + MessagePack binary |
| Input | Keyboard, Gamepad API, Touch |

---

## Milestone Map

```
M0 Scaffold ──► M1 Sim Loop ──► M2 Collision ──► M3 Track Editor
                                                        │
                                                        ▼
                                               M4 Ghost Replay  ◄── first playable milestone
                                                        │
                                    ┌───────────────────┼───────────────────┐
                                    ▼                   ▼                   ▼
                               M5 Input            M6 Audio           M7 Ships
                                    └───────────────────┼───────────────────┘
                                                        ▼
                                                  M8 Backend
                                                        │
                                                        ▼
                                                 M9 Multiplayer
                                                        │
                                                        ▼
                                                M10 Load Speed
```

---

## M0 — Project Scaffold

**Goal:** Working dev loop. PixiJS canvas visible in browser within seconds of `npm run dev`.

### Tasks

- [ ] `npm create vite@latest drifts-in-space -- --template vanilla-ts`
- [ ] Install deps: `pixi.js@8`, `howler`, `@msgpack/msgpack`
- [ ] Install dev deps: `@types/howler`, `vite-plugin-checker` (TypeScript strict)
- [ ] Configure `vite.config.ts`: separate vendor chunk (pixi+howler), source maps in dev
- [ ] `src/main.ts`: bootstrap PixiJS Application, resize to window, black background
- [ ] `src/render/Renderer.ts`: stub class, owns `PIXI.Application`
- [ ] `.gitignore`, `tsconfig.json` (strict mode, `"moduleResolution": "bundler"`)
- [ ] Confirm HMR works: change background colour, see instant update

### Done when
A PixiJS canvas fills the browser window. No page reload needed during development.

---

## M1 — Core Simulation Loop

**Goal:** A ship moves on screen, controlled by keyboard. Physics feel matches ANXRacers.

### Background — ANXRacers source

`PhysicsSimul.cs` runs a fixed-step accumulator:
```csharp
t += Time.deltaTime;
while (t >= Physics2DTimeStep) { t -= Physics2DTimeStep; Tick(Physics2DTimeStep); }
```

`Spaceship.FixedUpdate` applies forces:
- Conditional drag: `angularDrag = 0.001, drag = 0` when **no** input; `MaxADrag / MaxLDrag` when input active
- Forces: `rb.AddTorque(-torque * torqueMultiplier)`, `rb.AddRelativeForce(strafe, surge)`
- Persistent `Boost` vector accumulated from trigger fields, added each tick

### Tasks

- [ ] `src/sim/SimLoop.ts` — fixed-step accumulator, 50 Hz
  ```
  acc += wallDt
  while acc >= TICK_DT: acc -= TICK_DT; world.tick(TICK_DT)
  renderAlpha = acc / TICK_DT   // passed to renderer for interpolation
  ```
- [ ] `src/sim/ShipState.ts` — plain struct: `{pos: Vec2, angle: number, vel: Vec2, angularVel: number, boost: Vec2}`
- [ ] `src/sim/Ship.ts` — `tick(dt, input, stats)`:
  - Forward/right vectors from angle
  - Surge signed → multiply by `surgeForward` or `surgeBackward`
  - `vel += forward * surge * dt / mass`
  - `vel += right * strafe * strafeMultiplier * dt / mass`
  - `vel += boost`
  - Conditional drag (no input = coasting drag near 0, same as ANXRacers)
  - `angularVel += -torque * torqueMultiplier * dt / mass`
  - Integrate: `pos += vel * dt`, `angle += angularVel * dt`
- [ ] `src/sim/World.ts` — owns array of `Ship`, calls `ship.tick()` each step
- [ ] `src/input/KeyboardInput.ts` — maps WASD/arrows to `{surge, strafe, torque}` in `[-1, 1]`
- [ ] `src/render/ShipView.ts` — renders ship sprite at interpolated position
  ```
  displayPos = lerp(prevState.pos, currentState.pos, alpha)
  displayAngle = lerpAngle(prevState.angle, currentState.angle, alpha)
  ```
- [ ] Main loop: `requestAnimationFrame` → `SimLoop.update(delta)` → `Renderer.draw(alpha)`

### Ship Stats (ANXRacers defaults to port)

```typescript
// Direct port of ANXRacers Spaceship inspector defaults
const DEFAULT_SHIP: ShipStats = {
  mass:               1,
  surgeForward:       300,
  surgeBackward:      200,
  strafeMultiplier:   100,
  torqueMultiplier:   1000,
  linearDrag:         /* rb.drag when active */,
  angularDrag:        /* rb.angularDrag when active */,
  radius:             0.5,
};
```

### Done when
Ship moves, drifts, and decelerates with the same feel as ANXRacers. No collision yet.

---

## M2 — Collision & Obstacles

**Goal:** Ship bounces off walls and triggers checkpoints. Track boundaries defined by static geometry.

### Obstacle Primitives

| Type | Data | Use case |
|---|---|---|
| Segment | `{a: Vec2, b: Vec2, material: Material}` | Straight walls |
| Capsule | `{a: Vec2, b: Vec2, radius: number, material: Material}` | Rounded walls, pillars |
| ConvexPolygon | `{verts: Vec2[], material: Material}` | Complex obstacles |
| CircleTrigger | `{pos: Vec2, radius: number, kind: 'checkpoint'|'boost'|'attractor'}` | Triggers |

Materials: `Rock | Metal | Ice` — same as ANXRacers `ObstacleMaterial` (drives audio selection).

### Collision Response

**Circle vs Segment:**
1. Project circle center onto segment line, clamp `t` to `[0, 1]`
2. Closest point = `a + t*(b-a)`
3. If `|center - closest| < radius`: penetration detected
4. Reflect velocity: `vel = vel - 2 * dot(vel, n) * n * (1 + bounce)`, scale by `friction`
5. Push out by penetration depth along normal

**Circle vs Capsule:** same as segment but `effectiveRadius = ship.radius + capsule.radius`

**Circle vs ConvexPolygon:** SAT — find minimum penetration axis among edge normals + voronoi vertex regions.

### Broadphase (Spatial Hash)

```typescript
// Cell size = 2 * max(ship.radius, maxObstacleRadius)
// Ships are dynamic — only ship positions change per tick
// Obstacles are static — inserted once at track load
// Query: get 9 cells around ship center → candidate list → narrow-phase
```

### CCD (Continuous Collision Detection)

CCD kicks in when `vel.magnitude * dt > ship.radius * 0.5` (ship could tunnel through thin wall).
Strategy: **adaptive substep** — if this condition is met, split the tick into 2 sub-steps. Simpler than full swept-capsule math and correct at 50Hz.

### Checkpoints

Port of `Checkpoint.cs` circle trigger logic:
- `Track` owns ordered list of `CircleTrigger` checkpoints
- On trigger enter: `track.enterCheckpoint(index)` — validates order, advances `currentCheckpointIndex`
- Finish line = last checkpoint wraps to 0 (laps) or ends race (time trial)
- Checkpoint radius scales with difficulty (port of `Checkpoint.Difficulty`)

### Tasks

- [ ] `src/sim/Obstacles.ts` — all primitive types + intersection helpers
- [ ] `src/sim/Collision.ts` — circle vs segment, capsule, polygon, trigger
- [ ] `src/sim/SpatialHash.ts` — insert/query/clear
- [ ] `src/sim/Track.ts` — owns obstacle list, spatial hash, checkpoint list
- [ ] Wire collision into `Ship.tick()`: after integration, query broadphase, resolve all contacts
- [ ] `src/sim/Fields.ts` — boost zones (persistent `boost` vector, port of `Boost.cs`), attractors

### Done when
Ship collides with drawn segments, bounces with material-appropriate feel, passes through checkpoint triggers in order.

---

## M3 — Draw-A-Track Editor

**Goal:** Player draws a track in the browser exactly like ANXRacers draw-a-track mode. Export to JSON and immediately race on it.

### Background — ANXRacers source

`CatamaranBrushNeo.cs`: dual-brush concept — left brush and right brush trail the spaceship at `±BrushRadius` offset from heading, painting the two walls of the track simultaneously. Obstacles, boosts, and checkpoints are placed from a palette.

`DrawATrackMgrNeo.cs`: `Time.fixedDeltaTime = 0.001f` (1000Hz physics!) so the brush never misses a frame.

### Track Data Format

```typescript
interface TrackData {
  id:         string;          // uuid
  name:       string;
  authorId:   string;
  version:    number;
  centerline: Vec2[];          // raw drawn path points
  walls: {
    left:  Segment[];          // generated from centerline + BrushRadius
    right: Segment[];
  };
  obstacles:  ObstaclePlacement[];
  checkpoints: CheckpointDef[];
  boostPads:  BoostPadDef[];
  startPos:   Vec2;
  startAngle: number;
}
```

Mirrors ANXRacers `Level` struct: `TrackData`, `ObstacleTypeAndTransform[]`, with `LevelId` → `id`.

### Editor Modes

| Mode | Description |
|---|---|
| `Draw` | Move ship (or drag mouse), left/right walls auto-paint from dual brush |
| `Erase` | Erase wall segments near cursor |
| `Place` | Click to drop obstacle/boost/checkpoint from palette |
| `Transform` | Drag placed objects to reposition |
| `Playtest` | Run the sim immediately on current track, exit back to editor |

### Tasks

- [ ] `src/editor/EditorApp.ts` — separate PixiJS stage from race stage, swap on mode change
- [ ] `src/editor/DualBrush.ts` — port `CatamaranBrushNeo`: track spaceship/mouse, emit `{left: Segment, right: Segment}` every N pixels moved (gap threshold to avoid over-dense segments)
- [ ] `src/editor/WallPainter.ts` — accumulates segments from DualBrush, renders live preview as PixiJS `Graphics`
- [ ] `src/editor/ObstaclePalette.ts` — drag-and-drop panel: Rock, Metal, Ice obstacles, Boost Pad, Checkpoint
- [ ] `src/editor/Eraser.ts` — circle eraser removes segments within radius (port `TrackEraser.cs`)
- [ ] `src/editor/TrackSerializer.ts` — serialize/deserialize `TrackData` ↔ JSON
- [ ] `src/editor/LocalStorage.ts` — save/load tracks from `indexedDB` (multiple tracks, named)
- [ ] Playtest button: load `TrackData` into `World`, start race, show "back to editor" overlay
- [ ] Track thumbnail generator: render minimap to `<canvas>` → PNG blob for track list

### Done when
Draw a track with mouse, place checkpoints and boosts, press Playtest, race it.

---

## M4 — Ghost Replay (First Playable Milestone)

**Goal:** Race against your own best time. Ghost is a semi-transparent ship that plays back the recorded state of the best run.

### Recording Architecture

Two parallel streams, recorded simultaneously during every race:

**Stream 1 — State Stream** (drives ghost playback on client):
```typescript
interface StateFrame {
  tick:   number;  // u32 — sim tick counter
  x:      number;  // i32 — pos.x * 1000 (millimeter precision)
  y:      number;  // i32 — pos.y * 1000
  angle:  number;  // i32 — angle * 10000 (0.0001 rad precision)
}
// At 50Hz for a 60s race: 3000 frames × 12 bytes = 36 KB uncompressed
// zlib compressed: ~8–12 KB
```

**Stream 2 — Input Stream** (server anti-cheat only, never drives sim):
```typescript
interface InputFrame {
  tick:   number;  // u32
  surge:  number;  // i8  (-127..127 maps to -1..1)
  strafe: number;  // i8
  torque: number;  // i8
}
// At 50Hz: 3000 frames × 7 bytes = 21 KB → zlib ~4 KB
// Uploaded with score submission. Server re-runs sim, verifies final time.
```

This mirrors the ANXRacers `Recorder.cs` architecture exactly. The input stream exists purely for server-side verification.

### Ghost Playback

Port of `GhostReplay.cs`:
- Decompress state stream from IndexedDB (best local ghost) or from server
- Each render frame: find `frame[i]` where `frame[i].tick <= currentTick < frame[i+1].tick`
- Interpolate `pos` and `angle` between the two surrounding frames using linear interpolation
- Render as semi-transparent ship sprite (alpha = 0.5) with name label

```typescript
// Port of GhostReplay.Update() interpolation
const t = (currentTick - frameA.tick) / (frameB.tick - frameA.tick); // [0, 1]
ghost.pos   = lerp(frameA.pos,   frameB.pos,   t);
ghost.angle = lerpAngle(frameA.angle, frameB.angle, t);
```

### Race Flow

```
PreRace → Countdown (3-2-1) → Racing → RaceFinished
```
- Countdown: cosmetic only, timer starts on GO
- Checkpoints: ordered collection, must be passed in sequence (port `Track.EnterCheckpoint`)
- Finish: last checkpoint triggers `RaceFinished`, records time
- Personal best: if `time < storedBestTime` → replace stored ghost + time in IndexedDB
- Best ghost shown on next race attempt

### Tasks

- [ ] `src/sim/Recorder.ts` — records state frames and input frames each tick when `recording = true`
- [ ] `src/sim/Ghost.ts` — loads compressed frames, exposes `getInterpolatedState(tick, alpha): GhostState`
- [ ] `src/render/GhostView.ts` — semi-transparent ship, label with name + best time
- [ ] `src/race/RaceManager.ts` — state machine: `PreRace → Countdown → Racing → Finished`
- [ ] `src/race/CheckpointTracker.ts` — ordered checkpoint validation (port of `Track.EnterCheckpoint`)
- [ ] `src/storage/GhostStore.ts` — IndexedDB CRUD for ghosts (keyed by `trackId + shipId`)
- [ ] Race HUD: current time, best time, checkpoint indicator, lap counter
- [ ] Finish dialog: time, delta vs best, personal best badge

### Done when
Complete a race. Your ghost appears on the next attempt. Beat your time, new ghost replaces it.

---

## M5 — Input System

**Goal:** Keyboard, gamepad, and touch all feed the same unified `InputState` interface. Matches ANXRacers `InputMgr.cs`.

### Unified Interface

```typescript
interface InputState {
  surge:  number;  // [-1, 1]  forward/backward
  strafe: number;  // [-1, 1]  left/right lateral
  torque: number;  // [-1, 1]  rotate CW/CCW
}
```

### Keyboard

| Key | Action |
|---|---|
| `W` / `↑` | surge +1 |
| `S` / `↓` | surge -1 |
| `A` / `←` | torque -1 |
| `D` / `→` | torque +1 |
| `Q` | strafe -1 |
| `E` | strafe +1 |
| `R` | restart race |

### Gamepad (Gamepad API)

- Left stick X/Y → `strafe`, `surge`
- Right stick X → `torque`
- Left/Right trigger → `torque` (alternative)
- `navigator.getGamepads()` polled every tick (not event-driven — Gamepad API is pull-based)
- Deadzone: `|axis| < 0.1 → 0` (prevents drift)

### Touch (port of `CustomizableTouchControlsNeo.cs`)

- Left virtual joystick: surge + strafe (dual axis)
- Right virtual joystick: torque (single axis, horizontal only)
- Joystick positions moveable by long-press drag (user customisable positions, saved to localStorage)
- Rendered as PixiJS `Graphics` circles, not DOM elements (no z-index conflicts)

### Tasks

- [ ] `src/input/InputManager.ts` — aggregates keyboard, gamepad, touch; exports current `InputState`
- [ ] `src/input/KeyboardInput.ts`
- [ ] `src/input/GamepadInput.ts` — poll `navigator.getGamepads()` in sim tick, not rAF
- [ ] `src/input/TouchInput.ts` — dual virtual joystick, PixiJS interaction events
- [ ] Gamepad vibration on collision: `gamepad.vibrationActuator.playEffect(...)` proportional to impact velocity
- [ ] Input binding UI: simple overlay showing current bindings, tap key/button to rebind

### Done when
All three input methods control the ship smoothly. Touch joystick positions save across sessions.

---

## M6 — Audio

**Goal:** Engine hum, drift ticking, collision sounds, and BGM. Direct port of ANXRacers audio logic.

### Engine Hum (port of `Spaceship.Update`)

```typescript
// ANXRacers: enginePower = Lerp(enginePower, Clamp(inputSurge, 0, 1) * .5f, dt * 3)
// engineAudio.volume = enginePower + 0.3
// engineAudio.pitch  = enginePower + 1 + (0 - (0.5 / (1 + vel.magnitude*0.5 + |angularVel|*0.5)))
enginePower = lerp(enginePower, clamp(input.surge, 0, 1) * 0.5, dt * 3);
engineSound.volume(enginePower + 0.3);
engineSound.rate(enginePower + 1 + (-(0.5 / (1 + vel * 0.5 + Math.abs(angVel) * 0.5))));
```

### Drift Ticker (port of `Drifter.FixedUpdate`)

```typescript
// lateral velocity component = |dot(normalize(vel), shipRight * inputSurge)|
const driftValue = Math.abs(dot(normalize(vel), right) * input.surge);
// smooth the value (SmoothDamp equivalent)
// scale volume and pitch with driftValue (port of DriftTickVolumeScale AnimationCurve)
```

### Collision Audio (port of `SpaceshipCollsions.ProcessCollision`)

- Three audio sources: rock, metal, ice — selected by `obstacle.material`
- Volume = `1 - 1/(1 + relativeVelocity.magnitude)` — same formula as ANXRacers
- Pitch randomised ±10% per impact
- Howler sprite sheet: all collision sounds in one audio file, avoid HTTP requests

### Howler Setup

```typescript
const sfx = new Howl({
  src: ['sfx.webm', 'sfx.mp3'],  // webm first (smaller), mp3 fallback
  sprite: {
    engineIdle: [0, 2000, true],  // looping
    driftTick:  [2000, 500],
    rockHit:    [2500, 300],
    metalHit:   [2800, 300],
    iceHit:     [3100, 300],
    checkpoint: [3400, 500],
    boost:      [3900, 800],
  },
  preload: false  // load on first user gesture (Web Audio unlock)
});
```

### Tasks

- [ ] `src/audio/AudioManager.ts` — Howler wrapper, manages all sounds
- [ ] `src/audio/EngineAudio.ts` — per-ship engine hum with port of ANXRacers pitch/volume formula
- [ ] `src/audio/DriftAudio.ts` — drift ticker port
- [ ] `src/audio/CollisionAudio.ts` — material-based collision audio
- [ ] BGM: Howler `Howl` with `loop: true`, volume control
- [ ] Web Audio unlock handler: play silent buffer on first tap/keypress
- [ ] Audio volume settings: master, SFX, BGM (localStorage)

### Done when
Engine pitch rises with speed. Drift ticker activates on lateral slip. Walls play distinct material sounds on impact.

---

## M7 — Ship Stats System

**Goal:** Multiple ships with different physics profiles. Player picks a ship before racing.

### Ship Definition

```typescript
interface ShipStats {
  id:              string;
  name:            string;
  // Physics — same field names as ANXRacers ShipPhysics DTO
  mass:            number;
  linearDrag:      number;   // LDrag
  angularDrag:     number;   // ADrag
  surgeForward:    number;
  surgeBackward:   number;
  strafe:          number;
  torque:          number;
  radius:          number;
  friction:        number;
  bounce:          number;
}
```

### Roster (starting point — values ported from ANXRacers ship inspector defaults)

| Ship | Character | Mass | Drag | Top Speed | Turn |
|---|---|---|---|---|---|
| Scout | Light, twitchy | Low | Low | High | High |
| Freighter | Heavy, stable | High | Medium | Medium | Low |
| Drifter | Balanced, high bounce | Medium | Low | Medium | High |

### Tasks

- [ ] `src/ships/ShipRoster.ts` — static array of `ShipStats`, initial values from ANXRacers
- [ ] Ship selection screen: PixiJS UI or HTML overlay, grid of 3 ships
- [ ] Stats display bars (port of `ShipStatSlider.cs`) — top speed, turn rate, drift, surge
- [ ] Selected ship ID persisted in `localStorage`
- [ ] Wire selected ship stats into `World.addShip(stats)`

### Done when
Player selects a ship, all ships feel distinctly different on track.

---

## M8 — Backend (.NET)

**Goal:** Persistent track storage, leaderboards, ghost upload/download, server-side anti-cheat.

### Technology

- ASP.NET Core 9 minimal API
- Entity Framework Core + SQLite (mirrors ANXRacers server stack)
- MessagePack for binary ghost streams (matches frontend `@msgpack/msgpack`)
- JWT auth (Bearer token, same pattern as ANXRacers `UserController.cs`)
- Docker: single self-contained binary + SQLite volume mount

### Shared DTO Alignment

Mirror ANXRacers server DTO names exactly where possible:

| ANXRacers DTO | DriftsInSpace equivalent |
|---|---|
| `DtoLevelResponse` | `DtoTrackResponse` |
| `DtoScoreResponse` | `DtoScoreResponse` (identical) |
| `DtoShipResponse` → `ShipPhysics` | `ShipStats` (same fields) |
| `PShipUpdate` | `ShipUpdatePacket` (same fields) |

### API Surface

**Auth**
```
POST /auth/register    { username, password } → { token, userId }
POST /auth/login       { username, password } → { token, userId }
```

**Tracks**
```
POST   /tracks            { TrackData }  → { trackId }          [auth required]
GET    /tracks             ?page=0&size=20 → TrackListItem[]
GET    /tracks/{id}        → TrackData + metadata
PUT    /tracks/{id}        { TrackData }                         [author only]
DELETE /tracks/{id}                                              [author only]
```

**Scores / Ghosts**
```
POST /scores/{trackId}    { time, shipId, stateStream: bytes, inputStream: bytes }
                          → { scoreId, rank }                   [auth required]
GET  /scores/{trackId}    ?limit=20 → ScoreEntry[]              (leaderboard)
GET  /scores/{trackId}/ghost/{scoreId} → stateStream: bytes     (download ghost)
GET  /scores/{trackId}/best → best ghost for authenticated user
```

**Anti-Cheat**
- `POST /scores/{trackId}` triggers async server-side sim replay
- Server re-runs the sim from the uploaded `inputStream` using the same 50Hz fixed-step integrator (ported to C#, or verifies against the uploaded `stateStream`)
- If `|serverTime - claimedTime| > 500ms` → score rejected, account flagged
- Input stream stored for 30 days; state stream stored only for personal best

### Database Schema

```sql
Users    (UserId, Username, PasswordHash, CreatedAt)
Tracks   (TrackId, AuthorId, Name, TrackJson, Version, CreatedAt, ModifiedAt)
Scores   (ScoreId, TrackId, UserId, ShipId, Time, StateStream, InputStream, SubmittedAt, Verified)
```

### Tasks

- [ ] New `DriftsInSpaceServer/` .NET 9 solution alongside game code
- [ ] EF Core migrations for Users, Tracks, Scores
- [ ] Auth endpoints with BCrypt password hashing + JWT signing
- [ ] Track CRUD endpoints
- [ ] Score submission: receive streams, store, return rank
- [ ] Ghost download endpoint: serve compressed state stream
- [ ] Anti-cheat service (background hosted service, processes unverified scores)
- [ ] CORS configured for dev (`localhost:5173`) and production domain
- [ ] Docker: `FROM mcr.microsoft.com/dotnet/aspnet:9.0`, SQLite file on volume

### Done when
Upload a ghost from the browser, see it appear on the leaderboard, download and race against it.

---

## M9 — Multiplayer

**Goal:** Multiple players race live on the same track with state-sync networking. Same model as ANXRacers.

### Network Model

**State sync at 50ms intervals** (same as ANXRacers `Client.cs` `TickEveryMs = 100`).

Each client:
1. Every 50ms, sends own ship state to server
2. Server broadcasts all player states back to all clients
3. Remote ships interpolated on client using ring buffer

### Packets (mirrors ANXRacers `PShipUpdate`)

```typescript
// Client → Server (20Hz)
interface ShipUpdatePacket {
  mpId:  number;  // u32
  tick:  number;  // u32
  x:     number;  // i32  (pos.x * 1000)
  y:     number;  // i32  (pos.y * 1000)
  angle: number;  // i32  (angle * 10000)
}

// Server → All clients
interface PlayerStatesPacket {
  serverTime: number;
  players:    ShipUpdatePacket[];
}
```

Serialized with MessagePack. No JSON in the multiplayer hot path.

### Client Interpolation (port of `RemotePlayer.cs`)

```typescript
// Ring buffer: 50 slots (LiteRingBuffer port)
// On receive: push to stateBuffer
// On render: if buffer healthy, advance currentState, interpolate to next
// timespeed: adaptive (1.0 normally, >1 if buffer growing, <1 if draining)
// Same bufferHealth / bufferHealthThreshold logic as ANXRacers RemotePlayer
```

### Server (ASP.NET Core + SignalR or raw WebSocket)

- Hub method: `SendShipState(ShipUpdatePacket)` → fan-out to all in room
- Room management: create/join by 6-char room code
- Race sync: server sends `RaceCountdown` event with server timestamp, all clients start at same real time
- Finish: first to complete broadcasts finish time, server broadcasts final ranks

### Race Session Flow

```
Lobby (waiting for players) → Countdown (server-authoritative timestamp)
→ Racing (state sync 20Hz) → Finished (rank broadcast) → Results screen
```

### Tasks

- [ ] SignalR Hub in backend: `RaceHub.cs` — join room, send state, receive states
- [ ] `src/net/MultiplayerClient.ts` — SignalR JS client, MessagePack transport
- [ ] `src/net/StateBuffer.ts` — ring buffer for remote player state interpolation (port `LiteRingBuffer`)
- [ ] `src/net/RemoteShip.ts` — reads from StateBuffer, exposes interpolated state (port `RemotePlayer.cs`)
- [ ] `src/render/RemoteShipView.ts` — renders remote ships with name labels
- [ ] Lobby UI: create room / join by code / player list
- [ ] Countdown sync: use server-provided `startAt` Unix timestamp
- [ ] Offscreen indicators (port `TargetIndicator.cs`): arrows pointing to off-camera ships

### Done when
Two browsers race each other on the same track in real time with smooth interpolation.

---

## M10 — Load Speed & Polish

**Goal:** < 1 MB initial payload, < 2 second load on fast connection. Game renders first frame before audio or track data finishes loading.

### Bundle Size Budget

| Asset | Target gzipped size |
|---|---|
| PixiJS v8 (vendor chunk) | ~180 KB |
| Howler.js | ~10 KB |
| `@msgpack/msgpack` | ~15 KB |
| Game code | ~80 KB |
| Ship sprites atlas | ~50 KB |
| **Total initial** | **< 350 KB** |
| SFX sprite sheet (deferred) | ~200 KB |
| BGM (deferred) | ~1 MB (streamed) |

### Loading Strategy

```
Frame 1: PixiJS canvas + loading screen (CSS spinner — no PixiJS needed)
Frame 2: PixiJS app starts, shows animated loading logo
↓
Parallel: download ship atlas + track data
↓
Race ready: audio loads on first user gesture (Web Audio API requirement)
BGM: streams after race starts
```

### Vite Config

```typescript
// vite.config.ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        vendor: ['pixi.js', 'howler'],  // cached by CDN separately
        msgpack: ['@msgpack/msgpack'],
      }
    }
  }
}
```

### Texture Atlas

- Single atlas for all ship sprites + UI icons + obstacle textures
- Built with `vite-plugin-spritesheet` (or pre-generated with free-tex-packer CLI)
- Ship sprites: 64×64px, 4 rotation frames per ship (PixiJS animates the rest)
- One HTTP request for all sprites

### PWA (Progressive Web App)

- `vite-plugin-pwa` — service worker with cache-first strategy for assets
- App manifest: name, icons, `display: standalone`
- Offline: races on downloaded tracks work offline (state saved in IndexedDB)
- "Add to home screen" prompt on mobile

### Tasks

- [ ] Vite chunk splitting config
- [ ] Texture atlas pipeline: scripts in `tools/` to pack sprites
- [ ] PixiJS `Assets.load()` manifest with loading progress callbacks
- [ ] Deferred audio init: Howler load on first pointer/key event
- [ ] PWA plugin + manifest + service worker
- [ ] Lighthouse audit: target Performance > 90, FCP < 1s
- [ ] Brotli compression on server (ASP.NET Core `UseResponseCompression`)

### Done when
Lighthouse Performance score > 90. First frame visible in < 1s on broadband.

---

## Directory Structure

```
DriftsInSpace/
  client/                       # Vite + TypeScript frontend
    src/
      sim/
        SimLoop.ts              # fixed-step accumulator (PhysicsSimul.cs port)
        Ship.ts                 # force integration (Spaceship.FixedUpdate port)
        ShipState.ts            # plain data struct
        World.ts                # owns ships + track, runs tick()
        Collision.ts            # circle vs segment/capsule/polygon
        Obstacles.ts            # primitive shapes + materials
        SpatialHash.ts          # broadphase
        Fields.ts               # boost zones, attractors (Boost.cs port)
        Track.ts                # obstacle list + checkpoint list
        Recorder.ts             # state + input stream recording
        Ghost.ts                # ghost playback (GhostReplay.cs port)
      input/
        InputManager.ts         # aggregator
        KeyboardInput.ts
        GamepadInput.ts
        TouchInput.ts           # virtual joystick (CustomizableTouchControlsNeo port)
      render/
        Renderer.ts             # owns PIXI.Application
        ShipView.ts             # player ship sprite + thruster effects
        GhostView.ts            # semi-transparent ghost
        RemoteShipView.ts       # multiplayer remote ships
        TrackView.ts            # obstacle + wall rendering
        HUD.ts                  # race timer, checkpoint indicators
      audio/
        AudioManager.ts         # Howler.js wrapper
        EngineAudio.ts          # pitch/volume formula (Spaceship.Update port)
        DriftAudio.ts           # drift ticker (Drifter.cs port)
        CollisionAudio.ts       # material-based (SpaceshipCollisions port)
      editor/
        EditorApp.ts
        DualBrush.ts            # CatamaranBrushNeo port
        WallPainter.ts
        ObstaclePalette.ts
        Eraser.ts
        TrackSerializer.ts
        LocalStorage.ts
      race/
        RaceManager.ts          # state machine (RaceManagerNeo port)
        CheckpointTracker.ts    # (Track.EnterCheckpoint port)
      ships/
        ShipRoster.ts           # ship stats definitions
      net/
        MultiplayerClient.ts    # SignalR + MessagePack
        StateBuffer.ts          # ring buffer (LiteRingBuffer port)
        RemoteShip.ts           # interpolated remote ship (RemotePlayer.cs port)
        Protocol.ts             # packet types (PShipUpdate port)
      storage/
        GhostStore.ts           # IndexedDB
        SettingsStore.ts        # localStorage
      main.ts
    public/
      manifest.json             # PWA
    index.html
    vite.config.ts
    tsconfig.json

  server/                       # ASP.NET Core backend
    DriftsInSpace.Server/
      Program.cs
      Hubs/
        RaceHub.cs              # SignalR multiplayer hub
      Endpoints/
        AuthEndpoints.cs
        TrackEndpoints.cs
        ScoreEndpoints.cs
      Services/
        AntiCheatService.cs     # background verification
        JwtService.cs
      Models/
        Entities/               # EF Core entities
        Dtos/                   # request/response DTOs (mirrored from ANXRacers)
      Data/
        AppDbContext.cs
        Migrations/
      DriftsInSpace.Server.csproj
    DriftsInSpace.Sim/          # shared sim C# library (for anti-cheat server replay)
      Ship.cs                   # port of Spaceship.FixedUpdate in pure C#
      SimLoop.cs
      Collision.cs
    DriftsInSpace.sln

  docs/
    PLAN.md                     # this file
    architecture.md             # data formats, packet specs, sim math reference

  tools/
    pack-sprites.js             # texture atlas build script
```

---

## Open Questions / Future Work

- **Lap racing vs point-to-point**: current plan assumes point-to-point time trial. Lap mode is additive — checkpoint wrapping already supports it.
- **Modding / track sharing**: ANXRacers has a full mod pack system (`ModPacks/`). For DriftsInSpace, the public track API in M8 is the equivalent.
- **Ship visual customization**: deferred intentionally. Ship stats are in place; adding skins is cosmetic-only (swap sprite in atlas).
- **AI opponents**: ANXRacers has an `AI/` folder. Not planned for DriftsInSpace but the ghost replay system is the foundation — AI could follow a ghost path.
- **Mobile app (PWA)**: M10 PWA covers "installable" on mobile. Native iOS/Android is not planned.
