# このリポジトリで作業するエージェントへ

ローカルの PLaMo 3 Translate（llama-server）で Web ページと PDF を訳す Chromium 拡張機能（Manifest V3）。使い方・機能の説明は `README.md`。

## 最初にすること: 使える状態か確かめる

クローン・フォークした直後や、利用者に「構築して」「セットアップして」「動くようにして」と頼まれたときは、まず次を実行する。

```powershell
powershell -ExecutionPolicy Bypass -File server\check.ps1 -NoStart
```

`READY` でなければ、`SETUP.md` の手順を上から進めて揃える（llama.cpp b11946 以降・モデル・`server\config.json`・中継プログラムの登録・ブラウザへの読み込み）。最後に `-NoStart` なしで `server\check.ps1` を実行し、実際に1文訳せて `READY` になったら構築は完了。ダウンロードの置き場所と、ブラウザへの読み込み（人の操作）は利用者に頼む。

以下は、コードを直すときの決まりと落とし穴。

## 作り

- ビルドの手順はない。素の JavaScript（ES modules）、依存は同梱の pdf.js（`vendor/pdfjs`、pdfjs-dist 5.7.284）だけ。npm・バンドラ・TypeScript を持ち込まない
- 翻訳の依頼の流れ: `content.js` / `viewer.js` → `shared.js`（`Plamo.translate`）→ `background.js`（同時 4 本の待ち行列・キャッシュ・サーバーの自動起動）→ llama-server の `/v1/chat/completions`
  - 訳し先は `chat_template_kwargs.target_lang`。文脈は system メッセージで渡す（`[plamo-translate]` で始まらない system を、PLaMo のテンプレートが文脈として読む）
  - 拡張機能の外（`test/` を http.server で開いたとき）では、`shared.js` がサーバーへ直接つなぐ
  - リンク・太字・文中の式は `<t1>…</t1>` の印で囲んで送り、訳文の中の印の位置に戻す
- サーバーの起動・停止: `background.js` → ネイティブメッセージング（`host/host.py`、名前 `com.plamo.translate_host`）→ `server/start-plamo.ps1` / `stop-plamo.ps1`。拡張機能の ID は manifest の `key` で固定してあり、`host/install.ps1` の `allowed_origins` と対になっている。`key` を変えない
- PDF: `viewer.js` が描画と翻訳の受け渡し、`pdftext.js` が文字と描画命令を段落・数式・表・図に分ける（`blocksFromPage`・`graphicsBoxes`）。数式・図・元の表は高解像度の描画から切り抜いた画像で見せる

## 守ること

- 画面の文言（トースト・メニュー・設定・ビューア）と `README.md` は日本語。コードの識別子とコメントは英語
- コメントには「触ると壊れる理由」だけを書く。経緯・数値の根拠・日付は書かず、必要なら `README.md` の該当の節に書く
- 機能や挙動を変えたら、同じコミットで `README.md` の説明も直す
- PC 固有の値（パス・Python の場所・ポート以外の個人設定）をコードに書かない。サーバーの設定は `server/config.json`（git 管理外、例は `config.example.json`）、`host/host.bat` と host の manifest は `install.ps1` が書く（どちらも git 管理外）
- 論文 PDF をコミットしない（`test/fetch-papers.ps1` で落とす）。個人のパス・メールアドレス・トークンを入れない
- `.ps1` は ASCII で書く（Windows PowerShell 5.1 は BOM なしの UTF-8 を読み違える。日本語を入れるなら UTF-8 BOM 付き）
- 新しい権限を manifest に足すときは、何に使うかを README に書く

## 確かめ方

1. 構文: `for f in *.js; do node --check "$f"; done`（`node --check` は1回に1ファイルしか見ない。Node 22 以降なら ES module の `viewer.js`・`pdftext.js` もそのまま通る）
2. サーバー: `server/start-plamo.ps1`（`config.json` が要る）。`http://127.0.0.1:11437/health` が返れば動いている
3. 拡張機能なしで試す: このフォルダで `python -m http.server 8765 --bind 127.0.0.1`
   - `viewer.html?file=/test/sample.pdf`: PDF ビューア
   - `test/page.html`: Web ページの翻訳
   - `test/analyze.html?files=papers/a.pdf,papers/b.pdf`: 全ページの分け方と怪しい箇所の一覧。**`pdftext.js` を変えたら、`test/fetch-papers.ps1` で落とした6本（1段組・2段組・数式・表・図が混ざる）で、変える前と後を見比べる**。1本で良くなっても別の論文で崩れることが多い
4. 中継プログラム: 長さ（4 バイト、リトルエンディアン）付きの JSON（`{"cmd":"status"}` / `{"cmd":"start","size":"2b"}` / `{"cmd":"stop"}`）を `host/host.bat` の標準入力に渡し、返事を読む
5. 実物のブラウザ: 拡張機能のページで再読み込みしてから試す。background の service worker のログは拡張機能のページの「Service Worker」から見る

## 落とし穴（踏んだもの）

- llama.cpp は b11946 以降でないと PLaMo 3 の tokenizer（`plamo3`）を読めない
- llama-server を起動するスクリプトの出力をパイプで受けると、llama-server がパイプを引き継いで EOF が来ず、呼び出し側が永久に待つ。`host.py` は一時ファイルで受けている
- ブラウザは中継プログラムを job object に入れることがあり、子プロセスが道連れで止まる。`CREATE_BREAKAWAY_FROM_JOB` で抜けている
- 裏に回ったタブでは `requestAnimationFrame`・`IntersectionObserver`・`img.decode()` が止まる。pdf.js の描画は `intent: "print"`、画像は `onload` で待つ（`decode()` を使わない）
- pdf.js のフォントの本当の名前（`CMMI10` など）は `page.commonObjs.get(fontName).name` から取り、ページを描画した後でないと取れない。数式の判定はこれに頼っている
- `getOperatorList` の描画の箱は CTM で変換し、クリップ（paint が `endPath` の `constructPath`）で切る。切らないとグラフの曲線の箱がページの外まで伸びる
- 短い語（表のセル・メニュー）は文脈なしで送ると誤訳する（evicted → 「退去」）。題名や周りの文を文脈として渡す
- 印刷のレイアウトは `body.print-layout`（`viewer.css` の末尾）。画面で同じレイアウトを測ってから文字を縮めて（`fitRows`）印刷するので、印刷用の CSS を `@media print` だけに書かない
