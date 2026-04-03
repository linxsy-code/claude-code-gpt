### 研究openclaw里如何使用openai ChatGPT/Codex subscription access instead of an API key.

结论：可以，但不是把 ChatGPT/Codex 订阅“当成 API key”去填 `OPENAI_API_KEY`。OpenClaw 把这条路做成了单独的 provider `openai-codex`，认证方式是 `ChatGPT OAuth`，走的是 `chatgpt.com/backend-api`；普通 `openai` provider 依然是 API key 路线。这个在 `docs/providers/openai.md:11-13`, `docs/concepts/model-providers.md:177-182`, `extensions/openai/openai-codex-provider.ts:33,243,251-252`, `extensions/openai/openai-provider.ts:206,251` 里都能对上。

实际用法就是两步。先交互式登录：
- `openclaw onboard --auth-choice openai-codex`
- 或 `openclaw models auth login --provider openai-codex`

然后把默认模型切到 Codex provider，而不是 `openai/...`：
- 默认写法在仓库里是 `openai-codex/gpt-5.4`，见 `docs/providers/openai.md:55-70` 和 `extensions/openai/default-models.ts:8`

几个关键限制也要注意：
- 这是交互式 OAuth，不是无头 secret 注入。`models auth login` 明确要求 interactive TTY，见 `src/commands/models/auth.ts:549`。
- 本地会拉浏览器回调到 `localhost:1455`；如果你在远程/VPS 上跑，会给你一个 URL，让你在本地浏览器登录后把 redirect URL 粘回来，见 `src/plugins/provider-openai-codex-oauth.ts:37-44`。
- `openai-codex` 当前没有 `runNonInteractive`，所以不能把它当纯 non-interactive onboarding 替代 API key，见 `src/commands/onboard-non-interactive/local/auth-choice.plugin-providers.ts:134-145`。
- 如果你只登录了 Codex OAuth，却还选 `openai/gpt-5.4`，OpenClaw 会直接提示你改用 `openai-codex/gpt-5.4`，或者再去设置 `OPENAI_API_KEY`，见 `extensions/openai/openai-provider.ts:251`。

我还补了一下官方站点核对：截至 2026-04-02，OpenAI 开发者站当前公开模型页更强调 `GPT-5-Codex` / `GPT-5.3-Codex` 这类命名，而这个仓库默认仍写 `openai-codex/gpt-5.4`。所以“订阅登录能力”这件事在 OpenClaw 里是实装了，但默认模型名和 OpenAI 当前公开目录是否完全同步，最好再做一次 live 验证再定到团队默认配置里。

官方参考：
- [https://developers.openai.com/api/docs/models/all](https://developers.openai.com/api/docs/models/all)
- [https://developers.openai.com/codex/app](https://developers.openai.com/codex/app)

如果你愿意，我下一步可以继续帮你把这条路径整理成一份最小可用配置示例，或者直接在仓库里再追一层 live test / runtime 代码，确认 `openai-codex/gpt-5.4` 现在是否还能稳定跑通。


先纠正一下名词：OpenClaw 里的规范 provider id 是 `openai-codex`，不是 `open-codex`。你要复刻的目标应该定义成 `openai-codex/gpt-5.4` 这一条模型路由。

**核心结论**
这条方案不是“拿 ChatGPT 订阅当 API key 填进 OpenAI API”。OpenClaw 的做法是单独做一个 `openai-codex` provider，把 ChatGPT/Codex 登录态作为 OAuth 凭据保存，再把运行时请求发到 Codex 路径，而不是 `api.openai.com/v1`。关键实现分散在这些文件里：

- `extensions/openai/openai-codex-provider.ts`
- `extensions/openai/openai-codex-catalog.ts`
- `src/plugins/provider-openai-codex-oauth.ts`
- `src/plugins/provider-openai-codex-oauth-tls.ts`
- `src/agents/auth-profiles/oauth.ts`
- `src/infra/provider-usage.fetch.codex.ts`
- `src/agents/models-config.providers.openai-codex.test.ts`

**你可以让另一个线程直接照着实现的技术方案**

1. **把 `openai-codex` 设计成独立 provider，不要和 `openai` 混用**
- `openai` 走 API key，`openai-codex` 走 ChatGPT OAuth。
- OpenClaw 代码里明确把两条路拆开了，`openai` 读 `OPENAI_API_KEY`，`openai-codex` 的 auth method 是 `ChatGPT OAuth`，见 `extensions/openai/openai-provider.ts:204-221` 和 `extensions/openai/openai-codex-provider.ts:239-252`。
- 如果用户只有 Codex OAuth，却选了 `openai/gpt-5.4`，OpenClaw 会报错并提示改用 `openai-codex/gpt-5.4`，见 `extensions/openai/openai-provider.ts:246-251`。

2. **provider 配置层只保存“这是 Codex 路径”，不要把 token 写进 provider config**
- OpenClaw 为 `openai-codex` 合成的 provider 配置是：
  - `baseUrl = "https://chatgpt.com/backend-api"`
  - `api = "openai-codex-responses"`
  - `models = []`
- 见 `extensions/openai/openai-codex-catalog.ts:3-8`。
- 测试也确认：当存在 `openai-codex` OAuth profile 时，会隐式注入这个 provider，而且**不会**往 provider config 里塞 `apiKey`，见 `src/agents/models-config.providers.openai-codex.test.ts:40-58`。

3. **认证层用 OAuth profile 存储，而不是 API key**
- OpenClaw 的 OAuth credential 结构是：
  - `access`
  - `refresh`
  - `expires`
  - 可选 `accountId`
  - 可选 `email` / `displayName`
- 类型定义在 `src/agents/auth-profiles/types.ts:4-16,36-44`。
- 持久化时 profile 类似 `openai-codex:<profile-name>`，由 `buildOauthProviderAuthResult` 构造，见 `src/plugin-sdk/provider-auth-result.ts:7-41`。

4. **登录流程是交互式浏览器 OAuth**
- OpenClaw 登录入口是 `loginOpenAICodexOAuth(...)`，见 `src/plugins/provider-openai-codex-oauth.ts:13-79`。
- 它会先做 TLS/network preflight，请求：
  - `https://auth.openai.com/oauth/authorize?...&response_type=code&redirect_uri=http://localhost:1455/auth/callback&scope=openid+profile+email`
- 见 `src/plugins/provider-openai-codex-oauth-tls.ts:22-24,102-112`。
- 本地模式：浏览器回调到 `localhost:1455`。
- 远程/VPS 模式：让用户在本地浏览器打开 URL，再把 redirect URL 粘回来。
- 见 `src/plugins/provider-openai-codex-oauth.ts:35-44`。

5. **运行时认证不要再找 API key，直接把 OAuth access token 当 bearer token 用**
- 这是我根据代码做的高置信推断：
  - `resolveApiKeyForProfile()` 处理 OAuth profile 时，最终返回的是 `apiKey` 字段；
  - 对 `openai-codex` 来说，provider 没有实现 `formatApiKey`，所以默认返回 `credentials.access`；
  - 见 `src/agents/auth-profiles/oauth.ts:72-94,326-390` 和 `extensions/openai/openai-codex-provider.ts` 中没有 `formatApiKey`。
- 换句话说，OpenClaw 对 `openai-codex` 的运行时 bearer token，本质上就是 OAuth `access` token。

6. **过期刷新逻辑要独立做，不要把 access token 当长期 secret**
- 如果 `expires` 未过期，直接用 `access`。
- 如果过期，先走 provider 自己的 refresh：
  - `refreshOpenAICodexOAuthCredential()`
  - 内部调用 `refreshOpenAICodexToken(...)`
- 见 `extensions/openai/openai-codex-provider.ts:147-169,299` 和 `extensions/openai/openai-codex-provider.runtime.ts:12-18`。
- OpenClaw 还加了一个很实用的防御性分支：
  - 如果 refresh 失败信息是 “Failed to extract accountId from token”，会回退到缓存 credential，而不是直接炸掉。
  - 见 `extensions/openai/openai-codex-provider.ts:156-166` 和 `src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts:112-167`。
- 这是 OpenClaw 特有的稳态优化，建议你也保留。

7. **模型解析层把 `openai-codex/gpt-5.4` 看成 provider-local alias**
- OpenClaw 当前把默认模型设成 `openai-codex/gpt-5.4`，见 `extensions/openai/default-models.ts:8`。
- 但代码里它是用模板模型合成出来的：
  - `gpt-5.4` 由 `gpt-5.3-codex` / `gpt-5.2-codex` 模板推导
  - 见 `extensions/openai/openai-codex-provider.ts:34,43-45,88-125`
- 这点很重要，因为 OpenAI 官方模型页在 2026-04-02 公开强调的是 `GPT-5-Codex`、`GPT-5.3-Codex`、`GPT-5.2-Codex`，而 OpenClaw 暴露的是 `gpt-5.4` 别名。你的新软件最好做一层“外部展示名 -> 实际 provider model id”的映射，不要把展示名和底层模型目录强绑定。

8. **传输层按 `openai-codex-responses` 做，默认 `transport = auto`**
- OpenClaw 对 `openai-codex` 默认把 transport 设成 `"auto"`，也就是 WebSocket-first，再 SSE fallback，见 `extensions/openai/openai-codex-provider.ts:279-286`。
- 测试确认默认值就是 `auto`，见 `src/agents/pi-embedded-runner-extraparams.test.ts:1512-1524`。
- 你可以直接复刻这个策略：
  - `websocket` 强制 WS
  - `sse` 强制 SSE
  - `auto` 先 WS 再 SSE

9. **Responses payload 需要遵守 Codex 特性**
- OpenClaw 的测试说明 Codex Responses 不应强制 `store=true`，而是要保持 `store=false`，见 `src/agents/pi-embedded-runner-extraparams.test.ts:3251-3276`。
- 它也支持把 `serviceTier` 注入到 Codex Responses payload，见 `src/agents/pi-embedded-runner-extraparams.test.ts:2164-2187`。
- 所以你的调用适配器至少要支持这些字段：
  - `transport`
  - `store`
  - `service_tier`
  - 可选 `text.verbosity`

10. **Base URL 和实际请求路径要解耦**
- 仓库里 provider 级 base URL 是 `https://chatgpt.com/backend-api`。
- 但测试里也出现了 `https://chatgpt.com/backend-api/codex/responses` 这样的实际运行时 URL，见 `src/agents/pi-embedded-runner-extraparams.test.ts:2182,3254,3268`。
- 这说明底层 client 可能会：
  - 用 base URL `.../backend-api`
  - 再在 transport 层补上 `/codex/responses`
- 所以在你的新软件里，建议写成：
  - provider config: `baseUrl = https://chatgpt.com/backend-api`
  - transport adapter: 负责把 Responses 请求路由到真实 Codex endpoint
- 这里的“真实最终路径”在 OpenClaw 仓库里是通过 `@mariozechner/pi-ai@0.64.0` 封装掉的，见 `package.json:1229`。如果你想 1:1 复刻，最省事的是直接复用这个包；如果你要原生重写，就得再去看这个包本身或抓一次网络流量。

**给另一个线程的最小实现蓝图**

```ts
type CodexOAuthProfile = {
  provider: "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  displayName?: string;
};

type CodexProviderConfig = {
  id: "openai-codex";
  api: "openai-codex-responses";
  baseUrl: "https://chatgpt.com/backend-api";
  defaultModel: "gpt-5.4";
  defaultTransport: "auto" | "websocket" | "sse";
};

async function resolveRuntimeBearer(profile: CodexOAuthProfile): Promise<string> {
  if (Date.now() < profile.expires) return profile.access;
  const refreshed = await refreshOpenAICodexToken(profile.refresh); // 复用现成库，或自己实现 refresh
  profile.access = refreshed.access;
  profile.refresh = refreshed.refresh;
  profile.expires = refreshed.expires;
  if (refreshed.accountId) profile.accountId = refreshed.accountId;
  persistProfile(profile);
  return profile.access;
}

async function callCodexResponses(params: {
  profile: CodexOAuthProfile;
  model: string; // e.g. "gpt-5.4"
  input: unknown;
  transport?: "auto" | "websocket" | "sse";
  serviceTier?: "auto" | "default" | "flex" | "priority";
}) {
  const bearer = await resolveRuntimeBearer(params.profile);

  const payload = {
    model: params.model,
    input: params.input,
    store: false,
    ...(params.serviceTier ? { service_tier: params.serviceTier } : {}),
  };

  return await codexResponsesTransport({
    baseUrl: "https://chatgpt.com/backend-api",
    bearerToken: bearer,
    payload,
    transport: params.transport ?? "auto",
  });
}
```

**另一个软件里最值得保留的 OpenClaw 设计**
- 认证和 provider 配置分离：profile 里存 OAuth，provider config 不存 token。
- `openai` 和 `openai-codex` 分成两个 provider。
- 运行时永远走“profile -> resolve bearer -> transport”，而不是直接读环境变量。
- 对 `gpt-5.4` 做 alias/forward-compat，不把 UI 展示名和底层官方目录死绑。
- 默认 `transport = auto`。
- Codex Responses 保持 `store = false`。
- refresh 失败时对 “accountId extraction” 做容错回退。

**我现在能确认、但不会硬猜的边界**
- OpenClaw 仓库里能确认 OAuth 浏览器入口、callback、profile 结构、baseUrl、api 类型、refresh 入口、usage 探针。
- 我**不能只凭这个仓库** 100% 还原 `@mariozechner/pi-ai` 内部的完整 OAuth token exchange 和最终 Responses HTTP path 拼接细节。
- 所以如果另一个线程要“最快上线”，最佳方案是直接复用 `@mariozechner/pi-ai@0.64.0`；如果要“完全自主实现”，就把 OpenClaw 这套分层当架构蓝图，再去补齐 `pi-ai` 那一层。

官方参考：
- [https://developers.openai.com/api/docs/models/all](https://developers.openai.com/api/docs/models/all)
- [https://developers.openai.com/codex/app](https://developers.openai.com/codex/app)

如果你愿意，我下一条可以直接把这份方案改写成“发给另一个线程的执行提示词”，或者直接给你一版可落地的 Node/TypeScript provider skeleton。




下面这段可以直接发给另一个线程：

```text
请基于 openclaw 仓库里已经实现的 `openai-codex` 路径，整理并输出一份“可在另一个软件里实现 `openai-codex/gpt-5.4` 调用”的技术实施方案。目标不是复述文档，而是给出可落地的架构、调用链、状态机、数据结构、边界条件和实现步骤。

工作要求：

1. 以代码为准，不要猜。
2. 重点研究以下文件：
- `extensions/openai/openai-codex-provider.ts`
- `extensions/openai/openai-codex-catalog.ts`
- `extensions/openai/default-models.ts`
- `src/plugins/provider-openai-codex-oauth.ts`
- `src/plugins/provider-openai-codex-oauth-tls.ts`
- `src/agents/auth-profiles/oauth.ts`
- `src/agents/auth-profiles/types.ts`
- `src/agents/auth-profiles/store.ts`
- `src/infra/provider-usage.fetch.codex.ts`
- `src/agents/models-config.providers.openai-codex.test.ts`
- `src/agents/pi-embedded-runner-extraparams.test.ts`
- `extensions/openai/openai-codex-auth-identity.ts`

3. 明确回答这些问题：
- OpenClaw 为什么把这条路径设计成独立 provider `openai-codex`，而不是复用 `openai`
- 登录态是怎么获得的，OAuth 入口、回调方式、远程/VPS fallback 是什么
- OAuth credential 的最小存储结构是什么
- 运行时如何从 auth profile 解析出真正用于请求的 bearer token
- token 过期后的刷新链路是什么
- `accountId` 在这条路径中的作用是什么，哪些请求会用到 `ChatGPT-Account-Id`
- provider config 层到底该保存什么，不该保存什么
- `openai-codex/gpt-5.4` 是如何映射到 `openai-codex-responses` + `https://chatgpt.com/backend-api` 的
- transport 默认值是什么，`auto/websocket/sse` 分别怎么处理
- Codex Responses payload 上有哪些与普通 OpenAI Responses 不同的约束，例如 `store=false`
- `service_tier` / fast mode / text verbosity 这些额外参数在这条路径上怎么传递
- 仓库内哪些部分是“已实锤实现”，哪些部分实际上依赖 `@mariozechner/pi-ai`，需要作为外部黑盒看待

4. 输出格式必须包含以下部分：
- 一段高层结论
- 一张“分层架构图”的文字版，至少分为：认证层、凭据存储层、运行时 auth 解析层、provider 解析层、transport 层、usage/配额层
- 一份“另一个软件里应照搬的数据结构定义”
- 一份“另一个软件里应照搬的状态机/流程图”的文字版
- 一份“最小可行实现步骤”
- 一份“不要踩的坑”
- 一份“哪些地方是推断，哪些地方是代码直接证据”的清单

5. 对每个关键结论都给出处，使用 repo-root 相对路径加行号，例如：
- `extensions/openai/openai-codex-provider.ts:33`
- `src/plugins/provider-openai-codex-oauth.ts:35-44`
如果拿不准行号，先查清楚再写。

6. 明确区分两件事：
- “OpenClaw 仓库已经明确实现的契约”
- “基于这些契约，可以在另一个软件里复刻的方案”
不要把推断写成事实。

7. 需要特别提醒：
- 这条路径不是 `OPENAI_API_KEY`
- 这是 ChatGPT/Codex OAuth 路径
- provider base URL 是 `https://chatgpt.com/backend-api`
- OpenClaw 当前默认模型写法是 `openai-codex/gpt-5.4`
- 截至 2026-04-02，OpenAI 官方公开模型目录更强调 `GPT-5-Codex` / `GPT-5.3-Codex` / `GPT-5.2-Codex`，因此要单独说明 OpenClaw 的模型命名和官方公开目录之间可能存在别名/前向兼容层，不要把这点忽略掉

8. 最后请额外输出两份内容：
- “给工程师的实施摘要”：不超过 15 条 flat bullets
- “给代码 agent 的执行提示词”：可直接复制给另一个 coding thread，用来实现这个 provider

限制：
- 不要修改代码
- 不要泛泛而谈 OAuth 基础知识
- 不要输出和仓库实现无关的通用 SDK 建议
- 如果某个底层细节只存在于 `@mariozechner/pi-ai` 而不在本仓库，请明确写“仓库内无法完全确认”

如果发现 OpenClaw 仓库里已经有足够接近可复用的抽象，也请指出最适合在另一个软件里复刻的最小抽象接口。
```

如果你愿意，我也可以顺手再给你一版“更短、更像内部派单”的版本。



下面给你一版可直接搬进另一个 Node/TypeScript 项目的 skeleton。它遵循 OpenClaw 这条 `openai-codex` 路径的核心设计：

- `openai-codex` 是独立 provider，不复用 `openai`
- 用 OAuth profile 存 `access/refresh/expires/accountId`
- 运行时直接把 OAuth `access` 当 bearer token
- base URL 固定走 `https://chatgpt.com/backend-api`
- payload 默认 `store: false`
- `service_tier`、`text.verbosity` 可透传
- transport 预留 `auto/websocket/sse`，先把 SSE/HTTP 跑通

有一个边界我先说明：OAuth 浏览器登录和 refresh 的底层细节在 OpenClaw 里主要委托给 `@mariozechner/pi-ai`。所以下面 skeleton 把这部分抽象成 `CodexOAuthClient`，你可以接 `pi-ai`，也可以自己实现。

**`src/providers/openai-codex/provider.ts`**
```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type CodexTransport = "auto" | "websocket" | "sse";
export type CodexServiceTier = "auto" | "default" | "flex" | "priority";
export type CodexTextVerbosity = "low" | "medium" | "high";

export type CodexOAuthCredential = {
  type: "oauth";
  provider: "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  displayName?: string;
};

export type CodexAuthStore = {
  version: 1;
  profiles: Record<string, CodexOAuthCredential>;
  order?: Record<string, string[]>;
};

export type CodexUsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type CodexUsageSnapshot = {
  provider: "openai-codex";
  plan?: string;
  windows: CodexUsageWindow[];
};

export interface CodexOAuthClient {
  login(params: {
    isRemote?: boolean;
    openUrl?: (url: string) => Promise<void>;
    localBrowserMessage?: string;
  }): Promise<Omit<CodexOAuthCredential, "type" | "provider">>;

  refresh(params: {
    refresh: string;
    access?: string;
  }): Promise<
    Pick<CodexOAuthCredential, "access" | "refresh" | "expires"> &
      Partial<Pick<CodexOAuthCredential, "accountId" | "email" | "displayName">>
  >;
}

export type OpenAICodexProviderOptions = {
  authStorePath: string;
  oauthClient: CodexOAuthClient;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  responsePath?: string;
  usagePath?: string;
  userAgent?: string;
};

export type CreateCodexResponseRequest = {
  profileId?: string;
  model?: string;
  input: unknown;
  transport?: CodexTransport;
  serviceTier?: CodexServiceTier;
  textVerbosity?: CodexTextVerbosity;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export class OpenAICodexProvider {
  private readonly authStorePath: string;
  private readonly oauthClient: CodexOAuthClient;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly responsePath: string;
  private readonly usagePath: string;
  private readonly userAgent: string;

  constructor(options: OpenAICodexProviderOptions) {
    this.authStorePath = options.authStorePath;
    this.oauthClient = options.oauthClient;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://chatgpt.com/backend-api";
    // Inferred from OpenClaw tests. Keep configurable.
    this.responsePath = options.responsePath ?? "codex/responses";
    this.usagePath = options.usagePath ?? "wham/usage";
    this.userAgent = options.userAgent ?? "YourAppCodexProvider/0.1";
  }

  async login(params?: {
    profileName?: string;
    isRemote?: boolean;
    openUrl?: (url: string) => Promise<void>;
  }): Promise<{ profileId: string; credential: CodexOAuthCredential }> {
    const profileName = normalizeProfileName(params?.profileName ?? "default");
    const raw = await this.oauthClient.login({
      isRemote: params?.isRemote,
      openUrl: params?.openUrl,
      localBrowserMessage: "Complete sign-in in your browser.",
    });

    const credential: CodexOAuthCredential = {
      type: "oauth",
      provider: "openai-codex",
      access: raw.access,
      refresh: raw.refresh,
      expires: raw.expires,
      ...(raw.accountId ? { accountId: raw.accountId } : {}),
      ...(raw.email ? { email: raw.email } : {}),
      ...(raw.displayName ? { displayName: raw.displayName } : {}),
    };

    const profileId = `openai-codex:${profileName}`;
    const store = await this.readStore();
    store.profiles[profileId] = credential;
    store.order = {
      ...(store.order ?? {}),
      "openai-codex": unique([profileId, ...(store.order?.["openai-codex"] ?? [])]),
    };
    await this.writeStore(store);

    return { profileId, credential };
  }

  async createResponse<T = unknown>(request: CreateCodexResponseRequest): Promise<T> {
    const resolved = await this.resolveRuntimeCredential(request.profileId);
    const url = this.buildUrl(this.responsePath);

    const transport = request.transport ?? "auto";
    if (transport === "websocket") {
      throw new Error(
        "WebSocket transport is not implemented in this skeleton yet. Start with transport='sse' or 'auto'.",
      );
    }

    const body: Record<string, unknown> = {
      model: stripProviderPrefix(request.model ?? "openai-codex/gpt-5.4"),
      input: request.input,
      store: false,
      ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
      ...(request.textVerbosity ? { text: { verbosity: request.textVerbosity } } : {}),
      ...(request.extraBody ?? {}),
    };

    const headers = {
      ...this.buildAuthHeaders(resolved.credential),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(request.headers ?? {}),
    };

    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      throw await this.buildHttpError(res);
    }

    return (await res.json()) as T;
  }

  async fetchUsage(profileId?: string): Promise<CodexUsageSnapshot> {
    const resolved = await this.resolveRuntimeCredential(profileId);
    const url = this.buildUrl(this.usagePath);

    const res = await this.fetchFn(url, {
      method: "GET",
      headers: {
        ...this.buildAuthHeaders(resolved.credential),
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw await this.buildHttpError(res);
    }

    const data = (await res.json()) as {
      plan_type?: string;
      credits?: { balance?: number | string | null };
      rate_limit?: {
        primary_window?: {
          limit_window_seconds?: number;
          used_percent?: number;
          reset_at?: number;
        };
        secondary_window?: {
          limit_window_seconds?: number;
          used_percent?: number;
          reset_at?: number;
        };
      };
    };

    const windows: CodexUsageWindow[] = [];
    const primary = data.rate_limit?.primary_window;
    const secondary = data.rate_limit?.secondary_window;

    if (primary) {
      const hours = Math.round((primary.limit_window_seconds ?? 10800) / 3600);
      windows.push({
        label: `${hours}h`,
        usedPercent: clampPercent(primary.used_percent ?? 0),
        ...(primary.reset_at ? { resetAt: primary.reset_at * 1000 } : {}),
      });
    }

    if (secondary) {
      const hours = Math.round((secondary.limit_window_seconds ?? 86400) / 3600);
      windows.push({
        label: hours >= 168 ? "Week" : hours < 24 ? `${hours}h` : "Day",
        usedPercent: clampPercent(secondary.used_percent ?? 0),
        ...(secondary.reset_at ? { resetAt: secondary.reset_at * 1000 } : {}),
      });
    }

    let plan = data.plan_type;
    if (data.credits?.balance !== undefined && data.credits.balance !== null) {
      const balance =
        typeof data.credits.balance === "number"
          ? data.credits.balance
          : Number.parseFloat(String(data.credits.balance));
      if (Number.isFinite(balance)) {
        plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
      }
    }

    return {
      provider: "openai-codex",
      ...(plan ? { plan } : {}),
      windows,
    };
  }

  async resolveRuntimeCredential(profileId?: string): Promise<{
    profileId: string;
    credential: CodexOAuthCredential;
  }> {
    const store = await this.readStore();
    const resolvedProfileId = this.pickProfileId(store, profileId);
    const credential = store.profiles[resolvedProfileId];
    if (!credential) {
      throw new Error(`No Codex OAuth profile found for "${resolvedProfileId}".`);
    }

    if (Date.now() < credential.expires) {
      return { profileId: resolvedProfileId, credential };
    }

    const refreshed = await this.oauthClient.refresh({
      refresh: credential.refresh,
      access: credential.access,
    });

    const next: CodexOAuthCredential = {
      ...credential,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
      ...(refreshed.email ? { email: refreshed.email } : {}),
      ...(refreshed.displayName ? { displayName: refreshed.displayName } : {}),
    };

    store.profiles[resolvedProfileId] = next;
    await this.writeStore(store);

    return { profileId: resolvedProfileId, credential: next };
  }

  private async readStore(): Promise<CodexAuthStore> {
    try {
      const raw = await readFile(this.authStorePath, "utf8");
      const parsed = JSON.parse(raw) as CodexAuthStore;
      return {
        version: 1,
        profiles: parsed.profiles ?? {},
        ...(parsed.order ? { order: parsed.order } : {}),
      };
    } catch (error) {
      const code = asNodeErrorCode(error);
      if (code === "ENOENT") {
        return { version: 1, profiles: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: CodexAuthStore): Promise<void> {
    await mkdir(path.dirname(this.authStorePath), { recursive: true });
    const tmp = `${this.authStorePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await rename(tmp, this.authStorePath);
  }

  private pickProfileId(store: CodexAuthStore, requested?: string): string {
    if (requested) {
      return requested;
    }
    const ordered = store.order?.["openai-codex"] ?? [];
    if (ordered[0]) {
      return ordered[0];
    }
    const fallback = Object.keys(store.profiles).find((id) => id.startsWith("openai-codex:"));
    if (fallback) {
      return fallback;
    }
    throw new Error("No openai-codex OAuth profile found. Run login first.");
  }

  private buildAuthHeaders(credential: CodexOAuthCredential): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.access}`,
      "User-Agent": this.userAgent,
      ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
    };
  }

  private buildUrl(relativePath: string): string {
    return new URL(relativePath.replace(/^\/+/, ""), `${this.baseUrl.replace(/\/+$/, "")}/`).toString();
  }

  private async buildHttpError(res: Response): Promise<Error> {
    const text = await safeReadText(res);
    const detail = text ? ` ${text}` : "";
    return new Error(`OpenAI Codex request failed: ${res.status} ${res.statusText}.${detail}`);
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function stripProviderPrefix(model: string): string {
  return model.startsWith("openai-codex/") ? model.slice("openai-codex/".length) : model;
}

function normalizeProfileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.trim();
  } catch {
    return "";
  }
}

function asNodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
```

**如果你想直接复用 OpenClaw 同款 OAuth 底层，可以接 `@mariozechner/pi-ai`**
```ts
import type { CodexOAuthClient } from "./provider";
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
} from "@mariozechner/pi-ai/oauth";

export class PiAiCodexOAuthClient implements CodexOAuthClient {
  async login(): Promise<{
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    email?: string;
    displayName?: string;
  }> {
    const creds = await loginOpenAICodex({
      onAuth: async ({ url }: { url: string }) => {
        console.log("Open this URL in your browser:");
        console.log(url);
      },
      onPrompt: async ({ message }: { message: string }) => {
        throw new Error(`Interactive prompt not wired: ${message}`);
      },
      onProgress: (message: string) => {
        console.log(message);
      },
    });

    if (!creds) {
      throw new Error("OpenAI Codex OAuth login returned no credentials.");
    }

    return {
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      ...(typeof creds.accountId === "string" ? { accountId: creds.accountId } : {}),
      ...(typeof creds.email === "string" ? { email: creds.email } : {}),
    };
  }

  async refresh(params: {
    refresh: string;
    access?: string;
  }): Promise<{
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  }> {
    const refreshed = await refreshOpenAICodexToken(params.refresh);
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      ...(typeof refreshed.accountId === "string" ? { accountId: refreshed.accountId } : {}),
    };
  }
}
```

**最小使用示例**
```ts
import os from "node:os";
import path from "node:path";
import {
  OpenAICodexProvider,
} from "./src/providers/openai-codex/provider";
import {
  PiAiCodexOAuthClient,
} from "./src/providers/openai-codex/piai-oauth-client";

const provider = new OpenAICodexProvider({
  authStorePath: path.join(os.homedir(), ".yourapp", "auth-profiles.json"),
  oauthClient: new PiAiCodexOAuthClient(),
});

async function main() {
  // 首次登录时执行一次
  // await provider.login({ profileName: "default" });

  const response = await provider.createResponse({
    model: "openai-codex/gpt-5.4",
    input: [
      {
        role: "user",
        content: "Write a TypeScript function that debounces an async callback.",
      },
    ],
    transport: "auto",
    serviceTier: "default",
    textVerbosity: "medium",
  });

  console.dir(response, { depth: null });

  const usage = await provider.fetchUsage();
  console.dir(usage, { depth: null });
}

void main();
```

**这版 skeleton 的设计取舍**
- `responsePath` 默认用了 `codex/responses`。这是根据 OpenClaw 测试里的 URL 推断出来的，做成了可配置。
- `store: false` 是默认行为，和 OpenClaw 对 Codex Responses 的处理一致。
- `ChatGPT-Account-Id` 只有在 credential 里有 `accountId` 时才发。
- 先把 HTTP/SSE 路跑通，`websocket` 先留接口，不在 skeleton 里硬写。
- OAuth 登录、refresh 被抽象成接口，所以你可以先接 `pi-ai`，后面再换自己实现。

**上线前你还应该补的两块**
- 给 auth store 加文件锁，避免并发 refresh 时互相覆盖。
- 给 `createResponse` 增加流式 SSE 解析，而不是只等整包 JSON。

如果你要，我下一条可以直接继续补成：
1. `websocket` 版本 skeleton  
2. SSE 流式解析版本  
3. 一个完整的 `Express/Fastify` provider adapter，让你的应用直接暴露 `/chat` 接口。



