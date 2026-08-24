# V3_PACKAGING_DESIGN.md — packaging 仕上げ(uv bootstrap 自動化 + vsix + onboarding)設計(正本)

> Note: references like "D-0xx" point to internal decision records not included in this repository.

前提: wheel 配布元・署名・自動更新・stdio 化は本フェーズでも対象外(将来課題)。V0 の `services/repair-api/scripts/bootstrap-uv.sh` PoC(uv→venv→非 editable install→token→/health)を拡張内実装の仕様原型とする。

## 0. ゴール

repo を持たない利用者が **vsix をローカルインストールするだけ**で、`.c` を開き → 案内に従って bridge 環境が自動構築され → scan/repair が動く。Windows は user 協力で実機 smoke(§9 既定)。

## 1. D-036(採用)bridge の配布と実行環境

- **配布物 = vsix に同梱する wheel 群**(`bridge-dist/`: repair-api の wheel + CertFix の wheel + 依存の lock 情報)。配布インフラ・署名・自動更新は作らない(§9 保留のまま。vsix はローカル配布物)。
- **CertFix wheel のビルドは out-of-tree**: certfix-dev を一時ディレクトリへコピーしてからビルドする(setuptools が source tree に egg-info 等を書く経路を遮断し、engine のソースツリーを不変に保つ)。
- **実行環境は extension の globalStorage 配下**(`<globalStorage>/bridge-venv/`)。repo の `.venv` とは独立。venv 作成と wheel install は **uv** で行う(uv 不在時は公式 installer を**同意ダイアログの上で**実行。拒否時は手動手順への誘導リンク)。
- **優先順位**(BridgeManager の python 解決): ① `crepair.bridge.pythonPath`(明示設定)→ ② repo `.venv`(開発者)→ ③ globalStorage の provisioned venv(エンドユーザー)→ ④ 未構築なら bootstrap 案内。
- **pin**: vsix バージョンと bridge wheel のバージョン/sha256 を extension に埋め込み、/health の identity と照合(既存 pin 検査の拡張)。不一致は警告 + 再 bootstrap 提案。

## 2. 実装ラウンド分割

- **V3a: 拡張内 bootstrap** — TypeScript で uv 検出/導入(同意制)→ venv 作成 → 同梱 wheel install → 検証(/health)までを progress 付きで実装。`C Repair: Set Up Bridge` コマンド + 未構築時の scan 起点導線。失敗時は段階別の人間可読エラー(uv なし / ネットワーク / disk)。unit テストは spawn を fake 化。
- **V3b: vsix ビルド** — wheel ビルドスクリプト(out-of-tree、`bridge-dist/` 生成、sha256 記録)+ `vsce package` 一式(`npm run package:vsix`)。生成 vsix のローカルインストール smoke(拡張一覧に出る・アイコン/README 表示)。
- **V3c: onboarding 仕上げ** — 初回起動 walkthrough(key → モード選択(D-031 既存)→ bootstrap → sample scan)と README(インストール・要件・費用目安・データが OpenRouter/provider へ送られる旨)。
- **受入(live)**: repo 外のクリーン環境相当(globalStorage 初期化 + pythonPath 未設定 + repo .venv 不可視)で、vsix install → bootstrap → play.c 相当の scan → repair → Accept が完走。

## 3. 対象外(再確認)

Marketplace 公開 / publisher ID / 署名 / 自動更新 / stdio bridge / hosted backend。Windows 実機検証は user 協力で V3b 後に実施(チェックリストを別途用意)。
