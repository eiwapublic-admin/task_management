# 解説動画 素材パッケージ（組み立て手順）

台本: リポジトリの `docs/video-script.md` ／ 方針: `docs/video-plan.md`

## 同梱物

- `preview_draft.mp4` — **全体の流れが分かる無音の仮組み版（2分02秒）**。まずこれをご覧ください
- `slides/` — スライド3枚（PNG 1920×1080）: C1タイトル / C3仕組み図解 / C9締め
- `clips/` — 操作録画6本（MP4 1920×1080 / 30fps・無音）
- `narration/` — カット別ナレーション原稿（c1.txt〜c9.txt）

## タイムライン（Canva に並べる順）

| # | 素材 | 長さ目安 | ナレーション | テロップ案 |
|---|---|---|---|---|
| C1 | slides/slide_c1.png | 7秒 | narration/c1.txt | （スライド内に含む） |
| C2 | clips/c2_kanban.mp4 | 10秒 | narration/c2.txt | タスクの取りこぼしをゼロに |
| C3 | slides/slide_c3.png | 24秒 | narration/c3.txt | （スライド内に含む） |
| C4 | clips/c4_login.mp4 | 17秒 | narration/c4.txt | 全員の状況が、ひと目でわかる |
| C5 | clips/c5_detail.mp4 | 14秒 | narration/c5.txt | 宛先も引用も、自動でセット |
| C6 | clips/c6_status.mp4 | 13秒 | narration/c6.txt | 対応したら、進めるだけ |
| C7 | clips/c7_reply_detect.mp4 | 11秒 | narration/c7.txt | 返信すれば、自動で「返信済み」 |
| C8 | clips/c8_settings.mp4 | 14秒 | narration/c8.txt | 振り分けルールは、日本語で書くだけ |
| C9 | slides/slide_c9.png | 15秒 | narration/c9.txt | （スライド内・VOICEVOXクレジット含む） |

- ナレーションがクリップより長い場合は、クリップの末尾を静止（フリーズ）で伸ばすか、スライドの表示時間を音声に合わせて調整してください
- 長さはナレーション音声を入れてから微調整するのが楽です

## ナレーション音声の作り方（VOICEVOX・所要10分ほど）

こちらの環境からは VOICEVOX エンジンの配布サーバーに接続できなかったため、音声の書き出しのみお願いします。

1. https://voicevox.hiroshiba.jp/ から VOICEVOX をダウンロード・インストール（無料・アカウント不要）
2. 起動し、話者を **「No.7（ノーマル）」** に設定
3. `narration/c1.txt` 〜 `c9.txt` の本文を1つずつ貼り付け（1行=1音声）
4. 話速 **1.1** 前後に設定（キビキビした進行に合います。聞いて調整可）
5. 「音声書き出し」で c1.wav〜c9.wav として保存

※ 利用条件: 動画にクレジット「VOICEVOX:No.7」の表記が必要です（C9 スライドに記載済み）

## Canva での組み立て

1. Canva で「動画（1920×1080）」の新規デザインを作成
2. 本パッケージの slides / clips をアップロードし、上記の順にタイムラインへ配置
3. 書き出した音声 c1.wav〜c9.wav を各カットの頭に配置
4. テロップ（上表のテロップ案）を画面下 1/4 に配置
5. お好みで BGM（音量は小さめ、-20dB 目安）とカット間のトランジション（「ディゾルブ」等を0.3秒程度）を追加
6. MP4 で書き出し

テロップ文言や構成の変更が必要になったら、その旨お知らせいただければ素材を再生成します。
