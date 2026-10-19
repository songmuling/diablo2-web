/**
 * 8-Directional Sub-Tile A* Pathfinding & Bresenham LOS String-Pulling
 * (`src/client/motion/pathfind.ts`, Feature F12).
 *
 * Operates on `LevelView` (or any `{ subWidth, subHeight, walkable, subOriginX?, subOriginY? }`
 * grid) in either level-local sub-tile coordinates or D2 world sub-tile coordinates.
 *
 * Guarantees:
 *   - 8-directional A* with octile heuristic (`cost = 1.0` cardinal, `Math.SQRT2` diagonal)
 *   - Strict corner-cutting prevention: diagonal transitions `(x, y) -> (x+dx, y+dy)`
 *     require both `(x+dx, y)` and `(x, y+dy)` to be walkable
 *   - Supercover Bresenham LOS raycasting (`hasLineOfSightLocal`, `hasLineOfSightWorld`)
 *     and greedy string-pulling (`smoothPathLocal`) to produce natural straight-line
 *     waypoint segments matching D2 client movement
 *   - Nearest-walkable fallback when the target sub-tile itself is blocked.
 */

import { sub_6FDAB610 } from '../../common/path/path-compute.ts'
import {
  DIRECTION_TO_OFFSET_A,
  PREPARE_TARGET_DIRECTIONS,
  SNAP_TO_CARDINAL,
} from '../../common/path/tables.ts'

export interface SubTileWalkabilityGrid {
  readonly subWidth: number
  readonly subHeight: number
  readonly walkable: Uint8Array
  readonly subOriginX?: number
  readonly subOriginY?: number
}

export interface SubTilePoint {
  readonly x: number
  readonly y: number
}

export interface PathfindOptions {
  /** Maximum A* nodes expanded before terminating (default: 16384). */
  readonly maxExpandedNodes?: number
  /** Whether to apply Bresenham supercover LOS string-pulling (default: true). */
  readonly smooth?: boolean
  /**
   * If the goal sub-tile is blocked, search up to `nearestTargetRadius` sub-tiles
   * around the goal for the closest walkable sub-tile (default: 10).
   */
  readonly nearestTargetRadius?: number
  /**
   * If the goal is unreachable within `maxExpandedNodes`, return the path to the
   * expanded node closest to the goal (default: true).
   */
  readonly allowPartial?: boolean
  /**
   * 1.13c unit collision size (`D2Common.UNITS_GetUnitSizeX` `0x6FD80F80` /
   * `COLLISION_CheckAnyCollisionWithAdjacentCells` `0x6FD9C140`):
   * - `1` (default): single sub-tile `(x, y)` check
   * - `2` (player `dwUnitSize = 2`, pattern 1): 5-cell `"+"` cross
   *   `(x, y), (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)`
   */
  readonly unitSize?: 1 | 2 | undefined
}

export interface PathfindResult {
  /** Waypoints from start (index 0) to goal/end (last index). Empty if start is invalid. */
  readonly path: readonly SubTilePoint[]
  /** Raw un-smoothed A* sub-tile steps from start to goal/end. */
  readonly rawPath: readonly SubTilePoint[]
  /** True if the exact requested goal (or resolved walkable target) was reached. */
  readonly reachedGoal: boolean
  /** Number of A* nodes expanded. */
  readonly expandedNodes: number
}

/** Maximum path length in 1.13c (D2Common/src/Path/PathMisc.cpp, MAXPATHLEN = 78). */
export const MAXPATHLEN = 78
/** Maximum straight-line coordinate delta allowed in PATHTYPE_STRAIGHT (100 sub-tiles). */
export const MAX_STRAIGHT_DISTANCE_DELTA = 100
/** Maximum Euclidean distance squared (18^2 = 324) to invoke local A* when straight line is blocked. */
export const MAX_ASTAR_OBSTACLE_DISTANCE_SQ = 324
/** 1.13c D2Collision.h ground walk collision mask (COLLIDE_WALL | COLLIDE_NOPLAYER | COLLIDE_OBJECT | COLLIDE_DOOR | COLLIDE_NO_PATH). */
export const COLLIDE_MASK_WALK = 0x1c09

const SQRT2 = Math.SQRT2
const OCTILE_DIAG_DIFF = SQRT2 - 1

const DIRS_8: readonly { readonly dx: number; readonly dy: number; readonly cost: number }[] = [
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: SQRT2 },
  { dx: 1, dy: -1, cost: SQRT2 },
  { dx: -1, dy: 1, cost: SQRT2 },
  { dx: -1, dy: -1, cost: SQRT2 },
]

function octileHeuristic(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  return dx > dy ? dx + OCTILE_DIAG_DIFF * dy : dy + OCTILE_DIAG_DIFF * dx
}

export function isCellWalkableLocal(grid: SubTileWalkabilityGrid, x: number, y: number): boolean {
  const sx = Math.floor(x)
  const sy = Math.floor(y)
  if (sx < 0 || sy < 0 || sx >= grid.subWidth || sy >= grid.subHeight) return false
  return grid.walkable[sy * grid.subWidth + sx] === 1
}

/**
 * 1.13c unit footprint walkability check (`COLLISION_CheckAnyCollisionWithPattern` `0x6FD9CE90` /
 * `COLLISION_CheckAnyCollisionWithAdjacentCells` `0x6FD9C140`).
 * For `unitSize === 2` (player `dwUnitSize = 2`), checks the 5-cell `"+"` cross centered at `(x, y)`.
 */
export function isUnitWalkableLocal(
  grid: SubTileWalkabilityGrid,
  x: number,
  y: number,
  unitSize: 1 | 2 = 1,
): boolean {
  if (!isCellWalkableLocal(grid, x, y)) return false
  if (unitSize === 2) {
    return (
      isCellWalkableLocal(grid, x - 1, y) &&
      isCellWalkableLocal(grid, x + 1, y) &&
      isCellWalkableLocal(grid, x, y - 1) &&
      isCellWalkableLocal(grid, x, y + 1)
    )
  }
  return true
}

/**
 * Diagonal step check from `(cx, cy)` to `(cx + stepX, cy + stepY)`.
 * - Both cardinal neighbors `(cx + stepX, cy)` and `(cx, cy + stepY)` must be walkable cells
 *   (which is also required by the 5-cell `"+"` cross of `(cx + stepX, cy + stepY)` when `unitSize = 2`).
 * - For `unitSize = 2`, at least one cardinal neighbor must also have a clear 5-cell `"+"` cross so
 *   a size-2 unit can step diagonally away from a wall edge (`0x6FD9C140`) without pinching through
 *   a diagonal gap between two opposing walls.
 */
function canStepDiagonalLocal(
  grid: SubTileWalkabilityGrid,
  cx: number,
  cy: number,
  stepX: number,
  stepY: number,
  unitSize: 1 | 2,
): boolean {
  if (
    !isCellWalkableLocal(grid, cx + stepX, cy) ||
    !isCellWalkableLocal(grid, cx, cy + stepY)
  ) {
    return false
  }
  if (unitSize === 2) {
    return (
      isUnitWalkableLocal(grid, cx + stepX, cy, 2) ||
      isUnitWalkableLocal(grid, cx, cy + stepY, 2)
    )
  }
  return true
}

/**
 * Supercover Bresenham line-of-sight check on local sub-tiles.
 * Checks every sub-tile touched by the line segment `(x0, y0) -> (x1, y1)`,
 * including both adjacent cells on diagonal crossings so smoothed paths never
 * clip through diagonal wall corners.
 */
export function hasLineOfSightLocal(
  grid: SubTileWalkabilityGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  unitSize: 1 | 2 = 1,
): boolean {
  let cx = Math.floor(x0)
  let cy = Math.floor(y0)
  const tx = Math.floor(x1)
  const ty = Math.floor(y1)

  if (!isCellWalkableLocal(grid, cx, cy) || !isUnitWalkableLocal(grid, tx, ty, unitSize)) {
    return false
  }
  if (cx === tx && cy === ty) return true

  const dx = Math.abs(tx - cx)
  const dy = Math.abs(ty - cy)
  const stepX = cx < tx ? 1 : -1
  const stepY = cy < ty ? 1 : -1

  let err = dx - dy
  const n = dx + dy

  for (let i = 0; i < n; i++) {
    const e2 = err * 2
    const moveX = e2 > -dy
    const moveY = e2 < dx

    if (moveX && moveY) {
      // Diagonal transition: prevent corner clipping
      if (!canStepDiagonalLocal(grid, cx, cy, stepX, stepY, unitSize)) {
        return false
      }
      cx += stepX
      cy += stepY
      err -= dy
      err += dx
      // Moving both advances 2 Manhattan steps
      i++
    } else if (moveX) {
      cx += stepX
      err -= dy
    } else if (moveY) {
      cy += stepY
      err += dx
    }

    if (!isUnitWalkableLocal(grid, cx, cy, unitSize)) {
      return false
    }
    if (cx === tx && cy === ty) {
      return true
    }
  }

  return isUnitWalkableLocal(grid, tx, ty, unitSize)
}

/**
 * Trace a straight supercover Bresenham ray from (x0, y0) toward (x1, y1).
 * Returns the sequence of walked sub-tiles up to the first obstacle or the target.
 */
export function traceStraightRayLocal(
  grid: SubTileWalkabilityGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  unitSize: 1 | 2 = 1,
): { readonly points: SubTilePoint[]; readonly blocked: boolean } {
  let cx = Math.floor(x0)
  let cy = Math.floor(y0)
  const tx = Math.floor(x1)
  const ty = Math.floor(y1)

  if (!isCellWalkableLocal(grid, cx, cy)) {
    return { points: [], blocked: true }
  }
  const points: SubTilePoint[] = [{ x: cx, y: cy }]
  if (cx === tx && cy === ty) {
    return { points, blocked: false }
  }

  const dx = Math.abs(tx - cx)
  const dy = Math.abs(ty - cy)
  const stepX = cx < tx ? 1 : -1
  const stepY = cy < ty ? 1 : -1

  let err = dx - dy
  const n = dx + dy

  for (let i = 0; i < n; i++) {
    const e2 = err * 2
    const moveX = e2 > -dy
    const moveY = e2 < dx

    let nextX = cx
    let nextY = cy

    if (moveX && moveY) {
      // Diagonal transition: prevent corner clipping
      if (!canStepDiagonalLocal(grid, cx, cy, stepX, stepY, unitSize)) {
        return { points, blocked: true }
      }
      nextX += stepX
      nextY += stepY
      err -= dy
      err += dx
      i++
    } else if (moveX) {
      nextX += stepX
      err -= dy
    } else if (moveY) {
      nextY += stepY
      err += dx
    }

    if (!isUnitWalkableLocal(grid, nextX, nextY, unitSize)) {
      return { points, blocked: true }
    }

    cx = nextX
    cy = nextY
    points.push({ x: cx, y: cy })
    if (cx === tx && cy === ty) {
      return { points, blocked: false }
    }
  }

  return { points, blocked: !isUnitWalkableLocal(grid, tx, ty, unitSize) }
}

/**
 * 1.13c `PATH_PreparePathTargetForPathUpdate` (`0x6FD85E00`) +
 * `PATH_FindValidTargetCoordsByMovingOrthogonally` (`0x6FD85D40`) on `SubTileWalkabilityGrid`.
 *
 * When `(targetX, targetY)` is blocked for `unitSize`:
 * 1. Walks 3 candidate directions (`p0`, `p1`, `p2`) from `target` toward `start` using
 *    `PREPARE_TARGET_DIRECTIONS[sub_6FDAB610(target, start) * 3]` (`0x6FDDC450`), updating
 *    `d0` from `p0 -> start` each step until a collision-free sub-tile on the near side of the
 *    obstacle is found (or `p0` reaches `start`, returning `null`).
 * 2. If the first collision-free candidate equals `start`, returns `null` (0 path points).
 * 3. For `unitSize === 2` (`UNIT_PLAYER`), applies `PATH_FindValidTargetCoordsByMovingOrthogonally`
 *    (`0x6FD85D40`): when `|dx| < 5 && |dy| < 5 && (dx !== 0 || dy !== 0)`, steps outward along
 *    `SNAP_TO_CARDINAL` (`0x6FDE4338`) up to Chebyshev distance 5 while collision-free.
 */
export function preparePathTargetLocal(
  grid: SubTileWalkabilityGrid,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  unitSize: 1 | 2 = 2,
): SubTilePoint | null {
  const sx = Math.floor(startX)
  const sy = Math.floor(startY)
  const tx = Math.floor(targetX)
  const ty = Math.floor(targetY)

  if (isUnitWalkableLocal(grid, tx, ty, unitSize)) {
    return { x: tx, y: ty }
  }

  let p0x = tx
  let p0y = ty
  let p1x = tx
  let p1y = ty
  let p2x = tx
  let p2y = ty

  const base = sub_6FDAB610(tx, ty, sx, sy) * 3
  let d0 = PREPARE_TARGET_DIRECTIONS[base]!
  const d1 = PREPARE_TARGET_DIRECTIONS[base + 1]!
  const d2 = PREPARE_TARGET_DIRECTIONS[base + 2]!

  const maxSteps = Math.abs(tx - sx) + Math.abs(ty - sy) + 8
  for (let step = 0; step < maxSteps; step++) {
    if (p0x === sx && p0y === sy) {
      return null
    }

    let chosenX = -1
    let chosenY = -1

    p0x += DIRECTION_TO_OFFSET_A[(d0 & 7) * 2]!
    p0y += DIRECTION_TO_OFFSET_A[(d0 & 7) * 2 + 1]!
    if (isUnitWalkableLocal(grid, p0x, p0y, unitSize)) {
      chosenX = p0x
      chosenY = p0y
    } else {
      p1x += DIRECTION_TO_OFFSET_A[(d1 & 7) * 2]!
      p1y += DIRECTION_TO_OFFSET_A[(d1 & 7) * 2 + 1]!
      if (isUnitWalkableLocal(grid, p1x, p1y, unitSize)) {
        chosenX = p1x
        chosenY = p1y
      } else if (d2 !== 255) {
        p2x += DIRECTION_TO_OFFSET_A[(d2 & 7) * 2]!
        p2y += DIRECTION_TO_OFFSET_A[(d2 & 7) * 2 + 1]!
        if (isUnitWalkableLocal(grid, p2x, p2y, unitSize)) {
          chosenX = p2x
          chosenY = p2y
        }
      }
    }

    if (chosenX !== -1) {
      if (chosenX === sx && chosenY === sy) {
        return null
      }
      if (unitSize === 2) {
        const nDeltaX = chosenX - sx
        const nDeltaY = chosenY - sy
        const nAbsDeltaX = Math.abs(nDeltaX)
        const nAbsDeltaY = Math.abs(nDeltaY)
        if (nAbsDeltaX < 5 && nAbsDeltaY < 5 && (nDeltaX !== 0 || nDeltaY !== 0)) {
          const nRemappedX = nDeltaX + 4
          const nRemappedY = nDeltaY + 4
          const nOffsetX = SNAP_TO_CARDINAL[nRemappedY * 9 + nRemappedX]!
          const nOffsetY = SNAP_TO_CARDINAL[nRemappedX * 9 + nRemappedY]!
          let nChebyshevDistance = Math.max(nAbsDeltaX, nAbsDeltaY)
          let cx = chosenX
          let cy = chosenY
          while (nChebyshevDistance < 5) {
            cx += nOffsetX
            cy += nOffsetY
            if (!isUnitWalkableLocal(grid, cx, cy, unitSize)) {
              break
            }
            nChebyshevDistance++
            chosenX = cx
            chosenY = cy
          }
        }
      }
      return { x: chosenX, y: chosenY }
    }

    d0 = PREPARE_TARGET_DIRECTIONS[sub_6FDAB610(p0x, p0y, sx, sy) * 3]!
  }

  return null
}

/**
 * Find the nearest walkable local sub-tile around `(targetX, targetY)` within `maxRadius`.
 * Ties are broken by Euclidean distance toward `(fromX, fromY)` when provided.
 */
export function findNearestWalkableLocal(
  grid: SubTileWalkabilityGrid,
  targetX: number,
  targetY: number,
  maxRadius = 10,
  fromX?: number,
  fromY?: number,
  unitSize: 1 | 2 = 1,
): SubTilePoint | null {
  const tx = Math.max(0, Math.min(grid.subWidth - 1, Math.floor(targetX)))
  const ty = Math.max(0, Math.min(grid.subHeight - 1, Math.floor(targetY)))
  if (isUnitWalkableLocal(grid, tx, ty, unitSize)) {
    return { x: tx, y: ty }
  }

  const refX = fromX ?? tx
  const refY = fromY ?? ty

  for (let r = 1; r <= maxRadius; r++) {
    let best: SubTilePoint | null = null
    let bestTargetDistSq = Infinity
    let bestRefDistSq = Infinity

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const nx = tx + dx
        const ny = ty + dy
        if (!isUnitWalkableLocal(grid, nx, ny, unitSize)) continue
        const targetDistSq = dx * dx + dy * dy
        const rdx = nx - refX
        const rdy = ny - refY
        const refDistSq = rdx * rdx + rdy * rdy
        if (
          targetDistSq < bestTargetDistSq ||
          (targetDistSq === bestTargetDistSq && refDistSq < bestRefDistSq)
        ) {
          bestTargetDistSq = targetDistSq
          bestRefDistSq = refDistSq
          best = { x: nx, y: ny }
        }
      }
    }

    if (best) return best
  }
  return null
}

/**
 * Smooth a dense A* sub-tile path using supercover Bresenham LOS string-pulling.
 */
export function smoothPathLocal(
  grid: SubTileWalkabilityGrid,
  rawPath: readonly SubTilePoint[],
  unitSize: 1 | 2 = 1,
): SubTilePoint[] {
  if (rawPath.length <= 2) return [...rawPath]
  const smoothed: SubTilePoint[] = [rawPath[0]!]
  let anchorIdx = 0

  while (anchorIdx < rawPath.length - 1) {
    const anchor = rawPath[anchorIdx]!
    let furthestIdx = anchorIdx + 1
    for (let probeIdx = rawPath.length - 1; probeIdx > anchorIdx + 1; probeIdx--) {
      const candidate = rawPath[probeIdx]!
      if (hasLineOfSightLocal(grid, anchor.x, anchor.y, candidate.x, candidate.y, unitSize)) {
        furthestIdx = probeIdx
        break
      }
    }
    smoothed.push(rawPath[furthestIdx]!)
    anchorIdx = furthestIdx
  }

  return smoothed
}

/**
 * Binary min-heap keyed on `fScore` for fast A* open-set extraction.
 */
class MinHeap {
  private readonly nodes: number[] = []
  private readonly priorities: number[] = []

  get size(): number {
    return this.nodes.length
  }

  clear(): void {
    this.nodes.length = 0
    this.priorities.length = 0
  }

  push(node: number, priority: number): void {
    let idx = this.nodes.length
    this.nodes.push(node)
    this.priorities.push(priority)
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1
      if (this.priorities[parentIdx]! <= priority) break
      this.nodes[idx] = this.nodes[parentIdx]!
      this.priorities[idx] = this.priorities[parentIdx]!
      idx = parentIdx
    }
    this.nodes[idx] = node
    this.priorities[idx] = priority
  }

  pop(): number | undefined {
    const len = this.nodes.length
    if (len === 0) return undefined
    const top = this.nodes[0]!
    const lastNode = this.nodes.pop()!
    const lastPrio = this.priorities.pop()!
    if (len > 1) {
      const half = (len - 1) >> 1
      let idx = 0
      while (idx < half) {
        let bestChild = (idx << 1) + 1
        const rightChild = bestChild + 1
        if (
          rightChild < len - 1 &&
          this.priorities[rightChild]! < this.priorities[bestChild]!
        ) {
          bestChild = rightChild
        }
        if (lastPrio <= this.priorities[bestChild]!) break
        this.nodes[idx] = this.nodes[bestChild]!
        this.priorities[idx] = this.priorities[bestChild]!
        idx = bestChild
      }
      this.nodes[idx] = lastNode
      this.priorities[idx] = lastPrio
    }
    return top
  }
}

// Reusable module-level A* scratch buffers keyed by generation ID (#1035).
// Eliminates per-call TypedArray allocations + O(w*h) `.fill()` across 50,000+ sub-tile grids.
let astarCapacity = 0
let astarSeenGen = new Uint32Array(0)
let astarClosedGen = new Uint32Array(0)
let astarGScore = new Float32Array(0)
let astarParent = new Int32Array(0)
let astarGenId = 0
const astarOpenHeap = new MinHeap()

function ensureAstarBuffers(totalCells: number): number {
  if (totalCells > astarCapacity) {
    astarCapacity = Math.max(totalCells, 65536)
    astarSeenGen = new Uint32Array(astarCapacity)
    astarClosedGen = new Uint32Array(astarCapacity)
    astarGScore = new Float32Array(astarCapacity)
    astarParent = new Int32Array(astarCapacity)
    astarGenId = 0
  }
  astarGenId = (astarGenId + 1) >>> 0
  if (astarGenId === 0) {
    astarSeenGen.fill(0)
    astarClosedGen.fill(0)
    astarGenId = 1
  }
  astarOpenHeap.clear()
  return astarGenId
}

/**
 * Run PATHTYPE_STRAIGHT pathfinding in level-local sub-tile coordinates (D2Common/src/Path/PathMisc.cpp:583-620).
 *
 * 1.13c Ground Truth:
 *   - Target delta > 100 sub-tiles is rejected.
 *   - If target collides (`COLLISION_CheckAnyCollisionWithPattern`), prepares target via
 *     `PATH_PreparePathTargetForPathUpdate` (`0x6FD85E00`) + `PATH_FindValidTargetCoordsByMovingOrthogonally`
 *     (`0x6FD85D40`) by stepping from target toward start.
 *   - First traces a straight line toward the goal.
 *   - If unobstructed, returns the straight line.
 *   - If blocked and Euclidean distance squared <= 18^2 (324), invokes local A* around the obstacle.
 *   - If distance squared > 324 or A* fails, stops at the obstacle.
 *   - All paths are capped at MAXPATHLEN (78).
 */
export function findPathLocal(
  grid: SubTileWalkabilityGrid,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  options: PathfindOptions = {},
): PathfindResult {
  const deltaX = Math.abs(goalX - startX)
  const deltaY = Math.abs(goalY - startY)
  if (deltaX > MAX_STRAIGHT_DISTANCE_DELTA || deltaY > MAX_STRAIGHT_DISTANCE_DELTA) {
    return { path: [], rawPath: [], reachedGoal: false, expandedNodes: 0 }
  }

  const maxExpanded = options.maxExpandedNodes ?? 16384
  const smooth = options.smooth ?? true
  const nearestRadius = options.nearestTargetRadius ?? 10
  const allowPartial = options.allowPartial ?? true
  const unitSize: 1 | 2 = options.unitSize === 2 ? 2 : 1

  const w = grid.subWidth
  const h = grid.subHeight
  if (w <= 0 || h <= 0) {
    return { path: [], rawPath: [], reachedGoal: false, expandedNodes: 0 }
  }

  // 1.13c `PATH_AStar_ComputePath` (0x6FDCB630) starts from `tStartCoord` directly if the center
  // cell is walkable, even when the unit is currently standing immediately adjacent to a wall/door.
  const floorStartX = Math.floor(startX)
  const floorStartY = Math.floor(startY)
  const resolvedStart = isCellWalkableLocal(grid, floorStartX, floorStartY)
    ? { x: floorStartX, y: floorStartY }
    : (findNearestWalkableLocal(grid, startX, startY, nearestRadius, undefined, undefined, unitSize) ??
      findNearestWalkableLocal(grid, startX, startY, nearestRadius, undefined, undefined, 1))
  if (!resolvedStart) {
    return { path: [], rawPath: [], reachedGoal: false, expandedNodes: 0 }
  }

  const floorGoalX = Math.floor(goalX)
  const floorGoalY = Math.floor(goalY)
  const resolvedGoal = isUnitWalkableLocal(grid, floorGoalX, floorGoalY, unitSize)
    ? { x: floorGoalX, y: floorGoalY }
    : preparePathTargetLocal(
        grid,
        resolvedStart.x,
        resolvedStart.y,
        floorGoalX,
        floorGoalY,
        unitSize,
      )
  if (!resolvedGoal) {
    return {
      path: [resolvedStart],
      rawPath: [resolvedStart],
      reachedGoal: false,
      expandedNodes: 0,
    }
  }

  const sx = resolvedStart.x
  const sy = resolvedStart.y
  const gx = resolvedGoal.x
  const gy = resolvedGoal.y

  if (sx === gx && sy === gy) {
    const pt = { x: sx, y: sy }
    return { path: [pt], rawPath: [pt], reachedGoal: true, expandedNodes: 1 }
  }

  // PATHTYPE_STRAIGHT: trace straight ray
  const ray = traceStraightRayLocal(grid, sx, sy, gx, gy, unitSize)
  if (!ray.blocked) {
    const rawPath = ray.points.slice(0, MAXPATHLEN)
    const finalPath = smooth ? [{ x: sx, y: sy }, { x: gx, y: gy }] : rawPath
    return {
      path: finalPath,
      rawPath,
      reachedGoal: true,
      expandedNodes: 1,
    }
  }

  // Obstructed ray: check distance squared
  const distSq = (gx - sx) * (gx - sx) + (gy - sy) * (gy - sy)
  if (distSq > MAX_ASTAR_OBSTACLE_DISTANCE_SQ) {
    // Distance > 18 sub-tiles: 1.13c does not invoke A*, stops at obstacle
    const rawPath = ray.points.slice(0, MAXPATHLEN)
    const finalPath =
      smooth && rawPath.length > 2
        ? [{ x: sx, y: sy }, rawPath[rawPath.length - 1]!]
        : rawPath
    return {
      path: finalPath,
      rawPath,
      reachedGoal: false,
      expandedNodes: 1,
    }
  }

  // Distance squared <= 324 (18^2): invoke local A* to navigate around obstacle
  const totalCells = w * h
  const gen = ensureAstarBuffers(totalCells)
  const seenGen = astarSeenGen
  const closedGen = astarClosedGen
  const gScore = astarGScore
  const parent = astarParent
  const open = astarOpenHeap

  const startIdx = sy * w + sx
  const goalIdx = gy * w + gx
  seenGen[startIdx] = gen
  gScore[startIdx] = 0
  parent[startIdx] = -1

  const initialH = octileHeuristic(sx, sy, gx, gy)
  open.push(startIdx, initialH)

  let expandedNodes = 0
  let bestIdx = startIdx
  let bestH = initialH
  let reachedGoal = false

  while (open.size > 0 && expandedNodes < maxExpanded) {
    const currentIdx = open.pop()!
    if (closedGen[currentIdx] === gen) continue
    closedGen[currentIdx] = gen
    expandedNodes++

    if (currentIdx === goalIdx) {
      reachedGoal = true
      bestIdx = goalIdx
      break
    }

    const cx = currentIdx % w
    const cy = (currentIdx - cx) / w
    const cg = gScore[currentIdx]!

    const ch = octileHeuristic(cx, cy, gx, gy)
    if (ch < bestH) {
      bestH = ch
      bestIdx = currentIdx
    }

    for (const dir of DIRS_8) {
      const nx = cx + dir.dx
      const ny = cy + dir.dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nIdx = ny * w + nx
      if (closedGen[nIdx] === gen) continue
      if (!isUnitWalkableLocal(grid, nx, ny, unitSize)) continue

      // Prevent diagonal corner cutting
      if (dir.dx !== 0 && dir.dy !== 0) {
        if (!canStepDiagonalLocal(grid, cx, cy, dir.dx, dir.dy, unitSize)) {
          continue
        }
      }

      const tentativeG = cg + dir.cost
      if (seenGen[nIdx] !== gen || tentativeG < gScore[nIdx]!) {
        seenGen[nIdx] = gen
        gScore[nIdx] = tentativeG
        parent[nIdx] = currentIdx
        const f = tentativeG + octileHeuristic(nx, ny, gx, gy)
        open.push(nIdx, f)
      }
    }
  }

  const endIdx = reachedGoal ? goalIdx : allowPartial ? bestIdx : -1
  if (endIdx < 0 || (!reachedGoal && endIdx === startIdx)) {
    // If A* failed or could not leave start, stop at the straight ray obstacle
    const rawPath = ray.points.slice(0, MAXPATHLEN)
    const finalPath =
      smooth && rawPath.length > 2
        ? [{ x: sx, y: sy }, rawPath[rawPath.length - 1]!]
        : rawPath
    return {
      path: finalPath,
      rawPath,
      reachedGoal: false,
      expandedNodes,
    }
  }

  const rawPath: SubTilePoint[] = []
  let trace = endIdx
  while (trace !== -1) {
    const tx = trace % w
    const ty = (trace - tx) / w
    rawPath.push({ x: tx, y: ty })
    if (trace === startIdx) break
    trace = parent[trace]!
  }
  rawPath.reverse()

  const cappedRaw = rawPath.slice(0, MAXPATHLEN)
  const finalPath = smooth ? smoothPathLocal(grid, cappedRaw, unitSize) : cappedRaw
  return {
    path: finalPath.slice(0, MAXPATHLEN),
    rawPath: cappedRaw,
    reachedGoal,
    expandedNodes,
  }
}

/**
 * Run 8-directional A* pathfinding in D2 world sub-tile coordinates.
 * Translates world sub-tiles by `(grid.subOriginX, grid.subOriginY)` and returns
 * waypoints in world sub-tile coordinates.
 */
export function findPathWorld(
  grid: SubTileWalkabilityGrid,
  worldStartX: number,
  worldStartY: number,
  worldGoalX: number,
  worldGoalY: number,
  options: PathfindOptions = {},
): PathfindResult {
  const ox = grid.subOriginX ?? 0
  const oy = grid.subOriginY ?? 0
  const localRes = findPathLocal(
    grid,
    worldStartX - ox,
    worldStartY - oy,
    worldGoalX - ox,
    worldGoalY - oy,
    options,
  )
  if (ox === 0 && oy === 0) return localRes
  return {
    path: localRes.path.map(p => ({ x: p.x + ox, y: p.y + oy })),
    rawPath: localRes.rawPath.map(p => ({ x: p.x + ox, y: p.y + oy })),
    reachedGoal: localRes.reachedGoal,
    expandedNodes: localRes.expandedNodes,
  }
}
