/**
 * Issue — pressing C (char panel) / B,T (skill / inventory) must pan the camera
 * so the player stays centered in the visible half, like 1.13c.
 *
 * Two defects locked here:
 * 1. The OnlineSession scene state never reported `leftPanelOpen`/`rightPanelOpen`,
 *    so `snapshot.panelShiftX` was permanently 0 (no pan at all).
 * 2. `computePanelCameraShift` had inverted signs and a fixed 160px magnitude
 *    (the 640-wide value): left panel must pan the camera LEFT (player centered
 *    in the right half), right panel RIGHT; magnitude = viewportWidth / 4.
 */
import { describe, expect, it } from 'vitest'
import {
  computePanelCameraShift,
  panelDockWidth,
  VIEWPORT_800x600,
  VIEWPORT_1024x768,
  VIEWPORT_1280x720,
} from '../src/client/view/viewport-profile.ts'
import { ClientWorldSceneSource } from '../src/client/view/scene-source.ts'
import type { ClientSceneWorldAdapter } from '../src/client/view/scene-source.ts'

function adapterWith(panels: { leftPanelOpen?: boolean; rightPanelOpen?: boolean }): ClientSceneWorldAdapter {
  return {
    tick: 1,
    playerSubX: 500,
    playerSubY: 500,
    units: [],
    levelView: null,
    neighbourLevelViews: [],
    tileAtlas: null,
    ambient: null,
    ...panels,
  } as unknown as ClientSceneWorldAdapter
}

describe('[panel camera shift] 1.13c half-screen panel panning', () => {
  it('1. shifts by panelDockWidth/2 with authentic signs', () => {
    // Left panel open: visible area is the right one → camera moves left (negative).
    expect(computePanelCameraShift(true, false, 400)).toBe(-200)
    // Right panel (inventory/skills): player centered in left visible area → positive.
    expect(computePanelCameraShift(false, true, 400)).toBe(200)
    // Both open or none: centered.
    expect(computePanelCameraShift(true, true, 400)).toBe(0)
    expect(computePanelCameraShift(false, false, 400)).toBe(0)
    // Panels are fixed-size art, NOT half the screen: 320 wide only at 640x480.
    expect(computePanelCameraShift(true, false, 320)).toBe(-160)
    // Extended viewports keep 400-wide docks — shift stays 200 at 1024/1280+,
    // never width/4 (256/320 would misplace the player; user-reported 1280x720).
    expect(computePanelCameraShift(false, true, 400)).toBe(200)
  })

  it('2. panelDockWidth: 320 at 640x480, 400 everywhere else incl. extended', () => {
    expect(panelDockWidth(VIEWPORT_800x600)).toBe(400)
    expect(panelDockWidth(VIEWPORT_1024x768)).toBe(400)
    expect(panelDockWidth(VIEWPORT_1280x720)).toBe(400)
  })

  it('2. scene camera pans when the world adapter reports panels open', () => {
    const sourceNoPanel = new ClientWorldSceneSource(() => adapterWith({}), VIEWPORT_800x600)
    const sourceLeft = new ClientWorldSceneSource(
      () => adapterWith({ leftPanelOpen: true }),
      VIEWPORT_800x600,
    )
    const sourceRight = new ClientWorldSceneSource(
      () => adapterWith({ rightPanelOpen: true }),
      VIEWPORT_1024x768,
    )
    const base = sourceNoPanel.getCameraTopLeft().x
    expect(sourceLeft.getCameraTopLeft().x).toBe(base - 200)
    expect(sourceRight.getCameraTopLeft(VIEWPORT_1024x768).x).toBe(
      sourceNoPanel.getCameraTopLeft(VIEWPORT_1024x768).x + 200,
    )
  })

  it('3. frame snapshot carries the panel shift so the renderer pans', () => {
    const source = new ClientWorldSceneSource(
      () => adapterWith({ rightPanelOpen: true }),
      VIEWPORT_800x600,
    )
    const snap = source.buildFrameSnapshot()
    expect(snap.panelShiftX).toBe(200)
  })
})
