/**
 * Protocol-neutral `GameServerAdapter` interface (PROJECT.md § Interface Contracts).
 */

import type { CloseReason } from '../transport/byte-stream.ts'
import type { ClientCommand } from './client-command.ts'
import type { ServerEvent } from './server-event.ts'

export interface GameServerStats {
  readonly unknownPackets: number
  readonly opaquePackets: number
  readonly rttMs: number | null
  readonly bytesIn: number
  readonly bytesOut: number
  readonly packetsIn?: number | undefined
  readonly packetsOut?: number | undefined
  readonly packetsReceived?: number | undefined
  readonly packetsSent?: number | undefined
  readonly protocolErrors?: number | undefined
}

export interface GameServerAdapter {
  readonly state: 'loading' | 'ingame' | 'inGame' | 'closed'
  send(cmd: ClientCommand): void
  onEvent(cb: (ev: ServerEvent) => void): () => void
  onClose(cb: (reason: CloseReason) => void): () => void
  leave(): void
  readonly close?: ((reason?: CloseReason) => void) | undefined
  readonly tick?: ((frames?: number) => void) | undefined
  readonly stats: GameServerStats
}
