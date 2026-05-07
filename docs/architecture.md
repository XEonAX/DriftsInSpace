# DriftsInSpace — Architecture Reference

Technical reference for data formats, simulation math, network protocol, and ANXRacers port mappings.

---

## Simulation Math

### Fixed-Step Loop

50 Hz. Wall clock accumulates; sim ticks consume it in fixed chunks.

```
TICK_DT = 0.02   // seconds (50 Hz)

acc += wallDeltaTime
while acc >= TICK_DT:
    acc -= TICK_DT
    world.tick(TICK_DT)
renderAlpha = acc / TICK_DT     // [0, 1] for visual interpolation
```

**ANXRacers equivalent:** `PhysicsSimul.cs` — `Physics2DTimeStep = 0.01` (100Hz). Same loop structure, halved rate.

### Ship Force Integration

Each tick, for each ship:

```
// Heading
forward = ( cos(angle), sin(angle) )
right   = (-sin(angle), cos(angle) )

// Thrust
thrust = surge > 0 ? surge * stats.surgeForward : surge * stats.surgeBackward
vel += forward * thrust  * dt / mass
vel += right   * strafe  * stats.strafe  * dt / mass
vel += boost              // persistent field vector (Boost.cs port)

// Conditional drag — ANXRacers: near-zero at rest, MaxLDrag/MaxADrag when thrusting
if surge == 0 && torque == 0:
    lDrag = COASTING_DRAG     // ~0.001
    aDrag = COASTING_ADRAG
else:
    lDrag = stats.linearDrag
    aDrag = stats.angularDrag

vel        *= (1 - lDrag * dt)
angularVel *= (1 - aDrag * dt)
angularVel += -torque * stats.torque * dt / mass

// Integrate
pos   += vel * dt
angle += angularVel * dt
```

**ANXRacers equivalent:** `Spaceship.FixedUpdate()` — `rb.AddTorque`, `rb.AddRelativeForce`, conditional drag assignment.

### Drift Metric

```
right      = (-sin(angle), cos(angle))
driftValue = |dot(normalize(vel), right)| * |surge|    // [0, 1]
```

0 = moving aligned with heading. 1 = fully sideways at full throttle.

**ANXRacers equivalent:** `Drifter.FixedUpdate()` — `Vector2.Dot(velocity/5, transform.right * inputSurge)`.

### Engine Audio Formula

```
// Runs every render frame (not sim tick) — visual smoothing
enginePower  = lerp(enginePower, clamp(surge, 0, 1) * 0.5, dt * 3)
volume       = enginePower + 0.3
pitch (rate) = enginePower + 1.0 - (0.5 / (1 + |vel| * 0.5 + |angularVel| * 0.5))
```

**ANXRacers equivalent:** `Spaceship.Update()` — identical formula.

### Collision Response (Circle vs Capsule, the most common case)

```
// Capsule endpoints A, B; capsule radius rc; ship radius rs
t       = clamp(dot(P-A, B-A) / |B-A|², 0, 1)
closest = A + t * (B-A)
n       = normalize(P - closest)
depth   = (rs + rc) - |P - closest|

if depth > 0:
    pos  += n * depth                          // push out
    vDotN = dot(vel, n)
    vel  -= n * vDotN * (1 + stats.bounce)    // reflect
    // friction: dampen tangential component
    tang  = vel - dot(vel, n) * n
    vel  -= tang * stats.friction * dt
```

Same pattern for circle-vs-circle (no endpoint clamping), circle-vs-rect (4 edges), circle-vs-polygon (SAT).

---

## Level / Track Data Format

### ANXRacers Level JSON (read-only input to `ANXRacersLoader`)

```typescript
// Mirrors ANXRacers Level.cs + Classes.cs exactly
interface ANXRacersLevelJson {
  LevelId:   string;
  LevelName: string;
  Track: {
    Laps:        number;
    Difficulty:  number;
    Checkpoints: Array<{
      Position: { x: number; y: number; z: number };
      Rotation: { x: number; y: number; z: number; w: number };
    }>;
  };
  Obstacles: Array<{
    Type:      string;   // ObstacleType enum key
    Transform: { Position: XYZ; Rotation: XYZW };
  }>;
  Props: Array<{
    Type:      string;   // 'Boost' | 'Attractor' | 'Repulsor'
    Transform: { Position: XYZ; Rotation: XYZW };
  }>;
}
```

### DriftsInSpace Native TrackData

Created by the editor (M7) and stored in IndexedDB / server DB.

```typescript
interface TrackData {
  // Identity
  id:           string;              // UUID
  name:         string;
  authorId:     string;
  version:      number;
  lapCount:     number;

  // Race start
  startPos:     [number, number];    // world coords
  startAngle:   number;             // radians

  // All physics objects — same split as ANXRacers Level.Obstacles / Level.Props
  obstacles:    PlacedObstacle[];
  props:        PlacedProp[];

  // Checkpoints (ordered) — same as ANXRacers TrackData.Checkpoints
  checkpoints:  CheckpointDef[];

  // Editor-only metadata (not consumed by sim)
  centerline:   [number, number][];  // raw drawn path for re-editing
  brushRadius:  number;
}

interface PlacedObstacle {
  type:     ObstacleType;    // string key into ObstacleShapes table
  pos:      [number, number];
  rotation: number;          // radians (converted from ANXRacers Quaternion)
}

interface PlacedProp {
  type:  PropType;            // 'Boost' | 'Attractor' | 'Repulsor'
  pos:   [number, number];
  angle: number;              // direction (Boost) or unused (Attractor/Repulsor)
}

interface CheckpointDef {
  pos:      [number, number];
  radius:   number;           // inversely proportional to difficulty
  isFinish: boolean;
}
```

### ObstacleType Enum and Collision Shapes

All 38 `ObstacleType` values from ANXRacers `Statics.cs`, with their collision geometry:

```typescript
// src/sim/ObstacleShapes.ts
type Material = 'Rock' | 'Metal' | 'Ice' | 'Glass' | 'None';
type CollisionShape =
  | { kind: 'circle';  radius: number;   material: Material }
  | { kind: 'capsule'; radius: number;   halfHeight: number; material: Material }
  | { kind: 'polygon'; verts: Vec2[];                        material: Material }
  | { kind: 'rect';    halfW: number;    halfH: number;      material: Material };

const SHAPES: Record<ObstacleType, CollisionShape> = {
  // Meteors (circles)
  meteorBrown_big1:  { kind: 'circle', radius: 2.56, material: 'Rock' },
  meteorBrown_big2:  { kind: 'circle', radius: 2.56, material: 'Rock' },
  meteorBrown_big3:  { kind: 'circle', radius: 2.56, material: 'Rock' },
  meteorBrown_big4:  { kind: 'circle', radius: 2.56, material: 'Rock' },
  spaceMeteors_001:  { kind: 'circle', radius: 0.64, material: 'Rock' },
  spaceMeteors_002:  { kind: 'circle', radius: 0.64, material: 'Rock' },
  spaceMeteors_003:  { kind: 'circle', radius: 0.64, material: 'Rock' },
  spaceMeteors_004:  { kind: 'circle', radius: 0.64, material: 'Rock' },
  // Boxes (rects — sizes from elementExplosiveNNN name)
  elementExplosive016: { kind: 'rect', halfW: 0.08, halfH: 0.08, material: 'Metal' },
  // ... all 38 entries — exact values to be measured from Unity prefabs
  // Capsules
  capsule100x300Rock:  { kind: 'capsule', radius: 0.5, halfHeight: 1.5, material: 'Rock' },
  capsule100x300Metal: { kind: 'capsule', radius: 0.5, halfHeight: 1.5, material: 'Metal' },
  capsule100x300Ice:   { kind: 'capsule', radius: 0.5, halfHeight: 1.5, material: 'Ice' },
  capsule100x200Rock:  { kind: 'capsule', radius: 0.5, halfHeight: 1.0, material: 'Rock' },
  capsule100x200Metal: { kind: 'capsule', radius: 0.5, halfHeight: 1.0, material: 'Metal' },
  capsule100x200Ice:   { kind: 'capsule', radius: 0.5, halfHeight: 1.0, material: 'Ice' },
  // Circles
  circle100x100Rock:   { kind: 'circle', radius: 0.5, material: 'Rock' },
  circle100x100Metal:  { kind: 'circle', radius: 0.5, material: 'Metal' },
  circle100x100Ice:    { kind: 'circle', radius: 0.5, material: 'Ice' },
  // Polygons — verts extracted once from Unity prefabs
  poly4Vert512ALargeRock: { kind: 'polygon', verts: [/* TBD */], material: 'Rock' },
  // ...
};
```

> **Action required at M2**: open each Unity prefab for polygon obstacles and record the `PolygonCollider2D` vertex arrays. All other shapes can be derived from the name alone.

### PropType

```typescript
type PropType = 'Boost' | 'Attractor' | 'Repulsor';

// Boost:     adds a directional vector to ship.boost on trigger enter;
//            removes it on trigger exit (port Boost.cs OnTriggerEnter2D / Exit2D)
// Attractor: applies radial force toward prop.pos every tick within radius
// Repulsor:  applies radial force away from prop.pos every tick within radius
```

---

## Ghost Recording Format

Two binary streams per race, written in parallel every sim tick.

### Stream 1 — State Stream (client ghost playback)

Fixed 10 bytes per frame. Tick is **implicit** — frame index `i` corresponds to race time `i × TICK_DT`.

```
Bytes  Field     Type     Encoding
0..3   x         int32    pos.x × 1000   (millimetre precision)
4..7   y         int32    pos.y × 1000
8..9   angle     uint16   full-circle: 0..65535 maps to 0..2π
                          resolution: 360° / 65536 ≈ 0.0055° per unit
```

**Total per frame: 10 bytes.**  
50 Hz × 300 s = 15,000 frames × 10 bytes = 150 KB uncompressed → ~20–30 KB zlib.

Angle encoding:
```typescript
// Encode
const a       = ((angle % TWO_PI) + TWO_PI) % TWO_PI;   // normalise to [0, 2π)
const encoded = Math.round(a / TWO_PI * 65535) & 0xFFFF; // uint16

// Decode
const angle = (encoded / 65535) * TWO_PI;

// Interpolation: always interpolate the short way around the circle
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % TWO_PI) - Math.PI;  // signed delta in (-π, π]
  return a + d * t;
}
```

Uploaded to server on score submission. Stored server-side only for the player's personal best.

### Stream 2 — Input Stream (server audit trail only)

Fixed 7 bytes per frame. **Never downloaded to other clients. Never drives the sim.**

```
Bytes  Field       Type    Encoding
0..3   frameIndex  uint32  redundant — helps detect truncation
4      surge       int8    surge  × 127   (-127..127 → -1..1)
5      strafe      int8    strafe × 127
6      torque      int8    torque × 127
```

15,000 frames × 7 bytes = 105 KB uncompressed → ~15–25 KB zlib.

Stored alongside state stream. Used by `PassiveAntiCheat` service to detect impossible inputs.

**ANXRacers equivalent:** `Recorder.cs` + `Ghost.Streams[]`. ANXRacers records separate channels per `StateStreams` enum value (`PosX`, `PosY`, `AngZ`, `Surge`, `Strafe`, etc.) as individual compressed float arrays. DriftsInSpace consolidates into two streams for simplicity.

---

## Network Protocol

### Packet Encoding

All multiplayer packets use MessagePack array format (not map) for minimal bytes.
Client: `@msgpack/msgpack`. Server: `MessagePack-CSharp`.

### ShipUpdatePacket (Client → Server, 20Hz)

```typescript
// Array: [mpId, tick, x, y, angle]
// mpId:  uint32
// tick:  uint32 — client sim tick counter
// x:     int32  — pos.x × 1000
// y:     int32  — pos.y × 1000
// angle: uint16 — same encoding as state stream
// Total: ~13 bytes per ship
```

**ANXRacers equivalent:** `PShipUpdate.cs` — identical fields, same quantization. Uses `int` for angle there (not quantised). Here we reuse the uint16 scheme for consistency with the state stream.

### PlayerStatesPacket (Server → All clients, 20Hz)

```typescript
// Array: [serverTime, players[]]
// serverTime: uint32 — milliseconds since server start
// players:    ShipUpdatePacket[]
```

**ANXRacers equivalent:** `PPlayerStates` in `Client.cs`.

### Client State Buffer (port of `RemotePlayer.cs`)

Ring buffer of 50 `ShipUpdatePacket` slots per remote ship.

```
On receive:
  push packet to ring buffer (discard oldest if full)

Each render frame:
  if bufferHealth >= bufferHealthThreshold:
    advance currentState; interpolate pos/angle toward nextState
  
  bufferHealth = |latestServerTick - clientTick|
  timespeed    = bufferHealth > threshold ? 1.05
               : bufferHealth < 3         ? 0.95
               :                            1.0
  // timespeed scales how fast the client clock advances to stabilise buffer
```

**ANXRacers equivalent:** `RemotePlayer.cs` — `LiteRingBuffer<PShipUpdate>`, `bufferHealth`, `timespeed`, `bufferHealthThreshold`. Logic is identical.

### SignalR Hub Contract

```csharp
// Client → Server
Task SendShipState(ShipUpdatePacket packet);
Task JoinRoom(string roomCode, string userId, string shipId);
Task LeaveRoom();

// Server → Client
Task ReceivePlayerStates(PlayerStatesPacket packet);
Task PlayerJoined(PlayerJoinedPacket packet);   // includes ShipStats for collision
Task PlayerLeft(uint mpId);
Task RaceCountdown(long startAtUnixMs);          // absolute time — all clients sync
Task RaceFinished(RaceResultsPacket results);
```

The SignalR JS client is **lazy-loaded** (dynamic `import()` on entering the multiplayer lobby).
It does not appear in the initial bundle.

---

## ANXRacers Port Map

| ANXRacers | DriftsInSpace | Notes |
|---|---|---|
| `PhysicsSimul.cs` | `sim/SimLoop.ts` | Loop identical, 50Hz vs 100Hz |
| `Spaceship.FixedUpdate()` | `sim/Ship.ts tick()` | Force formula identical, no Rigidbody2D |
| `Drifter.FixedUpdate()` | `audio/DriftAudio.ts` | Same dot product formula |
| `Boost.cs OnTriggerEnter/Exit2D` | `sim/Fields.ts` | Boost vector add/subtract on trigger |
| `Recorder.cs` | `sim/Recorder.ts` | Two flat streams vs per-channel Streams[] |
| `GhostReplay.cs Update()` | `sim/Ghost.ts` | Frame interpolation identical |
| `Ghost.Streams[]` | state stream + input stream | Consolidated: 2 streams vs N channels |
| `StateStreams` enum | state stream channels | PosX+PosY+AngZ merged into state stream |
| `Checkpoint.cs OnTriggerEnter2D` | `race/CheckpointTracker.ts` | Circle trigger, ordered validation |
| `Level.cs` | `TrackData` | Field names mirrored |
| `ObstacleTypeAndTransform` | `PlacedObstacle` | Same: type string + position + rotation |
| `PropTypeAndTransform` | `PlacedProp` | Same: Boost/Attractor/Repulsor |
| `ObstacleType` enum | `ObstacleType` string union | Identical values, no C# enum integer |
| `PropType` enum | `PropType` string union | Boost, Attractor, Repulsor |
| `ObstacleMaterial` enum | `Material` string union | Rock, Metal, Ice |
| `CatamaranBrushNeo.cs` | `editor/DualBrush.ts` | Dual-brush wall painting |
| `TrackEraser.cs` | `editor/Eraser.ts` | Circle erase of placed obstacles |
| `SpaceshipCollsions.cs` | `audio/CollisionAudio.ts` | Material-based audio |
| `Client.cs` | `net/MultiplayerClient.ts` | LiteNetLib → SignalR WebSocket |
| `RemotePlayer.cs` | `net/RemoteShip.ts` | Ring buffer interpolation identical |
| `LiteRingBuffer<T>` | `net/StateBuffer.ts` | Same ring buffer logic |
| `PShipUpdate.cs` | `net/Protocol.ts` | Same fields, MessagePack vs LiteNetLib |
| `PPlayerStates.cs` | `net/Protocol.ts` | Same fan-out packet |
| `InputMgr.cs` | `input/InputManager.ts` | Same `{surge, strafe, torque}` |
| `CustomizableTouchControlsNeo.cs` | `input/TouchInput.ts` | Moveable virtual joystick |
| `ShipPhysics` DTO | `ShipStats` | Identical field names |
| `DtoLevelResponse` | `DtoTrackResponse` (server) | Field names mirrored |
| `DtoScoreResponse` | `DtoScoreResponse` | Identical |

---

## Coordinate System

Matches ANXRacers Unity 2D world space:
- X: rightward
- Y: upward (Unity convention)
- Angle: radians, 0 = facing right (+X), counter-clockwise positive

PixiJS default: Y increases downward. Apply `stage.scale.y = -1` at the root container to match. All text and sprites that must not be flipped need a counter-scale: `textObject.scale.y = -1`.

---

## Performance Targets

| Metric | Target |
|---|---|
| Sim tick budget (50Hz = 20ms) | < 2ms for 8 ships + full collision |
| Render frame (60fps = 16.6ms) | < 8ms (leave browser headroom) |
| Initial bundle gzipped | < 335 KB |
| Time to first render | < 1 second |
| Ghost download (300s race) | < 35 KB (zlib state stream) |
| Multiplayer packet per ship | < 13 bytes per 50ms update |
| SignalR JS client | loaded only on multiplayer entry (lazy) |
