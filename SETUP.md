# セットアップ手順（クローン・フォーク直後）

このリポジトリを新しい PC で使える状態にする手順。人が読んでも、コーディングエージェント（Claude Code・Codex など）にリポジトリの URL を渡して「使えるようにして」と頼んでも進められるように書いてある。

ゴールは `server\check.ps1` が `READY` を出し、ブラウザに拡張機能が読み込まれている状態。

**0.8B だけ使う PC（ノート PC など）は、手順 0〜5 が要らない。** 拡張機能には 0.8B をブラウザの中で動かす内蔵エンジンがある。手順 6 で読み込み、最初の翻訳でモデル（約 0.57 GB）が自動で落ちてくる。中継プログラムを登録していなければ、設定の「翻訳エンジン」は既定の「自動」のまま内蔵エンジンになる。利用者が「0.8B で」「サーバーなしで」「ブラウザだけで」と言ったら、この進め方にする。

## エージェントへ

- まだクローンしていなければ、`%USERPROFILE%\plamo-translate` にクローンする。ブラウザはこのフォルダを読み続けるので、一時フォルダに置かない
- 上から順に進める。各手順の「確かめる」が通ってから次へ
- すでに入っているもの（llama.cpp・モデル・Python）は探して使い、二重に落とさない
- 利用者の指定がなければ、聞かずに次の既定で進める
  - 置き場所: `%LOCALAPPDATA%\plamo-translate\llama.cpp` と `%LOCALAPPDATA%\plamo-translate\models`
  - モデル: 2B だけ（約 1.8 GB）。llama.cpp は CUDA 版で約 680 MB、Vulkan 版で約 40 MB
- そのドライブの空きが 5 GB より少ないときだけ、置き場所を利用者に聞く
- ブラウザへの読み込み（手順 6）だけは人の操作が要る。クローン先のフルパスと一緒に手順を示して待つ
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
- Python 3 がなければ `winget install -e --id Python.Python.3.13 --scope user` で入れる（winget がなければ https://www.python.org/downloads/ から入れてもらう）。Microsoft Store の空の `python.exe`（`WindowsApps` の中）は使えない
- macOS・Linux では、サーバーの起動スクリプト（`server\*.ps1`）と `host\install.ps1` が動かない。拡張機能そのものは、llama-server を手で起動すれば使える（手順 4 の手動起動を参照）

## 1. llama.cpp（b11946 以降）

PLaMo 3 の tokenizer（`plamo3`）は b11946 より古い llama.cpp では読めない。

**すでにあるなら**、`llama-server.exe --version` の `build` が 11946 以上か確かめる。

**ないなら** https://github.com/ggml-org/llama.cpp/releases から、GPU に合う zip を落として展開する。Windows の zip は `b<番号>` のリリース（Pre-release 扱い）にしかない。`v0.9.0` のような安定版のタグや、GitHub の「Latest」には zip がないので使わない。

| GPU | 落とすもの |
|---|---|
| NVIDIA（ドライバが CUDA 12.4 以上） | `llama-<tag>-bin-win-cuda-12.4-x64.zip` と `cudart-llama-bin-win-cuda-12.4-x64.zip`（同じフォルダに展開） |
| AMD・Intel・古い NVIDIA | `llama-<tag>-bin-win-vulkan-x64.zip` |
| GPU なし | `llama-<tag>-bin-win-cpu-x64.zip`（遅い） |

```powershell
$dir = "$env:LOCALAPPDATA\plamo-translate\llama.cpp"
New-Item -ItemType Directory -Force $dir | Out-Null
$rel = (Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20") | Where-Object { $_.tag_name -match '^b\d+$' } | Select-Object -First 1
# NVIDIA の例。Vulkan なら "llama-$($rel.tag_name)-bin-win-vulkan-x64.zip" だけにする
$want = "llama-$($rel.tag_name)-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"
foreach ($a in $rel.assets | Where-Object { $want -contains $_.name }) {
    Invoke-WebRequest $a.browser_download_url -OutFile "$dir\$($a.name)"
    Expand-Archive "$dir\$($a.name)" $dir -Force
    Remove-Item "$dir\$($a.name)"
}
```

どれが合うか分からなければ、Vulkan 版を選ぶ（多くの GPU で動く）。

**確かめる**: `<置き場所>\llama-server.exe --version` が `build 11946` 以上を出す。

## 2. モデル

Hugging Face の pfnet（ログイン不要）から Q4_K_M を1つのフォルダに落とす。

```powershell
$dir = "$env:LOCALAPPDATA\plamo-translate\models"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_K_M.gguf" -OutFile "$dir\plamo-3-translate-2b-Q4_K_M.gguf"
# ほかのサイズも使うなら（任意）。$s は 0.8b / 8b / 31b（31B は約 20 GB）
# $s = "8b"; Invoke-WebRequest "https://huggingface.co/pfnet/plamo-3-translate-$s-GGUF/resolve/main/plamo-3-translate-$s-Q4_K_M.gguf" -OutFile "$dir\plamo-3-translate-$s-Q4_K_M.gguf"
```

ファイル名は変えない。起動スクリプトは `plamo-3-translate-<0.8b|2b|8b|31b>-Q4_K_M.gguf` を探す。モデルの利用条件は各モデルのページの LICENSE（PLaMo コミュニティライセンス）に従う。

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

`up (2b, port 11437)` と出れば動いている。起動できなければ `failed` と出る（待つのは最大 300 秒）。

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

Chrome・Chromium・Vivaldi・Edge に登録する。フォルダを移したら、もう一度実行する。

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
- サーバーが起動しないときは、ボタンの「!」にカーソルを乗せて理由を読む。「中継プログラムを呼び出せません」なら手順 5 をやり直す

## 困ったとき

| 症状 | 見るところ |
|---|---|
| `check.ps1` の llama-server が NG（build が足りない） | 手順 1 で新しいリリースを落とす |
| `start-plamo.ps1` が `failed` | `plamo_server_2b.err`。`unknown tokenizer` なら llama.cpp が古い。`out of memory` なら `gpuLayers` を下げる |
| 「中継プログラムを呼び出せません」「中継エラー」と出る | 手順 5。拡張機能の ID が違わないか（手順 6 の 4） |
| 訳は出るが遅い | `nvidia-smi` で GPU に載っているか。CPU 版の llama.cpp を使っていないか |
| PDF のタブでボタンを押しても何も起きない | ローカルの PDF なら「ファイルの URL へのアクセス」をオンにする |
