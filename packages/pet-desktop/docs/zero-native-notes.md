# zero-native 桌面宠物实现笔记（pet-spike 沉淀）

> 面向 pet-desktop 正式版的实现者。本文全部结论来自可行性 spike（`/tmp/pet-spike`）的实机验证与三轮拖拽 bug 的根因修复，每条坑都带 `文件:行号` 证据。引用行号以 2026-09-03 的 `/tmp/pet-spike` 与 `/tmp/zero-native` 工作区为准。

## 1. 背景

**方案**：用 zero-native 框架（Zig-core UiApp + gpu_surface canvas，Metal 后端）实现精灵图（sprite）桌面宠物——一个 192×192 的透明、置顶、无边框窗口，整个表面是一块 GPU canvas，两张 PNG 帧以 250ms 定时器交替实现待机动画。

**为什么选它**：

- 纯原生渲染，无 WebView 开销；窗口小、常驻，资源占用必须低。
- Windows 上透明窗口会拒绝 WebView（见第 5 节），gpu_surface 是跨平台唯一可行路线，macOS spike 走通即验证了路线本身。
- canvas 声明式 UI（markup + DesignTokens）足以表达"一张图 + 点击/拖拽/右键菜单"的全部交互。

**spike 位置与复跑**：

```sh
cd /tmp/pet-spike
zig build run     # ReleaseFast；运行日志重定向到 /tmp/pet-spike-run.log 便于事后分析
zig build test    # 单元测试（几何/拖拽映射/标签一致性）
```

框架源码在 `/tmp/zero-native`（path dependency，见 `build.zig.zon:6`）。spike 的 `README.md` 是本文的精简版，代码注释里有更细的机制说明。

## 2. 已验证能力清单

| 能力 | 验证方式 |
| --- | --- |
| 透明窗口 | 截图取窗口四角像素为桌面背景色；三件套配置见 3.3 |
| 置顶（always_on_top） | `app.zon:23` + `src/main.zig:58` 双声明；运行中开窗遮挡实测 |
| 无边框（chromeless） | `titlebar = .chromeless`（`src/main.zig:56`），窗口无标题栏无红绿灯 |
| 帧动画 | 250ms repeating timer 翻转 `show_a`（`src/model.zig:141-144`），截图可见两帧交替 |
| 点击反馈 | 单击切换 1.25× 缩放（128→160pt），日志 `press #N zoomed=...` |
| 拖拽移动 | 见 3.5/3.6——60Hz 轮询绝对定位，实机长甩 3.9s 横跨全屏不脱离 |
| 右键退出 | `context_menu` 声明（`src/view.zig:26-28`），菜单项发 `.quit` → `fx.quitApp()` |
| 越屏悬挂 | 拖拽 origin 实测横扫 x 33→1264（屏宽 1512pt），窗口贴边/部分越出屏幕仍正常渲染与跟随 |
| 右下角初始定位 | boot 日志 `place bottom-right (1296.0,113.0)` + CGWindowList 报 192×192 @(1296,677) |

## 3. 踩坑清单（核心资产）

### 3.1 npm 全局 zero-native CLI 自带旧 SDK，不可用

npm 安装的 CLI 捆绑的 SDK 是旧 API，与仓库代码不兼容。**必须用框架仓库的本地克隆作为依赖，并锁定 commit**（`pet-spike/README.md:13-15`）。正式版建议在 monorepo 内 vendored 或 submodule 固定版本。

### 3.2 zig 依赖只接受相对路径或 URL+hash

`build.zig.zon` 的 dependency 不支持绝对路径。spike 用相对路径：`.{ .path = "../zero-native" }`（`build.zig.zon:6`）。正式版若要跨仓库引用，走 URL+hash 或把框架纳入同一 workspace。

### 3.3 透明窗口三件套，缺一不可

1. 窗口声明 `transparent = true`（`app.zon:22` 与 `src/main.zig:57` **两处必须一致**——宿主先按 app.zon 建窗，scene 声明不符会打架）；
2. gpu_surface 声明 `gpu_alpha_mode = .premultiplied`（`src/main.zig:41`）；
3. `tokens_fn` 把 **三个** token 的 alpha 置 0：`background`（主 canvas 的 frame 清屏色，`ui_app.zig` 只给次级窗口自动 alpha-0 清屏）、`surface_subtle` / `surface_pressed`（可交互容器的 hover/pressed wash 读这两档，alpha-0 的 wash 会被 emitter 跳过）——见 `src/main.zig:77-92` 的注释与代码。

漏掉后两项的症状：hover/按下时宠物背后出现不透明方块。

### 3.4 window_drag 与 on_press 同元素时 press 优先 → 宠物必须自建拖拽

内置 `window_drag` 通道只在 hit route 上**没有** press 认领者时才把手势交给平台（`canvas/widget_routing.zig:223` 注释："authored handlers outrank the drag surface"），运行时测试 `canvas_widget_window_drag_tests.zig:212`（"a widget with both a press handler and window_drag keeps its press"）把这个优先级钉死。宠物的整个表面就是 press 目标（点击=缩放反馈），所以同元素 `window_drag` 永远不触发。

**正确做法**：根容器挂 `.on_drag`（`src/view.zig:37`），拖拽完全由 app 侧通过 AppKit 通道实现（`src/appkit.zig` 头注释 1-15 行有完整论证）。

### 3.5 macOS 无免费 pointer capture：拖拽跟随必须轮询，end/cancel 事件是 advisory

on_drag 事件流经窗口命中区派发，指针甩出窗口（快速拖拽时窗口追着指针跑、指针很容易"领先"出窗）事件流即断；runtime 随即合成一个 **cancel（phase=2）**——**但物理按键还按着**。信任这个 cancel 去结束拖拽，窗口就搁浅在半路上（长甩脱离 bug 的根因）。

**正确做法**（`src/model.zig`）：

- on_drag 事件只负责**启动**手势：首个 post-slop change 事件捕获 `grab = mouseLocation - origin`（`:191-209`），之后跟随交给 60Hz repeating timer；
- 轮询 tick 读 `NSEvent.mouseLocation` 做绝对定位 `setFrameOrigin(ml - grab)`（`:240-258`），不依赖任何事件；
- end/cancel 事件先查 `+[NSEvent pressedMouseButtons]` bit 0，按键仍按下则忽略并计数（`:228-233`）；
- 唯一可信的结束 = 轮询发现按键已抬起（`:244-247` → `endDrag(.., "buttons-up")`）。

实测证据：cancel 后事件流完全死掉（events 计数停在 42），轮询 62Hz 独撑 3.9 秒横跨全屏后以 buttons-up 收尾。runtime 侧机制见 `canvas_widget_events.zig:346-378`（指针出窗的合成 cancel 分支）。

另注意 runtime 有 6pt 拖拽 slop（`canvas_widget_events.zig:57` `canvas_widget_drag_slop`）：sub-slop 位移不进入拖拽，release 仍是普通 press——单击与拖拽因此能干净地共存在同一元素上。

### 3.6 runtime terminal drag 分支不清 press latch：release 回声会补发 press

拖拽结束的那个 release 会**再触发一次 press**（宠物被意外缩放）。机制链：

1. mid-drag cancel 走 terminal 分支（`canvas_widget_events.zig:416-430`），清 drag 状态但**不清** `canvas_widget_pressed_id`（只有 route 丢失分支 `:360` 和 Escape 键盘路径 `:486` 清）；
2. release 到达时 pointer capture 仍指向 pressed widget（`:74-75`），且此时 drag 状态已清、`gpu_surface_events.zig:326-332` 的 press_target 退役逻辑不再触发（已不存在 terminal drag 事件）；
3. 于是 release 按普通点击派发 press，且**比轮询的 buttons-up 检测早 ~5ms** 到达（实测）。

**正确做法**（app 侧双闸门，`src/model.zig:160-176`）：

- `dragging` 仍为 true 的 press 直接忽略（覆盖"回声先于轮询检测到抬键"的主序）；
- `endDrag` 记录 `drag_end_ms`（`:270`），其后 250ms 内的 press 忽略并消费该窗口（覆盖反序竞态；一次性消费保证 250ms 后的真点击不被吞）。

### 3.7 同一 pre-reveal 回合只调一次 setFrameOrigin:

同一回合内两次 `setFrameOrigin:` 会让合成内容落后 WindowServer 的 frame 记录一步（观察到窗口记录已在第二个 origin，sprite 却合成在第一个）。疑似框架/宿主 bug，值得上报。**正确做法**：初始定位只在 `init_fx`（installing frame，首帧 reveal 之前）调一次（`src/model.zig:117-140` boot + `src/appkit.zig:138-152` placeBottomRight）。

### 3.8 GPU layer 画不出窗口 bounds → 透明边距窗口

CAMetalLayer 物理上无法在 bounds 外绘制：sprite 贴窗边快速移动时会被裁切。**正确做法**：窗口做比 sprite 大——spike 为 192 窗口 / 128 sprite / 四边 32pt 透明边距（`src/model.zig:43-45`）；边距还需容纳缩放置大（160pt zoomed overhang 16pt < 32pt，几何单测 `:299` 钉住 margin ≥ overhang）。边距不要过大，否则透明区拦截点击会像"死屏幕"。

### 3.9 坐标系：mouseLocation 与 setFrameOrigin: 同为 AppKit 左下原点系

两者共享同一全局屏幕坐标（左下原点、y 向上），**拖拽链路无任何 y 翻转**。`grab = ml - origin` 在首个 post-slop 事件处建立后，`dragOrigin(ml, grab) = ml - grab` 是 1:1 绝对映射：零跳变、无累积误差、无 view-local 反馈环（`src/model.zig:286` 单测钉住该纯函数）。切忌把 view-local 的 drag 事件坐标喂回窗口定位——窗口在指针下移动，view-local 坐标会形成反馈。

### 3.10 objc 调用用 dlsym(RTLD_DEFAULT)，不要 -lobjc

在 addApp 构建图里按名字链接 libobjc 会失败（生成的模块没有 usr/lib 搜索路径）。libobjc 一定已被 AppKit 平台宿主载入进程，直接 `dlsym(RTLD_DEFAULT, "objc_getClass"/"sel_registerName"/"objc_msgSend")` 即可（`src/appkit.zig:23-45`）。arm64 无需 msgSend_stret 变体——trampoline 保留间接结果寄存器，NSRect 返回值也用普通符号（`:51-53`）。

### 3.11 zig build test 不要加 -Doptimize=Debug

框架链接 bug：Debug 模式的 test 目标会挂（`README.md:20-22`）。`zig build run` 可以加，test 不行。

### 3.12 锁屏时 CGWindowList / screencapture 读数不可信

macOS 锁屏（`IOConsoleLocked == true`）时 screencapture 全黑、CGWindowList 返回垃圾几何（曾报 116×116）。任何自动化截图/窗口几何验证前先查：

```sh
ioreg -n Root -d1 -a | plutil -extract IOConsoleLocked raw -
```

## 4. 经过验证的代码模式（可直接照抄）

### 4.1 UiApp 接线骨架（`src/main.zig`）

- `shell_windows` 声明 + `app.zon` 窗口声明**逐字段一致**（`:44-60` 注释说明原因）；
- `PetApp = native_sdk.UiApp(Model, Msg)`，`petOptions()` 挂 `update_fx` / `init_fx` / `view` / `tokens_fn`（`:63-75`）；
- `runner.runWithOptions` 传 `bundle_id`、`default_frame`、`js_window_api = false`、最小权限集（`:94-111`）；
- `pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic)`（`:21`）——panic 落盘，便于实机排障。

### 4.2 boot 单次定位右下角（`src/model.zig:123-140` + `src/appkit.zig:138-152`）

`init_fx` 在 installing frame 上运行、先于首次 reveal，此时定位不会闪一下宿主默认居中位置。用 `[screen visibleFrame]` 计算 `origin = (visible.maxX - size - margin, visible.minY + margin)`，自动避开 Dock 与菜单栏。**全程只调这一次**（见 3.7）。

### 4.3 拖拽状态机（`src/model.zig`）

```
idle
  │  on_drag phase=0 (首个 post-slop change)
  ▼
dragging ── 捕获 grab = mouseLocation - origin，启动 60Hz drag_poll timer
  │  drag_poll tick (60Hz)
  │    ├─ pressedMouseButtons == 0 ──→ endDrag("buttons-up") ──→ idle
  │    └─ 否则 setFrameOrigin(ml - grab)
  │  on_drag phase=0 (迟到事件) ──→ 同样的绝对定位，顺手应用（sub-tick 响应）
  │  on_drag phase=1/2 (end/cancel)
  │    ├─ leftMouseDown() == true ──→ 忽略（advisory，计数 spurious_ends）
  │    └─ 按键已抬 ──→ endDrag("event") ──→ idle
  │  press 到达
  │    ├─ dragging ──→ 忽略（release 回声，见 3.6）
  │    ├─ drag_end_ms 后 250ms 内 ──→ 忽略并消费窗口
  │    └─ 否则 ──→ 正常点击（缩放）
```

关键不变量：**跟随与结束判定都不依赖事件流**；事件流只提供启动信号与 sub-tick 的额外响应。逐行实现见 `.drag` 分支 `:191-238`、`.drag_poll` 分支 `:240-262`、`endDrag` `:266-273`、`.press` 闸门 `:160-176`。

### 4.4 视图结构（`src/view.zig`）

单个根 column 同时是 press 目标、drag source、context menu 属主（`:30-48`）；`quiet_hover` 去掉可交互容器的 hover wash（透明窗口上 wash 显示为不透明方块，`:10-14`）；sprite `ui.image` 居中，尺寸由 model 的 zoomed 状态驱动。

### 4.5 AppKit 桥（`src/appkit.zig`）

dlsym 三件套 + 按调用形状各一次 cast 的 `call0`/`call1` 泛型封装（`:54-62`）；窗口按 title 在 `[NSApp windows]` 里查（`:69-83`，无边框窗口保留 title）；对外只暴露 `origin/frame/mouseLocation/leftMouseDown/setOrigin/placeBottomRight/logFrame` 七个函数。

## 5. 开放问题

1. **上报框架 bug**：
   - terminal drag 分支不清 `canvas_widget_pressed_id`（`canvas_widget_events.zig:416-430`），导致 post-slop 拖拽的 release 回声补发 press——app 侧已用双闸门绕过，但框架应在对称性上与 `:360`/`:486` 保持一致；
   - 同一 pre-reveal 回合两次 `setFrameOrigin:` 导致合成内容落后 WindowServer 记录一步（3.7）——需要框架宿主侧确认根因。
2. ~~**Windows 精灵图路径**~~ **已解决（2026-09-05）**：透明窗口在 Windows 上拒绝 WebView，必须走 gpu_surface——本应用一直是此路线，天然兼容。已确认框架 Win32 宿主（`src/platform/windows/webview2_host.cpp`）完整接线了逐像素透明（WS_EX_LAYERED + UpdateLayeredWindow，走 CPU 参考渲染器 + GDI DIB 呈现，192×192 精灵图足够）、置顶（WS_EX_TOPMOST）、右键菜单（TrackPopupMenu）、PNG 解码（WIC）与定时器；`app.zon` 的 `gpu_backend = "metal"` 是可移植请求值，Windows 宿主统一映射到默认 presenter。App 侧 Win32 等价物已落在 `src/win32.zig`（经 `src/windowing.zig` 按 `builtin.os.tag` 分发）：`FindWindowA` 按 title 查窗口、`GetWindowRect`/`SetWindowPos` 读写位置、`GetCursorPos` 对应 `mouseLocation`、`GetAsyncKeyState(VK_LBUTTON)` 高位对应 `pressedMouseButtons`、`SPI_GETWORKAREA` 对应 visibleFrame 的右下角放置；`hideFromDock` 的对应做法是加 WS_EX_TOOLWINDOW、去 WS_EX_APPWINDOW。已从 macOS 交叉编译通过（`zig build -Dtarget=x86_64-windows-gnu`），真机行为（透明呈现、DPI 缩放、taskbar 隐藏）仍待 Windows 硬件上验证。
3. **Linux Wayland**：`always_on_top` 在 Wayland 下受合成器限制（无协议保证，GNOME/KDE 行为不一），正式版若支持 Linux 需降级为 best-effort 并在文档中声明。
4. **多屏/Dock 变化**：`placeBottomRight` 只在 boot 调一次；屏幕插拔或 Dock 移位后不会重定位，正式版可监听 `NSApplicationDidChangeScreenParametersNotification`。
