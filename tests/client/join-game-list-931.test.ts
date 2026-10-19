import { describe, expect, it } from 'vitest'
import {
  applyRealmGamesToFlowState,
  createInitialFlowState,
  formatJoinGameDetailLines,
  JOIN_GAME_LIST_REFRESH_INTERVAL_MS,
} from '../../src/client/frontend/flow-state.ts'

describe('Lobby Join Game list population, selection preservation & refresh interval (#931)', () => {
  it('defines 1.13c D2Multi.dll (0x6f9ddf3b) 15,000 ms (0x3a98) refresh interval', () => {
    expect(JOIN_GAME_LIST_REFRESH_INTERVAL_MS).toBe(15_000)
  })

  it('formats MCP_GAMEINFO (0x06) details when live d2cs returns non-zero open game status bitmask (0x00300004)', () => {
    const lines = formatJoinGameDetailLines({
      name: 'j931o9zn',
      status: 0x00300004,
      uptimeSec: 65,
      creatorLevel: 1,
      levelDiff: 0xff,
      maxPlayers: 8,
      description: 'issue 931 verify',
      players: [{ name: 'WebBotOne', charClass: 1, level: 1 }],
    })
    expect(lines).toEqual([
      { text: 'issue 931 verify', color: 0 },
      { text: '', color: 0 },
      { text: 'Elapsed Time: 0:01:05', color: 0 },
      { text: '', color: 0 },
      { text: 'WebBotOne', color: 0 },
      { text: 'Level 1 Sorceress', color: 5 },
    ])

    // Closed game status without GAME_STAT_OPEN (0x04) returns empty lines
    expect(
      formatJoinGameDetailLines({
        name: 'closed1',
        status: 0x00300000,
        uptimeSec: 10,
        maxPlayers: 8,
        players: [],
      }),
    ).toEqual([])
  })

  it('auto-selects the first game and populates gameName when no game is selected', () => {
    const st = createInitialFlowState()
    st.stage = 'bnet_lobby'
    st.lobbySubPanel = 'join'
    st.gameName = ''
    st.selectedGameName = ''

    const res = applyRealmGamesToFlowState(st, [
      { index: 1, name: 'EmptyRoom', description: '', playerCount: 0, status: 0x00300004 },
      { index: 2, name: 'BaalRun01', description: 'fast', playerCount: 4, status: 0x00302004 },
      { index: 3, name: 'Tristram02', description: 'walk', playerCount: 2, status: 0x00300004 },
    ])

    expect(st.realmGames).toHaveLength(2)
    expect(st.realmGames.map((g) => g.name)).toEqual(['BaalRun01', 'Tristram02'])
    expect(st.selectedGameName).toBe('BaalRun01')
    expect(st.gameName).toBe('BaalRun01')
    expect(res).toEqual({
      selectedGameName: 'BaalRun01',
      shouldFetchGameInfo: true,
    })
  })

  it('preserves selectedGameName across refreshes per D2Multi.dll (0x6f9e1f80) and avoids flicker during streaming', () => {
    const st = createInitialFlowState()
    st.stage = 'bnet_lobby'
    st.lobbySubPanel = 'join'

    applyRealmGamesToFlowState(st, [
      { index: 10, name: 'GameAlpha', description: 'a', playerCount: 1, status: 0x00300004 },
      { index: 11, name: 'GameBeta', description: 'b', playerCount: 2, status: 0x00302004 },
    ])

    // User clicks GameBeta
    st.selectedGameName = 'GameBeta'
    st.gameName = 'GameBeta'

    // Periodic refresh starts: first packet only has GameAlpha so far (finalized: false)
    const midRes = applyRealmGamesToFlowState(
      st,
      [{ index: 10, name: 'GameAlpha', description: 'a', playerCount: 3, status: 0x00300004 }],
      { finalized: false },
    )
    expect(st.realmGames.map((g) => `${g.name}:${g.playerCount}`)).toEqual([
      'GameAlpha:3',
      'GameBeta:2',
    ])
    expect(st.selectedGameName).toBe('GameBeta')
    expect(midRes.shouldFetchGameInfo).toBe(false)

    // Refresh completes with both games (finalized: true)
    const finalRes = applyRealmGamesToFlowState(
      st,
      [
        { index: 10, name: 'GameAlpha', description: 'a', playerCount: 3, status: 0x00300004 },
        { index: 11, name: 'GameBeta', description: 'b', playerCount: 5, status: 0x00302004 },
      ],
      { finalized: true },
    )
    expect(st.realmGames.map((g) => `${g.name}:${g.playerCount}`)).toEqual([
      'GameAlpha:3',
      'GameBeta:5',
    ])
    expect(st.selectedGameName).toBe('GameBeta')
    expect(st.gameName).toBe('GameBeta')
    expect(finalRes.shouldFetchGameInfo).toBe(true)
  })

  it('clears vanished selectedGameName on finalized refresh and selects remaining first game unless user typed custom gameName', () => {
    const st = createInitialFlowState()
    st.stage = 'bnet_lobby'
    st.lobbySubPanel = 'join'
    st.selectedGameName = 'OldClosedGame'
    st.gameName = 'OldClosedGame'

    const res = applyRealmGamesToFlowState(
      st,
      [{ index: 20, name: 'NewOpenGame', description: 'fresh', playerCount: 1, status: 0x00300004 }],
      { finalized: true },
    )
    expect(st.selectedGameName).toBe('NewOpenGame')
    expect(st.gameName).toBe('NewOpenGame')
    expect(res.shouldFetchGameInfo).toBe(true)

    // When user manually typed a custom gameName (selectedGameName === ''), refresh does not overwrite gameName
    st.selectedGameName = ''
    st.gameName = 'CustomPrivate1'
    const customRes = applyRealmGamesToFlowState(
      st,
      [{ index: 20, name: 'NewOpenGame', description: 'fresh', playerCount: 2, status: 0x00300004 }],
      { finalized: true },
    )
    expect(st.selectedGameName).toBe('')
    expect(st.gameName).toBe('CustomPrivate1')
    expect(customRes.shouldFetchGameInfo).toBe(false)
  })
})
