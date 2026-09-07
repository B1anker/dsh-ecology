# @seaveyon/dsh-world-line

A read-only time machine and doctor for DSH profiles: capture the exact
composition state of a DSH profile (manifest, patch layer, workspace and
lockfile, local-plugin receipts), keep it in an append-only content-addressed
vault, diff any two captures — plus an isolated divergence **lab** that verifies a
candidate against a throwaway clone — **Phases 0-3 of the WORLD-LINE-SPEC**.

Lab transactions (candidate add/update/remove/config-patch) run only inside
`labs/<id>` (independent home + pnpm store + process group); successful labs
clean up by default and failures keep a 7-day diagnostic window. Phase 3 adds
the browser client probes (§6 steps 4-6: a fresh Playwright context must reach
the client-ready shell with zero page/console/request errors) and **promotion**
(§7): `lab add --promote` or `lab promote <id>` swaps only the verified
whitelist files of a passed lab onto the official profile — same-filesystem
fsynced staging, atomic rename dance, auto pre/post-promote snapshots, an
append-only promotion journal at `<dsh-home>/world-line/journal.jsonl`, and an
optional `--restart` that re-verifies the official boot and marks the
after-snapshot lastKnownGood (rolling back atomically on failure). A client
probe failure refuses promotion unconditionally; missing/inconclusive client
evidence refuses it unless `--accept-inconclusive`. Read the spec for the
roadmap and the exact acceptance evidence (`docs/compatibility.md`,
`docs/threat-model.md`, `docs/phase2-design.md`, `docs/phase3-design.md`,
`evidence/live-evidence.json`, `evidence/phase2-evidence.json`,
`evidence/phase2-cli-evidence.json`).

## Install / run

```sh
# from this repo (bun workspace)
bun install
bun run --filter @seaveyon/dsh-world-line test:unit

# from the package directory: build, test, verify against a real dsh (if on PATH)
bun test:real
```

The shipped artifact is a plain Node CLI (requires Node >= 22; the CI matrix
also runs 20.19 and 22.12/24 suites):

```sh
dsh-world-line [--dsh-home <path>] [--profile <name>] <command> [--json]
```

`--dsh-home` defaults to `$DSH_HOME` then `~/.dsh`; the default profile is
`web` — nothing here is hardcoded, and nothing writes into a live profile.

The CLI automatically reads `.env` from the selected DSH home before running
a command. Existing environment variables take precedence, including empty
values. A missing `.env` is allowed; an unreadable file stops the command.
Values are parsed as dotenv text (quoted values and literal `$` are supported),
never executed as shell commands, and never assigned to the parent process.
`--dsh-home` selects both the profile home and the environment file; a
`DSH_HOME` entry inside `.env` cannot redirect the command elsewhere.

For lab operations, restore verification labs, and `rescue start`, the runtime
environment uses this precedence (highest first):

1. Existing shell environment variables.
2. `~/.dsh-wl/.env` (optional experiment-specific overrides).
3. `<dsh-home>/.env` (defaults inherited from the selected official home).

An empty value in the experiment file overrides the official value. Files are
read anew for each invocation, not copied or synchronized. The experiment's
`DSH_HOME` always points to its own lab/rescue directory, regardless of entries
in either file. No `.env` file is copied into labs or snapshots.

Use `--no-inherit-env` with lab start/add/update/remove/config, restore, or rescue
start to omit layer 3 from experimental child processes. Shell variables still
apply. Snapshot encryption and promotion (including official restart checks)
continue to use the official environment, never the experimental overlay.
The flag is rejected on commands without an experimental runtime, such as
`lab promote` and `snapshot create`.

For example, with login settings saved in `~/.dsh/.env`, no manual
`--env-file` or shell export is needed. Add only the values you want to override
to `~/.dsh-wl/.env`:

```sh
dsh-world-line lab add '@seaveyon/dsh-web-login@latest' --keep
# Use only shell variables and ~/.dsh-wl/.env for the experimental runtime:
dsh-world-line lab add '@seaveyon/dsh-web-login@latest' --keep --no-inherit-env
```

## Commands (this milestone)

To run an interactive mirror of the current profile:

```sh
dsh-world-line lab start                  # reuse running mirror, resume stopped mirror, or create first
dsh-world-line lab start --new            # explicitly create another mirror
dsh-world-line lab alias <lab-id> my_name  # unique name within this DSH home
dsh-world-line lab start my_name          # start or reuse that specific mirror
dsh-world-line lab list                   # running/stopped status and port
dsh-world-line lab stop <lab-id>          # stop its process, retain its files
dsh-world-line lab destroy <lab-id>       # remove it after stopping
```

`lab start` reuses the newest running mirror for the selected home/profile, or resumes
the newest stopped mirror, keeping its previous port. If that port is occupied,
startup fails instead of silently choosing another port. It creates the first mirror when none exists; use
`--new` to create additional mirrors. Existing instances are retained. Resuming
preserves the mirror’s files and installed dependencies; it loads the current
experiment environment again without recopying settings or stored API keys.

New mirrors copy persistent home data: all settings, API keys and credential
references, GitHub account bindings, conversation history, profiles and plugin
storage. Copies are independent (private files use 0600, directories 0700).
Existing mirrors created before home inheritance are backfilled once on their
next `lab start`; running legacy mirrors are stopped and resumed to load the
inherited state. Existing files and settings values win. Subsequent starts do
not resynchronize data, including data intentionally deleted in the mirror.

Excluded: `world-line/`, dependencies, Git metadata, caches/logs/temp/runtime
files, PID/lock/socket files, derived profile `cordis.yml`, dotenv files, and
authentication sessions/recovery/invitation state. Conversation `sessions/`
are retained; web-login `auth/.../sessions.json` is excluded. Managed credentials
copy API-key records and string references, excluding browser/OAuth grants.
Dotenv still loads via the separate experiment environment, with overrides
from `~/.dsh-wl/.env`. `--no-inherit-api-keys` omits stored credentials on initial
inheritance; combine with `--no-inherit-env` to omit the official dotenv layer.
These flags do not delete credentials already saved in an existing mirror.

Home paths in settings and newly copied Cordis patches are redirected to the
mirror. Internal home symlinks are retargeted; external symlinks are omitted
and listed in `manifest.homeInheritance.skippedLinks` (`lab inspect`). Other
plugin-specific embedded paths and working repositories are not rewritten.
Workspace actions still affect the repositories you choose.

The selected profile's dependencies are installed separately with scripts
disabled and registry lock resolutions retained. Local package links are
materialized into the lab, excluding `.git`, `node_modules`, and `.env`.
Resuming retains installed dependencies. Other profiles' data is copied, but
only the selected profile is installed and started. Copying a live official
home is not a transactional database snapshot.

The printed URL is the per-boot authenticated entry point; keep it private.
Open that complete URL in the same browser where you sign in. Opening `/login`
or the bare address on a new port does not establish DSH BrowserAuth, even if
web-login accepts your password or GitHub identity. `lab start <alias>` retrieves
the current entry URL without restarting an already running instance.
The local web-login plugin automatically scopes its login cookie to each
`WORLD_LINE_LAB` ID. Existing mirrors hold an older plugin copy; create a new
mirror after updating web-login to pick up this fix. Independent non-WL
instances can set distinct web-login `cookieNamespace` values manually.

The mirror keeps running after the CLI exits. A private `service.json` (0600)
stores the local stop credential; neither it nor the entry URL is included in
diagnostic reports. Running mirrors must be stopped before deletion and cannot
be promoted as verified candidates. `lab start` checks host/HTTP readiness;
it does not certify browser plugin compatibility. OAuth callback settings are
copied as configured; use a test OAuth application for a separate callback.

| command | purpose |
| --- | --- |
| `lab start [id-or-alias] [--new] [--no-inherit-env]` | reuse/resume a mirror; `--new` creates another (cannot combine with an ID) |
| `lab alias <id-or-alias> <name>` | assign or rename a unique alias within this DSH home |
| `lab stop <id>` | stop the background mirror, retain the lab files |
| `doctor` | read-only diagnostics over the host + profile + vault; exit 1 when a check fails |
| `snapshot create [--label t] [--break-stale-lock]` | capture the profile into the vault (content-addressed objects + immutable manifest) |
| `timeline list` | snapshots of the current profile, newest first |
| `timeline show <id>` | one manifest (default: latest) |
| `timeline diff <a> <b>` | semantic diff: files, bundles, dependencies, patch entries per layer, derived root, unmanaged files |
| `lab add/update/remove <spec> [--keep] [--allow-scripts]` | apply a candidate inside a fresh isolated lab and verify it (compose → host boot → HTTP ready; `--promote` adds browser client probes + promotion) |
| `lab config apply <patch.yml> [--keep]` | same transaction for a config patch overlay |
| `lab promote <id> [--accept-inconclusive] [--restart]` | promote a retained passed lab (§7): client gate, receipt check, auto snapshots, atomic whitelist swap, journal |
| `lab list` | retained labs, newest first (expired failed labs reaped) |
| `lab inspect <id>` | one lab's manifest and probe records |
| `lab destroy <id>` | remove one lab |

`lab` verbs verify a **known dsh version only** (fail closed); everything but
promotion never writes the official profile, and exit 1 fires when any probe
fails. Promotion writes only the four whitelist files and never lab runtime,
logs, cookies, tokens or the lab home. Lab layout:
`<dsh-home>/world-line/labs/<id>/{home/,pnpm-store/,manifest.json,probe.json,logs/}`.
`restore`, `rescue`, `report` are recognized and refused with their roadmap
phase until the spec's later phases ship.

`-h/--help` prints usage; `-V/--version` prints the package version.

Every command answers `--json` with a `{schemaVersion: 1, command, ok,
data|error}` envelope. Exit codes: `0` ok · `1` verification failed ·
`2` usage/file error · `3` internal invariant error.

## What a snapshot contains

- **Files** (`manifest` = package.json, `profile-patch` = cordis.patch.yml,
  `workspace` = pnpm-workspace.yaml, `lockfile` = pnpm-lock.yaml when present)
  stored by sha256 into `world-line/vault/objects/`.
- **Receipt**: per-file sha256 plus a canonical tree hash over the same set.
- **Derived state**: `cordis.yml` presence and cleanliness against the exact
  boot template of the exercised DSH (it is rewritten on every boot — it is
  *never* snapshotted).
- **Dependencies**: registry/link/file/git/tarball classification, resolved
  versions from the lockfile, and content receipts for local link/file
  plugins (`package.json` + `cordis.patch.yml`, plus git HEAD when the target
  is a checkout).
- **Redaction (invariant 6)**: values under sensitive key names and
  recognizable token/URL/bearer shapes are stored as `<redacted>`; a managed
  file that *carries* secret-shaped content is never persisted to the
  plaintext vault — its hash is recorded with a skip reason (the encrypted
  vault arrives in Phase 4).

`cordis.yml`, `node_modules`, and anything the whitelist does not name are
never captured; unknown extra top-level files are reported as `unmanaged` so
a future restore planner can refuse to drop them silently.

## Locks

One writer per `{dshHome, profile}` (`world-line/locks/<profile>.lock`). A
live lock is never overridden, even with `--break-stale-lock`; a stale lock
(dead holder or foreign host) is refused unless that flag confirms the break.
`timeline` and `doctor` need no lock.

## Layout

```
<DSH_HOME>/world-line/
  state.json            # profile -> latest snapshot id
  locks/<profile>.lock  # writer lock
  vault/
    objects/<sha256>    # immutable content-addressed files
    snapshots/<id>.json # immutable manifests (collision => invariant error)
  labs/                 # Phase 2+
  reports/              # Phase 4+
```

Manifest/format identity: `formatVersion 1` · envelope `schemaVersion 1` ·
package version 0.1.0. Snapshot ids are `snap-YYYYMMDDTHHMMSSZ-<8 hex>`.

## Development

```sh
bun run build       # tsc NodeNext -> dist/
bun test:unit       # rstest, fixture DSH homes only (no real dsh needed)
bun test:coverage   # v8 coverage with ratchet thresholds
bun test:real       # live evidence against a real `dsh` on PATH (skips cleanly otherwise)
bunx tsc -p tsconfig.json --noEmit
```

Tests build real profile layouts in temp DSH homes; none of them touch
`~/.dsh`.

Lab aliases work with `start`, `stop`, `inspect`, `destroy`, and `promote`, and
appear in `lab list`. Names are case-sensitive, 1–64 ASCII letters, digits,
underscores or hyphens; start with a letter or digit and cannot start with
`lab-`. Renaming releases the old name; destroying the lab releases its name.
A duplicate name is rejected, including across profiles in the same home.

In `lab list`, `running` / `stopped` describe persistent mirror processes.
`passed` / `failed` describe a verification run's outcome, not a live server.
`passed` means the recorded checks succeeded; it does not by itself prove all
browser functionality. `runs` counts verification runs; mirrors have `0 runs`
and verdict `-`. Ports on verification labs are historical.

Supervisors started before URL retrieval was added return only a base URL when
reused; their original authenticated link remains usable. Stopping and resuming
such a mirror upgrades its supervisor and prints a fresh authenticated URL.

Set an explicit default mirror per DSH home and profile:

```sh
wl lab default test       # accept an ID or alias
wl lab default            # show the current default
wl lab default --clear    # return to automatic selection
wl lab start              # start/reuse the configured default
```

An explicit start ID overrides the default; `--new` creates another mirror
without changing the default. Alias changes preserve the default because it
stores the lab ID. Destroying that lab clears the default. `lab list` marks
it with `*` in the default column. Without a default, automatic selection
continues to prefer a running mirror, then a stopped mirror.

## DSH Web 世界线视图

World Line 现在同时提供 CLI 和 DSH Web 插件。开发版先构建，再安装到目标实例：

```sh
bun run --filter @seaveyon/dsh-world-line build
# 在目标 DSH_HOME 下安装；省略 DSH_HOME 就是正式环境。
DSH_HOME=/path/to/instance/home dsh plugin --profile web add file:/absolute/path/to/dsh-ecology/packages/world-line --ignore-scripts
```

重启该实例后，点击 DSH **右上角的世界线图标**，悬浮显示提示；进入画布后同一位置变为返回按钮，点击回到原页面。子世界线在此处持续显示当前别名。页面使用宿主的浅色/深色主题，通过 `shell.overlay` 扩展槽挂载，不替换会话或工作区服务。
当前实现的完整宿主验证版本为 DSH `0.1.2-rc.1`。

- 平行时间轴使用 React Flow 展示实例的创建时间和父子分支关系，管理操作统一放在时间点菜单中，移除底部选中卡片。右键菜单采用系统浮层样式，按世界线分支、快照与记录、世界线管理分组；二级菜单自动左右翻转和避开底边，横向空间不足时在面板内进入下一级。画布统一接管右键，菜单位于快照详情上方。
- 拖动画布平移、触控板捏合缩放，左下角可放大、缩小或适应全部世界线。右键轨道上的具体时间点，菜单显示实例别名、时间、状态、端口、来源和当前所在标记，支持 **进入世界线**、**创建旁路分支**、**设为默认世界线**、**修改别名**、**停止世界线** 和 **删除世界线**。
  分支复制当前状态，菜单中的历史时刻只用于定位，不代表历史快照。也可使用节点的省略号按钮，或聚焦节点后按 `Shift+F10`；方向键选择、`Esc` 关闭菜单。窄屏使用可滚动列表和相同操作菜单。
- **沉浸式操作**：顶部图标栏提供搜索、验证实验、刷新、记录、快照、对比与创建；事件抽屉按需展开，画布工具收在左下角图标中。底部时间胶囊可展开拖动，接近事件时吸附，前后按钮跳转事件，方向键按分钟移动、Shift + 方向键跳事件。各条线按稳定 ID 使用 DSH 原生主题色及其混色，不随别名或筛选变化。
- **事件与快照**：轨道上的 `○` 表示创建或最近一次验证记录，`◆` 表示真实配置快照。相邻事件会聚合，点击后可在事件面板逐项查看；回看时保留全部事件，游标之后的记录用淡色虚线标记，仍可点击或右键操作。历史游标绑定真实时间，后台刷新不会使它漂移。
  右键世界线选择 **保存配置快照**，填写用途后保存到该实例自己的快照库；已有 CLI 快照也会显示。
- **从快照分支**：点击或右键快照节点，选择 **从此快照创建世界线**。恢复当时的插件组成、profile 配置与 home patch；会话、账户绑定、模型设置和全局凭据继承来源实例当前状态（配置内敏感字段随快照加密恢复），登录会话仍隔离。
  快照不归档本地插件源码，新快照记录源码指纹；本地源码变化、旧快照缺少指纹、配置内容缺失或无法解密时拒绝分支。分支始终创建独立实例，不覆盖来源。
- **双线对比**：点击顶部入口选择基准与目标，或 `Shift` 单击两条轨道，也可从右键菜单加入对比。显示当前插件版本、依赖声明、安装位置、配置项与文件差异，支持交换方向和重新读取。
  结果不返回密钥、配置原文或本地路径；隔离导致的安装位置变化也会标注。当前版本只比较插件组成与配置，不比较会话内容或模型设置，对比本身不写入配置；合入使用下述独立确认流程。
- **合入主干**：右键目标世界线 → **世界线管理 → 合入主干**，勾选插件，生成隔离候选。依赖安装、配置、启动及浏览器探针全部通过后，再点击 **确认合入主干**。移除插件和同步整个 profile patch 都需单独勾选；未选插件保留，home 配置、会话、模型设置、登录状态不合入。
  合入前自动保存快照；源码、主干或候选变化后要求重新验证。缺少安全密钥服务导致配置备份不完整时拒绝合入。写入异常会回退，旧依赖树保留在 profile 的 `.wl-before-merge-*` 目录。合入不会自动重启正式服务，重启后加载新能力。
  本地源码固定在管理根目录的 `world-line/merges/<id>/packages`，不依赖可清理的验证 lab。不要删除已合入候选的 artifacts；没有自动清理合入记录。管理插件本身不支持此入口自我替换，请通过发布或 PR 更新。验证未通过时不会提供强制合入。浏览器验证需要 Chrome，或用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium；运行时随插件安装 `playwright-core`，不会自动下载浏览器。
  CLI `lab promote` 仍用于已验证的一次性实验；持久世界线通过上述流程重新组合、验证后合入。已有运行中的旧后端需重启才能显示合入入口，也可以直接在新版主干画布操作。
- 分支通过平滑弧线连接父子轨道；运行节点保持呼吸光环与轨道流光，停止节点为静态虚线。尊重系统减少动态效果设置，页面隐藏时暂停动画。
- **进入世界线**会在新标签页展示潜行过渡：目标定位、通路校准、加速进入。动画使用宿主主题色，只有目标实例就绪后才跳转；可跳过动画或取消进入（不会停止实例）。减少动态效果时使用静态提示，弹窗被阻止时提供手动进入链接，连接失败时保留错误和返回入口。
- 创建提交后暂停后台轮询、取消未完成的旧刷新，并保持提交中的别名校验中性，避免新实例出现时将自己的别名误报为重复；服务端仍检查唯一性。
- 默认显示持久世界线；**验证实验**可展开一次性的验证 lab。`passed` 是验证结果，不等于进程仍在运行。
- 从某条世界线分支，会独立复制该实例当前的 home、配置、历史与 API 密钥，保留父实例。
  沿用现有继承排除规则，不复制认证会话、运行文件和缓存。运行中数据库的复制不保证事务快照一致性。
- 时间指针用于观察创建/分支时刻；当前分支操作复制现态，不能恢复指针所指的历史数据。
- 为避免关闭当前管理连接，页面拒绝停止/删除自己所在的实例。请在另一实例操作。
- 默认配置和别名与 CLI 共用。默认绑定实例 ID，改名不影响默认选择。
- **避免套娃**：镜像通过 `WORLD_LINE_MANAGER_HOME` 找到同一管理根目录；缺少环境标记时，也能从标准 lab home 路径推导根目录。子实例再次安装插件只会打开同一张图，分支是同级隔离目录，不会递归复制管理库。错误的父根指向会被拒绝，继承也排除运行备份目录。旧后端需重启后获得这项保护。
- 管理 API 复用 DSH 原生浏览器认证及 Host/Origin 检查；写操作另要求同源 JSON 请求。
  安装 web-login 时还会经过其登录门禁。API 列表不返回凭据或启动 token。
- 这是本机实例管理界面；进入实例使用本机 loopback 地址。反向代理的跨实例路由尚未实现。

也可以从 CLI 创建带别名的子世界线：

```sh
wl lab fork test oauth-fix
wl lab start oauth-fix
```

分支关系存于子实例的 `manifest.json` → `source.parentLabId`，分支时间为 `createdAt`。
没有父实例记录的旧 lab 显示为从 `main` 来源环境创建；来源环境行不是可停止的镜像进程。
