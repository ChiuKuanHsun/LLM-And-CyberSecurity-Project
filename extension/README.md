# Chrome Extension — Intent-Based Phishing Detector

## 載入方式（開發模式）

1. 開啟 Chrome → 網址列輸入 `chrome://extensions/`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」→ 選擇本 `extension/` 資料夾
4. **必須先啟動 FastAPI 後端**（見 `backend/README.md`）

## 圖示檔案

`extension/icons/` 中需放置 `icon16.png`、`icon48.png`、`icon128.png`。
Week 14 可用任意佔位圖（純色方塊即可），Week 15 再換正式設計。

## 檔案結構

```
extension/
├── manifest.json       # MV3 設定、權限、host_permissions
├── background.js       # Service Worker：統一 fetch + 端點管理
├── content.js          # 注入網頁：DOM 擷取 + 警告 Overlay
├── overlay.css         # 警告視窗樣式
├── popup.html / .js    # 工具列 popup：連線狀態 + 快速設定入口
└── options/
    ├── options.html    # BYOM 設定頁
    └── options.js      # 端點儲存 + 連線測試
```

## Manifest V3 重點

- 使用 `service_worker` 取代 MV2 的 `background page`
- `host_permissions` 必須宣告 `http://127.0.0.1:8080/*` 才能打本機 API
- `content_scripts` 目前 match Gmail / Facebook / LINE Web，可依需求擴充
