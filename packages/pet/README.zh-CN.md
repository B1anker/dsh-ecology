# @seaveyon/dsh-pet

[DSH](https://github.com/deepseek-ai) Web 界面的桌面宠物。[English](README.md)

本插件是桌面宠物的**心情源 + 设置面板**——它不在网页上渲染宠物本体。它实时监听你的
agent 正在做什么（思考、调用工具、等待你确认、完成回合时庆祝、双双安静太久时打瞌睡），
推导出心情，并把每次变化推送给[桌面伴侣 App](../pet-desktop)——宠物真正生活在你
的桌面上。

![演示：默认内置宠物 DeepSeek 酱跟随 agent 状态切换——待机、思考、工作、庆祝、被抚摸](assets/demo.gif)

> 演示直接用桌面 App 实际内置的精灵条带渲染（脚本见
> [`../pet-desktop/scripts`](../pet-desktop/scripts) 里的
> `render-demo-gif.mjs`）——你看到的就是桌面上的样子。

## 安装

```sh
dsh plugin --profile web add @seaveyon/dsh-pet
```

本包声明了 `dsh.bundle.patch`，`dsh plugin` 会同时安装 npm 依赖并把
[`cordis.patch.yml`](cordis.patch.yml) 的 loader 行并入 profile——无需手动改 YAML。
重启 `dsh web` 并硬刷新页面，插件立即开始为桌面 App 提供状态。

> 这一行 loader 是必需的：client 模块系统通过扫描宿主 Loader 的活动条目来发现插件
> bundle，仅作为普通依赖安装的包永远不会被伺服。该行激活的宿主插件只拥有一个路由——
> 下文说的桌面 App 启动器——别无他物。

## 使用宠物

宠物本体由桌面伴侣 App 显示在你的桌面上。Web 界面里你看到的是 **设置 → 宠物**：

- 桌面上显示哪只宠物：两个内置形象（deepseek-chan 与
  ai-sleepy-silver-wolf），以及导入到桌面 App 里的宠物。
- 宠物的名字。
- 桌面伴侣的召唤按钮。桥接本身常开——驱动桌宠就是本插件存在的意义；桌面 App
  不在线时桥接静默失败，开着没有任何副作用。

### 从面板启动桌面 App

在回环页面（DSH server 与浏览器同机）上，只要探测不到桌面 App，伴侣一行就会
提供「启动桌面 App」按钮。按钮会把请求发给运行在 DSH server 里的宿主面
（`POST /dsh-pet/launch-desktop`，见 [`src/launch.ts`](src/launch.ts)）：只接受
回环来源，强制自定义请求头使跨站页面无法偷触，profile 有登录门时还要求带会话。
远端宿主场景下面板从不显示该按钮——否则会把宠物启动到服务器上，而不是你的桌面。

宿主按以下顺序决定启动什么：

1. 本次安装中对应平台的可选依赖包里的伴侣二进制——
   `@seaveyon/dsh-pet-desktop-darwin-arm64`、`-darwin-x64` 或 `-win32-x64`，
   npm 的 os/cpu 选择器只会下载与你机器匹配的那一个。它与插件版本锁定
   （optionalDependencies 写的是完全相同的精确版本号），桥接协议绝不会错配；
   macOS 上 npm 安装的文件不带 quarantine 属性，所以未签名也能直接启动，
   不会触发 Gatekeeper。精灵素材仍随主包发布（`desktop/assets/`，由发布流水线
   在打包时放入），启动器通过 `DSH_PET_DESKTOP_ASSETS` 把素材目录指给二进制。
   在开发检出中，这一角色由 `bun run build:desktop` 暂存的
   `desktop/dsh-pet-desktop-*` 副本承担。
2. 已安装的副本，各平台不同。macOS 上是 `DSH Pet.app`——先按 bundle id 解析，
   再查标准 Applications 目录（开发和拆分前的旧包走这条路）。Windows 没有
   `open -b` 也没有安装器，回退为指向 exe 路径的 `DSH_PET_DESKTOP_APP` 环境变量。

两者都找不到时，面板改为给出下载链接。

有 settings 服务时配置写入 DSH settings，否则回退 `localStorage`——远端浏览器
（settings RPC 不出服务器）也走本地存储。

### 选择器就是桌面花名册

选择器的单一数据源是桌面 App：当它应答 `GET http://127.0.0.1:45731/pets`
时，返回的花名册（含内置形象）就是整个列表，所有预览都是桥接服务上的精灵条带，
用步进式 CSS 背景动画播放。已知内置 id 沿用本地化名字；其余 id 视为导入宠物，
显示名由 id 美化而来并带"导入"角标。桌面
App 未应答（或不可达）时选择器为空——宠物在桌面上，页面不提供替身名单——只显示
"未连接"提示，面板打开期间会静默重试一两次；由于两侧 id 一致，已存储的 petId 在桌面
应答后仍保持选中。已选中但暂时不可达的导入宠物在桌面侧的表现由桌面 App 自己负责。

## 原理

本包是双面 DSH 插件：宿主面（[`src/index.ts`](src/index.ts)）注册唯一一个启动路由，
客户端面（[`src/client/`](src/client)）由 shell 的
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
bun run build   # 产出 dist/index.js（宿主：启动路由）与 dist/client.js（浏览器 bundle）
bun run test    # 基于 @seaveyon/dsh-plugin-testkit 客户端替身的 jsdom 套件
```

## License

MIT。本项目是独立软件，与 DeepSeek AI 无隶属或背书关系。
