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
| 語音秘書 | 從「設定」查看 Gemini Live API 連線，確認由哪個帳號計費；想測通話時再開啟麥克風。 |
| 自架模型 | 以 K 私有狀態內的 `.runtime/gemma-main.json` 設定自己的模型。未設定的本機模型不會列在選單。 |

K 桌面啟動器使用的 `K_CANDIDATE_ROOT` 是本次安裝的執行目錄；表中的「K 私有狀態」位於其中的 `vault/private-state`。設定是否存在可以檢查，完整金鑰或權杖不需要貼給 AI。

元件選擇與手機遠端授權分開保存。要撤銷已設定的遠端入口，可在安裝目錄執行 `node scripts/configure-remote.mjs --root "私有狀態完整路徑" --revoke`。
