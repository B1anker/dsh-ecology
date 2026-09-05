# 交接:pet-desktop Windows 拖拽抖动(已修复,待复测确认)

> 2026-09-05。给下一位接手的 agent:背景、已完成工作、已排除的嫌疑、根因、操作速查。
> 请先读完本文再动手;不要重复已做过的验证。
>
> **状态(第六轮):修复生效 —— 用户在 v5 包上反馈"好像没问题了"。**尚未收到验证日志,所以 §5.2 的验收判据还没被数据确认过;若要彻底收尾,拿一份 `-Ddrag-diag` 构建的日志核一下 `move gaps` 直方图即可。
>
> 一句话根因:**跟手 61Hz 时平滑,38Hz 时抖**。61Hz 只在拖拽事件流活着时才有;而**换向那一下的快速扫动会让指针跑出窗口命中区,runtime 从此永久停止派发拖拽事件**,跟手掉回那个只有 40Hz 的 `WM_TIMER` 轮询 —— 这就是用户说的"第一个方向没问题,换向之后才有问题"。§4 有逐时间窗的实测表。
>
> 修复:事件流会中途死掉,所以**轮询自己必须跑够 60Hz**。第五轮想用 `timeBeginPeriod(1)` 把栅格缩小到请求周期之下 —— 实测无效(§3)。**第六轮反过来:把请求周期压到一个栅格槽之下(`drag_poll_interval_ms` 16 → 10ms)**,这样每个栅格 tick 都到期,轮询变成规整的 ~64Hz。这一行就是全部修复内容,§5.2 有栅格算术。
>
> 另外两件配套的事:① 窗口化构建**自动把日志写到 exe 同级的 `dsh-pet-desktop.log`**,不用再走命令行重定向(§1、`src/runlog.zig`);② 手势级输入诊断收进了 `-Ddrag-diag` 开关,默认关(§1、`src/diag.zig`)。
>
> 已结案、别再查:镜像条带内容(逐帧包围盒实测对称,§3)、状态机、DPI 重采样、`pptDst` 回拽、方向相关性、trace I/O、`timeBeginPeriod`(§3)。

## 0. 仓库与分支状态

- 仓库:`/Users/seavey/code/dsh-ecology`(monorepo,bun + zig)。
- 分支:`feat/pet-windows`,PR #21(https://github.com/B1anker/dsh-ecology/pull/21)。
- 已推送的提交:
  - `a65abde` fix(pet): 内置花名册补 ai-sleepy-silver-wolf + demo.gif 重生
  - `daffd24` feat(pet,pet-desktop): Windows 支持(移植主体)
  - `46f576c` fix(pet-desktop): 预镜像跑步条带(修"右拖仍显示朝左动画")
- **工作区有未提交改动**:
  - `src/win32.zig`:DPI 归位修复(第二轮,归位本身已正常,可以留)。
  - `src/model.zig`:含多轮内容,注意甄别 —— ① 调试日志(`drag start`/`facing flip`/`hover enter|leave`,第二轮加的,是定位根因的关键证据,建议留到验证通过);② 第二轮的"拖拽事件不再移窗"(**已被第三轮推翻**);③ 第三轮的 `followPointer` + 时间闸门 + `drag_moves`(**必要但不充分,见 §4.5,别回滚**);④ 第五轮的 `beginPreciseTimers` 调用点 + `move_gaps` 直方图(直方图是本轮的主要读数,留着);⑤ 第六轮的 `drag_poll_interval_ms = 10`(**当前待验证的改动**,§5.2)。
  - `src/win32.zig` / `src/windowing.zig` / `src/appkit.zig`:第五轮新增 `beginPreciseTimers`/`endPreciseTimers`(§5.1;第六轮改成回报 bool,好让日志说清当时跑在哪个栅格上)。
  - `src/runlog.zig`(新文件)+ `src/main.zig` 一行调用:窗口化构建自动落盘日志(§1)。
  - `src/persist.zig`:抽出 `appDataPath` 供 `statePath`/`logPath` 共用;`state save failed` 改成每次运行只报一次(§1 的日志有界性)。
  - `src/diag.zig`(新文件)+ `build.zig`:手势级输入诊断的 `-Ddrag-diag` 开关(§1)。`build.zig` 从 `addApp` 换成 `addAppArtifacts`,只为拿到 exe/tests 好注入 `build_options` 模块。
- 工作区还有 `packages/web-login/` 的 4 个文件改动,**与本任务无关,不要动**。

## 1. 环境事实(已核实)

- 桌面 App:`packages/pet-desktop`,Zig 0.16.0 + zero-native SDK(锁定 commit 5665a35,SDK 源码在 `packages/pet-desktop/zig-pkg/native_sdk-0.1.0-hzDzQsgTsgLYuia25nP8kRXdGyfVgpwLVmdAsMzdCAxE/`)。
- 交叉构建:macOS → Windows 用 `zig build -Dtarget=x86_64-windows-gnu`(SDK 构建图拒绝 msvc ABI)。zig 在 PATH(mise)。
- Windows 目标机:`seaveyluo-pc0`,**4K 屏 150% DPI**(3840×2160,192pt 窗口 = 288 物理像素)。
- 发文件到 Windows:taildrop 技能,`/Users/seavey/.agents/skills/taildrop/scripts/taildrop.sh send --target seaveyluo-pc0 -- <file>`。
- **窗口化构建双击运行时没有控制台**,所有 `std.debug.print` 会消失。`src/runlog.zig` 在 `main` 的第一行处理:**stderr 没有去处时**才把 stdout/stderr 指向 `<app-data>/dsh-pet-desktop.log`,和 `state.txt` 同目录(`persist.appDataPath`,即 Windows `%LOCALAPPDATA%\dsh-pet-desktop\`、macOS `~/Library/Application Support/dsh-pet-desktop/`),每次运行覆盖重建。**双击就有日志**;而 `cmd /c "pet.exe > log.txt 2>&1"` 或终端里跑这种已经有去处的运行照旧,不会一份输出劈成两处。
  - 能改到的原因:`std.Io.File.stderr()` 在 Windows 上读 `peb().ProcessParameters.hStdError`(正是 `SetStdHandle` 改的字段),在 POSIX 上读 `STDERR_FILENO`(正是 `dup2` 重绑的东西)。第一次打印之前动手,后面连 SDK 的打印一起跟着走。
  - **两个平台的判据必须不一样**(实测,别想当然合并):Windows 给脱离控制台的进程一个**空句柄**,所以"能写吗"自己就能回答;macOS 的 `launchd` 给双击的 `.app` 一个**完全有效的 fd 2,指向 `/dev/null`**(`st_rdev` 与 `/dev/null` 相同,`write` 返回字节数),"能写吗"会答"能",于是判据必须换成"stderr 是不是黑洞"。另外 `std.c.stat` 在 Zig 0.16 的 macOS 上编译不过(映射到 darwin 没有的 `private.stat`),所以 `/dev/null` 的设备号是 `open` + `fstat` 拿的。
  - **日志大小有界,不需要轮转**:每次运行截断重建,且发布形态里没有常态写入者 —— 每次 POST 一行的 `state #N` 收进了 `-Ddrag-diag`,跟它同路的两个错误(`state save failed`、`unknown petId`)各自只报一次。macOS 实测:启动完 15 行 / 987 字节,之后不再涨。
  - **⚠️ 上面这句只在 `-Dtrace=off` 的构建上成立。** SDK 的 `-Dtrace` 默认是 `.events`,会按派发的事件写行(**含每一个呈现帧**):实测启动一次就写 6KB,之后约 300 字节/秒且不封顶。所以 `-Dtrace=off` 不只是"日志好读"的问题,是打包的硬要求(§7)。
  - **兜底:1MB 硬上限**(`runlog.max_bytes`)。挂在帧定时器上,每次 tick 查一次文件大小(`fstat`/`GetFileSizeEx`,一次约 1µs,idle 时 1.1 秒一次);超限就写一行说明、把 stderr 转到空设备,**保留文件头部**(启动那 15 行才是有用的,后面淹上来的是噪音)。实测(故意把阈值调到 8KB + trace 开着):t=6s 越线、t=9s 封顶于 8524 字节(超出 332 字节 = 一个帧节拍的写入量),之后 12/15/18 秒完全不再增长,说明行只出现一次。
    - 为什么必须靠运行时兜底、不能在构建期拦:app 的 `build.zig` **读不到 `-Dtrace`**(重复声明同名选项会 `panic: Option 'trace' declared twice`,实测);SDK 把值放在自己的 `build_options` 里没有 accessor;而它那个 sink 虽然叫 `StdoutTraceSink`,内部用的是 `std.debug.print` 也就是 **stderr**,和我们的打印同一个流,所以连"按流分开"都做不到。
    - 排查这类问题时注意:**先 `pkill -f dsh-pet-desktop` 清残留**。我在验证上限时被残留进程坑过两次(旧进程仍持有被 `rm` 掉的旧 inode,读出来的日志会出现重复/截断的说明行),干净重跑后行为完全正常。
- **手势级输入诊断由 `-Ddrag-diag` 控制,默认关**(`src/diag.zig`)。开关后面是 `drag start`/`drag end`/`move gaps`/`drag poll`/`hover enter|leave`/`facing flip`/`press #` —— 只在拿着秒表看日志时才有意义、且高频(移窗最高 77Hz)的那些。`enabled` 是 comptime bool,所以不带开关的构建里连字符串和 `move_gaps` 直方图的累计都不存在(实测 release exe 里搜不到 `move gaps ms`)。素材加载、状态桥、服务器、持久化失败这些**生命周期与错误打印保持无条件** —— 那才是现场报告需要的,而且一次运行只出现一次。
- **两个打包 exe 的区别**(以前只是优化模式不同,现在才有实质区别):`pet-*-debug.exe` = ReleaseFast + 调试符号 + `-Ddrag-diag`;`pet-*-release.exe` = ReleaseSmall,诊断编译掉。注意 **"debug" 包其实不是 Debug 构建** —— SDK 的构建图把 app exe 的默认优化模式定为 `ReleaseFast`(`build/app.zig:1762`),所以两个包在拖拽性能上没有差别,可以放心用 debug 包复现问题。
- 运行时从 `<exe目录>/assets/` 读精灵素材,发包必须带 assets 目录一起(zip)。
- 证据日志:
  - `/Users/seavey/Downloads/log.txt`(18065 行,第二轮**之前**采的)。
  - `/Users/seavey/Downloads/log 1.txt`(26829 行,第二轮**之后**采的,含 2 次拖拽共 15 秒)—— §4 的根因就是从这份算出来的。
  - `/Users/seavey/Downloads/log 3.txt`(trace 关掉后采的,4 次拖拽)—— §4 的逐时间窗分解出自这份。
  - `/Users/seavey/Downloads/log 4.txt`(28 行,第五轮 `timeBeginPeriod` 版,2 次拖拽)—— 证伪第五轮的那份,`move gaps` 直方图第一次出现。

## 2. 症状时间线

1. 初版 Windows 构建:能跑,点击放大/拖动跟随/悬浮跳跃正常;**右拖仍显示朝左动画**。
2. 根因:SDK 的 CPU 参考渲染器(`SDK/src/primitives/canvas/reference.zig` `drawImage`,~L491)把 Affine 经 `transformRect` 折成轴对齐包围盒,**负缩放符号丢失**;Windows 透明窗口(WS_EX_LAYERED)永远走这条软件路径。Metal/Direct2D 不受影响。此发现记在 `docs/zero-native-notes.md` 2026-09-05 条目,值得报上游。
3. 修复(`46f576c`):为 `working` 条带预生成逐帧水平镜像 `working-mirrored.png`(manifest 加 `mirroredFile`),朝右时换用镜像图像 id(每宠物 16 槽中的 slot 8),弃用负缩放 Affine。已验证朝向正确。
4. **新问题:拖动时宠物抖动,用户描述"每移动一步都在重置序列帧"**。用户当时只提右拖,左拖据说平滑 —— 第三轮的日志证明**方向相关性不成立**(§3),左右都抖;"重置序列帧"也不是字面意思,`frame_index` 全程正常,那是位置步长忽大忽小的观感。
5. 第二轮修复(见 §0):拖拽事件流(Windows 上 400-500 次/秒)不再逐事件 `SetWindowPos`,移动统一交 60Hz 轮询;`placeBottomRight` 修 DPI 换算(之前窗口有 72px 被放到屏幕右缘外)。**用户测后:抖动仍在。**归位修复有效,但移窗改动方向搞反了 —— 它把移窗从"永不被饿死的输入流"搬到了"会被输入饿死的 WM_TIMER"上。
6. 第三轮:从 `log 1.txt` 量出移窗实际只有 40Hz 且节拍在 1x/2x 之间跳变,改为**输入流当时钟 + 13ms 闸门**,轮询退为兜底(§4)。**用户测后:抖动仍在**,但 `log 2.txt` 证明这一轮修的问题是真的、也真修好了(§4 验证结果)。
7. 第四轮:怀疑**测试构建自己在制造抖动** —— `-Dtrace` 默认 `.events`,拖拽时 SDK 在事件派发路径内每秒同步 `std.debug.print` 2300+ 次到重定向的文件里。出了 `-Dtrace=off` 的 debug 与 release 构建。**用户测后:仍抖**,trace I/O 排除(但打包默认仍应带 `-Dtrace=off`,见 §7)。
8. **用户给出关键细节**:"一开始往左移则左动画没问题,鼠标持续按住,这时往右移才有问题;反过来一开始往右移则右动画没问题,然后往左移就有问题。" —— 症状左右对称,触发点是**单次拖拽内的换向**。
9. 第五轮:`log 3.txt` 按时间窗分解出跟手频率与事件流速率的关系,定位完整因果链(§4),用 `timeBeginPeriod(1)` 对症修复(§5.1)。**用户测后:仍抖,且 `log 4.txt` 显示轮询 40.2Hz —— 和第三轮的 40Hz 一模一样,精度请求根本没生效。**
10. 第六轮(当前):根因判断不动,换手段 —— 把轮询的请求周期从 16ms 压到 10ms(一个栅格槽之下),让它每个 tick 都到期(§5.2);同时把 `beginPreciseTimers` 的结果打进日志,免得下次还要靠推断。顺手做了日志自动落盘(§1)。等硬件验证。

## 3. 已排除的嫌疑(日志证据,别再查)

来自 `/Users/seavey/Downloads/log.txt`(注意:这份日志是"事件节流"改动**之前**采的):

- `frame_index` 不会在拖拽中重置:重置点只有 boot/drag start/endDrag/hover 转换,日志里每次拖拽只有一个 `drag start` 和一个 `drag end`,`spurious_ends=0`。
- 无拖拽重启风暴、无 hover 抖动(hover enter/leave 全部发生在 `dragging=false`)。
- 朝向翻转稀疏(每次拖拽 1-3 次 `facing flip`,是用户慢速变向的真实反映,不是每步翻转)。
- 无条带重载/解码失败(9 张条带含镜像条带全部 boot 时一次加载成功)。
- 呈现帧率正常:拖拽期间 `gpu_surface_frame` ≈ 64Hz;拖拽事件**不触发**额外呈现(1.5 秒拖拽 579 事件 vs 99 帧)。
- 定时器:frame timer 120ms 节拍正常(日志 timer 事件数对得上)。

来自 `log 1.txt`(第二轮之后):

- **抖动与拖拽方向无关**,所以**镜像条带内容清白**(第二轮的头号嫌疑),不必再去逐帧比对 `working.png` 与 `working-mirrored.png`,也不必做"右拖强走 Affine 回退"的对照构建。判据:拖拽中出现了 30 对 `hover leave`/`hover enter`,在 `facing_right` 为 true 和 false 两种朝向下都密集出现,左右表现一致。
- **不是 DPI 150% 下的重采样抖动**(第二轮的二号嫌疑):呈现帧间隔极稳(p10 15.6 / 中位 16.7 / p90 17.1ms),重采样相位抖动会体现在帧率或帧内容上,不会只体现在位置上。
- **不是 `UpdateLayeredWindow` 的 `pptDst` 回拽**(值得记一笔,因为它看着很像):`presentTransparentWindow` 在合成**开始**时 `GetWindowRect` 读位置,结尾把这个可能已过期的 rect 传给 `UpdateLayeredWindow` 的 `pptDst`,而非 NULL 的 `pptDst` 是会移动窗口的。但呈现的调用点(`webview2_host.cpp:6105/7233/7291/7334`)全在 UI 线程,合成过程中没有回调,`SetWindowPos` 与呈现严格串行,所以 `pptDst` 永远等于当前位置,不会回拽。**别再查这条。**

来自 `log 3.txt` 与本地资产实测(第四轮之后):

- **不是 trace I/O**:`-Dtrace=off` 的 debug 与 release 两个构建都仍然抖(日志从 13 秒 7995 行降到 58 行,干净可读)。**但打包默认仍应带 `-Dtrace=off`**,理由见 §7。
- **镜像条带内容确定清白**(这次是逐帧实测,不再是推断)。`scripts/lib/mirror.mjs` 是逐帧翻转、帧序不变;实测两只宠物 `working.png` 与 `working-mirrored.png` 的 6 帧 alpha 包围盒完全对称(deepseek-chan frame0 `x=[54,200]` → `x=[55,201]`,即 255−200 与 255−54),帧间主体质心只漂 1.7px。复现脚本思路见 §8。
  - 唯一副产物:主体在 256px 帧内本身偏左约 9px(质心 119 vs 136),所以**换向瞬间精灵会横跳约 13 物理像素**。这是一次性位移,不是抖动,但如果观感上介意,可以在镜像时按质心补偿平移。

来自 `log 4.txt`(第五轮之后):

- **`timeBeginPeriod(1)` 对 `SetTimer` 没用**(至少在这台 Win11 上)。两次拖拽的轮询频率是 135/3358ms = **40.2Hz** 和 126/3155ms = 39.9Hz,与第三轮无精度请求时的 40Hz 完全一致;`move gaps` 直方图的 `25-33ms` 桶仍是主峰(47/150、41/149),正是 15.625ms 栅格的两倍。**别再试提精度这条路**。第六轮保留了这个调用(无害,而且对进程里其它时钟有好处),但它已不承担作用,并且现在会把成败打进 `drag start` 那行,下次一看便知。
- 顺带确认了 §4 的因果链在这份日志里**又复现了一次**:两次拖拽的事件流都在 1.5 秒后塌掉(519 → +35 → +11 和 445 → +28 → +0),而直方图正好是双峰 —— 事件流活着的那段落在 `13-18ms`(78 次),死掉之后的那段落在 `25-33ms`(47 次)。

结论:**应用层状态机干净,资产干净,渲染层干净,抖动在移窗节拍上;而节拍的唯一约束是 `SetTimer` 的栅格,且这个栅格不接受被缩小。**

## 4. 根因(完整因果链,`log 3.txt` 实测)

一句话:**跟手 61Hz 时平滑,38Hz 时抖;61Hz 只在拖拽事件流活着时才有,而换向会永久杀死事件流。**

### 4.1 事实:61Hz 平滑,38Hz 抖

`log 3.txt`(`-Dtrace=off`,4 次拖拽)按 1.5 秒窗口分解:

| 拖拽 | 朝向翻转 | 换向前 | 换向后 |
|---|---|---|---|
| 1 | 0 次(全程朝左) | 事件 457Hz / 移窗 **58.5Hz** | — |
| 2 | 1 次(开头就翻,**未换向**) | 事件 259Hz / 移窗 **61.5Hz** | 事件 251Hz / 移窗 **61.6Hz** |
| 3 | 2 次(**换向**) | 事件 352Hz / 移窗 **57.1Hz** | 事件 **18Hz** / 移窗 **38.6Hz** |
| 4 | 2 次(**换向**) | 事件 266Hz / 移窗 **52.9Hz** | 事件 **12Hz** / 移窗 **37.9Hz** |

拖拽 2 是关键对照:它也翻了朝向、也换了图像 id,但**没有换向**(开头就朝右,之后一直朝右),事件流和跟手全程 61Hz,平滑。所以病因不是图像 id 切换,也不是方向本身。

### 4.2 换向为什么杀死事件流

换向那一下必然是一次快速扫动,指针瞬间跑出窗口命中区。`model.zig` `.drag` 分支的注释早就记过这个行为:"once the pointer outruns the sprite and exits the window the stream dies mid-drag(the 'pointer escapes on fast moves' bug)"。而且 runtime **不发 cancel**(`spurious_ends=0` 全程成立),它只是静默停止派发 —— 所以事件流一去不回,拖拽 4 剩下的 7 秒都只有 10-19Hz 的零星事件。

### 4.3 事件流一死,就只剩被饿死的 40Hz 轮询

SDK 给 app 定时器的是裸 `SetTimer`(`webview2_host.cpp:6637` `native_sdk_windows_start_timer`),走 `WM_TIMER`。两重问题:

1. **栅格量化**(主因):`SetTimer` 把请求周期取整到**传统系统定时器栅格 15.625ms**。16ms 的请求因此在 1 格和 2 格之间摇摆 —— `log 1.txt` 实测 423 tick / 10576ms = **25.0ms/tick(40Hz)**,间隔分布双峰在 15–17ms 与 30–34ms,25.0 ÷ 15.625 = 1.6,即约六成 tick 掉到 2 格。**在 15.625ms 栅格上,60Hz 跟手根本不可能存在。**
2. **优先级饥饿**(次因):`WM_TIMER` 是最低优先级消息,只在输入和投递消息排空后才生成。事件流活着(数百 Hz)时它被压得更狠;而事件流死后队列反而空了,所以此时**量化才是唯一的约束**。

讽刺的是 SDK 自己完全知道 `WM_TIMER` 的毛病:它的帧泵刻意不用它 —— 用 `CreateWaitableTimerExW(CREATE_WAITABLE_TIMER_HIGH_RESOLUTION)` 加上每派发一条消息就调一次 `gpuSurfaceDrainDueFrameEmissions()`(`webview2_host.cpp:2815` 与 `:2946`,注释原话:"WM_TIMER is generated only after higher-priority input/posted messages have drained. A trackpad or high-rate wheel can therefore keep the one-shot emit timer pending for hundreds of milliseconds")。**app 定时器没有这层保护** —— 值得报上游的第二条 SDK 问题(第一条是 §2.2 的 `reference.zig` 丢负缩放)。

### 4.4 为什么前四轮都没看出来

前三轮的移窗节拍分别是 549Hz(逐事件)、40Hz(纯定时器)、47Hz(闸门),症状不变,这一度让我判断"主因不在节拍"—— 判断错了。真相是**事件流活着时节拍是好的(61Hz),死了就是 38Hz**,而单次拖拽的平均值把这两个状态糊成了一个 47Hz 的中间数。必须按时间窗切开才看得见。用户那句"第一个方向没问题,换向之后才有问题"正是这两个状态的分界。

### 4.5 第三轮那些改动的定位

第三轮(输入流当时钟 + 13ms 闸门)是**必要但不充分**的:

| 判据 | 第二轮 | 第三轮 |
|---|---|---|
| 拖拽中 `hover leave`/`enter` 对数(位置滞后的直接读数) | 30 | **0** |
| 呈现 | 61.1Hz | 63.7Hz,10 秒内仅 1 次掉帧 |
| 全事件流 >40ms 空洞 | — | **0 个**(消息泵没有长停顿) |

它把事件流活着时的跟手做到了 61Hz(拖拽 1、2 就是证据),位置滞后彻底消失。**保留,别回滚** —— 它是 §5 那半个修复的另一半。

## 5. 让轮询自己跑够 60Hz:两次尝试

修复方向由 §4 定死:**事件流会中途死掉,所以轮询必须自己能跑 60Hz**。事件流死后消息队列反而是空的(10-19Hz 输入),优先级饥饿此时不是约束 —— 唯一的约束是 `SetTimer` 的 15.625ms 栅格量化。两次尝试都在打这一个点,区别只在从哪一侧打。

### 5.1 第五轮:把栅格缩到请求之下(`timeBeginPeriod(1)`)—— 实测无效

`timeBeginPeriod(1)` 本该把进程的定时器精度提到 1ms,让 16ms 的请求交付 16ms。实测轮询仍是 40.2Hz,直方图主峰仍在 `25-33ms`(§3)。原因没有继续深挖 —— 可能是 Win10 2004 起定时器精度改成按进程隔离后 `WM_TIMER` 不再跟随,也可能 `SetTimer` 本来就只认传统栅格。**没必要深挖,因为 5.2 绕开了它。**

留下来的部分:

- `win32.zig`:`beginPreciseTimers()` / `endPreciseTimers()`,`LoadLibraryA("winmm.dll")` + `GetProcAddress` 动态解析 `timeBeginPeriod`/`timeEndPeriod`。动态解析而非链接,是为了保持本文件"不需要 import library"的性质(和 `appkit.zig` 用 dlsym 拿 Objective-C runtime 同一个理由)。作用域**限定在单次拖拽内**(`drag start` 抬、`endDrag` 落,一一配对),抬高全局定时器精度有系统功耗代价,不该常驻。第六轮把它改成回报 bool,打进 `drag start` 那行。
- `model.zig`:`move_gaps` 移窗间隔直方图,在内存里累计、`drag end` 时一次性打出。**故意不逐次打印** —— 跟手最高 77Hz,每次一行就是把无缓冲同步 I/O 放进热路径,正是第四轮踩过的坑。这个直方图是目前最有用的单一读数:它把"事件流活着"和"事件流死了"两段的节拍分离成了两个峰。

### 5.2 第六轮:把请求压到一个栅格槽之下(`drag_poll_interval_ms` 16 → 10)

既然栅格不肯变小,那就让请求比栅格更小。`SetTimer` 只在**到期时刻之后的第一个栅格 tick** 上触发:

- 请求 16ms:比一个槽(15.625ms)多 0.4ms,于是错过第 1 个 tick、落到第 2 个,然后与栅格互相打拍 —— 实测 25.0ms 均值、步长在 1 格与 2 格之间跳,**就是抖动本身**。
- 请求 10ms:任何小于一个槽的周期在**每个** tick 上都已到期,于是每 tick 触发一次 —— 规整的 ~64Hz。10 是 `SetTimer` 能接受的下限(`USER_TIMER_MINIMUM`,更小的值会被静默抬到 10),所以这是"压到槽下"的最省写法。

两种栅格下都成立,这是选它的另一个理由:栅格若真的是 1ms(别的机器上 `timeBeginPeriod` 生效),10ms 就按 10ms 交付,此时是 `drag_move_min_interval_ms = 13` 的闸门在定节拍;栅格是 15.625ms,就是每 tick 一次的 64Hz。**两条路都落在 60Hz 之上,而不是之下。**

代价:栅格 1ms 时轮询从 60 次/秒变成 100 次/秒,每次只是 `GetCursorPos` + `GetAsyncKeyState` 加一次闸门判断,移窗次数仍由闸门封顶(≤77Hz)。macOS 侧同样变成 100Hz 轮询,同样被闸门挡住,可接受。

### 验收判据(下次日志)

`dsh-pet-windows-v5.zip`,含 `pet-v5-debug.exe` 与 `pet-v5-release.exe`。**直接双击**(不必再走命令行,日志自动落在 exe 同级的 `dsh-pet-desktop.log`,见 §1),做一次**长拖拽并中途多次换向**,然后看两行:

```
dsh-pet-desktop: drag start origin=(..) mouse=(..) poll_ms=10 precise_timers=true|false
dsh-pet-desktop: move gaps ms <=8:.. 9-12:.. 13-15:.. 16-18:.. 19-24:.. 25-33:.. 34-50:.. >50:..
```

- **通过**:`25-33` 桶塌到接近空,质量集中在 `13-18`;`drag poll ticks=N ... elapsed_ms=M` 的 `N/M` 从 40Hz 升到 60Hz 以上。
- **失败**:`25-33` 仍是主峰 → `SetTimer` 的行为和上面的模型不符,**至此应彻底放弃 `WM_TIMER`**,走 §6.1(专用线程)。
- `precise_timers` 这次会明说 —— 若是 `false`,说明 winmm 解析都没成功,第五轮的结论要按"根本没执行"重读(不影响 5.2 的判断)。
- 换向后 `events` 速率**预计仍会塌**(本轮没修事件流的死亡,只是让它不再要紧)。只要换向后 `moves` 能稳在 60Hz 以上而用户反馈平滑,就对了。

## 6. 若第六轮也不成立:剩余线索

按嫌疑排序。前提是先读 §5 的验收判据 —— **`move gaps` 直方图和 `poll ticks` 频率决定往哪走**。

1. **直方图主峰仍在 25-33**(轮询频率没升上去)→ **彻底放弃 `WM_TIMER`**。两次从两侧打栅格都失败,说明 `SetTimer` 这条路走不通。开一个专用线程:高精度 waitable timer(`CreateWaitableTimerExW` + `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`,和 SDK 帧泵同一套)醒来 → `GetCursorPos` → `SetWindowPos`。注意跨线程 `SetWindowPos` 会把 `WM_WINDOWPOSCHANGING` 发给属主线程,需要属主在泵消息(它在泵,事件流就是从那儿来的),调用方会阻塞到属主处理完 —— 对专用线程无所谓。这是目前最有把握的方案,只是要新起一个线程和它的生命周期管理,所以放在栅格方案之后试。
2. **直方图集中在 13-18 了、但用户仍报抖**(节拍已经对了)。这时才轮到"呈现与移窗不同相"的问题:呈现是 SDK 固定的 60Hz 栅格(`kGpuFrameIntervalNs = 16666667`),不锁 vsync。**先问屏幕刷新率** —— 如果显示器是 144Hz/165Hz,固定 60Hz 的更新本身就有节拍感,而这在 app 层无解,得改 SDK 的帧泵。同时也该**要录屏**(见第 8 条),因为到这一步文字读数已经用尽了。
3. **修事件流的死亡本身**。第五、六轮都只是让它不再要紧,没修它。方向:把窗口的透明命中区做得比现在大很多(现在 192pt 窗口 / 128pt 精灵,只有 32pt 余量),指针就不容易跑出去;代价是更多"死屏幕空间"(`view.zig` 头部注释讨论过这个取舍)。
4. **指针自身的抖动**。`facing_dead_zone_px = 1.5` 的存在说明 `GetCursorPos` 读数本来就有亚像素噪声,而我们是 1:1 映射。验证:把每次移窗的目标 origin 存进环形缓冲、拖拽结束一次性 dump(**不要在热路径里 print**,那就是第四轮踩的坑),看目标序列是否单调。
5. **移窗有没有真的生效**。同一版 instrument 里,在 `SetWindowPos` 之前读一次 `windowing.origin()` 和上一次的目标比。不一致说明有东西在把窗口往回拽。注意 `pptDst` 那条已经排除(§3),这里查的是 DPI 取整之类。
6. **`petWindow()` 的 `FindWindowA` 开销**。`win32.zig` 每次 `setOrigin`/`origin`/`frame` 都做一次全局窗口枚举,现在是每秒几十到几百次。值得缓存 HWND(注意窗口销毁后的失效)。
7. **SDK 侧根治定时器**:给 app 定时器套上帧泵那套 waitable timer + 每消息 drain(§4.3)。改动大、`zig-pkg` 未入库,更适合报上游而不是本地打补丁。
8. **录屏**。到这一步必须要了:文字区分不了"位置步长不均"、"宠物原地左右晃"、"内容 tearing"这三种病,处理方向完全不同。

## 7. 操作速查

```sh
cd packages/pet-desktop
zig build                                        # 本机 macOS
zig build test                                   # 单测(末尾那行 "failed command ... --listen=-" 是既有的 runner teardown 噪音,退出码 0 即为通过)
# !! -Dtrace 默认是 .events,会在事件派发路径里每秒同步写 2300+ 行(§3 已证明它不是
# 抖动主因,但它把日志从 58 行撑到 8000 行、并让最低优先级的 WM_TIMER 更容易饿死)。
# 现在还多一条理由:日志自动落盘了(§1),trace 开着就等于往用户磁盘上无界地写。
# 打给用户的包一律加 -Dtrace=off,没有例外。
# -Ddrag-diag 打开手势级输入诊断(默认关,见 §1);排查抖动的包一定要带上,否则日志里
# 没有 move gaps / drag poll / facing flip。
zig build -Ddrag-diag -Dtarget=x86_64-windows-gnu -Dtrace=off   # Windows debug 交叉构建 → zig-out/bin/dsh-pet-desktop.exe
zig build -Doptimize=ReleaseSmall -Dtarget=x86_64-windows-gnu -Dtrace=off --prefix zig-out-win-x64   # release 形态(静默)

# 打包(exe + assets 必须同级)并发送到 Windows:
rm -rf /tmp/pet-v6 && mkdir -p /tmp/pet-v6
cp zig-out/bin/dsh-pet-desktop.exe /tmp/pet-v6/pet-v6-debug.exe
cp zig-out-win-x64/bin/dsh-pet-desktop.exe /tmp/pet-v6/pet-v6-release.exe
cp -R assets /tmp/pet-v6/assets
cd /tmp/pet-v6 && zip -qr /tmp/dsh-pet-windows-v6.zip .
tailscale file cp /tmp/dsh-pet-windows-v6.zip seaveyluo-pc0:
```

Windows 侧:右键退出旧实例 → 解压 → **双击 exe** → 拖 → 右键退出 → 取 `%LOCALAPPDATA%\dsh-pet-desktop\dsh-pet-desktop.log`(§1)。命令行重定向仍然可用,但不再是必须的。

验证包的一致性检查:`rg -c 'move gaps ms' -a <exe>` 在 debug 包里应是 1、release 包里应是 0。

## 8. 关键代码位置

- 拖拽状态机/跟手节拍/朝向死区:`packages/pet-desktop/src/model.zig`(搜 `.drag`、`.drag_poll`、`followPointer`、`dueForMove`、`drag_move_min_interval_ms`、`move_gaps`、`noteDragPointerX`、`endDrag`;`facing_dead_zone_px = 1.5`)
- **轮询周期(第六轮修复的全部内容)**:`src/model.zig` `drag_poll_interval_ms`(注释写了栅格算术)
- 定时器精度(第五轮,已证无效但保留):`src/win32.zig` `beginPreciseTimers`/`endPreciseTimers`(动态解析 winmm);分发 `src/windowing.zig`;macOS 返回 true 的实现 `src/appkit.zig`
- 日志自动落盘:`src/runlog.zig`(Windows `SetStdHandle` / macOS `dup2`,各自的"stderr 有没有去处"判据;`max_bytes`/`enforceCap` 是 1MB 上限)+ `src/main.zig` 里 `main` 的第一行 + `model.zig` `.tick` 分支里的 `runlog.enforceCap()`;落盘位置来自 `src/persist.zig` 的 `appDataPath`/`logPath`(和 `state.txt` 共用一个平台目录解析,以后要加 XDG 只改一处)
- 诊断开关:`src/diag.zig`(`enabled` + `print`)、`build.zig`(`-Ddrag-diag` → `build_options.drag_diag`)
- SDK 的 app 定时器(根因所在):`zig-pkg/native_sdk-*/src/platform/windows/webview2_host.cpp` `native_sdk_windows_start_timer`(~L6637,裸 `SetTimer`);对照它自己的帧泵 `gpuSurfaceRefreshFrameWakeTimer`(~L2827)与 `gpuSurfaceDrainDueFrameEmissions`(~L2957)
- 资产逐帧校验(§3 用过):`scripts/lib/png.mjs` 的 `decodePng` + 按帧宽切片统计 alpha 包围盒与质心,几十行即可复现
- 镜像图像选择:`model.zig` `spriteImageId()` + `mirroredRunLoaded()`;视图变换:`src/view.zig` `rootView`(Affine 回退仅在无镜像资产时启用)
- 镜像条带加载/槽位:`src/manifest.zig`(`mirrored_run_slot = 8`、`mirroredRunImageId`、`mirroredRunPet`、`.image_done` 里先于 `decodeImageId` 处理)
- Win32 桥:`src/win32.zig`(GetCursorPos/SetWindowPos/GetAsyncKeyState/SPI_GETWORKAREA);macOS 对应物:`src/appkit.zig`;分发层:`src/windowing.zig`
- 镜像生成:`scripts/mirror-working-strips.mjs`、`scripts/lib/mirror.mjs`;Codex 导入器已集成:`scripts/lib/import.mjs`
- 手势诊断的全部调用点:`model.zig` 里搜 `diag.print`(10 处);它们的开关见上面的 `src/diag.zig`
- SDK 罪证:`zig-pkg/native_sdk-*/src/primitives/canvas/reference.zig` `drawImage`(~L475-568,`transformRect` 丢负缩放);Windows 透明呈现:`.../src/platform/windows/webview2_host.cpp` `presentTransparentWindow`(~L3129)

## 9. 其他已知事项(别当成新 bug)

- zig 测试 runner 结束时打印一行 `failed command: ... --listen=-`,HEAD 上就有,退出码 0,测试全过。
- `packages/pet-desktop/scripts/bake-sprites.mjs` 已过时(引用已删除的 `PET_STYLE_CSS`),与本次任务无关,别跑。
- 插件侧(packages/pet)与发布工作流的 Windows 支持已完成并有测试,与抖动无关。
- Windows 运行时持久化路径:`%LOCALAPPDATA%\dsh-pet-desktop\state.txt`;桥接端口 127.0.0.1:45731。
