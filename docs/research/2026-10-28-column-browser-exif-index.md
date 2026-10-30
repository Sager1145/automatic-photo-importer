# 分栏浏览与 EXIF 本地索引：一手资料研究

研究日期：2026-10-28。本文为规划依据，不包含功能实现。代码背景由主代理提供：Electron 44、React/TypeScript、exiftool-vendored 39；已有数值曝光字段及磁盘 sealed v5 缓存，当前没有 SQLite 依赖。以下把文档事实与产品建议分开。

## 已核实的文档事实

- Apple 将 column view 定义为一系列纵向列组成的层级浏览器；首列放根层级，叶节点可在末尾显示详情/预览，列应可调整宽度。[Apple HIG](https://developer.apple.com/design/human-interface-guidelines/column-views)。NSBrowser 的每个后续列表示更深一层，但这是 AppKit 组件概念，不能直接作为 Electron 实现方案。[NSBrowser](https://developer.apple.com/documentation/appkit/nsbrowser)
- Finder 分栏并排显示文件夹及其内容，保留所在层级的上下文；选择文件可以显示缩略图和详情。[Finder 布局](https://support.apple.com/en-mk/guide/mac-help/mchldaafb302/mac)。列分隔线可拖动，双击可展开到完整文件名宽度。[排序与列宽](https://support.apple.com/en-ie/guide/mac-help/mchlp1745/27/mac/27)
- Apple 记录的快捷键包括 ⌘3 分栏、⌘↑ 上级目录、⌘↓ 打开选中项、⌘[ / ⌘] 前进后退。该快捷键文档把无修饰左右箭头的展开/折叠明确标为仅列表视图；不能拿这条文字证明 Finder 分栏的方向键细节。[Mac 快捷键](https://support.apple.com/en-us/102650)。选中文件按空格可 Quick Look。[Finder 使用指南](https://support.apple.com/en-ca/guide/mac-pro/apddf030866a/mac)
- EXIF 的 ExposureTime、FNumber、FocalLength 是 rational64u；LensModel 是字符串；LensInfo 是焦段和光圈范围的四个有理数，不等于镜头型号。ISO 标签为 int16u，另有 ISOSpeed 等高位宽相关标签，不能把 65535 当作所有文件的实际 ISO。[ExifTool EXIF 标签](https://exiftool.org/TagNames/EXIF.html)
- `-n` 或单独标签后缀 `#` 返回供计算的 ValueConv，数值通常转成标准单位（例如秒）；默认 PrintConv 是展示值。[ExifTool 数据流](https://www.exiftool.org/under.html)。标准 FNumber/ExposureTime 应对应相机显示值，但可能已被四舍五入。[FAQ 第 4 项](https://exiftool.org/faq.html)
- Composite:LensID 从多种镜头标签推导；Composite:Aperture、ShutterSpeed 有各自的原始标签来源，因此它们应被视作有来源的派生值。[Composite 标签](https://exiftool.org/TagNames/Composite.html)。`-stay_open` 可避免每条命令重新加载 ExifTool；`-fast2` 跳过 MakerNotes，可能损失镜头识别所需信息。[命令文档](https://exiftool.org/exiftool_pod2.html)
- SQLite 组合索引受左侧列约束与首个范围条件限制，通常不能用一个巨大组合索引同时加速所有独立范围；`GROUP BY`/`DISTINCT` 有时也可受益于索引。[优化器说明](https://sqlite.org/optoverview.html)。覆盖索引可减少回表，索引存在写入与空间成本，需按实际查询选择。[查询规划](https://sqlite.org/queryplanner.html)
- WAL 支持读写并行，但同一时刻仍只有一个写者；长读事务会阻碍 checkpoint。WAL 不适用于网络文件系统，相关访问必须位于同一主机。[SQLite WAL](https://sqlite.org/wal.html)
- Electron 扩展 Node 的 process；Node 的 `process.versions` 报告实际运行时组件版本。[Electron process](https://www.electronjs.org/docs/latest/api/process)、[Node process](https://nodejs.org/docs/latest-v22.x/api/process.html#processversions)。`node:sqlite` 自 Node 22.5 加入且其 API/稳定性随版本变化；当前在线最新文档已经显示不同于早期版本的 Database API，不能直接套到项目。[Node SQLite](https://nodejs.org/api/sqlite.html)。Electron utilityProcess 提供带 Node 和消息端口的子进程。[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

## 对本项目的建议（设计推论）

1. **两种浏览语义共用一个界面**：真实目录路径按层级逐列展开；相机、镜头、焦段等分类是虚拟 facet，选择只改变查询，不移动照片。列头区分「文件夹」与「筛选」，保持路径面包屑。点击旧列另一项时替换右侧后续列；选文件时末列显示预览和 EXIF。
2. **明确键盘约定**：上下选择行、右键进入子层、左键回上层，空格预览、Esc 关闭预览；这是本产品拟采用的行为，尚未经真实 Finder 操作逐项核验。保留焦点、横向滚动到活动列；允许拖动列宽。不要把方向键从数值输入框抢走。
3. **统一数值**：`focal_length_mm`、`f_number`、`exposure_seconds` 用数值列，`iso` 用整数；`1/125` 解析为 0.008 秒，`2 s` 为 2 秒，查询按秒比较。展示格式单独生成。保留 source tag 与缺失状态；未知值为 NULL，不能用 0 补齐。精确选择应来自库中实际归一化值；范围比较使用上下界，不按字符串排序。若采用相机标准档位归并，需明确标为档位匹配，不能静默改写原值。
4. **镜头降级有标识**：优先可信 LensModel；缺失时使用解码后的 Composite:LensID/厂商标签；仅有 LensInfo 时显示规格并标为「型号未知」，不把同规格镜头合并成确定型号。相机用 Make + Model 形成规范键；保留原文用于详情。ISO 的多来源优先级需用现有 ExifTool 输出样本核验，不能无条件互相替代。
5. **facet 联动**：不同字段之间 AND，同字段多选 OR；数值支持精确值与闭区间。每个 facet 的候选数量应应用其他字段的过滤，再聚合自身字段，避免选中一台相机后无法看到其他可选相机；「未知」单独计数。结果按文件身份分页，缩略图仅加载可见部分。
6. **增量索引只读照片**：扫描/导入已有 EXIF 读取结果直接 upsert；整理成功后更新位置而不重复提取 EXIF。记录 volume/root 身份、相对路径、size/mtime、提取版本、规则版本。size/mtime 是变化检测线索，不是内容哈希或永久身份。全库回填交给可暂停、有进度的后台任务；索引中/完成/错误需区分，当前结果注明已索引覆盖范围。
7. **SQLite 作为可重建本地缓存**：建议本机 userData 存库，即使照片在 NAS 上也不把活跃 WAL 数据库放 NAS。一个写队列批量提交；查询和索引处理移出 UI 热路径。先为 root、camera、lens、各数值范围和常见排序建立少量索引，用真实数据的 EXPLAIN QUERY PLAN 与延迟验证；不预建所有字段排列组合。现有 sealed 缓存可继续承担其既有角色，便携快照另做版本化导出设计。
8. **运行时门槛**：决定使用 `node:sqlite` 前，在项目实际 Electron 主进程及所选后台进程记录 `process.versions.node/electron`，试加载模块并执行内存建表/参数查询；再测打包应用。宿主 shell Node、package.json 的 @types/node、Electron 主版本都不能替代这个验证。确认真实运行时版本后使用其对应文档，选择 utilityProcess 或主进程创建的 Node worker；不需要为数据库开放 renderer 的 Node 集成。
9. **自定义结构与未整理检测**：持久化 folder template 与规则版本；用同一规则引擎计算「期望路径」并与当前相对路径比较，而不是靠目录名形状猜测是否整理。外盘离线、EXIF 缺失、规则改变、计划待应用分别表示；修改规则后先生成移动预览，再由既有整理流程执行。

## 检索限制与待验证项

Firecrawl 连接器可发现，但首批请求均因额度耗尽而未执行，因此使用 web 后备。Apple/SQLite/Electron/Node 页面已取得正文或官方检索摘录；ExifTool 多个页面正文访问返回 403，上述 EXIF 结论来自其官方页面检索摘录，未把摘录冒充全文。未验证当前项目打包运行时、百万级照片性能、Finder 实机按键行为、所有品牌镜头/高 ISO 降级结果；这些属于实现前的小型验证任务。本文不证明本机当前运行的 SQLite 版本或 `node:sqlite` 可用。

## 实施前运行时实测

2026-10-28 在实际 Electron utilityProcess 中建立内存 SQLite 表、参数化插入并查询成功。实际版本 Electron 44.9.1 / Node 24.22.0 / SQLite 3.53.4；中文文件名、ISO 102400 和纳秒时间字符串 `1793250000123456789` 原样往返。可丢弃探针与输出保存在 `/private/tmp/photo-browser-runtime/`。此结果验证后台进程能力，尚不代替后续 catalog worker 与打包应用验收。


## Task 8 independent measurements (2026-10-28)

Real SQLite stress: 100,000 primary + 20,000 companion rows, 44.890s ingestion (2,228 primary/s), 336,982,016-byte DB. After SQL-owner EXPLAIN-driven changes, every one of eight tested operations met warm p95 ≤200ms (worst146.59ms) and reopened-catalog first request ≤1s (worst159.71ms). 20 warm samples per operation; OS cache not purged, typed fixtures exclude EXIF parsing. First benchmark correctly failed on facet/directory latency; the independent rerun passed. Raw result: `/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-catalog-stress-McqgJk/report.json`.

Real Electron GUI: 24 pre-tagged real PNG/JPEG scanned through catalogRefresh, native trusted drag/drop and keyboard composition, presets, actual thumbnail, real folders and navigation-only organization reminder passed. File hashes/paths/size/mtime/ctime and organization preferences were unchanged. Long31-block layouts at1000px,125%/200% light/dark mounted5–6 blocks/5facet columns/23option rows. Raw GUI result: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-Uh83A0/artifacts/report.json`. These are pre-stop-default-amendment results, not packaged-app claims. Full commands, failures, screenshot paths and limitations are in `.superpowers/sdd/2026-10-28-library-browser/task-8-report.md`. Packaging, Windows/Linux and1m extension remain unverified.


## Photographic stop defaults follow-up (2026-10-28)

Primary references checked for the browser's terminology and grouping defaults:

- [Nikon — Understanding Maximum Aperture](https://www.nikonusa.com/learn-and-explore/c/tips-and-techniques/understanding-maximum-aperture) describes aperture as f/stops and gives the familiar nominal sequence from 1.4 through 16. This supports f/ labels and nominal full-stop browse ranges.
- [Canon — Exposure Triangle Basics](https://www.canon.co.nz/get-inspired/exposure-triangle-basics) describes doubling ISO steps and shutter duration intervals, with fractional-second shutter examples. The browser therefore uses ISO labels and fractions/seconds rather than presenting raw shutter decimals.
- [Canon PowerShot G7X settings reference](https://asia.canon/en/support/8202196700) lists intermediate shutter settings including 1/160, aperture f/1.8 and ISO 125. This supports preserving recorded intermediate settings in exact mode instead of snapping metadata to full-stop defaults.

The extended boundary arrays are the user's approved product policy, not a claim that every camera supports the same exposure settings. They are shared in `desktop/catalog/values.ts`. Numeric values remain physical capture units; full-stop buckets only affect browsing. Half-open interior ranges, an open final tail and explicit edge symbols keep boundary membership clear. Existing saved browser views are not migrated or overwritten.
