/**
 * Derived Mercenary Sheet & Level-from-Experience helpers (`src/client/ui-model/derived-stats.ts`).
 *
 * Player character-sheet attributes and combat stats now run through `stat-engine.ts` and `combat-stats.ts`.
 * This module provides:
 * - `RESIST_PENALTY_BY_DIFFICULTY` (`DifficultyLevels.txt` penalty: 0 / -40 / -100)
 * - `resolveLevelFromExp` (`D2_EXPERIENCE_TABLE_99` level lookup)
 * - `computeEffectiveMercenaryStats` (`Hireling.txt` 8th-precision scaling + equipment/socket/state aggregation + `lifePct / 128` + difficulty resistance penalty + dynamic colors)
 */

import {
  RAW_ARMOR,
  RAW_WEAPONS,
} from '../../common/data/canonical-drop-data.ts'
import {
  CANONICAL_GEMS_TABLE,
  type GemModifier,
} from '../../common/items/gems.ts'
import { D2_EXPERIENCE_TABLE_99 } from '../../common/skills/formulas.ts'
import {
  HIRELING_RECORDS,
  resolveHirelingName,
  type HirelingRecord,
} from '../../common/units/hireling-table.ts'
import type { D2ColorCode } from '../../common/skills/skills-meta.ts'
import type { ItemData, ItemStat } from '../../netproto/index.ts'
import type { ClientWorld } from '../world/client-world.ts'

/** `DifficultyLevels.txt` row `ResistPenalty` column (Normal / Nightmare / Hell). */
export const RESIST_PENALTY_BY_DIFFICULTY: readonly [number, number, number] = [
  0,
  -40,
  -100,
] as const

/**
 * Infers character level (`1..99`) from experience (`D2_EXPERIENCE_TABLE_99`, where index `L` is the XP threshold for level `L`).
 */
export function resolveLevelFromExp(exp: number): number {
  if (!Number.isFinite(exp) || exp <= 0) return 1
  let resolved = 1
  for (let lvl = 1; lvl <= 99; lvl++) {
    const threshold = D2_EXPERIENCE_TABLE_99[lvl] ?? 0
    if (exp >= threshold) {
      resolved = lvl
    } else {
      break
    }
  }
  return resolved
}

const SHIELD_TYPE_CODES = new Set(['shie', 'shld', 'ashd', 'pala', 'head', 'voodoo'])
const THROWING_WEAPON_TYPES = new Set(['tkni', 'taxe', 'jav', 'ajav', 'tpot'])
const RANGED_WEAPON_TYPES = new Set(['bow', 'xbow', 'abow'])

function getWeaponRow(code: string): Record<string, any> | undefined {
  return ((RAW_WEAPONS as unknown) as Record<string, any>)[code]
}

function getArmorRow(code: string): Record<string, any> | undefined {
  return ((RAW_ARMOR as unknown) as Record<string, any>)[code]
}

function getItemKind(code: string): 'weapon' | 'armor' | 'misc' {
  const c = code.trim().toLowerCase()
  if (getWeaponRow(c)) return 'weapon'
  if (getArmorRow(c)) return 'armor'
  return 'misc'
}

function getHostSocketCategory(code: string, bodyLoc: number): 'weapon' | 'helm' | 'shield' {
  const c = code.trim().toLowerCase()
  if (getWeaponRow(c)) return 'weapon'
  const armorRow = getArmorRow(c)
  const itemType = String(armorRow?.type ?? '').trim().toLowerCase()
  if (SHIELD_TYPE_CODES.has(itemType) || bodyLoc === 5 || bodyLoc === 12) {
    if (!getWeaponRow(c)) return 'shield'
  }
  return 'helm'
}

/**
 * Converts a canonical `GemModifier` from `Gems.txt` into `ItemStat` entries when a socketed child
 * does not already carry explicit `ItemStat` records on the wire.
 */
function gemModToItemStats(mod: GemModifier): ItemStat[] {
  const val = mod.min
  const max = mod.max
  const par = Number(mod.param ?? mod.par ?? 0) || 0
  switch (mod.code) {
    case 'str':
      return [{ statId: 0, param: 0, value: val }]
    case 'enr':
      return [{ statId: 1, param: 0, value: val }]
    case 'dex':
      return [{ statId: 2, param: 0, value: val }]
    case 'vit':
      return [{ statId: 3, param: 0, value: val }]
    case 'hp':
      return [{ statId: 7, param: 0, value: val }]
    case 'mana':
      return [{ statId: 9, param: 0, value: val }]
    case 'stam':
      return [{ statId: 11, param: 0, value: val }]
    case 'hp%':
      return [{ statId: 76, param: 0, value: val }]
    case 'mana%':
      return [{ statId: 77, param: 0, value: val }]
    case 'ac':
      return [{ statId: 31, param: 0, value: val }]
    case 'ac%':
      return [{ statId: 16, param: 0, value: val }]
    case 'att':
      return [{ statId: 19, param: 0, value: val }]
    case 'att%':
      return [{ statId: 119, param: 0, value: val }]
    case 'res-fire':
      return [{ statId: 39, param: 0, value: val }]
    case 'res-ltng':
      return [{ statId: 41, param: 0, value: val }]
    case 'res-cold':
      return [{ statId: 43, param: 0, value: val }]
    case 'res-pois':
      return [{ statId: 45, param: 0, value: val }]
    case 'res-all':
      return [
        { statId: 39, param: 0, value: val },
        { statId: 41, param: 0, value: val },
        { statId: 43, param: 0, value: val },
        { statId: 45, param: 0, value: val },
      ]
    case 'res-fire-max':
      return [{ statId: 40, param: 0, value: val }]
    case 'res-ltng-max':
      return [{ statId: 42, param: 0, value: val }]
    case 'res-cold-max':
      return [{ statId: 44, param: 0, value: val }]
    case 'res-pois-max':
      return [{ statId: 46, param: 0, value: val }]
    case 'dmg%':
      return [{ statId: 17, param: 0, value: val }]
    case 'dmg-min':
      return [
        { statId: 21, param: 0, value: val },
        { statId: 23, param: 0, value: val },
      ]
    case 'dmg-max':
      return [
        { statId: 22, param: 0, value: val },
        { statId: 24, param: 0, value: val },
      ]
    case 'dmg-norm':
      return [
        { statId: 21, param: 0, value: val },
        { statId: 22, param: 0, value: max },
      ]
    case 'dmg-fire':
      return [
        { statId: 48, param: 0, value: val },
        { statId: 49, param: 0, value: max },
      ]
    case 'dmg-ltng':
      return [
        { statId: 50, param: 0, value: val },
        { statId: 51, param: 0, value: max },
      ]
    case 'dmg-mag':
      return [
        { statId: 52, param: 0, value: val },
        { statId: 53, param: 0, value: max },
      ]
    case 'dmg-cold':
      return [
        { statId: 54, param: 0, value: val },
        { statId: 55, param: 0, value: max },
        { statId: 56, param: 0, value: par || 50 },
      ]
    case 'dmg-pois':
      return [
        { statId: 57, param: 0, value: val },
        { statId: 58, param: 0, value: max },
        { statId: 59, param: 0, value: par || 50 },
      ]
    case 'req%':
      return [{ statId: 91, param: 0, value: val }]
    default:
      return []
  }
}

/**
 * Normalizes a stat 6..11 pool value from an item or state stat list:
 * if encoded in 8.8 fixed point (`Math.abs(val) >= 256 && (val & 0xff) === 0`), shifts right by 8.
 */
function normalizeItemPoolStat(val: number): number {
  if (Math.abs(val) >= 256 && (val & 0xff) === 0) {
    return val >> 8
  }
  return val
}

function isDefaultPlaceholderArmorStat(item: ItemData, stats: readonly ItemStat[]): boolean {
  if (stats.length !== 1) return false
  const s0 = stats[0]!
  const sid = Number(s0.statId ?? (s0 as any).id ?? -1)
  return sid === 31 && (s0.param ?? 0) === 0 && s0.value === 5 && item.defense === 5
}

function extractItemAndSocketStats(
  item: ItemData,
  socketChildren: readonly ItemData[],
  bodyLoc: number,
): {
  readonly itemStats: ItemStat[]
  readonly baseArmorDefense: number
  readonly localEdPct: number
  readonly localFlatDefense: number
  readonly localDefPerLevel8ths: number
} {
  const code = (item.code ?? '').trim().toLowerCase()
  const kind = getItemKind(code)
  const rawList: ItemStat[] = [
    ...(Array.isArray(item.stats) ? item.stats : []),
    ...(Array.isArray(item.runewordStats) ? item.runewordStats : []),
    ...(Array.isArray(item.setBonusStats) ? item.setBonusStats : []),
  ]

  let consumedArmorStat = false
  let armorStatDef: number | undefined
  const filteredItemStats: ItemStat[] = []

  const skipPlaceholderOnNonArmor = kind !== 'armor' && isDefaultPlaceholderArmorStat(item, rawList)
  if (!skipPlaceholderOnNonArmor) {
    for (const raw of rawList) {
      const statId = Number(raw.statId ?? (raw as any).id ?? -1)
      const param = Number(raw.param ?? 0)
      const value = Number(raw.value ?? 0)
      if (!Number.isFinite(statId) || statId < 0 || !Number.isFinite(value)) continue
      if (
        !consumedArmorStat &&
        kind === 'armor' &&
        statId === 31 &&
        (typeof item.defense !== 'number' || item.defense <= 0 || value === item.defense)
      ) {
        armorStatDef = value
        consumedArmorStat = true
        continue
      }
      filteredItemStats.push({ statId, param, value })
    }
  }

  // Socketed children (gems, runes, jewels)
  const hostCat = getHostSocketCategory(code, bodyLoc)
  for (const child of socketChildren) {
    const childCode = (child.code ?? '').trim().toLowerCase()
    const childRawStats = Array.isArray(child.stats) ? child.stats : []
    const isChildPlaceholder = isDefaultPlaceholderArmorStat(child, childRawStats)
    const effectiveChildStats = isChildPlaceholder ? [] : childRawStats
    if (effectiveChildStats.length > 0) {
      for (const s of effectiveChildStats) {
        const sid = Number(s.statId ?? (s as any).id ?? -1)
        const param = Number(s.param ?? 0)
        const value = Number(s.value ?? 0)
        if (sid >= 0 && Number.isFinite(value)) {
          filteredItemStats.push({ statId: sid, param, value })
        }
      }
    } else {
      const gemDef = CANONICAL_GEMS_TABLE.get(childCode)
      if (gemDef) {
        const mods =
          hostCat === 'weapon'
            ? gemDef.weaponMods
            : hostCat === 'shield'
              ? gemDef.shieldMods
              : gemDef.helmMods
        for (const m of mods) {
          filteredItemStats.push(...gemModToItemStats(m))
        }
      }
    }
  }

  // Base armor defense calculation
  let baseArmorDefense = 0
  let localEdPct = 0
  let localFlatDefense = 0
  let localDefPerLevel8ths = 0

  if (kind === 'armor') {
    const armorRow = getArmorRow(code)
    const explicitDef =
      typeof item.defense === 'number' && item.defense > 0
        ? item.defense
        : armorStatDef !== undefined && armorStatDef > 0
          ? armorStatDef
          : (armorRow?.maxac ?? armorRow?.minac ?? 0)
    baseArmorDefense = Math.max(0, explicitDef)
    for (const s of filteredItemStats) {
      if (s.statId === 16) localEdPct += s.value
      else if (s.statId === 31) localFlatDefense += s.value
      else if (s.statId === 214) localDefPerLevel8ths += s.value
    }
  }

  return {
    itemStats: filteredItemStats,
    baseArmorDefense,
    localEdPct,
    localFlatDefense,
    localDefPerLevel8ths,
  }
}

function isItemUsable(item: ItemData): boolean {
  if (item.broken === true) return false
  if (item.identified === false) return false
  const isIndestructible = item.stats?.some((s) => (s.statId ?? (s as any).id) === 152 && s.value > 0)
  if (
    !isIndestructible &&
    typeof item.maxDurability === 'number' &&
    item.maxDurability > 0 &&
    typeof item.curDurability === 'number' &&
    item.curDurability <= 0 &&
    item.durability === 0
  ) {
    return false
  }
  return true
}

export interface WeaponHandSummary {
  readonly item: ItemData | null
  readonly code: string | null
  readonly type: string | null
  readonly isWeapon: boolean
  readonly isTwoHanded: boolean
  readonly isOneOrTwoHanded: boolean
  readonly isRanged: boolean
  readonly isThrowing: boolean
  readonly minDam1H: number
  readonly maxDam1H: number
  readonly minDam2H: number
  readonly maxDam2H: number
  readonly minMisDam: number
  readonly maxMisDam: number
  readonly localEdPct: number
  readonly localMaxDamPerLevel8ths: number
  readonly localMaxEdPerLevel8ths: number
  readonly localMin1H: number
  readonly localMax1H: number
  readonly localMin2H: number
  readonly localMax2H: number
  readonly localMinThrow: number
  readonly localMaxThrow: number
  readonly localFlatAr: number
  readonly localPctAr: number
  readonly localArPerLevel8ths: number
  readonly localPctArPerLevel8ths: number
  readonly elemFireMin: number
  readonly elemFireMax: number
  readonly elemLtngMin: number
  readonly elemLtngMax: number
  readonly elemMagMin: number
  readonly elemMagMax: number
  readonly elemColdMin: number
  readonly elemColdMax: number
  readonly elemPoisTotalMin: number
  readonly elemPoisTotalMax: number
}

function getSocketChildrenForItem(world: ClientWorld, item: ItemData): readonly ItemData[] {
  const fromContainers = (world.containers as any)?.getSocketChildren?.(item.id) ?? []
  if (fromContainers.length > 0) return fromContainers
  if (Array.isArray((item as any).socketedChildren)) return (item as any).socketedChildren
  if (Array.isArray((item as any).gems)) return (item as any).gems
  return []
}

function buildWeaponHandSummary(
  item: ItemData,
  stats: readonly ItemStat[],
): WeaponHandSummary {
  const code = (item.code ?? '').trim().toLowerCase()
  const wRow = getWeaponRow(code)
  const aRow = getArmorRow(code)
  const isWeapon = Boolean(wRow)
  const type = String(wRow?.type ?? aRow?.type ?? '').trim().toLowerCase() || null
  const isTwoHanded = Boolean(wRow?.['2handed'] === 1 || wRow?.twoHanded || wRow?.twohanded === '1')
  const isOneOrTwoHanded = Boolean(wRow?.['1or2handed'] === 1 || wRow?.oneOrTwoHanded || wRow?.['1or2handed'] === '1')
  const isRanged = type !== null && RANGED_WEAPON_TYPES.has(type)
  const isThrowing = type !== null && THROWING_WEAPON_TYPES.has(type)
  const ethMult = item.ethereal ? 1.5 : 1

  const minDam1H = Math.max(0, Math.floor((Number(wRow?.mindam ?? 0) || 0) * ethMult))
  const maxDam1H = Math.max(0, Math.floor((Number(wRow?.maxdam ?? 0) || 0) * ethMult))
  const minDam2H = Math.max(0, Math.floor((Number(wRow?.['2handmindam'] ?? wRow?.twoHandedMindam ?? wRow?.mindam ?? 0) || 0) * ethMult))
  const maxDam2H = Math.max(0, Math.floor((Number(wRow?.['2handmaxdam'] ?? wRow?.twoHandedMaxdam ?? wRow?.maxdam ?? 0) || 0) * ethMult))
  const minMisDam = Math.max(0, Math.floor((Number(wRow?.minmisdam ?? wRow?.minMisDam ?? 0) || 0) * ethMult))
  const maxMisDam = Math.max(0, Math.floor((Number(wRow?.maxmisdam ?? wRow?.maxMisDam ?? 0) || 0) * ethMult))

  let localEdPct = 0
  let localMaxDamPerLevel8ths = 0
  let localMaxEdPerLevel8ths = 0
  let localMin1H = 0
  let localMax1H = 0
  let localMin2H = 0
  let localMax2H = 0
  let localMinThrow = 0
  let localMaxThrow = 0
  let localFlatAr = 0
  let localPctAr = 0
  let localArPerLevel8ths = 0
  let localPctArPerLevel8ths = 0
  let elemFireMin = 0
  let elemFireMax = 0
  let elemLtngMin = 0
  let elemLtngMax = 0
  let elemMagMin = 0
  let elemMagMax = 0
  let elemColdMin = 0
  let elemColdMax = 0
  let poisRateMin = 0
  let poisRateMax = 0
  let poisFrames = 0

  for (const s of stats) {
    switch (s.statId) {
      case 17:
      case 18:
        // Avoid double-counting if both 17 (maxdamage_percent) and 18 (mindamage_percent) are emitted with identical value
        if (s.statId === 17) localEdPct += s.value
        else if (!stats.some((o) => o.statId === 17)) localEdPct += s.value
        break
      case 21:
        localMin1H += s.value
        break
      case 22:
        localMax1H += s.value
        break
      case 23:
        localMin2H += s.value
        break
      case 24:
        localMax2H += s.value
        break
      case 159:
        localMinThrow += s.value
        break
      case 160:
        localMaxThrow += s.value
        break
      case 218:
        localMaxDamPerLevel8ths += s.value
        break
      case 219:
        localMaxEdPerLevel8ths += s.value
        break
      case 19:
        localFlatAr += s.value
        break
      case 119:
        localPctAr += s.value
        break
      case 220:
        localArPerLevel8ths += s.value
        break
      case 221:
        localPctArPerLevel8ths += s.value
        break
      case 48:
        elemFireMin += s.value
        break
      case 49:
        elemFireMax += s.value
        break
      case 50:
        elemLtngMin += s.value
        break
      case 51:
        elemLtngMax += s.value
        break
      case 52:
        elemMagMin += s.value
        break
      case 53:
        elemMagMax += s.value
        break
      case 54:
        elemColdMin += s.value
        break
      case 55:
        elemColdMax += s.value
        break
      case 57:
        poisRateMin += s.value
        break
      case 58:
        poisRateMax += s.value
        break
      case 59:
        poisFrames += s.value
        break
    }
  }

  const effPoisFrames = poisFrames > 0 ? poisFrames : (poisRateMin > 0 || poisRateMax > 0 ? 50 : 0)
  const elemPoisTotalMin =
    effPoisFrames > 0 && poisRateMin >= 16
      ? Math.floor((poisRateMin * effPoisFrames + 128) / 256)
      : poisRateMin
  const elemPoisTotalMax =
    effPoisFrames > 0 && poisRateMax >= 16
      ? Math.floor((poisRateMax * effPoisFrames + 128) / 256)
      : Math.max(elemPoisTotalMin, poisRateMax)

  return {
    item,
    code,
    type,
    isWeapon,
    isTwoHanded,
    isOneOrTwoHanded,
    isRanged,
    isThrowing,
    minDam1H,
    maxDam1H,
    minDam2H,
    maxDam2H,
    minMisDam,
    maxMisDam,
    localEdPct,
    localMaxDamPerLevel8ths,
    localMaxEdPerLevel8ths,
    localMin1H,
    localMax1H,
    localMin2H,
    localMax2H,
    localMinThrow,
    localMaxThrow,
    localFlatAr,
    localPctAr,
    localArPerLevel8ths,
    localPctArPerLevel8ths,
    elemFireMin,
    elemFireMax: Math.max(elemFireMin, elemFireMax),
    elemLtngMin,
    elemLtngMax: Math.max(elemLtngMin, elemLtngMax),
    elemMagMin,
    elemMagMax: Math.max(elemMagMin, elemMagMax),
    elemColdMin,
    elemColdMax: Math.max(elemColdMin, elemColdMax),
    elemPoisTotalMin,
    elemPoisTotalMax,
  }
}

export interface EffectiveMercenaryStats {
  readonly name: string
  readonly hirelingRecord: HirelingRecord | null
  readonly level: number
  readonly experience: number
  readonly nextLevelXp: number
  readonly hp: number
  readonly maxHp: number
  readonly lifePct: number
  readonly baseStr: number
  readonly str: number
  readonly strColor: D2ColorCode
  readonly baseDex: number
  readonly dex: number
  readonly dexColor: D2ColorCode
  readonly baseMinDamage: number
  readonly minDamage: number
  readonly baseMaxDamage: number
  readonly maxDamage: number
  readonly damageColor: D2ColorCode
  readonly baseDefense: number
  readonly defense: number
  readonly defenseColor: D2ColorCode
  readonly baseAttackRating: number
  readonly attackRating: number
  readonly baseFireResist: number
  readonly fireResist: number
  readonly maxFireResist: number
  readonly fireResistColor: D2ColorCode
  readonly baseColdResist: number
  readonly coldResist: number
  readonly maxColdResist: number
  readonly coldResistColor: D2ColorCode
  readonly baseLightResist: number
  readonly lightResist: number
  readonly maxLightResist: number
  readonly lightResistColor: D2ColorCode
  readonly basePoisonResist: number
  readonly poisonResist: number
  readonly maxPoisonResist: number
  readonly poisonResistColor: D2ColorCode
}

const DEFAULT_HIRELING_BY_CLASS: Readonly<Record<number, number>> = {
  271: 1, // Act 1 Rogue Scout (Normal Fire Arrow)
  338: 7, // Act 2 Desert Mercenary (Normal Combat)
  359: 19, // Act 3 Iron Wolf (Normal Cold)
  560: 25, // Act 5 Barbarian
  561: 25, // Act 5 Barbarian
}

function selectHirelingRecord(
  classId: number,
  difficulty: 0 | 1 | 2,
  mlvl: number,
  explicitSubTypeId?: number,
): HirelingRecord | null {
  if (explicitSubTypeId !== undefined) {
    const exact = HIRELING_RECORDS.find((r) => r.subTypeId === explicitSubTypeId && r.version === 100)
    if (exact) return exact
  }
  const diffNum = difficulty + 1 // 1 = Normal, 2 = Nightmare, 3 = Hell
  const candidates = HIRELING_RECORDS.filter(
    (r) =>
      r.version === 100 &&
      (r.classId === classId || (classId === 560 && r.classId === 561)) &&
      r.difficulty === diffNum,
  )
  const pool =
    candidates.length > 0
      ? candidates
      : HIRELING_RECORDS.filter(
          (r) => r.version === 100 && (r.classId === classId || (classId === 560 && r.classId === 561)),
        )
  if (pool.length === 0) {
    const fallbackId = DEFAULT_HIRELING_BY_CLASS[classId]
    return fallbackId ? (HIRELING_RECORDS.find((r) => r.subTypeId === fallbackId) ?? null) : null
  }
  let chosen = pool[0]!
  for (const r of pool) {
    if (r.level <= mlvl && r.level >= chosen.level) {
      chosen = r
    }
  }
  return chosen
}

function resolveMercStatColor(current: number, base: number): D2ColorCode {
  if (current > base) return 'blue'
  if (current < base) return 'red'
  return 'white'
}

function resolveMercResColor(displayed: number, maxCap: number, baseDisplayed: number): D2ColorCode {
  if (displayed >= maxCap) return 'gold'
  if (displayed < 0 || displayed < baseDisplayed) return 'red'
  if (displayed > baseDisplayed) return 'blue'
  return 'white'
}

/**
 * Computes full Diablo II v1.13c Mercenary attribute panel stats (`R1.8`) from `Hireling.txt`
 * 8th-precision scaling, equipped merc items (slots `1, 3, 4, 5`) + socketed children,
 * difficulty resistance penalty (`0 / -40 / -100`), and `lifePct` (`0..128` scale).
 */
export function computeEffectiveMercenaryStats(
  world: ClientWorld,
  lang: 'ENG' | 'CHI' = 'ENG',
): EffectiveMercenaryStats | null {
  const mercRaw = world.merc as any
  if (!mercRaw) return null

  const mercUnitForStats =
    mercRaw.mercId && typeof world.getUnit === 'function'
      ? world.getUnit('monster', mercRaw.mercId)
      : undefined
  const rawStatsMap: Map<number, number> =
    mercRaw.stats instanceof Map ? mercRaw.stats : new Map<number, number>()
  const readRawStat = (statId: number, propKey: string): number | undefined => {
    if (typeof mercRaw[propKey] === 'number' && Number.isFinite(mercRaw[propKey])) {
      return mercRaw[propKey]
    }
    if (mercUnitForStats?.stats && typeof mercUnitForStats.stats.has === 'function' && mercUnitForStats.stats.has(statId)) {
      const v = Number(mercUnitForStats.stats.get(statId))
      if (Number.isFinite(v)) return v
    }
    if (rawStatsMap.has(statId)) {
      const v = Number(rawStatsMap.get(statId))
      if (Number.isFinite(v)) return v
    }
    if (mercRaw.stats && typeof mercRaw.stats === 'object' && !(mercRaw.stats instanceof Map)) {
      if (typeof mercRaw.stats.has === 'function' && mercRaw.stats.has(statId)) {
        const v = Number(mercRaw.stats.get(statId))
        if (Number.isFinite(v)) return v
      }
      if (propKey in mercRaw.stats) {
        const v = Number(mercRaw.stats[propKey])
        if (Number.isFinite(v)) return v
      }
    }
    return undefined
  }

  const classId = Number(mercRaw.classId ?? 338)
  const rawExp = Number(readRawStat(13, 'experience') ?? mercRaw.exp ?? 0) || 0
  const explicitLevel = readRawStat(12, 'level')

  // Hireling record lookup (`Hireling.txt`)
  const prelimLevel = explicitLevel && explicitLevel > 0 ? explicitLevel : (world.self.level > 0 ? world.self.level : 1)
  const hireRec = selectHirelingRecord(
    classId,
    world.difficulty,
    prelimLevel,
    typeof mercRaw.hirelingId === 'number' ? mercRaw.hirelingId : undefined,
  )

  // Infer level from exp if not explicitly set (`expPerLvl * (L + 1) * L * L`)
  let mlvl = explicitLevel && explicitLevel > 0 ? explicitLevel : 0
  if (mlvl <= 0) {
    if (rawExp > 0 && hireRec && hireRec.expPerLvl > 0) {
      let inferred = 1
      for (let l = 1; l <= 98; l++) {
        const thresh = hireRec.expPerLvl * (l + 1) * l * l
        if (rawExp >= thresh) inferred = l
        else break
      }
      mlvl = inferred
    } else {
      mlvl = Math.max(1, hireRec?.level ?? (world.self.level > 0 ? world.self.level : 1))
    }
  }

  const finalRec = selectHirelingRecord(
    classId,
    world.difficulty,
    mlvl,
    typeof mercRaw.hirelingId === 'number' ? mercRaw.hirelingId : undefined,
  ) ?? hireRec

  const nextLevelXp =
    finalRec && finalRec.expPerLvl > 0 && mlvl < 98
      ? finalRec.expPerLvl * (mlvl + 2) * (mlvl + 1) * (mlvl + 1)
      : 0

  const deltaLvl = finalRec ? Math.max(0, mlvl - finalRec.level) : 0
  const tableBaseHp = finalRec ? finalRec.hp + Math.floor((deltaLvl * finalRec.hpPerLvl) / 8) : 100
  const tableBaseStr = finalRec ? finalRec.str + Math.floor((deltaLvl * finalRec.strPerLvl) / 8) : 0
  const tableBaseDex = finalRec ? finalRec.dex + Math.floor((deltaLvl * finalRec.dexPerLvl) / 8) : 0
  const tableBaseDef = finalRec ? finalRec.defense + Math.floor((deltaLvl * finalRec.defPerLvl) / 8) : 0
  const tableBaseAr = finalRec ? finalRec.ar + Math.floor((deltaLvl * finalRec.arPerLvl) / 8) : 0
  const tableBaseMinDmg = finalRec ? finalRec.dmgMin + Math.floor((deltaLvl * finalRec.dmgPerLvl) / 8) : 1
  const tableBaseMaxDmg = finalRec ? finalRec.dmgMax + Math.floor((deltaLvl * finalRec.dmgPerLvl) / 8) : 2
  const tableBaseResist = finalRec ? finalRec.resist + Math.floor((deltaLvl * finalRec.resistPerLvl) / 8) : 0

  const rawMaxHpStat = readRawStat(7, 'maxLife') ?? readRawStat(7, 'maxHp')
  const normServerMaxHp =
    rawMaxHpStat !== undefined && rawMaxHpStat > 0 ? normalizeItemPoolStat(rawMaxHpStat) : 0
  const baseMaxHp = Math.max(tableBaseHp, normServerMaxHp)
  const baseStr = Math.max(tableBaseStr, readRawStat(0, 'strength') ?? 0)
  const baseDex = Math.max(tableBaseDex, readRawStat(2, 'dexterity') ?? 0)

  // Collect merc equipped items (slots 1=head, 3=torso, 4=rightHand, 5=leftHand)
  const findMercSlot = (slotNum: number): ItemData | undefined => {
    const bySlot = world.containers.mercBySlot?.get(slotNum) ?? world.containers.merc.get(slotNum)
    if (bySlot && (bySlot.bodyLoc || bySlot.equippedSlot || slotNum) === slotNum) return bySlot
    for (const it of world.containers.merc.values()) {
      if ((it.bodyLoc || it.equippedSlot) === slotNum) return it
    }
    return undefined
  }

  const mercSlots: Array<{ readonly slot: number; readonly item: ItemData }> = []
  for (const s of [1, 3, 4, 5]) {
    const it = findMercSlot(s)
    if (it && isItemUsable(it)) mercSlots.push({ slot: s, item: it })
  }

  let addStr = 0
  let addDex = 0
  let addVit = 0
  let flatHp = 0
  let maxHpPct = 0
  let pieceArmorDef = 0
  let flatDef = 0
  let defPct = 0
  let flatAr = 0
  let arPct = 0
  let fireResAdd = readRawStat(39, 'fireResist') ?? 0
  let lightResAdd = readRawStat(41, 'lightResist') ?? 0
  let coldResAdd = readRawStat(43, 'coldResist') ?? 0
  let poisResAdd = readRawStat(45, 'poisonResist') ?? 0
  let maxFireAdd = 0
  let maxLightAdd = 0
  let maxColdAdd = 0
  let maxPoisAdd = 0
  let offWeapEdPct = 0
  let globalMinDmg = 0
  let globalMaxDmg = 0
  let elemDmgMin = 0
  let elemDmgMax = 0
  let mercW1: WeaponHandSummary | null = null
  let mercW2: WeaponHandSummary | null = null

  for (const { slot, item } of mercSlots) {
    const code = (item.code ?? '').trim().toLowerCase()
    const kind = getItemKind(code)
    const extracted = extractItemAndSocketStats(item, getSocketChildrenForItem(world, item), slot)

    if (kind === 'armor') {
      const defPerLvl = Math.floor((extracted.localDefPerLevel8ths * mlvl) / 8)
      const enh =
        extracted.localEdPct > 0
          ? Math.floor(((extracted.baseArmorDefense + 1) * (100 + extracted.localEdPct)) / 100)
          : Math.floor((extracted.baseArmorDefense * (100 + extracted.localEdPct)) / 100)
      pieceArmorDef += Math.max(0, enh + extracted.localFlatDefense + defPerLvl)
    }

    if (kind === 'weapon' && (slot === 4 || slot === 5)) {
      const wSum = buildWeaponHandSummary(item, extracted.itemStats)
      if (slot === 4) mercW1 = wSum
      else mercW2 = wSum
    }

    for (const st of extracted.itemStats) {
      switch (st.statId) {
        case 0:
          addStr += st.value
          break
        case 2:
          addDex += st.value
          break
        case 3:
          addVit += st.value
          break
        case 222:
          addStr += Math.floor((st.value * mlvl) / 8)
          break
        case 223:
          addDex += Math.floor((st.value * mlvl) / 8)
          break
        case 224:
          addVit += Math.floor((st.value * mlvl) / 8)
          break
        case 7:
          flatHp += normalizeItemPoolStat(st.value)
          break
        case 76:
          maxHpPct += st.value
          break
        case 216:
          flatHp += Math.floor((st.value * mlvl) / 8)
          break
        case 16:
          if (kind !== 'armor') defPct += st.value
          break
        case 31:
          if (kind !== 'armor') flatDef += st.value
          break
        case 214:
          if (kind !== 'armor') flatDef += Math.floor((st.value * mlvl) / 8)
          break
        case 19:
          flatAr += st.value
          break
        case 119:
          arPct += st.value
          break
        case 220:
          flatAr += Math.floor((st.value * mlvl) / 8)
          break
        case 221:
          arPct += Math.floor((st.value * mlvl) / 8)
          break
        case 39:
          fireResAdd += st.value
          break
        case 40:
          maxFireAdd += st.value
          break
        case 41:
          lightResAdd += st.value
          break
        case 42:
          maxLightAdd += st.value
          break
        case 43:
          coldResAdd += st.value
          break
        case 44:
          maxColdAdd += st.value
          break
        case 45:
          poisResAdd += st.value
          break
        case 46:
          maxPoisAdd += st.value
          break
        case 17:
        case 18:
        case 25:
          if (kind !== 'weapon') {
            if (st.statId === 18 && extracted.itemStats.some((o) => o.statId === 17)) break
            offWeapEdPct += st.value
          }
          break
        case 21:
        case 23:
          if (kind !== 'weapon') {
            if (st.statId === 23 && extracted.itemStats.some((o) => o.statId === 21)) break
            globalMinDmg += st.value
          }
          break
        case 22:
        case 24:
          if (kind !== 'weapon') {
            if (st.statId === 24 && extracted.itemStats.some((o) => o.statId === 22)) break
            globalMaxDmg += st.value
          }
          break
        case 48:
        case 50:
        case 52:
        case 54:
          elemDmgMin += st.value
          break
        case 49:
        case 51:
        case 53:
        case 55:
          elemDmgMax += st.value
          break
      }
    }
  }

  // Merc unit state stats (e.g. Battle Orders state 32, Shout state 26, Defiance state 39, Might state 33, Fade state 159)
  const mercUnit = mercRaw.mercId ? world.getUnit('monster', mercRaw.mercId) : undefined
  if (mercUnit?.states.has(32) || world.self.states.has(32)) {
    const boLvl = Math.max(1, world.self.skills.get(149) ?? 1)
    if (mercUnit?.states.has(32)) maxHpPct += 50 + 3 * (boLvl - 1)
  }
  if (mercUnit?.states.has(26)) {
    const shoutLvl = Math.max(1, world.self.skills.get(138) ?? 1)
    defPct += 100 + 10 * (shoutLvl - 1)
  }
  if (mercUnit?.states.has(39)) {
    defPct += 70
  }
  let fadeRes = 0
  if (mercUnit?.states.has(159)) {
    fadeRes = 60
  }

  const str = Math.max(0, baseStr + addStr)
  const dex = Math.max(0, baseDex + addDex)
  const maxHp = Math.max(1, Math.floor(((baseMaxHp + flatHp) * (100 + maxHpPct)) / 100) + addVit * 2)

  // Merc lifePct is on a 0..128 scale in D2GS (0x7F / 0x0C / 0xAC)
  const rawLifePct = typeof mercRaw.lifePct === 'number' ? mercRaw.lifePct : 128
  const explicitLife = readRawStat(6, 'life') ?? readRawStat(6, 'hp')
  const normExplicitLife =
    explicitLife !== undefined ? normalizeItemPoolStat(explicitLife) : undefined
  const hp = mercRaw.isDead
    ? 0
    : normExplicitLife !== undefined && normExplicitLife > 0
      ? Math.min(maxHp, normExplicitLife)
      : Math.max(0, Math.min(maxHp, Math.round((Math.max(0, rawLifePct) / 128) * maxHp)))

  // Defense
  const explicitMercDef = readRawStat(31, 'defense') ?? 0
  const baseDefense = Math.max(
    explicitMercDef,
    tableBaseDef + Math.floor(baseDex / 4),
  )
  const rawTotalMercDef =
    Math.max(explicitMercDef, tableBaseDef) +
    Math.floor(dex / 4) +
    pieceArmorDef +
    flatDef
  const defense = Math.max(0, Math.floor((rawTotalMercDef * (100 + defPct)) / 100))

  // Attack Rating
  const baseAttackRating = tableBaseAr + baseDex * 5
  const attackRating = Math.max(
    0,
    Math.floor(((tableBaseAr + dex * 5 + flatAr) * (100 + arPct)) / 100),
  )

  // Damage
  const explicitMinDmg = readRawStat(21, 'minDamage') ?? readRawStat(21, 'damageMin') ?? 0
  const explicitMaxDmg = readRawStat(22, 'maxDamage') ?? readRawStat(22, 'damageMax') ?? 0
  const baseMinDamage = Math.max(tableBaseMinDmg, explicitMinDmg)
  const baseMaxDamage = Math.max(tableBaseMaxDmg, explicitMaxDmg)

  const primaryW = mercW1 ?? mercW2
  let wAddedMin = 0
  let wAddedMax = 0
  if (primaryW && primaryW.isWeapon) {
    const use2H =
      primaryW.isTwoHanded &&
      (!primaryW.isOneOrTwoHanded || (classId !== 560 && classId !== 561) || !mercW2)
    const rawWMin = use2H && primaryW.maxDam2H > 0 ? primaryW.minDam2H : primaryW.minDam1H
    const rawWMax = use2H && primaryW.maxDam2H > 0 ? primaryW.maxDam2H : primaryW.maxDam1H
    const lFlatMin = use2H ? (primaryW.localMin2H || primaryW.localMin1H) : primaryW.localMin1H
    const lFlatMax = use2H ? (primaryW.localMax2H || primaryW.localMax1H) : primaryW.localMax1H
    const lEd = primaryW.localEdPct + Math.floor((primaryW.localMaxEdPerLevel8ths * mlvl) / 8)
    wAddedMin = Math.floor((rawWMin * (100 + lEd)) / 100) + lFlatMin
    wAddedMax =
      Math.floor((rawWMax * (100 + lEd)) / 100) +
      lFlatMax +
      Math.floor((primaryW.localMaxDamPerLevel8ths * mlvl) / 8)
  }

  const statDmgPct =
    primaryW?.isRanged
      ? dex
      : str
  const totalMercEdPct = statDmgPct + offWeapEdPct
  const computedMinDmg =
    Math.floor(((baseMinDamage + wAddedMin + globalMinDmg) * (100 + totalMercEdPct)) / 100) +
    elemDmgMin
  const computedMaxDmg =
    Math.floor(((baseMaxDamage + wAddedMax + globalMaxDmg) * (100 + totalMercEdPct)) / 100) +
    Math.max(elemDmgMin, elemDmgMax)

  const minDamage =
    explicitMinDmg > 0 && !primaryW && offWeapEdPct === 0 && elemDmgMin === 0
      ? explicitMinDmg
      : Math.max(baseMinDamage, computedMinDmg)
  const maxDamage =
    explicitMaxDmg > 0 && !primaryW && offWeapEdPct === 0 && elemDmgMax === 0
      ? explicitMaxDmg
      : Math.max(minDamage + 1, computedMaxDmg)

  // Resistances (`tableBaseResist` + difficulty penalty + gear/sockets/auras, clamped to `[-100, min(95, 75 + maxAdd)]`)
  const diffPenalty = RESIST_PENALTY_BY_DIFFICULTY[world.difficulty] ?? 0
  const maxFireResist = Math.min(95, 75 + maxFireAdd)
  const maxColdResist = Math.min(95, 75 + maxColdAdd)
  const maxLightResist = Math.min(95, 75 + maxLightAdd)
  const maxPoisonResist = Math.min(95, 75 + maxPoisAdd)

  const clampMercRes = (val: number, cap: number): number => Math.max(-100, Math.min(cap, val))
  const nakedRes = clampMercRes(tableBaseResist + diffPenalty, 75)
  const fireResist = clampMercRes(tableBaseResist + diffPenalty + fireResAdd + fadeRes, maxFireResist)
  const coldResist = clampMercRes(tableBaseResist + diffPenalty + coldResAdd + fadeRes, maxColdResist)
  const lightResist = clampMercRes(tableBaseResist + diffPenalty + lightResAdd + fadeRes, maxLightResist)
  const poisonResist = clampMercRes(tableBaseResist + diffPenalty + poisResAdd + fadeRes, maxPoisonResist)

  // Name resolution via `resolveHirelingName` when `nameId` is present (`D2Client.dll 0x6faf9783`)
  const normMercClassId = classId === 560 ? 561 : classId
  const rawMercClassId = Number(mercRaw.classId ?? mercRaw.hcIdx ?? 0)
  const resolvedTblName =
    typeof mercRaw.nameId === 'number' &&
    mercRaw.nameId >= 0 &&
    (rawMercClassId > 0 || mercRaw.nameId >= 1000)
      ? resolveHirelingName(normMercClassId, mercRaw.nameId, lang)
      : ''
  const isRealMercName = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && !s.startsWith('Mercenary #') && !s.startsWith('Merc #')
  const validTblName = isRealMercName(resolvedTblName) ? resolvedTblName : ''
  const rawNameZh = (mercRaw as { nameZh?: string }).nameZh
  const validRawNameZh = isRealMercName(rawNameZh) ? rawNameZh : ''
  const validRawNameEn = isRealMercName(mercRaw.name) ? mercRaw.name : ''
  const typeLabel =
    typeof mercRaw.nameId === 'number' && mercRaw.nameId > 0
      ? (lang === 'CHI' ? `佣兵 #${mercRaw.nameId}` : `Merc #${mercRaw.nameId}`)
      : mercRaw.mercId
        ? (lang === 'CHI' ? `佣兵 #${mercRaw.mercId}` : `Merc #${mercRaw.mercId}`)
        : (lang === 'CHI' ? '佣兵' : 'Mercenary')
  const name =
    lang === 'CHI'
      ? (validRawNameZh || validTblName || validRawNameEn || mercRaw.name || typeLabel)
      : (validRawNameEn || validTblName || mercRaw.name || typeLabel)

  return {
    name,
    hirelingRecord: finalRec,
    level: mlvl,
    experience: rawExp,
    nextLevelXp,
    hp,
    maxHp,
    lifePct: rawLifePct,
    baseStr,
    str,
    strColor: resolveMercStatColor(str, baseStr),
    baseDex,
    dex,
    dexColor: resolveMercStatColor(dex, baseDex),
    baseMinDamage,
    minDamage,
    baseMaxDamage,
    maxDamage,
    damageColor:
      minDamage > baseMinDamage || maxDamage > baseMaxDamage || elemDmgMax > 0
        ? 'blue'
        : minDamage < baseMinDamage
          ? 'red'
          : 'white',
    baseDefense,
    defense,
    defenseColor: resolveMercStatColor(defense, baseDefense),
    baseAttackRating,
    attackRating,
    baseFireResist: nakedRes,
    fireResist,
    maxFireResist,
    fireResistColor: resolveMercResColor(fireResist, maxFireResist, nakedRes),
    baseColdResist: nakedRes,
    coldResist,
    maxColdResist,
    coldResistColor: resolveMercResColor(coldResist, maxColdResist, nakedRes),
    baseLightResist: nakedRes,
    lightResist,
    maxLightResist,
    lightResistColor: resolveMercResColor(lightResist, maxLightResist, nakedRes),
    basePoisonResist: nakedRes,
    poisonResist,
    maxPoisonResist,
    poisonResistColor: resolveMercResColor(poisonResist, maxPoisonResist, nakedRes),
  }
}
