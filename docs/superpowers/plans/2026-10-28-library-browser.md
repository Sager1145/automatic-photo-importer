# 分类预览与 EXIF 分栏浏览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过侧边栏进入 Finder 式分栏照片浏览，支持普通与 EXIF 分类/范围筛选，扫描自动维护持久化索引并提醒未整理项目。

**Architecture:** Electron utility process 独占本机 SQLite，向主进程提供小型 Catalog Interface；扫描与真实落盘/移动结果增量写入。React 分栏查询分页数据，实际目录与虚拟分类共享文件预览；目录一致性使用从现有规划器提取的落位函数。

**Tech Stack:** 项目现有 Electron 44.9.1、React、TypeScript、exiftool-vendored；拟用实际内置 Node 24.22.0 的 `node:sqlite`。本机已验证模块可加载，utility process/打包验证列为 Task 1。

**Spec:** `docs/superpowers/specs/2026-10-28-library-browser-design.md`；外部证据：`docs/research/2026-10-28-column-browser-exif-index.md`。

## Global Constraints

- 状态为待评审计划。本轮不实现、不安装依赖、不提交/推送；后续执行方式由用户评审后决定。
- 用户已确认第一版浏览备份目标中的照片库。推荐每次选择一个已配置目标图库；独立照片/视频根同属可选范围，两块备份分别计数。
- 不写源卡；分类不移动文件。整理仍走现有 review / Apply 和恢复机制。
- 数值单位：焦距 mm、光圈 f 数、曝光秒、ISO；范围输入两端均包含，自动桶左闭右开且末桶含上界。
- 拍摄日历使用相机本地日期；不以电脑时区改写。缺失、失败、未读分别显示。
- 数据库在本机 `userData/catalog/catalog.sqlite`；属于可重建缓存，不授予复制/删除/移动许可，也不充当已验证 SHA 证明。
- 服从现有 CPU/内存和磁盘限流；主线程不做同步 SQL；renderer 不接收全库条目或 SQL。
- 保留现有未提交代码；特别是 `core/index.ts`、`routing-options.ts`、edited/folder-rules 测试，实施前重新阅读 diff。
- 延续现有四语言翻译、主题、字号、键盘和跨平台路径政策。

## Review Focus

1. 扫描中断/读取失败/局部扫描不能把未看到的整个库清空；Task 3、4 验证 scope 收尾。
2. 旧扫描和新导入/移动交错不能覆盖已完成的新位置；Task 3、4 验证 mutation revision 保护。
3. 名称不变而内容/EXIF 被外部编辑，目录缓存不能隐藏变化；Task 4 验证逐文件 stat。
4. 改模板、相机时区和合法冲突/已编辑/未知目录不能产生错误待整理提示；Task 2、7 验证。
5. exFAT 重连 inode/dev 改变、相同挂载点换盘不能串库或错误继承元数据；Task 3、4 验证。

## 文件职责与推荐 Interface

以下是拟新增路径，不是现有模块。沿用现有组织，不同时重构旧大文件。

| 文件 | 职责 |
| --- | --- |
| `desktop/catalog/types.ts` | Node-free 的分类、查询、分页、状态与索引事件类型 |
| `desktop/catalog/values.ts` | 从 Metadata 提取数值/日期/名称键，解析用户范围与桶 |
| `desktop/core/folder-rules.ts` | 从 `core/index.ts` 提取完整路由与落位判断，内部包含目录构造；供规划器和索引复用 |
| `desktop/catalog/store.ts` | SQLite schema、事务、revision、查询、重建 |
| `desktop/catalog/worker.ts`、`process.ts` | utility process 协议与受控客户端；失败/退出处理 |
| `desktop/catalog/coordinator.ts` | 扫描/落盘/恢复事件归一、任务优先级与补扫调度 |
| `desktop/renderer/browser/state.ts` | 分栏选择、筛选、面包屑、导航 reducer |
| `desktop/renderer/browser/LibraryBrowser.tsx` | 浏览页和索引/离线状态 |
| `desktop/renderer/browser/ColumnBrowser.tsx` | 列表、分页虚拟化、列宽与键盘 |
| `desktop/renderer/browser/RangeFilter.tsx`、`FilePreview.tsx` | 数值输入及按需预览 |
| `desktop/renderer/browser/translations.ts` | 新文案四语言 |

共享类型的最低约定：

```ts
type NumericField = 'focalLengthMm' | 'fNumber' | 'exposureSeconds' | 'iso';
type CategoryField = NumericField | 'camera' | 'lens' | 'format' |
  'captureYear' | 'captureMonth' | 'captureDay' | 'nameInitial';
type MetadataStatus = 'pending' | 'ready' | 'error';
type PlacementStatus = 'unchecked' | 'inPlace' | 'misplaced' | 'unclassifiable';
// 同字段 values 为 OR；多个 Filter 为 AND。
type Filter =
  | { kind: 'values'; field: CategoryField; values: (string | number)[] }
  | { kind: 'range'; field: NumericField; min?: number; max?: number }
  | { kind: 'missing'; field: CategoryField }
  | { kind: 'placement'; status: PlacementStatus };
interface CatalogQuery {
  libraryId: string;
  filters: Filter[];
  parentPath?: string; // 实际目录模式的直接子目录；省略为全库
  nameContains?: string;
  sort: { field: 'name' | 'captured' | 'format' | NumericField; direction: 'asc' | 'desc' };
  cursor?: string;
  limit: number; // 默认 200，上限 500
}
```

Task 1 同时定义 `CatalogRecord`（设计数据模型的 files/capture/placement 联合输入）、`CatalogRow`（文件摘要）、`DirectoryRow`（直接子目录、数量）、`FacetResult`（分页类别、四种覆盖计数和 min/max）、`CatalogPage`（rows/total/nextCursor/revision）、`CatalogStatus`（在线、进度、dirty、最近完成时间）。数据库整数身份以字符串传输，不能 BigInt 直接过 JSON。

Catalog 的公开方法：

```ts
interface Catalog {
  beginScan(libraryId: string, scope: string[]): Promise<string>;
  ingest(runId: string, records: CatalogRecord[]): Promise<void>;
  endScan(runId: string, result: 'complete' | 'partial' | 'cancelled'): Promise<void>;
  apply(changes: CatalogChange[]): Promise<void>;
  query(query: CatalogQuery): Promise<CatalogPage>;
  directories(query: CatalogQuery): Promise<{rows: DirectoryRow[]; nextCursor?: string; revision: number}>;
  facets(query: CatalogQuery, field: CategoryField): Promise<FacetResult>;
  status(libraryId: string): Promise<CatalogStatus>;
  close(): Promise<void>;
}
```

`CatalogChange` 是带 libraryId、fileId/实际路径与 mutation revision 的判别联合：upsert、move、missing、invalidatePlacement；move 同时携带旧新路径、确认 stat，invalidatePlacement 携带新 rulesScope。move/missing 在旧路径保存墓碑，直到相关扫描结束。元数据读取失败可保存 error；不能将旧 ready 数据不加说明地当本次 ready 继续用。

## Task 1：数值/查询合同与实际运行时验证

**Files:** Create `desktop/catalog/types.ts`, `desktop/catalog/values.ts`, `desktop/tests/catalog-values.test.ts`；Modify `desktop/platform/metadata.ts` 及 `desktop/tests/metadata-extraction.test.ts` 仅在验证高 ISO 来源需修正时。

**Consumes:** 现有 `Metadata`、`Exposure`、拍摄日历解析；官方资料中 ValueConv/ISO 语义。

**Produces:** 上述类型；`catalogValues(metadata:Metadata):CatalogValues`、`parseNumericInput(field:NumericField,text:string):number`、`parseRange(field,minText,maxText):{min?:number;max?:number}`、`numericBuckets(field,observedMin,observedMax):NumericBucket[]`，`CatalogValues`/`NumericBucket` 在 types 中定义。

- [ ] 写行为测试：`1/125 → 0.008`、`2s → 2`、`f/2.8 → 2.8`、`24mm → 24`、ISO 800；分母 0、非有限/负值拒绝；反向范围提示错误；空端点为开界。
- [ ] 写数据归一测试：零值不归到数字类，快门 0.008 与 0.0083 不同组；`2026-01-01T00:15:00+09:00` 仍归 1 月 1 日；缺失和读取失败不混淆。
- [ ] 在测试素材检查 ISO 65535 哨兵及扩展 ISO 标签，确定当前解析器可用性；若有缺口，新增真实 tag fixture 与来源明确的优先级，不能误索引为 ISO 65535。
- [ ] 运行 `node --import tsx --test desktop/tests/catalog-values.test.ts desktop/tests/metadata-extraction.test.ts`，先观察新行为测试失败，再实现通过。
- [ ] 用实际 Electron utility process 执行内存 SQLite 建表、参数写入/查询和退出；验证 worker 消息中的路径、数值、字符串 stat。把结果记录到研究文档，不凭 shell Node 判断兼容性。

## Task 2：提取落位计算，保持现有组织行为

**Files:** Create `desktop/core/folder-rules.ts`, `desktop/tests/catalog-placement.test.ts`；Modify `desktop/core/index.ts`；Extend existing `desktop/tests/folder-rules.test.ts`, `edited-organization.test.ts`, `check-folder-layout.test.ts`。

**Consumes:** 现有 `FolderRules`/`folder()`、`planOnce()` 中家族/Live Photo/GoPro 上下文、unknownReason/unknownRelative/isEdited、特殊目录豁免、`templateValues`、`ruleOptions`、冲突与伴随关系。

**Produces:** `expectedFolder(info:Metadata,mtime:Date,media:{video:boolean;format:string}|undefined,options:FolderRules):{root:'photos'|'videos';camera:string;sub:string}`，等价提取现有函数；`evaluateRoutes(input:RoutingInput):RouteDecision[]` 提取完整路由阶段，`classifyPlacement(input:PlacementInput):PlacementDecision` 用路由结果比较实际落位。RoutingInput 包含本 scope inventory、原始 Metadata map、stat/mtime、family/Live/分段关联及规则；RouteDecision 含文件身份、根角色、期望路径、effective routing metadata 与 keep/exempt 原因。相关类型与 FolderRules 同址定义；原始 capture/exposure 始终独立，不被继承和回退覆盖。

- [ ] 用既有 `plan`/`findMisplaced` 作为行为参照补充 fixture：相机优先、日期 token、静态前缀、独立视频模板、已编辑、未知、Problem files、Conflicts、数字冲突命名和 sidecar。
- [ ] 新增“自定义模板不能被简单 builder 解析也可正确落位”“改模板只使 placement 过期”的失败测试；缺 EXIF 时分别验证 keep 留存为 unclassifiable、folder/fileDate 可得到有效路径、伴随继承不污染原始 EXIF。
- [ ] 等价提取完整路由阶段后让原规划器和分类判断都调用它；只抽出 folder() 不算完成。保留当前 dirty diff 中的编辑目录规则。不要以索引判断替换正式移动计划。
- [ ] 运行上述三个既有测试加 `catalog-placement.test.ts`；确认既有路径结果不变，新状态测试通过。

## Task 3：SQLite 持久化、分页与 facet 查询

**Files:** Create `desktop/catalog/store.ts`, `worker.ts`, `process.ts`, `desktop/tests/catalog-store.test.ts`, `catalog-query.test.ts`；Modify `Scripts/build-desktop.mjs` 添加 `catalog-worker` 对应输入/产物映射，保持现有三个入口；worker 实际路径为 `desktop/catalog/worker.ts`。

**Consumes:** Task 1 类型和 Task 2 状态；现有 volumes 的卷身份。

**Produces:** 实现 Catalog；库身份为 volumeId + 卷内相对根；由 store 持久化 fileId、revision 与 scan generation。数据库 schema 使用 `PRAGMA user_version`，不覆盖现有记录版本 5。

- [ ] 写持久化/重开测试和组合查询 fixture：两个相机、两个镜头、RAW/JPEG/XMP、重复名称、未知值、数值边界、相机本地日期。
- [ ] 对 `camera IN(A,B) AND focalLengthMm BETWEEN 24 AND 70 AND iso<=800` 断言具体文件 ID 和总数；facet 排除本字段条件；每个默认桶边界恰好落一次；目录查询只返回直接子目录。
- [ ] 写 cursor 测试：同名跨路径稳定分页无重复；revision 或 query hash 改变时返回明确 `staleCursor`，不静默翻到新一页；非法 limit/字段/路径在执行前拒绝。
- [ ] 写 scan scope 测试：cancel 不清旧行，局部完成只收尾该子树，partial 的失败子树保留；起始 revision 后的新 upsert/move 不被旧扫描覆写；move/missing 的旧路径墓碑阻止旧扫描复活文件，扫描结束前不清理墓碑。
- [ ] 写卷测试：同卷改挂载点维持库身份，同路径换卷不读旧库；不可信卷 ID 不能永久串联；数据库缺失/损坏/不支持 schema 时成为可重建缓存。
- [ ] 实现事务批次、参数化 SQL、上述基础索引、WAL 和短查询；同步 SQL 留在 worker。索引进程崩溃使客户端未完成请求结束并将图库标 dirty，重开通过正常刷新恢复，不无限重启。
- [ ] 运行 `node --import tsx --test desktop/tests/catalog-store.test.ts desktop/tests/catalog-query.test.ts`；同时重跑 Electron utility process 集成验证，不能只有宿主 Node 的测试。

## Task 4：扫描与导入自动增量接入

**Files:** Create `desktop/catalog/coordinator.ts`, `desktop/tests/catalog-ingestion.test.ts`；Modify `desktop/main.ts`, `desktop/scan-worker.ts`, `desktop/scan-process.ts`；按需扩展 `desktop/platform/metadata.ts` 的读取观察机制。

**Consumes:** Catalog、扫描 inventory/routing 批次、`onFileOutcome`；现有 resource governor、卷信息。

**Produces:** `CatalogCoordinator.observeScan(event:CatalogScanEvent):Promise<void>`、`observeOutcome(outcome:FileOutcome):Promise<void>`、`refresh(libraryId:string,signal:AbortSignal):Promise<void>`；对应事件类型放 types。后台刷新首次进入、连接以及工作结束后空闲执行，已有任务合并，不叠加整库扫描。

- [ ] 写“来源扫描不等于目标已存在”“导入两目标仅成功一份只增加一库”“existing/routed 保留实际路径”的回归测试。
- [ ] 写“名称/目录时间不变但文件 EXIF 编辑后重读”“原文件 stat 不变复用元数据”“重连后的身份须重新校验”测试。
- [ ] 接入既有读取结果而非重跑 metadata；图库刷新可复用枚举名称，但逐文件校验元数据 stat，单独 metadataVersion 控制解析器升级。
- [ ] 批次默认最多 256 条或 250 ms flush，进程队列最多 4096 条；无法消费则标 dirty 并停止继续排队，安排空闲补扫。磁盘上的正式导入/整理具有优先级，补扫可取消/暂停。
- [ ] 每批次事务形成 revision；仅扫描成功完成的 scope 可收尾。索引写入失败成为独立告警，不把照片重新复制、不改变真实导入结果。
- [ ] 运行 `node --import tsx --test desktop/tests/catalog-ingestion.test.ts desktop/tests/scan-memory.test.ts desktop/tests/scan-concurrency.test.ts desktop/tests/verification-once.test.ts`，断言 warm 交互没有 metadata 调用，索引不新增全文件 hash。

## Task 5：整理、恢复与去重事件一致性

**Files:** Extend coordinator 和 `desktop/tests/catalog-ingestion.test.ts`；Modify `desktop/main.ts`, `desktop/core/recovery.ts`, `desktop/core/duplicate-removal.ts`, `desktop/core/destinations.ts`，以实际 move observer/已完成日志事件所在位置为准，仅添加必要观察入口。

**Consumes:** 成功改名、恢复、undo、duplicate removal 的真实结果；Catalog.apply。

**Produces:** `observeMove(event:CatalogMoveEvent):Promise<void>`；旧新 root/path/最终 stat 和动作类型必须明确，复用现有 `carryRouting` 的观察链，不能覆盖它。有歧义的家族配对交给定点补扫。

- [ ] 写部分成功整理后只更新已完成移动的测试；正常停止、崩溃恢复、undo、finalize、duplicate removal 分别断言库内可见 ID/位置/计数。
- [ ] 进入恢复原件区的条目退出普通结果；恢复返回正常根后重新可见。删除恢复缓存不会删除正常库条目。
- [ ] 确认 rename 不改变文件名时可携带已知 EXIF；冲突导致改名时，名字相关的 DJI/来源解析按当前 metadata 策略重算，不盲目复制旧解释值。
- [ ] 运行 ingestion 新测试和 `desktop/tests/recovery-remount.test.ts`、`organization-release-duplicates.test.ts`、`organize-folder-layout.test.ts`；没有成功移动不发成功索引事件。

## Task 6：侧边栏入口、目录/分类分栏与预览

**Files:** Create browser 下 state/UI/translations 文件、`desktop/tests/browser-state.test.ts`, `browser-ui.test.ts`, `catalog-ipc.test.ts`；Modify `desktop/shared.ts`, `preload.ts`, `main.ts`, `renderer/RootApp.tsx`, `renderer/workspace-state.ts`, `renderer/i18n.tsx`, `renderer/styles.css`, `desktop/state-channel.ts`（仅需要的轻量状态）；Extend QA 导航检查。

**Consumes:** CatalogQuery/Page/FacetResult/Status 和现有 thumbnail/summary/exif 通道。

**Produces:** `DesktopAPI.catalogQuery(query)`, `catalogDirectories(query)`, `catalogFacets(query,field)`, `catalogStatus(libraryId)`；mutation 通过现有 Action 增加 refresh/stop，不接受 renderer 任意 file path 或 SQL。`WorkspacePage` 新增 `browser`。

- [ ] reducer 测试：左列改选清右侧、保留字段顺序，多选 OR/跨列 AND、范围叠加、模式切换、back/forward、排序/列宽不丢选择。
- [ ] IPC 测试：未授权 library、`../`、非法字段、超限 limit、过期 cursor 被拒绝；解析文件路径后沿用 `allowed()` 的在线/包含性核对。
- [ ] 新增侧边栏「分类预览」与浏览页；实现真实目录与可配置分类顺序、字段覆盖率、具体值/自定义范围与已选择筛选条。
- [ ] UI 测试明确断言 ↑↓/←→、Tab/Home/End、Space/Esc、文字框方向键不被截获、可见焦点；Cmd/Ctrl 多选；revision 改变重新请求第一页，晚到响应不能覆盖新选中项。
- [ ] 文件与类别使用稳定 cursor 和列表虚拟化，按需载入预览；主状态广播只带 revision/覆盖率/索引进度，不携带 CatalogPage 或完整 EXIF。
- [ ] 四语言/深浅主题/大字号验收；空库、索引中、离线、无匹配、字段缺失各有明确文案；列最小 180 px、默认 220 px，窄屏横向导航和可折叠预览。
- [ ] 运行三个新测试、既有 workspace/state-channel/metadata-display 测试，再运行 isolated UI QA 的导航和新 browser 检查。

## Task 7：自动待整理提示与正式整理衔接

**Files:** Extend coordinator、browser UI、`desktop/misplaced-results.ts`；Modify `desktop/main.ts`、RootApp 的 Organization 入口；Create `desktop/tests/catalog-reminders.test.ts`；Extend `misplaced-results.test.ts`、QA 的 organization/browser 场景。

**Consumes:** Task 2 共享分类结果、Task 4/5 增量事件、当前 rulesScope、现有 previewOrganization/applyReview。

**Produces:** placement 字段筛选和轻量 reminder 状态 `{libraryId,rulesScope,checked,total,misplaced,unclassifiable,revision}`；规则变化使状态 unchecked 并排队重算，未读 metadata 不伪造完成。

- [ ] 写提醒测试：规则变化不重读已知 EXIF；相同结果不反复打断；partial 明示已检查比例；离线不提供整理执行；缺 metadata 独立计数。
- [ ] 通过 Task 2 全部模板 fixture 断言提醒与当前 findMisplaced 语义一致；合法冲突、编辑、未知、问题文件目录不误报。
- [ ] 展示 badge、当前/建议路径与原因；点击打开当前库既有整理 Review，重新验证，不把缓存 path 或 fileId 列表直接当移动权限。用户筛选只是定位范围，初版正式整理仍按当前已选图库/文件夹的既有范围进行，UI 明示该范围，避免暗示只移动筛选结果。
- [ ] 运行 `node --import tsx --test desktop/tests/catalog-reminders.test.ts desktop/tests/misplaced-results.test.ts desktop/tests/check-folder-layout.test.ts`，并验收点击后先见 review、Apply 后才移动。

## Task 8：性能、打包与交付验证

**Files:** Create `desktop/stress/catalog.stress.ts`, `desktop/qa/ui/checks/browser.ts`；Modify QA harness 与 `docs/research/2026-10-28-column-browser-exif-index.md` 记录实测，更新用户指南中的新入口。

**Consumes:** 完整功能；设计中的拟定指标。

- [ ] 在可丢弃 fixture 生成 10 万主媒体 + companions 的目录/数值记录；记录索引吞吐、db 大小、冷/热 query、facet p50/p95、EXIF 调用次数、主进程阻塞、renderer 行数/内存。100 万记录为扩展压力，单列结果。
- [ ] 验证常见组合查询热 p95 ≤200 ms、冷首次 ≤1 s、活动 DOM 行数 ≤500；用 EXPLAIN QUERY PLAN 定位失败查询后再调整索引，未达标如实记录，不能以新增任意组合索引绕过分析。
- [ ] 模拟扫描取消、磁盘断开、同挂载点换盘、数据库损坏、worker 退出、并行导入/补扫；确认文件操作结果优先且索引最终可刷新修复。
- [ ] 运行 `npm run typecheck`、`npm test`、`npm run build`；运行目录/EXIF/提醒相关的 isolated `npm run codex:test`（支持参数按现有 docs 使用），以及新 catalog stress。只有变更涉及或新失败需要时扩大长时 stress。
- [ ] `npm run package:mac` 后验证数据库 worker 产物、首次打开、重启重连、数值筛选和旧库补建；Windows/Linux 声称支持前分别验证其 packaged runtime、盘符/卷身份。当前主要交付验收 macOS，其他平台未测则明确列出。
- [ ] 记录真实命令、失败、覆盖与性能，交付评审；不自动 commit/push/发布。

## 覆盖自检与执行建议

需求映射：侧边栏/Finder 分栏 → Task 6；日期/名称/相机/格式/镜头/数值范围 → Task 1、3、6；动态字段 → Task 3、6；扫描/导入/整理自动索引 → Task 4、5；自定义结构 → Task 2、7；未整理提醒 → Task 7；效率/可靠性 → Task 3、8。

建议采用分任务实施与独立审查，尤其让目录行为等价提取、索引状态收尾和真实移动事件接入分别通过验证，再集成界面。此建议不是本轮开始实现的指令。用户评审设计及范围后，再按选择执行。

## 实施中用户追加要求（覆盖 Task 6/7/8 相应范围）

Task6 必须实现完整虚拟 hierarchy 编辑器，而不只是一个字段顺序选择器：素材 block 拖入路径、任意重排/移除、独立实例 ID、可重复字段、键盘替代操作；日期年/月/日及安全展示格式、名称首字符/具体值、格式扩展名/媒体类、数值具体值/可编辑范围分桶。提供单字段和组合预设，侧栏可直接进入；自定义预设持久化、命名/重命名/删除。

Task3 增加必要 query 字段：captureYearMonth（月+年）、name（具体名）、mediaKind（格式大类），保持旧 format 为扩展名；可由已有列/JSON派生，无需重新读 EXIF。Task6 本机浏览配置单独持久化，不混入任何 FolderRules。

Task7 浏览提醒只显示/跳转独立整理工具，不在浏览器发起 review/apply/move；虚拟层级变化绝不修改整理规则或使 rulesScope 失效。Task8 UI QA 覆盖拖拽和键盘拼装/重启恢复/切换侧栏预设，并验证媒体字节、路径与整理偏好不变。详见设计追加确认节。
