# PHASE3A_DESIGN.md — CertFix scan 統合の設計（正本）

> Note: references like "D-0xx" point to internal decision records not included in this repository.

前提: `SPIKE_CERTFIX_ADAPTER.md`（特に §7）、D-015（Phase 3 先行）、D-016（API route）。
scope: **scan 統合まで**（repair/validation 統合は Phase 3b）。context の LLM 補完は Phase 2 に据え置き、Phase 3a の実ファイルは「items 空の draft」で流す（UI は sample_clean で実証済みの経路）。

## 1. 構成

```
c-repair/
├── services/repair-api/          新規（Python 3.10+, FastAPI + uvicorn）
│   ├── pyproject.toml            fastapi / uvicorn / httpx(certfix 依存)
│   ├── src/repair_api/
│   │   ├── main.py               FastAPI app, CORS(localhost:5173), /health
│   │   ├── adapter/certfix_adapter.py   CertFix 呼び出しと写像（§3）
│   │   ├── compose.py            Augmented C 合成（CONTRACT §2.2 の Python 実装）
│   │   ├── functions.py          関数 inventory（certfix splitter 利用）
│   │   └── schemas.py            contract 6 object の Pydantic model（schema 準拠）
│   └── tests/                    fake backend による単体テスト + fixture parity テスト
└── apps/web/src/client/HttpClient.ts   新規（RepairApiClient 実装）
```

- certfix は**非 editable install または PYTHONPATH** で参照（certfix-dev へ書き込まない）。
- server は **stateless**: 各リクエストが必要な contract object を運ぶ。session 永続化はしない（未決 #8 は据え置き。source はリクエスト処理中の per-job temp dir のみに存在し、処理後に削除。計画書 §15.1）。

## 2. HTTP API（body はすべて contract JSON そのもの）

| endpoint | in → out | 備考 |
|---|---|---|
| GET /health | → {status, engine{id,version}, adapter{id,version}} | 起動確認・identity |
| POST /context/infer | {source_document} → context_augmentation_set | **Phase 3a は常に items 空の draft**（status=draft, revision=null）。Phase 2 で実装置換 |
| POST /context/confirm | {context_augmentation_set} → 同（confirmed） | revision は決定論: `ctxrev-` + sha256(original_hash + 全 items の current_text 連結) 先頭 12 hex。同一内容の再 confirm は同一 revision |
| POST /scan | {source_document, context_augmentation_set} → function_scan_result | set.status=confirmed / set.original_hash=source.content_hash を検証、不一致は 409 |
| POST /repair | … | **Phase 3a は 501** を返す（Phase 3b で実装） |

**RepairApiClient interface の変更**: `scan(source, contextRevisionId)` → `scan(source, confirmedSet)`、`repair(source, contextRevisionId, functionId)` → `repair(source, confirmedSet, functionId)`。HttpClient が Augmented 合成材料（items）を必要とするため。FixtureClient も追随（revision は set から読む。挙動不変）。

## 3. adapter の写像規則（spike §4/§7 の確定事項）

1. **合成**: `compose.py` が CONTRACT §2.2 どおり Augmented C を合成（marker 2 行 + 注意書き 1 行 + items + 空行 + Original byte 不変）。`prelude_line_count = 4 + Σ items 行数`。**JS 実装（packages/core/prelude.js）との等価性は fixture parity テストで担保**（tests/fixtures の augmentation 3 セットに対し prelude_line_count と合成結果を照合）。
2. **関数 inventory**: Original C を `certfix.core.preprocessor.Preprocessor`（行構造保存）に通し、`certfix.core.splitter.split_functions` で関数名・開始/終了行を取得（processed 座標 = Original 座標）。prelude 範囲内（stub 等）に完全に含まれる関数は inventory から除外。
3. **scan**: per-job temp dir に Augmented C を書き、`Detector.check_file`（generic 関数チャンク経路）を実行。violation.line（Augmented 座標）から `prelude_line_count` を減算して Original 座標へ。
4. **finding への写像**:
   - 行番号を関数 range に突き合わせて帰属。関数外は UI に出さず `diagnostics` としてログ（V1 仕様）。
   - `rule_id == "UNKNOWN-CERT-C"` → kind=uncertain（防御的写像）。それ以外は kind=violation。
   - **D-003**: 同一関数に複数 violation が写像された場合、先頭（最小行）だけを finding とし、残りは diagnostics に記録。
   - `assumption_dependent` = 対象 source に items 空でない prelude があり、かつ item に未確認(assumption)が含まれる場合…Phase 3a は items 空のため常に false。confirm 済み items がある場合は「provenance が llm_inferred の item が 1 つ以上」で true とする。
5. **identity**: engine={id:"certfix", version:certfix.__version__} / adapter={id:"certfix-inprocess", version:"0.1.0"} / rule_profile={id:"cert-c", version:"certfix-0.4.1-bundled"}。model 名は config 由来を FunctionScanResult 生成時に付与しない（scan 結果 schema に model field はない。repair 側 Phase 3b で model_identity を付与）。
6. **config**: 同梱 `deepseek-v4-flash-api.yaml` を repair-api 同梱 config としてコピー保持（certfix-dev への依存パスを runtime に持たない）。`DEEPSEEK_API_KEY` は環境変数（.env 読み込み）。timeout は check 用に 120s。

## 4. Web 側変更

- `HttpClient.ts`: RepairApiClient 実装。base URL は `VITE_API_BASE_URL`。設定時は HttpClient、未設定時は従来どおり FixtureClient（**E2E は FixtureClient のまま維持** — CI に API key を要求しない）。
- Screen 1/2 に **外部送信の明示**（D-016、計画書 §15.1）: 「Analyze / Scan 実行時、ソースコードが LLM provider（DeepSeek API）へ送信されます」を HttpClient 使用時のみ表示。
- エラー状態: backend 未起動（fetch 失敗）/ 409（hash・revision 不整合）/ 5xx を利用者可読なエラー表示に。scan の in-progress 表示は既存 D-011 実装をそのまま使用（timeout は 180s に延長）。
- 実ファイル flow: Upload（任意 .c）→ Analyze（items 空 draft が返る）→ Confirm → 実 scan 結果表示。ここまでが Phase 3a の受入範囲（Generate repair は 501 → repair_failed 相当の表示で可）。

## 5. テスト戦略

1. **Python 単体（LLM なし）**: fake InferenceBackend（固定 violation を返す）を注入し、prelude 減算 / 関数帰属 / UNKNOWN→UNCERTAIN / 複数 violation の D-003 縮約 / 関数外 diagnostics / 409 系を検証。
2. **fixture parity**: tests/fixtures の 3 セットで compose の prelude_line_count・合成テキストが JS 実装と一致（validator の合成規則と同一入力で照合）。
3. **E2E**: 既存 4 spec は FixtureClient のまま不変で pass。
4. **live smoke（手動・opt-in）**: `DEEPSEEK_API_KEY` がある環境でのみ動く script（server 起動 → sample_sensor.c を HTTP で scan → FunctionScanResult が schema validate されることを確認）。CI 化しない。

## 6. 実装ラウンドの分割と受入条件

- **R-1 repair-api scaffold + adapter + 単体テスト**（backend round）
  - 完了条件: `uvicorn` 起動で /health が identity を返す。fake backend 単体テスト全 pass。fixture parity テスト全 pass。pytest 1 コマンド実行可。certfix-dev 無変更。
- **R-2 Web HttpClient + 通知/エラー UI + client 切替**（frontend round）
  - 完了条件: typecheck/build/validate/E2E（FixtureClient）全 pass。`VITE_API_BASE_URL` 設定時に HttpClient が選ばれ、未起動 backend で可読エラー。外部送信の明示が HttpClient 時のみ表示。
- **R-3 結合検証**: server を実起動し、live smoke で実 .c の scan → UI 表示まで通す。実測時間・UNKNOWN 発生率を記録する。

## 7. Phase 3a の制約（追加分）

- repair-api は localhost bind のみ（0.0.0.0 にしない）。認証なしのまま公開しない（未決 #9 は public hosting 時）。
- source content をログ出力しない（エラーログにも本文を含めない。hash と行番号のみ）。
- per-job temp dir は処理終了時に必ず削除。
