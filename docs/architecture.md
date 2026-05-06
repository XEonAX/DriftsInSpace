# DriftsInSpace — Architecture Reference

Technical reference for data formats, simulation math, network protocol, and ANXRacers port mappings.

---

## Simulation Math

### Fixed-Step Loop

Runs at 50 Hz. Wall clock time accumulates; sim ticks consume it in fixed chunks.

```
acc += wallDeltaTime
while acc >= 0.02:
    acc -= 0.02
    world.tick(0.02)
renderAlpha = acc / 0.02          // [0, 1] for visual interpolation
```

**ANXRacers equivalent:** `PhysicsSimul.cs` — `Physics2DTimeStep = 0.01` (100Hz). DriftsInSpace uses 50Hz; the loop structure is identical.

### Ship Force Integration

Each tick, for each ship:

```
// Input
surge  ∈ [-1, 1]    (forward/backward)
strafe ∈ [-1, 1]    (lateral)
torque ∈ [-1, 1]    (rotation)

// Heading vectors
forward = (cos(angle), sin(angle))
right   = (-sin(angle), cos(angle))

// Thrust
thrustMag = surge > 0 ? surge * stats.surgeForward
                       : surge * stats.surgeBackward
vel += forward * thrustMag * dt / stats.mass
vel += right   * stats.strafe * strafe * dt / stats.mass
vel += boost                        // persistent field accumulator

// Conditional drag (ANXRacers: drag=0.001 at rest, MaxLDrag/MaxADrag when thrusting)
if surge == 0 && torque == 0:
    linearDragThisTick  = COASTING_DRAG   // near 0
    angularDragThisTick = COASTING_ADRAG  // near 0
else:
    linearDragThisTick  = stats.linearDrag
    angularDragThisTick = stats.angularDrag

vel        *= (1 - linearDragThisTick  * dt)
angularVel *= (1 - angularDragThisTick * dt)

// Torque
angularVel += -torque * stats.torqueMultiplier * dt / stats.mass

// Integrate
pos   += vel * dt
angle += angularVel * dt
```

**ANXRacers equivalent:** `Spaceship.FixedUpdate()` — `rb.AddTorque`, `rb.AddRelativeForce`, conditional `rb.angularDrag = 0.001 / MaxADrag`.

### Drift Metric

```
// Used for audio (DriftAudio) and future drift-score system
right      = (-sin(angle), cos(angle))
driftValue = |dot(normalize(vel), right)| * |surge|
```
Range [0, 1]. 0 = aligned with heading. 1 = fully sideways.

**ANXRacers equivalent:** `Drifter.FixedUpdate()` — `Vector2.Dot(velocity/5, transform.right * inputSurge)`.

### Engine Audio Formula

```
// Run every render frame (visual update, not sim tick)
enginePower = lerp(enginePower, clamp(surge, 0, 1) * 0.5, dt * 3)
volume = enginePower + 0.3
pitch  = enginePower + 1.0 - (0.5 / (1 + |vel| * 0.5 + |angularVel| * 0.5))
```

**ANXRacers equivalent:** `Spaceship.Update()` — identical formula.

### Collision Response (Circle vs Segment)

```
// Given: circle center P, radius r, segment A→B
closest = A + clamp(dot(P-A, B-A) / |B-A|², 0, 1) * (B-A)
n       = normalize(P - closest)
depth   = r - |P - closest|

if depth > 0:
    // Push out
    pos += n * depth
    // Reflect velocity with material coefficients
    vDotN   = dot(vel, n)
    vel     -= n * vDotN * (1 + stats.bounce)
    // Friction: dampen tangential component
    tangent  = vel - dot(vel, n) * n
    vel     -= tangent * stats.friction * dt
```

**ANXRacers equivalent:** Unity Physics2D contact solver. Same result, explicit here.

---

## Track Data Format

Full JSON schema. Stored in server DB as `TEXT` column (compressed with gzip for download).

```typescript
interface TrackData {
  // Identity
  id:           string;    // UUID v4
  name:         string;
  authorId:     string;    // UUID
  version:      number;    // incremented on each save
  createdAt:    string;    // ISO 8601
  modifiedAt:   string;

  // Race config
  startPos:     [number, number];   // world coords [x, y]
  startAngle:   number;             // radians
  lapCount:     number;             // 1 = point-to-point time trial

  // Geometry
  walls: {
    segments: SegmentDef[];         // all wall segments (left + right walls merged)
  };
  obstacles:    ObstacleDef[];
  checkpoints:  CheckpointDef[];
  boostPads:    BoostPadDef[];
  attractors:   AttractorDef[];

  // Editor metadata (not used by sim)
  centerline:   [number, number][]; // raw drawn path, for re-editing
  brushRadius:  number;
}

interface SegmentDef {
  a:        [number, number];
  b:        [number, number];
  material: 'Rock' | 'Metal' | 'Ice';
}

interface ObstacleDef {
  kind:     'Segment' | 'Capsule' | 'Polygon';
  // Segment / Capsule
  a?:       [number, number];
  b?:       [number, number];
  radius?:  number;
  // Polygon
  verts?:   [number, number][];
  material: 'Rock' | 'Metal' | 'Ice';
}

interface CheckpointDef {
  index:    number;           // ordered 0, 1, 2, ...
  pos:      [number, number];
  radius:   number;           // inversely proportional to difficulty
  isFinish: boolean;
}

interface BoostPadDef {
  pos:      [number, number];
  angle:    number;           // direction of boost vector
  strength: number;           // magnitude applied to ship boost vector
  radius:   number;           // trigger radius
}

interface AttractorDef {
  pos:      [number, number];
  radius:   number;           // field radius
  strength: number;           // positive = pull, negative = push
}
```

**ANXRacers equivalent:** `Level.cs` — `TrackData Track`, `ObstacleTypeAndTransform[] Obstacles`, `PropTypeAndTransform[] Props`. Field names deliberately mirrored.

---

## Ghost Recording Format

Two streams per race, recorded in parallel.

### Stream 1 — State Stream (client ghost playback)

Binary, little-endian. Fixed 12 bytes per frame.

```
Frame layout (12 bytes):
  [0..3]  tick  : uint32   sim tick counter (0-based, increments each 50Hz tick)
  [4..7]  x     : int32    pos.x * 1000   (millimetre precision)
  [8..11] y     : int32    pos.y * 1000
  [12..13] angle: int16    angle * 10000  (0.0001 radian precision, wraps ±π)

// Note: angle stored as int16 → ±3.2768 rad ≈ ±187.8°
// For full 360°: store (angle + π) * 10000 as uint16, unwrap on decode
```

Capacity: 50Hz × 300s race = 15,000 frames × 12 bytes = 180 KB uncompressed.
After zlib: ~20–40 KB typical.

Uploaded to server on `POST /scores/{trackId}` alongside the score claim. Stored for the player's personal best only.

### Stream 2 — Input Stream (server anti-cheat, never sent to other clients)

Binary, little-endian. Fixed 7 bytes per frame.

```
Frame layout (7 bytes):
  [0..3]  tick   : uint32
  [4]     surge  : int8    surge  * 127    (-127..127 maps to -1..1)
  [5]     strafe : int8    strafe * 127
  [6]     torque : int8    torque * 127
```

15,000 frames × 7 bytes = 105 KB uncompressed. After zlib: ~15–25 KB.

Uploaded alongside state stream. Server re-runs sim from input stream. Score rejected if `|serverTime - claimedTime| > 500ms`.

**ANXRacers equivalent:** `Recorder.cs` state recording + Ghost input stream. Split into two streams here for clarity.

---

## Network Protocol

### Packet Encoding

All multiplayer packets encoded with MessagePack (`@msgpack/msgpack` on client, `MessagePack-CSharp` on server). No JSON in the multiplayer hot path.

### ShipUpdatePacket (Client → Server, 20Hz)

```typescript
// MessagePack array format (not map) for minimal bytes
[mpId: uint32, tick: uint32, x: int32, y: int32, angle: int32]
// Total: ~18 bytes per ship per update
// angle: same encoding as state stream (radians * 10000)
```

**ANXRacers equivalent:** `PShipUpdate` — identical fields, same quantization strategy.

### PlayerStatesPacket (Server → All clients, 20Hz)

```typescript
[serverTime: uint32, players: ShipUpdatePacket[]]
// serverTime: milliseconds since server start (for client clock sync)
```

**ANXRacers equivalent:** `PPlayerStates` in `Client.cs`.

### Client State Buffer (Interpolation)

Ring buffer of 50 `ShipUpdatePacket` slots per remote ship.

```
On receive:
  if buffer full: discard oldest, push new
  else: push new

Each render frame:
  if bufferHealth >= threshold:
    advance currentState toward next buffered state
    interpolate pos/angle between currentState and nextState
  
  bufferHealth = |serverTick - clientTick|    // measure of jitter
  timespeed = bufferHealth > threshold ? 1.05 : (bufferHealth < 3 ? 0.95 : 1.0)
  // timespeed scales how fast client clock advances to stabilise buffer
```

**ANXRacers equivalent:** `RemotePlayer.cs` — `LiteRingBuffer<PShipUpdate>`, `bufferHealth`, `timespeed`, `bufferHealthThreshold`.

### SignalR Hub Methods

```csharp
// Client → Server
Task SendShipState(ShipUpdatePacket packet);
Task JoinRoom(string roomCode, string userId, ShipStats shipStats);
Task LeaveRoom();
Task SendChatMessage(string message);

// Server → Client
Task ReceivePlayerStates(PlayerStatesPacket packet);
Task PlayerJoined(PlayerJoinedPacket packet);
Task PlayerLeft(uint mpId);
Task RaceCountdown(long startAtUnixMs);    // absolute time, all clients sync to it
Task RaceFinished(RaceResultsPacket packet);
```

---

## ANXRacers Port Map

Quick reference: ANXRacers C# class → DriftsInSpace TypeScript equivalent.

| ANXRacers | DriftsInSpace | Notes |
|---|---|---|
| `PhysicsSimul.cs` | `sim/SimLoop.ts` | Loop structure identical, 50Hz vs 100Hz |
| `Spaceship.FixedUpdate()` | `sim/Ship.ts tick()` | Force formula identical, no Rigidbody2D |
| `Drifter.FixedUpdate()` | `audio/DriftAudio.ts` | Same dot product formula |
| `Boost.cs OnTriggerEnter2D` | `sim/Fields.ts` | Boost vector add/subtract on trigger |
| `Recorder.cs` | `sim/Recorder.ts` | Two streams (state + input) instead of one |
| `GhostReplay.cs Update()` | `sim/Ghost.ts` | Frame interpolation logic identical |
| `Checkpoint.cs OnTriggerEnter2D` | `race/CheckpointTracker.ts` | Circle trigger, ordered validation |
| `CatamaranBrushNeo.cs` | `editor/DualBrush.ts` | Dual-brush wall painting |
| `SpaceshipCollsions.cs` | `audio/CollisionAudio.ts` | Material audio selection |
| `Client.cs` | `net/MultiplayerClient.ts` | LiteNetLib → SignalR WebSocket |
| `RemotePlayer.cs` | `net/RemoteShip.ts` | Ring buffer interpolation identical |
| `PShipUpdate.cs` | `net/Protocol.ts ShipUpdatePacket` | Same fields, MessagePack not LiteNetLib |
| `InputMgr.cs` | `input/InputManager.ts` | Same `{surge, strafe, torque}` interface |
| `CustomizableTouchControlsNeo.cs` | `input/TouchInput.ts` | Moveable virtual joystick |
| `Level.cs` + `Classes.cs` | `TrackData` interface | Field names mirrored |
| `ShipPhysics` (DTO) | `ShipStats` | Identical field names |

---

## Coordinate System

Matches ANXRacers Unity 2D world space:
- X: rightward
- Y: upward
- Angle: radians, 0 = facing right (+X), increases counter-clockwise
- PixiJS default Y is flipped (Y increases downward) — apply `stage.scale.y = -1` at root container to match

---

## Performance Targets

| Metric | Target |
|---|---|
| Sim tick budget (50Hz = 20ms) | < 2ms for 8 ships + full collision |
| Render frame (60fps = 16.6ms) | < 8ms (leave headroom for browser) |
| Initial bundle (gzipped) | < 350 KB |
| Time to first render | < 1 second |
| Ghost download (60s race) | < 50 KB (zlib state stream) |
| Multiplayer packet size | < 20 bytes per ship per 50ms update |
