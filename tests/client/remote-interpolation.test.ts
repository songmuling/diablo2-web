/**
 * Remote Entity Movement Interpolation & MonStats Velocity Tests (Issues #586, #598).
 *
 * Verifies Diablo II v1.13c ground truth:
 * - Remote monster velocity derives from MonStats.txt (Velocity / Run) via computeMonsterMoveSpeedSubTilesPerSec
 * - S2C 0x67 / 0x68 decodes nPathType and nVelocity
 * - S2C nVelocity scales monster / unit speed, retaining the 25% speed floor
 * - Units advance along waypoints cleanly without synthetic 1.5x catchup acceleration (#598)
 * - Remote units settle cleanly on authoritative stop packets without sliding glide (#598)
 */

import { describe, expect, it } from 'vitest'
import {
  RemoteEntityInterpolator,
  resolveRemoteMoveSpeed,
} from '../../src/client/motion/interpolate.ts'
import {
  D2_BASE_RUN_SUBTILES_PER_SEC,
  D2_BASE_WALK_SUBTILES_PER_SEC,
} from '../../src/client/motion/predictor.ts'
import { ByteWriter } from '../../src/netproto/core/byte-writer.ts'
import {
  decode0x67NpcMove,
  decode0x68NpcMoveToTarget,
} from '../../src/netproto/d2gs/s2c/movement.ts'

describe('S2C Movement Packet Decoders for nPathType & nVelocity (Issue #586)', () => {
  it('decodes nPathType and nVelocity from 0x67 NpcMove', () => {
    // 0x67 packet:
    // [0] 0x67
    // [1..4] unitId u32LE (e.g. 101)
    // [5] moveType u8 (e.g. 0x01 walk)
    // [6..7] targetX u16LE (1234)
    // [8..9] targetY u16LE (5678)
    // [10..11] unk0x0A u16LE
    // [12] nPathType u8 (e.g. 4)
    // [13..14] nVelocity i16LE (e.g. 75 = 75% speed)
    // [15] unk u8
    const w = new ByteWriter(16)
    w.u8(0x67)
    w.u32LE(101)
    w.u8(0x01) // walk
    w.u16LE(1234)
    w.u16LE(5678)
    w.u16LE(0) // unk0x0A
    w.u8(4) // nPathType
    w.i16LE(75) // nVelocity = 75%
    w.u8(0)

    const event = decode0x67NpcMove(w.toUint8Array())
    expect(event.type).toBe('UnitMove')
    if (event.type === 'UnitMove') {
      expect(event.id).toBe(101)
      expect(event.mode).toBe('walk')
      expect(event.to).toEqual({ x: 1234, y: 5678 })
      expect(event.pathType).toBe(4)
      expect(event.velocityPercent).toBe(75)
    }
  })

  it('decodes nPathType and nVelocity from 0x68 NpcMoveToTarget', () => {
    // 0x68 packet:
    // [0] 0x68
    // [1..4] unitId u32LE
    // [5] moveType u8 (0x17 run)
    // [6..7] currentX u16LE (100)
    // [8..9] currentY u16LE (200)
    // [10] targetType u8 (0 = player)
    // [11..14] targetId u32LE (1)
    // [15..16] unk0x0F u16LE
    // [17] nPathType u8 (3)
    // [18..19] nVelocity i16LE (120 = 120%)
    // [20] unk u8
    const w = new ByteWriter(21)
    w.u8(0x68)
    w.u32LE(202)
    w.u8(0x17) // run
    w.u16LE(100)
    w.u16LE(200)
    w.u8(0) // targetType = player
    w.u32LE(1) // targetId
    w.u16LE(0) // unk0x0F
    w.u8(3) // nPathType
    w.i16LE(120) // nVelocity
    w.u8(0)

    const event = decode0x68NpcMoveToTarget(w.toUint8Array())
    expect(event.type).toBe('UnitMove')
    if (event.type === 'UnitMove') {
      expect(event.id).toBe(202)
      expect(event.mode).toBe('run')
      expect(event.pathType).toBe(3)
      expect(event.velocityPercent).toBe(120)
      expect(event.target).toEqual({ unitType: 0, id: 1 })
    }
  })
})

describe('resolveRemoteMoveSpeed with MonStats & velocityPercent (Issue #586)', () => {
  it('resolves authentic monster speed using MonStats.txt data for NPCs and monsters', () => {
    // Akara (classId 148): MonStats Velocity = 3 -> 1.171875 sub-tiles/sec
    const akaraSpeed = resolveRemoteMoveSpeed({
      unitType: 1,
      classId: 148,
      running: false,
    })
    expect(akaraSpeed.speedSubTilesPerSec).toBe(1.171875)

    // Zombie (classId 19): MonStats Velocity = 15 -> 5.859375 sub-tiles/sec
    const zombieSpeed = resolveRemoteMoveSpeed({
      unitType: 1,
      classId: 19,
      running: false,
    })
    expect(zombieSpeed.speedSubTilesPerSec).toBe(5.859375)

    // Fallen (classId 0): MonStats Velocity = 9 -> 3.515625 sub-tiles/sec
    const fallenSpeed = resolveRemoteMoveSpeed({
      unitType: 1,
      classId: 0,
      running: false,
    })
    expect(fallenSpeed.speedSubTilesPerSec).toBe(3.515625)
  })

  it('scales monster speed with nVelocity while maintaining 25% floor', () => {
    // Zombie at 75% speed
    const chilledZombie = resolveRemoteMoveSpeed({
      unitType: 1,
      classId: 19,
      running: false,
      velocityPercent: 75,
    })
    expect(chilledZombie.speedSubTilesPerSec).toBe(5.859375)

    // Severe slow (10% velocityPercent) clamped to 25% floor:
    const frozenZombie = resolveRemoteMoveSpeed({
      unitType: 1,
      classId: 19,
      running: false,
      velocityPercent: 10,
    })
    // 25% floor: (25 * Math.trunc((25 * (5 << 8)) / 100)) / 4096 = 1.953125
    expect(frozenZombie.speedSubTilesPerSec).toBe(
      resolveRemoteMoveSpeed({
        unitType: 1,
        classId: 19,
        running: false,
        velocityPercent: 25,
      }).speedSubTilesPerSec,
    )
  })

  it('scales remote player speed with nVelocity while maintaining 25% floor', () => {
    // Remote player walking at 50% speed
    const chilledPlayer = resolveRemoteMoveSpeed({
      unitType: 0,
      running: false,
      velocityPercent: 50,
    })
    expect(chilledPlayer.speedSubTilesPerSec).toBe(D2_BASE_WALK_SUBTILES_PER_SEC * 0.5)

    // Remote player at 10% speed clamped to 25% floor
    const frozenPlayer = resolveRemoteMoveSpeed({
      unitType: 0,
      running: false,
      velocityPercent: 10,
    })
    expect(frozenPlayer.speedSubTilesPerSec).toBe(D2_BASE_WALK_SUBTILES_PER_SEC * 0.25)
  })
})

describe('RemoteEntityInterpolator Kinematics & Parity (Issue #598)', () => {
  it('advances remote monsters at authentic velocity without 1.5x synthetic catchup acceleration', () => {
    const interpolator = new RemoteEntityInterpolator()

    // Spawn Akara at visual position (98, 100) lagging behind server
    interpolator.spawnOrSnap({
      unitType: 1,
      unitId: 10,
      classId: 148,
      x: 98,
      y: 100,
    })

    // Server sends move to (105, 100) with server position at (100, 100)
    // Server segment distance is 5, but visual distance is 7
    const moveCmd = interpolator.startMove({
      unitType: 1,
      unitId: 10,
      currentX: 100,
      currentY: 100,
      targetX: 105,
      targetY: 100,
      running: false,
    })

    // In 1.13c parity (Issue #598): speed is strictly authentic MonStats speed (1.171875),
    // NOT boosted by arbitrary 1.5x catchup multiplier
    expect(moveCmd.speedSubTilesPerSec).toBe(1.171875)

    // Step 1 second (1000ms)
    interpolator.update(1000)
    const state = interpolator.getEntityState(1, 10)!
    expect(state.moving).toBe(true)
    // Advance = 1.171875 sub-tiles from currentX (98)
    expect(state.x).toBeCloseTo(98 + 1.171875, 4)
  })

  it('settles cleanly on authoritative stop packets without post-stop sliding deceleration', () => {
    const interpolator = new RemoteEntityInterpolator()

    interpolator.spawnOrSnap({
      unitType: 1,
      unitId: 20,
      classId: 19, // Zombie
      x: 100,
      y: 100,
    })

    interpolator.startMove({
      unitType: 1,
      unitId: 20,
      targetX: 110,
      targetY: 100,
      running: false,
    })

    // Update 500ms -> unit moves toward target
    interpolator.update(500)
    const movingState = interpolator.getEntityState(1, 20)!
    expect(movingState.moving).toBe(true)

    // Server stop packet received at movingState.x
    const stoppedState = interpolator.stopEntity({
      unitType: 1,
      unitId: 20,
      x: movingState.x,
      y: 100,
    })

    // In 1.13c parity (Issue #598): unit immediately settles at authoritative stop position,
    // moving is set to false, and no post-stop overshoot happens
    expect(stoppedState.moving).toBe(false)
    expect(stoppedState.x).toBe(movingState.x)
    expect(stoppedState.y).toBe(100)

    // Further updates do not move the unit
    interpolator.update(500)
    const afterUpdateState = interpolator.getEntityState(1, 20)!
    expect(afterUpdateState.moving).toBe(false)
    expect(afterUpdateState.x).toBe(movingState.x)
    expect(afterUpdateState.y).toBe(100)
  })
})
