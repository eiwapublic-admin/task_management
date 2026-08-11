# UI 標準（栄和 タスク管理システム）

新しい画面を作るとき・既存の画面に手を入れるときの拠り所。**この文書と
`src/index.css`（トークン）・`src/styles/ui.css`（共通部品）の3点で「標準」を構成する。**

目的は、画面ごとにフォントサイズや色を個別に指示しなくても、自然に統一感のある
UI ができあがる状態にすること。迷ったらこの文書に戻ってくる。

- トークン（色・寸法・文字サイズ）… `src/index.css`
- 共通部品（ボタン・入力欄・カード・モーダル等）… `src/styles/ui.css`
- この文書 … 使い分けのルールと、新しい画面の組み立て方

---

## 1. 3つの原則

### 原則1: 色は「意味」で選ぶ。好みで選ばない

このシステムには**2つのアクセント色**があり、役割がはっきり分かれている。
ここが崩れると画面全体が一気に分かりにくくなるので、最優先で守ること。

| 色 | 意味 | 使う場所 |
|---|---|---|
| **ブランド green** `--color-brand` | **いま自分がどこにいるか / どれが選ばれているか** | ヘッダーの帯、選択中のタブ・セグメント、本日マーカー、選択中の行 |
| **アクション blue** `--color-primary` | **押すと何かが起きる** | 主要ボタン、リンク、フォーカスリング、ホバーの合図 |

> **なぜ分けるのか**: 同じ画面で緑と青の両方が「押せそう」に見えると、利用者は
> どちらを押せばいいのか一瞬迷う。「緑＝現在地の表示（押しても移動しない）」
> 「青＝操作（押すと起きる）」と決め切ることで、迷いをなくしている。

そのほかの色も意味が決まっている。

| 色 | 意味 |
|---|---|
| `--color-danger`（赤） | 消える・戻せない操作、不良判定（削除・スパム・NG・基準値割れ） |
| `--color-warn`（オレンジ） | 注意・経過観察（即時改修◎、期限が近い） |
| `--reports-header-bg`（イエロー） | **日報セクションの見出し帯専用**。タスク管理のグリーンと区別するための色で、**押せる要素には絶対に使わない** |

赤は `--color-danger` の**1色だけ**。以前は `#dc2626` と `#c81021` が混在していたが統一済み。

### 原則2: 生の値を書かない

CSS に `14px` `#6b7280` `12px` `z-index: 55` のような**生値を直接書かない**。
必ずトークンを参照する。

```css
/* ✗ やってはいけない */
.my-thing { font-size: 13px; color: #6b7280; border-radius: 8px; z-index: 55; }

/* ✓ 正しい */
.my-thing {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  border-radius: var(--radius-control);
  z-index: var(--z-modal-nested);
}
```

文字サイズは**8段階**（`--fs-2xs` 〜 `--fs-2xl`）しかない。ここに無いサイズが
欲しくなったら、それは本当に必要か、既存の段階で代用できないかを先に疑う。

### 原則3: まず共通部品で組む。個別CSSは最後の手段

新しい見た目が必要になったら、この順で考える。

1. `src/styles/ui.css` に既にある部品で組めないか
2. 組めないなら、**それは本当にこの画面だけの見た目か**
3. 汎用的なら → `ui.css` に部品として足す（他の画面でも使えるようになる）
4. 本当にその画面固有なら → その画面のCSSに書く

「とりあえずこの画面に書く」を続けると、また画面ごとにバラバラになる。

---

## 2. 新しい画面の作り方（レシピ）

この骨格をコピーして始める。これだけで余白・幅・タイトルの大きさ・
ボタンの高さが他の画面と揃う。

```jsx
export default function NewScreen() {
  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow">
        <div className="ui-toolbar">
          <button type="button" className="icon-btn-home" onClick={...}
                  aria-label="日報一覧に戻る" title="日報一覧に戻る">
            <IconHome size={32} />
          </button>
          <h2 className="ui-page-title">画面名</h2>
          <div className="ui-toolbar-actions">
            <button type="button" className="btn-primary">主要アクション</button>
          </div>
        </div>

        {/* 中身 */}
      </div>
    </div>
  )
}
```

### 幅の選び方（`.ui-container`）

| 指定 | 幅 | 使う画面 |
|---|---|---|
| `is-narrow` | 900px | 一覧・フォームが主役（日報一覧・残留塩素・違反車両・定型文・従量課金） |
| `is-wide` | 1200px | 表が主役（自主検査表） |
| 指定なし | 全幅 | カンバン・設定・処理ログ・アーカイブ |

**いずれも中央寄せ**。「この画面だけ左寄せ」のような揺れを作らない。

### ツールバーの並び順

**左＝いま自分がどこにいるかの情報、右＝操作**。

```
[ホーム] [画面名] [年月の移動] ………… [表示切替] [検索] [遷移ボタン] [出力]
```

右側は `.ui-toolbar-actions` に入れると自動で右端に寄る。

---

## 3. 部品の使い分け

### ボタン

| クラス | いつ使うか |
|---|---|
| `.btn-primary` | その画面で**一番やってほしいこと**（保存・記録する・検索） |
| `.btn-plain` | それ以外の操作（一覧へ戻る・切替・補助的な遷移） |
| `.btn-danger` | 消える・戻せない操作の**確定**（削除の実行） |

**1画面に `.btn-primary` は原則1つ。** 2つ以上並べたくなったら、本当に両方とも
「一番やってほしいこと」なのか優先順位を見直す。

選択状態を持つ二次ボタン（フィルタ等）は `.btn-plain.is-active` にする。
選択中＝現在地なのでブランド色になる（原則1）。

### アイコンのみのボタン

`.icon-btn-add` / `-nav` / `-home` / `-gear` / `-delete` / `-download` / `-search` / `.icon-btn-close`

**文字ラベルが無いので、`title` と `aria-label` を必ず両方付ける。**
`title` はマウス利用者へのツールチップ、`aria-label` はスクリーンリーダー用。

```jsx
<button type="button" className="icon-btn-download"
        aria-label="PDFを出力" title="PDFを出力">
  <IconDownload size={20} />
</button>
```

削除は「置いてあるだけで不安にさせない」ため、**ホバーで初めて赤くなる**。
また削除は押しただけでは実行せず、必ず `ConfirmDeleteButton`（確認を挟む共通部品）を使う。

### セグメント切替（`.ui-segmented`）

**同じ対象の「見せ方」を切り替える**ときに使う（リスト/カレンダー、日付順/累計回数順）。

押すと**別の画面へ移動する**類は、セグメントではなくボタンを使うこと。
セグメントは「今この見方を選んでいる」という現在地の表現なので、
選択中はブランド色になる。

グリーンヘッダーの上に置くときは `.ui-segmented.on-dark` を付ける。

### 入力欄

ラベルと入力を縦に積む `.ui-field` が基本形。

```jsx
<label className="ui-field">
  <span>測定場所</span>
  <input type="text" className="ui-input" placeholder="1F給湯室" />
</label>
```

`.ui-input` / `.ui-select` / `.ui-textarea` は高さ・角丸・フォーカスの見え方が
揃っている。表の行内など密度が要るところは `.is-compact` を足す。

> **iOS のズーム対策は書かなくてよい。** iOS Safari はフォーカスした入力の文字が
> 16px 未満だと自動でズームするが、`ui.css` が 768px 以下で一括して 16px に
> 引き上げている。**画面ごとに `font-size: 16px` を書かないこと。**

### カード（`.ui-card`）

白い面＋淡い罫線＋ごく薄い影。見出し帯が要るときは `.ui-card-title` を中に置く。

日報の入力セクションは `.ui-card-title.is-reports` でイエローの帯にする
（「ここは記入する場所」の合図。タスク管理のグリーンと区別するため）。

### 表（`.ui-table`）

`.ui-table-wrap` で包むと、狭い画面でも横スクロールできる。
数値の列は `.is-numeric` を付けると右寄せ＋桁揃えになる。

### バッジ（`.ui-badge`）

状態や件数を短く示す。**押せる要素には見せないこと**（バッジは表示専用）。

`.is-current`（現在地・緑）/ `.is-action`（新着・青）/ `.is-danger`（赤）/ `.is-warn`（黄）

### モーダル（`.ui-overlay` / `.ui-modal`）

```jsx
<div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
  <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
    <div className="ui-modal-head">
      <h3 className="ui-modal-title">タイトル</h3>
      <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">×</button>
    </div>
    <div className="ui-modal-body">…</div>
    <div className="ui-modal-foot">
      <ConfirmDeleteButton onConfirm={...} />
      <div className="ui-modal-foot-end">
        <button className="btn-plain" onClick={onClose}>キャンセル</button>
        <button className="btn-primary" onClick={onSave}>記録する</button>
      </div>
    </div>
  </div>
</div>
```

**フッタは 左＝取り消し・削除系 / 右＝進める系**（`.ui-modal-foot-end` で右に寄る）。

> **iOS の面倒は `ui.css` が見ている。** 高さが変わる問題・ノッチに隠れる問題
> （`env(safe-area-inset-*)`）・裏のページへスクロールが伝わる問題、
> これらは `.ui-overlay` / `.ui-modal` で一度だけ対処済み。**画面ごとに書き直さないこと。**

**モーダルの高さは `vh` / `dvh` で計算しない。** `.ui-modal` は `max-height: 100%`
＝「オーバーレイの内側にぴったり収まる」で高さを決めている。`vh` / `dvh` / `lvh` は
iOS では固定表示（`position: fixed`）要素の実寸と一致しないことがあり、計算値が
枠より大きいとモーダルが枠からはみ出し、**見出しが画面上端の外へ追い出されて、
下にスワイプしないと出てこない**状態になる（2026-08-10 に日報詳細で発生）。
オーバーレイ側の `overflow-y: auto` は最後の保険であって、そこに頼る設計にしないこと。

**開いている間は裏のページを固定する。** `useBodyScrollLock()`（`src/lib/`）を
コンポーネントの先頭で呼ぶだけでよい。入れ子のモーダル（日報詳細の上に自主点検）でも
数を数えているので、内側を閉じても外側のロックは外れない。

重なり順は `--z-*` から選ぶ（生の `z-index` を書かない）。

| トークン | 用途 |
|---|---|
| `--z-modal` (50) | 通常のモーダル（タスク詳細・日報詳細） |
| `--z-modal-nested` (55) | モーダルの上に重ねるモーダル（自主点検・残留塩素の入力） |
| `--z-preview` (60) | 写真・PDFの拡大表示 |
| `--z-blocking` (200) | PDF作成中など、操作を止める全画面オーバーレイ |

### 固定表示ヘッダー（`.ui-sticky-head` / `.ui-sticky-head-2`）

一覧・カンバンの見出しをスクロールしても画面上部に残したいときに使う。

```jsx
const stickyHeadRef = useStickyHeightVar('--sticky2-h')
// ...
<div className="ui-toolbar ui-sticky-head" ref={stickyHeadRef}>…</div>
<div className="…-header ui-sticky-head-2">…</div>
```

`useStickyHeightVar`（`src/lib/`）が1段目の実測高さを CSS 変数化し、2段目はその下に
`top: calc(var(--app-header-h) + var(--sticky2-h, 0px))` で積み上がる。

> **横スクロールできる要素の中では使わない。** `overflow-x: auto` を持つ要素は、
> CSS の仕様上 `overflow-y` も自動的に `visible` から `auto` に変わる
> （`overflow-y: visible` を明示しても上書きできない）。これによりその要素が
> 意図せず縦のスクロールコンテナになり、中の `position: sticky` 要素の固定位置の
> 基準（最も近い祖先のスクロールコンテナ）が**ページからその要素へすり替わって**
> しまう。結果、見出しが本来より大きく下にずれて表示される（2026-08-11に
> カンバン列見出し・アーカイブ表で発生）。横スクロールが要る一覧では、
> スクロール対象を専用のラッパー（例: `.logs-table-wrap`）に絞り、
> `.ui-sticky-head` 系の要素はその外側に置く。どうしても同じ要素の中に置く
> 必要があるなら、その幅では固定表示自体を諦めて `position: static` に戻す
> （`.kanban-column-header` の狭幅時の扱いを参照）

### 空状態・注記

- `.ui-empty` … 「まだ記録がありません」
- `.ui-note` … 補足の一文（凡例・注意書き）

---

## 4. やってはいけないこと

| ✗ | なぜ |
|---|---|
| CSS に生値（`14px` `#333` `z-index: 55`）を書く | トークンを変えても追随せず、また画面ごとにバラバラになる |
| 1画面に `.btn-primary` を複数置く | 「一番やってほしいこと」が伝わらなくなる |
| イエロー（`--reports-header-bg`）を押せる要素に使う | 見出し専用の色。押せると誤解される |
| 画面ごとに `font-size: 16px`（iOSズーム対策）を書く | `ui.css` が一括対処済み。二重管理になる |
| 画面ごとにモーダルの高さ・safe-area を書く | 同上 |
| モーダルの高さを `vh` / `dvh` で計算する | iOSで枠とずれ、見出しが画面の外へ隠れる。`max-height: 100%` を使う |
| モーダルを開いても裏のページを固定しない | 裏が一緒に動き、iOSで表示がずれて見える。`useBodyScrollLock()` を呼ぶ |
| `overflow-x: auto` な要素の中で `.ui-sticky-head` 系を使う | `overflow-y` が自動で `auto` になり、固定位置の基準がページからその要素にすり替わって見出しが下にずれる |
| バッジを押せるように見せる | バッジは表示専用。押せるなら `.btn-plain` を使う |
| アイコンのみのボタンに `aria-label` を付けない | スクリーンリーダーで何のボタンか分からない |

---

## 5. 新しい画面を出す前のチェックリスト

- [ ] 画面の骨格は `.ui-page` → `.ui-container` → `.ui-toolbar` で組んだか
- [ ] `.ui-container` の幅（narrow / wide / 全幅）は画面の性格に合っているか
- [ ] `.btn-primary` は1つだけか
- [ ] 緑を「押せる要素」に、青を「現在地の表示」に使っていないか
- [ ] アイコンのみのボタンに `title` と `aria-label` があるか
- [ ] 削除は `ConfirmDeleteButton` で確認を挟んでいるか
- [ ] CSS に生値を書いていないか（`grep -nE ':\s*#[0-9a-f]{3,6}|[0-9]+px' 追加したCSS`）
- [ ] **iPhone 幅（375px）で横スクロールが出ないか**（実機かPlaywrightで確認）
- [ ] 入力欄をタップしてもズームしないか（16px 以上になっているか）
- [ ] モーダルなら、**見出し（タイトル・×）が常に画面内にあるか**（縦に長い内容で確認）
- [ ] モーダルなら `useBodyScrollLock()` を呼んでいるか

---

## 6. この標準の育て方

標準は一度作って終わりではない。次のときに更新する。

- **同じような見た目を2回書いた**とき → `ui.css` に部品として切り出す
- **トークンに無い色・サイズが必要になった**とき → その場で生値を書かず、
  本当に必要かを検討したうえでトークンとして追加する
- **原則1（緑と青の役割）に例外を作りたくなった**とき → まず本当に例外が必要か疑う。
  作るなら**この文書に理由を書いてから**にする（後から見て意図が分かるように）

変更したら、この文書・`index.css`・`ui.css` の3点が食い違わないようにする。
