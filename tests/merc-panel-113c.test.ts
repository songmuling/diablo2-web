import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClientWorld } from '../src/client/world/client-world.ts'
import { HudManager } from '../src/client/ui/hud-manager.ts'
import { HudModel } from '../src/client/ui-model/hud-model.ts'
import { computeEffectiveMercenaryStats } from '../src/client/ui-model/derived-stats.ts'
import { WorldPanelsHud } from '../src/client/ui/world-panels.ts'
import { clearMissingArtEntries, getMissingArtEntries } from '../src/client/scene/world-renderer.ts'
import { BAKED_UI_MANIFEST } from '../src/common/items/baked-ui-meta.ts'

if (typeof globalThis.window === 'undefined') {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

function readPngDimensions(filePath: string): { width: number; height: number } {
  const buf = fs.readFileSync(filePath)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

function createRecordingCtx() {
  const drawnTexts: Array<{ text: string; x: number; y: number; font?: string }> = []
  const drawnImages: Array<{
    img: unknown
    args: number[]
    globalAlpha: number
  }> = []
  let fillRectCount = 0
  let currentAlpha = 1
  const ctx = {
    get globalAlpha() {
      return currentAlpha
    },
    set globalAlpha(val: number) {
      currentAlpha = val
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {
      currentAlpha = 1
    },
    fillRect() {
      fillRectCount++
    },
    strokeRect() {},
    clearRect() {},
    fillText(text: string, x: number, y: number) {
      drawnTexts.push({ text: String(text), x, y })
    },
    measureText(text: string) {
      return { width: String(text).length * 8 } as TextMetrics
    },
    drawImage(img: unknown, ...args: number[]) {
      drawnImages.push({ img, args, globalAlpha: currentAlpha })
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
  } as unknown as CanvasRenderingContext2D
  return {
    ctx,
    drawnTexts,
    drawnImages,
    get fillRectCount() {
      return fillRectCount
    },
  }
}

describe('Diablo II v1.13c Mercenary Screen (UI_DrawMercScreen @ 0x6fb4ae80)', () => {
  it('bakes authentic NPCInv.dc6 and empty slot silhouette PNGs with exact 1.13c dimensions', () => {
    const uiDir = path.resolve(__dirname, '../public/ui')
    const expected: Array<[string, string, number, number]> = [
      ['mercBg', 'merc-bg.png', 320, 432],
      ['invArmor', 'inv-armor.png', 54, 82],
      ['invHelmGlove', 'inv-helm-glove.png', 108, 53],
      ['invWeapons', 'inv-weapons.png', 54, 109],
    ]
    for (const [manifestKey, filename, width, height] of expected) {
      const fullPath = path.join(uiDir, filename)
      expect(fs.existsSync(fullPath)).toBe(true)
      const dims = readPngDimensions(fullPath)
      expect(dims.width).toBe(width)
      expect(dims.height).toBe(height)
      expect(BAKED_UI_MANIFEST.images[manifestKey]).toBe(`/ui/${filename}`)
    }
  })

  it('syncs Mercenary stats and equipped items from ClientWorld monster unit & merc container via HudModel', () => {
    const world = new ClientWorld()
    const hud = new HudManager()
    const commands: unknown[] = []
    const model = new HudModel({
      world,
      hudManager: hud,
      onCommand: (cmd) => commands.push(cmd),
    })

    // Assign player and Act 1 Rogue Scout mercenary (hcIdx 271, mercId 777)
    world.apply({
      type: 'PlayerAssign',
      unitId: 1,
      charClass: 1,
      name: 'Sorceress',
      x: 5100,
      y: 5100,
    })
    const mercUnit = (world as any).ensureUnit('monster', 777)
    mercUnit.classId = 271
    mercUnit.x = 5104
    mercUnit.y = 5104
    mercUnit.mode = 1
    mercUnit.stats.set(12, 10) // Level 10
    mercUnit.stats.set(6, 160 << 8) // HP 160
    mercUnit.stats.set(7, 200 << 8) // MaxHP 200

    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 777,
      classId: 271,
      nameId: 1,
    } as any)

    // Equip a helm in merc slot 1 and a bow in merc slot 4
    ;(world.containers.merc as Map<number, any>).set(1001, {
      id: 1001,
      code: 'cap',
      name: 'Cap',
      container: 'merc',
      bodyLoc: 1,
      equippedSlot: 1,
      width: 2,
      height: 2,
      quality: 2,
      identified: true,
      stats: [{ statId: 31, param: 0, value: 5 }],
    })
    ;(world.containers.mercBySlot as Map<number, any>).set(1, world.containers.merc.get(1001))

    ;(world.containers.merc as Map<number, any>).set(1004, {
      id: 1004,
      code: 'sbw',
      name: 'Short Bow',
      container: 'merc',
      bodyLoc: 4,
      equippedSlot: 4,
      width: 2,
      height: 3,
      quality: 2,
      identified: true,
      stats: [],
    })
    ;(world.containers.mercBySlot as Map<number, any>).set(4, world.containers.merc.get(1004))

    model.syncFromWorld()

    const wpMerc = hud.worldPanels.merc
    expect(wpMerc).not.toBeNull()
    expect(wpMerc.level).toBe(10)
    expect(wpMerc.hp).toBeGreaterThan(0)
    expect(wpMerc.maxHp).toBeGreaterThanOrEqual(wpMerc.hp)
    expect(wpMerc.nextExp).toBeGreaterThan(0)
    expect(wpMerc.headItem?.code).toBe('cap')
    expect(wpMerc.weaponItem?.code).toBe('sbw')
  })

  it('draws NPCInv.dc6 background, empty slot silhouettes, equipped sprites, 2H phantom, and font16->font6 overflow fallback', () => {
    const wp = new WorldPanelsHud()
    wp.setLanguage('en')

    const mercBgImg = { id: 'mercBg', width: 320, height: 432 } as unknown as HTMLImageElement
    const invHelmGloveImg = { id: 'invHelmGlove', width: 108, height: 53 } as unknown as HTMLImageElement
    const invArmorImg = { id: 'invArmor', width: 54, height: 82 } as unknown as HTMLImageElement
    const invWeaponsImg = { id: 'invWeapons', width: 54, height: 109 } as unknown as HTMLImageElement
    const buySellBtnImg = { id: 'buySellBtn', width: 512, height: 32 } as unknown as HTMLImageElement
    const itemsAtlasImg = { id: 'itemsAtlas', width: 1024, height: 1024 } as unknown as HTMLImageElement

    // 1. All 4 slots empty: draws all 4 silhouettes (helm uses frame 1 at srcX=54)
    wp.merc = {
      mercId: 501,
      classId: 271,
      name: 'Amplisa',
      level: 12,
      exp: 14500,
      hp: 180,
      maxHp: 200,
      strength: 52,
      dexterity: 68,
      damageMin: 14,
      damageMax: 32,
      defense: 95,
      fireResist: 35,
      coldResist: 35,
      lightResist: 75,
      poisonResist: -10,
    }
    const emptyRec = createRecordingCtx()
    wp.drawMercenaryPanel(emptyRec.ctx, 80, 60, undefined, {
      mercBgImg,
      invHelmGloveImg,
      invArmorImg,
      invWeaponsImg,
      buySellBtnImg,
      itemsAtlasImg,
    })

    // Background at (80, 60)
    expect(emptyRec.drawnImages.some((d) => d.img === mercBgImg && d.args[0] === 80 && d.args[1] === 60)).toBe(true)
    // Helm silhouette frame 1 (srcX=54) at (80+135, 60+5) = (215, 65)
    expect(
      emptyRec.drawnImages.some(
        (d) => d.img === invHelmGloveImg && d.args[0] === 54 && d.args[4] === 215 && d.args[5] === 65,
      ),
    ).toBe(true)
    // Armor silhouette at (80+135, 60+75) = (215, 135)
    expect(
      emptyRec.drawnImages.some((d) => d.img === invArmorImg && d.args[4] === 215 && d.args[5] === 135),
    ).toBe(true)
    // Right and Left arm weapon silhouettes at (100, 108) and (331, 108)
    expect(
      emptyRec.drawnImages.filter((d) => d.img === invWeaponsImg).map((d) => [d.args[4], d.args[5]]),
    ).toEqual([
      [100, 108],
      [331, 108],
    ])
    // Close button frame 10 (srcX=320) at (80+272, 60+385) = (352, 445)
    expect(
      emptyRec.drawnImages.some(
        (d) => d.img === buySellBtnImg && d.args[0] === 320 && d.args[4] === 352 && d.args[5] === 445,
      ),
    ).toBe(true)

    // 2. Equip a 2-handed weapon (sbw) in slot 4: suppresses both weapon silhouettes and draws 2H phantom in slot 5
    wp.merc = {
      ...wp.merc,
      damageMin: 1234,
      damageMax: 5678, // wide string triggers font16 -> font6 overflow fallback (maxW=48)
      weaponItem: {
        id: '3',
        code: 'sbw',
        name: 'Short Bow',
        nameZh: '短弓',
        kind: 'weapon',
        twoHanded: true,
        invWidth: 2,
        invHeight: 3,
      },
    }
    const fontCalls: Array<{ text: string; font: string }> = []
    const mockFont = {
      drawText: (_ctx: unknown, text: string, _x: number, _y: number, opts?: { font?: string }) => {
        fontCalls.push({ text, font: opts?.font ?? 'font16' })
      },
      measureText: (text: string, font?: string) => text.length * (font === 'font6' ? 5 : 9),
    } as any

    const twoHandRec = createRecordingCtx()
    wp.drawMercenaryPanel(twoHandRec.ctx, 80, 60, mockFont, {
      mercBgImg,
      invHelmGloveImg,
      invArmorImg,
      invWeaponsImg,
      buySellBtnImg,
      itemsAtlasImg,
    })

    // Neither weapon silhouette should be drawn when a 2H weapon occupies right arm
    expect(twoHandRec.drawnImages.some((d) => d.img === invWeaponsImg)).toBe(false)
    // Translucent 2H phantom sprite drawn in left arm with globalAlpha = 0.45
    expect(twoHandRec.drawnImages.some((d) => d.img === itemsAtlasImg && d.globalAlpha === 0.45)).toBe(true)
    // Wide damage '1234-5678' (9 chars * 9 = 81 > 48) falls back from font16 to font6
    const dmgCall = fontCalls.find((c) => c.text === '1234-5678')
    expect(dmgCall?.font).toBe('font6')
    // Normal strength '52' (2 chars * 9 = 18 <= 48) stays font16
    const strCall = fontCalls.find((c) => c.text === '52')
    expect(strCall?.font).toBe('font16')
  })

  it('reports missing art via reportMissingArt when mercBgImg is null (no silent fallback)', () => {
    clearMissingArtEntries()
    const wp = new WorldPanelsHud()
    const rec = createRecordingCtx()
    wp.drawMercenaryPanel(rec.ctx, 80, 60, undefined, { mercBgImg: null })
    expect(getMissingArtEntries().some((e) => e.category === 'ui-panel' && e.id === 'npcinv')).toBe(true)
  })

  it('hit-tests Hireling2 (800x600) equip slots (1, 3, 4, 5), bottom-right close button, and right-click portrait toggle', () => {
    const hud = new HudManager()
    hud.merc = {
      mercId: 501,
      classId: 271,
      name: 'Amplisa',
      level: 12,
      hp: 180,
      maxHp: 200,
      isDead: false,
      iconKey: 'roguehire',
    } as any
    hud.worldPanels.merc = hud.merc

    // Right-clicking top-left Mercenary portrait (x: 16..64, y: 16..64) opens 'merc' panel
    expect(hud.leftPanel).toBe('none')
    expect(hud.isPointInterceptedByHud(32, 32)).toBe(true)
    hud.handleClick(32, 32, 2)
    expect(hud.leftPanel).toBe('merc')

    // Track Mercenary equip slot clicks (slots 1=head, 3=torso, 4=right arm, 5=left arm)
    const clickedSlots: number[] = []
    hud.worldPanels.onMercEquipSlotClick = (slot) => clickedSlots.push(slot)

    // Head (slot 1): [215..269, 68..119]
    hud.handleClick(240, 90, 0)
    // Torso (slot 3): [213..269, 137..219]
    hud.handleClick(240, 175, 0)
    // Right Arm (slot 4): [100..155, 107..219]
    hud.handleClick(125, 160, 0)
    // Left Arm (slot 5): [331..386, 107..219]
    hud.handleClick(355, 160, 0)
    expect(clickedSlots).toEqual([1, 3, 4, 5])

    // Clicking legacy top-right [X] ([364..392, 68..96]) must NOT close the Mercenary panel
    hud.handleClick(375, 80, 0)
    expect(hud.leftPanel).toBe('merc')

    // Clicking authentic bottom-right close button ([350..382, 444..476]) closes the
    // Mercenary panel on mouse-up (1.13c semantics, issue #927: press latches only)
    hud.handleClick(366, 460, 0)
    expect(hud.leftPanel).toBe('merc')
    hud.handleHudMouseUp(366, 460, 0)
    expect(hud.leftPanel).toBe('none')
  })

  it('localizes Mercenary names from .tbl string tables across Acts I, II, III, and V (including nameId=0 Aliza/阿里撒 and 0x0421->0x2b0d Jarulf/賈魯夫)', () => {
    const cases: Array<{
      label: string
      classId: number
      nameId: number
      expectedEn: string
      expectedZh: string
    }> = [
      // Act 1 Rogue Scout: merc01 (0-based nameId=0 and global wMercName=3411)
      { label: 'Act 1 Rogue (nameId=0)', classId: 271, nameId: 0, expectedEn: 'Aliza', expectedZh: '阿里撒' },
      { label: 'Act 1 Rogue (wMercName=3411)', classId: 271, nameId: 3411, expectedEn: 'Aliza', expectedZh: '阿里撒' },
      // Act 2 Desert Mercenary: merca208 (Emilio / 艾米羅)
      { label: 'Act 2 Desert Guard (Emilio)', classId: 338, nameId: 7, expectedEn: 'Emilio', expectedZh: '艾米羅' },
      // Act 3 Iron Wolf: merca222 (Jelani / 喬安妮) and D2Client.dll 0x6faf978c 0x0421 -> 0x2b0d (Jarulf / 賈魯夫)
      { label: 'Act 3 Iron Wolf (Jelani)', classId: 359, nameId: 0, expectedEn: 'Jelani', expectedZh: '喬安妮' },
      { label: 'Act 3 Iron Wolf (Jarulf 0x0421)', classId: 359, nameId: 0x0421, expectedEn: 'Jarulf', expectedZh: '賈魯夫' },
      // Act 5 Barbarian: MercX101 (Varaya / 伐德哈卡) for both hcIdx 560 and 561
      { label: 'Act 5 Barbarian (hcIdx=560)', classId: 560, nameId: 0, expectedEn: 'Varaya', expectedZh: '伐德哈卡' },
      { label: 'Act 5 Barbarian (hcIdx=561)', classId: 561, nameId: 0, expectedEn: 'Varaya', expectedZh: '伐德哈卡' },
    ]

    for (const tc of cases) {
      const world = new ClientWorld()
      world.apply({
        type: 'PlayerAssign',
        unitId: 1,
        charClass: 1,
        name: 'Sorceress',
        x: 5100,
        y: 5100,
      })
      const mercUnit = (world as any).ensureUnit('monster', 888)
      mercUnit.classId = tc.classId
      mercUnit.x = 5104
      mercUnit.y = 5104
      mercUnit.mode = 1
      mercUnit.stats.set(12, 15) // Level 15
      mercUnit.stats.set(0, 60) // Strength 60
      mercUnit.stats.set(2, 60) // Dexterity 60
      mercUnit.stats.set(6, 200 << 8)
      mercUnit.stats.set(7, 200 << 8)

      world.apply({
        type: 'Merc',
        kind: 'assign',
        ownerId: 1,
        mercId: 888,
        classId: tc.classId,
        nameId: tc.nameId,
      } as any)

      expect(computeEffectiveMercenaryStats(world, 'ENG')?.name, `${tc.label} ENG`).toBe(tc.expectedEn)
      expect(computeEffectiveMercenaryStats(world, 'CHI')?.name, `${tc.label} CHI`).toBe(tc.expectedZh)

      const hud = new HudManager()
      hud.setLang('CHI')
      const model = new HudModel({
        world,
        hudManager: hud,
        onCommand: () => {},
      })
      model.syncFromWorld()

      expect(hud.merc?.name, `${tc.label} HudModel CHI`).toBe(tc.expectedZh)
      expect(hud.merc?.nameZh, `${tc.label} HudModel nameZh`).toBe(tc.expectedZh)
      expect(hud.merc?.nameEn, `${tc.label} HudModel nameEn`).toBe(tc.expectedEn)
      expect(hud.worldPanels.merc?.name, `${tc.label} worldPanels CHI`).toBe(tc.expectedZh)
    }
  })

  it('reactively switches Mercenary name between CHI (阿里撒) and ENG (Aliza) in both top-left HUD portrait and Mercenary Panel (O) without requiring a new packet', () => {
    const world = new ClientWorld()
    world.apply({
      type: 'PlayerAssign',
      unitId: 1,
      charClass: 1,
      name: 'Sorceress',
      x: 5100,
      y: 5100,
    })
    const mercUnit = (world as any).ensureUnit('monster', 777)
    mercUnit.classId = 271
    mercUnit.x = 5104
    mercUnit.y = 5104
    mercUnit.mode = 1
    mercUnit.stats.set(12, 8)
    mercUnit.stats.set(0, 42)
    mercUnit.stats.set(2, 55)
    mercUnit.stats.set(6, 120 << 8)
    mercUnit.stats.set(7, 150 << 8)

    // Assign Act 1 Rogue Scout Aliza (nameId = 0 -> merc01 = 'Aliza' / '阿里撒')
    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 777,
      classId: 271,
      nameId: 0,
    } as any)

    const hud = new HudManager()
    hud.setLang('CHI')
    const model = new HudModel({
      world,
      hudManager: hud,
      onCommand: () => {},
    })
    model.syncFromWorld()

    const mercBgImg = { id: 'mercBg', width: 320, height: 432 } as unknown as HTMLImageElement
    const invHelmGloveImg = { id: 'invHelmGlove', width: 108, height: 53 } as unknown as HTMLImageElement
    const invArmorImg = { id: 'invArmor', width: 54, height: 82 } as unknown as HTMLImageElement
    const invWeaponsImg = { id: 'invWeapons', width: 54, height: 109 } as unknown as HTMLImageElement
    const buySellBtnImg = { id: 'buySellBtn', width: 512, height: 32 } as unknown as HTMLImageElement

    const capturePortraitAndPanelNames = () => {
      // 1. Capture top-left HUD portrait label (slotX + 24 = 40, y = 10)
      const portraitCalls: Array<{ text: string; x: number; y: number }> = []
      const origDrawText = hud.font.drawText.bind(hud.font)
      hud.font.drawText = ((_ctx: unknown, text: string, x: number, y: number) => {
        portraitCalls.push({ text: String(text), x, y })
      }) as any
      const hudRec = createRecordingCtx()
      hud.ctx = hudRec.ctx
      hud.leftPanel = 'none'
      hud.render(1000, false)
      hud.font.drawText = origDrawText

      // 2. Capture Mercenary Screen (O) label at (ox + 15 = 95, oy + 214 = 274)
      const panelCalls: Array<{ text: string; x: number; y: number }> = []
      const mockPanelFont = {
        drawText: (_ctx: unknown, text: string, x: number, y: number) => {
          panelCalls.push({ text: String(text), x, y })
        },
        measureText: (text: string) => text.length * 6,
      } as any
      const panelRec = createRecordingCtx()
      hud.worldPanels.drawMercenaryPanel(panelRec.ctx, 80, 60, mockPanelFont, {
        mercBgImg,
        invHelmGloveImg,
        invArmorImg,
        invWeaponsImg,
        buySellBtnImg,
      })

      const portraitLabel = portraitCalls.find((c) => c.x === 40 && c.y === 10)?.text
      const panelLabel = panelCalls.find((c) => c.x === 95 && c.y === 274)?.text
      return { portraitLabel, panelLabel }
    }

    // Initially in CHI: both top-left HUD portrait and Mercenary Panel (O) display '阿里撒'
    expect(capturePortraitAndPanelNames()).toEqual({
      portraitLabel: '阿里撒',
      panelLabel: '阿里撒',
    })

    // Switch live to ENG without any new Merc packet or syncFromWorld() call
    hud.setLang('ENG')
    expect(capturePortraitAndPanelNames()).toEqual({
      portraitLabel: 'Aliza',
      panelLabel: 'Aliza',
    })

    // Switch live back to CHI without any new Merc packet or syncFromWorld() call
    hud.setLang('CHI')
    expect(capturePortraitAndPanelNames()).toEqual({
      portraitLabel: '阿里撒',
      panelLabel: '阿里撒',
    })
  })

  it('cancels NPC interaction session (C2S 0x30 NpcCancel) after MercHire (0x36), MercResurrect (0x62), and before MercItem (0x61) so D2Game 0x6fcf0bc0 never rejects equipping mercenary weapons (Issue #989)', () => {
    const world = new ClientWorld()
    const hud = new HudManager()
    const commands: Array<{ type: string; [k: string]: unknown }> = []
    const model = new HudModel({
      world,
      hudManager: hud,
      onCommand: (cmd) => commands.push(cmd as any),
    })

    world.apply({
      type: 'PlayerAssign',
      unitId: 1,
      charClass: 1,
      name: 'Sorceress',
      x: 5100,
      y: 5100,
    })

    // 1. Simulate talking to Kashya (npcId = 150) and opening the Hire dialog
    ;(world.npcInteraction as any).npcId = 150
    ;(world.npcInteraction as any).npcClassId = 150
    ;(world.npcInteraction as any).window = 'hire'
    ;(world.npcInteraction as any).activeWindow = 'hire'
    hud.leftPanel = 'hire'
    hud.worldPanels.activePanel = 'hire'

    model.hireMerc(150, 3411)

    expect(commands).toEqual([
      { type: 'MercHire', npcId: 150, mercId: 3411 },
      { type: 'NpcCancel', target: { unitType: 1, id: 150 } },
    ])
    expect(world.npcInteraction.npcId).toBeNull()
    expect(hud.leftPanel).toBe('none')
    expect(hud.worldPanels.activePanel).toBe('none')

    // 2. Simulate resurrecting a mercenary at Kashya (npcId = 150)
    commands.length = 0
    ;(world.npcInteraction as any).npcId = 150
    ;(world.npcInteraction as any).window = 'menu'
    ;(world.npcInteraction as any).activeWindow = 'menu'

    model.resurrectMerc(150)

    expect(commands).toEqual([
      { type: 'MercResurrect', npcId: 150 },
      { type: 'NpcCancel', target: { unitType: 1, id: 150 } },
    ])
    expect(world.npcInteraction.npcId).toBeNull()

    // 3. Equipping a weapon on the mercenary while an NPC session is still active cancels the NPC session first
    commands.length = 0
    ;(world.npcInteraction as any).npcId = 150
    ;(world.containers as any).cursor = {
      id: 2001,
      code: 'sbw',
      name: 'Short Bow',
      container: 'cursor',
      width: 2,
      height: 3,
    }
    hud.inventory.cursorItem = {
      id: '2001',
      code: 'sbw',
      name: 'Short Bow',
      nameZh: '短弓',
      kind: 'weapon',
      invWidth: 2,
      invHeight: 3,
    } as any

    hud.toggleLeftPanel('merc')
    hud.handleClick(125, 160, 0) // Click rArm (slot 4)

    expect(commands).toEqual([
      { type: 'NpcCancel', target: { unitType: 1, id: 150 } },
      { type: 'MercItem', slot: 4 },
    ])
    expect(world.npcInteraction.npcId).toBeNull()
  })

  it('resolves unequipping a mercenary weapon from lArm (slot 5 / 2H phantom) to slot 4 and supports left-clicking Mercenary portrait with cursor item (Issue #989)', () => {
    const world = new ClientWorld()
    const hud = new HudManager()
    const commands: Array<{ type: string; [k: string]: unknown }> = []
    const model = new HudModel({
      world,
      hudManager: hud,
      onCommand: (cmd) => commands.push(cmd as any),
    })

    world.apply({
      type: 'PlayerAssign',
      unitId: 1,
      charClass: 1,
      name: 'Sorceress',
      x: 5100,
      y: 5100,
    })
    const mercUnit = (world as any).ensureUnit('monster', 777)
    mercUnit.classId = 271
    mercUnit.x = 5104
    mercUnit.y = 5104
    mercUnit.mode = 1
    mercUnit.stats.set(12, 10)
    mercUnit.stats.set(6, 160 << 8)
    mercUnit.stats.set(7, 200 << 8)

    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 777,
      classId: 271,
      nameId: 0,
    } as any)

    // Equip a 2H bow in merc slot 4 (rArm); slot 5 (lArm) displays the 2H phantom
    const bowItem = {
      id: 1004,
      code: 'sbw',
      name: 'Short Bow',
      container: 'merc',
      bodyLoc: 4,
      equippedSlot: 4,
      width: 2,
      height: 3,
      quality: 2,
      identified: true,
      stats: [],
    }
    ;(world.containers.merc as Map<number, any>).set(1004, bowItem)
    ;(world.containers.mercBySlot as Map<number, any>).set(4, bowItem)
    model.syncFromWorld()

    // Open Mercenary panel and click lArm (slot 5 at x=355, y=160) with empty cursor to unequip the 2H bow
    hud.toggleLeftPanel('merc')
    hud.handleClick(355, 160, 0)
    expect(commands).toEqual([{ type: 'MercItem', slot: 4 }])

    // Left-clicking the top-left Mercenary portrait (x=32, y=32) while holding a weapon on cursor sends MercItem(0)
    commands.length = 0
    hud.leftPanel = 'none'
    hud.inventory.cursorItem = {
      id: '2002',
      code: 'lbw',
      name: 'Long Bow',
      nameZh: '长弓',
      kind: 'weapon',
      invWidth: 2,
      invHeight: 3,
    } as any
    hud.handleClick(32, 32, 0)
    expect(commands).toEqual([{ type: 'MercItem', slot: 0 }])
  })

  it('clears mercenary equipment, sockets, and stale stats when replacing a mercenary via MercHire (0x36) or AssignMerc (0x81), while preserving equipment when resurrecting the same dead mercenary (Issue #994)', () => {
    const world = new ClientWorld()
    const hud = new HudManager()
    const commands: Array<{ type: string; [k: string]: unknown }> = []
    const model = new HudModel({
      world,
      hudManager: hud,
      onCommand: (cmd) => commands.push(cmd as any),
    })

    world.apply({
      type: 'PlayerAssign',
      unitId: 1,
      charClass: 1,
      name: 'Sorceress',
      x: 5100,
      y: 5100,
    })

    // 1. Assign Act 1 Rogue Scout Aliza (mercId = 777, classId = 271, nameId = 0)
    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 777,
      classId: 271,
      nameId: 0,
      seed: 0x11112222,
    } as any)
    world.apply({ type: 'Merc', kind: 'stat', mercId: 777, stat: 12, value: 18 })
    world.apply({ type: 'Merc', kind: 'exp', mercId: 777, stat: 13, value: 45000 })

    // Equip helm (slot 1), armor (slot 3), and socketed bow (slot 4) via applyItemEvent
    world.containers.applyItemEvent(
      0x06,
      {
        id: 3001,
        code: 'cap',
        name: 'Cap',
        container: 'merc',
        ownerType: 1,
        ownerId: 777,
        bodyLoc: 1,
        equippedSlot: 1,
        width: 2,
        height: 2,
        quality: 2,
        identified: true,
        stats: [{ statId: 31, param: 0, value: 15 }],
      } as any,
      'merc',
      1,
    )
    world.containers.applyItemEvent(
      0x06,
      {
        id: 3003,
        code: 'qui',
        name: 'Quilted Armor',
        container: 'merc',
        ownerType: 1,
        ownerId: 777,
        bodyLoc: 3,
        equippedSlot: 3,
        width: 2,
        height: 3,
        quality: 2,
        identified: true,
        stats: [{ statId: 31, param: 0, value: 25 }],
      } as any,
      'merc',
      1,
    )
    world.containers.applyItemEvent(
      0x06,
      {
        id: 3004,
        code: 'sbw',
        name: 'Short Bow',
        container: 'merc',
        ownerType: 1,
        ownerId: 777,
        bodyLoc: 4,
        equippedSlot: 4,
        width: 2,
        height: 3,
        quality: 2,
        identified: true,
        stats: [],
      } as any,
      'merc',
      1,
    )
    world.containers.applyItemEvent(
      0x0b,
      {
        id: 3099,
        code: 'gcv',
        name: 'Chipped Amethyst',
        container: 'socket',
        ownerType: 4,
        ownerId: 3004,
        width: 1,
        height: 1,
        quality: 2,
        identified: true,
        stats: [],
      } as any,
      'socket',
      1,
    )

    model.syncFromWorld()
    expect(world.containers.merc.size).toBe(3)
    expect(world.containers.mercBySlot.size).toBe(3)
    expect(world.containers.sockets.has(3004)).toBe(true)
    expect(hud.worldPanels.merc?.headItem?.code).toBe('cap')
    expect(hud.worldPanels.merc?.bodyItem?.code).toBe('qui')
    expect(hud.worldPanels.merc?.weaponItem?.code).toBe('sbw')

    // 2. Mercenary dies (0x9B MercReviveCost) and is then resurrected in town (0x81 AssignMerc with same classId=271, nameId=0, seed=0x11112222)
    world.apply({
      type: 'Merc',
      kind: 'reviveCost',
      reviveNameId: 0,
      reviveCost: 5000,
    } as any)
    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 778,
      classId: 271,
      nameId: 0,
      seed: 0x11112222,
    } as any)
    model.syncFromWorld()

    // Resurrecting the same dead mercenary MUST preserve its equipment
    expect(world.containers.merc.size).toBe(3)
    expect(world.containers.mercBySlot.size).toBe(3)
    expect(hud.worldPanels.merc?.headItem?.code).toBe('cap')
    expect(hud.worldPanels.merc?.bodyItem?.code).toBe('qui')
    expect(hud.worldPanels.merc?.weaponItem?.code).toBe('sbw')

    // 3. Replace the mercenary with a new Act 2 Desert Mercenary (Emilio, classId = 338, nameId = 7) via S2C 0x81 AssignMerc
    world.apply({
      type: 'Merc',
      kind: 'assign',
      ownerId: 1,
      mercId: 888,
      classId: 338,
      nameId: 7,
      seed: 0x33334444,
    } as any)
    model.syncFromWorld()

    // Replacing the mercenary MUST clear all old mercenary equipment, sockets, and stale exp/stats
    expect(world.containers.merc.size).toBe(0)
    expect(world.containers.mercBySlot.size).toBe(0)
    expect(world.containers.allById.has(3001)).toBe(false)
    expect(world.containers.allById.has(3003)).toBe(false)
    expect(world.containers.allById.has(3004)).toBe(false)
    expect(world.containers.allById.has(3099)).toBe(false)
    expect(world.containers.sockets.has(3004)).toBe(false)
    expect(world.merc?.exp).toBeUndefined()
    expect(world.merc?.stats.size).toBe(0)
    expect(hud.worldPanels.merc?.headItem).toBeNull()
    expect(hud.worldPanels.merc?.bodyItem).toBeNull()
    expect(hud.worldPanels.merc?.weaponItem).toBeNull()
    expect(hud.worldPanels.merc?.shieldItem).toBeNull()

    // 4. Equip a spear on the new mercenary, then call model.hireMerc(150, 3412) directly
    world.containers.applyItemEvent(
      0x06,
      {
        id: 4004,
        code: 'spr',
        name: 'Spear',
        container: 'merc',
        ownerType: 1,
        ownerId: 888,
        bodyLoc: 4,
        equippedSlot: 4,
        width: 2,
        height: 4,
        quality: 2,
        identified: true,
        stats: [],
      } as any,
      'merc',
      1,
    )
    model.syncFromWorld()
    expect(hud.worldPanels.merc?.weaponItem?.code).toBe('spr')

    model.hireMerc(150, 3412)
    model.syncFromWorld()
    expect(world.containers.merc.size).toBe(0)
    expect(world.containers.mercBySlot.size).toBe(0)
    expect(hud.worldPanels.merc?.weaponItem).toBeNull()
  })
})


