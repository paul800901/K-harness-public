# 在 Windows 安裝 K HARNESS

準備 Git for Windows 和 Node.js 22.19 以上（含 npm）。一般聊天可使用 Windows 電腦的內建顯示晶片。

1. 在你想存放程式的資料夾開啟 PowerShell，依序執行以下兩行。

   ```powershell
   git clone https://github.com/paul800901/K-harness-public.git
   cd K-harness-public
   ```

2. 執行 `.\Setup-K.ps1`。安裝程式會下載此版本指定的相依套件、建置 Windows 桌面程式，並在本機執行測試。請保留該資料夾供後續更新使用。
3. 安裝完成後執行 `.\Start-K-Desktop.ps1`。第一次開啟時選取要用的元件，再到「設定 → 帳號與核心」，按該核心的「更新」取得官方程式。完全離開 K 再重新開啟。
4. 使用 Codex、Claude Code、Antigravity 或 Grok 時，在「設定」選該供應商登入，依官方畫面親自完成授權。使用 DeepSeek Harness 時，先安裝 7-Zip，再在「API 連線」設定你自己的 DeepSeek 金鑰，使用費用由該 API 帳戶支付。
5. 選擇自己的工作資料夾，開一個聊天室，選剛設定的核心，送出一句簡單的話。收到回覆就完成第一個核心的驗證。

若 Windows 顯示「系統已停用指令碼執行」，可在剛才的 Git 目錄以 `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\Setup-K.ps1` 安裝，用同樣的參數執行 `.\Start-K-Desktop.ps1` 啟動。這個選項只作用於該次 PowerShell 程序。公司電腦若由群組原則管理，請依管理員提供的執行方式操作。

已有官方 Codex 或 Claude Windows 執行檔的人，可在執行安裝程式時選用 `-CodexExecutable` 或 `-ClaudeExecutable`，指定該執行檔的完整路徑。請勿將登入檔或金鑰放進原始碼目錄。

需要本機聽寫時，可在安裝時指定 [README 的聽寫選項](../README.md#本機聽寫)。其餘工作電腦依賴按你選擇的功能設定。安裝遇到錯誤時，保留畫面上的錯誤訊息供查詢；送給別人前先遮掉個人資料夾路徑。

## 如何核對這台電腦

| 功能 | 可以怎麼查 |
| --- | --- |
| 元件 | 在「設定 → 元件」更改選擇。工作區與聊天室共用這台電腦的選擇。 |
| 已選的 AI 核心 | 在「設定」查看個別核心是否已安裝、是否登入。用該核心開房收到回覆後，即可確認這個帳號能正常工作。 |
| 本機聽寫 | 在安裝位置的 `.local/runtime.json` 核對 `dictationProvider`。選 Whisper 時還需核對 `dictationPython`、`dictationModel` 指向自己的檔案。用麥克風說一句話並停止，確認草稿出現文字。 |
| K 專用瀏覽器 | 在電腦上執行 `scripts/Setup-K-Browser.ps1` 設定自己的 Chrome；需要無痕操作時，在該擴充功能的詳細資料中勾選允許無痕模式。 |
| 桌面控制 | 使用者自行安裝 Windows-MCP，將其程式位置以 `executable` 寫入 K 私有狀態內的 `.runtime/desktop-control.json`。此工具只提供給具備完整存取權的主對話。 |
| 語音秘書 | 從「設定」查看 Gemini Live API 連線，確認由哪個帳號計費；想測通話時再開啟麥克風。Google 搜尋與工作區以外的唯讀資料夾是選用設定，寫在 K 私有狀態內的 `.runtime/voice-emma.json`，例如 `{"googleSearch": true, "readFolders": [{"name": "桌面", "path": "C:\\Users\\Example\\Desktop"}]}`。範例中的 `Example` 請換成自己的 Windows 使用者資料夾。沒有這個檔案時不搜尋，只讀已登記的工作區。下一通電話生效；搜尋的支援與費用依你的 Gemini API 方案，Google 拒絕時通話會顯示錯誤，K 不會自動重試或改用其他計費。 |
| 自架模型 | 以 K 私有狀態內的 `.runtime/gemma-main.json` 設定自己的模型。未設定的本機模型不會列在選單。 |

K 桌面啟動器使用的 `K_CANDIDATE_ROOT` 是本次安裝的執行目錄；表中的「K 私有狀態」位於其中的 `vault/private-state`。設定是否存在可以檢查，完整金鑰或權杖不需要貼給 AI。

元件選擇與手機遠端授權分開保存。要撤銷已設定的遠端入口，可在安裝目錄執行 `node scripts/configure-remote.mjs --root "私有狀態完整路徑" --revoke`。

## 核心相容性與更新

設定頁的核心更新會保留可用的上一版，並說明「目前執行」與「下次啟動」的版本。K 會略過已實測有問題的版本；公開程式目前內建 Antigravity 1.5.17 的略過紀錄，因為該版在工作區寫入權限下仍可寫入工作區外。這筆紀錄隨公開版提供，新安裝也生效。使用者可在核心存放目錄的 `withheld-cores.json` 追加自己的測試紀錄，格式例如 `{"gemini":{"1.5.17":"權限檢查未通過"}}`；沒有這個檔案也會保留內建紀錄。

Antigravity 新版下載完成後，先請自己的 AI 在本機以該執行檔跑 `scripts/antigravity-permission-probe.mjs --run`，確認權限測試結果再完全離開 K 並重新開啟。測試用 `K_GEMINI_EXECUTABLE` 指定要驗證的執行檔，使用自己的官方登入與訂閱額度，會建立測試用假檔案。未帶 `--run` 只顯示說明。測試失敗時保留證據與原版本，不能把套件下載成功當成權限驗證通過。

若官方當時提供的最新版在略過名單中，K 不會下載它；沒有舊核心的新安裝需等相容版本，或由自己的 AI 協助核對官方可取得且已通過測試的版本。K 不會因此自動換核心、帳號或計費。Grok 與 DeepSeek 的既有原生對話綁定原工作目錄，移到不同實體目錄時需開新聊天室。

離線聽寫的語音分段已在 faster-whisper 1.2.1 上測試。自己的 Python 環境須支援 `VadOptions` 與 `collect_chunks(..., max_duration=...)`；使用不同版本時，請先執行聽寫測試並實際試說一句，再確認辨識是否適合自己的麥克風與電腦。

Grok 的原生啟動須支援 `agent --no-leader stdio`，已以 Grok 1.0.92 的官方執行檔確認參數。較早版本的最低相容版號尚未確認；若顯示不支援該參數，請先從設定頁更新 Grok 核心並重新開啟 K。
