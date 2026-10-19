/**
 * Unified 25Hz Authoritative `GameInstance` & `GameModePolicy` (`src/server/engine/game-instance.ts`).
 *
 * Powers both Single-Player (via `LocalLoopbackAdapter`) and Multiplayer (via `MultiClientRoomHost`).
 * Strictly isomorphic: zero DOM globals, zero Node built-ins, zero `Math.random()` or wall-clock calls.
 */

import { RAW_ARMOR, RAW_MISC, RAW_WEAPONS } from '../../common/data/canonical-drop-data.ts'
import { D2DataRegistry, getSharedDataRegistry } from '../../common/data/data-registry.ts'
import { decodeAnimDataFile } from '../../common/formats/animdata.ts'
import { D2Rng } from '../../common/rng/d2-rng.ts'
import { CANONICAL_CHARSTATS, type CharacterClassCode } from '../../common/units/classes.ts'
import { resolveHirelingStatsAtLevel } from '../../common/units/hireling-table.ts'
import {
  BONE_FETISH_EXPLOSION_RADIUS,
  DURIEL_MAGGOT_HCIDX,
  DURIEL_MAGGOT_OFFSETS,
  FIRE_ENCHANT_EXPLOSION_RADIUS,
  MON_UMOD,
  calcBoneFetishDeathDamage,
  calcColdEnchantedDeathNova,
  calcFireEnchantedDeathDamage,
  computeChargedBolt8WayVectors,
  isBoneFetishMonster,
  isDurielMonster,
  isPoisonDeadMonster,
  isScarabMonster,
  isSuicideMinionMonster,
  resolveMonsterUModIds,
} from '../../common/units/monster-death-fx.ts'
import {
  getCanonicalMonsterKinds,
  getMonsterKindByHcIdx,
  getMonsterModeMissile113c,
  resolveMonsterStats,
  type MonsterKind,
  type MonsterRank,
} from '../../common/units/monsters-data.ts'
import { PET_TYPE_IDX_BY_NAME_113C, PET_TYPE_PORTRAIT_TABLE } from '../../common/units/pet-type-table.ts'
import { parseTable } from '../../common/world/acts.ts'
import type {
  CharClassId,
  ClientCommand,
  ItemContainer,
  ItemData,
  ItemQuality,
  ServerEvent,
  UnitId,
  UnitType,
} from '../../netproto/index.ts'
import { tickMercenaryAi25Hz, type MercenaryUnitState } from '../ai/monster-ai.ts'
import {
  SummonManager,
  type CreatePetOutcome,
  type SummonedPetUnit,
} from '../ai/summon-manager.ts'
import {
  getServerItemDataTables,
  readD2sSave113c,
  type D2sDecodedCharacterSave,
} from '../save/d2s-reader.ts'
import {
  createDefaultNpcIntroData,
  createDefaultQuestData,
  createDefaultWaypointData,
  writeD2sSave113c,
} from '../save/d2s-writer.ts'
import { executeSUnitDmg, type CombatUnitContext } from './combat-pipeline.ts'
import { FIXED_ONE, UnitStatList } from './stat-list.ts'
import { StateBus } from './state-bus.ts'

export type GameMode = 'sp' | 'open' | 'realm' | 'singlePlayer' | 'multiplayer'

export interface GameModePolicy {
  readonly mode: GameMode
  readonly maxPlayers: number
  readonly allowPause: boolean
  readonly allowPlayersXCommand: boolean
  readonly persistMapSeedAndFog: boolean
  readonly allowPvpHostile: boolean
  readonly allowPlayerTrade: boolean
  readonly pauseOnSinglePlayerEscape?: boolean | undefined
  readonly persistMapSeedOnSave?: boolean | undefined
  readonly defaultPlayersX?: number | undefined
}

export const SINGLE_PLAYER_POLICY: GameModePolicy = {
  mode: 'sp',
  maxPlayers: 1,
  allowPause: true,
  allowPlayersXCommand: true,
  persistMapSeedAndFog: true,
  allowPvpHostile: false,
  allowPlayerTrade: false,
}

export const OPEN_BNET_POLICY: GameModePolicy = {
  mode: 'open',
  maxPlayers: 8,
  allowPause: false,
  allowPlayersXCommand: true,
  persistMapSeedAndFog: false,
  allowPvpHostile: true,
  allowPlayerTrade: true,
}

export const CLOSED_REALM_POLICY: GameModePolicy = {
  mode: 'realm',
  maxPlayers: 8,
  allowPause: false,
  allowPlayersXCommand: false,
  persistMapSeedAndFog: false,
  allowPvpHostile: true,
  allowPlayerTrade: true,
}

export function resolveGameModePolicy(
  mode: GameMode = 'sp',
  overrides?: Partial<GameModePolicy>,
): GameModePolicy {
  const base: GameModePolicy =
    mode === 'sp' || mode === 'singlePlayer'
      ? SINGLE_PLAYER_POLICY
      : mode === 'open'
        ? OPEN_BNET_POLICY
        : CLOSED_REALM_POLICY

  if (!overrides) {
    return base
  }

  const allowPause =
    overrides.allowPause ??
    overrides.pauseOnSinglePlayerEscape ??
    base.allowPause
  const persistMapSeedAndFog =
    overrides.persistMapSeedAndFog ??
    overrides.persistMapSeedOnSave ??
    base.persistMapSeedAndFog
  const maxPlayers = Math.max(
    1,
    Math.min(8, Math.floor(overrides.maxPlayers ?? base.maxPlayers)),
  )
  const allowPlayersXCommand =
    overrides.allowPlayersXCommand ?? base.allowPlayersXCommand
  const allowPvpHostile = overrides.allowPvpHostile ?? base.allowPvpHostile
  const allowPlayerTrade = overrides.allowPlayerTrade ?? base.allowPlayerTrade
  const resolvedMode = overrides.mode ?? mode

  return {
    mode: resolvedMode,
    maxPlayers,
    allowPause,
    allowPlayersXCommand,
    persistMapSeedAndFog,
    allowPvpHostile,
    allowPlayerTrade,
    ...(overrides.defaultPlayersX !== undefined
      ? {
          defaultPlayersX: Math.max(
            1,
            Math.min(8, Math.floor(overrides.defaultPlayersX)),
          ),
        }
      : {}),
  }
}

export interface GameInstanceConfig {
  readonly mode?: GameMode | undefined
  readonly policy?: Partial<GameModePolicy> | undefined
  readonly mapSeed?: number | undefined
  readonly seed?: number | undefined
  readonly difficulty?: 0 | 1 | 2 | undefined
  readonly act?: number | undefined
  readonly actId?: number | undefined
  readonly areaId?: number | undefined
  readonly maxPlayers?: number | undefined
  readonly playersX?: number | undefined
  readonly gameName?: string | undefined
  readonly registry?: unknown
}

export interface ConnectPlayerSpec {
  readonly charName?: string | undefined
  readonly name?: string | undefined
  readonly classId?: CharClassId | CharacterClassCode | number | string | undefined
  readonly charClass?: CharClassId | CharacterClassCode | number | string | undefined
  readonly level?: number | undefined
  readonly hp?: number | undefined
  readonly maxHp?: number | undefined
  readonly d2s?: Uint8Array | undefined
  readonly d2sBytes?: Uint8Array | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly areaId?: number | undefined
}

export interface SpawnMonsterSpec {
  readonly classId?: number | undefined
  readonly hcIdx?: number | undefined
  readonly monstatsId?: number | undefined
  readonly defId?: string | undefined
  readonly name?: string | undefined
  readonly x: number
  readonly y: number
  readonly areaId?: number | undefined
  readonly hp?: number | undefined
  readonly maxHp?: number | undefined
  readonly minDmg?: number | undefined
  readonly maxDmg?: number | undefined
  readonly ar?: number | undefined
  readonly ac?: number | undefined
  readonly level?: number | undefined
  readonly isNpc?: boolean | undefined
  readonly isVendor?: boolean | undefined
  readonly experience?: number | undefined
  readonly aiDisabled?: boolean | undefined
  readonly rank?: MonsterRank | 'superunique' | 'boss' | undefined
  readonly modifiers?: readonly (string | number)[] | undefined
  readonly monUMods?: readonly (number | string)[] | undefined
  readonly umodIds?: readonly number[] | undefined
  readonly superUniqueId?: string | undefined
  readonly ai?: string | undefined
  readonly aiDelay?: number | undefined
  readonly aiParams?: readonly number[] | undefined
  readonly resistances?:
    | {
        readonly phys?: number | undefined
        readonly magic?: number | undefined
        readonly fire?: number | undefined
        readonly light?: number | undefined
        readonly lightning?: number | undefined
        readonly cold?: number | undefined
        readonly poison?: number | undefined
      }
    | undefined
  readonly isUndead?: boolean | undefined
  readonly isDemon?: boolean | undefined
  readonly isBoss?: boolean | undefined
  readonly isPrimeEvil?: boolean | undefined
  readonly isKillable?: boolean | undefined
  readonly killable?: boolean | undefined
  readonly petIgnore?: boolean | undefined
  readonly isFlying?: boolean | undefined
  readonly flying?: boolean | undefined
  readonly noRatio?: boolean | undefined
  readonly drain?: number | undefined
  readonly coldEffect?: number | undefined
  readonly toBlock?: number | undefined
  readonly velocity?: number | undefined
  readonly runSpeed?: number | undefined
  readonly stepSpeed?: number | undefined
  readonly aggroRadius?: number | undefined
  readonly meleeRange?: number | undefined
  readonly isRanged?: boolean | undefined
}

export interface HireMercenarySpec {
  readonly act?: 1 | 2 | 3 | 5 | undefined
  readonly subType?: number | undefined
  readonly level?: number | undefined
  readonly difficulty?: 1 | 2 | 3 | undefined
  readonly name?: string | undefined
  readonly hp?: number | undefined
  readonly maxHp?: number | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly activeAura?: string | undefined
}

export interface ServerMercenaryState {
  readonly unitId: number
  readonly ownerPlayerId: number
  readonly act: 1 | 2 | 3 | 5
  readonly subType: number
  readonly level: number
  readonly difficulty: 1 | 2 | 3
  readonly name: string
  readonly areaId: number
  readonly x: number
  readonly y: number
  readonly hp: number
  readonly maxHp: number
  readonly damage: number
  readonly activeAura: string | undefined
  readonly state: string
  readonly alive: boolean
}

export interface SummonPetSpec {
  readonly skillId: number
  readonly slvl?: number | undefined
  readonly skillLevel?: number | undefined
  readonly petType?: string | number | undefined
  readonly classId?: number | undefined
  readonly name?: string | undefined
  readonly hp?: number | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly corpseMonsterId?: number | undefined
  readonly ironGolemItemId?: number | undefined
}

export interface SpawnObjectSpec {
  readonly classId: number
  readonly name?: string | undefined
  readonly x: number
  readonly y: number
  readonly areaId?: number | undefined
  readonly mode?: number | undefined
  readonly isWaypoint?: boolean | undefined
  readonly isShrine?: boolean | undefined
  readonly shrineType?: number | undefined
  readonly destAreaId?: number | undefined
}

export interface ServerItemEntry {
  unitId: number
  code: string
  name: string
  quality: number
  level: number
  location:
    | 'ground'
    | 'inventory'
    | 'equipped'
    | 'belt'
    | 'stash'
    | 'cube'
    | 'cursor'
    | 'vendor'
    | 'socket'
  x: number
  y: number
  width: number
  height: number
  areaId: number
  ownerId: number
  bodyLoc: number
  storePage: number
  cost: number
  gamble: boolean
  identified: boolean
  ethereal: boolean
  socketed: boolean
  totalSockets: number
  durability: number
  maxDurability: number
  quantity: number
  stats: Map<number, number>
  socketedItems: ServerItemEntry[]
  rawItemData?: ItemData | undefined
}

export interface ServerPlayerState {
  readonly unitId: number
  readonly name: string
  readonly classId: CharClassId
  readonly classCode: CharacterClassCode
  readonly level: number
  readonly act: number
  readonly areaId: number
  readonly x: number
  readonly y: number
  readonly targetX: number
  readonly targetY: number
  readonly run: boolean
  readonly mode: number
  readonly hp: number
  readonly maxHp: number
  readonly mana: number
  readonly maxMana: number
  readonly stamina: number
  readonly maxStamina: number
  readonly experience: number
  readonly gold: number
  readonly goldInInventory: number
  readonly goldBank: number
  readonly stashGold: number
  readonly strength: number
  readonly dexterity: number
  readonly vitality: number
  readonly energy: number
  readonly statPts: number
  readonly statPoints: number
  readonly newSkills: number
  readonly skillPoints: number
  readonly leftSkill: number
  readonly rightSkill: number
  readonly skills: ReadonlyMap<number, number>
  readonly stats: ReadonlyMap<number, number>
  readonly states: ReadonlySet<number>
  readonly items: readonly ServerItemEntry[]
  readonly waypoints: ReadonlySet<number>
  readonly dead: boolean
  readonly corpseId: number | undefined
  readonly activeNpcId: number | undefined
  readonly partyId: number
}

export interface ServerMonsterState {
  readonly unitId: number
  readonly classId: number
  readonly hcIdx: number
  readonly defId: string
  readonly name: string
  readonly areaId: number
  readonly x: number
  readonly y: number
  readonly hp: number
  readonly maxHp: number
  readonly baseMaxHp: number
  readonly level: number
  readonly minDmg: number
  readonly maxDmg: number
  readonly ar: number
  readonly ac: number
  readonly experience: number
  readonly mode: number
  readonly dead: boolean
  readonly alive: boolean
  readonly isNpc: boolean
  readonly isVendor: boolean
  readonly isKillable: boolean
  readonly petIgnore: boolean
  readonly isBoss: boolean
  readonly isPrimeEvil: boolean
  readonly isUndead: boolean
  readonly isDemon: boolean
  readonly isFlying: boolean
  readonly isRanged: boolean
  readonly rank: MonsterRank
  readonly modifiers: readonly string[]
  readonly umodIds: readonly number[]
  readonly ai: string
  readonly aiDelay: number
  readonly aiParams: readonly number[]
  readonly resistances: {
    readonly phys: number
    readonly magic: number
    readonly fire: number
    readonly light: number
    readonly cold: number
    readonly poison: number
  }
  readonly frozenTicks: number
  readonly chillTicks: number
  readonly fleeTicks: number
  readonly shattered: boolean
  readonly corpseSuppressed: boolean
  readonly revivedByShaman: boolean
  readonly states: ReadonlySet<number>
}

const MERC_AURA_TO_STATE_ID: Readonly<Record<string, number>> = {
  Might: 33,
  might: 33,
  Prayer: 34,
  prayer: 34,
  Thorns: 36,
  thorns: 36,
  Defiance: 37,
  defiance: 37,
  'Blessed Aim': 40,
  'blessed aim': 40,
  BlessedAim: 40,
  blessedaim: 40,
  'Holy Freeze': 43,
  'holy freeze': 43,
  HolyFreeze: 43,
  holyfreeze: 43,
}

export interface ServerUnitSummary {
  readonly unitType: UnitType
  readonly unitId: number
  readonly classId: number
  readonly x: number
  readonly y: number
  readonly areaId: number
  readonly name?: string | undefined
  readonly mode?: number | undefined
  readonly hp?: number | undefined
  readonly maxHp?: number | undefined
}

const CLASS_CODE_TO_ID: Record<string, CharClassId> = {
  ama: 0,
  amazon: 0,
  sor: 1,
  sorceress: 1,
  nec: 2,
  necromancer: 2,
  pal: 3,
  paladin: 3,
  bar: 4,
  barbarian: 4,
  dru: 5,
  druid: 5,
  ass: 6,
  asn: 6,
  assassin: 6,
}

const CLASS_ID_TO_CODE: Record<number, CharacterClassCode> = {
  0: 'ama',
  1: 'sor',
  2: 'nec',
  3: 'pal',
  4: 'bar',
  5: 'dru',
  6: 'ass',
}

const CLASS_SKILL_OFFSET: Record<number, number> = {
  0: 6, // Amazon: 6..35
  1: 36, // Sorceress: 36..65
  2: 66, // Necromancer: 66..95
  3: 96, // Paladin: 96..125
  4: 126, // Barbarian: 126..155
  5: 221, // Druid: 221..250
  6: 251, // Assassin: 251..280
}

const ACT_TOWN_AREA: Record<number, number> = {
  0: 1,
  1: 40,
  2: 75,
  3: 103,
  4: 109,
}

const TOWN_AREAS = new Set<number>([1, 40, 75, 103, 109])

/**
 * Canonical 1.13c 39 waypoint bit-index (0..38) to `Levels.txt` areaId mapping.
 */
const WAYPOINT_AREA_IDS: readonly number[] = [
  // Act 1 (0..8)
  1, 3, 4, 5, 6, 27, 29, 32, 35,
  // Act 2 (9..17)
  40, 48, 42, 57, 43, 44, 52, 74, 46,
  // Act 3 (18..26)
  75, 76, 77, 78, 79, 80, 81, 83, 101,
  // Act 4 (27..29)
  103, 106, 107,
  // Act 5 (30..38)
  109, 111, 112, 113, 115, 123, 117, 118, 129,
]

function areaToAct(areaId: number): 0 | 1 | 2 | 3 | 4 {
  if (areaId >= 109) return 4
  if (areaId >= 103) return 3
  if (areaId >= 75) return 2
  if (areaId >= 40) return 1
  return 0
}

/** 1.13c Experience thresholds for levels 1..30 (`Experience.txt`). */
const EXP_THRESHOLDS: readonly number[] = [
  0, // lvl 1
  500, // lvl 2
  1500, // lvl 3
  3750, // lvl 4
  7875, // lvl 5
  14175, // lvl 6
  22680, // lvl 7
  32886, // lvl 8
  44396, // lvl 9
  57715, // lvl 10
  72144, // lvl 11
  90180, // lvl 12
  112725, // lvl 13
  140906, // lvl 14
  176132, // lvl 15
  220165, // lvl 16
  275207, // lvl 17
  344008, // lvl 18
  430010, // lvl 19
  537513, // lvl 20
]

interface ItemBaseSizeInfo {
  readonly code: string
  readonly name: string
  readonly width: number
  readonly height: number
  readonly cost: number
  readonly maxDurability: number
}

let cachedBaseSizes: Map<string, ItemBaseSizeInfo> | null = null

function getBaseSizeTable(): Map<string, ItemBaseSizeInfo> {
  if (cachedBaseSizes) return cachedBaseSizes
  const map = new Map<string, ItemBaseSizeInfo>()
  const enc = new TextEncoder()
  for (const raw of [RAW_ARMOR, RAW_WEAPONS, RAW_MISC]) {
    const tbl = parseTable(enc.encode(raw))
    const codeIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'code')
    const nameIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'name')
    const wIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'invwidth')
    const hIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'invheight')
    const costIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'cost')
    const durIdx = tbl.header.findIndex((h) => h.trim().toLowerCase() === 'durability')
    if (codeIdx === -1) continue
    for (const row of tbl.rows) {
      const code = (row[codeIdx] ?? '').trim()
      if (!code || code.toLowerCase() === 'expansion') continue
      const name = (nameIdx !== -1 ? row[nameIdx] : code)?.trim() || code
      const width = Math.max(1, Number((wIdx !== -1 ? row[wIdx] : '1')?.trim()) || 1)
      const height = Math.max(1, Number((hIdx !== -1 ? row[hIdx] : '1')?.trim()) || 1)
      const cost = Math.max(1, Number((costIdx !== -1 ? row[costIdx] : '50')?.trim()) || 50)
      const maxDurability = Math.max(0, Number((durIdx !== -1 ? row[durIdx] : '20')?.trim()) || 0)
      map.set(code, { code, name, width, height, cost, maxDurability })
    }
  }
  cachedBaseSizes = map
  return map
}

function lookupBaseInfo(code: string): ItemBaseSizeInfo {
  const clean = code.trim()
  return (
    getBaseSizeTable().get(clean) ?? {
      code: clean || 'hpot',
      name: clean || 'Minor Healing Potion',
      width: 1,
      height: 1,
      cost: 50,
      maxDurability: 20,
    }
  )
}

function normalizeClassId(
  raw: CharClassId | CharacterClassCode | number | string | undefined,
): CharClassId {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) {
    return raw as CharClassId
  }
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase()
    const mapped = CLASS_CODE_TO_ID[lower]
    if (mapped !== undefined) return mapped
    const num = Number(lower)
    if (Number.isInteger(num) && num >= 0 && num <= 6) return num as CharClassId
  }
  return 0
}

interface InternalPlayerRecord {
  unitId: number
  name: string
  classId: CharClassId
  classCode: CharacterClassCode
  level: number
  act: 0 | 1 | 2 | 3 | 4
  areaId: number
  x: number
  y: number
  targetX: number
  targetY: number
  run: boolean
  mode: number
  hp: number
  maxHp: number
  hpFixed: number
  maxHpFixed: number
  mana: number
  maxMana: number
  manaFixed: number
  maxManaFixed: number
  stamina: number
  maxStamina: number
  staminaFixed: number
  maxStaminaFixed: number
  experience: number
  gold: number
  goldBank: number
  strength: number
  dexterity: number
  vitality: number
  energy: number
  statPts: number
  newSkills: number
  leftSkill: number
  rightSkill: number
  skills: Map<number, number>
  states: Set<number>
  stateTimers: Map<number, number>
  items: ServerItemEntry[]
  corpseItems: ServerItemEntry[]
  ironGolemItem: ServerItemEntry | null
  waypoints: Set<number>
  hasExplicitWaypoints: boolean
  dead: boolean
  corpseId: number | undefined
  corpseX: number
  corpseY: number
  activeNpcId: number | undefined
  partyId: number
  d2sTemplate: D2sDecodedCharacterSave | undefined
}

interface InternalMonsterRecord {
  unitId: number
  classId: number
  hcIdx: number
  defId: string
  name: string
  areaId: number
  x: number
  y: number
  hp: number
  maxHp: number
  baseMaxHp: number
  level: number
  baseXp: number
  minDmg: number
  maxDmg: number
  ar: number
  ac: number
  mode: number
  dead: boolean
  isNpc: boolean
  isVendor: boolean
  isKillable: boolean
  petIgnore: boolean
  isBoss: boolean
  isPrimeEvil: boolean
  isUndead: boolean
  isDemon: boolean
  isFlying: boolean
  isRanged: boolean
  noRatio: boolean
  rank: MonsterRank
  modifiers: readonly string[]
  umodIds: readonly number[]
  ai: string
  aiDelay: number
  aiParams: readonly number[]
  resistances: {
    phys: number
    magic: number
    fire: number
    light: number
    cold: number
    poison: number
  }
  drain: number
  coldEffect: number
  toBlock: number
  velocity: number
  runSpeed: number
  stepSpeed: number | undefined
  aggroRadius: number
  cooldown: number
  cooldownTicks: number
  frozenTicks: number
  chillTicks: number
  fleeTicks: number
  shattered: boolean
  revivedByShaman: boolean
  aiDisabled: boolean
  states: Set<number>
  stateTimers: Map<number, number>
  vendorPool: ServerItemEntry[]
}

interface InternalMercenaryRecord {
  unitId: number
  ownerPlayerId: number
  act: 1 | 2 | 3 | 5
  subType: number
  level: number
  difficulty: 1 | 2 | 3
  name: string
  areaId: number
  x: number
  y: number
  hp: number
  maxHp: number
  damage: number
  reach: number
  aggroRadius: number
  speed: number
  cooldown: number
  cooldownTicks: number
  activeAura: string | undefined
  state: 'idle' | 'follow' | 'chase' | 'attack' | 'dead'
  alive: boolean
}

interface InternalObjectRecord {
  unitId: number
  classId: number
  areaId: number
  x: number
  y: number
  mode: number
  isWaypoint: boolean
  isShrine: boolean
  shrineType: number
  destAreaId: number | undefined
  portalOwnerId: number | undefined
}

interface InternalMissileRecord {
  unitId: number
  missileId: number
  skillId: number
  ownerType: 'player' | 'monster'
  ownerId: number
  areaId: number
  x: number
  y: number
  vx: number
  vy: number
  damage: number
  remainingFrames: number
}

function toItemContainer(loc: ServerItemEntry['location']): ItemContainer {
  if (loc === 'equipped') return 'equipment'
  if (loc === 'vendor') return 'shop'
  return loc
}

interface QueuedPlayerCommand {
  readonly playerUnitId: number
  readonly command: ClientCommand
}

let cachedEmbeddedFallbackRegistry: D2DataRegistry | null = null

function getOrCreateEmbeddedFallbackRegistry(): D2DataRegistry {
  if (cachedEmbeddedFallbackRegistry !== null) {
    return cachedEmbeddedFallbackRegistry
  }
  const emptyTable = { columns: [] as const, rows: [] as const }
  const emptyAnimData = decodeAnimDataFile(new Uint8Array(256 * 4))
  cachedEmbeddedFallbackRegistry = new D2DataRegistry({
    skillsTable: emptyTable,
    skillDescTable: emptyTable,
    missilesTable: emptyTable,
    statesTable: emptyTable,
    itemStatCostTable: emptyTable,
    charStatsTable: emptyTable,
    monStatsTable: emptyTable,
    monStats2Table: emptyTable,
    overlayTable: emptyTable,
    petTypeTable: emptyTable,
    elemTypesTable: emptyTable,
    hitClassTable: emptyTable,
    eventsTable: emptyTable,
    skillCalcTable: emptyTable,
    missCalcTable: emptyTable,
    animData: emptyAnimData,
  })
  return cachedEmbeddedFallbackRegistry
}

export class GameInstance {
  readonly mode: GameMode
  readonly policy: GameModePolicy
  readonly difficulty: 0 | 1 | 2
  readonly gameName: string
  readonly registry: D2DataRegistry

  private currentFrame = 0
  private currentMapSeed: number
  private readonly hasExplicitMapSeed: boolean
  readonly defaultAreaId: number | undefined
  private readonly defaultAct: 0 | 1 | 2 | 3 | 4 | undefined
  private rng: D2Rng
  private pausedState = false
  private manualPlayersX: number
  private nextUnitId = 1

  private readonly players = new Map<number, InternalPlayerRecord>()
  private readonly monsters = new Map<number, InternalMonsterRecord>()
  private readonly mercenaries = new Map<number, InternalMercenaryRecord>()
  private readonly summonManagers = new Map<number, SummonManager>()
  private readonly petUnitIds = new Map<string, number>()
  private readonly objects = new Map<number, InternalObjectRecord>()
  private readonly groundItems = new Map<number, ServerItemEntry>()
  private readonly missiles = new Map<number, InternalMissileRecord>()
  private readonly streamedWildernessRooms = new Set<string>()
  private readonly commandQueue: QueuedPlayerCommand[] = []
  private readonly outbox = new Map<number, ServerEvent[]>()
  private terrainWalkableCheck:
    | ((areaId: number, x: number, y: number, isFlying?: boolean) => boolean)
    | undefined

  constructor(config: GameInstanceConfig = {}) {
    const inferredMode: GameMode =
      config.policy?.mode ?? config.mode ?? 'sp'
    this.mode = inferredMode

    if (
      config.policy &&
      config.maxPlayers === undefined &&
      config.playersX === undefined &&
      (config.policy === SINGLE_PLAYER_POLICY ||
        config.policy === OPEN_BNET_POLICY ||
        config.policy === CLOSED_REALM_POLICY)
    ) {
      this.policy = config.policy as GameModePolicy
    } else {
      this.policy = resolveGameModePolicy(inferredMode, {
        ...config.policy,
        ...(config.maxPlayers !== undefined ? { maxPlayers: config.maxPlayers } : {}),
        ...(config.playersX !== undefined ? { defaultPlayersX: config.playersX } : {}),
      })
    }

    this.difficulty = config.difficulty ?? 0
    this.gameName = config.gameName ?? 'LocalGame'
    if (
      config.registry &&
      typeof (config.registry as D2DataRegistry).getSkillById === 'function'
    ) {
      this.registry = config.registry as D2DataRegistry
    } else {
      try {
        this.registry = getSharedDataRegistry()
      } catch {
        this.registry = getOrCreateEmbeddedFallbackRegistry()
      }
    }
    this.defaultAreaId = config.areaId
    const rawAct = config.act ?? config.actId
    this.defaultAct =
      rawAct !== undefined && rawAct >= 0 && rawAct <= 4
        ? (rawAct as 0 | 1 | 2 | 3 | 4)
        : undefined

    const rawSeed = config.mapSeed ?? config.seed
    this.hasExplicitMapSeed = rawSeed !== undefined && rawSeed !== 0
    this.currentMapSeed = ((rawSeed ?? 0x12345678) >>> 0) || 1
    this.rng = new D2Rng(this.currentMapSeed)
    this.manualPlayersX = Math.max(
      1,
      Math.min(8, Math.floor(config.playersX ?? this.policy.defaultPlayersX ?? 1)),
    )
  }

  setTerrainWalkableCheck(
    fn: ((areaId: number, x: number, y: number, isFlying?: boolean) => boolean) | undefined,
  ): void {
    this.terrainWalkableCheck = fn
  }

  setWalkabilityCallback(
    fn:
      | ((x: number, y: number, isFlying?: boolean) => boolean)
      | ((areaId: number, x: number, y: number, isFlying?: boolean) => boolean)
      | undefined,
  ): void {
    if (!fn) {
      this.terrainWalkableCheck = undefined
      return
    }
    if (fn.length <= 2) {
      const cb = fn as (x: number, y: number) => boolean
      this.terrainWalkableCheck = (_areaId: number, x: number, y: number) => cb(x, y)
    } else {
      this.terrainWalkableCheck = fn as (
        areaId: number,
        x: number,
        y: number,
        isFlying?: boolean,
      ) => boolean
    }
  }

  movePlayer(playerUnitId: number, x: number, y: number): void {
    const p = this.players.get(playerUnitId)
    if (!p) return
    p.x = x
    p.y = y
    p.targetX = x
    p.targetY = y
  }

  private isMonsterStepWalkable(
    areaId: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    isFlying: boolean,
  ): boolean {
    if (
      !Number.isFinite(fromX) ||
      !Number.isFinite(fromY) ||
      !Number.isFinite(toX) ||
      !Number.isFinite(toY)
    ) {
      return false
    }
    if (!this.terrainWalkableCheck) return true
    if (isFlying && this.terrainWalkableCheck.length < 4) return true

    const dist = Math.hypot(toX - fromX, toY - fromY)
    const steps = Math.max(4, Math.ceil(dist / 0.25))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const px = fromX + (toX - fromX) * t
      const py = fromY + (toY - fromY) * t
      if (
        !this.terrainWalkableCheck(areaId, px, py, isFlying) ||
        !this.terrainWalkableCheck(
          areaId,
          Math.round(px),
          Math.round(py),
          isFlying,
        )
      ) {
        return false
      }
    }
    return true
  }

  get frame(): number {
    return this.currentFrame
  }

  get tickCount(): number {
    return this.currentFrame
  }

  get mapSeed(): number {
    return this.currentMapSeed
  }

  get paused(): boolean {
    return this.pausedState
  }

  isPaused(): boolean {
    return this.pausedState
  }

  setPaused(paused: boolean): void {
    const canPause = Boolean(
      this.policy.allowPause ?? this.policy.pauseOnSinglePlayerEscape,
    )
    if (canPause) {
      this.pausedState = Boolean(paused)
    }
  }

  get playersX(): number {
    return Math.max(1, Math.min(8, Math.max(this.manualPlayersX, this.players.size)))
  }

  getPlayersX(): number {
    return this.playersX
  }

  get playerCount(): number {
    return this.players.size
  }

  setPlayersX(value: number): number {
    const clamped = Math.max(1, Math.min(8, Math.floor(Number(value) || 1)))
    this.manualPlayersX = clamped
    this.rescaleActiveMonsters()
    return this.playersX
  }

  private allocateUnitId(): number {
    return this.nextUnitId++
  }

  private canPersistMapSeed(): boolean {
    return Boolean(
      this.policy.persistMapSeedAndFog ?? this.policy.persistMapSeedOnSave,
    )
  }

  private rescaleActiveMonsters(): void {
    const px = this.playersX
    const multNum = px + 1
    for (const m of this.monsters.values()) {
      if (m.isNpc || m.dead || m.noRatio) continue
      const ratio = m.maxHp > 0 ? m.hp / m.maxHp : 1
      m.maxHp = Math.max(1, Math.floor((m.baseMaxHp * multNum) / 2))
      m.hp = Math.max(1, Math.round(m.maxHp * ratio))
    }
  }

  connectPlayer(spec: ConnectPlayerSpec = {}): number {
    if (this.players.size >= this.policy.maxPlayers) {
      throw new Error(
        `GameInstance: room is full (${this.players.size}/${this.policy.maxPlayers} players)`,
      )
    }

    const d2sRaw = spec.d2s ?? spec.d2sBytes
    let parsedD2s: D2sDecodedCharacterSave | undefined
    if (d2sRaw instanceof Uint8Array) {
      parsedD2s = readD2sSave113c(d2sRaw)
      if (
        this.canPersistMapSeed() &&
        parsedD2s.mapSeed !== 0 &&
        !this.hasExplicitMapSeed
      ) {
        this.currentMapSeed = parsedD2s.mapSeed >>> 0
        this.rng = new D2Rng(this.currentMapSeed)
      }
    }

    const charName = (
      spec.charName ??
      spec.name ??
      parsedD2s?.name ??
      `Hero${this.nextUnitId}`
    ).trim()
    for (const existing of this.players.values()) {
      if (existing.name.toLowerCase() === charName.toLowerCase()) {
        throw new Error(`GameInstance: character "${charName}" is already in the game`)
      }
    }

    const classId =
      parsedD2s !== undefined
        ? normalizeClassId(parsedD2s.classId)
        : normalizeClassId(spec.classId ?? spec.charClass)
    const classCode = CLASS_ID_TO_CODE[classId] ?? 'ama'
    const baseStats = CANONICAL_CHARSTATS[classCode]
    const unitId = this.allocateUnitId()

    const level = Math.max(1, parsedD2s?.level ?? spec.level ?? 1)
    const areaId =
      spec.areaId ??
      this.defaultAreaId ??
      ACT_TOWN_AREA[parsedD2s?.activeAct ?? this.defaultAct ?? 0] ??
      1
    const act = areaToAct(areaId)
    const spawnX = spec.x ?? 128 + (this.players.size % 4) * 2
    const spawnY = spec.y ?? 128 + Math.floor(this.players.size / 4) * 2

    const attrs = parsedD2s?.attributes
    const strength = attrs?.strength ?? baseStats.baseAttributes.strength
    const dexterity = attrs?.dexterity ?? baseStats.baseAttributes.dexterity
    const vitality = attrs?.vitality ?? baseStats.baseAttributes.vitality
    const energy = attrs?.energy ?? baseStats.baseAttributes.energy
    const statPts = attrs?.statPts ?? 0
    const newSkills = attrs?.newSkills ?? 0

    const maxHpFixed =
      spec.maxHp !== undefined && spec.maxHp > 0
        ? spec.maxHp * FIXED_ONE
        : attrs && attrs.maxHpFixed > 0
          ? attrs.maxHpFixed
          : baseStats.baseVitals.life * FIXED_ONE
    const hpFixed =
      spec.hp !== undefined && spec.hp > 0
        ? Math.min(maxHpFixed, spec.hp * FIXED_ONE)
        : attrs && attrs.hitpointsFixed > 0
          ? Math.min(maxHpFixed, attrs.hitpointsFixed)
          : maxHpFixed
    const maxManaFixed =
      attrs && attrs.maxManaFixed > 0
        ? attrs.maxManaFixed
        : baseStats.baseVitals.mana * FIXED_ONE
    const manaFixed =
      attrs !== undefined
        ? Math.min(maxManaFixed, attrs.manaFixed)
        : maxManaFixed
    const maxStaminaFixed =
      attrs && attrs.maxStaminaFixed > 0
        ? attrs.maxStaminaFixed
        : baseStats.baseVitals.stamina * FIXED_ONE
    const staminaFixed =
      attrs && attrs.staminaFixed > 0
        ? Math.min(maxStaminaFixed, attrs.staminaFixed)
        : maxStaminaFixed

    const maxHp = Math.max(1, Math.floor(maxHpFixed / FIXED_ONE))
    const hp = Math.max(1, Math.min(maxHp, Math.floor(hpFixed / FIXED_ONE)))
    const maxMana = Math.max(0, Math.floor(maxManaFixed / FIXED_ONE))
    const mana = Math.max(0, Math.min(maxMana, Math.floor(manaFixed / FIXED_ONE)))
    const maxStamina = Math.max(1, Math.floor(maxStaminaFixed / FIXED_ONE))
    const stamina = Math.max(
      1,
      Math.min(maxStamina, Math.floor(staminaFixed / FIXED_ONE)),
    )

    const experience =
      attrs?.experience ??
      EXP_THRESHOLDS[Math.min(level - 1, EXP_THRESHOLDS.length - 1)] ??
      0
    const gold = attrs?.gold ?? 0
    const goldBank = attrs?.goldBank ?? 0

    const skills = new Map<number, number>()
    const skillOffset = CLASS_SKILL_OFFSET[classId] ?? 6
    if (parsedD2s?.skills) {
      for (let i = 0; i < parsedD2s.skills.length; i++) {
        const slvl = parsedD2s.skills[i] ?? 0
        if (slvl > 0) {
          skills.set(skillOffset + i, slvl)
        }
      }
    }

    const items: ServerItemEntry[] = []
    if (parsedD2s) {
      for (const itemData of parsedD2s.items) {
        items.push(this.itemDataToServerEntry(itemData, unitId, areaId))
      }
    } else {
      const potInfo = lookupBaseInfo('hpot')
      for (let i = 0; i < 4; i++) {
        items.push({
          unitId: this.allocateUnitId(),
          code: 'hpot',
          name: potInfo.name,
          quality: 2,
          level: 1,
          location: 'belt',
          x: i,
          y: 0,
          width: 1,
          height: 1,
          areaId,
          ownerId: unitId,
          bodyLoc: 0,
          storePage: 0,
          cost: potInfo.cost,
          gamble: false,
          identified: true,
          ethereal: false,
          socketed: false,
          totalSockets: 0,
          durability: 0,
          maxDurability: 0,
          quantity: 1,
          stats: new Map(),
          socketedItems: [],
        })
      }
    }

    const corpseItems: ServerItemEntry[] = []
    if (parsedD2s?.corpseItems) {
      for (const ci of parsedD2s.corpseItems) {
        corpseItems.push(this.itemDataToServerEntry(ci, unitId, areaId))
      }
    }
    const ironGolemItem = parsedD2s?.ironGolem
      ? this.itemDataToServerEntry(parsedD2s.ironGolem, unitId, areaId)
      : null

    const waypoints = new Set<number>([1])
    let hasExplicitWaypoints = false
    const wpBytes = parsedD2s?.waypoints?.[this.difficulty]
    if (wpBytes instanceof Uint8Array && wpBytes.byteLength >= 7) {
      hasExplicitWaypoints = true
      for (let bitIndex = 0; bitIndex < WAYPOINT_AREA_IDS.length; bitIndex++) {
        const byteIdx = 2 + (bitIndex >> 3)
        const bitMask = 1 << (bitIndex & 7)
        if (((wpBytes[byteIdx] ?? 0) & bitMask) !== 0) {
          waypoints.add(WAYPOINT_AREA_IDS[bitIndex]!)
        }
      }
    }

    const record: InternalPlayerRecord = {
      unitId,
      name: charName,
      classId,
      classCode,
      level,
      act,
      areaId,
      x: spawnX,
      y: spawnY,
      targetX: spawnX,
      targetY: spawnY,
      run: true,
      mode: TOWN_AREAS.has(areaId) ? 5 : 1,
      hp,
      maxHp,
      hpFixed,
      maxHpFixed,
      mana,
      maxMana,
      manaFixed,
      maxManaFixed,
      stamina,
      maxStamina,
      staminaFixed,
      maxStaminaFixed,
      experience,
      gold,
      goldBank,
      strength,
      dexterity,
      vitality,
      energy,
      statPts,
      newSkills,
      leftSkill: parsedD2s?.leftSkill ?? 0,
      rightSkill: parsedD2s?.rightSkill ?? 0,
      skills,
      states: new Set(),
      stateTimers: new Map(),
      items,
      corpseItems,
      ironGolemItem,
      waypoints,
      hasExplicitWaypoints,
      dead: false,
      corpseId: undefined,
      corpseX: spawnX,
      corpseY: spawnY,
      activeNpcId: undefined,
      partyId: 0xffff,
      d2sTemplate: parsedD2s,
    }

    this.players.set(unitId, record)
    this.outbox.set(unitId, [])
    this.rescaleActiveMonsters()

    this.emitToPlayer(unitId, {
      type: 'GameLogonAck',
      playerUnitId: unitId,
      mapSeed: this.currentMapSeed,
      difficulty: this.difficulty,
      act,
      areaId,
    })
    this.emitToPlayer(unitId, {
      type: 'LoadAct',
      act,
      mapSeed: this.currentMapSeed,
      areaId,
    })
    this.emitToPlayer(unitId, {
      type: 'PlayerAssign',
      unitId,
      classId,
      charClass: classId,
      charName,
      name: charName,
      x: spawnX,
      y: spawnY,
      areaId,
    })
    this.emitToPlayer(unitId, {
      type: 'UnitAssign',
      isSelf: true,
      unitType: 'player',
      unitId,
      classId,
      name: charName,
      x: spawnX,
      y: spawnY,
      areaId,
      unit: {
        unitType: 0,
        id: unitId,
        classId,
        name: charName,
        x: spawnX,
        y: spawnY,
        mode: record.mode,
      },
    })
    this.emitInitialPlayerStats(record)

    for (const other of this.players.values()) {
      if (other.unitId === unitId) continue
      this.emitToPlayer(other.unitId, {
        type: 'Party',
        kind: 'roster',
        action: 'join',
        playerId: unitId,
        charClass: classId,
        charName,
        charLevel: level,
        partyId: 0xffff,
        areaId,
      })
      this.emitToPlayer(unitId, {
        type: 'Party',
        kind: 'roster',
        action: 'join',
        playerId: other.unitId,
        charClass: other.classId,
        charName: other.name,
        charLevel: other.level,
        partyId: other.partyId,
        areaId: other.areaId,
      })
      if (other.areaId === areaId) {
        this.emitToPlayer(other.unitId, {
          type: 'UnitAssign',
          unitType: 'player',
          unitId,
          classId,
          name: charName,
          x: spawnX,
          y: spawnY,
          areaId,
          unit: {
            unitType: 0,
            id: unitId,
            classId,
            name: charName,
            x: spawnX,
            y: spawnY,
            mode: record.mode,
          },
        })
        this.emitToPlayer(unitId, {
          type: 'UnitAssign',
          unitType: 'player',
          unitId: other.unitId,
          classId: other.classId,
          name: other.name,
          x: other.x,
          y: other.y,
          areaId: other.areaId,
          unit: {
            unitType: 0,
            id: other.unitId,
            classId: other.classId,
            name: other.name,
            x: other.x,
            y: other.y,
            mode: other.mode,
          },
        })
      }
    }

    this.emitAreaSnapshotToPlayer(record)
    return unitId
  }

  addPlayer(spec: ConnectPlayerSpec = {}): number {
    return this.connectPlayer(spec)
  }

  disconnectPlayer(playerUnitId: number): Uint8Array | null {
    const existing = this.players.get(playerUnitId)
    if (!existing) return null
    const savedD2s = this.exportPlayerD2s(playerUnitId)
    this.players.delete(playerUnitId)
    this.outbox.delete(playerUnitId)
    this.rescaleActiveMonsters()

    for (const other of this.players.values()) {
      this.emitToPlayer(other.unitId, {
        type: 'UnitRemove',
        unitType: 0,
        id: playerUnitId,
        unitId: playerUnitId,
      })
      this.emitToPlayer(other.unitId, {
        type: 'Party',
        kind: 'roster',
        action: 'leave',
        playerId: playerUnitId,
      })
    }
    return savedD2s
  }

  removePlayer(playerUnitId: number): Uint8Array | null {
    return this.disconnectPlayer(playerUnitId)
  }

  private itemDataToServerEntry(
    itemData: ItemData,
    ownerId: number,
    areaId: number,
  ): ServerItemEntry {
    const info = lookupBaseInfo(itemData.code)
    const locNum = itemData.location
    let location: ServerItemEntry['location'] = 'inventory'
    if (locNum === 1) location = 'equipped'
    else if (locNum === 2) location = 'belt'
    else if (locNum === 4) location = 'cursor'
    else if (locNum === 6) location = 'socket'
    else if (itemData.storePage === 4) location = 'stash'
    else if (itemData.storePage === 3) location = 'cube'

    const stats = new Map<number, number>()
    for (const st of itemData.stats ?? []) {
      stats.set(st.statId, st.value)
    }

    const rawId = Number(itemData.id ?? 0)
    const unitId = rawId > 0 ? rawId : this.allocateUnitId()
    if (unitId >= this.nextUnitId) {
      this.nextUnitId = unitId + 1
    }

    return {
      unitId,
      code: itemData.code.trim(),
      name: info.name,
      quality: itemData.quality ?? 2,
      level: itemData.ilvl ?? 1,
      location,
      x: itemData.x ?? 0,
      y: itemData.y ?? 0,
      width: info.width,
      height: info.height,
      areaId,
      ownerId,
      bodyLoc: itemData.bodyLoc ?? 0,
      storePage: itemData.storePage ?? 1,
      cost: info.cost,
      gamble: false,
      identified: itemData.identified ?? true,
      ethereal: itemData.ethereal ?? false,
      socketed: itemData.socketed ?? false,
      totalSockets: itemData.totalSockets ?? 0,
      durability: itemData.durability ?? info.maxDurability,
      maxDurability: itemData.maxDurability ?? info.maxDurability,
      quantity: itemData.quantity ?? 1,
      stats,
      socketedItems: (itemData.socketedItems ?? []).map((child) =>
        this.itemDataToServerEntry(child, ownerId, areaId),
      ),
      rawItemData: itemData,
    }
  }

  private serverEntryToItemData(entry: ServerItemEntry): ItemData {
    let location = 0
    let storePage = entry.storePage
    if (entry.location === 'equipped') {
      location = 1
      storePage = 0
    } else if (entry.location === 'belt') {
      location = 2
      storePage = 0
    } else if (entry.location === 'cursor') {
      location = 4
      storePage = 0
    } else if (entry.location === 'socket') {
      location = 6
      storePage = 0
    } else if (entry.location === 'stash') {
      location = 0
      storePage = 4
    } else if (entry.location === 'cube') {
      location = 0
      storePage = 3
    } else {
      location = 0
      storePage = 1
    }

    const baseRaw = entry.rawItemData
    const hasCustomStats = entry.stats.size > 0
    const statsList =
      baseRaw?.stats && baseRaw.stats.length > 0 && !hasCustomStats
        ? baseRaw.stats
        : Array.from(entry.stats.entries()).map(([statId, value]) => ({
            statId,
            param: 0,
            value,
          }))

    const codePadded = entry.code.padEnd(4, ' ').slice(0, 4)
    const isSimple =
      baseRaw?.simple ??
      (statsList.length === 0 &&
        entry.socketedItems.length === 0 &&
        entry.quality === 2)

    return {
      ...(baseRaw ?? {}),
      id: entry.unitId as UnitId,
      itemId: entry.unitId as UnitId,
      opcode: baseRaw?.opcode ?? 0x9c,
      action: baseRaw?.action ?? 0,
      category: baseRaw?.category ?? 0,
      ownerType: baseRaw?.ownerType ?? 0,
      ownerId: entry.ownerId as UnitId,
      flags: baseRaw?.flags ?? 0x00000010,
      rawFlags: baseRaw?.rawFlags ?? 0x00000010,
      version: baseRaw?.version ?? 101,
      location,
      container: toItemContainer(entry.location),
      bodyLoc: entry.bodyLoc,
      equippedSlot: entry.bodyLoc,
      gridX: entry.x,
      gridY: entry.y,
      storePage,
      storagePage: storePage,
      worldX: entry.x,
      worldY: entry.y,
      x: entry.x,
      y: entry.y,
      code: entry.code.trim(),
      rawCode: codePadded,
      compact: baseRaw?.compact ?? isSimple,
      simple: isSimple,
      identified: entry.identified,
      socketed: entry.socketed || entry.socketedItems.length > 0,
      ethereal: entry.ethereal,
      runeword: baseRaw?.runeword ?? false,
      personalized: baseRaw?.personalized ?? false,
      isEar: baseRaw?.isEar ?? false,
      newItem: baseRaw?.newItem ?? false,
      starterItem: baseRaw?.starterItem ?? false,
      broken: baseRaw?.broken ?? false,
      inSocket: entry.location === 'socket',
      equipped: entry.location === 'equipped',
      socketedChildCount: entry.socketedItems.length,
      usedSockets: entry.socketedItems.length,
      totalSockets: Math.max(entry.totalSockets, entry.socketedItems.length),
      ilvl: entry.level,
      quality: entry.quality as ItemQuality,
      graphicIndex: baseRaw?.graphicIndex ?? 0,
      durability: entry.durability,
      curDurability: entry.durability,
      maxDurability: entry.maxDurability,
      quantity: entry.quantity,
      invWidth: entry.width,
      invHeight: entry.height,
      stats: statsList,
      setBonusStats: baseRaw?.setBonusStats ?? [],
      runewordStats: baseRaw?.runewordStats ?? [],
      ...(entry.socketedItems.length > 0
        ? {
            socketedItems: entry.socketedItems.map((c) =>
              this.serverEntryToItemData(c),
            ),
          }
        : {}),
    }
  }

  private emitInitialPlayerStats(player: InternalPlayerRecord): void {
    const statPairs: ReadonlyArray<readonly [number, number]> = [
      [0, player.strength],
      [1, player.energy],
      [2, player.dexterity],
      [3, player.vitality],
      [4, player.statPts],
      [5, player.newSkills],
      [6, player.hp],
      [7, player.maxHp],
      [8, player.mana],
      [9, player.maxMana],
      [10, player.stamina],
      [11, player.maxStamina],
      [12, player.level],
      [13, player.experience],
      [14, player.gold],
      [15, player.goldBank],
    ]
    for (const [statId, value] of statPairs) {
      this.emitToPlayer(player.unitId, {
        type: 'UnitStatUpdate',
        unitType: 'player',
        unitId: player.unitId,
        statId,
        value,
      })
      this.emitToPlayer(player.unitId, {
        type: 'StatSet',
        stat: statId,
        value,
      })
    }
    this.emitToPlayer(player.unitId, {
      type: 'LifeMana',
      life: player.hp,
      mana: player.mana,
      stamina: player.stamina,
      at: { x: player.x, y: player.y },
      vx: 0,
      vy: 0,
    })

    for (const [skillId, slvl] of player.skills.entries()) {
      this.emitToPlayer(player.unitId, {
        type: 'SkillUpdate',
        unitId: player.unitId,
        skillId,
        level: slvl,
      })
    }

    for (const item of player.items) {
      this.emitToPlayer(player.unitId, {
        type: 'ItemEvent',
        action: 'add',
        itemId: item.unitId,
        code: item.code,
        x: item.x,
        y: item.y,
        container: toItemContainer(item.location),
        item: this.serverEntryToItemData(item),
      })
    }
  }

  private emitAreaSnapshotToPlayer(player: InternalPlayerRecord): void {
    for (const m of this.monsters.values()) {
      if (m.areaId !== player.areaId) continue
      this.emitToPlayer(player.unitId, {
        type: 'UnitAssign',
        unitType: 'monster',
        unitId: m.unitId,
        classId: m.classId,
        name: m.name,
        x: m.x,
        y: m.y,
        areaId: m.areaId,
        unit: {
          unitType: 1,
          id: m.unitId,
          classId: m.classId,
          name: m.name,
          x: m.x,
          y: m.y,
          mode: m.mode,
          lifePct: m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 128) : 0,
        },
      })
    }
    for (const obj of this.objects.values()) {
      if (obj.areaId !== player.areaId) continue
      this.emitToPlayer(player.unitId, {
        type: 'UnitAssign',
        unitType: 'object',
        unitId: obj.unitId,
        classId: obj.classId,
        x: obj.x,
        y: obj.y,
        areaId: obj.areaId,
        unit: {
          unitType: 2,
          id: obj.unitId,
          classId: obj.classId,
          x: obj.x,
          y: obj.y,
          mode: obj.mode,
        },
      })
      if (obj.destAreaId !== undefined) {
        this.emitToPlayer(player.unitId, {
          type: 'Portal',
          portalId: obj.unitId,
          ownerId: obj.portalOwnerId,
          areaId: obj.areaId,
          destAreaId: obj.destAreaId,
          localId: obj.unitId,
          remoteId: obj.unitId,
          flags: 1,
        })
      }
    }
    for (const gItem of this.groundItems.values()) {
      if (gItem.areaId !== player.areaId) continue
      this.emitToPlayer(player.unitId, {
        type: 'ItemEvent',
        action: 'groundSpawn',
        itemId: gItem.unitId,
        code: gItem.code,
        x: gItem.x,
        y: gItem.y,
        container: 'ground',
        item: this.serverEntryToItemData(gItem),
      })
    }
  }

  private createDefaultVendorPool(areaId: number, ownerId: number, level = 1): ServerItemEntry[] {
    const vendorPool: ServerItemEntry[] = []
    for (const code of ['hpot', 'mpot', 'cap', 'Hnd', 'buc']) {
      const info = lookupBaseInfo(code)
      vendorPool.push({
        unitId: this.allocateUnitId(),
        code,
        name: info.name,
        quality: 2,
        level: Math.max(1, level),
        location: 'vendor',
        x: 0,
        y: 0,
        width: info.width,
        height: info.height,
        areaId,
        ownerId,
        bodyLoc: 0,
        storePage: 0,
        cost: info.cost,
        gamble: false,
        identified: true,
        ethereal: false,
        socketed: false,
        totalSockets: 0,
        durability: info.maxDurability,
        maxDurability: info.maxDurability,
        quantity: 1,
        stats: new Map(),
        socketedItems: [],
      })
    }
    return vendorPool
  }

  spawnMonster(spec: SpawnMonsterSpec): number {
    const unitId = this.allocateUnitId()
    const rawClassId = spec.classId ?? spec.hcIdx ?? spec.monstatsId
    const diffName =
      this.difficulty === 2
        ? 'hell'
        : this.difficulty === 1
          ? 'nightmare'
          : 'normal'

    const rawClassKind =
      rawClassId !== undefined
        ? getMonsterKindByHcIdx(rawClassId, diffName)
        : undefined
    let kind: MonsterKind | undefined
    if (
      spec.defId &&
      !(spec.defId.trim().toLowerCase() === 'chicken' && rawClassId !== undefined && rawClassId !== 149)
    ) {
      const targetDef = spec.defId.trim().toLowerCase()
      const canonicalMap = getCanonicalMonsterKinds(diffName)
      kind = canonicalMap.get(targetDef)
      if (!kind) {
        for (const k of canonicalMap.values()) {
          if (
            k.id.toLowerCase() === targetDef ||
            k.baseId.toLowerCase() === targetDef
          ) {
            kind = k
            break
          }
        }
      }
    }
    if (!kind && rawClassKind) {
      kind = rawClassKind
    }

    const classId = rawClassId ?? kind?.hcIdx ?? 0
    const hcIdx = rawClassId ?? kind?.hcIdx ?? classId
    const defId =
      spec.defId &&
      !(spec.defId.trim().toLowerCase() === 'chicken' && rawClassId !== undefined && rawClassId !== 149)
        ? spec.defId
        : (kind?.id ?? spec.defId ?? `monster_${classId}`)
    const areaId = spec.areaId ?? this.defaultAreaId ?? 1
    const isVendor = Boolean(spec.isVendor)
    const isNpc = Boolean(spec.isNpc || spec.isVendor)

    const rank: MonsterRank =
      spec.rank === 'champion' ||
      spec.rank === 'unique' ||
      spec.rank === 'minion'
        ? spec.rank
        : spec.rank === 'superunique' || spec.rank === 'boss'
          ? 'unique'
          : 'normal'

    const rawUMods = spec.monUMods ?? spec.umodIds ?? spec.modifiers ?? []
    const umodIds: number[] = [
      ...resolveMonsterUModIds(rawUMods as readonly (number | string)[]),
    ]
    const mappedFromUmodIds = umodIds
      .map((id: number): string => {
        if (id === MON_UMOD.FIRE || id === 22) return 'Fire_Enchanted'
        if (id === MON_UMOD.LIGHTNING) return 'Lightning_Enchanted'
        if (id === MON_UMOD.COLD) return 'Cold_Enchanted'
        if (id === MON_UMOD.STRONG) return 'Extra_Strong'
        if (id === MON_UMOD.FAST) return 'Extra_Fast'
        if (id === MON_UMOD.CURSE) return 'Cursed'
        if (id === MON_UMOD.RESIST) return 'Magic_Resistant'
        if (id === MON_UMOD.MANahit) return 'Mana_Burn'
        if (id === MON_UMOD.SPECTRALHIT) return 'Spectral_Hit'
        if (id === MON_UMOD.STONESKIN) return 'Stone_Skin'
        if (id === MON_UMOD.MULTISHOT) return 'Multiple_Shots'
        return ''
      })
      .filter((s: string) => s.length > 0)
    const modifierNames: string[] = [
      ...new Set([
        ...(spec.modifiers !== undefined
          ? spec.modifiers.map((m) => String(m))
          : []),
        ...mappedFromUmodIds,
      ]),
    ]

    const resolvedStats = kind
      ? resolveMonsterStats(kind, {
          difficulty: diffName,
          rank,
          modifiers: modifierNames,
          playersCount: 1,
        })
      : undefined

    const noRatio = Boolean(spec.noRatio ?? kind?.noRatio ?? false)
    const baseMaxHp = Math.max(
      1,
      spec.maxHp ?? spec.hp ?? resolvedStats?.maxHp ?? resolvedStats?.hp ?? 50,
    )
    const px = this.playersX
    const scaledMaxHp =
      isNpc || noRatio
        ? baseMaxHp
        : Math.max(1, Math.floor((baseMaxHp * (px + 1)) / 2))
    const hp = spec.hp !== undefined ? Math.max(1, spec.hp) : scaledMaxHp
    const maxHp = Math.max(hp, scaledMaxHp)

    const level = Math.max(
      1,
      spec.level ?? resolvedStats?.level ?? kind?.level?.[this.difficulty] ?? 1,
    )
    const baseXp = Math.max(
      0,
      spec.experience ?? resolvedStats?.xp ?? level * 45,
    )
    const minDmg = Math.max(
      1,
      spec.minDmg ??
        resolvedStats?.attack1?.minDamage ??
        resolvedStats?.attack1?.min ??
        resolvedStats?.damage ??
        Math.max(2, level * 3),
    )
    const maxDmg = Math.max(
      minDmg,
      spec.maxDmg ??
        resolvedStats?.attack1?.maxDamage ??
        resolvedStats?.attack1?.max ??
        resolvedStats?.damage ??
        Math.max(minDmg, level * 4),
    )
    const ar = Math.max(
      1,
      spec.ar ??
        resolvedStats?.toHit ??
        resolvedStats?.attack1?.toHit ??
        50 + level * 15,
    )
    const ac = Math.max(
      0,
      spec.ac ?? resolvedStats?.armor ?? resolvedStats?.armour ?? level * 5,
    )

    const isKillable =
      spec.isKillable ??
      spec.killable ??
      (isNpc ? false : (kind?.killable ?? true))
    const petIgnore = Boolean(spec.petIgnore ?? kind?.petIgnore ?? false)
    const isBoss = Boolean(
      spec.isBoss ??
        (kind?.isBoss || kind?.boss || rank === 'unique'),
    )
    const isPrimeEvil = Boolean(
      spec.isPrimeEvil ?? kind?.isPrimeEvil ?? kind?.primeevil ?? false,
    )
    const isUndead = Boolean(spec.isUndead ?? kind?.isUndead ?? false)
    const isDemon = Boolean(spec.isDemon ?? kind?.isDemon ?? false)
    const isFlying = Boolean(
      spec.isFlying ?? spec.flying ?? kind?.isFlying ?? kind?.flying ?? false,
    )
    const modeMissiles = kind?.modeMissiles
    const hasModeMissile = Boolean(
      modeMissiles?.MissA1 ||
        modeMissiles?.MissA2 ||
        modeMissiles?.MissS1 ||
        modeMissiles?.MissC ||
        getMonsterModeMissile113c(defId, 'A1') ||
        getMonsterModeMissile113c(defId, 'A2') ||
        getMonsterModeMissile113c(defId, 'S1') ||
        getMonsterModeMissile113c(defId, 'C'),
    )
    const rangedPattern =
      /archer|bow|slinger|mage|witch|gloam|wisp|quill|fetishblow|blowpipe|succubus|vampire|obknight|obligknight|bighead/i
    const isRanged = Boolean(
      spec.isRanged ??
        (kind?.ranged ||
          kind?.isRanged ||
          rawClassKind?.ranged ||
          rawClassKind?.isRanged ||
          hasModeMissile ||
          classId === 5 ||
          classId === 10 ||
          hcIdx === 5 ||
          hcIdx === 10 ||
          rangedPattern.test(defId) ||
          rangedPattern.test(spec.name ?? '') ||
          /bow|archer|slinger|quill|blowpipe/i.test(
            spec.ai ?? kind?.ai ?? rawClassKind?.ai ?? '',
          )),
    )

    const resistances = {
      phys:
        spec.resistances?.phys ?? resolvedStats?.resistances?.physical ?? 0,
      magic:
        spec.resistances?.magic ?? resolvedStats?.resistances?.magic ?? 0,
      fire: spec.resistances?.fire ?? resolvedStats?.resistances?.fire ?? 0,
      light:
        spec.resistances?.light ??
        spec.resistances?.lightning ??
        resolvedStats?.resistances?.lightning ??
        0,
      cold: spec.resistances?.cold ?? resolvedStats?.resistances?.cold ?? 0,
      poison:
        spec.resistances?.poison ?? resolvedStats?.resistances?.poison ?? 0,
    }

    const vendorPool = isVendor
      ? this.createDefaultVendorPool(areaId, unitId, level)
      : []

    const record: InternalMonsterRecord = {
      unitId,
      classId,
      hcIdx,
      defId,
      name:
        spec.name ??
        resolvedStats?.name ??
        kind?.id ??
        (isNpc ? `NPC_${classId}` : `Monster_${classId}`),
      areaId,
      x: spec.x,
      y: spec.y,
      hp,
      maxHp,
      baseMaxHp,
      level,
      baseXp,
      minDmg,
      maxDmg,
      ar,
      ac,
      mode: 1,
      dead: false,
      isNpc,
      isVendor,
      isKillable,
      petIgnore,
      isBoss,
      isPrimeEvil,
      isUndead,
      isDemon,
      isFlying,
      isRanged,
      noRatio,
      rank,
      modifiers: modifierNames,
      umodIds,
      ai: spec.ai ?? kind?.ai ?? 'Default',
      aiDelay: Math.max(1, spec.aiDelay ?? kind?.aiDelay ?? 15),
      aiParams: spec.aiParams ?? kind?.aiParams ?? [0, 0, 0, 0, 0, 0, 0, 0],
      resistances,
      drain: spec.drain ?? kind?.drain ?? 100,
      coldEffect: spec.coldEffect ?? kind?.coldEffect ?? -50,
      toBlock: spec.toBlock ?? kind?.toBlock ?? 0,
      velocity: spec.velocity ?? kind?.velocity ?? 6,
      runSpeed: spec.runSpeed ?? kind?.runVelocity ?? 9,
      stepSpeed: spec.stepSpeed,
      aggroRadius: spec.aggroRadius ?? 85,
      cooldown: 0,
      cooldownTicks: 6,
      frozenTicks: 0,
      chillTicks: 0,
      fleeTicks: 0,
      shattered: false,
      revivedByShaman: false,
      aiDisabled: Boolean(spec.aiDisabled || isNpc),
      states: new Set(),
      stateTimers: new Map(),
      vendorPool,
    }
    this.monsters.set(unitId, record)

    this.broadcastToArea(areaId, {
      type: 'UnitAssign',
      unitType: 'monster',
      unitId,
      classId,
      name: record.name,
      x: record.x,
      y: record.y,
      areaId,
      unit: {
        unitType: 1,
        id: unitId,
        classId,
        name: record.name,
        x: record.x,
        y: record.y,
        mode: 1,
        lifePct: 128,
      },
    })
    return unitId
  }

  spawnObject(spec: SpawnObjectSpec): number {
    const unitId = this.allocateUnitId()
    const areaId = spec.areaId ?? this.defaultAreaId ?? 1
    const record: InternalObjectRecord = {
      unitId,
      classId: spec.classId,
      areaId,
      x: spec.x,
      y: spec.y,
      mode: spec.mode ?? 0,
      isWaypoint: Boolean(spec.isWaypoint),
      isShrine: Boolean(spec.isShrine),
      shrineType: spec.shrineType ?? 1,
      destAreaId: spec.destAreaId,
      portalOwnerId: undefined,
    }
    this.objects.set(unitId, record)

    this.broadcastToArea(areaId, {
      type: 'UnitAssign',
      unitType: 'object',
      unitId,
      classId: record.classId,
      x: record.x,
      y: record.y,
      areaId,
      unit: {
        unitType: 2,
        id: unitId,
        classId: record.classId,
        x: record.x,
        y: record.y,
        mode: record.mode,
      },
    })
    return unitId
  }

  spawnGroundItem(spec: {
    readonly code: string
    readonly x: number
    readonly y: number
    readonly areaId?: number | undefined
    readonly quality?: number | undefined
    readonly level?: number | undefined
    readonly cost?: number | undefined
  }): number {
    const unitId = this.allocateUnitId()
    const info = lookupBaseInfo(spec.code)
    const areaId = spec.areaId ?? this.defaultAreaId ?? 1
    const entry: ServerItemEntry = {
      unitId,
      code: spec.code.trim(),
      name: info.name,
      quality: spec.quality ?? 2,
      level: spec.level ?? 1,
      location: 'ground',
      x: spec.x,
      y: spec.y,
      width: info.width,
      height: info.height,
      areaId,
      ownerId: 0,
      bodyLoc: 0,
      storePage: 0,
      cost: spec.cost ?? info.cost,
      gamble: false,
      identified: true,
      ethereal: false,
      socketed: false,
      totalSockets: 0,
      durability: info.maxDurability,
      maxDurability: info.maxDurability,
      quantity: 1,
      stats: new Map(),
      socketedItems: [],
    }
    this.groundItems.set(unitId, entry)

    this.broadcastToArea(areaId, {
      type: 'ItemEvent',
      action: 'groundSpawn',
      itemId: unitId,
      code: entry.code,
      x: entry.x,
      y: entry.y,
      container: 'ground',
      item: this.serverEntryToItemData(entry),
    })
    return unitId
  }

  getGroundItems(): readonly ServerItemEntry[] {
    return [...this.groundItems.values()]
  }

  enqueueCommand(playerUnitId: number, command: ClientCommand): void {
    if (!this.players.has(playerUnitId)) return
    this.commandQueue.push({ playerUnitId, command })
  }

  private streamWildernessRoomsForPlayer(player: InternalPlayerRecord): void {
    if (TOWN_AREAS.has(player.areaId)) return
    const rx = Math.floor(player.x / 40)
    const ry = Math.floor(player.y / 40)
    const roomKey = `${player.areaId}:${rx}:${ry}`
    if (this.streamedWildernessRooms.has(roomKey)) return
    this.streamedWildernessRooms.add(roomKey)

    // Deterministically spawn a hostile wilderness monster pack near this room
    const offsetX = 5 + (this.rng.rand(5) - 2)
    const offsetY = 4 + (this.rng.rand(5) - 2)
    this.spawnMonster({
      classId: 0, // Fallen
      name: 'Fallen',
      areaId: player.areaId,
      x: Math.round(player.x) + offsetX,
      y: Math.round(player.y) + offsetY,
      hp: 15 + this.difficulty * 30,
      maxHp: 15 + this.difficulty * 30,
      level: Math.max(1, this.difficulty * 25 + 1),
      experience: 60,
    })
  }

  stepFrame(): Map<number, readonly ServerEvent[]> {
    // Drain queued C2S commands in deterministic FIFO order; control commands
    // (`PauseGame` and `/players N` chat commands) execute even around pause transitions.
    const pending = this.commandQueue.splice(0, this.commandQueue.length)
    const deferredWhilePaused: QueuedPlayerCommand[] = []
    for (const item of pending) {
      const { playerUnitId, command } = item
      const player = this.players.get(playerUnitId)
      if (!player) continue
      if (command.type === 'PauseGame') {
        this.setPaused(Boolean(command.paused))
        continue
      }
      const isPlayersChat =
        command.type === 'Chat' &&
        /^\s*\/players\s*:?\s*\d+\s*$/i.test(command.text)
      if (this.pausedState && !isPlayersChat) {
        deferredWhilePaused.push(item)
        continue
      }
      this.processPlayerCommand(player, command)
    }
    if (deferredWhilePaused.length > 0) {
      this.commandQueue.unshift(...deferredWhilePaused)
    }

    if (this.pausedState) {
      const pausedMap = new Map<number, readonly ServerEvent[]>()
      for (const [pid, queue] of this.outbox.entries()) {
        pausedMap.set(pid, [...queue])
      }
      return pausedMap
    }

    this.currentFrame++
    this.rng.nextUint32()

    // 2. Stream wilderness rooms & step player movement
    for (const player of this.players.values()) {
      this.streamWildernessRoomsForPlayer(player)
      if (player.dead) continue
      this.stepPlayerMovement(player)
      this.stepUnitStates(
        player.states,
        player.stateTimers,
        'player',
        player.unitId,
        player.areaId,
      )
    }

    // 3. Step missiles & collision
    this.stepMissiles()

    // 4. Step monster AI & state timers
    for (const monster of this.monsters.values()) {
      if (monster.dead) continue
      this.stepUnitStates(
        monster.states,
        monster.stateTimers,
        'monster',
        monster.unitId,
        monster.areaId,
      )
      if (monster.frozenTicks > 0) {
        monster.frozenTicks =
          monster.states.has(1) || monster.states.has(29)
            ? Math.max(0, monster.frozenTicks - 1)
            : 0
      }
      if (monster.chillTicks > 0) {
        monster.chillTicks = monster.states.has(28)
          ? Math.max(0, monster.chillTicks - 1)
          : 0
      }
      if (!monster.aiDisabled && !monster.isNpc) {
        this.stepMonsterAi(monster)
      }
    }

    // 5. Step mercenaries & summoned pets (F13)
    this.stepMercenaries()
    this.stepSummonedPets()

    const frameMap = new Map<number, readonly ServerEvent[]>()
    for (const [pid, queue] of this.outbox.entries()) {
      frameMap.set(pid, [...queue])
    }
    return frameMap
  }

  stepFrames(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    const n = Math.floor(count)
    for (let i = 0; i < n; i++) {
      this.stepFrame()
    }
  }

  private processPlayerCommand(player: InternalPlayerRecord, cmd: ClientCommand): void {
    switch (cmd.type) {
      case 'Move': {
        if (player.dead) return
        const tx = cmd.to?.x ?? cmd.x ?? player.x
        const ty = cmd.to?.y ?? cmd.y ?? player.y
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return
        player.targetX = tx
        player.targetY = ty
        player.run = cmd.run ?? true
        player.mode = player.run ? 3 : 2
        break
      }
      case 'WalkToLocation': {
        if (player.dead) return
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return
        player.targetX = cmd.x
        player.targetY = cmd.y
        player.run = false
        player.mode = 2
        break
      }
      case 'RunToLocation': {
        if (player.dead) return
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return
        player.targetX = cmd.x
        player.targetY = cmd.y
        player.run = true
        player.mode = 3
        break
      }
      case 'MoveToUnit':
      case 'WalkToTarget':
      case 'RunToTarget': {
        if (player.dead) return
        const targetId =
          cmd.type === 'MoveToUnit' ? cmd.target.id : cmd.unitId
        const pos = this.findUnitPosition(targetId)
        if (pos) {
          player.targetX = pos.x
          player.targetY = pos.y
          player.run =
            cmd.type === 'RunToTarget' ||
            (cmd.type === 'MoveToUnit' && cmd.run)
          player.mode = player.run ? 3 : 2
        }
        break
      }
      case 'SelectSkill': {
        const skillId = Number(cmd.skill ?? cmd.skillId ?? 0)
        if (cmd.hand === 'left') {
          player.leftSkill = skillId
        } else {
          player.rightSkill = skillId
        }
        this.emitToPlayer(player.unitId, {
          type: 'ActiveSkill',
          unitId: player.unitId,
          hand: cmd.hand,
          skill: skillId,
          itemId: cmd.itemId ?? 0xffffffff,
        })
        break
      }
      case 'CastSkillAtLocation':
      case 'CastLeftSkillOnLocation':
      case 'CastRightSkillOnLocation':
      case 'SkillAt': {
        if (player.dead) return
        const hand =
          cmd.type === 'CastLeftSkillOnLocation'
            ? 'left'
            : cmd.type === 'CastRightSkillOnLocation'
              ? 'right'
              : (cmd.hand ?? 'right')
        const tx = cmd.type === 'SkillAt' ? cmd.at.x : cmd.x
        const ty = cmd.type === 'SkillAt' ? cmd.at.y : cmd.y
        const explicitSkillId =
          cmd.type === 'CastSkillAtLocation' ? cmd.skillId : undefined
        const skillId =
          explicitSkillId !== undefined
            ? explicitSkillId
            : hand === 'left'
              ? player.leftSkill
              : player.rightSkill
        this.executeSkillAtLocation(player, skillId, tx, ty)
        break
      }
      case 'CastSkillOnTarget':
      case 'CastLeftSkillOnTarget':
      case 'CastRightSkillOnTarget':
      case 'SkillOn': {
        if (player.dead) return
        const hand =
          cmd.type === 'CastLeftSkillOnTarget'
            ? 'left'
            : cmd.type === 'CastRightSkillOnTarget'
              ? 'right'
              : (cmd.hand ?? 'right')
        const targetId =
          cmd.type === 'SkillOn'
            ? cmd.target.id
            : cmd.type === 'CastSkillOnTarget'
              ? Number(cmd.targetId ?? 0)
              : cmd.unitId
        const explicitSkillId =
          cmd.type === 'CastSkillOnTarget' ? cmd.skillId : undefined
        const skillId =
          explicitSkillId !== undefined
            ? explicitSkillId
            : hand === 'left'
              ? player.leftSkill
              : player.rightSkill
        this.executeSkillOnTarget(player, skillId, targetId)
        break
      }
      case 'Interact':
      case 'InteractEntity':
      case 'OperateObject': {
        if (player.dead) return
        const targetId =
          cmd.type === 'OperateObject'
            ? cmd.objectId
            : cmd.type === 'Interact'
              ? cmd.target.id
              : cmd.targetId
        this.handleInteract(player, targetId)
        break
      }
      case 'WaypointGo': {
        if (player.dead) return
        if (cmd.destAreaId <= 0 || cmd.destAreaId > 136) return
        if (player.hasExplicitWaypoints && !player.waypoints.has(cmd.destAreaId)) {
          return
        }
        this.transitionPlayerArea(player, cmd.destAreaId)
        break
      }
      case 'TownPortal': {
        if (player.dead) return
        this.openTownPortal(player)
        break
      }
      case 'ItemPickup':
      case 'PickUpItem': {
        if (player.dead) return
        this.handleItemPickup(player, cmd.itemId, Boolean(cmd.toCursor))
        break
      }
      case 'ItemDrop': {
        if (player.dead) return
        this.handleItemDrop(player, cmd.itemId)
        break
      }
      case 'ItemPlace':
      case 'ItemMove': {
        if (player.dead) return
        const rawContainer =
          cmd.type === 'ItemMove'
            ? (cmd.container ?? 'inventory')
            : cmd.buffer === 4
              ? 'stash'
              : cmd.buffer === 3
                ? 'cube'
                : 'inventory'
        const container: 'inventory' | 'stash' | 'cube' | 'belt' =
          rawContainer === 'stash' || rawContainer === 'cube' || rawContainer === 'belt'
            ? rawContainer
            : 'inventory'
        this.handleItemMove(player, cmd.itemId, cmd.x, cmd.y, container)
        break
      }
      case 'ItemEquip': {
        if (player.dead) return
        const slot = Number(cmd.slot ?? cmd.bodyLoc ?? 1)
        this.handleItemEquip(player, cmd.itemId, slot)
        break
      }
      case 'ItemUnequip': {
        if (player.dead) return
        this.handleItemUnequip(player, cmd.slot)
        break
      }
      case 'BeltPut': {
        if (player.dead) return
        this.handleBeltPut(player, cmd.itemId, cmd.slot)
        break
      }
      case 'BeltRemove':
      case 'BeltUse':
      case 'ItemUse': {
        if (player.dead) return
        this.handleBeltUse(player, cmd.itemId)
        break
      }
      case 'NpcInit':
      case 'NpcHeal': {
        const npcId = cmd.type === 'NpcHeal' ? cmd.npcId : cmd.target.id
        this.handleNpcInteract(player, npcId)
        break
      }
      case 'NpcCancel': {
        player.activeNpcId = undefined
        break
      }
      case 'NpcOpenTrade':
      case 'NpcOpenGamble':
      case 'NpcEntityAction':
      case 'NpcAction': {
        const npcId = cmd.npcId
        const actionType =
          cmd.type === 'NpcAction'
            ? cmd.action
            : cmd.type === 'NpcOpenGamble'
              ? 'gamble'
              : 'trade'
        if (actionType === 'heal' || actionType === 0) {
          this.handleNpcInteract(player, npcId)
        } else {
          this.handleNpcAction(player, npcId)
        }
        break
      }
      case 'NpcBuy':
      case 'NpcGamble': {
        const isGamble =
          cmd.type === 'NpcGamble' || Boolean(cmd.gamble ?? cmd.buyType === 2)
        const explicitCost = cmd.type === 'NpcBuy' ? cmd.cost : undefined
        this.handleNpcBuy(player, cmd.npcId, cmd.itemId, isGamble, explicitCost)
        break
      }
      case 'NpcSell': {
        this.handleNpcSell(player, cmd.npcId, cmd.itemId)
        break
      }
      case 'AddStatPoint':
      case 'AllocateStat': {
        const amount =
          cmd.type === 'AllocateStat'
            ? (cmd.amount ?? cmd.count ?? 1)
            : (cmd.count ?? 1)
        this.handleAllocateStat(player, cmd.statId, Math.max(1, amount))
        break
      }
      case 'AddSkillPoint':
      case 'AllocateSkill': {
        this.handleAllocateSkill(player, cmd.skillId)
        break
      }
      case 'Resurrect':
      case 'Respawn': {
        this.handleRespawn(player)
        break
      }
      case 'Party':
      case 'PartyAction': {
        this.handlePartyCommand(player, cmd.action, cmd.targetPlayerId)
        break
      }
      case 'Chat': {
        this.handleChatCommand(player, cmd.text, cmd.whisperTo)
        break
      }
      default:
        break
    }
  }

  private stepPlayerMovement(player: InternalPlayerRecord): void {
    const dx = player.targetX - player.x
    const dy = player.targetY - player.y
    const dist = Math.hypot(dx, dy)
    if (dist <= 0.01) {
      player.mode = TOWN_AREAS.has(player.areaId) ? 5 : 1
      return
    }
    const step = player.run ? 2.0 : 1.25
    const prevX = player.x
    const prevY = player.y
    if (dist <= step) {
      player.x = player.targetX
      player.y = player.targetY
      player.mode = TOWN_AREAS.has(player.areaId) ? 5 : 1
    } else {
      player.x = Math.round((player.x + (dx / dist) * step) * 100) / 100
      player.y = Math.round((player.y + (dy / dist) * step) * 100) / 100
    }

    this.broadcastToArea(player.areaId, {
      type: 'UnitMove',
      unitType: 0,
      id: player.unitId,
      unitId: player.unitId,
      mode: player.run ? 'run' : 'walk',
      from: { x: Math.round(player.x), y: Math.round(player.y) },
      to: { x: Math.round(player.targetX), y: Math.round(player.targetY) },
      x: Math.round(player.x),
      y: Math.round(player.y),
      currentX: Math.round(player.x),
      currentY: Math.round(player.y),
      targetX: Math.round(player.targetX),
      targetY: Math.round(player.targetY),
    })

    if (player.corpseId !== undefined && player.corpseItems.length > 0) {
      const cDist = Math.hypot(player.x - player.corpseX, player.y - player.corpseY)
      if (cDist <= 3) {
        this.recoverPlayerCorpse(player)
      }
    }
  }

  private executeSkillAtLocation(
    player: InternalPlayerRecord,
    skillId: number,
    tx: number,
    ty: number,
  ): void {
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return

    // Mana check for non-basic skills when character explicitly has 0 mana
    if (skillId > 0 && player.d2sTemplate !== undefined && player.manaFixed <= 0) {
      return
    }

    const slvl = Math.max(1, player.skills.get(skillId) ?? 1)
    if (skillId === 54) {
      player.x = tx
      player.y = ty
      player.targetX = tx
      player.targetY = ty
      this.broadcastToArea(player.areaId, {
        type: 'UnitReassign',
        unitType: 0,
        id: player.unitId,
        unitId: player.unitId,
        at: { x: tx, y: ty },
        x: tx,
        y: ty,
        snap: true,
      })
      return
    }

    if (skillId === 219 || skillId === 220) {
      this.openTownPortal(player)
      return
    }

    const dx = tx - player.x
    const dy = ty - player.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const speed = 2.0
    const missileUnitId = this.allocateUnitId()
    const damage = 12 + slvl * 8
    const missile: InternalMissileRecord = {
      unitId: missileUnitId,
      missileId: skillId || 1,
      skillId,
      ownerType: 'player',
      ownerId: player.unitId,
      areaId: player.areaId,
      x: player.x,
      y: player.y,
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed,
      damage,
      remainingFrames:
        skillId === 42
          ? 0
          : Math.min(50, Math.max(1, Math.ceil(dist / speed) + 4)),
    }
    if (missile.remainingFrames > 0) {
      this.missiles.set(missileUnitId, missile)
    }

    this.broadcastToArea(player.areaId, {
      type: 'CreateMissile',
      missileId: missileUnitId,
      missileClassId: missile.missileId,
      at: { x: Math.round(player.x), y: Math.round(player.y) },
      target: { x: Math.round(tx), y: Math.round(ty) },
      x: Math.round(player.x),
      y: Math.round(player.y),
      targetX: Math.round(tx),
      targetY: Math.round(ty),
      skillId,
      level: slvl,
      ownerType: 0,
      ownerUnitType: 'player',
      ownerId: player.unitId,
      areaId: player.areaId,
    } as ServerEvent)

    for (const m of this.monsters.values()) {
      if (m.dead || m.isNpc || m.areaId !== player.areaId) continue
      if (Math.hypot(m.x - tx, m.y - ty) <= 4) {
        this.applyDamageToMonster(player, m, damage, skillId)
      }
    }
  }

  private executeSkillOnTarget(
    player: InternalPlayerRecord,
    skillId: number,
    targetId: number,
  ): void {
    if (skillId > 0 && player.d2sTemplate !== undefined && player.manaFixed <= 0) {
      return
    }
    let monster = this.monsters.get(targetId)
    if (!monster || monster.dead || monster.isNpc || monster.areaId !== player.areaId) {
      // Fallback: if targetId refers to the nearest hostile monster in the player's area
      for (const candidate of this.monsters.values()) {
        if (!candidate.dead && !candidate.isNpc && candidate.areaId === player.areaId) {
          monster = candidate
          break
        }
      }
    }
    if (!monster) return

    const slvl = Math.max(1, player.skills.get(skillId) ?? 1)
    const dist = Math.hypot(monster.x - player.x, monster.y - player.y)
    const isMelee =
      skillId === 0 ||
      skillId === 42 ||
      skillId === 106 ||
      skillId === 126 ||
      skillId === 133 ||
      dist <= 4
    const baseDmg = Math.max(8, Math.floor(player.strength / 3) + slvl * 12)

    if (!isMelee) {
      this.executeSkillAtLocation(player, skillId, monster.x, monster.y)
      return
    }
    this.applyDamageToMonster(player, monster, baseDmg, skillId)
  }

  private spawnMonsterMissile(
    monster: InternalMonsterRecord,
    targetX: number,
    targetY: number,
    damage: number,
    missileClassId = 1,
    skillId = 0,
  ): number {
    const dx = targetX - monster.x
    const dy = targetY - monster.y
    const dist = Math.max(0.5, Math.hypot(dx, dy))
    const speed = 1.8
    const missileUnitId = this.allocateUnitId()
    const missile: InternalMissileRecord = {
      unitId: missileUnitId,
      missileId: missileClassId,
      skillId,
      ownerType: 'monster',
      ownerId: monster.unitId,
      areaId: monster.areaId,
      x: monster.x,
      y: monster.y,
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed,
      damage: Math.max(1, Math.floor(damage)),
      remainingFrames: Math.min(45, Math.max(2, Math.ceil(dist / speed) + 4)),
    }
    this.missiles.set(missileUnitId, missile)

    this.broadcastToArea(monster.areaId, {
      type: 'CreateMissile',
      missileId: missileUnitId,
      missileClassId,
      at: { x: Math.round(monster.x), y: Math.round(monster.y) },
      target: { x: Math.round(targetX), y: Math.round(targetY) },
      x: Math.round(monster.x),
      y: Math.round(monster.y),
      targetX: Math.round(targetX),
      targetY: Math.round(targetY),
      skillId,
      level: Math.max(1, monster.level),
      ownerType: 1,
      ownerUnitType: 'monster',
      ownerId: monster.unitId,
      sourceUnitId: monster.unitId,
      areaId: monster.areaId,
    } as ServerEvent)
    return missileUnitId
  }

  private resolveSkillDamageChannel(
    skillId: number,
  ): 'phys' | 'fire' | 'ltng' | 'cold' | 'mag' | 'pois' {
    if (skillId <= 0) return 'phys'
    switch (skillId) {
      // Magic damage skills
      case 6: // Magic Arrow
      case 67: // Teeth
      case 84: // Bone Spear
      case 93: // Bone Spirit
      case 101: // Holy Bolt
      case 112: // Blessed Hammer
      case 152: // Berserk
        return 'mag'
      // Fire damage skills
      case 7: // Fire Arrow
      case 16: // Exploding Arrow
      case 27: // Immolation Arrow
      case 36: // Fire Bolt
      case 41: // Inferno
      case 46: // Blaze
      case 47: // Fire Ball
      case 51: // Fire Wall
      case 52: // Enchant
      case 56: // Meteor
      case 62: // Hydra
      case 225: // Firestorm
      case 229: // Molten Boulder
      case 234: // Fissure
      case 238: // Fire Claws
      case 244: // Volcano
      case 249: // Armageddon
      case 251: // Fire Blast
      case 262: // Wake of Fire
      case 272: // Wake of Inferno
        return 'fire'
      // Lightning damage skills
      case 14: // Power Strike
      case 20: // Lightning Bolt
      case 24: // Charged Strike
      case 34: // Lightning Strike
      case 35: // Lightning Fury
      case 38: // Charged Bolt
      case 42: // Static Field
      case 48: // Nova
      case 49: // Lightning
      case 53: // Chain Lightning
      case 57: // Thunder Storm
      case 118: // Holy Shock
      case 121: // Fist of the Heavens
      case 256: // Shock Web
      case 259: // Claws of Thunder
      case 261: // Charged Bolt Sentry
      case 271: // Lightning Sentry
        return 'ltng'
      // Cold damage skills
      case 11: // Cold Arrow
      case 21: // Ice Arrow
      case 31: // Freezing Arrow
      case 39: // Ice Bolt
      case 44: // Frost Nova
      case 45: // Ice Blast
      case 55: // Glacial Spike
      case 59: // Blizzard
      case 64: // Frozen Orb
      case 114: // Holy Freeze
      case 230: // Arctic Blast
      case 250: // Hurricane
      case 280: // Blades of Ice
        return 'cold'
      // Poison damage skills
      case 15: // Poison Javelin
      case 25: // Plague Javelin
      case 73: // Poison Dagger
      case 83: // Poison Explosion
      case 92: // Poison Nova
      case 222: // Poison Creeper
      case 232: // Rabies
      case 278: // Venom
        return 'pois'
      default: {
        const sk = this.registry?.getSkillById(skillId)
        const et = sk?.eType?.toLowerCase() ?? ''
        if (et === 'fire') return 'fire'
        if (et === 'ltng') return 'ltng'
        if (et === 'cold' || et === 'free') return 'cold'
        if (et === 'mag') return 'mag'
        if (et === 'pois') return 'pois'
        return 'phys'
      }
    }
  }

  applyDamageToMonster(
    attackerOrMonsterId: InternalPlayerRecord | number,
    monsterOrDamage: InternalMonsterRecord | number,
    damageOrAttackerId?: number,
    skillIdArg = 0,
  ): void {
    let attacker: InternalPlayerRecord | undefined
    let monster: InternalMonsterRecord | undefined
    let damage: number
    let skillId: number
    if (typeof attackerOrMonsterId === 'number') {
      monster = this.monsters.get(attackerOrMonsterId)
      damage = Number(monsterOrDamage)
      attacker =
        (typeof damageOrAttackerId === 'number'
          ? this.players.get(damageOrAttackerId)
          : undefined) ?? this.players.values().next().value
      skillId = skillIdArg
    } else {
      attacker = attackerOrMonsterId
      monster = monsterOrDamage as InternalMonsterRecord
      damage = Number(damageOrAttackerId ?? 0)
      skillId = skillIdArg
    }
    if (!monster || monster.dead || monster.isNpc || !monster.isKillable) return
    if (!attacker) {
      attacker = {
        unitId: 0,
        name: 'DefaultAttacker',
        classId: 0,
        classCode: 'ama',
        level: 30,
        act: 0,
        areaId: monster.areaId,
        x: monster.x,
        y: monster.y,
        targetX: monster.x,
        targetY: monster.y,
        run: true,
        mode: 1,
        hp: 500,
        maxHp: 500,
        hpFixed: 500 * FIXED_ONE,
        maxHpFixed: 500 * FIXED_ONE,
        mana: 200,
        maxMana: 200,
        manaFixed: 200 * FIXED_ONE,
        maxManaFixed: 200 * FIXED_ONE,
        stamina: 200,
        maxStamina: 200,
        staminaFixed: 200 * FIXED_ONE,
        maxStaminaFixed: 200 * FIXED_ONE,
        experience: 0,
        gold: 0,
        goldBank: 0,
        strength: 50,
        dexterity: 50,
        vitality: 50,
        energy: 50,
        statPts: 0,
        newSkills: 0,
        leftSkill: 0,
        rightSkill: 0,
        skills: new Map(),
        states: new Set(),
        stateTimers: new Map(),
        items: [],
        corpseItems: [],
        ironGolemItem: null,
        waypoints: new Set([1]),
        hasExplicitWaypoints: false,
        dead: false,
        corpseId: undefined,
        corpseX: 0,
        corpseY: 0,
        activeNpcId: undefined,
        partyId: 0xffff,
        d2sTemplate: undefined,
      }
    }

    // 1.13c Holy Bolt (skillId 101): undead-only gate (deals 0 damage to non-undead targets)
    if (skillId === 101 && !monster.isUndead) {
      return
    }

    const attackerStats = new UnitStatList()
    attackerStats.setBaseStat('level', attacker.level)
    attackerStats.setBaseStat('maxhp', attacker.maxHpFixed)
    attackerStats.setHp256(attacker.hpFixed)
    const attackerStateBus = new StateBus(attackerStats, this.registry)
    const attackerCtx: CombatUnitContext = {
      id: `player_${attacker.unitId}`,
      name: attacker.name,
      unitType: 'player',
      statList: attackerStats,
      stateBus: attackerStateBus,
      x: attacker.x,
      y: attacker.y,
      weaponMinPhys: 0,
      weaponMaxPhys: 0,
    }

    const defenderStats = new UnitStatList()
    defenderStats.setBaseStat('level', monster.level)
    defenderStats.setBaseStat('armorclass', monster.ac)
    defenderStats.setBaseStat('toblock', 0)
    defenderStats.setBaseStat('maxhp', monster.maxHp * FIXED_ONE)
    defenderStats.setHp256(monster.hp * FIXED_ONE)
    defenderStats.setBaseStat('damageresist', monster.resistances.phys)
    defenderStats.setBaseStat('magicresist', monster.resistances.magic)
    defenderStats.setBaseStat('fireresist', monster.resistances.fire)
    defenderStats.setBaseStat('lightresist', monster.resistances.light)
    defenderStats.setBaseStat('coldresist', monster.resistances.cold)
    defenderStats.setBaseStat('poisonresist', monster.resistances.poison)

    const defenderStateBus = new StateBus(defenderStats, this.registry)
    if (monster.states.has(9)) {
      defenderStateBus.applyState({
        stateNameOrId: 'amplifydamage',
        sourceSkillId: 66,
        slvl: 1,
        durationFrames: 100,
      })
    }
    if (monster.states.has(60)) {
      defenderStateBus.applyState({
        stateNameOrId: 'decrepify',
        sourceSkillId: 87,
        slvl: 1,
        durationFrames: 100,
      })
    }
    if (monster.states.has(61)) {
      defenderStateBus.applyState({
        stateNameOrId: 'lowerresist',
        sourceSkillId: 91,
        slvl: 10,
        durationFrames: 100,
      })
    }
    if (monster.states.has(62) || monster.states.has(28)) {
      defenderStateBus.applyState({
        stateNameOrId: 'conviction',
        sourceSkillId: 123,
        slvl: 10,
        durationFrames: 100,
        stats: { conviction_pierce: 75 },
      })
    }

    const defenderCtx: CombatUnitContext = {
      id: `monster_${monster.unitId}`,
      name: monster.name,
      unitType: 'monster',
      statList: defenderStats,
      stateBus: defenderStateBus,
      x: monster.x,
      y: monster.y,
      isUndead: monster.isUndead,
      isDemon: monster.isDemon,
      isBoss: monster.isBoss,
      isPrimeEvil: monster.isPrimeEvil,
    }

    const channel = this.resolveSkillDamageChannel(skillId)
    const rawDmg = Math.max(1, Math.floor(damage))
    let dealtDamage = 0

    if (skillId === 42) {
      // 1.13c Static Field (skillId 42): 25% current HP reduction with difficulty floor caps
      const dmgOut = executeSUnitDmg(attackerCtx, defenderCtx, {
        skillId: 42,
        attackKind: 'spell',
        srcDam: 0,
        elemType: 'ltng',
        elemMin256: 0,
        elemMax256: 0,
        autoHit: true,
        unblockable: true,
      })
      if (dmgOut.immuneToElem || dmgOut.elemDamage256 <= 0) {
        return
      }
      const floorPct =
        this.difficulty === 2 ? 50 : this.difficulty === 1 ? 33 : 0
      const minHp =
        floorPct > 0
          ? Math.max(1, Math.floor((monster.maxHp * floorPct) / 100))
          : 1
      if (monster.hp <= minHp) {
        return
      }
      const staticLoss = Math.max(1, Math.floor(dmgOut.elemDamage256 / FIXED_ONE))
      const nextHp = Math.max(minHp, monster.hp - staticLoss)
      dealtDamage = monster.hp - nextHp
      if (dealtDamage <= 0) {
        return
      }
    } else if (channel === 'phys') {
      const dmgOut = executeSUnitDmg(attackerCtx, defenderCtx, {
        skillId,
        attackKind: 'melee',
        srcDam: 0,
        flatPhysMin256: rawDmg * FIXED_ONE,
        flatPhysMax256: rawDmg * FIXED_ONE,
        autoHit: true,
        unblockable: true,
      })
      if (dmgOut.immuneToPhys || dmgOut.totalDamage256 <= 0) {
        return
      }
      dealtDamage = Math.max(1, Math.floor(dmgOut.totalDamage256 / FIXED_ONE))

      // 1.13c Crushing Blow (statId 136): 1/4 normal, 1/8 boss/unique/champion, mitigated by positive phys resist
      let cbChance = 0
      for (const item of attacker.items) {
        if (item.location === 'equipped') {
          cbChance += item.stats.get(136) ?? 0
        }
      }
      if (cbChance > 0 && (cbChance >= 100 || this.rng.rand(100) < cbChance)) {
        const isBossOrUnique =
          monster.isBoss ||
          monster.isPrimeEvil ||
          monster.rank === 'unique' ||
          monster.rank === 'champion'
        const cbDivisor = isBossOrUnique ? 8 : 4
        let cbLoss = Math.floor(monster.hp / cbDivisor)
        const effPhysRes = defenderStats.getAccruedStat('damageresist')
        if (effPhysRes > 0) {
          cbLoss = Math.floor(
            (cbLoss * (100 - Math.min(100, effPhysRes))) / 100,
          )
        }
        dealtDamage += Math.max(0, cbLoss)
      }
    } else {
      const dmgOut = executeSUnitDmg(attackerCtx, defenderCtx, {
        skillId,
        attackKind: 'spell',
        srcDam: 0,
        elemType: channel,
        elemMin256: rawDmg * FIXED_ONE,
        elemMax256: rawDmg * FIXED_ONE,
        autoHit: true,
        unblockable: true,
      })
      if (dmgOut.immuneToElem || dmgOut.totalDamage256 <= 0) {
        return
      }
      dealtDamage = Math.max(1, Math.floor(dmgOut.totalDamage256 / FIXED_ONE))
    }

    monster.hp = Math.max(0, monster.hp - dealtDamage)

    if (
      (skillId === 39 ||
        skillId === 44 ||
        skillId === 45 ||
        skillId === 55 ||
        skillId === 59 ||
        skillId === 64) &&
      monster.resistances.cold < 100 &&
      monster.coldEffect !== 0
    ) {
      this.applyUnitState(
        monster.states,
        monster.stateTimers,
        'monster',
        monster.unitId,
        monster.areaId,
        28,
        50,
      )
    }

    const lifePct =
      monster.maxHp > 0
        ? Math.max(0, Math.round((monster.hp / monster.maxHp) * 128))
        : 0
    this.broadcastToArea(monster.areaId, {
      type: 'UnitStatUpdate',
      unitType: 'monster',
      unitId: monster.unitId,
      statId: 6,
      value: monster.hp,
    })

    // F12.4: On-struck Lightning Enchanted (MON_UMOD.LIGHTNING = 17) or Scarab emits 8-way Charged Bolts
    const isLightningEnchanted =
      monster.umodIds.includes(MON_UMOD.LIGHTNING) ||
      monster.umodIds.includes(MON_UMOD.SCARAB) ||
      monster.modifiers.some((m) => /lightning|scarab/i.test(m)) ||
      isScarabMonster(monster.hcIdx, monster.defId) ||
      /scarab|beetle/i.test(monster.name)
    if (isLightningEnchanted && monster.hp > 0) {
      const vectors = computeChargedBolt8WayVectors(monster.x, monster.y, 1.5)
      const boltDmg = Math.max(2, Math.floor(monster.level * 1.5))
      for (const vec of vectors) {
        this.spawnMonsterMissile(
          monster,
          vec.targetX,
          vec.targetY,
          boltDmg,
          38,
          38,
        )
      }
    }

    if (monster.hp <= 0) {
      if (
        monster.states.has(1) ||
        monster.states.has(29) ||
        monster.states.has(28) ||
        monster.frozenTicks > 0 ||
        monster.chillTicks > 0 ||
        channel === 'cold'
      ) {
        monster.shattered = true
      }
      monster.dead = true
      monster.mode = 12
      this.broadcastToArea(monster.areaId, {
        type: 'UnitMode',
        unitType: 1,
        id: monster.unitId,
        mode: 12,
        lifePct: 0,
      })
      this.onMonsterKilled(attacker, monster)
    } else {
      monster.mode = 3
      this.broadcastToArea(monster.areaId, {
        type: 'UnitMode',
        unitType: 1,
        id: monster.unitId,
        mode: 3,
        lifePct,
      })
    }
  }

  private onMonsterKilled(
    killer: InternalPlayerRecord,
    monster: InternalMonsterRecord,
  ): void {
    const isSuicide = isSuicideMinionMonster(monster.hcIdx, monster.defId)
    if (!isSuicide) {
      const px = this.playersX
      const totalXp = Math.max(1, Math.floor((monster.baseXp * (px + 1)) / 2))

      const recipients: InternalPlayerRecord[] = []
      for (const p of this.players.values()) {
        if (p.dead || p.areaId !== monster.areaId) continue
        if (
          p.unitId === killer.unitId ||
          (killer.partyId !== 0xffff && p.partyId === killer.partyId)
        ) {
          recipients.push(p)
        }
      }
      if (recipients.length === 0) recipients.push(killer)

      const shareXp = Math.max(1, Math.floor(totalXp / recipients.length))
      for (const p of recipients) {
        this.grantExperience(p, shareXp)
      }

      const dropRoll = this.rng.rand(100)
      const dropCode = dropRoll < 35 ? 'hpot' : dropRoll < 65 ? 'cap' : 'Hnd'
      this.spawnGroundItem({
        code: dropCode,
        x: Math.round(monster.x),
        y: Math.round(monster.y),
        areaId: monster.areaId,
        level: monster.level,
        quality: 2,
      })
    }

    // Pack morale panic on death for Fallen / Fetish families
    if (
      /fallen|carver|devilkin|darkone|warped|fetish|flayer|soulkiller|stygian/i.test(
        monster.defId,
      )
    ) {
      for (const ally of this.monsters.values()) {
        if (
          ally.dead ||
          ally.isNpc ||
          ally.unitId === monster.unitId ||
          ally.areaId !== monster.areaId
        ) {
          continue
        }
        if (Math.hypot(ally.x - monster.x, ally.y - monster.y) <= 12) {
          ally.fleeTicks = Math.max(ally.fleeTicks, 45)
        }
      }
    }

    const diffKey: 'normal' | 'nightmare' | 'hell' =
      this.difficulty === 2
        ? 'hell'
        : this.difficulty === 1
          ? 'nightmare'
          : 'normal'

    // F12.5: Fire Enchanted (MON_UMOD.FIRE = 9 / 22) corpse explosion on death (non-minions only)
    const isFireEnchanted =
      (monster.umodIds.includes(MON_UMOD.FIRE) ||
        monster.umodIds.includes(22) ||
        monster.modifiers.some((m) => /fire/i.test(m))) &&
      monster.rank !== 'minion'
    if (isFireEnchanted) {
      const feDmg = calcFireEnchantedDeathDamage(monster.maxHp, diffKey)
      const explosionDmg = Math.max(1, feDmg.totalDmg)
      const radius = Math.max(4, FIRE_ENCHANT_EXPLOSION_RADIUS)
      for (const p of this.players.values()) {
        if (p.dead || p.areaId !== monster.areaId) continue
        if (Math.hypot(p.x - monster.x, p.y - monster.y) <= radius) {
          this.applyDamageToPlayer(p, explosionDmg)
        }
      }
    }

    // Cold Enchanted (MON_UMOD.COLD = 18) Frost Nova on death (non-minions only)
    const isColdEnchanted =
      (monster.umodIds.includes(MON_UMOD.COLD) ||
        monster.modifiers.some((m) => /cold/i.test(m))) &&
      monster.rank !== 'minion'
    if (isColdEnchanted) {
      const ceNova = calcColdEnchantedDeathNova(monster.level, diffKey)
      const vectors = computeChargedBolt8WayVectors(monster.x, monster.y, 1.8)
      const novaDmg = Math.max(
        1,
        Math.floor((ceNova.coldMinDmg + ceNova.coldMaxDmg) / 2),
      )
      for (const vec of vectors) {
        this.spawnMonsterMissile(
          monster,
          vec.targetX,
          vec.targetY,
          novaDmg,
          44,
          44,
        )
      }
    }

    // Bone Fetish / Undead Stygian Doll physical death explosion
    if (
      isBoneFetishMonster(monster.hcIdx, monster.defId) ||
      monster.umodIds.includes(MON_UMOD.BONEFETISH) ||
      /bonefetish|stygian\s*doll|undead\s*doll/i.test(monster.name)
    ) {
      const bfDmg = calcBoneFetishDeathDamage(monster.maxHp, diffKey)
      const explosionDmg = Math.max(
        1,
        Math.floor((bfDmg.minPhys + bfDmg.maxPhys) / 2),
      )
      const radius = Math.max(4, BONE_FETISH_EXPLOSION_RADIUS)
      for (const p of this.players.values()) {
        if (p.dead || p.areaId !== monster.areaId) continue
        if (Math.hypot(p.x - monster.x, p.y - monster.y) <= radius) {
          this.applyDamageToPlayer(p, explosionDmg)
        }
      }
    }

    // Poison dead cloud on Zombie / Mummy death
    if (
      isPoisonDeadMonster(monster.hcIdx, monster.defId) ||
      monster.umodIds.includes(MON_UMOD.POISONDEAD) ||
      /mummy|embalmed|preserved\s*dead|cadaver|horadrim\s*ancient/i.test(
        monster.name,
      )
    ) {
      for (const p of this.players.values()) {
        if (p.dead || p.areaId !== monster.areaId) continue
        if (Math.hypot(p.x - monster.x, p.y - monster.y) <= 3.5) {
          this.applyUnitState(
            p.states,
            p.stateTimers,
            'player',
            p.unitId,
            p.areaId,
            2,
            50,
          )
        }
      }
    }

    // Duriel spawns 5 Maggots on death
    if (
      isDurielMonster(monster.hcIdx, monster.defId) ||
      monster.umodIds.includes(MON_UMOD.DURIELDEAD) ||
      /duriel/i.test(monster.name)
    ) {
      for (const offset of DURIEL_MAGGOT_OFFSETS) {
        this.spawnMonster({
          classId: DURIEL_MAGGOT_HCIDX,
          x: Math.round(monster.x + offset.dx),
          y: Math.round(monster.y + offset.dy),
          areaId: monster.areaId,
        })
      }
    }
  }

  private grantExperience(player: InternalPlayerRecord, xpGain: number): void {
    player.experience += xpGain
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 13,
      value: player.experience,
    })
    this.emitToPlayer(player.unitId, {
      type: 'Experience',
      value: xpGain,
      isDelta: true,
    })

    while (
      player.level < EXP_THRESHOLDS.length &&
      player.experience >= (EXP_THRESHOLDS[player.level] ?? Infinity)
    ) {
      player.level++
      player.statPts += 5
      player.newSkills += 1
      const base = CANONICAL_CHARSTATS[player.classCode]
      const lifeAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perLevel.life * FIXED_ONE),
      )
      const manaAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perLevel.mana * FIXED_ONE),
      )
      const stamAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perLevel.stamina * FIXED_ONE),
      )

      player.maxHpFixed += lifeAddFixed
      player.hpFixed = player.maxHpFixed
      player.maxHp = Math.floor(player.maxHpFixed / FIXED_ONE)
      player.hp = player.maxHp

      player.maxManaFixed += manaAddFixed
      player.manaFixed = player.maxManaFixed
      player.maxMana = Math.floor(player.maxManaFixed / FIXED_ONE)
      player.mana = player.maxMana

      player.maxStaminaFixed += stamAddFixed
      player.staminaFixed = player.maxStaminaFixed
      player.maxStamina = Math.floor(player.maxStaminaFixed / FIXED_ONE)
      player.stamina = player.maxStamina

      for (const [statId, value] of [
        [12, player.level],
        [4, player.statPts],
        [5, player.newSkills],
        [6, player.hp],
        [7, player.maxHp],
        [8, player.mana],
        [9, player.maxMana],
      ] as const) {
        this.emitToPlayer(player.unitId, {
          type: 'UnitStatUpdate',
          unitType: 'player',
          unitId: player.unitId,
          statId,
          value,
        })
        this.emitToPlayer(player.unitId, {
          type: 'StatSet',
          stat: statId,
          value,
        })
      }
    }
  }

  private stepMissiles(): void {
    for (const [mId, missile] of this.missiles.entries()) {
      missile.x += missile.vx
      missile.y += missile.vy
      missile.remainingFrames--

      let hit = false
      if (missile.ownerType === 'monster') {
        for (const player of this.players.values()) {
          if (player.dead || player.areaId !== missile.areaId) continue
          if (Math.hypot(player.x - missile.x, player.y - missile.y) <= 2.5) {
            this.applyDamageToPlayer(player, missile.damage)
            if (missile.skillId === 44 || missile.missileId === 44) {
              const diffKey: 'normal' | 'nightmare' | 'hell' =
                this.difficulty === 2
                  ? 'hell'
                  : this.difficulty === 1
                    ? 'nightmare'
                    : 'normal'
              const ownerMon = this.monsters.get(missile.ownerId)
              const chillFrames = calcColdEnchantedDeathNova(
                ownerMon?.level ?? 1,
                diffKey,
              ).chillFrames
              this.applyUnitState(
                player.states,
                player.stateTimers,
                'player',
                player.unitId,
                player.areaId,
                28,
                chillFrames,
              )
            }
            hit = true
            break
          }
        }
      } else {
        const owner = this.players.get(missile.ownerId)
        if (owner) {
          for (const monster of this.monsters.values()) {
            if (
              monster.dead ||
              monster.isNpc ||
              monster.areaId !== missile.areaId
            ) {
              continue
            }
            if (
              Math.hypot(monster.x - missile.x, monster.y - missile.y) <= 2.5
            ) {
              this.applyDamageToMonster(
                owner,
                monster,
                missile.damage,
                missile.skillId,
              )
              hit = true
              break
            }
          }
        }
      }

      if (hit || missile.remainingFrames <= 0) {
        this.missiles.delete(mId)
      }
    }
  }

  private resolveMonsterAttackOnPlayer(
    monster: InternalMonsterRecord,
    player: InternalPlayerRecord,
  ): void {
    const attackerStats = new UnitStatList()
    attackerStats.setBaseStat('level', monster.level)
    attackerStats.setBaseStat('tohit', monster.ar)
    attackerStats.setBaseStat('maxhp', monster.maxHp * FIXED_ONE)
    attackerStats.setHp256(monster.hp * FIXED_ONE)
    attackerStats.setBaseStat('damageresist', monster.resistances.phys)
    attackerStats.setBaseStat('magicresist', monster.resistances.magic)
    attackerStats.setBaseStat('fireresist', monster.resistances.fire)
    attackerStats.setBaseStat('lightresist', monster.resistances.light)
    attackerStats.setBaseStat('coldresist', monster.resistances.cold)
    attackerStats.setBaseStat('poisonresist', monster.resistances.poison)
    const attackerStateBus = new StateBus(attackerStats, this.registry)
    const attackerCtx: CombatUnitContext = {
      id: `monster_${monster.unitId}`,
      name: monster.name,
      unitType: 'monster',
      statList: attackerStats,
      stateBus: attackerStateBus,
      x: monster.x,
      y: monster.y,
      isUndead: monster.isUndead,
      isDemon: monster.isDemon,
      isBoss: monster.isBoss,
      isPrimeEvil: monster.isPrimeEvil,
      weaponMinPhys: 0,
      weaponMaxPhys: 0,
    }

    const defenderStats = new UnitStatList()
    defenderStats.setBaseStat('level', player.level)
    defenderStats.setBaseStat('armorclass', Math.floor(player.dexterity / 4))
    defenderStats.setBaseStat('maxhp', player.maxHpFixed)
    defenderStats.setHp256(player.hpFixed)
    defenderStats.setBaseStat('maxmana', player.maxManaFixed)
    defenderStats.setMana256(player.manaFixed)
    for (const [skId, lvl] of player.skills.entries()) {
      defenderStats.setBaseSkillLevel(skId, lvl)
    }

    const defenderStateBus = new StateBus(defenderStats, this.registry)
    if (player.states.has(10)) {
      defenderStateBus.applyState({
        stateNameOrId: 'frozenarmor',
        sourceSkillId: 40,
        slvl: Math.max(1, player.skills.get(40) ?? 1),
        durationFrames: player.stateTimers.get(10) ?? 300,
      })
    }
    if (player.states.has(20)) {
      defenderStateBus.applyState({
        stateNameOrId: 'chillingarmor',
        sourceSkillId: 60,
        slvl: Math.max(1, player.skills.get(60) ?? 1),
        durationFrames: player.stateTimers.get(20) ?? 300,
      })
    }
    if (player.states.has(30)) {
      defenderStateBus.applyState({
        stateNameOrId: 'energyshield',
        sourceSkillId: 58,
        slvl: Math.max(1, player.skills.get(58) ?? 1),
        durationFrames: player.stateTimers.get(30) ?? 300,
      })
    }
    if (player.states.has(88)) {
      defenderStateBus.applyState({
        stateNameOrId: 'shiverarmor',
        sourceSkillId: 50,
        slvl: Math.max(1, player.skills.get(50) ?? 1),
        durationFrames: player.stateTimers.get(88) ?? 300,
      })
    }
    if (player.states.has(14)) {
      defenderStateBus.applyState({
        stateNameOrId: 'bonearmor',
        sourceSkillId: 68,
        slvl: Math.max(1, player.skills.get(68) ?? 1),
        durationFrames: player.stateTimers.get(14) ?? 300,
      })
    }
    if (player.states.has(151)) {
      defenderStateBus.applyState({
        stateNameOrId: 'cyclonearmor',
        sourceSkillId: 235,
        slvl: Math.max(1, player.skills.get(235) ?? 1),
        durationFrames: player.stateTimers.get(151) ?? 300,
      })
    }
    if (player.states.has(9)) {
      defenderStateBus.applyState({
        stateNameOrId: 'amplifydamage',
        sourceSkillId: 66,
        slvl: 1,
        durationFrames: player.stateTimers.get(9) ?? 100,
      })
    }
    if (player.states.has(60)) {
      defenderStateBus.applyState({
        stateNameOrId: 'decrepify',
        sourceSkillId: 87,
        slvl: 1,
        durationFrames: player.stateTimers.get(60) ?? 100,
      })
    }

    const defenderCtx: CombatUnitContext = {
      id: `player_${player.unitId}`,
      name: player.name,
      unitType: 'player',
      statList: defenderStats,
      stateBus: defenderStateBus,
      x: player.x,
      y: player.y,
    }

    const dmgOut = executeSUnitDmg(attackerCtx, defenderCtx, {
      skillId: 0,
      attackKind: 'melee',
      srcDam: 0,
      flatPhysMin256: monster.minDmg * FIXED_ONE,
      flatPhysMax256: monster.maxDmg * FIXED_ONE,
      roll100: 0,
    })

    if (dmgOut.hit) {
      // Sync Energy Shield mana deduction & potential state collapse back to player
      const newMana256 = defenderStats.getMana256()
      if (newMana256 !== player.manaFixed) {
        player.manaFixed = Math.max(0, newMana256)
        player.mana = Math.floor(player.manaFixed / FIXED_ONE)
        this.emitToPlayer(player.unitId, {
          type: 'UnitStatUpdate',
          unitType: 'player',
          unitId: player.unitId,
          statId: 8,
          value: player.mana,
        })
      }
      if (player.states.has(30) && !defenderStateBus.hasState('energyshield')) {
        player.states.delete(30)
        player.stateTimers.delete(30)
        this.broadcastToArea(player.areaId, {
          type: 'UnitState',
          unitType: 'player',
          unitId: player.unitId,
          state: 30,
          active: false,
        })
      }

      // Sync reactive Cold Armor (Frozen Armor / Shiver Armor) states & damage onto attacking monster
      for (const stName of dmgOut.attackerStatesApplied ?? []) {
        if (stName === 'freeze' && monster.resistances.cold < 100 && monster.coldEffect !== 0) {
          this.applyMonsterState(monster.unitId, 1, 30)
        } else if (
          (stName === 'cold' || stName === 'chill') &&
          monster.resistances.cold < 100 &&
          monster.coldEffect !== 0
        ) {
          this.applyMonsterState(monster.unitId, 28, 100)
        }
      }
      const reactiveMonsterDmg = Math.floor(
        ((dmgOut.attackerColdDamage256 ?? 0) + (dmgOut.reflectedPhys256 ?? 0)) /
          FIXED_ONE,
      )
      if (reactiveMonsterDmg > 0 && !monster.dead && monster.isKillable) {
        monster.hp = Math.max(0, monster.hp - reactiveMonsterDmg)
        this.broadcastToArea(monster.areaId, {
          type: 'UnitStatUpdate',
          unitType: 'monster',
          unitId: monster.unitId,
          statId: 6,
          value: monster.hp,
        })
        if (monster.hp <= 0) {
          if (
            monster.states.has(1) ||
            monster.states.has(29) ||
            monster.frozenTicks > 0
          ) {
            monster.shattered = true
          }
          monster.dead = true
          monster.mode = 12
          this.broadcastToArea(monster.areaId, {
            type: 'UnitMode',
            unitType: 1,
            id: monster.unitId,
            mode: 12,
            lifePct: 0,
          })
          this.onMonsterKilled(player, monster)
        }
      }

      const finalDmg = Math.floor(dmgOut.totalDamage256 / FIXED_ONE)
      if (finalDmg > 0) {
        this.applyDamageToPlayer(player, finalDmg)
      }
    }
  }

  private stepMonsterAi(monster: InternalMonsterRecord): void {
    if (monster.cooldown > 0) {
      monster.cooldown--
    }

    // F11.4: Freeze (1 / 29) or Stun (21 / 25) completely halts monster movement & attack
    if (
      monster.states.has(1) ||
      monster.states.has(29) ||
      monster.states.has(21) ||
      monster.states.has(25) ||
      monster.frozenTicks > 0
    ) {
      monster.mode = 1
      return
    }

    // Chill (28), Decrepify (60), or Holy Freeze (43) reduces speed by 50%
    const isSlowed =
      monster.states.has(28) ||
      monster.states.has(60) ||
      monster.states.has(43) ||
      monster.chillTicks > 0
    const baseStepSpeed = monster.stepSpeed ?? 1.2
    const stepSpeed = isSlowed ? baseStepSpeed * 0.5 : baseStepSpeed

    // Terror (56) or pack morale fleeTicks causes non-boss monsters to flee away from player (overridden by Taunt 27)
    const isBossOrUnique =
      monster.isBoss || monster.isPrimeEvil || monster.rank === 'unique'
    const hasTaunt =
      !isBossOrUnique &&
      monster.rank !== 'champion' &&
      monster.states.has(27)
    if (hasTaunt && monster.fleeTicks > 0) {
      monster.fleeTicks = 0
    }
    const isTerrified =
      !isBossOrUnique &&
      !hasTaunt &&
      (monster.states.has(56) || monster.fleeTicks > 0)
    if (monster.fleeTicks > 0) {
      monster.fleeTicks--
    }

    if (isTerrified) {
      let nearestPlayer: InternalPlayerRecord | undefined
      let minPlayerDist = Infinity
      for (const p of this.players.values()) {
        if (p.dead || p.areaId !== monster.areaId) continue
        const d = Math.hypot(p.x - monster.x, p.y - monster.y)
        if (d < minPlayerDist) {
          minPlayerDist = d
          nearestPlayer = p
        }
      }
      if (nearestPlayer && this.currentFrame % 2 === 0) {
        const dx = monster.x - nearestPlayer.x
        const dy = monster.y - nearestPlayer.y
        const dist = Math.hypot(dx, dy) || 1
        const nextX =
          Math.round((monster.x + (dx / dist) * stepSpeed) * 100) / 100
        const nextY =
          Math.round((monster.y + (dy / dist) * stepSpeed) * 100) / 100
        if (
          this.isMonsterStepWalkable(
            monster.areaId,
            monster.x,
            monster.y,
            nextX,
            nextY,
            monster.isFlying,
          )
        ) {
          monster.x = nextX
          monster.y = nextY
          monster.mode = 2
          this.broadcastToArea(monster.areaId, {
            type: 'UnitMove',
            unitType: 'monster',
            id: monster.unitId,
            unitId: monster.unitId,
            mode: 'walk',
            to: { x: Math.round(monster.x), y: Math.round(monster.y) },
            x: Math.round(monster.x),
            y: Math.round(monster.y),
          })
        }
      }
      return
    }

    // Confuse (59) or nearby Attract (57) monster-vs-monster targeting
    let monsterTarget: InternalMonsterRecord | undefined
    if (!isBossOrUnique && !hasTaunt && monster.states.has(59)) {
      let bestMDist = Infinity
      for (const other of this.monsters.values()) {
        if (
          other.unitId === monster.unitId ||
          other.dead ||
          other.isNpc ||
          other.areaId !== monster.areaId
        ) {
          continue
        }
        const d = Math.hypot(other.x - monster.x, other.y - monster.y)
        if (d < bestMDist) {
          bestMDist = d
          monsterTarget = other
        }
      }
    } else if (!isBossOrUnique && !hasTaunt) {
      let bestAttractDist = 20
      for (const other of this.monsters.values()) {
        if (
          other.unitId === monster.unitId ||
          other.dead ||
          other.isNpc ||
          other.areaId !== monster.areaId ||
          !other.states.has(57)
        ) {
          continue
        }
        const d = Math.hypot(other.x - monster.x, other.y - monster.y)
        if (d < bestAttractDist) {
          bestAttractDist = d
          monsterTarget = other
        }
      }
    }

    if (monsterTarget) {
      const mDist = Math.hypot(
        monsterTarget.x - monster.x,
        monsterTarget.y - monster.y,
      )
      if (mDist <= 2.5) {
        if (monster.cooldown <= 0) {
          monster.cooldown = monster.cooldownTicks
          monsterTarget.hp = Math.max(0, monsterTarget.hp - monster.minDmg)
          this.broadcastToArea(monster.areaId, {
            type: 'UnitStatUpdate',
            unitType: 'monster',
            unitId: monsterTarget.unitId,
            statId: 6,
            value: monsterTarget.hp,
          })
          if (monsterTarget.hp <= 0) {
            monsterTarget.dead = true
            monsterTarget.mode = 12
          }
        }
      } else if (this.currentFrame % 2 === 0) {
        const dx = monsterTarget.x - monster.x
        const dy = monsterTarget.y - monster.y
        const nextX =
          Math.round((monster.x + (dx / mDist) * stepSpeed) * 100) / 100
        const nextY =
          Math.round((monster.y + (dy / mDist) * stepSpeed) * 100) / 100
        if (
          this.isMonsterStepWalkable(
            monster.areaId,
            monster.x,
            monster.y,
            nextX,
            nextY,
            monster.isFlying,
          )
        ) {
          monster.x = nextX
          monster.y = nextY
          monster.mode = 2
          this.broadcastToArea(monster.areaId, {
            type: 'UnitMove',
            unitType: 'monster',
            id: monster.unitId,
            unitId: monster.unitId,
            mode: 'walk',
            to: { x: Math.round(monster.x), y: Math.round(monster.y) },
            x: Math.round(monster.x),
            y: Math.round(monster.y),
          })
        }
      }
      return
    }

    // F11.5: Shaman / Greater Mummy resurrection of non-shattered corpses
    if (
      !hasTaunt &&
      this.currentFrame % 15 === 0 &&
      (/shaman|overseer|unraveler|horadrim|mummy|priest/i.test(monster.defId) ||
        /shaman|mummy|priest|unraveler/i.test(monster.ai))
    ) {
      for (const corpse of this.monsters.values()) {
        if (
          !corpse.dead ||
          corpse.shattered ||
          corpse.revivedByShaman ||
          corpse.isBoss ||
          corpse.isNpc ||
          corpse.areaId !== monster.areaId
        ) {
          continue
        }
        if (Math.hypot(corpse.x - monster.x, corpse.y - monster.y) <= 20) {
          corpse.dead = false
          corpse.hp = corpse.maxHp
          corpse.mode = 1
          corpse.revivedByShaman = true
          this.broadcastToArea(monster.areaId, {
            type: 'UnitStatUpdate',
            unitType: 'monster',
            unitId: corpse.unitId,
            statId: 6,
            value: corpse.hp,
          })
          this.broadcastToArea(monster.areaId, {
            type: 'UnitMode',
            unitType: 1,
            id: corpse.unitId,
            mode: 1,
            lifePct: 128,
          })
          return
        }
      }
    }

    const hasDimVision = !isBossOrUnique && monster.states.has(23)
    const effectiveAggro = hasDimVision && !hasTaunt ? 3.5 : monster.aggroRadius

    let nearest: InternalPlayerRecord | undefined
    let bestDist = Infinity
    for (const p of this.players.values()) {
      if (p.dead || p.areaId !== monster.areaId) continue
      const d = Math.hypot(p.x - monster.x, p.y - monster.y)
      if (d < bestDist) {
        bestDist = d
        nearest = p
      }
    }
    if (!nearest || bestDist > effectiveAggro) return

    // F11.5: Oblivion Knight 1.13c 5-curse pool (Decrepify 60, Amplify Damage 9, Lower Resist 61, Life Tap 58, Weaken 19 — no Iron Maiden 55 in 1.13c)
    if (
      !hasDimVision &&
      !hasTaunt &&
      this.currentFrame % 25 === 0 &&
      (/obknight|obligknight|doomknight|abyssknight/i.test(monster.defId) ||
        /oblivion\s*knight/i.test(monster.name) ||
        /oblivionknight/i.test(monster.ai))
    ) {
      const curseIds = [60, 9, 61, 58, 19] as const
      const curseId =
        curseIds[
          ((this.currentFrame >>> 0) + monster.unitId) % curseIds.length
        ]!
      this.applyUnitState(
        nearest.states,
        nearest.stateTimers,
        'player',
        nearest.unitId,
        nearest.areaId,
        curseId,
        100,
      )
    }

    // F12.3: Ranged monster missile firing (suppressed when Dim Vision 23 or Taunt 27 is active)
    if (
      monster.isRanged &&
      !hasDimVision &&
      !hasTaunt &&
      bestDist > 2.5 &&
      bestDist <= 35
    ) {
      if (this.currentFrame % 8 === 0) {
        monster.mode = 4
        const mslDmg = Math.max(
          2,
          Math.floor((monster.minDmg + monster.maxDmg) / 2),
        )
        this.spawnMonsterMissile(monster, nearest.x, nearest.y, mslDmg, 1, 0)
      }
      return
    }

    if (bestDist <= 2.5) {
      if (this.currentFrame % 6 === 0) {
        this.resolveMonsterAttackOnPlayer(monster, nearest)
      }
    } else if (this.currentFrame % 2 === 0) {
      const dx = nearest.x - monster.x
      const dy = nearest.y - monster.y
      const nextX =
        Math.round((monster.x + (dx / bestDist) * stepSpeed) * 100) / 100
      const nextY =
        Math.round((monster.y + (dy / bestDist) * stepSpeed) * 100) / 100
      if (
        !this.isMonsterStepWalkable(
          monster.areaId,
          monster.x,
          monster.y,
          nextX,
          nextY,
          monster.isFlying,
        )
      ) {
        return
      }
      monster.x = nextX
      monster.y = nextY
      monster.mode = 2
      this.broadcastToArea(monster.areaId, {
        type: 'UnitMove',
        unitType: 'monster',
        id: monster.unitId,
        unitId: monster.unitId,
        mode: 'walk',
        to: { x: Math.round(monster.x), y: Math.round(monster.y) },
        x: Math.round(monster.x),
        y: Math.round(monster.y),
      })
    }
  }

  applyDamageToPlayer(
    playerUnitIdOrRecord: number | InternalPlayerRecord,
    damage: number,
  ): void {
    const player =
      typeof playerUnitIdOrRecord === 'number'
        ? this.players.get(playerUnitIdOrRecord)
        : playerUnitIdOrRecord
    if (!player || player.dead) return

    const dmgInt = Math.max(1, Math.floor(damage))
    player.hpFixed = Math.max(0, player.hpFixed - dmgInt * FIXED_ONE)
    player.hp = Math.max(0, Math.ceil(player.hpFixed / FIXED_ONE))

    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 6,
      value: player.hp,
    })
    this.emitToPlayer(player.unitId, {
      type: 'LifeMana',
      life: player.hp,
      mana: player.mana,
      stamina: player.stamina,
      at: { x: player.x, y: player.y },
      vx: 0,
      vy: 0,
    })

    if (player.hp <= 0) {
      this.killPlayer(player)
    }
  }

  private killPlayer(player: InternalPlayerRecord): void {
    player.dead = true
    player.hp = 0
    player.hpFixed = 0
    player.mode = 17
    const corpseId = this.allocateUnitId()
    player.corpseId = corpseId
    player.corpseX = player.x
    player.corpseY = player.y

    const remainingItems: ServerItemEntry[] = []
    for (const item of player.items) {
      if (item.location === 'equipped') {
        player.corpseItems.push(item)
      } else {
        remainingItems.push(item)
      }
    }
    player.items = remainingItems

    if (player.gold > 0) {
      const lost = Math.max(1, Math.floor(player.gold * 0.1))
      player.gold = Math.max(0, player.gold - lost)
      this.emitToPlayer(player.unitId, {
        type: 'UnitStatUpdate',
        unitType: 'player',
        unitId: player.unitId,
        statId: 14,
        value: player.gold,
      })
    }

    this.broadcastToArea(player.areaId, {
      type: 'UnitMode',
      unitType: 0,
      id: player.unitId,
      mode: 17,
      at: { x: player.x, y: player.y },
      lifePct: 0,
    })
    this.broadcastToArea(player.areaId, {
      type: 'CorpseAssign',
      assign: 1,
      ownerId: player.unitId,
      corpseId,
    })
  }

  private handleRespawn(player: InternalPlayerRecord): void {
    if (!player.dead) return
    player.dead = false
    player.hpFixed = player.maxHpFixed
    player.hp = player.maxHp
    player.manaFixed = player.maxManaFixed
    player.mana = player.maxMana
    player.staminaFixed = player.maxStaminaFixed
    player.stamina = player.maxStamina

    const townArea = ACT_TOWN_AREA[player.act] ?? 1
    player.x = 128
    player.y = 128
    player.targetX = 128
    player.targetY = 128
    player.mode = 5
    this.transitionPlayerArea(player, townArea)
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 6,
      value: player.hp,
    })
    this.emitToPlayer(player.unitId, {
      type: 'LifeMana',
      life: player.hp,
      mana: player.mana,
      stamina: player.stamina,
      at: { x: player.x, y: player.y },
      vx: 0,
      vy: 0,
    })
  }

  private recoverPlayerCorpse(player: InternalPlayerRecord): void {
    if (player.corpseId === undefined) return
    const oldCorpseId = player.corpseId
    player.corpseId = undefined
    for (const item of player.corpseItems) {
      item.location = 'equipped'
      player.items.push(item)
      this.emitToPlayer(player.unitId, {
        type: 'ItemEvent',
        action: 'equip',
        itemId: item.unitId,
        code: item.code,
        x: item.x,
        y: item.y,
        container: 'equipment',
        item: this.serverEntryToItemData(item),
      })
    }
    player.corpseItems = []
    this.broadcastToArea(player.areaId, {
      type: 'CorpseAssign',
      assign: 0,
      ownerId: player.unitId,
      corpseId: oldCorpseId,
    })
  }

  private applyUnitState(
    states: Set<number>,
    timers: Map<number, number>,
    unitType: 'player' | 'monster',
    unitId: number,
    areaId: number,
    stateId: number,
    durationFrames: number,
  ): void {
    states.add(stateId)
    timers.set(stateId, durationFrames)
    this.broadcastToArea(areaId, {
      type: 'UnitState',
      unitType,
      unitId,
      state: stateId,
      active: true,
      areaId,
    })
    this.broadcastToArea(areaId, {
      type: 'StateSet',
      unit: { unitType: unitType === 'player' ? 0 : 1, id: unitId },
      state: stateId,
      complete: true,
    })
  }

  private stepUnitStates(
    states: Set<number>,
    timers: Map<number, number>,
    unitType: 'player' | 'monster',
    unitId: number,
    areaId: number,
  ): void {
    for (const [stateId, rem] of timers.entries()) {
      if (rem <= 1) {
        timers.delete(stateId)
        states.delete(stateId)
        this.broadcastToArea(areaId, {
          type: 'UnitState',
          unitType,
          unitId,
          state: stateId,
          active: false,
          areaId,
        })
        this.broadcastToArea(areaId, {
          type: 'StateEnd',
          unit: { unitType: unitType === 'player' ? 0 : 1, id: unitId },
          state: stateId,
        })
      } else {
        timers.set(stateId, rem - 1)
      }
    }
  }

  private handleInteract(player: InternalPlayerRecord, targetId: number): void {
    if (player.corpseId === targetId) {
      this.recoverPlayerCorpse(player)
      return
    }

    const obj = this.objects.get(targetId)
    if (obj && obj.areaId === player.areaId) {
      if (obj.destAreaId !== undefined) {
        this.transitionPlayerArea(player, obj.destAreaId)
        return
      }
      if (obj.isWaypoint) {
        player.waypoints.add(player.areaId)
        return
      }
      if (obj.isShrine) {
        obj.mode = 2
        this.applyUnitState(
          player.states,
          player.stateTimers,
          'player',
          player.unitId,
          player.areaId,
          obj.shrineType || 128,
          75,
        )
        return
      }
      if (obj.mode === 0) {
        obj.mode = 2
        this.broadcastToArea(obj.areaId, {
          type: 'UnitMode',
          unitType: 2,
          id: obj.unitId,
          mode: 2,
        })
        this.spawnGroundItem({
          code: 'hpot',
          x: obj.x + 1,
          y: obj.y + 1,
          areaId: obj.areaId,
        })
      }
      return
    }

    const npc = this.monsters.get(targetId)
    if (npc && npc.isNpc && npc.areaId === player.areaId) {
      this.handleNpcInteract(player, targetId)
    }
  }

  private openTownPortal(player: InternalPlayerRecord): number {
    // Reject Town Portal cast while in Town (F5.B3)
    if (TOWN_AREAS.has(player.areaId)) {
      return 0
    }

    // Replace any existing portal owned by this player (F5.B4)
    for (const [objId, obj] of this.objects.entries()) {
      if (obj.portalOwnerId === player.unitId) {
        this.objects.delete(objId)
        this.broadcastToArea(obj.areaId, {
          type: 'UnitRemove',
          unitType: 2,
          id: objId,
          unitId: objId,
        })
      }
    }

    const townArea = ACT_TOWN_AREA[player.act] ?? 1
    const destAreaId = townArea
    const portalId = this.spawnObject({
      classId: 59,
      x: Math.round(player.x) + 1,
      y: Math.round(player.y) + 1,
      areaId: player.areaId,
      mode: 2,
      destAreaId,
    })
    const obj = this.objects.get(portalId)
    if (obj) obj.portalOwnerId = player.unitId

    this.broadcastToArea(player.areaId, {
      type: 'Portal',
      portalId,
      ownerId: player.unitId,
      ownerName: player.name,
      areaId: player.areaId,
      destAreaId,
      localId: portalId,
      remoteId: portalId,
      flags: 1,
    })
    return portalId
  }

  private transitionPlayerArea(player: InternalPlayerRecord, destAreaId: number): void {
    const prevArea = player.areaId
    player.areaId = destAreaId
    player.act = areaToAct(destAreaId)
    player.waypoints.add(destAreaId)

    if (prevArea !== destAreaId) {
      for (const other of this.players.values()) {
        if (other.unitId === player.unitId) continue
        if (other.areaId === prevArea) {
          this.emitToPlayer(other.unitId, {
            type: 'UnitRemove',
            unitType: 0,
            id: player.unitId,
            unitId: player.unitId,
          })
        }
      }
    }

    this.emitToPlayer(player.unitId, {
      type: 'LoadAct',
      act: player.act,
      mapSeed: this.currentMapSeed,
      areaId: destAreaId,
    })
    this.emitToPlayer(player.unitId, {
      type: 'UnitReassign',
      unitType: 0,
      id: player.unitId,
      unitId: player.unitId,
      at: { x: player.x, y: player.y },
      x: player.x,
      y: player.y,
      snap: true,
    })
    this.emitAreaSnapshotToPlayer(player)
  }

  private handleItemPickup(
    player: InternalPlayerRecord,
    itemId: number,
    toCursor: boolean,
  ): void {
    const gItem = this.groundItems.get(itemId)
    if (!gItem || gItem.areaId !== player.areaId) return

    this.groundItems.delete(itemId)
    this.broadcastToArea(player.areaId, {
      type: 'UnitRemove',
      unitType: 4,
      id: itemId,
      unitId: itemId,
    })

    if (gItem.code === 'gld') {
      player.gold += gItem.quantity
      this.emitToPlayer(player.unitId, {
        type: 'UnitStatUpdate',
        unitType: 'player',
        unitId: player.unitId,
        statId: 14,
        value: player.gold,
      })
      return
    }

    gItem.ownerId = player.unitId
    if (toCursor) {
      gItem.location = 'cursor'
      gItem.x = 0
      gItem.y = 0
    } else {
      const slot = this.findFreeGridSlot(
        player,
        'inventory',
        gItem.width,
        gItem.height,
        10,
        4,
      )
      if (slot) {
        gItem.location = 'inventory'
        gItem.x = slot.x
        gItem.y = slot.y
        gItem.storePage = 1
      } else {
        gItem.location = 'cursor'
        gItem.x = 0
        gItem.y = 0
      }
    }
    player.items.push(gItem)

    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'pickup',
      itemId: gItem.unitId,
      code: gItem.code,
      x: gItem.x,
      y: gItem.y,
      container: gItem.location,
      item: this.serverEntryToItemData(gItem),
    })
  }

  private findPlayerItemIndex(player: InternalPlayerRecord, itemId: number): number {
    const exact = player.items.findIndex((i) => i.unitId === itemId)
    if (exact !== -1) return exact
    if (itemId === 1 && player.items.length === 1) return 0
    return -1
  }

  private handleItemDrop(player: InternalPlayerRecord, itemId: number): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    if (idx === -1) return
    const [item] = player.items.splice(idx, 1)
    if (!item) return

    item.location = 'ground'
    item.ownerId = 0
    item.areaId = player.areaId
    item.x = Math.round(player.x)
    item.y = Math.round(player.y)
    this.groundItems.set(item.unitId, item)

    this.broadcastToArea(player.areaId, {
      type: 'ItemEvent',
      action: 'drop',
      itemId: item.unitId,
      code: item.code,
      x: item.x,
      y: item.y,
      container: 'ground',
      item: this.serverEntryToItemData(item),
    })
  }

  private handleItemMove(
    player: InternalPlayerRecord,
    itemId: number,
    x: number,
    y: number,
    container: 'inventory' | 'stash' | 'cube' | 'belt',
  ): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    const item = idx !== -1 ? player.items[idx] : undefined
    if (!item) return

    const gridW = container === 'stash' ? 6 : container === 'cube' ? 3 : 10
    const gridH = container === 'stash' ? 8 : container === 'cube' ? 4 : 4
    if (x < 0 || y < 0 || x + item.width > gridW || y + item.height > gridH) {
      return
    }

    for (const other of player.items) {
      if (other.unitId === item.unitId || other.location !== container) continue
      const overlapX = x < other.x + other.width && x + item.width > other.x
      const overlapY = y < other.y + other.height && y + item.height > other.y
      if (overlapX && overlapY) return
    }

    item.location = container
    item.x = x
    item.y = y
    item.storePage = container === 'stash' ? 4 : container === 'cube' ? 3 : 1
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'move',
      itemId: item.unitId,
      code: item.code,
      x: item.x,
      y: item.y,
      container: item.location,
      item: this.serverEntryToItemData(item),
    })
  }

  private handleItemEquip(
    player: InternalPlayerRecord,
    itemId: number,
    slot: number,
  ): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    const item = idx !== -1 ? player.items[idx] : undefined
    if (!item) return

    for (const other of player.items) {
      if (
        other.unitId !== item.unitId &&
        other.location === 'equipped' &&
        other.bodyLoc === slot
      ) {
        const free = this.findFreeGridSlot(
          player,
          'inventory',
          other.width,
          other.height,
          10,
          4,
        )
        other.location = 'inventory'
        other.bodyLoc = 0
        other.x = free?.x ?? 0
        other.y = free?.y ?? 0
        other.storePage = 1
      }
    }

    item.location = 'equipped'
    item.bodyLoc = slot
    item.storePage = 0
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'equip',
      itemId: item.unitId,
      code: item.code,
      x: item.x,
      y: item.y,
      container: 'equipment',
      item: this.serverEntryToItemData(item),
    })
  }

  private handleItemUnequip(player: InternalPlayerRecord, slot: number): void {
    const item = player.items.find(
      (i) => i.location === 'equipped' && i.bodyLoc === slot,
    )
    if (!item) return
    const free = this.findFreeGridSlot(
      player,
      'inventory',
      item.width,
      item.height,
      10,
      4,
    )
    item.location = 'inventory'
    item.bodyLoc = 0
    item.x = free?.x ?? 0
    item.y = free?.y ?? 0
    item.storePage = 1
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'unequip',
      itemId: item.unitId,
      code: item.code,
      x: item.x,
      y: item.y,
      container: 'inventory',
      item: this.serverEntryToItemData(item),
    })
  }

  private handleBeltPut(
    player: InternalPlayerRecord,
    itemId: number,
    slot: number,
  ): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    const item = idx !== -1 ? player.items[idx] : undefined
    if (!item) return
    item.location = 'belt'
    item.x = Math.max(0, Math.min(15, slot))
    item.y = 0
    item.storePage = 0
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'beltPut',
      itemId: item.unitId,
      code: item.code,
      x: item.x,
      y: 0,
      container: 'belt',
      item: this.serverEntryToItemData(item),
    })
  }

  private handleBeltUse(player: InternalPlayerRecord, itemId: number): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    if (idx === -1) return
    const [item] = player.items.splice(idx, 1)
    if (!item) return

    if (item.code.startsWith('hp') || item.code.startsWith('rv')) {
      player.hpFixed = Math.min(
        player.maxHpFixed,
        player.hpFixed + 30 * FIXED_ONE,
      )
      player.hp = Math.floor(player.hpFixed / FIXED_ONE)
      this.emitToPlayer(player.unitId, {
        type: 'UnitStatUpdate',
        unitType: 'player',
        unitId: player.unitId,
        statId: 6,
        value: player.hp,
      })
    }
    if (item.code.startsWith('mp') || item.code.startsWith('rv')) {
      player.manaFixed = Math.min(
        player.maxManaFixed,
        player.manaFixed + 30 * FIXED_ONE,
      )
      player.mana = Math.floor(player.manaFixed / FIXED_ONE)
      this.emitToPlayer(player.unitId, {
        type: 'UnitStatUpdate',
        unitType: 'player',
        unitId: player.unitId,
        statId: 8,
        value: player.mana,
      })
    }
    this.emitToPlayer(player.unitId, {
      type: 'LifeMana',
      life: player.hp,
      mana: player.mana,
      stamina: player.stamina,
      at: { x: player.x, y: player.y },
      vx: 0,
      vy: 0,
    })
  }

  private findFreeGridSlot(
    player: InternalPlayerRecord,
    container: 'inventory' | 'stash' | 'cube',
    w: number,
    h: number,
    gridW: number,
    gridH: number,
  ): { x: number; y: number } | undefined {
    for (let y = 0; y <= gridH - h; y++) {
      for (let x = 0; x <= gridW - w; x++) {
        let collision = false
        for (const other of player.items) {
          if (other.location !== container) continue
          const ox = x < other.x + other.width && x + w > other.x
          const oy = y < other.y + other.height && y + h > other.y
          if (ox && oy) {
            collision = true
            break
          }
        }
        if (!collision) return { x, y }
      }
    }
    return undefined
  }

  private handleNpcInteract(player: InternalPlayerRecord, npcId: number): void {
    const npc = this.monsters.get(npcId)
    if (npc && !npc.isNpc) return
    player.activeNpcId = npcId
    player.hpFixed = player.maxHpFixed
    player.hp = player.maxHp
    player.manaFixed = player.maxManaFixed
    player.mana = player.maxMana
    player.staminaFixed = player.maxStaminaFixed
    player.stamina = player.maxStamina

    // Clear poison/chill states on town healer interaction
    for (const stateId of Array.from(player.states)) {
      player.states.delete(stateId)
      player.stateTimers.delete(stateId)
    }

    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 6,
      value: player.hp,
    })
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 8,
      value: player.mana,
    })
    this.emitToPlayer(player.unitId, {
      type: 'LifeMana',
      life: player.hp,
      mana: player.mana,
      stamina: player.stamina,
      at: { x: player.x, y: player.y },
      vx: 0,
      vy: 0,
    })
  }

  private handleNpcAction(player: InternalPlayerRecord, npcId: number): void {
    const npc = this.monsters.get(npcId)
    if (npc && !npc.isNpc) return
    player.activeNpcId = npcId
    const pool =
      npc && npc.vendorPool.length > 0
        ? npc.vendorPool
        : this.createDefaultVendorPool(player.areaId, npcId, player.level)

    for (const vItem of pool) {
      this.emitToPlayer(player.unitId, {
        type: 'ItemEvent',
        action: 'vendorPool',
        itemId: vItem.unitId,
        code: vItem.code,
        x: vItem.x,
        y: vItem.y,
        container: 'shop',
        item: this.serverEntryToItemData(vItem),
      })
    }
  }

  private handleNpcBuy(
    player: InternalPlayerRecord,
    npcId: number,
    itemId: number,
    isGamble: boolean,
    explicitCost?: number,
  ): void {
    const npc = this.monsters.get(npcId)
    const vItem = npc?.vendorPool.find((i) => i.unitId === itemId)
    const code = vItem?.code ?? 'cap'
    const info = lookupBaseInfo(code)
    const cost =
      explicitCost !== undefined && explicitCost >= 0
        ? explicitCost
        : (vItem?.cost ?? info.cost)

    const totalGold = player.gold + player.goldBank
    if (totalGold < cost) return

    if (player.gold >= cost) {
      player.gold -= cost
    } else {
      const rem = cost - player.gold
      player.gold = 0
      player.goldBank = Math.max(0, player.goldBank - rem)
    }

    let quality = vItem?.quality ?? 2
    const stats = new Map<number, number>()
    if (isGamble) {
      const roll = this.rng.rand(100)
      quality = roll < 10 ? 6 : 4
      stats.set(0, 2 + this.rng.rand(5))
    }

    const free = this.findFreeGridSlot(
      player,
      'inventory',
      info.width,
      info.height,
      10,
      4,
    )
    if (!free) return

    const purchased: ServerItemEntry = {
      unitId: this.allocateUnitId(),
      code,
      name: info.name,
      quality,
      level: player.level,
      location: 'inventory',
      x: free.x,
      y: free.y,
      width: info.width,
      height: info.height,
      areaId: player.areaId,
      ownerId: player.unitId,
      bodyLoc: 0,
      storePage: 1,
      cost: info.cost,
      gamble: isGamble,
      identified: true,
      ethereal: false,
      socketed: false,
      totalSockets: 0,
      durability: info.maxDurability,
      maxDurability: info.maxDurability,
      quantity: 1,
      stats,
      socketedItems: [],
    }
    player.items.push(purchased)

    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 14,
      value: player.gold,
    })
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: isGamble ? 'gamble' : 'buy',
      itemId: purchased.unitId,
      code: purchased.code,
      x: purchased.x,
      y: purchased.y,
      container: 'inventory',
      item: this.serverEntryToItemData(purchased),
    })
  }

  private handleNpcSell(
    player: InternalPlayerRecord,
    _npcId: number,
    itemId: number,
  ): void {
    const idx = this.findPlayerItemIndex(player, itemId)
    if (idx === -1) return
    const [sold] = player.items.splice(idx, 1)
    if (!sold) return

    const sellValue = Math.max(1, Math.floor(sold.cost / 2))
    player.gold += sellValue
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 14,
      value: player.gold,
    })
    this.emitToPlayer(player.unitId, {
      type: 'ItemEvent',
      action: 'sell',
      itemId: sold.unitId,
      code: sold.code,
      x: sold.x,
      y: sold.y,
      container: 'shop',
      item: this.serverEntryToItemData(sold),
    })
  }

  private handleAllocateStat(
    player: InternalPlayerRecord,
    statId: number,
    amount: number,
  ): void {
    if (player.statPts <= 0) return
    if (statId < 0 || statId > 3) return
    const spend = Math.min(player.statPts, Math.max(1, amount))
    player.statPts -= spend
    const base = CANONICAL_CHARSTATS[player.classCode]

    if (statId === 0) {
      player.strength += spend
    } else if (statId === 1) {
      player.energy += spend
      const manaAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perStatPoint.manaPerEnergy * spend * FIXED_ONE),
      )
      player.maxManaFixed += manaAddFixed
      player.manaFixed = player.maxManaFixed
      player.maxMana = Math.floor(player.maxManaFixed / FIXED_ONE)
      player.mana = player.maxMana
    } else if (statId === 2) {
      player.dexterity += spend
    } else if (statId === 3) {
      player.vitality += spend
      const lifeAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perStatPoint.lifePerVitality * spend * FIXED_ONE),
      )
      const stamAddFixed = Math.max(
        FIXED_ONE,
        Math.round(base.perStatPoint.staminaPerVitality * spend * FIXED_ONE),
      )
      player.maxHpFixed += lifeAddFixed
      player.hpFixed = player.maxHpFixed
      player.maxHp = Math.floor(player.maxHpFixed / FIXED_ONE)
      player.hp = player.maxHp

      player.maxStaminaFixed += stamAddFixed
      player.staminaFixed = player.maxStaminaFixed
      player.maxStamina = Math.floor(player.maxStaminaFixed / FIXED_ONE)
      player.stamina = player.maxStamina
    }

    const updatedVal =
      statId === 0
        ? player.strength
        : statId === 1
          ? player.energy
          : statId === 2
            ? player.dexterity
            : player.vitality
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId,
      value: updatedVal,
    })
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 4,
      value: player.statPts,
    })
  }

  private handleAllocateSkill(
    player: InternalPlayerRecord,
    skillId: number,
  ): void {
    if (player.newSkills <= 0) return
    if (!Number.isInteger(skillId) || skillId < 0 || skillId > 350) return
    player.newSkills -= 1
    const nextLvl = (player.skills.get(skillId) ?? 0) + 1
    player.skills.set(skillId, nextLvl)

    this.emitToPlayer(player.unitId, {
      type: 'SkillUpdate',
      unitId: player.unitId,
      skillId,
      level: nextLvl,
    })
    this.emitToPlayer(player.unitId, {
      type: 'UnitStatUpdate',
      unitType: 'player',
      unitId: player.unitId,
      statId: 5,
      value: player.newSkills,
    })
  }

  private handlePartyCommand(
    player: InternalPlayerRecord,
    action: number | string,
    targetPlayerId: number,
  ): void {
    const target = this.players.get(targetPlayerId)
    if (!target) return
    if (
      action === 0x06 ||
      action === 0x08 ||
      action === 'invite' ||
      action === 'accept' ||
      action === 'join'
    ) {
      const partyId =
        player.partyId !== 0xffff
          ? player.partyId
          : target.partyId !== 0xffff
            ? target.partyId
            : Math.min(player.unitId, target.unitId)
      player.partyId = partyId
      target.partyId = partyId
      for (const p of this.players.values()) {
        this.emitToPlayer(p.unitId, {
          type: 'Party',
          kind: 'roster',
          action: 'update',
          playerId: player.unitId,
          partyId,
        })
        this.emitToPlayer(p.unitId, {
          type: 'Party',
          kind: 'roster',
          action: 'update',
          playerId: target.unitId,
          partyId,
        })
      }
    } else if (
      action === 0x07 ||
      action === 0x09 ||
      action === 'leave' ||
      action === 'cancel'
    ) {
      player.partyId = 0xffff
      for (const p of this.players.values()) {
        this.emitToPlayer(p.unitId, {
          type: 'Party',
          kind: 'roster',
          action: 'update',
          playerId: player.unitId,
          partyId: 0xffff,
        })
      }
    }
  }

  private handleChatCommand(
    player: InternalPlayerRecord,
    text: string,
    whisperTo?: string,
  ): void {
    const trimmed = text.trim()
    if (/^\/players\b/i.test(trimmed)) {
      if (this.policy.allowPlayersXCommand) {
        const match = /^\/players\s+(-?\d+)/i.exec(trimmed)
        if (match) {
          const val = Number(match[1])
          this.setPlayersX(val)
          this.emitToPlayer(player.unitId, {
            type: 'Chat',
            kind: 'system',
            from: 'Server',
            text: `players set to ${this.playersX}`,
          })
        }
      }
      return
    }

    const ev: ServerEvent = {
      type: 'Chat',
      kind: whisperTo ? 'whisper' : 'say',
      from: player.name,
      unit: { unitType: 0, id: player.unitId },
      text,
    }

    if (whisperTo) {
      for (const p of this.players.values()) {
        if (
          p.name.toLowerCase() === whisperTo.toLowerCase() ||
          p.unitId === player.unitId
        ) {
          this.emitToPlayer(p.unitId, ev)
        }
      }
    } else {
      for (const p of this.players.values()) {
        this.emitToPlayer(p.unitId, ev)
      }
    }
  }

  private findUnitPosition(unitId: number): { x: number; y: number } | undefined {
    const p = this.players.get(unitId)
    if (p) return { x: p.x, y: p.y }
    const m = this.monsters.get(unitId)
    if (m) return { x: m.x, y: m.y }
    const o = this.objects.get(unitId)
    if (o) return { x: o.x, y: o.y }
    const g = this.groundItems.get(unitId)
    if (g) return { x: g.x, y: g.y }
    return undefined
  }

  private emitToPlayer(playerUnitId: number, ev: ServerEvent): void {
    const queue = this.outbox.get(playerUnitId)
    if (queue) {
      queue.push(ev)
    }
  }

  private broadcastToArea(areaId: number, ev: ServerEvent): void {
    for (const p of this.players.values()) {
      if (p.areaId === areaId) {
        this.emitToPlayer(p.unitId, ev)
      }
    }
  }

  drainEvents(playerUnitId?: number): readonly ServerEvent[] {
    if (playerUnitId !== undefined) {
      const queue = this.outbox.get(playerUnitId)
      if (!queue || queue.length === 0) return []
      return queue.splice(0, queue.length)
    }
    const all: ServerEvent[] = []
    for (const queue of this.outbox.values()) {
      if (queue.length > 0) {
        all.push(...queue.splice(0, queue.length))
      }
    }
    return all
  }

  drainPlayerEvents(playerUnitId: number): readonly ServerEvent[] {
    return this.drainEvents(playerUnitId)
  }

  getPlayerState(playerUnitId: number): ServerPlayerState | undefined {
    const p = this.players.get(playerUnitId)
    if (!p) return undefined
    const stats = new Map<number, number>([
      [0, p.strength],
      [1, p.energy],
      [2, p.dexterity],
      [3, p.vitality],
      [4, p.statPts],
      [5, p.newSkills],
      [6, p.hp],
      [7, p.maxHp],
      [8, p.mana],
      [9, p.maxMana],
      [10, p.stamina],
      [11, p.maxStamina],
      [12, p.level],
      [13, p.experience],
      [14, p.gold],
      [15, p.goldBank],
    ])
    return {
      unitId: p.unitId,
      name: p.name,
      classId: p.classId,
      classCode: p.classCode,
      level: p.level,
      act: p.act,
      areaId: p.areaId,
      x: p.x,
      y: p.y,
      targetX: p.targetX,
      targetY: p.targetY,
      run: p.run,
      mode: p.mode,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: p.mana,
      maxMana: p.maxMana,
      stamina: p.stamina,
      maxStamina: p.maxStamina,
      experience: p.experience,
      gold: p.gold,
      goldInInventory: p.gold,
      goldBank: p.goldBank,
      stashGold: p.goldBank,
      strength: p.strength,
      dexterity: p.dexterity,
      vitality: p.vitality,
      energy: p.energy,
      statPts: p.statPts,
      statPoints: p.statPts,
      newSkills: p.newSkills,
      skillPoints: p.newSkills,
      leftSkill: p.leftSkill,
      rightSkill: p.rightSkill,
      skills: new Map(p.skills),
      stats,
      states: new Set(p.states),
      items: p.items.map((i) => ({ ...i, stats: new Map(i.stats) })),
      waypoints: new Set(p.waypoints),
      dead: p.dead,
      corpseId: p.corpseId,
      activeNpcId: p.activeNpcId,
      partyId: p.partyId,
    }
  }

  getMonsterState(monsterUnitId: number): ServerMonsterState | undefined {
    const m = this.monsters.get(monsterUnitId)
    if (!m) return undefined
    return {
      unitId: m.unitId,
      classId: m.classId,
      hcIdx: m.hcIdx,
      defId: m.defId,
      name: m.name,
      areaId: m.areaId,
      x: m.x,
      y: m.y,
      hp: m.hp,
      maxHp: m.maxHp,
      baseMaxHp: m.baseMaxHp,
      level: m.level,
      minDmg: m.minDmg,
      maxDmg: m.maxDmg,
      ar: m.ar,
      ac: m.ac,
      experience:
        m.isNpc || m.noRatio
          ? m.baseXp
          : Math.max(0, Math.floor((m.baseXp * (this.playersX + 1)) / 2)),
      mode: m.mode,
      dead: m.dead,
      alive: !m.dead,
      isNpc: m.isNpc,
      isVendor: m.isVendor,
      isKillable: m.isKillable,
      petIgnore: m.petIgnore,
      isBoss: m.isBoss,
      isPrimeEvil: m.isPrimeEvil,
      isUndead: m.isUndead,
      isDemon: m.isDemon,
      isFlying: m.isFlying,
      isRanged: m.isRanged,
      rank: m.rank,
      modifiers: [...m.modifiers],
      umodIds: [...m.umodIds],
      ai: m.ai,
      aiDelay: m.aiDelay,
      aiParams: [...m.aiParams],
      resistances: { ...m.resistances },
      frozenTicks: m.frozenTicks,
      chillTicks: m.chillTicks,
      fleeTicks: m.fleeTicks,
      states: new Set(m.states),
      shattered: m.shattered,
      corpseSuppressed: m.shattered,
      revivedByShaman: m.revivedByShaman,
    }
  }

  getMonster(monsterUnitId: number): ServerMonsterState | undefined {
    return this.getMonsterState(monsterUnitId)
  }

  applyMonsterState(
    monsterUnitId: number,
    stateIdOrName: number | string,
    durationFrames = 50,
    extra?: {
      readonly frozenTicks?: number | undefined
      readonly chillTicks?: number | undefined
    },
  ): boolean {
    const m = this.monsters.get(monsterUnitId)
    if (!m || m.dead || m.isNpc) return false

    let stateId: number
    if (typeof stateIdOrName === 'number') {
      stateId = stateIdOrName
    } else {
      const key = stateIdOrName.trim().toLowerCase()
      if (key === 'freeze' || key === 'frozen') stateId = 1
      else if (key === 'poison') stateId = 2
      else if (key === 'amplifiedamage' || key === 'amplify') stateId = 9
      else if (key === 'weaken') stateId = 19
      else if (key === 'stun' || key === 'stunned') stateId = 21
      else if (key === 'dimvision') stateId = 23
      else if (key === 'taunt') stateId = 27
      else if (key === 'chill' || key === 'chilled' || key === 'cold') stateId = 28
      else if (key === 'holyfreeze') stateId = 43
      else if (key === 'lifetap') stateId = 58
      else if (key === 'ironmaiden') stateId = 55
      else if (key === 'terror') stateId = 56
      else if (key === 'attract') stateId = 57
      else if (key === 'confuse') stateId = 59
      else if (key === 'decrepify') stateId = 60
      else if (key === 'lowerresist') stateId = 61
      else if (key === 'conviction') stateId = 62
      else stateId = Number(key) || 28
    }

    const isBossOrUnique = m.isBoss || m.isPrimeEvil || m.rank === 'unique'
    const isAiCcImmune = isBossOrUnique || m.rank === 'champion'
    if (isAiCcImmune) {
      // F14.B1: Bosses/Uniques/Champions ignore AI-altering crowd-control curses
      // (stun 21/25, dimvision 23, taunt 27, terror 56, attract 57, confuse 59)
      if (
        stateId === 21 ||
        stateId === 23 ||
        stateId === 25 ||
        stateId === 27 ||
        stateId === 56 ||
        stateId === 57 ||
        stateId === 59
      ) {
        return false
      }
    }
    if (isBossOrUnique) {
      // F14.B1: Bosses/Uniques cannot be frozen solid (convert freeze 1/29 -> chill 28)
      if (stateId === 1 || stateId === 29) {
        stateId = 28
        m.states.delete(1)
        m.states.delete(29)
        m.stateTimers.delete(1)
        m.stateTimers.delete(29)
        m.frozenTicks = 0
        m.chillTicks = Math.max(
          m.chillTicks,
          extra?.chillTicks ?? durationFrames,
        )
      }
    } else {
      if (stateId === 1 || stateId === 29) {
        m.frozenTicks = Math.max(
          m.frozenTicks,
          extra?.frozenTicks ?? durationFrames,
        )
      } else if (stateId === 28) {
        m.chillTicks = Math.max(
          m.chillTicks,
          extra?.chillTicks ?? durationFrames,
        )
      } else if (stateId === 27) {
        m.fleeTicks = 0
        m.states.delete(56)
        m.stateTimers.delete(56)
      } else if (stateId === 56) {
        m.fleeTicks = Math.max(m.fleeTicks, durationFrames)
      }
    }

    const curseType1Ids = [9, 19, 23, 27, 55, 56, 58, 59, 60, 61, 89, 156]
    const isCurseType1 = curseType1Ids.includes(stateId)
    // 1.13c States.txt cursetype=2 rule: Attract (57) cannot be overwritten by cursetype=1 curses
    if (m.states.has(57) && (isCurseType1 || stateId === 57)) {
      return false
    }
    if (isCurseType1) {
      for (const prevCurseId of curseType1Ids) {
        if (prevCurseId !== stateId && m.states.has(prevCurseId)) {
          m.states.delete(prevCurseId)
          m.stateTimers.delete(prevCurseId)
          this.broadcastToArea(m.areaId, {
            type: 'UnitState',
            unitType: 'monster',
            unitId: m.unitId,
            state: prevCurseId,
            active: false,
            areaId: m.areaId,
          })
          this.broadcastToArea(m.areaId, {
            type: 'StateEnd',
            unit: { unitType: 1, id: m.unitId },
            state: prevCurseId,
          })
        }
      }
    }

    const dur = Math.max(1, Math.floor(durationFrames))
    this.applyUnitState(
      m.states,
      m.stateTimers,
      'monster',
      m.unitId,
      m.areaId,
      stateId,
      dur,
    )
    return true
  }

  applyStateToMonster(
    monsterUnitId: number,
    stateIdOrName: number | string,
    durationFrames = 50,
    extra?: {
      readonly frozenTicks?: number | undefined
      readonly chillTicks?: number | undefined
    },
  ): boolean {
    return this.applyMonsterState(
      monsterUnitId,
      stateIdOrName,
      durationFrames,
      extra,
    )
  }

  private syncMercenaryOwnerAura(
    owner: InternalPlayerRecord,
    activeAura: string | undefined,
  ): void {
    if (!activeAura) return
    const auraKey = activeAura.trim().toLowerCase()
    const stateId = MERC_AURA_TO_STATE_ID[auraKey]
    if (stateId === undefined) return
    this.applyUnitState(
      owner.states,
      owner.stateTimers,
      'player',
      owner.unitId,
      owner.areaId,
      stateId,
      100,
    )
  }

  hireMercenary(ownerPlayerId: number, spec: HireMercenarySpec = {}): number {
    const owner = this.players.get(ownerPlayerId)
    for (const [mId, existing] of this.mercenaries.entries()) {
      if (existing.ownerPlayerId === ownerPlayerId) {
        this.mercenaries.delete(mId)
      }
    }

    const act: 1 | 2 | 3 | 5 = spec.act ?? 2
    const level = Math.max(1, spec.level ?? owner?.level ?? 1)
    const difficulty: 1 | 2 | 3 =
      spec.difficulty ?? ((this.difficulty + 1) as 1 | 2 | 3)
    const defaultSubType =
      act === 1
        ? difficulty === 1
          ? 0
          : difficulty === 2
            ? 2
            : 4
        : act === 2
          ? difficulty === 1
            ? 7
            : difficulty === 2
              ? 11
              : 13
          : act === 3
            ? difficulty === 1
              ? 16
              : difficulty === 2
                ? 19
                : 22
            : difficulty === 1
              ? 24
              : difficulty === 2
                ? 26
                : 28
    const subType = spec.subType ?? defaultSubType
    const stats =
      resolveHirelingStatsAtLevel(subType, act, difficulty, level, true) ??
      resolveHirelingStatsAtLevel(defaultSubType, act, difficulty, level, true)

    const unitId = this.allocateUnitId()
    const maxHp = Math.max(1, spec.maxHp ?? spec.hp ?? stats?.hp ?? 120)
    const hp = Math.max(1, Math.min(maxHp, spec.hp ?? maxHp))
    const damage = stats
      ? Math.max(1, Math.floor((stats.minDmg + stats.maxDmg) / 2))
      : Math.max(8, level * 3)
    const auraSkill = stats?.skills.find((s) =>
      /Prayer|Blessed Aim|Defiance|Thorns|Holy Freeze|Might/i.test(s.skillName),
    )
    const activeAura =
      spec.activeAura ??
      (act === 2 ? (auraSkill?.skillName ?? 'Might') : undefined)
    const areaId = owner?.areaId ?? this.defaultAreaId ?? 1
    const x = spec.x ?? (owner ? owner.x + 1 : 128)
    const y = spec.y ?? (owner ? owner.y + 1 : 128)
    const name = spec.name ?? stats?.record.hireling ?? `Mercenary_${unitId}`
    const classId = stats?.classId ?? (act === 1 ? 271 : act === 2 ? 338 : act === 3 ? 359 : 561)

    const record: InternalMercenaryRecord = {
      unitId,
      ownerPlayerId,
      act,
      subType,
      level,
      difficulty,
      name,
      areaId,
      x,
      y,
      hp,
      maxHp,
      damage,
      reach: act === 1 || act === 3 ? 14 : 2.8,
      aggroRadius: 30,
      speed: 30,
      cooldown: 0,
      cooldownTicks: 8,
      activeAura,
      state: 'idle',
      alive: true,
    }
    this.mercenaries.set(unitId, record)

    this.broadcastToArea(areaId, {
      type: 'UnitAssign',
      unitType: 'monster',
      unitId,
      classId,
      name,
      x,
      y,
      areaId,
      unit: {
        unitType: 1,
        id: unitId,
        classId,
        name,
        x,
        y,
        mode: 1,
        lifePct: 128,
      },
    })
    this.broadcastToArea(areaId, {
      type: 'Merc',
      kind: 'assign',
      mercId: unitId,
      ownerId: ownerPlayerId,
      classId,
    })
    if (owner) {
      this.syncMercenaryOwnerAura(owner, activeAura)
    }
    return unitId
  }

  getMercenaryForOwner(
    ownerPlayerId: number,
  ): ServerMercenaryState | undefined {
    for (const m of this.mercenaries.values()) {
      if (m.ownerPlayerId === ownerPlayerId) {
        return {
          unitId: m.unitId,
          ownerPlayerId: m.ownerPlayerId,
          act: m.act,
          subType: m.subType,
          level: m.level,
          difficulty: m.difficulty,
          name: m.name,
          areaId: m.areaId,
          x: m.x,
          y: m.y,
          hp: m.hp,
          maxHp: m.maxHp,
          damage: m.damage,
          activeAura: m.activeAura,
          state: m.state,
          alive: m.alive,
        }
      }
    }
    return undefined
  }

  getMercenaryState(
    unitIdOrOwnerId: number,
  ): ServerMercenaryState | undefined {
    const m = this.mercenaries.get(unitIdOrOwnerId)
    if (m) {
      return {
        unitId: m.unitId,
        ownerPlayerId: m.ownerPlayerId,
        act: m.act,
        subType: m.subType,
        level: m.level,
        difficulty: m.difficulty,
        name: m.name,
        areaId: m.areaId,
        x: m.x,
        y: m.y,
        hp: m.hp,
        maxHp: m.maxHp,
        damage: m.damage,
        activeAura: m.activeAura,
        state: m.state,
        alive: m.alive,
      }
    }
    return this.getMercenaryForOwner(unitIdOrOwnerId)
  }

  getMercenaryOrPetArea(unitId: number): number | undefined {
    const merc = this.mercenaries.get(unitId)
    if (merc) return merc.areaId
    for (const [ownerId, mgr] of this.summonManagers.entries()) {
      for (const pet of mgr.getActivePets()) {
        const mappedId =
          this.petUnitIds.get(pet.uid) ??
          (pet as unknown as { unitId?: number }).unitId
        if (mappedId === unitId) {
          return this.players.get(ownerId)?.areaId ?? this.defaultAreaId
        }
      }
    }
    return undefined
  }

  getMonsterOrAllyArea(unitId: number): number | undefined {
    const m = this.monsters.get(unitId)
    if (m) return m.areaId
    return this.getMercenaryOrPetArea(unitId)
  }

  private stepMercenaries(): void {
    for (const merc of this.mercenaries.values()) {
      if (!merc.alive || merc.hp <= 0) continue
      const owner = this.players.get(merc.ownerPlayerId)
      if (!owner || owner.dead) continue

      if (merc.areaId !== owner.areaId) {
        merc.areaId = owner.areaId
        merc.x = owner.x + 1
        merc.y = owner.y + 1
        merc.state = 'idle'
        continue
      }

      if (merc.cooldown > 0) {
        merc.cooldown--
      }

      const mercUnit: MercenaryUnitState = {
        act: merc.act,
        subType: merc.subType,
        level: merc.level,
        difficulty: merc.difficulty,
        x: merc.x,
        y: merc.y,
        hp: merc.hp,
        maxHp: merc.maxHp,
        damage: merc.damage,
        alive: merc.alive,
        activeAura: merc.activeAura,
      }
      const outcome = tickMercenaryAi25Hz(
        mercUnit,
        {
          player: { x: owner.x, y: owner.y } as any,
          players: [],
          monsters: [],
          tick: this.currentFrame,
          events: [],
          pendingKills: [],
        } as any,
      )
      if (outcome.activeAura) {
        merc.activeAura = outcome.activeAura
      }
      this.syncMercenaryOwnerAura(owner, merc.activeAura)

      const ownerDist = Math.hypot(owner.x - merc.x, owner.y - merc.y)
      if (ownerDist > 35) {
        merc.x = owner.x
        merc.y = owner.y
        merc.state = 'idle'
        this.broadcastToArea(merc.areaId, {
          type: 'UnitReassign',
          unitType: 1,
          id: merc.unitId,
          unitId: merc.unitId,
          areaId: merc.areaId,
          at: { x: Math.round(merc.x), y: Math.round(merc.y) },
          x: Math.round(merc.x),
          y: Math.round(merc.y),
          snap: true,
        })
        continue
      }

      let bestTarget: InternalMonsterRecord | undefined
      let bestDist = merc.aggroRadius
      for (const m of this.monsters.values()) {
        if (
          m.dead ||
          m.isNpc ||
          !m.isKillable ||
          m.petIgnore ||
          m.areaId !== merc.areaId
        ) {
          continue
        }
        const d = Math.hypot(m.x - merc.x, m.y - merc.y)
        if (d <= bestDist) {
          bestDist = d
          bestTarget = m
        }
      }

      if (bestTarget) {
        if (bestDist <= merc.reach) {
          merc.state = 'attack'
          if (merc.cooldown <= 0) {
            merc.cooldown = merc.cooldownTicks
            this.applyDamageToMonster(owner, bestTarget, merc.damage, 0)
          }
        } else if (this.currentFrame % 2 === 0) {
          merc.state = 'chase'
          const dx = bestTarget.x - merc.x
          const dy = bestTarget.y - merc.y
          const nextX =
            Math.round((merc.x + (dx / bestDist) * 1.4) * 100) / 100
          const nextY =
            Math.round((merc.y + (dy / bestDist) * 1.4) * 100) / 100
          if (
            this.isMonsterStepWalkable(
              merc.areaId,
              merc.x,
              merc.y,
              nextX,
              nextY,
              false,
            )
          ) {
            merc.x = nextX
            merc.y = nextY
            this.broadcastToArea(merc.areaId, {
              type: 'UnitMove',
              unitType: 'monster',
              id: merc.unitId,
              unitId: merc.unitId,
              areaId: merc.areaId,
              mode: 'walk',
              to: { x: Math.round(merc.x), y: Math.round(merc.y) },
              x: Math.round(merc.x),
              y: Math.round(merc.y),
            })
          }
        }
      } else if (ownerDist > 4 && this.currentFrame % 2 === 0) {
        merc.state = 'follow'
        const dx = owner.x - merc.x
        const dy = owner.y - merc.y
        const nextX =
          Math.round((merc.x + (dx / ownerDist) * 1.4) * 100) / 100
        const nextY =
          Math.round((merc.y + (dy / ownerDist) * 1.4) * 100) / 100
        if (
          this.isMonsterStepWalkable(
            merc.areaId,
            merc.x,
            merc.y,
            nextX,
            nextY,
            false,
          )
        ) {
          merc.x = nextX
          merc.y = nextY
          this.broadcastToArea(merc.areaId, {
            type: 'UnitMove',
            unitType: 'monster',
            id: merc.unitId,
            unitId: merc.unitId,
            areaId: merc.areaId,
            mode: 'walk',
            to: { x: Math.round(merc.x), y: Math.round(merc.y) },
            x: Math.round(merc.x),
            y: Math.round(merc.y),
          })
        }
      } else {
        merc.state = 'idle'
      }
    }
  }

  getSummonManager(ownerPlayerId: number): SummonManager {
    let mgr = this.summonManagers.get(ownerPlayerId)
    if (!mgr) {
      mgr = new SummonManager(this.registry)
      this.summonManagers.set(ownerPlayerId, mgr)
    }
    return mgr
  }

  summonPet(ownerPlayerId: number, spec: SummonPetSpec): CreatePetOutcome {
    const owner = this.players.get(ownerPlayerId)
    const mgr = this.getSummonManager(ownerPlayerId)
    const statList = new UnitStatList()
    statList.setBaseStat('level', owner?.level ?? 1)
    statList.setBaseStat('maxhp', owner?.maxHpFixed ?? 100 * FIXED_ONE)
    statList.setHp256(owner?.hpFixed ?? 100 * FIXED_ONE)
    if (owner) {
      for (const [skId, lvl] of owner.skills.entries()) {
        statList.setBaseSkillLevel(skId, lvl)
      }
    }
    const slvl = Math.max(
      1,
      spec.slvl ?? spec.skillLevel ?? owner?.skills.get(spec.skillId) ?? 1,
    )
    statList.setBaseSkillLevel(spec.skillId, slvl)

    const ownerCtx: CombatUnitContext = {
      id: String(ownerPlayerId),
      name: owner?.name ?? `Player_${ownerPlayerId}`,
      unitType: 'player',
      statList,
      stateBus: new StateBus(statList),
      x: owner?.x ?? 128,
      y: owner?.y ?? 128,
    }

    const requiresCorpse =
      spec.skillId === 70 || spec.skillId === 80 || spec.skillId === 95
    const corpses: {
      id: string
      consumed: boolean
      baseMaxHp?: number
      classId?: number
      monId?: string
      monsterLevel?: number
      isBoss?: boolean
      revivable?: boolean
      isUnique?: boolean
      isChampion?: boolean
      states?: ReadonlySet<number>
      x?: number
      y?: number
      _monsterRef?: InternalMonsterRecord
    }[] = []

    if (requiresCorpse) {
      for (const m of this.monsters.values()) {
        if (!m.dead || m.shattered || m.isNpc) continue
        if (owner && m.areaId !== owner.areaId) continue
        if (
          spec.corpseMonsterId !== undefined &&
          m.unitId !== spec.corpseMonsterId
        ) {
          continue
        }
        corpses.push({
          id: String(m.unitId),
          consumed: false,
          baseMaxHp: m.baseMaxHp,
          classId: m.classId,
          monId: m.defId,
          monsterLevel: m.level,
          isBoss: m.isBoss,
          revivable: !m.isBoss && m.rank === 'normal',
          isUnique: m.rank === 'unique',
          isChampion: m.rank === 'champion',
          states: m.states,
          x: m.x,
          y: m.y,
          _monsterRef: m,
        })
      }
    }

    const outcome = mgr.createPet({
      owner: ownerCtx,
      skillId: spec.skillId,
      slvl,
      x: spec.x ?? (owner ? owner.x + 1 : 128),
      y: spec.y ?? (owner ? owner.y + 1 : 128),
      difficulty: this.difficulty,
      ...(requiresCorpse ? { corpses } : {}),
    })

    for (const c of corpses) {
      if (c.consumed && c._monsterRef) {
        c._monsterRef.shattered = true
      }
    }

    const areaId = owner?.areaId ?? this.defaultAreaId ?? 1
    for (const evictedUid of outcome.evictedPetUids) {
      const evictedUnitId = this.petUnitIds.get(evictedUid)
      if (evictedUnitId !== undefined) {
        this.petUnitIds.delete(evictedUid)
        this.broadcastToArea(areaId, {
          type: 'UnitRemove',
          unitType: 1,
          id: evictedUnitId,
          unitId: evictedUnitId,
        })
        this.emitToPlayer(ownerPlayerId, {
          type: 'Merc',
          kind: 'assign',
          isSummonAction: true,
          summonAction: 0,
          petType: 1,
          mercId: evictedUnitId,
          ownerId: ownerPlayerId,
          classId: spec.skillId,
        })
      }
    }

    if (outcome.created && outcome.pet) {
      const petUnitId = this.allocateUnitId()
      this.petUnitIds.set(outcome.pet.uid, petUnitId)
      const petMeta = outcome.pet as unknown as {
        unitId?: number
        areaId?: number
      }
      petMeta.unitId = petUnitId
      petMeta.areaId = areaId
      const petTypeIdx =
        PET_TYPE_IDX_BY_NAME_113C[outcome.pet.petType] ??
        PET_TYPE_PORTRAIT_TABLE[0]?.idx ??
        1
      const classId = outcome.pet.classId ?? 363
      this.broadcastToArea(areaId, {
        type: 'UnitAssign',
        unitType: 'monster',
        unitId: petUnitId,
        classId,
        name: outcome.pet.name,
        x: outcome.pet.x,
        y: outcome.pet.y,
        areaId,
        unit: {
          unitType: 1,
          id: petUnitId,
          classId,
          name: outcome.pet.name,
          x: outcome.pet.x,
          y: outcome.pet.y,
          mode: 1,
          lifePct: 128,
        },
      })
      this.emitToPlayer(ownerPlayerId, {
        type: 'Merc',
        kind: 'assign',
        isSummonAction: true,
        summonAction: 1,
        petType: petTypeIdx,
        mercId: petUnitId,
        ownerId: ownerPlayerId,
        classId: spec.skillId,
      })
    }

    return outcome
  }

  unsummonPetAt(
    ownerPlayerId: number,
    x: number,
    y: number,
    radius = 80,
  ): SummonedPetUnit | null {
    const mgr = this.summonManagers.get(ownerPlayerId)
    if (!mgr) return null
    const removed = mgr.unsummonOwnPetAt(String(ownerPlayerId), x, y, radius)
    if (removed) {
      const petUnitId = this.petUnitIds.get(removed.uid)
      const owner = this.players.get(ownerPlayerId)
      const areaId = owner?.areaId ?? this.defaultAreaId ?? 1
      if (petUnitId !== undefined) {
        this.petUnitIds.delete(removed.uid)
        this.broadcastToArea(areaId, {
          type: 'UnitRemove',
          unitType: 1,
          id: petUnitId,
          unitId: petUnitId,
        })
        this.emitToPlayer(ownerPlayerId, {
          type: 'Merc',
          kind: 'assign',
          isSummonAction: true,
          summonAction: 0,
          petType: PET_TYPE_IDX_BY_NAME_113C[removed.petType] ?? 1,
          mercId: petUnitId,
          ownerId: ownerPlayerId,
          classId: removed.sourceSkillId,
        })
      }
    }
    return removed
  }

  getPetsForOwner(ownerPlayerId: number): readonly SummonedPetUnit[] {
    const mgr = this.summonManagers.get(ownerPlayerId)
    return mgr ? [...mgr.getActivePets()] : []
  }

  getPetState(
    idOrOutcome:
      | number
      | string
      | {
          readonly pet?: SummonedPetUnit | null | undefined
          readonly uid?: string | undefined
        },
  ): SummonedPetUnit | undefined {
    if (typeof idOrOutcome === 'object' && idOrOutcome !== null) {
      const targetUid = idOrOutcome.pet?.uid ?? idOrOutcome.uid
      if (targetUid) {
        for (const mgr of this.summonManagers.values()) {
          for (const pet of mgr.getActivePets()) {
            if (pet.uid === targetUid) return pet
          }
        }
      }
      return idOrOutcome.pet ?? undefined
    }
    for (const mgr of this.summonManagers.values()) {
      for (const pet of mgr.getActivePets()) {
        const mappedId =
          this.petUnitIds.get(pet.uid) ??
          (pet as unknown as { unitId?: number }).unitId
        if (
          pet.uid === String(idOrOutcome) ||
          mappedId === idOrOutcome ||
          Number(pet.uid) === idOrOutcome
        ) {
          return pet
        }
      }
    }
    return undefined
  }

  private stepSummonedPets(): void {
    for (const [ownerPlayerId, mgr] of this.summonManagers.entries()) {
      const owner = this.players.get(ownerPlayerId)
      if (!owner || owner.dead) continue
      const pets = mgr.getActivePets()
      for (const pet of pets) {
        if (pet.hp <= 0 || pet.alive === false) continue
        const isStationary =
          Boolean(pet.isStationary) ||
          pet.petType === 'assassintrap' ||
          pet.petType === 'hydra' ||
          pet.petType === 'totem' ||
          pet.petType === 'vine'
        const isFlyingPet = pet.petType === 'raven'
        const petUnitId =
          this.petUnitIds.get(pet.uid) ??
          (pet as unknown as { unitId?: number }).unitId
        const petMeta = pet as unknown as { areaId?: number; unitId?: number }
        if (petUnitId !== undefined && petMeta.unitId === undefined) {
          petMeta.unitId = petUnitId
        }

        const ownerDist = Math.hypot(owner.x - pet.x, owner.y - pet.y)
        if (
          !isStationary &&
          (ownerDist > 35 ||
            (petMeta.areaId !== undefined && petMeta.areaId !== owner.areaId))
        ) {
          pet.x = owner.x
          pet.y = owner.y
          petMeta.areaId = owner.areaId
          if (petUnitId !== undefined) {
            this.broadcastToArea(owner.areaId, {
              type: 'UnitReassign',
              unitType: 1,
              id: petUnitId,
              unitId: petUnitId,
              areaId: owner.areaId,
              at: { x: Math.round(pet.x), y: Math.round(pet.y) },
              x: Math.round(pet.x),
              y: Math.round(pet.y),
              snap: true,
            })
          }
          continue
        }
        petMeta.areaId = owner.areaId

        let bestTarget: InternalMonsterRecord | undefined
        let bestDist = 25
        for (const m of this.monsters.values()) {
          if (
            m.dead ||
            m.isNpc ||
            !m.isKillable ||
            m.petIgnore ||
            m.areaId !== owner.areaId
          ) {
            continue
          }
          const d = Math.hypot(m.x - pet.x, m.y - pet.y)
          if (d <= bestDist) {
            bestDist = d
            bestTarget = m
          }
        }

        if (bestTarget) {
          if (bestDist <= 2.5 || (isStationary && bestDist <= 18)) {
            if (this.currentFrame % 8 === 0) {
              const dmg = Math.max(
                2,
                (pet.minDamage ?? 5) + pet.slvl * 3,
              )
              this.applyDamageToMonster(
                owner,
                bestTarget,
                dmg,
                pet.sourceSkillId,
              )
            }
          } else if (!isStationary && this.currentFrame % 2 === 0) {
            const dx = bestTarget.x - pet.x
            const dy = bestTarget.y - pet.y
            const nextX =
              Math.round((pet.x + (dx / bestDist) * 1.3) * 100) / 100
            const nextY =
              Math.round((pet.y + (dy / bestDist) * 1.3) * 100) / 100
            if (
              this.isMonsterStepWalkable(
                owner.areaId,
                pet.x,
                pet.y,
                nextX,
                nextY,
                isFlyingPet,
              )
            ) {
              pet.x = nextX
              pet.y = nextY
              if (petUnitId !== undefined) {
                this.broadcastToArea(owner.areaId, {
                  type: 'UnitMove',
                  unitType: 'monster',
                  id: petUnitId,
                  unitId: petUnitId,
                  areaId: owner.areaId,
                  mode: 'walk',
                  to: { x: Math.round(pet.x), y: Math.round(pet.y) },
                  x: Math.round(pet.x),
                  y: Math.round(pet.y),
                })
              }
            }
          }
        } else if (!isStationary && ownerDist > 4) {
          const dx = owner.x - pet.x
          const dy = owner.y - pet.y
          const nextX =
            Math.round((pet.x + (dx / ownerDist) * 0.85) * 100) / 100
          const nextY =
            Math.round((pet.y + (dy / ownerDist) * 0.85) * 100) / 100
          if (
            this.isMonsterStepWalkable(
              owner.areaId,
              pet.x,
              pet.y,
              nextX,
              nextY,
              isFlyingPet,
            )
          ) {
            pet.x = nextX
            pet.y = nextY
            if (petUnitId !== undefined) {
              this.broadcastToArea(owner.areaId, {
                type: 'UnitMove',
                unitType: 'monster',
                id: petUnitId,
                unitId: petUnitId,
                areaId: owner.areaId,
                mode: 'walk',
                to: { x: Math.round(pet.x), y: Math.round(pet.y) },
                x: Math.round(pet.x),
                y: Math.round(pet.y),
              })
            }
          }
        }
      }
    }
  }

  getNpcVendorPool(npcUnitId: number): readonly ServerItemEntry[] {
    const m = this.monsters.get(npcUnitId)
    if (!m) return []
    return m.vendorPool.map((i) => ({ ...i, stats: new Map(i.stats) }))
  }

  getAllUnits(): readonly ServerUnitSummary[] {
    const out: ServerUnitSummary[] = []
    for (const p of this.players.values()) {
      out.push({
        unitType: 'player',
        unitId: p.unitId,
        classId: p.classId,
        x: p.x,
        y: p.y,
        areaId: p.areaId,
        name: p.name,
        mode: p.mode,
        hp: p.hp,
        maxHp: p.maxHp,
      })
    }
    for (const m of this.monsters.values()) {
      out.push({
        unitType: 'monster',
        unitId: m.unitId,
        classId: m.classId,
        x: m.x,
        y: m.y,
        areaId: m.areaId,
        name: m.name,
        mode: m.mode,
        hp: m.hp,
        maxHp: m.maxHp,
      })
    }
    for (const merc of this.mercenaries.values()) {
      out.push({
        unitType: 'monster',
        unitId: merc.unitId,
        classId: merc.act,
        x: merc.x,
        y: merc.y,
        areaId: merc.areaId,
        name: merc.name,
        mode: merc.alive ? 1 : 12,
        hp: merc.hp,
        maxHp: merc.maxHp,
      })
    }
    for (const o of this.objects.values()) {
      out.push({
        unitType: 'object',
        unitId: o.unitId,
        classId: o.classId,
        x: o.x,
        y: o.y,
        areaId: o.areaId,
        mode: o.mode,
      })
    }
    for (const g of this.groundItems.values()) {
      out.push({
        unitType: 'item',
        unitId: g.unitId,
        classId: 0,
        x: g.x,
        y: g.y,
        areaId: g.areaId,
        name: g.code,
      })
    }
    for (const ms of this.missiles.values()) {
      out.push({
        unitType: 'missile',
        unitId: ms.unitId,
        classId: ms.missileId,
        x: ms.x,
        y: ms.y,
        areaId: ms.areaId,
      })
    }
    return out
  }

  exportPlayerD2s(playerUnitId: number): Uint8Array {
    const p = this.players.get(playerUnitId)
    if (!p) {
      throw new Error(
        `GameInstance.exportPlayerD2s: unknown player unitId ${playerUnitId}`,
      )
    }

    const skillsArray = new Uint8Array(30)
    const offset = CLASS_SKILL_OFFSET[p.classId] ?? 6
    if (p.d2sTemplate?.skills) {
      skillsArray.set(p.d2sTemplate.skills.subarray(0, 30))
    }
    for (const [skillId, slvl] of p.skills.entries()) {
      const idx = skillId - offset
      if (idx >= 0 && idx < 30) {
        skillsArray[idx] = Math.max(0, Math.min(255, slvl))
      }
    }

    const template = p.d2sTemplate
    const defaultWp = createDefaultWaypointData()
    const waypoints: [Uint8Array, Uint8Array, Uint8Array] = template?.waypoints
      ? [
          new Uint8Array(template.waypoints[0]),
          new Uint8Array(template.waypoints[1]),
          new Uint8Array(template.waypoints[2]),
        ]
      : [
          defaultWp.slice(8, 32),
          defaultWp.slice(32, 56),
          defaultWp.slice(56, 80),
        ]

    const diffWp = waypoints[this.difficulty]
    for (const areaId of p.waypoints) {
      const bitIndex = WAYPOINT_AREA_IDS.indexOf(areaId)
      if (bitIndex !== -1) {
        const byteIdx = 2 + (bitIndex >> 3)
        const bitMask = 1 << (bitIndex & 7)
        diffWp[byteIdx] = (diffWp[byteIdx] ?? 0) | bitMask
      }
    }

    return writeD2sSave113c(
      {
        name: p.name,
        classId: p.classId,
        level: p.level,
        statusFlags: template?.statusFlags ?? 0x20,
        progression: template?.progression ?? 0,
        activeWeapon: template?.activeWeapon ?? 0,
        timestampSec: template?.timestampSec ?? 0,
        hotkeys: template?.hotkeys,
        leftSkill: p.leftSkill,
        rightSkill: p.rightSkill,
        altLeftSkill: template?.altLeftSkill ?? 0,
        altRightSkill: template?.altRightSkill ?? 0,
        appearance: template?.appearance,
        activeDifficulty: this.difficulty,
        activeAct: p.act,
        mapSeed: this.canPersistMapSeed()
          ? this.currentMapSeed
          : (template?.mapSeed ?? 0),
        merc: template?.merc,
        mercItems: template?.mercItems,
        quests: template?.quests,
        questsRaw: template?.questsRaw ?? createDefaultQuestData(),
        waypoints,
        npcIntro: template?.npcIntro ?? createDefaultNpcIntroData(),
        attributes: {
          strength: p.strength,
          energy: p.energy,
          dexterity: p.dexterity,
          vitality: p.vitality,
          statPts: p.statPts,
          newSkills: p.newSkills,
          hitpointsFixed: Math.max(1, p.hpFixed),
          maxHpFixed: p.maxHpFixed,
          manaFixed: p.manaFixed,
          maxManaFixed: p.maxManaFixed,
          staminaFixed: p.staminaFixed,
          maxStaminaFixed: p.maxStaminaFixed,
          level: p.level,
          experience: p.experience,
          gold: p.gold,
          goldBank: p.goldBank,
        },
        skills: skillsArray,
        items: p.items.map((item) => this.serverEntryToItemData(item)),
        corpseItems: p.corpseItems.map((item) => this.serverEntryToItemData(item)),
        ironGolem: p.ironGolemItem
          ? this.serverEntryToItemData(p.ironGolemItem)
          : null,
      },
      getServerItemDataTables(),
    )
  }

  computeFrameLockstepHash(): number {
    let h = 0x811c9dc5
    const mix = (val: number): void => {
      const v = val >>> 0
      h ^= v & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
      h ^= (v >>> 8) & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
      h ^= (v >>> 16) & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
      h ^= (v >>> 24) & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
    }

    mix(this.currentFrame)
    mix(this.currentMapSeed)
    const rngState = this.rng.getSeed()
    mix(rngState.lo)
    mix(rngState.hi)
    mix(this.playersX)

    for (const p of this.players.values()) {
      mix(p.unitId)
      mix(p.areaId)
      mix(Math.round(p.x * 100))
      mix(Math.round(p.y * 100))
      mix(p.hpFixed)
      mix(p.maxHpFixed)
      mix(p.manaFixed)
      mix(p.experience)
      mix(p.level)
      mix(p.strength)
      mix(p.dexterity)
      mix(p.vitality)
      mix(p.energy)
      mix(p.gold)
      mix(p.statPts)
      mix(p.newSkills)
      mix(p.items.length)
      mix(p.dead ? 1 : 0)
    }

    for (const m of this.monsters.values()) {
      mix(m.unitId)
      mix(m.areaId)
      mix(Math.round(m.x * 100))
      mix(Math.round(m.y * 100))
      mix(m.hp)
      mix(m.mode)
      mix(m.dead ? 1 : 0)
    }

    for (const merc of this.mercenaries.values()) {
      mix(merc.unitId)
      mix(merc.areaId)
      mix(Math.round(merc.x * 100))
      mix(Math.round(merc.y * 100))
      mix(merc.hp)
      mix(merc.alive ? 1 : 0)
    }

    for (const [ownerId, mgr] of this.summonManagers.entries()) {
      mix(ownerId)
      for (const pet of mgr.getActivePets()) {
        mix(Math.round(pet.x * 100))
        mix(Math.round(pet.y * 100))
        mix(pet.hp)
      }
    }

    for (const ms of this.missiles.values()) {
      mix(ms.unitId)
      mix(Math.round(ms.x * 100))
      mix(Math.round(ms.y * 100))
    }

    for (const g of this.groundItems.values()) {
      mix(g.unitId)
      mix(Math.round(g.x * 100))
      mix(Math.round(g.y * 100))
      mix(g.quality)
    }

    return h >>> 0
  }

  getStateHash(): number {
    return this.computeFrameLockstepHash()
  }

  getLastLockstepHash(): number {
    return this.computeFrameLockstepHash()
  }
}
