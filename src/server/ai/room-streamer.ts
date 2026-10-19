/**
 * Server Room Streamer & Room-Local Monster Pack Spawner (Diablo II v1.13c).
 *
 * Wraps and re-exports `MonsterStreamingManager` (`src/common/units/monster-streaming.ts`)
 * and room-partition/pack-allocation algorithms (`src/common/units/monster-rooms.ts`),
 * adding multi-player (`1..8` players) active room streaming support (`RoomStreamer`)
 * for `GameInstance`.
 */

import {
  PACK_RADIUS_PX,
  allocatePacksToRooms,
  partitionMapIntoRooms,
  spawnMonsterPacksByRooms,
  spawnPacksInRoom,
  type MapRoom,
  type PartitionOptions,
} from '../../common/units/monster-rooms.ts'
import {
  MonsterStreamingManager,
  distanceToRoom,
  type MonsterStreamingOptions,
  type StreamingRoomDef,
  type StreamingRoomState,
} from '../../common/units/monster-streaming.ts'
import type { CombatTerrain, CombatWorld, MonsterPack } from '../../common/units/unit-types.ts'

export const DEFAULT_ACTIVATION_RADIUS = 1600
export const DEFAULT_DEACTIVATION_RADIUS = 2400

export {
  MonsterStreamingManager,
  distanceToRoom,
  PACK_RADIUS_PX,
  allocatePacksToRooms,
  partitionMapIntoRooms,
  spawnMonsterPacksByRooms,
  spawnPacksInRoom,
  type MonsterStreamingOptions,
  type MonsterStreamingOptions as RoomStreamerOptions,
  type StreamingRoomDef,
  type StreamingRoomState,
  type MapRoom,
  type PartitionOptions,
  type PartitionOptions as RoomPartitionOptions,
}

export interface FlexibleStreamingRoomDef {
  readonly id: string | number
  readonly bounds?: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | undefined
  readonly minX?: number | undefined
  readonly minY?: number | undefined
  readonly maxX?: number | undefined
  readonly maxY?: number | undefined
  readonly packs: readonly MonsterPack[]
  readonly room?: MapRoom | undefined
}

export interface RoomStreamTickResult {
  readonly activeRooms: readonly StreamingRoomState[]
  readonly activeRoomIds: readonly (string | number)[]
  readonly populatedRooms: readonly StreamingRoomState[]
}

function normalizeRoomDefs(roomDefs: readonly (StreamingRoomDef | FlexibleStreamingRoomDef)[]): StreamingRoomDef[] {
  return roomDefs.map((r) => {
    const bounds = r.bounds ?? {
      minX: (r as FlexibleStreamingRoomDef).minX ?? 0,
      minY: (r as FlexibleStreamingRoomDef).minY ?? 0,
      maxX: (r as FlexibleStreamingRoomDef).maxX ?? 0,
      maxY: (r as FlexibleStreamingRoomDef).maxY ?? 0,
    }
    return {
      id: r.id,
      bounds,
      packs: r.packs,
      ...(r.room !== undefined ? { room: r.room } : {}),
    }
  })
}

export type PlayerCoordInput =
  | { readonly x: number; readonly y: number }
  | readonly [number, number]

function normalizePlayerCoords(
  players: readonly PlayerCoordInput[],
): { readonly x: number; readonly y: number }[] {
  return players.map((p) =>
    Array.isArray(p)
      ? { x: p[0], y: p[1] }
      : { x: (p as { readonly x: number; readonly y: number }).x, y: (p as { readonly x: number; readonly y: number }).y },
  )
}

/**
 * Multi-player (`1..8` players) room streamer extending `MonsterStreamingManager`.
 * Activates and populates any room within `activationRadius` of ANY living/connected player,
 * and hibernates rooms only when ALL players are beyond `deactivationRadius`.
 */
export class RoomStreamer extends MonsterStreamingManager {
  constructor(
    world: CombatWorld,
    terrain: CombatTerrain,
    roomDefs: readonly (StreamingRoomDef | FlexibleStreamingRoomDef)[],
    options: MonsterStreamingOptions = {},
  ) {
    super(world, terrain, normalizeRoomDefs(roomDefs), options)
  }

  /**
   * Update room population and active/hibernated states across 1..8 player positions.
   */
  updateForPlayers(players: readonly PlayerCoordInput[]): RoomStreamTickResult {
    const normPlayers = normalizePlayerCoords(players)
    if (normPlayers.length === 1) {
      this.update(normPlayers[0]!.x, normPlayers[0]!.y)
    } else if (normPlayers.length > 1) {
      for (const room of this.rooms) {
        let minDist = Number.POSITIVE_INFINITY
        for (const p of normPlayers) {
          const d = distanceToRoom(p.x, p.y, room.bounds)
          if (d < minDist) minDist = d
        }
        if (minDist <= this.activationRadius) {
          if (!room.bPopulated) {
            this.populateRoom(room)
          }
          if (!room.active) {
            room.active = true
            for (const idx of room.monsterIndices) {
              const monster = this.world.monsters[idx]
              if (monster && monster.state !== 'dead') {
                monster.sleeping = false
              }
            }
          }
        } else if (minDist > this.deactivationRadius && room.active) {
          room.active = false
          for (const idx of room.monsterIndices) {
            const monster = this.world.monsters[idx]
            if (monster && monster.state !== 'dead') {
              monster.sleeping = true
            }
          }
        }
      }
    }
    const activeRooms = this.rooms.filter((r) => r.active)
    const populatedRooms = this.rooms.filter((r) => r.bPopulated)
    return {
      activeRooms,
      activeRoomIds: activeRooms.map((r) => r.id),
      populatedRooms,
    }
  }
}

/**
 * Standalone helper to advance a `RoomStreamer` across 1..8 player positions.
 */
export function streamActiveRooms113c(
  streamer: RoomStreamer,
  players: readonly PlayerCoordInput[],
): RoomStreamTickResult {
  return streamer.updateForPlayers(players)
}
