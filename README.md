# K HARNESS

K 是 Windows 上的 AI 工作台。你可以在同一個視窗管理專案、聊天室與背景工作。可連接 Codex、Claude Code、Antigravity、Grok 和 DeepSeek Harness。核心由各供應商提供，每個人使用自己的帳號。一般聊天沒有 NVIDIA 顯示卡的需求。

## 第一次使用

第一次開啟 K 時，先選要用的功能。K 只顯示你選的項目，之後可在「設定 → 元件」更改。取消選取會保留登入、設定和聊天室。新對話、工作區、排程與搜尋都會保留。

選好後，依畫面下載核心並登入自己的帳號。選 DeepSeek Harness、艾瑪或 API 諮詢模型時，費用由你的 API 帳戶支付。

想先知道原型有哪些功能、公開版附了什麼、艾瑪怎麼設定，可在工作台開啟「設定 → 功能清單與設定條件」。GitHub 上也能閱讀同一份[原型與公開版功能對照表](docs/features.md)。

第一次安裝可依照[Windows 安裝步驟](docs/windows-install.md)操作。

準備一台 Windows 電腦、Git 和 Node.js 22.19 以上。先用 Git 複製本儲存庫，安裝程式會從你選定的 Git 版本建置桌面程式。工作台可以先開啟，想聊天時再選擇、安裝第一個核心。登入與手機驗證請在供應商的登入畫面自行完成。

| 想做的事 | 需要準備 |
| --- | --- |
| 開始聊天 | 選一個核心，安裝對應的官方程式並以自己的帳號登入。使用 DeepSeek Harness 需設定自己的 DeepSeek API 金鑰，費用由該帳戶支付。 |
| 讓 AI 操作網頁 | 設定 K 專用的 Chrome 與瀏覽器助手。無痕操作另需在 Chrome 擴充功能頁允許。 |
| 讓 AI 操作桌面 | 在此電腦安裝並設定 Windows 桌面控制工具。啟用後，操作會使用你的前景視窗、鍵盤和滑鼠。 |
| 與語音秘書通話 | 在「API 連線」設定自己的 Gemini Live 金鑰，並允許麥克風。通話依該帳戶的 API 方案計費。 |
| 用手機連回工作台 | 在自己的電腦設定遠端連線、HTTPS 網址與登入。Android 手機端是連回 Windows 工作台的選用配件。 |
| 使用本機模型或 Colab | 設定自己的推論環境、模型與位置。使用 Colab 時請確認所選帳號及運算費用。 |

## 本機聽寫

選取「聽寫」後，Windows 桌面版和手機連線介面會顯示麥克風圖示；尚未設定時，點選即顯示說明。一般瀏覽器直接開啟網頁時則使用瀏覽器提供的語音服務，啟用前會詢問同意。你可以選擇 Windows 語音辨識，或使用自己的離線 Whisper 環境。Whisper 可用相容的 NVIDIA 顯卡加速，程式也有 CPU 辨識路徑，速度依電腦而異。

設定 Windows 辨識時，安裝參數是 `-DictationProvider windows`。請先安裝 Windows 繁體中文（臺灣）的語音辨識引擎。選擇 Whisper 時，使用 `-DictationProvider whisper`、`-DictationPython` 與 `-DictationModel` 指定自己的 Python 和本機模型資料夾。Python 環境需可載入 faster-whisper、NumPy 與 OpenCC。若要用顯卡加速，請在同一個標準 Windows Python venv 裡準備與模型執行套件相容的 NVIDIA cuBLAS、cuDNN 及 CUDA 執行程式庫。K 會檢查顯卡的使用率及可用記憶體。低於 2,500 MiB、三次取樣中至少兩次使用率達 70%，或無法載入 GPU 時，會改用 CPU。4,500 MiB 以上可選用 float16。重新開啟 K 後，先說一句話，停止並查看草稿，即可檢查辨識是否正常。

## 請自己的 AI 協助

把下面這句交給能讀取本機專案的 AI 即可。

> 請讀 K 的 README，核對我這台電腦已設定哪些核心和功能，分別告訴我哪些已經實測、哪些只看到設定、哪些還缺東西。先解釋需要的硬體、權限與費用，再幫我設定我選的功能。

每個人使用自己的帳號和金鑰。使用雲端核心時，你送出的內容會交由所選供應商處理；與語音秘書通話時，語音會送到 Gemini Live。分享問題或測試結果前，請先檢查附件中是否含有帳號、金鑰或私人對話。

## Gemini 額度

公開版透過 Antigravity 官方命令 `/usage` 顯示目前登入帳號的模型額度。畫面會列出官方回報的數字與查詢時間。官方未提供的數字顯示為未知。私人原型另有查詢方式。[Antigravity 官方命令說明](https://antigravity.google/docs/cli-getting-started)

## 授權

K HARNESS 公開版的原創程式採 GNU Affero General Public License 第 3 版（AGPL-3.0-only）。可以使用、修改、收費或再散布。散布程式時，須依授權條款向收件人提供對應原始碼。修改版透過網路與使用者互動時，應提供免費取得該版本對應原始碼的方式。使用 K 處理的私人文件和對話仍由使用者管理。[完整授權條款](LICENSE)

瀏覽器助手中的 Playwright 上游程式保留原有 Apache-2.0 聲明。各家核心由使用者透過官方管道取得，各自適用供應商提供的授權與服務條款。[瀏覽器助手上游聲明](browser-extension/README.md)

專案側欄使用 DeepSeekHarness 的 MIT 授權程式。[來源與授權全文](docs/third-party-workspace.md)

Google 商家讀取功能需自行設定相容的 Google 商家用戶端及專案綁定。討論中的網頁搜尋選用 Exa 服務，搜尋內容會送往該服務。選用 Android 手機端時，請在建置時以 `-ServerOrigin` 指定自己的 Tailscale HTTPS 根網址；自訂 Windows 安裝位置時，以 `-StateRoot` 指定該次安裝的狀態目錄。
