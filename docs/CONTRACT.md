# CONTRACT.md — domain object / contract 定義（正本）

Web / VS Code 共通 contract の正本。JSON Schema 実体は `packages/contract/schemas/` に置き、本書と齟齬がある場合は本書を正として schema を修正する。

## 1. 共通規約

- **ID**: すべて string。fixture では可読な固定値（例: `"cand-001"`）、実装では UUID 等。
- **hash**: `sha256:` prefix 付き hex 文字列。対象は UTF-8 byte 列（改行変換等の正規化はしない）。
- **行座標**: すべて **Original C 基準、1-indexed、両端 inclusive**。Augmented C 上の位置が必要な場合は `prelude_line_count` を加算して導出する（D-002。実 CertFix 接続時の座標変換は feasibility spike で再検討）。
- **必須 identity**（結果系 object が持つ追跡情報）: `original_hash`、`context_revision_id`、`rule_profile {id, version}`、`adapter {id, version}`、`harness {id, version}`。Phase 1 fixture では `adapter.id = "fixture"` 等の placeholder を許す。
  - 旧表記 `engine` は D-017(a) で `harness` に改名（CertFix は engine ではなく harness / workflow）。
- **contract_version**: 本 contract の版数は `"1"`。bridge の `/health` が申告し、消費者（VS Code 拡張等）が互換確認に使う。schema の破壊的変更時に増分する。
- **marker**（Augmented C の prelude 区切り。export 検証にも使用）:
  - 開始: `/* ===== C Repair inferred context ===== */`
  - 終了: `/* ===== Original source ===== */`

## 2. schema 一覧（6 本、D-007）

### 2.1 source-document.schema.json

Web upload / VS Code active document / fixture を抽象化する core contract。

| field | type | 備考 |
|---|---|---|
| source_id | string | 必須 |
| filename | string | 必須 |
| language | "c" | 必須 |
| content | string | 必須。Original C 全文 |
| content_hash | string | 必須。sha256 |
| size_bytes | integer | 必須 |
| origin | "web_upload" \| "vscode_document" \| "fixture" | 必須 |

### 2.2 context-augmentation-set.schema.json

1 つの source に対する補完 context の集合と revision。

| field | type | 備考 |
|---|---|---|
| set_id | string | 必須 |
| source_id / original_hash | string | 必須 |
| status | "draft" \| "confirmed" | 必須 |
| context_revision_id | string \| null | confirmed 時に非 null |
| prelude_line_count | integer | 必須。合成後 prelude の行数（marker・空行含む） |
| items[] | array | 下記 |

item:

| field | type | 備考 |
|---|---|---|
| item_id | string | 必須 |
| kind | enum | inferred_type / external_global / external_function_declaration / external_function_stub / inferred_macro / opaque_type / validation_helper / other |
| generated_text | string | LLM（fixture）生成時の原文。不変 |
| current_text | string | 表示・使用される現在文。編集可能 |
| provenance | enum | exact_same_file / derived_from_usage / llm_inferred / user_corrected |
| user_edited | boolean | current_text ≠ generated_text で true |
| confirmed | boolean | 利用者確認済みか |
| rationale | string | 推測根拠の説明 |
| usage_evidence[] | array of {line, snippet} | 推測根拠となった Original C 上の使用箇所 |

合成規則（Phase 1、D-002）: `Augmented C = marker開始行 + 注意書き + items[].current_text を連結 + marker終了行 + 空行 + Original C（byte 不変）`。

- 注意書きは固定文字列 1 行: `/* Auto-generated provisional context. Not part of Original source. */`
- items が空でも prelude 構造（marker 2 行＋注意書き 1 行＋空行 1 行 = 4 行）は常に生成する。したがって `prelude_line_count = 4 + Σ items[].current_text の行数`。
- augmentation item は **Original C 内で解決できないシンボルのみ**を対象とする。Original 内に既存の宣言・定義があるシンボルを重複して補完しない（計画書 §7.3: same-file 情報は deterministic 抽出）。

### 2.3 function-scan-result.schema.json

全関数 scan の結果一式（violation inventory）。

| field | type | 備考 |
|---|---|---|
| scan_id | string | 必須 |
| source_id / original_hash / context_revision_id | string | 必須 |
| rule_profile / adapter / harness | {id, version} | 必須 |
| functions[] | array | 下記 |

function:

| field | type | 備考 |
|---|---|---|
| function_id | string | 必須 |
| name | string | 必須 |
| original_range | {start_line, end_line} | 必須。Original C 基準 |
| findings[] | array | **V1 は 0..1 件**（D-003）。schema 上は複数可 |

finding:

| field | type | 備考 |
|---|---|---|
| finding_id | string | 必須 |
| kind | "violation" \| "uncertain" | 必須 |
| rule_id / rule_summary | string | violation では必須。uncertain では rule_id 省略可 |
| explanation | string | 必須 |
| location | {start_line, end_line} | 必須。Original C 基準 |
| assumption_dependent | boolean | 必須。未確認仮定に依存する判定なら true |

### 2.4 repair-candidate.schema.json

| field | type | 備考 |
|---|---|---|
| candidate_id | string | 必須 |
| finding_id / function_id | string | 必須 |
| source_id / original_hash / context_revision_id | string | 必須 |
| status | "repair_ready" \| "repair_failed" \| "validation_failed" | 必須（generating は runtime 状態であり永続 object には現れない） |
| repair_explanation | string | 必須 |
| hunks[] | array | repair_ready / validation_failed では 1 件以上 |
| validations[] | array of {name, status, detail} | status: pass / fail / skipped / not_run |
| model_identity | string | 任意。生成に使った model / route |

**hunk**（patch の最小単位。Original C 基準、生成方式に中立 — D-004）:

| field | type | 備考 |
|---|---|---|
| hunk_id | string | 必須 |
| start_line | integer | 必須。1-indexed |
| line_count | integer | 必須。0 = `start_line` の直前への挿入。n>0 = `start_line` から n 行を置換 |
| replacement_text | string | 必須。空文字 + line_count>0 = 削除 |

占有範囲: line_count>0 → `[start_line, start_line+line_count-1]`。line_count=0 → 挿入点境界 `start_line`。2 hunk の占有範囲・挿入点が交差すれば conflict（`STATE_MODEL.md` §5）。

### 2.5 patch-selection.schema.json

採否の記録。export の入力。

| field | type | 備考 |
|---|---|---|
| selection_id | string | 必須 |
| source_id / original_hash / context_revision_id | string | 必須 |
| decisions[] | array of {candidate_id, decision} | decision: accepted / rejected / pending |
| conflicts[] | array of {candidate_ids[], reason} | 検出済み conflict の記録（表示用） |

注: reviewed（diff 閲覧済み）状態は V1 では UI session state であり本 contract に含めない（D-014）。session persistence・レビュー履歴が必要になった時点で field 追加を検討する。

### 2.6 export-report.schema.json

| field | type | 備考 |
|---|---|---|
| export_id | string | 必須 |
| source | {filename, original_hash} | 必須 |
| context_revision_id | string | 必須 |
| rule_profile / adapter / harness | {id, version} | 必須 |
| accepted[] | array of {candidate_id, finding_id, rule_id, validations[]} | 必須 |
| rejected_count / pending_count | integer | 必須 |
| output | {filename, content_hash} | 必須。Accepted Candidate C の hash |
| assumption_dependent | boolean | 必須。accepted のいずれかが仮定依存なら true |
| disclaimer | string | 必須。「candidate であり規格準拠を保証しない」旨の固定文 |

## 3. 将来互換に関する注記

- `findings[]` は複数化可能な形を維持する（D-003）。複数 finding 対応時も schema 変更は不要の見込み。
- hunk 表現は whole-file candidate からの patch 抽出方式（保留事項）に依存しない。adapter がどの方式を採っても最終的に hunk 集合へ正規化する。
- `source-document.origin` により VS Code active document（Phase 5）を追加コストなしで表現できる。
