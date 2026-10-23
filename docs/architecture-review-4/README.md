# 架构审查第 4 轮：功能接口、唯一实现与跨层数据流

日期：2026-10-23。代码基线 `daaabd8`，修复在分支 `claude/architecture-review-4`。上一轮（第 3 轮）结论见 [architecture-and-features.md](../architecture-and-features.md) 的 Git 历史。

## 1. 方法

- 词汇和判据来自 Matt Pocock `codebase-design`：module、interface（调用者必须知道的一切：类型、时序、错误、性能）、depth、seam、adapter；**删除测试**（删掉后复杂度消失 = 转发层；复杂度散回 N 个调用者 = 它在起作用）；**一个 adapter 是假想的 seam，两个才是真的**。
- 一个功能一个实现：同一功能可以有多个按钮，但必须进入同一条实现。界面上的产品选项（6 种目录布局、网格/列表、单盘/双份/顺序填盘）不是冗余实现。
- **数据安全冗余不是软件冗余**：校验、签名日志、收据、恢复区原件、身份绑定各防一种故障，保留。重复实现、重复规则、跨层重复传输、从不触发的兜底才删。
- 并行分析：8 个只读会话各审一个功能，贯穿 renderer → main → core/platform → 子进程，各自给出接口表、问题和需求核对（本目录下 8 个英文分报告）。另有 4 个只读子任务做全局清单（Action/IPC、导出与引用、renderer 重复、跨层数据流的实测）。
- 其他会话：本轮开始时，另有会话在做 records v5（`core/recovery.ts` 存储）、按每个文件只校验一次（`recovery.ts`/`originals.ts`/`duplicate-removal.ts` 哈希）、UI 测试序列，另有未合并分支 `progress-everywhere`、`speed-accuracy`、`stage-color-bars`、`detailed-logging`、`exfat-copy-path` 等。与它们重叠的问题本轮只记录、交给对应会话，不重复改。主检出里另有会话正在改写 `architecture-and-features.md`（只写文档、不改代码，编号 R1–R13）；本报告与它互相印证，合并时以代码为准。

| 分报告 | 范围 |
|---|---|
| [sources.md](sources.md) | 设备发现、选择、只读扫描、扫描记忆 |
| [planning.md](planning.md) | 媒体识别、路由元数据、目录模板与布局、空间分配、审核 |
| [copy.md](copy.md) | 队列、复制执行与校验、半写续传、exFAT、AppleDouble、残留、删除原件、盘到盘备份 |
| [organize.md](organize.md) | 整理现有文件、备份目录检查、恢复列表、撤销/释放 |
| [duplicates.md](duplicates.md) | 移除重复项 |
| [progress.md](progress.md) | 进度、剩余时间、速度、盘活动、资源限制、状态发布节奏 |
| [errors.md](errors.md) | 错误/警告、跳过、历史、后端消息、四语言 |
| [shell.md](shell.md) | 外壳、设置、renderer↔main 接口 |

## 2. 第一性原理与分层

应用只需做四件事：**发现**源与目的地；把源的内容**计划**成每个目的地上的确定目标；**执行**复制（或同盘整理）并证明结果；把状态**呈现**给界面。依赖只向下：

```
renderer（只发 Action、只读 AppState）
  → preload（透明桥接）
  → main（授权、任务生命周期、偏好、编排）
  → core（inventory / plan / execute / recovery / duplicates，纯文件系统逻辑）
  → platform（卷、相机桥、ExifTool、文件时间、缩略图、盘活动：真实 OS adapter）
  ↘ scan utility process（只读扫描，隔离卡死的卷）
```

目标形态只有两条业务主线：**导入复制**（plan → executeMany）和**可恢复的图库变更**（整理、去重都进 recovery 日志）。两者共享清单、路由元数据和内容事实。

## 3. 接口清单：一个接口 → 一个实现（修复后）

### 3.1 renderer → main：`DesktopAPI` 7 个方法

| 方法 | 通道 | 唯一实现 |
|---|---|---|
| `state()` | `importer:state` | `stateChannel.snapshot` |
| `subscribe()` | `importer:updated` | `createStateChannel.publish` ← `emit()` |
| `action(Action)` | `importer:action` | `main.action()`，42 种 Action，见 3.2 |
| `exif(path)` | `importer:exif` | `allowed()` → `platform/metadata.metadata()` 读全部标签（**原 `inspect` 已并入**） |
| `thumbnail(path)` | `importer:thumbnail` | `platform/thumbnails.thumbnail`（系统解码，失败用 `embeddedPreview`） |
| `duplicateGroups()` | `importer:duplicates` | main 内存中的分组，按 revision 拉取 |
| `errorPaths(jobId,code)` | `importer:errorPaths` | `job-issues.issuePaths`，分组错误的全部路径按需取 |

### 3.2 Action：50 → 42

| 功能 | Action | 唯一实现 |
|---|---|---|
| 刷新源与目的地 | `refresh`（及 5 秒定时） | `refresh()` → `mountedVolumes`/`getSources`/`volumeInfo` |
| 选源文件夹 / 整盘备份 | `chooseSource{backup}` | `resolveFolderSources` |
| 选择 / 移除目的地 | `chooseDestination` / `removeDestination` | `validateDestination` |
| 勾选 / 忘记设备 / 关闭重连提示 | `selectSource` / `forgetDevice` / `dismissReconnected` | `DeviceSelection` |
| 置顶 | `moveToTop` | `queue-order.moveToFront` |
| 只读扫描（一个或全部已选） | **`scan{sourceId?}`**（原 `scanSource`+`scanSources`） | `scanSource()` → `scanSourceInWorker` → `inventory`+`analyzeSourceCameras` |
| 审核 / 应用 / 丢弃 | `preview` / `previewOrganization` / `applyReview` / `discardReview` | `previewSource` → `prepare()`；应用 = 同一 `Prepared` 交给 `run()` |
| 开始 / 暂停 / 停止 | `start` / `pause` / `stop` | `enqueue` → `pump` → `startJob` → `run` → `finishJob` |
| 重试 / 跳过 | `retryJob` / **`skip{path?,all?}`**（原 `skipFile`+`skipAndContinue`） | 重新入队同一计划器 |
| 整理目的地 / 备份目录 / 任意文件夹或文件夹源 | `organize` / `organizeBackup` / **`organizeFolder{sourceId?}`**（原 `organizeFolder`+`organizeSourceFolder`） | `queueOrganization` → `prepare` → `executeReorganization` → recovery 日志 |
| 整理范围与本次选项 | `chooseOrganizationFolders` / `resetOrganizationFolders` / `organizeOptions` | `state.organizationFolders`、`takeOrganizeOptions`+`sourcePolicy` |
| 继续暂停的整理 | `continueOrganization` | 有日志 → `resumeOrganizationJob`，否则按保存的请求重新排队 |
| 恢复列表与操作 | `refreshOrganization` / **`recovery{op:'resume'|'finalize'|'undo'|'delete'}`**（原 4 个 Action）/ `measureOrganizationRecovery` | `listOrganizations`；`resumeOrganizationJob(op)` → recovery 的 resume/finalize/undo/delete |
| 删除已备份原件 | `measureOriginals` / `deleteOriginals` | `core/originals`（现已纳入任务生命周期，见 F3） |
| 移除重复项 | `duplicatesScope` / `duplicatesChooseFolder` / `duplicatesScan` / `duplicatesStop` / `duplicatesRemove` | `scanDuplicates`；`resolveGroups` → `removeDuplicates` → recovery 日志 |
| 清理中断残留 | `cleanResidue` | `findResidue`/`cleanResidue` |
| 设置 | `preferences{patch}` | `acceptedPreferences(settingsLocked)` → `normalizePreferences` → `save` |
| 未知格式规则 | `unknownRule` | `inventory.rules` |
| 错误：清除 / 跳过 | **`clearErrors{ids?,severity?}`**（原 `clearError`+`clearErrorIds`+`clearErrors`）/ `acknowledgeErrors` | `error-log.clearErrors`（一个函数）/ `acknowledgeJob` |
| 在访达中显示 / 窗口按钮 | `reveal` / `window` | `allowed` → `shell.showItemInFolder` / BrowserWindow |

### 3.3 核心规则的唯一归属

| 规则 | 唯一实现 |
|---|---|
| 卷枚举与相机卡判定（macOS/Windows/Linux 三个真 adapter） | `platform/volumes.ts` |
| 协议相机（macOS ImageCaptureCore） | `platform/camera-bridge.ts` ↔ `Sources/CameraBridge` |
| 媒体/伴随/系统文件/未知格式 | `core/inventory.ts` + `media-formats.ts` + `core/known-files.ts` |
| 路由元数据（相机、日期+时区、编辑导出） | `platform/metadata.metadata({details:false})`，按 stat 缓存 |
| 目录模板的 token 值、展开、编辑导出模板 | **`folder-template.ts`**（`templateValues`/`expandTemplate`/`editedTemplate`，core `folder()` 与设置预览共用） |
| 6 种布局里的子目录 | `media-formats.layoutFolders` |
| 已存在同内容跳过、同名不同内容进 `Conflicts/<内容 id>/` | `core/index.ts` `existingMatches`/`allocate` |
| 单盘/双份/顺序填盘与空间 | `core/allocation.ts` |
| 复制：一次读源写多盘暂存 → 回读 → 硬链接或独占发布 | `core/index.ts` `executeMany` |
| 整理/去重的可恢复变更 | `core/recovery.ts` 签名日志 |
| 任务是否在运行 | **`shared.isRunning` / `isLive`**（原 9 处手写阶段列表） |
| 设置何时锁定 | **`settings-lock.settingsLocked`**（main 与 renderer 同一规则，现在含去重扫描） |
| 任务开始/结束的登记 | **`main.startJob` / `finishJob`**（原 4 份手写副本） |
| 操作报告写入 | **`main.writeReport`**（原 4 份） |
| 状态跨 IPC 的去重 | `state-channel.ts` 的一个引用表（清单、任务错误、问题文件、错误日志、历史、去重 earlier 列表） |
| 后端消息与四语言 | `messages.ts`（key → 四语言）+ `renderer/i18n.tsx` |

## 4. 发现与修复

### 4.1 行为错误（已修复）

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| F1 | `idle()` 写成 `!recoveryRefresh`；自 `058592d` 起它是对象，恒为假，ExifTool 与哈希线程**从不释放**，盘在工作结束后仍被占用，无法立即推出 | 改为 `!recoveryRefresh.running` | `633c194` |
| F2 | 从“审核后整理”启动的任务不带 `organization`/`folders`/保存的请求：暂停当成导入、卡片不能继续/跳过/重试；审核后的导入不标记去重扫描过期、也不触发随后的备份目录整理 | 四种任务（直接排队、审核、恢复操作、移除重复项）统一 `startJob`/`finishJob`；审核整理与一键整理是同一种任务 | `633c194` |
| F3 | 删除已备份原件不在任何生命周期里：停止和退出不能结束它，`idle()` 可能在哈希中途关闭哈希线程，Mac 可能睡眠 | 登记到 `originalsControls`：可停止、退出时等待、计入 `idle()`、保持唤醒 | `633c194`；`keep-awake.test.ts` 新增 |
| F4 | 去重扫描时设置页仍可改任务设置，修改被主进程悄悄丢弃 | `settingsLocked` 加入去重扫描/移除；main 只用这一条规则 | `633c194`；`settings-lock.test.ts` 新增 |
| F5 | 去重扫描 EXIF 读取失败也记成 `read:true`，之后 stat 不变就永不重读，可能漏组 | 只在读取成功时记录 | `6ed3a0c`；`duplicates-detection.test.ts` 新增（先失败后通过） |
| F6 | 导入结束时为每个已校验文件 `filter` 全部计划条目，O(n²)，5 万文件约 25 亿次比较，主进程卡住 | 一次建 `Map` | `633c194` |
| F7 | 仪表盘的警告数不扣除已清除的警告，与“全部错误”不一致 | 改从 `collectErrors` 计数 | `600199c` |
| F8 | 单条元数据问题行没有“在访达中显示”（`errorPath` 排除 `text` 消息，分组行用 `pathOf` 有） | 统一用 `pathOf`，删除 `errorPath` | `600199c` |
| F9 | 去重页翻页后返回，已出队但被取消的文件不再获取缩略图/EXIF | “已加载”只看结果缓存，在途请求单独管理 | `600199c` |

### 4.2 跨层重复传输与性能（已修复）

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| P1 | 每次发布（忙时约 6 次/秒）都重新序列化所有任务的错误、问题文件、错误日志和历史。实测 5 个任务 × 2,000 个失败：每次 2.46 MB，主进程序列化约 110 ms，renderer 每次渲染再算两遍 `gatherErrors` 约 760 ms | 状态通道的一个引用表覆盖它们（错误按长度做版本，因为是原地追加）；renderer 在错误日志对象不变时复用汇总结果 | `e61b79c`；`state-channel.test.ts` 新增 |
| P2 | 清单的 `listing`（每个目录的全部条目名，仅 main 复用扫描时需要）随清单传给 renderer；去重 `earlier` 列表（可达整库大小）每次发布都传 | 发送时去掉 `listing`（每个清单只做一次）；`earlier` 走引用表 | `785b149` |
| P3 | 扫描子进程每 8 个文件就发一次相机汇总，每次复制至今全部问题（O(n²/8)） | 改为最多每 250 ms 一次 | `e61b79c` |
| P4 | 盘活动每秒强制一次全量发布 | 新样本随下一次发布带出；只有 1 秒内没有任何发布时才强制 | `e61b79c` |
| P5 | `inspect` 每次打开元数据都抽取最大 20 MB 的内嵌 JPEG，base64 后跨 IPC，界面从不显示（UI-32 已移除预览） | 删除 `preview()` 与 `inspect`；只剩 `exif` | `4d34d54` |

### 4.3 冗余接口与臭抽象（已修复）

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| A1 | 3 个清除错误的 Action（只差 id / ids / 无）、2 个清除函数 | 1 个 Action、1 个函数 | `633c194` |
| A2 | 恢复列表 4 个 Action 都进 `resumeOrganizationJob(kind)` | `recovery{op}` | `633c194` |
| A3 | `scanSource`/`scanSources`、`organizeFolder`/`organizeSourceFolder`、`skipFile`/`skipAndContinue` 各是同一实现的两个入口 | 各合并为一个带可选参数的 Action | `633c194` |
| A4 | 阶段列表手写 9 处、忙碌判断手写 10 处、报告写入 4 份、任务收尾 4 份且已互相走样 | `isRunning`/`isLive`、`assertIdle`、`writeReport`、`startJob`/`finishJob` | `633c194` |
| A5 | `getSources` 已排除目的地，`refresh` 又过滤一遍 | 删除第二遍 | `633c194` |
| A6 | `isAcknowledged` 在 `errorTotal` 里复制一份 | 用同一个函数 | `f352009` |
| A7 | 只被测试使用的生产代码：`createIssueSink`、`nextQueued`、`shortCapacity`；ETA 中写了从不读的 `Legacy.smoother`、`JobState.known` | 删除，测试改用应用实际调用的接口 | `5156db7`、`600199c` |
| A8 | 模板 token 值在 core 与 renderer 各实现一遍，编辑导出的预览硬编码 `2026/202610` | `folder-template.ts` 一处实现，core 与设置预览共用 | `8dc33f4`、`600199c` |
| A9 | 4 个几乎相同的确认弹窗；两处各算一遍容量；renderer 里从不触发的 ETA/队列兜底 | 一个 `ConfirmSheet`、一个 `capacityUse`、删除兜底 | `600199c` |
| A10 | 146 行没有任何界面使用的翻译、1 行重复键；`Try again` 与 `Retry` 四语译文相同 | 删除；合并为 `Retry` | `e6fb145`、`600199c` |
| A11 | 编译器报告的未使用变量和导入（含 `ImportDesk` 中算了从不用的 `transferred`/`total`/`speed`、main 中失效的 `livePreferences` 副本） | 删除 | `70f2a86` |

### 4.4 需求缺口（已修复）

- **UI-26 标题栏总进度按钮**已在某次改版后丢失（总览只能从设置页重新打开）。现在导入台标题栏有“总览”开关按钮（`aria-pressed`），打开/收起总进度总览（`600199c`）。

### 4.5 独立审查发现（已修复）

实现之外另由一个审查子任务读完整个 diff。它确认了 F1 和状态通道的不变量（任务错误只追加或整体替换，其余字段都换对象），并发现：

| # | 问题 | 修复 |
|---|---|---|
| V1 | 删除原件可以被停止后，`deleteOriginals` 抛出中止会丢掉整个结果：已删除的文件不进报告、历史和列表 | 每个文件都以“已删除”或“保留（stopped）”结束，结果标记为已停止，main 照常记录（`41c4feb`；`source-handling.test.ts` 新增，先失败后通过） |
| V2 | 恢复操作结束后，任务在可能很慢的恢复列表重读期间仍占着 `active`，扫描、审核等被拒绝 | 重读之前先释放（`41c4feb`） |
| V3 | 移除重复项被停止后，重扫期间卡片一直显示“正在停止” | 先清除停止标记（`41c4feb`） |

行为变化（有意，记录在案）：`idle()` 修好后，ExifTool 和哈希线程会在每次空闲后关闭，下次使用时重新启动；这是原设计（“工作结束即可推出盘”），代价是一次进程启动。审核后的导入现在也会触发 `auto` 模式的备份目录整理；审核后的整理现在可以重试。

## 5. 已识别、本轮不改（含归属）

| 问题 | 原因 / 归属 |
|---|---|
| 恢复列表在每个任务后重读所有根目录；两层并发保护叠加（organize S4） | `claude/progress-everywhere` 正在重写 `listOrganizations` 与 `deferred-refresh`；合并后再只读被改动的根 |
| 进度形状：`scanProgress`、`deletingOriginals`、`OrganizationProgress` 仍是手工形状；列举阶段任务条停在 0%（progress S4） | `progress-everywhere`、`speed-accuracy`、`stage-color-bars` 正在改同一处 |
| 整理后清理空目录有两个实现：日志内的 `rmdir` 与日志外的 `removeOrganizedFolders`，后者才真正生效（organize S3） | 在 `core/recovery.ts`，records v5 正在改其存储；应把服务文件规则并入日志内清理后删除后者 |
| `DuplicateStore` 的 `restore`/`mode:'recorded'`/`folders`/`complete`/存储的 groups 无产品读取者；与 `DestinationIndex` 对“摘要是否可信”规则不一致 | 落盘格式归 records v5；应由 `DestinationIndex` 唯一拥有摘要规则 |
| 自动/询问模式下备份目录先检查一遍元数据，整理时又全部重读（placement memory 未用于整理，organize S5） | 涉及“只读一次”规则，与按每个文件只校验一次的会话协调 |
| 核心里的私有 `pool` 与 `devices.mapPool` 重复；6 种“同一文件”判断；11 处原子写 | `core/index.ts` 正被 exFAT、records v5、速度分支同时修改；单独小提交更合适 |
| renderer 自行判断“未知格式需提示”，与 core 判断不一致（planning S3，errors S8） | 应由 `gatherErrors`/inventory 给出 `unknown-format`；涉及错误面板交互，下一轮 |
| 应用文件名模式（暂存、收据、索引临时文件）在创建处与残留检测处各写一份（copy S3） | 建议一个 `core/app-files.ts`；与 records v5 的新存储位置一起做 |
| `RootApp.tsx` 1,900 行，`DuplicatesPage` 反向从它导入 10 个基础组件 | 拆出 `renderer/ui.tsx` 是机械移动，但会与所有在途 renderer 分支冲突；放在合并之后 |

## 6. 需求核对（摘要）

逐项状态见各分报告第 3 节。本轮结论：

- **已实现**：SRC-01/03–08/10、DST-01–07、FMT-01–15、META-01–11、ORG-01–21、COPY-01–14、SAFE-01–08/10/12、UI-01–25/27/29–41、LOC-01/02、ICON-04。
- **本轮补上**：UI-26（标题栏总进度）、UI-32 残留成本（不再生成无人显示的预览）。
- **部分**：
  - SRC-02/09：Windows/Linux 没有 PTP/MTP 相机 adapter，协议相机不能只读扫描。
  - ORG-22：编辑导出的路径固定为“先日期”，不跟随“先相机”顺序（是否要跟随需用户决定）。
  - COPY-03：首次见到的卡默认未选，要回答一次才会自动导入（`device-selection.ts` 有意设计，与 COPY-03 字面有出入，需用户确认）。
  - LOC-03：少数低层错误详情、原生对话框标题、跳过后历史里的错误代码仍是英文。
  - SAFE-11：整理时“释放已确认重复项”每次默认开启。
  - PROJ-07：Windows/Linux 使用自绘窗口按钮而非系统原生。
  - SRC-11：卡片上仍显示“Connected USB camera”标签（只是标签，不是检测宣传），请确认是否也要去掉。
- 未在本轮验证：真实相机卡、双盘、Windows/Linux 实机、物理断电。

## 7. 验证

在本分支的独立 worktree 中运行（日志在会话 scratchpad，不进 git）：

- `npx tsc --noEmit`：通过。
- `npm test`：1,209 项，1,208 通过，0 失败，1 项跳过（原有）。基线（修改前）为 1,202 项全部通过；新增 7 项回归测试，其中 F5、F7、V1 和状态通道的测试都先失败、修复后通过。
- `npm run build`：通过。
- `npm run codex:test -- --no-build`（真实 Electron 应用 + 临时夹具）：34/34 通过，包括一键整理经公开 Action 执行并写出报告、任一目的地的审核整理、重试、并发源、所有源原件与目的地标记逐字节不变。

未验证：真实相机卡、双盘、Windows/Linux 实机、物理断电；IPC 字节数的改善只在合成状态下测量（2.46 MB → 每次只发变化的部分），没有在运行中的应用里计数。

## 8. 合并说明

本分支从 `main@daaabd8` 切出，没有合并到 `main`。以下在途分支会与它在同一行冲突，合并时以本分支的接口为准：`progress-everywhere`/`speed-accuracy`/`stage-color-bars`（`main.ts` 的 `emit`、`RootApp.tsx` 进度组件）、`detailed-logging`（`main.ts`）、`sidebar-destination-status`、`residue-recoverable`（`RootApp.tsx`、`i18n.tsx`）、按每个文件只校验一次的会话（`originals.ts`、`main.ts` 的 `rememberImported`）。其中任何仍发送旧 Action 名（`scanSource`、`clearErrorIds`、`resumeOrganization` 等）或调用 `window.importer.inspect` 的代码，合并后会被类型检查直接指出。
