# V2_CONTEXT_BUILDER_DESIGN.md — Context Builder（LLM 補完 + Context Review）設計（正本）

> Note: references like "D-0xx" point to internal decision records not included in this repository.

前提: D-020（V2 前倒し）、計画書 §7（Context Builder V1）、CONTRACT.md §2.2、SPIKE §4。
目的: 「baseline が compile 不能 → compile: skipped」を、**LLM による外部宣言の仮補完 + 利用者確認**で解消し、compile evidence を実世界の `.c` で成立させる。既存の配管（augmentation set / revision / prelude 合成 / 座標写像 / prelude hunk 破棄）は**変更しない** — 空だった中身を実装するだけ。

## 1. bridge: /context/infer の実装（V2a）

pipeline（計画書 §7.2 の V1 具体化）:

1. **不足シンボル検出（deterministic）**: prelude なしの Original（Preprocessor 済み）を compile probe し、`_extract_missing_symbols`（V1c-UX で実装済み）で `unknown type name / implicit declaration / undeclared` を抽出。compiler 不在時は items 空の draft を返す（現行挙動に degrade。制限として明記）。include paths（D-020 近道）適用後も残るシンボルだけが対象になる。
2. **usage evidence 抽出（deterministic）**: 各シンボルについて Original 中の出現行（line + snippet、最大 3 件）を収集。
3. **LLM 補完**: file 全文 + 不足シンボル一覧 + usage 行を prompt に、シンボルごとの最小 C 宣言を生成（fix role と同じ backend、temperature 0）。出力はシンボルごとの fenced block を要求し、parse 失敗したシンボルは item を作らない（欠けは /context/check で可視化）。
4. **item 化**: kind は宣言テキストから分類（`typedef|struct|union|enum` → inferred_type / `#define` → inferred_macro / `(` を含む宣言 → external_function_declaration / それ以外 → external_global）。`provenance=llm_inferred`、`confirmed=false`、`generated_text=current_text`、rationale は「inferred from usage at line N」形式、usage_evidence 添付。
5. **応答**: status=draft / revision=null の ContextAugmentationSet（現行 contract のまま）。

**新 endpoint `/context/check`**（request envelope のみ。schema 不変更）:
`{source_document, context_augmentation_set, compile_include_paths?}` → `{compiles: bool, missing_symbols: string[]}` — Augmented C を compile probe し、Review UI が「context compiles ✓ / まだ不足: X」を表示するために使う。

## 2. assumption 意味論の精緻化（D-020）

- adapter の `assumption_dependent` 判定を「provenance=llm_inferred がある」→「**confirmed=false の item がある**」に変更。
- `/context/confirm` は従来どおり revision を発行するが、**items[].confirmed は client が設定した値を尊重**する（Review を通した confirm は全 true、Skip 時は false のまま confirm）。

## 3. VS Code: Context Review UX（V2b）

- scan flow 変更: infer の結果 items > 0 なら **Context Review** を挟む。items 0 なら従来どおり直行（自己完結ファイルの体験は不変）。
- **Review 画面 = 編集可能な untitled C document** を開く。内容は item ごとに区切りコメント付きの prelude:

```c
/* === C Repair inferred context. Review & edit the declarations below. === */
/* --- item aug-1 [external_function_declaration] (llm_inferred) --- */
int read_sensor(int channel);
/* --- item aug-2 [external_global] (llm_inferred) --- */
extern int threshold;
```

- notification（または CodeLens）で操作を提示:
  - **Confirm & Scan**: document を区切りコメントで parse → 各 item の current_text 更新（generated_text と差があれば user_edited=true, provenance=user_corrected）→ 全 item confirmed=true → `/context/confirm` → `/context/check` の結果を通知（「context compiles ✓」/「まだ不足: X — このまま進めると compile は skipped になります」）→ scan。
  - **Skip review & Scan**: confirmed=false のまま confirm → scan。findings/candidates は assumption-dependent 表示になる（§2）。
- 設定 `crepair.contextReview`: `"when-needed"`（default: items があるときだけ Review）/ `"always"` / `"never"`（常に Skip 相当）。
- **cache**: 同一 content_hash の confirmed set を session を跨いで保持（workspaceState）。source 変更（hash 変化）で破棄 = D-006。`C Repair: Edit Context` コマンドで再 Review。
- TreeView ルートに context 状態（items 数 / confirmed / assumption-dependent）を表示。

## 4. 不変条件（変更なし、テストで再確認）

- Accepted 適用結果に prelude 由来テキストが混入しない（既存: prelude 範囲 hunk 破棄 + cosmetic フィルタ + marker 検査）。
- Detection と Repair は同一 confirmed revision（既存配線）。
- context 変更 → 下流破棄（既存 D-006 + cache 破棄）。

## 5. ラウンド分割と受入

- **V2a（bridge）**: infer pipeline + /context/check + assumption 意味論変更 + pytest（fake LLM・fake compile で: シンボル検出→item 化 / parse 失敗シンボルの欠け / check 応答 / confirmed=false→assumption）。live smoke: play.c で infer が VehicleState/read_sensor/threshold の 3 item を返し、compose 後 baseline compile が通ること。
- **V2b（extension）**: Review UX + confirm/skip + 設定 + cache + integration（fixtureBridge に items 応答を追加し、Review → Confirm → scan → repair で compile: pass になる流れを検証）。
- **総合受入（live）**: play.c で scan → Review（3 宣言を確認）→ Confirm → scan 結果 → Generate Repair → **compile: pass の candidate** → Accept → 出力に prelude 混入なし。
