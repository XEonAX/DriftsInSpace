import { loadAllShips } from '../data/ships'
import type { ShipData } from '../data/ships'

export async function showShipPicker(onSelect: (shipId: string, name: string) => void): Promise<void> {
  const ships = await loadAllShips()

  let playerName = localStorage.getItem('drifts_name') ?? ''

  const overlay = document.createElement('div')
  overlay.id = 'ship-picker'
  overlay.innerHTML = `
    <div class="picker-inner">
      <h1>Drifts in Space</h1>
      <div class="name-row">
        <input id="player-name" type="text" placeholder="Enter your name" maxlength="24"
               value="${escapeHtml(playerName)}" autocomplete="off" spellcheck="false"/>
      </div>
      <div class="ship-grid" id="ship-grid"></div>
      <button id="launch-btn" disabled>Launch</button>
    </div>
  `
  document.body.appendChild(overlay)

  const grid = overlay.querySelector('#ship-grid')!
  const nameInput = overlay.querySelector('#player-name') as HTMLInputElement
  const launchBtn = overlay.querySelector('#launch-btn') as HTMLButtonElement

  let selectedId: string | null = null

  function updateLaunchState(): void {
    launchBtn.disabled = !selectedId || nameInput.value.trim().length === 0
  }

  nameInput.addEventListener('input', updateLaunchState)

  ships.forEach((ship: ShipData) => {
    const card = document.createElement('div')
    card.className = 'ship-card'
    card.dataset.id = ship.ShipId

    const d = ship.ShipDetails
    card.innerHTML = `
      <img src="/assets/ships/${ship.ShipId}.thumb.png" alt="${ship.ShipName}" />
      <div class="ship-name">${ship.ShipName}</div>
      <div class="ship-stats">
        <span title="Surge Forward">⬆ ${d.SurgeForward}</span>
        <span title="Torque">↺ ${d.Torque}</span>
        <span title="Mass">⬛ ${d.Mass}</span>
      </div>
    `
    card.addEventListener('click', () => {
      grid.querySelectorAll('.ship-card').forEach(c => c.classList.remove('selected'))
      card.classList.add('selected')
      selectedId = ship.ShipId
      updateLaunchState()
    })
    grid.appendChild(card)
  })

  launchBtn.addEventListener('click', () => {
    const name = nameInput.value.trim()
    if (!selectedId || !name) return
    localStorage.setItem('drifts_name', name)
    overlay.remove()
    onSelect(selectedId, name)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
