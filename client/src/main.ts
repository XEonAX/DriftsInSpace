import { Game } from './game/Game'
import { showShipPicker } from './game/ShipPicker'

showShipPicker((shipId: string, skinId: string, displayName: string) => {
  const game = new Game(shipId, skinId, displayName)
  game.start().catch(console.error)
})
