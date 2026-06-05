# Week 16 期末整合報告 — Overleaf 共編說明

## 📂 檔案結構

```
report/final/
├── main.tex          # 主檔（10-12 頁）
├── references.bib    # 引用清單（BibTeX）
├── README.md         # 本說明
└── figs/             # 圖片資料夾（截圖、架構圖、loss 曲線、混淆矩陣）
```

---

## 🚀 上傳到 Overleaf

### 方法 1：壓縮上傳（最快）

1. 把整個 `report/final/` 資料夾壓縮成 `.zip`
2. 進 [Overleaf](https://www.overleaf.com) → New Project → **Upload Project**
3. 拖入 zip 檔即可

### 方法 2：GitHub 連結（適合持續同步）

1. 把 `Project/` 推到 GitHub
2. Overleaf → New Project → **Import from GitHub** → 選 repo + 路徑指 `report/final/`

### 編譯器設定

進 Overleaf 專案後，左下角 Menu → **Settings**：

| 設定 | 值 |
| --- | --- |
| Compiler | **XeLaTeX**（必填，中文必要） |
| TeX Live version | 2024 以上 |
| Main document | `main.tex` |

按 Recompile，第一次編譯約 30-60 秒（要載字型）。

---

## 👥 共編規範（重要！）

### 邀請組員

Overleaf 左上 **Share** → 輸入組員 Gmail：
- 盧彥宇（組員 B）— 可編輯權限
- 吳花瑜（組員 C）— 可編輯權限

### 編輯規範

`main.tex` 內每個 `\section` 開頭都有 `\textit{主責：X (姓名)}` 註明負責人。**請只編輯自己的章節**：

| 章節 | 主責 | 編輯範圍 |
| --- | --- | --- |
| §1 緒論 | A 主筆，三人共潤 | A 寫好初稿，B/C 補意見 |
| §2 系統架構 | A | A 補架構圖 figs/architecture.pdf |
| §3.1, §3.2 前端 / 後端 | A | A |
| §3.3 資料工程與微調 | **B** | 填 `[TODO: B]` 處 + 補 figs/loss_curve.png |
| §3.4 提示詞工程 | **C** | 填 `[TODO: C]` 處 |
| §4 Train/Serve 對齊 | 三人共同 | 各自補充自己領域內容 |
| §5 安全評估 | **C** | 填 `[TODO: C]` 處 + 補 figs/confusion_matrix.png |
| §6 工程考量 | A | A |
| §7 架構限制 | 三人共同 | 各補充 1 條自己領域的 |
| §8 結論 | 三人共同 | 互相潤色 |

### `[TODO: X]` 標記

整份報告共有 **多處 `[TODO: B]` 與 `[TODO: C]`** 等待填寫，主要分布在：
- §3.3 表 \ref{tab:dataset}, \ref{tab:hyper}
- §5 表 \ref{tab:testset}, \ref{tab:metrics}
- §5 圖 \ref{fig:cm} 混淆矩陣
- 摘要與結論的具體數字

請直接 Ctrl+F 搜尋 `[TODO: B]` 或 `[TODO: C]` 找到自己的位置。

### 新增引用

`references.bib` 內有 8 筆預設引用。若要新增：
1. 在 `references.bib` 末尾加新的 `@article{...}` 區塊
2. 在 `main.tex` 內適當位置用 `\cite{key}` 引用
3. **通知 A** 對齊格式

---

## 📷 圖片需求清單

放在 `report/final/figs/` 目錄下：

| 檔名 | 內容 | 提供者 |
| --- | --- | --- |
| `architecture.pdf` | 整體系統架構圖（用 draw.io / Excalidraw） | A |
| `loss_curve.png` | LoRA 訓練 loss 曲線（Unsloth 自動產生） | B |
| `confusion_matrix.png` | Held-out test set 混淆矩陣 | C |

若要在 LaTeX 內引用，主檔內已預留位置（搜尋 `\fbox`），把 `\fbox{...}` 替換為：

```latex
\includegraphics[width=0.7\textwidth]{figs/檔名.pdf}
```

---

## ⚙️ 常見編譯錯誤

### 1. 字型錯誤 `Noto Serif CJK TC not found`
Overleaf 偶爾切換字型路徑會遇到。改用備援方案：
```latex
\setCJKmainfont{Source Han Serif TC}
```

### 2. 中文無法顯示
確認左下角設定為 **XeLaTeX**，不是 pdfLaTeX。

### 3. `[TODO: ...]` 顯示異常
這是純文字標記，不影響編譯。最終定稿前需替換為實際內容。

---

## 📅 建議的編輯時程

| 階段 | 任務 |
| --- | --- |
| Day 1 | A 上傳專案、邀請 B/C 入 Overleaf |
| Day 1-2 | B 補完 §3.3 與 figs/loss_curve.png |
| Day 1-2 | C 補完 §3.4、§5、figs/confusion_matrix.png |
| Day 3 | A 補完 figs/architecture.pdf |
| Day 4 | 三人共讀 §7、§8 互相潤色 |
| Day 5 | 最終校稿與排版微調 |

---

## ✅ 交付前 checklist

- [ ] 所有 `[TODO: X]` 已替換為實際內容
- [ ] 所有圖片已放入 `figs/` 並於 LaTeX 內 `\includegraphics`
- [ ] 編譯無 error、無 missing reference
- [ ] 三人姓名 / 學號正確
- [ ] 頁數 8 頁以上（目前主檔結構約 10-12 頁）
- [ ] 至少 6 個引用（目前 8 個）
- [ ] 摘要與結論的具體數字一致
