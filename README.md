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

Three cameras, a drawer of SD cards, and a backup drive full of folders called `DCIM copy 2`.

Automatic Photo Importer turns that into `photobackup/2026/202610/NIKON Z f/`. It reads the camera's own metadata, not file dates, and proves every copy with SHA-256 before it trusts it.

```
photobackup/              ← the backup path you choose
└── 2026/                 ← year, from the capture date
    └── 202610/           ← month
        └── NIKON Z f/    ← camera model, from EXIF
            ├── DSC_0001.NEF
            ├── DSC_0001.xmp   ← sidecars stay with their file
            └── DSC_0002.MOV
```

Each date level can be switched off, a day folder added, or the camera put first. In **Settings → Folder structure** you can also split photos and videos by format.

Your originals are never at risk:

- Nothing on the card is moved, changed or deleted.
- Identical files are skipped. A different file with the same name goes to `Conflicts/<content-id>/` inside the camera folder, never over the original.
- Stop an import, or pull the card, and import it again: the app rechecks what was already written and carries on.

### Getting started

You need Node.js and npm.

```sh
npm ci
npm start
```

On first launch, pick a backup drive or folder: a local folder or a fixed external HDD or SSD. Camera cards and USB flash drives can't be backup destinations. The app creates `photobackup` inside it, or uses the folder as is if you clear the name.

For USB cameras on macOS, build the camera helper once first. It needs the Xcode command-line tools.

```sh
npm run native:mac
```

### Everyday use

Keep the app open and insert a card, or connect a camera over USB. With **Automatic** on, the import starts by itself.

- **Start imports** queues every connected card, even with Automatic off.
- **Stop** cancels running work; finished files stay.
- **Review** shows the plan before anything is copied.
- **Scan media** reads a card without copying: totals, formats, and which cameras shot them.

### More than imports

**Back up whole drives.** **Back up drives or folders…** copies every file with its original folders under `Drive backups/`, without sorting by camera or date. **Mirror** mode moves files that disappeared from the source into `Drive backups/.mirror-removed/`; it never deletes.

**Use two disks.** **Copy to both destinations** writes a verified copy to each of two physical disks. **Fill first, then second** moves on to the second disk when the first is full.

**Tidy an old library.** **Organize existing files…** previews a new structure for files you already have, then applies it. Each original waits in a hidden recovery area until you release it, so you can undo. See [Organization and recovery](docs/organization-recovery.md).

**Remove duplicates.** Review the duplicate groups found during imports and organizing. Unwanted copies go to the same recovery area, with undo. See [Remove duplicates](docs/remove-duplicates.md).

### Limits

| Platform | Status |
| --- | --- |
| macOS (Apple silicon) | Built and tested. USB cameras work through ImageCaptureCore. |
| Windows | Same code, with a `package:win` target. Not yet tested on hardware. |
| Linux | Same code, with a `package:linux` target. Not yet tested on hardware. |

USB camera files are staged on the Mac before copying, so they need local free space, and most cameras offer no checksum to compare against. There is no Wi-Fi transfer and no video playback preview. Builds are local and not notarized.

Records written by versions before v5 (the `Photo Importer Recovery` folders, per-file import receipts and index files) are no longer converted. A drive that holds them shows **Acknowledge old records**; the records stay untouched, and organizing or removing duplicates on that library waits until you acknowledge. The build tagged `records-migrator-v5` is the last one that converts them.

### Development

```sh
npm run build          # Typecheck and bundle the renderer and Electron process
npm run typecheck      # TypeScript checks only
npm test               # Backend and platform tests
npm run test:stress    # Long-running stress tests
npm run package:mac    # Package a local macOS arm64 app into build/desktop
npm run codex:test     # Isolated end-to-end run with fixture media
npm run codex:qa       # Leave a fixture app open for UI checks
```

`codex:test` also accepts `--no-build`, `--ui-only` and `--organization-only`. See [Codex testing](docs/codex-testing.md).

### Documentation

- [Architecture and features](docs/architecture-and-features.md) (in Chinese)
- [Organization and recovery](docs/organization-recovery.md) · [Remove duplicates](docs/remove-duplicates.md)
- [Scan performance](docs/scan-performance.md) · [Verification](docs/verification.md)
- [Shared desktop implementation](docs/multiplatform-migration.md)
- [Icon](docs/icon.md) · [Research](docs/research.md) · [Earlier SwiftUI app](docs/legacy-implementation.md)

---

<a id="zh-hans"></a>

## 简体中文

三台相机、一抽屉 SD 卡，还有一块装满 `DCIM copy 2` 这类文件夹的备份硬盘。

Automatic Photo Importer（自动照片导入器）会把它们整理成 `photobackup/2026/202610/NIKON Z f/`。它读取的是相机自己写入的元数据，而不是文件日期；每份副本都要先通过 SHA-256 校验，才算数。

```
photobackup/              ← 你选择的备份路径
└── 2026/                 ← 年份，来自拍摄日期
    └── 202610/           ← 月份
        └── NIKON Z f/    ← 相机型号，来自 EXIF
            ├── DSC_0001.NEF
            ├── DSC_0001.xmp   ← 附属文件跟随主文件
            └── DSC_0002.MOV
```

每一级日期文件夹都可以关闭，也可以加上日期文件夹，或者把相机放在最前面。在「设置 → 文件夹结构」中，还可以把照片和视频按格式分开存放。

你的原始文件永远不会有风险：

- 存储卡上的任何内容都不会被移动、修改或删除。
- 相同的文件会被跳过。同名但内容不同的文件会放进相机文件夹里的 `Conflicts/<content-id>/`，绝不会覆盖原文件。
- 停止导入或拔出存储卡后，再次导入即可：应用会重新检查已写入的内容，然后继续。

### 快速开始

需要 Node.js 和 npm。

```sh
npm ci
npm start
```

首次启动时，选择一个备份磁盘或文件夹：本地文件夹，或固定的外置硬盘、SSD。相机存储卡和 U 盘不能作为备份目标。应用会在其中创建 `photobackup`；如果清空这个名称，则直接使用所选文件夹。

在 macOS 上使用 USB 相机前，需要先构建一次相机辅助程序。这需要 Xcode 命令行工具。

```sh
npm run native:mac
```

### 日常使用

保持应用运行，插入存储卡，或者用 USB 连接相机。打开「自动」后，导入会自行开始。

- 「开始导入」会把所有已连接的存储卡加入队列，即使「自动」处于关闭状态。
- 「停止」会取消正在进行的任务；已完成的文件会保留。
- 「审核」会在复制任何内容之前显示计划。
- 「扫描媒体」只读取存储卡而不复制：显示总数、格式，以及拍摄它们的相机。

### 不只是导入

**备份整个磁盘。** 「备份磁盘或文件夹…」会把每个文件连同原有文件夹复制到 `Drive backups/` 下，不按相机或日期整理。「镜像」模式会把来源上已消失的文件移到 `Drive backups/.mirror-removed/`；它从不删除文件。

**使用两块磁盘。** 「复制到两个目标」会在两块物理磁盘上各写入一份经过校验的副本。「先存满第一块再用第二块」会在第一块磁盘满了之后改用第二块。

**整理旧图库。** 「整理现有文件…」会为已有文件预览新的结构，然后应用。每个原文件都会留在隐藏的恢复区，直到你释放它，所以可以撤销。详见[整理与恢复](docs/organization-recovery.md)（英文）。

**移除重复文件。** 查看导入和整理时发现的重复文件组。不需要的副本会进入同一个恢复区，可以撤销。详见[移除重复文件](docs/remove-duplicates.md)（英文）。

### 限制

| 平台 | 状态 |
| --- | --- |
| macOS（Apple 芯片） | 已构建并测试。通过 ImageCaptureCore 支持 USB 相机。 |
| Windows | 同一套代码，提供 `package:win` 打包目标。尚未在真实硬件上测试。 |
| Linux | 同一套代码，提供 `package:linux` 打包目标。尚未在真实硬件上测试。 |

USB 相机的文件会先暂存到 Mac 上再复制，因此需要本地空闲空间；而且大多数相机不提供可供比对的校验和。不支持 Wi-Fi 传输，也没有视频播放预览。构建产物仅供本地使用，未经公证。

v5 之前的版本写下的记录（`Photo Importer Recovery` 文件夹、逐个文件的导入回执和索引文件）不再转换。存有这类记录的驱动器会显示**确认旧记录**；这些记录保持原样，该资料库的整理和移除重复项会等到你确认后才进行。标记为 `records-migrator-v5` 的版本是最后一个能转换它们的版本。

### 开发

```sh
npm run build          # 类型检查并打包渲染进程和 Electron 进程
npm run typecheck      # 仅运行 TypeScript 检查
npm test               # 后端和平台测试
npm run test:stress    # 长时间运行的压力测试
npm run package:mac    # 在 build/desktop 中打包本地 macOS arm64 应用
npm run codex:test     # 使用测试素材进行隔离的端到端测试
npm run codex:qa       # 保持测试应用打开以检查界面
```

`codex:test` 还支持 `--no-build`、`--ui-only` 和 `--organization-only`。详见 [Codex 测试](docs/codex-testing.md)。

### 文档

- [实际功能、接口与架构审查](docs/architecture-and-features.md)
- [整理与恢复](docs/organization-recovery.md) · [移除重复文件](docs/remove-duplicates.md)（英文）
- [扫描性能](docs/scan-performance.md) · [验证](docs/verification.md)（英文）
- [共享桌面实现](docs/multiplatform-migration.md)（英文）
- [图标](docs/icon.md) · [调研](docs/research.md) · [早期 SwiftUI 应用](docs/legacy-implementation.md)（英文）

---

<a id="zh-hant"></a>

## 繁體中文

三台相機、一抽屜 SD 卡，還有一顆塞滿 `DCIM copy 2` 這類資料夾的備份硬碟。

Automatic Photo Importer（自動照片匯入器）會把它們整理成 `photobackup/2026/202610/NIKON Z f/`。它讀取的是相機自己寫入的中繼資料，而不是檔案日期；每份副本都要先通過 SHA-256 校驗，才算數。

```
photobackup/              ← 你選擇的備份路徑
└── 2026/                 ← 年份，來自拍攝日期
    └── 202610/           ← 月份
        └── NIKON Z f/    ← 相機型號，來自 EXIF
            ├── DSC_0001.NEF
            ├── DSC_0001.xmp   ← 附屬檔案跟隨主檔案
            └── DSC_0002.MOV
```

每一層日期資料夾都可以關閉，也可以加上日期資料夾，或是把相機放在最前面。在「設定 → 資料夾結構」中，還可以把照片和影片依格式分開存放。

你的原始檔案永遠不會有風險：

- 記憶卡上的任何內容都不會被移動、修改或刪除。
- 相同的檔案會被略過。同名但內容不同的檔案會放進相機資料夾裡的 `Conflicts/<content-id>/`，絕不會覆寫原檔案。
- 停止匯入或拔出記憶卡後，再次匯入即可：App 會重新檢查已寫入的內容，然後繼續。

### 快速開始

需要 Node.js 和 npm。

```sh
npm ci
npm start
```

首次啟動時，選擇一個備份磁碟或資料夾：本機資料夾，或固定式外接硬碟、SSD。相機記憶卡和 USB 隨身碟不能作為備份目的地。App 會在其中建立 `photobackup`；如果清空這個名稱，則直接使用所選資料夾。

在 macOS 上使用 USB 相機前，需要先建置一次相機輔助程式。這需要 Xcode 命令列工具。

```sh
npm run native:mac
```

### 日常使用

保持 App 執行，插入記憶卡，或是用 USB 連接相機。開啟「自動」後，匯入會自行開始。

- 「開始匯入」會把所有已連接的記憶卡加入佇列，即使「自動」處於關閉狀態。
- 「停止」會取消進行中的工作；已完成的檔案會保留。
- 「審核」會在複製任何內容之前顯示計畫。
- 「掃描媒體」只讀取記憶卡而不複製：顯示總數、格式，以及拍攝它們的相機。

### 不只是匯入

**備份整顆磁碟。** 「備份磁碟或資料夾…」會把每個檔案連同原有資料夾複製到 `Drive backups/` 下，不依相機或日期整理。「鏡像」模式會把來源上已消失的檔案移到 `Drive backups/.mirror-removed/`；它從不刪除檔案。

**使用兩顆磁碟。** 「複製到兩個目的地」會在兩顆實體磁碟上各寫入一份經過校驗的副本。「先存滿第一顆再用第二顆」會在第一顆磁碟滿了之後改用第二顆。

**整理舊圖庫。** 「整理現有檔案…」會為現有檔案預覽新的結構，然後套用。每個原檔案都會留在隱藏的復原區，直到你釋放它，所以可以還原。詳見[整理與復原](docs/organization-recovery.md)（英文）。

**移除重複檔案。** 檢視匯入和整理時發現的重複檔案群組。不需要的副本會進入同一個復原區，可以還原。詳見[移除重複檔案](docs/remove-duplicates.md)（英文）。

### 限制

| 平台 | 狀態 |
| --- | --- |
| macOS（Apple 晶片） | 已建置並測試。透過 ImageCaptureCore 支援 USB 相機。 |
| Windows | 同一套程式碼，提供 `package:win` 封裝目標。尚未在實體硬體上測試。 |
| Linux | 同一套程式碼，提供 `package:linux` 封裝目標。尚未在實體硬體上測試。 |

USB 相機的檔案會先暫存到 Mac 上再複製，因此需要本機可用空間；而且大多數相機不提供可供比對的校驗碼。不支援 Wi-Fi 傳輸，也沒有影片播放預覽。建置產物僅供本機使用，未經公證。

v5 之前的版本寫下的記錄（`Photo Importer Recovery` 資料夾、逐個檔案的匯入回執和索引檔案）不再轉換。存有這類記錄的磁碟會顯示**確認舊記錄**；這些記錄保持原樣，該資料庫的整理和移除重複項會等到你確認後才進行。標記為 `records-migrator-v5` 的版本是最後一個能轉換它們的版本。

### 開發

```sh
npm run build          # 型別檢查並打包轉譯程序和 Electron 程序
npm run typecheck      # 僅執行 TypeScript 檢查
npm test               # 後端和平台測試
npm run test:stress    # 長時間執行的壓力測試
npm run package:mac    # 在 build/desktop 中封裝本機 macOS arm64 App
npm run codex:test     # 使用測試素材進行隔離的端對端測試
npm run codex:qa       # 保持測試 App 開啟以檢查介面
```

`codex:test` 還支援 `--no-build`、`--ui-only` 和 `--organization-only`。詳見 [Codex 測試](docs/codex-testing.md)。

### 文件

- [實際功能、介面與架構審查](docs/architecture-and-features.md)（簡體中文）
- [整理與復原](docs/organization-recovery.md) · [移除重複檔案](docs/remove-duplicates.md)（英文）
- [掃描效能](docs/scan-performance.md) · [驗證](docs/verification.md)（英文）
- [共用桌面實作](docs/multiplatform-migration.md)（英文）
- [圖示](docs/icon.md) · [研究](docs/research.md) · [早期 SwiftUI App](docs/legacy-implementation.md)（英文）

---

<a id="ja"></a>

## 日本語

3 台のカメラ、引き出しいっぱいの SD カード、そして `DCIM copy 2` のようなフォルダーだらけのバックアップドライブ。

Automatic Photo Importer は、それを `photobackup/2026/202610/NIKON Z f/` に整理します。ファイルの日付ではなくカメラ自身が記録したメタデータを読み取り、すべてのコピーを SHA-256 で確かめてから信頼します。

```
photobackup/              ← 選んだバックアップパス
└── 2026/                 ← 年（撮影日から）
    └── 202610/           ← 月
        └── NIKON Z f/    ← カメラ機種（EXIF から）
            ├── DSC_0001.NEF
            ├── DSC_0001.xmp   ← サイドカーは本体と一緒に
            └── DSC_0002.MOV
```

日付の各階層はオフにでき、日のフォルダーを加えたり、カメラを先頭にしたりもできます。「設定 → フォルダー構造」では、写真と動画をフォーマット別に分けることもできます。

元のファイルが危険にさらされることはありません。

- カード上のものを移動・変更・削除することはありません。
- 同一のファイルはスキップします。名前が同じで内容が異なるファイルはカメラフォルダー内の `Conflicts/<content-id>/` に置かれ、元のファイルを上書きしません。
- インポートを停止したり、カードを抜いたりしても、もう一度インポートすれば大丈夫です。書き込み済みの内容を再確認してから続きを行います。

### はじめに

Node.js と npm が必要です。

```sh
npm ci
npm start
```

初回起動時に、バックアップ先のドライブまたはフォルダーを選びます。ローカルフォルダーか、据え置きの外付け HDD・SSD が使えます。カメラのカードと USB フラッシュドライブはバックアップ先にできません。アプリはその中に `photobackup` を作ります。名前を空にすると、選んだフォルダーをそのまま使います。

macOS で USB カメラを使う場合は、先にカメラヘルパーを一度ビルドします。Xcode コマンドラインツールが必要です。

```sh
npm run native:mac
```

### 毎日の使い方

アプリを開いたままカードを挿すか、USB でカメラをつなぎます。「自動」がオンなら、インポートは自動で始まります。

- 「インポート開始」は、「自動」がオフでも、接続中のすべてのカードをキューに入れます。
- 「停止」は実行中の処理を取り消します。完了したファイルは残ります。
- 「確認」は、何かをコピーする前にプランを表示します。
- 「メディアをスキャン」はコピーせずにカードを読み取り、総数、フォーマット、撮影したカメラを表示します。

### インポートだけではありません

**ドライブを丸ごとバックアップ。** 「ドライブやフォルダーをバックアップ…」は、カメラや日付で並べ替えずに、すべてのファイルを元のフォルダーごと `Drive backups/` の下にコピーします。「ミラー」モードでは、ソースから消えたファイルを `Drive backups/.mirror-removed/` に移します。削除はしません。

**2 台のディスクを使う。** 「両方の保存先にコピー」は、2 台の物理ディスクそれぞれに検証済みのコピーを書き込みます。「1台目から順に保存」は、1 台目がいっぱいになると 2 台目に移ります。

**古いライブラリを整理。** 「既存ファイルを整理…」は、手元のファイルに新しい構成をプレビューしてから適用します。元のファイルは解放するまで隠しの復元領域に残るので、元に戻せます。詳しくは[整理と復元](docs/organization-recovery.md)（英語）を参照してください。

**重複ファイルを削除。** インポートや整理の際に見つかった重複グループを確認します。不要なコピーは同じ復元領域に移り、元に戻せます。詳しくは[重複ファイルの削除](docs/remove-duplicates.md)（英語）を参照してください。

### 制限事項

| プラットフォーム | 状況 |
| --- | --- |
| macOS（Apple シリコン） | ビルドとテスト済み。ImageCaptureCore 経由で USB カメラに対応。 |
| Windows | 同じコードで、`package:win` ターゲットあり。実機ではまだテストしていません。 |
| Linux | 同じコードで、`package:linux` ターゲットあり。実機ではまだテストしていません。 |

USB カメラのファイルはコピーの前にいったん Mac に一時保存されるため、ローカルの空き容量が必要です。また、多くのカメラは照合用のチェックサムを提供しません。Wi-Fi 転送と動画の再生プレビューには対応していません。ビルドはローカル用で、公証されていません。

v5 より前のバージョンが書いた記録（`Photo Importer Recovery` フォルダー、ファイルごとの読み込み受領記録とインデックスファイル）は変換されなくなりました。こうした記録があるドライブには**古い記録を確認済みにする**が表示されます。記録はそのまま残り、そのライブラリの整理と重複の削除は確認するまで待機します。これらを変換できる最後のビルドは `records-migrator-v5` タグのものです。

### 開発

```sh
npm run build          # 型チェックとレンダラー・Electron プロセスのバンドル
npm run typecheck      # TypeScript のチェックのみ
npm test               # バックエンドとプラットフォームのテスト
npm run test:stress    # 長時間のストレステスト
npm run package:mac    # build/desktop にローカルの macOS arm64 アプリをパッケージ化
npm run codex:test     # テスト素材を使った隔離環境でのエンドツーエンド実行
npm run codex:qa       # UI 確認のためテスト用アプリを開いたままにする
```

`codex:test` は `--no-build`、`--ui-only`、`--organization-only` も受け付けます。詳しくは [Codex テスト](docs/codex-testing.md) を参照してください。

### ドキュメント

- [機能・インターフェース・アーキテクチャのレビュー](docs/architecture-and-features.md)（中国語）
- [整理と復元](docs/organization-recovery.md) · [重複ファイルの削除](docs/remove-duplicates.md)（英語）
- [スキャン性能](docs/scan-performance.md) · [検証](docs/verification.md)（英語）
- [共通デスクトップ実装](docs/multiplatform-migration.md)（英語）
- [アイコン](docs/icon.md) · [調査](docs/research.md) · [以前の SwiftUI アプリ](docs/legacy-implementation.md)（英語）
