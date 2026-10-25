// Append these rows to the existing four-locale catalog during integration.
export const settingsTranslationRows = `
Storage|存储|儲存|保存先
File handling|文件处理|檔案處理|ファイルの扱い
Metadata and file rules|元数据与文件规则|中繼資料與檔案規則|メタデータとファイルのルール
Devices|设备|裝置|デバイス
Problem files|问题文件|問題檔案|問題のあるファイル
Files without date or camera|无日期或相机信息的文件|無日期或相機資訊的檔案|日付やカメラ情報のないファイル
Unrecognized file types|无法识别的文件类型|無法辨識的檔案類型|認識できないファイル形式
Drive backups: {mode}|驱动器备份：{mode}|磁碟備份：{mode}|ドライブのバックアップ：{mode}
Change|更改|變更|変更
Open in Library|在资料库中打开|在資料庫中開啟|ライブラリで開く
Ejecting drives|推出驱动器|退出磁碟|ドライブの取り出し
Eject drives automatically after a clean import|导入顺利完成后自动推出驱动器|匯入順利完成後自動退出磁碟|問題なくインポートできたらドライブを自動で取り出す
Cards and drives are ejected once every file is copied and verified with no errors, after Delete originals if that is offered. Folders and cameras are never ejected.|所有文件都已复制并验证且没有错误后，存储卡和驱动器会被推出；如果提供了“删除原文件”，则在其完成之后。文件夹和相机不会被推出。|所有檔案都已複製並驗證且沒有錯誤後，記憶卡和磁碟會被退出；如果提供了「刪除原始檔案」，則在其完成之後。資料夾和相機不會被退出。|すべてのファイルがコピーされエラーなく検証されると、カードとドライブを取り出します。元のファイルの削除が提示される場合は、その後です。フォルダーとカメラは取り出されません。
Delete originals|删除原文件|刪除原始檔案|元のファイルを削除
Offer for folders|为文件夹提供|為資料夾提供|フォルダーで提示する
Offer for SD cards and drives|为 SD 卡和驱动器提供|為 SD 卡和磁碟提供|SDカードとドライブで提示する
After an import, offers to delete only the files verified by checksum in the backup, with a two-step confirmation.|导入后，仅提供删除已在备份中通过校验和验证的文件，并需两步确认。|匯入後，僅提供刪除已在備份中通過校驗碼驗證的檔案，並需兩步確認。|インポート後、バックアップでチェックサム検証済みのファイルだけを、2段階の確認のうえ削除できます。
After an import, offers to delete only the files verified by checksum in the backup, with a two-step confirmation. Off by default.|导入后，仅提供删除已在备份中通过校验和验证的文件，并需两步确认。默认关闭。|匯入後，僅提供刪除已在備份中通過校驗碼驗證的檔案，並需兩步確認。預設為關閉。|インポート後、バックアップでチェックサム検証済みのファイルだけを、2段階の確認のうえ削除できます。初期設定ではオフです。
Eject|推出|退出|取り出す
Remove from app|从应用中移除|從 App 中移除|アプリから削除
Eject {name}?|要推出 {name} 吗？|要退出 {name} 嗎？|{name} を取り出しますか？
Remove {name} from the app?|要将 {name} 从应用中移除吗？|要將 {name} 從 App 中移除嗎？|{name} をアプリから削除しますか？
The folder and its files stay where they are.|文件夹及其文件保持原样。|資料夾及其檔案保持原樣。|フォルダーとファイルはそのまま残ります。
Ejected drives can be unplugged safely.|推出后的驱动器可以安全拔下。|退出後的磁碟可以安全拔除。|取り出したドライブは安全に取り外せます。
In use. Wait for it to finish first.|正在使用中。请先等待其完成。|正在使用中。請先等待其完成。|使用中です。終わるまでお待ちください。
Eject all done ({count})|全部推出已完成的（{count}）|全部退出已完成的（{count}）|完了したものをすべて取り出す（{count}）
Eject all done ({count})?|要全部推出已完成的（{count}）吗？|要全部退出已完成的（{count}）嗎？|完了したものをすべて取り出しますか？（{count}）
Eject all|全部推出|全部退出|すべて取り出す
Eject finished drives and remove finished folders|推出已完成的驱动器并移除已完成的文件夹|退出已完成的磁碟並移除已完成的資料夾|完了したドライブを取り出し、完了したフォルダーを削除します
Finished drives are ejected and can be unplugged safely. Finished folders are only removed from the app; the folders and their files stay where they are.|已完成的驱动器会被推出，可安全拔下。已完成的文件夹只会从应用中移除；文件夹及其文件保持原样。|已完成的磁碟會被退出，可安全拔除。已完成的資料夾只會從 App 中移除；資料夾及其檔案保持原樣。|完了したドライブは取り出され、安全に取り外せます。完了したフォルダーはアプリから削除されるだけで、フォルダーとファイルはそのまま残ります。
`;
