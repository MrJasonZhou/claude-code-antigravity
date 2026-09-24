[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

一個 Claude Code 外掛：把工作交給 **Google Antigravity CLI（`agy`）**，再把結果帶回來，用法與 Codex 外掛相同。agy 執行 Gemini（以及它託管的 Claude 和 GPT-OSS 模型），具備 Google 搜尋、影像生成和超大上下文視窗，因此很適合作為 Claude 的第二個 agent。

## 安裝

```bash
claude plugin marketplace add /path/to/agy_plugin
claude plugin install agy@agy-plugin
```

需求：Node ≥ 18，且 `agy` 位於 `PATH` 中（或設定 `AGY_BIN`）。你必須至少執行過一次 `agy` 並完成登入。執行 `/agy:setup` 可檢查所有設定，並查看配額和可用模型。

## 指令

| 指令 | 作用 |
|---|---|
| `/agy:task <task>` | 委派工作：實作、修正、調查。後續跟進時可選擇繼續上一次的 agy 對話。 |
| `/agy:ask <question>` | 針對整個程式碼庫的唯讀提問，或徵求第二意見。 |
| `/agy:review` | 結構化程式碼審查。目標：未提交的變更、某個分支（`--base`）、單一提交（`--commit <sha>`）或 GitHub PR（`--pr <n>`，使用 `gh`）。發現的問題依嚴重程度排序，並附上 file:line。 |
| `/agy:adversarial-review` | 對設計、其假設以及它在實際使用中如何失敗進行質疑式審查。 |
| `/agy:critique <plan or file>` | 在撰寫任何程式碼之前，對計畫、設計文件或 RFC 進行對抗式審查。agy 會用實際程式碼逐條檢驗每個假設。 |
| `/agy:compare <question>` | 平行向多個模型提出同一問題（預設 `pro,opus,gpt`，即透過 agy 呼叫 Gemini、Claude 和 GPT）。接著由 Claude 總結它們的共識與分歧。 |
| `/agy:apply [id]` | 套用 `--worktree` 任務產生的修補檔。必要時退回三方合併。 |
| `/agy:research <question>` | 根據即時 Google 搜尋回答，並附上來源 URL。 |
| `/agy:image <description>` | 生成影像。檔案儲存到 `agy-images/`，或 `--out` 指定的目錄。 |
| `/agy:status [id]`、`/agy:result [id]`、`/agy:cancel [id]` | 管理背景工作。 |
| `/agy:transfer [note]` | 把目前的 Claude Code 工作階段移交給 agy。agy 會閱讀精簡後的對話紀錄、檢查工作區，並回覆目標、進度、未解決問題和後續步驟。可在終端機用 `agy --conversation <id>` 繼續，或在 Claude 中用 `/agy:task --resume-last` 繼續。 |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | 檢查安裝與驗證，顯示配額和模型，並為目前工作區開啟或關閉停止時審查閘門。 |

### 停止時審查閘門

預設關閉。用 `/agy:setup --enable-review-gate` 依工作區開啟。當 Claude 即將停止、且工作樹中有 agy 尚未審查過的未提交變更時，agy 會審查這些變更。如果發現具體缺陷，它會阻止停止，並把發現的問題交回給 Claude 處理。

- 每個不同的工作樹狀態只審查一次，依據是完整內容的指紋。被 agy 阻止過的狀態會一直保持阻止，直到程式碼改變；再次停止不會第二次呼叫 agy。
- 連續阻止 3 次後，閘門會放行停止，因此不會無限循環。
- 如果 agy 失敗（服務中斷、配額用盡、逾時），停止會直接放行。故障的閘門絕不會困住工作階段。

Claude 也可以自行呼叫 **`agy-delegate`** 子 agent，用於取得第二意見、全程式碼庫問題、最新的網路資訊，或範圍明確的任務。

### 常用參數

- **權限策略。** agy 的無頭模式無法向你請求核准。任何超出所選策略的工具都會終止執行，輸出中會說明原因。
  - *（預設）* 唯讀：agy 可以讀取檔案，但不能編輯檔案或執行 shell 指令。
  - `--write`：agy 可以編輯工作區中的檔案（`agy --mode accept-edits`）。
  - `--worktree`：agy 在一個拋棄式 git worktree 中編輯，該 worktree 預先放入你目前未提交和未追蹤的檔案（符號連結保持為連結）。被忽略的相依目錄（如 `node_modules` 和 `.venv`）會以連結方式接入，以便執行測試，且它們絕不會進入修補檔。需要至少一個提交；若子模組有未提交變更則拒絕執行。結果以修補檔形式返回，用 `/agy:apply` 套用。你自己的工作樹不會被觸碰，因此多個 agy 任務和 Claude 可以同時工作。
  - `--yolo`：agy 還可以執行 shell 指令和擷取 URL（`agy --dangerously-skip-permissions`）。僅在你明確要求時使用。
- **讓 agy 執行測試。** 使用 `/agy:setup --allow-command "npm test"`。該規則儲存在 agy 自己的全域 `settings.json` 中，因此也會作用於你的互動式 agy 工作階段。用 `--revoke-command` 移除。agy 會被明確告知可以執行哪些指令，因此不需要 `--yolo` 就能執行測試並反覆修改直到通過。開放式規則（`bash -c`、`python3 -c`、`npm exec`、`uv run` 等）和 shell 特殊字元會被拒絕。這項檢查用於防止無意間過寬的規則，它不是沙箱：被允許的測試指令會執行專案程式碼，而在 `--write` 模式下 agy 可以編輯這些程式碼。
- **Best-of-N。** `/agy:task --worktree --models pro,opus,gpt <task>` 讓每個模型在各自的 worktree 中獨立實作任務。Claude 比較這些修補檔，由你選擇套用哪一個。
- `--prompt-file <path>` 把檔案內容加入提示詞。適用於大型日誌、堆疊追蹤或規格說明；在 Linux 上單一命令列參數上限為 128 KB。
- `/agy:result <id> --wait` 會阻塞直到背景工作完成。
- `--background` 在背景執行工作。從斜線指令啟動時，它作為 Claude 背景任務執行，因此 agy 完成時 Claude 會收到通知。接著使用 `/agy:status` 和 `/agy:result`。
- `--resume-last` 繼續該工作區中最近一次完成的 agy 對話。`--resume <conversation-id>` 繼續指定的對話。
- `--model <id|pro|flash|opus|sonnet|gpt>` 選擇模型。別名會解析為最新的相符模型，並優先選擇 `-high` 變體。
- `--effort low|medium|high`、`--add-dir <dir>`、`--timeout <sec>`、`--agent <custom agy agent>`、`--json`。

### agy 收到什麼，你得到什麼

- **共用專案規則。** agy 會自行讀取 `GEMINI.md` 和 `AGENTS.md`。外掛還會把從工作目錄到儲存庫根目錄的每個 `CLAUDE.md` / `CLAUDE.local.md` 指給它，使兩個 agent 遵循相同的慣例。
- **影像輸入。** agy 是多模態的。在任何任務中以路徑提及截圖、設計稿或圖表即可，例如 "implement design/mock.png" 或 "why is the chart in bug.png empty?"。
- **瀏覽器檢查。** agy 具備瀏覽器工具。在安裝了 Chrome 的環境中，`--yolo` 任務可以開啟你的開發伺服器、點擊操作並截圖。
- **稽核紀錄。** 每個結果都會列出 agy 執行的 shell 指令，並標記 ✓ 或 ✗。`/agy:status <id>` 顯示工具呼叫的完整時間軸，包括耗時和錯誤。

## 運作原理

`plugins/agy/scripts/agy-companion.mjs` 是一個無相依套件的單檔 Node 腳本。它會：

1. 建立帶固定前言的提示詞：工作區根目錄、工具策略，以及「沒有人在旁觀看」。提示詞透過 **stdin** 傳給 agy，因此大型 diff 不會觸及 argv 限制。它執行 `agy --output-format stream-json`。
2. 把事件串流寫入 `~/.cache/agy-plugin/jobs/` 下的工作紀錄（可用 `AGY_PLUGIN_DATA` 覆寫）。紀錄包含即時進度、agy 編輯過的檔案、被拒絕的工具、token 用量和 agy 對話 id。
3. 產生 Markdown 報告。審查使用 `--json-schema` 搭配 `schemas/review.schema.json`，並呈現為依嚴重程度排序的發現。agy 在 `~/.gemini/antigravity-cli/brain/<conversation>/` 中建立的檔案會列為產物，影像會被複製到專案中。

## 測試

```bash
node tests/companion.test.mjs   # 使用假的 agy 執行檔；不需要網路或配額
```
