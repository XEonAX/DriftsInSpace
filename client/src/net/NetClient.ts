import {
  buildPlayerJoin,
  buildShipUpdate,
  parsePacket,
} from './Packets'
import type { GalaxyPacket, PlayerInitialState, PlayerStatesPacket } from './Packets'

export const WS_URL = import.meta.env.PROD
  ? 'wss://galacticdrifters.aeonax.com/ws'
  : 'ws://localhost:5839/ws'

export type { GalaxyPacket, PlayerInitialState, PlayerStatesPacket }

export interface NetClientCallbacks {
  /** Server confirmed our join and sent the full world state. */
  onGalaxy(data: GalaxyPacket): void
  /** ~22 Hz broadcast of all players' physics states. */
  onPlayerStates(data: PlayerStatesPacket): void
  /** A new player connected while we were in-game. */
  onPlayerJoin(player: PlayerInitialState): void
  /** A player disconnected. */
  onPlayerLeft(mpId: number): void
  /** WebSocket closed (intentional or network error). */
  onDisconnected(): void
}

export class NetClient {
  private ws: WebSocket | null = null
  private _myMPId = 0
  private _connected = false

  /** Our server-assigned MPId. Available after onGalaxy fires. */
  get myMPId() { return this._myMPId }
  get connected() { return this._connected }

  /**
   * Connect to the server and send PPlayerJoin.
   * @param url        WebSocket URL, e.g. "ws://localhost:5000/ws"
   * @param userId     Client-generated UUID (stable per browser)
   * @param displayName Player's chosen name
   * @param skinId     Selected ship ID
   * @param callbacks  Event handlers
   */
  connect(
    url: string,
    userId: string,
    displayName: string,
    skinId: string,
    callbacks: NetClientCallbacks,
  ): void {
    if (this.ws) this.disconnect()

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this._connected = true
      ws.send(buildPlayerJoin(userId, displayName, skinId))
    }

    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const packet = parsePacket(ev.data)
      if (!packet) return

      switch (packet.type) {
        case 'Galaxy':
          this._myMPId = packet.data.myMPId
          callbacks.onGalaxy(packet.data)
          break
        case 'PlayerStates':
          callbacks.onPlayerStates(packet.data)
          break
        case 'PlayerJoinBroadcast':
          callbacks.onPlayerJoin(packet.data)
          break
        case 'PlayerLeft':
          callbacks.onPlayerLeft(packet.data.mpId)
          break
      }
    }

    ws.onclose = () => {
      this._connected = false
      callbacks.onDisconnected()
    }

    ws.onerror = () => {
      // onerror is always followed by onclose — no need to handle separately
    }
  }

  /**
   * Send the local ship's physics state to the server (call every physics tick).
   */
  sendShipUpdate(
    tick:   number,
    posX:   number, posY: number,
    angle:  number,
    velX:   number, velY: number,
    angVel: number,
    surge:  number, strafe: number, turn: number,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._myMPId) return
    this.ws.send(buildShipUpdate(
      this._myMPId, tick, posX, posY, angle, velX, velY, angVel, surge, strafe, turn,
    ))
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
    this._connected = false
    this._myMPId = 0
  }
}
