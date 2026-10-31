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

## 3.1 客製化 #2：觸控板捲動在 TUI 裡一次跳好幾格（commit `fix(terminal): scale trackpad wheel reports to scrolled lines under mouse tracking`）

- **行為**：在 cc 這類開了 mouse tracking 的 TUI 裡雙指滑動，捲動量要跟手指移動距離成正比，輕滑能只捲一步。
- **原因**：`GhosttyInputController.ts` 的 `handleWheel` 在 mouse tracking 模式下，**每個 wheel 事件固定送一次** 64/65 滾輪回報，完全不看 `deltaY`。觸控板一次滑動會送出幾十個小像素事件（再加慣性），所以一滑就飛走。`deltaY === 0`（純橫向）還會被當成往下捲。一般 shell 捲回歷史那條路本來就有用 `deltaY / cellHeight` 累積，沒問題。
- **修法**：把「像素 → 行數、不滿一行留給下個事件」抽成 `wheelLines()`，兩條路共用；mouse tracking 改成每捲一行送一次回報。反向滑動時清掉舊的餘數，避免要先「還」掉反方向的量。
- **測試**：`GhosttyInputController.test.ts` 的 "reports one wheel step per scrolled line for pixel deltas under mouse tracking"。
- **定位關鍵字**：`command rg -n "deltaY < 0 \? 64 : 65|handleWheel|wheelRemainder" src`
- **驗收**：在 `claude` 裡輸出夠長的內容後，雙指慢慢往上滑，畫面應該一步一步捲，不會一下跳好幾格。外接滑鼠滾一格也要確認仍會捲動。

## 3.2 客製化 #3：Nerd Font 圖示變成方框 □（commit `fix(terminal): register installed Nerd Fonts hidden from WKWebView`）

- **行為**：終端機字型留空（自動偵測）時，prompt、`eza --icons` 等 Nerd Font 私用區（PUA）圖示要正常顯示。
- **原因**：macOS WKWebView **不讓網頁內容看到使用者自行安裝的字型**（`~/Library/Fonts`、`/Library/Fonts`），CoreText 看得到也沒用，打開 WebKit 的 `shouldAllowUserInstalledFonts` 也一樣。`src/lib/fonts.ts` 的 `detectMonoFontFamily` 因此偵測不到 Nerd Font，退回 JetBrains Mono / Menlo，而這兩個都沒有 PUA 字形。官方在 `8ba1a0a` 拿掉了內建 symbol 字型，改成依賴已安裝的 Nerd Font，正好踩到這個限制。已用獨立的 WKWebView 探測程式驗證過。
- **修法**：
  - Rust `src-tauri/src/modules/fonts.rs`：`terminal_nerd_font(families)` 只在 macOS 上，到上述兩個目錄找 `{族名去空白}-Regular.{ttf,otf}`，回傳原始 bytes（找不到就回空 body）。族名必須含 `Nerd Font` 且只能是英數字和空白（防路徑穿越），另外有大小上限與字型 magic 檢查。指令註冊在 `lib.rs` 的 `generate_handler!`。
  - `fonts.ts`：`FALLBACK_CHAIN` 在 JetBrains Mono 後面插入 `"Terax Nerd Symbols"`；`ensureMonoFontsLoaded` 在偵測不到 Nerd Font 時呼叫上述指令，用 `FontFace` 以這個名字註冊。只有 JetBrains Mono 缺的字形會 fallback 過去，一般文字外觀不變。
  - 注意：canvas context 若在字型註冊**前**就設過同一個 `font` 字串，WebKit 會沿用舊的解析結果；目前 glyph rasterizer 是在 `ensureMonoFontsLoaded` 之後才建立 canvas，所以沒問題，重構時要保持這個順序。
- **測試**：`fonts.rs` 的 4 個單元測試；`fonts.test.ts` 的 "registers an installed Nerd Font only when …"。
- **定位關鍵字**：`command rg -n "NERD_FONT_CANDIDATES|FALLBACK_CHAIN|ensureMonoFontsLoaded" src/lib`
- **先看官方是否已修**：如果官方把 symbol 字型加回來，或已改用其他方式載入已安裝字型，這個 commit 就拿掉。
- **驗收**：字型設定留空，在 `zsh` 裡看 prompt 圖示，並執行 `eza --icons`，都不應該出現 □。

## 3.3 客製化 #4：只是移動游標卻變成拖曳選取（commit `fix(terminal): end drags whose release never arrived`）

- **行為**：放開觸控板或滑鼠後，單純移動游標不可以延伸反白選取，也不可以對 TUI 回報拖曳。
- **原因**：結束拖曳只靠收到放開事件。只要漏掉一次（輕點觸控板時剛好碰上失焦、在 pane 外放開、放開時按著 Shift 等），狀態就會卡在「按著」。
  - `TerminalSelectionController.ts` 的 `handlePointerMove` 只比對 `pointerId`，不看 `event.buttons` → shell 裡反白跟著游標跑（使用者實際遇到的情況）。
  - `GhosttyInputController.ts` 的 `mouseButtons` 只在 `handleMouseUp` 清除，而它有好幾個提前 return → mouse tracking（1002）下會把移動回報成拖曳。
- **修法**：每次 move 都用 `event.buttons` 校正。
  - 選取：`(event.buttons & 1) === 0` 就呼叫 `endDrag`（從 `handlePointerUp` 拆出來的收尾邏輯，**不會**先把選取延伸到目前游標位置）。
  - 輸入：`this.mouseButtons &= mouseEventButtons(event.buttons)`。注意 `buttons` 的位元是右鍵=2、中鍵=4，`1 << button` 是中鍵=2、右鍵=4，要靠 `mouseEventButtons` 轉換。
- **測試**："ends a drag whose pointerup was lost instead of extending it on hover"、"stops reporting button motion once the pressed button is no longer held"、"maps MouseEvent.buttons onto the 1 << button layout"。selection 測試 fixture 的 `pointer()` 現在會帶 `buttons`（預設 `pointerup` 為 0，其餘為 1）。
- **定位關鍵字**：`command rg -n "handlePointerMove|mouseButtons" src/modules/terminal/ghostty`

## 3.4 客製化 #5：Markdown 清單按 Enter 多出一行空行（commit `fix(editor): continue Markdown lists without inserting blank lines`）

- **行為**：在 `.md` 的 `- …` 行尾按 Enter，下一行直接出現 `- `，中間不會多一行空行；在空的項目上按 Enter 就結束清單。
- **原因**：Terax 直接用 `@codemirror/lang-markdown` 預設的 Enter（`insertNewlineContinueMarkup`）。它有兩個刻意設計的行為：(1) 清單的第 1、2 項之間有空行（loose list）時，每次 Enter 都補一行空行，維持鬆散格式；(2) 在空的第 2 項上按 Enter，不是結束清單，而是把清單改成 loose，之後就一直觸發 (1)。
- **修法**：`src/modules/editor/lib/markdownEnter.ts`
  - 使用 `insertNewlineContinueMarkupCommand({ nonTightLists: false })` 關掉 (2)。
  - 包一層 `dispatch`：插入的文字如果是「換行＋只有縮排或 `>` 的空行＋換行」開頭（`LOOSE_GAP`），就拿掉那行空行，再重新建立 transaction，selection 用 `map(changeSet, 1)` 對應過去。
  - `languageDefinitions.ts` 的 Markdown loader 改成 `markdown({ addKeymap: false })`，再加上 `markdownKeymap()`（Enter → 上面的指令；Backspace → 原本的 `deleteMarkupBackward`）。
- **測試**：`markdownEnter.test.ts`（tight/loose/巢狀 loose/空項目/引用/行中斷開）。
- **定位關鍵字**：`command rg -n "lang-markdown" src/modules/editor`
- **先看官方是否已修**：如果升級後的 `@codemirror/lang-markdown` 有提供關掉 loose 補空行的選項，就改用官方選項。

## 3.4.1 客製化 #6：三指拖曳中按鍵後，游標移動仍在拖曳（commit `fix(app): end script-driven drags when a key is pressed`，`src/lib/dragKeyGuard.ts`）

- **狀態**：2026-10-31 使用者實機確認解決。新版 log 有 `drag-ended-by-key`，且沒有再出現 `ANOMALY`。
- **別再重新排查（分層測試結果）**：
  - 三指拖曳中，只有非修飾鍵會觸發：⌘C/V/X/A/;、F6、⌃; 會；不按鍵、單按 ⌘ 不會。⌘F 或一般文字在 cc 裡會蓋掉症狀（取消選取），F6 在 cc 裡看不到、在純 shell 看得到，所以要在純 shell 驗證。
  - 純 WKWebView 的原生選取、tao + wry 的原生選取都不會黏著；同一個純 WKWebView 加上 JS 實作的拖曳就會。所以原因是「script 拖曳照著 `buttons` 走」，不是 wry/tao/Tauri 的 bug，也不是輸入法或原生選單。
  - 其他 macOS 軟體不會發生，這是使用者的實測結論，不要再質疑。

- **行為**：拖曳中按下非修飾鍵（⌘C、F6、⌃; 等）就結束拖曳，放開手指後單純移動游標不可再延伸選取。單按 ⌘、Shift、⌥ 不影響拖曳。
- **原因**：三指拖曳中按非修飾鍵後，`buttons` 會持續回報左鍵按著，直到下一次輕點。原生文字選取不會因此繼續延伸，但用 script 實作的拖曳（終端機選取、CodeMirror、分頁排序）只看 `buttons`，就會一路跟著游標。純 WKWebView 加上一段 JS 拖曳即可重現，與 Terax 其他程式無關，所以 #4 的 `buttons` 校正擋不到。
- **修法**：`main.tsx` 在 render 前安裝 `installDragKeyGuard`，在 window capture 階段追蹤左鍵按壓；遇到非修飾鍵就對按下時的 target 發出 `pointercancel` 與 `mouseup`。用 cancel 而不是 up，分頁排序、檔案移動才不會被提交；`mouseup` 是因為 CodeMirror 和終端機滑鼠回報只認它。
- **測試**：`src/lib/dragKeyGuard.test.ts`。
- **定位關鍵字**：`command rg -n "installDragKeyGuard|HeldPointerTracker" src`
- **驗收**：在 shell、`claude`、`.md` 分頁各試一次：三指拖曳選字，手指不離開時按 F6 或 ⌘C，放開後單指移動游標，選取不可跟著跑。
- **合併衝突時**：
  - 這個修法是獨立新檔，幾乎只有 `main.tsx` 會衝突。原則是 `installDragKeyGuard()` 要在 `render` 之前呼叫，才會先於會 `stopImmediatePropagation` 的全域快捷鍵（`useGlobalShortcuts.ts`）。
  - 官方若重寫拖曳，確認每個 script 拖曳仍能被 `pointercancel` 或 `mouseup` 結束：`command rg -n "pointercancel|\"mouseup\"|onPointerCancel" src`。新增的拖曳要有 cancel 處理，且 cancel 不可提交（分頁排序、檔案移動）。
  - 官方若自己處理了按鍵結束拖曳，就拿掉這個 commit，再照上面的驗收確認。

## 3.4.2 客製化 #7：輸入法組字視窗跑到終端左上角（commit `fix(terminal): keep the input on the cursor cell for IME windows`）

- **行為**：用中文輸入法組字時，組字與選字視窗要出現在終端游標旁邊，WebGPU 和 WebGL 都一樣。
- **原因**：系統依焦點輸入框的文字位置放置輸入法視窗，而兩個 surface 的隱藏 `textarea` 都寫死 `left:0;top:0;width:1px;height:1px`。用 WKWebView 探測 `firstRectForCharacterRange` 可重現：舊樣式回報 `x≈6～10, y≈1`，而且 1px 寬會讓文字逐字折行，組字起點的座標還會跑到視窗外（`y=-181`）。
- **修法**：`input/terminalInputAnchor.ts`
  - `TERMINAL_INPUT_STYLE`：兩個 surface 共用，去掉 padding、border，不折行。
  - `terminalInputAnchor`：算出游標格的位置，寬度延伸到行尾，高度與行高等於格高，組字文字才不會捲動。游標隱藏時也要跟（cc 這類 TUI 會隱藏游標）。
  - `applyTerminalInputAnchor`：每個 frame 呼叫，只寫有變動的屬性；`pointerEvents === "auto"` 代表 `TerminalNativeSelection` 正把輸入框借給右鍵選單，此時不動。
- **測試**：`terminalInputAnchor.test.ts`，以及兩個 surface 測試的 "keeps the input on the cursor cell …"。
- **定位關鍵字**：`command rg -n "terminalInputAnchor|TERMINAL_INPUT_STYLE" src`，以及 `command rg -n "position:absolute;left:0;top:0;width:1px" src`（官方若改動樣式，先查這個）。
- **驗收**：分別在 zsh 和 `claude` 輸入框用中文輸入法打字，組字視窗要在游標旁；換行、分割窗格後也一樣；右鍵選單的「拷貝」仍可用。

## 3.4.3 客製化 #8：輕點分頁沒切換，分頁還黏在游標上（commit `fix(app): keep mouse events in order while a text field is focused`，`src-tauri/src/modules/mouse_input_context.rs`）

- **狀態**：2026-10-31 使用者實機確認解決。新版 log 按下 41 次、放開 41 次，順序全部正確。
- **別再重新排查（分層測試結果）**，以下都是鼠鬚管、不到 1ms 的輕點，「顛倒數/次數」：

  | 環境 | 結果 |
  |---|---|
  | Terax | 7/7 |
  | 純 WKWebView＋有焦點的文字框 | 8/8 |
  | 同上，加上本修法 | 0/10 |
  | 純 WKWebView，無文字框 | 0/3 |
  | tao＋wry，無文字框 | 0/8 |

  - `CGEventTap` 與 App 層看到的順序一直正確，所以不是 macOS，也不是 Tauri、wry、tao。
  - 系統注音 0/4，樣本少，且當時實際輸入法未驗證。鼠鬚管 master 的 `recognizedEvents` 只有 `keyDown`、`flagsChanged`，它為何造成亂序仍未知。
- **行為**：輕點一定是先按下、後放開；分頁會切換，不會黏在游標上，cc 也不會把移動當成拖曳。
- **原因**：macOS 的輕點有約 17ms 與不到 1ms 兩種。焦點在可編輯元素時，WebKit 的 `WebViewImpl::nativeMouseEventHandler` 會把滑鼠事件交給 `-[NSTextInputContext handleEvent:completionHandler:]`，等回呼才送給網頁；不到 1ms 的那種在鼠鬚管下會變成放開先到。`TabBar.tsx` 先收到放開就不切換，再收到按下就等一個不會來的放開。下一次輕點 WebKit 也不會送 `pointerdown`。
- **修法**：`main` 視窗的 web view 類別上，覆寫 12 個滑鼠 selector 與 `inputContext`。處理滑鼠事件的當下 `inputContext` 回傳 nil，WebKit 就直接同步送出；打字與組字仍看到原本的值。移動事件也要涵蓋，否則還在排隊的移動會排到按下之後，帶著 `buttons=0` 打斷選取。
- **類別不要用名稱查**：wry 的執行期類別名稱是 `wry::wkwebview::class::wry_web_view::WryWebView0.57.0`，會隨版本變動，要從實例取 `-class`。
- **測試**：`mouse_input_context.rs` 的 "hides_the_input_context_only_during_mouse_calls"。
- **定位關鍵字**：`command rg -n "mouse_input_context" src-tauri/src`；WebKit 端看 `nativeMouseEventHandler`。
- **驗收**：
  - 啟動後 `Terax.log` 要有 `mouse events bypass the input context`，沒有就代表 hook 沒裝上。
  - 用鼠鬚管、觸控板輕點不同分頁 20 次，每次都切換且不黏著。
  - 三指拖曳選字、拖曳分頁排序正常；組字到一半點別的分頁，回來可繼續打字。
- **合併衝突時**：這是獨立新檔，只有 `lib.rs` 的 `install` 呼叫與 `mod.rs` 可能衝突。若 WebKit 或 wry 改了 `inputContext` 判斷或類別結構，先照上面的驗收確認。官方若自己修好就拿掉這個 commit。

## 3.4.4 客製化 #9：方塊游標把文字蓋住（commit `fix(terminal): keep text readable under a gently blinking block cursor`）

- **狀態**：2026-10-31 使用者實機確認效果良好。
- **行為**：Cursor style 選 Block 時，方塊內的文字用反差色顯示，停在中文字上會蓋滿兩格；開啟 Cursor blink 時方塊在深淺之間微微閃爍，不會整個消失。Bar、Underline 維持原本的閃爍方式。
- **原因**：文字其實畫在方塊上方，只是和方塊同色；主題的 `cursorAccent` 沒有接到 GPU 繪製，方塊也固定一格寬。
- **修法**：
  - `terminalVisuals.ts` 的 `cursorText` 讀 `cursorAccent`。
  - WebGPU：`shaders.ts` 的 `cursor_contains` 同時決定方塊範圍與文字換色；`Screen` 新增 `cursor_text_color`。
  - WebGL：`WebGlCellRenderer.ts` 的 glyph 著色器用 `u_cursor_rect`、`u_cursor_text` 換色；寬度由 `blockCursorSpan` 算出。
  - 閃爍：`dimmedBlockCursorColor` 把方塊往背景色淡化 35%。沿用既有的 600ms 計時，不做逐格動畫，避免持續重繪。
- **測試**：`terminalGeometry.test.ts` 的 "block cursor"、`ScreenUniform.test.ts` 的游標文字色。單元測試跑不了著色器，改動後要實機看。
- **定位關鍵字**：`command rg -n "cursor_contains|cursorText|blockCursorSpan|dimmedBlockCursorColor" src`
- **驗收**：亮暗主題都試，WebGPU 和 WebGL 都要一樣：方塊停在英文、中文、彩色文字上都看得清楚；分割窗格與視窗縮小時，換色範圍仍對齊方塊。
- **合併衝突時**：官方若改了 `Screen` 的版面，`SCREEN_OFFSET`、WGSL struct、`SCREEN_UNIFORM_BYTES` 要一起改，`ScreenUniform.test.ts` 會檢查三者一致。

## 3.4.5 客製化 #10：快捷鍵切換左右相鄰分頁（commit `feat(tabs): switch to the adjacent tab with Cmd+Ctrl+brackets`）

- **行為**：`⌘⌃[` / `⌘⌃]` 激活當前 Space 內，標籤列上左邊/右邊的分頁。到兩端會繞回另一端，按住可連續切換，不跳切換面板。可在設定頁 Tabs 群組改鍵。
- **為什麼不用 `⌘⇧[` / `]`**：那組已是 `space.prev` / `space.next`。官方的 `SHORTCUT_GROUPS` 漏列 `"Spaces"`，所以設定頁看不到也改不了。使用者決定在官方開放設定前不動 Space 的快捷鍵，所以**不要**把 `"Spaces"` 補進清單，也不要改它的預設鍵。
- **為什麼不重用 `tab.next` / `tab.prev`**：`Ctrl+Tab` 是最近使用順序的切換面板，不是標籤列順序。
- **修法**：
  - `useTabs.ts` 的 `pickAdjacentTab`：純函式，負責 Space 篩選與繞回。
  - `shortcuts.ts`：新增 `tab.left` / `tab.right`，綁定明確寫 `meta` + `ctrl`，不用 `MOD_PROP`，否則非 macOS 上會變成 `Ctrl+[`，而那是終端機的 ESC。
  - `matchBinding`：綁定同時有 `ctrl` 和 `meta` 時也比對 `e.code`，因為 Control 可能改寫 `e.key`（`Ctrl+[` 是 ESC 控制字元）。
- **測試**：`pickAdjacentTab.test.ts`；`shortcuts.test.ts` 的 "falls back to the physical code for Cmd+Ctrl combinations"、"binds adjacent tab switching …"。
- **定位關鍵字**：`command rg -n "pickAdjacentTab|tab\.left|tab\.right" src`
- **先看官方是否已修**：官方若新增標籤列順序的切換動作，就改用官方動作並拿掉這個 commit；若官方開放 Space 設定，再問使用者要不要調整。
- **驗收**：開三個分頁，分別在 zsh、`claude`、編輯器分頁按 `⌘⌃[` / `⌘⌃]`，要依標籤列順序切換並繞回，按鍵不可輸入到終端；拖曳分頁改順序後要照新順序；`⌘⇧[` / `]` 仍是切換 Space。

## 3.5 暫時性診斷：拖曳黏著 trace（已移除）

`3ecd7d0` 加入、#8 解決後移除。升級時這兩個 commit 都不要 cherry-pick。若拖曳黏著再次發生，可從 `3ecd7d0` 取回。

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
- **cherry-pick 有衝突時**：以第 1～3 節的「行為」和「原因」為準，不要硬保留舊 diff。先看該節的「定位關鍵字」找到新位置，在新結構上重寫，再用該節的測試和驗收確認。同一個 commit 不要混入官方變更。
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
- 2026-10-31：找到三指拖曳中按鍵造成拖曳黏著的根源，加上 `dragKeyGuard`（#6）。同日查出事件順序顛倒是 WebKit 的輸入法路徑加上鼠鬚管所致，以 `mouse_input_context` 解決（#8）。
