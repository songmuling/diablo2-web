import { describe, expect, it } from 'vitest'
import {
  MON_STATS_SOUND_BY_HCIDX_113C,
  SUPER_UNIQUE_MON_SOUND_BY_ID_113C,
  convertMonsterSoundMode113c,
  resolveMonsterSoundProfileId113c,
  resolveUnitMonSoundRow113c,
} from '../../src/common/audio/mon-sounds-113c.ts'
import { ClientWorld } from '../../src/client/world/client-world.ts'
import { AudioRuntime113c } from '../../src/client/audio/audio-runtime-113c.ts'

describe('Issue #986: 1.13c MonStats/MonSounds monster SFX in ClientWorld & AudioRuntime113c', () => {
  it('resolves MonStats.txt hcIdx (MonSound / UMonSound) and SuperUniques.txt overrides', () => {
    expect(MON_STATS_SOUND_BY_HCIDX_113C.length).toBe(734)
    expect(MON_STATS_SOUND_BY_HCIDX_113C[5]).toEqual(['zombie1', 'zombie', 'zombieunique'])
    expect(MON_STATS_SOUND_BY_HCIDX_113C[19]).toEqual(['fallen1', 'fallen', 'fallen'])
    expect(MON_STATS_SOUND_BY_HCIDX_113C[58]).toEqual(['fallenshaman1', 'fallenshaman', 'fallenshaman'])
    expect(SUPER_UNIQUE_MON_SOUND_BY_ID_113C[6]).toBe('countess')
    expect(SUPER_UNIQUE_MON_SOUND_BY_ID_113C[20]).toBe('smith')
    expect(SUPER_UNIQUE_MON_SOUND_BY_ID_113C[41]).toBe('smithdemon')

    expect(resolveMonsterSoundProfileId113c({ classId: 19 })).toBe('fallen')
    expect(resolveMonsterSoundProfileId113c({ classId: 5 })).toBe('zombie')
    expect(resolveMonsterSoundProfileId113c({ classId: 5, isUnique: true })).toBe('zombieunique')
    expect(resolveMonsterSoundProfileId113c({ classId: 5, isChampion: true })).toBe('zombieunique')
    expect(
      resolveMonsterSoundProfileId113c({
        classId: 45,
        isSuperUnique: true,
        superUniqueId: 6,
      }),
    ).toBe('countess')
  })

  it('emits Fallen (hcIdx=19) Attack1+Weapon1, Footstep, HitSound (0x0C & GH), and DeathSound in ClientWorld', () => {
    const world = new ClientWorld()
    world.apply({
      type: 'UnitAssign',
      unit: {
        unitType: 1,
        id: 501,
        classId: 19, // fallen1 (MonSound='fallen': attack1=890, weapon1=251, hitSound=895, deathSound=900, footstep=2720)
        x: 5100,
        y: 5100,
        mode: 1,
        lifePct: 128,
      },
    })
    world.drainWorldSoundRequests()

    // 1. Attack1 (890, delay=0) + Weapon1 (251, delay=5, vol=160) on A1 (mode=4)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 501,
      mode: 4,
      at: { x: 5100, y: 5100 },
    })
    const a1Reqs = world.drainWorldSoundRequests()
    const wep1 = a1Reqs.find((r) => r.soundId === 251)
    expect(wep1).toBeDefined()
    expect(wep1?.delayTicks).toBe(5)
    expect(wep1?.volume).toBe(160)
    for (const r of a1Reqs) {
      expect([890, 251]).toContain(r.soundId)
    }

    // 2. Walk (mode=2) -> Footstep (2720)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 501,
      mode: 2,
      at: { x: 5102, y: 5102 },
    })
    const wlReqs = world.drainWorldSoundRequests()
    expect(wlReqs.map((r) => r.soundId)).toContain(2720)

    // 3. 0x0C NPCGetHit (mode === undefined && hitClass !== undefined) -> HitSound (895, delay=2)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 501,
      lifePct: 96,
      hitClass: 32,
    })
    const hit0cReqs = world.drainWorldSoundRequests()
    expect(hit0cReqs).toHaveLength(1)
    expect(hit0cReqs[0]?.soundId).toBe(895)
    expect(hit0cReqs[0]?.delayTicks).toBe(2)

    // 4. Mode 3 (GH) -> HitSound (895, delay=2)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 501,
      mode: 3,
      lifePct: 64,
      hitClass: 32,
    })
    const ghReqs = world.drainWorldSoundRequests()
    expect(ghReqs).toHaveLength(1)
    expect(ghReqs[0]?.soundId).toBe(895)

    // 5. Mode 0 (DT) -> Fallen DeathSound (900, delay=1), NOT hardcoded 1094 (thornhulk)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 501,
      mode: 0,
      lifePct: 0,
    })
    const dtReqs = world.drainWorldSoundRequests()
    expect(dtReqs.some((r) => r.soundId === 900 && r.delayTicks === 1)).toBe(true)
    expect(dtReqs.some((r) => r.soundId === 1094)).toBe(false)
  })

  it('converts Fallen Shaman (hcIdx=58) A2 + Resurrect (#181) to S1 (Skill1 = 938) via CvtMo1/CvtSk1/CvtTgt1', () => {
    const shamanRow = resolveUnitMonSoundRow113c({ classId: 58 })
    expect(shamanRow).toBeDefined()
    expect(shamanRow?.id).toBe('fallenshaman')
    expect(convertMonsterSoundMode113c(shamanRow!, 5, 181)).toBe(8)
    expect(convertMonsterSoundMode113c(shamanRow!, 5, 36)).toBe(5)

    const world = new ClientWorld()
    world.apply({
      type: 'UnitAssign',
      unit: {
        unitType: 1,
        id: 601,
        classId: 58, // fallenshaman1
        x: 5120,
        y: 5120,
        mode: 1,
        lifePct: 128,
      },
    })
    world.drainWorldSoundRequests()

    // Shaman casts Resurrect (skillId=181, anim mode A2=5 -> converted to S1=8 -> skill1=938)
    world.apply({
      type: 'SkillCast',
      caster: { unitType: 1, id: 601 },
      skill: 181,
      level: 1,
      target: { x: 5100, y: 5100 },
    })
    const castReqs = world.drainWorldSoundRequests()
    expect(castReqs.map((r) => r.soundId)).toContain(938)
  })

  it('emits Init sound on UnitAssign and periodic Neutral sound (907) when living monster ticks in MONMODE_NEUTRAL (1)', () => {
    const world = new ClientWorld()
    // Compelling Orb (hcIdx=366, MonSound='compellingorb', init=667) emits Init on UnitAssign
    world.apply({
      type: 'UnitAssign',
      unit: {
        unitType: 1,
        id: 700,
        classId: 366,
        x: 5090,
        y: 5090,
        mode: 1,
        lifePct: 128,
      },
    })
    expect(world.drainWorldSoundRequests().map((r) => r.soundId)).toContain(667)

    world.apply({
      type: 'UnitAssign',
      unit: {
        unitType: 1,
        id: 701,
        classId: 19, // fallen1: Neutral=907, NeuTime=300
        x: 5100,
        y: 5100,
        mode: 1,
        lifePct: 128,
      },
    })
    world.drainWorldSoundRequests()

    let neutralEmitted = false
    for (let i = 0; i < 610; i++) {
      world.tick(40)
      const reqs = world.drainWorldSoundRequests()
      if (reqs.some((r) => r.soundId === 907)) {
        neutralEmitted = true
        break
      }
    }
    expect(neutralEmitted).toBe(true)
  })

  it('prefetches sfx-mon-global alongside act monster packs in preloadMonsterPacksForAct', () => {
    const prefetched: string[] = []
    const runtime = new AudioRuntime113c({
      loader: {
        prefetch: (packId: string) => {
          prefetched.push(packId)
        },
        getSoundBuffer: () => null,
        ensureSoundBuffer: async () => null,
      } as any,
    })
    runtime.preloadMonsterPacksForAct(1)
    expect(prefetched).toContain('sfx-mon-global')
    expect(prefetched.some((p) => p.startsWith('sfx-mon-act1'))).toBe(true)
  })

  it('skips monster death vocal on STATE_FREEZE (43) and drops unshipped monster sound IDs (1595..1598)', () => {
    const world = new ClientWorld()
    world.apply({
      type: 'UnitAssign',
      unit: { unitType: 1, id: 801, classId: 19, x: 5100, y: 5100, mode: 1, lifePct: 128 },
    })
    world.drainWorldSoundRequests()

    world.pushSoundRequest({ soundId: 1595 })
    expect(world.drainWorldSoundRequests()).toHaveLength(0)

    const frozenUnit = world.getUnit('monster', 801)!
    frozenUnit.states.add(43)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 801,
      mode: 0,
      lifePct: 0,
    })
    expect(world.drainWorldSoundRequests().some((r) => r.soundId === 900)).toBe(false)
  })

  it('Issue #1236: emitUnitDeathSound does not fall back to bogus 1094 when MonSounds.txt DeathSound is 0', () => {
    const world = new ClientWorld()
    // Bat (hcIdx=159, MonSound='bat', deathSound=0), Akara (hcIdx=148, MonSound='lightnpc', deathSound=0), and Hellmeteor (hcIdx=153, MonSound='')
    world.emitUnitDeathSound({ unitType: 1, unitId: 901, classId: 159, x: 5100, y: 5100 })
    world.emitUnitDeathSound({ unitType: 1, unitId: 902, classId: 148, x: 5100, y: 5100 })
    world.emitUnitDeathSound({ unitType: 1, unitId: 903, classId: 153, x: 5100, y: 5100 })
    expect(world.drainWorldSoundRequests()).toHaveLength(0)

    // Fallen (hcIdx=19, MonSound='fallen', deathSound=900, deaDelay=1) still emits 900 with delayTicks=1
    world.emitUnitDeathSound({ unitType: 1, unitId: 904, classId: 19, x: 5100, y: 5100 })
    const reqs = world.drainWorldSoundRequests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0]?.soundId).toBe(900)
    expect(reqs[0]?.delayTicks).toBe(1)
  })

  it('Issue #1237: MONMODE_DEAD (12) corpse state sync does not emit monster death vocal', () => {
    const world = new ClientWorld()
    // 1. UnitAssign of a corpse (mode=12, lifePct=0) followed by UnitMode(mode=12) or NpcState(state=0x09)
    world.apply({
      type: 'UnitAssign',
      unit: { unitType: 1, id: 1001, classId: 19, x: 5100, y: 5100, mode: 12, lifePct: 0 },
    })
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 1001,
      mode: 12,
      lifePct: 0,
    })
    world.apply({
      type: 'NpcState',
      unitId: 1001,
      state: 0x09,
      x: 5100,
      y: 5100,
      life: 0,
    } as any)
    expect(world.drainWorldSoundRequests()).toHaveLength(0)

    // 2. UnitAssign of a living monster followed by corpse sync UnitMode(mode=12) (0x69 cmd=0x09)
    world.apply({
      type: 'UnitAssign',
      unit: { unitType: 1, id: 1002, classId: 19, x: 5100, y: 5100, mode: 1, lifePct: 128 },
    })
    world.drainWorldSoundRequests()
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 1002,
      mode: 12,
      lifePct: 0,
    })
    expect(world.drainWorldSoundRequests().some((r) => r.soundId === 900)).toBe(false)
  })

  it('Issue #1238: schedules FsCnt multi-step footsteps per WL/RN cycle and re-triggers footsteps & NeuTime across sustained animation loops', () => {
    const world = new ClientWorld()
    // Arach (hcIdx=122 'arach1', MonSound='arach': footstep=2720, fsCnt=3, fsOff=0, fsPrb=100)
    world.apply({
      type: 'UnitAssign',
      unit: { unitType: 1, id: 1101, classId: 122, x: 5100, y: 5100, mode: 1, lifePct: 128 },
    })
    world.drainWorldSoundRequests()

    // 1. Entering WL (mode=2) schedules all FsCnt=3 footsteps across the walk cycle
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 1101,
      mode: 2,
      at: { x: 5100, y: 5100 },
    })
    const modeWalkReqs = world.drainWorldSoundRequests().filter((r) => r.soundId === 2720)
    expect(modeWalkReqs).toHaveLength(3)
    expect(modeWalkReqs[0]?.delayTicks).toBeUndefined()
    expect(modeWalkReqs[1]?.delayTicks).toBeGreaterThan(0)
    expect(modeWalkReqs[2]?.delayTicks).toBeGreaterThan(modeWalkReqs[1]!.delayTicks!)

    // Reset to NU (mode=1) and start a sustained UnitMove across the room (5100, 5100) -> (5112, 5112)
    world.apply({
      type: 'UnitMode',
      unitType: 1,
      id: 1101,
      mode: 1,
      at: { x: 5100, y: 5100 },
    })
    world.drainWorldSoundRequests()
    world.apply({
      type: 'UnitMove',
      unitType: 1,
      id: 1101,
      mode: 'walk',
      from: { x: 5100, y: 5100 },
      to: { x: 5112, y: 5112 },
    })

    // First tick drains the queued 0x67 cmd=0x01 and enters WL (3 footsteps); subsequent ticks wrap the walk animation and re-emit footsteps
    let totalSustainedWalkFootsteps = 0
    for (let i = 0; i < 30; i++) {
      world.tick(40)
      totalSustainedWalkFootsteps += world.drainWorldSoundRequests().filter((r) => r.soundId === 2720).length
    }
    expect(totalSustainedWalkFootsteps).toBeGreaterThanOrEqual(6)
  })
})
