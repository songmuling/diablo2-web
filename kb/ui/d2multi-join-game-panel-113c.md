# D2Multi.dll & D2MCPClient.dll v1.13c Lobby Join Game Sub-Panel (`joingamebckg.dc6`, `MCP_GAMEINFO 0x06`, `0x6F9E3280`)

## 1. Binary & Asset Overview

- **`D2Multi.dll`** (ImageBase `0x6F9D0000`)
  - Join Game Panel Init (`0x6F9E48F0`): constructs all Join Game sub-panel widgets from the control descriptor table at `0x6F9EA510..0x6F9EAFF0` and initializes both scrollbars (`0x6F9E9C94` and `0x6F9E9CA0` from `data\global\ui\BIGMENU\joingamescrollbars.dc6`).
  - Game List Population (`0x6F9E4A00` / `0x6F9E4A8B..0x6F9E4AA5`): configures 2 columns on the left list TextBox (`D2Win_10132(hList, col=1, xOffset=0x87)` = `+135px`) for `Game Name` (`x=432`) and `Players` (`x=567`).
  - Game List Click & Double-Click (`0x6F9E4730`): populates the `gameName` editbox with the clicked row's name, requests `MCP_GAMEINFO (0x06)` (`D2MCPClient_10018`), and triggers immediate game join when `GetTickCount() - s_dwLastClickMs < 500` on the same row.
  - Game Name EditBox Change Handler (`0x6F9E1F60`): clears list selection and details when the player types manually in `gameName`, then updates `JOIN GAME` button enablement via `0x6F9E1870`.
  - `JOIN GAME` Button Enablement (`0x6F9E1870`): enables the `JOIN GAME` button (`0x6F9EA840`) iff `strlen(gameName) > 0` (`D2Win_10042` non-empty).
  - Game Details Formatter (`0x6F9E3280`): populates the right-hand Game Details TextBox (`0x6F9EA780`) from `MCP_GAMEINFO (0x06)`.
- **`D2MCPClient.dll`** (ImageBase `0x6FA20000`)
  - `MCP_GAMEINFO (0x06)` S2C Handler (`0x6FA26280`): decodes server game info into an internal `tGameInfo` struct and invokes the registered UI callback (`0x6F9E3280`).
- **MPQ Art Asset (`d2exp.mpq` / `d2data.mpq`)**
  - `data\global\ui\BIGMENU\joingamebckg.dc6`: 4 frames stitched in a $2 \times 2$ grid (`256×256`, `117×256`, `256×117`, `117×117` $\rightarrow$ `373×373` with `act1Pl2.rgb`), drawn at `(415, 74)` (`y_bottom = 447`).

---

## 2. Join Game Control Descriptor Table (`D2Multi.dll` `0x6F9EA510..0x6F9EA840`)

Each 48-byte (`0x30`) control record has layout:
`[type: u32, assetPtr: u32, x: i32, y_bottom: i32, w: i32, h: i32, fontOrParam1: u32, param2: u32, strId: u32, callback: u32, flags: u32, extra: u32]`
where `y_top = y_bottom - h` for text/editbox controls, and `y_top = y_bottom - frame0.height` for multi-piece `IMAGE` controls (`joingamebckg.dc6` frame 0 height `256` $\rightarrow$ `y_top = 330 - 256 = 74`).

| VA | Widget Type | `x` | `y_bottom` | `w` | `h` | `y_top` | Font / Asset | `strId` / Text | Role |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| `0x6F9EA510` | `1` (`IMAGE`) | `415` | `330` | `-1` | `-1` | `74` | `joingamebckg.dc6` | `0` | `373×373` Join Game background panel |
| `0x6F9EA540` | `4` (`TEXTBOX`) | `496` | `106` | `200` | `22` | `84` | `font24` (gold, centered at `596`) | `5151` (`"JOIN GAME"`) | Sub-panel title |
| `0x6F9EA570` | `4` (`TEXTBOX`) | `428` | `124` | `155` | `15` | `109` | `font16` (gold) | `5269` (`"Game Name"`) | Left input label |
| `0x6F9EA5A0` | `4` (`TEXTBOX`) | `602` | `124` | `155` | `15` | `109` | `font16` (gold) | `5271` (`"Password"`) | Right input label |
| `0x6F9EA5D0` | `4` (`TEXTBOX`) | `431` | `211` | `172` | `15` | `196` | `font16` (gold) | `5275` (`"Game Name Players"`) | Game list column header |
| `0x6F9EA600` | `2` (`EDITBOX`) | `432` | `144` | `155` | `20` | `124` | `fontformal12` (`maxLen=15`, gold box `(425, 123, 167, 25)`) | `0` | Side-by-side `Game Name` input |
| `0x6F9EA630` | `2` (`EDITBOX`) | `606` | `144` | `155` | `20` | `124` | `fontformal12` (`maxLen=15`, gold box `(599, 123, 168, 25)`) | `0` | Side-by-side `Password` input |
| `0x6F9EA660` | `4` (`TEXTBOX`) | `432` | `393` | `160` | `173` | `220` | `fontformal10` (`0x6F9E9C60` `fontId=4`, `col1=0`, `col2=+135`, scrollbar `0x6F9E9C94`) | `0` | Left scrollable Game List (`11` rows, `15px` step) |
| `0x6F9EA780` | `4` (`TEXTBOX`) | `609` | `393` | `143` | `194` | `199` | `fontformal10` (scrollbar `0x6F9E9CA0`) | `0` | Right scrollable Game Details (`14` rows, `13px` step) |
| `0x6F9EA810` | `6` (`BUTTON`) | `433` | `433` | `96` | `32` | `401` | `CancelButtonBlank.dc6` | `5103` (`"CANCEL"`) | Cancel button |
| `0x6F9EA840` | `6` (`BUTTON`) | `594` | `433` | `172` | `32` | `401` | `GameButtonBlank.dc6` | `5151` (`"JOIN GAME"`) | Join Game submit button |

---

## 3. `MCP_GAMEINFO (0x06)` Binary Wire Format (`D2MCPClient.dll` `0x6FA26280`)

In `D2MCPClient.dll` `0x6FA26280`, `%ecx` points to the MCP opcode byte (`0x06`) after the 2-byte packet length header is stripped. Thus byte offset `N` from `%ecx` corresponds to `payload + (N - 1)` after the 3-byte `[u16 size][u8 opcode=0x06]` header:

| Packet Offset | `%ecx` Offset | Field | Type | Description |
|---:|---:|---|---|---|
| `3..4` | `+0x01` | `requestId` | `u16` | Echoed request ID |
| `5..8` | `+0x03` | `status` | `u32` | Game status bitmask (`0x00100000` = Expansion / Lord of Destruction, `0x00000800` = Hardcore) |
| `9..12` | `+0x07` | `uptimeSec` | `u32` | Game elapsed time in seconds |
| `13` | `+0x0B` | `creatorLevel` | `u8` | Creator's character level (used with `levelDiff` for `[min..max]` range) |
| `14` | `+0x0C` | `levelDiff` | `u8` | Allowed character level difference (`0xFF` = unrestricted) |
| `15` | `+0x0D` | `maxPlayers` | `u8` | Maximum allowed players (`1..8`) |
| `16` | `+0x0E` | `playerCount` | `u8` | Number of characters currently in the game (`0..16`) |
| `17..32` | `+0x0F..+0x1E` | `classes[16]` | `u8[16]` | 1-based character class IDs (`1`=Amazon .. `7`=Assassin) |
| `33..48` | `+0x1F..+0x2E` | `levels[16]` | `u8[16]` | Character levels (`1..99`) |
| `49..` | `+0x2F..` | `description` | `cstring` | Null-terminated game description string (`<= 31` chars) |
| `..` | `..` | `players[0..playerCount-1]` | `cstring[]` | `playerCount` null-terminated character names (`<= 15` chars each) |

---

## 4. Right-Hand Game Details Formatting (`D2Multi.dll` `0x6F9E3280`, `.rdata` `0x6F9E7504..0x6F9E75D7`)

When `MCP_GAMEINFO (0x06)` succeeds (`info.status == 0`), `0x6F9E3280` clears `hDetailsBox` (`0x6F9EA780`) and appends lines in exact order:

1. **Non-empty `description`** (`0x6F9E32BF..0x6F9E32E9`):
   - Appends `description` (color `0` White) followed by a blank line `""` (`0x6F9E75D7`).
2. **Elapsed Time** (`0x6F9E32F0..0x6F9E3335`):
   - Computes `hours = uptimeSec / 3600`, `minutes = (uptimeSec % 3600) / 60`, `seconds = uptimeSec % 60`.
   - Formats `"Elapsed Time: %d:%02d:%02d"` (`0x6F9E75BC`, color `0` White).
3. **Level Restriction** (`0x6F9E3337..0x6F9E339E`):
   - When `info.levelDiff < 100` (`0x64`):
     - If `info.levelDiff == 0`: formats `"Level %d"` (`0x6F9E75A0`, `info.creatorLevel`, color `0` White).
     - If `1 <= info.levelDiff < 100`: formats `"Level %d to %d"` (`0x6F9E75AC`, `max(1, creatorLevel - levelDiff)` .. `min(99, creatorLevel + levelDiff)`, color `0` White).
4. **Max Players Cap** (`0x6F9E33A0..0x6F9E33CC`):
   - When `1 <= info.maxPlayers < 8`: formats `"Up to %d Players"` (`0x6F9E758C`, color `0` White).
5. **Separator Blank Line** (`0x6F9E33CE..0x6F9E33DC`):
   - Appends a blank line `""` (`0x6F9E75D7`).
6. **Current Players Roster** (`0x6F9E33E0..0x6F9E34B5`):
   - For each player `i` (`0 .. info.playerCount - 1`) with non-empty `name`:
     - Line 1: `name` (color `0` White).
     - Line 2: `"Level %d <ClassName>"` (`0x6F9E7504..0x6F9E757C`, color `5` DarkGray per `push 0x5; call 0x6F9D7C5C` @ `0x6F9E347F`).

---

## 5. `MCP_GAMELIST (0x05)` Wire Format, Streaming & 15s Auto-Refresh (`D2Multi.dll` & `D2MCPClient.dll`)

### 5.1 C2S `MCP_GAMELIST (0x05)` Request (`D2Multi.dll` `0x6F9E4850` $\rightarrow$ `D2MCPClient.dll` `0x6FA27230`)

When the player enters the Join Game sub-panel (`0x6F9E48F0`) or the 15-second lobby refresh timer expires (`0x6F9DDF3B..0x6F9DDF7F`), `0x6F9E4850` increments `s_wGameListReqId` (`0x6F9E9C34`, skipping `0`), stores it in `0x6FA09F18`, resets `s_dwGameCount` (`0x6FA09DCC = 0`), checks the active character's Hardcore flag (`[pChar + 0x1EB] & 0x04`), and calls `D2MCPClient_10017` (`0x6FA27230`):

| Packet Offset | Payload Offset | Field | Type | Description |
|---:|---:|---|---|---|
| `0..1` | — | `size` | `u16` | Total packet byte length (`>= 10`) |
| `2` | — | `opcode` | `u8` | `0x05` (`MCP_GAMELIST`) |
| `3..4` | `+0x00` | `requestId` | `u16` | Monotonic non-zero request ID (`s_wGameListReqId`) |
| `5..8` | `+0x02` | `flags` | `u32` | `0x00000800` if active character is Hardcore (`charFlags & 0x04`), else `0x00000000` |
| `9..` | `+0x06..` | `searchMask` | `cstring` | Null-terminated search filter string (`""` by default) |

### 5.2 S2C `MCP_GAMELIST (0x05)` Response & End-of-List Sentinel (`D2MCPClient.dll` `0x6FA263E0`, `D2Multi.dll` `0x6F9DDC48`)

Each S2C `MCP_GAMELIST (0x05)` packet carries a single game summary entry or the end-of-list sentinel:

| Packet Offset | `%ecx` Offset | Field | Type | Description |
|---:|---:|---|---|---|
| `3..4` | `+0x01` | `requestId` | `u16` | Echoed request ID (`0x6FA09F18`) |
| `5..8` | `+0x03` | `index` | `u32` | Server-assigned game slot index (`u16` compared at `[edi+0x08]` in `0x6F9E2120`) |
| `9` | `+0x07` | `playerCount` | `u8` | Current number of players in the game (`0` for empty/closing or sentinel entries) |
| `10..13` | `+0x08` | `status` | `u32` | Game status bitmask (`0x00000004` = `GAME_STAT_OPEN`, `0xFFFFFFFE` = end-of-list, `0xFFFFFFFF` = server down) |
| `14..` | `+0x0C..` | `gameName` | `cstring` | Null-terminated game name (`<= 15` chars; empty `""` on `d2cs` end-of-list sentinel) |
| `..` | `..` | `description` | `cstring` | Null-terminated game description (`<= 31` chars) |

- **Premature-Termination Invariant (`#931`)**: `d2cs` iterates its internal game list and may emit recently-emptied games (`gameName != ""` and `playerCount == 0`) *before* active open games (`playerCount >= 1`), followed by a 17-byte end-of-list sentinel (`11 00 05 <reqId:u16> 00 00 00 00 00 00 00 00 00 00 00 00 00`, where `gameName == ""`). In `D2MCPClient.dll` `0x6FA263E0` and `D2Multi.dll` `0x6F9DDC48..0x6F9DDCA5`:
  - End-of-list is reached **only** when `gameName.length === 0` (`parsedLen < payloadLen` on the 17-byte `d2cs` sentinel) or `status === 0xFFFFFFFE` / `0xFFFFFFFF`.
  - Non-empty entries with `playerCount === 0` or closed status (`(status & 0x04) === 0`) are skipped without terminating the `MCP_GAMELIST` stream.
- **Deduplication (`0x6F9E2120`)**: Incoming games are deduplicated against existing entries in `s_aGameList` (`0x6F9EBF20`, stride `0x3B`) by game `index` (and case-insensitive `gameName`).
- **Selection Preservation (`0x6F9E1F80`, `0x6F9E209A..0x6F9E20F8`)**: When rebuilding the Join Game list box, if the previously selected game name still exists in the refreshed list, its selection highlight is preserved; if no game was selected and `gameName` is empty, the first entry is selected and `MCP_GAMEINFO (0x06)` is requested.
- **Periodic Auto-Refresh (`0x6F9DDF3B..0x6F9DDF7F`)**: While the Join Game sub-panel is active (`s_dwActiveSubPanel == 3`), the lobby loop checks `GetTickCount() - s_dwLastGameListRefreshMs >= 0x3A98` (**15,000 ms**) and automatically re-requests `MCP_GAMELIST (0x05)`.

