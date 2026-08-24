# PRODUCT_FLOW.md — user flow と画面仕様（正本）

Web prototype の user flow・画面構成の正本。状態遷移の詳細は `STATE_MODEL.md`、データ構造は `CONTRACT.md` を参照。用語・前提は `DECISIONS.md` に従う（成果物は `Accepted Candidate C`）。

## 1. 全体 flow

```text
Upload one .c file
        ↓
Create Original C（immutable、hash 保持）
        ↓
Detect unresolved external context
        ↓
LLM generates provisional context（Phase 1 では fixture）
        ↓
Compose Augmented C（prelude 純連結、D-002）
        ↓
User reviews / edits inferred context
        ↓
Confirm → context revision 発行
        ↓
Scan all functions（in-progress 表示、D-011）
        ↓
Violation inventory（1 関数 0..1 finding、D-003）
        ↓
Generate repairs（違反関数のみ、個別 / 一括）
        ↓
Original / Proposed side-by-side diff（左は常に Original C、D-004）
        ↓
Accept / Reject / Accept selected / Accept all eligible（D-005）
        ↓
Export Accepted Candidate C + JSON report（D-009）
```

## 2. 画面仕様

### Screen 1: Upload

- 目的: `.c` を 1 つ受け取り Original C を確定する。
- UI: drag & drop / file picker、fixture 選択 button（Phase 1）、filename / size / SHA-256 hash 表示、source preview（read-only）、`Analyze context` button。
- 制約: `.c` 以外は拒否。upload 後の Original C は immutable。
- 遷移: `Analyze context` → Context Review へ（Phase 1 では fixture の augmentation を擬似遅延後に表示）。

### Screen 2: Context Review

- 目的: LLM 補完（Phase 1 は fixture）を確認・編集し、context revision を確定する。
- UI:
  - Original（read-only）と Augmented の表示。Augmented は「prelude ブロックのみ編集可能、Original 部分は read-only」。
  - augmentation item 一覧: kind / provenance / rationale / usage evidence を表示、`current_text` を編集可能。
  - 編集した item は `user_edited` を明示。
  - `Confirm and scan` button → revision ID を発行・表示。
- 遷移: confirm → Scan Results へ。confirm 後に再編集した場合はこの画面に戻り、下流を全破棄（D-006）、stale banner を表示。

### Screen 3: Scan Results

- 目的: 全関数 scan の結果一覧を repair 前に提示する。
- UI:
  - サマリ（例: `6 functions scanned / 2 violations / 1 uncertain / 3 clean`）。
  - 関数一覧: 関数名、集約 status（CLEAN / VIOLATION_FOUND / UNCERTAIN）、rule ID / summary、assumption 依存表示。
  - `Generate all repairs`（違反関数のみ対象）と関数単位の `Generate repair`。生成中は in-progress 表示。
- 遷移: candidate 生成済みの関数から Repair Review へ。

### Screen 4: Repair Review

- 目的: Original と修正候補の比較・採否。
- UI:
  - Monaco side-by-side diff。**左 = Original C（常に）**、右 = candidate 適用後の全文。
  - 関数名、対象 rule、violation explanation、repair explanation、validations 一覧（複数の validation を個別 status で表示、単一 success へ潰さない）、assumption / context revision 表示、changed lines navigation。
  - 操作: `Accept` / `Reject` / `Accept selected` / `Accept all reviewed`（レビュー済みかつ eligible のみを一括適用。未閲覧・conflict は理由別 skip 表示。D-014）。
  - candidate 一覧に reviewed / not-reviewed バッジを表示。diff を表示した時点で reviewed（D-014）。
  - conflict（hunk 範囲重複）のある candidate は accept を抑止し、理由と相手 candidate を表示。
  - `Regenerate` は Phase 1 では実装しない。
- 遷移: Export へ（accepted が 0 でも export 可能、その場合 Accepted Candidate C = Original C）。

### Screen 5: Export

- 目的: accepted patch だけを Original C へ適用した Accepted Candidate C を生成・出力する。
- UI: 採用サマリ（accepted / rejected / pending 件数。pending のうち未閲覧の件数を参考表示、D-014）、出力 preview、download button。
- 出力（D-009）: Accepted Candidate `.c`、JSON report（`export-report.schema.json` 準拠）。
- 不変条件: 出力 `.c` に prelude 由来テキスト（inferred context marker 含む）を一切含めない。

## 3. Phase 1 の擬似非同期

fixture 駆動でも `Analyze context` / `Scan` / `Generate repair` には 300〜800ms 程度の擬似遅延を入れ、in-progress 状態を UI で通す（D-011）。
