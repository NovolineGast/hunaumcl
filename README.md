# HUNAUMCL

基于 Electron + TypeScript 的 Minecraft Java 版桌面启动器，面向 Windows、macOS 和 Linux。

当前已支持原版、Fabric、Forge、NeoForge 组件选择与事务安装，以及 OptiFine、Fabric API、OptiFabric 组合管理；包含字节级下载进度、Microsoft / 离线账号管理、实例独立设置、三种版本隔离策略、实时日志和结束游戏。窗口使用无边框标题栏，最小化、最大化/还原和关闭按钮集成在顶部导航中；页面与弹窗有过渡动画，并遵循系统减少动画偏好。Microsoft 登录需要配置自己的 Client ID 和 Minecraft API 资格；实际验证范围见下文。

## 开发

使用 Node.js 24 LTS 和 npm。

```sh
npm ci
npm run dev
```

首次运行 Electron 时会下载对应平台的运行时。开发环境不需要预先安装 Java；检查游戏条件时会显示缺少的 Java 版本。

```sh
npm run check          # 严格类型检查、协议/持久化测试、生产构建
npm run start          # 运行生产构建，需先 build 或 check
npm run test:desktop   # 构建并运行真实 Electron 窗口测试
npm run package:portable  # Windows 便携版，输出到 release/
```

Windows 便携版运行 `release/HUNAUMCL-<版本>-win32-x64/HUNAUMCL.exe`。它未签名，首次运行可能触发 SmartScreen 提示；游戏数据默认仍保存在用户数据目录，可用 `HUNAUMCL_DATA_DIR` 指定到便携目录。

桌面测试使用独立临时数据目录及注入的确定性 Mojang 传输数据，验证 IPC、窗口隔离、实例创建、账号增删改与切换、实例设置保存及重载、预检、下载中的字节/速度更新、取消与重试、安装状态、弹窗过渡及减少动画、搜索与运行环境页面，截图输出到 `test-results/`。它与下面的真实游戏验证是两类测试。

## 安装与运行游戏

1. 顶部点击「下载」，选择 Minecraft 版本与实例名称。1.12.2 使用 Java 8，1.20.1 使用 Java 17，1.21.1 使用 Java 21。
2. 在下载页选择加载器或 OptiFine，点击「创建并安装」，等待客户端、支持库、日志配置、资源及组件下载校验完成。已有实例可在「版本选择」中进入「组件安装」，修改选择后保存并安装。
3. 在启动页左侧进入账号管理，配置并登录 Microsoft 账号，或添加离线账号；离线名称为 3–16 位字母、数字或下划线。
4. 通过左侧「版本选择」切换当前实例，点击「版本设置」配置此实例的 Java、内存、窗口、账号绑定与隔离方式；保存后在下一次启动生效。
5. 点击左侧「启动游戏」，确认账号后启动；尚未安装的实例在同一位置显示「安装游戏」。
6. 下载时顶部持续显示进度、速度、当前文件、文件数和预计剩余时间；「任务与日志」提供取消与结束游戏。页面重载后可恢复查看当前任务。

## 账号与实例设置

离线账号支持新增、改名、删除、选择当前账号；记录在 `accounts.json`，重启后仍保留。内部账号 ID 与名称分离。修改离线名称会按 Minecraft 约定重新生成离线 UUID，可能改变存档中的玩家身份，界面会明确提示。删除账号只删除记录，保留游戏文件和存档。

未绑定账号的实例跟随启动器当前账号；绑定后使用固定账号。单次启动可临时改选其他已保存账号。绑定的账号被删除时，不会静默切换身份，而是提示重新选择。

每个实例单独保存：显示名称、自动/手动内存（512–65536 MiB）、自动/指定已检测 Java、窗口宽高、全屏模式、绑定账号与版本隔离。手动 Java 通过不含路径的 ID 选择，启动时重新验证其可用性、主版本和 CPU 架构。恢复默认设置仅重置表单，点击保存后生效。修改显示名称不会移动目录。

## 加载器与高清修复

- Fabric：官方 Loader Profile → 继承原版 → 完整库补全，可选 Fabric API。附属模组会检查实际 `fabric.mod.json`，包括 Minecraft 和 Fabric Loader 版本约束。
- Forge / NeoForge：下载并校验安装器 → 解包 install_profile/version.json → 安装库 → 按客户端 sides 执行 processor → 验证输出 → 补全最终启动库。没有用“只改 mainClass”代替安装。NeoForge 1.20.1 使用历史 forge Maven 项目，后续版本使用 neoforge 项目。
- OptiFine 单装：解析安装器 Config 元数据并生成继承启动配置；1.14 起运行 Patcher，1.12.2 等旧版直接复制原始 JAR 作为 LaunchWrapper 库。提取安装器内置的 LaunchWrapper，没有内置时补全标准 LaunchWrapper 依赖。
- Forge + OptiFine：按 OptiFine 目录声明检查 Forge 完整版本或旧式构建号；OptiFine 作为模组安装到有效 gameDir 的 mods。不是把声明版本当成最低版本。
- Fabric + OptiFine：必须同时选择适用的 OptiFabric，并检查其实际加载器约束。NeoForge + OptiFine 在前后端均拒绝。
- 组件变更先保存选择；安装成功才切换生效配置，失败时仍可使用上次成功的启动配置。组件页分别显示“已安装”和“本次选择”。

安装使用每次独立的事务工作区与运行目录，最终通过 install.json 切换入口。它保留原版 jar、版本继承链和 processor 生成的依赖。只管理本次明确拥有的 mods 文件；同名不同内容的用户文件会报冲突并保留。组件切换和修复不删除 saves、config 或整个游戏目录。

## 版本隔离

- **独立**（默认）：`instances/<uuid>/game`，隔离 mods/config/saves/options/截图。
- **共享**：`games/shared`，所有明确关闭隔离的实例共用游戏目录。共享的 mods/配置可能冲突，界面会提示。
- **自动**：有加载器的实例使用独立目录；原版实例若已有独立 mods 或 saves，也继续使用独立目录；否则使用共享目录。自动判断以真实目录内容及已安装组件为依据。

最终工作目录与 `${game_directory}` 始终由同一策略生成；assets/libraries 共享不等于游戏目录共享，natives 仍按每次启动隔离。切换隔离方式不会搬移或删除原存档；托管的 OptiFine/API 等组件在新目标目录缺失时会验证源文件再补入。同一共享游戏目录不能被两个实例同时启动，运行中也不能安装到该目录。可通过卡片或设置页打开当前有效游戏目录。

旧的 schemaVersion=1 实例记录若没有 settings 字段，会在读取时补充默认值，保存时写回；不会清空已有实例。当前没有全局可调内存/窗口设置，所以「自动」使用内置推荐策略，而非用户自定义全局设置。

离线身份用于本地游戏，不具备正版服务器认证能力。Microsoft 登录采用浏览器设备代码授权、Xbox/Minecraft 许可与档案验证、系统加密保存及自动刷新，启动使用服务返回的玩家 UUID 与会话。进入「设置 → 账号管理 → Microsoft 登录设置」填写自己的公共客户端 ID，或使用 `HUNAUMCL_MICROSOFT_CLIENT_ID` 环境变量。注册 Entra 应用不会自动取得 Minecraft Java 版 API 资格；未通过审核时 Minecraft 服务会返回 403，需要按 [Java 版游戏服务 API 审核流程](https://help.minecraft.net/hc/en-us/articles/16254801392141)申请。

原版基础安装接受新版 `arguments` 和旧版 `minecraftArguments`，仍要求官方 Java 版本声明、大小与校验值。旧版参数保留原生库目录和 classpath 的 JVM 默认值；继承解析将 OptiFine tweaker 追加到原版参数。早期原版、旧式资源映射、LiteLoader/Legacy Fabric/Cleanroom 尚未提供完整支持，不应把本次实现理解为已达到完整的历史版本兼容。ARM64 和三系统真机范围也仍需扩展验证。

## 工程结构

```text
apps/desktop/src/
  main/           Electron 窗口、IPC 来源与参数校验
  preload/        固定命令白名单
  renderer/       游戏库、账号页、实例设置、下载进度、后台任务及日志
packages/
  contracts/      公开 DTO、IPC 名称、输入 schema
  domain/         规则、Java 约束、平台映射、继承环检查
  application/    实例、预检、安装与启动用例、运行时端口
  runtime-node/   元数据、下载校验、Java、XMCL 适配、进程与日志
tests/            协议、事务、取消、进程、日志及数据损坏测试
```

领域层不依赖 Electron、Node I/O 或界面。Renderer 无 Node 权限，Preload 不暴露通用 IPC、文件或进程 API。后台返回有限的预检摘要，不向窗口传递执行文件路径和凭据。

## 数据与行为

默认保存在 Electron 用户数据目录下的 `data/`。开发或测试可在启动进程中设置 `HUNAUMCL_DATA_DIR`；这是本地进程配置，不是 UI 输入。

```text
data/
  instances.json                  schemaVersion=1 的实例记录
  accounts.json                   schemaVersion=2，公开账号身份与系统加密的微软凭据
  microsoft.json                  公开的应用 Client ID，本地配置
  instances/<uuid>/game/          每实例独立目录
  instances/<uuid>/install.json   完成安装后的版本/平台与描述文件摘要
  instances/<uuid>/runtime/      各次成功组件安装的完整运行文件
  games/shared/                  关闭隔离时的有效游戏目录
  transactions/<uuid>/           工作区、journal、处理器日志、托管模组备份
  shared/                        共享的版本、支持库和 assets
  sessions/<uuid>/               每次启动独立 natives 与 Java 参数文件
```

写入串行执行，并先写同目录临时文件再重命名。损坏或更高版本的实例记录会报错并保留原文件，不会默默重置。此版本暂不提供删除实例、导入或配置迁移。

版本列表直接读取 Mojang HTTPS 元数据；版本 JSON 验证官方清单中的 SHA-1。传输只接受明确的官方 HTTPS 主机、禁止跳转；最多 8 个并发文件，单请求总超时 120 秒，失败最多尝试 3 次。按大小和 SHA-1 检查已有文件，仅下载缺失/损坏内容，校验后通过临时文件提升；完成全部依赖后提交安装记录，不触碰 saves。

下载进度按流中已收到的字节更新，不必等待单个文件完成；UI 每 250 毫秒读取一次有界快照。阶段字节统计区分已有文件复用和实际网络传输，速度只统计网络字节；无有效速度时不虚构 ETA。顶部总体安装百分比采用元数据、支持库和资源阶段的加权估计，阶段内按字节推进；校验并提交安装记录前不显示 100%。失败重试可能让阶段字节进度回退，因为失败尝试不算有效文件。

取消会等待下载和 Java 处理器结束，保留之前成功的 receipt。组件提交期间对托管模组写入独立的持久化变更记录，重启时检查是否已发布 receipt，再完成提交或回滚；遇到用户修改过的冲突文件保留原件与备份。事务目录和处理器末尾输出保留用于诊断。此机制不是持久化分段下载续传，异常断电仍可能留下孤立 `.part`。同一时刻只允许一个安装或启动准备任务。

启动读取已安装的本地描述和完成记录，不要求再次联网获取清单。默认匹配同架构 Java，使用 argv 数组且 `shell:false`，Java 9+ 使用 `@argfile`，避免 Windows 命令行长度问题。每次原生库解压到独立 session 目录。日志解析 Mojang XML 控制台输出为可读文本，对敏感字段与用户路径脱敏；每个会话最多保留 400 行且 64,000 字符，通过有界快照轮询提供给 UI。退出启动器会取消任务并结束由本次启动器管理的游戏进程。

原版下载仍使用官方主机；组件元数据优先官方源、部分目录及 Maven 失败时回退 BMCLAPI。OptiFine 优先 BMCLAPI，节点不可用时解析官方页面回退 OptiFine 官网；两条路径都核对 BMCLAPI 内容 hash（现代文件 SHA-1、部分历史文件 MD5），缓存额外记录 SHA-1。官方响应缺少总大小时仍显示实时字节与速度，并明确标注总大小未知。Fabric API 使用 Modrinth，OptiFabric 使用 CFWidget 的游戏版本/文件记录和固定 ForgeCDN。OptiFabric 无上游校验和时按 HTTPS、目录大小及实际模组身份校验，并记录首次下载的 SHA-1，不能把它描述成发布者签名验证。组件下载在桌面壳使用 Electron 网络栈，TLS 检查保持启用。

尚无用户可配置的镜像/代理设置、Java 自动下载或完整离线版本目录。元数据目录为进程内缓存；安装后的游戏文件和描述已保存到磁盘。成功运行目录与失败事务当前保留，后续需要增加可审阅的清理功能。

Java 扫描覆盖 PATH、JAVA_HOME 及常用安装目录，macOS 额外调用 `java_home`。探测子进程限制为 4 并发、单个超时 5 秒。当前采用保守预检策略：匹配版本元数据明确声明的 Java 主版本和本机架构；高版本 Java 不自动视为兼容。没有 Java 元数据或包含继承的版本明确报告暂不支持，不猜测参数。

## 验证范围

- TypeScript 严格检查、自动化测试与生产构建可通过 `npm run check` 复现。
- 本地 Windows 的真实 Electron 窗口测试可通过 `npm run test:desktop` 复现。
- 已验证开发模式和真实 Mojang 接口：读取正式版本列表，并为 1.21.1 匹配本机 Java 21。
- 三系统 CI 配置执行类型检查、测试和构建；配置存在不代表已经在远端运行过。
- 已在 Windows x64 通过实际官方文件完成 1.21.1 安装（3,888 个去重资源对象），使用本机 Java 21 启动离线游戏；观察到 LWJGL、声音引擎、渲染纹理图集初始化，进程持续运行 30 秒，并通过启动器结束。
- 已再次通过已保存账号与实例绑定启动 1.21.1，并验证指定 Java、1536 MiB 内存及 1000×600 窗口进入实际启动参数。单元/集成测试共 53 项，另有真实 Electron 窗口测试覆盖账号操作、设置重载、字节级下载速度及减少动画模式。
- 加载器实现后的自动测试共 64 项，另有桌面测试验证组件互斥、Forge/OptiFine 组合选择和隔离选项保存。Windows x64 的 Fabric+API、OptiFine 单装、Forge+OptiFine、NeoForge、Fabric+OptiFine+OptiFabric 五种真实运行记录，不以“安装完”代替游戏初始化证据。
- 已在 Windows x64 分别完成 1.12.2 + OptiFine HD_U_G5、HD_U_C5 的真实下载、安装与 Java 8 离线启动，确认 OptiFine 版本、声音和纹理图集初始化后持续运行至少 15 秒；C5 实际触发了镜像超时后的官网回退及标准 LaunchWrapper 补全。记录为 `test-results/legacy-optifine-HD_U_G5.json` 和 `test-results/legacy-optifine-HD_U_C5.json`。可在已构建后运行 `node scripts/validate-legacy-optifine.mjs` 复现，需要联网及本地 Java 8，数据隔离在 `.research/legacy-optifine-validation/`。当前自动测试共 73 项。
- 真实游戏验证没有操作存档或加入服务器，未将进程启动等同于全部游戏功能验收。记录与截图位于本机 `test-results/`；测试数据隔离在 `.research/game-validation/`，不影响默认用户目录。
- 尚未在 macOS/Linux 真机验证，也尚未生成安装包或接入自动更新。三系统平台适配仍需实际游戏验证。
- 微软登录加入后自动测试共 89 项，Electron 桌面测试覆盖 Client ID 保存、设备码、取消与重载、系统加密及账号切换。微软/Xbox/Minecraft 服务响应使用受控测试数据，真实账号授权需自己的 Client ID 与 Minecraft API 准入后再验收。截图见 `test-results/microsoft-settings.png`、`microsoft-device-code.png`、`accounts-microsoft.png`。

## 后续开发顺序

1. 使用自己的 Microsoft 应用注册与 API 资格完成真人授权验收，扩展皮肤管理。
2. 增加任务 journal、错误恢复、Java 管理与下载源配置。
3. 扩展更多加载器/游戏历史版本、整合包与诊断。
4. 完成 macOS/Linux 真机验证及签名安装包。

版本解析、启动参数和原生库准备使用 MIT 许可的 `@xmcl/core@2.16.2`，组件安装计划使用 `@xmcl/installer@6.3.6`，由 HUNAUMCL 执行受控下载、处理器、事务提交和回滚。发布包存在两个兼容问题：用 npm override 将 @xmcl/unzip 固定到 2.1.2，构建与测试 alias 适配 installer 引用但 core 未发布的 utils/isNotNull 子路径；没有修改 node_modules 源码。Fabric 版本约束使用 @xmcl/semver，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

界面截图：[下载进度](screenshots/download-progress.png) · [账号管理](screenshots/accounts.png) · [实例设置](screenshots/instance-settings.png)。这些界面截图由可重复的桌面测试生成，下载数据使用受控测试流；真实游戏验证记录另存本机 `test-results/real-game-validation.json`。

当前实现独立编写，不包含其他启动器的源码。
