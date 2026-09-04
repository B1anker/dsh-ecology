# @seaveyon/dsh-pet

[DSH](https://github.com/deepseek-ai) Web 界面的桌面宠物。[English](README.md)

本插件是桌面宠物的**心情源 + 设置面板**——它不在网页上渲染宠物本体。它实时监听你的
agent 正在做什么（思考、调用工具、等待你确认、完成回合时庆祝、双双安静太久时打瞌睡），
推导出心情，并把每次变化推送给[桌面伴侣 App](../pet-desktop)——宠物真正生活在你
的桌面上。

![演示：Mochi 跟随 agent 状态切换——待机、思考、工作、庆祝、被抚摸](assets/demo.gif)

> 演示里是宠物早期的页面形态（v1.2 及更早）；宠物现已搬到桌面上，本插件负责告诉它
> 该是什么心情。

## 安装

```sh
dsh plugin --profile web add @seaveyon/dsh-pet
```

本包声明了 `dsh.bundle.patch`，`dsh plugin` 会同时安装 npm 依赖并把
[`cordis.patch.yml`](cordis.patch.yml) 的 loader 行并入 profile——无需手动改 YAML。
重启 `dsh web` 并硬刷新页面，插件立即开始为桌面 App 提供状态。

> 这一行 loader 是必需的：client 模块系统通过扫描宿主 Loader 的活动条目来发现插件
> bundle，仅作为普通依赖安装的包永远不会被伺服。该行激活的宿主插件是刻意的空实现——
> 所有功能都在浏览器 bundle 里。

## 使用宠物

宠物本体由桌面伴侣 App 显示在你的桌面上。Web 界面里你看到的是 **设置 → 宠物**：

- 桌面上显示哪只宠物：四只内置形象（blob、cat、robot、DeepSeek 酱），以及导入到
  桌面 App 里的宠物。
- 宠物的名字。
- 桌面伴侣开关——默认开启，因为驱动桌宠就是本插件存在的意义；桌面 App 不在线时桥接
  静默失败，开着没有任何副作用。

有 settings 服务时配置写入 DSH settings，否则回退 `localStorage`——远端浏览器
（settings RPC 不出服务器）也走本地存储。

### 选择器就是桌面花名册

选择器的单一数据源是桌面 App：当它应答 `GET http://127.0.0.1:45731/pets`
时，返回的花名册（含内置 4 只）就是整个列表，所有预览都是桥接服务上的精灵条带，
用步进式 CSS 背景动画播放。已知内置 id 沿用本地化名字（deepseek-chan 仍是
「DeepSeek 酱」）；其余 id 视为导入宠物，显示名由 id 美化而来并带"导入"角标。桌面
App 不可达时选择器回退到内置 SVG 形象并显示"未连接"提示，面板打开期间会静默重试
一两次；由于两侧 id 一致，回退态与在线态切换时同一 petId 的选中态保持。已选中但
暂时不可达的导入宠物在桌面侧的表现由桌面 App 自己负责。

## 原理

本包是双面 DSH 插件：宿主面是空操作的 Cordis 插件（见
[`src/index.ts`](src/index.ts)），客户端面（[`src/client/`](src/client)）由 shell 的
client 模块系统伺服于 `/plugins/@seaveyon/dsh-pet/client.js`。客户端从
`sessions.currentProvideInfo` provide 通道读取实时 agent 状态，从会话快照推导宠物心情
（[`src/client/mood.ts`](src/client/mood.ts)），并把每次变化 POST 到伴侣 App 的回环
服务（[`src/client/bridge.ts`](src/client/bridge.ts)）——零 LLM 调用、零遥测，唯一的
网络流量是 loopback。

手写宿主契约类型及其依据记录在 [`src/client/host-types.ts`](src/client/host-types.ts)
顶部。

## 开发

```sh
bun install
bun run build   # 产出 dist/index.js（宿主空操作）与 dist/client.js（浏览器 bundle）
bun run test    # 基于 @seaveyon/dsh-plugin-testkit 客户端替身的 jsdom 套件
```

## License

MIT。本项目是独立软件，与 DeepSeek AI 无隶属或背书关系。
