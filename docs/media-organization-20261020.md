# 媒体过滤、编辑导出与目录合并

用户确认：仅编辑器导出的成片进入 `editied`；RAW 原片及其 XMP 保持原片归组。默认路径分别为 `photobackup/年/年月/相机` 与 `photobackup/年/年月/editied/相机`；编辑导出文件夹名称可在 Organization 修改，必须是单个安全目录名。普通目录预设不因此改变。

## 只读调查

实际 A006 快照中，Unknown Camera 目录含9份媒体、9份伴随文件、11份其他文件和29份系统元文件；抽样MP4、JPEG、PNG均为有效媒体。不能按目录名删除。缺少型号时仍保留Unknown Camera，不用父目录名伪造EXIF型号。

2024/2025/2026根目录快照分别含735、11996、8207份媒体；扫描时旧整理进程仍在运行，因此这些是非原子统计，不作为最终迁移清单。`build/media-organization-audit/inventory.json`保留扩展名、分类和样本。Lightroom导出JPEG实测记录了Lightroom Classic15.2.1及ILCE-7M5型号；旧FUJIFILM X100VI、SONY ILCE-7M5、a7v等目录与元数据型号不一致。

## 应用行为

- 相机卡/协议相机的媒体导入只包含受支持照片和视频，以及确实关联的XMP、Sony XML等伴随文件；旧自定义扩展名规则不能把DSC/DAT等无关文件重新加入。整盘文件备份仍有独立的保留原目录语义。
- 单一元数据解析器识别明确的Lightroom、Photoshop、Capture One、darktable、RawTherapee、Affinity Photo、DxO、GIMP等软件来源。相机固件、ExifTool和单独的Camera Raw调整设置不证明导出。RAW即使有编辑来源也不进入编辑成片目录。
- 同内容、同目标的旧位置文件在目标重新验证后转入恢复区；不同内容的重名文件使用冲突名称保留。没有覆盖式merge。
- 整批新副本校验完成后才移动旧位置原件，恢复区保留原字节。本次维护不自动finalize恢复副本。
- 仅移除已审核源目录中确认为空的旧父目录，使用非递归rmdir；仍有其他文件、下载、系统元文件的目录保留。不得递归清空旧年份或相机目录。
- 后续整理更改了旧日志引用的目标时，使用有鉴权的日志接续关系保留历史，防止旧“恢复”重新建立已废弃布局；旧恢复原件不因此删除。

## 证据与限制

编辑器可能剥除或保留不准确的软件标签，因此不存在能从所有文件中必然判断编辑状态的方法。这里只根据明确来源分类，不靠文件名猜测。Adobe说明Camera Raw/Lightroom调整可仅存于XMP而不改变RAW；ExifTool记录XMP的CreatorTool和History软件来源字段：[Adobe Camera Raw](https://helpx.adobe.com/camera-raw/desktop/get-started/overview-and-setup/introduction-camera-raw.html)、[ExifTool XMP](https://www.exiftool.org/TagNames/XMP.html)。

## 本轮完整测试结果

- 198项后台/单元检查通过，含编辑导出路径、RAW/XMP保留、合并与冲突、空目录清理、连续整理接续、进程中断和复制故障。
- 16项完整Electron检查通过，包括编辑导出目录修改、四语、持久化、不安全目录名拒绝、实际导入/排队/停止与整理恢复。
- 3项实际exFAT镜像故障测试通过：源卸载、目标卸载、容量耗尽及重试。镜像为临时测试卷，未拔出真实卡或A006。
- 6个已连接卷只读检查共7954份媒体、0份无关文件被纳入；真实Lightroom JPEG识别edited=true、ILCE-7M5和拍摄时区-05:00。没有新一轮真实卡写入或重复复制7954份媒体；此前真实导入证据见硬件报告。
- 生产构建、macOS本地签名与安装完成，安装asar与打包asar SHA256一致。ZIP已更新。

验证收据：`build/media-organization-audit/verification.json`；日志与只读调查在同一目录。完整Electron报告：`/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-yMAJDm/artifacts/report.json`。

物理突然断电、所有相机协议和其他操作系统真机不在本次已验证范围；SIGKILL与虚拟卷卸载不能冒充电气断电测试。

## 真实盘任务状态

`Scripts/a006-media-organize.mts --apply --wait-for-previous` 已启动，当前等待旧A006维护进程86104退出并确认其成功报告，之后才调用同一核心对2024、2025、2026和现有photobackup作范围受限的整理。不会处理旁边的独立硬件测试备份目录，也不自动finalize恢复副本。日志：`build/media-organization-audit/hardware-followup.log`；每次运行的计划、执行和恢复校验另存run目录。真实盘迁移尚未完成，不以自动化通过替代完成证明。

此前A006维护进程须先退出，不能同时启动两个修改同一库的整理进程。相机卡只读，真实盘写入限A006。


## 后续跟进（2026-10-20T18:19:37.804866-04:00，多伦多时间）

旧维护执行阶段记录19423项复制/搬移、7766项核对保留、0执行错误；其完整恢复校验尚未生成完成报告。后续进程22343继续等待旧进程86104成功退出。已启动独立只读校验`Scripts/verify-a006-consolidation.mts --run=... --wait`（exec65170），报告目录`build/media-organization-audit/final-audit-297efaf3-25bc-4570-be92-0e09a4fb1287`；它仅在后续整理成功后开始实际内容读取。校验脚本类型检查及合成SHA/重复覆盖/遗漏/符号链接/鉴权测试通过，不等于真实盘最终校验已完成。

校验对照旧计划、新审核与实际鉴权目标、7954项原始导入内容；分别报告规范目标覆盖与恢复区内容保全，逐字节SHA256检查最新恢复原件，并保留证据文件哈希。百度仍在写入的活动下载与未记录历史文件不在“所有记录内容均保全”的断言范围内。

已设置15分钟只读状态跟进（a006），不赋予定时任务发起复制、移动、删除或恢复的能力。现有串行工作与只读校验由本聊天直接启动，保留恢复原件；任务期间通过临时caffeinate防止空闲休眠。详见`build/media-organization-audit/tracking.json`。最终报告完成前不宣称零丢失或全部整理成功。


## 保留恢复副本的控制修正（2026-10-20T18:28:18.509805-04:00）

发现旧维护脚本在完整复核后会自动finalize，这不符合用户本次明确的保留要求。已在其仍处于完整恢复读取时向已核实PID86104发出SIGINT；其校验函数不接受取消信号，会读完当前整批，随后在preflight的取消检查退出，阻止自动清理。原退出报告将保留，不伪装为原脚本整体成功。

进程级采样确认旧维护约2秒读取2,013,265,920字节、采样写入0，说明不是仅凭其他软件磁盘活动猜测它仍在工作。证据`old-process-activity.json`。

旧等待进程22343与旧只读审核42323已在等待状态正常取消，原run/failure报告保留。新跟随进程44122（exec39261）只接受已完成整批复核、明确取消清理且无任何清理标记的保留检查点；其验证器16项测试通过。检查点绑定原执行、原完整复核、原失败退出、事件日志及信号记录的SHA256，不改变原报告。

新的独立只读审核进程44328（exec26777）等待新run完成，逐份核对两代恢复副本，不因重复内容而略过某个恢复路径。新run及审核目录以`build/media-organization-audit/tracking.json`为准；其中supersededAttempts是主动取消的旧等待任务，不能当成新的媒体校验失败。当前尚未完成真实盘整理或最终内容保全审核。


### 旧维护已完成复核并保留原件（2026-10-20T18:30:03.806412-04:00）

旧`recovery-after.json`确认27189/27189项完成，status=complete。进程86104于多伦多18:27:59在清理前按取消请求退出；`summary.json`保留原始passed=false/verification Abort记录，没有改写。无finalization报告或清理事件。新run的`predecessor-checkpoint.json`已通过有界验证，状态verified-retained，绑定原报告和信号记录。

当前新跟随任务已接受检查点，正在检查既有日志后开始限定目录规划；独立只读审核等待本轮整理完成。两轮恢复原件都列入最终逐路径SHA256校验。此处只确认旧复核与安全衔接，不宣称后续年份整理或最终审核已完成。

## User-directed App reset and new UI (2026-10-20 evening)

The user explicitly requested permanent deletion of `photobackup` except edited exports, followed by actual desktop App automatic card imports and scoped organization of A006 root `2024`, `2025`, and `2026`. The previous retention-only follow-up CLI was intentionally stopped during read-only preflight, before producing a plan or applying any new move. Its waiting audit was also stopped; neither cancellation is a content failure.

Deleting the backup immediately would have deleted historical originals relocated there by the previous maintenance. Its authenticated manifest accounts for 19,227 original paths under the root years. Before reset, 235 were exclusively copied back with SHA-256 verification; 26 already existed and retained their authenticated identity. The remaining 18,966 originals were relocated without changing inode/size/mtime into freshly reserved private subfolders within the matching root year. The app can now scan all historical originals under the selected years without reaching inside an old recovery store. The old recovery is no longer resumable and must not be replayed after this transition. This identity-based relocation reuses the predecessor's completed content verification; it is **not** a new full content audit. New App planning and a final content audit remain required.

Local evidence: `build/media-organization-audit/reset-restored-originals.jsonl`, `reset-original-locations.jsonl`, and `reset-restoration-summary.json`. Earlier unsuccessful restoration attempts stopped before any moves; a later deliberate interrupt retained 235 verified restored files, which the namespace transition recognizes explicitly. Camera cards were never modified.

The App now exposes native multi-folder selection for organization, publishes drive detection before expensive recovery checks, and saves actual execution plans/results under its user-data `operation-reports/<job-id>`. Unknown formats remain excluded by default; the interface supports remembered exclusion or explicit camera-folder copying. Camera-folder inference uses the nearest directory with unambiguous media metadata, preserves ambiguity as `Unknown Camera`, and does not classify unknown data as edited exports. Existing media companions remain associated independently.

Real App UI evidence so far: six mounted sources automatically detected (five media cards plus Sony PMHOME), A006 destination ready, all prompted unknown extensions explicitly excluded and remembered, and exactly the root `2024`, `2025`, `2026` folders selected through the App's native folder chooser. Automatic import is still off pending completion of edited-export preservation and reset. No permanent reset deletion has occurred at this checkpoint.

### Actual App run launched (19:11–19:14 Toronto)

The installed production App (PID 80668, asar SHA-256 `23dc5c44eeb7b29b053a84516c2564317c609e2d07fc8265527c940114bf013a`) now has independent source cards and title-bar Start, Stop, Automatic, Total progress and All errors controls. Error details live in their own panel. The global photo-picker button is removed; individual file EXIF inspection remains. Four-language layout checks passed at 1000px and 150% text. Current verification: 231 backend tests and 18 full Electron checks passed. See `build/media-organization-audit/app-ui-verification.json`.

A real UI action enabled Automatic. Six attached sources were detected without manual folder source selection; two card jobs are actively scanning/verifying, with the others queued. Another real UI action clicked Organize now with precisely `2024`, `2025`, `2026` selected. Its Library organization job is queued after the six imports and uses the same canonical planner/executor as reviewed organization, preserving new recovery originals. Screenshots: `app-real-source-cards.png` and `app-real-progress.png` in the audit directory. This is an in-progress hardware test, not a completed content verification.

All 786 selected edited exports (4,223,039,854 bytes), including retained originals corresponding to recognized exports, were SHA-256 checked before relocation outside deletion scope. Their receipt is `reset-preserved-edited.jsonl`. A nested recovery folder was renamed to `Retained edited originals` inside the reserved edited-source folder so the App will scan it, with the prefix mapping recorded in `reset-edited-path-mapping.json`.

The user-authorized permanent deletion of the remaining old backup initially stopped when macOS automatically removed a paired AppleDouble sidecar; only disappearance of `._` service files is now skipped. Remaining cleanup was isolated at the path recorded in `reset-pending-deletion.json`, leaving `/Volumes/A006/photobackup` free for the new App. Media removal is prioritized before the large obsolete recovery-event directory. Cleanup is still running; `reset-ready-for-app.json` means the original path was vacated, **not** that all permanent deletion has finished. `reset-complete.json` is the required final deletion receipt. Do not delete or traverse the new App library as part of old cleanup.

Independent auditor PID 90865 is waiting for all actual App operation receipts plus permanent reset completion before reading media. It verifies actual canonical outputs, every authenticated new retained original, all 7,954 recorded card originals, canonical coverage for the 19,227 historical entries and 786 preserved edited entries, and edited-export placement. It deliberately does not require the old recovery copies that the user explicitly authorized deleting. Reports and current process identities are recorded in `tracking.json`; the heartbeat remains read-only and cannot restart, resume, or click business operations.

The full fixture run found and reproduced a destination ctime race caused by cleanup of the App's own temporary hard link. Duplicate checks and cleanup now share the existing publication lock, while source checks remain strict and source streaming remains parallel. The final full fixture suite passes. It also caught a post-organization settings delay; recovery listing now refreshes asynchronously after work completes.

### Compact UI update staged separately

Subsequent user layout changes put the active page title in the same top row as the global controls, extend the sidebar to the top edge, make Automatic an accessible pressed-state button, compact Settings into adjacent groups, and place the 1–5 source slider alongside Sources & queue. Twelve isolated Electron UI checks passed, including all four languages at 150% text in a 1000px window, native window controls, toggle persistence, and the heading/slider relationship. Evidence: `build/media-organization-audit/compact-ui-verification.json`.

The production App performing the hardware test remains on the previous installed build; it was not restarted or replaced. The new UI package is staged at `build/AutomaticPhotoImporter-UI-Update.zip` and has not been applied to that running App. Do not confuse screenshots of this isolated UI verification with live hardware progress or treat this UI-only package as a completed hardware test.


### Centralized Settings configuration

Moved backup locations, copy policy, backup folder, folder presets/template, media separation, edited-export naming and saved unknown-file rules into the Settings page. Organization retains its operation scope, review/run and recovery actions. The import dashboard shows destination health and a Settings shortcut. No duplicate folder configurator remains on Organization. Existing settings storage and import/organization execution are unchanged.

Build and all 231 backend tests passed. The isolated Electron UI suite passed all 12 checks, including persisted edited-folder changes and all four languages. Report: `build/media-organization-audit/settings-configuration-verification.json`. The production hardware import App was not restarted or replaced.


### Live status, recovery safeguards and interface update

Read-only native App inspection found no errors in All errors; five actual source jobs completed with 1,181 files copied and zero execution errors. The larger Nikon card remained active (last observed 745/6,773, approximately 9 MB/s). Organization and independent full-content verification were still pending. Evidence: `build/media-organization-audit/live-app-status-20261020.json`. This is a progress observation, not a no-loss conclusion.

The staged update adds persisted list/grid source layouts, a per-format media pie in collapsed-by-default details, reduced-motion-aware interaction animations, dedicated format decisions/metadata errors, and authenticated incomplete-copy recovery with deterministic conflict folders. Source cards no longer display unknown-format action blocks. One-session exclusions clear the error item without changing persisted rules. The installed production App remains untouched while its real transfer queue runs.

The complete backend suite passed 248 tests (`/tmp/photo-core-suite-final.txt`), including fresh-process SIGKILL staging/publication recovery, inode preservation, concurrent imports, changed/forged receipts and deterministic conflicts. UI-only normal-motion checks passed 14 before the additional motion-preference check; the reduced-motion run passed all 15 (`photo-importer-codex-PlPrCb/artifacts/report.json` in the task temp directory). Physical power-off/device-cache behavior has not been exercised.

Final update verification: build and all 249 backend tests passed, the complete isolated Electron workflow passed 21 checks, and reduced-motion UI QA passed 15 checks. `build/media-organization-audit/interface-copy-verification.json` binds the reports and the SHA-256 of the signed staged ZIP. Production PID 80668 was not replaced or restarted. The normal-motion full suite validates real app copy/retry/duplicate, concurrent folder creation, organization, recheck and second-destination actions with temporary fixtures.


### Per-format capacity strip; pie removed

At the user’s request, source and destination capacity displays now use a continuous Storage-style strip with used/total/free readings and a legend. Source scans split media by actual extension (NEF, ARW, JPG, PNG, MP4, MOV, etc.), with distinct colors. Other/unscanned usage stays gray; destination media categories are not invented. The previously requested pie chart has been removed. Format counts and sizes remain in expanded details. Settings text fields now commit the current input value on blur, including fast input/blur sequences. Build, all 253 backend tests and 16 isolated Electron UI checks passed. Evidence: `build/media-organization-audit/storage-format-ui-verification.json`. The production App performing hardware imports was not replaced or restarted.
