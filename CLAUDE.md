# CLAUDE.md

本仓库是 Claude Code 插件 **agy**：把任务、代码审查、网络检索和图像生成交给 Google Antigravity CLI（`agy`，运行 Gemini / Claude / GPT-OSS），再把结果带回 Claude。整体设计仿照 Codex 插件。用户文档见 `README.md`（另有 7 种语言译本 `README.*.md`，修改英文版时要同步更新译本）。

## 目录结构

- `.claude-plugin/marketplace.json`：本地 marketplace `agy-plugin`，版本号与 `plugin.json` 保持一致。
- `plugins/agy/scripts/agy-companion.mjs`：**全部逻辑都在这一个文件里**。单文件 Node 脚本，零依赖，Node ≥ 18。子命令入口表见文件末尾的 `COMMANDS`，另外还有 `hook-session-start` 和 `hook-stop` 两个 hook 入口。
- `plugins/agy/commands/*.md`：斜杠命令 `/agy:*`，只负责调用 companion，不写业务逻辑。
- `plugins/agy/agents/agy-delegate.md`：Claude 可以自行调用的子 agent。
- `plugins/agy/skills/agy-runtime/SKILL.md`：给 Claude 看的调用约定。
- `plugins/agy/hooks/hooks.json`：SessionStart（为 `/agy:transfer` 提供对话记录路径）和 Stop（可选的停止时审查门）。
- `plugins/agy/schemas/review.schema.json`：review 的 `--json-schema` 输出结构。
- `tests/companion.test.mjs`：使用假的 agy 二进制，不需要网络，也不消耗配额。

## 常用命令

```bash
node tests/companion.test.mjs                     # 全部测试，每次提交前必须通过
claude plugin validate plugins/agy                # 校验清单
```

**安装与更新**：本机装的是 GitHub 上的 marketplace `agy-plugin`（`MrJasonZhou/claude-code-antigravity`，分支 `master`）。本地改动推送后按下面的步骤更新，然后重启 Claude Code：

```bash
claude plugin marketplace update agy-plugin
claude plugin update agy@agy-plugin    # 按版本号判断；不生效就先 uninstall 再 install
```

**未推送的改动只想在本机测试时**：本地目录的 marketplace 也叫 `agy-plugin`，会和 GitHub 那个同名冲突，所以要先换源，测完再换回来：

```bash
claude plugin uninstall agy@agy-plugin && claude plugin marketplace remove agy-plugin
claude plugin marketplace add "$PWD" && claude plugin install agy@agy-plugin
# 测完后执行同样两行，把 "$PWD" 换成 MrJasonZhou/claude-code-antigravity
```

运行时数据位于 `~/.cache/agy-plugin/`（可用 `AGY_PLUGIN_DATA` 覆盖），agy 可执行文件可以用 `AGY_BIN` 指定。

## 开发历程（按阶段）

1. **基础功能**：task / ask / review / research / image，后台任务，status / result / cancel。
2. **停止时审查门 + 会话移交**（`/agy:transfer`）。
3. **隔离与协作**：`--worktree` + `/agy:apply`、命令白名单 `--allow-command`、`/agy:compare` 多模型并行、`review --commit/--pr`、Best-of-N（`--models`）、`--prompt-file`、`result --wait`、`/agy:critique`、命令审计记录。
4. **交替审查加固**：让 agy 和 Codex 轮流做只读审查，Claude 修复，前后约 10 轮，直到两边都没有新发现。修复主要集中在白名单绕过、进程组清理、锁与原子写、worktree 边界情况以及子目录路径。
5. 补充多语言 README，发布到 GitHub（`MrJasonZhou/claude-code-antigravity`），本机改为从 GitHub 安装 v0.1.0。
6. 适配 agy 1.3.4（v0.1.2–0.1.3）：模型别名配合 `--effort` 解析为基础名，`pro` 别名随 Gemini Pro 下线而失效，`/agy:compare` 默认改为 `gemini,opus,gpt`；新增 `--sandbox` 模式。

## 设计决策（不要回退）

这些决策都是在审查中踩坑后才确定的，改动前请先理解原因。

**白名单守卫（`positionals` / `NEVER` / `OPEN_ENDED_TOOL` / `LAUNCHER_SUB`）**
- 规则要**按结构判断，不靠枚举**：以启动器子命令（`exec`、`run`、`task`、`init`、`create`、`x`、`dlx`……）结尾的规则，不论是什么工具一律拒绝；不带 `=` 的裸选项一律视为可能带参数值；`-m <module>` 视为子命令。以后遇到新的包管理器，应该靠结构规则挡住，而不是往列表里补名字。
- 会逐个 token 检查，包括末尾的选项，也会跳过 `FOO=bar` 这样的环境变量前缀，并拒绝 shell 元字符和内联代码参数（`-c`、`-e`、`--eval`……）。
- 这个守卫**不是沙箱**，只用来防止规则无意中写得过宽。文档里必须如实说明这一点。

**进程生命周期**
- agy 以独立进程组启动。清理残留进程要在子进程的 `exit` 事件里做，不能等 `close`，因为后台进程继承了 stdio，`close` 会迟迟不来。清理顺序是先 TERM，5 秒后再 KILL。
- 只向**组长 pid 已经不存在**的进程组发信号，避免 pid 被复用后误杀别的进程。pid 身份用 `/proc` 中的启动时间确认，在有 `/proc` 的系统上判断失败就按“不是同一进程”处理（fail closed）。
- companion 自己先退出时，要 KILL 仍然残留的进程组。

**锁与持久化**
- JSON 写入一律用“临时文件 + rename”（`writeJsonAtomic`），并加锁（`updateJson`）。
- **绝不自动删除锁**：先检查再删除这一步做不到原子化。如果持锁者已经死亡，就报错，并告诉用户如何手动清理。
- 每个任务记录只有一个写入者。job id 必须经过校验，防止路径穿越。

**审查范围与 worktree**
- review 上下文、审查门指纹和 PR 审查都**以仓库根目录为准**，不能以 cwd 为准，否则在子目录中运行会漏掉未跟踪文件。
- 未跟踪文件列表用 NUL 分隔；不跟随（解引用）符号链接；超大文件只读一部分。
- worktree 会复制未提交和未跟踪的文件，符号链接保持为链接。被忽略的依赖目录（`node_modules`、`.venv`、`venv`）通过符号链接接入，但绝不写进补丁，删除 worktree 时也不会跟随这些链接。仓库没有任何提交，或子模块有未提交改动时，直接拒绝。apply 以事务方式执行，失败时回退到三方合并。

**模型别名（`resolveModel`）**
- agy 1.3.4 起，带档位后缀的 id（`claude-opus-5-5-high`）不能和另一个 `--effort` 一起用，只写基础名（`claude-opus-5-5`）则可以。所以指定了 `--effort` 时，别名解析为基础名；没指定时仍优先选 `-high`。
- 别名匹配不到任何模型时直接报错并列出可用模型；不是别名的未知 id 原样传给 agy（可能是 agy settings 里的自定义模型）。模型列表会变（1.3 去掉了 Gemini Pro），默认值和文档示例不要写死某个具体系列。

**`--sandbox` 模式**
- 对应 `agy --sandbox --dangerously-skip-permissions`。在 Linux 上实测：shell 命令看到的文件系统除 `/tmp` 外都是只读，网络可用，家目录可读；文件修改走 agy 的编辑工具，不受影响。
- 它是“能跑测试、但 shell 改不了文件”的折中方案，和 `--worktree` 搭配最好。文档里必须如实写明网络是通的、家目录可读，不能把它说成完全隔离。与 `--yolo` 互斥。

**审查门**
- 用完整内容的指纹去重：同一状态只审查一次，被阻止过的状态会一直保持阻止。连续阻止 3 次后放行，放行时重置状态。agy 出错（服务中断、配额、超时）也放行。

**与 Claude Code 交互的约定**
- 内联的 `!` 命令一旦以非零码退出，Claude Code 会丢弃它的输出。所以斜杠命令里的错误要**写到 stdout 并以 0 退出**。
- 提示词通过 stdin 传给 agy，避免超出 argv 长度限制。agy 以 headless 模式运行、无法请求审批，因此权限策略（只读 / `--write` / `--worktree` / `--sandbox` / `--yolo`）必须在前言中写清楚。

## 工作方式

- 修复缺陷时同时补上回归测试，并保证已有断言不被削弱（曾出现过测试循环变量没被使用、导致断言形同虚设的问题）。
- 交替审查时，每一轮都**开新会话**并附上已有决策说明，这样比在超长会话里继续审查快得多（约 5 分钟对 30–40 分钟），也能避免审查者重复提出已经否决的建议。
- 明确不在范围内的事项：非 UTF-8 文件名。
- 提交信息用英文，一行说清楚改了什么以及为什么。
