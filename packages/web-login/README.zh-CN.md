# dsh-web-login

[English](README.md) · [简体中文](README.zh-CN.md)

为 DSH Web 提供基于 Cookie 会话的登录保护层。它将反向代理的浏览器原生 HTTP Basic 认证弹窗替换为独立的登录页面，并保护 Web UI、API 路由、插件资源、SPA fallback 和 WebSocket 升级请求。

> **状态：** 已发布到 npm。需要 Node.js **20.11.0 或更高版本**。本项目为独立软件，与 DeepSeek AI 没有隶属或背书关系。

## 功能

- 从环境变量读取 scrypt 密码校验值，不从插件配置读取密码；
- 生成高熵、不透明的内存会话 ID，并使用 host-only、`HttpOnly`、`SameSite=Strict` Cookie；在 TLS 环境下还会带上 `__Host-` 前缀；
- 浏览器文档导航会跳转到 `/login`；API、插件和其他资源路由返回可处理的 JSON `401`，不会返回 HTML 登录页；
- 仅允许 `POST /logout`，同时撤销服务端会话并清除浏览器 Cookie；
- 包装通过 DSH `webServer` 注册的精确路由、前缀路由、SPA fallback 和 WebSocket 升级；
- 在运行 scrypt **之前**限制失败登录次数——既按网段，也跨全部客户端统计；会话表和限流表都有内存上限，并在触顶时拒绝而不是放行；
- scrypt 在线程池上执行并受并发闸约束，因此大量登录请求不会拖住 DSH 进程的其余部分；
- 为所有未认证响应设置 `Cache-Control: no-store`、CSP、防嵌入、防 MIME 嗅探和无 Referer 等安全响应头。

会话只保存在进程内存中。重启 DSH 会让所有人退出登录；这避免了落盘会话密钥和会话数据库，但也意味着它**不是**多实例共享会话方案。

## 安装前准备

1. 生产环境必须使用 HTTPS。`secureCookie` 默认是 `true`；即使 TLS 在反向代理处终止，也应保持开启。
2. 反向代理到 DSH 的链路必须处于私有网络或受到等效保护。本包不能替代防火墙、私有监听、TLS 或代理层的访问控制。
3. DSH 环境文件中的 scrypt 校验值仍属于凭据材料。不要提交到仓库、粘贴到日志或放进 profile manifest。
4. 必须把本包作为 DSH bundle 安装，而不是普通依赖。bundle 层会给所有官方 Web 路由拥有者注入就绪服务；缺少这些注入时，某个路由可能早于登录保护层装饰注册表。

完整安全模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 安装

把 bundle 添加到 DSH Web profile：

```sh
dsh plugin --profile web add @seaveyon/dsh-web-login
```

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin` 会同时安装 npm 依赖，并把
[`cordis.patch.yml`](cordis.patch.yml) 层追加到 profile。该层会插入登录插件，并让
`web-runtime`、`connection`、`modules` 和 `client-hmr` 等待
`dshWebLoginReady`。其中 `inject` 数组重述了 `webStartup` 和 `webRuntime`，因为
DSH patch 会替换整个字段，而不是向现有数组追加元素。

本包将 DSH host 与 Cordis 声明为可选 peer，因为正常的 DSH Web 安装一般已经提供它们。

在交互式终端生成密码校验值（密码不会回显）：

```sh
dsh plugin --profile web exec dsh-web-login-hash
```

该命令会向 `${DSH_HOME}/.env` 写入 `LOGIN_PASSWORD_HASH=scrypt$…`；如果未设置 `DSH_HOME`，则写入 `~/.dsh/.env`。它会保留其他环境变量、以原子替换方式写入并将文件权限设为 `0600`，且不会打印密码或校验值。DSH 主目录必须先存在。
如果 bundle 安装在其他名称的 profile 中，请替换命令里的 `web`。

如果 DSH 由服务管理器启动，请确认该进程实际加载这个环境文件。若校验值缺失或格式错误，插件会在启动时失败关闭，而不是暴露未保护的 Web 端口。

启动 profile 前先检查合成结果：

```sh
dsh --profile web --dump-config
```

输出必须包含 `dsh-web-login` 行和上述四个就绪注入。若出现目标行未匹配的警告，说明已安装的 DSH Web 组合发生了变化；应将其视为不兼容，而不是忽略。

修改 bundle 或环境后重启 DSH。浏览器访问 `/` 应跳转到 `/login`；登录后确认 Web UI、API、插件资源和 WebSocket 功能正常。使用无痕窗口或独立客户端确认未登录的 API 和 WebSocket 请求被拒绝。

profile 的后置层可以按 id 覆盖 bundle 行。例如，本机纯 HTTP 开发必须使用较弱的非 Secure Cookie：

```yaml
- id: dsh-web-login
  config:
    secureCookie: false
    title: DSH Web
```

DSH 会用这个 mapping 替换该行的整个 `config`；未写出的插件设置仍由本包填入经过校验的默认值。

## 配置

所有配置都会校验。未知或拼写错误的键会导致启动失败，而不是悄悄采用默认值。

| 键 | 默认值 | 取值范围 | 说明 |
| --- | --- | --- | --- |
| `passwordHashEnv` | `LOGIN_PASSWORD_HASH` | 合法环境变量名 | 保存 `scrypt$<salt hex>$<key hex>` 的环境变量名。 |
| `title` | `DSH Web` | 1–120 字符 | 登录页与浏览器标题。 |
| `secureCookie` | `true` | — | 为 Cookie 增加 `Secure` 属性并启用 `__Host-` 名称。除本机 HTTP 开发外不要关闭。 |
| `sessionTtlMs` | 30 天 | 1 分钟–365 天 | 会话有效期；重启会更早使会话失效。 |
| `maxSessions` | `10000` | 1–1000000 | 最大活跃会话数。满额时新登录返回 `503`，不会驱逐活跃会话。 |
| `maxBodyBytes` | `4096` | 64 B–1 MiB | 登录表单最大字节数。 |
| `sweepIntervalMs` | 5 分钟 | 1 秒–1 小时 | 清理过期会话和限流记录的间隔。 |

#### 登录尝试限流

| 键 | 默认值 | 取值范围 | 说明 |
| --- | --- | --- | --- |
| `attemptLimit` | `5` | 1–1000 | 单个客户端在窗口内触发封锁所需的失败次数。 |
| `attemptWindowMs` | 15 分钟 | 1 秒–24 小时 | 失败计数窗口。 |
| `blockMs` | 15 分钟 | 1 秒–24 小时 | 单客户端封锁时长。 |
| `maxAttemptClients` | `10000` | 1–1000000 | 最大限流记录数。满额时，尚无记录的客户端会被拒绝，而不是不受限地放行。 |
| `globalAttemptLimit` | `100` | 1–1000000 | 一个窗口内**所有**客户端的失败总数，超过后所有登录都会被封锁。 |
| `globalBlockMs` | 1 分钟 | 1 秒–24 小时 | 全局封锁时长。远短于 `blockMs`，因为它同样会误伤运维者本人。 |
| `ipv4PrefixBits` | `32` | 8–32 | IPv4 客户端归入的网段宽度。 |
| `ipv6PrefixBits` | `64` | 32–128 | IPv6 客户端归入的网段宽度。 |

#### 密码哈希

| 键 | 默认值 | 取值范围 | 说明 |
| --- | --- | --- | --- |
| `kdfConcurrency` | `2` | 1–32 | 允许同时执行的 scrypt 计算数。 |
| `kdfQueueDepth` | `8` | 0–1024 | 允许排队等待的登录数。超出后直接返回 `503` 与 `Retry-After`，而不是继续排队。 |

### 密码哈希与事件循环

每次 scrypt 大约消耗 80 毫秒和 16 MiB，而何时触发由未认证的调用方决定。插件把它放到 libuv 线程池上执行，而不是同步执行：同步计算会占住事件循环，拖住的不只是这一次登录，而是 DSH 进程里其余所有请求、WebSocket 帧和定时器。

这只是把问题挪了个位置：线程池默认只有四个槽，占满会饿死 DSH 其余部分的文件与 DNS 操作。`kdfConcurrency` 限制闸门最多占用几个槽，`kdfQueueDepth` 限制最多允许几个请求排队。两者都超出时，登录会立刻收到 `503` 和 `Retry-After`——对单个访客体验更差，但这是洪水场景下唯一能让进程保持可用的结果。

### 限流

失败次数会按客户端统计，同时也独立地在全局统计。前者挡住来自单一地址的爆破；后者是同一攻击者分散到大量地址时的兜底——按客户端统计在原理上就看不见这种情况。

这里的"客户端"是**网段**而不是地址。按单个地址计数根本拦不住持有一个 IPv6 /64 的人——那相当于一千八百亿亿份独立配额——因此地址会先按 `ipv4PrefixBits` 和 `ipv6PrefixBits` 掩码，再作为限流键。所有不是地址的输入都会落进同一个桶，因此攻击者可控的请求头无法凭空造出新身份。

当限流表达到 `maxAttemptClients` 时，尚无记录的客户端会被拒绝而不是不受限地放行。相反的做法是 fail-open：表填满之后，所有新客户端都不受限——而这正是攻击者会主动制造的状态。

### 可信代理和限流

默认 `trustProxy: false`，限流使用直接 socket 地址，客户端无法伪造。只有当 DSH 只能通过**可信代理**访问，且代理会在每一个请求上覆盖转发 IP 头时，才能启用 `trustProxy`。插件采用逗号分隔链中的最后一跳，因为它是代理在看到客户端后追加的值。

```yaml
- id: dsh-web-login
  config:
    trustProxy: true
    clientIpHeader: x-forwarded-for
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `trustProxy` | `false` | 是否使用转发 IP 头进行限流。 |
| `clientIpHeader` | `x-forwarded-for` | 小写头名称，仅在 `trustProxy` 为 true 时读取。 |

若代理只是原样透传客户端带来的 `X-Forwarded-For`，客户端可以伪造限流身份，从而绕过按客户端限流。

### 会话 Cookie

在 `secureCookie: true` 下，Cookie 名为 `__Host-dsh_session`。这个前缀不是装饰：浏览器只有在 Cookie 同时满足 `Secure`、`Path=/` 且没有 `Domain` 时才会接受 `__Host-` 名称，而这三个条件是兄弟子域给父域种 Cookie 时无法满足的。它让"这个 Cookie 来自本主机"变成浏览器强制执行的事实，而不只是本包自己克制不去放宽。

前缀依赖 `Secure`，因此在 `secureCookie: false` 下不可用。该配置是给本机 HTTP 开发用的，会使用不带前缀的名称。

如果同一个名称带着不同的值出现两次，请求会被当作未登录处理，而不是任选其一。Cookie 头里只有名称和值，从更宽作用域种下的 Cookie 在这里与真正的那个无法区分；而浏览器按 path 长度降序排列，"取第一个"恰好会选中本该排除的那个值。退出登录会同时清除两个 Cookie 名称，因此已经升级到前缀名的部署不会残留一个看起来还有效的 `dsh_session`。

## 本地开发

对于仅在本机监听、没有 TLS 的开发环境，可设为 `secureCookie: false`；不要把这个设置带到可从互联网访问的实例。使用单独的开发密码和环境目录：

```sh
mkdir -p "$PWD/.dsh-dev"
DSH_HOME="$PWD/.dsh-dev" dsh plugin --profile web add @seaveyon/dsh-web-login
DSH_HOME="$PWD/.dsh-dev" dsh plugin --profile web exec dsh-web-login-hash --env-path "$PWD/.dsh-dev/.env"
```

CLI 支持 `--env-path PATH` 和 `--var NAME` 来指定开发路径和环境变量名。它拒绝少于 8 个字符的密码，以及超过运行时最大字节长度的密码。

路径参数叫 `--env-path` 而不是 `--env-file`，因为后者被 Node 占用：无论 `--env-file` 出现在命令行的哪个位置（包括脚本路径之后），Node 都会消费它，把指定文件当作 dotenv 文件加载，文件不存在时以状态码 9 退出——而首次运行时它必然不存在，因为这个文件正是本命令要创建的。

执行包内检查。请先安装依赖——类型检查器、测试运行器和打包器都是开发依赖：

```sh
bun install            # 在 workspace 根目录执行
bun run typecheck      # 对 src 与 test 执行 tsc
bun run test           # 先 rslib 构建，再执行 rstest
bun run test:coverage  # 带覆盖率的 rstest，并校验门槛
bun run build          # rslib，bundleless，并生成类型声明
bun run pack:check     # 先构建，再执行 npm pack --dry-run
```

测试集里包含针对解析函数的属性测试（`test/unit/parsing.property.test.ts`），覆盖那些读取攻击者可控字符串的入口：Cookie 头、转发地址头、存储的校验值，以及 `.env` 改写。它们断言的是不变量而不是具体输出——函数是全函数、值能原样往返、放宽网段绝不会把同一个桶拆开——因为这些才是调用方真正依赖的性质。

Lint 与格式化在整个 workspace 只配置一份，请在根目录执行：`bun run lint` 和
`bun run format:check`。根目录的 `bun run check` 会对所有包一并执行类型检查、lint
和格式检查。

CLI 测试会启动 `dist/hash-password.js`，因此需要先构建。`bun run test` 和
`bun run pack:check` 都会先构建；只有直接执行 `bun run test:unit` 时需要确保已有
`dist/`。

## 升级与移除

### 升级

1. 阅读发行说明。
2. 备份现有 profile，并继续妥善保护 profile 和环境文件。
3. 从 bundle 化之前的版本迁移时，删除 profile patch 中手工插入的登录行和就绪依赖；
   只保留类似上文示例的按 id 配置覆盖。现在由 bundle 负责这些行。
4. 从 bundle 化之前的版本迁移时，执行
   `dsh plugin --profile web add @seaveyon/dsh-web-login`；已经由 bundle 管理时，执行
   `dsh plugin --profile web update @seaveyon/dsh-web-login`。然后检查
   `dsh --profile web --dump-config` 并重启 DSH。
5. 在视为升级完成前，测试匿名导航、API/WebSocket 拒绝、登录和退出。

校验值格式为 `scrypt$<salt hex>$<key hex>`。仅在轮换访问密码时重新生成，不需要在常规包升级时重置密码。

### 移除

1. 执行 `dsh plugin --profile web remove @seaveyon/dsh-web-login`；该命令会同时移除依赖和 bundle 层。
2. 重启 DSH，并在暴露服务之前确认替代访问控制已生效。
3. 仅在登录保护层不再配置读取它之后，才从 DSH 环境文件中移除 `LOGIN_PASSWORD_HASH`。

如果没有其他访问控制，移除插件会使 DSH Web 表面根据其监听地址和网络配置可访问。

## 包内容与发布

npm allowlist 只包含构建产物、密码校验值 CLI、可安装的 bundle patch、双语 README、安全策略和 MIT 许可证。测试、`.env`、会话状态和 profile 专属配置均不会进入 tarball。

发布由 `main` 分支自动触发，并使用 npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) 认证，因此每个版本都带有指向其构建 workflow 运行记录的 provenance。在本地安装、测试或执行检查都不会触发 `npm publish`。
