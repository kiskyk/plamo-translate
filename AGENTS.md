# 環境構築

このリポジトリを使える状態にするときの手順。

1. 足りないものを確かめる

   ```powershell
   powershell -ExecutionPolicy Bypass -File server\check.ps1 -NoStart
   ```

2. NG の項目を `SETUP.md` の手順で揃える（llama.cpp b11946 以降・モデル・`server\config.json`・`host\install.ps1` での登録）
3. 仕上げに `-NoStart` を付けずに実行する

   ```powershell
   powershell -ExecutionPolicy Bypass -File server\check.ps1
   ```

   サーバーを起動して英語1文を日本語に訳し、`READY` と出れば完了
4. ブラウザへの読み込みは人の操作が要る（`SETUP.md` の手順 6）。手順を伝えて、終わるのを待つ

次のことは、実行する前に利用者に聞く。

- ダウンロードの置き場所
- 8B モデルも落とすか（既定は 2B だけ）

`server\config.json`・`host\host.bat`・`host\com.plamo.translate_host.json`・`server\logs\` は PC ごとに作るファイル。コミットしない。
