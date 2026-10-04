# VSIXのビルドと配布

## ビルドする

リポジトリのルートで依存関係を導入し、bridge wheelを用意してから実行する。

```sh
npm install
bash tools/build-bridge-dist.sh
npm run package:vsix -- all
```

単体なら`all`を`darwin-arm64`、`win32-x64`、`linux-x64`に置き換える。Linux版には`tools/build-local-engine.py`で用意した`apps/vscode/engine-dist`が必要。Mac・Windows版の作成にはLinuxのエンジンアーカイブは不要。

コマンドはビルドを1回実行し、指定ターゲットのVSIXを順に作成する。完成すると出力先を表示する。

```text
dist/vsix/dev/<自動生成のビルドID>/
  c-repair-0.2.0-darwin-arm64.vsix
  c-repair-0.2.0-win32-x64.vsix
  c-repair-0.2.0-linux-x64.vsix
  SHA256SUMS
  manifest.json
```

VSIXの名前と内部バージョンは`apps/vscode/package.json`から生成する。開発ビルドの違いは一意なビルドIDで区別し、過去の成果物は上書きしない。公開する新版では`package.json`のバージョンを更新する。`tools/package-local-mac.mjs`は互換入口で、ファイル名の指定は受け付けない。

## 生成物と一時領域

- **ソース:** `apps/vscode/src`、`resources`、`media`、利用者向けガイド等。
- **開発用出力:** `apps/vscode/dist`はF5・watch用。パッケージ作成では変更しない。
- **同梱素材:** `apps/vscode/bridge-dist`、`engine-dist`。既存の整合性manifestと照合してから同梱する。
- **配布物:** `dist/vsix/dev/<ビルドID>`。OSの一時領域でビルド・ZIP検証を完了し、共有先にコピー・ハッシュ照合してから完成ディレクトリとして配置する。
- **保存する証跡:** `dist/vsix/evidence`。過去の実機検証や再現に必要なVSIXを元の名前・ハッシュのまま保管する。

`dist/`はGit管理の対象外。生成物はディレクトリごと共有・転送し、ソースにコミットしない。パッケージ作成時に`.local-package-*`や`.mac-package-*`をソース内へ作ることはない。

## 転送してインストールする

同じディレクトリのVSIX、`SHA256SUMS`、`manifest.json`を一式で転送する。Dropboxではローカルで完成していても別端末で同期が終わっているとは限らない。転送先でそのディレクトリに移動して確認する。

```sh
# Linux
sha256sum -c SHA256SUMS
# macOS
shasum -a 256 -c SHA256SUMS
```

WindowsではPowerShellの`Get-FileHash -Algorithm SHA256`の値を照合する。`manifest.json`の版数・ターゲット・ファイル名・サイズも確認する。ビルド元commitとdirty状態は参考情報であり、未コミットのソースを再現できる保証ではない。`packagedInputSha256`はステージした配布素材とbundleの識別用で、全ソースのスナップショットではない。

自分のOSに合うVSIXをVS Codeの **Install from VSIX…** で導入する。CLIを使う場合は実際のファイル名を指定する。

```sh
code --install-extension c-repair-0.2.0-darwin-arm64.vsix --force
```

開発版は同じ内部バージョンの場合があるため、今回インストールしたビルドIDとハッシュをテスト記録に残す。

## 失敗した場合

ビルド・同梱素材のハッシュ・ZIPのCRC・ターゲット・転送照合に失敗した場合、完成した成果物として表示しない。一時領域は終了時に削除する。後始末に失敗した場合は残った場所を警告し、元のビルドエラーを保つ。

同じチェックアウトのパッケージ作成には端末内ロックがある。強制終了後にロックが残った場合は、そのビルドが終了していることを確認してから、エラーメッセージに表示されたロックディレクトリを削除する。`dist/vsix/.incoming-*`が残っている場合も、進行中の転送でないことを確認して整理する。既存の残骸を自動削除しない。

ローカルのロックはDropbox経由の別端末には効かない。同じ同期中のチェックアウトを複数端末で同時編集・ビルドしない。Macだけでビルドしたい場合も同じコマンドを使えるが、依存関係はMac用に導入する。

## 検証と公開

```sh
npm run test:packaging
npm run typecheck:vscode
```

パッケージ処理は全ZIPエントリのCRC・サイズ、版数・ターゲット、英日それぞれの利用ガイド／ローカル設定ガイド（計4本）・練習用テンプレート `resources/quick-start.c`・CHANGELOG・bundle・wheelのハッシュ、OS別の同梱内容を確認する。Mac版のみMLX runtimeを、Linux版のみCUDAエンジンアーカイブを同梱する。パッケージの検証はMac MetalやWindows CUDAでの実推論の確認とは区別する。

Cソースは練習用テンプレート1本だけを同梱し、他のテスト用Cファイルは除外する。

このコマンドはMarketplaceへ公開しない。掲載内容のREADMEと公開ガイドを整えてからVSIXを作成し、公開時の手順は[公開手順書](RELEASE_RUNBOOK.md)を参照する。
