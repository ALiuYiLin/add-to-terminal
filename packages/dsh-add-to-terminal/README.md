# dsh-add-to-terminal

DSH 侧桥接插件：把 VS Code 的 [Add to Terminal](https://github.com/ALiuYiLin/add-to-terminal) 扩展发来的代码引用，写进 **DSH Web 页面当前的输入框草稿**（不提交，你补一句话再回车）。

```
VS Code 选中代码 ─Ctrl+Alt+T─▶ 本插件（DSH 宿主） ─SSE─▶ DSH Web 页面 ─▶ 输入框草稿
```

## 安装（用户）

需要**两半**都装上：

**① VS Code 扩展**：在 VS Code 市场搜索 **Add to Terminal**（需 0.5.0 或更高），或安装 VSIX。

**② 本插件（DSH 侧）**：在 DSH Web 的 **设置 → 插件** 里找到 `dsh-add-to-terminal` 并启用；或者用命令行（这一步是 profile 的依赖安装，本质是 pnpm）：

```bash
dsh plugin --profile web add dsh-add-to-terminal
```

插件启用后会把 Web 地址与本次进程令牌写到 `<系统临时目录>/dsh-add-to-terminal/bridge.json`，VS Code 扩展读取它即可零配置工作（端口随机也没关系）。插件被禁用/卸载时该文件会被删除。

装好后：VS Code 的**资源管理器侧边栏**会出现 **「DSH 页面」** 区块，列出当前打开着 DSH Web 的标签页。点一行即连接（设为目标 + 立刻投递当前选区 + 把浏览器带到该页），之后 `Ctrl+Alt+T` 一直投给它。状态栏显示当前目标；页面收到内容时它的标签标题会闪 `●`。

> 没开 DSH Web 时不会报错：扩展会安静地走"只发到终端"（这是设计，不是故障）。

## 为什么需要 DSH 侧插件

输入框草稿在**浏览器页面**里（页面本地存储），宿主进程写不了 —— 所以必须有一个页面侧插件，而"页面怎么知道该写什么"需要一个会合点。本插件就是会合点 + 页面侧写入者。

## 组成

TypeScript 源码在 `src/`，编译产物在 `lib/`：

| 文件 | 说明 |
|---|---|
| `src/host.ts` | 宿主半：在 Web 服务器上挂 `/dsh-add-to-terminal/*` 路由 |
| `src/client.ts` | 页面半：每个打开的 DSH Web 标签页连一条 SSE，收到引用后用 `conversation.input.left` 槽位的 `inputActions` 写入草稿 |
| `src/ambient.d.ts` | 两半共用类型（页面半必须是 classic script，不能 import 类型） |
| `test/host.cjs` | 宿主半套件：一次性 `node:http` 服务器跑真实编译产物（不用装进任何 profile） |
| `test/client.cjs` | 页面半套件：stub DOM 里跑真实 `lib/client.js` |

## 接口

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| GET | `/dsh-add-to-terminal/ping` | 页面 | "这个地址后面真的有桥接吗"——页面开流前先问，避免对着 SPA 兜底页疯狂重连 |
| GET | `/dsh-add-to-terminal/targets` | VS Code（需 token） | 列出已连接的 DSH 页面（含 `client`/`stage`/`note` 诊断字段） |
| GET | `/dsh-add-to-terminal/context?tabId=` | VS Code（需 token） | 该页面对应会话的 `cwd`（用于路径判定；会话服务缺失时返回 `null`） |
| POST | `/dsh-add-to-terminal/push` | VS Code（需 token） | `{ tabId, text, nonce }` → 投递到指定标签页 |
| GET | `/dsh-add-to-terminal/stream?tabId=` | 页面 | 标签页的 SSE 连接 |
| POST | `/dsh-add-to-terminal/present` | 页面 | 上报标签、可写性、会话 id、阶段、聚焦状态 |
| POST | `/dsh-add-to-terminal/ack` | 页面 | 写入成功/失败确认 |

### 发现文件

```json
{ "url": "http://127.0.0.1:3080", "port": 3080, "token": "…", "route": "/dsh-add-to-terminal" }
```

写在 `<os.tmpdir()>/dsh-add-to-terminal/bridge.json`；页面连上来时、以及每 30 秒自我修复（缺了就重写）；dispose 时只删属于自己的那份（热重载下不会误删新实例的文件）。

## 面板上的标签

`present` 上报的 `label` 是 **`工作区 · 标题`**（会话 `cwd` 末段 + 会话标题），例如 `dsh-info · 选中代码发送到dsh web输入框设计`。不含浏览器名/版本，也不含 tabId：

- 「哪个浏览器打开的这个页面」跟会话内容无关，占地方还容易跟另一个标签页混淆；
- 真正的区分信息是"哪个工作区、哪个会话"；
- 还没有会话（Hero / 空页面）时退到页面标题；连页面标题都没有时用 `DSH 页面`；
- 扩展侧用短 tabId（`#4eb1`）在面板里区分同一会话的多个标签页。

## 信任模型

- 扩展侧接口：要求 `x-dsh-bridge-token`，并且**拒绝任何带 `Origin` 的请求**（浏览器无法在无预检的情况下伪造）；
- 页面侧接口：只接受同源请求；
- 只写草稿，不提交；本插件没有任何"代替用户发送"的能力。

## 页面安全约束（踩过坑后写死的规则）

这个插件跑在 DSH 页面里，**绝不允许**因为自己出错而影响页面：

1. `window.__ModuleLoader__` 的注册带 try/catch：重复或过期的 bundle 重放不会把异常抛进启动审计；
2. `apply()` 永不抛异常；
3. **只有 `/ping` 明确答出桥接标记后才开 SSE**。否则后端没有桥接时请求会落到 SPA 兜底处理器、拿到 `text/html`，`EventSource` 因 MIME 错误每 3 秒重连一次，抢掉同源 HTTP/1.1 的连接配额 —— 这会让整个 Web 界面卡在加载；
4. 所有重连都走"探测 + 指数退避"（3s 起，上限 60s），不使用浏览器自带的热重连；
5. 未绑定输入框时收到的内容进有界队列（最多 5 条），挂载后冲刷；写入失败会 ack `insert-failed`，不静默丢弃。

## 开发

```bash
npm install
npm run build     # src/ -> lib/
npm run check     # 宿主半 23 项 + 页面半 28 项，全部离线
```

本地调试（不经过 pnpm、改一行 4 秒生效、失败只 warning）：在 profile 的 `cordis.patch.yml` 里加一行**文件路径行**

```yaml
- insert:
    - id: dsh-add-to-terminal
      name: '/abs/path/to/dsh-add-to-terminal/lib/host.js'
      inject: ['webServer']
```

> 绝对路径行**不要**带 `?v=1`：`?` 会被编码成 `%3F` 当成文件名 → `failed to import`。
>
> 反过来，**不要**用手写 `package.json` 依赖（`link:`）的方式启用：`dsh plugin` 是 pnpm 的转发，手写依赖容易与 `pnpm-lock.yaml` 不一致，而 DSH 启动时对"显式启用目标"的失败会拒绝整个启动 —— 表现就是页面 shell 出来了但模型选择/会话列表永远加载。

## 发布

```bash
npm publish --access public     # prepublishOnly 会自动跑 build
```

同时记得发布 VS Code 扩展侧（`vsce publish`）。

## 已知限制

- 页面半是从包里提供的，**改了它需要重启 DSH 或刷新页面**才会生效（实测 HMR 换不掉旧产物）；
- 桥接恢复后，扩展侧若停在"断开"状态，需要在面板里点一次页面或用状态栏重连；
- 排障先看 `/targets` 的 `client` 与 `stage`：`client` 是页面正在跑的构建，`stage` 是 `loaded → applied → slot-registered → seated` 走到哪一步。

## License

MIT
