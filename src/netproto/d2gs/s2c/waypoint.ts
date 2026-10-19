/**
 * D2GS S->C Waypoint Menu & Portal Packet Decoders (1.13c).
 * Verified against D2Client.dll:
 * - 0x60 TownPortalState (7B, 0x6fb5d2f0)
 * - 0x63 WaypointMenu (21B, 0x6fb5f8b0)
 * - 0x82 PortalOwnership (29B, 0x6fb5d160)
 */

import { ByteReader } from '../../core/byte-reader.ts'
import type { ServerEvent } from '../../domain/server-event.ts'

/** 0x63 WaypointMenu (21B, D2Client.dll 0x6fb5f8b0) */
export function decode0x63WaypointMenu(pkt: Uint8Array): ServerEvent {
  const r = new ByteReader(pkt)
  r.u8() // 0x63
  const unitId = r.u32LE()
  r.u16LE() // unk
  // 14 bytes of waypoint bitmask (bits 0..38 correspond to the 39 waypoints across Acts 1..5)
  const maskBytes = r.bytes(14)
  const open: number[] = []
  for (let i = 0; i < 39; i++) {
    const byteIdx = i >>> 3
    const bitIdx = i & 7
    if (((maskBytes[byteIdx] ?? 0) & (1 << bitIdx)) !== 0) {
      open.push(i)
    }
  }
  return {
    type: 'WaypointMenu',
    unitId,
    open,
  }
}

/** 0x60 TownPortalState (7B, D2Client.dll 0x6fb5d2f0) */
export function decode0x60TownPortalState(pkt: Uint8Array): ServerEvent {
  const r = new ByteReader(pkt)
  r.u8() // 0x60
  const flags = r.u8()
  const areaId = r.u8()
  const localId = r.u32LE()
  return {
    type: 'Portal',
    portalId: localId,
    areaId,
    localId,
    flags,
  }
}

/** 0x82 PortalOwnership (29B, D2Client.dll 0x6fb5d160) */
export function decode0x82PortalOwnership(pkt: Uint8Array): ServerEvent {
  const r = new ByteReader(pkt)
  r.u8() // 0x82
  const ownerId = r.u32LE()
  const ownerName = r.fixedCString(16)
  const localId = r.u32LE()
  const remoteId = r.u32LE()
  return {
    type: 'Portal',
    portalId: localId,
    ownerId,
    ownerName,
    areaId: 0,
    localId,
    remoteId,
  }
}

