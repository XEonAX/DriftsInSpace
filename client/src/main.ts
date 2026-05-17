import { Game } from './game/Game'
import { showShipPicker } from './game/ShipPicker'

showShipPicker((shipId: string, skinId: string, displayName: string) => {
  const game = new Game(shipId, skinId, displayName)
  game.start().catch(console.error)
})

// ping
try {
  fetch("https://ping.aeonax.com/" + window.location, {
    mode: "no-cors",
    referrerPolicy: "unsafe-url"
  }).catch(() => {
    // Silently fail if ping endpoint is unavailable
  });
} catch (e) {
  // Silently fail
}