# DSH Companion 实现规格：`@seaveyon/dsh-pet` + `@seaveyon/dsh-pet-desktop`

状态：待实现  
受众：接手实现的 agent / maintainer（本文自足，不依赖任何聊天上下文）  
语言：TypeScript（插件，Node.js ≥ 20.19）+ Zig 0.16（桌面 App，zero-native SDK 锁定 commit 5665a35）  
交付物：把现有桌面宠物改造成常驻菜单栏（macOS）/ 系统托盘（Windows）的 agent 伴侣——看会话状态、在托盘里直接批准或拒绝工具审批、回答提问、收系统通知；宠物窗口降为可开关的皮肤。  
核实日期：2026-09-17，对象为已安装的 DSH 0.1.5-rc.1 宿主与本仓库 `main`。

## 1. 产品定义

- **伴侣（Companion）**：`dsh-pet-desktop` 进程本体。一个状态项、一份下拉菜单、系统通知、一个可隐藏的宠物窗口。
- **状态项（status item）**：菜单栏 / 托盘里的按钮，图标加一段 ≤ 64 字节的标题，由模型状态实时推导。
- **事件流（feed）**：`dsh-pet` 服务端插件通过自有路由推给伴侣的 SSE 流，加一个全量快照接口。伴侣是它的唯一消费者。
- **决定（decision）**：伴侣对一条待审批或待提问的回答，经插件回填给宿主的 waterfall。
- **宠物皮肤**：现有 192×192 透明置顶窗口及其精灵图动画。它不再是产品主体，心情由事件流下发。
- **浏览器侧**：`dsh-pet` 的 client bundle 只保留设置面板（启动伴侣、配对、开关宠物、皮肤预览）。

## 2. v1 目标与边界

### 必须实现

1. 状态项按聚合态变化（待处理数 / 失败 / 运行数 / 空闲 / 离线），菜单列出会话、待审批、待提问，点击会话打开 DSH 深链。
2. 托盘内对审批作答：`allowed-once` / `rejected`；对提问作答：选项或自由文本。
3. 四类系统通知：回合结束、回合错误、需要审批、需要回答。macOS 带动作按钮，Windows 只做点击激活。
4. 插件侧事件流与快照、Bearer 令牌鉴权、启动时经环境变量交付令牌、手工启动时的配对码。
5. 心情机移到服务端共享模块，宠物随事件流变化；宠物窗口 `close_policy = "hide"`，菜单可开关并记忆。
6. 现有入站桥 `POST /state` 在迁移完成后移除；`GET /pets`、`GET /sprites/*` 保留给设置面板预览。
7. 跨语言契约测试：TS 编码器产出的事件即 Zig 解析器的 fixtures；`scripts/check-host-contract.mjs` 覆盖新依赖的宿主事件。

### 明确不做

- 远程 DSH（非 loopback 端点）。v1 所有伴侣路由对非 loopback 对端一律 403；远程与 web-login 的设备令牌一起做。
- Linux。SDK 的托盘在 Linux 返回 `UnsupportedService`（平台矩阵脚注 6）。
- "总是允许" / 持久授权。宿主 outcome 闭集没有它，伴侣也不伪造。
- 从通知按钮直接批准。通知动作只做"在 DSH 中查看"；批准必须进菜单点分段行。
- 展示工具参数、文件内容、模型输出。事件流只含标题、工具名、reason（截断脱敏）。
- 替宿主"超时拒绝"。宿主没有审批超时；伴侣离线时中继必须 `next()` 放行，不得代答。
- 改包名。`@seaveyon/dsh-pet` / `@seaveyon/dsh-pet-desktop` 与三个平台包名字不变；App 显示名改为 "DSH Companion"。

## 3. 已核实的事实（实现前不必重新调查）

### 3.1 宿主信号面（DSH 0.1.5-rc.1，服务端 Cordis 事件）

| 事件 / 服务 | 负载 | 出处 |
| --- | --- | --- |
| `agent/status` | `{ agent, status }`；`status === 'running'` 即运行位 | `dsh-api-session-controller/lib/index.js` 2755–2757 据此 emit `api-session/status(sessionId, running)` |
| `agent/error` | `{ agent, turn, error }` | 同上 2758–2760 → `api-session/error(sessionId, errorChain)` |
| `session/created` / `session/disposed` | `session`；`ApiSessionList.summaryFor(session)` 给 `title / cwd / updatedAt / running` | 同上 2749–2754、1812–1820 |
| `session/event` | `turn/end`、工具调用、`approval/asked`、`approval/decided`、`user/message` … | `dsh-session/lib/types/known-event-types.js` |
| `approval/request`（waterfall） | `{ agent, toolName, callId?, reason?, signal? }`；返回 `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` 或 `next()` | `dsh-user-approval/lib/index.js` 30–35（OUTCOMES）、131–147（request：先 append `approval/asked`，decide 后 append `approval/decided`）、175–195（decide：policy `never` 直接 rejected；waterfall 无终端 answerer → unavailable；signal 中止 → cancelled） |
| `user-questions/request`（waterfall） | `ctx.userQuestions` 发起，agent 作用域 | `dsh-user-questions/lib/index.js` 69 |
| `ctx.agents.get(sessionId)?.status`、`ctx.sessions` | 快照基线 | testkit 已 mock `sessions.list` |

约束：`approval.request()` 只能在 open turn 内调用；宿主**没有**审批超时或自动拒绝；浏览器 UI（`dsh-client-ui-approval/lib/client.js` 166）只回 `allowed-once` / `rejected`；服务端作答的现成范例是 `dsh-acp/lib/index.js` 1115–1137（`ctx.on("approval/request", (request, next) => …)`，非己方 agent 则 `next()`）。策略 `ask` / `never` 由 `dsh-permission-presets` 切换。宿主没有任何 OS 通知 / badge / toast 服务。

浏览器身份：`connection.authenticatedUrl(baseUrl)` 只在 `GET /` 用 `?token=` 换 HttpOnly + SameSite=Strict cookie，不接受 `Authorization` 头，`/api/remote.mux` 的 WebSocket 也要同一 cookie。这是不让伴侣直连宿主 Web API 的原因之一。

### 3.2 zero-native SDK 能力（`packages/pet-desktop/zig-pkg/native_sdk-0.1.0-hzDz…/`）

| 能力 | API | 位置与上限 |
| --- | --- | --- |
| 状态项 | `UiApp.Options.status_item: ?StatusItemOptions`、`status_item_fn: fn(model, *StatusItemScratch) StatusItemState`；菜单选择经 `on_command: fn(name) ?Msg` | `src/runtime/ui_app.zig` 245–262、268–282、789–808；`max_status_items 8`、`max_tray_items 32`、`max_tray_title_bytes 64`、`max_tray_tooltip_bytes 256`、`max_tray_segment_options 8`、`max_tray_chart_values 32`（`src/platform/types.zig` 264–274） |
| 菜单行类型 | `TrayMenuItem{ id, label, command, separator, enabled, detail, role, segmented: ?TraySegmentedRow, metric: ?TrayMetricRow, chart: ?TrayChartRow }`；`TrayPresentation{ title, tone: normal\|warning\|critical, icon_opacity, font_weight … }` | `src/platform/types.zig` 1470–1610 |
| 系统通知 | `fx.showNotification(NotificationOptions{ id, title, subtitle, body, action_label, action_command })`；同 id 替换；动作进 `on_command` | `src/runtime/effects.zig` 8593；`max_notification_title_bytes 128`、`body 1024`、`id 128`、`action_command 128`（types.zig 243–248）；需 `permissions` 含 `notifications` |
| HTTP 客户端 | `fx.fetch(FetchOptions{ key, method, url, headers, body, timeout_ms, response: .buffered \| .stream, on_line, max_line_bytes, on_response })` | `src/runtime/effects.zig` 3004–3037、6936；`.stream` 按行送 Msg，`timeout_ms` 覆盖整个连接生命周期；每行默认 ≤ `max_effect_line_bytes 4096`；与 spawn 共用 `max_effects 16` 槽；需 `network` 权限 |
| 凭据 | `fx.credentialsSet / credentialsGet / credentialsDelete` | `src/runtime/effects.zig` 8876–8916；需 `credentials` 权限 |
| 菜单栏应用生命周期 | 窗口 `close_policy = "hide"`；`fx.hideWindow / showWindow / quitApp`；`LaunchAtLoginStatus` | `src/platform/types.zig` 634；effects.zig 10353–10397；平台矩阵 `docs/src/app/docs/platform-support/page.mdx` 60–95 |
| 平台支持 | 托盘 macOS full / Windows full / Linux none；通知 macOS full（动作按钮）/ Windows caveats（单条气球、无自定义按钮、点击即激活）/ Linux full | 同上及脚注 6、11 |
| 用法范例 | `examples/canvas-preview/src/main.zig` 159–184（静态 `status_item`）；`examples/system-monitor`（定时器 + 纯解析器 + 模型派生 UI 的组织方式） | — |

### 3.3 本仓库现状

- `packages/pet/src/index.ts`：`apply` 用 `@seaveyon/dsh-di` 的 `InstantiationService` 组合 `services.ts` 里的 `IWebServer`、`IDesktopLauncher`、`ILaunchRoute`。`host-types.ts` 的 `HostContext` 只有 `get` 与 `effect`，**没有** `on` / `waterfall`——需要扩展。
- `packages/pet/src/launch.ts`：`LAUNCH_ROUTE_PATH = '/dsh-pet/launch-desktop'`，`LAUNCH_HEADER = 'x-dsh-pet-launch'`，`LOOPBACK_ADDRESSES`，`launchDesktopApp(deps, request)` 已能把环境变量（`DSH_PET_DESKTOP_ORIGINS`）经 spawn env 或 `open --env` 交给 App。伴侣令牌走同一条路。
- `packages/pet/src/client/mood.ts`：纯心情机 `PetStateMachine` / `deriveMood`（优先级：`pending.length > 0` → waiting；`running && runningCalls.length` → working；`running` → thinking；错误 → sad；否则 idle；`CELEBRATE_MS 2400`、`PET_MS 1600`、`SLEEP_AFTER_MS 5 min`）。`mood-source.ts` 在 0.1.5+ 只能读到 `running` 与两个错误槽，`pending` / `runningCalls` 合成为空——所以现在的宠物几乎进不了 waiting / working。
- `packages/pet/src/client/bridge.ts`：浏览器 → App 的 `POST /state`、`GET /pets`、`/events` 活性流。`DESKTOP_COMPANION_PORT` 取自 `desktop.ts` 的 `DESKTOP_BRIDGE_PORT = 45731`，`test/desktop-contract.test.ts` 与 `server.zig` 钉死一致。
- `packages/pet-desktop/src/`：`main.zig`（`runner.runWithOptions`，权限 `view`、`command`）、`model.zig`（`Model`、`Msg`、`boot`、`update`；`start_state_server` 是可替换的测试缝）、`server.zig`（入站 HTTP 桥 + `origin.zig` 的 CORS 策略）、`state.zig`（`Mood` 枚举 8 值、通道行编码）、`view.zig`（宠物画布 + 右键"退出"菜单）、`manifest.zig`（≤ 8 只宠物、16 个图像槽）、`persist.zig`（状态行落盘）、`appkit.zig / win32.zig / windowing.zig`（拖拽、置顶、透明三件套）。`docs/zero-native-notes.md` 列了 12 条已踩过的坑，改窗口相关代码前必读。
- `app.zon`：`permissions = { "view", "command" }`，主窗口 `label = "main"`，未设 `close_policy`。
- 打包：`packages/pet/package.json` 的 `build:desktop` 把 `zig build -Doptimize=ReleaseSmall` 的**裸二进制**装进 `../pet-desktop-{darwin-arm64,darwin-x64,win32-x64}/bin/`；没有 `.app` bundle。现有 macOS arm64 ReleaseFast 产物 6.9 MB。
- 测试：`packages/plugin-testkit` 的 `createMockContext` 支持 `on / emit / waterfall`（`src/context.ts` 40–122），可直接触发 `approval/request`。CI 的 `desktop-zig` job 跑 `zig build test`；`scripts/smoke-tarball.mjs` 装 tarball 做冒烟。

### 3.4 竞品（2026-09-17）

`dsh-menubar-macos`（AppKit，只管 dsh web 启停）、`dsh-island`（Swift，macOS 13+，只读，README 明确排除 Windows/Linux、交互审批、宠物皮肤）、`dsh-notify`（osascript / notify-send，无 Windows，只提醒）、`dsh-notification`（桌面 + 浏览器 + Webhook，`approval/request` 只旁听）、`deepseek-harness-desktop`（Electron 壳 + 托盘）。没有一个同时具备"托盘内可操作审批"、"Windows 原生"、"宠物皮肤"。

## 4. 不变量

1. **伴侣离线时宿主行为与今天完全一致。** 中继监听器在没有已连接伴侣、或伴侣未在 `decisionTimeoutMs` 内应答时，必须 `next()`；永远不产出 `unavailable`、不吞掉浏览器的路径。
2. **只产出宿主认识的 outcome。** 审批：`allowed-once` / `rejected`；`signal` 中止 → 本侧标记 cancelled 并广播 `resolved`，晚到的决定丢弃。没有"总是允许"。
3. **一个 approvalId / questionId 只接受一次决定。** 第二次 → 409；未知 → 404；已撤回 → 410。
4. **事件流不含秘密与参数。** 工具参数、文件内容、模型输出、令牌、cookie 永不进入事件流、通知或日志；标题与 reason 服务端截断到 160 字节并脱敏（脱敏规则参照 `packages/world-line/src/domain/redaction.ts`，复制到 `packages/pet/src/companion/redact.ts`，不引入 world-line 依赖）。
5. **伴侣路由自带鉴权，且默认只对 loopback。** `Authorization: Bearer <token>` 缺失或错误 → 401；非 loopback 对端 → 403（v1 无开关）；令牌与 web-login 会话正交。
6. **令牌不落明文。** 服务端只存 sha256；App 端存 Keychain / Credential Manager（`fx.credentialsSet`），日志只打印指纹前 8 位。
7. **App 不猜宿主。** 事件解析忽略未知字段，单行超过 4 KiB 丢弃并计数；`revision` 断档就重拉快照；解析失败不崩溃。
8. **宠物窗口代码不动语义。** 拖拽、透明、置顶、精灵图路径与 `docs/zero-native-notes.md` 的 12 条结论保持不变；本次只加 `close_policy` 与心情来源。
9. **两种语言一份契约。** TS 编码器的输出快照就是 Zig 解析器的 fixtures；任何一侧改字段，另一侧测试必须红。

## 5. 架构与模块

```text
DSH 宿主（Cordis 事件）
  agent/status · agent/error · session/* · approval/request · user-questions/request
        │ 订阅 / waterfall 作答
        ▼
@seaveyon/dsh-pet 服务端  packages/pet/src/companion/
  feed.ts        CompanionFeed     快照 + SSE hub + revision            @inject(IPluginContext, IWebServer)
  relay.ts       InteractionRelay  审批 / 提问的竞速中继、单次消费          @inject(IPluginContext, ICompanionFeed)
  auth.ts        CompanionAuth     令牌签发 / 校验 / 配对码 / 吊销 / 持久化  @inject(IPluginContext)
  routes.ts      CompanionRoutes   6 条路由，挂在 webServer 上             @inject(IWebServer, ICompanionAuth, ICompanionFeed, IInteractionRelay)
  mood.ts        服务端心情机（用 shared/mood.ts）
packages/pet/src/shared/mood.ts   从 client/mood.ts 抽出的纯函数，两侧共用
        │ fx.fetch .stream（SSE）/ POST 决定           环境变量或配对码交付令牌
        ▼
dsh-pet-desktop（Zig）
  companion.zig  SSE 行 → 类型化事件（纯函数，fixtures 测试）
  feed.zig       连接 / 重连 / revision 断档 / 快照拉取
  tray.zig       Model → StatusItemState（纯函数）
  notify.zig     notice → NotificationOptions（去重 id，纯函数）
  pairing.zig    凭据读写、配对窗口
  model.zig      Model 增 companion 状态；Msg 增 feed_* / tray_command / notification_action / decision_*
  main.zig       Options 增 status_item / status_item_fn / on_command；权限增 network / notifications / credentials
  server.zig     过渡期保留 GET /pets、/sprites；POST /state 与 /events 在 P3 删除
```

### 5.1 TS 侧新增服务（DI）

沿用 `services.ts` 的写法：每个服务一个 `createDecorator` 标识符 + 一个 `@inject(...)` 类，`createServices` 里 `collection.set(...)`。`HostContext` 扩展：

```ts
export interface HostContext {
  get: <T = unknown>(name: string) => T | undefined
  effect: (setup: () => void | Disposer, label?: string) => void
  on: (event: string, listener: (...args: any[]) => unknown) => Disposer
  logger?: { info(msg: string): void; warn(msg: string): void }
}
```

`on` 的返回值必须包进 `ctx.effect`，插件卸载时自动解绑（`createMockContext` 已按此实现）。`scripts/check-host-contract.mjs` 增加对 `approval/request`、`user-questions/request`、`agent/status`、`agent/error`、`session/created`、`session/disposed` 的存在性检查（在宿主的 typert.host.js 事件表里查名字）。

### 5.2 Zig 侧组织

- 所有网络 I/O 只经 `fx.fetch`；不再自建出站 socket。入站 `server.zig` 线程照旧，直到 P3 删除 `POST /state` / `GET /events`。
- `companion.zig`、`tray.zig`、`notify.zig` 必须是纯函数模块，单测不依赖平台宿主（`zig build test` 已是 `-Dplatform=null` 形态的单元测试）。
- `on_command(name)` 把命令字符串解析成 `Msg`：`ap.allow.<id>`、`ap.reject.<id>`、`ap.open.<id>`、`q.open.<id>`、`s.open.<sessionId>`、`pet.toggle`、`pet.skin.<petId>`、`login.toggle`、`open.dsh`、`pair`、`quit`。id 用服务端生成的 8 字符 base32，命令总长 < 64 字节（`action_command` 上限 128）。

## 6. 伴侣协议

### 6.1 路由（前缀与现有 `/dsh-pet/launch-desktop` 一致）

| 方法 路径 | 用途 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /dsh-pet/companion/snapshot` | 全量快照（重连基线） | 200 JSON | 401 / 403 |
| `GET /dsh-pet/companion/events?since=<revision>` | SSE 事件流；`since` 缺失或落后于服务端保留窗口时先发一个 `resync` 事件 | 200 `text/event-stream` | 401 / 403 |
| `POST /dsh-pet/companion/approvals/{approvalId}` | `{"decision":"allowed-once"\|"rejected"}` | 200 `{"ok":true,"outcome":…}` | 400 / 404 / 409（已决）/ 410（已撤回） |
| `POST /dsh-pet/companion/questions/{questionId}` | `{"answer":{"optionId":…}}` 或 `{"answer":{"text":…}}`（text ≤ 2 KiB） | 200 | 同上 |
| `POST /dsh-pet/companion/pair` | `{"code":"482913"}` → `{"token":…,"url":…}`；**免 Bearer**，仅 loopback | 200 | 400 / 429（10 分钟内 5 次错误锁定）/ 410（码过期） |
| `POST /dsh-pet/companion/revoke` | 吊销当前 Bearer 对应的令牌 | 204 | 401 |

通用：非 loopback 对端一律 403（复用 `LOOPBACK_ADDRESSES`）；`Bearer` 常量时间比较（`crypto.timingSafeEqual` 对 sha256）；所有响应 `cache-control: no-store`；响应体 JSON 用 `redactData` 同等级脱敏。

### 6.2 令牌

- 服务端：`randomBytes(32).toString('hex')`；存 `{ sha256, label: 'launched' | 'paired', createdAt, lastSeenAt }` 到 `$DSH_HOME/dsh-pet/companion.json`（mode 0600，原子写：临时文件 + rename，参照 `packages/world-line/src/fs/atomic.ts`），最多 8 条，超出淘汰最旧；宿主重启后仍有效。
- 启动交付：`launchDesktopApp` 在 `bridgeOriginsEnv` 旁新增 `companionEnv(url, token)` → `DSH_PET_COMPANION_URL`、`DSH_PET_COMPANION_TOKEN`，走现有 spawn env / `open --env` 路径。每次启动签发新令牌（label `launched`），旧 `launched` 令牌保留到下次 `lastSeenAt` 超过 7 天。
- 配对：设置面板"伴侣"分区点"生成配对码" → 6 位数字，60 秒有效，一次性；App 菜单"配对…"打开一个模型声明的小窗口（`windows_fn`）输入后 `POST /pair`。
- App 端：启动时环境变量优先并写入凭据（service `dev.seaveyon.dsh-pet-desktop`，account `companion@<host>:<port>`）；否则读凭据；否则进入"未配对"态（状态项标题 `—`，菜单只有"配对…"、"打开 DSH"、"退出"）。401 两次 → 删除凭据回到未配对态。

### 6.3 快照（`GET /snapshot`）

```json
{
  "schemaVersion": 1,
  "revision": 128,
  "host": { "version": "0.1.5-rc.1", "url": "http://127.0.0.1:3080" },
  "sessions": [
    { "id": "s_…", "title": "dsh-ecology · feat/di", "cwd": "~/code/dsh-ecology",
      "running": true, "phase": "tool:bash", "error": null,
      "updatedAt": 1789000000000, "parentId": null }
  ],
  "approvals": [
    { "approvalId": "K7Q2M9ZP", "sessionId": "s_…", "toolName": "bash",
      "reason": "运行测试套件", "askedAt": 1789000000000 }
  ],
  "questions": [
    { "questionId": "…", "sessionId": "s_…", "prompt": "…",
      "options": [{ "id": "a", "label": "…" }], "freeText": true, "askedAt": … }
  ],
  "mood": { "mood": "waiting", "petId": "deepseek-chan", "name": "Mochi", "locale": "zh" }
}
```

`phase` 是受控枚举：`idle | thinking | tool:<toolName> | awaiting-approval | awaiting-answer | error`，由 `session/event` 折叠得出；`title` ≤ 160 字节；`cwd` 用 `~` 折叠家目录；会话最多 64 条（按 `updatedAt` 倒序），更多的不进快照。

### 6.4 SSE 事件

每条 `id:` 为 revision（单调递增），`data:` 单行 JSON ≤ 4 KiB（App 每行上限），每 15 秒一条 `: hb` 注释。

| `event:` | `data:` | 触发 |
| --- | --- | --- |
| `resync` | `{"revision":n}` | `since` 无法续上；App 收到后拉快照 |
| `session` | 与快照中 session 同形 | `session/created`、`agent/status`、`agent/error`、`session/event` 折叠后的变化 |
| `session-removed` | `{"id":…}` | `session/disposed` |
| `approval` | 与快照中 approval 同形 | 中继登记新请求 |
| `question` | 与快照中 question 同形 | 同上 |
| `resolved` | `{"kind":"approval"\|"question","id":…,"outcome":…,"by":"companion"\|"web"\|"policy"\|"cancelled"}` | 任一侧作答或撤回 |
| `notice` | `{"kind":"turn-end"\|"turn-error"\|"approval"\|"question","sessionId":…,"title":…,"body":…,"dedupeKey":…}` | 见第 9 节 |
| `mood` | 与快照中 mood 同形 | 服务端心情机输出变化 |

服务端保留最近 256 条事件供 `since` 续传；更早的只能 `resync`。

## 7. 审批与提问中继语义

```ts
ctx.on('approval/request', (request, next) => {
  if (!feed.hasSubscribers()) return next()                // 不变量 1
  const entry = relay.register('approval', request)        // 分配 id，广播 approval 事件 + notice
  const chain = Promise.resolve().then(() => next())       // 浏览器等其余 answerer 照常收到
  const settled = Promise.race([entry.decision, chain])    // 谁先答谁生效
  settled.then(
    (outcome) => relay.settle(entry.id, outcome, entry.decidedByCompanion ? 'companion' : 'web'),
    () => relay.settle(entry.id, 'unavailable', 'web'),
  )
  request.signal?.addEventListener('abort', () => relay.cancel(entry.id), { once: true })
  return settled
})
```

- `relay.settle` 之后广播 `resolved`；晚到的 `POST /approvals/{id}` → 409；撤回后 → 410。
- 伴侣决定只接受 `allowed-once` / `rejected`；写一条插件级审计到 `ctx.logger.info`（`dsh-pet: approval <id> <outcome> by companion <fingerprint8>`），宿主自身的 `approval/decided` 照常由 `dsh-user-approval` 追加。
- `decisionTimeoutMs`（默认 0 = 不超时）仅用于测试与"伴侣挂了但 SSE 未断"的兜底：超过后 `relay.detach(entry)`，此后只等 `chain`。
- **P2 首日必测**：伴侣先答后，浏览器的待审批对话框是否随 `approval/decided` 关闭。若不关闭，切换到保守模式 `relayMode: 'when-no-browser'`——只有 `connection` 没有活跃浏览器客户端时才 `register`，否则直接 `next()`；两种模式都实现，默认取实测结果。
- `user-questions/request` 走同一 `InteractionRelay`，outcome 形状以 `dsh-user-questions` 的类型为准（P2 后半实现时对照 `lib/types`）。
- 作用域：宿主用 `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', …)` 发起；`dsh-acp` 在插件级 `ctx.on` 能收到并按 agent 过滤，本插件同样在插件级监听。P2 首日用真实宿主确认能收到，收不到则记录并改为经 `agent/created` 逐 agent 挂监听。

## 8. 状态项与菜单

### 8.1 聚合态 → 按钮

| 优先级 | 条件 | 标题 | `tone` | `icon_opacity` |
| --- | --- | --- | --- | --- |
| 1 | 未配对 / 令牌失效 | `—` | normal | 0.4 |
| 2 | 事件流断开 > 10 秒 | `—` | normal | 0.4 |
| 3 | 待审批 + 待提问 > 0 | 该数字 | warning（≥ 3 时 critical） | 1.0 |
| 4 | 存在 `phase = error` 的会话 | `!` | critical | 1.0 |
| 5 | 运行中会话 > 0 | 运行数 | normal | 1.0 |
| 6 | 其余 | 空 | normal | 0.6 |

`tooltip`（≤ 256 字节）：`DSH Companion · 已连接 127.0.0.1:3080 · 2 项待处理 · 1 个运行中`。

### 8.2 菜单布局（≤ 32 项）

1. `metric` 行：主文本"2 项需要你处理 · 1 个会话运行中"，副文本"已连接 … · 3 秒前"。
2. 分隔。
3. 待审批：每条一行 `label = <toolName>`、`detail = <会话标题> · <reason>`，紧随一行 `segmented`：`允许一次`（`ap.allow.<id>`）/ `拒绝`（`ap.reject.<id>`）/ `在 DSH 中查看`（`ap.open.<id>`）。最多 4 条，超出显示"还有 N 条，在 DSH 中处理"。
4. 待提问：每条一行 `label = 问题前 40 字`，`detail = 会话标题`，命令 `q.open.<id>`（v1 提问在配对窗口同款小窗口里作答，见 P2）。最多 2 条。
5. 分隔。
6. 会话：按 待处理 > 失败 > 运行 > 空闲 排序，`label = 标题`，`detail = phase 文案 · 耗时/相对时间`，命令 `s.open.<id>`。最多 16 行，超出末行"更多…"（`open.dsh`）。
7. 分隔。
8. `显示桌面宠物` / `隐藏桌面宠物`（`pet.toggle`）；`宠物皮肤`（子菜单不可用时改为分段行，≤ 8 只，`pet.skin.<petId>`）；`登录时启动`（`login.toggle`，`detail` 显示当前状态）；`打开 DSH`（`open.dsh`）；`配对…`（仅未配对态显示）；`退出`。

裁剪由 `tray.zig` 的纯函数完成，输入 Model 输出 `StatusItemState`，单测覆盖每个聚合态与容量边界。文案跟随 `mood.locale`（zh / en），沿用 `view.zig` 的双语表方式。

### 8.3 命令处理

`on_command` 只做解析成 `Msg`；`update` 里：`ap.allow / ap.reject` → `fx.fetch` POST（`key` 为 id 哈希，`.buffered`，超时 5 秒），结果 `decision_done{ id, status }`；成功后本地先移除该项（乐观），失败（409/410/网络）恢复并在 metric 行副文本提示一次。`s.open / ap.open / q.open / open.dsh` → `openExternalUrl(<host.url>/?session=<id>)`。

## 9. 通知

| `kind` | 触发（服务端） | `dedupeKey`（App 用作通知 id） | 标题 / 正文 | macOS 动作 |
| --- | --- | --- | --- | --- |
| `turn-end` | `agent/status` running → false，且本回合 ≥ 5 秒 | `turn:<sessionId>` | 会话标题 / "回合完成 · 3 分 12 秒" | 在 DSH 中查看 |
| `turn-error` | `agent/error` | `error:<sessionId>` | 会话标题 / 错误链首句（≤ 200 字） | 在 DSH 中查看 |
| `approval` | 中继登记 | `approval:<sessionId>` | 会话标题 / "需要批准 bash · <reason>" | 在 DSH 中查看（**不是**批准） |
| `question` | 中继登记 | `question:<sessionId>` | 会话标题 / 问题前 200 字 | 在 DSH 中查看 |

- 同一 `dedupeKey` 重发即替换（SDK 同 id 语义），一个会话同类通知永远只有一条。
- `resolved` 到达时不撤回已发通知（SDK 无撤回 API），但菜单即时更新。
- Windows：`action_label` / `action_command` 留空，点击即激活 → `open.dsh`。
- App 侧 `notify.zig` 是纯函数：`notice → ?NotificationOptions`；用户在菜单关掉"通知"时返回 null（P3 设置项，持久化到 `persist.zig` 的状态文件旁）。
- 静音窗：同一会话 30 秒内 `turn-end` 不重复；`approval` / `question` 不静音。

## 10. 宠物皮肤

- `shared/mood.ts`：把 `client/mood.ts` 的 `PetStateMachine`、`deriveMood`、常量移到不依赖 DOM 的模块；`client/mood.ts` 变为 re-export。服务端 `companion/mood.ts` 用同一机器：输入由 `session/event` 折叠（`pending` = 该会话待审批 + 待提问数，`runningCalls` = 进行中的工具调用），针对"当前会话"——取 `updatedAt` 最新且非 blank 的会话；1 秒 tick 由 `setInterval` 驱动并在 `ctx.effect` 中清理。输出变化才广播 `mood`。
- App：`mood` 事件直接喂现有 `state_event` 路径（`state.zig` 的通道行编码可复用：把事件转成 `mood\tpetId\tname\tlocale` 行投给同一 handler），宠物窗口逻辑零改动。
- 窗口：`app.zon` 主窗口加 `close_policy = "hide"`；菜单 `pet.toggle` → `fx.hideWindow("main")` / `showWindow("main")`；开关状态写入 `persist.zig` 的状态文件（新增一字段，向后兼容旧行）。默认首次启动显示。
- 迁移：P1–P2 期间浏览器 `POST /state` 与事件流并存，App 以**最后到达者**为准；P3 起浏览器 `bridge.ts` 不再 POST，`server.zig` 删除 `/state` 与 `/events`，保留 `/pets`、`/sprites/*`（设置面板预览仍从 App 拉图）。

## 11. 配置与设置面板

插件 `config`（zod，`packages/pet/src/config.ts` 新建，沿用其他包的 `Config` 静态属性写法）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `companion.enabled` | `true` | 关掉即不注册伴侣路由与监听 |
| `companion.relayMode` | `'race'` | `'race' \| 'when-no-browser' \| 'off'`，见第 7 节 |
| `companion.decisionTimeoutMs` | `0` | 见第 7 节 |
| `companion.notices.turnEndMinMs` | `5000` | 回合结束通知的最短回合时长 |
| `companion.maxSessions` | `64` | 快照会话上限 |

设置面板"伴侣"分区（`settings-panel.tsx` 新增 section）：连接状态（从插件路由 `GET /dsh-pet/companion/status`——仅浏览器会话可见，不需 Bearer）、"启动伴侣"（复用现有 launch 路由）、"生成配对码"、"吊销全部令牌"、"显示桌面宠物"开关（经伴侣通道下发 `pet.toggle`，无伴侣时禁用）、皮肤选择（现有）。

环境变量汇总：`DSH_PET_COMPANION_URL`、`DSH_PET_COMPANION_TOKEN`（新）；`DSH_PET_DESKTOP_ORIGINS`、`DSH_PET_DESKTOP_ASSETS`、`DSH_PET_DESKTOP_APP`（既有）。

## 12. 打包与发布

- **macOS 通知需要签名的 `.app` bundle 与 bundle id**（`UNUserNotificationCenter` 对裸二进制不弹权限、不投递）。P0 首日验证；若确认，平台包 `@seaveyon/dsh-pet-desktop-darwin-*` 改为携带 `DSH Companion.app`（用 SDK 的 `native package` 或 `zig build` 后手工组 bundle：`Contents/MacOS/dsh-pet-desktop`、`Contents/Info.plist` 含 `CFBundleIdentifier = dev.seaveyon.dsh-pet-desktop`、`LSUIElement = true`、`Contents/Resources/assets`），`launch.ts` 的 `platformPackageBinary` 改为指向 bundle 内可执行文件（`open` 路径用 bundle）。ad-hoc 签名即可让通知工作；notarization 仍为手工步骤。
- Windows：`bin/dsh-pet-desktop.exe` 不变；托盘图标从 `assets/icon.ico`（新增）加载。
- `assets/`：新增 `tray-template.png`（macOS 模板图标，黑色 + alpha，18×18 @1x/@2x）与 `icon.ico`。
- semantic-release：`release/pet.config.mjs` 与三个平台包配置不变；`build:desktop` 脚本增加 bundle 组装。`scripts/smoke-tarball.mjs` 的 pet 条目增加：路由模块可导入、`companionEnv` 输出正确。
- CI：`desktop-zig` job 保持 `zig build test`；新增一步 `zig build` 后校验 `app.zon` 权限包含 `network`、`notifications`、`credentials`（简单 grep，防止回退）。

## 13. 自动化验收

测试一律用临时 DSH home 与 `createMockContext`，不碰真实 `~/.dsh`。

TS（`packages/pet/test/`）：

1. `companion-feed.test.ts`：`session/created` → `session` 事件；`agent/status` 翻转 → 同一 session 事件且 `revision` 递增；`session/disposed` → `session-removed`；快照 ≤ `maxSessions` 且按 `updatedAt` 倒序；标题截断与脱敏；`since` 落后 → `resync`。
2. `companion-relay.test.ts`：无订阅者 → `next()` 被调用且不广播；有订阅者 → 广播 `approval`，`POST allowed-once` → waterfall 返回 `allowed-once`、`resolved.by = companion`；浏览器先答（`next()` 先 resolve）→ 之后的 POST 409、`resolved.by = web`；`signal` 中止 → 410 与 `resolved.by = cancelled`；非法 decision → 400；`relayMode = 'when-no-browser'` 的两条分支。
3. `companion-auth.test.ts`：无 Bearer 401、错令牌 401（常量时间路径至少断言不因前缀提前返回）、非 loopback 403、配对码一次性与 60 秒过期、5 次错误后 429、吊销后 401、`companion.json` mode 0600 且宿主重启（重新 `apply`）后令牌仍有效。
4. `companion-mood.test.ts`：`approval/asked` 折叠为 `pending` → `waiting`；工具调用中 → `working`；`running` 落下 → `celebrating` 后回 `idle`；与 `client/mood.ts` 既有断言共用 fixtures。
5. `companion-fixtures.test.ts`：把每种事件与快照的编码结果写到 `packages/pet-desktop/src/fixtures/companion/*.sse`（提交到仓库）；测试断言重新生成后与仓库文件逐字节一致（漂移即红）。
6. `launch.test.ts` 增：`companionEnv` 进 spawn env 与 `open --env`；无令牌时不注入。
7. `desktop-contract.test.ts` 增：读取 `companion.zig` 中的 `schema_version` 常量与 TS `schemaVersion` 相等；读取 `app.zon` 权限含三项。

Zig（`packages/pet-desktop/src/*_test` 内联 test）：

8. `companion.zig`：对 `fixtures/companion/*.sse` 逐行解析出预期事件；未知 `event:` 忽略；未知字段忽略；超 4 KiB 行丢弃并计数；`id:` 单调性检查。
9. `tray.zig`：六种聚合态的标题 / tone / opacity；32 项裁剪与"更多…"；4 条审批上限；zh / en 文案；命令字符串长度 < 64。
10. `notify.zig`：四类 notice 的 id / 标题 / 正文长度上限；Windows 目标下动作字段为空；30 秒静音窗；通知关闭时返回 null。
11. `feed.zig`：重连退避序列（1、2、4、5、5 … 秒）；`resync` → 拉快照；401 两次 → 清凭据。
12. `model.zig`：`pet.toggle` 往返 hide/show 且持久化字段落盘；`mood` 事件驱动现有 `state_event` 路径（复用既有测试）。

手工受理（写进 P0 / P2 退出条件）：两平台状态项截图；macOS 通知动作回调进 `on_command` 的日志；伴侣先答后浏览器对话框关闭的录屏或日志。

## 14. 分阶段实施

### P0：可行性 spike（约 1 周）

- 在现有 App 加静态 `status_item` + `status_item_fn`（标题取现有桥接的 mood），一条测试通知，`close_policy = "hide"`；权限加三项。
- 验证：macOS 裸二进制 vs ad-hoc 签名 `.app` 的通知权限行为；Windows 交叉编译后托盘与气球；`fx.fetch .stream` 对一个本地 SSE 小服务的按行投递。
- 退出：两平台截图、通知回调日志、`.app` 结论写入本文第 12 节；不合并任何协议代码。

### P1：状态与通知（约 2 周）

- TS：`HostContext.on`、`CompanionFeed`、`CompanionAuth`（仅 `launched` 令牌与环境变量交付）、`snapshot` / `events` / `revoke` 路由、`turn-end` / `turn-error` notice、fixtures 生成。
- Zig：`companion.zig`、`feed.zig`、`tray.zig`（暂无审批块）、`notify.zig`、`main.zig` 接线、`open.dsh` / `s.open`。
- 退出：第 13 节的 1、3（部分）、5、6、8、9、10、11 全绿；`bun run check`、`bun run test`、`zig build test`；断网 30 秒自动恢复的手测记录。

### P2：审批与提问（约 2 周）

- TS：`InteractionRelay`、`approvals` / `questions` 路由、`relayMode` 双实现、审计日志、`check-host-contract` 扩展。
- Zig：菜单审批块与分段行、`ap.*` 命令与乐观更新、`question` 作答小窗口（`windows_fn`）。
- 首日：真实宿主验证 waterfall 可达性与浏览器对话框关闭行为，据此定 `relayMode` 默认值。
- 退出：第 13 节的 2、4（部分）；手测录屏；`docs/zero-native-notes.md` 追加新踩的坑。

### P3：宠物即皮肤与产品化（约 1–2 周）

- `shared/mood.ts` 抽取、服务端心情机与 `mood` 事件；App `mood` 事件接入；`pet.toggle` 与持久化；`pet.skin.*`；登录时启动；配对码 UX（面板 + 小窗口）；删除 `POST /state` / `GET /events`；`bridge.ts` 停止 POST。
- 打包：`.app` bundle、`icon.ico`、模板图标、`build:desktop` 更新、smoke 条目。
- 文档：`packages/pet/README*.md`、`packages/pet-desktop/README.md`、设置面板文案；App 显示名 "DSH Companion"。
- 退出：全部 13 节测试；`bun run smoke`（如有）；三个平台包与 `dsh-pet` 通过 semantic-release 发布。

### 之后（不在本文承诺）

远程 DSH（web-login 设备令牌）；Linux（等 SDK 托盘）；world-line lab 结果与 git-worktree 快捷入口进菜单；是否发 `dsh-companion` 别名包。

## 15. 风险与待验证

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| macOS 通知要求 `.app` + bundle id，现发裸二进制 | P0 可能撞墙 | P0 首日验证；改平台包为 `.app`（第 12 节） |
| 审批竞速与浏览器对话框关闭行为未实测 | 陈旧对话框或双重提示 | P2 首日实测；`relayMode` 双实现，默认取实测结果 |
| 插件级 `ctx.on` 收不到 agent 作用域的 waterfall | 中继失效 | P2 首日用真实宿主验证；备选按 agent 挂监听 |
| 宿主事件在 rc 版本间漂移 | 伴侣静默失去信号 | `check-host-contract` 覆盖新事件；插件集中适配，App 不感知 |
| SDK 锁定 commit 的状态项 / 通知若有 bug 需升级 | 牵动拖拽与透明三件套 | 升级单独成 PR，回归 `zero-native-notes.md` 12 条 |
| Windows 气球无自定义按钮、一次一条 | 不能从通知直接处理 | 托盘菜单为主，文档写明 |
| 菜单 32 项 / 标题 64 字节 | 多会话截断 | `tray.zig` 按优先级裁剪 + "更多…" |
| SSE 单行 4 KiB | 长标题 / 多选项提问溢出 | 服务端在编码处截断并测试；快照走 buffered GET 不受限 |
| `fx.fetch` 与 spawn 共用 16 槽 | 决定 POST 与流并发占槽 | 同时在飞的 POST ≤ 4，多余排队 |

## 16. 给接手 agent 的首条任务

基于 `main` 新建分支，先只做 P0：在 `packages/pet-desktop` 现有 App 上加 `status_item` / `status_item_fn`（标题取现有 mood）、一条测试通知、`close_policy = "hide"`，`app.zon` 权限加 `network`、`notifications`、`credentials`；用 ad-hoc 签名的 `.app` 与裸二进制各跑一次通知，Windows 交叉编译验证托盘；把结论追加到本文第 12 节与 `packages/pet-desktop/docs/zero-native-notes.md`。不要在 P0 写任何协议或插件代码。提交前运行根 `bun run check`、`packages/pet-desktop` 的 `zig build test` 与 `zig fmt --check src/`，PR 里附两平台截图。
