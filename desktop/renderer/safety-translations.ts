/** Append these rows to the shared i18n catalog during integration. */
export const safetyTranslationRows=`
Stop imports|停止导入|停止匯入|インポートを停止
Stops queued, paused and running media imports and file backups. Scans, reviews and library tools continue.|停止排队、暂停和正在运行的媒体导入及文件备份。扫描、预览和资料库工具会继续运行。|停止排隊、暫停及執行中的媒體匯入與檔案備份。掃描、預覽與圖庫工具會繼續執行。|待機中・一時停止中・実行中のメディア読み込みとファイルバックアップを停止します。スキャン、確認、ライブラリツールは続行します。
Clean up leftover files?|清理残留文件？|清理殘留檔案？|残りのファイルをクリーンアップしますか？
Delete leftovers and clear receipts|删除残留文件并清除凭据|刪除殘留檔案並清除收據|残りのファイルを削除して記録を消去
Estimated removable files: {count} ({size}).|预计可删除的文件：{count} 个（{size}）。|預計可刪除的檔案：{count} 個（{size}）。|削除できるファイルの見積もり：{count} 件（{size}）。
Other leftover files and folders|其他残留文件和文件夹|其他殘留檔案與資料夾|その他の残りのファイルとフォルダ
Resumable staging copies|可继续导入的暂存副本|可繼續匯入的暫存副本|再開できる作業用コピー
Kept staging copies|保留的暂存副本|保留的暫存副本|保持している作業用コピー
Old copy receipts|旧复制凭据|舊複製收據|古いコピー記録
{count} receipts cleared; named files kept|清除 {count} 条凭据；保留对应文件|清除 {count} 筆收據；保留對應檔案|記録 {count} 件を消去、対象ファイルは保持
Recoverable complete copies|可恢复的完整副本|可復原的完整副本|復元できる完全なコピー
{count} retained ({size})|保留 {count} 个（{size}）|保留 {count} 個（{size}）|{count} 件を保持（{size}）
Manual cleanup also deletes resumable and kept staging copies. Re-importing will need to copy them again.|手动清理也会删除可继续导入的及保留的暂存副本。再次导入时需要重新复制这些文件。|手動清理也會刪除可繼續匯入及保留的暫存副本。再次匯入時需要重新複製這些檔案。|手動クリーンアップでは、再開できる作業用コピーと保持している作業用コピーも削除します。再読み込み時にもう一度コピーする必要があります。
The files named by old copy receipts are kept. Recoverable complete copies are retained.|旧复制凭据对应的文件会保留。可恢复的完整副本也会保留。|舊複製收據對應的檔案會保留。可復原的完整副本也會保留。|古いコピー記録が指すファイルは保持します。復元できる完全なコピーも保持します。
These amounts come from the latest check. Cleanup checks again and may leave files that changed or are in use.|这些数量来自最近一次检查。清理时会再次检查，已更改或正在使用的文件可能会保留。|這些數量來自最近一次檢查。清理時會再次檢查，已變更或正在使用的檔案可能會保留。|これらの値は直近の確認結果です。クリーンアップ時に再確認し、変更されたファイルや使用中のファイルを残す場合があります。
`;
