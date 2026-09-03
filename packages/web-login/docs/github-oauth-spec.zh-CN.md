# dsh-web-login GitHub OAuth 与身份授权规格

| 字段 | 值 |
| --- | --- |
| 状态 | 阶段 1 实现中（单 owner MVP） |
| 目标包 | `@seaveyon/dsh-web-login` |
| 建议版本 | `0.3.0` |
| 主要场景 | 单人多设备、家庭服务器、远程工作站、小型可信团队 |
| 身份提供方 | GitHub.com OAuth Web Application Flow |

## 1. 摘要

本规格将 `dsh-web-login` 从“共享密码门禁”扩展为“具有人类身份的远程访问门禁”。管理员首次通过已有密码会话或仅主机可用的恢复流程绑定 GitHub；插件从 GitHub `GET /user` 响应中自动取得并持久化稳定的数字用户 ID。以后任何设备都可以完成 GitHub OAuth，插件仅在实时身份与本地授权记录匹配时创建 DSH 会话。

OAuth 证明“访问者是谁”，本地授权记录决定“该身份能否进入”。任意有效 GitHub 账号不得自动获得访问权。

此功能不替代 HTTPS、反向代理、DSH 自身的 Host/Origin 信任边界或 DSH 内建的浏览器传输认证。发布前必须证明 OAuth 会话能够与目标 DSH 版本的 BrowserAuth 正确协同。

## 2. 背景与问题

当前插件只有一个共享密码校验值。它适合单人本机部署，但在以下场景中存在明显摩擦：

- 同一用户从电脑、平板和手机访问时，需要分发和输入共享密码；
- 多人共享一个密码时，服务无法识别实际访问者，也无法只撤销某一个人；
- 密码轮换会同时影响所有设备和用户；
- 远程 DSH 是可执行命令、读取工作区并处理凭据的控制面，共享秘密不足以提供身份审计。

DSH 新版本还具有自己的启动令牌和签名浏览器 Cookie。该机制证明浏览器持有本次启动产生的能力，但不等同于稳定的人类身份。GitHub OAuth 的目标是补足真人身份与本地授权，而不是重复实现传输认证。

## 3. 产品目标

### 3.1 必须实现

- 用户不需要手工查询或填写 GitHub 数字 ID；
- 首位管理员只能从已认证的引导流程产生，不能采用“公网第一个登录者成为管理员”；
- 日常登录只允许已登记的 GitHub 数字 ID；
- 同一 GitHub 用户可以从不同设备分别建立本地会话；
- 移除用户后，其现有 DSH 会话立即失效；
- OAuth Client Secret、授权码、access token 和 PKCE verifier 不进入配置文件、浏览器存储、持久会话或日志；
- OAuth 失败、状态损坏、授权文件损坏或 DSH 认证桥不兼容时均 fail-closed；
- 保持 HTTP、API、插件资源、SPA fallback 和 WebSocket 的完整门禁覆盖。

### 3.2 应当实现

- 绑定完成后自动关闭正常的网络密码登录，不要求管理员手工切换模式；
- 提供主机本地恢复路径；
- 保存可展示的 GitHub 用户名，但始终用数字 ID 授权；
- 为登录、绑定、拒绝、撤销和恢复事件生成不含秘密的安全日志；
- 管理员可通过短期一次性邀请添加其他 GitHub 用户。

### 3.3 非目标

- 不提供 GitHub 仓库内容访问；MVP 不请求 `repo` scope；
- 不把 GitHub OAuth token 用作 DSH API bearer token；
- 不提供多租户工作区、会话或文件隔离；
- 不提供完整企业 IAM、SCIM、SAML 或通用 OIDC；
- 不在 MVP 中支持 GitHub Enterprise Server、自定义 OAuth 端点、组织或团队授权；
- 不让 OAuth 替代 TLS、防火墙、私有监听或可信反向代理。

## 4. 术语

- **身份认证（authentication）**：通过 GitHub OAuth 和 `GET /user` 确认访问者的 GitHub 身份。
- **授权（authorization）**：将 GitHub 数字用户 ID 与本地已授权用户记录比较。
- **引导认证（bootstrap authentication）**：首次绑定 owner 前使用的现有密码会话或主机本地恢复能力。
- **principal**：写入 DSH 会话的本地身份，例如 GitHub 用户 ID、显示用户名和角色。
- **BrowserAuth**：目标 DSH 版本自身的浏览器启动令牌、签名 Cookie 和 API/WS 认证边界。
- **授权状态文件**：插件持久化已授权 GitHub 身份的本地文件，不含 OAuth token。

## 5. 用户与需求场景

### 5.1 主要用户

1. 在家庭服务器、NAS 或远程工作站运行 DSH 的单一开发者；
2. 通过 Tailscale、Cloudflare Tunnel、Caddy、nginx 或 SSH 转发访问 DSH 的用户；
3. 需要从多个个人设备登录同一 DSH 实例的用户；
4. 共用一个受信 DSH 实例、需要按人撤销访问的小型团队。

### 5.2 不适合的用户

- 只在 `127.0.0.1` 使用 DSH 且能安全取得每次启动 URL 的用户；
- 需要租户级数据隔离和细粒度资源权限的团队；
- 无法访问 GitHub.com 的离线或隔离环境；
- 需要公司统一 SSO 而非 GitHub 身份的组织。

## 6. 设计原则

1. **绑定与登录分离**：首次登记身份需要更高权限，日常 OAuth 只验证已登记身份。
2. **显式授权**：GitHub 登录成功不代表 DSH 授权成功。
3. **稳定标识**：只使用 GitHub 数字 `id` 作为授权键；`login` 仅用于展示和日志。
4. **最小权限**：MVP 使用空 scope，只读取认证用户的公开身份，不请求邮箱、组织或仓库权限。
5. **短期持有 token**：token 只存在于回调处理函数内；读取身份后立即撤销单个 app token，随后清除内存引用。
6. **单一规范源站**：OAuth 回调、Cookie 和所有认证后跳转均以显式 `publicUrl` 为准。
7. **兼容性先于功能**：无法证明目标 DSH BrowserAuth 协同时不得发布 OAuth 模式。
8. **默认拒绝**：缺失用户、未知状态、配置错误、外部请求失败和持久化失败都不能创建会话。

## 7. 生命周期状态机

插件根据授权状态文件和临时恢复状态计算运行状态，不要求管理员直接设置 `authMode`。

| 状态 | 条件 | 可用登录方式 | 允许的迁移 |
| --- | --- | --- | --- |
| `bootstrap` | 没有授权状态文件或 `users` 为空 | 现有密码登录 | 绑定首位 owner 后进入 `active` |
| `active` | 至少存在一个有效 owner | GitHub OAuth | 添加/移除用户；本机开启恢复窗口 |
| `recovery` | 主机 CLI 创建了未过期的一次性恢复能力 | GitHub OAuth；一次性恢复入口 | 重绑 owner 后回到 `active`；超时回到原状态 |
| `invalid` | 文件损坏、版本未知、没有 owner 或权限不安全 | 无 | 修复文件或通过本机 CLI 恢复 |

### 7.1 状态不变量

- `active` 状态至少有一个 `role: owner`；
- UI 和 API 均禁止删除最后一个 owner；
- `invalid` 不得回退为开放访问或普通密码登录；
- `bootstrap` 只能在从未绑定或由明确恢复操作清空后出现；
- 普通 HTTP 请求不能自行创建 `recovery` 状态。

## 8. 核心流程

### 8.1 首次绑定 owner

1. 插件发现没有授权状态文件，进入 `bootstrap`；
2. 用户通过现有 scrypt 密码登录，获得短期 bootstrap session；
3. 已登录用户调用 `POST /auth/github/enroll`；
4. 插件创建一次性 OAuth state 和 PKCE verifier，记录 `intent: enroll-owner`；
5. 浏览器跳转 GitHub；
6. 回调验证 state、PKCE 和授权码，然后调用 `GET /user`；
7. 插件以原子方式写入首位 owner；
8. 插件创建带 GitHub principal 的正常 DSH 会话，并撤销 bootstrap session；
9. 插件进入 `active`，密码表单从正常登录页面消失。

如果授权文件写入失败，必须先撤销新建会话并显示错误；不得出现“浏览器已登录、授权记录未保存”的分裂状态。

### 8.2 已登记用户日常登录

1. 未认证用户访问 DSH 页面，被重定向至 `/login`；
2. 登录页显示“使用 GitHub 登录”；
3. `GET /auth/github/login` 创建 `intent: login` 的一次性 OAuth state；
4. GitHub 回调取得 `{ id, login }`；
5. 插件以 `id` 查询本地授权记录；
6. 未找到、已禁用或授权版本不匹配时返回通用 `403`；
7. 找到时创建带 principal 的本地 Session，并重定向至固定首页 `/`。

不得将用户提供的 `next`、`redirect_uri` 或回调参数直接作为跳转目标。MVP 使用固定首页，避免开放重定向。

### 8.3 添加其他用户

该流程属于第二阶段，但数据结构和路由应预留：

1. owner 创建十分钟有效、一次性、不可猜测的邀请；
2. 候选用户打开邀请链接并完成 GitHub OAuth；
3. OAuth state 内部关联邀请摘要和 `intent: accept-invitation`；
4. 回调自动保存候选用户数字 ID；
5. 邀请在成功、拒绝、过期或首次消费时失效。

邀请不得直接携带明文角色、GitHub ID 或可修改授权结果的客户端字段。MVP 后的首个版本只允许邀请 `member`；提升 owner 需要已登录 owner 的独立操作。

### 8.4 移除用户

1. owner 提交删除请求；
2. 服务端验证不能删除最后一个 owner；
3. 原子更新授权状态并递增 `authzVersion`；
4. 撤销目标用户的所有内存 Session；
5. 后续携带旧 Cookie 的请求返回 `401`。

### 8.5 主机本地恢复

提供命令：

```sh
dsh plugin --profile web exec dsh-web-login-recovery
```

命令生成至少 32 字节随机的一次性恢复 token，只打印一次，并将其摘要、创建时间和过期时间安全写入插件状态目录。恢复 token：

- 十分钟后过期；
- 首次验证即消费；
- 只能用于进入短期恢复会话，不能直接作为长期登录凭据；
- 不得通过普通远程 HTTP 请求生成；
- 恢复成功后必须重新绑定或修复 owner。

长期不保留可从网络使用的密码后门。现有密码 hash 可以保留用于显式 bootstrap 兼容，但 `active` 状态不得展示或处理普通密码登录。

## 9. HTTP 路由

| 方法 | 路径 | 是否匿名可达 | 用途 |
| --- | --- | --- | --- |
| `GET`, `HEAD` | `/login` | 是 | 按状态显示密码引导、GitHub 登录或错误信息 |
| `POST` | `/login` | 仅 `bootstrap` | 现有密码引导登录 |
| `GET` | `/auth/github/login` | 是 | 为已登记用户发起 GitHub OAuth |
| `GET` | `/auth/github/callback` | 是 | 消费 OAuth state 并完成登录/绑定 |
| `POST` | `/auth/github/enroll` | 否 | 已认证 bootstrap session 发起 owner 绑定 |
| `POST` | `/auth/github/invitations` | 否 | owner 创建邀请；第二阶段 |
| `GET` | `/auth/github/invitation?token=…` | 是 | 消费邀请并发起 OAuth；第二阶段 |
| `GET` | `/auth/users` | 否 | 返回最小化的已授权用户列表；第二阶段 |
| `DELETE` | `/auth/users` | 否 | owner 在受限请求体中提交数字 ID 并移除用户；第二阶段 |
| `GET` | `/auth/recovery?token=…` | 是 | 消费主机 CLI 创建的一次性恢复能力 |
| `POST` | `/logout` | 是 | 撤销当前本地 Session 并清除 Cookie |

### 9.1 路由绕过规则

门禁装饰器只能匿名放行以下精确路径：

- `/login`
- `/logout`
- `/auth/github/login`
- `/auth/github/callback`
- `/auth/github/invitation`
- `/auth/recovery`

`/auth/`、`/login/` 或其他前缀不得整体放行。邀请和恢复 token 放在精确路由的查询参数中，由 handler 严格校验；这避免为了动态路径而匿名放行整个前缀。插件自有但需要登录的路由必须接受与其他 DSH 路由相同的 session guard。

## 10. OAuth 协议

### 10.1 GitHub OAuth App

MVP 使用 GitHub OAuth App 的 Authorization Code Web Flow：

- Authorization endpoint：`https://github.com/login/oauth/authorize`
- Token endpoint：`https://github.com/login/oauth/access_token`
- User endpoint：`https://api.github.com/user`
- Token revocation endpoint：`https://api.github.com/applications/{client_id}/token`
- PKCE method：`S256`
- Scope：空
- Callback：`${publicUrl}/auth/github/callback`

`redirect_uri` 必须由服务端配置生成，并在授权请求和 token 交换中完全一致。不得从请求 Host、Forwarded 头或查询参数推导。

### 10.2 OAuth state

新增有界内存仓库：

```ts
interface PendingOAuth {
  intent: 'login' | 'enroll-owner' | 'accept-invitation'
  codeVerifier: string
  createdAt: number
  expiresAt: number
  initiatorSessionId?: string
  invitationDigest?: string
}

interface OAuthStateStore {
  open(input: Omit<PendingOAuth, 'codeVerifier' | 'createdAt' | 'expiresAt'>): {
    state: string
    codeChallenge: string
  } | null
  consume(state: unknown): PendingOAuth | undefined
  sweep(): void
  readonly size: number
}
```

要求：

- `state` 和 verifier 均来自密码学安全随机源；
- `consume` 一次性删除记录，包括错误和过期路径；
- 默认 TTL 十分钟；
- 默认最多 1,000 个 pending state；
- 满额时返回 `503`，不得驱逐仍有效的流程；
- 不使用当前 `SameSite=Strict` session Cookie 保存 state/verifier，因为跨站 GitHub 回调不能依赖该 Cookie 被发送；
- 定时清理过期记录，定时器不得阻止进程退出。

### 10.3 外部 HTTP 约束

- 每个 GitHub 请求默认十秒超时；
- token 和 user 响应体分别设置较小硬上限；
- 明确发送 `Accept: application/json` 或 GitHub REST media type；
- 发送固定 `User-Agent` 和受支持的 API version header；
- 只连接编译期固定的 GitHub HTTPS 主机；MVP 不允许配置任意 endpoint，避免 SSRF；
- 不自动跟随 token、user 或 revoke endpoint 的跨主机重定向；
- JSON 类型、字段和长度必须运行时校验；
- 网络错误、限流、非 2xx、畸形响应和缺少数字 `id` 均拒绝登录。

### 10.4 Token 生命周期

access token 仅允许存在于回调函数的局部作用域：

1. 交换授权码；
2. 调用 `GET /user`；
3. 如未来启用组织规则，再进行必要授权检查；
4. 调用单 token 撤销接口；
5. 清除引用并完成本地 Session 创建。

MVP 的安全策略是撤销失败则不创建 DSH Session，避免留下服务无法确认已回收的第三方凭据。该策略应通过真实 GitHub 流程验证用户体验和限流行为；如后续放宽，必须记录明确的安全决策。

## 11. 持久化授权数据

默认路径：

```text
${DSH_HOME}/auth/dsh-web-login/github-users.json
```

建议 schema：

```json
{
  "schemaVersion": 1,
  "authzVersion": 3,
  "users": [
    {
      "githubUserId": 12345678,
      "login": "example",
      "role": "owner",
      "status": "active",
      "enrolledAt": "2026-09-02T10:00:00.000Z",
      "lastLoginAt": "2026-09-02T11:00:00.000Z"
    }
  ]
}
```

### 11.1 文件安全要求

- 目录权限为 `0700`，文件权限为 `0600`；
- 拒绝读取或写入符号链接；
- 写入同目录临时文件，设置权限，必要时同步，然后原子 rename；
- 解析前限制文件大小；
- 拒绝重复 GitHub ID、未知 schema、未知角色、非法时间和空 owner 集合；
- 写入失败保留旧文件，不得留下部分 JSON；
- 状态文件是授权数据而非秘密，但其完整性属于安全边界；
- 不把该文件提交版本控制或包含在普通诊断输出中。

## 12. Session 模型

当前 `SessionStore` 需要从 `session id -> expiry` 扩展为：

```ts
interface SessionPrincipal {
  provider: 'password-bootstrap' | 'github' | 'recovery'
  githubUserId?: number
  githubLogin?: string
  role: 'owner' | 'member'
  authzVersion: number
}

interface SessionRecord {
  expiresAt: number
  principal: SessionPrincipal
}
```

新增能力：

- `open(principal)` 创建会话；
- `get(id)` 返回仍有效的 principal；
- `revoke(id)` 撤销单会话；
- `revokePrincipal(githubUserId)` 撤销某用户全部会话；
- `revokeAll()` 用于授权文件替换或安全恢复；
- 每次授权检查验证用户仍为 active 且 `authzVersion` 可接受。

Cookie 继续使用 host-only、`HttpOnly`、`SameSite=Strict` 和生产环境 `Secure` 的现有实现。OAuth access token 绝不能进入 Cookie。

## 13. 配置

新增配置建议：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `githubEnabled` | `false` | 显式启用 GitHub OAuth；保持向后兼容 |
| `publicUrl` | 无 | 必填 HTTPS 规范源站；本机测试可显式允许 loopback HTTP |
| `githubClientIdEnv` | `GITHUB_OAUTH_CLIENT_ID` | Client ID 环境变量名 |
| `githubClientSecretEnv` | `GITHUB_OAUTH_CLIENT_SECRET` | Client Secret 环境变量名 |
| `githubStateTtlMs` | 十分钟 | pending OAuth state 有效期 |
| `githubMaxPendingStates` | `1000` | pending state 容量上限 |
| `githubRequestTimeoutMs` | 十秒 | GitHub HTTP 请求超时 |
| `githubMaxConcurrentCallbacks` | `4` | 回调外部请求并发上限 |
| `authorizationFile` | `${DSH_HOME}/auth/dsh-web-login/github-users.json` | 授权状态路径 |

规则：

- `githubEnabled: false` 时行为与 `0.2.x` 密码模式一致；
- `githubEnabled: true` 时必须有合法 `publicUrl`、Client ID 和 Client Secret；
- Secret 只能来自环境变量；
- 未知配置键继续导致启动失败；
- `publicUrl` 不得包含用户名、密码、查询参数或 fragment；
- 非 loopback 的 `http:` URL 导致启动失败；
- 不再暴露容易产生双重长期登录入口的 `authMode: either`。迁移期由生命周期状态自动控制。

示例：

```yaml
- id: dsh-web-login
  config:
    githubEnabled: true
    publicUrl: https://dsh.example.com
```

```dotenv
GITHUB_OAUTH_CLIENT_ID=Ov23li...
GITHUB_OAUTH_CLIENT_SECRET=...
LOGIN_PASSWORD_HASH=scrypt$...
```

`LOGIN_PASSWORD_HASH` 在首次绑定完成后不再接受普通网络密码登录，但仍可由明确的本地恢复策略使用。

## 14. DSH BrowserAuth 兼容性门槛

GitHub OAuth Session 与 DSH 内建 BrowserAuth 是不同安全层。实现开始前必须对目标 DSH 版本完成兼容性实验，并记录版本和结果。

### 14.1 必须证明

从没有任何 DSH 或插件 Cookie、也没有启动 URL token 的全新浏览器开始：

1. 完成 GitHub 登录；
2. 加载 SPA；
3. 调用普通 Host RPC；
4. 建立并重连 WebSocket；
5. 调用目标版本允许远程使用的设置、凭据或其他特权方法；
6. 退出登录后，上述能力全部立即失败；
7. OAuth 未授权用户不能借助 DSH 启动 token 绕过 GitHub 人类身份门禁。

### 14.2 可接受的集成结果

按优先级选择：

1. 使用 DSH 提供的正式身份/BrowserAuth 扩展点，将 GitHub principal 交给 DSH；
2. 与 DSH 维护者确认的稳定服务契约集成；
3. 如果目标版本确实不需要第二个传输 Session，保留外层 gate，但用真实 host E2E 测试证明；
4. 若只能依赖私有内部结构、伪造 Cookie 或复制 DSH 私钥，停止发布并推动上游扩展点。

不得通过记录、读取或转发 DSH 每次启动的明文 URL token 来桥接 OAuth。

### 14.3 失败行为

- 检测到明确不支持的 host 契约时启动失败；
- 不能确认兼容性时 `githubEnabled` 保持不可用；
- bundle patch 和 README 必须声明已测试的 DSH 版本范围；
- CI 的 testkit 通过不能替代真实 DSH host 的端到端测试。

## 15. 安全威胁与控制

| 威胁 | 控制 |
| --- | --- |
| 首位访客抢占 owner | 首次绑定必须具有密码 bootstrap session 或主机本地恢复能力 |
| OAuth CSRF / login CSRF | 不可猜测、一次性、短期 `state`，并绑定 intent 和发起会话 |
| 授权码截获 | PKCE S256、精确 callback、服务端交换、短超时 |
| 回调重放 | state 在任何消费路径立即删除；code 仅使用一次 |
| 开放重定向 | 固定返回 `/`；不接受客户端绝对 URL |
| 任意 GitHub 用户进入 | OAuth 后必须匹配本地数字 ID 授权记录 |
| 用户名变更/复用 | 数字 ID 授权，用户名仅展示 |
| token 泄露 | 不写磁盘、Cookie、浏览器或日志；使用后撤销 |
| pending state 内存耗尽 | 容量、TTL、定时清理、IP/网段和全局限流 |
| GitHub API 资源耗尽 | callback 并发闸、请求超时、响应体上限和频率限制 |
| 授权文件篡改 | 安全权限、严格 schema、原子写入、拒绝 symlink |
| 删除用户后旧 Session 可用 | 按 principal 撤销并验证授权版本 |
| 反向代理伪造来源 | `trustProxy` 仅在可信代理覆盖头部且 DSH 不可被绕过时开启 |
| 外层登录成功、内层 DSH 仍拒绝 | 真实 host 兼容性门槛和干净浏览器 E2E |
| 双登录入口绕过 | active 状态关闭普通密码 POST，只保留主机恢复 |

## 16. 错误与日志

### 16.1 用户可见错误

- OAuth 被取消：`GitHub sign-in was cancelled.`
- state 无效或过期：`This sign-in request expired. Please try again.`
- 未授权身份：`This GitHub account is not allowed.`
- GitHub 暂时不可用：`GitHub sign-in is temporarily unavailable.`
- 状态容量或回调并发已满：返回 `503` 和 `Retry-After`；
- 授权状态损坏：返回通用维护错误，服务端记录详细诊断。

不得向用户显示 Client Secret、token、code、verifier、原始 GitHub 响应或本地文件路径。

### 16.2 安全日志

允许记录：

- 事件类型；
- GitHub 数字 ID 和当时用户名；
- 客户端限流桶；
- 成功/拒绝原因的稳定错误码；
- 时间戳和 authzVersion。

禁止记录：

- OAuth access/refresh token；
- Client Secret；
- 授权码；
- 完整 state、PKCE verifier、session ID、邀请 token 或恢复 token；
- GitHub API 完整响应体。

## 17. 测试规格

### 17.1 单元测试

- 配置默认值、范围、HTTPS 限制和未知键；
- OAuth state 熵、PKCE challenge、过期、容量、一次消费和 sweep；
- GitHub token/user/revoke 响应的严格解析；
- 授权文件 schema、重复 ID、最后 owner 和未知版本；
- 原子写入、权限、symlink 拒绝和部分写入恢复；
- principal session 的创建、过期、按用户撤销和授权版本失效；
- 页面在 `bootstrap`、`active`、`recovery`、错误状态下的输出和转义。

### 17.2 集成测试

- 未登记状态只允许密码 bootstrap，不允许普通 GitHub 账号抢占；
- 绑定 owner 成功后自动关闭普通密码登录；
- 已登记 ID 登录成功并获得现有安全 Cookie；
- 未登记 ID 返回 `403` 且不创建 Session；
- 用户名改变、数字 ID 相同仍成功；
- state 缺失、错误、过期、重复使用均失败；
- GitHub 超时、限流、非 2xx、超大响应和畸形 JSON 均失败；
- token 撤销失败时不创建 Session；
- 移除用户后所有设备上的旧 Session 均失效；
- OAuth 公共精确路由可达，其他精确/前缀/fallback/upgrade 路由仍受保护；
- 日志捕获中不出现任何秘密材料。

### 17.3 真实 host 端到端测试

每个声明支持的 DSH 版本至少验证：

- 全新浏览器 GitHub 登录；
- SPA 首屏和刷新；
- API 请求；
- WebSocket 建立、断线和重连；
- 插件静态资源；
- 目标版本的设置/凭据等特权操作；
- 退出、用户撤销、服务重启；
- HTTPS 反向代理以及 Host/Origin 配置；
- 没有 OAuth Session 时，即使持有 DSH 启动 URL，也不能越过外层人类身份门禁。

## 18. 交付阶段

### 阶段 0：兼容性实验

- 固定目标 DSH 版本；
- 明确 BrowserAuth 与插件 gate 的执行顺序；
- 完成干净浏览器 E2E；
- 决定是否存在可支持的身份桥；
- 不发布用户可见 OAuth 功能。

退出条件：第 14 节全部通过，或明确停止实现并提出上游扩展点需求。

### 阶段 1：单 owner MVP

- password bootstrap；
- GitHub OAuth + PKCE；
- 自动保存 owner ID；
- active 状态只允许 GitHub 登录；
- principal session；
- 主机本地恢复；
- 安全持久化和完整测试。

### 阶段 2：小型团队

- owner 管理页/API；
- 一次性邀请；
- `owner`/`member` 角色；
- 按用户撤销会话；
- 最小安全审计日志。

### 阶段 3：可选身份策略

- GitHub 组织/团队授权；
- GitHub App 或 GitHub Enterprise Server；
- 通用 OIDC；
- 更细权限前必须先获得 DSH 可消费 principal 的正式契约。

## 19. 向后兼容与迁移

- `githubEnabled` 默认 `false`，升级 `0.2.x -> 0.3.x` 不改变现有密码行为；
- 开启 OAuth 后，如果尚未绑定 owner，自动进入 `bootstrap`；
- 首次绑定成功后自动进入 `active`，无需修改 YAML；
- 现有 Session 可以在升级时统一失效，避免没有 principal 的旧会话被错误继承；
- 回退到 `0.2.x` 不应删除授权状态文件，但旧版本不会读取它；
- README 必须明确 OAuth 是远程身份层，而不是公网暴露 DSH 的完整部署方案。

## 20. 验收标准

功能只有在同时满足以下条件时才可标记完成：

1. 管理员无需手工查询 GitHub ID 即可完成首次绑定；
2. 没有 bootstrap 权限的首位访问者无法登记自己；
3. 任意未登记 GitHub 账号无法获得 DSH Session；
4. 已登记账号可在新设备的干净浏览器中登录；
5. GitHub ID 被自动持久化，且 token、code、verifier、secret 从不持久化；
6. 移除用户会立即撤销其全部现有 Session；
7. HTTP、API、静态资源、fallback 和 WebSocket 门禁无回归；
8. 目标 DSH 真实 host 的普通与特权操作端到端通过；
9. OAuth、GitHub API 或状态文件故障均 fail-closed；
10. 单元、集成、属性和 bundle 检查全部通过；
11. 中英文 README、SECURITY 和升级/恢复说明同步更新；
12. 发布说明列出确切测试过的 DSH 版本范围。

## 21. 发布前待决问题

1. 目标 DSH 版本是否提供正式 BrowserAuth/identity 扩展点？
2. 如果没有，外层 OAuth gate 如何让全新浏览器取得内部 DSH 传输 Session，而不复制私钥或读取启动 token？
3. GitHub 单 token 立即撤销是否会造成不可接受的授权确认频率或 API 限流？
4. `member` 在 DSH 尚无细粒度授权时是否有真实区别，还是阶段 2 暂时只支持多个等权 owner？
5. 本机恢复入口应绑定 loopback socket、一次性 token，还是两者同时要求？
6. 授权文件是否需要额外完整性 MAC，或依赖主机文件权限已足够？

第 1、2 项是实现阻塞项；其他问题可以通过原型和威胁模型评审解决。

## 22. 参考资料

- [GitHub OAuth Web Application Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub OAuth App 最佳实践](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
- [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [GitHub `GET /user`](https://docs.github.com/en/rest/users/users)
- [GitHub OAuth token 管理与撤销](https://docs.github.com/en/rest/apps/oauth-applications)
- [DSH browser authentication and request trust](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
