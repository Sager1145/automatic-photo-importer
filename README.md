<p align="center">
  <img src="Assets/AppIcon-preview.png" alt="Automatic Photo Importer icon" width="128">
</p>

<h1 align="center">Automatic Photo Importer</h1>

<p align="center">
  <a href="#en">English</a> · <a href="#zh-hans">简体中文</a> · <a href="#zh-hant">繁體中文</a> · <a href="#ja">日本語</a>
</p>

---

<a id="en"></a>

## English

Automatic Photo Importer is a desktop app that copies photos and videos off camera cards and cameras, checks every copy, and files them by capture date and camera. It never deletes your originals.

It is built with React and TypeScript, runs in Electron, and uses a portable Node filesystem backend. A small native helper adds USB camera support on macOS.

### Highlights

- **Finds your media on its own.** Detects SD and CFexpress cards, card readers, cameras in USB mass-storage mode and, on macOS, USB cameras through ImageCaptureCore. With **Automatic** on, a new card starts importing as soon as it appears.
- **Sorts by real metadata.** Reads the camera model and capture date from the original RAW files and keeps the date the camera recorded, even across time zones. One card can hold several cameras.
- **Checks every byte.** Each copy is verified with SHA-256. Identical files are skipped. A different file with the same name goes to `Conflicts/<content-id>/`, so nothing is overwritten. An interrupted import resumes after rechecking what was already written.
- **Flexible folders.** The default is `photobackup/{year}/{yyyymm}/{camera}`. In Settings, put the date or the camera first, turn year, month and day folders on or off, and pick how months and days are named (`10`, `202610`, `10 October`, `2026-10 October`; `20`, `20261020`). **Advanced: custom template** accepts the tokens `{year}`, `{yyyymm}`, `{month}`, `{monthName}`, `{yearMonthName}`, `{day}`, `{yyyyMMdd}` and `{camera}`.
- **Six media layouts.** Keep everything together (the default), split photos and videos by format (`Photos/NEF`, `Videos/MOV`), use one folder per format, put videos with photos or photos with videos, or send videos to a separate `videobackup` folder. Format names are merged (JPG/JPEG → `JPEG`, HEIC/HIF → `HEIF`, TIF → `TIFF`, MPG → `MPEG`).
- **Sidecars stay with their file.** XMP, DOP and AAE stay with the photo; Sony XML, DJI LRF and audio stay with the video; `NKSC_PARAM` stays beside the NEF. Live Photo MOVs are filed with their still. Unknown file types can be ignored or sent to a folder you choose.
- **Scan before you copy.** **Scan media** and **Scan all** only read. Each source shows its path, capacity, photo and video totals, a per-format breakdown (NEF, ARW, JPG, MP4, …) and the camera models confirmed from metadata.
- **One or two disks.** Copy to one destination, to two separate disks, or fill the first disk and continue on the second.
- **Whole-drive backups.** Copy any drive or folder file for file, keeping its folder structure.
- **Tidy an existing library.** Preview and apply a new folder structure to files you already have. Originals go to a hidden recovery area first, and you can undo.
- **Remove duplicates.** Review duplicate groups found during imports and organization, and move unwanted copies to recovery with undo.
- **Photo details.** Photo previews, full EXIF, and shutter counts when the metadata provides them, with their source shown.
- **Four languages.** English, 简体中文, 繁體中文 and 日本語, with System, Light and Dark appearance, an accent color and text size from 100% to 150%.

### Getting started

You need Node.js and npm. Building the macOS camera helper also needs the Xcode command-line tools.

```sh
npm ci
npm start
```

On first launch, choose a backup drive or folder and a backup path inside it (default `photobackup`; leave it empty to use the folder itself). Keep the app open so it can notice new cards.

To use USB cameras on macOS, build the native helper first:

```sh
npm run native:mac
```

### Using the app

The title bar holds **Start imports**, **Stop**, **Automatic**, **Total progress** and **All errors**. ⌘/Ctrl+R refreshes the source list.

- **Start imports** queues every connected source, even when **Automatic** is off.
- **Stop** clears the queue and cancels running work. Finished files stay; importing the same source again picks up where it left off.
- **Automatic** imports new cameras and cards as they connect.
- **Review** builds a plan you can inspect before anything is copied. Select a row to see that file's photo and metadata.
- The parallel-source slider on the Import desk runs 1 to 5 sources at once (default 2).
- Open **Drive details** on a source card for its full path, format counts and camera models.

Camera cards cannot be chosen as backup destinations, and removable USB flash drives are blocked too. Local folders and fixed external HDDs and SSDs work. Turn on **Enable media folder selection** to import from an ordinary drive or folder.

### Drive backups and two disks

**Back up drives or folders…** copies every file and keeps the original folders, without sorting by camera or date. Each source gets its own folder under `Drive backups/`. Hidden files are included; symbolic links, AppleDouble and filesystem service files are skipped.

- **Additive** keeps files that exist only on the destination, and keeps both versions when names collide.
- **Mirror** lists files that disappeared or changed on the source in Review. Applying it moves them to `Drive backups/.mirror-removed/<date>/`. Nothing is deleted.

**Copy to both destinations** needs two different physical disks and reports any copy that did not finish. **Fill first, then second** places each photo with its sidecars on whichever disk has room. Both only copy. Neither is RAID, and neither passes deletions along.

### Organizing an existing library

In **Organization**, set the backup folder, template and layout, then choose **Organize existing files…**. The preview covers the whole destination, old backup folders included, and shows where each file would move. Applying it writes and SHA-256-checks each new file, then moves the original into a hidden recovery area on the same disk.

**Organization recovery** lists past operations. **Resume & recheck** and **Recheck** confirm contents and continue. The first recheck in a session reads every file; later ones read only files whose size or dates changed. **Full recheck** reads everything again. Recovered originals are only removed when you explicitly release them.

Set **Edited exports folder** (default `editied`) to keep exports from your editor apart from the originals in each month. Normal imports never move or change anything on the camera card or source drive.

### Compatibility

| | |
| --- | --- |
| macOS (Apple silicon) | Built and tested here. USB camera (PTP) support through ImageCaptureCore. |
| Windows, Linux | Share the same app and backend, with `package:win` and `package:linux` targets. Not yet built or tested on hardware. |
| Mass-storage cards | Plain filesystem access, verified against the source. |
| USB cameras | Files are staged on the Mac first, so local free space is needed. They can be checked against the reported size; most cameras offer no checksum. |
| Metadata | Read with the bundled ExifTool. Missing metadata is shown in the preview and falls back to clearly named folders. |

Proprietary Wi-Fi transfer modes are not supported. Videos show metadata but have no playback preview yet. Builds are local development builds, not notarized releases.

### Development

```sh
npm run build          # Typecheck and bundle the renderer and Electron process
npm run typecheck      # TypeScript checks only
npm test               # Backend and platform tests
npm run test:stress    # Long-running stress tests
npm run native:mac     # Build the macOS camera helper
npm run package:mac    # Package a local macOS arm64 app into build/desktop
npm run codex:test     # Isolated end-to-end run with fixture media
npm run codex:qa       # Leave a fixture app open for UI checks
```

`codex:test` also accepts `--no-build`, `--ui-only` and `--organization-only`. See [Codex testing](docs/codex-testing.md).

### Documentation

- [Architecture and features](docs/architecture-and-features.md) (in Chinese)
- [Organization and recovery](docs/organization-recovery.md)
- [Remove duplicates](docs/remove-duplicates.md)
- [Scan performance](docs/scan-performance.md) · [Verification](docs/verification.md)
- [Shared desktop implementation](docs/multiplatform-migration.md)
- [Icon](docs/icon.md) · [Research](docs/research.md) · [Earlier SwiftUI app](docs/legacy-implementation.md)

---

<a id="zh-hans"></a>

## 简体中文

Automatic Photo Importer（自动照片导入器）是一款桌面应用：它从相机存储卡和相机中复制照片与视频，逐一校验每份副本，并按拍摄日期和相机型号归档。它从不删除你的原始文件。

应用使用 React 和 TypeScript 构建，运行在 Electron 上，后端是可移植的 Node 文件系统实现。在 macOS 上，一个小型原生辅助程序提供 USB 相机支持。

### 主要功能

- **自动发现媒体。** 识别 SD 和 CFexpress 卡、读卡器、处于 USB 大容量存储模式的相机，以及 macOS 上通过 ImageCaptureCore 连接的 USB 相机。打开「自动」后，插入新卡即开始导入。
- **按真实元数据归档。** 从原始 RAW 文件读取相机型号和拍摄日期，即使跨时区也保留相机记录的日期。一张卡上可以有多台相机的文件。
- **逐字节校验。** 每份副本都用 SHA-256 校验，相同文件会跳过。同名但内容不同的文件放入 `Conflicts/<content-id>/`，不会覆盖任何内容。中断的导入会先重新检查已写入的部分，再继续。
- **灵活的文件夹结构。** 默认为 `photobackup/{year}/{yyyymm}/{camera}`。在「设置」中可以把日期或相机放在前面，分别开关年、月、日文件夹，并选择月和日的命名方式（`10`、`202610`、`10 October`、`2026-10 October`；`20`、`20261020`）。「高级：自定义模板」支持 `{year}`、`{yyyymm}`、`{month}`、`{monthName}`、`{yearMonthName}`、`{day}`、`{yyyyMMdd}` 和 `{camera}`。
- **六种媒体布局。** 全部放在一起（默认）、照片和视频按格式分开（`Photos/NEF`、`Videos/MOV`）、每种格式一个文件夹、视频放进照片文件夹或照片放进视频文件夹，或者把视频放到单独的 `videobackup` 文件夹。格式名称会合并（JPG/JPEG → `JPEG`，HEIC/HIF → `HEIF`，TIF → `TIFF`，MPG → `MPEG`）。
- **附属文件跟随主文件。** XMP、DOP、AAE 跟随照片；Sony XML、DJI LRF 和音频跟随视频；`NKSC_PARAM` 放在 NEF 旁边。实况照片的 MOV 与对应的静态照片放在一起。未知文件类型可以忽略，或放到你指定的文件夹。
- **先扫描，后复制。** 「扫描媒体」和「扫描全部」只读取文件。每个来源会显示路径、容量、照片和视频总数、按格式统计（NEF、ARW、JPG、MP4 等），以及从元数据确认的相机型号。
- **一块或两块磁盘。** 复制到一个目标、两块不同的磁盘，或者先存满第一块再用第二块。
- **整盘备份。** 逐个文件复制任意磁盘或文件夹，保留原有文件夹结构。
- **整理现有图库。** 预览并应用新的文件夹结构。原文件会先移入隐藏的恢复区，可以撤销。
- **移除重复文件。** 查看导入和整理时发现的重复文件组，把不需要的副本移入恢复区，可以撤销。
- **照片详情。** 照片预览、完整 EXIF，以及元数据中提供的快门次数（并注明来源）。
- **四种语言。** English、简体中文、繁體中文和日本語；支持跟随系统、浅色和深色外观，可选强调色，文字大小可在 100% 到 150% 之间调节。

### 快速开始

需要 Node.js 和 npm。构建 macOS 相机辅助程序还需要 Xcode 命令行工具。

```sh
npm ci
npm start
```

首次启动时，选择备份磁盘或文件夹，以及其中的备份路径（默认 `photobackup`；留空则直接使用所选文件夹）。保持应用运行，它才能发现新插入的存储卡。

在 macOS 上使用 USB 相机前，请先构建原生辅助程序：

```sh
npm run native:mac
```

### 使用方法

标题栏包含「开始导入」「停止」「自动」「总进度」和「所有错误」。按 ⌘/Ctrl+R 刷新来源列表。

- 「开始导入」会把所有已连接的来源加入队列，即使「自动」处于关闭状态。
- 「停止」会清空队列并取消正在进行的任务。已完成的文件会保留；再次导入同一来源时会从中断处继续。
- 「自动」会在相机和存储卡连接时自动导入。
- 「审核」会生成一份计划，你可以在复制前查看。选择某一行即可查看该文件的照片和元数据。
- 「导入」页上的并行来源滑块可同时处理 1 到 5 个来源（默认 2 个）。
- 在来源卡片上打开「详细信息」，可以查看完整路径、格式统计和相机型号。

相机存储卡不能被选为备份目标，可移动 U 盘也会被阻止。本地文件夹和固定的外置硬盘、SSD 均可使用。打开「启用媒体文件夹选择」后，可以从普通磁盘或文件夹导入。

### 整盘备份与双磁盘

「备份磁盘或文件夹…」会复制所有文件并保留原有文件夹，不按相机或日期整理。每个来源在 `Drive backups/` 下有自己的文件夹。隐藏文件会被包含；符号链接、AppleDouble 和文件系统服务文件会被跳过。

- 「只增不删」保留仅存在于目标上的文件；名称冲突时两个版本都保留。
- 「镜像」会在「审核」中列出来源上已消失或已更改的文件。应用后，这些文件会被移到 `Drive backups/.mirror-removed/<date>/`，不会删除任何内容。

「复制到两个目标」需要两块不同的物理磁盘，并会报告任何未完成的副本。「先存满第一块再用第二块」会把每张照片连同附属文件放到有空间的磁盘上。两者都只做复制，不是 RAID，也不会同步删除操作。

### 整理现有图库

在「整理」页设置备份文件夹、模板和布局，然后选择「整理现有文件…」。预览会扫描整个目标（包括旧的备份文件夹），并显示每个文件将移动到的位置。应用后，每个新文件都会写入并经过 SHA-256 校验，然后原文件被移入同一磁盘上的隐藏恢复区。

「整理恢复」列出以往的操作。「继续并重新检查」和「重新检查」会核对内容并继续。每次会话中的第一次重新检查会读取所有文件；之后只读取大小或日期有变化的文件。「完整重新检查」会重新读取全部内容。恢复区中的原文件只有在你明确释放后才会被移除。

设置「编辑导出文件夹」（默认 `editied`），可在每个月份下把编辑软件导出的照片与原始文件分开存放。正常导入从不移动或修改相机存储卡或来源磁盘上的任何内容。

### 兼容性

| | |
| --- | --- |
| macOS（Apple 芯片） | 已在此构建和测试。通过 ImageCaptureCore 支持 USB 相机（PTP）。 |
| Windows、Linux | 共用同一应用和后端，提供 `package:win` 和 `package:linux` 打包目标。尚未在真实硬件上构建或测试。 |
| 大容量存储卡 | 直接通过文件系统访问，并与来源内容比对校验。 |
| USB 相机 | 文件会先暂存到 Mac 上，因此需要本地空闲空间。可以核对相机报告的大小；大多数相机不提供校验和。 |
| 元数据 | 使用内置的 ExifTool 读取。缺失的元数据会在预览中显示，并使用明确命名的备用文件夹。 |

不支持厂商专有的 Wi-Fi 传输模式。视频可以显示元数据，但暂不支持播放预览。构建产物是本地开发版本，未经公证。

### 开发

```sh
npm run build          # 类型检查并打包渲染进程和 Electron 进程
npm run typecheck      # 仅运行 TypeScript 检查
npm test               # 后端和平台测试
npm run test:stress    # 长时间运行的压力测试
npm run native:mac     # 构建 macOS 相机辅助程序
npm run package:mac    # 在 build/desktop 中打包本地 macOS arm64 应用
npm run codex:test     # 使用测试素材进行隔离的端到端测试
npm run codex:qa       # 保持测试应用打开以检查界面
```

`codex:test` 还支持 `--no-build`、`--ui-only` 和 `--organization-only`。详见 [Codex 测试](docs/codex-testing.md)。

### 文档

- [实际功能、接口与架构审查](docs/architecture-and-features.md)
- [整理与恢复](docs/organization-recovery.md)（英文）
- [移除重复文件](docs/remove-duplicates.md)（英文）
- [扫描性能](docs/scan-performance.md) · [验证](docs/verification.md)（英文）
- [共享桌面实现](docs/multiplatform-migration.md)（英文）
- [图标](docs/icon.md) · [调研](docs/research.md) · [早期 SwiftUI 应用](docs/legacy-implementation.md)（英文）

---

<a id="zh-hant"></a>

## 繁體中文

Automatic Photo Importer（自動照片匯入器）是一款桌面 App：它從相機記憶卡和相機中複製照片與影片，逐一校驗每份副本，並依拍攝日期和相機型號歸檔。它從不刪除你的原始檔案。

App 使用 React 和 TypeScript 開發，在 Electron 上執行，後端是可攜式的 Node 檔案系統實作。在 macOS 上，一個小型原生輔助程式提供 USB 相機支援。

### 主要功能

- **自動偵測媒體。** 辨識 SD 和 CFexpress 卡、讀卡機、處於 USB 大量儲存模式的相機，以及 macOS 上透過 ImageCaptureCore 連接的 USB 相機。開啟「自動」後，插入新卡即開始匯入。
- **依真實中繼資料歸檔。** 從原始 RAW 檔讀取相機型號和拍攝日期，即使跨時區也保留相機記錄的日期。一張卡上可以有多台相機的檔案。
- **逐位元組校驗。** 每份副本都以 SHA-256 校驗，相同檔案會略過。同名但內容不同的檔案放入 `Conflicts/<content-id>/`，不會覆寫任何內容。中斷的匯入會先重新檢查已寫入的部分，再繼續。
- **彈性的資料夾結構。** 預設為 `photobackup/{year}/{yyyymm}/{camera}`。在「設定」中可以把日期或相機放在前面，分別開關年、月、日資料夾，並選擇月和日的命名方式（`10`、`202610`、`10 October`、`2026-10 October`；`20`、`20261020`）。「進階：自訂範本」支援 `{year}`、`{yyyymm}`、`{month}`、`{monthName}`、`{yearMonthName}`、`{day}`、`{yyyyMMdd}` 和 `{camera}`。
- **六種媒體配置。** 全部放在一起（預設）、照片和影片依格式分開（`Photos/NEF`、`Videos/MOV`）、每種格式一個資料夾、影片放進照片資料夾或照片放進影片資料夾，或是把影片放到獨立的 `videobackup` 資料夾。格式名稱會合併（JPG/JPEG → `JPEG`，HEIC/HIF → `HEIF`，TIF → `TIFF`，MPG → `MPEG`）。
- **附屬檔案跟隨主檔案。** XMP、DOP、AAE 跟隨照片；Sony XML、DJI LRF 和音訊跟隨影片；`NKSC_PARAM` 放在 NEF 旁邊。原況照片的 MOV 與對應的靜態照片放在一起。未知檔案類型可以忽略，或放到你指定的資料夾。
- **先掃描，再複製。** 「掃描媒體」和「掃描全部」只讀取檔案。每個來源會顯示路徑、容量、照片和影片總數、依格式統計（NEF、ARW、JPG、MP4 等），以及從中繼資料確認的相機型號。
- **一顆或兩顆磁碟。** 複製到一個目的地、兩顆不同的磁碟，或是先存滿第一顆再用第二顆。
- **整顆磁碟備份。** 逐一複製任何磁碟或資料夾中的檔案，保留原有資料夾結構。
- **整理現有圖庫。** 預覽並套用新的資料夾結構。原檔案會先移入隱藏的復原區，可以還原。
- **移除重複檔案。** 檢視匯入和整理時發現的重複檔案群組，把不需要的副本移入復原區，可以還原。
- **照片詳細資訊。** 照片預覽、完整 EXIF，以及中繼資料中提供的快門次數（並註明來源）。
- **四種語言。** English、简体中文、繁體中文和日本語；支援跟隨系統、淺色和深色外觀，可選強調色，文字大小可在 100% 到 150% 之間調整。

### 快速開始

需要 Node.js 和 npm。建置 macOS 相機輔助程式還需要 Xcode 命令列工具。

```sh
npm ci
npm start
```

首次啟動時，選擇備份磁碟或資料夾，以及其中的備份路徑（預設 `photobackup`；留空則直接使用所選資料夾）。保持 App 執行，它才能偵測新插入的記憶卡。

在 macOS 上使用 USB 相機前，請先建置原生輔助程式：

```sh
npm run native:mac
```

### 使用方式

標題列包含「開始匯入」「停止」「自動」「總進度」和「所有錯誤」。按 ⌘/Ctrl+R 重新整理來源清單。

- 「開始匯入」會把所有已連接的來源加入佇列，即使「自動」處於關閉狀態。
- 「停止」會清空佇列並取消進行中的工作。已完成的檔案會保留；再次匯入同一來源時會從中斷處繼續。
- 「自動」會在相機和記憶卡連接時自動匯入。
- 「審核」會產生一份計畫，讓你在複製前檢視。選擇某一列即可檢視該檔案的照片和中繼資料。
- 「匯入」頁上的平行來源滑桿可同時處理 1 到 5 個來源（預設 2 個）。
- 在來源卡片上開啟「詳細資訊」，可以檢視完整路徑、格式統計和相機型號。

相機記憶卡不能被選為備份目的地，可移除式 USB 隨身碟也會被阻擋。本機資料夾和固定式外接硬碟、SSD 皆可使用。開啟「啟用媒體資料夾選擇」後，可以從一般磁碟或資料夾匯入。

### 整顆磁碟備份與雙磁碟

「備份磁碟或資料夾…」會複製所有檔案並保留原有資料夾，不依相機或日期整理。每個來源在 `Drive backups/` 下有自己的資料夾。隱藏檔案會被包含；符號連結、AppleDouble 和檔案系統服務檔案會被略過。

- 「只增不刪」保留僅存在於目的地的檔案；名稱衝突時兩個版本都保留。
- 「鏡像」會在「審核」中列出來源上已消失或已變更的檔案。套用後，這些檔案會被移到 `Drive backups/.mirror-removed/<date>/`，不會刪除任何內容。

「複製到兩個目的地」需要兩顆不同的實體磁碟，並會回報任何未完成的副本。「先存滿第一顆再用第二顆」會把每張照片連同附屬檔案放到有空間的磁碟上。兩者都只做複製，不是 RAID，也不會同步刪除操作。

### 整理現有圖庫

在「整理」頁設定備份資料夾、範本和配置，然後選擇「整理現有檔案…」。預覽會掃描整個目的地（包括舊的備份資料夾），並顯示每個檔案將移動到的位置。套用後，每個新檔案都會寫入並經過 SHA-256 校驗，接著原檔案被移入同一磁碟上的隱藏復原區。

「整理復原」列出過去的操作。「繼續並重新檢查」和「重新檢查」會核對內容並繼續。每次工作階段中的第一次重新檢查會讀取所有檔案；之後只讀取大小或日期有變化的檔案。「完整重新檢查」會重新讀取全部內容。復原區中的原檔案只有在你明確釋放後才會被移除。

設定「編輯匯出資料夾」（預設 `editied`），可在每個月份下把編輯軟體匯出的照片與原始檔案分開存放。一般匯入從不移動或修改相機記憶卡或來源磁碟上的任何內容。

### 相容性

| | |
| --- | --- |
| macOS（Apple 晶片） | 已在此建置和測試。透過 ImageCaptureCore 支援 USB 相機（PTP）。 |
| Windows、Linux | 共用同一 App 和後端，提供 `package:win` 和 `package:linux` 封裝目標。尚未在實體硬體上建置或測試。 |
| 大量儲存記憶卡 | 直接透過檔案系統存取，並與來源內容比對校驗。 |
| USB 相機 | 檔案會先暫存到 Mac 上，因此需要本機可用空間。可以核對相機回報的大小；大多數相機不提供校驗碼。 |
| 中繼資料 | 使用內建的 ExifTool 讀取。缺少的中繼資料會在預覽中顯示，並使用明確命名的備用資料夾。 |

不支援廠商專有的 Wi-Fi 傳輸模式。影片可以顯示中繼資料，但暫不支援播放預覽。建置產物是本機開發版本，未經公證。

### 開發

```sh
npm run build          # 型別檢查並打包轉譯程序和 Electron 程序
npm run typecheck      # 僅執行 TypeScript 檢查
npm test               # 後端和平台測試
npm run test:stress    # 長時間執行的壓力測試
npm run native:mac     # 建置 macOS 相機輔助程式
npm run package:mac    # 在 build/desktop 中封裝本機 macOS arm64 App
npm run codex:test     # 使用測試素材進行隔離的端對端測試
npm run codex:qa       # 保持測試 App 開啟以檢查介面
```

`codex:test` 還支援 `--no-build`、`--ui-only` 和 `--organization-only`。詳見 [Codex 測試](docs/codex-testing.md)。

### 文件

- [實際功能、介面與架構審查](docs/architecture-and-features.md)（簡體中文）
- [整理與復原](docs/organization-recovery.md)（英文）
- [移除重複檔案](docs/remove-duplicates.md)（英文）
- [掃描效能](docs/scan-performance.md) · [驗證](docs/verification.md)（英文）
- [共用桌面實作](docs/multiplatform-migration.md)（英文）
- [圖示](docs/icon.md) · [研究](docs/research.md) · [早期 SwiftUI App](docs/legacy-implementation.md)（英文）

---

<a id="ja"></a>

## 日本語

Automatic Photo Importer は、カメラのメモリーカードやカメラから写真と動画をコピーし、すべてのコピーを検証したうえで、撮影日とカメラ別に整理するデスクトップアプリです。元のファイルを削除することはありません。

React と TypeScript で作られ、Electron 上で動作し、移植性のある Node ファイルシステムバックエンドを使います。macOS では、小さなネイティブヘルパーが USB カメラに対応します。

### 主な機能

- **メディアを自動で検出。** SD カード、CFexpress カード、カードリーダー、USB マスストレージモードのカメラ、そして macOS では ImageCaptureCore 経由の USB カメラを認識します。「自動」をオンにすると、新しいカードを挿した時点でインポートが始まります。
- **実際のメタデータで整理。** 元の RAW ファイルからカメラ機種と撮影日を読み取り、タイムゾーンをまたいでもカメラが記録した日付を保ちます。1 枚のカードに複数のカメラのファイルがあっても区別します。
- **1 バイト単位で検証。** すべてのコピーを SHA-256 で検証し、同一のファイルはスキップします。名前が同じで内容が異なるファイルは `Conflicts/<content-id>/` に置かれ、上書きは起こりません。中断したインポートは、書き込み済みの部分を再確認してから再開します。
- **柔軟なフォルダー構成。** 既定は `photobackup/{year}/{yyyymm}/{camera}` です。「設定」で日付とカメラのどちらを先にするか、年・月・日のフォルダーを個別にオンオフするか、月と日の名前の形式（`10`、`202610`、`10 October`、`2026-10 October`；`20`、`20261020`）を選べます。「詳細：カスタムテンプレート」では `{year}`、`{yyyymm}`、`{month}`、`{monthName}`、`{yearMonthName}`、`{day}`、`{yyyyMMdd}`、`{camera}` を使えます。
- **6 種類のメディア配置。** すべてまとめる（既定）、写真と動画をフォーマット別に分ける（`Photos/NEF`、`Videos/MOV`）、フォーマットごとに 1 フォルダー、動画を写真と一緒に／写真を動画と一緒に置く、または動画を別の `videobackup` フォルダーに送る、から選べます。フォーマット名は統合されます（JPG/JPEG → `JPEG`、HEIC/HIF → `HEIF`、TIF → `TIFF`、MPG → `MPEG`）。
- **サイドカーは本体と一緒に。** XMP・DOP・AAE は写真と、Sony XML・DJI LRF・音声は動画と一緒に置かれ、`NKSC_PARAM` は NEF の隣に置かれます。Live Photos の MOV は対応する静止画と同じ場所に入ります。不明なファイル形式は無視するか、指定したフォルダーに送れます。
- **コピーの前にスキャン。** 「メディアをスキャン」と「すべてスキャン」は読み取りだけを行います。各ソースにはパス、容量、写真と動画の総数、フォーマット別の内訳（NEF、ARW、JPG、MP4 など）、メタデータで確認したカメラ機種が表示されます。
- **1 台または 2 台のディスク。** 1 つの保存先、2 台の別々のディスク、または 1 台目がいっぱいになったら 2 台目に続ける方式を選べます。
- **ドライブ丸ごとバックアップ。** 任意のドライブやフォルダーを、フォルダー構成を保ったまますべてコピーします。
- **既存ライブラリの整理。** 手元のファイルに新しいフォルダー構成をプレビューしてから適用します。元のファイルはまず隠しの復元領域に移され、元に戻せます。
- **重複ファイルの削除。** インポートや整理の際に見つかった重複グループを確認し、不要なコピーを復元領域へ移します。元に戻せます。
- **写真の詳細。** 写真のプレビュー、すべての EXIF、メタデータに含まれる場合はシャッター回数（取得元つき）を表示します。
- **4 か国語。** English、简体中文、繁體中文、日本語に対応。外観はシステム／ライト／ダーク、アクセントカラー、文字サイズ（100%〜150%）を選べます。

### はじめに

Node.js と npm が必要です。macOS のカメラヘルパーをビルドするには Xcode コマンドラインツールも必要です。

```sh
npm ci
npm start
```

初回起動時に、バックアップ先のドライブまたはフォルダーと、その中のバックアップパス（既定は `photobackup`。空にすると選んだフォルダーをそのまま使います）を選びます。新しいカードを検出できるよう、アプリは起動したままにしておきます。

macOS で USB カメラを使う前に、ネイティブヘルパーをビルドします。

```sh
npm run native:mac
```

### 使い方

タイトルバーには「インポート開始」「停止」「自動」「全体の進捗」「すべてのエラー」があります。⌘/Ctrl+R でソース一覧を更新します。

- 「インポート開始」は、「自動」がオフでも、接続中のすべてのソースをキューに入れます。
- 「停止」はキューを空にし、実行中の処理を取り消します。完了したファイルは残り、同じソースをもう一度インポートすると続きから再開します。
- 「自動」は、カメラやカードが接続されたときに自動でインポートします。
- 「確認」は、コピーの前に内容を確かめられるプランを作ります。行を選ぶと、そのファイルの写真とメタデータが表示されます。
- 「インポート」画面の並列ソース数スライダーで、同時に処理するソースを 1〜5 件（既定 2 件）に設定できます。
- ソースカードの「詳細情報」を開くと、完全なパス、フォーマット別の件数、カメラ機種を確認できます。

カメラのメモリーカードはバックアップ先に選べず、取り外し可能な USB フラッシュドライブもブロックされます。ローカルフォルダーと据え置きの外付け HDD・SSD は使えます。「メディアフォルダーの選択を有効化」をオンにすると、通常のドライブやフォルダーからインポートできます。

### ドライブのバックアップと 2 台のディスク

「ドライブやフォルダーをバックアップ…」は、カメラや日付で並べ替えずに、すべてのファイルを元のフォルダー構成のままコピーします。ソースごとに `Drive backups/` の下に専用フォルダーが作られます。隠しファイルは含まれ、シンボリックリンク、AppleDouble、ファイルシステムのサービスファイルはスキップされます。

- 「追加のみ」は保存先にしかないファイルを残し、名前が衝突した場合は両方を残します。
- 「ミラー」は、ソースから消えたファイルや変更されたファイルを「確認」に一覧表示します。適用すると `Drive backups/.mirror-removed/<date>/` に移動し、何も削除しません。

「両方の保存先にコピー」には 2 台の別々の物理ディスクが必要で、完了しなかったコピーを報告します。「1台目から順に保存」は、各写真をサイドカーと一緒に空きのあるディスクに配置します。どちらもコピーするだけで、RAID ではなく、削除を反映することもありません。

### 既存ライブラリの整理

「整理」画面でバックアップフォルダー、テンプレート、配置を設定し、「既存ファイルを整理…」を選びます。プレビューは古いバックアップフォルダーを含む保存先全体を対象に、各ファイルの移動先を示します。適用すると、新しいファイルを書き込んで SHA-256 で確認し、元のファイルを同じディスク上の隠しの復元領域に移します。

「整理の復元」には過去の操作が一覧表示されます。「再開して再確認」と「再確認」は内容を確かめてから続行します。セッション中の最初の再確認はすべてのファイルを読み、以降はサイズや日付が変わったファイルだけを読みます。「すべて再確認」はもう一度すべてを読みます。復元領域の元ファイルは、明示的に解放したときだけ取り除かれます。

「編集済み書き出しフォルダー」（既定は `editied`）を設定すると、編集アプリから書き出した写真を各月の元ファイルと分けて保存できます。通常のインポートでは、カメラのカードやソースドライブ上のものを移動・変更することはありません。

### 対応環境

| | |
| --- | --- |
| macOS（Apple シリコン） | ここでビルドとテストを実施。ImageCaptureCore 経由で USB カメラ（PTP）に対応。 |
| Windows、Linux | 同じアプリとバックエンドを共有し、`package:win` と `package:linux` のターゲットがあります。実機でのビルドやテストはまだ行っていません。 |
| マスストレージのカード | 通常のファイルシステムでアクセスし、ソースの内容と照合して検証します。 |
| USB カメラ | ファイルはいったん Mac に一時保存されるため、ローカルの空き容量が必要です。カメラが報告するサイズとは照合できますが、多くのカメラはチェックサムを提供しません。 |
| メタデータ | 同梱の ExifTool で読み取ります。欠けているメタデータはプレビューに表示され、分かりやすい名前の代替フォルダーが使われます。 |

メーカー独自の Wi-Fi 転送モードには対応していません。動画はメタデータを表示できますが、再生プレビューはまだありません。ビルドはローカルの開発版で、公証済みのリリースではありません。

### 開発

```sh
npm run build          # 型チェックとレンダラー・Electron プロセスのバンドル
npm run typecheck      # TypeScript のチェックのみ
npm test               # バックエンドとプラットフォームのテスト
npm run test:stress    # 長時間のストレステスト
npm run native:mac     # macOS カメラヘルパーのビルド
npm run package:mac    # build/desktop にローカルの macOS arm64 アプリをパッケージ化
npm run codex:test     # テスト素材を使った隔離環境でのエンドツーエンド実行
npm run codex:qa       # UI 確認のためテスト用アプリを開いたままにする
```

`codex:test` は `--no-build`、`--ui-only`、`--organization-only` も受け付けます。詳しくは [Codex テスト](docs/codex-testing.md) を参照してください。

### ドキュメント

- [機能・インターフェース・アーキテクチャのレビュー](docs/architecture-and-features.md)（中国語）
- [整理と復元](docs/organization-recovery.md)（英語）
- [重複ファイルの削除](docs/remove-duplicates.md)（英語）
- [スキャン性能](docs/scan-performance.md) · [検証](docs/verification.md)（英語）
- [共通デスクトップ実装](docs/multiplatform-migration.md)（英語）
- [アイコン](docs/icon.md) · [調査](docs/research.md) · [以前の SwiftUI アプリ](docs/legacy-implementation.md)（英語）
