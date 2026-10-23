import type {Language} from './shared';

/** Text the main process shows the user: a catalog key plus parameters, translated by the renderer.
 * `text` carries raw text (low-level errors, file names, history from earlier versions) unchanged. */
export const backendMessages={
 text:{en:'{text}','zh-Hans':'{text}','zh-Hant':'{text}',ja:'{text}'},

 'history.issuesSkipped':{en:'Skipped issues ({name}): {count}','zh-Hans':'已跳过的问题（{name}）：{count}','zh-Hant':'已略過的問題（{name}）：{count}',ja:'スキップした問題（{name}）：{count}'},
 'error.acknowledgeInvalid':{en:'These issues can no longer be skipped. Open All errors again.','zh-Hans':'这些问题已无法跳过。请重新打开“所有错误”。','zh-Hant':'這些問題已無法略過。請重新開啟「所有錯誤」。',ja:'これらの問題はスキップできなくなりました。「すべてのエラー」を開き直してください。'},
 'issue.group':{en:'{count} items need attention','zh-Hans':'{count} 项需要留意','zh-Hant':'{count} 項需要留意',ja:'{count} 件の確認が必要です'},
 'job.waiting':{en:'Waiting for an available slot','zh-Hans':'等待空闲的处理位置','zh-Hant':'等待空閒的處理位置',ja:'空きを待っています'},
 'job.waitingForImports':{en:'Waiting for imports to finish before organizing','zh-Hans':'等待导入完成后再整理','zh-Hant':'等待匯入完成後再整理',ja:'インポートの完了を待ってから整理します'},
 'job.stagingCamera':{en:'Downloading camera originals to a temporary staging folder','zh-Hans':'正在将相机原始文件下载到临时暂存文件夹','zh-Hant':'正在將相機原始檔案下載到暫存資料夾',ja:'カメラの元のファイルを一時フォルダーにダウンロード中'},
 'job.finding':{en:'Finding media without reading file contents','zh-Hans':'正在查找媒体文件（不读取文件内容）','zh-Hant':'正在尋找媒體檔案（不讀取檔案內容）',ja:'ファイルの内容を読まずにメディアを検索中'},
 'job.cameraDownload':{en:'Downloading camera files: {done} of {total}','zh-Hans':'正在下载相机文件：{done}/{total}','zh-Hant':'正在下載相機檔案：{done}/{total}',ja:'カメラのファイルをダウンロード中：{total} 件中 {done} 件'},
 'job.checkingSource':{en:'Checking source: {count} files · {file}','zh-Hans':'正在检查来源：{count} 个文件 · {file}','zh-Hant':'正在檢查來源：{count} 個檔案 · {file}',ja:'ソースを確認中：{count} ファイル · {file}'},
 'job.confirmingCandidates':{en:'Confirming possible duplicates: {count} of {total} · {file}','zh-Hans':'正在确认可能的重复文件：{count}/{total} · {file}','zh-Hant':'正在確認可能的重複檔案：{count}/{total} · {file}',ja:'重複の可能性があるファイルを確認中：{total} 件中 {count} 件 · {file}'},
 'job.removingDuplicates':{en:'Checking duplicates and setting them aside','zh-Hans':'正在检查重复文件并将其搁置','zh-Hant':'正在檢查重複檔案並將其擱置',ja:'重複ファイルを確認して退避中'},
 'job.duplicatesRemoved':{en:'{count} duplicates set aside ({size}) with undo; nothing is deleted until you release them','zh-Hans':'已搁置 {count} 个重复文件（{size}），可撤销；在你释放前不会删除任何内容','zh-Hant':'已擱置 {count} 個重複檔案（{size}），可復原；在你釋放前不會刪除任何內容',ja:'重複ファイル {count} 件（{size}）を退避しました。取り消せます。解放するまで何も削除されません'},
 'job.duplicatesCarried':{en:'{count} companion files carried next to the kept copy','zh-Hans':'{count} 个附属文件已移到保留副本旁边','zh-Hant':'{count} 個附屬檔案已移到保留副本旁邊',ja:'付属ファイル {count} 件を残したコピーの隣へ移動'},
 'job.duplicatesLeft':{en:'{count} files left in place','zh-Hans':'{count} 个文件保留在原处','zh-Hant':'{count} 個檔案保留在原處',ja:'{count} 件のファイルはそのまま残しました'},
 'job.duplicatesReleased':{en:'Released {count} removed duplicates ({size}). The copies you kept are unchanged.','zh-Hans':'已释放 {count} 个已移除的重复文件（{size}）。你保留的副本保持不变。','zh-Hant':'已釋放 {count} 個已移除的重複檔案（{size}）。你保留的副本保持不變。',ja:'削除済みの重複ファイル {count} 件（{size}）を解放しました。残したコピーは変更されません。'},
 'job.duplicatesUndone':{en:'{restored} duplicates put back where they were','zh-Hans':'{restored} 个重复文件已放回原处','zh-Hant':'{restored} 個重複檔案已放回原處',ja:'重複ファイル {restored} 件を元の場所に戻しました'},
 'history.duplicatesRemoved':{en:'Duplicates removed: {name}','zh-Hans':'已移除重复文件：{name}','zh-Hant':'已移除重複檔案：{name}',ja:'重複ファイルを削除：{name}'},
 'history.duplicatesReleased':{en:'Removed duplicates released','zh-Hans':'已释放已移除的重复文件','zh-Hant':'已釋放已移除的重複檔案',ja:'削除した重複ファイルを解放'},
 'history.duplicatesUndone':{en:'Duplicate removal undone','zh-Hans':'已撤销重复文件移除','zh-Hant':'已復原重複檔案移除',ja:'重複ファイルの削除を取り消し'},
 'error.duplicatesScope':{en:'Choose a library to look through first.','zh-Hans':'请先选择要查找的媒体库。','zh-Hant':'請先選擇要查找的媒體庫。',ja:'先に調べるライブラリを選択してください。'},
 'error.duplicatesNothing':{en:'There is nothing to remove yet. Decide at least one group first.','zh-Hans':'暂时没有可移除的内容。请先决定至少一组。','zh-Hant':'暫時沒有可移除的內容。請先決定至少一組。',ja:'削除するものがまだありません。先に少なくとも 1 つのグループを決めてください。'},
 'error.duplicatesStale':{en:'Scan the library again first.','zh-Hans':'请先重新扫描该媒体库。','zh-Hant':'請先重新掃描該媒體庫。',ja:'先にライブラリをもう一度スキャンしてください。'},
 'error.duplicatesLibraries':{en:'That folder holds or overlaps more than one backup library. Choose one library, or a folder inside it.','zh-Hans':'该文件夹包含或重叠多个备份库。请选择单个库，或其中的文件夹。','zh-Hant':'該資料夾包含或重疊多個備份庫。請選擇單一庫，或其中的資料夾。',ja:'このフォルダには複数のバックアップライブラリが含まれるか重なっています。1つのライブラリ、またはその中のフォルダを選択してください。'},
 'error.duplicatesUnavailable':{en:'This library is not available. Reconnect its drive.','zh-Hans':'此媒体库不可用。请重新连接其驱动器。','zh-Hant':'此媒體庫不可用。請重新連接其磁碟。',ja:'このライブラリは利用できません。ドライブを接続し直してください。'},
 'job.stepChecking':{en:'Checking: {completed} of {total}','zh-Hans':'正在检查：{completed}/{total}','zh-Hant':'正在檢查：{completed}/{total}',ja:'確認中：{total} 件中 {completed} 件'},
 'job.stepReleasing':{en:'Releasing kept originals: {completed} of {total}','zh-Hans':'正在释放保留的原文件：{completed}/{total}','zh-Hant':'正在釋放保留的原始檔案：{completed}/{total}',ja:'保持中の元のファイルを解放中：{total} 件中 {completed} 件'},
 'job.stepDeleting':{en:'Deleting recovery files: {completed} of {total}','zh-Hans':'正在删除恢复文件：{completed}/{total}','zh-Hant':'正在刪除復原檔案：{completed}/{total}',ja:'復元用ファイルを削除中：{total} 件中 {completed} 件'},
 'job.recheckDelete':{en:'Checking organized files before deleting recovery files','zh-Hans':'正在检查已整理的文件，然后删除恢复文件','zh-Hant':'正在檢查已整理的檔案，然後刪除復原檔案',ja:'復元用ファイルを削除する前に、整理済みファイルを確認中'},
 'job.recoveryDeleted':{en:'{count} recovery files deleted ({size}). The organized files are unchanged.','zh-Hans':'已删除 {count} 个恢复文件（{size}）。已整理的文件保持不变。','zh-Hant':'已刪除 {count} 個復原檔案（{size}）。已整理的檔案保持不變。',ja:'復元用ファイル {count} 件を削除しました（{size}）。整理済みファイルは変更されていません。'},
 'job.originalsDeleted':{en:'{count} originals deleted from the source ({size}), each checked against the backup · {kept} left in place','zh-Hans':'已从来源删除 {count} 个原文件（{size}），均已与备份核对 · {kept} 个保留在原处','zh-Hant':'已從來源刪除 {count} 個原始檔案（{size}），均已與備份核對 · {kept} 個保留在原處',ja:'ソースから元のファイル {count} 件を削除しました（{size}、すべてバックアップと照合済み）· {kept} 件はそのまま残しています'},
 'error.originalsStale':{en:'These originals are no longer available to delete. Import the folder again first.','zh-Hans':'这些原文件已无法删除。请先重新导入该文件夹。','zh-Hant':'這些原始檔案已無法刪除。請先重新匯入該資料夾。',ja:'これらの元のファイルは削除できなくなりました。先にフォルダーをもう一度インポートしてください。'},
 'error.originalsBusy':{en:'Wait for this source to finish before deleting its originals.','zh-Hans':'请等此来源处理完成后再删除其原文件。','zh-Hant':'請等此來源處理完成後再刪除其原始檔案。',ja:'このソースの処理が終わってから元のファイルを削除してください。'},
 'error.originalsDelete':{en:'{count} originals could not be checked or deleted and were left in place: {error}','zh-Hans':'有 {count} 个原文件无法检查或删除，已保留在原处：{error}','zh-Hant':'有 {count} 個原始檔案無法檢查或刪除，已保留在原處：{error}',ja:'{count} 件の元のファイルは確認または削除できず、そのまま残しています：{error}'},
 'history.recoveryDeleted':{en:'Organization recovery files deleted','zh-Hans':'已删除整理恢复文件','zh-Hant':'已刪除整理復原檔案',ja:'整理の復元用ファイルを削除しました'},
 'job.stepRestoring':{en:'Putting files back: {completed} of {total}','zh-Hans':'正在将文件放回原处：{completed}/{total}','zh-Hant':'正在將檔案放回原處：{completed}/{total}',ja:'ファイルを元に戻し中：{total} 件中 {completed} 件'},
 'job.organizationPaused':{en:'Paused. Files already moved stay in place; Resume rechecks them and continues.','zh-Hans':'已暂停。已移动的文件保持不变；点击“继续”会重新检查并继续整理。','zh-Hant':'已暫停。已移動的檔案保持不變；點選「繼續」會重新檢查並繼續整理。',ja:'一時停止しました。移動済みのファイルはそのままです。「再開」で確認して続行します。'},
 'job.listing':{en:'Listing files: {count} found','zh-Hans':'正在列出文件：已找到 {count} 个','zh-Hant':'正在列出檔案：已找到 {count} 個',ja:'ファイルを一覧中：{count} 件'},
 'job.readingToMove':{en:'Reading files to move: {count} of {total} · {file}','zh-Hans':'正在读取要移动的文件：{count}/{total} · {file}','zh-Hant':'正在讀取要移動的檔案：{count}/{total} · {file}',ja:'移動するファイルを読み取り中：{total} 件中 {count} 件 · {file}'},
 'job.checkingSourceOf':{en:'Checking source: {count} of {total} files · {file}','zh-Hans':'正在检查来源：{count}/{total} 个文件 · {file}','zh-Hant':'正在檢查來源：{count}/{total} 個檔案 · {file}',ja:'ソースを確認中：{total} ファイル中 {count} 件 · {file}'},
 'job.lookingElsewhere':{en:'Looking for files already in the backup: {count} of {total} · {file}','zh-Hans':'正在查找备份中已有的文件：{count}/{total} · {file}','zh-Hant':'正在尋找備份中已有的檔案：{count}/{total} · {file}',ja:'バックアップにすでにあるファイルを検索中：{count}/{total} · {file}'},
 'job.olderRules':{en:'{count} files already in the backup under older folder rules — Organize backup can apply the new rules','zh-Hans':'备份中已有 {count} 个文件位于旧文件夹规则下——“整理备份”可应用新规则','zh-Hant':'備份中已有 {count} 個檔案位於舊資料夾規則下——「整理備份」可套用新規則',ja:'{count} 件のファイルは、以前のフォルダルールのままバックアップに保存されています — 「バックアップを整理」で新しいルールを適用できます'},
 'job.comparingDestination':{en:'Checking the destination for existing files: {count} of {total} · {file}','zh-Hans':'正在检查目标中的现有文件：{count}/{total} · {file}','zh-Hant':'正在檢查目的地中的現有檔案：{count}/{total} · {file}',ja:'保存先の既存ファイルを確認中：{total} 件中 {count} 件 · {file}'},
 'job.confirmingExisting':{en:'Confirming files already on the destination: {count} of {total} · {file}','zh-Hans':'正在确认目标中已有的文件：{count}/{total} · {file}','zh-Hant':'正在確認目的地中已有的檔案：{count}/{total} · {file}',ja:'保存先にあるファイルを確認中：{total} 件中 {count} 件 · {file}'},
 'job.readingMetadata':{en:'Reading source metadata and checking destination folders','zh-Hans':'正在读取来源元数据并检查目标文件夹','zh-Hant':'正在讀取來源中繼資料並檢查目的地資料夾',ja:'ソースのメタデータを読み取り、保存先フォルダーを確認中'},
 'job.destinationLabel':{en:'Destination {index} of {count}','zh-Hans':'目标 {index}/{count}','zh-Hant':'目的地 {index}/{count}',ja:'保存先 {index}/{count}'},
 'job.destinationFile':{en:'Destination {index} of {count}: {file}','zh-Hans':'目标 {index}/{count}：{file}','zh-Hant':'目的地 {index}/{count}：{file}',ja:'保存先 {index}/{count}：{file}'},
 'job.revalidating':{en:'Revalidating reviewed paths','zh-Hans':'正在重新验证已审核的路径','zh-Hant':'正在重新驗證已審核的路徑',ja:'確認済みのパスを再検証中'},
 'job.copied':{en:'{copied} copied · {skipped} verified','zh-Hans':'已复制 {copied} 个 · 已验证 {skipped} 个','zh-Hant':'已複製 {copied} 個 · 已驗證 {skipped} 個',ja:'{copied} 件コピー · {skipped} 件検証済み'},
 'job.skippedErrors':{en:'{count} skipped with errors','zh-Hans':'{count} 个因错误跳过','zh-Hant':'{count} 個因錯誤略過',ja:'エラーで {count} 件スキップ'},
 'job.mirrorRemoved':{en:'{count} moved to Removed by mirror','zh-Hans':'{count} 个已移至 Removed by mirror','zh-Hant':'{count} 個已移至 Removed by mirror',ja:'{count} 件を Removed by mirror に移動'},
 'job.errors':{en:'{count} errors','zh-Hans':'{count} 个错误','zh-Hant':'{count} 個錯誤',ja:'エラー {count} 件'},
 'job.mirrorIncomplete':{en:'Mirror incomplete; originals retained','zh-Hans':'镜像未完成；原文件已保留','zh-Hant':'鏡像未完成；原始檔案已保留',ja:'ミラーは未完了です。元のファイルは保持されています'},
 'job.mirrorVerified':{en:'Both destinations verified','zh-Hans':'两个目标均已验证','zh-Hant':'兩個目的地均已驗證',ja:'両方の保存先を検証済み'},
 'job.alreadyImported':{en:'Already imported · all {count} files are in the backup and verified','zh-Hans':'已导入 · 全部 {count} 个文件均已在备份中并通过验证','zh-Hant':'已匯入 · 全部 {count} 個檔案均已在備份中並通過驗證',ja:'読み込み済み · {count} ファイルすべてがバックアップにあり検証済みです'},
 'job.moved':{en:'{count} moved','zh-Hans':'已移动 {count} 个','zh-Hant':'已移動 {count} 個',ja:'{count} 件移動'},
 'job.retained':{en:'{count} originals kept for undo ({size})','zh-Hans':'保留 {count} 个原文件以便撤销（{size}）','zh-Hant':'保留 {count} 個原始檔案以便復原（{size}）',ja:'取り消し用に元のファイル {count} 件を保持（{size}）'},
 'job.problemsCollected':{en:'{count} problem files collected into Problem files','zh-Hans':'已将 {count} 个问题文件收集到“Problem files”','zh-Hant':'已將 {count} 個問題檔案收集到「Problem files」',ja:'問題のあるファイル {count} 件を「Problem files」に集めました'},
 'job.problemsSkipped':{en:'{count} problem files not copied or moved','zh-Hans':'{count} 个问题文件未复制或移动','zh-Hant':'{count} 個問題檔案未複製或移動',ja:'問題のあるファイル {count} 件はコピー・移動していません'},
 'job.appleDouble':{en:'macOS ._ files: {removed} removed · {orphans} leftover removed · {kept} kept (they hold data, existed before this import, or changed while checked) · {failed} could not be removed · {folders} folders could not be read','zh-Hans':'macOS ._ 文件：已删除 {removed} 个 · 已删除 {orphans} 个遗留文件 · {kept} 个已保留（含有数据、在此次导入前已存在，或在检查时发生变化） · {failed} 个无法删除 · {folders} 个文件夹无法读取','zh-Hant':'macOS ._ 檔案：已刪除 {removed} 個 · 已刪除 {orphans} 個遺留檔案 · {kept} 個已保留（含有資料、在此次匯入前已存在，或在檢查時發生變化） · {failed} 個無法刪除 · {folders} 個資料夾無法讀取',ja:'macOS の ._ ファイル：{removed} 件削除 · 残骸 {orphans} 件削除 · {kept} 件保持（データを含む、今回より前から存在、または確認中に変更） · {failed} 件は削除できませんでした · {folders} 個のフォルダーは読み取れませんでした'},
 'job.foldersRemoved':{en:'{count} empty folders removed','zh-Hans':'已删除 {count} 个空文件夹','zh-Hant':'已刪除 {count} 個空資料夾',ja:'空のフォルダー {count} 件を削除'},
 'job.paused':{en:'Paused. Verified copies are kept; Start continues with the remaining files.','zh-Hans':'已暂停。已验证的副本会保留；点击“开始”继续处理剩余文件。','zh-Hant':'已暫停。已驗證的副本會保留；點選「開始」繼續處理剩餘檔案。',ja:'一時停止しました。検証済みのコピーは保持され、「開始」で残りのファイルを続行します。'},
 'job.pausedQueued':{en:'Paused before copying. Start continues.','zh-Hans':'已在复制前暂停。点击“开始”继续。','zh-Hant':'已在複製前暫停。點選「開始」繼續。',ja:'コピー前に一時停止しました。「開始」で続行します。'},
 'job.stopped':{en:'Stopped. Completed copies and source originals remain.','zh-Hans':'已停止。已完成的副本和来源原文件均保留。','zh-Hant':'已停止。已完成的副本和來源原始檔案均保留。',ja:'停止しました。完了したコピーとソースの元のファイルは残ります。'},
 'job.removedFromQueue':{en:'Removed from queue','zh-Hans':'已从队列中移除','zh-Hant':'已從佇列中移除',ja:'キューから削除しました'},
 'job.automaticDisabled':{en:'Automatic queue disabled','zh-Hans':'自动队列已关闭','zh-Hant':'自動佇列已關閉',ja:'自動キューは無効です'},
 'job.recheckFinalize':{en:'Rechecking organized files before releasing kept originals','zh-Hans':'正在重新检查已整理的文件，然后释放保留的原文件','zh-Hant':'正在重新檢查已整理的檔案，然後釋放保留的原始檔案',ja:'保持中の元のファイルを解放する前に、整理済みファイルを再確認中'},
 'job.recheckUndo':{en:'Rechecking organized files before putting them back','zh-Hans':'正在重新检查已整理的文件，然后将其放回原处','zh-Hant':'正在重新檢查已整理的檔案，然後將其放回原處',ja:'元に戻す前に、整理済みファイルを再確認中'},
 'job.recheckJournal':{en:'Rechecking journal and retained originals','zh-Hans':'正在重新检查日志和保留的原文件','zh-Hant':'正在重新檢查日誌和保留的原始檔案',ja:'ジャーナルと保持中の元のファイルを再確認中'},
 'job.readingLater':{en:'Reading later organizations: {count} of {total}','zh-Hans':'正在读取较新的整理记录：{count}/{total}','zh-Hant':'正在讀取較新的整理記錄：{count}/{total}',ja:'新しい整理の記録を読み込み中：{total} 件中 {count} 件'},
 'job.readingEarlier':{en:'Checking the earlier organization: {count} of {total} records','zh-Hans':'正在检查较早的整理：{count}/{total} 条记录','zh-Hant':'正在檢查較早的整理：{count}/{total} 筆記錄',ja:'以前の整理を確認中：記録 {total} 件中 {count} 件'},
 'job.converting':{en:'Converting the organization record: {count} of {total}','zh-Hans':'正在转换整理记录：{count}/{total}','zh-Hant':'正在轉換整理記錄：{count}/{total}',ja:'整理の記録を変換中：{total} 件中 {count} 件'},
 'job.cleaning':{en:'Removing old record files: {count} of {total}','zh-Hans':'正在删除旧的记录文件：{count}/{total}','zh-Hant':'正在刪除舊的記錄檔案：{count}/{total}',ja:'古い記録ファイルを削除中：{total} 件中 {count} 件'},
 'job.measuring':{en:'Measuring: {count} files','zh-Hans':'正在测量：{count} 个文件','zh-Hant':'正在測量：{count} 個檔案',ja:'計測中：{count} ファイル'},
 'job.readingHistory':{en:'Reading organization history: {count} of {total} files','zh-Hans':'正在读取整理历史：{count}/{total} 个文件','zh-Hant':'正在讀取整理歷史：{count}/{total} 個檔案',ja:'整理履歴を読み込み中：{total} 件中 {count} 件'},
 'job.resuming':{en:'Rechecking and resuming organization','zh-Hans':'正在重新检查并继续整理','zh-Hant':'正在重新檢查並繼續整理',ja:'再確認して整理を再開中'},
 'job.releasedDuplicates':{en:'Removed {count} confirmed duplicates from their original place ({size}).','zh-Hans':'已从原位置删除 {count} 个已确认的重复文件（{size}）。','zh-Hant':'已從原位置刪除 {count} 個已確認的重複檔案（{size}）。',ja:'確認済みの重複ファイル {count} 件を元の場所から削除しました（{size}）。'},
 'job.released':{en:'Released {count} kept originals ({size}). The organized files are unchanged.','zh-Hans':'已释放 {count} 个保留的原文件（{size}）。已整理的文件保持不变。','zh-Hant':'已釋放 {count} 個保留的原始檔案（{size}）。已整理的檔案保持不變。',ja:'保持していた元のファイル {count} 件（{size}）を解放しました。整理済みファイルは変更されていません。'},
 'job.handedOff':{en:'{count} files stay where a later organization moved them','zh-Hans':'{count} 个文件留在之后的整理移动到的位置','zh-Hant':'{count} 個檔案留在之後的整理移動到的位置',ja:'{count} 件のファイルは後の整理で移動した場所に残します'},
 'job.undone':{en:'{restored} files put back where they were · {removed} organized copies removed','zh-Hans':'{restored} 个文件已放回原处 · 已删除 {removed} 个整理后的副本','zh-Hant':'{restored} 個檔案已放回原處 · 已刪除 {removed} 個整理後的副本',ja:'{restored} ファイルを元の場所に戻しました · 整理済みのコピー {removed} 件を削除'},

 'history.import':{en:'Import: {name}','zh-Hans':'导入：{name}','zh-Hant':'匯入：{name}',ja:'インポート：{name}'},
 'history.driveBackup':{en:'Drive backup: {name}','zh-Hans':'驱动器备份：{name}','zh-Hant':'磁碟備份：{name}',ja:'ドライブのバックアップ：{name}'},
 'history.organization':{en:'Library organization','zh-Hans':'媒体库整理','zh-Hant':'媒體庫整理',ja:'ライブラリの整理'},
 'history.organizationUndone':{en:'Library organization undone','zh-Hans':'媒体库整理已撤销','zh-Hant':'媒體庫整理已復原',ja:'ライブラリの整理を取り消しました'},
 'history.organizationRecovery':{en:'Library organization recovery','zh-Hans':'媒体库整理恢复','zh-Hant':'媒體庫整理復原',ja:'ライブラリ整理の復元'},

 'error.sourceDisconnected':{en:'Source disconnected.','zh-Hans':'来源已断开连接。','zh-Hant':'來源已中斷連線。',ja:'ソースが切断されました。'},
 'error.sourceChanged':{en:'Source changed; scan again: {path}','zh-Hans':'来源已更改，请重新扫描：{path}','zh-Hant':'來源已變更，請重新掃描：{path}',ja:'ソースが変更されました。再スキャンしてください：{path}'},
 'error.alreadyInBackup':{en:'{source} is already in your backup ({root}); there is nothing to import from it.','zh-Hans':'{source} 已在你的备份中（{root}），无需从中导入。','zh-Hant':'{source} 已在你的備份中（{root}），無需從中匯入。',ja:'{source} はすでにバックアップ内にあります（{root}）。インポートするものはありません。'},
 'error.cameraScan':{en:'This camera must download originals before its media can be inspected. Use Review.','zh-Hans':'必须先下载此相机的原始文件才能检查其媒体。请使用“审核”。','zh-Hant':'必須先下載此相機的原始檔案才能檢查其媒體。請使用「審核」。',ja:'このカメラのメディアを確認するには、先に元のファイルをダウンロードする必要があります。「確認」を使ってください。'},
 'error.selectDrive':{en:'Select this drive first.','zh-Hans':'请先选择此驱动器。','zh-Hant':'請先選擇此磁碟。',ja:'先にこのドライブを選択してください。'},
 'error.folderSourcesOff':{en:'Enable folder sources first.','zh-Hans':'请先启用文件夹来源。','zh-Hant':'請先啟用資料夾來源。',ja:'先にフォルダーソースを有効にしてください。'},
 'error.busy':{en:'Finish transfers or discard the current review first.','zh-Hans':'请先完成传输或放弃当前审核。','zh-Hant':'請先完成傳輸或捨棄目前的審核。',ja:'先に転送を完了するか、現在の確認を破棄してください。'},
 'error.busyScan':{en:'Finish transfers or the current review before scanning.','zh-Hans':'请先完成传输或当前审核，然后再扫描。','zh-Hant':'請先完成傳輸或目前的審核，然後再掃描。',ja:'スキャンする前に、転送または現在の確認を完了してください。'},
 'error.busyReview':{en:'Wait for transfers to finish or stop them before reviewing.','zh-Hans':'请等待传输完成或将其停止，然后再审核。','zh-Hant':'請等待傳輸完成或將其停止，然後再審核。',ja:'確認する前に、転送の完了を待つか停止してください。'},
 'error.busyResume':{en:'Wait for the other transfer or review to finish, then resume again.','zh-Hans':'请等待其他传输或审核完成，然后再次继续。','zh-Hant':'請等待其他傳輸或審核完成，然後再次繼續。',ja:'ほかの転送または確認が終わるのを待ってから、もう一度再開してください。'},
 'error.reviewOpen':{en:'Finish the current review first.','zh-Hans':'请先完成当前审核。','zh-Hant':'請先完成目前的審核。',ja:'先に現在の確認を完了してください。'},
 'error.rulesDuringReview':{en:'Stop the current review before changing file rules.','zh-Hans':'更改文件规则前，请先停止当前审核。','zh-Hant':'變更檔案規則前，請先停止目前的審核。',ja:'ファイルのルールを変更する前に、現在の確認を停止してください。'},
 'error.recoveryListStale':{en:'Refresh the organization recovery list first.','zh-Hans':'请先刷新整理恢复列表。','zh-Hant':'請先更新整理復原清單。',ja:'先に整理の復元一覧を更新してください。'},
 'error.organizationDestination':{en:'Choose the original organization destination again.','zh-Hans':'请重新选择原来的整理目标。','zh-Hant':'請重新選擇原本的整理目的地。',ja:'元の整理先をもう一度選択してください。'},
 'error.organizationRunning':{en:'Organization is already queued or running.','zh-Hans':'整理已在排队或正在进行。','zh-Hant':'整理已在佇列中或正在進行。',ja:'整理はすでに待機中か実行中です。'},
 'error.backupFolderOutside':{en:'The backup folder must be inside the destination.','zh-Hans':'备份文件夹必须位于目标内。','zh-Hant':'備份資料夾必須位於目的地內。',ja:'バックアップフォルダーは保存先の中に置く必要があります。'},
 'error.chooseDestination':{en:'Choose a destination first.','zh-Hans':'请先选择目标。','zh-Hant':'請先選擇目的地。',ja:'先に保存先を選択してください。'},
 'error.chooseDestinations':{en:'Choose the required backup destinations first.','zh-Hans':'请先选择所需的备份目标。','zh-Hant':'請先選擇所需的備份目的地。',ja:'先に必要なバックアップ保存先を選択してください。'},
 'error.foldersOutside':{en:'Choose folders inside the selected destination.','zh-Hans':'请选择所选目标内的文件夹。','zh-Hant':'請選擇所選目的地內的資料夾。',ja:'選択した保存先の中にあるフォルダーを選んでください。'},
 'error.folderUnidentified':{en:'This folder\'s drive cannot be identified, so an interrupted organization could not be resumed safely.','zh-Hans':'无法识别此文件夹所在的驱动器，因此中断的整理无法安全恢复。','zh-Hant':'無法識別此資料夾所在的磁碟，因此中斷的整理無法安全繼續。',ja:'このフォルダーのドライブを識別できないため、中断した整理を安全に再開できません。'},
 'error.editedFolderName':{en:'Choose a single safe folder name for edited exports.','zh-Hans':'请为编辑导出选择一个安全的单层文件夹名称。','zh-Hant':'請為編輯匯出選擇一個安全的單層資料夾名稱。',ja:'編集済み書き出し用に、安全な単一のフォルダー名を選んでください。'},
 'error.mirrorSequential':{en:'Mirror backup needs one destination or Copy to both; Fill first then second splits files across disks.','zh-Hans':'镜像备份需要单个目标或“复制到两个目标”；“先存满第一块再用第二块”会把文件分散到多块磁盘。','zh-Hant':'鏡像備份需要單一目的地或「複製到兩個目的地」；「先存滿第一顆再用第二顆」會把檔案分散到多顆磁碟。',ja:'ミラーバックアップには保存先が 1 つか「両方の保存先にコピー」が必要です。「1台目から順に保存」ではファイルが複数のディスクに分かれます。'},
 'error.mirrorNoUuid':{en:'Mirror backup needs a drive with a filesystem UUID. Use Additive backup for this drive.','zh-Hans':'镜像备份需要具有文件系统 UUID 的驱动器。请对此驱动器使用“只增不删”备份。','zh-Hant':'鏡像備份需要具有檔案系統 UUID 的磁碟。請對此磁碟使用「只增不刪」備份。',ja:'ミラーバックアップにはファイルシステム UUID のあるドライブが必要です。このドライブには「追加のみ」バックアップを使ってください。'},
 'error.mirrorReview':{en:'Mirror backup would move {count} files that are no longer on this drive into Removed by mirror. Open Review to confirm.','zh-Hans':'镜像备份会把此驱动器上已不存在的 {count} 个文件移至 Removed by mirror。请打开“审核”确认。','zh-Hant':'鏡像備份會把此磁碟上已不存在的 {count} 個檔案移至 Removed by mirror。請開啟「審核」確認。',ja:'ミラーバックアップは、このドライブにもうない {count} ファイルを Removed by mirror に移動します。「確認」を開いて承認してください。'},
 'error.organizeSpace':{en:'Destination {index} needs {size} free for organizing.','zh-Hans':'目标 {index} 需要 {size} 可用空间才能整理。','zh-Hant':'目的地 {index} 需要 {size} 可用空間才能整理。',ja:'保存先 {index} の整理には {size} の空き容量が必要です。'},
 'error.reviewSpace':{en:'A reviewed destination needs more free space. Review again.','zh-Hans':'已审核的目标需要更多可用空间。请重新审核。','zh-Hant':'已審核的目的地需要更多可用空間。請重新審核。',ja:'確認済みの保存先の空き容量が足りません。もう一度確認してください。'},
 'error.bothNeedSpace':{en:'Both destinations need more free space for the next related file group and publication workspace.','zh-Hans':'两个目标都需要更多可用空间，用于下一组相关文件和发布工作区。','zh-Hant':'兩個目的地都需要更多可用空間，用於下一組相關檔案和發布工作區。',ja:'次の関連ファイルグループと公開用の作業領域のため、両方の保存先に空き容量が必要です。'},
 'error.destinationNeedsSpace':{en:'Destination {index} needs {needed} free for the new files and publication workspace but has {free}. Files already there ({existing}) are skipped and not counted.','zh-Hans':'目标 {index} 需要 {needed} 可用空间来存放新文件和发布工作区，但只有 {free}。已存在的文件（{existing}）会被跳过，不计入其中。','zh-Hant':'目的地 {index} 需要 {needed} 可用空間來存放新檔案和發布工作區，但只有 {free}。已存在的檔案（{existing}）會被略過，不計入其中。',ja:'保存先 {index} には新しいファイルと公開用の作業領域のために {needed} の空き容量が必要ですが、空きは {free} です。すでにあるファイル（{existing}）はスキップされ、計算に含まれません。'},
 'error.backupFolderPath':{en:'Use a relative backup folder without . or .. components.','zh-Hans':'请使用不含 . 或 .. 的相对备份文件夹路径。','zh-Hant':'請使用不含 . 或 .. 的相對備份資料夾路徑。',ja:'. や .. を含まない相対パスのバックアップフォルダーを使ってください。'},
 'error.videoFolderPath':{en:'Use a separate video backup folder beside the photo backup folder, without . or .. components.','zh-Hans':'请在照片备份文件夹旁使用单独的视频备份文件夹，路径中不能含 . 或 ..。','zh-Hant':'請在照片備份資料夾旁使用獨立的影片備份資料夾，路徑中不能含 . 或 ..。',ja:'写真のバックアップフォルダーとは別に、. や .. を含まない動画のバックアップフォルダーを並べて使ってください。'},
 'error.videoFolderMissing':{en:'Choose a video backup folder for every destination.','zh-Hans':'请为每个目标选择视频备份文件夹。','zh-Hant':'請為每個目的地選擇影片備份資料夾。',ja:'すべての保存先に動画のバックアップフォルダーを選んでください。'},
 'error.videoFolderNested':{en:'Use separate photo and video backup folders, neither inside the other.','zh-Hans':'请使用相互独立的照片和视频备份文件夹，二者不能互相包含。','zh-Hant':'請使用彼此獨立的照片和影片備份資料夾，兩者不能互相包含。',ja:'写真と動画のバックアップフォルダーは、互いに含まない別々のフォルダーにしてください。'},
 'error.organizeFolderVideo':{en:'Organizing a folder in place keeps one folder; choose a media layout without a separate video backup folder first.','zh-Hans':'就地整理文件夹只使用一个文件夹；请先选择不含单独视频备份文件夹的媒体文件布局。','zh-Hant':'就地整理資料夾只使用一個資料夾；請先選擇不含獨立影片備份資料夾的媒體檔案配置。',ja:'フォルダーをその場で整理する場合はフォルダーが 1 つだけです。先に、動画のバックアップフォルダーを分けないメディアの配置を選んでください。'},
 'error.invalidTemplate':{en:'Invalid folder template: {template}','zh-Hans':'文件夹模板无效：{template}','zh-Hant':'資料夾範本無效：{template}',ja:'フォルダーテンプレートが無効です：{template}'},
 'error.separateDisksUnverified':{en:'Could not verify that destinations are on separate physical disks.','zh-Hans':'无法确认两个目标位于不同的物理磁盘上。','zh-Hant':'無法確認兩個目的地位於不同的實體磁碟上。',ja:'保存先が別々の物理ディスクにあることを確認できませんでした。'},
 'error.separateDisks':{en:'Choose two separate physical backup disks.','zh-Hans':'请选择两块不同的物理备份磁盘。','zh-Hant':'請選擇兩顆不同的實體備份磁碟。',ja:'別々の物理バックアップディスクを 2 台選んでください。'},
 'error.destinationUnidentified':{en:'This destination disk cannot be identified.','zh-Hans':'无法识别此目标磁盘。','zh-Hant':'無法識別此目的地磁碟。',ja:'この保存先のディスクを識別できません。'},
 'error.destinationRelative':{en:'Choose an absolute destination folder.','zh-Hans':'请选择绝对路径的目标文件夹。','zh-Hant':'請選擇絕對路徑的目的地資料夾。',ja:'絶対パスの保存先フォルダーを選んでください。'},
 'error.destinationInSource':{en:'A destination cannot be on or inside an import source or camera card.','zh-Hans':'目标不能位于导入来源或相机卡上或其中。','zh-Hant':'目的地不能位於匯入來源或相機卡上或其中。',ja:'保存先をインポート元やカメラカードの上や中に置くことはできません。'},
 'error.destinationOnCard':{en:'A destination cannot be on a camera card or removable flash media.','zh-Hans':'目标不能位于相机卡或可移动闪存介质上。','zh-Hant':'目的地不能位於相機卡或可移除快閃媒體上。',ja:'保存先をカメラカードやリムーバブルフラッシュメディアに置くことはできません。'},
 'error.destinationUninspectable':{en:'Could not inspect this volume for camera folders. Authorize access or reconnect it before choosing a destination.','zh-Hans':'无法检查此宗卷中的相机文件夹。请先授权访问或重新连接，再选择目标。','zh-Hant':'無法檢查此宗卷中的相機資料夾。請先授權存取或重新連接，再選擇目的地。',ja:'このボリュームのカメラフォルダーを確認できませんでした。保存先を選ぶ前に、アクセスを許可するか接続し直してください。'},
 'error.destinationReadOnly':{en:'The destination filesystem is read-only.','zh-Hans':'目标文件系统为只读。','zh-Hant':'目的地檔案系統為唯讀。',ja:'保存先のファイルシステムは読み取り専用です。'},
 'error.destinationNotFolder':{en:'The destination must be a folder.','zh-Hans':'目标必须是文件夹。','zh-Hant':'目的地必須是資料夾。',ja:'保存先はフォルダーである必要があります。'},
 'error.destinationUnavailable':{en:'The destination is unavailable.','zh-Hans':'目标不可用。','zh-Hant':'目的地無法使用。',ja:'保存先を利用できません。'},
 'error.destinationChanged':{en:'The selected destination disk changed or cannot be identified. Choose it again before copying.','zh-Hans':'所选目标磁盘已更改或无法识别。请在复制前重新选择。','zh-Hant':'所選目的地磁碟已變更或無法識別。請在複製前重新選擇。',ja:'選択した保存先のディスクが変更されたか、識別できません。コピーする前にもう一度選択してください。'},
 'error.backupFolderCheck':{en:'Backup folder check: {error}','zh-Hans':'备份文件夹检查：{error}','zh-Hant':'備份資料夾檢查：{error}',ja:'バックアップフォルダーの確認：{error}'},
 'inventory.emptyFile':{en:'empty file (0 bytes)','zh-Hans':'空文件（0 字节）','zh-Hant':'空檔案（0 位元組）',ja:'空のファイル（0 バイト）'},
 'inventory.emptySkipped':{en:'{count} skipped: empty file (0 bytes)','zh-Hans':'已跳过 {count} 个：空文件（0 字节）','zh-Hant':'已略過 {count} 個：空檔案（0 位元組）',ja:'{count} 件をスキップ：空のファイル（0 バイト）'},
 'inventory.emptyPrimaryFile':{en:'companion to an empty file','zh-Hans':'空文件的伴随文件','zh-Hant':'空檔案的隨附檔案',ja:'空のファイルの関連ファイル'},
 'inventory.emptyPrimarySkipped':{en:'{count} skipped: companion to an empty file','zh-Hans':'已跳过 {count} 个：空文件的伴随文件','zh-Hant':'已略過 {count} 個：空檔案的隨附檔案',ja:'{count} 件をスキップ：空のファイルの関連ファイル'},
 'error.fileFailed':{en:'Problem with {path}: {error}','zh-Hans':'{path} 出现问题：{error}','zh-Hant':'{path} 發生問題：{error}',ja:'{path} で問題が発生しました：{error}'},
 'error.userSkipped':{en:'Skipped by you','zh-Hans':'已由你跳过','zh-Hant':'已由你略過',ja:'手動でスキップしました'},
 'error.fileSkipped':{en:'Skipped {path}: {error}','zh-Hans':'已跳过 {path}：{error}','zh-Hant':'已略過 {path}：{error}',ja:'スキップしました {path}：{error}'},
 'error.residueCleanup':{en:'Leftover file cleanup: {error}','zh-Hans':'残留文件清理：{error}','zh-Hant':'殘留檔案清理：{error}',ja:'残ったファイルのクリーンアップ：{error}'},
 'error.folderCleanup':{en:'Folder cleanup: {error}','zh-Hans':'文件夹清理：{error}','zh-Hant':'資料夾清理：{error}',ja:'フォルダーの整理：{error}'},
} as const satisfies Record<string,Record<Language,string>>;

export type MessageKey=keyof typeof backendMessages;
export type MessageParam=string|number|Message|Message[];
export interface Message {key:MessageKey;params?:Record<string,MessageParam>;}

export function message(key:MessageKey,params?:Record<string,MessageParam>):Message {return params?{key,params}:{key};}
export function text(value:string):Message {return {key:'text',params:{text:value}};}
/** Parts of one detail line, joined with " · "; false, 0 and undefined parts are left out. */
export function joined(...parts:(Message|false|0|undefined)[]):Message {return {key:'text',params:{text:parts.filter((part):part is Message=>!!part)}};}

export function formatMessage(value:Message,language:Language):string {
 return backendMessages[value.key][language].replace(/\{(\w+)\}/g,(placeholder,name:string)=>{
  const param=value.params?.[name];
  return param===undefined?placeholder:typeof param==='string'?param:typeof param==='number'?new Intl.NumberFormat(language).format(param):Array.isArray(param)?param.map(part=>formatMessage(part,language)).join(' · '):formatMessage(param,language);
 });
}

/** An error the user sees translated. Its `message` is the English text, for logs and reports. */
export class MessageError extends Error {
 constructor(readonly key:MessageKey,readonly params?:Record<string,MessageParam>){super(formatMessage(message(key,params),'en'));}
}
/** The source file a planning error is about, when the user can skip that file. */
export function filePath(value:Message|undefined):string|undefined {
 const path=value?.params?.path;
 return value&&(value.key==='error.sourceChanged'||value.key==='error.fileFailed')&&typeof path==='string'?path:undefined;
}
/** The file or folder an error is about, for Show in Finder. */
export function errorPath(value:Message|undefined):string|undefined {
 const path=value?.params?.path;
 return value&&value.key!=='text'&&typeof path==='string'?path:undefined;
}
export function toMessage(error:unknown):Message {
 return error instanceof MessageError?message(error.key,error.params):text(error instanceof Error?error.message:String(error));
}
/** A message read from settings.json; earlier versions saved plain English strings. */
export function savedMessage(value:unknown):Message|undefined {
 if(typeof value==='string')return text(value);
 if(value&&typeof value==='object'&&typeof (value as Message).key==='string'&&Object.hasOwn(backendMessages,(value as Message).key))return value as Message;
}
