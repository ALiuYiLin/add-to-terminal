# Add to Terminal × DSH Web —— 选中代码一键送进 DSH 输入框（设计与实现记录）
> **关于本文档** —— 这是 Add to Terminal × DSH Web 桥接的完整记录：方案对比 → 定稿 → 实现 → 两次线上事故复盘。
>
> - 当前状态：插件 `packages/dsh-add-to-terminal`（0.2.1）+ 扩展 `packages/vscode-add-to-terminal`（0.5.0）；
> - 文中出现的 `E:\code3\dsh-info\...` 是**搬迁前的历史路径**：本仓库现在是 pnpm monorepo，插件在 `packages/dsh-add-to-terminal`；
> - 给 DSH 写插件的同学，建议直接读 **附录 F / 附录 G**（启动被拒与页面卡死的根因、以及零 pnpm 的可用装法）；
> - 文中提到的 `verify-*.cjs` 是机器相关的验证脚本，放在单独的 `dsh-info` 仓库；插件自带的两套离线套件已随包放在 `packages/dsh-add-to-terminal/test/`。

> 状态：已实现（插件 0.2.1 + 扩展 0.5.0）。本文保留从方案讨论到线上事故复盘的完整过程。
> 目标：VS Code 里选中代码 / 右键文件 / 点灯泡修复项 → 一次点击 → DSH Web 的**输入框草稿**里出现引用文本，未提交，用户补一句话再回车。

---

## 0. 结论速览

推荐 **方案 B（宿主路由 + SSE + 页面插件）**，并用 **方案 A 的 URL fragment 深链**做两件事的兜底与增强：

1. **把浏览器窗口带到前台**（页面插件无法可靠 `window.focus()`，但同文档 hash 导航会激活已打开的标签页）；
2. POST 失败时的**降级投递通道**（payload 直接塞进 hash）。

链路一句话：

```
VS Code 扩展 --HTTP POST(loopback+token)--> DSH 宿主插件 --SSE--> 页面客户端插件 --inputActions--> 输入框草稿
```

全部落地大概是一个 DSH bundle（宿主半 + 客户端半）+ VS Code 扩展里一个 sink。

---

## 1. 需求拆解：为什么必然是"三段桥"

| 位置 | 事实 | 推论 |
|---|---|---|
| 选中代码 / 光标行号 / 诊断 | 在 VS Code 扩展宿主进程里 | 只能由扩展**主动发起**（VS Code 扩展不能被外部进程反向调用），第一跳必须扩展自己走 |
| 输入框草稿 | 在浏览器页面里（localStorage 持久化：`dsh-client-ui-conversation` 的 `CONVERSATION_STORE_KEY` + sessionId） | 宿主进程**写不了**草稿，必须有页面侧插件 |
| 浏览器 | 不能被动接收连接 | 第二跳要么页面常连接（SSE/WS/轮询），要么靠导航事件（hash 深链） |

所以最小完整方案 = **扩展侧改动** + **DSH 页面侧插件**；宿主侧插件只在这两跳之间做"可靠的收件箱"（队列/ack/多标签仲裁）时才需要。

---

## 2. 现状与已验证能力（本机运行时 + 发行包核对）

### 2.1 输入框可写，而且是公开 API

- 槽位 `conversation.input.left`（list、**session 作用域**）的 standard props 里有：
  - `inputActions: InputActions`
  - `useInput: SnapshotSelectorHook<InputState>`（可读当前 `draft` / `draftRev`）
  - `sessionId: SessionId`
- `InputActions`（`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`，注释原文 "The public input action face provided to every session-scope slot component"）：
  - `captureInsertion(): TokenSpan`
  - `insertText(text, span): boolean` ← 带 revision 守卫（draft 变了返回 false）
  - `setDraft(text): void` ← 整段替换
  - `submit(): void` / `addAttachments()` / `removeAttachment()` / `pruneAttachments()`
- 结论：**页面插件只要占一个 session 作用域槽位，就能写草稿**，不需要任何私有 API。
  （`conversation.composer.bar` 里还有 `focus()`、`paste()` 等更强的手段，但那是 package-internal 的 inject face，跨插件拿不到。）

### 2.2 引用文本的形态

- `@file` mention 插入的是**普通提示词文本**（不是 chip）：`@path`、`@"path with spaces"`；相对路径**以工作区根解析**，绝对路径保留主机路径（`dsh-file-reference` README）。
- 也就是说 DSH 侧最自然的产物是 `` @src/app.ts:42-58 error: ... ``，不需要构造引用 chip。
- 现有扩展的输出格式（`` `src/app.ts:42-58` ``）依然能工作，只是不享受 DSH 的 `@` 语法/高亮。

### 2.3 宿主侧能开 HTTP 路由，而且能做 SSE

- `ctx.webServer.register({kind:'exact'|'prefix', path, handler})`，`handler` 自己拥有完整响应生命周期，"may hold the response open, e.g. SSE"；重复路径抛错。
- webserver 本身"carries no TLS, authentication, or origin policy of its own" → **自定义路由要自带 token 与 Origin 校验**。
- 端口可配置（默认 3080，本次运行就是 127.0.0.1:3080）；`ctx.webServer.port` 可读实际端口。
- Web GUI 的鉴权（进程 token → 签名 cookie，控制 `/api` 与 WS 流）在网关那一层；自定义路径不在 `/api` 前缀下，所以扩展可以直接 POST，不需要 DSH 的会话凭据。

### 2.4 页面插件怎么被加载

- bundle 的 `package.json` 里 `dsh.client = { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation'] }`，客户端半是一个用 `window.__ModuleLoader__.load({id, factory})` 注册的普通浏览器模块（模板 `templates/decoration/client.js`）。
- 因此页面插件**天然可以做同源 `fetch` / `EventSource`**，这是宿主→页面的推送通道。

### 2.5 其它相关事实

- `WebRoute` 只能拿到 `IncomingMessage`；同一来源的多次 POST 需要自己做幂等（nonce）。
- 页面 URL 是目录式（启动 URL 带 token → 换 cookie → 重定向到不带 token 的同目录），fragment 大概率是空闲的（实现时验证一下 SPA 是否使用 hash 路由）。
- 宿主侧还能拿到会话创建元数据里的 `cwd`（`dsh-session` 的 `SessionCreationMeta.cwd`），所以**由宿主按会话重写相对路径**是可能的。

---

## 3. 候选方案

### 方案 A：纯客户端 + URL fragment 深链（最小实现）

```
VS Code: vscode.env.openExternal("http://127.0.0.1:3080/#dsh-at=<base64>&n=<nonce>")
页面插件: 读 location.hash / 监听 hashchange → 解出 payload → inputActions 写入草稿
```

- 只要一个客户端半（无宿主半、无端口/令牌/队列）。
- 同源不同 fragment 属同文档导航：**已打开的标签页会被激活且不重载**，正好解决"切回浏览器"的体验问题。
- 缺点：
  - 页面没开时 `openExternal` 会开新标签页，payload 落在"新页面默认进入的那个会话"上，**不一定是你在看的那个**；
  - 扩展拿不到任何 ack，只能乐观提示；
  - 相同内容重复点击时 hash 相同 → 不触发 `hashchange`，必须带 nonce，URL 会有点脏；
  - 依赖默认浏览器 = 你放 DSH 的那个浏览器；DSH 若跑在 Desktop(Electron/file://) 形态则形态不同；
  - payload 会进浏览器历史/地址栏。

### 方案 B：宿主路由 + SSE + 页面插件（推荐）

```
POST /dsh-add-to-terminal/push   （VS Code → 宿主，带 token，返回 {ok, delivered|queued})
GET  /dsh-add-to-terminal/stream （页面 → 宿主，SSE，带 sessionId；宿主记录连接与"最近活跃"）
POST /dsh-add-to-terminal/ack    （页面 → 宿主，确认已写入草稿，宿主据此清队列）
```

- 宿主持有小队列（深度 ≤ 10、TTL 5 分钟），页面没开就排队，页面一开自动补投；扩展拿到真实 ack。
- 可选增强：POST 成功后再 `openExternal("…#dsh-focus=<nonce>")` 把浏览器带到前台（不重载页面）。
- 成本：宿主半 + 客户端半 + 扩展三处改动；多标签仲裁、令牌、队列语义要写清楚。

### 方案 C：文件邮箱 + 宿主 watch

- 扩展把 JSON 追加到 `%TEMP%\dsh-add-to-terminal\queue.jsonl`（或 `$DSH_HOME/...`），宿主插件 `fs.watch` 后**仍需**走 B 的 SSE 那最后一跳。
- 优点：不占端口、不需要管 `/api` 鉴权、DSH 端口随机也无所谓。
- 缺点：文件增长/权限/事件延迟；最后一跳没省；ack 更绕。
- 定位：方案 B 的网络形态备选（例如以后要跨 SSH/容器时）。

### 方案 D：直接投递成一条用户消息（不走草稿）

- 宿主侧用会话控制器/agent 接口把引用作为一条 user message 投给指定会话（`dsh-api-session-controller` 的 `prompt(request, signal)`："Admit one prompt after explicitly resuming its Session"），或 `ctx.agents` 那套。
- 优点：页面完全不用开；真正的"一键问 agent"。
- 缺点：**丢掉了"先落在输入框、我再补一句问题"的核心体验**；还要决定目标会话与 queue/steer 语义。
- 定位：未来可选的 `mode: 'send'`，不是 MVP。

### 已排除

- **剪贴板 + 聚焦 + 模拟粘贴**：抢用户剪贴板、无 ack、极易静默失败。
- **复用现有终端通道**（把文本发进 DSH 的 Web 终端面板）：那是 shell 提示符，不是输入框，语义完全不同。
- **让 DSH 侧 MCP/工具去"拉" VS Code 状态**：变成 agent 主动拉取，和"点一下就在输入框里"是两回事。

### 对比

| 维度 | A 深链 | B 宿主路由+SSE | C 文件邮箱 | D 直接发消息 |
|---|---|---|---|---|
| 新增部件 | 客户端半 | 宿主半+客户端半 | 宿主半+客户端半 | 宿主半 |
| 页面没开 | 开新页，落点不确定 | 排队，开页补投 | 排队，开页补投 | 直接生效 |
| 扩展能否拿到确认 | ❌ | ✅ | ✅（绕） | ✅ |
| 浏览器自动前台 | ✅ 天然 | 需额外深链 | 需额外深链 | 不需要 |
| 多标签页 | 天然只作用当前页 | 需仲裁 | 需仲裁 | 不需要 |
| 会话定位 | 只能"当前页" | 可精确到 sessionId | 同 B | 必须显式指定 |
| 安全面 | 无（URL 可被伪造） | 需 token+Origin | 文件权限 | 需权限校验 |
| 实现量（相对） | 1x | 2.5x | 3x | 1.5x |

---

## 4. 推荐方案详细设计（B 主 + A 兜底/聚焦）

### 4.1 组件与职责

```
┌──────────────────────┐        ┌───────────────────────────────┐        ┌──────────────────────────────┐
│ VS Code 扩展          │  POST  │ DSH bundle · Host half         │  SSE   │ DSH bundle · Client half      │
│ add-to-terminal       │ ─────► │ /dsh-add-to-terminal/*         │ ─────► │ conversation.input.left 占用者 │
│  · 现有格式化逻辑      │  token │  · 队列(深度/TTL) + 去重(nonce) │        │  · EventSource + 增量补拉      │
│  · DshSink（新）       │ ◄───── │  · token 文件、Origin 校验      │ ◄───── │  · inputActions 写草稿         │
│  · openExternal 聚焦   │  ack   │  · 多标签仲裁（最近活跃/聚焦）   │  ack   │  · 角标：已插入/排队中/未连接   │
└──────────────────────┘        └───────────────────────────────┘        └──────────────────────────────┘
```

### 4.2 bundle 布局（占位命名）

```
dsh-add-to-terminal/
  package.json       # dsh.bundle.patch + dsh.client{platform:'web',immediately:true,inject:[conversation]}
  cordis.patch.yml   # insert: { id: dsh-add-to-terminal, name, config: { tokenFile, queueMax, queueTtlMs } }
  index.js           # Host half：webServer 路由 + 队列 + 令牌
  client.js          # Client half：SSE + slot 占用者 + 写入
  locale/{en,zh}.json
```

VS Code 侧：

```
src/sinks/types.ts       # interface Sink { send(text): Promise<SinkResult> }
src/sinks/terminalSink.ts# 现有行为（Claude Code 等）
src/sinks/dshSink.ts     # POST + 失败降级深链 + 聚焦
src/extension.ts         # 目标选择：addToTerminal.destination = terminal | dsh | both
```

### 4.3 时序

**场景 1：DSH 页面开着（常见）**

```
用户 Ctrl+Alt+T
  → 扩展格式化 + POST /push {text, device, nonce, ts, workspace}
  → 宿主：找到"最近活跃"的 SSE 连接 → 推 {seq, text}
  → 页面插件：inputActions.captureInsertion() + insertText(text, span)
      ├─ 成功 → POST /ack {seq} → 宿主清条目
      └─ span 失效 → 重取一次；再失败 → setDraft(draft + sep + text)
  → 【可选】扩展 openExternal(#dsh-focus=nonce) 把浏览器带到前台
  → 返回 {ok:true, delivered:true} → VS Code 提示 "已插入 DSH 输入框"
```

**场景 2：页面没开**

```
POST /push → 无活动连接 → 入队（深度/TTL 限制）→ 返回 {ok:true, queued:true}
  → 扩展提示 "DSH 未打开，已排队（打开后自动填入）" + 可选 openExternal 唤起页面
  → 用户打开页面 → 客户端半加载 → SSE 连上并上报 sessionId
  → 宿主按 seq 增量补投（或 GET /pending?since=seq 兜底）→ 页面写入草稿 → ack
```

### 4.4 协议草案

```jsonc
// POST /dsh-add-to-terminal/push
{
  "text": "@src/app.ts:42-58 error: Cannot find name 'foo'",  // 已渲染好的兜底文本
  "structured": {                                             // 便于宿主重写路径
    "items": [
      { "kind": "editor|explorer|diagnostic",
        "abs": "E:/code3/x/src/app.ts", "rel": "src/app.ts",
        "start": 42, "end": 58,
        "message": "Cannot find name 'foo'", "severity": "error" }
    ],
    "workspace": "E:/code3/x"
  },
  "client": "vscode", "nonce": "…", "ts": 1730000000000
}
// 200: { "ok": true, "delivered": true|false, "queued": true|false, "queueSize": 1 }

// GET /dsh-add-to-terminal/stream?sessionId=…&since=12    → SSE
//   event: item   data: { seq, text }
//   event: hello  data: { seq }         // 当前水位，供增量补拉
// POST /dsh-add-to-terminal/ack  { seq }
// GET  /dsh-add-to-terminal/pending?since=N  （EventSource 不可用时的轮询兜底）
```

### 4.5 写入草稿的细节

- **追加，不覆盖**：读 `useInput(s => s.draft)`；`captureInsertion()` 拿 span；`insertText(text + ' ', span)`。
- 分隔规则：草稿非空且不以空白结尾 → 前后补空格/换行（建议换行，多个引用更清晰）。
- `insertText` 返回 false（span 失效 / 正在提交）→ 重新 `captureInsertion()` 再试一次；仍失败 → `setDraft(draft + sep + text)`。
- **不自动 submit**（保留用户补问题的环节）。`submit` 只作为未来 `mode:'send'` 的可选项。
- 编辑器未聚焦时 Lexical 事务仍可写，但"是否稳定"要在实现阶段真机验证一次。

---

## 5. 关键设计点与取舍

1. **目标会话**：默认 = 页面当前可见会话（插件的 slot props 自带 `sessionId`）。页面在 SSE 里上报 sessionId，宿主投递给"最近活跃的那条连接"。
   **补充（见附录 A）：改成"VS Code 侧显式选目标会话"更好**——把"投给谁"从隐式变成显式，顺带解决多标签页歧义。
2. **多标签页**：必须仲裁，否则同一 payload 会被多个标签重复插入。规则：页面在 `visibilitychange`/`focus` 时上报心跳，宿主只投"最近聚焦"的那条连接；无聚焦者时投最近连接的一条。
3. **路径映射（最容易被忽略的坑）**：`@` 相对引用以 DSH 工作区根解析，而 VS Code 的工作区文件夹不一定等于该会话的 `cwd`。
   - 建议：扩展同时发送 `abs`/`rel`/`workspace`；宿主用 `sessionId → cwd` 校验并重写；文件不在 cwd 下 → 退化为绝对路径或纯文本。
   - 保底：纯文本 `` `E:/code3/x/src/app.ts:42-58` `` 永远对模型可读。
4. **文本形态**：建议 DSH 目标默认用 `@rel:start-end`（贴合 DSH 原生 `@` 语法），保留一个设置切回现有反引号格式。
5. **浏览器焦点**：页面插件 `window.focus()` 不可靠（无用户手势）；用 `openExternal(url + '#dsh-focus=nonce')` 的同文档导航唤起已有标签页。可配置 `dshFocus: always | whenQueued | never`。页面侧再加一个"有新内容"角标，避免用户没注意。
6. **安全**：自定义路由不受 `/api` 网关保护，必须自带：
   - 仅 loopback（Web GUI 本来就拒绝 `0.0.0.0`）；
   - token：宿主生成随机串写到发现文件（如 `$DSH_HOME/add-to-terminal/bridge.json`，权限收紧），扩展读取 → **零配置**；也支持 VS Code 设置里手填覆盖；
   - 拒绝带非本机 Origin 的请求（防任意网页用无预检 POST 盲插），或要求自定义头 `X-DSH-Bridge` 触发预检；
   - payload 上限（如 8 KB）、JSON 形状校验、队列深度/TTL 限流、nonce 幂等。
7. **端口发现**：`addToTerminal.dshUrl` 默认 `http://127.0.0.1:3080`；宿主把 `{url,port,token}` 写入同一个发现文件，扩展优先读文件、回退设置。这样用户改端口/随机端口都不用配。
8. **失败可见性**：扩展侧三种提示（已插入 / 已排队 / 连不上，附排查提示）；页面侧角标。绝对不要静默丢。
9. **与现有终端目标共存**：扩展抽出 `Sink`，`destination: terminal | dsh | both`；甚至两个快捷键分别绑两条链路（`Ctrl+Alt+T` → DSH，`Ctrl+Alt+Shift+T` → 终端）。
10. **降级链**：POST 失败（端口变了/宿主没装）→ 自动改用 A 的深链把 payload 直接塞进 hash；这条兜底不需要任何宿主部件，装一半也能用。

---

## 6. 分阶段落地建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 只做方案 A：客户端半（slot 占用者 + hash 解析 + 写入）+ 扩展加一个 DSH 目标 | 选中代码 → 点击 → 浏览器前台 → 输入框出现引用，可继续打字 |
| M2 | 升级到方案 B：宿主路由 + SSE + 队列 + token/发现文件 + ack | 页面关闭时点击 → 打开页面后自动填入；扩展显示真实确认 |
| M3 | 精确化：cwd 路径重写、多标签仲裁、状态角标、资源管理器多选/诊断/Quick Fix 全覆盖、设置项 | 三种入口（编辑器/资源管理器/灯泡）行为一致 |
| M4（可选） | `mode: 'send'` 直发（方案 D）、反向能力（DSH 里点路径 → `vscode://file/…:42` 打开 VS Code） | — |

反向能力顺带说明：既然桥搭起来了，DSH → VS Code 用 `vscode://file/<abs>:<line>` URI handler 很便宜，可以考虑一起规划。

---

## 7. 风险与待实现阶段验证项

1. `openExternal` 同文档 fragment 导航**是否真的复用并激活已打开标签页**（Chrome/Edge 预期是；Firefox/Safari 需实测）。
2. 编辑器未聚焦时 `insertText` 的稳定性（预期可用，需真机确认）。
3. 宿主 bundle 的 host half 注册 `webServer` 路由、读写 `node:fs`（普通宿主插件预期可以，需实测确认；沙箱约束只针对动态 `cordis_run` 插件）。
4. 自定义（非 `/api`）路由是否真的绕过网关的 Host/Origin 检查 —— 若没有，方案 B 的鉴权设计要跟着调整。
5. DSH 前端是否使用 hash 路由（若使用，方案 A 的 payload 需要换到 query 或自定义事件）。
6. `@src/app.ts:42-58` 这种"带行号的相对 mention"在 DSH 里是被高亮/被模型正确解析，还是 `:42-58` 会让 mention 失配（必要时降级为 `` @src/app.ts `` + 文本行号，或纯文本）。
7. VS Code Remote/DevContainer 场景：扩展在远端跑，`127.0.0.1:3080` 需要端口转发或改用发现文件里的 LAN 地址。
8. `dsh-session` 的 `cwd` 通过哪个宿主服务按 `sessionId` 查（`ctx.agents.get(id)` / session store）—— 路径重写依赖它。

---

## 8. 待确认的决策

1. 起步用 **M1（深链，快）** 还是直接 **M2（宿主路由，一步到位）**？
2. 页面没打开时：**排队**（推荐）还是直接报错？
3. 文本形态：`@相对路径:行号`（贴合 DSH）还是保持现有 `` `路径:行号` ``？
4. 是否需要 `mode: 'send'`（直接提交给 agent，不等用户补话）？
5. 点击后是否**总是**把浏览器带到前台（推荐总是，或只在排队时）？
6. 终端目标（Claude Code）保留并行，还是 DSH 成为默认目标？
7. 这个 DSH 侧 bundle 做成**本机安装的私有 bundle**，还是准备成可发布的插件包？

---

# 附录 A：会话面板（显式目标）方案

> 结论：**成立，而且优先级不低。** 它把"投给谁"从隐式（当前可见会话 / 最近活跃标签页）变成显式，代价是扩展侧多一个面板 + 宿主多一个列表接口。

## A.1 为什么这样更好

| 问题（隐式目标） | 显式目标的解法 |
|---|---|
| 多标签页都要仲裁，否则重复插入 | 每个页面按 `sessionId` 登记，只投目标会话 |
| 页面开着别的会话，payload 会不会插错 | 不会，目标就是你在 VS Code 里点的那一个 |
| 用户不知道投到哪去了 | 面板/状态栏显示目标 + 投递结果 |
| 切换会话要回浏览器点 | 面板点击即可切换（页面侧 `uiWorkspace.openSession`） |

## A.2 数据来源（已核对，宿主侧全都有）

```
GET /dsh-add-to-terminal/sessions?workspace=<VS Code 工作区绝对路径>
```

宿主半内部：

1. `ctx.workspaceRegistry.resolveByPath(<abs>)` → `Workspace { id, path, title, sessionIds, status() }`
   - 注意：要求**全限定路径且目录存在**，内部走 `fs.realpath` 规范化；未注册的目录返回 `undefined`。
2. 兜底：即使没有 workspace 记录，也可以用
   `ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [<abs>] }])` 直接按会话 cwd 找。
3. `ctx.sessionQuery.listSessions()` / `filterSessions(...)` → `SessionRecord { header, live, persisted }`，
   `SessionHeader = { id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset? }`
4. `ctx.sessionQuery.readTitleSnapshots(ids)` → 会话标题（一批一次读，别 N+1）。
5. 归档集合来自 workspace registry（`archiveSession`/`unarchiveSession` 的那套），归档会话默认不列。

面板项字段建议：标题（无标题显示 `新会话 · <时间>`）、相对时间、`live`（宿主是否已激活）、`persisted`、`agentPreset`、是否当前目标。

## A.3 交互设计（建议）

- 面板（Activity Bar 容器 + TreeView）：
  - 顶部："目标：<会话名>" / 未选择时提示；
  - 列表项单击 = **设为目标并立刻投递当前选区**（最少步骤），右键菜单另有"仅设为目标"、"仅投递"、"在 DSH 中打开"；
  - 目标写进 `context.workspaceState`，VS Code 重载后仍然记得。
- 同时提供 Quick Pick（`DSH: 选择目标会话`）+ 状态栏项（显示当前目标 + 连接状态）。
  面板用于浏览，Quick Pick 用于键盘流；两者共用同一个目标状态。
- `Ctrl+Alt+T` 的语义不变："投给当前目标"；没有目标时回退到"当前可见会话"或弹 Quick Pick。

## A.4 投递状态机（"连接"其实是四种情况）

| 情况 | 行为 |
|---|---|
| 页面已连接且正显示目标会话 | SSE 直接投递 → 写草稿 → ack |
| 页面已连接，显示的是别的会话 | 客户端 `uiWorkspace.openSession(target)` 切过去 → **等 composer mount** → 写草稿（草稿按会话持久化，不会串台） |
| 页面未连接 | 入队（带 sessionId）→ 用户打开页面时，客户端半连上后自动 `openSession(target)` + 冲刷队列 |
| 目标是冷会话（persisted、未 live） | 打开会先 resume/激活，composer 出现有延迟 → 依靠"pending 队列 + slot 占用者 mount 后冲刷"，不要假设立刻可写 |

关键技术点：**写入能力只在 composer 挂载时存在**（`inputActions` 来自 slot props），所以页面插件必须是

```
模块级：SSE 连接 + pending 队列（与 slot 生命周期无关）
slot 占用者 mount 时：bindSession(sessionId, inputActions) → 冲刷属于该 session 的 pending
slot 占用者 unmount 时：解绑（此时如有未写内容，留在 pending 里等下次）
```

## A.5 坑（都要在实现里处理）

1. **路径规范化**：`resolveByPath` 是 realpath 语义的；VS Code 工作区可能是多根、子目录、符号链接、盘符大小写 / `\\` 混用。对不上时给一个"手动选择 DSH 工作区"入口（列 `workspaceRegistry.list()`）。
2. **不要用切换会话当副作用伤人**：用户可能正在 DSH 的会话 B 里打字，你在 VS Code 点了 A 就把页面切走。建议 `dshSwitchOnTarget: always | onlyWhenHidden(默认) | never`，并且草稿按会话持久化（不会丢内容）。
3. **子代理会话污染列表**：`header.parentSession` 存在 / `origin === 'subagent'` 的派生会话默认隐藏。
4. **`live` ≠ 正在跑 turn**：`SessionRecord.live` 只表示宿主是否激活（或可由 `workspace/session-activity` 那套判断），别在面板上写成"运行中"。
5. **时间/title 的读取量**：面板刷新要批量 `readTitleSnapshots`，并对 `listSessions` 做节流/缓存；别每次展开都全量读日志。
6. **多 VS Code 窗口 / 多根工作区**：目标状态按"工作区文件夹"存，别全局单例。

## A.6 对既有方案的影响

- **仍然需要**方案 B 的 SSE + 页面插件：草稿在页面侧，宿主再"精准"也写不了草稿（除非切到方案 D 直接发消息）。
- **仍然需要**深链聚焦（`openExternal(#dsh-focus=…)`）：投递到后台标签页后，得让用户看见。
- 多标签仲裁从"必须"降级为"目标会话同时被两个页面打开时才需要"（例如同一会话开两个标签页 → 只投最近聚焦那个）。
- 新增成本：扩展侧多一个 TreeView（约几百行）+ 宿主侧一个 `/sessions` 接口 + 页面侧 `openSession` 与队列冲刷逻辑。

## A.7 修订后的阶段划分

| 阶段 | 内容 |
|---|---|
| M1 | 深链最小闭环（方案 A） |
| M1.5 | VS Code 侧 Quick Pick + 状态栏 + 记忆目标（先不做面板），宿主 `/sessions` 接口 |
| M2 | 宿主路由 + SSE + 队列 + token/发现文件 + ack（方案 B） |
| M2.5 | 页面侧 `openSession` 切换 + pending 冲刷 + 冷会话等待 |
| M3 | Activity Bar 面板 TreeView、状态角标、路径映射/手动选择工作区、多根工作区 |

---

# 附录 B：简化版 —— 只投给"页面中已激活"的会话

> 结论：**对，可以砍掉一大块复杂度**（宿主队列、TTL、自动切会话、冷会话 resume 等待、跨挂载冲刷）。
> 前提是把"激活"定义准确，并且接受面板从"会话浏览器"退化成"当前已打开会话"。

## B.1 "激活"的准确含义

必须是**页面自己上报**的，不能用宿主侧状态推断：

| 概念 | 谁说了算 | 能不能作为"可连接"依据 |
|---|---|---|
| 会话存在于宿主 | `SessionRecord.persisted` | ❌ 冷会话没有页面 |
| 会话被宿主激活/可 resume | `SessionRecord.live` | ❌ 只是宿主侧活着，跟浏览器无关 |
| **页面已连 SSE 且当前正显示该会话** | 页面插件上报 | ✅ **只有这个能保证 composer 已挂载、`inputActions` 已绑定** |

上报机制（两种都行，推荐第一种）：

1. `EventSource('/dsh-add-to-terminal/stream?sessionId=<当前会话>')`；**切换会话时关闭并重连**（会话切换是低频操作，重连最省事，宿主侧的"可连接集合"永远准确、掉线自动清理）。
2. 常连 + 单独的 `POST /present { sessionId }` 更新。

宿主维护 `connectionId → sessionId`，并记录每条连接的**最近聚焦时间**（页面在 `focus`/`visibilitychange` 时打一个心跳）。

## B.2 因此可以砍掉的东西

- 宿主队列 / TTL / 幂等重放 / `queueSize` 语义；
- 页面侧 `uiWorkspace.openSession` 自动切换；
- 冷会话 resume 等待、"打开后再补投"；
- 跨挂载的 pending 冲刷（投递时 composer 一定已挂载）；
- 会话未打开时的"排队还是报错"这个决策（不再需要队列）。

## B.3 不能省的东西

| 部件 | 为什么还要 |
|---|---|
| 页面插件（slot 占用者） | 草稿在页面里，`inputActions` 只有 composer 挂载时才有 |
| 宿主路由 + SSE | 浏览器不能被动接收；扩展写不了页面 |
| 宿主 `/targets` 接口 | 扩展要知道"现在哪些会话可连接"，这个信息只有页面知道 |
| 深链聚焦 `openExternal(url#dsh-focus=…)` | 投进去之后得让用户看见（页面插件无法可靠 `window.focus()`） |
| ack（可选但便宜） | 页面写成功后 `POST /ack`，扩展的 HTTP 响应据此返回"已插入 / 目标未激活"，把"静默丢"变成明确反馈 |
| 多标签去重 | 同一会话被两个标签页打开时，只投**最近聚焦**的那条连接 |

## B.4 代价（要接受）

1. **面板退化**：一个页面同一时刻只显示一个会话，所以"可连接集合"通常只有 **1 项**（多标签才有多项）。它不再是"浏览项目所有会话并切换"的面板，而是"当前打开的会话 + 连接状态"指示器。
2. **没打开就没法投**：用户必须先让 DSH 打开那个会话。需要给出明确交互，而不是失败。

## B.5 推荐收尾（几乎同样简单，但保留可浏览性）

`/targets` 与 `/sessions` 两个接口分开：

- `/targets`：**可连接集合**（页面上报，通常 1 项），面板里可点、点击即投；
- `/sessions?workspace=<abs>`：项目全部会话（`workspaceRegistry` + `sessionQuery`），**只读**，用于浏览；非激活项灰显，附一个"在 DSH 中打开"按钮。

点"在 DSH 中打开"时：

```
openExternal(`${url}#dsh-open=<sessionId>`)   // 同文档导航，把浏览器带到前台且不重载
页面插件 → uiWorkspace.openSession(sessionId)
        → composer mount 后写入（浏览器侧一个小 pending 变量即可，宿主零队列）
```

这样"浏览 + 打开 + 投递"都有，而宿主侧依旧没有队列/TTL。

## B.6 边界与交互（简化版必须写清的几条）

1. **页面刷新 / 正在切会话时点击**：返回 `delivered:false, reason:'target-not-active'` → VS Code 明确提示"目标会话当前未在 DSH 中打开"，并给一个"打开 DSH"按钮（触发深链）。
2. **DSH 未运行 / 端口不通**：提示"无法连接 DSH"，并可选**回退到终端 sink**（扩展本来就有这条链路，`destination: dsh → terminal` 的降级是零成本实现）。
3. **`live` 不要当"运行中"用**：面板/状态栏若要显示运行状态，另找 activity 投影；`live` 只是宿主激活。
4. **目标记忆**：目标会话存 `workspaceState`，但每次投递前用 `/targets` 复核它是否仍激活；不激活就按第 1 条提示，不静默改投别人。

## B.7 修订后的阶段划分（比附录 A 更短）

| 阶段 | 内容 |
|---|---|
| M1 | 宿主 bundle（`/targets` + `/stream` SSE + `/push` + ack + token 发现文件）+ 页面插件（上报 sessionId、写 `inputActions`）+ 扩展 `DshSink` |
| M1.5 | 深链聚焦 `#dsh-focus`；VS Code 状态栏 + Quick Pick 目标；失败提示与终端回退 |
| M2 | `/sessions` 只读列表 + "在 DSH 中打开"（`#dsh-open` + 客户端 `openSession` + 浏览器侧 pending 写一次） |
| M3 | Activity Bar 面板 TreeView、状态角标、路径映射兜底、多根工作区 |

原附录 A 的 M1（纯深链）仍可作为"先看到效果"的探路版本保留。

---

# 附录 C：按"页面实例"投递（最终简化形态，以此为准）

> 目标：VS Code 面板列出**开着 DSH Web 的页面**，点一个作为目标；之后所有投递都进**那个页面的输入框**，不管它当前是哪个会话。
> 好处：宿主不再需要工作区/会话体系，投递目标是"输入框"而不是"会话"，语义唯一、无歧义。

## C.1 概念修正：可观察对象是"页面实例"，不是"浏览器进程"

浏览器不向网页暴露进程边界，宿主能看到的只有 **SSE 连接**。所以：

| 用户的说法 | 实际可观察的实体 |
|---|---|
| 浏览器进程 | 一条 SSE 连接 = 一个**标签页/窗口**里的 DSH 页面实例 |
| 同一浏览器两个窗口 | 两个页面实例（两条连接），可分别选 |
| 同一标签页刷新 | 理论上同一"实例"（用 `sessionStorage` 保住身份） |

面板项名称建议：**"DSH 页面"** 而不是"浏览器进程"。

## C.2 页面身份与标签

页面插件在 `sessionStorage` 里生成一次 `tabId`（刷新不变、新标签页新 id），连 SSE 时带上：

```
GET /dsh-add-to-terminal/stream?tabId=<id>&label=<base64(标签)>
POST /dsh-add-to-terminal/present   // 状态变化时更新：会话标题、可写性、聚焦时间
```

标签内容（都由页面自己知道，不需要宿主查会话）：

- 浏览器：`navigator.userAgent` 解析出的 Chrome/Edge/Firefox + 大版本；
- 当前工作区/会话标题：slot 的 standard props 里有 `useSessions` / `useSessionStatus` / `useConversation`，够用；
- 短 id：`tabId` 前 4 位，用来区分"同一个浏览器同一个会话的两个标签页"；
- 状态：`可写`（composer 已挂载）/ `无输入框`（Hero 空态或未选会话）/ `提交中`；
- `最近聚焦`：页面在 `focus` / `visibilitychange` 时上报心跳。

面板项示例：

```
Chrome  ●  可写      code3 · 修复登录弹窗      #a3f1   3 秒前活跃
Edge    ○  无输入框  （未选择会话）            #77c2   2 分钟前
```

## C.3 协议（比附录 B 更小）

```
GET  /dsh-add-to-terminal/targets            → [{ tabId, label, writable, lastFocusAt }]
GET  /dsh-add-to-terminal/targets/stream     → 可选：给 VS Code 自己用的 SSE，面板实时刷新
GET  /dsh-add-to-terminal/stream?tabId=…     → 页面连接（宿主登记/心跳）
POST /dsh-add-to-terminal/push  { tabId, text, nonce }
     → 200 { ok, delivered, reason }         // reason: 'not-connected' | 'not-writable' | 'insert-failed'
POST /dsh-add-to-terminal/ack   { nonce }    // 页面写入成功后的确认
```

宿主只维护一张 `tabId → { socket, label, writable, lastFocusAt }` 表 + 一个 nonce→ack 的短等待。**没有会话查询、没有队列、没有 TTL。**

## C.4 投递语义与边界

| 情况 | 行为 |
|---|---|
| 目标页面可写 | SSE 推给它 → 写草稿 → ack → 扩展提示"已插入" |
| 目标页面在 Hero / 未选会话 | `writable=false` → 面板已标灰 → 投递返回 `not-writable`，提示"该页面当前没有输入框" |
| 目标页面正在提交（`insertText` 可能返回 false） | 重取 span 重试一次；仍失败 → `insert-failed`，明确提示（不静默） |
| 目标页面已断开（关标签/刷新中断/DSH 重启） | `not-connected` → 提示 + 可选回退（见 C.6） |
| 投递后用户又切了会话 | 文本留在**插入时那个会话**的草稿里（草稿按会话持久化），可接受 |
| 同时有多个页面 | 只投被点击的那一个；只有一个页面时**自动成为目标**（零点击） |

## C.5 焦点问题（唯一变难的地方）

`openExternal(url + '#…')` 是按 **URL** 匹配激活标签页的。多个 DSH 标签页 URL 完全相同时，浏览器只会激活"最近使用的那个"，**不一定是目标**。

- 单标签页（绝大多数情况）：无歧义，直接用 `#dsh-focus=<nonce>` 把浏览器带到前台即可。
- 多标签页：可选技巧 —— 页面自己在 `history.replaceState` 里把自己的 `tabId` 写进 fragment，使每个标签页拥有**唯一 URL**，从而 `openExternal(url + '#dsh-tab=<id>')` 能精确定位到那一个标签页；接收页面若发现 id 不是自己就忽略并回执"focus-missed"。
  - 风险：要实测 DSH 前端是否会重写 hash（目录式路由大概率不会）。
- 兜底（永远有效）：目标页面收到"投递成功"后**闪一下标题**（`document.title = '● ' + 原标题`，几秒后还原）或显示角标；用户在浏览器里自己切。VS Code 侧提示"已投递给 #a3f1"，两边对得上号。

## C.6 砍掉 / 保留（相对附录 B 的增量简化）

**再砍掉：** `/sessions`、`workspaceRegistry.resolveByPath`、`sessionQuery`、cwd 路径匹配与重写、子代理/归档/冷会话过滤、`uiWorkspace.openSession`、会话级目标复核。

**新增：** `tabId` 身份、`/targets`、面板项的"可写性"状态、焦点兜底（标题闪烁）。

**仍然保留：** 页面插件（写草稿）、宿主 bundle（会合点 + 令牌/端口发现）、SSE、ack、深链聚焦。

**回退策略（建议做一条）：** `not-connected` / `not-writable` 时，可按配置自动改投**终端 sink**（扩展已有链路），或只提示。注意语义差别要在提示里写清楚。

**已考虑并排除：** 让 VS Code 扩展自己开本地 HTTP/SSE 服务、由页面反向连接（可以完全不要宿主 bundle）——但页面无法发现随机端口（页面读不了文件），只能用固定端口或端口扫描，得不偿失。

## C.7 阶段划分（以本节为准）

| 阶段 | 内容 |
|---|---|
| M1 | 宿主 bundle（`/stream` + `/targets` + `/push` + ack + token/端口发现文件）+ 页面插件（`tabId`、上报标签/可写性、写 `inputActions`）+ 扩展 `DshSink` |
| M1.5 | VS Code 面板（TreeView，列 DSH 页面，单页自动选目标，状态栏显示当前目标）+ 深链聚焦 + 失败提示与终端回退 |
| M2 | 多标签精确定位（per-tab fragment）、标题闪烁兜底、`/targets/stream` 实时刷新面板 |
| M3 | 可选增强：`submit` 直发模式、反向能力（DSH 里点路径 → `vscode://file/…:42` 打开 VS Code） |

**M1 之后的 UX 一句话：** 打开 DSH 页面 → VS Code 面板自动出现该项并被选为目标 → 选中代码点 `Ctrl+Alt+T` → 该页面的输入框里出现引用 → 你补一句话回车。

---

# 附录 D：M1 实现状态

## 已实现并验证

| 部件 | 位置 | 验证结果 |
|---|---|---|
| Host half | `E:\code3\dsh-info\dsh-add-to-terminal\index.js` | `/targets` 返回已连接页面；无令牌 → 401；`/context` 返回会话 `cwd`（实测 `E:\code3\dsh-info`）；`/push` → SSE → 页面写入 → ack → `delivered:true` |
| Client half | `…\dsh-add-to-terminal\client.js` | HMR 自动加载；`conversation.input.left` 占用者 `dsh-add-to-terminal` 已注册且 `active:true`；上报 tabId/标签/会话 id/可写性 |
| 发现文件 | `%TEMP%\dsh-add-to-terminal\bridge.json` | 启动即写入（url/port/token/pid） |
| 扩展 sink | `E:\code3\add-to-terminal\src\sink.ts` + `extension.ts` | 编译通过；harness 驱动真实编译产物：12/12 检查通过（不可达→回退终端、已投递→状态栏+焦点 URL+记住目标、终端目标保持反引号格式、6 种失败原因的回落策略） |
| Host 未确认路径 | `verify-noack.cjs` | 假页面声明可写但永不 ack → `push` 等待 2514ms 后返回 `{"ok":false,"reason":"no-ack"}` |
| VSIX | `E:\code3\add-to-terminal\add-to-terminal-0.2.0.vsix` | 已打包并 `code --install-extension` 安装（本机 VS Code 1.139.1 现为 `eelynn.add-to-terminal@0.2.0`，覆盖原 0.1.3） |

### 两条实现期的策略修正

1. **超时收紧**：`/targets` 1.2s、`/context` 0.8s、`/push` 4s（宿主 ack 超时 2.5s）。最坏情况从 9s 降到 6s，本地正常路径 &lt;100ms。
2. **未确认不重复投递**：`no-ack`（宿主已推送但页面未确认）标记为 `uncertain`，**不再自动回退终端**，只提示"未确认，可重试"；其余失败原因照常回退。否则一次点击可能同时出现在 DSH 草稿和终端里。

## 与设计的差异（重要）

`plugin_manager install_bundle` **失败**：pnpm 阶段在拉取无关平台的二进制（`@anthropic-ai/claude-agent-sdk-{linux,darwin}*`、`@openai/codex-{linux,darwin}*`）时网络超时 600s，`application: failed`。profile 状态本身完好（49 个顶层项、无断链、win32 包都在），只是没有启用。

因此改为手工补上 `install_bundle` 的同两步（等价且更小）：

1. `C:\Users\Administrator\.dsh\profiles\web\package.json` 的 `dependencies` 加 `"dsh-add-to-terminal": "link:E:/code3/dsh-info/dsh-add-to-terminal"`；
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-add-to-terminal"`。

`patchReload: live` 立刻生效，无需重启 DSH。注意 `pnpm-lock.yaml` 没有该依赖的 importer 条目（pnpm add 的写盘阶段被超时打断），后续若再跑 `pnpm install` / `install_bundle`，package.json 里的声明会让它保留。

## 尚未验证

1. 真实 VS Code UI 链路（`Ctrl+Alt+T` / 右键菜单 / 灯泡 Quick Fix）——扩展 0.2.0 已用 `code --install-extension` 装进本机 VS Code，只差按一次键；
2. `dshFocus` 深链在浏览器里的实际行为（焦点 URL 已断言，浏览器是否复用标签页未观察）；
3. 多标签页同时打开时的**真实**仲裁（规则已由 stub 覆盖 E1–E4，真实双标签未跑）。

## 复现验证（全部本地、不需要浏览器）

```powershell
node E:\code3\dsh-info\verify-bridge-behaviors.cjs   # 宿主半 10/10：身份/可写性/ack/未连接/重连
node E:\code3\dsh-info\verify-noack.cjs              # 宿主半：未确认推送 -> no-ack（~2.5s）
node E:\code3\dsh-info\verify-extension-flow.cjs     # 扩展半 22/22：回退策略/取目标/渲染/三个入口
node E:\code3\dsh-info\verify-client-core.cjs        # 页面半 18/18：排队/挂载冲刷/分隔/ack 失败
```

后两个脚本用 stub `vscode` / stub bridge / stub DOM，**不会**污染真实输入框。

## 验证覆盖（合计 50 项自动检查 + 真实投递）

| 范围 | 覆盖内容 |
|---|---|
| 宿主半 10/10 | SSE hello、`/targets` 标签与可写性、item 文本、ack→delivered、不可写拒绝、未知标签 `not-connected`、同 tabId 重连只留一条并退役旧连接、重连刷新标签、push 响应回带标签 |
| 宿主半 no-ack | 假页面声明可写但永不 ack → 2514/2505ms 后返回 `no-ack` |
| 扩展半 22/22 | 不可达→回退终端、delivered→状态栏/无终端写入/焦点 URL/记住目标、终端格式不变、6 种失败原因的回落策略（`no-ack` 不回退）、取目标 4 条规则、相对/绝对路径、带空格加引号、诊断尾串（含反引号转义）、资源管理器多文件换行、Quick Fix 入口 |
| 页面半 18/18 | 注册槽位与顺序、EventSource URL 带 tabId、tabId 落 sessionStorage、无 composer 时 `writable:false`、标签含浏览器与页面标题、未挂载时排队不 ack、挂载即冲刷并 ack、草稿非空补换行、插入失败回 `insert-failed`、卸载报不可写并重新排队、重挂载再冲刷 |
| 真实链路 | 真实 Chrome 标签页连接、3 次真实投递被页面写入草稿并 ack（`delivered:true`） |

---

# 附录 E：M1.5 面板（已实现）

用户要的"左侧插件面板"落在扩展侧，宿主与页面半不需要改动（`/targets` 已经够用）。

## 实现

| 部件 | 位置 | 说明 |
|---|---|---|
| Activity Bar 容器 + 视图 | `package.json` `viewsContainers.activitybar` / `views`（id `addToTerminal.targets`，名「DSH 页面」），图标 `media/bridge.svg` | `activationEvents` 加 `onView:addToTerminal.targets` |
| 树与状态栏 | `src/panel.ts` | `DshPanel implements TreeDataProvider`；行=一个 DSH 页面（标签/可写性/图标/工具提示）；可见时每 3s 轮询 `/targets`；标题栏刷新按钮 |
| 点击语义（方案 A） | `addToTerminal.connectTarget(tabId)` | 设为目标 → 立刻把当前选区投给这个 tabId → 成功后 `openExternal(#dsh-focus)` 把浏览器带到前台 |
| Quick Pick | `addToTerminal.selectTarget` | 列全部页面，选中后同样设目标+投递 |
| 状态栏 | `$(plug) DSH: Chrome 154 #1fbf` / `$(debug-disconnect) DSH 未连接` | 点击 = Quick Pick |
| 目标指定 | `DshSink.send(render, { tabId })` | 显式 tabId 优先；不在列表里 → `目标 DSH 页面已断开` |

面板为空是**正确**状态：只有"页面开着且当前有输入框"的标签页才会连接上来（草稿在页面侧）。

## 验证

`verify-extension-flow.cjs` 扩到 **34/34**（新增 G1–G12）：tree view 创建、一行一页面、可写/无输入框的图标与描述、点击行→记住目标+投递到该 tabId+输入文本正确、状态栏命名目标、Quick Pick 列表与选择、空态提示、状态栏"未连接"、变为可见时刷新。

## 产物

`add-to-terminal-0.3.0.vsix`，已 `code --install-extension` 覆盖安装（本机现为 `eelynn.add-to-terminal@0.3.0`）。**需要重载 VS Code 窗口**才会出现新面板。

## 0.4.0：用户实测反馈后的两个修正

用户实测反馈：①每按一次 `Ctrl+Alt+T` 就多开一个 DSH 标签页；②看不到"链接了哪个标签页"的面板/按钮。

| 现象 | 根因 | 修正 |
|---|---|---|
| 每次按键多开一个浏览器标签页 | `openExternal(url + '#dsh-focus=<nonce>')`：浏览器按**完整 URL（含 # 片段）**判断"该地址是否已打开"，每次 nonce 不同 → 每次都算新地址 → 新标签页。原假设"同文档导航会复用标签页"是错的 | `dshFocus` **默认 false**；启用时只打开**不含锚点的裸地址** |
| 看不到面板 | 视图挂在自建的 Activity Bar 容器里，图标很容易被折进 `···` 溢出菜单；且当时用户还没重载窗口（0.2.0 根本没有面板） | 视图改挂 **`explorer` 容器**（左侧资源管理器里的「DSH 页面」区块）；行上加 **`当前目标`** 标记 + 插头图标 + 行内 🔌 连接按钮 |
| 投递后不知道内容进了哪个标签页 | 浏览器焦点无法从页面可靠获取 | 页面侧收到并写入成功后，把自己的标签标题前面加 `●` 闪 6 秒（`client.js` `flashTitle()`）；面板标签计算会剥掉这个标记 |

## 验证（0.4.0）

| 套件 | 结果 |
|---|---|
| `verify-extension-flow.cjs` | **37/37**（新增：默认不碰浏览器、开启时只用裸地址、`当前目标` 标记与插头图标、其他行不误标） |
| `verify-client-core.cjs` | **20/20**（新增：成功写入后标记标题、标记不泄漏进面板标签） |
| `verify-bridge-behaviors.cjs` | 10/10 |
| 合计 | **67 项自动检查** |

## 0.5.0：用户反馈后的三个修正

用户实测反馈：①要能**断开**这条链接；②有人**只用「添加到终端」**，根本没有 DSH Web 页面 —— 不能把"没开 DSH"当成异常；③面板/状态栏不用显示 `Chrome 154` 这种浏览器信息，**工作区名称 · 标题**就够了。

| 现象 | 根因 | 修正 |
|---|---|---|
| 没有断开入口 | 目标一旦记下就只能换、不能断；断开后也没有"只发终端"的状态 | 新增 `addToTerminal.disconnectTarget`，三个入口（状态栏 Quick Pick 首项、视图标题栏 ⏏、当前目标行的行内按钮、命令面板）。断开 = 忘记目标 + `workspaceState` 置 `addToTerminal.dshDisconnected`，此后**不再探测桥接**，引用直发终端；点任意一页即重连 |
| 只用终端的人每次都收到"DSH 投递失败"警告 | "投递失败"与"DSH 根本不在场"混为一谈 | `SinkResult` 增加 `unavailable`：**没装桥接 / DSH 关着 / 没有已连接页面 / 页面中途关闭**这四种都算"不在场"，按 `fallbackToTerminal` **静默**发终端（只出一条状态栏消息）。面板空态也从「没有可投递的 DSH 页面」改成「只发到终端」，状态栏改成 `$(terminal) 只发到终端` |
| 标签 `Chrome 154 · DeepSeek Harness · #1fbf` | 页面半用 `navigator.userAgent` 取浏览器名 + 大版本，再拼页面标题与 tabId | 页面半改从 `useSessions` 读会话摘要：标签 = **`工作区 · 标题`**（`cwd` 末段 + 会话标题，空标题时退到页面标题，再退到 `DSH 页面`）。浏览器与 tabId 都不再出现在标签里 |

### 验证（0.5.0）

| 套件 | 结果 |
|---|---|
| `verify-extension-flow.cjs` | **49/49**（新增 A：死端口为静默回退、D：`no-page` 静默回退、G7a：状态栏无浏览器名、G8：Quick Pick 首项是断开、G10b/G11：空态与状态栏「只发到终端」、H1–H9：断开→只发终端→不探测桥接→重连） |
| `verify-client-core.cjs` | **24/24**（新增：标签为 `工作区 · 标题`、不含浏览器名、不含 tabId、空会话退到工作区名、无会话退到页面标题） |
| `verify-bridge-behaviors.cjs` | 10/10 |
| 合计 | **83 项自动检查** |

> 页面半（`client.js`）的改动要**重启 DSH**（或至少让 Web 端重新加载插件 bundle）才会生效；扩展半的改动要重新 `npm run compile` 并打包安装。

---

# 附录 F：DSH Web 不可用事故 + TypeScript 重写（2026-10-01）

## 事故

重启 DSH 后 **DSH Web 不可用**：在输入框里输入时报 client 侧错误；用户随后**手动卸载**了桥接插件。卸载后 profile 干净（依赖与 bundles 条目均移除、发现文件由宿主半正确删除）。

## 根因（判断）

页面半在**页面启动时立即**开 SSE，而那一刻宿主半的路由可能尚未注册。请求于是落到 SPA 兜底处理器、返回 `index.html`（`text/html`）；`EventSource` 因 MIME 不符报错，并按浏览器默认策略**每 3 秒自动重连一次、永远失败**。这些重连持续占用同源 HTTP/1.1 连接（每源上限 6 条），挤掉 App 提交消息所需的连接 → 页面报 client 侧错误。

为什么 0.5.0 的实测阶段是好的：那时它是被 HMR 注入到**已经在运行**的页面里，路由早已注册。这解释了"只有重启后才坏"。

**诚实说明**：错误原文没有留存，无法 100% 确证。但下面 4 条修复与根因无关地消除了这一类故障。

## 修复（4 条）

| # | 修复 | 作用 |
|---|---|---|
| 1 | 新增 `GET /ping` → `{bridge:'dsh-add-to-terminal'}` | 页面有办法先问"这个地址后面真的有桥接吗" |
| 2 | 页面半**只有 ping 成功才开 SSE**；重连一律"探测 + 指数退避"（3s→60s）；`onerror` 主动 `close()`，不使用浏览器热重连 | 后端没有桥接时**一个 SSE 都不会开**，不可能出现 MIME 错误循环，也不会占用连接配额 |
| 3 | 注册加全局去重 + try/catch；`apply()` 永不抛异常；`useInput` 选择器空值安全；所有 effect try/catch | 页面半自身的任何错误都不会冒泡进页面或启动审计 |
| 4 | 宿主半 `inject` 只保留 `webServer`；`sessionQuery` 改为**按请求** `ctx.get` | 减少启动期依赖；会话服务晚到也能补上（此前是 apply 时快照，晚到则 `/context` 永远返回 `null` —— 这是本轮 suite 抓出的真 bug） |

## TypeScript 重写

```
src/host.ts       → lib/host.js     ESM，package exports "."
src/client.ts     → lib/client.js   classic script，exports "./client"
src/ambient.d.ts  → 两半共用类型（页面半不能 import 类型，否则编译产物带模块壳）
tsconfig.json     → 输出 lib/，types 指向扩展目录的 @types/node
```

构建（复用扩展的 tsc，不需要联网装依赖）：

```powershell
& E:\code3\add-to-terminal\node_modules\.bin\tsc.cmd -p E:\code3\dsh-info\dsh-add-to-terminal
```

标签逻辑按你 harness/README 的规格重写：`工作区 · 标题`（`cwd` 末段 + 会话标题；标题等于工作区名时不重复；无会话退页面标题；再无则 `DSH 页面`；剥掉 `●` 标记），不含浏览器名与 tabId。

## 验证（全部离线，不需要装进任何 profile）

| 套件 | 本轮 | 上一轮 | 说明 |
|---|---|---|---|
| `verify-extension-flow.cjs` | **49/49** | 49/49 | 你更新的扩展 harness 原样通过；我**没有改扩展代码** |
| `verify-client-core.cjs` | **28/28** | 24/24 | 你的 24 项 + 新增 4 条连接安全（错误即关流、不立即重连、ping 无桥接时不开流、桥接恢复后下次探测连上） |
| `verify-host-standalone.cjs` | **23/23** | 新增 | 一次性 `node:http` 服务器跑**真实编译产物** `lib/host.js`：/ping、token 门、Origin 拒绝、SSE 握手、present、targets、context（含会话服务缺失退化）、push+ack、not-writable、not-connected、重连退役旧连接、no-ack 超时、发现文件、dispose 清理路由与文件 |
| `verify-bridge-behaviors.cjs` | SKIP | 10/10 | 需要活着的桥接；未安装时优雅跳过并指向 standalone 套件 |

## 尚未做 / 待你确认

1. **没有重新装进 profile** —— 你手动卸载了，不会再未经同意安装。装/卸都是 profile `package.json` 一步（`dependencies` + `dsh.profile.bundles`），我可以只在你说可以时做一次受控验证。
2. 真实页面的启动时序（ping→stream 握手）需要装进去才能实测。
3. TS 迁移时我删掉了根目录的 `index.js` / `client.js`。按 0.5.0 文档，页面半那 22 小时里只改了标签逻辑（已按规格重写）；**若你还改过别的，请告诉我，我补回 TS 版本。**

---

# 附录 G：两次"DSH Web 不可用"的根因与可用装法（2026-10-01 实测）

## 事故一：手写 `package.json` 启用 → 启动被拒

用 `dependencies` + `dsh.profile.bundles` 手工启用后重启：页面 shell 能出来、`/api` 能答 401，但模型选择/会话列表永远加载，插件行**根本没激活**（Config 0 条目、无发现文件、`/ping` 404）。

根因：`dsh plugin --profile web …` 只是 **pnpm 的转发**。手写的 `"dsh-add-to-terminal": "link:…"` 在 `pnpm-lock.yaml` 里**没有 importer 条目**（当初 pnpm 写盘被网络超时打断），启动时该行解析失败；而 `reconcileProfilePatches` 对**"显式启用目标"的失败会拒绝整个启动**（`dsh-app-boot`：*explicit enablement targets whose existing failures also reject reconciliation*）→ 应用永远到不了就绪。

## 可用装法：profile patch 里的**文件路径行**（零 pnpm）

```yaml
- insert:
    - id: dsh-add-to-terminal
      name: 'E:/code3/dsh-info/dsh-add-to-terminal/lib/host.js'
      inject: ['webServer']
```

- **不写 `package.json`、不动 `pnpm-lock.yaml`、不跑 pnpm**；
- `patchReload: live` → 改这一行 **4 秒生效，不用重启**（实测）；
- 该行不是"显式启用目标"，**失败只是一条 warning**（实测输出：`dsh: warning: 1 entry did not activate` + `failed to import`，而 `dsh web:` 正常打印、应用可用）；
- 页面半照样工作：`dsh-client-modules` 的 `locatePkgJson` 对**路径行**会走 `nearestPackage(moduleUrl)`，向上找到我们的 `package.json` → 读到 `dsh.client` → 提供 `./lib/client.js`（源码确认 + 实测）。

### 两个踩过的坑

1. **绝对路径行不能带 `?v=1`**：会被编码成 `%3F`，loader 去找名为 `host.js?v=1` 的文件 → `failed to import`（相对路径行 `./tools/project-qa.mjs?v=14` 是另一套解析，不能照抄）。
2. **改 patch 文件其实每次都在重组**：早先"改了没反应"是因为那一行一直在导入失败被丢掉，不是没触发。

## 实测证据（可用状态）

```
/targets → tab=#4eb1  client=ts-0.2.1  stage=seated  writable=True
           sessionId=session-74a8e310-…
           label='dsh-info · 选中代码发送到dsh web输入框设计'   note=''
POST /push → {"ok":true,"delivered":true,…}   9 ms
```

`stage` 是这次诊断的关键字段（`loaded → applied → slot-registered → seated`）。**早先"座位没挂上（writable=false）"的全部观察都是对着旧 client 产物做的假象**：DSH 重启后页面还跑着内存里的旧构建，HMR 没把它换掉（改版本号实测也没换），必须刷新页面/重启才拿到当前产物。

## 待办 / 限制

- 页面半的改动**可能**需要刷新页面或重启才能生效（HMR 换不掉旧产物，实测）；
- 扩展侧 0.5.0 的"断开"是持久状态：桥接恢复后要在面板里点一次页面或用状态栏重连；
- 回滚 = 删掉 patch 里那 4 行（live 生效，不用重启）。

