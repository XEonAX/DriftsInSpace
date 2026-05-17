import { Application, Sprite, Assets } from 'pixi.js'
import { loadAllShips, SHIP_SKINS } from '../data/ships'
import type { ShipData, ShipDetails } from '../data/ships'
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
    // Canvas is 150% of orb diameter (CSS), so size the PixiJS app to match
    const orbSize = canvas.parentElement!.clientWidth || 200
    const size = Math.round(orbSize * 1.5)
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
    // Ship fills ~52% of the orb (inner 2/3 of canvas), not the full canvas
    s.width = s.height = (size / 1.5) * 0.52
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

  const STAT_DEFS: Array<{ key: keyof ShipDetails; label: string }> = [
    { key: 'Mass',          label: 'Mass'               },
    { key: 'SurgeForward',  label: 'Forward Thrusters'  },
    { key: 'LDrag',         label: 'Vel. Stabilization' },
    { key: 'Bounce',        label: 'Shield Repulsion'   },
    { key: 'Torque',        label: 'Turn Thrusters'     },
    { key: 'SurgeBackward', label: 'Reverse Thrusters'  },
    { key: 'ADrag',         label: 'Spin Stabilization' },
    { key: 'Friction',      label: 'Shield Resistance'  },
  ]
  const statMax = {} as Record<keyof ShipDetails, number>
  for (const { key } of STAT_DEFS) {
    statMax[key] = Math.max(...ships.map(s => s.ShipDetails[key]))
  }

  let playerName = localStorage.getItem('drifts_name') ?? ''
  const savedShipId = localStorage.getItem('drifts_ship')
  const savedSkinId = localStorage.getItem('drifts_skin')

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
            <svg class="sp-title-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.89,15.5L18.31,16.89C19.21,15.73 19.76,14.39 19.93,13H17.91C17.77,13.87 17.43,14.72 16.89,15.5M13,17.9V19.92C14.39,19.75 15.74,19.21 16.9,18.31L15.46,16.87C14.71,17.41 13.87,17.76 13,17.9M19.93,11C19.76,9.61 19.21,8.27 18.31,7.11L16.89,8.53C17.43,9.28 17.77,10.13 17.91,11M15.55,5.55L11,1V4.07C7.06,4.56 4,7.92 4,12C4,16.08 7.05,19.44 11,19.93V17.91C8.16,17.43 6,14.97 6,12C6,9.03 8.16,6.57 11,6.09V10L15.55,5.55Z"/>
            </svg>
            DRIFTS IN SPACE
            <svg class="sp-title-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19,1L17.74,3.75L15,5L17.74,6.26L19,9L20.25,6.26L23,5L20.25,3.75M9,4L6.5,9.5L1,12L6.5,14.5L9,20L11.5,14.5L17,12L11.5,9.5M19,15L17.74,17.74L15,19L17.74,20.25L19,23L20.25,20.25L23,19L20.25,17.74"/>
            </svg>
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
                <path d="M12 2C12 2 7 4 7 12C7 15.1 7.76 17.75 8.67 19.83C9 20.55 9.71 21 10.5 21H13.5C14.29 21 15 20.55 15.33 19.83C16.25 17.75 17 15.1 17 12C17 4 12 2 12 2M13.5 19H10.5C9.5 16.76 9 14.41 9 12C9 7.36 10.9 5.2 12 4.33C13.1 5.2 15 7.36 15 12C15 14.41 14.5 16.76 13.5 19M20 22L16.14 20.45C16.84 18.92 17.34 17.34 17.65 15.73M7.86 20.45L4 22L6.35 15.73C6.66 17.34 7.16 18.92 7.86 20.45M12 12C10.9 12 10 11.1 10 10C10 8.9 10.9 8 12 8C13.1 8 14 8.9 14 10C14 11.1 13.1 12 12 12Z"/>
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
    launchBtn.disabled = !selectedShipId || !selectedSkinId
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
        localStorage.setItem('drifts_skin', skin.skinId)
        preview.load(
          `/assets/ships/${skin.skinId}.png`,
          `/assets/ships/${skin.skinId}.skin.json`,
        ).catch(console.error)
        updateLaunchState()
      })
      skinList.appendChild(row)
    })
    const prefSkin = (savedSkinId ? skinList.querySelector(`[data-id="${savedSkinId}"]`) : null) as HTMLElement | null
    const first = (prefSkin ?? skinList.querySelector('.sp-row')) as HTMLElement | null
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

      </div>
      <span class="sp-row-chevron">\u203a</span>
    `
    row.addEventListener('click', () => {
      shipList.querySelectorAll('.sp-row').forEach(r => r.classList.remove('selected'))
      row.classList.add('selected')
      selectedShipId = ship.ShipId
      localStorage.setItem('drifts_ship', ship.ShipId)
      previewStats.innerHTML = STAT_DEFS.map(({ key, label }) => {
        const val = d[key]
        const max = statMax[key]
        const pct = max > 0 ? Math.min(100, (val / max) * 100) : 0
        return `<div class="sp-stat">
            <div class="sp-stat-track"><div class="sp-stat-fill" style="width:${pct.toFixed(1)}%"></div></div>
            <div class="sp-stat-meta">
              <span class="sp-stat-name">${label}</span>
              <span class="sp-stat-val">${fmtDings(val)}</span>
            </div>
          </div>`
      }).join('')
      showSkinsForShip(ship)
      updateLaunchState()
    })
    shipList.appendChild(row)
  })

  const falconId = '00000002-f00d-feed-bee5-ba51c5b0d1ce'
  const defaultRow = (shipList.querySelector(`[data-id="${savedShipId ?? falconId}"]`) ??
                     shipList.querySelector('.sp-row')) as HTMLElement | null
  defaultRow?.click()

  launchBtn.addEventListener('click', () => {
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); return }
    if (!selectedShipId || !selectedSkinId) return
    localStorage.setItem('drifts_name', name)
    preview.destroy()
    overlay.remove()
    onSelect(selectedShipId, selectedSkinId, name)
  })
}

function fmtDings(v: number): string {
  return (v % 1 === 0 ? `${v}` : `${v.toFixed(1)}`) + ' Dings'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
