import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Language } from '../shared';
import { formatMessage, type Message } from '../messages';

export const localeNames: Record<Language, string> = { en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ja: '日本語' };
export const languages = Object.keys(localeNames) as Language[];
// English keys are also the fallback. Placeholder names and user data never pass through translation.
const rows = `
Performance|性能|效能|パフォーマンス
CPU threads|CPU 线程数|CPU 執行緒數|CPU スレッド数
{count} threads|{count} 个线程|{count} 個執行緒|{count} スレッド
Memory limit|内存上限|記憶體上限|メモリ上限
{count} MB|{count} MB|{count} MB|{count} MB
The most processors the importer uses at once for checksums and reading photo details. Lower it to keep the Mac responsive. Applies to the next import; file reading adjusts after you restart the app.|导入器同时用于校验和读取照片信息的最大处理器数量。调低可让 Mac 保持流畅。下次导入时生效；文件读取线程在重启应用后调整。|匯入器同時用於校驗和讀取照片資訊的最大處理器數量。調低可讓 Mac 保持流暢。下次匯入時生效；檔案讀取執行緒在重新啟動 App 後調整。|チェックサムと写真情報の読み取りに同時に使うプロセッサーの最大数です。下げると Mac の動作が軽くなります。次回の読み込みから適用され、ファイル読み取りはアプリの再起動後に調整されます。
A soft budget for buffers, caches and the app itself. Near the limit new files wait for running ones; nothing is stopped. Applies to the next import.|缓冲区、缓存和应用本身的内存软预算。接近上限时，新文件会等待正在处理的文件；不会停止任何任务。下次导入时生效。|緩衝區、快取和 App 本身的記憶體軟預算。接近上限時，新檔案會等待進行中的檔案；不會停止任何工作。下次匯入時生效。|バッファー、キャッシュ、アプリ自体のためのメモリの目安です。上限に近づくと新しいファイルは処理中のファイルを待ちますが、何も停止しません。次回の読み込みから適用されます。
Using up to {threads} threads · {used} MB of {limit} MB|最多使用 {threads} 个线程 · 已用 {used} MB／上限 {limit} MB|最多使用 {threads} 個執行緒 · 已用 {used} MB／上限 {limit} MB|最大 {threads} スレッド · {used} MB／{limit} MB を使用中
Reset to defaults|恢复默认值|恢復預設值|初期設定に戻す
Memory use is above the limit. New files wait until it drops; running work continues.|内存用量已超过上限。新文件会等待用量下降；正在进行的任务会继续。|記憶體用量已超過上限。新檔案會等待用量下降；進行中的工作會繼續。|メモリ使用量が上限を超えています。使用量が下がるまで新しいファイルは待機し、処理中の作業は続行されます。
{count} temporary copies were left on {drive} — your photos are safe|{drive} 上留下了 {count} 个临时副本 — 你的照片是安全的|{drive} 上留下了 {count} 個暫存副本 — 你的照片是安全的|{drive} に一時コピーが {count} 件残りました — 写真は無事です
1 temporary copy was left on {drive} — your photo is safe|{drive} 上留下了 1 个临时副本 — 你的照片是安全的|{drive} 上留下了 1 個暫存副本 — 你的照片是安全的|{drive} に一時コピーが 1 件残りました — 写真は無事です
These are scratch files from the copy step. Every real copy was checked and is complete; Clean up removes the leftovers.|这些是复制过程中的临时文件。所有正式副本都已检查且完整；“清理”会删除这些残留文件。|這些是複製過程中的暫存檔案。所有正式副本都已檢查且完整；「清理」會刪除這些殘留檔案。|コピー処理の作業用ファイルです。本来のコピーはすべて確認済みで完全です。「クリーンアップ」で残りを削除できます。
{count} files could not be read for photo details|有 {count} 个文件无法读取照片详情|有 {count} 個檔案無法讀取照片詳細資訊|{count} 件のファイルで写真の詳細を読み取れませんでした
1 file could not be read for photo details|有 1 个文件无法读取照片详情|有 1 個檔案無法讀取照片詳細資訊|1 件のファイルで写真の詳細を読み取れませんでした
The files are still copied; their dates may come from the file instead.|这些文件仍会被复制；日期可能改用文件本身的日期。|這些檔案仍會被複製；日期可能改用檔案本身的日期。|ファイルはコピーされます。日付はファイル自体のものになる場合があります。
{count} empty files were left out|有 {count} 个空文件被跳过|有 {count} 個空檔案被略過|空のファイル {count} 件を除外しました
1 empty file was left out|有 1 个空文件被跳过|有 1 個空檔案被略過|空のファイル 1 件を除外しました
Empty files hold no photo data.|空文件不含任何照片数据。|空檔案不含任何照片資料。|空のファイルには写真データがありません。
{count} files could not be copied|有 {count} 个文件无法复制|有 {count} 個檔案無法複製|{count} 件のファイルをコピーできませんでした
1 file could not be copied|有 1 个文件无法复制|有 1 個檔案無法複製|1 件のファイルをコピーできませんでした
These files are not in the backup yet. Retry runs the job again.|这些文件尚未进入备份。“重试”会重新运行该任务。|這些檔案尚未進入備份。「重試」會重新執行該工作。|これらのファイルはまだバックアップにありません。「再試行」でジョブをもう一度実行します。
{count} files were skipped because they failed|有 {count} 个文件因出错而被跳过|有 {count} 個檔案因出錯而被略過|{count} 件のファイルは失敗したためスキップされました
1 file was skipped because it failed|有 1 个文件因出错而被跳过|有 1 個檔案因出錯而被略過|1 件のファイルは失敗したためスキップされました
The other files were copied. Retry runs the job again, including these files.|其他文件已复制。“重试”会重新运行任务，包括这些文件。|其他檔案已複製。「重試」會重新執行工作，包括這些檔案。|他のファイルはコピーされました。「再試行」でこれらも含めてジョブを再実行します。
{count} issues need attention|有 {count} 个问题需要留意|有 {count} 個問題需要留意|{count} 件の確認が必要です
1 issue needs attention|有 1 个问题需要留意|有 1 個問題需要留意|1 件の確認が必要です
1 macOS ._ file was kept|已保留 1 个 macOS ._ 文件|已保留 1 個 macOS ._ 檔案|macOS の ._ ファイルを 1 件残しました
{count} macOS ._ files were kept|已保留 {count} 个 macOS ._ 文件|已保留 {count} 個 macOS ._ 檔案|macOS の ._ ファイルを {count} 件残しました
A ._ file may hold tags or comments, so it was left in place. Your photos are not affected.|._ 文件可能包含标签或注释，因此已原样保留。你的照片不受影响。|._ 檔案可能包含標籤或註解，因此已原樣保留。你的照片不受影響。|._ ファイルにはタグやコメントが含まれている場合があるため、そのまま残しました。写真には影響しません。
1 macOS ._ file or folder could not be checked|有 1 个 macOS ._ 文件或文件夹无法检查|有 1 個 macOS ._ 檔案或資料夾無法檢查|macOS の ._ ファイルまたはフォルダ 1 件を確認できませんでした
{count} macOS ._ files or folders could not be checked|有 {count} 个 macOS ._ 文件或文件夹无法检查|有 {count} 個 macOS ._ 檔案或資料夾無法檢查|macOS の ._ ファイルまたはフォルダ {count} 件を確認できませんでした
These were left as they are. Your photos are not affected.|这些内容已保持原样。你的照片不受影响。|這些內容已保持原樣。你的照片不受影響。|これらはそのまま残しました。写真には影響しません。
Copy details|复制详情|複製詳細資訊|詳細をコピー
Clear group|清除此组|清除此群組|グループを消去
Retry all|全部重试|全部重試|すべて再試行
Show more|显示更多|顯示更多|さらに表示
Copy all paths|复制全部路径|複製全部路徑|すべてのパスをコピー
Show affected files|显示受影响的文件|顯示受影響的檔案|影響を受けるファイルを表示
Hide affected files|隐藏受影响的文件|隱藏受影響的檔案|影響を受けるファイルを隠す
Technical detail|技术详情|技術詳細資訊|技術的な詳細
Skip these|跳过这些|略過這些|これらをスキップ
Skip all and mark as done|全部跳过并标记为完成|全部略過並標記為完成|すべてスキップして完了にする
Skipping only changes the status. Nothing is deleted.|跳过只会改变状态，不会删除任何内容。|略過只會變更狀態，不會刪除任何內容。|スキップしても状態が変わるだけで、何も削除されません。
{count} issues skipped|已跳过 {count} 个问题|已略過 {count} 個問題|{count} 件の問題をスキップしました
1 issue skipped|已跳过 1 个问题|已略過 1 個問題|1 件の問題をスキップしました
Copying files|正在复制文件|正在複製檔案|ファイルをコピー中
Moving files|正在移动文件|正在移動檔案|ファイルを移動中
Stopping…|正在停止…|正在停止…|停止しています…
Pausing…|正在暂停…|正在暫停…|一時停止しています…
Verifying copied files|正在验证已复制文件|正在驗證已複製檔案|コピーしたファイルを検証中
Drive path|存储位置|儲存位置|保存場所

Drive details|详细信息|詳細資訊|詳細情報
Needs {needed} of {free} free|需要 {needed}，可用 {free}|需要 {needed}，可用 {free}|必要 {needed}／空き {free}
Needs {needed} of {free} free ({existing} already on the destination)|需要 {needed}，可用 {free}（{existing} 已在目标中）|需要 {needed}，可用 {free}（{existing} 已在目的地中）|必要 {needed}／空き {free}（{existing} は保存先にあります）

Capture information|拍摄信息|拍攝資訊|撮影情報
Capture date|拍摄日期|拍攝日期|撮影日
Capture time|拍摄时间|拍攝時間|撮影時刻
Time zone|时区|時區|タイムゾーン
Exposure settings|曝光设置|曝光設定|露出設定
Lens|镜头|鏡頭|レンズ
Aperture|光圈|光圈|絞り
ISO|ISO|ISO|ISO
Shutter speed|快门速度|快門速度|シャッタースピード
Focal length|焦距|焦距|焦点距離
Exposure compensation|曝光补偿|曝光補償|露出補正
Refresh list|刷新列表|重新整理清單|一覧を更新
Last completed|上次已完成|上次已完成|前回完了
Last verified: {completed} of {total} files|上次校验：{completed}/{total} 个文件|上次驗證：{completed}/{total} 個檔案|前回の検証：{total} 件中 {completed} 件

Photo Importer|照片导入器|照片匯入器|写真インポーター
Automatic Photo Importer|自动照片导入器|自動照片匯入器|自動写真インポーター
Opening your camera workbench…|正在打开相机工作台…|正在開啟相機工作台…|カメラワークベンチを開いています…
Import desk|导入工作台|匯入工作台|インポート
Organization|整理|整理|整理
History|历史记录|歷史記錄|履歴
Settings|设置|設定|設定
Import history|导入历史|匯入歷史|インポート履歴
Window controls|窗口控制|視窗控制|ウィンドウ操作
Minimize window|最小化窗口|最小化視窗|ウィンドウを最小化
Minimize|最小化|最小化|最小化
Maximize or restore window|最大化或还原窗口|最大化或還原視窗|ウィンドウを最大化・復元
Maximize or restore|最大化或还原|最大化或還原|最大化・復元
Close window|关闭窗口|關閉視窗|ウィンドウを閉じる
Close|关闭|關閉|閉じる
Main navigation|主导航|主導覽|メインナビゲーション
Connected sources|已连接的来源|已連接的來源|接続中のソース
Start imports|开始导入|開始匯入|インポート開始
Stop|停止|停止|停止
Automatic|自动|自動|自動
Refresh connected sources|刷新已连接的来源|重新整理已連接的來源|接続中のソースを更新
App language|应用语言|應用程式語言|アプリの言語
Text size|文字大小|文字大小|文字サイズ
Reset text size|重置文字大小|重設文字大小|文字サイズをリセット
Automatic import|自动导入|自動匯入|自動インポート
Parallel sources|并行来源|並行來源|同時処理ソース数
Appearance|外观|外觀|外観
Color mode|颜色模式|顏色模式|カラーモード
System|跟随系统|跟隨系統|システム
Light|浅色|淺色|ライト
Dark|深色|深色|ダーク
Accent|强调色|強調色|アクセント
Accent color|强调色|強調色|アクセントカラー
Coral accent|珊瑚色|珊瑚色|コーラル
Ocean accent|海洋蓝|海洋藍|オーシャン
Forest accent|森林绿|森林綠|フォレスト
Import dashboard|导入仪表板|匯入儀表板|インポートダッシュボード
Import overview|导入概览|匯入概覽|インポート概要
Overview|概览|概覽|概要
Show or hide the import overview|显示或隐藏导入概览|顯示或隱藏匯入概覽|インポート概要の表示/非表示
Transfers running|正在传输|正在傳輸|転送中
Review pending|等待审核|等待審核|確認待ち
Idle|空闲|閒置|待機中
Active / queued|活动 / 排队|進行中 / 排隊|実行中 / 待機中
Transfer speed|传输速度|傳輸速度|転送速度
Combined active sources|所有活动来源合计|所有進行中來源合計|実行中ソースの合計
No active transfers|没有正在进行的传输|沒有進行中的傳輸|転送は実行されていません
No transfer planned|尚无传输计划|尚無傳輸計畫|転送予定なし
Starting…|正在开始…|開始中…|開始しています…
Moving|移动|移動|移動
Files processed|已处理的文件|已處理的檔案|処理済みファイル
Files verified|已验证的文件|已驗證的檔案|検証済みファイル
Files moved|已移动的文件|已移動的檔案|移動済みファイル
Files copied|已复制的文件|已複製的檔案|コピー済みファイル
{complete} sources complete · {errors} need attention · {warnings} warnings|{complete} 个来源完成 · {errors} 个需处理 · {warnings} 个警告|{complete} 個來源完成 · {errors} 個需處理 · {warnings} 個警告|{complete} 件完了 · {errors} 件要確認 · 警告 {warnings} 件
The backup folder {folder} isn't scanned as a source|备份文件夹 {folder} 不会作为来源被扫描|備份資料夾 {folder} 不會作為來源被掃描|バックアップフォルダー {folder} はソースとしてスキャンされません
The backup folder isn't scanned as a source|备份文件夹不会作为来源被扫描|備份資料夾不會作為來源被掃描|バックアップフォルダーはソースとしてスキャンされません
{completed} of {total} files downloaded|已下载 {completed}/{total} 个文件|已下載 {completed}/{total} 個檔案|{total} 件中 {completed} 件ダウンロード済み
{completed} of {total} extra files set aside|已搁置 {completed}/{total} 个多余文件|已擱置 {completed}/{total} 個多餘檔案|余分なファイル {total} 件中 {completed} 件を退避済み
{completed} files looked at|已查看 {completed} 个文件|已查看 {completed} 個檔案|{completed} 件のファイルを確認済み
Setting aside duplicates: {completed} of {total}|正在搁置重复文件：{completed}/{total}|正在擱置重複檔案：{completed}/{total}|重複ファイルを退避中：{total} 件中 {completed} 件
Reading metadata: {completed} of {total} files|正在读取元数据：{completed}/{total} 个文件|正在讀取中繼資料：{completed}/{total} 個檔案|メタデータを読み込み中：{total} 件中 {completed} 件
Looking for files already in the backup: {completed} of {total}|正在查找备份中已有的文件：{completed}/{total}|正在尋找備份中已有的檔案：{completed}/{total}|バックアップにすでにあるファイルを検索中：{completed}/{total}
Confirming possible duplicates: {completed} of {total} files|正在确认可能的重复文件：{completed}/{total} 个文件|正在確認可能的重複檔案：{completed}/{total} 個檔案|重複の可能性があるファイルを確認中：{total} 件中 {completed} 件
Looking for identical files: {completed} of {total} files|正在查找相同的文件：{completed}/{total} 个文件|正在尋找相同的檔案：{completed}/{total} 個檔案|同一のファイルを検索中：{total} 件中 {completed} 件
Finishing up: {completed} of {total}|正在收尾：{completed}/{total}|正在收尾：{completed}/{total}|仕上げ中：{total} 件中 {completed} 件
{completed} of {total} files released|已释放 {completed}/{total} 个文件|已釋放 {completed}/{total} 個檔案|{total} 件中 {completed} 件を解放済み
{completed} of {total} files put back|已放回 {completed}/{total} 个文件|已放回 {completed}/{total} 個檔案|{total} 件中 {completed} 件を元に戻し済み
{completed} of {total} files deleted|已删除 {completed}/{total} 个文件|已刪除 {completed}/{total} 個檔案|{total} 件中 {completed} 件を削除済み
Leftover files progress|残留文件进度|殘留檔案進度|残りファイルの進行状況
Library folder not found|未找到资料库文件夹|找不到資料庫資料夾|ライブラリフォルダーが見つかりません
{completed} of {total}|{completed}/{total}|{completed}/{total}|{total} 件中 {completed} 件
{step} · {completed} of {total}|{step} · {completed}/{total}|{step} · {completed}/{total}|{step} · {total} 件中 {completed} 件
{count} complete copies whose card file changed are kept ({size}): each may be the only copy.|{count} 个完整副本的卡上文件已更改，已保留（{size}）：每个都可能是唯一的副本。|{count} 個完整副本的卡上檔案已變更，已保留（{size}）：每個都可能是唯一的副本。|カード上のファイルが変更された完全なコピー {count} 件を保持しています（{size}）。それぞれが唯一のコピーかもしれません。
Backup folder check progress|备份文件夹检查进度|備份資料夾檢查進度|バックアップフォルダー確認の進行状況
Checking {drive} folder layout|正在检查 {drive} 的文件夹结构|正在檢查 {drive} 的資料夾結構|{drive} のフォルダー構成を確認中
Organization history progress|整理记录读取进度|整理記錄讀取進度|整理履歴の読み込み状況
Files checked|已检查的文件|已檢查的檔案|確認済みファイル
Destinations ready|已就绪的目标|已就緒的目的地|準備済みの保存先
Choose a backup destination|选择备份目标|選擇備份目的地|バックアップ先を選択
Combined copy progress|总体复制进度|整體複製進度|全体のコピー進捗
Choose destination|选择目标|選擇目的地|保存先を選択
Sources & queue|来源与队列|來源與佇列|ソースとキュー
Current copies finish before a lower limit takes effect.|当前复制完成后，降低的上限才会生效。|目前複製完成後，降低的上限才會生效。|上限の引き下げは実行中のコピー完了後に反映されます。
Maximum parallel sources|最大并行来源数|最大並行來源數|同時処理ソース数の上限
Connect camera storage or a memory card.|连接相机存储或存储卡。|連接相機儲存裝置或記憶卡。|カメラのストレージやメモリーカードを接続。
Automatic import is watching for new connections.|自动导入正在监测新连接。|自動匯入正在監測新連接。|自動インポートで新しい接続を監視しています。
Automatic import is off. Use Start when you’re ready.|自动导入已关闭，准备好后点击「开始」。|自動匯入已關閉，準備好後點選「開始」。|自動インポートはオフです。準備ができたら開始してください。
Enable media folder selection|启用媒体文件夹选择|啟用媒體資料夾選擇|メディアフォルダーの選択を有効化
Choose media folders…|选择媒体文件夹…|選擇媒體資料夾…|メディアフォルダーを選択…
Bring an entire drive, too.|也能备份整个磁盘。|也能備份整個磁碟。|ドライブ全体もバックアップ。
Back up drives or folders…|备份磁盘或文件夹…|備份磁碟或資料夾…|ドライブやフォルダーをバックアップ…
Ready to import|准备导入|準備匯入|インポート可能
Discovering files|正在查找文件|正在尋找檔案|ファイルを検索中
Checking existing files|正在检查现有文件|正在檢查現有檔案|既存ファイルを確認中
Complete|完成|完成|完了
Stopped|已停止|已停止|停止済み
Needs attention|需要处理|需要處理|確認が必要
Queued|已排队|已排隊|待機中
Folder backup|文件夹备份|資料夾備份|フォルダーバックアップ
Same drive|同一驱动器|同一個磁碟|同じドライブ
Same drive as {name}|与 {name} 同一驱动器|與 {name} 同一個磁碟|{name} と同じドライブ
Same drive as {name}. Its capacity is shown there.|与 {name} 同一驱动器，容量显示在该处。|與 {name} 同一個磁碟，容量顯示在該處。|{name} と同じドライブです。容量はそちらに表示されます。
This folder is on the same drive as your backup. Importing copies the files, which uses space on this drive.|此文件夹与备份位于同一驱动器。导入会复制文件，这会占用该驱动器的空间。|此資料夾與備份位於同一個磁碟。匯入會複製檔案，這會佔用該磁碟的空間。|このフォルダーはバックアップと同じドライブにあります。読み込むとファイルがコピーされ、このドライブの容量を使います。
Organize instead (move, no extra space)|改为整理（移动文件，不占用额外空间）|改為整理（移動檔案，不佔用額外空間）|代わりに整理する（移動のみ、追加容量なし）
Needs {needed} of {free} free on this same drive|需要 {needed}，此驱动器可用 {free}|需要 {needed}，此磁碟可用 {free}|必要 {needed}／このドライブの空き {free}
Connected USB camera|已连接的 USB 相机|已連接的 USB 相機|接続中のUSBカメラ
Review files before copying|复制前审核文件|複製前審核檔案|コピー前にファイルを確認
Review|审核|審核|確認
Stop source|停止此来源|停止此來源|このソースを停止
Recheck|重新检查|重新檢查|再確認
Import|导入|匯入|インポート
Verified|已校验|已驗證|検証済み
Capacity unavailable over USB|USB 连接不提供容量信息|USB 連接不提供容量資訊|USB経由では容量を取得できません
Capacity unavailable|容量信息不可用|容量資訊無法取得|容量を取得できません
Storage used|已用空间|已用空間|使用済み容量
Drive activity|硬盘使用率|硬碟使用率|ドライブの使用率
Estimated share of time the drive spent reading or writing, not its capacity|硬盘用于读写的估算时间占比，不是容量|硬碟用於讀寫的估算時間占比，不是容量|ドライブが読み書きに使った時間の推定割合です（容量ではありません）
Read|读取|讀取|読み込み
Write|写入|寫入|書き込み
Activity ≈{percent}|使用率 ≈{percent}|使用率 ≈{percent}|使用率 ≈{percent}
Whole disk, all apps; may include metadata and receipts|整个硬盘，包含所有应用；可能含元数据和回执|整個硬碟，包含所有應用程式；可能含中繼資料和回條|ディスク全体・すべてのアプリの合計です。メタデータやレシートを含む場合があります
Read {read} · Write {write}|读取 {read} · 写入 {write}|讀取 {read} · 寫入 {write}|読み込み {read} · 書き込み {write}
Destinations|目标|目的地|保存先
Copy policy|复制策略|複製策略|コピー方式
One destination|单一目标|單一目的地|1つの保存先
Copy to both destinations|复制到两个目标|複製到兩個目的地|両方の保存先にコピー
Fill first, then second|先存满第一块再用第二块|先存滿第一顆再用第二顆|1台目から順に保存
First destination|第一目标|第一目的地|1つ目の保存先
Second destination|第二目标|第二目的地|2つ目の保存先
Not selected|未选择|未選擇|未選択
Offline|离线|離線|オフライン
Selected|已选择|已選擇|選択済み
Choose a backup drive|选择备份磁盘|選擇備份磁碟|バックアップドライブを選択
A drive or folder for your verified copies.|用于存放校验副本的磁盘或文件夹。|用於存放驗證副本的磁碟或資料夾。|検証済みコピーを保存するドライブやフォルダー。
Drive offline|磁盘离线|磁碟離線|ドライブがオフライン
Reading drive capacity…|正在读取磁盘容量…|正在讀取磁碟容量…|ドライブ容量を取得中…
Reconnect this drive before importing.|请在导入前重新连接此磁盘。|請在匯入前重新連接此磁碟。|インポート前にこのドライブを再接続してください。
Destination available|目标可用|目的地可用|保存先は利用可能
Checking destination…|正在检查目标…|正在檢查目的地…|保存先を確認中…
Checking destinations…|正在检查目标…|正在檢查目的地…|保存先を確認中…
Change…|更改…|變更…|変更…
Choose location…|选择位置…|選擇位置…|場所を選択…
Show in file manager|在文件管理器中显示|在檔案管理員中顯示|ファイルマネージャーで表示
Remove destination|移除目标|移除目的地|保存先を削除
{used} used, {free} free, {total} total|已用 {used}，可用 {free}，总计 {total}|已用 {used}，可用 {free}，總計 {total}|使用済み {used}、空き {free}、合計 {total}
Other or unscanned|其他或未扫描|其他或未掃描|その他・未スキャン
Used|已用|已用|使用済み
Media categories use scanned file sizes.|媒体分类按扫描文件大小估算。|媒體分類依掃描檔案大小估算。|メディア分類はスキャンしたファイルサイズに基づきます。
Source layout|来源布局|來源配置|ソースのレイアウト
List view|列表视图|清單檢視|リスト表示
Grid view|网格视图|網格檢視|グリッド表示
Folder organization|文件夹整理|資料夾整理|フォルダー整理
Folder backup inventory|文件夹备份清单|資料夾備份清單|フォルダーバックアップ一覧
Source inventory|来源文件清单|來源檔案清單|ソースのファイル一覧
Filter inventory files|筛选清单文件|篩選清單檔案|一覧を絞り込む
All files|所有文件|所有檔案|すべてのファイル
Included files|包含的文件|包含的檔案|対象ファイル
Search inventory files|搜索清单文件|搜尋清單檔案|一覧内を検索
Find a file…|查找文件…|尋找檔案…|ファイルを検索…
File|文件|檔案|ファイル
Type|类型|類型|種類
Size|大小|大小|サイズ
Included|已包含|已包含|対象
Ignored|已忽略|已忽略|対象外
Other|其他|其他|その他
Images|图像|影像|画像
No files match this filter.|没有符合此筛选条件的文件。|沒有符合此篩選條件的檔案。|条件に一致するファイルはありません。
Other file rules|其他文件规则|其他檔案規則|その他のファイルルール
Extension|扩展名|副檔名|拡張子
No extension|无扩展名|無副檔名|拡張子なし
Action|操作|操作|操作
Ignore|忽略|忽略|無視
Copy to folder|复制到文件夹|複製到資料夾|フォルダーにコピー
Folder beneath each destination|每个目标下的文件夹|每個目的地下的資料夾|各保存先内のフォルダー
Use a relative folder without empty components, . or ..|请输入相对文件夹路径，不能包含空段、. 或 ..|請輸入相對資料夾路徑，不能包含空段、. 或 ..|空の要素、.、.. を含まない相対フォルダーを指定してください。
Remember for this extension|记住此扩展名的规则|記住此副檔名的規則|この拡張子のルールを保存
Apply rule|应用规则|套用規則|ルールを適用
Backup location|备份位置|備份位置|バックアップ先
Backup folder|备份文件夹|備份資料夾|バックアップフォルダー
Folder structure|文件夹结构|資料夾結構|フォルダー構造
Date, then camera|先日期后相机|先日期後相機|日付 → カメラ
Camera, then date|先相机后日期|先相機後日期|カメラ → 日付
Organize first by|首先按以下分类|首先依以下分類|最初の分類
Year folder|年份文件夹|年份資料夾|年のフォルダー
Month folder|月份文件夹|月份資料夾|月のフォルダー
Day folder|日期文件夹|日期資料夾|日のフォルダー
Include the year in the name|名称中包含年份|名稱中包含年份|名前に年を含める
Include the year and month in the name|名称中包含年份和月份|名稱中包含年份和月份|名前に年と月を含める
Month names|月份名称|月份名稱|月の表記
Numbers|数字|數字|数字
English|英文|英文|英語
Photo folders|照片文件夹|照片資料夾|写真のフォルダー
Video folders|视频文件夹|影片資料夾|動画のフォルダー
Then sort by file type|然后按文件类型分类|然後依檔案類型分類|次にファイルの種類で分類
Use the photo folder path for videos|视频使用与照片相同的文件夹路径|影片使用與照片相同的資料夾路徑|動画にも写真と同じフォルダー構成を使う
Advanced: custom template|高级：自定义模板|進階：自訂範本|詳細：カスタムテンプレート
Photo folder template|照片文件夹模板|照片資料夾範本|写真のフォルダーテンプレート
This folder path is a custom template. Edit it under Advanced, or start again with the folder builder.|此文件夹路径是自定义模板。可在“高级”中编辑，或使用文件夹构建器重新设置。|此資料夾路徑是自訂範本。可在「進階」中編輯，或使用資料夾建構器重新設定。|このフォルダー構成はカスタムテンプレートです。「詳細」で編集するか、フォルダービルダーで設定し直してください。
Use the folder builder|使用文件夹构建器|使用資料夾建構器|フォルダービルダーを使う
Folder template|文件夹模板|資料夾範本|フォルダーテンプレート
Collect problem files|收集问题文件|收集問題檔案|問題のあるファイルを集める
Move 0-byte files and their companions into Problem files. Undo puts them back.|将 0 字节文件及其伴随文件移入“Problem files”。撤销会把它们放回原处。|將 0 位元組檔案及其隨附檔案移入「Problem files」。還原會把它們放回原處。|0 バイトのファイルとその関連ファイルを「Problem files」に移動します。取り消すと元に戻ります。
{count} problem files will be collected into Problem files/…|{count} 个问题文件将被收集到 Problem files/…|{count} 個問題檔案將被收集到 Problem files/…|問題のあるファイル {count} 件を Problem files/… に集めます
{count} problem files will stay where they are|{count} 个问题文件将保留在原处|{count} 個問題檔案將保留在原處|問題のあるファイル {count} 件はそのまま残ります
{count} problem files are skipped and not copied|已跳过 {count} 个问题文件，不会复制|已略過 {count} 個問題檔案，不會複製|問題のあるファイル {count} 件はスキップされ、コピーされません
Empty files|空文件|空檔案|空のファイル
Unreadable files|无法读取的文件|無法讀取的檔案|読み取れないファイル
Could not be read|无法读取|無法讀取|読み取れませんでした
and {count} more|还有 {count} 个|還有 {count} 個|ほか {count} 件
Edited exports folder|编辑导出文件夹|編輯匯出資料夾|編集済み書き出しフォルダー
Your edited export lands here|编辑导出的照片将保存在这里|編輯匯出的照片將儲存在這裡|編集済み写真の保存先
Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}|可用标记：{year}、{yyyymm}、{month}、{monthName}、{yearMonthName}、{day}、{yyyyMMdd}、{camera}|可用標記：{year}、{yyyymm}、{month}、{monthName}、{yearMonthName}、{day}、{yyyyMMdd}、{camera}|使用可能なトークン：{year}、{yyyymm}、{month}、{monthName}、{yearMonthName}、{day}、{yyyyMMdd}、{camera}
Media layout|媒体文件布局|媒體檔案配置|メディアの配置
Photos and videos, then file formats|先分照片和视频，再按文件格式|先分照片和影片，再依檔案格式|写真と動画に分け、さらにファイル形式別に
Photos/NEF, Photos/JPEG, Videos/MOV inside the camera folder.|相机文件夹内的 Photos/NEF、Photos/JPEG、Videos/MOV。|相機資料夾內的 Photos/NEF、Photos/JPEG、Videos/MOV。|カメラフォルダー内の Photos/NEF、Photos/JPEG、Videos/MOV。
A folder for each file format|每种文件格式一个文件夹|每種檔案格式一個資料夾|ファイル形式ごとのフォルダー
NEF, JPEG, MOV folders inside the camera folder.|相机文件夹内的 NEF、JPEG、MOV 文件夹。|相機資料夾內的 NEF、JPEG、MOV 資料夾。|カメラフォルダー内の NEF、JPEG、MOV フォルダー。
Photos together, videos in a folder|照片放在一起，视频单独放一个文件夹|照片放在一起，影片另放一個資料夾|写真はまとめて、動画は専用フォルダーへ
Photos in the camera folder, videos in its Videos folder.|照片直接放在相机文件夹，视频放在其中的 Videos 文件夹。|照片直接放在相機資料夾，影片放在其中的 Videos 資料夾。|写真はカメラフォルダーに、動画はその中の Videos フォルダーに保存します。
Videos together, photos in a folder|视频放在一起，照片单独放一个文件夹|影片放在一起，照片另放一個資料夾|動画はまとめて、写真は専用フォルダーへ
Videos in the camera folder, photos in its Photos folder.|视频直接放在相机文件夹，照片放在其中的 Photos 文件夹。|影片直接放在相機資料夾，照片放在其中的 Photos 資料夾。|動画はカメラフォルダーに、写真はその中の Photos フォルダーに保存します。
Everything in the camera folder|全部放在相机文件夹|全部放在相機資料夾|すべてカメラフォルダーに
Photos and videos side by side.|照片和视频放在一起。|照片和影片放在一起。|写真と動画を同じ場所に保存します。
A separate video backup folder|单独的视频备份文件夹|獨立的影片備份資料夾|動画用の別のバックアップフォルダー
Videos go to their own backup folder beside the photo backup folder.|视频保存到照片备份文件夹旁边的独立备份文件夹。|影片儲存到照片備份資料夾旁的獨立備份資料夾。|動画は写真のバックアップフォルダーの隣にある専用フォルダーに保存します。
Video backup folder|视频备份文件夹|影片備份資料夾|動画のバックアップフォルダー
Created beside the photo backup folder on each destination.|在每个目标位置的照片备份文件夹旁创建。|在每個目的地的照片備份資料夾旁建立。|各保存先で写真のバックアップフォルダーの隣に作成します。
Video folder template|视频文件夹模板|影片資料夾範本|動画のフォルダーテンプレート
Organization review progress|整理预览进度|整理預覽進度|整理の確認の進行状況
Review progress|预览进度|預覽進度|確認の進行状況
Checking the backup folder|正在检查备份文件夹|正在檢查備份資料夾|バックアップフォルダーを確認中
Your next video lands here|下一个视频将保存在这里|下一部影片將儲存在這裡|次の動画の保存先
Your next photo lands here|下一张照片将保存在这里|下一張照片將儲存在這裡|次の写真の保存先
Edit|编辑|編輯|編集
File extension|文件扩展名|檔案副檔名|ファイル拡張子
For example, PDF|例如 PDF|例如 PDF|例：PDF
Leave empty for files without an extension.|无扩展名的文件请留空。|無副檔名的檔案請留空。|拡張子のないファイルは空欄にします。
Copy to custom folder|复制到自定义文件夹|複製到自訂資料夾|指定フォルダーにコピー
Relative folder|相对文件夹|相對資料夾|相対フォルダー
Save rule|保存规则|儲存規則|ルールを保存
Your collection starts here.|照片库从这里开始。|照片庫從這裡開始。|コレクションはここから。
Go to import desk|前往导入工作台|前往匯入工作台|インポート画面へ
Stopped by user|用户已停止|使用者已停止|ユーザーが停止
Session recorded|已记录会话|已記錄工作階段|セッション記録済み
Reading photo metadata…|正在读取照片元数据…|正在讀取照片中繼資料…|写真のメタデータを読み込み中…
Could not read this file|无法读取此文件|無法讀取此檔案|ファイルを読み込めませんでした
Show this file in file manager|在文件管理器中显示此文件|在檔案管理員中顯示此檔案|このファイルをファイルマネージャーで表示
Camera|相机|相機|カメラ
Captured|拍摄时间|拍攝時間|撮影日時
Shutter count|快门次数|快門次數|シャッター回数
Not recorded|未记录|未記錄|記録なし
Not available|不可用|無法取得|取得不可
All metadata|所有元数据|所有中繼資料|すべてのメタデータ
Find a metadata field…|查找元数据字段…|尋找中繼資料欄位…|メタデータの項目を検索…
Search metadata fields|搜索元数据字段|搜尋中繼資料欄位|メタデータ項目を検索
No metadata fields match your search.|没有匹配的元数据字段。|沒有符合的中繼資料欄位。|検索に一致する項目はありません。
No metadata fields were returned for this file.|此文件没有返回元数据字段。|此檔案未傳回中繼資料欄位。|このファイルにはメタデータ項目がありません。
Done|完成|完成|完了
Building review…|正在生成审核…|正在產生審核…|確認を準備中…
Building your file review…|正在生成文件审核…|正在產生檔案審核…|ファイル確認を準備中…
Cancel review|取消审核|取消審核|確認をキャンセル
Review before reorganizing|整理前审核|整理前審核|整理前に確認
Review before copying|复制前审核|複製前審核|コピー前に確認
Ready to review|准备审核|準備審核|確認可能
Find a source, destination or checksum…|查找来源、目标或校验和…|尋找來源、目的地或校驗碼…|ソース・保存先・チェックサムを検索…
Search reviewed files|搜索审核文件|搜尋審核檔案|確認対象ファイルを検索
Source|来源|來源|ソース
Destination|目标|目的地|保存先
Type / size|类型 / 大小|類型 / 大小|種類 / サイズ
Checksum|校验和|校驗碼|チェックサム
Keep verified|保留已校验文件|保留已驗證檔案|検証済みを保持
Copy|复制|複製|コピー
No files need to be processed.|没有需要处理的文件。|沒有需要處理的檔案。|処理が必要なファイルはありません。
No files match this search.|没有匹配的文件。|沒有符合的檔案。|検索に一致するファイルはありません。
Previous|上一页|上一頁|前へ
Next|下一页|下一頁|次へ
Discard review|放弃审核|捨棄審核|確認を破棄
Copy reviewed files|复制已审核的文件|複製已審核的檔案|確認したファイルをコピー
Scan media|扫描媒体|掃描媒體|メディアをスキャン
Resume & recheck|继续并重新检查|繼續並重新檢查|再開して再確認
Videos|视频|影片|動画
{count} files|{count} 个文件|{count} 個檔案|{count} ファイル
{count} fields|{count} 个字段|{count} 個欄位|{count} 項目
{count} sessions|{count} 次会话|{count} 次工作階段|{count} セッション
{count} connected|{count} 个已连接|{count} 個已連接|{count} 件接続中
{count} included files|{count} 个包含的文件|{count} 個包含的檔案|{count} 件の対象ファイル
{count} photos & videos|{count} 张照片和视频|{count} 張照片與影片|写真・動画 {count} 件
{count} companions|{count} 个伴随文件|{count} 個伴隨檔案|関連ファイル {count} 件
{count} other files|{count} 个其他文件|{count} 個其他檔案|その他 {count} 件
{count} of 10|{count} / 10|{count} / 10|{count} / 10
Drive backups|驱动器备份|磁碟備份|ドライブのバックアップ
Drive backup mode|驱动器备份模式|磁碟備份模式|ドライブのバックアップモード
Additive|只增不删|只增不刪|追加のみ
Mirror|镜像|鏡像|ミラー
Drive backups are saved here on each destination|驱动器备份保存在每个目标的此位置|磁碟備份儲存在每個目的地的此位置|ドライブのバックアップは各保存先のここに保存されます
{count} files will be moved to Removed by mirror|{count} 个文件将移到 Removed by mirror|{count} 個檔案將移到 Removed by mirror|{count} 件のファイルが Removed by mirror へ移動されます
Drive folder: {folder}|驱动器文件夹：{folder}|磁碟資料夾：{folder}|ドライブフォルダー：{folder}
Reason|原因|原因|理由
No longer on the drive|驱动器上已不存在|磁碟上已不存在|ドライブにもう存在しません
Replaced by a newer version|已被较新版本取代|已被較新版本取代|新しいバージョンに置き換えられました
Unknown files|未知文件|未知檔案|不明なファイル
Skip automatically|自动跳过|自動略過|自動的にスキップ
Copy to Other files folder|复制到“其他文件”文件夹|複製到「其他檔案」資料夾|「その他のファイル」フォルダーにコピー
Ask me|询问我|詢問我|確認する
Skipped {count} camera system files ({names})|已跳过 {count} 个相机系统文件（{names}）|已略過 {count} 個相機系統檔案（{names}）|カメラのシステムファイル {count} 件をスキップ（{names}）
{count} unknown files skipped|已跳过 {count} 个未知文件|已略過 {count} 個未知檔案|不明なファイル {count} 件をスキップ
{count} unknown files copied to other folders|{count} 个未知文件复制到其他文件夹|{count} 個未知檔案複製到其他資料夾|不明なファイル {count} 件を別フォルダーにコピー
Camera system files|相机系统文件|相機系統檔案|カメラのシステムファイル
Lenses from EXIF metadata|EXIF 元数据中的镜头|EXIF 中繼資料中的鏡頭|EXIF メタデータのレンズ
No lenses identified yet.|尚未识别出镜头。|尚未識別出鏡頭。|まだレンズは特定されていません。
No lens information in checked files.|已检查的文件中没有镜头信息。|已檢查的檔案中沒有鏡頭資訊。|確認したファイルにレンズ情報はありません。
Computed during copy|复制时计算|複製時計算|コピー時に計算
Listing files…|正在列出文件…|正在列出檔案…|ファイルを一覧表示中…
{count} files found · {size}|已找到 {count} 个文件 · {size}|已找到 {count} 個檔案 · {size}|{count} 件のファイルを検出 · {size}
Choose drives to import|选择要导入的驱动器|選擇要匯入的磁碟|読み込むドライブを選択
New drive connected|已连接新驱动器|已連接新磁碟|新しいドライブが接続されました
New drives connected|已连接多个新驱动器|已連接多個新磁碟|新しいドライブが接続されました
Import from this drive|从此驱动器导入|從此磁碟匯入|このドライブから読み込む
Don't import|不导入|不匯入|読み込まない
Not selected · won't be imported|未选中 · 不会导入|未選取 · 不會匯入|未選択 · 読み込みません
Import this drive|导入此驱动器|匯入此磁碟|このドライブを読み込む
Start imports ({count})|开始导入（{count}）|開始匯入（{count}）|インポート開始（{count}）
Remembered drives|已记住的驱动器|已記住的磁碟|記憶したドライブ
Last selected {date}|上次选中：{date}|上次選取：{date}|最終選択：{date}
Forget|忘记|忘記|削除
Forget {name}|忘记 {name}|忘記 {name}|{name} を削除
File metadata|文件元数据|檔案中繼資料|ファイルのメタデータ
Close metadata|关闭元数据|關閉中繼資料|メタデータを閉じる
Show metadata for {name}|显示 {name} 的元数据|顯示 {name} 的中繼資料|{name} のメタデータを表示
Total progress|总进度|總進度|全体の進捗
Sources|来源|來源|ソース
General|通用|一般|一般
No sources connected|未连接来源|未連接來源|接続されたソースはありません
Drives|驱动器|磁碟|ドライブ
Connected drives|已连接的驱动器|已連接的磁碟|接続中のドライブ
Ignored drives|已忽略的驱动器|已忽略的磁碟|無視するドライブ
Ignored {date}|忽略于 {date}|忽略於 {date}|{date} に無視
No ignored drives.|没有已忽略的驱动器。|沒有已忽略的磁碟。|無視しているドライブはありません。
Stop ignoring|取消忽略|取消忽略|無視をやめる
Stop ignoring {name}|取消忽略 {name}|取消忽略 {name}|{name} の無視をやめる
Import from {name}?|要从 {name} 导入吗？|要從 {name} 匯入嗎？|{name} から読み込みますか？
Select|选择|選取|選択
Don't import this drive|不导入此驱动器|不匯入此磁碟|このドライブを読み込まない
Pause|暂停|暫停|一時停止
Resume|继续|繼續|再開
Pause {name}|暂停 {name}|暫停 {name}|{name} を一時停止
Paused|已暂停|已暫停|一時停止中
Continue|继续|繼續|再開
Undo organization|撤销整理|復原整理|整理を元に戻す
Delete recovery files|删除恢复文件|刪除復原檔案|復元用ファイルを削除
Finish or undo this organization before deleting its recovery files.|请先完成或撤销此整理，然后再删除其恢复文件。|請先完成或復原此整理，然後再刪除其復原檔案。|復元用ファイルを削除する前に、この整理を完了するか元に戻してください。
Delete recovery files for this organization?|要删除此整理的恢复文件吗？|要刪除此整理的復原檔案嗎？|この整理の復元用ファイルを削除しますか？
You will no longer be able to undo it.|之后将无法再撤销此整理。|之後將無法再復原此整理。|この整理は元に戻せなくなります。
{size} will be freed.|将释放 {size}。|將釋放 {size}。|{size} が解放されます。
Measuring recovery files…|正在计算恢复文件大小…|正在計算復原檔案大小…|復元用ファイルのサイズを計算中…
Delete recovery files permanently?|要永久删除恢复文件吗？|要永久刪除復原檔案嗎？|復元用ファイルを完全に削除しますか？
This permanently deletes {count} files ({size}) of recovery data. This cannot be undone.|这将永久删除 {count} 个恢复数据文件（{size}）。此操作无法撤销。|這將永久刪除 {count} 個復原資料檔案（{size}）。此操作無法復原。|復元用データ {count} ファイル（{size}）を完全に削除します。この操作は取り消せません。
Continue…|继续…|繼續…|続ける…
Delete permanently|永久删除|永久刪除|完全に削除
Replaced by a later organization|已被之后的整理取代|已被之後的整理取代|後の整理に置き換え済み
Undone|已撤销|已復原|元に戻し済み
Release {size}|释放 {size}|釋放 {size}|{size} を解放
Release {size}?|要释放 {size} 吗？|要釋放 {size} 嗎？|{size} を解放しますか？
Cancel|取消|取消|キャンセル
Verify each copy after copying|复制后校验每个副本|複製後驗證每個副本|コピー後に各コピーを検証
Verification after copy is off|复制后校验已关闭|複製後驗證已關閉|コピー後の検証はオフです
{completed} of {total} files copied|已复制 {completed}/{total} 个文件|已複製 {completed}/{total} 個檔案|{total} 件中 {completed} 件をコピー済み
{count} failed|{count} 个失败|{count} 個失敗|{count} 件失敗
Import steps|导入步骤|匯入步驟|読み込みの手順
Scanning|扫描|掃描|スキャン
Copying|复制|複製|コピー
Verifying|校验|驗證|検証
Reading|读取|讀取|読み込み
Comparing|比较|比較|比較
Tidying|整理|整理|整頓
Deleting|删除|刪除|削除
Checking folder|检查文件夹|檢查資料夾|フォルダを確認
{stage}, {percent}%|{stage}，{percent}%|{stage}，{percent}%|{stage}、{percent}%
Already imported|已导入|已匯入|読み込み済み
All {count} files are in the backup and verified|全部 {count} 个文件已在备份中并通过校验|全部 {count} 個檔案已在備份中並通過驗證|{count} 件すべてがバックアップ済みで検証済みです
All files are in the backup and verified|所有文件已在备份中并通过校验|所有檔案已在備份中並通過驗證|すべてのファイルがバックアップ済みで検証済みです
A destination is offline. Reconnect it to import.|有目标离线，请重新连接后再导入。|有目的地離線，請重新連接後再匯入。|保存先がオフラインです。再接続してから読み込んでください。
A verified copy on both drives.|在两个驱动器上各保存一份校验副本。|在兩個磁碟上各保存一份驗證副本。|両方のドライブに検証済みコピーを保存します。
Apply or discard the review.|请应用或放弃此审核。|請套用或放棄此審核。|確認内容を適用するか破棄してください。
Backup matches the drive. Removed files are moved aside, not deleted.|备份与驱动器保持一致。已删除的文件会被移开，不会被删除。|備份與磁碟保持一致。已刪除的檔案會被移開，不會被刪除。|バックアップをドライブと一致させます。削除されたファイルは移動され、消去されません。
Camera folders (DCIM) found.|找到相机文件夹（DCIM）。|找到相機資料夾（DCIM）。|カメラフォルダー（DCIM）があります。
Change this any time in Drives.|可随时在“驱动器”中更改。|可隨時在「磁碟」中變更。|「ドライブ」でいつでも変更できます。
Checking files. Nothing is copied yet.|正在检查文件，尚未复制任何内容。|正在檢查檔案，尚未複製任何內容。|ファイルを確認中です。まだ何もコピーしていません。
Connect a memory card or camera to start.|连接存储卡或相机即可开始。|連接記憶卡或相機即可開始。|メモリーカードかカメラを接続して開始します。
Copied to an Other files folder.|复制到“其他文件”文件夹。|複製到「其他檔案」資料夾。|「その他のファイル」フォルダーにコピーします。
Copy every file, keeping its folders.|复制所有文件并保留其文件夹结构。|複製所有檔案並保留其資料夾結構。|フォルダー構成を保ったまま全ファイルをコピーします。
Copying starts when you apply.|应用后才开始复制。|套用後才開始複製。|適用するとコピーを開始します。
Deleted files stay in the backup.|已删除的文件会保留在备份中。|已刪除的檔案會保留在備份中。|削除したファイルもバックアップに残ります。
Edited exports go here, inside each month folder.|编辑导出的照片放在这里，位于每个月份文件夹中。|編輯匯出的照片放在這裡，位於每個月份資料夾中。|編集済みの書き出しは各月フォルダー内のここに入ります。
Fill the first drive, then use the second.|先存满第一个驱动器，再使用第二个。|先存滿第一個磁碟，再使用第二個。|1台目がいっぱいになったら2台目を使います。
Finished imports appear here.|完成的导入会显示在这里。|完成的匯入會顯示在這裡。|完了した読み込みがここに表示されます。
Index files the camera writes. Not needed.|相机写入的索引文件，不需要导入。|相機寫入的索引檔案，不需要匯入。|カメラが書き込むインデックスファイルです。不要です。
Leave empty to use the drive itself.|留空则直接使用驱动器本身。|留空則直接使用磁碟本身。|空欄にするとドライブ直下を使います。
Mirror doesn't work with “Fill first, then second”.|镜像不能与“先存满第一块再用第二块”同时使用。|鏡像不能與「先存滿第一顆再用第二顆」同時使用。|ミラーは「1台目から順に保存」と併用できません。
Mirror is on: removed files are moved aside after review.|镜像已开启：已删除的文件会在审核后被移开。|鏡像已開啟：已刪除的檔案會在審核後被移開。|ミラーがオン：削除されたファイルは確認後に移動されます。
Move existing files into your folder structure.|将现有文件移入你的文件夹结构。|將現有檔案移入你的資料夾結構。|既存のファイルをフォルダー構成に合わせて移動します。
No camera folders (DCIM) found.|未找到相机文件夹（DCIM）。|未找到相機資料夾（DCIM）。|カメラフォルダー（DCIM）がありません。
{count} organized files are no longer where this organization put them.|{count} 个已整理的文件已不在此次整理放置的位置。|{count} 個已整理的檔案已不在此次整理放置的位置。|整理したファイルのうち {count} 件は、この整理で置いた場所にありません。
Full recheck|完整重新检查|完整重新檢查|すべて再確認
Reads every organized file again, not only those changed since the last recheck.|重新读取每个已整理的文件，而不只是自上次重新检查以来有变化的文件。|重新讀取每個已整理的檔案，而不只是自上次重新檢查以來有變化的檔案。|前回の再確認以降に変わったファイルだけでなく、整理したすべてのファイルを読み直します。
Reading organization history…|正在读取整理记录…|正在讀取整理記錄…|整理の履歴を読み込み中…
Reading organization history is paused while a job uses the drive. It continues afterwards.|有任务正在使用该磁盘，整理记录的读取已暂停，任务结束后会继续。|有工作正在使用該磁碟，整理記錄的讀取已暫停，工作結束後會繼續。|ジョブがドライブを使用中のため、整理履歴の読み込みを一時停止しています。終了後に再開します。
No organization history.|没有整理记录。|沒有整理記錄。|整理の履歴はありません。
No remembered drives.|没有已记住的驱动器。|沒有已記住的磁碟。|記憶したドライブはありません。
Camera details for {name}|{name} 的相机详情|{name} 的相機詳細資訊|{name} のカメラの詳細
{count} files without a camera model|{count} 个文件没有相机型号|{count} 個檔案沒有相機型號|カメラ機種のないファイル {count} 件
No camera data from a scan yet. Scan this drive to see its cameras.|还没有扫描得到的相机数据。扫描此驱动器即可查看其相机。|尚無掃描得到的相機資料。掃描此磁碟即可查看其相機。|スキャンによるカメラ情報はまだありません。このドライブをスキャンするとカメラを確認できます。
No saved rules.|没有已保存的规则。|沒有已儲存的規則。|保存されたルールはありません。
Not available with Mirror.|镜像模式下不可用。|鏡像模式下不可用。|ミラーでは使用できません。
Not photos or videos. Change this in Settings.|不是照片或视频。可在设置中更改。|不是照片或影片。可在設定中變更。|写真でも動画でもありません。設定で変更できます。
Nothing is deleted; files go to Removed by mirror.|不会删除任何文件；文件会移到 Removed by mirror。|不會刪除任何檔案；檔案會移到 Removed by mirror。|何も削除されません。ファイルは Removed by mirror に移動します。
Nothing moves until you apply.|应用之前不会移动任何文件。|套用之前不會移動任何檔案。|適用するまで何も移動しません。
One verified copy.|一份校验过的副本。|一份驗證過的副本。|検証済みコピーを1つ保存します。
Reads each copy back to confirm it. Off is faster.|重新读取每个副本以确认无误。关闭会更快。|重新讀取每個副本以確認無誤。關閉會更快。|各コピーを読み直して確認します。オフにすると速くなります。
Remove macOS ._ files|移除 macOS 的 ._ 文件|移除 macOS 的 ._ 檔案|macOS の ._ ファイルを削除
Deletes the hidden ._ files macOS leaves beside copied and organized files on exFAT and FAT drives, only when they hold no tags or other data.|删除 macOS 在 exFAT 和 FAT 驱动器上于已复制和已整理文件旁留下的隐藏 ._ 文件，仅限不含标签或其他数据的文件。|刪除 macOS 在 exFAT 和 FAT 磁碟機上於已複製和已整理檔案旁留下的隱藏 ._ 檔案，僅限不含標籤或其他資料的檔案。|exFAT や FAT のドライブでコピー・整理したファイルの横に macOS が作る隠しファイル ._ を削除します。タグなどのデータがないものだけが対象です。
Skip files with errors and continue|跳过出错的文件并继续|略過出錯的檔案並繼續|エラーのファイルをスキップして続行
A file that can't be read or changes while it is checked is listed in All errors and left out; the other files are still copied. Off stops the import at the first such file.|无法读取或在检查时发生变化的文件会列入“所有错误”并被跳过，其余文件照常复制。关闭时，遇到这类文件会停止导入。|無法讀取或在檢查時發生變化的檔案會列入「所有錯誤」並被略過，其餘檔案照常複製。關閉時，遇到這類檔案會停止匯入。|読み取れないファイルや確認中に変更されたファイルは「すべてのエラー」に記録してスキップし、ほかのファイルはコピーを続けます。オフにすると、そのようなファイルでインポートを停止します。
Run again, skipping files with errors|重新运行，并跳过出错的文件|重新執行，並略過出錯的檔案|エラーのファイルをスキップしてもう一度実行
{file} stopped this job.|{file} 导致此任务停止。|{file} 導致此工作停止。|{file} でこのジョブが停止しました。
Skip|跳过|略過|スキップ
Skip all|全部跳过|全部略過|すべてスキップ
Leave this file out and run the job again|跳过此文件并重新运行任务|略過此檔案並重新執行工作|このファイルを除外してジョブをもう一度実行
Retry|重试|重試|再試行
Run this job again, including files that had errors|重新运行此任务，包括出错的文件|重新執行此工作，包括出錯的檔案|エラーのファイルも含めてこのジョブをもう一度実行
This job ended with errors.|此任务完成时有错误。|此工作完成時有錯誤。|このジョブはエラーがある状態で終了しました。
Show in Finder|在访达中显示|在 Finder 中顯示|Finder で表示
Review what Mirror will move to continue.|请先审核镜像将移动的文件再继续。|請先審核鏡像將移動的檔案再繼續。|続行するには、ミラーで移動するファイルを確認してください。
Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.|导入、整理或审核进行期间（包括已暂停或排队中的）已锁定。请先完成或停止它们再更改。|匯入、整理或審核進行期間（包括已暫停或排隊中的）已鎖定。請先完成或停止它們再變更。|読み込み・整理・レビューの実行中（一時停止中や待機中を含む）はロックされています。完了または停止してから変更してください。
Some settings are locked while work is active.|有任务进行时，部分设置已锁定。|有工作進行時，部分設定已鎖定。|作業中は一部の設定がロックされています。
Showing 500 matches. Search to narrow.|显示 500 个匹配项，可搜索以缩小范围。|顯示 500 個符合項目，可搜尋以縮小範圍。|500件を表示中。検索で絞り込めます。
This deletes the kept originals. Undo won't be possible.|这会删除保留的原始文件，之后将无法撤销。|這會刪除保留的原始檔案，之後將無法復原。|保持している元のファイルを削除します。元に戻せなくなります。
Unknown files are not copied.|未知文件不会被复制。|未知檔案不會被複製。|不明なファイルはコピーしません。
Use Review for USB cameras.|USB 相机请使用“审核”。|USB 相機請使用「審核」。|USB 接続のカメラは「確認」を使ってください。
You'll be asked in All errors.|会在“所有错误”中询问你。|會在「所有錯誤」中詢問你。|「すべてのエラー」で確認します。
{count} originals ({size}) kept for undo.|为可撤销保留了 {count} 个原始文件（{size}）。|為可復原保留了 {count} 個原始檔案（{size}）。|元に戻すため元のファイル {count} 件（{size}）を保持しています。
{name}: {count} unknown files skipped.|{name}：已跳过 {count} 个未知文件。|{name}：已略過 {count} 個未知檔案。|{name}：不明なファイル {count} 件をスキップしました。
Organize a folder|整理文件夹|整理資料夾|フォルダーを整理
Sorts a folder's files into your folder structure, inside that folder.|按你的文件夹结构整理某个文件夹内的文件，结果仍在该文件夹中。|依你的資料夾結構整理某個資料夾內的檔案，結果仍在該資料夾中。|フォルダー内のファイルを、そのフォルダーの中でフォルダー構成どおりに整理します。
Choose folder…|选择文件夹…|選擇資料夾…|フォルダーを選択…
{free} free of {total}|剩余 {free}，共 {total}|剩餘 {free}，共 {total}|空き {free} / 全体 {total}
Waiting|等待中|等待中|待機中
In progress|进行中|進行中|処理中
Skipped|已跳过|已略過|スキップ
Remove emptied source folders|删除已清空的来源文件夹|刪除已清空的來源資料夾|空になった元フォルダーを削除
Remove confirmed duplicates|删除已确认的重复文件|刪除已確認的重複檔案|確認済みの重複ファイルを削除
After organizing finishes without errors, originals already present at their destination are checked again and removed instead of kept for undo.|整理无错误完成后，再次校验已存在于目标位置的原文件，然后将其删除，而不是保留以供撤销。|整理無錯誤完成後，再次校驗已存在於目標位置的原始檔案，然後將其刪除，而不是保留以供復原。|整理がエラーなく完了したら、移動先に既にある元のファイルを再確認し、元に戻す用に残さず削除します。
Folders left empty after organizing are removed. Folders with files are kept.|整理后变空的文件夹会被删除，仍有文件的文件夹会保留。|整理後變空的資料夾會被刪除，仍有檔案的資料夾會保留。|整理後に空になったフォルダーは削除します。ファイルが残るフォルダーは残します。
Large sizes shrink to fit small windows.|窗口较小时，大字号会自动缩小以适应。|視窗較小時，大字級會自動縮小以符合。|ウィンドウが小さいときは大きな文字が自動で縮小されます。
Choose whether to import this drive.|请选择是否导入此驱动器。|請選擇是否匯入此磁碟。|このドライブを読み込むか選んでください。
Decide later|稍后决定|稍後決定|あとで決める
Organizing now|正在整理|正在整理|整理中
Organizing|正在整理|正在整理|整理中
Listing files|正在列出文件|正在列出檔案|ファイルを一覧中
Checking files|正在检查文件|正在檢查檔案|ファイルを確認中
{completed} files found|已找到 {completed} 个文件|已找到 {completed} 個檔案|{completed} 件見つかりました
{completed} files found · {size}|已找到 {completed} 个文件 · {size}|已找到 {completed} 個檔案 · {size}|{completed} 件見つかりました · {size}
{completed} of {total} files read · {size} of {totalSize}|已读取 {completed}/{total} 个文件 · {size}/{totalSize}|已讀取 {completed}/{total} 個檔案 · {size}/{totalSize}|{total} 件中 {completed} 件を読み込み · {totalSize} 中 {size}
Reading organization history: {completed} of {total} files|正在读取整理历史：{completed}/{total} 个文件|正在讀取整理歷史：{completed}/{total} 個檔案|整理履歴を読み込み中：{total} 件中 {completed} 件
Reading history|正在读取历史|正在讀取歷史|履歴を読み込み中
Checking the earlier organization: {completed} of {total} records|正在检查之前的整理记录：{completed}/{total}|正在檢查先前的整理紀錄：{completed}/{total}|以前の整理記録を確認中：{total} 件中 {completed} 件
Reading metadata|正在读取元数据|正在讀取中繼資料|メタデータを読み取り中
Checking the destination: {completed} of {total} files · {size} read|正在检查目标：{completed}/{total} 个文件 · 已读取 {size}|正在檢查目的地：{completed}/{total} 個檔案 · 已讀取 {size}|保存先を確認中：{total} ファイル中 {completed} 件 · {size} 読み取り済み
Reading later organizations: {completed} of {total}|正在读取较新的整理记录：{completed}/{total}|正在讀取較新的整理記錄：{completed}/{total}|新しい整理の記録を読み込み中：{total} 件中 {completed} 件
Old records from an earlier version are on {drive}. Use records-migrator-v5 to convert them; they were left untouched.|{drive} 上有早期版本留下的旧记录。请使用 records-migrator-v5 转换它们；它们未被改动。|{drive} 上有早期版本留下的舊記錄。請使用 records-migrator-v5 轉換它們；它們未被更動。|{drive} に以前のバージョンの古い記録があります。records-migrator-v5 を使って変換してください。記録には手を加えていません。
Acknowledge old records|确认旧记录|確認舊記錄|古い記録を確認済みにする
Reading earlier organization records: {completed} of {total}|正在读取较早的整理记录：{completed}/{total}|正在讀取較早的整理記錄：{completed}/{total}|以前の整理の記録を読み込み中：{total} 件中 {completed} 件
Reading earlier organizations: journal {journal} of {journals}, records {completed} of {total}|正在读取较早的整理：第 {journal}/{journals} 份记录，已读 {completed}/{total} 条|正在讀取較早的整理：第 {journal}/{journals} 份記錄，已讀 {completed}/{total} 筆|以前の整理を読み込み中：記録 {journal}/{journals} 件目、{total} 件中 {completed} 件
Removing old record files: {completed} of {total}|正在删除旧的记录文件：{completed}/{total}|正在刪除舊的記錄檔案：{completed}/{total}|古い記録ファイルを削除中：{total} 件中 {completed} 件
Measuring: {completed} files|正在测量：{completed} 个文件|正在測量：{completed} 個檔案|計測中：{completed} ファイル
Preparing destinations: {completed} of {total}|正在准备目标位置：{completed}/{total}|正在準備目的地：{completed}/{total}|保存先を準備中：{total} 件中 {completed} 件
Comparing the backup with the drive: {completed} of {total}|正在比较备份与磁盘：{completed}/{total}|正在比較備份與磁碟：{completed}/{total}|バックアップとドライブを比較中：{total} 件中 {completed} 件
Loading the destination index: {size} of {totalSize}|正在加载目标索引：{size}/{totalSize}|正在載入目的地索引：{size}/{totalSize}|保存先のインデックスを読み込み中：{totalSize} 中 {size}
Checking the destination: {completed} of {total} files|正在检查目标：{completed}/{total} 个文件|正在檢查目的地：{completed}/{total} 個檔案|保存先を確認中：{total} ファイル中 {completed} 件
Confirming files already on the destination: {completed} of {total}|正在确认目标中已有的文件：{completed}/{total}|正在確認目的地中已有的檔案：{completed}/{total}|保存先にあるファイルを確認中：{total} 件中 {completed} 件
Confirming files before moving: {completed} of {total}|移动前确认文件：{completed}/{total}|移動前確認檔案：{completed}/{total}|移動前にファイルを確認中：{total} 件中 {completed} 件
Confirming|正在确认|正在確認|確認中
Reading files|正在读取文件|正在讀取檔案|ファイルを読み込み中
Reconnect it to choose.|重新连接后即可选择。|重新連接後即可選擇。|再接続すると選べます。
Unplugged|已拔出|已拔出|取り外し済み
{completed} of {total} files moved|已移动 {completed}/{total} 个文件|已移動 {completed}/{total} 個檔案|{total} 件中 {completed} 件を移動済み
{completed} of {total} files organized|已整理 {completed}/{total} 个文件|已整理 {completed}/{total} 個檔案|{total} 件中 {completed} 件を整理済み
Not enough space on the destination.|目标空间不足。|目的地空間不足。|保存先の空き容量が足りません。
Free up space or choose another destination.|请释放空间或选择其他目标。|請釋放空間或選擇其他目的地。|空き容量を増やすか、別の保存先を選んでください。
macOS didn't allow access to this location.|macOS 不允许访问此位置。|macOS 不允許存取此位置。|macOS がこの場所へのアクセスを許可しませんでした。
Check the drive's permissions, or allow the app in Privacy & Security.|请检查驱动器权限，或在“隐私与安全性”中允许本应用。|請檢查磁碟權限，或在「隱私權與安全性」中允許本 App。|ドライブの権限を確認するか、「プライバシーとセキュリティ」でアプリを許可してください。
Files on the drive changed during the import.|导入过程中驱动器上的文件发生了变化。|匯入過程中磁碟上的檔案發生了變化。|読み込み中にドライブのファイルが変更されました。
Scan the drive again, then import.|请重新扫描驱动器后再导入。|請重新掃描磁碟後再匯入。|ドライブを再スキャンしてから読み込んでください。
A copy didn't match the original.|有副本与原始文件不一致。|有副本與原始檔案不一致。|コピーが元のファイルと一致しませんでした。
Import again. The mismatched copy isn't kept.|请重新导入。不一致的副本不会保留。|請重新匯入。不一致的副本不會保留。|もう一度読み込んでください。一致しないコピーは残りません。
Mirror needs your review before moving files.|镜像在移动文件前需要你审核。|鏡像在移動檔案前需要你審核。|ミラーがファイルを移動する前に確認が必要です。
Open Review on this drive.|请在此驱动器上打开“审核”。|請在此磁碟上開啟「審核」。|このドライブで「確認」を開いてください。
The drive was disconnected or a file is missing.|驱动器已断开或文件缺失。|磁碟已中斷連接或檔案遺失。|ドライブが取り外されたか、ファイルが見つかりません。
Reconnect the drive and try again.|请重新连接驱动器后重试。|請重新連接磁碟後重試。|ドライブを再接続してもう一度お試しください。
The drive reported a read or write error.|驱动器报告了读写错误。|磁碟回報了讀寫錯誤。|ドライブで読み書きエラーが発生しました。
Check the card or drive, or try another reader.|请检查存储卡或驱动器，或换一个读卡器。|請檢查記憶卡或磁碟，或換一個讀卡機。|カードやドライブを確認するか、別のリーダーをお試しください。
The operation took too long.|操作耗时过长。|操作耗時過長。|処理に時間がかかりすぎました。
Try again. A slow or failing drive can cause this.|请重试。驱动器缓慢或故障可能导致此问题。|請重試。磁碟緩慢或故障可能導致此問題。|もう一度お試しください。遅いドライブや故障したドライブが原因の場合があります。
Couldn't read photo details.|无法读取照片信息。|無法讀取照片資訊。|写真の情報を読み取れませんでした。
The file is still copied; its date may come from the file instead.|文件仍会被复制；日期可能改用文件本身的日期。|檔案仍會被複製；日期可能改用檔案本身的日期。|ファイルはコピーされます。日付はファイル自体の日付になる場合があります。
App|应用|App|アプリ
Copy all details|复制全部详情|複製全部詳細資訊|すべての詳細をコピー
{count} issues|{count} 个问题|{count} 個問題|{count} 件の問題
Show drive|显示驱动器|顯示磁碟|ドライブを表示
Dismiss|关闭|關閉|閉じる
Clear|清除|清除|消去
Clear all|全部清除|全部清除|すべて消去
Clear all errors|清除所有错误|清除所有錯誤|すべてのエラーを消去
Clear error: {title}|清除错误：{title}|清除錯誤：{title}|エラーを消去：{title}
Drive: {name}|驱动器：{name}|磁碟：{name}|ドライブ：{name}
Show errors for {name}|显示 {name} 的错误|顯示 {name} 的錯誤|{name} のエラーを表示
Errors for {name}|{name} 的错误|{name} 的錯誤|{name} のエラー
Show all errors|显示所有错误|顯示所有錯誤|すべてのエラーを表示
Clear all errors for {name}|清除 {name} 的所有错误|清除 {name} 的所有錯誤|{name} のエラーをすべて消去
Details|详情|詳細資訊|詳細
{count} new issues|{count} 个新问题|{count} 個新問題|{count} 件の新しい問題
{count} new warnings|{count} 条新警告|{count} 則新警告|新しい警告 {count} 件
Errors|错误|錯誤|エラー
Warnings|警告|警告|警告
{count} warnings|{count} 条警告|{count} 則警告|警告 {count} 件
No warnings to show.|暂无警告。|目前沒有警告。|警告はありません。
Clear all warnings|清除所有警告|清除所有警告|警告をすべて消去
Clear all warnings for {name}|清除 {name} 的所有警告|清除 {name} 的所有警告|{name} の警告をすべて消去
Show warnings for {name}|显示 {name} 的警告|顯示 {name} 的警告|{name} の警告を表示
View|查看|查看|表示
Off|关|關|オフ
Ask|询问|詢問|確認する
Organize backup|整理备份|整理備份|バックアップを整理
Check the backup folder|检查备份文件夹|檢查備份資料夾|バックアップフォルダーの確認
Backup folder is in order.|备份文件夹已整理好。|備份資料夾已整理好。|バックアップフォルダーは整理済みです。
{count} files outside your folder structure|{count} 个文件不在文件夹结构中|{count} 個檔案不在資料夾結構中|フォルダー構成の外に {count} 個のファイル
Misplaced files are moved into place after each import.|每次导入后，放错位置的文件会自动移到正确位置。|每次匯入後，放錯位置的檔案會自動移到正確位置。|読み込みのたびに、場所違いのファイルを正しい場所へ移動します。
Checked after each import. You choose when to move files.|每次导入后检查，由你决定何时移动文件。|每次匯入後檢查，由你決定何時移動檔案。|読み込みのたびに確認し、移動するタイミングは自分で選べます。
Not checked automatically.|不自动检查。|不自動檢查。|自動では確認しません。
Leftover files|残留文件|殘留檔案|残ったファイル
1 leftover file|1 个残留文件|1 個殘留檔案|残ったファイル 1 個
{count} leftover files|{count} 个残留文件|{count} 個殘留檔案|残ったファイル {count} 個
Looking for leftover files…|正在查找残留文件…|正在尋找殘留檔案…|残ったファイルを確認中…
Not checked yet.|尚未检查。|尚未檢查。|まだ確認していません。
No leftover files.|没有残留文件。|沒有殘留檔案。|残ったファイルはありません。
Clean up|清理|清理|クリーンアップ
{count} can continue when that card is imported again ({size}). Automatic cleanup keeps them; Clean up removes them too.|其中 {count} 个可在再次导入该存储卡时继续（{size}）。自动清理会保留它们；点击“清理”也会删除它们。|其中 {count} 個可在再次匯入該記憶卡時繼續（{size}）。自動清理會保留它們；點選「清理」也會刪除它們。|そのうち {count} 個は、そのカードをもう一度読み込むと続きから再開できます（{size}）。自動クリーンアップでは残し、「クリーンアップ」では削除します。
{count} copies could not be proven unneeded ({size}). Automatic cleanup keeps them; Clean up removes them too.|其中 {count} 个副本无法确认已不再需要（{size}）。自动清理会保留它们；点击“清理”也会删除它们。|其中 {count} 個副本無法確認已不再需要（{size}）。自動清理會保留它們；點選「清理」也會刪除它們。|そのうち {count} 個のコピーは不要と確認できませんでした（{size}）。自動クリーンアップでは残し、「クリーンアップ」では削除します。
{count} complete copies whose card file changed are kept: {folder}|{count} 个完整副本的存储卡文件已更改，已保留：{folder}|{count} 個完整副本的記憶卡檔案已變更，已保留：{folder}|カード上のファイルが変わった完全なコピー {count} 個を保管しています：{folder}
A file at {path} has an old copy receipt that no longer matches it; the file is kept. Remove the receipt so imports can continue.|{path} 处的文件有一份旧的复制回执，与它已不相符；文件会保留。请移除该回执，以便继续导入。|{path} 處的檔案有一份舊的複製回執，與它已不相符；檔案會保留。請移除該回執，以便繼續匯入。|{path} のファイルに、一致しなくなった古いコピーの受領記録があります。ファイルはそのままです。インポートを続けるには受領記録を削除してください。
Remove receipt|移除回执|移除回執|受領記録を削除
{count} more files have an old copy receipt. Clean up removes those receipts too; the files are kept.|另有 {count} 个文件有旧的复制回执。点击“清理”也会移除这些回执；文件会保留。|另有 {count} 個檔案有舊的複製回執。點選「清理」也會移除這些回執；檔案會保留。|ほかに {count} 個のファイルに古いコピーの受領記録があります。クリーンアップでこれらの受領記録も削除されます。ファイルは残ります。
Last cleanup removed {files} ({size}).|上次清理删除了{files}（{size}）。|上次清理刪除了{files}（{size}）。|前回のクリーンアップで{files}を削除しました（{size}）。
Staging files from interrupted imports, organization scratch copies and camera downloads are removed automatically when nothing is running. Originals kept for undo stay until you release them.|中断的导入留下的暂存文件、整理时的临时副本和相机下载内容会在没有任务运行时自动删除。为撤销而保留的原文件会一直保留，直到你释放它们。|中斷的匯入留下的暫存檔案、整理時的暫時副本和相機下載內容會在沒有工作執行時自動刪除。為復原而保留的原始檔案會一直保留，直到你釋放它們。|中断した読み込みの一時ファイル、整理中の一時コピー、カメラからのダウンロードは、何も実行していないときに自動で削除されます。取り消し用に保持している元のファイルは、解放するまで残ります。
{completed} of {total} files checked|已检查 {completed}/{total} 个文件|已檢查 {completed}/{total} 個檔案|{total} 個中 {completed} 個のファイルを確認
{completed} of {total} files read|已读取 {completed}/{total} 个文件|已讀取 {completed}/{total} 個檔案|{total} 個中 {completed} 個のファイルを読み込み
{time} elapsed|已用时 {time}|已用時 {time}|経過時間 {time}
Took {time}|用时 {time}|用時 {time}|所要時間 {time}
Estimating time left…|正在估算剩余时间…|正在估算剩餘時間…|残り時間を計算中…
{count} files/s|{count} 个文件/秒|{count} 個檔案/秒|{count} ファイル/秒
Verify read|校验读取|校驗讀取|検証の読み込み
{time} left|剩余{time}|剩餘{time}|残り{time}
{count} already in the backup|备份中已有 {count} 个|備份中已有 {count} 個|バックアップに {count} 件が既にあります
{time} left, not counting queued sources|剩余{time}（不含排队中的来源）|剩餘{time}（不含佇列中的來源）|残り{time}（待機中のソースを除く）
under a minute|不到 1 分钟|不到 1 分鐘|1 分未満
about {minutes} min|约 {minutes} 分钟|約 {minutes} 分鐘|約 {minutes} 分
about {hours} h {minutes} min|约 {hours} 小时 {minutes} 分钟|約 {hours} 小時 {minutes} 分鐘|約 {hours} 時間 {minutes} 分
about {hours} h|约 {hours} 小时|約 {hours} 小時|約 {hours} 時間
about {low}–{high} min|约 {low}–{high} 分钟|約 {low}–{high} 分鐘|約 {low}～{high} 分
about {low}–{high} h|约 {low}–{high} 小时|約 {low}–{high} 小時|約 {low}～{high} 時間
{completed} of {total} files verified · {size} of {totalSize}|已校验 {completed}/{total} 个文件 · {size}/{totalSize}|已驗證 {completed}/{total} 個檔案 · {size}/{totalSize}|{total} 件中 {completed} 件を検証済み · {totalSize} 中 {size}
Move {name} to the top|将 {name} 移到最上方|將 {name} 移到最上方|{name} を一番上へ移動
Move to the top|移到最上方|移到最上方|一番上へ移動
Drive reconnected|驱动器已重新连接|磁碟已重新連接|ドライブが再接続されました
Drives reconnected|驱动器已重新连接|磁碟已重新連接|ドライブが再接続されました
Last import verified {date}|上次导入并验证：{date}|上次匯入並驗證：{date}|前回の読み込みと検証：{date}
Last scan finished {date}|上次扫描完成：{date}|上次掃描完成：{date}|前回のスキャン完了：{date}
Import now|立即导入|立即匯入|今すぐ読み込む
OK|好|好|OK
Hide the import overview|隐藏导入概览|隱藏匯入概覽|読み込みの概要を隠す
Show the import overview|显示导入概览|顯示匯入概覽|読み込みの概要を表示
Importing|导入|匯入|読み込み
Folders|文件夹|資料夾|フォルダー
Manual|手动|手動|手動
{count} at once|同时 {count} 个|同時 {count} 個|同時に {count} 台
Not set|未设置|未設定|未設定
{count} remembered|已记住 {count} 个|已記住 {count} 個|{count} 台を記憶
Backup folder check|备份文件夹检查|備份資料夾檢查|バックアップフォルダーの確認
Starting imports|开始导入|開始匯入|読み込みの開始
Imports start as soon as a selected drive connects.|选定的驱动器一连接就开始导入。|選定的磁碟一連接就開始匯入。|選択したドライブを接続するとすぐに読み込みを開始します。
Drives at once|同时处理的驱动器|同時處理的磁碟|同時に処理するドライブ
Lets you choose a folder of photos as a source.|允许选择一个照片文件夹作为来源。|允許選擇一個照片資料夾作為來源。|写真フォルダーを読み込み元として選べます。
Settings categories|设置类别|設定類別|設定のカテゴリ
Totals, speed and progress at the top of the Import desk.|在导入台顶部显示总数、速度和进度。|在匯入台頂部顯示總數、速度和進度。|読み込みデスクの上部に合計、速度、進行状況を表示します。
1 file outside your folder structure|1 个文件不在文件夹结构中|1 個檔案不在資料夾結構中|フォルダー構成の外に 1 個のファイル
Limit: {count} simultaneous|上限：同时 {count} 个|上限：同時 {count} 個|同時処理上限：{count}
of {size} planned|计划共 {size}|計畫共 {size}|予定 {size} 中
{complete} sources complete · {errors} need attention|{complete} 个来源完成 · {errors} 个需处理|{complete} 個來源完成 · {errors} 個需處理|{complete} 件完了 · {errors} 件要確認
{size} free across destinations|目标合计剩余 {size}|目的地合計剩餘 {size}|保存先の空き容量 {size}
{size} free|剩余 {size}|剩餘 {size}|空き {size}
Queue position {count}|队列位置 {count}|佇列位置 {count}|待機順 {count}
Review import from {name}|审核来自 {name} 的导入|審核來自 {name} 的匯入|{name} のインポートを確認
{name} copy progress|{name} 复制进度|{name} 複製進度|{name} のコピー進捗
{name} scanning|正在扫描 {name}|正在掃描 {name}|{name} をスキャン中
Show first destination in file manager|在文件管理器中显示第一目标|在檔案管理員中顯示第一目的地|1つ目の保存先をファイルマネージャーで表示
Show second destination in file manager|在文件管理器中显示第二目标|在檔案管理員中顯示第二目的地|2つ目の保存先をファイルマネージャーで表示
Companion to {name}|{name} 的伴随文件|{name} 的伴隨檔案|{name} の関連ファイル
Copy to {folder}|复制到 {folder}|複製到 {folder}|{folder} にコピー
Edit rule for {extension}|编辑 {extension} 的规则|編輯 {extension} 的規則|{extension} のルールを編集
files without an extension|无扩展名的文件|無副檔名的檔案|拡張子のないファイル
Preview of {name}|{name} 的预览|{name} 的預覽|{name} のプレビュー
{name}: import preview|{name}：导入预览|{name}：匯入預覽|{name}：インポートのプレビュー
{count} copies to write|待写入 {count} 份副本|待寫入 {count} 份副本|コピー予定 {count} 件
{count} already verified|{count} 个已校验|{count} 個已驗證|{count} 件検証済み
{size} to organize|待整理 {size}|待整理 {size}|整理予定 {size}
{size} to copy|待复制 {size}|待複製 {size}|コピー予定 {size}
Destination {count}: |目标 {count}：|目的地 {count}：|保存先 {count}：
Files {start}–{end} of {total}|文件 {start}–{end}，共 {total} 个|檔案 {start}–{end}，共 {total} 個|{total} 件中 {start}〜{end} 件
{count} sources connected. Choose a backup destination to enable imports.|已连接 {count} 个来源。选择备份目标以启用导入。|已連接 {count} 個來源。選擇備份目的地以啟用匯入。|{count} 件接続中です。バックアップ先を選ぶとインポートできます。
{count} sources connected. Choose two backup destinations to enable imports.|已连接 {count} 个来源。选择两个备份目标以启用导入。|已連接 {count} 個來源。選擇兩個備份目的地以啟用匯入。|{count} 件接続中です。2つのバックアップ先を選ぶとインポートできます。

Import controls|导入控制|匯入控制|インポート操作
Drive controls|驱动器控制|磁碟控制|ドライブ操作
Organization controls|整理控制|整理控制|整理操作
Refresh drives|刷新驱动器|重新整理磁碟|ドライブを更新
Scan all|扫描全部|掃描全部|すべてスキャン
Scanning…|正在扫描…|正在掃描…|スキャン中…
Scan to see formats and counts|扫描以查看格式和数量|掃描以檢視格式與數量|スキャンで形式と件数を表示
Reading media formats and counts…|正在读取媒体格式和数量…|正在讀取媒體格式與數量…|メディアの形式と件数を取得中…
Read photo and video formats without copying files|只读取照片和视频格式，不复制文件|僅讀取照片與影片格式，不複製檔案|コピーせずに写真・動画の形式を確認
Media summary for {name}|{name} 的媒体摘要|{name} 的媒體摘要|{name} のメディア概要
{size} media|媒体 {size}|媒體 {size}|メディア {size}
Updating scan…|正在更新扫描…|正在更新掃描…|スキャンを更新中…
Photos|照片|照片|写真
{count} files · {size}|{count} 个文件 · {size}|{count} 個檔案 · {size}|{count} ファイル · {size}
No photos found.|未找到照片。|未找到照片。|写真が見つかりません。
No videos found.|未找到视频。|未找到影片。|動画が見つかりません。
Existing files, new structure|现有文件，全新结构|現有檔案，全新結構|既存ファイルを新しい構造に
Organization destination|整理目标|整理目的地|整理する保存先
Scan existing files in|扫描此处的现有文件|掃描此處的現有檔案|既存ファイルのスキャン先
New structure under|新结构的根目录|新結構的根目錄|新しい構造の保存先
Choose a backup location in Settings to begin.|在设置中选择备份位置即可开始。|在設定中選擇備份位置即可開始。|設定でバックアップ先を選択してください。
Organization recovery|整理恢复|整理復原|整理の復元
Needs recovery|需要恢复|需要復原|復元が必要
{completed} of {total} files verified|已校验 {completed} / {total} 个文件|已驗證 {completed} / {total} 個檔案|{total} 件中 {completed} 件検証済み
Review your new folder structure|审核新的文件夹结构|審核新的資料夾結構|新しいフォルダー構造を確認
{count} files to organize|待整理 {count} 个文件|待整理 {count} 個檔案|整理予定 {count} ファイル
Existing path|现有路径|現有路徑|現在のパス
New path|新路径|新路徑|新しいパス
Organize|整理|整理|整理
Apply reviewed organization|应用已审核的整理|套用已審核的整理|確認した整理を適用
Scan media on {name}|扫描 {name} 上的媒体|掃描 {name} 上的媒體|{name} のメディアをスキャン
Media camera information|媒体相机信息|媒體相機資訊|メディアのカメラ情報
Camera metadata|相机元数据|相機中繼資料|カメラのメタデータ
Reading camera metadata: {checked}/{total}|正在读取相机元数据：{checked}/{total}|正在讀取相機中繼資料：{checked}/{total}|カメラのメタデータを取得中：{checked}/{total}
Camera metadata scan stopped: {checked}/{total}|相机元数据扫描已停止：{checked}/{total}|相機中繼資料掃描已停止：{checked}/{total}|カメラのメタデータ取得を停止：{checked}/{total}
Camera metadata scan incomplete: {checked}/{total}|相机元数据扫描未完成：{checked}/{total}|相機中繼資料掃描未完成：{checked}/{total}|カメラのメタデータ取得が未完了：{checked}/{total}
Camera metadata checked: {checked}/{total}|已检查相机元数据：{checked}/{total}|已檢查相機中繼資料：{checked}/{total}|カメラのメタデータを確認済み：{checked}/{total}
Camera hints — unconfirmed|相机线索（未经确认）|相機線索（未經確認）|カメラの手がかり（未確認）
Drive name|磁盘名称|磁碟名稱|ドライブ名
File type|文件类型|檔案類型|ファイル形式
Camera folder layout|相机文件夹结构|相機資料夾結構|カメラのフォルダー構造
Confirmed by EXIF metadata|EXIF 元数据已确认|EXIF 中繼資料已確認|EXIFメタデータで確認済み
No camera models confirmed yet.|尚未确认相机型号。|尚未確認相機型號。|カメラ機種はまだ確認されていません。
No camera models confirmed in checked files.|已检查的文件中未确认相机型号。|已檢查的檔案中未確認相機型號。|確認したファイルにカメラ機種の記録がありません。
Unknown file formats|未知文件格式|未知檔案格式|不明なファイル形式
Keep unknown files excluded|继续排除未知文件|繼續排除未知檔案|不明なファイルの除外を保存
Choose folders…|选择文件夹…|選擇資料夾…|フォルダーを選択…
Use whole destination|使用整个目标|使用整個目的地|保存先全体を使用
Only the selected folders will be scanned.|仅扫描选定的文件夹。|僅掃描選取的資料夾。|選択したフォルダーのみをスキャンします。
All folders on this destination will be scanned.|将扫描此目标上的所有文件夹。|將掃描此目的地上的所有資料夾。|この保存先のすべてのフォルダーをスキャンします。
Selected organization folders|选定的整理文件夹|選取的整理資料夾|整理対象の選択フォルダー
Checking organization files: {count} · {file}|正在检查整理文件：{count} · {file}|正在檢查整理檔案：{count} · {file}|整理対象を確認中：{count} · {file}
Preparing organization review…|正在准备整理预览…|正在準備整理預覽…|整理の確認を準備中…
Copy to camera folders|复制到相机文件夹|複製到相機資料夾|カメラ別フォルダーにコピー
Remember for these extensions|记住这些扩展名的选择|記住這些副檔名的選擇|これらの拡張子の設定を保存
Unknown formats stay excluded unless you choose to copy them. Recheck the source after changing a rule.|未知格式默认排除，除非你选择复制。更改规则后请重新检查来源。|未知格式預設排除，除非你選擇複製。變更規則後請重新檢查來源。|コピーを選択するまで不明な形式は除外されます。ルール変更後はソースを再確認してください。
Camera folders use a matching photo or video, or the card’s single confirmed camera. Mixed or unconfirmed cards use the Unknown files folder.|相机文件夹使用匹配的照片或视频，或卡中唯一已确认的相机。混合或未确认的卡使用“Unknown files”文件夹。|相機資料夾使用配對的照片或影片，或卡中唯一已確認的相機。混合或未確認的卡使用「Unknown files」資料夾。|カメラ別フォルダーは、対応する写真・動画、またはカードで確認済みの唯一のカメラを使います。混在または未確認のカードは「Unknown files」フォルダーを使います。
{count} unknown files will be left where they are.|{count} 个未知文件将保留在原位。|{count} 個未知檔案將保留在原位。|不明なファイル {count} 件はそのままの場所に残します。
{count} unknown files will not be copied; they stay on the source.|{count} 个未知文件不会被复制，仍留在来源中。|{count} 個未知檔案不會被複製，仍留在來源中。|不明なファイル {count} 件はコピーされず、ソースに残ります。
{count} unknown files will be moved to {folder}.|{count} 个未知文件将被移动到 {folder}。|{count} 個未知檔案將被移動到 {folder}。|不明なファイル {count} 件を {folder} に移動します。
{count} unknown files will be copied to {folder}.|{count} 个未知文件将被复制到 {folder}。|{count} 個未知檔案將被複製到 {folder}。|不明なファイル {count} 件を {folder} にコピーします。
{count} without a date|{count} 个无日期|{count} 個無日期|日付なし {count} 件
{count} without a camera|{count} 个无相机|{count} 個無相機|カメラなし {count} 件
{count} unreadable|{count} 个无法读取|{count} 個無法讀取|読み取り不可 {count} 件
No capture date|无拍摄日期|無拍攝日期|撮影日なし
No camera|无相机|無相機|カメラなし
They have no capture date, no camera or known origin, or could not be read, such as screenshots, edited exports and files from messaging apps. Nothing starts until you continue.|这些文件没有拍摄日期、没有相机或已知来源，或无法读取，例如截图、编辑后导出的文件和来自通讯应用的文件。在你继续之前不会开始任何操作。|這些檔案沒有拍攝日期、沒有相機或已知來源，或無法讀取，例如螢幕截圖、編輯後匯出的檔案和來自通訊 App 的檔案。在你繼續之前不會開始任何操作。|撮影日がない、カメラや既知の取得元がない、または読み取れないファイルです（スクリーンショット、編集後の書き出し、メッセージアプリのファイルなど）。続行するまで何も始まりません。
Show files|显示文件|顯示檔案|ファイルを表示
Hide files|隐藏文件|隱藏檔案|ファイルを隠す
Use file date instead|改用文件日期|改用檔案日期|ファイルの日付を使う
1 unknown file was left where it is|有 1 个未知文件保留在原位|有 1 個未知檔案保留在原位|不明なファイル 1 件をそのままの場所に残しました
{count} unknown files were left where they are|有 {count} 个未知文件保留在原位|有 {count} 個未知檔案保留在原位|不明なファイル {count} 件をそのままの場所に残しました
1 unknown file was filed in the unknown files folder|有 1 个未知文件被放入未知文件文件夹|有 1 個未知檔案被放入未知檔案資料夾|不明なファイル 1 件を不明ファイル用フォルダーに入れました
{count} unknown files were filed in the unknown files folder|有 {count} 个未知文件被放入未知文件文件夹|有 {count} 個未知檔案被放入未知檔案資料夾|不明なファイル {count} 件を不明ファイル用フォルダーに入れました
They have no capture date, no camera or known origin, or could not be read. You can change this in Settings.|这些文件没有拍摄日期、没有相机或已知来源，或无法读取。你可以在“设置”中更改。|這些檔案沒有拍攝日期、沒有相機或已知來源，或無法讀取。你可以在「設定」中變更。|撮影日がない、カメラや既知の取得元がない、または読み取れないファイルです。設定で変更できます。
Files without metadata|无元数据的文件|無中繼資料的檔案|メタデータのないファイル
Files with unknown metadata|元数据未知的文件|中繼資料未知的檔案|メタデータが不明なファイル
Leave where they are|保留在原位|保留在原位|そのままにする
Not moved or copied, and Delete originals never removes them. You are warned before a job starts.|不移动也不复制，“删除原件”也绝不会删除它们。任务开始前会提醒你。|不移動也不複製，「刪除原始檔」也絕不會刪除它們。工作開始前會提醒你。|移動もコピーもされず、「元ファイルを削除」でも削除されません。ジョブの開始前に警告します。
Move to a folder|移动到文件夹|移動到資料夾|フォルダーに移動
Organized or copied into one folder directly under your library, keeping their subfolders.|整理或复制到资料库下的同一个文件夹中，并保留其子文件夹结构。|整理或複製到資料庫下的同一個資料夾中，並保留其子資料夾結構。|ライブラリ直下の1つのフォルダーに、サブフォルダー構成を保ったまま整理またはコピーします。
Use file date|使用文件日期|使用檔案日期|ファイルの日付を使う
Filed by the file's modified date, in a camera folder with the folder name below.|按文件修改日期归档，放入以下方文件夹名称命名的相机文件夹。|依檔案修改日期歸檔，放入以下方資料夾名稱命名的相機資料夾。|ファイルの更新日で整理し、下のフォルダー名のカメラフォルダーに入れます。
Use one folder name: no slashes or special characters, not a date or year, and not a folder the app uses. The saved name stays in use until this is fixed.|请使用单一的文件夹名称：不含斜杠或特殊字符，不是日期或年份，也不是应用使用的文件夹。在修正之前仍使用已保存的名称。|請使用單一的資料夾名稱：不含斜線或特殊字元，不是日期或年份，也不是 App 使用的資料夾。在修正之前仍使用已儲存的名稱。|フォルダー名は1つだけにしてください。スラッシュや特殊文字、日付や年、アプリが使うフォルダー名は使えません。修正するまで保存済みの名前を使います。
Unknown files folder name|未知文件文件夹名称|未知檔案資料夾名稱|不明ファイル用フォルダー名
All errors|所有错误|所有錯誤|すべてのエラー
{count} errors|{count} 个错误|{count} 個錯誤|エラー {count} 件
Close panel|关闭面板|關閉面板|パネルを閉じる
No errors to show.|暂无错误。|目前沒有錯誤。|エラーはありません。
See All errors for details.|请在“所有错误”中查看详情。|請在「所有錯誤」中查看詳情。|詳細は「すべてのエラー」で確認できます。
Organize now|立即整理|立即整理|今すぐ整理
Review changes…|预览更改…|預覽變更…|変更を確認…
Library organization|媒体库整理|媒體庫整理|ライブラリの整理
Import: copy, source untouched|导入：复制，来源保持不变|匯入：複製，來源保持不變|インポート：コピー、ソースはそのまま
Organize: move, source removed|整理：移动，来源文件已移除|整理：移動，來源檔案已移除|整理：移動、ソースから削除
Emptied source folders are removed|已清空的来源文件夹会被删除|已清空的來源資料夾會被刪除|空になった元フォルダーは削除されます
Emptied source folders are kept|已清空的来源文件夹会保留|已清空的來源資料夾會保留|空になった元フォルダーは残ります
Confirmed duplicates are released|已确认的重复文件会被释放|已確認的重複檔案會被釋放|確認済みの重複ファイルは解放されます
Confirmed duplicates are kept for undo|已确认的重复文件会保留以便撤销|已確認的重複檔案會保留以便復原|確認済みの重複ファイルは取り消し用に保持されます
Delete originals already in the backup|删除已在备份中的原文件|刪除已在備份中的原始檔案|バックアップ済みの元のファイルを削除
Deletes only source files verified in the backup|只删除已在备份中验证过的来源文件|只刪除已在備份中驗證過的來源檔案|バックアップで検証済みのソースファイルだけを削除します
Delete originals already in the backup?|要删除已在备份中的原文件吗？|要刪除已在備份中的原始檔案嗎？|バックアップ済みの元のファイルを削除しますか？
Delete originals permanently?|要永久删除原文件吗？|要永久刪除原始檔案嗎？|元のファイルを完全に削除しますか？
Only files that were copied and verified by checksum in the backup are deleted. Files that were not copied stay where they are.|只会删除已复制并通过校验和验证的备份文件对应的原文件。未复制的文件会保留在原处。|只會刪除已複製並通過檢查碼驗證的備份檔案所對應的原始檔案。未複製的檔案會保留在原處。|コピーされ、チェックサムでバックアップ内の確認が取れたファイルだけを削除します。コピーされていないファイルはそのまま残ります。
{count} files ({size}) will be deleted from {name}.|将从 {name} 删除 {count} 个文件（{size}）。|將從 {name} 刪除 {count} 個檔案（{size}）。|{name} から {count} 件（{size}）のファイルを削除します。
No verified originals to delete.|没有可删除的已验证原文件。|沒有可刪除的已驗證原始檔案。|削除できる検証済みの元のファイルはありません。
This permanently deletes {count} files ({size}) from {name}. Each is checked against its copy in the backup first. This cannot be undone.|这将从 {name} 永久删除 {count} 个文件（{size}）。删除前会逐个与备份中的副本核对。此操作无法撤销。|這將從 {name} 永久刪除 {count} 個檔案（{size}）。刪除前會逐一與備份中的副本核對。此操作無法復原。|{name} から {count} 件（{size}）のファイルを完全に削除します。削除前に、それぞれバックアップ内のコピーと照合します。この操作は取り消せません。
Counting verified originals…|正在统计已验证的原文件…|正在統計已驗證的原始檔案…|検証済みの元のファイルを数えています…
{count} files will stay where they are.|有 {count} 个文件会保留在原处。|有 {count} 個檔案會保留在原處。|{count} 件のファイルはそのまま残ります。
Stopped after {count} originals deleted ({size}); {kept} left in place|已在删除 {count} 个原文件（{size}）后停止；{kept} 个保留在原处|已在刪除 {count} 個原始檔案（{size}）後停止；{kept} 個保留在原處|元のファイル {count} 件（{size}）を削除した時点で停止し、{kept} 件はそのまま残しました
{count} originals deleted ({size}); {kept} left in place; {folders} empty folders removed|已删除 {count} 个原文件（{size}）；{kept} 个保留在原处；已移除 {folders} 个空文件夹|已刪除 {count} 個原始檔案（{size}）；{kept} 個保留在原處；已移除 {folders} 個空資料夾|元のファイル {count} 件（{size}）を削除、{kept} 件はそのまま残し、空のフォルダ {folders} 件を削除しました
Removing empty folders: {completed} of {total}|正在移除空文件夹：{completed}/{total}|正在移除空資料夾：{completed}/{total}|空のフォルダを削除中：{total} 件中 {completed} 件
Deleting originals: {completed} of {total}|正在删除原文件：{completed}/{total}|正在刪除原始檔案：{completed}/{total}|元のファイルを削除中：{total} 件中 {completed} 件
Level 1: you decide|级别 1：由你决定|層級 1：由你決定|レベル1：すべて自分で決める
You decide every group. Nothing is removed until you choose which file to keep.|每一组都由你决定。在你选择要保留的文件之前，不会删除任何内容。|每一組都由你決定。在你選擇要保留的檔案之前，不會移除任何內容。|すべてのグループを自分で決めます。残すファイルを選ぶまで何も削除されません。
Level 2: identical files|级别 2：完全相同的文件|層級 2：完全相同的檔案|レベル2：完全に同一のファイル
Files that are exactly the same (same SHA-256) are removed automatically, keeping the copy in your organized folders. You decide all other groups.|完全相同（SHA-256 相同）的文件会自动移除，并保留已整理文件夹中的那一份。其他分组由你决定。|完全相同（SHA-256 相同）的檔案會自動移除，並保留已整理資料夾中的那一份。其他群組由你決定。|完全に同一（SHA-256 が同じ）のファイルは自動で削除され、整理済みフォルダー内のものが残ります。それ以外のグループは自分で決めます。
Level 3: automatic|级别 3：自动|層級 3：自動|レベル3：自動
Exactly identical files (same SHA-256) are removed automatically. Files with the same EXIF are removed only after you confirm them, even when their size matches.|完全相同的文件（SHA-256 相同）会自动移除。EXIF 相同的文件即使大小一致，也要在你确认后才会移除。|完全相同的檔案（SHA-256 相同）會自動移除。EXIF 相同的檔案即使大小一致，也要在你確認後才會移除。|完全に同一のファイル（SHA-256 が同じ）は自動で削除されます。EXIF が同じファイルは、サイズが同じでも確認してから削除されます。
Removal level|移除级别|移除層級|削除レベル
Identical files|完全相同的文件|完全相同的檔案|同一のファイル
Same EXIF and size|EXIF 和大小相同|EXIF 和大小相同|EXIF とサイズが同じ
Same EXIF, different size|EXIF 相同，大小不同|EXIF 相同，大小不同|EXIF は同じでサイズが異なる
Same name and time|名称和时间相同|名稱和時間相同|名前と時刻が同じ
Dimensions|尺寸|尺寸|サイズ（ピクセル）
File size|文件大小|檔案大小|ファイルサイズ
Path|路径|路徑|パス
SHA identical|SHA 相同|SHA 相同|SHA 一致
EXIF identical|EXIF 相同|EXIF 相同|EXIF 一致
Size differs|大小不同|大小不同|サイズが異なる
In organized structure|在整理后的结构中|在整理後的結構中|整理済みの構造内
Suggested keep|建议保留|建議保留|おすすめの保持
No preview available|无可用预览|沒有可用預覽|プレビューはありません
Loading preview…|正在加载预览…|正在載入預覽…|プレビューを読み込み中…
This Mac can't decode this RAW format yet, so the camera's embedded preview is shown. Updating macOS or converting the files with Adobe DNG Converter adds support.|这台 Mac 暂时无法解码此 RAW 格式，因此显示相机内嵌的预览。更新 macOS 或用 Adobe DNG Converter 转换文件即可获得支持。|這台 Mac 暫時無法解碼此 RAW 格式，因此顯示相機內嵌的預覽。更新 macOS 或用 Adobe DNG Converter 轉換檔案即可獲得支援。|この Mac はこの RAW 形式をまだデコードできないため、カメラ内蔵のプレビューを表示しています。macOS を更新するか、Adobe DNG Converter で変換すると対応できます。
This file's preview could not be read.|无法读取此文件的预览。|無法讀取此檔案的預覽。|このファイルのプレビューを読み込めませんでした。
This file's EXIF could not be read.|无法读取此文件的 EXIF。|無法讀取此檔案的 EXIF。|このファイルの EXIF を読み込めませんでした。
Full EXIF|完整 EXIF|完整 EXIF|すべての EXIF
Loading…|正在加载…|正在載入…|読み込み中…
No EXIF found|未找到 EXIF|找不到 EXIF|EXIF が見つかりません
Group {number}|第 {number} 组|第 {number} 組|グループ {number}
Group|分组|群組|グループ
Removed automatically|自动移除|自動移除|自動で削除
Choose a file to keep|请选择要保留的文件|請選擇要保留的檔案|残すファイルを選んでください
Keep all|全部保留|全部保留|すべて残す
Will be removed|将被移除|將被移除|削除されます
Remove duplicates from {name}?|要从 {name} 移除重复文件吗？|要從 {name} 移除重複檔案嗎？|{name} から重複ファイルを削除しますか？
Remove {files} files?|要移除 {files} 个文件吗？|要移除 {files} 個檔案嗎？|{files} 件のファイルを削除しますか？
{count} of these files were placed by an earlier organization; removing them ends that organization's Undo.|其中 {count} 个文件由之前的整理放置；移除它们会使该次整理无法再撤销。|其中 {count} 個檔案由先前的整理放置；移除它們會使該次整理無法再復原。|これらのうち {count} 件は以前の整理で配置されたものです。削除すると、その整理の取り消しはできなくなります。
{files} files in {groups} groups will be moved to the recovery area, freeing {size} once released.|{groups} 组中的 {files} 个文件将移到恢复区域，释放后可腾出 {size}。|{groups} 組中的 {files} 個檔案將移到復原區域，釋放後可騰出 {size}。|{groups} グループの {files} 件が復元用の領域に移動し、解放すると {size} が空きます。
Nothing is deleted yet. You can undo this, and the space is freed only when you release the removed files.|目前不会删除任何内容。你可以撤销，只有在释放已移除的文件后才会腾出空间。|目前不會刪除任何內容。你可以復原，只有在釋放已移除的檔案後才會騰出空間。|まだ何も削除されません。元に戻せます。削除したファイルを解放したときに初めて空き容量が増えます。
The kept file of each group is checked first. The other {files} files ({size}) move to the recovery area and can be put back with Undo.|会先检查每组保留的文件。其余 {files} 个文件（{size}）会移到恢复区域，可用“撤销”放回。|會先檢查每組保留的檔案。其餘 {files} 個檔案（{size}）會移到復原區域，可用「復原」放回。|各グループの残すファイルを先に確認します。残りの {files} 件（{size}）は復元用の領域に移動し、「元に戻す」で戻せます。
Remove {files} files|移除 {files} 个文件|移除 {files} 個檔案|{files} 件を削除
Removed duplicates|已移除的重复文件|已移除的重複檔案|削除した重複ファイル
Set aside with undo. The space is freed when you release them.|已搁置，可撤销。释放后才会腾出空间。|已擱置，可復原。釋放後才會騰出空間。|元に戻せる状態で退避しています。解放すると空き容量が増えます。
No removed duplicates in this library.|此资料库中没有已移除的重复文件。|此資料庫中沒有已移除的重複檔案。|このライブラリに削除した重複ファイルはありません。
Removed|已移除|已移除|削除済み
Undo|撤销|復原|元に戻す
Pages|页面|頁面|ページ
Previous page|上一页|上一頁|前のページ
Page {page} of {pages}|第 {page}/{pages} 页|第 {page}/{pages} 頁|{pages} ページ中 {page} ページ目
Next page|下一页|下一頁|次のページ
Where to look|查找位置|尋找位置|探す場所
Pick a backup library or any folder. Copies are compared only inside it.|选择备份资料库或任意文件夹。只会在其内部比较副本。|選擇備份資料庫或任意資料夾。只會在其內部比較副本。|バックアップのライブラリまたは任意のフォルダーを選びます。その中だけで比較します。
Library|资料库|資料庫|ライブラリ
Library to look through|要查找的资料库|要尋找的資料庫|調べるライブラリ
Choose a library…|选择资料库…|選擇資料庫…|ライブラリを選択…
No library available|没有可用的资料库|沒有可用的資料庫|利用できるライブラリがありません
Looking through|正在查找|正在尋找|調査対象
Scan again|重新扫描|重新掃描|再スキャン
Scan for duplicates|扫描重复文件|掃描重複檔案|重複ファイルをスキャン
Duplicate scan progress|重复文件扫描进度|重複檔案掃描進度|重複ファイルのスキャンの進行状況
Removing duplicates|正在移除重复文件|正在移除重複檔案|重複ファイルを削除中
{count} duplicates set aside ({size}).|已搁置 {count} 个重复文件（{size}）。|已擱置 {count} 個重複檔案（{size}）。|{count} 件の重複ファイルを退避しました（{size}）。
Before you remove|移除之前|移除之前|削除する前に
{groups} groups of duplicates found in {files} files.|在 {files} 个文件中找到 {groups} 组重复文件。|在 {files} 個檔案中找到 {groups} 組重複檔案。|{files} 件のファイルから {groups} グループの重複が見つかりました。
Remove duplicates…|移除重复文件…|移除重複檔案…|重複ファイルを削除…
Groups to clean up|要清理的分组|要清理的群組|整理するグループ
Files to remove|要移除的文件|要移除的檔案|削除するファイル
Space to free|可腾出的空间|可騰出的空間|空き容量の増加
Waiting for your choice|等待你的选择|等待你的選擇|選択待ち
Removed files go to a recovery area first. Nothing is deleted until you release them.|移除的文件会先放入恢复区域。释放之前不会删除任何内容。|移除的檔案會先放入復原區域。釋放之前不會刪除任何內容。|削除したファイルはまず復元用の領域に移動します。解放するまで何も削除されません。
Groups|分组|群組|グループ
Keep the suggested file in every group|每组都保留建议的文件|每組都保留建議的檔案|すべてのグループでおすすめのファイルを残す
Show groups|显示分组|顯示群組|表示するグループ
All ({count})|全部（{count}）|全部（{count}）|すべて（{count}）
You decide ({count})|由你决定（{count}）|由你決定（{count}）|自分で決める（{count}）
Automatic ({count})|自动（{count}）|自動（{count}）|自動（{count}）
No duplicates found.|未找到重复文件。|找不到重複檔案。|重複ファイルは見つかりませんでした。
Scan to look for duplicates in this library.|扫描以查找此资料库中的重复文件。|掃描以尋找此資料庫中的重複檔案。|スキャンして、このライブラリの重複ファイルを探します。
Remove duplicates|移除重复文件|移除重複檔案|重複ファイルの削除
Duplicates|重复文件|重複檔案|重複
Remove duplicates controls|移除重复文件控制|移除重複檔案控制|重複ファイル削除の操作
Exposure|曝光|曝光|露出
Exposure program|曝光程序|曝光程式|露出プログラム
Exposure mode|曝光模式|曝光模式|露出モード
Metering mode|测光模式|測光模式|測光モード
White balance|白平衡|白平衡|ホワイトバランス
Flash|闪光灯|閃光燈|フラッシュ
35 mm equivalent|35 毫米等效|35 毫米等效|35mm 換算
Subject distance|拍摄距离|拍攝距離|被写体距離
Digital zoom|数码变焦|數位變焦|デジタルズーム
Scene type|场景类型|場景類型|シーンタイプ
Camera & Lens|相机和镜头|相機與鏡頭|カメラとレンズ
Camera make|相机品牌|相機品牌|カメラメーカー
Camera model|相机型号|相機型號|カメラモデル
Camera serial number|相机序列号|相機序號|カメラのシリアル番号
Internal serial number|内部序列号|內部序號|内部シリアル番号
Lens make|镜头品牌|鏡頭品牌|レンズメーカー
Lens ID|镜头 ID|鏡頭 ID|レンズ ID
Lens serial number|镜头序列号|鏡頭序號|レンズのシリアル番号
Software|软件|軟體|ソフトウェア
Firmware|固件|韌體|ファームウェア
Photographer|摄影师|攝影師|撮影者
Copyright|版权|版權|著作権
Date & Time|日期和时间|日期與時間|日付と時刻
Sub-seconds|亚秒|亞秒|サブ秒
Time zone offset|时区偏移|時區偏移|タイムゾーンのオフセット
Created|创建时间|建立時間|作成日時
Modified|修改时间|修改時間|変更日時
Creation date|创建日期|建立日期|作成日
Location|位置|位置|場所
Latitude|纬度|緯度|緯度
Longitude|经度|經度|経度
Altitude|海拔|海拔|高度
City|城市|城市|市区町村
State or province|州或省|州或省|都道府県・州
Country|国家或地区|國家或地區|国・地域
Image|图像|影像|画像
Width|宽度|寬度|幅
Height|高度|高度|高さ
Resolution|分辨率|解析度|解像度
Orientation|方向|方向|向き
Color space|色彩空间|色彩空間|色空間
Bits per sample|每样本位数|每樣本位元數|サンプルあたりのビット数
Compression|压缩|壓縮|圧縮
Maker Notes|厂商备注|廠商備註|メーカーノート
Mechanical shutter count|机械快门次数|機械快門次數|メカシャッター回数
Image count|图像计数|影像計數|画像カウント
File number|文件编号|檔案編號|ファイル番号
Focus mode|对焦模式|對焦模式|フォーカスモード
Autofocus area|自动对焦区域|自動對焦區域|AF エリア
Vibration reduction|防抖|防震|手ぶれ補正
Picture style|照片风格|照片風格|ピクチャースタイル
Quality|画质|畫質|画質
Noise reduction|降噪|降噪|ノイズ低減
Active D-Lighting|动态 D-Lighting|動態 D-Lighting|アクティブ D-ライティング
Drive mode|驱动模式|驅動模式|ドライブモード
Release mode|释放模式|釋放模式|レリーズモード
File name|文件名|檔案名稱|ファイル名
MIME type|MIME 类型|MIME 類型|MIME タイプ
File modified|文件修改时间|檔案修改時間|ファイルの更新日時
Not defined|未定义|未定義|未定義
Program|程序自动|程式自動|プログラム
Aperture priority|光圈优先|光圈優先|絞り優先
Shutter priority|快门优先|快門優先|シャッター優先
Creative|创意|創意|クリエイティブ
Portrait|人像|人像|ポートレート
Landscape|风景|風景|風景
Auto|自动|自動|オート
Auto bracket|自动包围|自動包圍|オートブラケット
Unknown|未知|未知|不明
Average|平均|平均|平均
Center-weighted|中央重点|中央重點|中央重点
Spot|点测光|點測光|スポット
Multi-spot|多点测光|多點測光|マルチスポット
Multi-segment|多区域|多區域|分割測光
Partial|局部|局部|部分
Standard|标准|標準|標準
Night|夜景|夜景|夜景
Normal|正常|正常|標準
Mirrored|镜像|鏡像|左右反転
Rotated 180°|旋转 180°|旋轉 180°|180° 回転
Mirrored vertically|垂直镜像|垂直鏡像|上下反転
Mirrored, rotated 90° left|镜像并向左旋转 90°|鏡像並向左旋轉 90°|左右反転して左に 90° 回転
Rotated 90° right|向右旋转 90°|向右旋轉 90°|右に 90° 回転
Mirrored, rotated 90° right|镜像并向右旋转 90°|鏡像並向右旋轉 90°|左右反転して右に 90° 回転
Rotated 90° left|向左旋转 90°|向左旋轉 90°|左に 90° 回転
sRGB|sRGB|sRGB|sRGB
Adobe RGB|Adobe RGB|Adobe RGB|Adobe RGB
Uncalibrated|未校准|未校準|未キャリブレーション
Uncompressed|未压缩|未壓縮|非圧縮
JPEG|JPEG|JPEG|JPEG
Lossy JPEG (DNG)|有损 JPEG（DNG）|有損 JPEG（DNG）|非可逆 JPEG（DNG）
Flash fired|闪光灯已闪光|閃光燈已閃光|フラッシュ発光
No flash|未闪光|未閃光|フラッシュなし
Checking…|检查中…|檢查中…|確認中…
Receiving files|正在接收文件|正在接收檔案|ファイルを受信中
Checking folder layout|正在检查文件夹结构|正在檢查資料夾結構|フォルダー構成を確認中
Cleaning up|正在清理|正在清理|クリーンアップ中
from {name}|来自 {name}|來自 {name}|{name} から
from {name} (+{count} more)|来自 {name}（另有 {count} 个）|來自 {name}（另有 {count} 個）|{name} から（ほか {count} 件）
{completed} of {total} files|{completed}/{total} 个文件|{completed}/{total} 個檔案|{total} 件中 {completed} 件
{completed} of {total} files · {size} of {totalSize}|{completed}/{total} 个文件 · {size}/{totalSize}|{completed}/{total} 個檔案 · {size}/{totalSize}|{total} 件中 {completed} 件 · {totalSize} 中 {size}
Destination status|目标磁盘状态|目標磁碟狀態|保存先の状態
Destination progress|目标磁盘进度|目標磁碟進度|保存先の進行状況
Diagnostics|诊断|診斷|診断
Log detail|日志详细程度|記錄詳細程度|ログの詳細度
Detailed|详细|詳細|詳細
Trace|跟踪|追蹤|トレース
Nothing is recorded.|不记录任何内容。|不記錄任何內容。|何も記録しません。
Records settings changes, job phases, every file the app deletes, and errors.|记录设置更改、任务阶段、应用删除的每个文件以及错误。|記錄設定變更、工作階段、App 刪除的每個檔案以及錯誤。|設定の変更、ジョブの段階、アプリが削除したすべてのファイル、エラーを記録します。
Also records each file's steps and decisions, drives, memory and timing.|同时记录每个文件的处理步骤和决定、驱动器、内存及耗时。|同時記錄每個檔案的處理步驟與決定、磁碟機、記憶體及耗時。|各ファイルの処理手順と判断、ドライブ、メモリ、所要時間も記録します。
Also records every routing decision and journal entry. Large; for troubleshooting.|同时记录每次归类决定和日志条目。体积较大，用于排查问题。|同時記錄每次歸類決定與日誌項目。體積較大，用於疑難排解。|すべての振り分け判断とジャーナルの項目も記録します。大きくなるため、問題の調査用です。
Open log folder|打开日志文件夹|開啟記錄檔資料夾|ログフォルダを開く
Copy latest log path|拷贝最新日志路径|拷貝最新記錄檔路徑|最新のログのパスをコピー
Export logs…|导出日志…|匯出記錄檔…|ログを書き出す…
Log size: {size}|日志大小：{size}|記錄檔大小：{size}|ログのサイズ：{size}
Logs stay on this Mac. They never include file contents or recovery keys.|日志只保存在这台 Mac 上，不含文件内容或恢复密钥。|記錄檔只保存在這台 Mac 上，不含檔案內容或復原金鑰。|ログはこの Mac にのみ保存され、ファイルの内容や復元キーは含まれません。
`;
export const translationCatalogs: Record<Exclude<Language, 'en'>, Record<string, string>> = { 'zh-Hans': {}, 'zh-Hant': {}, ja: {} };
for (const row of rows.trim().split('\n').filter(Boolean)) {
  const [english, simplified, traditional, japanese] = row.split('|');
  translationCatalogs['zh-Hans'][english] = simplified;
  translationCatalogs['zh-Hant'][english] = traditional;
  translationCatalogs.ja[english] = japanese;
}
export type Translator = (english: string | Message, values?: Record<string, string | number>) => string;
export function createTranslator(language: Language): Translator {
  return (english, values) => {
    if (typeof english !== 'string') return formatMessage(english, language);
    const translated = language === 'en' ? english : Object.hasOwn(translationCatalogs[language] ?? {}, english) ? translationCatalogs[language][english] : english;
    return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) => values && Object.hasOwn(values, key) ? String(values[key]) : placeholder);
  };
}
export function formatNumber(value: number, language: Language, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(language, options).format(value);
}
export function formatBytes(value = 0, language: Language = 'en'): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const n = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1000)), 4));
  // Large sizes always keep their decimals ("1.00 TB", "994.7 GB") so capacity differences stay visible.
  const digits = n === 4 ? 2 : n > 1 ? 1 : 0;
  return `${formatNumber(value / 1000 ** n, language, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[n]}`;
}
/** 0 B/s, 1 KB/s, 2 MB/s, 3 GB/s: decimal units, like formatBytes. */
export type SpeedUnit = 0 | 1 | 2 | 3;
const speedUnits = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
/** The unit to show a speed in. Going up switches once 3 digits would round to 1000; going down only below 0.9
 * of the shown unit, so a speed hovering near a boundary keeps its unit ("0.980 MB/s", not 980 KB/s then 1.01 MB/s). */
export function speedUnit(value: number, previous?: SpeedUnit): SpeedUnit {
  if (!Number.isFinite(value) || value < 0) return previous ?? 0;
  let unit = 0;
  while (unit < 3 && Number((value / 1000 ** unit).toPrecision(3)) >= 1000) unit++;
  return (previous !== undefined && previous > unit && value >= .9 * 1000 ** previous ? previous : unit) as SpeedUnit;
}
/** A speed with 3 significant digits: "850 KB/s", "12.4 MB/s", "1.23 GB/s"; "—" when unknown. */
export function formatSpeed(value: number | undefined, language: Language = 'en', unit: SpeedUnit = speedUnit(value ?? Number.NaN)): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const options: Intl.NumberFormatOptions = unit === 0 ? { maximumFractionDigits: 0 } : { minimumSignificantDigits: 3, maximumSignificantDigits: 3 };
  return `${formatNumber(value / 1000 ** unit, language, options)} ${speedUnits[unit]}`;
}
function translationValue(language: Language) {
  return { language, t: createTranslator(language), formatNumber: (value: number) => formatNumber(value, language), formatBytes: (value = 0) => formatBytes(value, language) };
}
const I18nContext = createContext(translationValue('en'));
export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => translationValue(language), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useTranslation() { return useContext(I18nContext); }
