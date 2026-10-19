/**
 * In-memory BNCS / MCP / D2GS fake servers for `createD2OnlineFlow` session-loss tests.
 *
 * Every `resolver.open()` creates a fresh `MemoryStream` pair (so a second login gets new
 * connections) and records both ends, letting tests force-close the server side of a connection and
 * assert that the flow disposed its client side. Responders follow the tier4 S6 harness.
 */

import {
  createMemoryStreamPair,
  type ByteStream,
  type EndpointResolver,
  type EndpointRole,
} from '../../src/netproto/index.ts'
import { ByteReader } from '../../src/netproto/core/byte-reader.ts'
import { ByteWriter } from '../../src/netproto/core/byte-writer.ts'
import { BncsFramer, encodeBncsFrame } from '../../src/netproto/bncs/framing.ts'
import { BncsOpcode, encodeBncsPing } from '../../src/netproto/bncs/packets.ts'
import { encodeMcpFrame, McpFramer } from '../../src/netproto/mcp/framing.ts'
import { McpOpcode } from '../../src/netproto/mcp/packets.ts'
import {
  defaultD2gsHuffmanCodec,
  wrapD2gsCompressedBlock,
} from '../../src/netproto/d2gs/compression.ts'
import type { MemoryStream } from '../../src/netproto/transport/memory-stream.ts'

export interface FakeConnection {
  readonly role: EndpointRole
  readonly client: MemoryStream
  readonly server: MemoryStream
}

export interface FakeRealmOptions {
  /** BNCS request opcodes the fake server never answers (to provoke request timeouts). */
  readonly silentBncs?: readonly number[] | undefined
  /** MCP request opcodes the fake server never answers. */
  readonly silentMcp?: readonly number[] | undefined
  /** Characters in MCP_CHARLIST2 (0 = empty roster, i.e. the char_create screen). */
  readonly characters?: number | undefined
  /** Status code returned for SID_CREATEACCOUNT2 (default 0x00 = OK). */
  readonly createAccountStatus?: number | undefined
  /** Suggestion string returned for SID_CREATEACCOUNT2 (default ''). */
  readonly createAccountSuggestion?: string | undefined
  /** How D2GS responds to C2S 0x68 GameLogon (default 'ok'). */
  readonly d2gsLogonMode?: 'ok' | 'charlocked_0xb4' | 'silent_logon' | undefined
}

export interface FakeRealm {
  readonly resolver: EndpointResolver
  readonly connections: FakeConnection[]
  readonly bncsNullCount: number
  /** Most recent connection for `role`. */
  latest(role: EndpointRole): FakeConnection
  /** Every client stream the resolver handed out is closed (nothing leaked). */
  allClientStreamsClosed(): boolean
}

function charList(count: number): Uint8Array {
  const w = new ByteWriter()
  w.u16LE(8)
  w.u32LE(count)
  w.u16LE(count)
  for (let i = 0; i < count; i++) {
    w.u32LE(0x7fffffff)
    w.cstring(`d2webbot_sorc${i === 0 ? '' : String(i)}`)
    const stat = new Uint8Array(33).fill(0xff)
    stat[0] = 0x84
    stat[1] = 0x80
    stat[13] = 0x02
    stat[25] = 80
    stat[26] = 0xa0
    stat[27] = 0x80
    w.bytes(stat)
    w.u8(0)
  }
  return w.toUint8Array()
}

function wireBncs(
  server: MemoryStream,
  silent: ReadonlySet<number>,
  onNull: () => void,
  createAccountStatus = 0,
  createAccountSuggestion = '',
): void {
  const framer = new BncsFramer()
  let initSeen = false
  server.onData((chunk) => {
    let data = chunk
    if (!initSeen && data[0] === 0x01) {
      initSeen = true
      data = data.subarray(1)
    }
    for (const pkt of framer.push(data)) {
      if (pkt.id === BncsOpcode.SID_NULL) {
        onNull()
      }
      if (silent.has(pkt.id) || server.isClosed) continue
      if (pkt.id === BncsOpcode.SID_NULL) {
        server.write(encodeBncsFrame(BncsOpcode.SID_NULL, new Uint8Array(0)))
      } else if (pkt.id === BncsOpcode.SID_AUTH_INFO) {
        server.write(encodeBncsPing(0x11223344))
        const w = new ByteWriter()
        w.u32LE(0)
        w.u32LE(0xabcdef01)
        w.u32LE(0)
        w.u32LE(0)
        w.u32LE(0)
        w.cstring('ver-IX86-1.mpq')
        w.cstring('A=1 B=2 C=3 4 A=A^S B=B^C C=C^A A=A^B')
        server.write(encodeBncsFrame(BncsOpcode.SID_AUTH_INFO, w.toUint8Array()))
      } else if (pkt.id === BncsOpcode.SID_AUTH_CHECK) {
        server.write(encodeBncsFrame(BncsOpcode.SID_AUTH_CHECK, new Uint8Array([0, 0, 0, 0, 0])))
      } else if (pkt.id === BncsOpcode.SID_CREATEACCOUNT2) {
        const w = new ByteWriter()
        w.u32LE(createAccountStatus)
        w.cstring(createAccountSuggestion)
        server.write(encodeBncsFrame(BncsOpcode.SID_CREATEACCOUNT2, w.toUint8Array()))
      } else if (pkt.id === BncsOpcode.SID_LOGONRESPONSE2) {
        server.write(encodeBncsFrame(BncsOpcode.SID_LOGONRESPONSE2, new Uint8Array([0, 0, 0, 0])))
      } else if (pkt.id === BncsOpcode.SID_QUERYREALMS2) {
        const w = new ByteWriter()
        w.u32LE(0)
        w.u32LE(1)
        w.u32LE(1)
        w.cstring('D2CS')
        w.cstring('Local Test Realm')
        server.write(encodeBncsFrame(BncsOpcode.SID_QUERYREALMS2, w.toUint8Array()))
      } else if (pkt.id === BncsOpcode.SID_LOGONREALMEX) {
        const w = new ByteWriter()
        w.u32LE(0x11223344)
        w.u32LE(0)
        w.bytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
        w.bytes(new Uint8Array([127, 0, 0, 1]))
        w.u16BE(6113)
        w.u16LE(0)
        w.bytes(new Uint8Array(48).fill(0x55))
        w.cstring('d2webbot_sorc')
        server.write(encodeBncsFrame(BncsOpcode.SID_LOGONREALMEX, w.toUint8Array()))
      } else if (pkt.id === BncsOpcode.SID_ENTERCHAT) {
        const w = new ByteWriter()
        w.cstring('d2webbot_sorc')
        w.cstring('PX2D')
        w.cstring('d2webbot2')
        server.write(encodeBncsFrame(BncsOpcode.SID_ENTERCHAT, w.toUint8Array()))
      }
    }
  })
}

function wireMcp(server: MemoryStream, silent: ReadonlySet<number>, characters: number): void {
  const framer = new McpFramer()
  let initSeen = false
  server.onData((chunk) => {
    let data = chunk
    if (!initSeen && data[0] === 0x01) {
      initSeen = true
      data = data.subarray(1)
    }
    for (const pkt of framer.push(data)) {
      if (silent.has(pkt.id) || server.isClosed) continue
      if (pkt.id === McpOpcode.MCP_STARTUP) {
        server.write(encodeMcpFrame(McpOpcode.MCP_STARTUP, new Uint8Array([0, 0, 0, 0])))
      } else if (pkt.id === McpOpcode.MCP_CHARLIST2) {
        server.write(encodeMcpFrame(McpOpcode.MCP_CHARLIST2, charList(characters)))
      } else if (pkt.id === McpOpcode.MCP_CHARLOGON) {
        server.write(encodeMcpFrame(McpOpcode.MCP_CHARLOGON, new Uint8Array([0, 0, 0, 0])))
      } else if (pkt.id === McpOpcode.MCP_CREATEGAME) {
        const reqId = new ByteReader(pkt.payload).u16LE()
        const w = new ByteWriter()
        w.u16LE(reqId)
        w.u16LE(1)
        w.u16LE(0)
        w.u32LE(0)
        server.write(encodeMcpFrame(McpOpcode.MCP_CREATEGAME, w.toUint8Array()))
      } else if (pkt.id === McpOpcode.MCP_JOINGAME) {
        const reqId = new ByteReader(pkt.payload).u16LE()
        const w = new ByteWriter()
        w.u16LE(reqId)
        w.u16LE(0x0042)
        w.u16LE(0)
        w.bytes(new Uint8Array([127, 0, 0, 1]))
        w.u32LE(0xdeadbeef)
        w.u32LE(0)
        server.write(encodeMcpFrame(McpOpcode.MCP_JOINGAME, w.toUint8Array()))
      }
    }
  })
}

function wireGame(
  server: MemoryStream,
  logonMode: NonNullable<FakeRealmOptions['d2gsLogonMode']> = 'ok',
): void {
  server.onData((chunk) => {
    if (chunk[0] === 0x68 && !server.isClosed) {
      if (logonMode === 'silent_logon') {
        return
      }
      if (logonMode === 'charlocked_0xb4') {
        server.write(
          wrapD2gsCompressedBlock(
            defaultD2gsHuffmanCodec.compress(new Uint8Array([0xb4, 0x06, 0x00, 0x00, 0x00])),
          ),
        )
        server.close()
        return
      }
      server.write(
        wrapD2gsCompressedBlock(
          defaultD2gsHuffmanCodec.compress(new Uint8Array([0x01, 0, 0, 0, 0, 0, 1, 1, 0x02, 0x04])),
        ),
      )
    }
  })
}

export function createFakeRealm(options: FakeRealmOptions = {}): FakeRealm {
  const silentBncs = new Set(options.silentBncs ?? [])
  const silentMcp = new Set(options.silentMcp ?? [])
  const characters = options.characters ?? 1
  const d2gsLogonMode = options.d2gsLogonMode ?? 'ok'
  const connections: FakeConnection[] = []
  let nullCount = 0

  const resolver: EndpointResolver = {
    open: async (role: EndpointRole): Promise<ByteStream> => {
      const [client, server] = createMemoryStreamPair(role)
      connections.push({ role, client, server })
      if (role === 'bnet') {
        wireBncs(
          server,
          silentBncs,
          () => {
            nullCount++
          },
          options.createAccountStatus ?? 0,
          options.createAccountSuggestion ?? '',
        )
      } else if (role === 'realm') wireMcp(server, silentMcp, characters)
      else {
        wireGame(server, d2gsLogonMode)
        setTimeout(() => {
          if (!server.isClosed) server.write(new Uint8Array([0xaf, 0x01]))
        }, 5)
      }
      return client
    },
  }

  return {
    resolver,
    connections,
    get bncsNullCount(): number {
      return nullCount
    },
    latest(role: EndpointRole): FakeConnection {
      const found = [...connections].reverse().find((c) => c.role === role)
      if (!found) throw new Error(`no ${role} connection was opened`)
      return found
    },
    allClientStreamsClosed(): boolean {
      return connections.every((c) => c.client.isClosed)
    },
  }
}
