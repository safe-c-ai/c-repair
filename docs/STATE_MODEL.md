# STATE_MODEL.md — 状態遷移と invalid 化ルール（正本）

4 層の状態機械（Session / Function / Finding / Candidate）と、context revision 変更時の invalid 化、conflict / eligible の定義を規定する。データ構造は `CONTRACT.md` を参照。

## 1. Session 状態（画面遷移の主軸）

```text
EMPTY
  → SOURCE_LOADED        .c 読込完了、Original C 確定（hash 発行）
  → CONTEXT_DRAFTING     context 補完 生成中（擬似遅延、D-011）
  → CONTEXT_REVIEW       補完の確認・編集中
  → CONTEXT_CONFIRMED    context_revision_id 発行済み
  → SCANNING             全関数 scan 実行中
  → SCANNED              violation inventory 表示可能
  → EXPORTED             export 実行済み（SCANNED へ戻り再 export 可能）
```

遷移ルール:

- `SOURCE_LOADED` 以降、Original C の content / hash は不変。別ファイルを読み込む場合は新 session（EMPTY から）。
- `CONTEXT_CONFIRMED` 以降に augmentation を編集 → `CONTEXT_REVIEW` へ戻る。このとき **scan 結果・candidate・decision をすべて破棄**（D-006）し、旧 revision の成果は復元しない。UI は stale banner で明示する。
- `SCANNED` 中の repair 生成は session 状態を変えない（Candidate 状態で表現）。

## 2. Function 状態（Screen 3 の集約表示）

独立した状態を持たず、`findings[]` から導出する（V1 は 0..1 件、D-003）:

| findings | 集約 status |
|---|---|
| 0 件 | `CLEAN` |
| 1 件 kind=violation | `VIOLATION_FOUND` |
| 1 件 kind=uncertain | `UNCERTAIN` |

`Generate repair` は `VIOLATION_FOUND` の関数でのみ有効。`UNCERTAIN` は根拠と仮定を表示するのみ（repair 対象外）。

## 3. Finding 状態

finding は不変の scan 結果であり、状態遷移しない。属性: `kind`（violation | uncertain）、`rule_id`、`assumption_dependent`。

## 4. Candidate 状態

```text
(finding: VIOLATION_FOUND)
  → GENERATING           生成中（擬似遅延）
  → REPAIR_READY         diff review 可能
  | REPAIR_FAILED        candidate なし
  | VALIDATION_FAILED    candidate はあるが accept-eligible ではない
```

`REPAIR_READY` の candidate は独立に decision を持つ:

```text
PENDING → ACCEPTED | REJECTED    （相互に変更可能。export 前なら取り消し・変更可）
```

- `VALIDATION_FAILED` の candidate は diff 閲覧可能だが accept 不可。
- validations は `[{name, status: pass|fail|skipped|not_run, detail}]` の配列。単一 success へ潰さない（計画書受入基準 #12）。

## 5. Conflict と eligible（D-004 / D-005）

- 各 candidate の patch は Original C 基準の hunk 集合（`CONTRACT.md` §hunk 参照）。
- **conflict**: 2 つの candidate の hunk が占有する行範囲（挿入は挿入点境界）が交差すること。conflict は candidate の属性ではなく「accept 済み集合との関係」で判定する:
  - candidate X を accept しようとしたとき、既 accept 集合のいずれかと交差するなら accept を抑止し、相手 candidate と理由を表示する。
  - 先に accept した側が優先。先の accept を取り消せば後の candidate は accept 可能になる。
- **eligible** = `REPAIR_READY` かつ decision が `REJECTED` でなく、既 accept 集合と conflict しない candidate。
- **reviewed**（D-014）= Screen 4 でその candidate の diff が表示されたこと。UI session state であり contract に含めない。D-006 reset で candidate とともに破棄される。
- 一括 accept（UI 名称 **`Accept all reviewed`**、D-014）は「eligible **かつ reviewed**」を candidate ID 昇順に順次 accept する。未閲覧（not reviewed）と、途中で conflict が新たに生じた candidate は**理由別に** skip し件数を表示する。

## 6. Export 時の検証

export 実行時に以下を機械検証し、違反があれば export を中止する:

1. すべての accepted candidate の `original_hash` が session の Original C hash と一致する。
2. すべての accepted candidate の `context_revision_id` が現行 revision と一致する。
3. accepted hunks が相互に交差しない。
4. 生成した Accepted Candidate C に prelude marker 文字列（`CONTRACT.md` §marker）が含まれない。

hunk 適用は start_line 降順（ファイル末尾側から）に行い、行番号 offset 計算を不要にする。
