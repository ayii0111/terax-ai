# Terax 客製化修復筆記（給下次接手的 agent 看）

---

# 修復 2：IME 全形符號第一個字被吃掉（分支 `fix/ime-fullwidth-first-char-keydownseen`）

## 一句話結論

中文輸入法下按住 Shift 連打全形符號（如 Shift+[ → 「），**第一個字會被吞掉**，根因是 xterm.js 的 `_keyDownSeen` 旗標被「按住的 Shift 的 keydown」毒化，擋掉了 WKWebView 上唯一能接住這種字的 `input` 事件 fallback。修法是用 `pnpm patch` 對 `@xterm/xterm@6.0.0` 打補丁：純修飾鍵的 keydown 不設 `_keyDownSeen`。

## 根因（別再重新排查）

- WKWebView 上，IME 直接送出（direct-commit）全形符號的事件順序是 **`input` 先、`keydown(keyCode 229)` 後**，且全程沒有 composition 事件。xterm 假設 keydown 先來。
- xterm 兩條接收路徑因此都失效：
  1. keydown 229 → `CompositionHelper._handleAnyTextareaChanges()`：diff textarea 舊值 vs 新值，但 `input` 已先寫入，keydown 當下的「舊值」已含新字 → diff 為空 → 不送。**每一下都如此。**
  2. `input` 事件 fallback（`CoreBrowserTerminal.ts` `_inputEvent`）：條件 `!ev.composed || !this._keyDownSeen`。`_keyDownSeen` 在任何 keydown 設 true、keyup 才重設。
- 實際送字的一直是路徑 2。按住 Shift 時，Shift 的 keydown 把 `_keyDownSeen` 設成 true，第一個字的 `input` 被擋 → 吞掉；第一下 `[` 的 keyup 重設旗標後，後續每下都正常。

## 怎麼證實的

Release 版沒開 devtools，用 `pnpm tauri dev` + Cmd+Option+I，在 Console 監聽 `.xterm-helper-textarea` 的 keydown/input/composition 事件。實測 log（Shift 按住連按兩次 `[`）：

```
keydown key=Shift keyCode=16
input  data="「"  taValue="「"      ← input 先到，被 _keyDownSeen 擋掉（吞）
keydown key={ keyCode=229 taValue="「"  ← diff 為空，不送
keyup  key={ keyCode=219            ← 重設 _keyDownSeen
input  data="「"  taValue="「「"     ← 第二下走 fallback，正常送出
keydown key={ keyCode=229
```

## 修法

`patches/@xterm__xterm.patch`（`pnpm patch @xterm/xterm` 產生，`pnpm-workspace.yaml` 的 `patchedDependencies` 引用）。對 `lib/xterm.js` 和 `lib/xterm.mjs` 各一處，把 `_keyDown(e)` 開頭的：

```js
this._keyDownSeen=!0
```

改成：

```js
this._keyDownSeen=!(e.key==="Shift"||e.key==="Control"||e.key==="Alt"||e.key==="Meta"||e.key==="CapsLock")
```

修飾鍵本來就不會產生文字，不設旗標不影響原本行為；xterm 升版時 patch 若對不上，重跑 `pnpm patch` 流程照上面改即可。這是 xterm.js 上游 bug，可考慮回報 https://github.com/xtermjs/xterm.js 。

## 驗證狀態

- `pnpm check-types`、`pnpm test`（363 tests）全過。
- 實機驗證：`pnpm tauri dev` 開終端，切中文輸入法，Shift 按住連按 `[` 兩次，應出現「「（第一下不再被吞）。

---

# 修復 1：Option+方向鍵跳字失效（分支 `fix/option-arrow-keycode-229`）

## 一句話結論

Terax 終端機裡 `Option+←/→`（跳字）、`Option+Backspace`（刪字）在 macOS 上完全沒反應，根因是 **macOS WKWebView 把 Option 修飾鍵誤標成 `keyCode 229`**（IME 組字用的代碼），Terax 自己的守衛邏輯看到 229 就直接把事件整個丟掉，功能邏輯本身完全正常、根本沒機會執行。

修法已經送出官方 PR：**https://github.com/crynta/terax-ai/pull/956**（分支 `fix/option-arrow-keycode-229`，在 fork `ayii0111/terax-ai` 上）。

## 為什麼會這樣（別再重新排查一次）

- Terax 是 Tauri + WKWebView + xterm.js 做的終端機 App。
- Option+方向鍵的跳字邏輯正確地實作在 `src/modules/terminal/lib/keymap.ts`（`terminalWordNavigationSequence`），會送出 readline 的 `ESC b` / `ESC f`。
- 但這段邏輯在 `src/modules/terminal/lib/rendererPool.ts` 的 `attachCustomKeyEventHandler` 裡，前面擋了一行：
  ```ts
  if (event.isComposing || event.keyCode === 229) return false;
  ```
  這行原意是「IME 組字中的按鍵不要轉發給 PTY」，但 macOS 的 Option 鍵同時也是重音符號（dead-key）修飾鍵，WKWebView 會把 Option+方向鍵也標成 `keyCode 229`（即使 `isComposing` 是 `false`），導致事件在跳字邏輯執行**之前**就被吞掉。

## 怎麼證實的（如果要重新驗證）

在 Terax 的 WKWebView 裡（用 Safari 的「開發」選單連進去，右鍵 Inspect Element 在**官方 DMG 版本上沒有**，因為 `src-tauri/Cargo.toml` 的 tauri crate 沒有開 `devtools` feature），Console 貼：

```js
document.addEventListener('keydown', e => console.log(e.key, e.code, e.ctrlKey, e.altKey, e.metaKey, e.isComposing, e.keyCode), true)
```

按 Option+方向鍵，實測結果：

```
ArrowLeft  ArrowLeft  ctrl:false alt:true meta:false composing:false keyCode:229
ArrowRight ArrowRight ctrl:false alt:true meta:false composing:false keyCode:229
```

## 修法

`src/modules/terminal/lib/rendererPool.ts` 裡，排除方向鍵/Backspace 不受 229 判斷影響（這兩種鍵不可能是真的 IME 組字內容）：

```ts
const isNavigationKey =
  event.key === "ArrowLeft" ||
  event.key === "ArrowRight" ||
  event.key === "ArrowUp" ||
  event.key === "ArrowDown" ||
  event.key === "Backspace";
if (event.isComposing || (event.keyCode === 229 && !isNavigationKey)) {
  return false;
}
```

## 這個資料夾裡有什麼

- 完整原始碼（`crynta/terax-ai` main 分支 clone，已包含上面的修法，在 `fix/option-arrow-keycode-229` 分支）
- **不含** `node_modules`、`src-tauri/target`（build 產物太大，用得到時重新跑 `pnpm install`、`pnpm tauri build`/`pnpm tauri dev` 即可重新生成）

## 走過的彎路（別重踩）

1. **懷疑過是 macOS 系統把 Option 鍵重映射成 Cmd 鍵** — 錯的，是測試手法問題（單獨按修飾鍵那一下的 keydown ≠ 組合鍵當下的狀態）。
2. **用 Karabiner-Elements 把 Option+方向鍵轉送成 Ctrl+方向鍵**，繞過這個 bug —— 這條路曾經一度看起來可行（物理 Ctrl+方向鍵直接測是正常的），但透過 Karabiner 模擬出來的 Ctrl+方向鍵在 Terax 裡行為不穩定（左鍵印出字元「D」、右鍵完全無效果），原因沒有查清楚就放棄了，改採從源碼修復。**最終沒有採用這個方案，正式修法是上面這個 keyCode 229 補丁。**
3. 一度猜測是 Karabiner 送出合成鍵盤事件的「時序」問題，嘗試把 `to` 事件拆成兩步（先送 Ctrl 按下、再送 Ctrl+方向鍵）——查證官方文件後證實這個寫法沒有根據，`to.hold_down_milliseconds` 才是真正能插入延遲的參數，且用法跟這個情境不同。這個嘗試已還原。
4. 想過直接修改已安裝 App 內的前端 JS 檔案——不可行，Tauri 把前端資源打包進 Rust 編譯出來的二進位檔本體，`.app/Contents/Resources` 裡沒有可編輯的 JS 檔案，只有圖示。

## 目前使用者本機狀態（2026-07-06）

- `/Applications/Terax.app`：已換成本機自行編譯、含此修法的版本
- `/Applications/Terax.app.official-backup`：原始官方版本備份
- Karabiner-Elements：已安裝，但 Terax 專用的重映射規則已停用（不再需要，因為改用原始碼修法）。若要完全移除：Karabiner-Elements 左側選單 → Maintenance → Uninstall，或跑 `sudo "/Library/Application Support/org.pqrs/Karabiner-Elements/bin/uninstall_karabiner_elements.sh"`，然後 `brew uninstall --cask karabiner-elements`。
- **注意**：Terax 可能會自動更新並嘗試把 `/Applications/Terax.app` 換回官方版（會蓋掉這個修法），直到官方 PR #956 被合併發布為止。若跳出更新提示，先確認要不要保留自編版本。
