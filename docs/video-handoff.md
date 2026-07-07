# 解説動画 制作 引き継ぎ書

最終更新: 2026-07-07
関連: 方針 [`video-plan.md`](./video-plan.md) ／ 台本 [`video-script.md`](./video-script.md)

この文書は、担当者向け「システム解説動画」の制作を**次のセッション（別の作業者・別のClaude）が継続できる**ようにまとめたものです。

---

## 1. いまどこまで進んでいるか

動画（約2分・PC向け・ナレーションあり）の**素材はすべて完成し、発注者（西川さん）に納品済み**。残りは「①VOICEVOXでナレーション音声を書き出す」「②Canvaで組み立てて書き出す」の2工程で、いずれも発注者側の手作業。

| 工程 | 状態 |
|---|---|
| 方針確定 | ✅ 完了（`video-plan.md`） |
| 台本・絵コンテ（9カット構成） | ✅ 完了（`video-script.md`）。発注者承認済み |
| 操作録画クリップ 6本 | ✅ 完了・納品済み |
| スライド 3枚（タイトル/図解/締め） | ✅ 完了・納品済み |
| カット別ナレーション原稿 9本 | ✅ 完了・納品済み |
| 無音の仮組みプレビュー（2分02秒） | ✅ 完了・納品済み |
| **ナレーション音声の書き出し** | ⏳ **発注者作業中**（VOICEVOX「No.7」。Mac の Gatekeeper で一度起動できなかったが `xattr -dr com.apple.quarantine` で解決済み） |
| **Canva で最終組み立て・書き出し** | ⏳ 未着手（音声が揃ってから） |

---

## 2. 成果物の置き場所

### リポジトリ内（このブランチにコミット済み・恒久保存）
- `docs/video-plan.md` — 制作方針・要件
- `docs/video-script.md` — 台本／カット表（ナレーション全文・テロップ文言入り）
- `docs/video-handoff.md` — 本書
- `video/` — **再生成用のソース一式**（下記「4. 再生成の手順」で使う）
  - `video/tools/mock-server.mjs` — 録画用モックAPIサーバー（デモデータ内蔵）
  - `video/tools/record.mjs` — Playwright 録画スクリプト（カットC2,C4〜C8）
  - `video/slides/slides.html` + `shoot.mjs` + `logo.svg` — スライド3枚の生成元
  - `video/narration/c1.txt〜c9.txt` — ナレーション原稿
  - `video/README_組み立て手順.md` — 発注者向けの組み立て手順書

### 発注者に送付済み（チャット経由・リポジトリには未格納）
- `preview_draft.mp4` — 無音の仮組みプレビュー（2分02秒）
- `kaisetsu-douga-sozai.zip`（約10MB）— clips 6本・slides 3枚・narration・README一式

> 注意: **生成済みの mp4/png バイナリはリポジトリに入れていない**（容量のため）。次セッションで実物が必要なら「4. 再生成」で作り直す。ソースと手順は全てコミット済みなので完全に再現できる。

---

## 3. 動画の構成（早見表）

9カット・約2分20秒。詳細は `video-script.md`。

1. **C1** タイトル（スライド）
2. **C2** カンバン全景（録画 `c2_kanban`）
3. **C3** 仕組み図解（スライド）★最重要＝「CCに if@eiwa-up.jp を入れるだけ」を伝える
4. **C4** ログイン→カンバン→担当者フィルタ（録画 `c4_login`）
5. **C5** タスク詳細（AI判定理由・メール参照・返信）（録画 `c5_detail`）
6. **C6** ステータス進行 未処理→対応中→完了（録画 `c6_status`）
7. **C7** 返信の自動検知＝取得実行で「返信済み」へ自動移動（録画 `c7_reply_detect`）
8. **C8** 設定画面 時間帯/頻度・振り分けルール・API利用状況（録画 `c8_settings`）
9. **C9** 締め（スライド・VOICEVOXクレジット入り）

伝えるべき要点: 便利さ（取りこぼし防止・全員の状況が見える）／簡単さ（開いて確認→ステータス進めるだけ）／賢さ（自動仕分け・返信自動検知・返信文自動構築）／設定（頻度・ルール・コスト）／**担当者へのお願い＝CCに if@eiwa-up.jp**。

---

## 4. 再生成の手順（次セッション用）

素材を作り直す／差し替える場合。作業ディレクトリは scratchpad（セッションごとに消えるので都度セットアップ）。

### 前提ツール
- Chromium: `/opt/pw-browsers/chromium`（Playwright 同梱。`playwright` npm を入れて `executablePath` 指定で使用）
- ffmpeg: `apt-get update && apt-get install -y ffmpeg`（Playwright同梱の ffmpeg-linux は mp4 muxer 非対応なので **フル版が必須**）

### 操作録画クリップ（C2, C4〜C8）
```bash
# 1) フロントをモックAPI向けにビルド
cd /home/user/task_management
VITE_SUPABASE_URL=http://localhost:8788 VITE_SUPABASE_ANON_KEY=demo-key npm run build
# 2) モックサーバー起動（dist を配信 + /api/* と /rest/v1/* を返す）
cd <scratchpad>/video && cp /home/user/task_management/video/tools/*.mjs .
DIST_DIR=/home/user/task_management/dist node mock-server.mjs &   # :8788
# 3) 録画（要 playwright npm）。clips/*.webm が出る
node record.mjs           # 全カット。node record.mjs c5 で個別
# 4) mp4 化
for f in clips/*.webm; do ffmpeg -y -i "$f" -c:v libx264 -pix_fmt yuv420p -crf 20 -r 30 "${f%.webm}.mp4"; done
```
- ログイン画面はモックなのでID/PWは任意（`nishikawa`等）で通る
- `record.mjs` は疑似カーソルを描画してマウス移動を録画に映している
- C7 は `/api/run-fetch` を叩くとモック側で t1 が「未処理→返信済み」に動く仕掛け（`mock-server.mjs` 内）

### スライド（C1, C3, C9）
```bash
cd <scratchpad>/video && cp /home/user/task_management/video/slides/* .
node shoot.mjs            # slide_c1.png / slide_c3.png / slide_c9.png（1920x1080）
```
- 文言・色を変えるなら `slides.html` を編集して再実行
- ブランドカラー: ヘッダー緑 `#33604d`、アクセント黄 `#ffd166`、ロゴ赤 `#c81021`

### 仮組みプレビュー（任意）
静止画スライドを尺分の動画にして clips と concat（手順は前回 `README_組み立て手順.md` のタイムライン表どおり）。

---

## 5. 発注者に残っている作業（そのまま伝えてよい案内）

1. **ナレーション音声**: VOICEVOX を起動し話者「No.7（ノーマル）」で `narration/c1.txt〜c9.txt` を1行ずつ貼り付け→話速1.1前後→c1.wav〜c9.wav を書き出し。クレジット「VOICEVOX:No.7」表記が必要（C9スライドに記載済み）
2. **Canva で組み立て**: 1920×1080動画を新規作成→clips/slidesをアップロード→台本順に配置→各カット頭に対応音声→テロップ（台本のテロップ列）→BGM小さめ・トランジション0.3秒程度→mp4書き出し
3. 音声がクリップより長いカット（特にC5）は、クリップ末尾を静止で伸ばすか再生速度を落として調整

---

## 6. 次のセッションでの始め方（発注者向けの一言）

次のセッションを開いたら、最初にこう伝えれば継続できます:

> **「`docs/video-handoff.md` を読んで。解説動画の続き。」**

そのうえで、状況に応じて以下のどれかを付け加えてください:
- 「ナレーション音声ができたので Canva 組み立ての相談をしたい」
- 「C5 のテロップ（または台本の◯◯）をこう変えたい。素材を作り直して」
- 「◯◯のカットを撮り直したい」→ セッション側は「4. 再生成の手順」で該当クリップだけ作り直せる

Claude 側は、この引き継ぎ書と `video/` のソースがあれば、モック環境の再構築から録画・スライド生成・再パッケージまで再現できます。
