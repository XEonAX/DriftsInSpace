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

export const SHIP_IDS = [
  '00000000-ace5-00f5-0b01-d1b5ecd00dee', // Sparrow
  '00000001-51de-c0c0-5eed-be51deb0d1e5', // Eagle
  '00000002-f00d-feed-bee5-ba51c5b0d1ce', // Falcon
  '00000003-f0c1-caca-deaf-d1ba51cab0de', // Squid
]

export async function loadShipData(shipId: string): Promise<ShipData> {
  const res = await fetch(`/assets/ships/${shipId}.json`)
  if (!res.ok) throw new Error(`Failed to load ship ${shipId}`)
  return res.json()
}

export async function loadAllShips(): Promise<ShipData[]> {
  return Promise.all(SHIP_IDS.map(loadShipData))
}
