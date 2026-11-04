// An import's same-name conflicts (ConflictsPanel.tsx): files whose name the library already holds with the same bytes.
export const conflictTranslationRows = `
Same name, same contents|同名且内容相同|同名且內容相同|同じ名前・同じ内容
1 file is already in the library with the same name and contents|有 1 个文件已在图库中，名称和内容都相同|有 1 個檔案已在圖庫中，名稱和內容都相同|同じ名前と内容のファイルが 1 件すでにライブラリにあります
{count} files are already in the library with the same name and contents|有 {count} 个文件已在图库中，名称和内容都相同|有 {count} 個檔案已在圖庫中，名稱和內容都相同|同じ名前と内容のファイルが {count} 件すでにライブラリにあります
They are not copied. The import goes on; choose for any of them now, and it is done when the import ends.|这些文件不会被复制。导入会继续进行；你现在就可以为任意文件做选择，导入结束后再执行。|這些檔案不會被複製。匯入會繼續進行；你現在就可以為任意檔案做選擇，匯入結束後再執行。|これらはコピーされません。インポートは続行します。今すぐ個別に選べ、インポート終了後に実行されます。
They were not copied. Choose for any of them; Overwrite keeps the replaced file in recovery storage until you undo or release it.|这些文件没有被复制。你可以为任意文件做选择；“覆盖”会把被替换的文件保存在恢复存储中，直到你撤销或释放它。|這些檔案沒有被複製。你可以為任意檔案做選擇；「覆寫」會把被取代的檔案保存在復原儲存空間中，直到你復原或釋放它。|これらはコピーされませんでした。個別に選べます。「上書き」では置き換えたファイルを、元に戻すか解放するまで復元用ストレージに保管します。
Skip {skip} · Overwrite {overwrite} · Keep both {keep}|跳过 {skip} · 覆盖 {overwrite} · 保留两者 {keep}|略過 {skip} · 覆寫 {overwrite} · 保留兩者 {keep}|スキップ {skip} · 上書き {overwrite} · 両方残す {keep}
{count} done|已完成 {count} 个|已完成 {count} 個|{count} 件完了
Applying your choices: {completed} of {total}|正在执行你的选择：{completed}/{total}|正在執行你的選擇：{completed}/{total}|選択を適用中：{completed}/{total}
Applying your choices…|正在执行你的选择…|正在執行你的選擇…|選択を適用中…
{count} choices wait to be applied|有 {count} 个选择等待执行|有 {count} 個選擇等待執行|{count} 件の選択が適用待ちです
Stopped: every conflict not applied yet is skipped.|已停止：所有尚未执行的冲突都会被跳过。|已停止：所有尚未執行的衝突都會被略過。|停止しました：まだ適用されていない競合はすべてスキップされます。
Overwrite all|全部覆盖|全部覆寫|すべて上書き
The library files go to recovery storage; Undo puts them back|图库中的文件会移入恢复存储；“撤销”可将其放回|圖庫中的檔案會移入復原儲存空間；「復原」可將其放回|ライブラリのファイルは復元用ストレージに移り、「元に戻す」で戻せます
Keep both for all|全部保留两者|全部保留兩者|すべて両方残す
Copies each file under a new name|以新名称复制每个文件|以新名稱複製每個檔案|各ファイルを新しい名前でコピーします
Skips every conflict not applied yet and stops the import|跳过所有尚未执行的冲突并停止导入|略過所有尚未執行的衝突並停止匯入|まだ適用されていない競合をすべてスキップし、インポートを停止します
Skip is now chosen for every file ({count}).|现在所有文件（{count} 个）都选择了“跳过”。|現在所有檔案（{count} 個）都選擇了「略過」。|すべてのファイル（{count} 件）で「スキップ」を選択しました。
Overwrite is now chosen for every file ({count}).|现在所有文件（{count} 个）都选择了“覆盖”。|現在所有檔案（{count} 個）都選擇了「覆寫」。|すべてのファイル（{count} 件）で「上書き」を選択しました。
Keep both is now chosen for every file ({count}).|现在所有文件（{count} 个）都选择了“保留两者”。|現在所有檔案（{count} 個）都選擇了「保留兩者」。|すべてのファイル（{count} 件）で「両方残す」を選択しました。
Skip is now chosen for {chosen} of {count} files; files already applied keep their result.|现在 {count} 个文件中有 {chosen} 个选择了“跳过”；已执行的文件保持原结果。|現在 {count} 個檔案中有 {chosen} 個選擇了「略過」；已執行的檔案保持原結果。|{count} 件中 {chosen} 件で「スキップ」を選択しました。適用済みのファイルは結果がそのまま残ります。
Overwrite is now chosen for {chosen} of {count} files; files already applied keep their result.|现在 {count} 个文件中有 {chosen} 个选择了“覆盖”；已执行的文件保持原结果。|現在 {count} 個檔案中有 {chosen} 個選擇了「覆寫」；已執行的檔案保持原結果。|{count} 件中 {chosen} 件で「上書き」を選択しました。適用済みのファイルは結果がそのまま残ります。
Keep both is now chosen for {chosen} of {count} files; files already applied keep their result.|现在 {count} 个文件中有 {chosen} 个选择了“保留两者”；已执行的文件保持原结果。|現在 {count} 個檔案中有 {chosen} 個選擇了「保留兩者」；已執行的檔案保持原結果。|{count} 件中 {chosen} 件で「両方残す」を選択しました。適用済みのファイルは結果がそのまま残ります。
Hide the files|隐藏文件|隱藏檔案|ファイルを隠す
Show the files|显示文件|顯示檔案|ファイルを表示
Show {count} more|再显示 {count} 个|再顯示 {count} 個|さらに {count} 件表示
Overwrite|覆盖|覆寫|上書き
Keep both|保留两者|保留兩者|両方残す
Applying…|正在执行…|正在執行…|適用中…
Overwritten|已覆盖|已覆寫|上書きしました
Kept both|已保留两者|已保留兩者|両方残しました
Failed|失败|失敗|失敗
Choice for {name}|{name} 的选择|{name} 的選擇|{name} の選択
Incoming file|导入的文件|匯入的檔案|取り込むファイル
In the library|图库中的文件|圖庫中的檔案|ライブラリ内のファイル
Show in folder|在文件夹中显示|在資料夾中顯示|フォルダで表示
Folder|文件夹|資料夾|フォルダ
Taken|拍摄时间|拍攝時間|撮影日時
Checked|核对结果|核對結果|確認内容
Same size and same SHA-256 ({hash}…)|大小相同，SHA-256 相同（{hash}…）|大小相同，SHA-256 相同（{hash}…）|サイズと SHA-256 が同じ（{hash}…）
Puts back the library files this overwrite replaced|放回此次覆盖所替换的图库文件|放回此次覆寫所取代的圖庫檔案|この上書きで置き換えたライブラリのファイルを戻します
Undo overwrite|撤销覆盖|復原覆寫|上書きを元に戻す
`;
