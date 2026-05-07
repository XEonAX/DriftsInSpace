import { Game } from './game/Game'
import { showShipPicker } from './game/ShipPicker'

showShipPicker((shipId: string, displayName: string) => {
  const game = new Game(shipId, displayName)
  game.start().catch(console.error)
})
