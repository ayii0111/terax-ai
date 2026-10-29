# Terax 客製化交接文件（給下次接手的 agent）

> 官方 Terax 出新版時，照本文件「升級流程」做，目標是**不用使用者陪著逐步除錯**就能把客製化功能套回去。
> 本文件是新增的獨立檔案，官方不會有同名檔，所以永遠不會產生合併衝突。

## 0. 倉庫配置

| 項目 | 值 |
|---|---|
| 本機路徑 | `~/cc-projects/terax-fix` |
| `origin` | 官方 `https://github.com/crynta/terax-ai` |
| `fork` | 使用者 fork `https://github.com/ayii0111/terax-ai` |
| 客製化分支 | `custom`：從官方 release tag 開出，上面**只有**客製化 commit |
| 目前基底 | `v0.9.0`（2026-10-16） |

**鐵律：客製化 commit 永遠只疊在官方 tag 之上，一個功能一個 commit。不要把官方 main merge 進來。**
上次（0.8.x）失敗的主因就是把官方更新和修改混在同一個 commit（`e94a85f`，100+ 檔案），之後再也分不出哪些是我們改的。

## 1. 功能規格（要達成的「行為」，不是行號）

全部是 macOS，**在一般 zsh 提示列和 Claude Code CLI（cc）輸入框都要能用**：

| 按鍵 | 送進 PTY 的位元組 | readline 意義 |
|---|---|---|
| ⌥ + ← | `ESC b`（`\x1bb`） | 往左跳一個字 |
| ⌥ + → | `ESC f`（`\x1bf`） | 往右跳一個字 |
| ⌥ + Backspace | `\x17`（Ctrl+W） | 刪前一個字 |
| ⌥ + Z | `\x1f`（Ctrl+_） | 復原 |
| ⌘ + ← | `\x01`（Ctrl+A） | 跳行首 |
| ⌘ + → | `\x05`（Ctrl+E） | 跳行尾 |
| ⌘ + Backspace | `\x15`（Ctrl+U） | 刪到行首 |

IME 組字中（`isComposing` / `compositionstart`～`compositionend`）**不可**送出上述序列。

已不需要的舊修改：「中文輸入法按住 Shift 打全形符號，第一個字被吃掉」（舊版用 `pnpm patch` 改 xterm.js）。0.9.0 改用 libghostty 後使用者確認已不再發生，**不要再套回 xterm patch**。

## 2. 根本原因（別再重新排查）

0.9.0 起終端改用 libghostty（`packages/ghostty-core`），鍵盤輸入全在一個 class 的 `handleKeyDown` 裡處理。映射邏輯本身（`keymap.ts`）官方早就寫對了，壞的是外層兩道關卡：

1. **keyCode 229 守衛**：`handleKeyDown` 開頭有
   `if (... || event.keyCode === 229 || event.key === "Dead" || event.key === "Process") return;`
   macOS WKWebView 會把 ⌥ 組合鍵標成 `keyCode 229` 或 `key === "Dead"`（⌥ 也是重音鍵修飾鍵），**即使根本沒有在組字**。所以 ⌥ 系列在映射前就被丟掉了 → 在 shell 和 cc 中都失效。
   - 對應官方 issue：#1009（使用者本人提的）、PR #956、#1215。
2. **alternate screen 閘門 + Cmd 直接放行給選單**：`terminalReadlineSequence` 開頭有 `if (opts.isAlternateScreen) return null;`（官方 #517 加的），接著 `handleKeyDown` 有
   `if (this.isMac && event.metaKey) return;  // 留給原生選單`
   兩者疊加 → cc 這類全螢幕 TUI 裡 ⌘+方向鍵**什麼都沒送出**。
   - 對應官方 issue：#1397（使用者本人提的）。

## 3. 修法（commit `fix(terminal): deliver macOS readline chords in TUIs and past keyCode 229`）

- `keymap.ts`
  - 新增 `terminalUndoSequence`：macOS 上 ⌥+Z → `\x1f`。用 `event.code === "KeyZ"` 判斷，因為 ⌥+Z 的 `event.key` 是 `"Ω"`。
  - `terminalReadlineSequence`：**移除** `isAlternateScreen` 參數與閘門，並串上 `terminalUndoSequence`。真正的 Ghostty 在 macOS 預設也是無條件送這些位元組。
- `GhosttyInputController.ts` `handleKeyDown`
  - 守衛拆成兩段：先只擋 `defaultPrevented || composing || isComposing`；接著算 `readline`；**只有 `readline` 為 null 時**才套 `keyCode 229 / Dead / Process` 守衛。
  - 原本後面計算 `readline` 的地方改成直接使用前面算好的值，其餘順序不變（paste/copy/`onKeyDown` 仍優先）。
- 測試
  - `keymap.test.ts`：readline 映射在任何畫面都會套用；`terminalUndoSequence` 的正反例。
  - `GhosttyInputController.test.ts`：7 個按鍵 × `keyCode` 0/229 × 一般畫面/alternate screen，都要送出正確位元組；組字中不可送出。
  - 已驗證：拿掉修改後，這些測試會失敗 5 個（測試確實能抓到修改遺失）。

## 4. 在新版程式碼中找到修改點（不要依賴檔名）

官方可能再重構或搬檔。用以下關鍵字定位：

```sh
command rg -n "keyCode === 229" src packages          # 守衛（關卡 1）
command rg -n "isAlternateScreen|alternateScreen" src  # 閘門（關卡 2）
command rg -n "metaKey\) return" src                  # Cmd 放行給選單
command rg -n "\\\\x1bb|\\\\x01|\\\\x15" src          # 既有 readline 映射
command rg -n "addEventListener\(\"keydown\"" src/modules/terminal  # 鍵盤入口
```

判斷原則：找到「終端機 textarea 的 keydown 處理器」，確保 (a) 上表 7 個按鍵在 229/Dead 守衛**之前**被辨識；(b) 不論 alternate screen 與否都會送出；(c) 組字中不送。

## 5. 升級流程（官方出新版時）

```sh
cd ~/cc-projects/terax-fix
command git fetch origin --tags
NEW=v0.X.Y                                   # 官方新 tag
command git switch -c custom-$NEW $NEW
command git cherry-pick <custom 分支上的客製化 commit...>   # 用 git log $OLD..custom 列出
# 若衝突或官方已重構：依第 2～4 節的「原因＋關鍵字」重寫，不要硬套舊 diff
command pnpm install --frozen-lockfile
command pnpm test                            # 全部要過；第 3 節的測試是驗收依據
command pnpm check-types
command pnpm tauri build --bundles app
```

- 先看官方是否已修好（#1009 / #956 / #1215 / #1397）。官方已修的部分就把對應 commit 拿掉，並確認測試仍通過。
- 測試全過後再 `git branch -f custom custom-$NEW`，並 push 到 `fork`（**push 前先問使用者**）。

## 6. 安裝

- 產出：`src-tauri/target/release/bundle/macos/Terax.app`。最後的 `TAURI_SIGNING_PRIVATE_KEY` 錯誤是 updater 簽章步驟，沒有官方金鑰時一定會出現，可以忽略，`.app` 本體已經建好。
- 安裝前先備份現有 app：`/Applications/Terax.app` → `/Applications/Terax-<版本>-custom.app.bak`（舊的客製版可以直接回退）。
- 未簽章：第一次開若被 Gatekeeper 擋，執行 `command xattr -dr com.apple.quarantine /Applications/Terax.app`。
- **自動更新會蓋掉客製版**：官方 updater 若提示更新，不要按，改走第 5 節流程。

## 7. 使用者驗收清單（只需一次）

在一般 zsh 提示列和 `claude` 輸入框各試一次：輸入 `aaa bbb ccc` 後依序按

1. ⌥+← 往左跳一個字、⌥+→ 往右跳一個字
2. ⌥+Backspace 刪掉一個字
3. ⌥+Z 復原剛剛的刪除（zsh 的 undo 是 Ctrl+_）
4. ⌘+← 跳到行首、⌘+→ 跳到行尾
5. ⌘+Backspace 刪到行首
6. 用中文輸入法打一個詞（組字中按 ⌥+← 不應亂跳）

## 8. 歷史

- 2026-07：0.8.x，修在 `rendererPool.ts` + xterm patch（fork 分支 `fix/option-arrow-keycode-229`、`fix/ime-fullwidth-first-char-keydownseen`，筆記在該分支的 `FIX_NOTES.md`）。
- 2026-08：merge 官方新版後功能全失效（原因：修改和官方更新混在同一個 commit，且官方改了檔案結構）。
- 2026-10-29：0.9.0 換成 libghostty，舊修法的檔案都不存在了。改在 `GhosttyInputController.ts` 重做，建立本文件與 `custom` 分支模式。
