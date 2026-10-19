/**
 * Protocol-neutral Battle.net, MCP Realm & Local Single-Player lobby models.
 */

import type { GameServerAdapter } from './game-server-adapter.ts'
import type { CharClassId } from './ids.ts'

export type LobbyGameMode = 'single' | 'bnet' | 'local' | 'open' | 'realm'
export type GameDifficulty = 0 | 1 | 2 | 'normal' | 'nightmare' | 'hell'

export interface RealmInfo {
  readonly id: number
  readonly title: string
  readonly description: string
}

export type RealmSummary = RealmInfo

export interface CharSummary {
  readonly name: string
  readonly charClass: CharClassId
  readonly classId?: CharClassId | string | undefined
  readonly level: number
  readonly hardcore: boolean
  readonly dead: boolean
  readonly expansion: boolean
  readonly ladder: boolean
  readonly act: number
  readonly difficulty: 0 | 1 | 2
  readonly progression?: number | undefined
  readonly expiresAt: number
  readonly equipmentGraphics: Uint8Array // 9 component bytes from 33-byte stat string
  readonly rawStatString: Uint8Array
}

export type CharacterSummary = CharSummary
export type LobbyCharacterSummary = CharSummary
export type LobbyCharacterInfo = CharSummary

export interface CharCreateSpec {
  readonly name: string
  readonly classId: CharClassId
  readonly charClass?: CharClassId | string | undefined
  readonly expansion?: boolean | undefined
  readonly hardcore?: boolean | undefined
  readonly ladder?: boolean | undefined
}

export type CreateCharacterInput = CharCreateSpec
export type CreateCharacterForm = CharCreateSpec

export interface CharacterManageResult {
  readonly ok: boolean
  readonly error?: string | undefined
  readonly character?: CharSummary | undefined
  readonly characters?: readonly CharSummary[] | undefined
}

export interface GameSummary {
  readonly name: string
  readonly description: string
  readonly playerCount: number
  readonly index: number
  readonly status: number
}

export type GameListEntry = GameSummary
export type LobbyGameListItem = GameSummary

export interface GameCreateSpec {
  readonly name: string
  readonly password?: string | undefined
  readonly description?: string | undefined
  readonly difficulty?: 0 | 1 | 2 | undefined
  readonly maxPlayers?: number | undefined
  readonly levelDiff?: number | undefined
}

export type CreateGameForm = GameCreateSpec
export type CreateGameRequest = GameCreateSpec

export interface JoinGameForm {
  readonly name: string
  readonly password?: string | undefined
}

export type JoinGameRequest = JoinGameForm

export interface GameInfoDetail {
  readonly name: string
  readonly status: number
  readonly uptimeSec: number
  readonly creatorLevel?: number | undefined
  readonly levelDiff?: number | undefined
  readonly maxPlayers: number
  readonly description?: string | undefined
  readonly players: readonly {
    readonly name: string
    readonly charClass: CharClassId
    readonly level: number
  }[]
}

export type ChatEventKind =
  | 'showUser'
  | 'join'
  | 'leave'
  | 'whisper'
  | 'talk'
  | 'broadcast'
  | 'channel'
  | 'userFlags'
  | 'whisperSent'
  | 'channelFull'
  | 'channelDoesNotExist'
  | 'channelRestricted'
  | 'info'
  | 'error'
  | 'emote'
  | 'unknown'

export interface ChatEvent {
  readonly eventId: number
  readonly kind: ChatEventKind
  readonly userFlags: number
  readonly ping: number
  readonly username: string
  readonly text: string
}

export interface ListGamesOptions {
  readonly difficulty?: GameDifficulty | undefined
  readonly search?: string | undefined
  readonly flags?: number | undefined
  readonly onGame?: ((game: GameSummary, games: readonly GameSummary[]) => void) | undefined
}

export interface LocalAreaPresetObject {
  readonly classId: number
  readonly x: number
  readonly y: number
  readonly areaId?: number | undefined
  readonly mode?: number | undefined
  readonly isWaypoint?: boolean | undefined
  readonly isShrine?: boolean | undefined
  readonly destAreaId?: number | undefined
}

export interface LocalAreaPresetMonster {
  readonly classId: number
  readonly x: number
  readonly y: number
  readonly areaId?: number | undefined
  readonly name?: string | undefined
  readonly isNpc?: boolean | undefined
  readonly isVendor?: boolean | undefined
  readonly isKillable?: boolean | undefined
  readonly aiDisabled?: boolean | undefined
}

export interface LocalAreaRoomReveal {
  readonly areaId: number
  readonly tileX: number
  readonly tileY: number
}

export interface LocalAreaBootstrap {
  readonly areaId?: number | undefined
  readonly spawnX: number
  readonly spawnY: number
  readonly rooms?: readonly LocalAreaRoomReveal[] | undefined
  readonly objects?: readonly LocalAreaPresetObject[] | undefined
  readonly monsters?: readonly LocalAreaPresetMonster[] | undefined
  readonly isWalkable?: ((areaId: number, x: number, y: number, isFlying?: boolean) => boolean) | undefined
}

export type LocalAreaBootstrapResolver = (params: {
  readonly act: number
  readonly areaId: number
  readonly mapSeed: number
  readonly difficulty: 0 | 1 | 2
}) => LocalAreaBootstrap | null | undefined

export interface LobbyEnterGameTarget {
  readonly mode?: 'local' | 'd2gs' | 'ts' | 'single' | 'create' | 'join' | undefined
  readonly charName?: string | undefined
  readonly charSummary?: CharSummary | undefined
  readonly d2sBytes?: Uint8Array | undefined
  readonly gameName?: string | undefined
  readonly name?: string | undefined
  readonly gamePassword?: string | undefined
  readonly password?: string | undefined
  readonly spec?: GameCreateSpec | undefined
  readonly difficulty?: GameDifficulty | undefined
  readonly mapSeed?: number | undefined
  readonly wsUrl?: string | undefined
  readonly gameToken?: number | undefined
  readonly gameHash?: number | undefined
  readonly resolveAreaBootstrap?: LocalAreaBootstrapResolver | undefined
}

export interface LobbyProvider {
  readonly mode: LobbyGameMode
  listCharacters(): Promise<readonly CharSummary[]>
  createCharacter(
    spec:
      | CharCreateSpec
      | {
          readonly name: string
          readonly classId: CharClassId | string
          readonly charClass?: CharClassId | string | undefined
          readonly expansion?: boolean | undefined
          readonly hardcore?: boolean | undefined
          readonly ladder?: boolean | undefined
        },
  ): Promise<CharSummary | readonly CharSummary[]>
  deleteCharacter(name: string): Promise<boolean | readonly CharSummary[]>
  convertCharacterToExpansion?(name: string): Promise<readonly CharSummary[]>
  selectCharacter(name: string): Promise<void>
  listGames?(filter?: string | ListGamesOptions, options?: ListGamesOptions): Promise<readonly GameSummary[]>
  getGameInfo?(name: string): Promise<GameInfoDetail>
  enterGame(
    target?:
      | { readonly mode: 'create'; readonly spec: GameCreateSpec }
      | { readonly mode: 'join'; readonly name: string; readonly password?: string | undefined }
      | { readonly mode: 'single'; readonly difficulty?: 0 | 1 | 2 | undefined }
      | LobbyEnterGameTarget,
  ): Promise<GameServerAdapter>
  leaveGame?(): Promise<void>
  createGame?(form: GameCreateSpec): Promise<LobbyEnterGameTarget | GameServerAdapter>
  joinGame?(form: JoinGameForm): Promise<LobbyEnterGameTarget | GameServerAdapter>
  exportCharacterD2s?(name: string): Promise<Uint8Array | null>
  importCharacterD2s?(bytes: Uint8Array): Promise<CharacterManageResult | readonly CharSummary[]>
}

export interface LocalServerOptions {
  readonly charName?: string | undefined
  readonly classId?: CharClassId | number | string | undefined
  readonly charClass?: CharClassId | string | undefined
  readonly charClassId?: CharClassId | undefined
  readonly charLevel?: number | undefined
  readonly difficulty?: GameDifficulty | undefined
  readonly actNumber?: 1 | 2 | 3 | 4 | 5 | undefined
  readonly levelId?: number | undefined
  readonly mapSeed?: number | undefined
  readonly d2sBytes?: Uint8Array | undefined
  readonly allowPause?: boolean | undefined
  readonly persistIntervalTicks?: number | undefined
  readonly onSaveD2s?: ((charName: string, d2sBytes: Uint8Array) => void) | undefined
  readonly resolveAreaBootstrap?: LocalAreaBootstrapResolver | undefined
}

export type LocalServerSessionRequest = LocalServerOptions

export interface LocalServerSessionHandle {
  readonly adapter: GameServerAdapter
  readonly lobby?: LobbyProvider | undefined
  stepFrame(): void
  stepTick?(nowMs?: number): void
  setPaused?(paused: boolean): void
  isPaused?(): boolean
  getPlayersX?(): number
  exportD2s(): Uint8Array
  stop(): void
}

export type LocalServerFactory = (options?: LocalServerOptions) => LocalServerSessionHandle
export type LocalServerSessionFactory = LocalServerFactory

let registeredLocalServerFactory: LocalServerFactory | null = null
let registeredLocalLobbyProvider: LobbyProvider | (() => LobbyProvider) | null = null

export function registerLocalServerFactory(factory: LocalServerFactory | null): void {
  registeredLocalServerFactory = factory
}

export function getLocalServerFactory(): LocalServerFactory | null {
  return registeredLocalServerFactory
}

export function createLocalServerSession(options?: LocalServerOptions): LocalServerSessionHandle {
  if (!registeredLocalServerFactory) {
    throw new Error('No LocalServerFactory registered; import src/server/loopback-adapter.ts or call registerLocalServerFactory() first.')
  }
  return registeredLocalServerFactory(options)
}

export function registerLocalLobbyProvider(providerOrFactory: LobbyProvider | (() => LobbyProvider) | null): void {
  registeredLocalLobbyProvider = providerOrFactory
}

export function getLocalLobbyProvider(): LobbyProvider | null {
  if (!registeredLocalLobbyProvider) return null
  return typeof registeredLocalLobbyProvider === 'function'
    ? registeredLocalLobbyProvider()
    : registeredLocalLobbyProvider
}

