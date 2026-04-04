# fork from Claude Code Best V3 (CCB)

牢 A (Anthropic) 官方 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 工具的源码反编译/逆向还原项目。目标是将 Claude Code 大部分功能及工程化能力复现。 

赞助商占位符

- [x] v1 会完成跑通及基本的类型检查通过;
- [x] V2 会完整实现工程化配套设施;
  - [ ] Biome 格式化可能不会先实施, 避免代码冲突
  - [x] 构建流水线完成, 产物 Node/Bun 都可以运行
- [x] V3 会写大量文档, 完善文档站点
- [ ] V4 会完成大量的测试文件, 以提高稳定性

> 我不知道这个项目还会存在多久, Star + Fork + git clone + .zip 包最稳健;
>
> 这个项目更新很快, 后台有 Opus 持续优化, 所以你可以提 issues, 但是 PR 暂时不会接受;
>
> Claude 已经烧了 800$ 以上, 如果你个人想赞助, 请随便找个机构捐款, 然后截图在 issues, 大家的力量是温暖的;
>
> 某些模型提供商想要赞助, 那么请私发一个 1w 额度以上的账号到 <claude-code-best@proton.me>; 我们会在赞助商栏直接给你最亮的位置

存活记录:

1. 开源后 24 小时: 突破 6k Star, 感谢各位支持. 完成 docs 文档的站点构建, 达到 v3 版本, 后续开始进行测试用例维护, 完成之后可以接受 PR; 看来牢 A 是不想理我们了;
2. 开源后 15 小时: 完成了构建产物的 node 支持, 现在是完全体了; star 快到 3k 了; 等待牢 A 的邮件
3. 开源后 12 小时: 愚人节, star 破 1k, 并且牢 A 没有发邮件搞这个项目
4. 如果你想要私人咨询服务, 那么可以发送邮件到 <claude-code-best@proton.me>, 备注咨询与联系方式即可; 由于后续工作非常多, 可能会忽略邮件, 半天没回复, 可以多发;

## 快速开始

### 环境要求

一定要最新版本的 bun 啊, 不然一堆奇奇怪怪的 BUG!!! bun upgrade!!!

- [Bun](https://bun.sh/) >= 1.3.11
- 常规的配置 CC 的方式, 各大提供商都有自己的配置方式

### 安装

```bash
bun install
```

### 运行

```bash
# 开发模式, 看到版本号 888 说明就是对了
bun run dev

# 构建
bun run build
```

### 使用 OpenAI 兼容模型

```bash
# Windows PowerShell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="你的 OpenAI API Key"
$env:OPENAI_MODEL="gpt-5" # 可选, 默认 gpt-5
$env:OPENAI_BASE_URL="https://api.openai.com/v1" # 可选

bun run dev
```

说明:

- `CLAUDE_CODE_USE_OPENAI=1` 会切换到 OpenAI provider
- `OPENAI_API_KEY` 为必填
- `OPENAI_MODEL` 不填时默认使用 `gpt-5`
- `OPENAI_SMALL_FAST_MODEL` 可选, 默认使用 `gpt-5-mini`
- 当前 OpenAI 接入优先支持文本对话、工具调用、`-p/--print` 模式和常见 side query

### OpenAI-compatible 语义适配现状

- `CLAUDE_CODE_USE_OPENAI`、`CLAUDE_CODE_USE_OPENAI_CODEX`、`CLAUDE_CODE_USE_MOONSHOT`、`CLAUDE_CODE_USE_QWEN` 现在都带有一层增强版 Anthropic 语义适配
- 已补的能力包括: 更接近 Claude 的 thinking / effort 透传、`stop_sequences` 下传、assistant tool-call 的 reasoning 上下文回放、以及客户端侧的 deferred tool / `tool_reference` 展开
- 其中 OpenAI / Moonshot / Qwen 走的是 OpenAI-compatible `/chat/completions` 适配; OpenAI Codex 走的是单独的 Codex Responses / OAuth 适配
- 这些 provider 现在“更像 Claude Code 的行为”, 但它们仍然不是完整的 Anthropic 协议翻译网关
- 仍然不能完全等价复制的能力包括: Anthropic 服务端原生 beta/header 行为、真正的 `tool_reference` / `defer_loading` 服务端协议、`prompt_caching_scope`、`context_management`、Anthropic 原生 token counting / cache 语义
- 如果你要的是“尽可能完整的 Anthropic 协议与行为”, 推荐优先使用下面的自定义 `ANTHROPIC_BASE_URL` 网关模式, 而不是 `CLAUDE_CODE_USE_*`

### 使用自定义 ANTHROPIC_BASE_URL 网关

```bash
# Windows PowerShell
$env:ANTHROPIC_BASE_URL="https://your-gateway.example/v1"
$env:ANTHROPIC_API_KEY="your gateway api key"

# Optional: narrow the capability set if the gateway only implements part of
# the Anthropic protocol. Default for custom ANTHROPIC_BASE_URL is "all".
$env:CLAUDE_CODE_ANTHROPIC_GATEWAY_CAPABILITIES="all"

bun run dev
```

说明:

- 自定义 `ANTHROPIC_BASE_URL` 现在默认按“完整 Anthropic 协议翻译网关”处理
- 不会再因为 host 不是官方 Anthropic 域名，就默认关闭 `tool search` / `defer_loading`
- 如果你的网关只支持部分能力，可用 `CLAUDE_CODE_ANTHROPIC_GATEWAY_CAPABILITIES` 或 `ANTHROPIC_GATEWAY_CAPABILITIES` 显式收窄
- 支持的 capability token: `all`, `tool_search`, `tool_reference`, `defer_loading`, `structured_outputs`, `prompt_caching_scope`, `context_management`, `redact_thinking`, `task_budgets`, `fine_grained_tool_streaming`
- 支持的别名: `full`, `translate`, `strict_tools`, `prompt_caching`, `thinking`, `fgts`
- 例子: `all,-fine_grained_tool_streaming` 或 `tool_search,prompt_caching_scope,structured_outputs`
- 这条路径的目标是“完整 Anthropic 翻译网关”; 但前提仍然是你的网关后端真的实现/转译了这些能力, 客户端不会凭空为后端补出服务端行为

### 使用 OpenAI Codex OAuth

```bash
# Windows PowerShell
$env:CLAUDE_CODE_USE_OPENAI_CODEX="1"
$env:OPENAI_CODEX_MODEL="gpt-5.4" # optional, default gpt-5.4
$env:OPENAI_CODEX_SMALL_FAST_MODEL="gpt-5.4-mini" # optional
$env:OPENAI_CODEX_BASE_URL="https://chatgpt.com/backend-api" # optional

# First-time login
bun run dev auth login --provider openai-codex
```

说明:

- `CLAUDE_CODE_USE_OPENAI_CODEX=1` 会切换到 OpenAI Codex provider
- 认证方式是 ChatGPT OAuth, 不是 `OPENAI_API_KEY`
- 首次使用推荐执行 `auth login --provider openai-codex`
- 也支持直接注入 `OPENAI_CODEX_ACCESS_TOKEN`
- 如需无交互注入, 也可以配合 `OPENAI_CODEX_REFRESH_TOKEN` / `OPENAI_CODEX_EXPIRES_AT`
- 默认模型是 `gpt-5.4`, 默认 fast model 是 `gpt-5.4-mini`
- 默认 base URL 是 `https://chatgpt.com/backend-api`

### 使用 Moonshot / Kimi K2.5

```bash
# Windows PowerShell
$env:CLAUDE_CODE_USE_MOONSHOT="1"
$env:MOONSHOT_API_KEY="你的 Moonshot API Key"
$env:MOONSHOT_MODEL="kimi-k2.5" # 可选, 默认 kimi-k2.5
$env:MOONSHOT_BASE_URL="https://api.moonshot.cn/v1" # 可选

bun run dev
```

说明:

- `CLAUDE_CODE_USE_MOONSHOT=1` 会切换到 Moonshot provider
- `MOONSHOT_API_KEY` 为必填
- `MOONSHOT_MODEL` 不填时默认使用 `kimi-k2.5`
- `MOONSHOT_SMALL_FAST_MODEL` 可选, 默认回退到 `MOONSHOT_MODEL`
- `MOONSHOT_BASE_URL` 不填时默认使用 `https://api.moonshot.cn/v1`
- Moonshot 走的是 OpenAI-compatible 接口实现, 因此支持范围与上面的 OpenAI 接入基本一致
- 如果你之前已经在用 `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY`, 启用 `CLAUDE_CODE_USE_MOONSHOT=1` 后也可以继续复用这些变量, 但更推荐显式使用 `MOONSHOT_*`

### 使用阿里云百炼 / 千问

```bash
# Windows PowerShell
$env:CLAUDE_CODE_USE_QWEN="1"
$env:QWEN_API_KEY="你的 DashScope API Key"
$env:QWEN_MODEL="qwen3-coder-plus" # 可选, 默认 qwen3-coder-plus
$env:QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1" # 可选

bun run dev
```

说明:

- `CLAUDE_CODE_USE_QWEN=1` 会切换到 Qwen provider
- `QWEN_API_KEY` 为必填
- `QWEN_MODEL` 不填时默认使用 `qwen3-coder-plus`
- `QWEN_SMALL_FAST_MODEL` 可选, 默认使用 `qwen3-coder-flash`
- `QWEN_BASE_URL` 不填时默认使用 `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 当前内置推荐模型是 `qwen3-coder-plus` / `qwen3-coder-flash`, 也支持把模型改成 `qwen3.5-plus`、`qwen3.5-flash` 等 DashScope 兼容模型
- Qwen 目前同样走 OpenAI-compatible 接口实现
- 如果你已经在环境里使用 `DASHSCOPE_API_KEY` 或 `OPENAI_*` 变量, 启用 `CLAUDE_CODE_USE_QWEN=1` 后也可以复用, 但更推荐显式使用 `QWEN_*`

构建采用 code splitting 多文件打包（`build.ts`），产物输出到 `dist/` 目录（入口 `dist/cli.js` + 约 450 个 chunk 文件）。

构建出的版本 bun 和 node 都可以启动, 你 publish 到私有源可以直接启动

如果遇到 bug 请直接提一个 issues, 我们优先解决

## 相关文档及网站

<https://deepwiki.com/claude-code-best/claude-code>

## Star History

<a href="https://www.star-history.com/?repos=claude-code-best%2Fclaude-code&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=claude-code-best/claude-code&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=claude-code-best/claude-code&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=claude-code-best/claude-code&type=date&legend=top-left" />
 </picture>
</a>

## 能力清单

> ✅ = 已实现  ⚠️ = 部分实现 / 条件启用  ❌ = stub / 移除 / feature flag 关闭

### 核心系统

| 能力 | 状态 | 说明 |
|------|------|------|
| REPL 交互界面（Ink 终端渲染） | ✅ | 主屏幕 5000+ 行，完整交互 |
| API 通信 — Anthropic Direct | ✅ | 支持 API Key + OAuth |
| API 通信 — AWS Bedrock | ✅ | 支持凭据刷新、Bearer Token |
| API 通信 — Google Vertex | ✅ | 支持 GCP 凭据刷新 |
| API 通信 — Azure Foundry | ✅ | 支持 API Key + Azure AD |
| 流式对话与工具调用循环 (`query.ts`) | ✅ | 1700+ 行，含自动压缩、token 追踪 |
| 会话引擎 (`QueryEngine.ts`) | ✅ | 1300+ 行，管理对话状态与归因 |
| 上下文构建（git status / CLAUDE.md / memory） | ✅ | `context.ts` 完整实现 |
| 权限系统（plan/auto/manual 模式） | ✅ | 6300+ 行，含 YOLO 分类器、路径验证、规则匹配 |
| Hook 系统（pre/post tool use） | ✅ | 支持 settings.json 配置 |
| 会话恢复 (`/resume`) | ✅ | 独立 ResumeConversation 屏幕 |
| Doctor 诊断 (`/doctor`) | ✅ | 版本、API、插件、沙箱检查 |
| 自动压缩 (compaction) | ✅ | auto-compact / micro-compact / API compact |

### 工具 — 始终可用

| 工具 | 状态 | 说明 |
|------|------|------|
| BashTool | ✅ | Shell 执行，沙箱，权限检查 |
| FileReadTool | ✅ | 文件 / PDF / 图片 / Notebook 读取 |
| FileEditTool | ✅ | 字符串替换式编辑 + diff 追踪 |
| FileWriteTool | ✅ | 文件创建 / 覆写 + diff 生成 |
| NotebookEditTool | ✅ | Jupyter Notebook 单元格编辑 |
| AgentTool | ✅ | 子代理派生（fork / async / background / remote） |
| WebFetchTool | ✅ | URL 抓取 → Markdown → AI 摘要 |
| WebSearchTool | ✅ | 网页搜索 + 域名过滤 |
| AskUserQuestionTool | ✅ | 多问题交互提示 + 预览 |
| SendMessageTool | ✅ | 消息发送（peers / teammates / mailbox） |
| SkillTool | ✅ | 斜杠命令 / Skill 调用 |
| EnterPlanModeTool | ✅ | 进入计划模式 |
| ExitPlanModeTool (V2) | ✅ | 退出计划模式 |
| TodoWriteTool | ✅ | Todo 列表 v1 |
| BriefTool | ✅ | 简短消息 + 附件发送 |
| TaskOutputTool | ✅ | 后台任务输出读取 |
| TaskStopTool | ✅ | 后台任务停止 |
| ListMcpResourcesTool | ⚠️ | MCP 资源列表（被 specialTools 过滤，特定条件下加入） |
| ReadMcpResourceTool | ⚠️ | MCP 资源读取（同上） |
| SyntheticOutputTool | ⚠️ | 仅在非交互会话（SDK/pipe 模式）下创建 |
| CronCreateTool | ✅ | 定时任务创建（已移除 AGENT_TRIGGERS gate） |
| CronDeleteTool | ✅ | 定时任务删除 |
| CronListTool | ✅ | 定时任务列表 |
| EnterWorktreeTool | ✅ | 进入 Git Worktree（`isWorktreeModeEnabled()` 已硬编码为 true） |
| ExitWorktreeTool | ✅ | 退出 Git Worktree |

### 工具 — 条件启用

| 工具 | 状态 | 启用条件 |
|------|------|----------|
| GlobTool | ✅ | 未嵌入 bfs/ugrep 时启用（默认启用） |
| GrepTool | ✅ | 同上 |
| TaskCreateTool | ⚠️ | `isTodoV2Enabled()` 为 true 时 |
| TaskGetTool | ⚠️ | 同上 |
| TaskUpdateTool | ⚠️ | 同上 |
| TaskListTool | ⚠️ | 同上 |
| TeamCreateTool | ⚠️ | `isAgentSwarmsEnabled()` |
| TeamDeleteTool | ⚠️ | 同上 |
| ToolSearchTool | ⚠️ | `isToolSearchEnabledOptimistic()` |
| PowerShellTool | ⚠️ | Windows 平台检测 |
| LSPTool | ⚠️ | `ENABLE_LSP_TOOL` 环境变量 |
| ConfigTool | ❌ | `USER_TYPE === 'ant'`（永远为 false） |

### 工具 — Feature Flag 关闭（全部不可用）

| 工具 | Feature Flag |
|------|-------------|
| SleepTool | `PROACTIVE` / `KAIROS` |
| RemoteTriggerTool | `AGENT_TRIGGERS_REMOTE` |
| MonitorTool | `MONITOR_TOOL` |
| SendUserFileTool | `KAIROS` |
| OverflowTestTool | `OVERFLOW_TEST_TOOL` |
| TerminalCaptureTool | `TERMINAL_PANEL` |
| WebBrowserTool | `WEB_BROWSER_TOOL` |
| SnipTool | `HISTORY_SNIP` |
| WorkflowTool | `WORKFLOW_SCRIPTS` |
| PushNotificationTool | `KAIROS` / `KAIROS_PUSH_NOTIFICATION` |
| SubscribePRTool | `KAIROS_GITHUB_WEBHOOKS` |
| ListPeersTool | `UDS_INBOX` |
| CtxInspectTool | `CONTEXT_COLLAPSE` |

### 工具 — Stub / 不可用

| 工具 | 说明 |
|------|------|
| TungstenTool | ANT-ONLY stub |
| REPLTool | ANT-ONLY，`isEnabled: () => false` |
| SuggestBackgroundPRTool | ANT-ONLY，`isEnabled: () => false` |
| VerifyPlanExecutionTool | 需 `CLAUDE_CODE_VERIFY_PLAN=true` 环境变量，且为 stub |
| ReviewArtifactTool | stub，未注册到 tools.ts |
| DiscoverSkillsTool | stub，未注册到 tools.ts |

### 斜杠命令 — 可用

| 命令 | 状态 | 说明 |
|------|------|------|
| `/add-dir` | ✅ | 添加目录 |
| `/advisor` | ✅ | Advisor 配置 |
| `/agents` | ✅ | 代理列表/管理 |
| `/branch` | ✅ | 分支管理 |
| `/btw` | ✅ | 快速备注 |
| `/chrome` | ✅ | Chrome 集成 |
| `/clear` | ✅ | 清屏 |
| `/color` | ✅ | Agent 颜色 |
| `/compact` | ✅ | 压缩对话 |
| `/config` (`/settings`) | ✅ | 配置管理 |
| `/context` | ✅ | 上下文信息 |
| `/copy` | ✅ | 复制最后消息 |
| `/cost` | ✅ | 会话费用 |
| `/desktop` | ✅ | Claude Desktop 集成 |
| `/diff` | ✅ | 显示 diff |
| `/doctor` | ✅ | 健康检查 |
| `/effort` | ✅ | 设置 effort 等级 |
| `/exit` | ✅ | 退出 |
| `/export` | ✅ | 导出对话 |
| `/extra-usage` | ✅ | 额外用量信息 |
| `/fast` | ✅ | 切换 fast 模式 |
| `/feedback` | ✅ | 反馈 |
| `/loop` | ✅ | 定时循环执行（bundled skill，可通过 `CLAUDE_CODE_DISABLE_CRON` 关闭） |
| `/heapdump` | ✅ | Heap dump（调试） |
| `/help` | ✅ | 帮助 |
| `/hooks` | ✅ | Hook 管理 |
| `/ide` | ✅ | IDE 连接 |
| `/init` | ✅ | 初始化项目 |
| `/install-github-app` | ✅ | 安装 GitHub App |
| `/install-slack-app` | ✅ | 安装 Slack App |
| `/keybindings` | ✅ | 快捷键管理 |
| `/login` / `/logout` | ✅ | 登录 / 登出 |
| `/mcp` | ✅ | MCP 服务管理 |
| `/memory` | ✅ | Memory / CLAUDE.md 管理 |
| `/mobile` | ✅ | 移动端 QR 码 |
| `/model` | ✅ | 模型选择 |
| `/output-style` | ✅ | 输出风格 |
| `/passes` | ✅ | 推荐码 |
| `/permissions` | ✅ | 权限管理 |
| `/plan` | ✅ | 计划模式 |
| `/plugin` | ✅ | 插件管理 |
| `/pr-comments` | ✅ | PR 评论 |
| `/privacy-settings` | ✅ | 隐私设置 |
| `/rate-limit-options` | ✅ | 限速选项 |
| `/release-notes` | ✅ | 更新日志 |
| `/reload-plugins` | ✅ | 重载插件 |
| `/remote-env` | ✅ | 远程环境配置 |
| `/rename` | ✅ | 重命名会话 |
| `/resume` | ✅ | 恢复会话 |
| `/review` | ✅ | 代码审查（本地） |
| `/ultrareview` | ✅ | 云端审查 |
| `/rewind` | ✅ | 回退对话 |
| `/sandbox-toggle` | ✅ | 切换沙箱 |
| `/security-review` | ✅ | 安全审查 |
| `/session` | ✅ | 会话信息 |
| `/skills` | ✅ | Skill 管理 |
| `/stats` | ✅ | 会话统计 |
| `/status` | ✅ | 状态信息 |
| `/statusline` | ✅ | 状态栏 UI |
| `/stickers` | ✅ | 贴纸 |
| `/tasks` | ✅ | 任务管理 |
| `/theme` | ✅ | 终端主题 |
| `/think-back` | ✅ | 年度回顾 |
| `/upgrade` | ✅ | 升级 CLI |
| `/usage` | ✅ | 用量信息 |
| `/insights` | ✅ | 使用分析报告 |
| `/vim` | ✅ | Vim 模式 |

### 斜杠命令 — Feature Flag 关闭

| 命令 | Feature Flag |
|------|-------------|
| `/voice` | `VOICE_MODE` |
| `/proactive` | `PROACTIVE` / `KAIROS` |
| `/brief` | `KAIROS` / `KAIROS_BRIEF` |
| `/assistant` | `KAIROS` |
| `/remote-control` (alias `rc`) | `BRIDGE_MODE` |
| `/remote-control-server` | `DAEMON` + `BRIDGE_MODE` |
| `/force-snip` | `HISTORY_SNIP` |
| `/workflows` | `WORKFLOW_SCRIPTS` |
| `/web-setup` | `CCR_REMOTE_SETUP` |
| `/subscribe-pr` | `KAIROS_GITHUB_WEBHOOKS` |
| `/ultraplan` | `ULTRAPLAN` |
| `/torch` | `TORCH` |
| `/peers` | `UDS_INBOX` |
| `/fork` | `FORK_SUBAGENT` |
| `/buddy` | `BUDDY` |

### 斜杠命令 — ANT-ONLY（不可用）

`/files` `/tag` `/backfill-sessions` `/break-cache` `/bughunter` `/commit` `/commit-push-pr` `/ctx_viz` `/good-claude` `/issue` `/init-verifiers` `/mock-limits` `/bridge-kick` `/version` `/reset-limits` `/onboarding` `/share` `/summary` `/teleport` `/ant-trace` `/perf-issue` `/env` `/oauth-refresh` `/debug-tool-call` `/agents-platform` `/autofix-pr`

### CLI 子命令

| 子命令 | 状态 | 说明 |
|--------|------|------|
| `claude`（默认） | ✅ | 主 REPL / 交互 / print 模式 |
| `claude mcp serve/add/remove/list/get/...` | ✅ | MCP 服务管理（7 个子命令） |
| `claude auth login/status/logout` | ✅ | 认证管理 |
| `claude plugin validate/list/install/...` | ✅ | 插件管理（7 个子命令） |
| `claude setup-token` | ✅ | 长效 Token 配置 |
| `claude agents` | ✅ | 代理列表 |
| `claude doctor` | ✅ | 健康检查 |
| `claude update` / `upgrade` | ✅ | 自动更新 |
| `claude install [target]` | ✅ | Native 安装 |
| `claude server` | ❌ | `DIRECT_CONNECT` flag |
| `claude ssh <host>` | ❌ | `SSH_REMOTE` flag |
| `claude open <cc-url>` | ❌ | `DIRECT_CONNECT` flag |
| `claude auto-mode` | ❌ | `TRANSCRIPT_CLASSIFIER` flag |
| `claude remote-control` | ❌ | `BRIDGE_MODE` + `DAEMON` flag |
| `claude assistant` | ❌ | `KAIROS` flag |
| `claude up/rollback/log/error/export/task/completion` | ❌ | ANT-ONLY |

### 服务层

| 服务 | 状态 | 说明 |
|------|------|------|
| API 客户端 (`services/api/`) | ✅ | 3400+ 行，5 个 provider（Anthropic / Bedrock / Vertex / Foundry / OpenAI-compatible） |
| MCP (`services/mcp/`) | ✅ | 34 个文件，12000+ 行 |
| OAuth (`services/oauth/`) | ✅ | 完整 OAuth 流程 |
| 插件 (`services/plugins/`) | ✅ | 基础设施完整，无内置插件 |
| LSP (`services/lsp/`) | ⚠️ | 实现存在，默认关闭 |
| 压缩 (`services/compact/`) | ✅ | auto / micro / API 压缩 |
| Hook 系统 (`services/tools/toolHooks.ts`) | ✅ | pre/post tool use hooks |
| 会话记忆 (`services/SessionMemory/`) | ✅ | 会话记忆管理 |
| 记忆提取 (`services/extractMemories/`) | ✅ | 自动记忆提取 |
| Skill 搜索 (`services/skillSearch/`) | ✅ | 本地/远程 skill 搜索 |
| 策略限制 (`services/policyLimits/`) | ✅ | 策略限制执行 |
| 分析 / GrowthBook / Sentry | ⚠️ | 框架存在，实际 sink 为空 |
| Voice (`services/voice.ts`) | ❌ | `VOICE_MODE` flag 关闭 |

### 内部包 (`packages/`)

| 包 | 状态 | 说明 |
|------|------|------|
| `color-diff-napi` | ✅ | 1006 行完整 TypeScript 实现（语法高亮 diff） |
| `audio-capture-napi` | ✅ | 151 行完整实现（跨平台音频录制，使用 SoX/arecord） |
| `image-processor-napi` | ✅ | 125 行完整实现（macOS 剪贴板图片读取，使用 osascript + sharp） |
| `modifiers-napi` | ✅ | 67 行完整实现（macOS 修饰键检测，bun:ffi + CoreGraphics） |
| `url-handler-napi` | ❌ | stub，`waitForUrlEvent()` 返回 null |
| `@ant/claude-for-chrome-mcp` | ❌ | stub，`createServer()` 返回 null |
| `@ant/computer-use-mcp` | ⚠️ | 类型安全 stub（265 行，完整类型定义但函数返回空值） |
| `@ant/computer-use-input` | ✅ | 183 行完整实现（macOS 键鼠模拟，AppleScript/JXA/CGEvent） |
| `@ant/computer-use-swift` | ✅ | 388 行完整实现（macOS 显示器/应用管理/截图，JXA/screencapture） |

### Feature Flags（31 个，全部返回 `false`）

`ABLATION_BASELINE` `AGENT_MEMORY_SNAPSHOT` `BG_SESSIONS` `BRIDGE_MODE` `BUDDY` `CCR_MIRROR` `CCR_REMOTE_SETUP` `CHICAGO_MCP` `COORDINATOR_MODE` `DAEMON` `DIRECT_CONNECT` `EXPERIMENTAL_SKILL_SEARCH` `FORK_SUBAGENT` `HARD_FAIL` `HISTORY_SNIP` `KAIROS` `KAIROS_BRIEF` `KAIROS_CHANNELS` `KAIROS_GITHUB_WEBHOOKS` `LODESTONE` `MCP_SKILLS` `PROACTIVE` `SSH_REMOTE` `TORCH` `TRANSCRIPT_CLASSIFIER` `UDS_INBOX` `ULTRAPLAN` `UPLOAD_USER_SETTINGS` `VOICE_MODE` `WEB_BROWSER_TOOL` `WORKFLOW_SCRIPTS`

## 项目结构

```
claude-code/
├── src/
│   ├── entrypoints/
│   │   ├── cli.tsx          # 入口文件（含 MACRO/feature polyfill）
│   │   └── sdk/             # SDK 子模块 stub
│   ├── main.tsx             # 主 CLI 逻辑（Commander 定义）
│   └── types/
│       ├── global.d.ts      # 全局变量/宏声明
│       └── internal-modules.d.ts  # 内部 npm 包类型声明
├── packages/                # Monorepo workspace 包
│   ├── color-diff-napi/     # 完整实现（终端 color diff）
│   ├── modifiers-napi/      # stub（macOS 修饰键检测）
│   ├── audio-capture-napi/  # stub
│   ├── image-processor-napi/# stub
│   ├── url-handler-napi/    # stub
│   └── @ant/               # Anthropic 内部包 stub
│       ├── claude-for-chrome-mcp/
│       ├── computer-use-mcp/
│       ├── computer-use-input/
│       └── computer-use-swift/
├── scripts/                 # 自动化 stub 生成脚本
├── build.ts                 # 构建脚本（Bun.build + code splitting + Node.js 兼容后处理）
├── dist/                    # 构建输出（入口 cli.js + ~450 chunk 文件）
└── package.json             # Bun workspaces monorepo 配置
```

## 技术说明

### 运行时 Polyfill

入口文件 `src/entrypoints/cli.tsx` 顶部注入了必要的 polyfill：

- `feature()` — 所有 feature flag 返回 `false`，跳过未实现分支
- `globalThis.MACRO` — 模拟构建时宏注入（VERSION 等）

### Monorepo

项目采用 Bun workspaces 管理内部包。原先手工放在 `node_modules/` 下的 stub 已统一迁入 `packages/`，通过 `workspace:*` 解析。

## Feature Flags 详解

原版 Claude Code 通过 `bun:bundle` 的 `feature()` 在构建时注入 feature flag，由 GrowthBook 等 A/B 实验平台控制灰度发布。本项目中 `feature()` 被 polyfill 为始终返回 `false`，因此以下 30 个 flag 全部关闭。

### 自主 Agent

| Flag | 用途 |
|------|------|
| `KAIROS` | Assistant 模式 — 长期运行的自主 Agent（含 brief、push 通知、文件发送） |
| `KAIROS_BRIEF` | Kairos Brief — 向用户发送简报摘要 |
| `KAIROS_CHANNELS` | Kairos 频道 — 多频道通信 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub Webhook 订阅 — PR 事件实时推送给 Agent |
| `PROACTIVE` | 主动模式 — Agent 主动执行任务，含 SleepTool 定时唤醒 |
| `COORDINATOR_MODE` | 协调器模式 — 多 Agent 编排调度 |
| `BUDDY` | Buddy 配对编程功能 |
| `FORK_SUBAGENT` | Fork 子代理 — 从当前会话分叉出独立子代理 |

### 远程 / 分布式

| Flag | 用途 |
|------|------|
| `BRIDGE_MODE` | 远程控制桥接 — 允许外部客户端远程操控 Claude Code |
| `DAEMON` | 守护进程 — 后台常驻服务，支持 worker 和 supervisor |
| `BG_SESSIONS` | 后台会话 — `ps`/`logs`/`attach`/`kill`/`--bg` 等后台进程管理 |
| `SSH_REMOTE` | SSH 远程 — `claude ssh <host>` 连接远程主机 |
| `DIRECT_CONNECT` | 直连模式 — `cc://` URL 协议、server 命令、`open` 命令 |
| `CCR_REMOTE_SETUP` | 网页端远程配置 — 通过浏览器配置 Claude Code |
| `CCR_MIRROR` | Claude Code Runtime 镜像 — 会话状态同步/复制 |

### 通信

| Flag | 用途 |
|------|------|
| `UDS_INBOX` | Unix Domain Socket 收件箱 — Agent 间本地通信（`/peers`） |

### 增强工具

| Flag | 用途 |
|------|------|
| `CHICAGO_MCP` | Computer Use MCP — 计算机操作（屏幕截图、鼠标键盘控制） |
| `WEB_BROWSER_TOOL` | 网页浏览器工具 — 在终端内嵌浏览器交互 |
| `VOICE_MODE` | 语音模式 — 语音输入输出，麦克风 push-to-talk |
| `WORKFLOW_SCRIPTS` | 工作流脚本 — 用户自定义自动化工作流 |
| `MCP_SKILLS` | 基于 MCP 的 Skill 加载机制 |

### 对话管理

| Flag | 用途 |
|------|------|
| `HISTORY_SNIP` | 历史裁剪 — 手动裁剪对话历史中的片段（`/force-snip`） |
| `ULTRAPLAN` | 超级计划 — 远程 Agent 协作的大规模规划功能 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 运行时的记忆快照功能 |

### 基础设施 / 实验

| Flag | 用途 |
|------|------|
| `ABLATION_BASELINE` | 科学实验 — 基线消融测试，用于 A/B 实验对照组 |
| `HARD_FAIL` | 硬失败模式 — 遇错直接中断而非降级 |
| `TRANSCRIPT_CLASSIFIER` | 对话分类器 — `auto-mode` 命令，自动分析和分类对话记录 |
| `UPLOAD_USER_SETTINGS` | 设置同步上传 — 将本地配置同步到云端 |
| `LODESTONE` | 深度链接协议处理器 — 从外部应用跳转到 Claude Code 指定位置 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性 Skill 搜索索引 |
| `TORCH` | Torch 功能（具体用途未知，可能是某种高亮/追踪机制） |

## 许可证

本项目仅供学习研究用途。Claude Code 的所有权利归 [Anthropic](https://www.anthropic.com/) 所有。
