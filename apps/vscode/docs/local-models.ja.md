# ローカルモデルの設定ガイド

[English](local-models.md)

APIキーを使わず、このコンピューターで違反検出・修正・LLM検証を実行します。

初めてモデルを準備する場合は、[初回セットアップ](#初回セットアップ)から始めてください。Scanから修正・適用までの操作は、[利用ガイド](user-guide.ja.md)で説明しています。

- [設定を変更して保存する](#設定を変更して保存する)
- [Reasoningと速度を調整する](#reasoningと速度を調整する)
- [トークン上限とメモリを調整する](#トークン上限とメモリを調整する)
- [初回セットアップ](#初回セットアップ)
- [困ったとき](#困ったとき)
- [詳細設定](#詳細設定)

## 設定を変更して保存する

実行中のスキャン・修正が終了してからApplyしてください。処理中も設定の編集はできます。

1. **C Repairの歯車 → Setup → Local Setup → Local model settings**を開きます。
2. 設定項目を選び、値を変更します。
3. 画面上部の **✓ Apply changes** を選びます。

変更は次のローカル処理から使用します。**Esc**は未保存の変更を取り消します。

コマンドパレットの**C Repair: Configure Local Inference**でも同じ設定画面を開けます。

| 設定項目 | 変更する内容 |
| --- | --- |
| Scan reasoning | 違反検出・修正後の違反除去確認の推論量 |
| Repair reasoning | 修正生成・意味的な検証の推論量 |
| Model and quantization | モデルまたは量子化 |
| Model location | ダウンロード先または既存モデルの場所 |
| Advanced settings | トークン上限・timeout・実行設定 |

別のモデルファイルが必要な場合、Applyのボタン名は**Download and apply**または**Verify model and apply**になります。

**C Repair Leaderboard**は[モデルの評価結果](https://safe-c-ai.github.io/c-repair-leaderboard/cert-c/)を開きます。選択中のモデルは変わりません。

## Reasoningと速度を調整する

**Local model settings → Scan reasoning**または**Repair reasoning**を開きます。

| モデル | Reasoningの選択肢 |
| --- | --- |
| Qwen3.8-27B | `xhigh`、`medium`、`low`、`off` |
| Ornith-1.5-35B-A3B | `on`、`off` |

他のモデルでは選択肢が異なる場合があります。

- **品質を優先する：** Qwen3.8では`xhigh`を使います。小さなコードでも推論に時間がかかる場合があります。
- **Qwen3.8で速度を優先する：** `medium`や`low`を試し、検出件数・修正品質への影響を確認します。
- **Reasoningを無効にする：** `off`を選びます。
- **Scanを修正と揃える：** Scan reasoningで**Same as repair**を選びます。

変更後は **✓ Apply changes** で保存してください。保存済みReasoning設定は拡張の更新後も維持します。**Model default**、`unverified`、カスタム設定は[詳細設定](#詳細設定)で説明しています。

## トークン上限とメモリを調整する

**Local model settings → Advanced settings**を開きます。

| 設定項目 | 1回のモデル呼び出しで対象になるもの |
| --- | --- |
| Context length | 入力＋推論＋最終回答 |
| Generation limit（MLX） | 推論＋最終回答 |
| Repair and detection limit（GGUF） | 推論＋最終回答 |
| Declaration completion limit | 補助宣言の生成。通常4,096トークン |
| Timeout | 待ち時間（秒） |

使用中の実行環境（MLXまたはGGUF）に対応する生成上限の項目を選びます。生成上限は、違反検出・修正・LLM検証に適用します。

**生成上限はスキャンするコードのサイズではありません。** 小さなコードでも推論トークンを多く使うことがあります。宣言補完の4,096トークンは、違反検出の上限ではありません。

たとえば**生成上限32K**なら、contextには**32Kに加えて入力を収める余裕**が必要です。contextを増やすとKVキャッシュのメモリ使用量が増えます。生成上限を増やすと、長い推論を許容する分、処理時間も増える場合があります。

メモリが足りない場合はcontextを減らすか、**Model and quantization**で小さい量子化を選びます。GGUFでは**KV cache → q8_0**や**GPU layers**でもGPUメモリ使用量を調整できます。これらのGGUF用設定はMLXにはありません。

## 初回セットアップ

### 始める前に

初回のモデル・実行環境のダウンロードにはネット接続が必要です。

拡張を実行するコンピューターに合うVSIXを使います。WSLやリモート接続では、接続先のパッケージ・メモリ・モデルファイルを使用します。

| 環境 | VSIX |
| --- | --- |
| Apple Silicon Mac | darwin-arm64 |
| Windows x64 | win32-x64 |
| Linux／WSL2 x64 | linux-x64 |

- **Mac：** macOS本体のARM64版VS Codeを使います。
- **Windows：** Microsoft Visual C++ x64ランタイムが必要です。GPU実行には、対応するNVIDIA GPUとドライバーも必要です。
- **Linux：** NVIDIA GPU実行には、対応GPU・ドライバー・AVX2対応CPUが必要です。CPUのみで実行する場合、NVIDIA GPUやドライバーは不要です。

推論エンジンは拡張が準備します。CUDA Toolkitの導入やエンジンのビルドは不要です。

### 手順

1. 上の表で選んだVSIXをインストールします。
2. **C Repairの歯車 → Setup → Local Setup → Set up or start local model**を開きます。空の結果画面の**Use a local model**からも開始できます。
3. モデルを選びます。メモリ設定は自動です。必要な場合だけ保存先や設定を変更します。
   GGUFセットアップで**Change settings**を開いた場合は、**Done**で戻ります。
4. **Download and start**（取得済みなら**Start local model**）を選びます。
5. `.c`ファイルを開き、**Scan Current File**または**Scan & Fix Current File**を実行します。

拡張がモデル・推論エンジン・Pythonブリッジを準備します。推論サーバーを利用者が起動する必要はありません。

**Context Review**が表示された場合は、補完された宣言を確認して続行します。

### Mac：MLX

通常ダウンロードは**Qwen3.8-27BのMLXモデル**です。共有メモリから量子化とトークン上限を自動設定します。

| Macのメモリ | 量子化 | Context | 生成上限 |
| --- | --- | ---: | ---: |
| 16 / 18 GB | 2bit（実験的） | 32K | 16K |
| 24 GB | 3bit | 64K | 32K |
| 32 / 36 GB | 4bit | 64K | 32K |
| 48 GB以上 | 5bit | 64K | 32K |

1Kは1,024トークンです。macOSや他のアプリも共有メモリを使うため、それらと推論用の余裕を確保してください。

新規MLX設定は**Scan reasoning**と**Repair reasoning**の両方が`xhigh`です。16 GB未満では自動ダウンロード候補を提示せず、**Custom model**を使います。

### Windows／Linux：GGUF

**Qwen3.8-27B**、**Ornith-1.5-35B-A3B**、既存GGUFを指定する**Custom model**から選びます。選んだモデルの量子化・GPU／RAM配置は自動設定します。Ornithの自動設定には**32 GB以上のRAM**が必要です。

自動対応外のGPUや手動エンジンを使う場合は、**Advanced settings → Inference engine**から互換エンジンを指定します。Windows／Linuxの自動GPU対応はNVIDIAです。AMD・Intel GPUでの高速化にはカスタムエンジンが必要です。

### モデルの保存場所

通常の保存先は拡張専用の保存領域にある`local-models`です。実際のパスは**Model location**で確認できます。

ダウンロードは中断後に再開できます。既存モデルはコピーせずその場所で使い、保存済みモデルはセットアップを繰り返さず起動します。

## 困ったとき

### Generation reached … token limit

モデルが回答を完了する前に、生成トークンの上限へ到達しました。

1. **Local model settings → Advanced settings**を開きます。
2. 失敗した処理に対応する上限を増やします。
   - 違反検出・修正・LLM検証：MLXは**Generation limit**、GGUFは**Repair and detection limit**。
   - 補助宣言の生成：**Declaration completion limit**。
3. **Context length**に、新しい上限**と入力の両方**が収まるようにします。たとえば生成32K＋入力8Kなら、contextは最低40K必要です。
4. **✓ Apply changes**を選び、失敗した処理を再実行します。

Qwen3.8での検出・修正では、**Scan reasoning**または**Repair reasoning**を下げ、推論トークンを減らす方法もあります。**✓ Apply changes**を選んで再実行し、品質への影響を確認してください。

### Context不足・メモリ不足

- **Contextエラー：** メモリに余裕があれば**Context length**を増やします。余裕がなければ入力や生成上限を減らします。
- **メモリ不足・ロード失敗：** 他のアプリを閉じ、context・量子化・配置を見直します。GGUFでは**KV cache**と**GPU layers**も確認します。

Context・KV cache・GPU layersは**Local model settings → Advanced settings**、量子化は**Model and quantization**で変更します。**✓ Apply changes**を選んで再実行してください。

### Timeout

**Local model settings → Advanced settings → Timeout**で上限を増やします。または、対応モデルで**Scan reasoning**や**Repair reasoning**を下げます。**✓ Apply changes**を選んで再実行します。

### モデルが見つからない・不完全

**Local model settings → Model location**で指定し直します。管理対象のダウンロードは、**Download this model again**で検証・再開できます。画面に表示される **✓ Apply changes**、**Download and apply**、**Verify model and apply**のいずれかで確定します。

### ブリッジへ接続できない

Outputの **C Repair** ログを確認し、ローカルセットアップを再実行します。初回のブリッジ準備は自動です。旧版から更新して古いブリッジが残っている場合は、**C Repair: Set Up Bridge** でブリッジを更新して再実行します。

### 処理を止めたい

進行通知の**Cancel**を選びます。モデルを停止する場合は、**C Repair: Stop Local Model**を実行します。

### 修正候補を確認する

[利用ガイドの「修正をレビューして適用する」](user-guide.ja.md#修正をレビューして適用する)を参照してください。検証結果、Accept／Reject、再Scanとレポート出力も説明しています。

## 詳細設定

### モデル既定値とカスタムReasoning

選択肢はGGUF内のチャットテンプレート、またはMLXのトークナイザー設定から読み取ります。

- **Model default：** テンプレート既定のReasoningを使います。
- **unverified：** テンプレートを認識できず、対応を確認できていません。
- **Custom…：** Reasoningのテンプレート引数をJSONで指定します。

選択肢は、選択中のテンプレートを認識できるかによって変わります。未認識の場合、表示された選択肢の互換性は未確認です。

### 既存モデルとカスタムモデル

Macの**Custom model**は既存MLXフォルダーまたはGGUFファイルを指定できます。MLXフォルダーには`config.json`・`tokenizer_config.json`・safetensors重みが必要です。GGUFはllama.cppで実行します。

保存済みGGUFは引き続き利用でき、自動置換しません。保存済みのQwen3.6 GGUF設定も引き続き使えます。

### 初期値への復元と再取得

**Restore recommended settings**は自動推奨の開始値へ戻します。MLXでは推論設定を戻し、量子化は**Model and quantization**から変更します。**Download this model again**は管理対象のファイルを検証し、不完全なダウンロードを再開します。管理対象のダウンロードはSHA-256で検証します。

### 実行環境の詳細

- **MLX：** 専用Python 3.12環境、モデルdtypeのKVキャッシュ、並列1、prefill step 512。この実装ではMTP・CPUへのMoE配置・KV形式の変更に対応しません。
- **GGUF：** 入力・物理バッチサイズを変更できます。MTPには対応モデル・エンジンと追加メモリが必要です。**MTP draft tokens**の`0`で無効化します。
- **新規MLXの既定値：** 宣言補完Reasoningは`off`、宣言補完の上限は4,096、timeoutは14,400秒。

Macの容量別設定は開始値です。5bitモデルと拡張の操作はM1 Max／64 GiBで確認済みです。他の容量・量子化は同じ範囲の実機確認を行っていません。


### カスタムPythonブリッジ

`crepair.bridge.pythonPath` に、自分で管理するPython環境を指定した場合だけの手順です。通常のセットアップはC Repair専用環境を使い、**Set Up Bridge** はその専用環境を更新します。

1. 拡張を動かすホストで `code --locate-extension safe-c-ai.c-repair` を実行し、インストール先を確認します。その中の `bridge-dist` にCertFixとrepair-apiのwheelがあります。
2. `crepair.bridge.pythonPath` で指定したPythonを使い、両方のwheelを再インストールします。以下のパスを実際のものへ置き換え、CertFix、repair-apiの順に指定します。

```sh
# macOS / Linux
"<python-path>" -m pip install --force-reinstall "<certfix-wheel.whl>" "<repair-api-wheel.whl>"
```

```powershell
# Windows PowerShell
& "<python-path>" -m pip install --force-reinstall "<certfix-wheel.whl>" "<repair-api-wheel.whl>"
```

その環境でpipの代わりにuvを使う場合は、`uv pip install --reinstall --python "<python-path>" "<certfix-wheel.whl>" "<repair-api-wheel.whl>"` を使います。

3. VS Codeを再読み込みし、更新した環境でブリッジを起動します。Remote／WSLでは、拡張を動かすホスト側で実施してください。
