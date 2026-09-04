# @seaveyon/dsh-pet

[DSH](https://github.com/deepseek-ai) Web 界面的桌面宠物。[English](README.md)

一只手工打磨的宠物住在 DSH Web GUI 的角落里，实时映射你的 agent 正在做什么：思考、调用工具、等待你确认、完成回合时蹦跳庆祝、和你一起安静太久时打瞌睡。

![演示：Mochi 跟随 agent 状态切换——待机、思考、工作、庆祝、被抚摸](assets/demo.gif)

## 安装

```sh
dsh plugin --profile web add @seaveyon/dsh-pet
```

本包声明了 `dsh.bundle.patch`，`dsh plugin` 会同时安装 npm 依赖并把 [`cordis.patch.yml`](cordis.patch.yml) 的 loader 行并入 profile——无需手动改 YAML。重启 `dsh web` 并硬刷新页面，宠物出现在右下角。

> 这一行 loader 是必需的：client 模块系统通过扫描宿主 Loader 的活动条目来发现插件 bundle，仅作为普通依赖安装的包永远不会被伺服。该行激活的宿主插件是刻意的空实现——所有功能都在浏览器 bundle 里。

## 使用宠物

- **拖动** 到任意位置，位置按浏览器记忆。
- **单击**（或 Tab 聚焦后按 Enter/空格）抚摸它。
- **双击** 隐藏它；点击爪印按钮唤回。
- agent 工作时，气泡显示正在调用的工具名；agent 等你确认时，宠物陪你一起等；回合完成时它会庆祝。

配置入口在 **设置 → 宠物**：四只内置形象（blob、cat、robot、DeepSeek 酱）、改名、0.5×–2× 缩放、显示开关。

有 settings 服务时配置写入 DSH settings，否则回退 `localStorage`——远端浏览器（settings RPC 不出服务器）也走本地存储。

## 原理

本包是双面 DSH 插件：宿主面是空操作的 Cordis 插件（见 [`src/index.ts`](src/index.ts)），客户端面（[`src/client/`](src/client)）由 shell 的 client 模块系统伺服于 `/plugins/@seaveyon/dsh-pet/client.js`。客户端从 `sessions.currentProvideInfo` provide 通道读取实时 agent 状态，从会话快照推导宠物心情——零 LLM 调用、零网络、零遥测。

手写宿主契约类型及其依据记录在 [`src/client/host-types.ts`](src/client/host-types.ts) 顶部。

## 开发

```sh
bun install
bun run build   # 产出 dist/index.js（宿主空操作）与 dist/client.js（浏览器 bundle）
bun run test    # 基于 @seaveyon/dsh-plugin-testkit 客户端替身的 jsdom 套件
```

## License

MIT。本项目是独立软件，与 DeepSeek AI 无隶属或背书关系。
