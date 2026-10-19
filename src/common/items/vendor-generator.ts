import { D2Rng } from '../rng/d2-rng.ts'
import type { DropTables } from './drop-tables.ts'
import { createDroppedItem, rollStaffMods } from './drop-tables.ts'
import { rollMagicAffixes, rollRareAffixes, getItemTypeCode } from './affix-generator.ts'
import { Inventory, ItemFlag, ItemQuality, type Item, type ItemBase, type RolledItemProp, decodeItemFlags, formatItemCode } from './items.ts'
import type { ItemQualityTier } from './item-ratio.ts'
import type { ItemTypeTable } from './item-types.ts'
import {
  VENDOR_COUNT,
  VendorNpcId,
  getTownNpcDescriptorByVendorId,
  type VendorItemColumns,
} from '../units/npc-table.ts'

/**
 * 1.13c Normal difficulty vendor item level caps per Act (Acts 1..5).
 * D2Game.dll `D2GAME_NPC_FillStoreInventory_6FCC7100`: `[12, 20, 28, 36, 45]`.
 */
export const NORMAL_ACT_VENDOR_ILVL_CAP: readonly [number, number, number, number, number] = [
  12, 20, 28, 36, 45,
] as const
export const VENDOR_NORMAL_ILVL_CAPS = NORMAL_ACT_VENDOR_ILVL_CAP

export type VendorTabKey = 'armor' | 'weapons1' | 'weapons2' | 'misc'
export type VendorTabId = VendorTabKey

export const VENDOR_TAB_KEYS: readonly VendorTabKey[] = [
  'armor',
  'weapons1',
  'weapons2',
  'misc',
] as const

export const VENDOR_GRID_WIDTH = 10
export const VENDOR_GRID_HEIGHT = 10

export interface VendorItemCacheEntry {
  readonly base: ItemBase
  readonly columns: VendorItemColumns
}

export interface GlobalVendorItemCache {
  /** Non-permanent rollable store items per VendorNpcId (0..16). */
  readonly itemCache: Readonly<Record<number, readonly VendorItemCacheEntry[]>>
  /** Permanent store items (`PermStoreItem == 1`) per VendorNpcId (0..16). */
  readonly permCache: Readonly<Record<number, readonly VendorItemCacheEntry[]>>
}

let _cachedGlobalVendorCache: WeakMap<DropTables, GlobalVendorItemCache> = new WeakMap()

/**
 * Builds the global per-vendor item cache (`D2GAME_NPC_BuildItemCache_6FCCA970`)
 * iterating Weapons.txt -> Armor.txt -> Misc.txt in exact MPQ row order.
 */
export function buildGlobalVendorItemCache(tables: DropTables): GlobalVendorItemCache {
  const existing = _cachedGlobalVendorCache.get(tables)
  if (existing) return existing

  const itemCache: Record<number, VendorItemCacheEntry[]> = {}
  const permCache: Record<number, VendorItemCacheEntry[]> = {}
  for (let vId = 0; vId < VENDOR_COUNT; vId++) {
    itemCache[vId] = []
    permCache[vId] = []
  }

  const allBases: ItemBase[] = [
    ...tables.weapons.all,
    ...tables.armor.all,
    ...tables.misc.all,
  ]

  for (const base of allBases) {
    if (!base.spawnable) continue
    const vCols = base.vendorColumns
    if (!vCols) continue

    for (let vId = 0; vId < VENDOR_COUNT; vId++) {
      const cols = vCols[vId]
      if (!cols) continue
      if (base.permStoreItem) {
        if (cols.min > 0 || cols.max > 0) {
          permCache[vId]!.push({ base, columns: cols })
        }
      } else {
        if (cols.max > 0 || cols.magicMax > 0) {
          itemCache[vId]!.push({ base, columns: cols })
        }
      }
    }
  }

  const built: GlobalVendorItemCache = { itemCache, permCache }
  _cachedGlobalVendorCache.set(tables, built)
  return built
}

/**
 * Resolves the effective vendor item level (`nItemLevel`) per `D2GAME_NPC_FillStoreInventory_6FCC7100`.
 *
 * - Base: `cLvl + 5` (clamped to `[1, 99]`).
 * - In Normal (`difficulty === 0`), clamped to Act cap `[12, 20, 28, 36, 45][actIndex]`.
 * - In Nightmare (`1`) and Hell (`2`), no Act cap is applied.
 */
export function computeVendorItemLevel(
  vendorId: VendorNpcId,
  difficulty: 0 | 1 | 2,
  cLvl: number,
  actIndex?: 0 | 1 | 2 | 3 | 4,
): number {
  let nItemLevel = Math.max(1, Math.min(99, Math.trunc(cLvl) + 5))
  if (difficulty === 0) {
    const resolvedAct =
      actIndex ?? getTownNpcDescriptorByVendorId(vendorId)?.actIndex ?? 0
    const cap = NORMAL_ACT_VENDOR_ILVL_CAP[resolvedAct] ?? 12
    if (nItemLevel > cap) {
      nItemLevel = cap
    }
  }
  return Math.max(1, nItemLevel)
}

/**
 * Resolves the store tab page (`'armo' | 'weap' | 'misc'`) for an item base
 * by traversing `ItemTypes.txt` (`StorePage` column).
 */
export function resolveStorePageForBase(
  base: ItemBase,
  itemTypes: ItemTypeTable,
): 'armo' | 'weap' | 'misc' {
  const startType = getItemTypeCode(base).trim()
  const queue: string[] = [startType, ...(base.tags ?? [])]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const code = queue.shift()!.trim()
    if (!code || visited.has(code.toLowerCase())) continue
    visited.add(code.toLowerCase())

    const def = itemTypes.byCode.get(code)
    if (!def) continue
    const sp = (def.storePage ?? '').toLowerCase()
    if (sp === 'armo' || sp === 'weap' || sp === 'misc') {
      return sp
    }
    if (def.equiv1) queue.push(def.equiv1)
    if (def.equiv2) queue.push(def.equiv2)
  }

  if (base.kind === 'armor') return 'armo'
  if (base.kind === 'weapon') return 'weap'
  return 'misc'
}

/**
 * Resolves Nightmare/Hell base item upgrade inside `D2GAME_NPC_GenerateStoreItem_6FCC6A60`.
 * Only runs when `cLvl > 25`.
 */
export function resolveVendorBaseUpgrade(
  base: ItemBase,
  cLvl: number,
  nItemLevel: number,
  difficulty: 0 | 1 | 2,
  isExpansion: boolean,
  tables: DropTables,
  rng: D2Rng,
): ItemBase {
  let selected = base
  if (cLvl <= 25) {
    return selected
  }

  if (difficulty === 1) {
    // Nightmare upgrade
    const nRand = rng.rand(100000)
    const nProb = (nItemLevel << 6) + 4000
    let upgradedToUber = false
    if (
      nRand < nProb &&
      selected.ubercode &&
      selected.ubercode !== selected.id &&
      selected.ubercode !== 'xxx'
    ) {
      const uberBase = tables.getBase(selected.ubercode)
      if (uberBase && uberBase.level <= nItemLevel) {
        selected = uberBase
        upgradedToUber = true
      }
    }
    if (
      !upgradedToUber &&
      selected.nightmareUpgrade &&
      selected.nightmareUpgrade !== 'xxx'
    ) {
      const upgBase = tables.getBase(selected.nightmareUpgrade)
      if (upgBase && upgBase.level <= nItemLevel) {
        selected = upgBase
      }
    }
  } else if (difficulty === 2) {
    // Hell upgrade
    const nRand = rng.rand(100000)
    let upgradedTier = false
    if (isExpansion) {
      const nUltraProb = 16 * nItemLevel + 1000
      if (
        nRand < nUltraProb &&
        selected.ultracode &&
        selected.ultracode !== selected.id &&
        selected.ultracode !== 'xxx'
      ) {
        const ultraBase = tables.getBase(selected.ultracode)
        if (ultraBase && ultraBase.level <= nItemLevel) {
          selected = ultraBase
          upgradedTier = true
        }
      }
    }
    if (!upgradedTier) {
      const nUberProb = (nItemLevel << 7) + 5000
      if (
        nRand < nUberProb &&
        selected.ubercode &&
        selected.ubercode !== selected.id &&
        selected.ubercode !== 'xxx'
      ) {
        const uberBase = tables.getBase(selected.ubercode)
        if (uberBase && uberBase.level <= nItemLevel) {
          selected = uberBase
          upgradedTier = true
        }
      }
    }
    if (selected.hellUpgrade && selected.hellUpgrade !== 'xxx') {
      const upgBase = tables.getBase(selected.hellUpgrade)
      if (upgBase && upgBase.level <= nItemLevel) {
        selected = upgBase
      }
    }
  }

  return selected
}

/**
 * Generates a single store item instance (`D2GAME_NPC_GenerateStoreItem_6FCC6A60`).
 */
export function generateVendorStoreItem(options: {
  readonly base: ItemBase
  readonly vendorId: VendorNpcId
  readonly qualityTier: ItemQualityTier
  readonly cLvl: number
  readonly nItemLevel: number
  readonly difficulty: 0 | 1 | 2
  readonly isExpansion?: boolean
  readonly permStore: boolean
  readonly tables: DropTables
  readonly rng: D2Rng
}): Item | null {
  const {
    base,
    vendorId,
    qualityTier,
    cLvl,
    nItemLevel,
    difficulty,
    isExpansion = true,
    permStore,
    tables,
    rng,
  } = options

  // Never generate quest items in vendor stores
  if (base.quest && base.quest > 0) {
    return null
  }
  if (!isExpansion && (base as any).version >= 100) {
    return null
  }

  const selectedBase = resolveVendorBaseUpgrade(
    base,
    cLvl,
    nItemLevel,
    difficulty,
    isExpansion,
    tables,
    rng,
  )

  if (!isExpansion && (selectedBase as any).version >= 100) {
    return null
  }

  const dwInitSeed = rng.rand(0x7fffffff) >>> 0
  const itemRng = new D2Rng(dwInitSeed || 1)

  const magicLvl = base.vendorColumns?.[vendorId]?.magicLvl ?? 255
  const rawAffixIlvl =
    magicLvl > 0 && magicLvl < 255 ? Math.min(nItemLevel, magicLvl) : nItemLevel
  // Ensure effective ilvl passed to rollMagicAffixes yields alvl >= 1 even when base qlvl > rawAffixIlvl
  const minIlvlForAlvl1 = Math.trunc((selectedBase.level ?? 1) / 2) + 1
  const effectiveAffixIlvl = Math.max(rawAffixIlvl, minIlvlForAlvl1, 1)

  const magicAffixes =
    qualityTier === 'magic'
      ? rollMagicAffixes(
          selectedBase,
          effectiveAffixIlvl,
          tables.magicAffixes,
          tables.isA,
          itemRng,
        )
      : undefined

  const staffMods =
    selectedBase.kind === 'weapon' || selectedBase.kind === 'armor'
      ? rollStaffMods(selectedBase, nItemLevel, tables.itemTypes, itemRng)
      : undefined

  // Roll sockets for normal/superior/low weapons and armor (never ethereal in vendor stores)
  let sockets = 0
  if (
    (selectedBase.kind === 'weapon' || selectedBase.kind === 'armor') &&
    (qualityTier === 'normal' || qualityTier === 'superior' || qualityTier === 'low')
  ) {
    const baseMaxSockets = Number((selectedBase as any).gemsockets) || 0
    if (baseMaxSockets > 0) {
      const typeCode = getItemTypeCode(selectedBase).trim().toLowerCase()
      const def = tables.itemTypes.byCode.get(typeCode)
      const typeMaxSockets = def
        ? nItemLevel >= 40
          ? def.maxSock40
          : nItemLevel >= 25
            ? def.maxSock25
            : def.maxSock1
        : baseMaxSockets
      const maxAllowed = Math.min(baseMaxSockets, typeMaxSockets)
      if (maxAllowed > 0 && itemRng.rand(3) === 0) {
        sockets = itemRng.randRange(1, maxAllowed)
      }
    }
  }

  const created = createDroppedItem(selectedBase, qualityTier, {
    magicAffixes,
    staffMods,
    ethereal: false,
    sockets,
    itemTypes: tables.itemTypes,
    ilvl: nItemLevel,
    dwInitSeed,
    itemRng,
    identified: true,
  })

  // Roll authentic armor defense in [minac, maxac] (or maxac + 1 if enhanced defense)
  let defense = created.defense
  if (selectedBase.kind === 'armor') {
    const minac = Number((selectedBase as any).minac) || selectedBase.defense
    const maxac = Number((selectedBase as any).maxac) || selectedBase.defense
    const acPct = created.stats['ac%'] ?? 0
    if (acPct > 0) {
      defense = Math.trunc(((maxac + 1) * (100 + acPct)) / 100)
    } else if (qualityTier === 'low') {
      const rawAc = minac < maxac ? itemRng.randRange(minac, maxac) : maxac
      defense = Math.max(1, Math.trunc((rawAc * 75) / 100))
    } else {
      defense = minac < maxac ? itemRng.randRange(minac, maxac) : maxac
    }
  }

  // Stack / quantity handling for permanent store items, quivers, throwing weapons, and tomes
  let stack = created.stack
  const codeLower = selectedBase.id.toLowerCase()
  const typeLower = (selectedBase.type ?? '').toLowerCase()
  if (permStore && (typeLower === 'bowq' || typeLower === 'xbowq' || codeLower === 'aqv' || codeLower === 'cqv')) {
    stack = selectedBase.maxStack > 1 ? selectedBase.maxStack : 350
  } else if (codeLower === 'tbk' || codeLower === 'ibk') {
    stack = Number((selectedBase as any).spawnstack) || 3
  } else if ((selectedBase as any).stackable) {
    const minStack = Number((selectedBase as any).minstack) || 1
    const maxStack = Number((selectedBase as any).maxstack) || selectedBase.maxStack || 1
    const spawnStack = Number((selectedBase as any).spawnstack) || maxStack
    stack = permStore ? maxStack : Math.max(minStack, Math.min(maxStack, spawnStack))
  }

  return {
    ...created,
    ...(defense !== undefined ? { defense, stats: { ...created.stats, defense } } : {}),
    stack,
    quantity: stack,
    permStore,
  }
}

export interface VendorStoreState {
  readonly vendorId: VendorNpcId
  readonly difficulty: 0 | 1 | 2
  readonly cLvl: number
  readonly nItemLevel: number
  readonly tabs: Readonly<Record<VendorTabKey, Inventory>>
  readonly allItems: readonly Item[]
}

/**
 * Places an item into the appropriate vendor tab (`armor`, `weapons1` -> overflow `weapons2`, `misc`).
 */
export function addItemToVendorTabs(
  tabs: Readonly<Record<VendorTabKey, Inventory>>,
  item: Item,
  itemTypes: ItemTypeTable,
): { readonly tab: VendorTabKey; readonly x: number; readonly y: number } | null {
  const storePage = resolveStorePageForBase(item.base, itemTypes)
  if (storePage === 'armo') {
    const pos = tabs.armor.add(item)
    return pos ? { tab: 'armor', ...pos } : null
  }
  if (storePage === 'weap') {
    const pos1 = tabs.weapons1.add(item)
    if (pos1) return { tab: 'weapons1', ...pos1 }
    const pos2 = tabs.weapons2.add(item)
    if (pos2) return { tab: 'weapons2', ...pos2 }
    return null
  }
  const posMisc = tabs.misc.add(item)
  return posMisc ? { tab: 'misc', ...posMisc } : null
}

/**
 * Generates the complete 4-tab 10x10 store inventory for a vendor (`D2GAME_NPC_FillStoreInventory_6FCC7100`).
 */
export function generateVendorStoreInventory(options: {
  readonly vendorId: VendorNpcId
  readonly difficulty: 0 | 1 | 2
  readonly cLvl: number
  readonly actIndex?: 0 | 1 | 2 | 3 | 4 | undefined
  readonly isExpansion?: boolean | undefined
  readonly tables: DropTables
  readonly rng?: D2Rng | undefined
  readonly seed?: number | undefined
}): VendorStoreState {
  const {
    vendorId,
    difficulty,
    cLvl,
    actIndex,
    isExpansion = true,
    tables,
  } = options
  const rng = options.rng ?? new D2Rng(options.seed ?? ((vendorId + 1) * 0x9e3779b9 + cLvl * 131 + difficulty * 997))

  const nItemLevel = computeVendorItemLevel(vendorId, difficulty, cLvl, actIndex)
  const cache = buildGlobalVendorItemCache(tables)

  const tabs: Record<VendorTabKey, Inventory> = {
    armor: new Inventory(VENDOR_GRID_WIDTH, VENDOR_GRID_HEIGHT),
    weapons1: new Inventory(VENDOR_GRID_WIDTH, VENDOR_GRID_HEIGHT),
    weapons2: new Inventory(VENDOR_GRID_WIDTH, VENDOR_GRID_HEIGHT),
    misc: new Inventory(VENDOR_GRID_WIDTH, VENDOR_GRID_HEIGHT),
  }

  const allItems: Item[] = []

  const nonPermEntries = cache.itemCache[vendorId] ?? []
  for (const entry of nonPermEntries) {
    const { base, columns } = entry
    if (base.level > nItemLevel) {
      continue
    }

    // 1. Normal / Inferior / Superior roll (ONLY when nItemLevel < 25 and nMax > 0)
    if (nItemLevel < 25 && columns.max > 0) {
      const range = columns.max - columns.min + 1
      const count = columns.min + (range > 0 ? rng.rand(range) : 0)
      for (let i = 0; i < count; i++) {
        const qRoll = rng.rand(100)
        let qTier: ItemQualityTier = 'normal'
        if (nItemLevel < 5) {
          if (qRoll > 90) qTier = 'low'
        } else if (nItemLevel < 10) {
          if (qRoll > 85) qTier = 'superior'
        } else {
          if (qRoll >= 75) qTier = 'superior'
        }

        const item = generateVendorStoreItem({
          base,
          vendorId,
          qualityTier: qTier,
          cLvl,
          nItemLevel,
          difficulty,
          isExpansion,
          permStore: false,
          tables,
          rng,
        })
        if (item) {
          const placed = addItemToVendorTabs(tabs, item, tables.itemTypes)
          if (placed) allItems.push(item)
        }
      }
    }

    // 2. Magic item roll (when magicMax > 0 and (bitfield1 & 1) !== 0)
    const bitfield1 = base.bitfield1 ?? 0
    if (columns.magicMax > 0 && (bitfield1 & 1) !== 0) {
      const nMinItems = nItemLevel >= 25 ? rng.rand(2) + 2 : 1
      const nRange = nMinItems + columns.magicMax - columns.magicMin
      const nMagicCount =
        nRange > 0 ? columns.magicMin + rng.rand(nRange) : columns.magicMin
      for (let i = 0; i < nMagicCount; i++) {
        const item = generateVendorStoreItem({
          base,
          vendorId,
          qualityTier: 'magic',
          cLvl,
          nItemLevel,
          difficulty,
          isExpansion,
          permStore: false,
          tables,
          rng,
        })
        if (item) {
          const placed = addItemToVendorTabs(tabs, item, tables.itemTypes)
          if (placed) allItems.push(item)
        }
      }
    }
  }

  // Step 2: Permanent store items (`pPermCache`)
  const permEntries = cache.permCache[vendorId] ?? []
  for (const entry of permEntries) {
    const { base } = entry
    const item = generateVendorStoreItem({
      base,
      vendorId,
      qualityTier: 'normal',
      cLvl,
      nItemLevel,
      difficulty,
      isExpansion,
      permStore: true,
      tables,
      rng,
    })
    if (item) {
      const placed = addItemToVendorTabs(tabs, item, tables.itemTypes)
      if (placed) allItems.push(item)
    }
  }

  return {
    vendorId,
    difficulty,
    cLvl,
    nItemLevel,
    tabs,
    allItems,
  }
}

/**
 * Generates a 10x10 Gamble inventory (`D2GAME_NPC_FillGamble_6FCC73E0`)
 * from `Gamble.txt` for a given character level `cLvl`.
 */
export function generateGambleInventory(options: {
  readonly vendorId: VendorNpcId
  readonly cLvl: number
  readonly isExpansion?: boolean | undefined
  readonly tables: DropTables
  readonly rng?: D2Rng | undefined
  readonly seed?: number | undefined
}): Inventory {
  const { cLvl, isExpansion = true, tables } = options
  const rng = options.rng ?? new D2Rng(options.seed ?? (cLvl * 2654435761 + 17))
  const grid = new Inventory(VENDOR_GRID_WIDTH, VENDOR_GRID_HEIGHT)

  const gambleCodes = tables.gambleCodes ?? []
  const maxBaseLvl = Math.max(1, cLvl + 4)
  const candidates: ItemBase[] = []
  for (const code of gambleCodes) {
    const base = tables.getBase(code)
    if (!base) continue
    if (!isExpansion && (base as any).version >= 100) continue
    if (base.level <= maxBaseLvl) {
      candidates.push(base)
    }
  }

  if (candidates.length === 0) {
    return grid
  }

  // Always guarantee Ring ('rin') and Amulet ('amu') are included in Gamble inventory per 1.13c
  const rinBase = tables.getBase('rin')
  const amuBase = tables.getBase('amu')
  const priorityBases: ItemBase[] = [rinBase, amuBase].filter((b): b is ItemBase => Boolean(b))

  const targetCount = 14
  const usedCodes = new Set<string>()
  let placedCount = 0
  let attempts = 0

  while (placedCount < targetCount && attempts < 80) {
    attempts++
    const base =
      placedCount < priorityBases.length
        ? priorityBases[placedCount]!
        : candidates[rng.rand(candidates.length)]!
    if (usedCodes.has(base.id) && attempts < 40 && placedCount >= priorityBases.length) {
      continue
    }
    const dwInitSeed = rng.rand(0x7fffffff) >>> 0
    const rawFlags = ItemFlag.GAMBLE
    const ilvl = Math.max(5, Math.min(99, Math.trunc(cLvl) + rng.rand(10) - 5))
    const mysteryItem: Item = {
      base,
      prefix: null,
      suffix: null,
      level: ilvl,
      ilvl,
      name: base.name,
      stats: {
        ...(base.damage > 0 ? { damage: base.damage } : {}),
        ...(base.defense > 0 ? { defense: base.defense } : {}),
      },
      invWidth: base.invWidth,
      invHeight: base.invHeight,
      stack: 1,
      value: base.gambleCost ?? base.value,
      rawFlags,
      flags: decodeItemFlags(rawFlags),
      version: 0x65,
      code: formatItemCode(base.id),
      quality: ItemQuality.MAGIC,
      rarity: 'magic',
      uniqueId: dwInitSeed,
      isGambleMystery: true,
      identified: false,
    }

    const pos = grid.add(mysteryItem)
    if (pos) {
      usedCodes.add(base.id)
      placedCount++
    }
  }

  return grid
}

/**
 * Resolves a purchased mystery Gamble item into its revealed Magic / Rare / Set / Unique item
 * per 1.13c `D2GAME_NPC_CreateGambleItem`:
 * - `ilvl = clamp(cLvl + rand(10) - 5, 5, 99)` (`[cLvl - 5, cLvl + 4]`)
 * - Exceptional (`ubercode`) chance: `(ilvl - qlvl_uber) * 90 + 100` out of `10000`
 * - Elite (`ultracode`) chance: `(ilvl - qlvl_ultra) * 33 + 100` out of `10000`
 * - Quality roll (out of `100000`):
 *   - Unique: `50` (`0.05%`, 1 in 2000)
 *   - Set: `100` (`0.10%`, 1 in 1000)
 *   - Rare: `10000` (`10.0%`, 1 in 10)
 *   - Magic: `89850` (`89.85%`)
 */
export function resolveGambledItem(options: {
  readonly mysteryItem: Item
  readonly cLvl: number
  readonly isExpansion?: boolean | undefined
  readonly tables: DropTables
  readonly rng?: D2Rng | undefined
}): Item {
  const { mysteryItem, cLvl, isExpansion = true, tables } = options
  const rng = options.rng ?? new D2Rng((mysteryItem.uniqueId ?? 1) ^ (cLvl * 0x45d9f3b))

  const ilvl = Math.max(5, Math.min(99, Math.trunc(cLvl) + rng.rand(10) - 5))
  const normBase = mysteryItem.base
  let selectedBase: ItemBase = normBase

  const uberBase =
    normBase.ubercode && normBase.ubercode !== normBase.id && normBase.ubercode !== 'xxx'
      ? tables.getBase(normBase.ubercode)
      : undefined
  const ultraBase =
    isExpansion &&
    normBase.ultracode &&
    normBase.ultracode !== normBase.id &&
    normBase.ultracode !== 'xxx'
      ? tables.getBase(normBase.ultracode)
      : undefined

  const chanceUltra =
    ultraBase && ilvl >= ultraBase.level ? (ilvl - ultraBase.level) * 33 + 100 : 0
  const chanceUber =
    uberBase && ilvl >= uberBase.level ? (ilvl - uberBase.level) * 90 + 100 : 0

  const upgRoll = rng.rand(10000)
  if (chanceUltra > 0 && upgRoll < chanceUltra && ultraBase) {
    selectedBase = ultraBase
  } else if (chanceUber > 0 && upgRoll < chanceUber && uberBase) {
    selectedBase = uberBase
  }

  const qRoll = rng.rand(100000)
  let qualityTier: ItemQualityTier = 'magic'
  let uniqueItem = undefined
  let setItem = undefined

  if (qRoll < 50) {
    // Try Unique (0.05%)
    const candidates = tables.uniques.byCode.get(selectedBase.id)?.filter(
      u => u.enabled && u.lvl <= ilvl && (isExpansion || u.version < 100),
    )
    if (candidates && candidates.length > 0) {
      qualityTier = 'unique'
      uniqueItem = candidates[rng.rand(candidates.length)]
    } else {
      qualityTier = 'rare'
    }
  } else if (qRoll < 150) {
    // Try Set (0.10%)
    const candidates = tables.sets.items.entries.filter(
      s =>
        s.item.toLowerCase() === selectedBase.id.toLowerCase() &&
        s.lvl <= ilvl,
    )
    if (candidates.length > 0) {
      qualityTier = 'set'
      setItem = candidates[rng.rand(candidates.length)]
    } else {
      qualityTier = 'rare'
    }
  } else if (qRoll < 10150) {
    qualityTier = 'rare'
  } else {
    qualityTier = 'magic'
  }

  const dwInitSeed = rng.rand(0x7fffffff) >>> 0
  const itemRng = new D2Rng(dwInitSeed || 1)

  const rareAffixes =
    qualityTier === 'rare'
      ? rollRareAffixes(
          selectedBase,
          ilvl,
          tables.magicAffixes,
          tables.rareNames,
          tables.isA,
          itemRng,
        )
      : undefined

  const magicAffixes =
    qualityTier === 'magic'
      ? rollMagicAffixes(
          selectedBase,
          ilvl,
          tables.magicAffixes,
          tables.isA,
          itemRng,
        )
      : undefined

  const staffMods: RolledItemProp[] | undefined =
    selectedBase.kind === 'weapon' || selectedBase.kind === 'armor'
      ? rollStaffMods(selectedBase, ilvl, tables.itemTypes, itemRng)
      : undefined

  const created = createDroppedItem(selectedBase, qualityTier, {
    uniqueItem,
    setItem,
    rareAffixes,
    magicAffixes,
    staffMods,
    ethereal: false,
    sockets: 0,
    itemTypes: tables.itemTypes,
    ilvl,
    dwInitSeed,
    itemRng,
    identified: true,
  })

  return {
    ...created,
    isGambleMystery: false,
    identified: true,
  }
}
