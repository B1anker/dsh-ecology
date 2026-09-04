# `@seaveyon/dsh-world-line` 实现规格

状态：待实现  
受众：接手实现的 agent / maintainer  
语言：TypeScript（Node.js 22+）  
交付物：独立 CLI；不是会加入 DSH Web Loader 的普通插件。

## 1. 产品定义

`dsh-world-line` 是 DSH profile、插件和组成配置的安全变更管理器。

- **当前世界线**：正在使用的正式 DSH profile。
- **分歧世界线**：从正式 profile 派生的隔离实验副本，用于安装或配置验证。
- **稳定世界线**：曾通过完整浏览器启动验收的 `lastKnownGood` 快照。
- **世界线档案**：针对 DSH 自身组成的 Time Machine 式本地快照、差异与恢复记录。

它解决的问题是：第三方 DSH 插件可能修改依赖、Cordis bundle patch 或浏览器 client
依赖图。即使 DSH 进程和 HTTP 端口仍正常，错误 external、inject、Loader entry 或
client service 注册也可能令整个 Web UI 显示 `Failed to load plugins`。直接执行
`dsh plugin --profile web add ...` 会先污染正式 profile，之后才看到错误。

## 2. v1 目标与边界

### 必须实现

1. 在不停止、不修改正在运行的正式 DSH 条件下，根据指定 profile 创建隔离副本。
2. 在副本中执行插件 add / update / remove 和候选配置变更。
3. 验证静态组成、DSH host boot 与真实浏览器 client boot；端口监听不等于成功。
4. 只有在验证通过时，才能以事务方式将变更提升到正式 profile。
5. 维护可回退的 profile / 插件组成 Time Machine；恢复一律先在副本验证。
6. 正式 DSH 无法启动时，仍可用独立 CLI 诊断、救援和恢复。

### 明确不做

- 不是恶意 npm 包、install script 或普通插件代码的 OS 级沙箱；副本模式保护 DSH
  状态，不等于隔离不可信代码。此类代码应在 VM/容器运行。
- 不默认备份用户项目文件、Git 工作区、所有 DSH sessions、浏览器 cookie 或 OAuth
  token。
- 不拦截用户绕过本工具直接运行 `dsh plugin`。
- 不 monkey-patch DSH 内部 Loader，也不替代宿主应提供的逐插件 fault isolation。
- 不自动完成真实外部 OAuth 流程。实验副本必须使用自己的 loopback URL，不能把生产
  回调成功作为通过标准。

## 3. CLI 契约

包名：`@seaveyon/dsh-world-line`  
二进制：`dsh-world-line`（可选短别名 `world-line`）

```text
dsh-world-line [--dsh-home <path>] [--profile <name>] <command>
```

默认 DSH home 为 `~/.dsh`，默认 profile 为 `web`。不得硬编码 home、端口、token、
DSH 内部包路径或 CLI flag。

### 分歧实验室

```sh
# 只在隔离副本验证；默认不会改正式 profile。
dsh-world-line lab add dsh-git-worktree@0.7.3
dsh-world-line lab update <package>
dsh-world-line lab remove <package>
dsh-world-line lab config apply ./candidate.patch.yml

# 只有显式提升才能写正式 profile。
dsh-world-line lab promote <lab-id>
dsh-world-line lab add --promote some-plugin@1.2.3

dsh-world-line lab list
dsh-world-line lab inspect <lab-id>
dsh-world-line lab destroy <lab-id>
```

成功 lab 默认清理，失败 lab 保留诊断 7 天；`--keep` 保留成功 lab，`--open` 才允许
自动打开浏览器。

### 世界线档案

```sh
dsh-world-line snapshot create --label "before marketplace test"
dsh-world-line timeline list
dsh-world-line timeline show <snapshot-id>
dsh-world-line timeline diff <snapshot-a> <snapshot-b>
dsh-world-line restore <snapshot-id>
dsh-world-line restore --last-known-good
dsh-world-line restore <snapshot-id> --promote
```

`restore` 默认只创建并验证恢复 lab；只有 `--promote` 才写正式 profile。每次 promote
和 restore promote 前均须自动创建 `pre-promote` 快照。

### 诊断和救援

```sh
dsh-world-line doctor
dsh-world-line doctor --json
dsh-world-line rescue start
dsh-world-line rescue stop
dsh-world-line report <lab-id-or-snapshot-id>
```

`rescue start` 创建临时安全 profile，只加载版本策略定义的 DSH core 行和用户明确
allowlist；它不能删除、重写或原地禁用正式 `cordis.patch.yml`。

所有命令支持 `--json`，输出带 `schemaVersion` 的机器可读 envelope。验证不通过退出码
为 1，调用/文件错误为 2，内部不变量错误为 3。

## 4. 不变量

1. **未提升，正式 profile 不变。** lab 与正式实例必须有不同目录、端口、PID、home、
   package-manager 可写 store。
2. **验证必含浏览器。** `hostReady` 不能单独代表通过，必须有 `clientReady`。
3. **核心层不可静默跳过。** rescue 只能跳过可选/用户插件；连接、runtime、module
   loader、layout、settings、workspace/conversation 和认证等核心行由版本策略列出。
4. **单 writer。** 每个 `{dshHome, profile}` 有排他锁；活锁不能自动覆盖。
5. **提升/恢复是事务。** 同文件系统 staging、fsync、rename；失败后正式 profile
   必须完整保留。
6. **秘密不能出现在 stdout、report、diff 或普通 manifest 中。**
7. **未知 DSH 版本 fail closed。** 只允许只读 doctor/snapshot，不允许猜测参数并
   执行 lab/promotion。

## 5. 存储模型

以 `<DSH_HOME>` 为根（默认 `~/.dsh`）：

```text
<DSH_HOME>/world-line/
  state.json
  locks/<profile>.lock
  labs/<lab-id>/
    profile/
    home/
    pnpm-store/
    manifest.json
    probe.json
    logs/{dsh.log,browser.log}
  vault/objects/<sha256>
  vault/snapshots/<snapshot-id>.json
  vault/secrets/<snapshot-id>.bin
  reports/<report-id>.json
```

每份 lab/snapshot manifest 至少记录：格式版本、DSH CLI 版本、Node/OS/架构、创建时间、
父快照、动作、候选来源、profile receipt、lockfile 哈希、验证结果和保留期。

### 快照内容

快照采用显式白名单，而非递归复制整个 DSH home：

- profile 的 `package.json`、lockfile、`cordis.patch.yml` 和组成所需的常规配置；
- 本地 `link:` / `file:` 插件的绝对路径、Git HEAD（若存在）、内容哈希；
- 包的 resolved URL、version、integrity 和 lockfile。

`node_modules` 不是快照真相；恢复时以 lockfile 重装。可选
`--vendor-local-plugin` 将本地插件归档到内容对象库，以保证以后可恢复。

默认不保存 cookie/token/password/OAuth secret。必须保存的秘密只写入加密 vault：
AES-256-GCM，macOS 密钥存 Keychain；无安全密钥服务的平台默认跳过敏感文件，而不是
明文保存。

## 6. Lab 生命周期

### 创建与候选安装

1. 获取 profile 写锁，计算正式 profile 的 `sourceReceipt`。
2. 生成 lab ID、随机空闲 loopback 端口，建立 `labs/<id>`。
3. 将 profile 白名单文件复制到 `labs/<id>/profile`；不可 hard-link 可写文件。
4. 创建独立 lab home 和 package-manager store；正式 profile 不能是写目标。
5. 在 lab 应用候选 add/update/remove/config patch。
6. 默认以 `--ignore-scripts` 安装。若包需要构建脚本，报告 `requires-script`；用户
   需显式 `--allow-scripts`。该选项不代表安全沙箱。
7. 覆盖实验 port/public URL，写入 `WORLD_LINE_LAB=<id>`。不得复制生产浏览器 cookie。
   Web login/OAuth 插件必须改用实验 loopback URL。

### 通过标准

每步写入 `ProbeResult`：check ID、required、startedAt、finishedAt、状态、redacted
错误链、关联 plugin/loader entry。

1. **compose**：通过 host adapter 运行等价 `--dump-config`，解析活跃 entries；拒绝
   重复 ID、无效 patch、缺包、明确 inject/external cycle。
2. **host boot**：用 lab profile/home/port 启动 DSH；超时只能杀 lab PID 及其子进程组。
3. **HTTP ready**：确认 local URL 可达，仅记录 `hostReady`。
4. **browser boot**：Playwright 用新的无缓存 context 打开实验 URL（仅该实例 token）。
   收集未处理 page error、console error、页面 boot diagnostics、DOM 与核心服务状态。
5. **core contract**：workspace、conversation、settings、connection 等核心 UI 均 ready。
6. **candidate contract**：声明 client 的插件必须 bundle load、factory registration、
   materialize、apply 成功；server-only 插件不因没有 client entry 而失败，但不得让
   core 退化。

server 健康而 client 失败必须是失败。无法取得可靠浏览器就绪信号为 `inconclusive`，默认
不得 promote；仅 `--accept-inconclusive` 可由用户承担风险继续。

## 7. Promotion 与恢复

### Promotion

1. 比较 lab `sourceReceipt` 和当前正式 profile receipt；不一致即拒绝，避免覆盖实验
   期间的外部改动。
2. 自动创建 `pre-promote` 快照。
3. 把 lab 已验证的组成文件复制到正式 profile 同文件系统 staging；不复制 lab runtime、
   日志、cookie、token 或 home。
4. 原子替换受管理文件并写 journal `committed`，再创建 after snapshot。
5. 默认不重启现有正式 DSH。只有显式 `--restart` 才重启；重启后完整 browser probe
   通过才标为 `lastKnownGood`。失败则原子回写 pre-promote snapshot。

### Time Machine

```text
captured -> staged -> validated -> promoted -> lastKnownGood
                   \-> rejected / restored
```

快照 manifest 不可变，内容对象按 SHA-256 去重。默认保留：最近 20 个、每日 14 个、
每周 12 个；清理先显示计划并确认，且不能删 parent 或 `lastKnownGood` 引用对象。

`timeline diff` 输出版本、patch entry、配置和本地插件 receipt 的语义差异，秘密均脱敏。
`restore` 始终 lab-first；恢复失败不得改变正式 profile 或删除旧 vault 历史。

## 8. HostAdapter

DSH 处于快速演进阶段，CLI 参数、profile 结构、ready endpoint、boot wire 都可能变化。
所有版本敏感逻辑必须只存在于 `src/host-adapters/`：

```ts
interface HostAdapter {
  detect(dshBinary: string): Promise<HostVersion>
  compose(profile: string, home: string): Promise<ActiveComposition>
  launch(input: { profile: string; home: string; port: number }): Promise<RunningDsh>
  launchUrl(running: RunningDsh): URL
  browserProbe(url: URL, composition: ActiveComposition): Promise<ProbeResult>
  coreEntries(composition: ActiveComposition): CorePolicyResult
}
```

首个 adapter 只支持实现时使用真实临时 profile 验证过的 DSH 范围。实现 agent 必须先检查
真实 `dsh --help`、`dsh plugin --help`、`dsh --profile web --dump-config`，再确定 adapter；
不得把本机当前端口/token/内部依赖路径写死。

## 9. 工程结构

```text
packages/world-line/
  src/
    cli.ts
    commands/{lab,timeline,snapshot,restore,doctor,rescue}.ts
    domain/{profile,composition,receipt,probe,snapshot,journal,redaction}.ts
    lab/{create,install,launcher,promote,cleanup}.ts
    vault/{objects,manifest,crypto,retention}.ts
    host-adapters/{types,detect,dsh-0.1.x}.ts
    browser/{probe,playwright}.ts
    fs/{atomic,lock,paths}.ts
  test/{unit,integration,fixtures}/
  docs/{threat-model,compatibility}.md
  package.json
```

该包不声明 `dsh.client` 或 `dsh.bundle`，也不在正式 DSH 进程内注册服务。未来可增加本地
管理 UI，但 rescue/restore 不能依赖该 UI。

## 10. 自动化验收

测试必须使用临时 DSH home，不能依赖真实用户 `~/.dsh`：

1. server-only 插件 lab 通过，正式 profile receipt 在 promote 前保持不变。
2. 模拟缺失 external 的 client bundle：browser probe 失败，正式端口/PID/profile 不变。
3. 模拟缺 inject、重复 loader ID、重复 client service：诊断应给出阶段与 entry ID。
4. hostReady 且 browser boot 失败时必须拒绝 promotion。
5. 实验过程中修改正式 profile，promotion 应因 receipt mismatch 拒绝。
6. 成功 promotion 产生前/后快照，diff/report 不泄露秘密。
7. `restore --promote` 先验 lab；lab restore 失败时正式 profile 不变。
8. `rescue start` 不改正式 patch，仅启动临时 home/port。
9. 活锁不能覆盖；stale lock 需用户确认才清理。
10. macOS/Linux/Windows 路径、子进程清理、Keychain 不可用时的安全降级均有测试。

## 11. 分阶段实施

### Phase 0：契约探索

- 在隔离临时目录建立真实 DSH HostAdapter evidence。
- 记录 CLI/profile/bundle/browser boot 合约与支持版本。
- 复用并补充现有 `plugin-testkit` 的 client-loader 失败 fixture；不得触碰未提交的
  其他包改动。

### Phase 1：只读 Vault 与 Doctor

- 实现路径、锁、receipt、redaction、内容对象库和 manifest。
- 完成 `snapshot create`、`timeline list/show/diff`、`doctor --json`。
- 此阶段不允许任何 restore promotion。

### Phase 2：Lab 静态验证和 Host Boot

- 实现 profile clone、候选 package transaction、子进程生命周期与 cleanup。
- 完成 compose、host readiness；未知结果 fail closed。

### Phase 3：浏览器验收和 Promotion

- Playwright client boot probe。
- lab promote、journal、pre-promote snapshot、receipt conflict check。

### Phase 4：Restore 与 Rescue

- 完整 lab-first restore、lastKnownGood、safe profile builder、加密 vault、诊断包。

### Phase 5：产品化

- 跨平台 CI、兼容矩阵、保留策略、故障恢复文档。
- 只有 CLI/救援稳定后，再评估可选本地 Web UI。

## 12. 给接手 agent 的首条任务

在本 worktree 创建 `packages/world-line`，先交付 Phase 0 和 Phase 1：真实 HostAdapter
契约证据、只读 snapshot/timeline/doctor。不要先做 UI 或自动安装；不要写真实用户 profile
或改 DSH 本体。提交前运行根 `bun run check`、新包单元测试，并提供临时 DSH profile 的
真实验证证据。
