import { loadAllShips, SHIP_SKINS } from '../data/ships'
import type { ShipData } from '../data/ships'

export async function showShipPicker(onSelect: (shipId: string, skinId: string, name: string) => void): Promise<void> {
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
      <div class="skin-row" id="skin-row" style="display:none">
        <div class="skin-label">Skin:</div>
        <div class="skin-grid" id="skin-grid"></div>
      </div>
      <button id="launch-btn" disabled>Launch</button>
    </div>
  `
  document.body.appendChild(overlay)

  const grid = overlay.querySelector('#ship-grid')!
  const skinRow = overlay.querySelector('#skin-row') as HTMLElement
  const skinGrid = overlay.querySelector('#skin-grid')!
  const nameInput = overlay.querySelector('#player-name') as HTMLInputElement
  const launchBtn = overlay.querySelector('#launch-btn') as HTMLButtonElement

  let selectedShipId: string | null = null
  let selectedSkinId: string | null = null

  function updateLaunchState(): void {
    launchBtn.disabled = !selectedShipId || !selectedSkinId || nameInput.value.trim().length === 0
  }

  function showSkinsForShip(shipId: string): void {
    const skins = SHIP_SKINS[shipId] ?? [{ skinId: shipId, skinName: shipId }]
    skinGrid.innerHTML = ''
    skins.forEach(skin => {
      const tile = document.createElement('div')
      tile.className = 'skin-tile'
      tile.dataset.skinId = skin.skinId
      tile.innerHTML = `
        <img src="/assets/ships/${skin.skinId}.thumb.png" alt="${skin.skinName}" title="${skin.skinName}" />
        <div class="skin-name">${skin.skinName}</div>
      `
      tile.addEventListener('click', () => {
        skinGrid.querySelectorAll('.skin-tile').forEach(t => t.classList.remove('selected'))
        tile.classList.add('selected')
        selectedSkinId = skin.skinId
        updateLaunchState()
      })
      skinGrid.appendChild(tile)
    })
    // Auto-select the default (first) skin
    const first = skinGrid.querySelector('.skin-tile') as HTMLElement | null
    if (first) first.click()
    skinRow.style.display = skins.length > 1 ? '' : 'none'
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
      selectedShipId = ship.ShipId
      showSkinsForShip(ship.ShipId)
      updateLaunchState()
    })
    grid.appendChild(card)
  })

  launchBtn.addEventListener('click', () => {
    const name = nameInput.value.trim()
    if (!selectedShipId || !selectedSkinId || !name) return
    localStorage.setItem('drifts_name', name)
    overlay.remove()
    onSelect(selectedShipId, selectedSkinId, name)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
