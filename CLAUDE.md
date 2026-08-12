# CLAUDE.md

このファイルは、Claude Code（および他の AI アシスタント）がこのリポジトリで作業する際の指針。

## このリポジトリは何か

プリズナートレーニング（BIG6）の実施を継続するための**個人用 Web アプリ**。
「記録アプリ」ではなく「実行アプリ」。起動した時点で今日やることが確定表示され、
実行の完了が最小操作で記録されることを最優先に設計されている。

- ビルド工程なし。ES モジュールをそのまま配信する素の静的サイト
- 依存パッケージなし（`node_modules` は存在しない。`package.json` に dependencies なし）
- サーバ・アカウント・同期なし。データは端末の `localStorage` のみ
- 表示言語・コメント・コミットメッセージはすべて**日本語**

**仕様書が正**: [`docs/spec/prisoner-training-app-spec-v0.4.md`](docs/spec/prisoner-training-app-spec-v0.4.md)。
コード中のコメントは「仕様書 4.1(c)」のように章番号で仕様を参照している。
ロジックを変更するときは、まず仕様書の該当章を読むこと。仕様書と実装が食い違う場合は、
どちらが正しいかを判断せずユーザーに確認する。

## コマンド

```sh
npm test        # logic.js のテスト（node:test、依存なし）。25 ケース
npm run serve   # 静的サーバ（python3 -m http.server 8000）
```

- 単一テストの実行: `node --test test/logic.test.js`
- 名前で絞る: `node --test --test-name-pattern '昇格' test/logic.test.js`
- リンタ・フォーマッタ・型チェックは設定されていない。周囲のスタイルに合わせる
- ブラウザで確認するときは `npm run serve`。`file://` では ES モジュールと
  `fetch('./standards.json')` が動かない

## ファイル構成と依存の向き

```
index.html        … #app と #modal-root だけを持つ器。app.js を type="module" で読む
app.js            … 画面と状態管理（唯一 DOM に触れるファイル）
logic.js          … 目標算出・昇格／降格・解禁・週集計・表示整形（純粋関数のみ）
timer.js          … テンポカウント・保持・休憩・Web Audio・Wake Lock
store.js          … 永続化の抽象化（localStorage への依存をここに閉じ込める）
standards.json    … ステップマスタの初期テンプレート（初回起動時のみ読む）
style.css         … 全スタイル（CSS 変数は :root にまとめてある）
test/logic.test.js
docs/spec/        … 仕様書
```

依存は一方向: `app.js → { logic.js, timer.js, store.js }`。
`logic.js` / `store.js` は互いに依存しない（テストは両方を import する）。

**守るべき境界**

| 制約 | 理由 |
|---|---|
| `logic.js` に DOM・`window`・`localStorage` を持ち込まない | node:test でそのまま実行できることが前提 |
| `localStorage` を触るのは `store.js` だけ | Capacitor でのネイティブ化時に差し替える範囲を 1 ファイルに限定（仕様書 6.3） |
| 音・タイマー・Wake Lock は `timer.js` に置く | `app.js` はライフサイクル（start/stop）だけを呼ぶ |
| 判定ロジックを `app.js` に書かない | テストできなくなる。導出できる値は `logic.js` の関数として足す |

## データモデル

`localStorage` のキー `prisoner-training-app` に**全データを 1 つの JSON** として保存する。

```js
{
  schemaVersion: 1,
  exercises: [{ id, name, group: 'big4'|'late', startPhase: 'down'|'up' }],
  steps: { [exerciseId]: { '1'..'10': { name, description, unit, mode, perSide, levels: {1,2,3} } } },
  initialState: { [exerciseId]: { step, level } },   // アプリ導入時の現在地
  settings: { ... },                                  // 仕様書 3.8
  records: [],      // 実施記録（仕様書 3.2）
  stepEvents: [],   // ステップ変更イベント（仕様書 3.3）
  pending: null,    // 中断した実行の途中経過（仕様書 5.5(g)）
}
```

**設計原則**: 導出できる状態は保存しない。現在のステップ・級・当日目標・解禁状態は
すべて `records` と `stepEvents` から毎回計算する（`logic.js`）。
保存するのは復元不可能なもの（そのとき提示した `targetOfDay`、ステップ変更の事実）だけ。

ステップマスタの属性:

- `unit`: `'reps'` | `'sec'` — 目標値の単位。漸進幅も `maxIncrement` / `secIncrement` で分かれる
- `mode`: `'rep'`（テンポカウント）| `'hold'`（保持）| `'free'`（カウントなし・手入力）
- `perSide`: 片側種目。実績は `[左, 右]`、判定は**弱い側**で行う（仕様書 4.7）

`standards.json` は**初期値の供給源にすぎない**。起動後は保存領域の値が正で、
設定画面から編集できる。テンプレートを更新しても既存ユーザーには自動反映されない
（設定 → データ →「ステップマスタをテンプレートから読み込む」で明示的に取り込む）。
`standards.json` にフィールドを足したら `store.js` の `createInitialData()`（`store.js:44`）にも追加する。

スキーマを増やすときは `migrate()`（`store.js:80`）に既定値の穴埋めを足す。
既存ユーザーのデータは壊さない。

## ロジックの中心: `simulate()`

`logic.js:183` の `simulate(data, ex)` が事実上すべての導出値の源。
現在ステップの記録を**先頭から順に再生**して、級・当日目標・目標降格の回数を求める。
`currentLevel()` / `targetOfDay()` / `demotionStatus()` / `gridCell()` はこれを呼ぶだけ。

再生の分岐は仕様書 4.1 の (a)〜(d) に対応している:

- (a) ステップ変更直後 → 新ステップの初級基準 × `initialRatio`（0.8）
- (b) 現在の級の基準を満たした → 次の級へ。前の級の総量を新しいセット数で割り直す
- (c) 通常の漸進 → 達成なら `+maxIncrement`、1 回未達は据え置き、2 回連続未達で実績平均まで下げる
- (d) 履歴なし → 級の基準値そのまま

漸進の基準は**レコードに保存された `targetOfDay`**（そのとき実際に提示した目標）。
基準値を後から直しても過去の目標は再計算しない。ここを「現在の基準値」に変えないこと。

画面が必要とする値は `exerciseState(data, ex, today)`（`logic.js:331`）が一括で返す。
新しい表示項目が必要になったら、まずここに足せないか考える。

## `app.js` の作法

**再描画**: 状態を変えたら `render()` を呼ぶ。`render()` は `#app.innerHTML` を丸ごと差し替える。
差分更新はしない。ただし**カウント中の数字・リング・時計だけは例外**で、
`afterRunRender()` 以降のコールバックが `textContent` / `stroke-dashoffset` を直接書き換える
（毎フレーム再描画すると重いため）。

**イベント**: `document` 1 箇所での委譲。ボタンには `data-act="名前"` を付け、
`actions`（`app.js:968`）に同名のハンドラを足す。`addEventListener` を個別要素に付けない
（再描画で消えるため）。フォーム入力は `change` リスナ側で `data-set` / `data-std` /
`data-tempo` / `data-sound` などの属性で振り分ける。

**エスケープ**: テンプレート文字列に値を差し込むときは必ず `esc()` を通す。
ステップ名・説明はユーザー入力であり、そのまま `innerHTML` に載る。

**画面**: `view = { name, ...params }`。`render()` 内の `views` テーブルに
`home` / `run` / `progress` / `settings` / `standards` が並ぶ。遷移は `go(name, params)`。

**実行中の状態**: モジュールスコープの `run` オブジェクト。`run.phase` が状態機械で
`idle → countdown → counting → confirm → rest → done` を遷移する。
タイマーの生成は `afterRunRender()` が `phase` を見て行う（描画後に DOM が要るため）。
`go()` で画面を離れると `stopRun()` が走り、タイマーと Wake Lock を必ず解放する。

**永続化**: 直接 `localStorage` を触らず、`data` を書き換えてから `save()`（= `store.save(data)`）。
セット確定ごとに `savePending()`（`app.js:561`）が中断復帰用の `pending` を書く。
ワークアウトの確定は `finishRun()`（`app.js:578`）が `records` に push して `pending` を消す。

## テスト

`test/logic.test.js` のみ。`node:test` + `node:assert/strict`、依存なし。

- 対象は `logic.js` の純粋関数（と `store.js` の既定値）。DOM を要するコードはテストしない
- テストデータは `makeData()` ヘルパで組む。全種目・全ステップに同じ基準値を入れ、
  `overrides` で `records` / `stepEvents` / `settings` を差し替える
- テスト名は日本語で、仕様書の項番を添える（例: `'(b) 級の移行では前の級の総量を新しいセット数で割り直す'`）
- ロジックを変えるときは**先にテストを足す**。特に `simulate()` の分岐は
  組み合わせで壊れやすい

## CI / デプロイ

`.github/workflows/pages.yml`:

1. `test` ジョブ … Node 22 で `npm test`
2. `deploy` ジョブ … `test` 成功後、リポジトリ全体をそのまま GitHub Pages へ

`main` への push で発火する。ビルドがないので**リポジトリの中身がそのまま公開物**。
公開したくないファイルを追加しない。

Wake Lock API と Web Audio API を使うため HTTPS 配信が前提。

## 変更時のチェックリスト

- [ ] 仕様書の該当章を確認した（挙動を変える場合、仕様書も更新するかユーザーに確認）
- [ ] 判定・算出は `logic.js` に置き、テストを足した
- [ ] `npm test` が通る
- [ ] ユーザー入力を `innerHTML` に載せる箇所は `esc()` を通した
- [ ] 保存データの形を変えたなら `createInitialData()` と `migrate()` を更新した
- [ ] `README.md` の記述（ファイル構成・使い方・実装上の判断）と矛盾しない

## コミットとブランチ

- コミットメッセージは**日本語・命令形の要約 1 行**
  （例: `実行画面：開始前カウントダウンと自動終了を追加`、`目標の表示順を「回数 × セット」に変更`）
- 作業は `claude/<内容>-<id>` 形式のブランチで行い、`main` へは PR 経由でマージする
- PR は明示的に依頼されたときだけ作る
