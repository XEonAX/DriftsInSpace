# DriftsInSpace — Development Plan

## Overview

Browser-based 2D top-down multiplayer spaceship free-roam game.  
Players join instantly (no login), pick a ship, and drift around a shared space map with other players.  
Same spaceship physics feel as ANXRacers. Collisions with map obstacles only — no player-vs-player collision.

---

## Tech Stack

### Client
| Concern | Choice | Notes |
|---|---|---|
| Renderer | PixiJS v8 | WebGL, sprite batching, fast 2D |
| Tooling | Vite + TypeScript | Sub-100ms HMR, ES modules |
| Audio | Howler.js | Engine loop, collision SFX |
| Input | Native Browser APIs | Gamepad API, Pointer Events, KeyboardEvent |
| Networking | WebSocket + ArrayBuffer | Binary frames, matches server packet format |
| Physics | Custom kinematic (TS port of ANXRacers) | No physics engine dependency |

### Server
| Concern | Choice | Notes |
|---|---|---|
| Runtime | ASP.NET Core (.NET 8) | New standalone service: DriftsInSpaceGalaxy |
| Transport | ASP.NET Core WebSocket middleware | Replaces LiteNetLib (UDP not available in browsers) |

| Hosting | Same Ubuntu ARM64 server as ANXRacersGalaxy | Separate systemd service |

---

## Repository Structure

```
DriftsInSpace/
  client/                        ← Vite + TypeScript frontend
    index.html
    src/
      main.ts                    ← entry point
      game/
        sim/
          ShipSim.ts             ← kinematic physics (port of Spaceship.cs FixedUpdate)
          Integrator.ts          ← tick accumulator loop
          CollisionSystem.ts     ← circle vs capsule/polygon
          SpatialHash.ts         ← broadphase
        net/
          Client.ts              ← WebSocket connection, binary packet r/w
          Packets.ts             ← PShipUpdate, PPlayerJoin, PGalaxy, etc.
          Interpolator.ts        ← ring buffer + timespeed rubber-banding
        render/
          Renderer.ts            ← PixiJS scene root
          ShipView.ts            ← ship sprite + thruster particles
          MapView.ts             ← obstacle sprites
          Camera.ts              ← follow camera with velocity lookahead
          HUD.ts                 ← player labels, off-screen indicators
        input/
          InputMgr.ts            ← keyboard / gamepad / touch unified output
          TouchControls.ts       ← virtual joystick for mobile
          GamepadMgr.ts          ← Gamepad API polling
        ui/
          ShipPicker.ts          ← ship selection screen
          NameEntry.ts           ← display name prompt
          LoadingScreen.ts
      assets/
        ships/                   ← bundled ship data + skin JSON + PNGs
        levels/                  ← bundled ANXRacers level JSONs
        audio/
        textures/                ← thruster flame sprite sheet, background
    public/
  server/                        ← ASP.NET Core DriftsInSpaceGalaxy
    DriftsInSpaceGalaxy.csproj
    Program.cs
    GalaxyConfig.cs
    GalaxyService.cs             ← timer loop (port of ANXRacersGalaxy GalaxyService)
    WsServer.cs                  ← WebSocket accept/receive/broadcast
    Packets/
      PShipUpdate.cs
      PPlayerJoin.cs
      PPlayerLeft.cs
      PGalaxy.cs
      PPlayerStates.cs
      PStringMessage.cs
    DriftsInSpaceGalaxy.service  ← systemd unit
  docs/
    plan.md                      ← this file
```

---

## Bundled Assets (from ANXRacers/Assets/Resources)

### Ships (4 default ships — no API call required)

All ship data is copied from `ANXRacers/Assets/Resources/ships/`.

| Ship | ID | Feel |
|---|---|---|
| Sparrow | `00000000-ace5-00f5-0b01-d1b5ecd00dee` | Slow, drifty, beginner |
| Eagle   | `00000001-51de-c0c0-5eed-be51deb0d1e5` | Balanced, medium speed |
| Falcon  | `00000002-f00d-feed-bee5-ba51c5b0d1ce` | Fast, high torque |
| Squid   | `00000003-f0c1-caca-deaf-d1ba51cab0de` | Heavy, rocket thrust |

Each ship folder contains:
- `{id}.json` — `ShipPhysics` (Mass, LDrag, ADrag, SurgeForward, SurgeBackward, Strafe, Torque, Radius)
- `{id}.skin.json` — `ShipSkin` (MainThrusters[], LeftReverseThruster, RightReverseThruster with Position/Scale/Color)
- `{id}.100.png` — thumbnail for ship picker
- `{id}.512.png` — in-game ship texture

The `.bytes` extension used by Unity's TextAsset is dropped — files are plain JSON and PNG.

### Maps

ANXRacers level JSON files are usable directly. Format:
```json
{
  "LevelName": "Alpha-1",
  "Obstacles": [
    { "Type": "capsule100x300Rock", "Transform": { "Position": {"x":0,"y":0,"z":0}, "Rotation": {"x":0,"y":0,"z":0,"w":1} } },
    { "Type": "poly5Vert128ARock",  "Transform": { ... } }
  ]
}
```

Obstacle type string encodes shape + material:
- `capsule{W}x{H}{Material}` → capsule collider, width W units, height H units
- `poly{N}Vert{Size}{Variant}{Material}` → convex polygon, N vertices, size 128 units

For DriftsInSpace Phase 1: use 1-2 existing ANXRacers levels as the free-roam map.  
The `Checkpoints` and `Track` fields are ignored.

---

## Physics Simulation — TS Port of ANXRacers

### Ship State (per-tick)
```typescript
interface ShipState {
  pos: { x: number; y: number };
  angle: number;           // radians, 0 = up
  vel: { x: number; y: number };
  angularVel: number;
}
```

### Tick (50 Hz, dt = 0.02s)
Direct port of `Spaceship.cs FixedUpdate` + `Rigidbody2D` drag model:

```typescript
function tick(state: ShipState, input: ShipInput, physics: ShipPhysics, dt: number) {
  const { torque, strafe, surge } = input;
  const isIdle = torque === 0 && surge === 0;

  if (isIdle) {
    // rb.angularDrag = 0.001; rb.drag = 0
    state.angularVel *= (1 - 0.001 * dt);
    // no linear drag when idle (matches ANXRacers)
  } else {
    // rb.angularDrag = MaxADrag; rb.drag = MaxLDrag
    state.angularVel *= (1 - physics.ADrag * dt);
    state.vel.x      *= (1 - physics.LDrag * dt);
    state.vel.y      *= (1 - physics.LDrag * dt);
  }

  // rb.AddTorque(-Torque * torqueMultiplier)  (torqueMultiplier=1 in sim units)
  state.angularVel -= torque * physics.Torque * dt / physics.Mass;

  // rb.AddRelativeForce({strafe * StrafeMultiplier, surge * SurgeMultiplier})
  const surgeForce = surge > 0
    ? surge * physics.SurgeForward
    : surge * physics.SurgeBackward;
  const strafeForce = strafe * physics.Strafe;

  // Rotate local force to world space
  const cos = Math.cos(state.angle);
  const sin = Math.sin(state.angle);
  state.vel.x += (strafeForce * cos - surgeForce * sin) * dt / physics.Mass;
  state.vel.y += (strafeForce * sin + surgeForce * cos) * dt / physics.Mass;

  state.angle += state.angularVel * dt;
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
}
```

### Tick Loop (time accumulator in rAF)
```typescript
const SIM_DT = 1000 / 50;  // 20ms
let accumulator = 0;
let lastTime = performance.now();

function loop(now: number) {
  accumulator += now - lastTime;
  lastTime = now;
  while (accumulator >= SIM_DT) {
    simTick(SIM_DT / 1000);   // advance physics
    netSendThisTick();          // upload local state at 50 Hz
    accumulator -= SIM_DT;
  }
  const alpha = accumulator / SIM_DT;  // interpolation factor for render
  renderer.render(alpha);
  requestAnimationFrame(loop);
}
```

### Collision — Circle vs Obstacles
- Ship = circle, radius from `ShipPhysics.Radius` (all ships: 0.63 units)
- Capsule = circle-vs-segment test with capsule radius
- Polygon = GJK or SAT against convex hull from obstacle type
- On collision: reflect velocity component along contact normal, apply `Bounce` + `Friction` from `ShipPhysics`
- No ship-vs-ship collision (by design for Phase 1)

Obstacle geometry is derived from the type string. A lookup table maps each type name to its collider shape + dimensions.

---

## Networking

### Protocol: Binary WebSocket

Packets are `ArrayBuffer` / `DataView`, matching the field layout of the C# `INetSerializable` structs.  
All integers are little-endian.

#### PShipUpdate (client → server, 50 Hz)
| Field | Type | Bytes | Notes |
|---|---|---|---|
| MPId | uint32 | 4 | assigned by server on join |
| t | uint32 | 4 | client sim tick counter |
| x | int32 | 4 | pos.x × 1000 |
| y | int32 | 4 | pos.y × 1000 |
| z | int32 | 4 | angle × 1000 (radians) |
| iy | int32 | 4 | vel.y × 1000 |
| iz | int32 | 4 | angularVel × 1000 |
Total: **28 bytes**

#### PPlayerStates (server → all clients, ~22 Hz)
| Field | Type | Notes |
|---|---|---|
| serverTime | uint32 | elapsed ms |
| players[] | PShipUpdate[] | all connected players |

#### PPlayerJoin (client → server, reliable on connect)
| Field | Type | Notes |
|---|---|---|
| UserId | string | anonymous GUID generated client-side |
| UserDisplayName | string | entered by player |
| SkinId | string | selected ship/skin GUID |

#### PGalaxy (server → new client, reliable on join)
| Field | Type | Notes |
|---|---|---|
| MPId | uint32 | this client's assigned MPId |
| Players[] | PPlayerInitialState[] | all current players + their states |

#### PPlayerLeft (server → all, reliable)
| Field | Type | Notes |
|---|---|---|
| MPId | uint32 | who left |

### Server Tick Architecture (DriftsInSpaceGalaxy)

Mirrors `ANXRacersGalaxy` exactly, replacing LiteNetLib with ASP.NET WebSocket:

- `GalaxyService` owns two timers:
  - Receive: 15ms → `WsServer.PollMessages()` (process queued WebSocket frames)
  - Send: 45ms → `WsServer.BroadcastPlayerStates()`
- `WsServer` manages `List<WebSocket>` + `List<DriftsPlayer>`
- Binary serialization: manual `BinaryWriter`/`BinaryReader` matching the JS `DataView` layout
- No rooms in Phase 1 — all players share one world

### Client Interpolation (port of RemotePlayer.cs)

```typescript
class RemotePlayer {
  stateBuffer: RingBuffer<PShipUpdate>;  // capacity 50
  currentState: PShipUpdate;
  tickThisSide: number;
  lastTickFromOtherSide: number;
  timeSpeed: number = 1.0;
  readonly DELAY = 100;  // ms buffer target

  fixedUpdate(dt: number) {
    // rubber-band time speed based on buffer health
    const health = this.stateBuffer.count;
    if (health > 10) this.timeSpeed = 1 + lerp(0, 1, (health - 10) / 10);
    else if (health < 5) this.timeSpeed = Math.max(0.5, 1 - lerp(0, 0.5, (5 - health) / 5));
    else this.timeSpeed = 1.0;

    // advance ghost ship
    this.tickThisSide += dt * 1000 * this.timeSpeed;
    // apply state from buffer when tick matches
    ...
  }
}
```

---

## Input System

### Unified Input Output
```typescript
interface ShipInput {
  torque: number;   // -1 to 1 (left/right rotation)
  surge:  number;   // -1 to 1 (forward/backward thrust)
  strafe: number;   // -1 to 1 (lateral)
}
```

### Keyboard
| Key | Action |
|---|---|
| W / ArrowUp | surge +1 |
| S / ArrowDown | surge -1 |
| A / ArrowLeft | torque -1 |
| D / ArrowRight | torque +1 |
| Q / Z | strafe -1 |
| E / X | strafe +1 |

### Gamepad (Gamepad API)
- Left stick X → torque
- Left stick Y → surge
- Right stick X → strafe
- Polled every frame (Gamepad API is not event-driven)

### Touch (mobile)
- Dual virtual joystick layout:
  - Left joystick → torque + surge
  - Right joystick → strafe (optional)
- Alternatively: single joystick steers, tap-hold for thrust (configurable)
- PixiJS `pointermove` events on joystick zones

---

## PixiJS Rendering

### World Scale
- 1 Unity unit = 64 pixels (configurable constant `PIXELS_PER_UNIT`)
- Ship sprite is 512px texture displayed at ~80px (radius 0.63 × 64 × 2 ≈ 80px)

### Scene Graph
```
app.stage
  mapContainer         ← static, rendered once to RenderTexture (background)
  obstacleContainer    ← obstacle sprites (z-order by type)
  shipContainer        ← all ships (local + remote)
    localShip
      shipSprite       ← 512px texture, rotated
      mainThrusterFX   ← ParticleContainer (flame emitter)
      leftRevFX
      rightRevFX
    remoteShip×N
  hudContainer         ← name labels, off-screen indicators (screen-space)
  uiContainer          ← ship picker, HUD, touch controls
```

### Camera
- Follows local ship position
- Velocity lookahead: camera target = `pos + vel * lookAheadFactor`
- Smooth damp toward target each frame
- `app.stage.pivot` and `app.stage.position` for world-space pan

### Thruster Particles
Driven by `ShipSkin` data:
- `MainThrusters[i].Position` → child sprite local offset (× `PIXELS_PER_UNIT`)
- `MainThrusters[i].Scale.y` → lerped by `inputSurge`, drives particle emission rate + flame length
- `LeftReverseThruster` → active when `inputTorque < 0` or `inputSurge < 0`
- `RightReverseThruster` → active when `inputTorque > 0` or `inputSurge < 0`
- Color tinted per skin `Color` field

### Obstacle Rendering
- Each obstacle type maps to a sprite (sliced from a texture atlas)
- Position from level JSON `Transform.Position.{x,y}`
- Rotation from `Transform.Rotation` quaternion → `2 * Math.atan2(q.z, q.w)` radians
- Background rock/nebula field tiled behind obstacles

---

## Server — DriftsInSpaceGalaxy

### Key Differences from ANXRacersGalaxy
- Transport: ASP.NET WebSocket instead of LiteNetLib
- No connection key validation (anonymous access)
- No race/checkpoint logic
- Spawn positions: fixed list of spawn points in map JSON

### Program.cs
```csharp
builder.Services.AddSingleton<WsServer>();
builder.Services.AddSingleton<DriftsPlayer.Factory>();
builder.Services.AddHostedService<GalaxyService>();


app.UseWebSockets();
app.Map("/ws", async ctx => {
    if (ctx.WebSockets.IsWebSocketRequest)
        await ctx.RequestServices.GetRequiredService<WsServer>().Accept(ctx);
    else ctx.Response.StatusCode = 400;
});
```

### GalaxyService (timer loop)
```csharp
_ReceiveTimer = new Timer(_ => _wsServer.PollMessages(), null,
    TimeSpan.Zero, TimeSpan.FromMilliseconds(15));
_SendTimer = new Timer(_ => _wsServer.BroadcastPlayerStates(elapsedMs), null,
    TimeSpan.Zero, TimeSpan.FromMilliseconds(45));
```

### WsServer packet handling
- On connect: accept WebSocket, wait for `PPlayerJoin`
- On `PPlayerJoin`: assign MPId, send `PGalaxy` to new player, broadcast `PPlayerJoin` to others
- On `PShipUpdate`: update player state
- On disconnect: broadcast `PPlayerLeft`
- `BroadcastPlayerStates`: build `PPlayerStates` binary buffer, send to all WebSockets

---

## Load Sequence & Fast-Load Strategy

```
Browser loads index.html
  └─ Vite bundle: pixi.js (vendor, CDN-cached) + game.js (~50KB)
     └─ Show ship picker UI immediately (no network)
        ├─ Load 4 × ship thumbnails (100px PNGs, ~5KB each) ← fast
        └─ Player enters name, picks ship
           └─ Connect WebSocket to DriftsInSpaceGalaxy
              ├─ Load selected ship 512px texture (~30KB)
              ├─ Load map JSON (~50KB, parse obstacles)
              └─ Receive PGalaxy → spawn + start game loop
```

Target: **page interactive < 1s**, **in-game < 3s** on average connection.

No blocking on ANXStudiosServer. All required assets (ships, one map) are bundled.

---

## Development Phases

### Phase 1 — Playable MVP
- [ ] Vite + TS project scaffold in `client/`
- [ ] Ship picker UI (4 ships, name entry)
- [ ] PixiJS renderer: local ship with thruster FX
- [ ] Kinematic physics sim (50 Hz tick loop)
- [ ] Keyboard input
- [ ] One bundled map (Alpha-1 level JSON → obstacle rendering)
- [ ] Circle vs capsule collision (most common obstacle type)
- [ ] DriftsInSpaceGalaxy C# server (WebSocket, binary packets)
- [ ] Multiplayer: join, broadcast states, remote player interpolation
- [ ] Camera follow with velocity lookahead
- [ ] Player name labels

### Phase 2 — Full Controls + Polish
- [ ] Gamepad support
- [ ] Touch controls (virtual joystick)
- [ ] Polygon obstacle collisions (poly5Vert, poly7Vert types)
- [ ] Off-screen player indicators
- [ ] Thruster audio (Howler.js engine loop, pitch driven by speed)
- [ ] Collision SFX
- [ ] Background (star field, nebula sprites)
- [ ] Smooth disconnect handling (ghost fade-out)

### Phase 3 — Content + Infrastructure
- [ ] Multiple maps (more ANXRacers level JSONs)
- [ ] Map vote / rotation
- [ ] Player count displayed in UI
- [ ] rsync deploy script (matching ANXStudiosServer deploy pattern)
- [ ] systemd service file (`DriftsInSpaceGalaxy.service`)

---

## Obstacle Geometry Lookup Table

Needed for both collision and rendering. Maps `ObstacleType` string to collider shape:

| Type Prefix | Collider | Approx Dimensions (units) |
|---|---|---|
| `capsule100x300Rock` | Capsule | radius=0.5, height=3.0 |
| `capsule100x300Metal` | Capsule | radius=0.5, height=3.0 |
| `poly5Vert128ARock` | ConvexPolygon 5 verts | ~1.28 units bounding |
| `poly5Vert128BRock` | ConvexPolygon 5 verts | ~1.28 units (variant B shape) |
| `poly7Vert128ARock` | ConvexPolygon 7 verts | ~1.28 units bounding |

Exact vertex data must be extracted from Unity's prefabs (or approximated from the sprite bounds).  
For Phase 1: treat all poly obstacles as circles with radius 0.64 (good enough for first pass).  
For Phase 2: extract actual collider vertices from Unity using a one-time editor script.

---

## Files to Copy from ANXRacers

Run once to seed the `client/src/assets/` folder:

```bash
ANXTRACERS=~/Projects/ANXRacers/Assets/Resources
DEST=~/Projects/DriftsInSpace/client/src/assets

# Ship data
cp $ANXTRACERS/ships/data/*.json $DEST/ships/data/

# Ship skins (json + both PNGs) — strip .bytes extension
for f in $ANXTRACERS/ships/skins/**/*.bytes; do
  dest="${f%.bytes}"         # strip .bytes
  dest="${dest##*/}"         # filename only
  cp "$f" "$DEST/ships/skins/$dest"
done

# One starter map
cp $ANXTRACERS/levels/000000a0-0e7e-4003-9913-4aedc38e1ba5.json \
   $DEST/levels/alpha-1.json
```

---

## Open Questions / Decisions Deferred

1. **Max players per room** — not decided yet. Start unbounded, add room splitting if needed.
2. **Poly obstacle vertex data** — needs Unity editor export script for exact shapes.
3. **Spawn points** — hardcode a few positions initially; later embed in map JSON.

