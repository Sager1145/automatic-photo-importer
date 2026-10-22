import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Language } from '../shared';
import { formatMessage, type Message } from '../messages';

export const localeNames: Record<Language, string> = { en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ja: '日本語' };
export const languages = Object.keys(localeNames) as Language[];
// English keys are also the fallback. Placeholder names and user data never pass through translation.
const rows = `
Copying files|正在复制文件|正在複製檔案|ファイルをコピー中
Verifying copied files|正在验证已复制文件|正在驗證已複製檔案|コピーしたファイルを検証中
Drive path|存储位置|儲存位置|保存場所

Drive details|详细信息|詳細資訊|詳細情報

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
Originals stay in the hidden recovery store. Resume uses this operation’s saved paths; start a new review to apply changed folder settings.|原文件保留在隐藏的恢复目录中。恢复会使用此操作保存的路径；要应用新的文件夹设置，请重新审核。|原始檔案保留在隱藏的復原目錄中。繼續會使用此操作儲存的路徑；要套用新的資料夾設定，請重新審核。|オリジナルは非表示の復旧領域に残ります。再開時はこの操作の保存済みパスを使用します。新しいフォルダー設定は、新たに確認して適用してください。

Photo Importer|照片导入器|照片匯入器|写真インポーター
Automatic Photo Importer|自动照片导入器|自動照片匯入器|自動写真インポーター
Opening your camera workbench…|正在打开相机工作台…|正在開啟相機工作台…|カメラワークベンチを開いています…
Try again|重试|重試|再試行
Your camera workbench|你的相机工作台|你的相機工作台|カメラのワークベンチ
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
Import in progress|正在导入|正在匯入|インポート中
Ready for your next shoot|准备好迎接下一次拍摄|準備好迎接下一次拍攝|次の撮影に備えて
Originals stay safe|原文件安全保留|原始檔案安全保留|オリジナルを安全に保管
Verified copies. Your camera files stay right where they are.|副本经过校验，相机中的原文件保持不动。|副本經過驗證，相機中的原始檔案保持不動。|コピーを検証し、カメラのファイルは元の場所に残します。
Watching for cameras|正在监测相机|正在監測相機|カメラの接続を監視中
Manual import|手动导入|手動匯入|手動インポート
Start imports|开始导入|開始匯入|インポート開始
Stop|停止|停止|停止
Automatic|自动|自動|自動
Preview photo and metadata|预览照片和元数据|預覽照片與中繼資料|写真とメタデータをプレビュー
Preview a photo and inspect its metadata|预览照片并查看元数据|預覽照片並檢視中繼資料|写真をプレビューしてメタデータを確認
Refresh connected sources|刷新已连接的来源|重新整理已連接的來源|接続中のソースを更新
Dismiss error|关闭错误提示|關閉錯誤提示|エラーを閉じる
Make it yours.|打造你的专属体验。|打造你的專屬體驗。|自分好みに設定。
Comfortable text, your preferred colors, and the way you import. Changes save automatically.|调整文字、颜色和导入方式，所有更改自动保存。|調整文字、顏色與匯入方式，所有變更自動儲存。|文字、色、インポート方法を調整できます。変更は自動保存されます。
Language|语言|語言|言語
App language|应用语言|應用程式語言|アプリの言語
Choose the language used throughout the app.|选择整个应用使用的语言。|選擇整個應用程式使用的語言。|アプリ全体で使用する言語を選択します。
Text & readability|文字与可读性|文字與可讀性|文字と読みやすさ
Text size|文字大小|文字大小|文字サイズ
Use larger text throughout the app. The comfortable default is 125%.|放大整个应用的文字，默认舒适大小为 125%。|放大整個應用程式的文字，預設舒適大小為 125%。|アプリ全体の文字を大きくします。標準は読みやすい125%です。
Your originals stay safe.|原文件安全保留。|原始檔案安全保留。|オリジナルを安全に保管します。
Review connected cameras, choose your backup drive, then start a verified import.|查看连接的相机，选择备份磁盘，然后开始校验导入。|檢視連接的相機，選擇備份磁碟，然後開始驗證匯入。|接続中のカメラを確認し、バックアップ先を選んで検証付きインポートを開始します。
Reset text size|重置文字大小|重設文字大小|文字サイズをリセット
Appearance & color|外观与颜色|外觀與顏色|外観と色
System follows your computer’s Light or Dark appearance. Choose a mode to keep it fixed.|系统模式跟随电脑的浅色或深色外观，也可选择固定模式。|系統模式跟隨電腦的淺色或深色外觀，也可選擇固定模式。|「システム」はコンピューターの外観に従います。固定するにはモードを選択します。
Import behavior|导入行为|匯入行為|インポート動作
Automatic import|自动导入|自動匯入|自動インポート
Queue newly connected camera sources after you choose a destination.|选择目标后，将新连接的相机来源加入队列。|選擇目的地後，將新連接的相機來源加入佇列。|保存先を選択すると、新しく接続したカメラをキューに追加します。
Parallel sources|并行来源|並行來源|同時処理ソース数
Settings maximum parallel sources|设置最大并行来源数|設定最大並行來源數|同時処理ソース数の上限設定
Lowering the limit lets active copies finish before another source starts. Folder paths and media rules are in Organization.|降低上限后，当前复制完成才会启动其他来源。文件夹路径和媒体规则位于「整理」。|降低上限後，目前複製完成才會啟動其他來源。資料夾路徑與媒體規則位於「整理」。|上限を下げると、実行中のコピー完了後に次のソースを開始します。フォルダーとメディアルールは「整理」にあります。
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
Transfers running|正在传输|正在傳輸|転送中
Review pending|等待审核|等待審核|確認待ち
Idle|空闲|閒置|待機中
Active / queued|活动 / 排队|進行中 / 排隊|実行中 / 待機中
Transfer speed|传输速度|傳輸速度|転送速度
Combined active sources|所有活动来源合计|所有進行中來源合計|実行中ソースの合計
No active transfers|没有正在进行的传输|沒有進行中的傳輸|転送は実行されていません
Transferred|已传输|已傳輸|転送済み
No transfer planned|尚无传输计划|尚無傳輸計畫|転送予定なし
Files checked|已检查的文件|已檢查的檔案|確認済みファイル
Destinations ready|已就绪的目标|已就緒的目的地|準備済みの保存先
Choose a backup destination|选择备份目标|選擇備份目的地|バックアップ先を選択
Combined copy progress|总体复制进度|整體複製進度|全体のコピー進捗
A destination is offline or still being checked. Reconnect it before importing.|目标离线或仍在检查中，请在导入前重新连接。|目的地離線或仍在檢查中，請在匯入前重新連接。|保存先がオフラインか確認中です。インポート前に再接続してください。
Review the proposed files and destinations, then apply or discard the plan.|审核建议的文件和目标，然后应用或放弃计划。|審核建議的檔案與目的地，然後套用或捨棄計畫。|対象ファイルと保存先を確認し、プランを適用または破棄してください。
Destination ready. Connect mounted camera storage or a memory card to begin.|目标已就绪，连接已挂载的相机存储或存储卡即可开始。|目的地已就緒，連接已掛載的相機儲存裝置或記憶卡即可開始。|保存先の準備ができました。マウント済みのカメラのストレージやメモリーカードを接続してください。
Choose destination|选择目标|選擇目的地|保存先を選択
Sources & queue|来源与队列|來源與佇列|ソースとキュー
Current copies finish before a lower limit takes effect.|当前复制完成后，降低的上限才会生效。|目前複製完成後，降低的上限才會生效。|上限の引き下げは実行中のコピー完了後に反映されます。
Maximum parallel sources|最大并行来源数|最大並行來源數|同時処理ソース数の上限
Connect camera storage or a memory card.|连接相机存储或存储卡。|連接相機儲存裝置或記憶卡。|カメラのストレージやメモリーカードを接続。
Mounted SD cards, CFexpress cards and camera storage appear here. Check your destination, then start importing.|已挂载的 SD 卡、CFexpress 卡和相机存储会显示在此处。确认目标后即可开始导入。|已掛載的 SD 卡、CFexpress 卡與相機儲存裝置會顯示於此。確認目的地後即可開始匯入。|マウント済みのSDカード、CFexpressカード、カメラのストレージをここに表示します。保存先を確認してインポートを開始してください。
Automatic import is watching for new connections.|自动导入正在监测新连接。|自動匯入正在監測新連接。|自動インポートで新しい接続を監視しています。
Automatic import is off. Use Start when you’re ready.|自动导入已关闭，准备好后点击「开始」。|自動匯入已關閉，準備好後點選「開始」。|自動インポートはオフです。準備ができたら開始してください。
Enable media folder selection|启用媒体文件夹选择|啟用媒體資料夾選擇|メディアフォルダーの選択を有効化
Choose media folders…|选择媒体文件夹…|選擇媒體資料夾…|メディアフォルダーを選択…
Bring an entire drive, too.|也能备份整个磁盘。|也能備份整個磁碟。|ドライブ全体もバックアップ。
Back up files in their original folders, including documents and other non-photo files.|按原有文件夹备份文件，包括文档和其他非照片文件。|依原有資料夾備份檔案，包括文件與其他非照片檔案。|文書などの写真以外のファイルも、元のフォルダー構造でバックアップします。
Back up drives or folders…|备份磁盘或文件夹…|備份磁碟或資料夾…|ドライブやフォルダーをバックアップ…
Backup files stay when originals disappear. Links and filesystem service files are skipped.|即使原文件消失，备份仍会保留。跳过链接和文件系统服务文件。|即使原始檔案消失，備份仍會保留。略過連結與檔案系統服務檔案。|元のファイルがなくなってもバックアップは残ります。リンクとファイルシステム用ファイルはスキップします。
Ready to import|准备导入|準備匯入|インポート可能
Discovering files|正在查找文件|正在尋找檔案|ファイルを検索中
Checking existing files|正在检查现有文件|正在檢查現有檔案|既存ファイルを確認中
Copying & verifying|正在复制并校验|正在複製並驗證|コピー・検証中
Complete|完成|完成|完了
Stopped|已停止|已停止|停止済み
Needs attention|需要处理|需要處理|確認が必要
Queued|已排队|已排隊|待機中
Folder backup|文件夹备份|資料夾備份|フォルダーバックアップ
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
Destinations|目标|目的地|保存先
Copy policy|复制策略|複製策略|コピー方式
One destination|单一目标|單一目的地|1つの保存先
Copy to both destinations|复制到两个目标|複製到兩個目的地|両方の保存先にコピー
Fill first, then second|先存满第一块再用第二块|先存滿第一顆再用第二顆|1台目から順に保存
Save one verified copy to your selected destination.|在所选目标保存一份经过校验的副本。|在所選目的地儲存一份經過驗證的副本。|選択した保存先に検証済みコピーを1つ保存します。
Save and verify a copy on both drives. Both must be available.|在两个磁盘上分别保存并校验副本，两个磁盘都必须可用。|在兩個磁碟上分別儲存並驗證副本，兩個磁碟都必須可用。|両方のドライブにコピーして検証します。両方の接続が必要です。
Use the first drive’s space, then continue on the second. Related files stay together.|先使用第一块磁盘，再继续使用第二块。关联文件保存在一起。|先使用第一顆磁碟，再繼續使用第二顆。相關檔案儲存在一起。|1台目の空き容量を使い、その後2台目に続けます。関連ファイルはまとめて保存します。
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
Change…|更改…|變更…|変更…
Choose location…|选择位置…|選擇位置…|場所を選択…
Show in file manager|在文件管理器中显示|在檔案管理員中顯示|ファイルマネージャーで表示
Remove destination|移除目标|移除目的地|保存先を削除
Every copy is verified. Files already on a destination are kept.|每份副本都会校验，目标中的现有文件予以保留。|每份副本都會驗證，目的地中的現有檔案予以保留。|すべてのコピーを検証し、保存先の既存ファイルは保持します。
{used} of {total} used|已用 {used}，共 {total}|已用 {used}，共 {total}|{total} 中 {used} 使用済み
{used} used, {free} free, {total} total|已用 {used}，可用 {free}，总计 {total}|已用 {used}，可用 {free}，總計 {total}|使用済み {used}、空き {free}、合計 {total}
Other or unscanned|其他或未扫描|其他或未掃描|その他・未スキャン
Used|已用|已用|使用済み
Media categories use scanned file sizes.|媒体分类按扫描文件大小估算。|媒體分類依掃描檔案大小估算。|メディア分類はスキャンしたファイルサイズに基づきます。
Media storage by format|各格式媒体容量|各格式媒體容量|形式別のメディア容量
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
Video|视频|影片|動画
Companion|伴随文件|伴隨檔案|関連ファイル
No files match this filter.|没有符合此筛选条件的文件。|沒有符合此篩選條件的檔案。|条件に一致するファイルはありません。
Showing the first 500 matches. Search to narrow the file list.|显示前 500 项匹配结果，请搜索以缩小范围。|顯示前 500 項符合結果，請搜尋以縮小範圍。|最初の500件を表示しています。検索で絞り込んでください。
Select a filename to preview its image and EXIF metadata.|选择文件名以预览图像和 EXIF 元数据。|選擇檔名以預覽影像與 EXIF 中繼資料。|ファイル名を選ぶと画像とEXIFメタデータを表示します。
Other file rules|其他文件规则|其他檔案規則|その他のファイルルール
Companions stay with their photos automatically. Choose what happens to unrecognized files.|伴随文件会自动与照片保存在一起。请选择如何处理无法识别的文件。|伴隨檔案會自動與照片儲存在一起。請選擇如何處理無法識別的檔案。|関連ファイルは自動で写真と一緒に保存します。未認識ファイルの処理を選択してください。
Extension|扩展名|副檔名|拡張子
No extension|无扩展名|無副檔名|拡張子なし
Action|操作|操作|操作
Ignore|忽略|忽略|無視
Copy to folder|复制到文件夹|複製到資料夾|フォルダーにコピー
Folder beneath each destination|每个目标下的文件夹|每個目的地下的資料夾|各保存先内のフォルダー
Use a relative folder without empty components, . or ..|请输入相对文件夹路径，不能包含空段、. 或 ..|請輸入相對資料夾路徑，不能包含空段、. 或 ..|空の要素、.、.. を含まない相対フォルダーを指定してください。
Remember for this extension|记住此扩展名的规则|記住此副檔名的規則|この拡張子のルールを保存
Apply rule|应用规则|套用規則|ルールを適用
Rules without Remember apply to this session. Recheck the source to use changed rules.|未记住的规则仅适用于本次会话。重新检查来源以使用更改后的规则。|未記住的規則僅適用於本次工作階段。重新檢查來源以使用變更後的規則。|保存しないルールは今回のみ適用します。変更後のルールはソースの再確認で反映します。
Make room for every shoot.|让每次拍摄井然有序。|讓每次拍攝井然有序。|すべての撮影を整理。
Choose where originals land and how your collection grows.|选择原文件的存放位置和照片库的整理方式。|選擇原始檔案的存放位置與照片庫的整理方式。|オリジナルの保存先とコレクションの整理方法を選択します。
Finish or discard the current review, or wait for active transfers, before changing import settings.|更改导入设置前，请完成或放弃当前审核，或等待传输结束。|變更匯入設定前，請完成或捨棄目前審核，或等待傳輸結束。|設定を変更するには、確認を完了・破棄するか、転送の完了を待ってください。
Backup location|备份位置|備份位置|バックアップ先
The same folder structure is used at each destination.|每个目标使用相同的文件夹结构。|每個目的地使用相同的資料夾結構。|各保存先で同じフォルダー構造を使用します。
No destination selected|未选择目标|未選擇目的地|保存先未選択
Choose a drive or folder to begin.|选择磁盘或文件夹即可开始。|選擇磁碟或資料夾即可開始。|ドライブやフォルダーを選択してください。
Backup folder|备份文件夹|備份資料夾|バックアップフォルダー
A folder inside each destination. Leave empty to use the destination itself.|每个目标内的文件夹。留空则直接使用目标。|每個目的地內的資料夾。留空則直接使用目的地。|各保存先内のフォルダーです。空欄にすると保存先を直接使用します。
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
Edited exports folder|编辑导出文件夹|編輯匯出資料夾|編集済み書き出しフォルダー
Editor-exported photos go in this folder within each month. RAW originals and XMP stay together.|编辑器导出的照片会保存在每月目录中的此文件夹内。RAW 原片和 XMP 保存在一起。|編輯器匯出的照片會儲存在每月目錄中的此資料夾內。RAW 原始檔與 XMP 儲存在一起。|編集ソフトから書き出した写真を各月のこのフォルダーに保存します。RAWの原本とXMPは一緒に保存します。
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
Example: Nikon Z6III · 20 October 2026|示例：Nikon Z6III · 2026年10月20日|範例：Nikon Z6III · 2026年10月20日|例：Nikon Z6III · 2026年10月20日
Sources & automation|来源与自动化|來源與自動化|ソースと自動化
Keep control over what enters your collection.|掌控进入照片库的内容。|掌控進入照片庫的內容。|コレクションに取り込む内容を管理します。
Import new camera connections|导入新连接的相机|匯入新連接的相機|新しく接続したカメラをインポート
Watch for cameras while Photo Importer is open. Existing files are checked on each import.|应用开启时监测相机，每次导入都会检查现有文件。|應用程式開啟時監測相機，每次匯入都會檢查現有檔案。|アプリを開いている間、カメラを監視します。毎回既存ファイルを確認します。
Choose a media folder manually|手动选择媒体文件夹|手動選擇媒體資料夾|メディアフォルダーを手動で選択
Enable folder selection on the import desk. Ordinary hard drives are never imported automatically.|在导入工作台启用文件夹选择，普通硬盘不会自动导入。|在匯入工作台啟用資料夾選擇，一般硬碟不會自動匯入。|インポート画面でフォルダー選択を有効にします。通常のドライブは自動インポートしません。
Remember how to handle unrecognized extensions. Photo and video companions stay together automatically.|记住无法识别的扩展名的处理方式，照片和视频伴随文件会自动保存在一起。|記住無法識別的副檔名的處理方式，照片與影片伴隨檔案會自動儲存在一起。|未認識の拡張子の処理方法を保存します。写真・動画の関連ファイルは自動でまとめます。
Edit|编辑|編輯|編集
No saved rules. Unrecognized files are ignored during camera imports.|尚无保存的规则。相机导入时忽略无法识别的文件。|尚無儲存的規則。相機匯入時忽略無法識別的檔案。|保存済みルールはありません。カメラのインポートでは未認識ファイルを無視します。
File extension|文件扩展名|檔案副檔名|ファイル拡張子
For example, PDF|例如 PDF|例如 PDF|例：PDF
Leave empty for files without an extension.|无扩展名的文件请留空。|無副檔名的檔案請留空。|拡張子のないファイルは空欄にします。
Copy to custom folder|复制到自定义文件夹|複製到自訂資料夾|指定フォルダーにコピー
Relative folder|相对文件夹|相對資料夾|相対フォルダー
Saved for future imports|已保存供后续导入使用|已儲存供後續匯入使用|次回以降のインポートに保存
Save rule|保存规则|儲存規則|ルールを保存
Existing collection|现有照片库|現有照片庫|既存コレクション
Review where files in your library belong before applying the current folder structure.|应用当前文件夹结构前，审核照片库内文件的归属位置。|套用目前資料夾結構前，審核照片庫內檔案的歸屬位置。|現在の構造を適用する前に、ライブラリ内の保存先を確認します。
Scan your first backup destination and review every proposed path. Identical files already at a destination are kept.|扫描第一备份目标并审核每个建议路径，保留目标中已有的相同文件。|掃描第一備份目的地並審核每個建議路徑，保留目的地中已有的相同檔案。|1つ目のバックアップ先をスキャンし、予定パスを確認します。保存先の同一ファイルは保持します。
Preview library reorganization…|预览照片库重新整理…|預覽照片庫重新整理…|ライブラリの整理をプレビュー…
Choose One destination on the import desk to reorganize an existing library.|在导入工作台选择「单一目标」即可重新整理现有照片库。|在匯入工作台選擇「單一目的地」即可重新整理現有照片庫。|既存ライブラリを整理するには、インポート画面で「1つの保存先」を選択してください。
Changes are saved automatically. Your source files are never deleted.|更改自动保存，来源文件永远不会被删除。|變更自動儲存，來源檔案永遠不會被刪除。|変更は自動保存されます。ソースのファイルは削除しません。
Every shoot, accounted for.|记录每一次拍摄。|記錄每一次拍攝。|すべての撮影を記録。
Your recent import sessions, from first frame to verified copy.|近期导入会话，从第一帧到校验副本一目了然。|近期匯入工作階段，從第一張到驗證副本一目瞭然。|最初の1枚から検証済みコピーまで、最近のインポートを記録します。
Your collection starts here.|照片库从这里开始。|照片庫從這裡開始。|コレクションはここから。
Completed imports and drive backups will appear in this timeline.|完成的导入和磁盘备份会显示在此时间线中。|完成的匯入與磁碟備份會顯示於此時間軸。|完了したインポートとドライブのバックアップがここに表示されます。
Go to import desk|前往导入工作台|前往匯入工作台|インポート画面へ
Stopped by user|用户已停止|使用者已停止|ユーザーが停止
Session recorded|已记录会话|已記錄工作階段|セッション記録済み
Photo & metadata|照片与元数据|照片與中繼資料|写真とメタデータ
Close photo preview|关闭照片预览|關閉照片預覽|写真プレビューを閉じる
Reading photo metadata…|正在读取照片元数据…|正在讀取照片中繼資料…|写真のメタデータを読み込み中…
Could not read this file|无法读取此文件|無法讀取此檔案|ファイルを読み込めませんでした
Image preview unavailable|无法预览图像|無法預覽影像|画像プレビューを表示できません
This file does not contain a supported image preview. Available metadata is shown.|此文件不包含支持的图像预览。可用的元数据仍会显示。|此檔案不含支援的影像預覽。仍會顯示可用的中繼資料。|このファイルに対応する画像プレビューはありません。取得できたメタデータを表示します。
Show this file in file manager|在文件管理器中显示此文件|在檔案管理員中顯示此檔案|このファイルをファイルマネージャーで表示
EXIF metadata|EXIF 元数据|EXIF 中繼資料|EXIFメタデータ
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
Preview reads your file without changing it.|预览只读取文件，不会更改文件。|預覽僅讀取檔案，不會變更檔案。|プレビューでは読み取りのみ行い、ファイルは変更しません。
Done|完成|完成|完了
Building your file review…|正在生成文件审核…|正在產生檔案審核…|ファイル確認を準備中…
Reading metadata and checking destinations. No files are being copied or moved.|正在读取元数据并检查目标，尚未复制或移动文件。|正在讀取中繼資料並檢查目的地，尚未複製或移動檔案。|メタデータと保存先を確認しています。コピーや移動は行っていません。
Cancel review|取消审核|取消審核|確認をキャンセル
Review before reorganizing|整理前审核|整理前審核|整理前に確認
Review before copying|复制前审核|複製前審核|コピー前に確認
Your collection, reorganized.|重新整理你的照片库。|重新整理你的照片庫。|コレクションを整理。
Check the proposed paths below. Changes start when you apply this review.|检查下方建议路径。应用此次审核后才开始更改。|檢查下方建議路徑。套用此次審核後才開始變更。|予定パスを確認してください。適用すると変更が始まります。
Check the destination for each file. Copying starts when you apply this review.|检查每个文件的目标。应用此次审核后开始复制。|檢查每個檔案的目的地。套用此次審核後開始複製。|各ファイルの保存先を確認してください。適用するとコピーが始まります。
Ready to review|准备审核|準備審核|確認可能
Find a source, destination or checksum…|查找来源、目标或校验和…|尋找來源、目的地或校驗碼…|ソース・保存先・チェックサムを検索…
Search reviewed files|搜索审核文件|搜尋審核檔案|確認対象ファイルを検索
Source|来源|來源|ソース
Destination|目标|目的地|保存先
Type / size|类型 / 大小|類型 / 大小|種類 / サイズ
Checksum|校验和|校驗碼|チェックサム
Keep verified|保留已校验文件|保留已驗證檔案|検証済みを保持
Move|移动|移動|移動
Copy|复制|複製|コピー
No files need to be processed.|没有需要处理的文件。|沒有需要處理的檔案。|処理が必要なファイルはありません。
No files match this search.|没有匹配的文件。|沒有符合的檔案。|検索に一致するファイルはありません。
Previous|上一页|上一頁|前へ
Next|下一页|下一頁|次へ
Identical duplicates stay in place. Every proposed move is shown above.|相同的重复文件保留原位，所有计划移动均已列出。|相同的重複檔案保留原位，所有計畫移動均已列出。|同一の重複ファイルは元の場所に残します。移動予定はすべて上記に表示しています。
Original files stay on your source. Copies are verified.|原文件保留在来源中，副本经过校验。|原始檔案保留在來源中，副本經過驗證。|オリジナルはソースに残し、コピーを検証します。
Discard review|放弃审核|捨棄審核|確認を破棄
Apply reviewed moves|应用已审核的移动|套用已審核的移動|確認した移動を適用
Copy reviewed files|复制已审核的文件|複製已審核的檔案|確認したファイルをコピー
Organize existing files…|整理现有文件…|整理現有檔案…|既存ファイルを整理…
Scan media|扫描媒体|掃描媒體|メディアをスキャン
Scan all sources|扫描所有来源|掃描所有來源|すべてのソースをスキャン
Resume & recheck|继续并重新检查|繼續並重新檢查|再開して再確認
Recheck organization|重新检查整理结果|重新檢查整理結果|整理を再確認
Pictures|图片|圖片|写真
Videos|视频|影片|動画
Extension breakdown|按扩展名统计|依副檔名統計|拡張子別の内訳
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
Choose what happens when files disappear from a backed-up drive.|选择已备份驱动器上的文件消失后如何处理。|選擇已備份磁碟上的檔案消失後如何處理。|バックアップ済みドライブからファイルが消えたときの扱いを選択します。
Drive backup mode|驱动器备份模式|磁碟備份模式|ドライブのバックアップモード
Additive|只增不删|只增不刪|追加のみ
Mirror|镜像|鏡像|ミラー
Keep files on the backup even after they're deleted from the drive.|即使文件已从驱动器删除，也保留在备份中。|即使檔案已從磁碟刪除，也保留在備份中。|ドライブから削除されたファイルもバックアップに残します。
Make the backup match the drive. Files no longer on the drive, or changed since the last backup, are moved to Drive backups/.mirror-removed on that destination after you review them. Nothing is permanently deleted.|让备份与驱动器保持一致。驱动器上已不存在或自上次备份后已更改的文件，会在你审核后移到该目标的 Drive backups/.mirror-removed。不会永久删除任何文件。|讓備份與磁碟保持一致。磁碟上已不存在或自上次備份後已變更的檔案，會在你審核後移到該目的地的 Drive backups/.mirror-removed。不會永久刪除任何檔案。|バックアップをドライブと一致させます。ドライブにもう存在しないファイルや前回のバックアップ以降に変更されたファイルは、確認後にその保存先の Drive backups/.mirror-removed へ移動されます。完全に削除されるものはありません。
Mirror can’t be combined with Fill first, then second. Choose another copy policy to use Mirror.|镜像不能与“先存满第一块再用第二块”同时使用。请选择其他复制策略以使用镜像。|鏡像不能與「先存滿第一顆再用第二顆」同時使用。請選擇其他複製策略以使用鏡像。|ミラーは「1台目から順に保存」と併用できません。ミラーを使うには別のコピー方式を選択してください。
Fill first, then second is unavailable while drive backups use Mirror.|驱动器备份使用镜像时，无法使用“先存满第一块再用第二块”。|磁碟備份使用鏡像時，無法使用「先存滿第一顆再用第二顆」。|ドライブのバックアップがミラーの間は「1台目から順に保存」は使用できません。
Drive backups are saved in {path} on each destination.|驱动器备份保存在每个目标的 {path} 中。|磁碟備份儲存在每個目的地的 {path} 中。|ドライブのバックアップは各保存先の {path} に保存されます。
Drive backups are saved here on each destination|驱动器备份保存在每个目标的此位置|磁碟備份儲存在每個目的地的此位置|ドライブのバックアップは各保存先のここに保存されます
Mirror backup: the backup matches the drive. Removed or changed files move to .mirror-removed after you review them.|镜像备份：备份与驱动器保持一致。已删除或已更改的文件会在你审核后移到 .mirror-removed。|鏡像備份：備份與磁碟保持一致。已刪除或已變更的檔案會在你審核後移到 .mirror-removed。|ミラーバックアップ：バックアップをドライブと一致させます。削除・変更されたファイルは確認後に .mirror-removed へ移動します。
Review the files Mirror will move before this backup can continue.|请先审核镜像将要移动的文件，然后才能继续此备份。|請先審核鏡像將要移動的檔案，然後才能繼續此備份。|このバックアップを続行する前に、ミラーで移動されるファイルを確認してください。
{count} files will be moved to .mirror-removed|{count} 个文件将移到 .mirror-removed|{count} 個檔案將移到 .mirror-removed|{count} 件のファイルが .mirror-removed へ移動されます
Nothing is permanently deleted. Moved files stay in Drive backups/.mirror-removed on this destination.|不会永久删除任何文件。移动的文件保留在此目标的 Drive backups/.mirror-removed 中。|不會永久刪除任何檔案。移動的檔案保留在此目的地的 Drive backups/.mirror-removed 中。|完全に削除されるものはありません。移動したファイルはこの保存先の Drive backups/.mirror-removed に残ります。
Drive folder: {folder}|驱动器文件夹：{folder}|磁碟資料夾：{folder}|ドライブフォルダー：{folder}
Reason|原因|原因|理由
No longer on the drive|驱动器上已不存在|磁碟上已不存在|ドライブにもう存在しません
Replaced by a newer version|已被较新版本取代|已被較新版本取代|新しいバージョンに置き換えられました
Unknown files|未知文件|未知檔案|不明なファイル
Skip automatically|自动跳过|自動略過|自動的にスキップ
Copy to Other files folder|复制到“其他文件”文件夹|複製到「其他檔案」資料夾|「その他のファイル」フォルダーにコピー
Ask me|询问我|詢問我|確認する
Unknown files stay on the source and are not copied. They are listed in drive details, not reported as errors.|未知文件保留在来源上，不会被复制。它们会列在详细信息中，不会作为错误报告。|未知檔案保留在來源上，不會被複製。它們會列在詳細資訊中，不會作為錯誤回報。|不明なファイルはソースに残り、コピーされません。詳細情報に一覧表示され、エラーとしては報告されません。
Unknown files are copied to an Other files folder on each destination.|未知文件会复制到每个目标上的“其他文件”文件夹。|未知檔案會複製到每個目的地上的「其他檔案」資料夾。|不明なファイルは各保存先の「その他のファイル」フォルダーにコピーされます。
Unknown formats appear in All errors so you can decide for each extension.|未知格式会显示在“所有错误”中，供你按扩展名逐一决定。|未知格式會顯示在「所有錯誤」中，供你依副檔名逐一決定。|不明な形式は「すべてのエラー」に表示され、拡張子ごとに扱いを決められます。
Camera system files, such as card indexes, are always skipped. Rules saved below for specific extensions take priority.|卡索引等相机系统文件始终会被跳过。下方为特定扩展名保存的规则优先。|卡片索引等相機系統檔案一律略過。下方為特定副檔名儲存的規則優先。|カードのインデックスなどのカメラのシステムファイルは常にスキップされます。下に保存した拡張子ごとのルールが優先されます。
No saved rules. The setting above applies to every unknown extension.|没有已保存的规则。上方设置适用于所有未知扩展名。|沒有已儲存的規則。上方設定適用於所有未知副檔名。|保存されたルールはありません。上の設定がすべての不明な拡張子に適用されます。
Skipped {count} camera system files ({names})|已跳过 {count} 个相机系统文件（{names}）|已略過 {count} 個相機系統檔案（{names}）|カメラのシステムファイル {count} 件をスキップ（{names}）
{count} unknown files skipped|已跳过 {count} 个未知文件|已略過 {count} 個未知檔案|不明なファイル {count} 件をスキップ
{count} unknown files copied to other folders|{count} 个未知文件复制到其他文件夹|{count} 個未知檔案複製到其他資料夾|不明なファイル {count} 件を別フォルダーにコピー
Camera system files|相机系统文件|相機系統檔案|カメラのシステムファイル
Card indexes and housekeeping data written by the camera or card. Your photos and videos never need them.|由相机或存储卡写入的索引和管理数据。你的照片和视频不需要它们。|由相機或記憶卡寫入的索引與管理資料。你的照片和影片不需要它們。|カメラやカードが書き込むインデックスや管理用データです。写真や動画の閲覧には必要ありません。
Not photos, videos or known companions. Choose how they are handled in Settings.|不是照片、视频或已知伴随文件。可在设置中选择处理方式。|不是照片、影片或已知伴隨檔案。可在設定中選擇處理方式。|写真、動画、既知の関連ファイルのいずれでもありません。扱い方は設定で選べます。
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
Looks like a camera card: it has camera folders such as DCIM.|看起来是相机存储卡：包含 DCIM 等相机文件夹。|看起來是相機記憶卡：包含 DCIM 等相機資料夾。|カメラのカードのようです：DCIM などのカメラフォルダーがあります。
Not recognized as a camera card: no camera folders such as DCIM were found.|未识别为相机存储卡：没有找到 DCIM 等相机文件夹。|未辨識為相機記憶卡：沒有找到 DCIM 等相機資料夾。|カメラのカードとして認識されません：DCIM などのカメラフォルダーが見つかりません。
Drives you import from are remembered and selected automatically next time. Change this on the source card or in Settings.|你选择导入的驱动器会被记住，下次自动选中。可在来源卡片或设置中更改。|你選擇匯入的磁碟會被記住，下次自動選取。可在來源卡片或設定中變更。|読み込むと選んだドライブは記憶され、次回は自動的に選択されます。ソースカードまたは設定で変更できます。
Not selected · won't be imported|未选中 · 不会导入|未選取 · 不會匯入|未選択 · 読み込みません
Import this drive|导入此驱动器|匯入此磁碟|このドライブを読み込む
Start imports ({count})|开始导入（{count}）|開始匯入（{count}）|インポート開始（{count}）
Remembered drives|已记住的驱动器|已記住的磁碟|記憶したドライブ
Drives you chose to import from are selected automatically when they connect again.|你选择导入过的驱动器再次连接时会自动选中。|你選擇匯入過的磁碟再次連接時會自動選取。|読み込むと選んだドライブは、再接続時に自動的に選択されます。
Last selected {date}|上次选中：{date}|上次選取：{date}|最終選択：{date}
Forget|忘记|忘記|削除
Forget {name}|忘记 {name}|忘記 {name}|{name} を削除
No remembered drives yet. You'll be asked about each new drive when it connects.|还没有已记住的驱动器。每个新驱动器连接时都会询问你。|還沒有已記住的磁碟。每個新磁碟連接時都會詢問你。|記憶したドライブはまだありません。新しいドライブを接続するたびに確認します。
File metadata|文件元数据|檔案中繼資料|ファイルのメタデータ
Close metadata|关闭元数据|關閉中繼資料|メタデータを閉じる
Reading metadata never changes your file.|读取元数据不会更改你的文件。|讀取中繼資料不會變更你的檔案。|メタデータの読み取りでファイルが変更されることはありません。
Show metadata for {name}|显示 {name} 的元数据|顯示 {name} 的中繼資料|{name} のメタデータを表示
Select a filename to see its EXIF metadata.|选择文件名以查看其 EXIF 元数据。|選擇檔名以查看其 EXIF 中繼資料。|ファイル名を選択すると EXIF メタデータを表示します。
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
Your answer is remembered. Change it any time in Drives.|你的选择会被记住，可随时在“驱动器”中更改。|你的選擇會被記住，可隨時在「磁碟」中變更。|選択は記憶されます。「ドライブ」でいつでも変更できます。
Select|选择|選取|選択
Don't import this drive|不导入此驱动器|不匯入此磁碟|このドライブを読み込まない
Pause|暂停|暫停|一時停止
Resume|继续|繼續|再開
Pause {name}|暂停 {name}|暫停 {name}|{name} を一時停止
Paused|已暂停|已暫停|一時停止中
Continue|继续|繼續|再開
{count} originals ({size}) are kept so this organization can be undone.|保留了 {count} 个原始文件（{size}），以便撤销此次整理。|保留了 {count} 個原始檔案（{size}），以便復原此次整理。|この整理を元に戻せるよう、元のファイル {count} 件（{size}）を保持しています。
Undo organization|撤销整理|復原整理|整理を元に戻す
Release {size}|释放 {size}|釋放 {size}|{size} を解放
Release {size}?|要释放 {size} 吗？|要釋放 {size} 嗎？|{size} を解放しますか？
The kept originals are permanently removed from this destination. After this, the organization can't be undone.|保留的原始文件将从此目标永久删除。之后将无法撤销此次整理。|保留的原始檔案將從此目的地永久刪除。之後將無法復原此次整理。|保持している元のファイルをこの保存先から完全に削除します。この後は整理を元に戻せません。
Cancel|取消|取消|キャンセル
Verify each copy after copying|复制后校验每个副本|複製後驗證每個副本|コピー後に各コピーを検証
Reads every copied file again and compares its checksum before it counts as done. Turning this off is faster but skips that second read; source checksums and change checks still apply.|在视为完成前，重新读取每个已复制文件并比对校验和。关闭后速度更快，但会跳过这次重读；来源校验和与变更检查仍会执行。|在視為完成前，重新讀取每個已複製檔案並比對總和檢查碼。關閉後速度更快，但會略過這次重讀；來源總和檢查碼與變更檢查仍會執行。|完了とみなす前に、コピーした各ファイルを読み直してチェックサムを照合します。オフにすると速くなりますが、この再読み込みを省略します。ソースのチェックサムと変更チェックは引き続き行われます。
Verification after copy is off|复制后校验已关闭|複製後驗證已關閉|コピー後の検証はオフです
{completed} of {total} files copied|已复制 {completed}/{total} 个文件|已複製 {completed}/{total} 個檔案|{total} 件中 {completed} 件をコピー済み
{completed} of {total} files verified|已校验 {completed}/{total} 个文件|已驗證 {completed}/{total} 個檔案|{total} 件中 {completed} 件を検証済み
{count} failed|{count} 个失败|{count} 個失敗|{count} 件失敗
Import steps|导入步骤|匯入步驟|読み込みの手順
Scanning|扫描|掃描|スキャン
Copying|复制|複製|コピー
Verifying|校验|驗證|検証
Already imported|已导入|已匯入|読み込み済み
All {count} files are in the backup and verified|全部 {count} 个文件已在备份中并通过校验|全部 {count} 個檔案已在備份中並通過驗證|{count} 件すべてがバックアップ済みで検証済みです
All files are in the backup and verified|所有文件已在备份中并通过校验|所有檔案已在備份中並通過驗證|すべてのファイルがバックアップ済みで検証済みです
Your backup folder is left out of this drive|此驱动器中的备份文件夹会被排除|此磁碟中的備份資料夾會被排除|このドライブ内のバックアップフォルダーは除外されます
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
No organization history.|没有整理记录。|沒有整理記錄。|整理の履歴はありません。
No remembered drives.|没有已记住的驱动器。|沒有已記住的磁碟。|記憶したドライブはありません。
No saved rules.|没有已保存的规则。|沒有已儲存的規則。|保存されたルールはありません。
Not available with Mirror.|镜像模式下不可用。|鏡像模式下不可用。|ミラーでは使用できません。
Not photos or videos. Change this in Settings.|不是照片或视频。可在设置中更改。|不是照片或影片。可在設定中變更。|写真でも動画でもありません。設定で変更できます。
Nothing is deleted; files go to .mirror-removed.|不会删除任何文件；文件会移到 .mirror-removed。|不會刪除任何檔案；檔案會移到 .mirror-removed。|何も削除されません。ファイルは .mirror-removed に移動します。
Nothing moves until you apply.|应用之前不会移动任何文件。|套用之前不會移動任何檔案。|適用するまで何も移動しません。
One verified copy.|一份校验过的副本。|一份驗證過的副本。|検証済みコピーを1つ保存します。
Reads each copy back to confirm it. Off is faster.|重新读取每个副本以确认无误。关闭会更快。|重新讀取每個副本以確認無誤。關閉會更快。|各コピーを読み直して確認します。オフにすると速くなります。
Review what Mirror will move to continue.|请先审核镜像将移动的文件再继续。|請先審核鏡像將移動的檔案再繼續。|続行するには、ミラーで移動するファイルを確認してください。
Settings are locked while importing or reviewing.|导入或审核期间设置已锁定。|匯入或審核期間設定已鎖定。|読み込み中または確認中は設定を変更できません。
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
Folders left empty after organizing are removed. Folders with files are kept.|整理后变空的文件夹会被删除，仍有文件的文件夹会保留。|整理後變空的資料夾會被刪除，仍有檔案的資料夾會保留。|整理後に空になったフォルダーは削除します。ファイルが残るフォルダーは残します。
Large sizes shrink to fit small windows.|窗口较小时，大字号会自动缩小以适应。|視窗較小時，大字級會自動縮小以符合。|ウィンドウが小さいときは大きな文字が自動で縮小されます。
Choose whether to import this drive.|请选择是否导入此驱动器。|請選擇是否匯入此磁碟。|このドライブを読み込むか選んでください。
Decide later|稍后决定|稍後決定|あとで決める
Organizing now|正在整理|正在整理|整理中
Preparing organization…|正在准备整理…|正在準備整理…|整理を準備中…
Organizing|正在整理|正在整理|整理中
Listing files|正在列出文件|正在列出檔案|ファイルを一覧中
Checking files|正在检查文件|正在檢查檔案|ファイルを確認中
{completed} files found|已找到 {completed} 个文件|已找到 {completed} 個檔案|{completed} 件見つかりました
{completed} files found · {size}|已找到 {completed} 个文件 · {size}|已找到 {completed} 個檔案 · {size}|{completed} 件見つかりました · {size}
{completed} of {total} files read · {size} of {totalSize}|已读取 {completed}/{total} 个文件 · {size}/{totalSize}|已讀取 {completed}/{total} 個檔案 · {size}/{totalSize}|{total} 件中 {completed} 件を読み込み · {totalSize} 中 {size}
Checking the earlier organization: {completed} of {total} records|正在检查之前的整理记录：{completed}/{total}|正在檢查先前的整理紀錄：{completed}/{total}|以前の整理記録を確認中：{total} 件中 {completed} 件
Confirming files before moving: {completed} of {total}|移动前确认文件：{completed}/{total}|移動前確認檔案：{completed}/{total}|移動前にファイルを確認中：{total} 件中 {completed} 件
Confirming|正在确认|正在確認|確認中
Reading files|正在读取文件|正在讀取檔案|ファイルを読み込み中
Reconnect it to choose.|重新连接后即可选择。|重新連接後即可選擇。|再接続すると選べます。
Unplugged|已拔出|已拔出|取り外し済み
{completed} of {total} files organized|已整理 {completed}/{total} 个文件|已整理 {completed}/{total} 個檔案|{total} 件中 {completed} 件を整理済み
{percent}% scanned|已扫描 {percent}%|已掃描 {percent}%|{percent}% スキャン済み
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
Details|详情|詳細資訊|詳細
{count} new issues|{count} 个新问题|{count} 個新問題|{count} 件の新しい問題
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
{completed} of {total} files checked|已检查 {completed}/{total} 个文件|已檢查 {completed}/{total} 個檔案|{total} 個中 {completed} 個のファイルを確認
{completed} of {total} files read|已读取 {completed}/{total} 个文件|已讀取 {completed}/{total} 個檔案|{total} 個中 {completed} 個のファイルを読み込み
{time} elapsed|已用时 {time}|已用時 {time}|経過時間 {time}
Took {time}|用时 {time}|用時 {time}|所要時間 {time}
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
After organizing|整理之后|整理之後|整理の後
Settings categories|设置类别|設定類別|設定のカテゴリ
Totals, speed and progress at the top of the Import desk.|在导入台顶部显示总数、速度和进度。|在匯入台頂部顯示總數、速度和進度。|読み込みデスクの上部に合計、速度、進行状況を表示します。
1 file outside your folder structure|1 个文件不在文件夹结构中|1 個檔案不在資料夾結構中|フォルダー構成の外に 1 個のファイル
Limit: {count} simultaneous|上限：同时 {count} 个|上限：同時 {count} 個|同時処理上限：{count}
of {size} planned|计划共 {size}|計畫共 {size}|予定 {size} 中
{complete} sources complete · {errors} need attention|{complete} 个来源完成 · {errors} 个需处理|{complete} 個來源完成 · {errors} 個需處理|{complete} 件完了 · {errors} 件要確認
{size} free across destinations|目标合计剩余 {size}|目的地合計剩餘 {size}|保存先の空き容量 {size}
{size} free|剩余 {size}|剩餘 {size}|空き {size}
{size} total|总计 {size}|總計 {size}|合計 {size}
Queue position {count}|队列位置 {count}|佇列位置 {count}|待機順 {count}
Review import from {name}|审核来自 {name} 的导入|審核來自 {name} 的匯入|{name} のインポートを確認
{name} copy progress|{name} 复制进度|{name} 複製進度|{name} のコピー進捗
{name} scanning|正在扫描 {name}|正在掃描 {name}|{name} をスキャン中
{completed} / {total} files|{completed} / {total} 个文件|{completed} / {total} 個檔案|{completed} / {total} ファイル
{count} files need attention|{count} 个文件需要处理|{count} 個檔案需要處理|{count} 件のファイルに確認が必要
Show first destination in file manager|在文件管理器中显示第一目标|在檔案管理員中顯示第一目的地|1つ目の保存先をファイルマネージャーで表示
Show second destination in file manager|在文件管理器中显示第二目标|在檔案管理員中顯示第二目的地|2つ目の保存先をファイルマネージャーで表示
Preview {name} and metadata|预览 {name} 和元数据|預覽 {name} 與中繼資料|{name} とメタデータをプレビュー
Companion to {name}|{name} 的伴随文件|{name} 的伴隨檔案|{name} の関連ファイル
Copy to {folder}|复制到 {folder}|複製到 {folder}|{folder} にコピー
Edit rule for {extension}|编辑 {extension} 的规则|編輯 {extension} 的規則|{extension} のルールを編集
files without an extension|无扩展名的文件|無副檔名的檔案|拡張子のないファイル
Preview of {name}|{name} 的预览|{name} 的預覽|{name} のプレビュー
{name}: import preview|{name}：导入预览|{name}：匯入預覽|{name}：インポートのプレビュー
{count} moves to write|待写入 {count} 次移动|待寫入 {count} 次移動|移動予定 {count} 件
{count} copies to write|待写入 {count} 份副本|待寫入 {count} 份副本|コピー予定 {count} 件
{count} already verified|{count} 个已校验|{count} 個已驗證|{count} 件検証済み
{size} to organize|待整理 {size}|待整理 {size}|整理予定 {size}
{size} to copy|待复制 {size}|待複製 {size}|コピー予定 {size}
Destination {count}: |目标 {count}：|目的地 {count}：|保存先 {count}：
Files {start}–{end} of {total}|文件 {start}–{end}，共 {total} 个|檔案 {start}–{end}，共 {total} 個|{total} 件中 {start}〜{end} 件
{count} sources ready. Use Start imports to check and copy their files.|{count} 个来源已就绪。点击「开始导入」检查并复制文件。|{count} 個來源已就緒。點選「開始匯入」檢查並複製檔案。|{count} 件のソースが準備済みです。「インポート開始」で確認とコピーを行います。
{count} sources processing. Originals stay on the source.|正在处理 {count} 个来源。原文件保留在来源中。|正在處理 {count} 個來源。原始檔案保留在來源中。|{count} 件を処理中です。オリジナルはソースに残ります。
{count} sources processing, {queued} waiting in the queue. Originals stay on the source.|正在处理 {count} 个来源，{queued} 个排队中。原文件保留在来源中。|正在處理 {count} 個來源，{queued} 個排隊中。原始檔案保留在來源中。|{count} 件を処理中、{queued} 件が待機中です。オリジナルはソースに残ります。
{count} sources connected. Choose a backup destination to enable imports.|已连接 {count} 个来源。选择备份目标以启用导入。|已連接 {count} 個來源。選擇備份目的地以啟用匯入。|{count} 件接続中です。バックアップ先を選ぶとインポートできます。
{count} sources connected. Choose two backup destinations to enable imports.|已连接 {count} 个来源。选择两个备份目标以启用导入。|已連接 {count} 個來源。選擇兩個備份目的地以啟用匯入。|{count} 件接続中です。2つのバックアップ先を選ぶとインポートできます。

Import controls|导入控制|匯入控制|インポート操作
Scan all|扫描全部|掃描全部|すべてスキャン
Scanning…|正在扫描…|正在掃描…|スキャン中…
Scan to see formats and counts|扫描以查看格式和数量|掃描以檢視格式與數量|スキャンで形式と件数を表示
Reading media formats and counts…|正在读取媒体格式和数量…|正在讀取媒體格式與數量…|メディアの形式と件数を取得中…
Use Review to inspect camera files. Read-only scans are unavailable over USB.|请使用「审核」检查相机文件。USB 连接不支持只读扫描。|請使用「審核」檢查相機檔案。USB 連接不支援唯讀掃描。|カメラのファイルは「確認」で調べてください。USB経由の読み取り専用スキャンには対応していません。
Read-only scans are unavailable over USB. Use Review to inspect camera files.|USB 连接不支持只读扫描，请使用「审核」检查相机文件。|USB 連接不支援唯讀掃描，請使用「審核」檢查相機檔案。|USB経由の読み取り専用スキャンには対応していません。「確認」でカメラのファイルを調べてください。
Read photo and video formats without copying files|只读取照片和视频格式，不复制文件|僅讀取照片與影片格式，不複製檔案|コピーせずに写真・動画の形式を確認
Media summary for {name}|{name} 的媒体摘要|{name} 的媒體摘要|{name} のメディア概要
{size} media|媒体 {size}|媒體 {size}|メディア {size}
Updating scan…|正在更新扫描…|正在更新掃描…|スキャンを更新中…
Photos|照片|照片|写真
{count} files · {size}|{count} 个文件 · {size}|{count} 個檔案 · {size}|{count} ファイル · {size}
No photos found.|未找到照片。|未找到照片。|写真が見つかりません。
No videos found.|未找到视频。|未找到影片。|動画が見つかりません。
Organize your collection.|整理你的照片库。|整理你的照片庫。|コレクションを整理。
Choose a folder structure, then review the changes to your existing files.|选择文件夹结构，然后审核现有文件的更改。|選擇資料夾結構，然後審核現有檔案的變更。|フォルダー構造を選び、既存ファイルへの変更を確認します。
Existing files, new structure|现有文件，全新结构|現有檔案，全新結構|既存ファイルを新しい構造に
Scan the selected destination and preview each existing path beside its proposed new path. Your current backup folder and folder structure settings are used.|扫描所选目标，对照预览现有路径和建议的新路径。使用当前备份文件夹和结构设置。|掃描所選目的地，對照預覽現有路徑與建議的新路徑。使用目前備份資料夾與結構設定。|選択した保存先をスキャンし、現在と新しいパスを並べて表示します。現在のバックアップフォルダーと構造設定を使用します。
Organization destination|整理目标|整理目的地|整理する保存先
Scan existing files in|扫描此处的现有文件|掃描此處的現有檔案|既存ファイルのスキャン先
New structure under|新结构的根目录|新結構的根目錄|新しい構造の保存先
Choose a backup location in Settings to begin.|在设置中选择备份位置即可开始。|在設定中選擇備份位置即可開始。|設定でバックアップ先を選択してください。
Preview first. When you apply the review, each new file is verified before its original is retained in a hidden recovery store on the same destination.|先预览。应用审核时，每个新文件都会先校验，然后将原文件保留在同一目标的隐藏恢复存储中。|先預覽。套用審核時，每個新檔案都會先驗證，然後將原始檔案保留在同一目的地的隱藏復原儲存區中。|まずプレビューしてください。適用時に新しいファイルを検証した後、元のファイルを同じ保存先の非表示の復元領域に保持します。
Organization recovery|整理恢复|整理復原|整理の復元
Needs recovery|需要恢复|需要復原|復元が必要
{completed} of {total} files verified|已校验 {completed} / {total} 个文件|已驗證 {completed} / {total} 個檔案|{total} 件中 {completed} 件検証済み
Originals are retained in the hidden recovery store after their new files are verified. Rechecking verifies the saved operation before continuing.|新文件校验后，原文件保留在隐藏恢复存储中。重新检查会在继续前验证已保存的操作。|新檔案驗證後，原始檔案保留在隱藏復原儲存區中。重新檢查會在繼續前驗證已儲存的操作。|新しいファイルの検証後、元のファイルを非表示の復元領域に保持します。再確認では保存済みの処理を検証してから続行します。
No saved organization operations found. Recheck after reconnecting a destination.|未找到已保存的整理操作。重新连接目标后再次检查。|未找到已儲存的整理操作。重新連接目的地後再次檢查。|保存された整理処理はありません。保存先を再接続して再確認してください。
Review your new folder structure|审核新的文件夹结构|審核新的資料夾結構|新しいフォルダー構造を確認
Compare existing and new paths. No files change until you apply this review.|对比现有路径和新路径，应用此次审核前不会更改文件。|對比現有路徑與新路徑，套用此次審核前不會變更檔案。|現在と新しいパスを比較してください。適用するまでファイルは変更しません。
{count} files to organize|待整理 {count} 个文件|待整理 {count} 個檔案|整理予定 {count} ファイル
Existing path|现有路径|現有路徑|現在のパス
New path|新路径|新路徑|新しいパス
Organize|整理|整理|整理
Apply reviewed organization|应用已审核的整理|套用已審核的整理|確認した整理を適用
Each new file is verified before its original is retained in a hidden recovery store on this destination.|每个新文件先经过校验，然后将原文件保留在此目标的隐藏恢复存储中。|每個新檔案先經過驗證，然後將原始檔案保留在此目的地的隱藏復原儲存區中。|新しいファイルを検証した後、元のファイルをこの保存先の非表示の復元領域に保持します。
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
{name}: {count} unrecognized files are excluded. Photo and video imports can continue.|{name}：已排除 {count} 个无法识别的文件。照片和视频导入可以继续。|{name}：已排除 {count} 個無法辨識的檔案。照片和影片匯入可以繼續。|{name}：不明な {count} ファイルを除外しています。写真と動画のインポートは続行できます。
Keep unknown files excluded|继续排除未知文件|繼續排除未知檔案|不明なファイルの除外を保存
This choice is remembered for each extension. Camera cards import only media and its companions.|此选择会按扩展名保存。相机卡仅导入媒体及其关联文件。|此選擇會依副檔名儲存。相機卡僅匯入媒體及其關聯檔案。|拡張子ごとにこの選択を保存します。カメラカードからはメディアと付随ファイルのみをインポートします。
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
Camera folders use a matching photo or video, or the card’s single confirmed camera. Mixed or unconfirmed cards use Unknown Camera.|相机文件夹使用匹配的照片或视频，或卡中唯一已确认的相机。混合或未确认的卡使用 Unknown Camera。|相機資料夾使用配對的照片或影片，或卡中唯一已確認的相機。混合或未確認的卡使用 Unknown Camera。|対応する写真・動画、またはカード内で唯一確認されたカメラを使用します。複数機種や未確認のカードでは Unknown Camera を使用します。
All errors|所有错误|所有錯誤|すべてのエラー
{count} errors|{count} 个错误|{count} 個錯誤|エラー {count} 件
Close panel|关闭面板|關閉面板|パネルを閉じる
No errors to show.|暂无错误。|目前沒有錯誤。|エラーはありません。
See All errors for details.|请在“所有错误”中查看详情。|請在「所有錯誤」中查看詳情。|詳細は「すべてのエラー」で確認できます。
Organize now|立即整理|立即整理|今すぐ整理
Review changes…|预览更改…|預覽變更…|変更を確認…
Library organization|媒体库整理|媒體庫整理|ライブラリの整理
Organization waits for queued imports to finish. Every new file is verified before its original is retained in the recovery store. Use Review changes to inspect the paths first.|整理会等待排队的导入完成。每个新文件都会经过验证，然后将原文件保留在恢复目录中。可使用“预览更改”先检查路径。|整理會等待佇列中的匯入完成。每個新檔案都會經過驗證，然後將原始檔案保留在復原目錄中。可使用「預覽變更」先檢查路徑。|整理は待機中のインポートが完了してから始まります。新しいファイルを検証してから、オリジナルを復旧領域に保持します。先にパスを確認するには「変更を確認」を使用してください。
How camera folders are chosen|如何选择相机文件夹|如何選擇相機資料夾|カメラ別フォルダーの選択方法
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
function translationValue(language: Language) {
  return { language, t: createTranslator(language), formatNumber: (value: number) => formatNumber(value, language), formatBytes: (value = 0) => formatBytes(value, language) };
}
const I18nContext = createContext(translationValue('en'));
export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => translationValue(language), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useTranslation() { return useContext(I18nContext); }
