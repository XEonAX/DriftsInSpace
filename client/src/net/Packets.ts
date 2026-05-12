// ─── Packet type IDs (must match server Packets.cs) ──────────────────────────
export const PacketType = {
  PlayerJoin:          0x01,
  Galaxy:              0x02,
  ShipUpdate:          0x03,
  PlayerStates:        0x04,
  PlayerJoinBroadcast: 0x05,
  PlayerLeft:          0x06,
} as const

// ─── Low-level read/write helpers ─────────────────────────────────────────────
// All values little-endian. Strings: uint16 length prefix + UTF-8 bytes.

export class BufWriter {
  private buf: Uint8Array
  private view: DataView
  private off = 0

  constructor(size: number) {
    this.buf  = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }

  u8(v: number)  { this.view.setUint8(this.off++, v) }
  u16(v: number) { this.view.setUint16(this.off, v, true); this.off += 2 }
  u32(v: number) { this.view.setUint32(this.off, v, true); this.off += 4 }
  i32(v: number) { this.view.setInt32(this.off, v, true); this.off += 4 }
  i8(v: number)  { this.view.setInt8(this.off++, v) }

  str(s: string) {
    const encoded = new TextEncoder().encode(s)
    this.u16(encoded.byteLength)
    this.buf.set(encoded, this.off)
    this.off += encoded.byteLength
  }

  bytes(): ArrayBuffer { return this.buf.buffer.slice(0, this.off) as ArrayBuffer }
}

export class BufReader {
  private view: DataView
  private off: number

  constructor(buf: ArrayBuffer, startOffset = 0) {
    this.view = new DataView(buf)
    this.off  = startOffset
  }

  u8()  { return this.view.getUint8(this.off++) }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v }
  i32() { const v = this.view.getInt32(this.off,  true); this.off += 4; return v }
  i8()  { return this.view.getInt8(this.off++) }

  str() {
    const len  = this.u16()
    const bytes = new Uint8Array(this.view.buffer, this.off, len)
    this.off += len
    return new TextDecoder().decode(bytes)
  }

  get offset() { return this.off }
  get remaining() { return this.view.byteLength - this.off }
}

// ─── Domain structs ───────────────────────────────────────────────────────────

/** Physics snapshot — all floats × 1000 → int32 for compact transport. */
export interface ShipUpdatePacket {
  mpId:   number
  tick:   number
  posX:   number   // raw int (pos.x * 1000)
  posY:   number
  angle:  number   // radians * 1000
  velX:   number
  velY:   number
  angVel: number
  surge:  number   // input.surge  * 100, int8
  strafe: number   // input.strafe * 100, int8
  turn:   number   // input.torque * 100, int8
}

/** Player identity + initial physics state — used in PGalaxy and PPlayerJoinBroadcast. */
export interface PlayerInitialState {
  mpId:        number
  userId:      string
  displayName: string
  skinId:      string
  state:       ShipUpdatePacket
}

export interface GalaxyPacket {
  myMPId:  number
  players: PlayerInitialState[]
}

export interface PlayerStatesPacket {
  serverTimeMs: number
  states:       ShipUpdatePacket[]
}

// ─── Serialize / deserialize ──────────────────────────────────────────────────

/** Decode raw float values from a ShipUpdatePacket (divide by 1000). */
export function decodeShipUpdate(p: ShipUpdatePacket) {
  return {
    mpId:   p.mpId,
    tick:   p.tick,
    pos:    { x: p.posX / 1000, y: p.posY / 1000 },
    angle:  p.angle  / 1000,
    vel:    { x: p.velX / 1000, y: p.velY / 1000 },
    angVel: p.angVel / 1000,
    input: {
      surge:  p.surge  / 100,
      strafe: p.strafe / 100,
      torque: p.turn   / 100,
    },
  }
}

function readShipUpdate(r: BufReader): ShipUpdatePacket {
  return {
    mpId:   r.u32(),
    tick:   r.u32(),
    posX:   r.i32(),
    posY:   r.i32(),
    angle:  r.i32(),
    velX:   r.i32(),
    velY:   r.i32(),
    angVel: r.i32(),
    surge:  r.i8(),
    strafe: r.i8(),
    turn:   r.i8(),
  }
}

function writeShipUpdate(w: BufWriter, p: ShipUpdatePacket) {
  w.u32(p.mpId)
  w.u32(p.tick)
  w.i32(p.posX)
  w.i32(p.posY)
  w.i32(p.angle)
  w.i32(p.velX)
  w.i32(p.velY)
  w.i32(p.angVel)
  w.i8(p.surge)
  w.i8(p.strafe)
  w.i8(p.turn)
}

function readPlayerInitialState(r: BufReader): PlayerInitialState {
  const mpId        = r.u32()
  const userId      = r.str()
  const displayName = r.str()
  const skinId      = r.str()
  const state       = readShipUpdate(r)
  return { mpId, userId, displayName, skinId, state }
}

// ─── Public packet builders ───────────────────────────────────────────────────

/**
 * Build the PPlayerJoin packet (client → server on connect).
 * Estimated size: 1 + (2 + userId.len) + (2 + name.len) + (2 + skinId.len)
 */
export function buildPlayerJoin(userId: string, displayName: string, skinId: string): ArrayBuffer {
  const te = new TextEncoder()
  const size = 1 + 2 + te.encode(userId).byteLength
                 + 2 + te.encode(displayName).byteLength
                 + 2 + te.encode(skinId).byteLength
  const w = new BufWriter(size)
  w.u8(PacketType.PlayerJoin)
  w.str(userId)
  w.str(displayName)
  w.str(skinId)
  return w.bytes()
}

/**
 * Build a PShipUpdate packet (client → server, 50 Hz).
 * Floats are passed in world-space; multiplied × 1000 here.
 * surge/strafe/turn are [-1..1] inputs, encoded as int8 × 100.
 */
export function buildShipUpdate(
  mpId: number, tick: number,
  posX: number, posY: number,
  angle: number,
  velX: number, velY: number,
  angVel: number,
  surge: number, strafe: number, turn: number,
): ArrayBuffer {
  const w = new BufWriter(1 + 8 * 4 + 3)
  w.u8(PacketType.ShipUpdate)
  const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v * 100)))
  writeShipUpdate(w, {
    mpId, tick,
    posX:   Math.round(posX   * 1000),
    posY:   Math.round(posY   * 1000),
    angle:  Math.round(angle  * 1000),
    velX:   Math.round(velX   * 1000),
    velY:   Math.round(velY   * 1000),
    angVel: Math.round(angVel * 1000),
    surge:  clamp(surge),
    strafe: clamp(strafe),
    turn:   clamp(turn),
  })
  return w.bytes()
}

// ─── Incoming packet parser ───────────────────────────────────────────────────

export type IncomingPacket =
  | { type: 'Galaxy';              data: GalaxyPacket          }
  | { type: 'PlayerStates';        data: PlayerStatesPacket    }
  | { type: 'PlayerJoinBroadcast'; data: PlayerInitialState    }
  | { type: 'PlayerLeft';          data: { mpId: number }      }

export function parsePacket(buf: ArrayBuffer): IncomingPacket | null {
  const r = new BufReader(buf)
  const type = r.u8()

  switch (type) {
    case PacketType.Galaxy: {
      const myMPId   = r.u32()
      const count    = r.u32()
      const players  = Array.from({ length: count }, () => readPlayerInitialState(r))
      return { type: 'Galaxy', data: { myMPId, players } }
    }

    case PacketType.PlayerStates: {
      const serverTimeMs = r.u32()
      const count        = r.u32()
      const states       = Array.from({ length: count }, () => readShipUpdate(r))
      return { type: 'PlayerStates', data: { serverTimeMs, states } }
    }

    case PacketType.PlayerJoinBroadcast: {
      return { type: 'PlayerJoinBroadcast', data: readPlayerInitialState(r) }
    }

    case PacketType.PlayerLeft: {
      return { type: 'PlayerLeft', data: { mpId: r.u32() } }
    }

    default:
      return null
  }
}
