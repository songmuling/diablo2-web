/**
 * Cross-tab active character in-game lease and duplicate-login error formatting (Issue #963).
 *
 * When a player logs in and enters a room (`in_game`) in one browser tab/page, PvPGN `d2cs`
 * still allows `MCP_CHARLOGON (0x07)` and `MCP_CREATEGAME (0x03)` / `MCP_JOINGAME (0x04)` for
 * that same character in a second tab, only for `d2gs` / `d2dbs` to reject or silently drop
 * `0x68 GameLogon` because the character is locked (`D2DBS_GETDATA_CHARLOCKED`).
 *
 * This module provides:
 * 1. A lightweight `localStorage`-backed lease (`d2_active_char_lease_v1:<host>:<charName>`)
 *    refreshed by the active in-game tab so a second tab on the same browser can fail-fast
 *    before opening a redundant room or hanging on `door_loading`.
 * 2. Deterministic error formatting that turns cross-tab leases, D2GS `0xB4` (`reason=0x06`
 *    `D2GS_GAMELOGON_CHARLOCKED`), and `state=logonSent` char-lock timeouts into an explicit
 *    localized prompt indicating that the character is already logged in.
 */

import { getGameLang } from '../i18n/lang.ts'

export interface ActiveCharLeaseStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ActiveCharacterLease {
  readonly tabId: string
  readonly host: string
  readonly accountName: string
  readonly charName: string
  readonly gameName: string
  readonly updatedAt: number
}

/** Lease time-to-live (ms) before an unrefreshed tab record is considered stale. */
export const ACTIVE_CHAR_LEASE_TTL_MS = 8_000

/** Heartbeat interval (ms) while a session is in `'entering-game'` or `'ingame'`. */
export const ACTIVE_CHAR_LEASE_HEARTBEAT_MS = 2_000

const LEASE_KEY_PREFIX = 'd2_active_char_lease_v1'

export function normalizeLeaseHost(host: string | null | undefined): string {
  return (host ?? '').trim().toLowerCase() || 'default'
}

export function normalizeLeaseCharName(charName: string | null | undefined): string {
  return (charName ?? '').trim().toLowerCase()
}

export function buildActiveCharLeaseKey(host: string, charName: string): string {
  return `${LEASE_KEY_PREFIX}:${normalizeLeaseHost(host)}:${normalizeLeaseCharName(charName)}`
}

export function getDefaultBrowserLeaseStorage(): ActiveCharLeaseStorage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
  } catch {
    // Ignore storage access errors in sandboxed contexts
  }
  return null
}

export function createMemoryLeaseStorage(): ActiveCharLeaseStorage {
  const map = new Map<string, string>()
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      map.set(key, value)
    },
    removeItem(key: string): void {
      map.delete(key)
    },
  }
}

export function readActiveCharacterLease(
  storage: ActiveCharLeaseStorage | null | undefined,
  host: string,
  charName: string,
  nowMs = Date.now(),
): ActiveCharacterLease | null {
  if (!storage) return null
  const normChar = normalizeLeaseCharName(charName)
  if (!normChar) return null
  const key = buildActiveCharLeaseKey(host, charName)
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ActiveCharacterLease> | null
    if (
      !parsed ||
      typeof parsed.tabId !== 'string' ||
      !parsed.tabId ||
      typeof parsed.charName !== 'string' ||
      typeof parsed.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null
    }
    if (nowMs - parsed.updatedAt >= ACTIVE_CHAR_LEASE_TTL_MS) {
      return null
    }
    return {
      tabId: parsed.tabId,
      host: typeof parsed.host === 'string' ? parsed.host : normalizeLeaseHost(host),
      accountName: typeof parsed.accountName === 'string' ? parsed.accountName : '',
      charName: parsed.charName,
      gameName: typeof parsed.gameName === 'string' ? parsed.gameName : '',
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  }
}

export function findConflictingCharacterLease(
  storage: ActiveCharLeaseStorage | null | undefined,
  host: string,
  charName: string,
  selfTabId: string,
  nowMs = Date.now(),
): ActiveCharacterLease | null {
  const lease = readActiveCharacterLease(storage, host, charName, nowMs)
  if (!lease || lease.tabId === selfTabId) {
    return null
  }
  return lease
}

export function writeActiveCharacterLease(
  storage: ActiveCharLeaseStorage | null | undefined,
  lease: ActiveCharacterLease,
): void {
  if (!storage) return
  const normChar = normalizeLeaseCharName(lease.charName)
  if (!normChar) return
  const key = buildActiveCharLeaseKey(lease.host, lease.charName)
  try {
    storage.setItem(key, JSON.stringify(lease))
  } catch {
    // Ignore quota or sandboxed storage errors
  }
}

export function releaseActiveCharacterLease(
  storage: ActiveCharLeaseStorage | null | undefined,
  host: string,
  charName: string,
  selfTabId: string,
): void {
  if (!storage) return
  const normChar = normalizeLeaseCharName(charName)
  if (!normChar) return
  const key = buildActiveCharLeaseKey(host, charName)
  try {
    const raw = storage.getItem(key)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<ActiveCharacterLease> | null
    if (!parsed || parsed.tabId === selfTabId) {
      storage.removeItem(key)
    }
  } catch {
    // Ignore storage access errors
  }
}

export function formatDuplicateCharacterLoginMessage(
  charName?: string | null,
  lang: 'zh' | 'en' = getGameLang(),
): string {
  const trimmed = (charName ?? '').trim()
  if (lang === 'en') {
    return trimmed
      ? `Character "${trimmed}" is already logged in and in a game (该角色已经登录). Unable to enter game.`
      : 'This character is already logged in and in a game (该角色已经登录). Unable to enter game.'
  }
  return trimmed
    ? `该角色 "${trimmed}" 已经登录并处于游戏中，无法重复创建或加入房间`
    : '该角色已经登录并处于游戏中，无法重复创建或加入房间'
}

export class DuplicateCharacterLoginError extends Error {
  override readonly name = 'DuplicateCharacterLoginError'
  readonly charName: string
  readonly gameName: string | undefined

  constructor(charName: string, gameName?: string) {
    super(formatDuplicateCharacterLoginMessage(charName))
    this.charName = charName
    this.gameName = gameName
  }
}

/**
 * Strip internal `[ProtocolError ...]` prefixes and normalize duplicate-character / game-entry
 * errors into a clean, user-facing prompt suitable for the lobby panel and popup modal.
 */
export function formatLobbyGameEnterError(
  err: unknown,
  charName?: string | null,
  lang: 'zh' | 'en' = getGameLang(),
): string {
  if (err instanceof DuplicateCharacterLoginError) {
    return formatDuplicateCharacterLoginMessage(err.charName || charName, lang)
  }
  const raw = err instanceof Error ? err.message : String(err)
  const stripped = raw.replace(/^\[ProtocolError[^\]]*\]\s*/i, '').trim()
  const lower = stripped.toLowerCase()
  if (
    lower.includes('已经登录') ||
    lower.includes('已在其他页面登录') ||
    lower.includes('already logged in') ||
    lower.includes('already in a game') ||
    lower.includes('reason=0x6') ||
    lower.includes('reason=0x06') ||
    lower.includes('state=logonsent') ||
    lower.includes('charlocked')
  ) {
    return formatDuplicateCharacterLoginMessage(charName, lang)
  }
  return stripped || raw
}
