export interface ShipDetails {
  Mass: number
  LDrag: number
  ADrag: number
  SurgeForward: number
  SurgeBackward: number
  Strafe: number
  Torque: number
  Radius: number
  Friction: number
  Bounce: number
}

export interface ShipData {
  ShipId: string
  ShipName: string
  ShipDetails: ShipDetails
}

export interface SkinInfo {
  skinId: string
  skinName: string
}

export const SHIP_IDS = [
  '00000000-ace5-00f5-0b01-d1b5ecd00dee', // Sparrow
  '00000001-51de-c0c0-5eed-be51deb0d1e5', // Eagle
  '00000002-f00d-feed-bee5-ba51c5b0d1ce', // Falcon
  '00000003-f0c1-caca-deaf-d1ba51cab0de', // Squid
  'd09face5-1ced-a9e5-d1e5-b109a5d091e5', // Froggy-2
  'bd0fa326-2590-4ebf-a1a3-5c72c783359c', // HyperBoi
]

/** Maps shipId → ordered list of available skins. First entry is always the default skin. */
export const SHIP_SKINS: Record<string, SkinInfo[]> = {
  '00000000-ace5-00f5-0b01-d1b5ecd00dee': [
    { skinId: '00000000-ace5-00f5-0b01-d1b5ecd00dee', skinName: 'ANX Sparrow' },
    { skinId: '9d6f9e23-0000-0000-0000-000000000001', skinName: 'Neon Purple' },
    { skinId: 'e89e2877-0000-0000-0000-000000000001', skinName: 'Cyberspace' },
    { skinId: 'e89e2877-0000-0000-0000-000000000005', skinName: 'The Shadow' },
  ],
  '00000001-51de-c0c0-5eed-be51deb0d1e5': [
    { skinId: '00000001-51de-c0c0-5eed-be51deb0d1e5', skinName: 'ANX Eagle' },
    { skinId: '9d6f9e23-0000-0000-0000-000000000002', skinName: 'Neon Purple' },
    { skinId: 'a28c7815-0000-0000-0000-000000000001', skinName: 'Midnight Vibe' },
    { skinId: 'e89e2877-0000-0000-0000-000000000003', skinName: 'NeonLights' },
  ],
  '00000002-f00d-feed-bee5-ba51c5b0d1ce': [
    { skinId: '00000002-f00d-feed-bee5-ba51c5b0d1ce', skinName: 'ANX Falcon' },
    { skinId: '1deafade-0000-0000-0000-000000000001', skinName: 'Superluminal' },
    { skinId: '37d2c0ac-0000-0000-0000-000000000001', skinName: 'Abhaile' },
    { skinId: '47aeb9db-0000-0000-0000-000000000001', skinName: 'Dengeki' },
    { skinId: '58fed07a-0000-0000-0000-000000000001', skinName: 'SS Orville' },
    { skinId: '9d6f9e23-0000-0000-0000-000000000003', skinName: 'Neon Purple' },
    { skinId: 'e0dc42cd-0000-0000-0000-000000000001', skinName: "Le6lindre's" },
  ],
  '00000003-f0c1-caca-deaf-d1ba51cab0de': [
    { skinId: '00000003-f0c1-caca-deaf-d1ba51cab0de', skinName: 'ANX Squid' },
    { skinId: '9d6f9e23-0000-0000-0000-000000000004', skinName: 'Neon Purple' },
    { skinId: 'e89e2877-0000-0000-0000-000000000002', skinName: 'NeonLights' },
  ],
  'd09face5-1ced-a9e5-d1e5-b109a5d091e5': [
    { skinId: 'd09face5-1ced-a9e5-d1e5-b109a5d091e5', skinName: 'Froggy-2' },
  ],
  'bd0fa326-2590-4ebf-a1a3-5c72c783359c': [
    { skinId: 'bd0fa326-2590-4ebf-a1a3-5c72c783359c', skinName: 'HyperBoi' },
  ],
}

export async function loadShipData(shipId: string): Promise<ShipData> {
  const res = await fetch(`/assets/ships/${shipId}.json`)
  if (!res.ok) throw new Error(`Failed to load ship ${shipId}`)
  return res.json()
}

export async function loadAllShips(): Promise<ShipData[]> {
  return Promise.all(SHIP_IDS.map(loadShipData))
}
