# 深模块接口收敛 Implementation Plan

> **For agentic workers:** 获得实施授权之前不要改业务代码。授权后按任务实施，使用 `superpowers:executing-plans` 或用户选定的 `superpowers:subagent-driven-development`。Checkbox 只标记未来工作。

**Goal:** 每个实际功能只留一个 interface 和一个 implementation；删掉同一事实的第二套算法、假 seam 和层间重复搬运。不新增端口、任务框架或仓库层。

**Architecture:** 保留现有深模块：`inventory` 是唯一列目录，`plan` / `executeMany` 是唯一导入字节路径，组织 journal 是唯一可撤销整理，`DestinationIndex` 是唯一可证明的 SHA-256 缓存，`metadataFromTags` 是唯一标签解释，`state-channel` 是唯一增量状态协议，`duplicate-rules` 是唯一分组纯函数。收敛发生在这些模块的调用方重复计算同一事实的地方。一个 adapter 的 port 不引入。

**Tech Stack:** TypeScript、Node、Electron、React、ExifTool、macOS ImageCaptureCore helper。检查命令：`npm test`（`node --import tsx --test desktop/tests/*.test.ts`），类型：`npm run typecheck`。

**Spec:** 本文件。依据是 2026-10-23 对八个功能簇的只读并行审查，词汇用 Matt 的 module / interface / seam / adapter / depth / leverage / locality。代码优先于 `docs/`。同日另有 [architecture-remediation](2026-10-23-architecture-remediation.md)，覆盖删除原件的部分结果、去重详情请求生命周期等本轮未重读的项；那些项不在本文撤回，也不在本文当作已证实。

## Global Constraints

- 本轮不改业务代码、测试、依赖，不提交。
- 一个功能一种 implementation。比较方案不是同时保留两套。
- A 与 B 能解决问题时，不拆成 A/B/C/D，不为假想的第二后端加 port。
- 旧的已签名 journal 与 import receipt 必须仍能读。可重建的缓存（placement、routing、scan-memory、重复文件上的 SHA）允许版本升级后整份作废并重算。
- 不把 FAT/exFAT 上 `ctime === mtime` 的 stat 当作内容证明。
- 导入的 stage 回读是校验本身，不是多余的一遍。组织整理的硬链接后再哈希同一 inode，才是多余的。
- `verifyCopies === false` 的新复制不是已验证内容，不能据此删源。
- 六种目录布局仍是 `folder` + `layoutFolders` 的参数，不为每种布局做一个执行器。
- 导入复制、整理改名、去重移走，是三种业务，不是同一函数的三种风格。它们可以共享 stage/publish，不能合成一个任务类层次。

## Review Focus

1. **顺序填盘后的同名文件**：先按字节把 family 分到盘，再算一次路径。留在盘 1 的文件不得留在只因已搬走的 family 才产生的 `Conflicts/` 里。
2. **exFAT 上的无人值守删除**：level 3 不得在字节不同时仍按 EXIF 删文件。显式选择仍可删相似项。
3. **旧整理 journal**：缺省 `strategy` 的旧清单仍按 copy 恢复。新运行默认 rename。
4. **placement 缓存版本**：规则 scope 一旦包含 `unknownRules`，旧缓存必须 miss 并全量再看，不能继续信任旧相对路径。
5. **空闲释放**：没有任何任务、扫描、审核、检查时，`closeMetadata` 与 `terminateHasher` 必须执行。修复 `idle()` 时不能在恢复列表仍在跑时关掉 ExifTool。

---

## 1. 总判

问题不是层太少。深模块已经在：列目录、计划与复制、组织 journal、目的地索引、标签解释、状态通道、设备选择记忆、去重规则。贵的是下一层把同一事实再算一遍，直到两份结果不一致。

已对照源码的缺陷：

- `idle()` 把 `recoveryRefresh` 这个对象当成布尔值。对象恒为真，`!recoveryRefresh` 恒为假，`releaseIfIdle` 永远不会调用 `closeMetadata` / `terminateHasher`（`desktop/main.ts:392-398`，对象创建于 `desktop/main.ts:84`）。
- `sourcePolicy('reorganize')` 返回 `strategy: 'rename'`，`run` 却写死 `strategy: 'rename'`，导入侧的 `strategy: 'copy'` 没人读（`desktop/run-policy.ts:19-22`，`desktop/main.ts:637`）。`beginOrganization` 的缺省参数仍是 `'copy'`（`desktop/core/recovery.ts:965`）。
- `deferredRefresh` 把 `AbortSignal` 传给 `run`，生产调用写成 `run: () => refreshOrganizations()`，信号被丢掉。中止走另一套 `listingControl`。
- level 3 对 strength `exif` 自动删除（`desktop/duplicate-rules.ts:106-107`）。删除循环会重算 SHA，但只在 `strength === 'sha'` 时比较（`desktop/core/duplicate-removal.ts:88`）。

下面每项都列出可行方案和利弊。推荐路径是实施时采用的那一个。未推荐的方案不要做成第二套实现留下。

## 2. 接口清单

一个 module 一行。Interface 是调用者必须知道的事实，不只是类型。Depth：deep 留着；shallow 只有在它是唯一一份规则时留着；pass-through 删掉或并进唯一调用方。

### 编排与 IPC

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| DesktopAPI | `desktop/preload.ts` | `state` 全量快照；`subscribe` 增量，首包必须是 reset；`action` 的失败写 `state.error`，promise 只在传输失败时拒绝；`inspect` / `exif` / `thumbnail` 要路径落在已允许根下；`duplicateGroups` 在 `revision` 变化时重取 | shallow，故意 | 保留。不要按功能拆通道 |
| action | `desktop/main.ts` | 一个判别联合，约五十个 `type`，一个 switch，未知 type 变成 `state.error` | shallow | 保留一个 switch |
| AppState | `desktop/shared.ts` | UI 快照。`Job.phase` 与 `Progress.phase` 用词不一致（规划期 job 是 `verifying`，progress 是 `planning`） | 类型，无行为 | 保留类型。规划期用词在 T10 对齐 |
| state-channel | `desktop/state-channel.ts` | `publish` 增 revision；清单按对象身份 intern；`review` 引用不变则省略；接收端丢旧 revision，无快照则排队 | deep | 保留。这是真 seam |
| messages | `desktop/messages.ts` | `{key, params}`；`formatMessage` 是唯一格式化 | shallow | 保留。不要把 `Message` 下推进 core |
| queue-order | `desktop/queue-order.ts` | 会话内置顶序；`nextRunnable` 跳过 `canStart` 为假的任务 | deep | 保留 |
| run-policy | `desktop/run-policy.ts` | import = 复制、不删源目录、不释放重复；reorganize = 改名、用本次整理选项。不读会翻转语义的旧偏好 | shallow | 保留，但 `run` 必须消费它返回的 `strategy`（T2） |
| acknowledge | `desktop/acknowledge.ts` | 仅 `complete \| error \| stopped`；省略 codes 则跳过全部错误并把 phase 置为 `complete`；不删文件 | 中等 | 保留。`isAcknowledged` 成为唯一跳过谓词（T10） |
| deferred-refresh | `desktop/deferred-refresh.ts` | `request` / `resume` / `defer` / `running` 生产在用；`pause` 与 signal 生产不用 | shallow | 删掉未使用的 abort 半边（T1） |
| plan / executeMany | `desktop/core/index.ts` | `plan` 一次；`error.sourceChanged` 时目前整份重跑。`executeMany` 一次读源、写各目的地的 stage、校验、硬链接或独占复制 | deep | 保留。重跑方式见 T7。不要把 `plan` 的参数袋再包一层 |
| executeDestinations | `desktop/core/destinations.ts` | 整理走 `executeReorganization`，导入走 `executeMany`；视频根目录分成多次运行、一次目的地结算；一个目的地失败不取消另一个 | deep | 保留。它不是落位层 |

### 来源

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| volumes | `desktop/platform/volumes.ts` | `MountedVolume`；`classifyVolume`：磁盘映像、`/`、明确内置盘不是来源；可移动或 DCIM 类布局是来源。`getSources` 附上 PTP，PTP 失败不隐藏卡。`source.id` = volumeId 或挂载路径 | deep | 保留，三个 OS 枚举留在函数内部。不要拆成 enumerate/classify/identity 四个 module |
| camera-bridge | `desktop/platform/camera-bridge.ts` | `cameraSources()`：无 helper 返回 `[]`。`prepareCamera` 只接受 `camera://`，暂存目录必须在临时根下。列出超时 10s，暂存 30min | shallow RPC，行为在 Swift | 保留这一个进程 seam。不要加第二 PTP 后端的 port |
| DeviceDiscovery | `Sources/CameraAdapters/DeviceDiscovery.swift` | 只列出无挂载点的非大容量存储。`stageCamera` 一次一个传输。id 是 uuid，缺 uuid 时是对象 id | deep | 保留 |
| NativeCameraBridge | `Sources/CameraBridge/main.swift` | stdin/stdout JSONL：`list`、`stage`。同一二进制的 `--set-file-times` 是另一项工作 | shallow | 保留进程边界。`list` 里多余的 `id: camera:` 字段删掉（T6） |
| device-selection | `desktop/device-selection.ts` | 会话键是 `source.id`。偏好键是 `deviceId`。文件夹不写入 `rememberedDevices` | deep | 保留。稳定 id 只用于偏好；会话键保持 `source.id`（T6） |
| folder-sources | `desktop/folder-sources.ts` | 用户所选路径 → 会话 `Source`，id `folder:${realpath}`。备份内的路径拒绝，同级其它路径仍加入 | shallow | 保留为唯一文件夹解析 |
| source-cameras | `desktop/source-cameras.ts` | 扫完之后从清单和元数据归纳机身，不决定哪台设备连着 | deep | 保留。删掉与 `recordedCamera` 重复的未知名称过滤（T9） |
| devices | `desktop/core/devices.ts` | 流槽与块大小按 `DeviceKind`。`kind()` 对每个 `stat.dev` 再跑一次 `diskutil` | deep（调度） | 调度留下。种类改由卷快照提供（T6） |
| drive-groups | `desktop/drive-groups.ts` | 只给带 `drive` 的文件夹分组。组长是当前数组第一项，随置顶改变 | shallow | 组长和容量在 `refresh` 算一次（T6） |
| drive-activity | `desktop/platform/drive-activity.ts` | 1s ioreg 采样。`activityTargets` 用最长前缀把路径映到盘 | 采样 deep，映射 shallow | 采样保留。映射改用 T6 的 `volumeOf` |

### 扫描与清单

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| inventory | `desktop/core/inventory.ts` | 深度优先。目录 key 是 `dev:ino:mtimeNs:ctimeNs`。key 命中则跳过 readdir；名字相同则沿用旧 size，不重新 lstat 文件。`folders` 存在时不用 reuse。分类每次重做 | deep | 唯一列目录者。reuse 入参改成清单记录，不是假的 `Inventory`（T7） |
| scan-worker | `desktop/scan-worker.ts` | 实用进程协议：start、progress、routing、inventory、cameras、done、error | shallow | 保留为进程边界 |
| scan-process | `desktop/scan-process.ts` | `scanSourceInWorker` 只把 promise 放进 `inFlight` | pass-through | 并进 `startScan`（T7） |
| scan-stop | `desktop/scan-stop.ts` | stop，2s 后 kill，250ms 后 SIGKILL | deep（策略小） | 保留 |
| scan-memory | `desktop/platform/scan-memory.ts` | 版本 4，64MB。存 `[relative, names]` 与 `[relative, size]`。读回时把 folder key 填成 `''`，于是下次一定 readdir | deep 缓存，形状在撒谎 | 直接存取 reuse 记录（T7） |
| listing-memory | `desktop/platform/listing-memory.ts` | 按根、子目录、backup 记 files/bytes，最多 200 条。坏文件当没有提示 | shallow | 保留为提示。不得压过更新的扫描（T7） |
| listing-estimate | `desktop/listing-estimate.ts` | 文件数优先于字节，再优先于顶层进度。share 到 0.9 后趋近 0.99，不到 1 | 一条曲线 | 扫描、ETA、进度条都只显示它写出的 share（T7、T10） |
| mediaKindForPath | `desktop/media-formats.ts` | 扩展名 → `RAW \| JPEG \| HEIF \| Videos \| Images \| Other`。未知即 Other，不解析 | 一张表 | 扫描、缩略图、视频判断共用。`layoutFolders` 留在同文件，不为此再拆 module |
| threadpool | `desktop/threadpool.ts` | `UV_THREADPOOL_SIZE` = clamp(2×CPU 线程, 4, 16)，缺省 16 | 中等 | 保留。`LISTING_STATS` 维持 8，不跟池大小绑 |

### 目的地与落位

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| folder | `desktop/core/index.ts` 私有 | EXIF 日历日优先。无拍摄日用本机日历的 mtime。未知 token 抛 `error.invalidTemplate`。已编辑文件不走用户模板，走 `{year}/{yyyymm}/${editedFolder}/{camera}` | deep | 提升为唯一替换器。预览和两份 scope 都调用它（T4） |
| folder-template | `desktop/folder-template.ts` | `FolderPath` 与 token 字符串互转。不套日期、不校验 | shallow 编解码 | 留下编解码。token 表只在 folder 规则里 |
| samplePath | `desktop/renderer/RootApp.tsx` | 用写死的日期和相机名 `replaceAll` | 第二套替换 | 改为调用唯一替换器（T4） |
| paths | `desktop/core/paths.ts` | `beneath` 不含根本身；`within` 含根。`validateRelative` / `safeComponent`。`makeParent` 拒绝换卷。另含 digest、stat、abort，不是落位 | 路径半边 deep | 保留。第三份包含判断改用 `beneath`（T4） |
| destination-roots | `desktop/platform/destination-roots.ts` | `backupFolders`：video-root 时两个根，否则一个。`destinationRoots` 校验、realpath、拒绝源在备份内、两个目的地必须是不同物理盘 | deep | 保留。所有 join 走一个 `libraryRoots`（T4）。`unsafeFolder` 并入 `validateRelative` |
| allocation | `desktop/core/allocation.ts` | 传输空间 = 待复制字节 + 最大 family。整理空间 = 最大文件 × 2。`allocateDestinations` 就地删掉不在该盘的 entries，不重算路径 | 空间 deep；树遍历 shallow | 先分盘再算路径（T5）。四个树遍历移到计划旁，删掉 barrel 再导出 |
| destination-index | `desktop/core/destination-index.ts` | `digestOf`。`ctime === mtime` 则记录不可信。`hinted` 与 `section` 是同一索引上的两个记忆范围，不是第二套索引 | deep | 唯一 SHA 缓存（T3） |
| routing-memory | `desktop/platform/routing-memory.ts` | 按 `dev:ino` 与规则 scope 记“要不要再找别处”。完成且无错误才写 | shallow | 与 placement 共用一个 `rulesScope`。两个文件不合并 |
| placement-memory | `desktop/platform/placement-memory.ts` | gzip，按 volume 与 scope。不匹配、损坏、超过 24MB 则全量检查。超过 40 万条则删文件 | 格式 deep，规则知识浅 | scope 与 folder 规则同源（T4） |

### 重复与身份

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| duplicate-rules | `desktop/duplicate-rules.ts` | 纯函数。可比 = 同扩展类且同 edited。`exifKey` 要日期、机身、连拍区分。`automatic`：level 3 为 sha 或 exif，level 2 为 sha，level 1 从不 | deep | 保留这一个分组器。无人值守只认 sha（T3） |
| duplicates | `desktop/core/duplicates.ts` | 库扫描：清单 → stat/EXIF 缓存 → 两阶段哈希 → `buildGroups`。`DuplicateStore.unchanged` 只认 size、mtimeNs、ino，含 FAT | deep | 文件记录留 EXIF。SHA 不再存在这里（T3）。`restore` 与 `mode: 'recorded'` 无调用者，删除 |
| duplicate-removal | `desktop/core/duplicate-removal.ts` | 不 unlink，只按 journal 移走。非 sha 组只看 inode 与 mtime 是否变过 | deep | 无人值守删除要求两边 SHA 相等（T3） |
| known-files | `desktop/core/known-files.ts` | 厂商记账文件与 12 字节起的 Finder alias → `Other` | shallow | 保留。这不是重复判断 |
| hasher | `desktop/core/hasher.ts` | `update` / `digest` / `drop`。worker 死掉后同一 SHA-256 改在主线程算 | 传输 | 保留主线程降级：同一算法，不是第二套身份。组织复制改走 `digest`（T8） |

跳过已存在文件是另一决定，实现只在 `existingMatches`：size 不同不读盘；否则目的地 SHA 等于源 SHA 才跳过。EXIF 与文件名永不跳过复制。不要把跳过和去重合成一个“身份服务”。

### 复制、校验、恢复

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| import-recovery | `desktop/core/import-recovery.ts` | 文件旁收据。`findPartial` 重读、验签、对根与父身份、源 stat、`nlink === 1`、字节前缀。缓存的名字不授权写入 | deep | 保留为导入的唯一恢复。验签函数从 `recovery.ts` 搬来（T8） |
| recovery | `desktop/core/recovery.ts` | 密封 manifest 之后才移动。`rename` 或 `copy`。撤销在任何 finalize 意图之后拒绝。缺省 strategy 是 `copy` | deep | 保留为整理与去重的 journal。不要并进 import 收据。新运行缺省改为 `rename`，旧清单仍读 copy（T2、T8） |
| residue | `desktop/core/residue.ts` | 只认本应用的名字。完整但卡已变的 stage 永不删。`recoverable` 与 journal 本体不删 | deep | 保留为两个格式的垃圾回收，不是第三套复制。`resumable` 计数不要包含 `kept`（T11） |
| originals | `desktop/core/originals.ts` | 测量只看 size 与存在。删除时重哈希源和每个目的地，inode/size/mtime 未变才 unlink | deep | 保留这次更晚的破坏性动作。不要用未签名的索引授权删除 |
| appledouble | `desktop/core/appledouble.ts` | 只删 `inspectAppleDouble` 认定为记账、且读与 unlink 之间未变、不超过 64KiB 的 `._` | deep | 唯一的 `._` 政策（T11） |
| drive-backup | `desktop/core/drive-backup.ts` | 每盘一个镜像夹。多出的文件改名进 `Removed by mirror`，不删除 | deep | 保留。不要并进 journal |
| redundant-folders | `desktop/core/redundant-folders.ts` | 不删库根、不删符号链接、不删仍有非服务文件的目录。按名字删所有 `._*` | 浅 | 与 journal 的 rmdir 收成一次清扫，`._` 交给 appledouble（T11） |

### 元数据

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| metadata | `desktop/platform/metadata.ts` | 一个解释器 `metadataFromTags`。两条读取：路由短标签（可缓存）与 `RequestAll`（不缓存）。缺省还做内嵌预览 | deep | 拆成 `route(file)` 与 `inspect(file)`，共用解释器。检查器不再生成没人读的预览（T9） |
| file-timestamps | `desktop/platform/file-timestamps.ts` | `captureTimestamp` 解析 `Metadata.date`。无时区则按主机本地日历校验。写入失败时改写源的 birth/mtime | deep | 唯一的瞬间转换。捕获日失败只在文件系统拒绝取值范围时回退（T9） |
| dji-models | `desktop/platform/dji-models.ts` | `djiProduct(value, dji)` | deep 数据 | 保留，唯一拼写归一 |
| thumbnails | `desktop/platform/thumbnails.ts` | 系统解码，失败再用内嵌 JPEG。缓存键是路径、尺寸、mtime、像素，不是路由 stat | deep | 保留。生产只有 `systemDecoders` 一个 adapter，不要再加端口 |
| metadata-display | `desktop/renderer/metadata-display.ts` | 把墙钟按 UTC 分量格式化，避免主机时区挪动日期 | shallow | 唯一的摘要格式化（T9） |
| exif-categories | `desktop/renderer/exif-categories.ts` | 每个标签名一个值。导入检查器不调用它，自己倒出 `fields` | deep 目录 | 留下非摘要标签。快门、光圈、ISO、日期改走摘要格式化 |

### 进度、设置、错误、日志

| Module | 文件 | Interface | Depth | 处置 |
|---|---|---|---|---|
| EtaTracker | `desktop/eta.ts` | `plan` 然后 `observe`。模型覆盖的步骤走 `JobModel`，其余走 EWMA `EtaEstimator`。结果再平滑、再分桶，写入 `job.eta` | 编排 deep，第二条估计器浅 | 一个 `observe` 结果。分桶只在渲染（T10） |
| JobModel | `desktop/eta-model.ts` | `a * files + b * GB`。fraction 不超过 0.99。`PriorBook` 有 `defaultBook` 与 `layeredBook` 两个生产 adapter | deep | 保留。这是真 seam |
| eta-priors | `desktop/eta-priors.ts` | 短于 30s、小于 20 文件且 1GB、共享时间超过 20% 的运行不入库。坏文件变空表 | deep | 保留 |
| eta-format | `desktop/eta-format.ts` | `DisplayHold`：最多 5s 一次；下降要过桶沿；上升要 20s 且 1.15 倍。`remainingRange` 只在 ≥ 10 分钟且高低比 ≥ 1.6 | shallow 政策 | 只在渲染调用一次 |
| resource-limits | `desktop/resource-limits.ts` | 线程 1..核数，内存 512MB..75% RAM。governor 超过预算 90% 才等。`savedLimits` 无生产调用者 | deep | 保留。线程池与偏好共用一次读取（T10） |
| keep-awake | `desktop/keep-awake.ts` | 有 `queued \| discovering \| verifying \| copying` 时阻止显示器睡眠 | shallow | 保留。唯一一份睡眠政策 |
| preferences | `desktop/preferences.ts` | 缺字段用 base。只有显式 false 才关掉校验与目录开关 | 中等 | 保留为唯一规范化 |
| settings-lock | `desktop/settings-lock.ts` | 发现、校验、复制、排队、暂停的停止、审核、扫描来源时锁定。`main` 另外 OR 了 `busy()` | shallow | 锁的条件收进这一个函数（T10） |
| error-log | `desktop/error-log.ts` | `gatherErrors` 把任务错误、组、清单、相机、目的地、恢复收成 `LoggedError`。id 是消息的 FNV | 中等 | 渲染端走一次。`buildRows` 并进来（T10） |
| error-groups | `desktop/error-groups.ts` | 再按 `groupedCodes` 合并 | shallow | 并入 error-log |
| job-issues | `desktop/job-issues.ts` | `recordIssue` O(1) 进组，全路径在 WeakMap，重启丢失。`throttled` 是全局 emit 节流，与错误无关 | 索引是真的 | 索引留下。`throttled` 挪走。`createIssueSink` 删除 |
| job-log | `desktop/job-log.ts` | 相位、拓扑、活动的 diff，然后 `log()` | shallow 观察者 | 保留。相位图与 `stampJobs` 共用一份（T10） |
| logger | `desktop/logger.ts` | JSON 行，500ms 刷，32MB 待写则丢，50MB 旋转。不向调用者抛 | deep | 保留。不要并进 job-log |
| log-export | `desktop/log-export.ts` | 先 zip，任何失败再复制文件夹 | 两套导出 | 只留一种（T11） |
| boot-controller | `desktop/renderer/boot-controller.ts` | intro / hold / fly / fade，与任务进度无关 | shallow | 不动 |

## 3. 层间往返

这些是同一份数据穿过层次后又算一遍。按是否碰磁盘排序。

| 事实 | 第一处 | 又算了一次 | 代价 |
|---|---|---|---|
| 挂载与种类 | `macVolume` 已读 plist | `devices.classify` 再跑 `diskutil`；最长前缀在 eta、backup、folderDrive、volumeInfo、activity、渲染各走一遍 | 每次刷新的进程与路径扫描 |
| 目录身份 | `folder()` | `samplePath`；`routingScope` 与 `placementScope` 各哈希一份，且都漏 `unknownRules` | 预览说谎；改未知规则后仍信任“已在位” |
| 清单 | worker 里的完整 `Inventory`，含 UI 不读的 `listing` | 存盘时丢掉 key，读回假 Inventory，下次必定 readdir；`plan` 在 size 过期时整份重跑；`examine` 再 lstat 每个文件 | 卡上的重复读 |
| 列出进度 | `listingEstimate` | 扫描故意传 `undefined`；ETA 在有已用空间时丢掉 `topShare`；进度条自己 `listingShare` | 条和剩余时间分母不同 |
| 拍摄时间 | `recordedDate` 一条字符串 | `folder`、`captureTimestamp`、`contradicts`、`unknownContext`、摘要、全 EXIF 各解析 | CPU，以及不一致的风险 |
| 源字节，组织 copy | 计划时的 digest | 流、再读源、再读 stage、硬链接后再读同一 inode、stash 再读源和目的地 | 每个文件多遍全读 |
| 源字节，导入独占复制 | 流哈希 + stage 回读（这是校验） | 再把目的地读一遍 | exFAT 上多一遍 |
| SHA | `DestinationIndex` 的严格谓词 | `DuplicateStore` 的弱谓词；删除时不用索引，再 `digest()` | exFAT 上用过期 EXIF/SHA |
| 错误列表 | `recordIssue` 已分组 | `emit` 里 `gatherErrors` 只为了时间戳；渲染再 `gatherErrors` 再 `buildRows` | 每次 publish 两次行走 |
| 剩余时间 | `JobModel` 秒数 | 平滑、分桶、写入 `job.eta`，渲染再分桶 | 侧栏 `Math.max` 加的是展示值 |
| 状态 IPC | 清单按引用 intern，这条是对的 | 1Hz 活动与 5s 心跳仍序列化偏好、历史、已结束任务 | 未测量。没有测量就不加第二协议 |
| 检查预览 | `metadata()` 缺省做 data-URL | 渲染不读 `metadata.preview` | 最多约 20MB 的无用 IPC |

不要做的“优化”：把 `StateUpdate` 拆成字段补丁协议；把 PTP 与卷 UUID 合并（ImageCaptureCore 的 id 不等于卷 UUID）；用未签名的 destination index 授权 `deleteOriginals`。

## 4. 任务

顺序是依赖顺序。T1、T2 可先做。T4 与 T5 都改 `plan`，放在一起。T10 用 T7 写出的 share。T8 在 T3 的 SHA 归属之后。

### T1：空闲释放与恢复列表的一个中止

**Files:**
- Modify: `desktop/main.ts`（`recoveryRefresh` 创建、`idle`、`refreshOrganizations`、`yieldListing`）
- Modify: `desktop/deferred-refresh.ts`（若生产不再需要 `pause`）
- Test: `desktop/tests/deferred-refresh.test.ts` 若存在则改；否则在现有 main 行为测试里加空闲释放。本轮未打开测试目录逐个核对文件名，实施时先搜索 `deferredRefresh` 与 `releaseIfIdle`。

**推荐：把推迟旗标留在 `yieldListing` / `refresh` 旁边，只中止 `listingControl`。`idle()` 看 `!organizationListing && !recoveryRefresh.running`。**

- 利：`releaseIfIdle` 能跑；一个 AbortController；删掉生产不用的 `pause`。
- 弊：现有 helper 单测若断言 `pause` 会失败，应改成断言生产实际使用的推迟行为。

备选：继续用 `deferredRefresh`，把 `listingControl` 的 abort 接到 `pause()`，`idle()` 改为 `.running`。

- 利：helper 的单测还能描述生产。
- 弊：两个控制器还在，除非 `refreshOrganizations` 真的使用传入的 signal。只有 `pause()` 成为唯一中止时才值得。

不要把恢复列表、错放检查、残留检查收成一个通用调度器。三者的寿命不同（列表可续、错放重开、残留要等队列空）。只删 `deferredRefresh` 里没人用的那一半。

- [ ] 写失败测试：没有任何活跃工作时 `releaseIfIdle` 调用关闭；`recoveryRefresh.running` 为真时不关闭。
- [ ] 改 `idle()` 与生产调用，使信号只有一个主人。
- [ ] `npm test` 中与 deferred、idle、recovery listing 相关的文件通过。

### T2：一次运行的策略只有一处

**Files:**
- Modify: `desktop/main.ts:620-637`
- Modify: `desktop/core/recovery.ts:965` 的缺省参数
- Modify: `desktop/run-policy.ts` 仅当字段仍无人读时才删
- Test: `desktop/tests/source-handling.test.ts`

**推荐：`run` 传入 `policy.strategy`。`beginOrganization` 缺省改为 `'rename'`。清单里没有 `strategy` 字段的旧 journal 仍按 copy 读。**

- 利：新运行与产品一致，即使调用方忘了传字段。`sourcePolicy` 成为真的决定。
- 弊：依赖“省略 strategy 即 copy”的新测试会变。旧 journal 读取必须单独有测试。

备选：从 `SourcePolicy` 删掉 `strategy`，`run` 继续写死 `'rename'`。

- 利：diff 最小。
- 弊：core 缺省仍是 `'copy'`，`executeDestinations` 之下的脚枪还在。

不要删掉 copy 实现。旧 journal 要靠它恢复。

- [ ] 测试：新整理传入的 strategy 是 rename；无字段的旧 manifest 恢复为 copy。
- [ ] 改两处缺省，使它们一致。
- [ ] 跑 `source-handling` 与 organization recovery 测试。

### T3：一个 SHA 归属；无人值守删除认字节

**Files:**
- Modify: `desktop/core/duplicates.ts`（`unchanged`、不再存 sha256、删除 `restore` 与 `mode: 'recorded'`）
- Modify: `desktop/core/destination-index.ts`（谓词保持，成为扫描与删除的读取处）
- Modify: `desktop/core/paths.ts`（把可证明 stat 收成一个函数，供索引和 EXIF 记录共用）
- Modify: `desktop/duplicate-rules.ts`（`automatic` 的 level 3）
- Modify: `desktop/core/duplicate-removal.ts`（哈希不等则留下）
- Modify: `desktop/core/index.ts`（计划阶段的成员过滤与 `APP_FOLDERS`）
- Modify: `desktop/renderer/DuplicatesPage.tsx` 文案，若 level 3 不再自动删 EXIF 组
- Test: `desktop/tests/duplicates-*.test.ts`、`desktop/tests/index-safety.test.ts`

这是两个决定，不要合成一个身份服务。

- 跳过已存在：size 加 SHA-256。保持。
- 重复组：SHA，或可信 EXIF，或同名同时刻。保持分组。改变的是哪一组可以没人点就删除。

**推荐：**

1. `DuplicateStore` 不再存 SHA。可信哈希只从 `DestinationIndex` 读，谓词维持 `provable`（拒绝 `ctime === mtime`）加 dev、ino、size、mtime、ctime。EXIF 记录用同一谓词决定缓存是否仍有效。
2. `automatic` 的无人值守只对 `sha`。删除循环里两边哈希都有且不等，则 `left`。EXIF 组仍显示，用户点了才移走。
3. 计划与扫描用同一个成员过滤：非 Other、size > 0、不是 `companionOf`。
4. 删除无调用者的 `restore` 与 `mode: 'recorded'`。
5. `confirmCandidates` 里非中止的哈希失败把该文件排除出这一轮分组，而不是退化为 EXIF 连接。
6. `'Photo Importer Data'` 放进与“别处查找”相同的一个排除列表。

利：exFAT 不能再用过期 inode 证明 SHA 或 EXIF。无人值守与跳过已存在使用同一字节规则。少一个没人读的分组快照。

弊：level 3 不再自动删除同 EXIF 同大小的重编码。这是行为变化。exFAT 每次扫描重读 EXIF。Live Photo 视频不再作为自己的主键被 stage 1 哈希，只作为静图的伴随。

备选：保留 level 3 的 EXIF 自动删除，并删掉非 sha 组的重哈希。

- 利：符合当前文案，少一次读。
- 弊：弱谓词上的过期 EXIF 仍能授权删除。在 T3.1 完成之前不要选这个。T3.1 完成之后它仍然比“认字节”松。不推荐。

备选：在两个存储前面加一个 identity service。

- 利：没有。调用者多学一个 interface。
- 弊：典型的浅 module。不要做。

不要把计划时的源哈希当作复制哈希。`stageMany` 哈希的是写下的字节。

- [ ] 测试：exFAT 形态的 stat（ctime 等于 mtime）不能命中旧 SHA；level 3 对字节不同的 EXIF 组结果是 left；用户显式决定仍可移走；哈希失败的文件不进组。
- [ ] 按推荐改存储与 `automatic`。
- [ ] 跑 duplicates、removal、index-safety 测试。

### T4：一条目录规则，一个 scope，一次备份根 join

**Files:**
- Modify: `desktop/core/index.ts` 的 `folder`
- Modify: `desktop/folder-template.ts`
- Modify: `desktop/renderer/RootApp.tsx` 的 `samplePath` 与已编辑预览
- Modify: `desktop/platform/routing-memory.ts`、`desktop/platform/placement-memory.ts`
- Modify: `desktop/main.ts` 的 `routingOf`、`placementOf`、`backupLibrary`、`listOrganizations`
- Modify: `desktop/platform/destination-roots.ts`
- Modify: `desktop/core/paths.ts` 只在需要把用户输入的段校验导出时
- Test: `desktop/tests/import-skip-gate.test.ts`、`desktop/tests/placement-memory.test.ts`、`desktop/tests/folder-template.test.ts`、目录组织相关测试

**推荐：**

1. 把 token 表、`folder()`、已编辑模式、`rulesScope(prefs)` 放在一个 module。`rulesScope` 覆盖模板、布局、视频模板、已编辑夹、未知规则。预览用固定元数据调用 `folder()`，不再 `replaceAll`。
2. `routingScope` 与 `placementScope` 改为存这个 scope。升一个版本常量。旧 placement 文件 miss 一次，做全量检查。这是安全的 miss。
3. `libraryRoots(destination, prefs)` 放在 `backupFolders` 旁边，realpath 或 resolve 一次。`backupLibrary`、残留、去重范围、placement id 调用它。组织列表仍单独扫描 `basePath` 与 `videoBasePath` 两个偏好名，以便找到旧 journal；不要再把 `backupFolders` 和这两个名字拼进同一个 Set。
4. `rememberEntries` 的手写 `path.relative` 改成 `beneath`。
5. 用户输入的相对段（`basePath`、`videoBasePath`、`editedFolder`）用 `validateRelative` / `safeComponent`。能保存的名字必须能计划。

利：预览、落位、两份缓存不会各说各的。改未知规则会使“已在位”失效。

弊：`folder()` 从 `index.ts` 挪走，是计划热路径的搬家。缓存 miss 一次，下一次错放检查更慢。以前能保存、计划时才失败的 `CON` 之类会在保存时失败。

备选：只共享 token 表，`folder()` 仍私有。

- 利：diff 小，预览能对齐。
- 弊：scope 与已编辑模式仍是两份。不修“已在位”的过期信任。不够。

备选：把 routing-memory 与 placement-memory 合成一个文件。

- 利：一个写队列。
- 弊：一个是每个 `dev:ino` 一条 scope，一个是几十万条 stat。合并存储是新的一层。不要做。

`sourceInsideBackup` 留作计划前的守卫。`planOnce` 在 canonical 路径上再查一次，是时机不同，不是第二套政策。执行时的 `validateDestination` 留着，它回答“还是不是那块盘”。

- [ ] 测试：同一模板下预览段与 `folder()` 段一致；未知规则变化使 `routingChanged` 为真；`CON` 在保存时失败；placement scope 不再因为没用到的 video 文件夹名而变。
- [ ] 实现推荐的 1–5。
- [ ] 跑 folder、placement、routing、destination 测试。

### T5：先分盘，再算一次路径

**Files:**
- Modify: `desktop/core/allocation.ts`
- Modify: `desktop/core/index.ts` 的 `allocate` 与 `plan` 的调用顺序
- Modify: `desktop/main.ts` 的 `recordDuplicates`，改用 `destinationParts`，删掉 `core/index.ts` 对 `allocateDestinations` 的再导出
- Test: `desktop/tests/allocation.test.ts`

**推荐：顺序模式下先按 family 字节把文件分到盘（现有循环，不改路径），再只对留下的 destination 调用 `folder()` 与冲突命名。镜像模式仍为两份完整树做计划。**

- 利：路径算一次。冲突名只反映真正共享该盘的文件。
- 弊：`plan` 与 `prepare` 的顺序要变。需要一条测试：两个同名文件只有一个放得下盘 1，留下的那个不在 `Conflicts/`。

备选：过滤之后再 `allocate()` 一次。

- 利：能修过期的 `Conflicts/`。
- 弊：第二遍路径，正是要去掉的味道。

不要把 `executeDestinations` 并进 `allocation.ts`。执行的失败隔离与空间计算不是同一项工作。

四个浅遍历（`destinationParts`、`destinationEntries`、`placedEntries`、`olderRulesPaths`）挪到 `TransferPlan` 旁边。空间函数与 `allocateDestinations` 留在 allocation。

- [ ] 先写会失败的同名竞争测试。
- [ ] 改顺序。
- [ ] 跑 allocation 与 planning 测试。

### T6：一份卷快照，一个稳定 id

**Files:**
- Modify: `desktop/platform/volumes.ts`
- Modify: `desktop/core/devices.ts`（`kind` 不再为已描述的挂载跑 diskutil）
- Modify: `desktop/main.ts` 的 `refresh`、`etaDrive`
- Modify: `desktop/device-selection.ts`
- Modify: `desktop/drive-groups.ts`、`desktop/renderer/RootApp.tsx` 的 `sourceCapacity` 与新盘文案
- Modify: `desktop/platform/camera-bridge.ts`、`Sources/CameraBridge/main.swift` 只删多余 id 字段
- Test: `desktop/tests/volume-identity.test.ts`、`desktop/tests/device-selection.test.ts`、`desktop/tests/folder-sources.test.ts`、`desktop/tests/platform.test.ts`

**推荐：**

1. 每次 `refresh` 建一份挂载快照，plist 里已有的 SolidState、总线、可移动位直接成为 `kind`。`etaDrive`、`folderDrive`、`volumeInfo`、`backupDriveIdentity`、`activityTargets` 调用同一个 `volumeOf(path)`。
2. `stableId` 只返回卷 UUID 或 `camera:${uuid}`，否则没有。偏好、忽略、历史用它。会话选择仍用 `source.id`。当 `refresh` 把 `folder:path` 换成检测到的卷时，把 `selected` 和会话项一起搬过去，再 `apply`。
3. `camera` 只表示 DCIM 类布局。PTP 不设这个位。桥接 JSON 不再带一份已经由 `cameraID` 表达的 `id`。`main` 不再给已经是 `camera:` 的 id 再加前缀。
4. 渲染不再自己做最长前缀。容量用来源上的 `total` / `free`。组长按 volume id 在 `refresh` 算一次，不随置顶变化。删掉作为后备的存储旗标 `sameAsDestination`。
5. `deviceHasRoom` 与“能不能再开一个任务”用快照上的 `physicalId`。没有 physicalId 时不要发明 `filesystem:` 来宣称两卷是同一块盘。`DeviceStreams` 的 `stat.dev` 只锁一个文件系统上的字节。

利：少一轮 diskutil，少五次路径扫描。文件夹被系统重新识别成卷时，用户的勾选还在。新盘文案不会把 PTP 说成 DCIM。

弊：热刷新路径会改。旧设置里的路径或 `diskN` 键要在读取时忽略一次，不能永久留第二条匹配。置顶不再决定谁显示容量，这是可见变化。Linux 的 mountinfo 后备若保留，这些行必须标成不稳定，选择逻辑不能记住它们。

备选：为卷和相机各加一个 port，测试一个、生产一个。

- 利：没有第二生产实现。
- 弊：一个 adapter 的假 seam。不要做。

不要把 PTP 并进卷列表。Swift 侧看不到卷 UUID。

`getSources` 在 helper 失败时仍返回已挂载的卡。这是故障隔离，不是第二套发现算法，留下。

- [ ] 测试：同一挂载只触发一次磁盘描述；文件夹 id 被卷 id 替换后仍为选中；PTP 的 `camera` 不为真；无 UUID 的 id 写不进 `rememberedDevices`。
- [ ] 实现 1–5。
- [ ] 跑 volume、selection、folder-sources 测试。

### T7：清单的 reuse 记录，和一个列出进度

**Files:**
- Modify: `desktop/core/inventory.ts`
- Modify: `desktop/platform/scan-memory.ts`
- Modify: `desktop/scan-process.ts`、`desktop/scan-worker.ts`
- Modify: `desktop/main.ts` 的 `listingOptions`、`scanSource`、`reusableScan`
- Modify: `desktop/listing-estimate.ts` 的调用方：`desktop/eta.ts`、`desktop/renderer/RootApp.tsx` 的 `ScanProgress`
- Modify: `desktop/core/index.ts` 的 `plan` 重跑
- Test: `desktop/tests/scan-progress.test.ts`、`desktop/tests/scan-memory.test.ts`

**推荐：**

1. reuse 记录是 `{backup, folders: {relative, key, names}[], files: {relative, size}[]}`，不是把 `included: false` 和空 key 填进 `Inventory`。状态通道发给渲染的对象不含 `listing`。磁盘格式已经接近这个形状，版本可以保持 4，但读回时禁止再合成假 Inventory。
2. `error.sourceChanged` 时只重读那个父目录（丢掉该目录的 reuse 项并 readdir），留在同一次 `planOnce`。身份命中和名字命中的短路保留。现有“过期 size 不能让导入用错 size”的测试改成断言这一次计划的发布 size，而不是断言整份 `plan` 跑了两遍。
3. 扫描提示的顺序固定为：本次扫描的 `scopeHint`，否则 listing-memory，否则已用字节。把 `listingEstimate` 的 `share` 存在 `scanProgress` 上。ETA 和进度条只读这个字段。
4. 删掉 `inventory` 里 `!options.folders` 对 reuse 的一刀切。选中的文件夹从整卡清单的相对路径复用。部分结果不写回 `listing`，以免覆盖整卡记忆。测试钉住这一点。
5. `scanSourceInWorker` 并进 `startScan`。不为协议再加一个类型 module。

利：渲染不再收到名字表。冷启动不会因为空 key 而必然 readdir 之后又盲信 size。一个过期文件不会推倒整次计划。进度条和剩余时间共用一个分母。

弊：`planOnce` 要能在中途补一个目录。`scanDuplicates` 若仍用原始 `top.done/total`，会成为第四种进度，应改为同一个 helper，否则不算做完。

备选：只在发布时剥掉 `listing`。

- 利：渲染载荷变小，改动小。
- 弊：worker 消息和读回的对象仍是假 Inventory。

备选：reuse 时对每个文件 lstat，从而删掉重跑。

- 利：size 不会过期。
- 弊：取消增量测试锁住的复用。不要做。

`LISTING_STATS = 8` 保持。没有测量说明再加大会更快。子进程只因复制了 `process.env` 才继承线程池，实施时不要在不复制该变量的情况下改 spawn。

Live Photo 的 `.mov` 配对留在元数据之后。不要塞进列目录。

- [ ] 测试：名字相同、size 不同时只重读该父目录；文件夹范围的导入复用整卡记录且不返回 `listing`；扫描的 share 被 ETA 与进度条原样使用。
- [ ] 实现 1–5。
- [ ] 跑 scan-progress、scan-memory、planning 测试。

### T8：少读几遍字节；两套恢复格式先只切开密封

**Files:**
- Modify: `desktop/core/recovery.ts` 的 `copyThroughStage`、`targetMatches`、stash 的 `verifyContents`
- Modify: `desktop/core/index.ts` 的独占 publish（约 `digest(destination)`）
- Modify: `desktop/core/import-recovery.ts`（迁入 `sealImportRecord` / `authenticateImportRecord`）
- Modify: `desktop/core/import-recovery.ts` 的 `findPartial`，复用已认证正文，stat 变了再认证
- Test: 组织复制、导入校验、import-recovery、residue 的现有测试

**推荐（现在做）：**

1. 组织 copy：流哈希与源 stat 未变之后，不再 `digest(源)`。硬链接的 inode 与已校验 stage 相同，则不再对目的地做内容哈希，与导入的 `publish` 一致。同一次 `run` 里已经记下 `passed` 的 stash 传 `verifyContents: false`。
2. 导入的独占复制：stage 刚校验过且复制结束时的 stat 符合，则不再 `digest(目的地)`。stage 回读保留，那是校验。
3. 密封函数搬到 `import-recovery.ts`。组织 journal 留在 `recovery.ts`。
4. `findPartial` 使用索引里已有的 `RecordData`，只在 size 或 mtime 变化时重新认证。
5. `copyThroughStage` 里的手写 `createHash` 在多余回读删除之后改为调用 `digest`。hasher 的主线程降级留下。

利：组织 copy 少大约四次全文件读。exFAT 的导入少一次目的地回读。模块边界和两份磁盘格式一致。

弊：硬链接的数据若损坏而 stat 不变，只能靠 stage 那一次回读发现，不会有第三次读同一 inode。独占复制在 `sync` 与检查之间崩溃，要等下次导入的 `findPartial`。这与收据的设计一致。

备选：让组织 copy 直接走 `stageMany` / `publish` / import 收据，journal 只保留改名、stash、撤销、finalize。

- 利：一条字节路径，residue 不用再解析 journal stage。
- 弊：publish 与 `stashed` 之间的崩溃窗口要重新映射。改动面最大。除非正在重写 journal，否则不要做。

备选：抽一个内部 `stageAndPublish`，收据仍分两处存放。

- 利：删掉两份 hash/link/exclusive 代码。
- 弊：两份磁盘格式还在，residue 仍是第二个解析器。下次碰组织复制时再做，不在本任务。

不要用 `DestinationIndex` 授权 `deleteOriginals`。索引没有 HMAC。删除保持全读。`verified-originals.json` 是报告，不是恢复输入，不要在启动时读回 `importedOriginals`。

- [ ] 测试：硬链接发布不再对同一 inode 做第二次内容哈希；独占复制在 stage 已校验时不再读目的地；无 strategy 的旧 journal 仍恢复；收据被替换（mtime 变）时重新认证。
- [ ] 实现 1–5。
- [ ] 跑 recovery、import、residue 测试。

### T9：一个解释器，两次读取，一种摘要格式

**Files:**
- Modify: `desktop/platform/metadata.ts`
- Modify: `desktop/main.ts` 的 `importer:inspect` 与 `importer:exif`
- Modify: `desktop/platform/file-timestamps.ts`
- Modify: `desktop/core/index.ts` 里对日期字符串的再次解析
- Modify: `desktop/renderer/metadata-display.ts`、`desktop/renderer/exif-categories.ts`、`desktop/renderer/DuplicatesPage.tsx`
- Modify: `desktop/source-cameras.ts` 重复的未知名称过滤
- Test: `desktop/tests/metadata-extraction.test.ts`、`desktop/tests/metadata-display.test.ts`、`desktop/tests/dji-metadata.test.ts`、`desktop/tests/file-timestamps.test.ts`

**推荐：**

1. `route(file)` 走短标签和缓存。`inspect(file)` 走 `RequestAll`，给全字段面板。两者调用 `metadataFromTags`。摘要卡使用已缓存的路由 `Metadata`，不再为摘要做第二次全读。
2. 下游只保留 `captureTimestamp` 作为瞬间转换。`folder`、`contradicts`、显示共用这一次解析的结果，删掉各自的正则。`recordedDate` 里的厂商顺序留下，那是时钟写在不同标签里，不是重复实现。
3. 删掉 `preview()` 以及 inspect 缺省的 `preview: true`。缩略图继续用 `embeddedPreview`。视频是否跳过预览用 `mediaKindForPath`，删掉私有扩展名数组。
4. `duplicateFingerprint` 使用 `exposureSummary` 的数字。全 EXIF 不再自己格式化快门、光圈、ISO、补偿、焦距和拍摄时间。
5. `shutterCount` 改为数字，`shutterNote` 改为代码，由渲染格式化。
6. `applyFileTimestamps` 只在文件系统拒绝取值范围时回退到源时间。helper 缺失或文件不是独占链接时，错误向上传。
7. 删掉 `source-cameras.ts` 里对 `recordedCamera` 已经拒绝过的字符串的第二遍过滤。

利：扫描仍用短标签。摘要不再二次解析。没人看的预览 data-URL 不再过 IPC。语言不在提取时烤成英文句子。

弊：全字段面板仍是第二次读取，这是 `RequestAll` 的成本，应当留下。捕获时间若 helper 不在，复制会失败而不是静默改用源时间，这是行为变化。`qa/a006-hardware.ts` 若断言 `result.preview`，要改成走缩略图或删掉该断言。

备选：每个文件都做 `RequestAll` 并缓存给 UI。

- 利：一次解析。
- 弊：扫描成本和内存变成全标签。路由标签表就是为了避免这个。不要做。

备选：按厂商做相机策略 interface。

- 利：没有。
- 弊：一个函数拆成多套。不要做。

ExifTool 批失败后的单文件重读留下。那是同一标签表的传输重试，不是第二种解释。

- [ ] 测试：路由结果能驱动摘要而不调用 `RequestAll`；inspect 的返回值没有 `preview`；无偏移的日期在文件夹、时间戳和显示上是同一个日历日；helper 缺失时 `applyFileTimestamps` 失败。
- [ ] 实现 1–7。
- [ ] 跑 metadata、timestamp、display 测试。

### T10：进度、剩余时间、错误各算一次

**Files:**
- Modify: `desktop/eta.ts`、`desktop/eta-model.ts`、`desktop/eta-format.ts`
- Modify: `desktop/renderer/RootApp.tsx` 的 `formatRemaining`、`formatEstimate`、fraction 系列、`explainError`、`collectErrors`
- Modify: `desktop/error-log.ts`、`desktop/error-groups.ts`、`desktop/job-issues.ts`、`desktop/acknowledge.ts`
- Modify: `desktop/main.ts` 的 `emit`、`stampJobs`、`settings` 锁
- Modify: `desktop/resource-limits.ts`、`desktop/threadpool.ts`、`desktop/preferences.ts`、`desktop/settings-lock.ts`、`desktop/shared.ts`
- Modify: `desktop/job-log.ts`
- Test: `desktop/tests/eta-*.test.ts`、`desktop/tests/error-log.test.ts`、`desktop/tests/error-groups.test.ts`、`desktop/tests/settings-lock.test.ts`、`desktop/tests/resource-limits.test.ts`

**推荐：**

1. 删掉 `EtaEstimator`、`EtaSmoother`、`Legacy`。每个 `observe` 看到的步骤都有一个 `JobModel` 快照。列出步骤显式标 `estimated: true`，不假装它是复制。`job.eta` 存模型秒数，不存桶代表值。`DisplayHold` 与 `remainingBucket` 只在渲染、每个 job id 一份。删掉 `JobState.known`、未使用的 `Legacy.smoother`、`eta.ts` 里未使用的 `remainingRange` import。
2. 进度条只读 `job.fraction`，列出读 T7 的 `share`。没有测量时显示不确定条，不用硬编码的 10% 权重。目的地行合并多个任务的规则只写一处，放在 `overviewEta` 旁边。
3. 错误 id 在 `recordIssue` 或推入 `job.errors` 时算一次。渲染用 `gatherErrors` 加 `buildRows` 一次。`buildRows` 移入 `error-log.ts`，删除 `error-groups.ts`。`explainError` 的英文正则改成消息 key；`severityOf` 是唯一严重性。`isAcknowledged` 只留在 `error-log.ts`。
4. `throttled` 挪到 `emit` 旁。`createIssueSink` 删除。`appleDoubleIssues` 挪到报告类型旁边，不新建 adapter。
5. `PhaseLog` 使用 `stampJobs` 已经在更新的那张相位表。
6. `readSavedLimits` 一份，供线程池和 `normalizePreferences`。`state.resources` 带上 `memoryRange`，设置页不再写 `0.75`。`settingsLocked` 包含去重扫描，`main` 不再 OR `busy()`。`LogLevel` 与活跃相位常量放在 `shared.ts`，两处各一份的数组删掉。

利：侧栏把秒数相加时加到的是模型值。卡片、总览、侧栏用同一 fraction。错误标题不随英文措辞变化。坏的 `maxCpuThreads` 在加载前后是同一个数。

弊：列出的剩余时间不再用 EWMA，要给 `JobModel` 一个估计总量步骤，否则早期没有秒数。渲染要持有 hold 状态。`text(...)` 错误没有 key 的，保留一条不另赋严重性的通用标题。

备选：留下 `EtaEstimator` 只服务模型不覆盖的步骤，平滑只放渲染。

- 利：改动小。
- 弊：两套公式留下来。不推荐，除非列出步骤实在套不进 `a * files + b * GB` 且估计总量也不可用。那时只为列出留一个函数，不要恢复整套 Legacy。

备选：把 `eta-model`、`eta-format`、`eta-priors` 并进 `eta.ts`。

- 利：文件少。
- 弊：拟合、磁盘和展示政策合成一个 module，deletion test 会失败。不要做。

备选：主进程继续 `gatherErrors`，把 `LoggedError[]` 放进状态。

- 利：渲染少走一遍。
- 弊：第二份错误列表过 IPC，而全路径本来就有单独的 `errorPaths` 读取。不要做。

`keep-awake` 与 `logger` 不动。`RateMeter` 在删掉第二估计器时从 `eta.ts` 挪走，不单独立项。

- [ ] 测试：未分桶的秒数相加不等于分桶后再相加的旧行为（钉住模型值）；未知 fraction 不显示 10%；同一错误 id 在主进程与渲染一致；坏的线程设置被夹到与正常化相同的值；去重扫描时设置锁定。
- [ ] 实现 1–6。
- [ ] 跑 eta、error、settings、resource 测试。

### T11：清扫、残留计数、一种日志导出

**Files:**
- Modify: `desktop/core/redundant-folders.ts`、`desktop/core/recovery.ts`、`desktop/core/appledouble.ts`、`desktop/main.ts` 调用处
- Modify: `desktop/core/residue.ts`、渲染里读 `resumable` 的地方
- Modify: `desktop/log-export.ts`、`desktop/main.ts` 的导出动作
- Test: `desktop/tests/redundant-folders.test.ts`、`desktop/tests/residue.test.ts`、`desktop/tests/log-export.test.ts`

**推荐：**

1. journal 完成之后做一次目录清扫。服务文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`）由这次清扫删除。`._` 只通过 `inspectAppleDouble`。journal 内部的 `removeEmptySourceFolders` 在这次后处理会跑时不再先跑一遍。
2. `Residue` 分开计 `resumable` 与 `kept`。自动清理的谓词写明两者都留。
3. 日志导出只保留 zip，失败则 `state.error`。若产品要求失败也一定交出文件，则只保留文件夹复制，删掉 zip。不要两个都留。推荐 zip，因为调用方的成功形状已经是一个压缩包；文件夹是安全网。

利：带标记的 `._` 不会被按名字删掉。残留数字与注释一致。导出失败可见。

弊：只含 `.DS_Store` 的空目录要等后处理，不能在 journal 的 rmdir 里消失。选择“只 zip”时，磁盘满会得到错误而不是一夹散文件。

备选：保留 `removeOrganizedFolders`，但 `._` 先检查，且 journal 已清掉的父目录跳过。

- 利：标记能留下。
- 弊：仍是两遍。不推荐。

- [ ] 测试：含资源叉的 `._` 留下；纯记账 `._` 删除；`kept` 不计入 `resumable`；zip 失败不会变成文件夹。
- [ ] 实现 1–3。
- [ ] 跑 residue、folders、log-export 测试。

### T12：不做

- 不把 `action` 拆成多个 IPC 通道。
- 不引入 VolumePort、CameraPort、IdentityService、parser-per-kind、Job 类层次。
- 不把三个后台检查收成一个读取框架。
- 不把组织撤销并进 import 收据，除非单独重写 journal。
- 不把镜像隔离夹并进恢复。
- 不把 `StateUpdate` 改成补丁协议，除非先有 IPC 体积测量。
- 不把 `listing` 的 8 路 lstat 改成跟线程池联动，除非有卡读测量。
- 不把容量条上的 `JPG` / `JPEG` 拼成一种，除非产品要条与文件夹拼写一致。那是 T4 的 `formatFolder` 能做的一行，不是新 module。
- 不加载未签名的 `verified-originals.json` 来恢复“删除原件”。
- 不把 boot 动画并进任务进度。

## 5. 与另一份同日计划的关系

[2026-10-23-architecture-remediation.md](2026-10-23-architecture-remediation.md) 里的这些项，本轮八个审查没有重读，因此既不采纳也不否定：

- 删除原件中止时丢掉已 unlink 的部分结果。
- 完成阶段消费者仍持有晚分配之前的路径（本文 T5 只证实顺序填盘会留下过期的 `Conflicts/` 路径）。
- 去重详情请求的生命周期与过期页面。
- 错误数组原地修改导致不能按对象引用做增量。

实施时先做本文 T1–T5。若那份计划的上述项仍在代码里，单独开任务，不要为它们再包一层 interface。

## 6. 验收

每项任务的测试命令写在该任务下。全部任务结束后：

- `npm test`
- `npm run typecheck`

未在本轮运行。不把“审查读过源码”写成“测试已通过”。

集成时看这五条，而不是看文件是否变少：

- 无工作时哈希线程和 ExifTool 会退出，恢复列表进行中不会退出。
- 新整理是 rename，旧的无 strategy journal 是 copy。
- level 3 不删除字节不同的文件。
- 顺序填盘后的幸存者路径与仍留在该盘的文件一致。
- 改未知规则或目录模板后，placement 缓存 miss。

## 7. 执行边界

本文完成时没有改 `desktop/` 或 `Sources/`。用户复核推荐路径之前不实施。若某一项要改用备选，只改那一项的推荐，不要把备选和推荐一起留下。
