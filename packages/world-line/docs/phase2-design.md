# Phase 2 设计契约（Lab 静态验证与 Host Boot）

依据 WORLD-LINE-SPEC §3/§5/§6/§8/§11（Phase 2）与真实 DSH 0.1.2-rc.1 实测。

## 实证契约（真实 dsh，2026-09-04 复验，全部离线可行）

1. **启动**：`dsh --profile <name> --port 0 --no-open`，env `DSH_HOME=<lab home>`。
   就绪 = stdout 首行匹配 `/^dsh web: (http:\/\/\S+)/`（`dsh-web-app` 在 loader
   settle + webServer/connection 就绪后才打印，URL 携带每次启动随机 `?token=`）。
2. **HTTP ready**：GET 该 URL 属 Phase 2 上限（浏览器探针是 Phase 3）；只记录
   `hostReady`。token 属秘密：lab manifest 永不存 URL/token，只存 `port` + host。
3. **插件管理**：`dsh plugin --profile <name> <pnpm args...>` 是真实 pnpm 转发器
   （cwd=profile 目录，pnpm 需在 PATH；相对路径按调用 cwd 锚定，绝对路径直通）。
   安装成功后按「已装依赖声明 `dsh.bundle.patch`」调和 `dsh.profile.bundles`
   （追加依赖序；bundle 资格随版本变化可进退）。pnpm flag 直通：
   `--ignore-scripts --store-dir <lab>/pnpm-store` 实测生效（独立 store 在 lab 内）。
4. **离线候选**：`add file:<绝对路径>` 实测成功（零依赖插件；真实仓库插件需先构建
   dist，或走 registry——证据用自建零依赖 fixture）。
5. **compose 验证**：`dsh --dump-config` 输出 YAML 合成树（`# == <bundle>` 分段 +
   patch 行）。实证：bundle patch 中 `{id: x}` 引用不存在 entry ⇒ dsh 报
   `patch: entry "x" not found`（无效 patch 探测信号）；新 id 必须用 `insert:`。
6. **web app flags**：`--host`（拒绝 0.0.0.0）、`--port`（0=OS 选）、`--no-open`、
   `--trusted-host`；`--help` 均可用（契约由 startup.js 内嵌 commander 提供）。
7. **lab 隔离**：DSH_HOME=<lab home> 全程独立；pnpm 只写 lab profile 目录与
   lab store；不复制浏览器 cookie/session（Phase 2 不产生浏览器状态）。

## 目录与文件（并入现有包）

```
src/domain/probe.ts          # ProbeResult/状态机/汇总（§6 通过标准记录）
src/lab/layout.ts            # labs/ 根、lab id、profile/home/store/logs 路径、列出
src/lab/manifest.ts          # LabManifest（§5 字段）+ lab probe.json 读写（原子、脱敏）
src/lab/create.ts            # 克隆：锁→sourceReceipt→白名单拷贝→home 骨架→manifest
src/lab/plans.ts             # 候选计划 add/update/remove/config-apply 类型与执行结果
src/lab/runner.ts            # 真实 dsh 子进程运行器（plugin 转发/dump），需脚本检测
src/lab/compose.ts           # dump 解析→ActiveComposition→重复 id/注入环/无效 patch
src/lab/launcher.ts          # host boot：spawn(进程组)→URL→HTTP ready→组内终止
src/lab/cleanup.ts           # 销毁 lab（含运行中进程组），失败保留 7 天策略
src/commands/lab.ts          # lab list/inspect/destroy + add/update/remove/config apply
```

## 状态机与生命周期（§3/§6 语义）

```
created -> applying -> probed(compose+hostBoot) -> pass: 默认清理(记摘要)；--keep 保留
                                   \-> fail: 保留 7 天诊断（expiresAt），destroy 可提前清
```

- `lab add <pkg>` 等候选运行全程持官方 profile 写锁（与 snapshot 同锁路径），
  sourceReceipt 为运行起点官方 receipt；结束释放。锁内无任何官方文件写入。
- 默认 `--ignore-scripts`；安装输出含 build-scripts 信号时记 `requires-script`，
  无 `--allow-scripts` 则候选状态 blocked（不 boot）。
- 未知/缺失 dsh 版本：lab 命令一律拒绝（fail closed，invariant 7）；promote 仍
  Phase 3 门禁；`--json` 信封与退出码 0/1/2/3 沿用。

## LabManifest（至少）字段（§5）

formatVersion 1 · kind 'lab' · id `lab-<stamp>-<hex8>` · createdAt · profileName ·
dshHome · state · plan{action,spec,source} · candidateSummary · sourceReceipt
（官方白名单 hashes）· dshFacts{cliVersion,known,adapterId} · probes 摘要
{compose,hostBoot} 状态（完整 ProbeResult 在 probe.json，manifest 只存脱敏摘要）·
port(仅数字) · expiresAt? · createdBy{worldLineVersion,environment}。
lab manifest 不可变除 state/expiresAt 由 owner 文件原子推进；损坏读取报
E_INTERNAL(3)（对齐 vault 语义）。

## 本里程碑边界（不做）

promote（Phase 3）、浏览器探针（Phase 3）、restore/rescue/report（Phase 4）、
加密 vault（Phase 4）、journal committed 写入（Phase 3 起）、`--open`（Phase 3）、
Windows Keychain。lab 目录在 world-line 下 → 真实 profile/DSH home 永不写入。

## Phase 2 交付状态（2026-09-04，PR 附）

全部叶模块 + CLI 接线完成，单元 118/118、CLI 真机证据 14/14、runner 证据 9/9。

- **CLI 语法（§3 全量）**：`lab add|update|remove <spec> [--keep] [--allow-scripts]`、
  `lab config apply <patch.yml> [--keep]`、`lab list|inspect <id>|destroy <id>`；
  全命令支持 `--json`（schemaVersion 信封）。退出码：0 通过 / 1 验证失败
  （compose/boot/HTTP 任一 fail）/ 2 用法与文件错误（含版本门禁拒绝）/ 3 内部错误。
- **一条交易 = 一个 lab**：版本门禁（未知 dsh fail closed）→ 官方 profile 写锁 →
  白名单字节拷贝 + 独立 home/pnpm store → 候选应用（plugin 转发）→ compose 静态
  验证 → host boot（真实 dsh、随机回环端口、超时仅杀 lab 进程组）→ HTTP ready
  探测 → 结果落 manifest/probe.json。`create` 阶段不保留任何 `created` 残留：
  候选应用与 config-apply 均在同一 lab 上完成（修复了早期 config apply 双创建）。
- **保留语义实测**：成功默认删除 lab（含 manifest/probe.json）；`--keep` 保留；
  失败保留 7 天（expiresAt），list 自动 reap 过期失败 lab；`destroy` 拒绝 mid-run。
- **本地候选**：`file:`/`link:` 绝对路径离线可用；bare `./path` 拒绝并提示加前缀；
  `@scope/name` 裸名可作 remove 目标。
- **remove/update 语义（保守）**：lab 克隆自官方 profile —— profile 本无该包时
  pnpm `remove`/越范围 `update` 如实失败（exit 1 + 保留 7 天），不改官方 profile
  即无 PASS 前提；这是不改真实环境的正确失败语义。
- **已知边界**：config-apply 覆盖文件复制进 lab（lab 外不留候选文本）；plan 内
  本地路径 redact 为 basename；URL/token 从不落盘（manifest 只记 port）。
