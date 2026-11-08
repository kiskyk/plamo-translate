# セットアップ手順（クローン・フォーク直後）

このリポジトリを新しい PC で使える状態にする手順。人が読んでも、コーディングエージェント（Claude Code・Codex など）に「SETUP.md のとおりに構築して」と頼んでも進められるように書いてある。

ゴールは `server\check.ps1` が `READY` を出し、ブラウザに拡張機能が読み込まれている状態。

## エージェントへ

- 上から順に進める。各手順の「確かめる」が通ってから次へ
- すでに入っているもの（llama.cpp・モデル・Python）は探して使い、二重に落とさない
- 次のことは、実行する前に利用者に聞く
  - ダウンロードの置き場所。llama.cpp は CUDA 版で約 650 MB（本体と cudart の zip の合計）・Vulkan 版で約 35 MB、2B モデルは約 1.8 GB、8B モデルは約 5.3 GB ある
  - 8B モデルを落とすかどうか。既定は 2B だけ
- ブラウザへの読み込み（手順 6）は人の操作が要る。手順を示して待つ
- 失敗したら `server\check.ps1` の NG の行と、`server\logs\`（または `config.json` の `logDir`）の `plamo_server_*.err` を見る
- 作ったファイルのうち、`server\config.json`・`host\host.bat`・`host\com.plamo.translate_host.json`・`server\logs\` は git 管理外。コミットしない

## 0. 前提を確かめる

```powershell
[Environment]::OSVersion.Version          # Windows 10/11
$PSVersionTable.PSVersion                 # 5.1 以上
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv   # NVIDIA GPU の有無
Get-Command python.exe -All | Select-Object Source   # WindowsApps 以外の python.exe があるか
```

- GPU の種類で、手順 1 で落とす llama.cpp を選ぶ
- Python 3 がなければ https://www.python.org/downloads/ から入れてもらう。Microsoft Store の空の `python.exe`（`WindowsApps` の中）は使えない
- macOS・Linux では、サーバーの起動スクリプト（`server\*.ps1`）と `host\install.ps1` が動かない。拡張機能そのものは、llama-server を手で起動すれば使える（手順 4 の手動起動を参照）

## 1. llama.cpp（b11946 以降）

PLaMo 3 の tokenizer（`plamo3`）は b11946 より古い llama.cpp では読めない。

**すでにあるなら**、`llama-server.exe --version` の `build` が 11946 以上か確かめる。

**ないなら** https://github.com/ggml-org/llama.cpp/releases の最新リリースから、GPU に合う zip を落として展開する。

| GPU | 落とすもの |
|---|---|
| NVIDIA（ドライバが CUDA 12.4 以上） | `llama-<tag>-bin-win-cuda-12.4-x64.zip` と `cudart-llama-bin-win-cuda-12.4-x64.zip`（同じフォルダに展開） |
| AMD・Intel・古い NVIDIA | `llama-<tag>-bin-win-vulkan-x64.zip` |
| GPU なし | `llama-<tag>-bin-win-cpu-x64.zip`（遅い） |

```powershell
# 例: gh がある場合
gh release download -R ggml-org/llama.cpp --pattern "llama-*-bin-win-cuda-12.4-x64.zip" --pattern "cudart-llama-bin-win-cuda-12.4-x64.zip" -D <置き場所>
```

どれが合うか分からなければ、Vulkan 版を選ぶ（多くの GPU で動く）。

**確かめる**: `<置き場所>\llama-server.exe --version` が `build 11946` 以上を出す。

## 2. モデル

Hugging Face の pfnet（ログイン不要）から Q4_K_M を1つのフォルダに落とす。

```powershell
$dir = "<モデルの置き場所>"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_K_M.gguf" -OutFile "$dir\plamo-3-translate-2b-Q4_K_M.gguf"
# 8B も使うなら（任意）
# Invoke-WebRequest "https://huggingface.co/pfnet/plamo-3-translate-8b-GGUF/resolve/main/plamo-3-translate-8b-Q4_K_M.gguf" -OutFile "$dir\plamo-3-translate-8b-Q4_K_M.gguf"
```

ファイル名は変えない。起動スクリプトは `plamo-3-translate-<2b|8b>-Q4_K_M.gguf` を探す。モデルの利用条件は各モデルのページの LICENSE（PLaMo コミュニティライセンス）に従う。

**確かめる**: 2B のファイルが約 1.8 GB（1,807,202,144 バイト）ある。

## 3. サーバーの設定

```powershell
Copy-Item server\config.example.json server\config.json
```

`server\config.json` を書き換える（パスは `/` か `\\` で書く）。

| 項目 | 中身 |
|---|---|
| `llamaServer` | 手順 1 の `llama-server.exe` のフルパス |
| `modelDir` | 手順 2 のフォルダ |
| `logDir` | ログの置き場所。空なら `server\logs\` |
| `gpuLayers` | GPU に載せる層の数。VRAM が足りないときは下げる（0 で CPU だけ） |
| `context` / `parallel` | 文脈長と同時処理の数。普通は変えない |

**確かめる**: `powershell -ExecutionPolicy Bypass -File server\check.ps1 -NoStart` で、config・llama-server・model の行が OK になる。

## 4. サーバーを動かしてみる

```powershell
powershell -ExecutionPolicy Bypass -File server\start-plamo.ps1        # 2B（-Size 8b で 8B）
powershell -ExecutionPolicy Bypass -File server\stop-plamo.ps1
```

`up (2b, port 11437)` と出れば動いている。60 秒待っても起動しなければ `failed` と出る。

Windows 以外で手で起動するときは、同じ引数で llama-server を起動する。

```
llama-server -m plamo-3-translate-2b-Q4_K_M.gguf --alias plamo --port 11437 --host 127.0.0.1 -ngl 99 -c 16384 -np 4 --jinja --no-prefill-assistant
```

`--jinja --no-prefill-assistant` は必須（モデル同梱のチャットテンプレートで訳し先の言語を渡すため）。

## 5. 中継プログラムの登録

拡張機能からサーバーを起動・停止するための仕組み（ネイティブメッセージング）。HKCU に書くだけで、管理者権限は要らない。

```powershell
powershell -ExecutionPolicy Bypass -File host\install.ps1
# Python が見つからないとき
powershell -ExecutionPolicy Bypass -File host\install.ps1 -Python "C:\path\to\python.exe"
```

Chrome・Vivaldi・Edge の3つに登録する。フォルダを移したら、もう一度実行する。

拡張機能の ID は `manifest.json` の `key` で `legfpcfpmfannnifaiobenldancdgbdf` に固定してある。フォークして `key` を消したり変えたりした場合は、ブラウザの拡張機能のページに出る ID を `-ExtensionId <ID>` で渡す。

**確かめる**: `powershell -ExecutionPolicy Bypass -File server\check.ps1` が最後に `READY` を出す（サーバーを起動し、英語1文を日本語に訳すところまで試す）。

## 6. ブラウザに読み込む（人の操作）

1. 拡張機能のページを開く（`chrome://extensions`・`vivaldi://extensions`・`edge://extensions`）
2. 「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」で、このリポジトリのフォルダを選ぶ
4. 出てきた ID が `legfpcfpmfannnifaiobenldancdgbdf` であることを確かめる（違えば手順 5 を `-ExtensionId` 付きでやり直す）
5. ローカルの PDF も開くなら、「詳細」で「ファイルの URL へのアクセスを許可する」をオンにする

**確かめる**:
- サーバーを止めた状態（`server\stop-plamo.ps1`）で、英語の Web ページを開いてツールバーのボタンを押す
- 数秒でサーバーが起動し、段落が日本語に置き換われば完了
- 右下に「中継プログラムが登録されていない」と出たら、手順 5 をやり直す

## 困ったとき

| 症状 | 見るところ |
|---|---|
| `check.ps1` の llama-server が NG（build が足りない） | 手順 1 で新しいリリースを落とす |
| `start-plamo.ps1` が `failed` | `plamo_server_2b.err`。`unknown tokenizer` なら llama.cpp が古い。`out of memory` なら `gpuLayers` を下げる |
| ボタンを押すと「中継プログラムが登録されていない」 | 手順 5。拡張機能の ID が違わないか（手順 6 の 4） |
| 訳は出るが遅い | `nvidia-smi` で GPU に載っているか。CPU 版の llama.cpp を使っていないか |
| PDF のタブでボタンを押しても何も起きない | ローカルの PDF なら「ファイルの URL へのアクセス」をオンにする |
