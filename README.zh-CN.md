[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# agy for Claude Code

一个 Claude Code 插件：把工作交给 **Google Antigravity CLI（`agy`）**，再把结果带回来，用法与 Codex 插件相同。agy 运行 Gemini（以及它托管的 Claude 和 GPT-OSS 模型），具备 Google 搜索、图像生成和超大上下文窗口，因此很适合作为 Claude 的第二个 agent。

## 安装

```bash
claude plugin marketplace add /path/to/agy_plugin
claude plugin install agy@agy-plugin
```

要求：Node ≥ 18，且 `agy` 在 `PATH` 中（或设置 `AGY_BIN`）。你必须至少运行过一次 `agy` 并完成登录。运行 `/agy:setup` 可检查所有配置，并查看配额和可用模型。

## 命令

| 命令 | 作用 |
|---|---|
| `/agy:task <task>` | 委派工作：实现、修复、调查。后续跟进时可选择继续上一次的 agy 对话。 |
| `/agy:ask <question>` | 针对整个代码库的只读提问，或征求第二意见。 |
| `/agy:review` | 结构化代码审查。目标：未提交的改动、某个分支（`--base`）、单个提交（`--commit <sha>`）或 GitHub PR（`--pr <n>`，使用 `gh`）。发现的问题按严重程度排序，并附带 file:line。 |
| `/agy:adversarial-review` | 对设计、其假设以及它在实际使用中如何失败进行质疑式审查。 |
| `/agy:critique <plan or file>` | 在写任何代码之前，对计划、设计文档或 RFC 进行对抗式审查。agy 会用实际代码逐条检验每个假设。 |
| `/agy:compare <question>` | 并行向多个模型提出同一问题（默认 `pro,opus,gpt`，即通过 agy 调用 Gemini、Claude 和 GPT）。随后由 Claude 总结它们的共识与分歧。 |
| `/agy:apply [id]` | 应用 `--worktree` 任务产生的补丁。必要时回退到三方合并。 |
| `/agy:research <question>` | 基于实时 Google 搜索回答，并附上来源 URL。 |
| `/agy:image <description>` | 生成图像。文件保存到 `agy-images/`，或 `--out` 指定的目录。 |
| `/agy:status [id]`、`/agy:result [id]`、`/agy:cancel [id]` | 管理后台任务。 |
| `/agy:transfer [note]` | 把当前 Claude Code 会话移交给 agy。agy 会阅读压缩后的对话记录、检查工作区，并回复目标、进展、未解决问题和后续步骤。可在终端用 `agy --conversation <id>` 继续，或在 Claude 中用 `/agy:task --resume-last` 继续。 |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | 检查安装和认证，显示配额和模型，并为当前工作区开启或关闭停止时审查门。 |

### 停止时审查门

默认关闭。用 `/agy:setup --enable-review-gate` 按工作区开启。当 Claude 即将停止、且工作树中有 agy 尚未审查过的未提交改动时，agy 会审查这些改动。如果发现具体缺陷，它会阻止停止，并把发现的问题交回给 Claude 处理。

- 每个不同的工作树状态只审查一次，依据是完整内容的指纹。被 agy 阻止过的状态会一直保持阻止，直到代码发生变化；再次停止不会第二次调用 agy。
- 连续阻止 3 次后，门会放行停止，因此不会无限循环。
- 如果 agy 失败（服务中断、配额耗尽、超时），停止会直接放行。坏掉的门绝不会困住会话。

Claude 也可以自行调用 **`agy-delegate`** 子 agent，用于获取第二意见、全代码库问题、最新的网络信息，或边界清晰的任务。

### 常用参数

- **权限策略。** agy 的无头模式无法向你请求批准。任何超出所选策略的工具都会终止运行，输出中会说明原因。
  - *（默认）* 只读：agy 可以读取文件，但不能编辑文件或运行 shell 命令。
  - `--write`：agy 可以编辑工作区中的文件（`agy --mode accept-edits`）。
  - `--worktree`：agy 在一个一次性的 git worktree 中编辑，该 worktree 预先放入你当前未提交和未跟踪的文件（符号链接保持为链接）。被忽略的依赖目录（如 `node_modules` 和 `.venv`）会以链接方式接入，以便运行测试，且它们绝不会进入补丁。需要至少一个提交；若子模块有未提交改动则拒绝运行。结果以补丁形式返回，用 `/agy:apply` 应用。你自己的工作树不会被触碰，因此多个 agy 任务和 Claude 可以同时工作。
  - `--yolo`：agy 还可以运行 shell 命令和获取 URL（`agy --dangerously-skip-permissions`）。仅在你明确要求时使用。
- **让 agy 运行测试。** 使用 `/agy:setup --allow-command "npm test"`。该规则存储在 agy 自己的全局 `settings.json` 中，因此也会作用于你的交互式 agy 会话。用 `--revoke-command` 移除。agy 会被明确告知可以运行哪些命令，因此无需 `--yolo` 就能运行测试并迭代到通过。开放式规则（`bash -c`、`python3 -c`、`npm exec`、`uv run` 等）和 shell 元字符会被拒绝。这项检查用于防止无意中过宽的规则，它不是沙箱：被允许的测试命令会运行项目代码，而在 `--write` 模式下 agy 可以编辑这些代码。
- **Best-of-N。** `/agy:task --worktree --models pro,opus,gpt <task>` 让每个模型在各自的 worktree 中独立实现任务。Claude 比较这些补丁，由你选择应用哪一个。
- `--prompt-file <path>` 把文件内容加入提示词。适用于大型日志、堆栈跟踪或规格说明；在 Linux 上单个命令行参数上限为 128 KB。
- `/agy:result <id> --wait` 阻塞直到后台任务完成。
- `--background` 在后台运行任务。从斜杠命令启动时，它作为 Claude 后台任务运行，因此 agy 完成时 Claude 会收到通知。随后使用 `/agy:status` 和 `/agy:result`。
- `--resume-last` 继续该工作区中最近一次完成的 agy 对话。`--resume <conversation-id>` 继续指定的对话。
- `--model <id|pro|flash|opus|sonnet|gpt>` 选择模型。别名会解析为最新的匹配模型，并优先选择 `-high` 变体。
- `--effort low|medium|high`、`--add-dir <dir>`、`--timeout <sec>`、`--agent <custom agy agent>`、`--json`。

### agy 收到什么，你得到什么

- **共享项目规则。** agy 会自行读取 `GEMINI.md` 和 `AGENTS.md`。插件还会把从工作目录到仓库根目录的每个 `CLAUDE.md` / `CLAUDE.local.md` 指给它，使两个 agent 遵循相同的约定。
- **图像输入。** agy 是多模态的。在任何任务中按路径提及截图、设计稿或图表即可，例如 "implement design/mock.png" 或 "why is the chart in bug.png empty?"。
- **浏览器检查。** agy 具备浏览器工具。在安装了 Chrome 的环境中，`--yolo` 任务可以打开你的开发服务器、点击操作并截图。
- **审计记录。** 每个结果都会列出 agy 运行的 shell 命令，并标记 ✓ 或 ✗。`/agy:status <id>` 显示工具调用的完整时间线，包括耗时和错误。

## 工作原理

`plugins/agy/scripts/agy-companion.mjs` 是一个无依赖的单文件 Node 脚本。它做以下事情：

1. 构建带固定前言的提示词：工作区根目录、工具策略，以及"没有人在旁观看"。提示词通过 **stdin** 传给 agy，因此大型 diff 不会触及 argv 限制。它运行 `agy --output-format stream-json`。
2. 把事件流式写入 `~/.cache/agy-plugin/jobs/` 下的任务记录（可用 `AGY_PLUGIN_DATA` 覆盖）。记录包含实时进度、agy 编辑过的文件、被拒绝的工具、token 用量和 agy 对话 id。
3. 渲染 Markdown 报告。审查使用 `--json-schema` 配合 `schemas/review.schema.json`，并渲染为按严重程度排序的发现。agy 在 `~/.gemini/antigravity-cli/brain/<conversation>/` 中创建的文件会作为产物列出，图像会被复制到项目中。

## 测试

```bash
node tests/companion.test.mjs   # 使用假的 agy 二进制；不需要网络或配额
```
