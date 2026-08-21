# dsh-web-login

[English](README.md) · [简体中文](README.zh-CN.md)

为 DSH Web 提供基于 Cookie 会话的登录保护层。它将反向代理的浏览器原生 HTTP Basic 认证弹窗替换为独立的登录页面，并保护 Web UI、API 路由、插件资源、SPA fallback 和 WebSocket 升级请求。

> **状态：** 公开源码准备版本 `0.1.0`。本包针对
> `@deepseek-ai/dsh-host-webserver` `0.1.0-rc.7` 的路由注册表契约，以及
> Cordis `^4.0.1` 进行测试。需要 Node.js **20.11.0 或更高版本**。本项目为独立软件，与 DeepSeek AI 没有隶属或背书关系。

## 功能

- 从环境变量读取 scrypt 密码校验值，不从插件配置读取密码；
- 生成高熵、不透明的内存会话 ID，并使用 host-only、`HttpOnly`、`SameSite=Strict` Cookie；
- 浏览器文档导航会跳转到 `/login`；API、插件和其他资源路由返回可处理的 JSON `401`，不会返回 HTML 登录页；
- 仅允许 `POST /logout`，同时撤销服务端会话并清除浏览器 Cookie；
- 包装通过 DSH `webServer` 注册的精确路由、前缀路由、SPA fallback 和 WebSocket 升级；
- 在运行 scrypt **之前**按客户端限制失败登录次数，并限制会话和限流记录所占内存；
- 为所有未认证响应设置 `Cache-Control: no-store`、CSP、防嵌入、防 MIME 嗅探和无 Referer 等安全响应头。

会话只保存在进程内存中。重启 DSH 会让所有人退出登录；这避免了落盘会话密钥和会话数据库，但也意味着它**不是**多实例共享会话方案。

## 安装前准备

1. 生产环境必须使用 HTTPS。`secureCookie` 默认是 `true`；即使 TLS 在反向代理处终止，也应保持开启。
2. 反向代理到 DSH 的链路必须处于私有网络或受到等效保护。本包不能替代防火墙、私有监听、TLS 或代理层的访问控制。
3. DSH 环境文件中的 scrypt 校验值仍属于凭据材料。不要提交到仓库、粘贴到日志或放进 profile manifest。
4. 所有 Web 路由拥有者都必须注入就绪服务；否则 DSH loader 并发启动时，某个路由可能早于登录保护层装饰注册表。

完整安全模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 安装

在 DSH Web 插件 loader 能解析依赖包的位置安装：

```sh
npm install @seaveyon/dsh-web-login
```

DSH Web 的正常安装一般已经提供下列可选 peer 依赖；建议使用已测试版本：

```text
@deepseek-ai/dsh-host-webserver  0.1.0-rc.7
@deepseek-ai/cordis              ^4.0.1
```

在交互式终端生成密码校验值（密码不会回显）：

```sh
npx dsh-web-login-hash
```

该命令会向 `${DSH_HOME}/.env` 写入 `LOGIN_PASSWORD_HASH=scrypt$…`；如果未设置 `DSH_HOME`，则写入 `~/.dsh/.env`。它会保留其他环境变量、以原子替换方式写入并将文件权限设为 `0600`，且不会打印密码或校验值。DSH 主目录必须先存在。

如果 DSH 由服务管理器启动，请确认该进程实际加载这个环境文件。若校验值缺失或格式错误，插件会在启动时失败关闭，而不是暴露未保护的 Web 端口。

### 添加 Web Profile Overlay

在**现有 DSH Web Cordis manifest** 中添加登录插件和就绪依赖。支持的 `0.1.0-rc.7` 组合中，`web-runtime`、`connection`、`modules` 和 `client-hmr` 都会拥有路由；保留其原有依赖，并给每一个追加 `dshWebLoginReady`。

可从带注释的示例开始：[`examples/dsh-web/cordis.patch.yml`](examples/dsh-web/cordis.patch.yml)

```yaml
plugins:
  dsh-web-login:
    package: '@seaveyon/dsh-web-login'
    config:
      secureCookie: true
      title: DSH Web

  web-runtime:
    inject: [dshWebLoginReady] # 追加，不要覆盖已有 inject
  connection:
    inject: [dshWebLoginReady]
  modules:
    inject: [dshWebLoginReady]
  client-hmr:
    inject: [dshWebLoginReady]
```

外层 YAML 的具体写法取决于已安装的 DSH profile loader；应将片段合并到现有插件条目，而不是直接覆盖整个 manifest。关键约束是：

1. `dsh-web-login` 必须在 `webServer` 服务就绪后启动；
2. 每个路由拥有者必须注入 `dshWebLoginReady`；
3. 这些条目只能在依赖可用后注册 HTTP、fallback、HMR 或 WebSocket 路由。

修改环境或插件 manifest 后重启 DSH。浏览器访问 `/` 应跳转到 `/login`；登录后确认 Web UI、API、插件资源和 WebSocket 功能正常。使用无痕窗口或独立客户端确认未登录的 API 和 WebSocket 请求被拒绝。

## 配置

所有配置都会校验。未知或拼写错误的键会导致启动失败，而不是悄悄采用默认值。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `passwordHashEnv` | `LOGIN_PASSWORD_HASH` | 保存 `scrypt$<salt hex>$<key hex>` 的环境变量名。 |
| `title` | `DSH Web` | 登录页与浏览器标题，长度为 1–120 个字符。 |
| `secureCookie` | `true` | 为 Cookie 增加 `Secure`。除本机 HTTP 开发外不要关闭。 |
| `sessionTtlMs` | 30 天 | 会话有效期；重启会更早使会话失效。范围：1 分钟–365 天。 |
| `maxSessions` | `10000` | 最大活跃会话数。满额时新登录返回 `503`，不会驱逐活跃会话。 |
| `maxBodyBytes` | `4096` | 登录表单最大字节数。范围：64 B–1 MiB。 |
| `attemptLimit` | `5` | 在统计窗口内触发封锁所需的失败次数。 |
| `attemptWindowMs` | 15 分钟 | 失败计数窗口。 |
| `blockMs` | 15 分钟 | 密码尝试被封锁的时长。 |
| `maxAttemptClients` | `10000` | 最大限流记录数，防止内存无限增长。 |
| `sweepIntervalMs` | 5 分钟 | 清理过期会话和限流记录的间隔。 |
| `trustProxy` | `false` | 仅在可信代理后使用转发 IP 头进行限流。 |
| `clientIpHeader` | `x-forwarded-for` | 仅在 `trustProxy` 为 true 时读取的小写头名称。 |

### 可信代理和限流

默认 `trustProxy: false`，限流使用直接 socket 地址，客户端无法伪造。只有当 DSH 只能通过**可信代理**访问，且代理会在每一个请求上覆盖转发 IP 头时，才能启用 `trustProxy`。插件采用逗号分隔链中的最后一跳，因为它是代理在看到客户端后追加的值。

```yaml
plugins:
  dsh-web-login:
    config:
      trustProxy: true
      clientIpHeader: x-forwarded-for
```

若代理只是原样透传客户端带来的 `X-Forwarded-For`，客户端可以伪造限流身份，从而绕过按客户端限流。

## 本地开发

对于仅在本机监听、没有 TLS 的开发环境，可设为 `secureCookie: false`；不要把这个设置带到可从互联网访问的实例。使用单独的开发密码和环境目录：

```sh
mkdir -p "$PWD/.dsh-dev"
DSH_HOME="$PWD/.dsh-dev" npx dsh-web-login-hash --env-path "$PWD/.dsh-dev/.env"
```

CLI 支持 `--env-path PATH` 和 `--var NAME` 来指定开发路径和环境变量名。它拒绝少于 8 个字符的密码，以及超过运行时最大字节长度的密码。

路径参数叫 `--env-path` 而不是 `--env-file`，因为后者被 Node 占用：无论 `--env-file` 出现在命令行的哪个位置（包括脚本路径之后），Node 都会消费它，把指定文件当作 dotenv 文件加载，文件不存在时以状态码 9 退出——而首次运行时它必然不存在，因为这个文件正是本命令要创建的。

执行包内检查。请先安装依赖——类型检查器、测试运行器和打包器都是开发依赖：

```sh
bun install          # 在 workspace 根目录执行
bun run typecheck    # 对 src 与 test 执行 tsc
bun run test         # rstest
bun run build        # rslib，bundleless，并生成类型声明
bun run pack:check   # 先构建，再执行 npm pack --dry-run
```

Lint 与格式化在整个 workspace 只配置一份，请在根目录执行：`bun run lint` 和
`bun run format:check`。根目录的 `bun run check` 会对所有包一并执行类型检查、lint
和格式检查。

CLI 测试会启动 `dist/hash-password.js`，因此需要先构建。`bun run pack:check` 会
先构建；在干净的工作树上直接执行 `bun run test` 则不会。

## 升级与移除

### 升级

1. 阅读发行说明并确认目标 DSH host/Cordis 版本兼容。
2. 备份 Web profile manifest，并继续妥善保护现有环境文件。
3. 升级包、执行上面的检查并重启 DSH。
4. 在视为升级完成前，测试匿名导航、API/WebSocket 拒绝、登录和退出。

校验值格式为 `scrypt$<salt hex>$<key hex>`。仅在轮换访问密码时重新生成，不需要在常规包升级时重置密码。

### 移除

1. 从 Web manifest 移除 `dsh-web-login`。
2. 从安装时修改过的路由拥有者 `inject` 数组中移除 `dshWebLoginReady`。
3. 重启 DSH，并在暴露服务之前确认替代访问控制已生效。
4. 仅在登录保护层不再配置读取它之后，才从 DSH 环境文件中移除 `LOGIN_PASSWORD_HASH`。

如果没有其他访问控制，移除插件会使 DSH Web 表面根据其监听地址和网络配置可访问。

## 包内容与发布

npm allowlist 只包含源码、密码校验值 CLI、示例 manifest、双语 README、安全策略和 MIT 许可证。测试、`.env`、会话状态和部署配置均不会进入 tarball。本仓库只为未来公开发布准备元数据；安装、测试、CI 和 release-preparation workflow 都不会执行 `npm publish`。
