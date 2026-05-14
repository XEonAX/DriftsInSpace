import { Application, Sprite, Assets } from 'pixi.js'
import { loadAllShips, SHIP_SKINS } from '../data/ships'
import type { ShipData } from '../data/ships'
import { ThrusterFX } from '../renderer/ThrusterFX'
import type { ShipSkinData } from '../renderer/ThrusterFX'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'

// ── PreviewPlayer — one persistent PixiJS app, swap assets on demand ──────

class PreviewPlayer {
  private app!: Application
  private ship:  Sprite | null = null
  private fx:    ThrusterFX | null = null
  private seq = 0
  private phase = 0

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const size = canvas.parentElement!.clientWidth || 200
    this.app = new Application()
    await this.app.init({
      canvas,
      width: size, height: size,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    this.app.ticker.add((t) => this._tick(t.deltaMS / 1000))
  }

  async load(shipUrl: string, skinUrl: string): Promise<void> {
    const mySeq = ++this.seq
    this.fx?.destroy(); this.fx = null
    this.ship?.destroy(); this.ship = null
    this.app.stage.removeChildren()

    const [tex, skin] = await Promise.all([
      Assets.load(shipUrl),
      Assets.load<ShipSkinData>(skinUrl).catch(() => null),
    ])
    if (mySeq !== this.seq) return

    const size = this.app.screen.width
    const s = new Sprite(tex)
    s.anchor.set(0.5, 0.5)
    s.position.set(size / 2, size / 2)
    s.width = s.height = size * 0.52
    this.app.stage.addChild(s)
    this.ship = s

    if (skin) {
      const fx = new ThrusterFX(s)
      await fx.init()
      if (mySeq !== this.seq) { fx.destroy(); return }
      // Use the same scale as in-game (PPU / texWidth) so Unity-unit positions
      // land at the correct fraction of the ship sprite regardless of preview size.
      fx.setParentScale(PIXELS_PER_UNIT / tex.width, PIXELS_PER_UNIT / tex.height)
      fx.loadSkin(skin)
      this.fx = fx
    }
  }

  private _tick(dt: number): void {
    if (!this.ship) return
    this.phase += (2 * Math.PI / 3.6) * dt
    const sinP = Math.sin(this.phase)
    const cosP = Math.cos(this.phase)
    this.ship.rotation = sinP * (Math.PI / 6)
    this.fx?.update({ surge: 1, strafe: 0, torque: cosP }, dt)
  }

  destroy(): void {
    this.seq = Number.MAX_SAFE_INTEGER
    this.fx?.destroy()
    this.app?.destroy(false)
  }
}

// ── Picker ─────────────────────────────────────────────────────────────────

export async function showShipPicker(
  onSelect: (shipId: string, skinId: string, name: string) => void,
): Promise<void> {
  const ships = await loadAllShips()
  let playerName = localStorage.getItem('drifts_name') ?? ''

  const overlay = document.createElement('div')
  overlay.id = 'ship-picker'

  overlay.innerHTML = `
    <div class="sp-corners" aria-hidden="true">
      <span class="sp-c tl"></span><span class="sp-c tr"></span>
      <span class="sp-c bl"></span><span class="sp-c br"></span>
    </div>
    <div class="sp-glow">
      <div class="sp-panel">
        <div class="sp-scanlines" aria-hidden="true"></div>
        <div class="sp-header">
          <div class="sp-title">
            <svg class="sp-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <path d="M12 2C12 2 5 8 5 14v3l7-2 7 2v-3C19 8 12 2 12 2Z"/>
              <path d="M5 17L2 22M19 17L22 22" stroke-linecap="round"/>
              <circle cx="12" cy="10" r="2.2" fill="currentColor" stroke="none"/>
            </svg>
            SHIPYARD
          </div>
          <div class="sp-pilot">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" style="opacity:.7;flex-shrink:0">
              <circle cx="12" cy="7" r="4"/>
              <path d="M4 21c0-4.42 3.58-8 8-8s8 3.58 8 8"/>
            </svg>
            <input id="player-name" type="text" placeholder="Enter callsign" maxlength="24"
                   value="${escapeHtml(playerName)}" autocomplete="off" spellcheck="false"/>
          </div>
        </div>
        <div class="sp-body">
          <div class="sp-side-col">
            <div class="sp-col-hdr">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="opacity:.75;flex-shrink:0">
                <path d="M12 2C12 2 5 8 5 14v3l7-2 7 2v-3C19 8 12 2 12 2Z"/>
              </svg>
              SELECT SHIP
            </div>
            <div id="ship-list" class="sp-list"></div>
          </div>
          <div class="sp-center-col">
            <div class="sp-orb">
              <canvas id="ship-preview-canvas"></canvas>
            </div>
            <div id="preview-stats" class="sp-stats"></div>
          </div>
          <div class="sp-side-col">
            <div class="sp-col-hdr">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14" style="opacity:.75;flex-shrink:0">
                <rect x="2" y="2" width="8" height="8" rx="1.5"/>
                <rect x="14" y="2" width="8" height="8" rx="1.5"/>
                <rect x="2" y="14" width="8" height="8" rx="1.5"/>
                <circle cx="18" cy="18" r="4"/>
                <path d="M18 14v8M14 18h8" stroke-linecap="round"/>
              </svg>
              SELECT LIVERY
            </div>
            <div id="skin-list" class="sp-list">
              <div class="sp-hint">\u2190 Select a ship first</div>
            </div>
          </div>
        </div>
        <div class="sp-footer">
          <button id="launch-btn" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" width="16" height="16">
              <path d="M5 12h14M13 6l6 6-6 6"/>
            </svg>
            LAUNCH
          </button>
        </div>
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  const shipList      = overlay.querySelector('#ship-list')!
  const skinList      = overlay.querySelector('#skin-list')!
  const previewCanvas = overlay.querySelector('#ship-preview-canvas') as HTMLCanvasElement
  const previewStats  = overlay.querySelector('#preview-stats')!
  const nameInput     = overlay.querySelector('#player-name') as HTMLInputElement
  const launchBtn     = overlay.querySelector('#launch-btn') as HTMLButtonElement

  let selectedShipId: string | null = null
  let selectedSkinId: string | null = null

  const preview = new PreviewPlayer()
  await preview.init(previewCanvas)

  function updateLaunchState(): void {
    launchBtn.disabled = !selectedShipId || !selectedSkinId || nameInput.value.trim().length === 0
  }

  function showSkinsForShip(ship: ShipData): void {
    const skins = SHIP_SKINS[ship.ShipId] ?? [{ skinId: ship.ShipId, skinName: ship.ShipName }]
    skinList.innerHTML = ''
    skins.forEach(skin => {
      const row = document.createElement('div')
      row.className = 'sp-row'
      row.dataset.id = skin.skinId
      row.innerHTML = `
        <img class="sp-row-thumb" src="/assets/ships/${skin.skinId}.thumb.png" alt="${skin.skinName}"/>
        <span class="sp-row-name">${skin.skinName}</span>
        <span class="sp-row-chevron">\u203a</span>
      `
      row.addEventListener('click', () => {
        skinList.querySelectorAll('.sp-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        selectedSkinId = skin.skinId
        preview.load(
          `/assets/ships/${skin.skinId}.png`,
          `/assets/ships/${skin.skinId}.skin.json`,
        ).catch(console.error)
        updateLaunchState()
      })
      skinList.appendChild(row)
    })
    const first = skinList.querySelector('.sp-row') as HTMLElement | null
    if (first) first.click()
  }

  nameInput.addEventListener('input', updateLaunchState)

  ships.forEach((ship: ShipData) => {
    const d = ship.ShipDetails
    const row = document.createElement('div')
    row.className = 'sp-row'
    row.dataset.id = ship.ShipId
    row.innerHTML = `
      <img class="sp-row-thumb" src="/assets/ships/${ship.ShipId}.thumb.png" alt="${ship.ShipName}"/>
      <div class="sp-row-info">
        <span class="sp-row-name">${ship.ShipName}</span>
        <span class="sp-row-sub">\u2b06${d.SurgeForward} &nbsp;\u21ba${d.Torque} &nbsp;\u2b1b${d.Mass}</span>
      </div>
      <span class="sp-row-chevron">\u203a</span>
    `
    row.addEventListener('click', () => {
      shipList.querySelectorAll('.sp-row').forEach(r => r.classList.remove('selected'))
      row.classList.add('selected')
      selectedShipId = ship.ShipId
      const thrust = Math.min(100, (d.SurgeForward / 500) * 100)
      const torque = Math.min(100, (d.Torque / 500) * 100)
      const mass   = Math.min(100, (d.Mass / 15) * 100)
      previewStats.innerHTML = `
        <div class="sp-stat-row"><span>THRUST</span>
          <div class="sp-stat-track"><div class="sp-stat-fill" style="width:${thrust}%"></div></div></div>
        <div class="sp-stat-row"><span>TORQUE</span>
          <div class="sp-stat-track"><div class="sp-stat-fill" style="width:${torque}%"></div></div></div>
        <div class="sp-stat-row"><span>MASS</span>
          <div class="sp-stat-track"><div class="sp-stat-fill sp-stat-mass" style="width:${mass}%"></div></div></div>
      `
      showSkinsForShip(ship)
      updateLaunchState()
    })
    shipList.appendChild(row)
  })

  const falconId = '00000002-f00d-feed-bee5-ba51c5b0d1ce'
  const defaultRow = (shipList.querySelector(`[data-id="${falconId}"]`) ??
                     shipList.querySelector('.sp-row')) as HTMLElement | null
  defaultRow?.click()

  launchBtn.addEventListener('click', () => {
    const name = nameInput.value.trim()
    if (!selectedShipId || !selectedSkinId || !name) return
    localStorage.setItem('drifts_name', name)
    preview.destroy()
    overlay.remove()
    onSelect(selectedShipId, selectedSkinId, name)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
