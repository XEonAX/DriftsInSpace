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
M0 Scaffold ──► M1 Sim Loop ──► M2 Collision ──► M3 Ghost Replay ◄── first playable milestone
                                      │
                               ANXRacers level
                               loader as test track
                               (no editor needed yet)

After M3:

M4 Input ──► M5 Audio ──► M6 Ships ──► M7 Track Editor
                                               │
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
- Persistent `Boost` vector accumulated from prop fields, added each tick

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
  displayPos   = lerp(prevState.pos,   currentState.pos,   alpha)
  displayAngle = lerpAngle(prevState.angle, currentState.angle, alpha)
  ```
- [ ] Main loop: `requestAnimationFrame` → `SimLoop.update(delta)` → `Renderer.draw(alpha)`

### Ship Stats (ANXRacers defaults to port)

```typescript
// Direct port of ANXRacers Spaceship inspector defaults
const DEFAULT_SHIP: ShipStats = {
  mass:          1,
  surgeForward:  300,
  surgeBackward: 200,
  strafe:        100,
  torque:        1000,
  linearDrag:    /* rb.drag when input active — read from Unity inspector */,
  angularDrag:   /* rb.angularDrag when input active */,
  radius:        0.5,
  friction:      /* PhysicsMaterial2D.friction */,
  bounce:        /* PhysicsMaterial2D.bounciness */,
};
```

### Done when
Ship moves, drifts, and decelerates with the same feel as ANXRacers. No collision yet.

---

## M2 — Collision, Obstacles & ANXRacers Level Loader

**Goal:** Ship collides with the obstacle palette. An existing ANXRacers `.json` level file loads and becomes the test track — no editor needed yet.

### Background — ANXRacers Level Format

ANXRacers `Level` (serialised to JSON) contains exactly:

```csharp
Level {
  TrackData Track;                      // Checkpoints + Laps + Difficulty
  ObstacleTypeAndTransform[] Obstacles; // ALL physics objects — walls included
  PropTypeAndTransform[]     Props;     // Boost | Attractor | Repulsor
}
TrackData     { TransformData[] Checkpoints; int Laps; float Difficulty; }
TransformData { Vector3 Position; Quaternion Rotation; }
ObstacleTypeAndTransform { ObstacleType Type; TransformData Transform; }
PropTypeAndTransform      { PropType     Type; TransformData Transform; }
```

**There are no wall arrays.** Walls are placed as obstacle objects by the catamaran brush, stored in `Obstacles[]` exactly like rocks and capsules. The `ObstacleType` enum name encodes the collision shape:

| Name pattern | Collision shape | Notes |
|---|---|---|
| `circle100x100*` | Circle r=0.5 | `*` = material suffix |
| `capsule100x300*` | Capsule r=0.5, h=3.0 | Primary wall piece |
| `capsule100x200*` | Capsule r=0.5, h=2.0 | Shorter wall piece |
| `elementExplosive*` | AABB rectangle | Size encoded in name |
| `elementGlassCircle*` | Circle | Radius from name |
| `elementGlass*x*` | Rectangle | WxH from name |
| `meteorBrown_big*` | Circle (large) | Circular rock |
| `spaceMeteors_*` | Circle (small) | Small rock |
| `poly4Vert*` | Convex polygon, 4 verts | Vertices in shape table |
| `poly5Vert*` | Convex polygon, 5 verts | |
| `poly7Vert*` | Convex polygon, 7 verts | |
| `*Force*` | Same shape + area effector | Applies velocity impulse |

Materials: `Rock`, `Metal`, `Ice` — suffix on capsule/circle types, drives audio on collision.

Props (separate from obstacles, no collision shape — only triggers):

| PropType | Behaviour |
|---|---|
| `Boost` | Adds directional vector to `ship.boost` on trigger enter, removes on exit |
| `Attractor` | Constant radial pull toward prop position (field every tick) |
| `Repulsor` | Constant radial push (field every tick) |

### Collision Descriptor Table

`src/sim/ObstacleShapes.ts` maps each `ObstacleType` string to a collision shape. Polygon vertices are extracted once from Unity prefabs and hardcoded here — they never change at runtime.

```typescript
type CollisionShape =
  | { kind: 'circle';  radius: number;  material: Material }
  | { kind: 'capsule'; radius: number;  halfHeight: number; material: Material }
  | { kind: 'polygon'; verts: Vec2[];                       material: Material }
  | { kind: 'rect';    halfW: number;   halfH: number;     material: Material };

const SHAPES: Record<ObstacleType, CollisionShape> = {
  circle100x100Rock:   { kind: 'circle',  radius: 0.5,              material: 'Rock' },
  capsule100x300Rock:  { kind: 'capsule', radius: 0.5, halfHeight: 1.5, material: 'Rock' },
  capsule100x300Metal: { kind: 'capsule', radius: 0.5, halfHeight: 1.5, material: 'Metal' },
  // ... all 38 types
};
```

### Collision Response

All obstacles are **static**. Ship is a circle. Four narrow-phase cases:

- **Circle vs Circle**: `|P - C| < r1 + r2`
- **Circle vs Capsule**: closest point on segment between capsule endpoints; effective radius = `ship.r + capsule.r`
- **Circle vs Polygon**: SAT — test edge normals + vertex voronoi regions
- **Circle vs Rect**: treat rect as 4 segments

Response (same for all): push ship out along contact normal, reflect velocity with `bounce` coefficient, dampen tangent with `friction`.

### Spatial Hash & CCD

```
Cell size = 2 × largest obstacle radius
Static obstacles inserted once at track load
Dynamic (ships) queried every tick: 9 cells around ship centre → narrow-phase candidates
CCD: if |vel| × dt > ship.radius × 0.5 → run 2 sub-steps that tick
```

### ANXRacers Level Loader

`src/level/ANXRacersLoader.ts` reads an ANXRacers `Level` JSON → `TrackData`:

```typescript
function loadANXRacersLevel(json: ANXRacersLevelJson): TrackData {
  return {
    id:          json.LevelId,
    name:        json.LevelName,
    lapCount:    json.Track.Laps,
    startPos:    extractStartPos(json),
    startAngle:  0,
    checkpoints: json.Track.Checkpoints.map(toCheckpointDef),
    obstacles:   json.Obstacles.map(o => ({
      type:     o.Type as ObstacleType,
      pos:      [o.Transform.Position.x, o.Transform.Position.y] as Vec2,
      rotation: quaternionToAngle(o.Transform.Rotation),
    })),
    props:       json.Props.map(p => ({
      type:  p.Type as PropType,
      pos:   [p.Transform.Position.x, p.Transform.Position.y] as Vec2,
      angle: quaternionToAngle(p.Transform.Rotation),
    })),
    centerline:  [],
    brushRadius: 0,
  };
}
```

### Tasks

- [ ] `src/sim/ObstacleShapes.ts` — collision descriptor for all 38 ANXRacers `ObstacleType` values
- [ ] `src/sim/Collision.ts` — circle vs circle, capsule, polygon (SAT), rect
- [ ] `src/sim/SpatialHash.ts` — insert/query/clear; static obstacles inserted once
- [ ] `src/sim/Fields.ts` — Boost (add/remove boost vector), Attractor, Repulsor triggers
- [ ] `src/sim/Track.ts` — obstacle list + spatial hash + checkpoint list
- [ ] `src/level/ANXRacersLoader.ts` — parse ANXRacers Level JSON → `TrackData`
- [ ] `src/level/TrackData.ts` — `TrackData` interface + `ObstacleType` enum + `PropType` enum
- [ ] `src/render/TrackView.ts` — render obstacles (placeholder coloured shapes before sprites)
- [ ] Wire collision into `Ship.tick()`: integrate → broadphase → resolve contacts
- [ ] Drop a real ANXRacers `.json` in `public/levels/test.json`, load at startup

### Done when
Ship races on a real ANXRacers track, collides with obstacles, passes checkpoints in order.

---

## M3 — Ghost Replay (First Playable Milestone)

**Goal:** Race against your own best time. Ghost plays back recorded state of the best run.

### Recording Architecture

Two parallel streams, recorded simultaneously during every race:

**Stream 1 — State Stream** (drives ghost playback on client):

```
Frame layout: 10 bytes  (no explicit tick — index is implicit: frame i = time i × TICK_DT)
  [0..3]  x     : int32    pos.x * 1000  (millimetre precision)
  [4..7]  y     : int32    pos.y * 1000
  [8..9]  angle : uint16   full-circle mapping: 0..65535 → 0..2π
                           resolution: 360° / 65536 ≈ 0.0055° — smooth enough
```

Angle encoding:
```typescript
// Encode (normalise to [0, 2π) first)
const a       = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
const encoded = Math.round(a / TWO_PI * 65535) & 0xFFFF;  // uint16

// Decode
const angle = (encoded / 65535) * TWO_PI;
```

Capacity at 50Hz for a 300s race: 15,000 frames × 10 bytes = 150 KB uncompressed → ~20–30 KB zlib.

**Stream 2 — Input Stream** (uploaded to server as anti-cheat audit trail, never drives sim):

```
Frame layout: 7 bytes
  [0..3]  frameIndex : uint32
  [4]     surge      : int8    surge  * 127
  [5]     strafe     : int8    strafe * 127
  [6]     torque     : int8    torque * 127
```

Stored server-side alongside the score. The server does **not** re-run the sim (see M8).

### Ghost Playback

Port of `GhostReplay.cs Update()`:

```typescript
const frameF  = raceTime / TICK_DT;
const i       = Math.floor(frameF);
const t       = frameF - i;                          // [0, 1]
ghost.pos     = lerp(frames[i].pos,   frames[i+1].pos,   t);
ghost.angle   = lerpAngle(frames[i].angle, frames[i+1].angle, t);
```

Rendered as semi-transparent ship (alpha 0.5) with name label + best time.

### Ghost Storage

Keyed by `trackId:shipId` — **per-track per-ship**. A Scout personal best is separate from a Freighter best on the same track.

```typescript
// IndexedDB store: 'ghosts'
// Key:   `${trackId}:${shipId}`
// Value: { time: number, stateStream: Uint8Array /* zlib-compressed */ }
```

### Race Flow

```
PreRace → Countdown (3-2-1) → Racing → RaceFinished
```
- Timer starts on GO
- Checkpoints: ordered, must pass in sequence
- Finish: last checkpoint → `RaceFinished`, record time
- If `time < storedBestTime` → replace ghost + time in IndexedDB
- Best ghost displayed on next attempt

### Tasks

- [ ] `src/sim/Recorder.ts` — records state + input frames each tick when `recording = true`
- [ ] `src/sim/Ghost.ts` — loads compressed frames, `getInterpolatedState(raceTime): GhostState`
- [ ] `src/render/GhostView.ts` — semi-transparent ship, label
- [ ] `src/race/RaceManager.ts` — state machine: `PreRace → Countdown → Racing → Finished`
- [ ] `src/race/CheckpointTracker.ts` — ordered validation (port `Track.EnterCheckpoint`)
- [ ] `src/storage/GhostStore.ts` — IndexedDB CRUD keyed by `trackId:shipId`
- [ ] Race HUD: current time, ± delta vs best, checkpoint indicator
- [ ] Finish dialog: time, delta, "New Record" badge

### Done when
Complete a race. Your ghost appears on the next attempt. Beat your time, new ghost replaces it.

---

## M4 — Input System

**Goal:** Keyboard, gamepad, and touch all feed the same `InputState`. Matches ANXRacers `InputMgr.cs`.

### Unified Interface

```typescript
interface InputState {
  surge:  number;  // [-1, 1]
  strafe: number;  // [-1, 1]
  torque: number;  // [-1, 1]
}
```

### Keyboard

| Key | Action |
|---|---|
| `W` / `↑` | surge +1 |
| `S` / `↓` | surge −1 |
| `A` / `←` | torque −1 |
| `D` / `→` | torque +1 |
| `Q` | strafe −1 |
| `E` | strafe +1 |
| `R` | restart race |

### Gamepad (Gamepad API)

- Left stick X/Y → strafe, surge
- Right stick X → torque
- Polled every sim tick (not event-driven)
- Deadzone: `|axis| < 0.1 → 0`

### Touch (port of `CustomizableTouchControlsNeo.cs`)

- Left joystick: surge + strafe (dual axis)
- Right joystick: torque (horizontal only)
- Joystick positions moveable by long-press drag, saved to localStorage
- Rendered as PixiJS `Graphics` (no DOM z-index issues)

### Tasks

- [ ] `src/input/InputManager.ts` — aggregate all sources
- [ ] `src/input/KeyboardInput.ts`
- [ ] `src/input/GamepadInput.ts` — poll `navigator.getGamepads()` in sim tick
- [ ] `src/input/TouchInput.ts` — dual virtual joystick, PixiJS pointer events
- [ ] Gamepad vibration on collision: `vibrationActuator.playEffect()` scaled by impact
- [ ] Input binding overlay: tap key/button to rebind

### Done when
All three input methods control the ship. Touch joystick positions persist across sessions.

---

## M5 — Audio

**Goal:** Engine hum, drift ticking, collision sounds, BGM. Direct port of ANXRacers audio logic.

### Engine Hum (port of `Spaceship.Update`)

```typescript
enginePower = lerp(enginePower, clamp(input.surge, 0, 1) * 0.5, dt * 3);
engineSound.volume(enginePower + 0.3);
engineSound.rate(enginePower + 1 - (0.5 / (1 + vel * 0.5 + Math.abs(angVel) * 0.5)));
```

### Drift Ticker (port of `Drifter.FixedUpdate`)

```typescript
const right      = vec2(-Math.sin(angle), Math.cos(angle));
const driftValue = Math.abs(dot(normalize(vel), right) * input.surge);
// SmoothDamp driftValue → drive Howler volume + rate
```

### Collision Audio (port of `SpaceshipCollsions.ProcessCollision`)

- Three sprites: rock, metal, ice — selected by `obstacle.material`
- Volume = `1 - 1/(1 + relativeVelocity)` — identical to ANXRacers
- Pitch randomised ±10%

### Howler Setup

```typescript
const sfx = new Howl({
  src: ['sfx.webm', 'sfx.mp3'],
  sprite: {
    engineIdle: [0,    2000, true],
    driftTick:  [2000, 500],
    rockHit:    [2500, 300],
    metalHit:   [2800, 300],
    iceHit:     [3100, 300],
    checkpoint: [3400, 500],
    boost:      [3900, 800],
  },
  preload: false,  // load on first user gesture
});
```

### Tasks

- [ ] `src/audio/AudioManager.ts`, `EngineAudio.ts`, `DriftAudio.ts`, `CollisionAudio.ts`
- [ ] BGM `Howl` with `loop: true`
- [ ] Web Audio unlock handler (silent buffer on first pointer/key)
- [ ] Volume settings: master, SFX, BGM (localStorage)

### Done when
Engine pitch rises with speed. Drift ticker activates on lateral slip. Walls play distinct material sounds.

---

## M6 — Ship Stats System

**Goal:** Three ships with distinct physics. Leaderboards are per-track per-ship.

### Ship Definition

```typescript
interface ShipStats {
  id:           string;
  name:         string;
  // Field names match ANXRacers ShipPhysics DTO exactly
  mass:         number;
  linearDrag:   number;    // LDrag
  angularDrag:  number;    // ADrag
  surgeForward: number;
  surgeBackward:number;
  strafe:       number;
  torque:       number;
  radius:       number;
  friction:     number;
  bounce:       number;
}
```

### Roster

| Ship | Feel | Mass | Drag | Speed | Turn |
|---|---|---|---|---|---|
| Scout | Light, twitchy | Low | Low | High | High |
| Freighter | Heavy, stable | High | Med | Med | Low |
| Drifter | Balanced, bouncy | Med | Low | Med | High |

### Tasks

- [ ] `src/ships/ShipRoster.ts` — static array of `ShipStats` (values from ANXRacers inspector)
- [ ] Ship selection screen with stats bars (port `ShipStatSlider.cs`)
- [ ] Selected ship persisted in `localStorage`
- [ ] Ghost store key = `trackId:shipId` — already the design from M3

### Done when
Three ships feel different. Each ship has its own leaderboard per track.

---

## M7 — Draw-A-Track Editor

**Goal:** Draw a track in the browser like ANXRacers draw-a-track. Race immediately on it.

### Background — ANXRacers source

`CatamaranBrushNeo.cs`: left and right brushes trail the ship at ±`BrushRadius`, each placing obstacle objects from a selected template as the ship moves. Placed objects are stored in `Obstacles[]` — the **same array used for rocks and other obstacles**. There is no separate wall data structure.

`DrawATrackMgrNeo.cs`: `Time.fixedDeltaTime = 0.001f` (1000Hz!) so the brush never skips.

### What the Editor Produces

A `TrackData` — `PlacedObstacle[]` and `PlacedProp[]` with named `ObstacleType` values. The sim and renderer treat editor-placed objects identically to loaded ANXRacers level objects.

### Editor Modes

| Mode | Description |
|---|---|
| `Draw` | Drive or drag cursor — dual brush places wall capsules |
| `Erase` | Circle eraser removes obstacles within radius |
| `Place` | Tap to place obstacle, boost, or checkpoint from palette |
| `Transform` | Drag objects to reposition |
| `Playtest` | Race current track; back button returns to editor |

### Tasks

- [ ] `src/editor/EditorApp.ts` — separate PixiJS stage, switch with race stage
- [ ] `src/editor/DualBrush.ts` — port `CatamaranBrushNeo`: emit `PlacedObstacle` every N pixels of movement
- [ ] `src/editor/ObstaclePlacer.ts` — accumulates `PlacedObstacle[]`, re-renders `TrackView`
- [ ] `src/editor/ObstaclePalette.ts` — panel: capsule sizes (short/long × rock/metal/ice), circles, polygons, boost, checkpoint
- [ ] `src/editor/Eraser.ts` — remove obstacles within circle radius (port `TrackEraser.cs`)
- [ ] `src/editor/TrackSerializer.ts` — `TrackData` ↔ JSON
- [ ] `src/editor/TrackStore.ts` — IndexedDB: multiple named tracks, last-edited first
- [ ] Playtest button: load `TrackData` → `World`, start race, show "back to editor" overlay
- [ ] Minimap thumbnail: render `TrackView` to off-screen `<canvas>` → PNG blob

### Done when
Draw a track, place checkpoints and boosts, Playtest it, save and reload across sessions.

---

## M8 — Backend (.NET)

**Goal:** Persistent tracks, per-track-per-ship leaderboards, ghost download, passive anti-cheat.

### Technology

- ASP.NET Core 9 minimal API
- EF Core + SQLite (mirrors ANXRacers server)
- JWT Bearer auth (same pattern as ANXRacers `UserController.cs`)
- Docker: self-contained binary + SQLite volume

### Anti-Cheat: Trust But Flag

No server-side sim replay (avoids maintaining a parallel C# physics sim). Instead, a background `IHostedService` runs passive checks on newly submitted scores:

- Max velocity per frame in state stream (physics ceiling is `surgeForward / linearDrag` per ship)
- Checkpoint split times vs theoretical minimum
- Score submission rate limiting

Suspicious scores get a non-null `FlagReason` and are held from the public leaderboard pending review. Scores are never silently dropped.

### Leaderboard Key

`(TrackId, ShipId)` — per-track per-ship. Score rows include `ShipId`.

### API Surface

**Auth**
```
POST /auth/register  { username, password } → { token, userId }
POST /auth/login     { username, password } → { token, userId }
```

**Tracks**
```
POST   /tracks                    { TrackData } → { trackId }  [auth]
GET    /tracks                    ?page&size → TrackListItem[]
GET    /tracks/{id}               → TrackData + metadata
PUT    /tracks/{id}                                             [author only]
DELETE /tracks/{id}                                             [author only]
```

**Scores / Ghosts**
```
POST /scores/{trackId}/{shipId}           { time, stateStream, inputStream } → { rank } [auth]
GET  /scores/{trackId}/{shipId}           ?limit=20 → ScoreEntry[]
GET  /scores/{trackId}/{shipId}/ghost/{scoreId}     → stateStream bytes
GET  /scores/{trackId}/{shipId}/best                → personal best ghost   [auth]
```

### Database Schema

```sql
Users   (UserId, Username, PasswordHash, CreatedAt)
Tracks  (TrackId, AuthorId, Name, TrackJson, Version, CreatedAt, ModifiedAt)
Scores  (ScoreId, TrackId, ShipId, UserId, Time,
         StateStream BLOB, InputStream BLOB,
         SubmittedAt, FlagReason TEXT NULL)
```

### Tasks

- [ ] `server/DriftsInSpace.Server/` — new .NET 9 solution
- [ ] EF Core migrations for Users, Tracks, Scores
- [ ] Auth: BCrypt + JWT signing
- [ ] Track CRUD endpoints
- [ ] Score submission: store streams, return rank (COUNT WHERE Time < submitted)
- [ ] Ghost download endpoint: serve zlib state stream bytes
- [ ] `PassiveAntiCheat.cs` — `IHostedService`, populates `FlagReason`
- [ ] CORS for `localhost:5173` (dev) + production domain
- [ ] Docker build

### Done when
Upload a ghost, see it on the leaderboard, download and race against it.

---

## M9 — Multiplayer

**Goal:** Live races. Same state-sync model as ANXRacers `Client.cs`.

### Network Model

State sync at 20Hz (50ms). Each client sends its state; server fans out to all players in the room.

### Packets (mirrors ANXRacers `PShipUpdate`)

```typescript
// Client → Server, MessagePack array format (~13 bytes)
[mpId: uint32, tick: uint32, x: int32, y: int32, angle: uint16]
// angle: same uint16 encoding as state stream (0..65535 → 0..2π)

// Server → All clients
[serverTime: uint32, players: ShipUpdatePacket[]]
```

### SignalR — Lazy-Loaded

The SignalR JS client (~90 KB gz) is dynamically imported **only when entering the multiplayer lobby**. It never appears in the initial bundle.

```typescript
async function connect() {
  const { HubConnectionBuilder }     = await import('@microsoft/signalr');
  const { MessagePackHubProtocol }   = await import('@microsoft/signalr-protocol-msgpack');
  // build connection...
}
```

### Client Interpolation (port of `RemotePlayer.cs`)

Ring buffer of 50 `ShipUpdatePacket` slots per remote ship. `bufferHealth` and `timespeed` logic identical to ANXRacers `RemotePlayer.LateUpdate`.

### Tasks

- [ ] `RaceHub.cs` — SignalR hub, room management, state fan-out
- [ ] `src/net/MultiplayerClient.ts` — lazy import + connection lifecycle
- [ ] `src/net/StateBuffer.ts` — ring buffer (port `LiteRingBuffer`)
- [ ] `src/net/RemoteShip.ts` — interpolated remote ship (port `RemotePlayer.cs`)
- [ ] `src/render/RemoteShipView.ts` — name labels, offscreen arrows
- [ ] Lobby UI: create room / join by 6-char code / player list
- [ ] Race countdown: server-authoritative `startAtUnixMs` timestamp
- [ ] Multiplayer finish ranks contributed to M8 leaderboard

### Done when
Two browsers race on the same track in real time with smooth interpolation.

---

## M10 — Load Speed & Polish

**Goal:** < 350 KB initial gzipped payload, < 1s first render, Lighthouse > 90.

### Bundle Size Budget

| Asset | Gzipped target |
|---|---|
| PixiJS v8 vendor chunk | ~180 KB |
| Howler.js | ~10 KB |
| `@msgpack/msgpack` | ~15 KB |
| Game code | ~80 KB |
| Ship + obstacle sprite atlas | ~50 KB |
| **Initial total** | **< 335 KB** |
| SFX sprite sheet (deferred) | ~200 KB |
| BGM (streamed after start) | ~1 MB |
| SignalR + protocol (lazy) | ~90 KB — only if multiplayer entered |

### Vite Config

```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        vendor:  ['pixi.js', 'howler'],
        msgpack: ['@msgpack/msgpack'],
        // @microsoft/signalr and @microsoft/signalr-protocol-msgpack
        // are dynamic imports — Vite splits them automatically
      }
    }
  }
}
```

### PWA

- `vite-plugin-pwa` — cache-first for all static assets
- Offline: races on downloaded tracks work without network (IndexedDB state)
- "Add to home screen" prompt on mobile

### Tasks

- [ ] Vite chunk config + verify SignalR stays out of initial bundle
- [ ] Sprite atlas build script (`tools/pack-sprites.js`)
- [ ] PixiJS `Assets.load()` manifest with progress callbacks
- [ ] Howler `preload: false`, load on first gesture
- [ ] PWA manifest + service worker
- [ ] Brotli compression (`UseResponseCompression` on server)
- [ ] Lighthouse audit: Performance > 90, FCP < 1s

### Done when
Lighthouse > 90. First frame < 1s on broadband. Offline works on a downloaded track.

---

## Directory Structure

```
DriftsInSpace/
  client/
    src/
      sim/
        SimLoop.ts          # fixed-step accumulator (PhysicsSimul.cs port)
        Ship.ts             # force integration (Spaceship.FixedUpdate port)
        ShipState.ts        # plain data struct
        World.ts            # owns ships + track
        Collision.ts        # circle vs circle / capsule / polygon / rect
        ObstacleShapes.ts   # collision descriptor table for all ObstacleType values
        SpatialHash.ts      # broadphase
        Fields.ts           # Boost / Attractor / Repulsor (Boost.cs port)
        Track.ts            # obstacle list + spatial hash + checkpoint tracker
        Recorder.ts         # state stream + input stream
        Ghost.ts            # playback (GhostReplay.cs port)
      level/
        ANXRacersLoader.ts  # ANXRacers Level JSON → TrackData
        TrackData.ts        # TrackData interface + ObstacleType + PropType enums
      input/
        InputManager.ts     # aggregator (InputMgr.cs port)
        KeyboardInput.ts
        GamepadInput.ts
        TouchInput.ts       # virtual joystick (CustomizableTouchControlsNeo port)
      render/
        Renderer.ts         # owns PIXI.Application
        ShipView.ts         # player ship + thrusters
        GhostView.ts        # semi-transparent ghost
        RemoteShipView.ts   # multiplayer remote ships
        TrackView.ts        # obstacles + props
        HUD.ts              # timer, checkpoint indicators
      audio/
        AudioManager.ts
        EngineAudio.ts      # Spaceship.Update port
        DriftAudio.ts       # Drifter.cs port
        CollisionAudio.ts   # SpaceshipCollisions port
      editor/
        EditorApp.ts
        DualBrush.ts        # CatamaranBrushNeo port
        ObstaclePlacer.ts   # accumulates PlacedObstacle[]
        ObstaclePalette.ts
        Eraser.ts           # TrackEraser.cs port
        TrackSerializer.ts
        TrackStore.ts       # IndexedDB
      race/
        RaceManager.ts      # state machine (RaceManagerNeo port)
        CheckpointTracker.ts
      ships/
        ShipRoster.ts
      net/
        MultiplayerClient.ts  # lazy SignalR import
        StateBuffer.ts        # ring buffer (LiteRingBuffer port)
        RemoteShip.ts         # RemotePlayer.cs port
        Protocol.ts           # packet types (PShipUpdate port)
      storage/
        GhostStore.ts         # IndexedDB, keyed trackId:shipId
        SettingsStore.ts      # localStorage
      main.ts
    public/
      levels/
        test.json             # one ANXRacers level file for M2 testing
      manifest.json
    index.html
    vite.config.ts
    tsconfig.json

  server/
    DriftsInSpace.Server/
      Program.cs
      Hubs/
        RaceHub.cs
      Endpoints/
        AuthEndpoints.cs
        TrackEndpoints.cs
        ScoreEndpoints.cs
      Services/
        PassiveAntiCheat.cs  # IHostedService, flags suspicious scores
        JwtService.cs
      Models/
        Entities/
        Dtos/                # field names mirrored from ANXRacers DTOs
      Data/
        AppDbContext.cs
        Migrations/
      DriftsInSpace.Server.csproj
    DriftsInSpace.sln

  docs/
    PLAN.md
    architecture.md

  tools/
    pack-sprites.js          # texture atlas build script
```

---

## Open Questions / Future Work

- **Lap racing**: `lapCount > 1` in `TrackData` is already wired; checkpoint wrapping supports it.
- **Track browser / sharing**: public track API in M8 is the equivalent of ANXRacers' level discovery.
- **Ship skins**: deferred. Ship stats are in; skins are cosmetic-only (swap sprite in atlas).
- **AI opponents**: not planned. Ghost replay is the foundation — AI could follow a ghost path.
- **Import ANXRacers tracks from live server**: the `ANXRacersLoader` in M2 reads local JSON. Fetching from `https://srv3.aeonax.com/ANXRacers/V3/` would let players import their existing ANXRacers tracks directly.
