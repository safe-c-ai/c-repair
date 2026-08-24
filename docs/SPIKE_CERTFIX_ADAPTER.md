# SPIKE_CERTFIX_ADAPTER.md — CertFix 接続 feasibility spike 結果

> Note: references like "D-0xx" point to internal decision records not included in this repository.

日付: 2026-08-20。方法: CertFix engine（v0.4.1、別リポジトリ）の**読み取り専用**調査（ファイル変更・コード実行なし）。目的: 保留 5 項目の実現可能性判定と Phase 2/3 計画への反映。

## 1. CertFix の接続面サマリ

| 項目 | 事実 |
|---|---|
| CLI | `certfix check`（scan のみ）/ `certfix fix`（repair）が分離。`--format json/sarif`、単一 `.c` 入力可 |
| Python API | `Detector.check_file(path, rules) -> list[Violation]`、`Fixer.fix_violation(violation, code) -> FixResult` を in-process で呼べる。dataclass に `to_dict()` あり |
| Violation | `rule_id / file_path / line(1-indexed) / column / message / severity / code_snippet`。**関数名は含まれない** |
| FixResult | `original_code / fixed_code`（**ファイル全体**）+ `to_diff()`（difflib unified diff）。source は決して直接書き換えない |
| validation | 5 gate（format / compile(gcc -fsyntax-only) / violation removal / semantic review(LLM) / programmatic regression）を `FixValidatorResult` で構造化保持。retryable 分類あり |
| identity | JSON 出力に `tool: certfix, tool_version: 0.4.1`。model 名は出力に含まれず config 由来（adapter が記録する） |
| LLM 依存 | **scan・repair とも LLM 必須**（デフォルトはファイル全体を LLM に送る検出）。backend は OpenAI 互換 API（`CERTFIX_API_KEY`、OpenRouter/DeepSeek）または local llama-server（Qwen3.6-27B-MTP, :8952） |
| 制約 | 115 CERT-C rules / **1 関数 1 違反**（LIMITATIONS.md 明記、D-003 と一致）/ 関数 ~200 行推奨 / C のみ / LLM 非決定性 / 検出は全 LLM 経由で timeout 300s デフォルト |
| context | ローカルヘッダ（`#include "..."`）の限定解決のみ。stub 生成・context 補完は**持たない** → c-repair の Context Builder と責務が重複しない |

## 2. 保留 5 項目の判定

### #1 adapter 接続方式 → **Python API in-process を推奨**（実現可能）

- c-repair の flow は「scan 全関数 → 利用者が確認 → 関数単位で repair」。CLI `certfix fix` は detection→repair を一体で走らせるため、**既知の violation から repair だけを駆動できる `Fixer.fix_violation(violation, code)` が flow に正確に一致**する。
- 帰結: `services/repair-api`（Python 薄層、計画書 §11 の位置）が certfix package を import する。計画書 §12.3 の選択肢 2 に相当。CLI subprocess 案（選択肢 1）は scan には使えるが repair 駆動が不適合。
- 注意: certfix の導入は `PYTHONPATH` 参照または非 editable install とする（`pip install -e` は engine のソースツリー内に egg-info を書き込んでしまうため使わない）。

### #2 function↔violation line mapping → **実現可能（adapter 側で帰属）**

- Violation は行番号（1-indexed、contract と同じ）を持つが**関数名を持たない**。
- 帰結: adapter が Original C の関数一覧（`function_id / name / original_range`）を自前で抽出し、violation.line を範囲に突き合わせて帰属させる。関数抽出は Phase 2 の deterministic parse の一部を**前倒し**して実装する（certfix.core.splitter の regex 方式を参考にできるが、依存はしない）。
- 未決の縁: 関数外（global scope）の violation の扱い。V1 は「関数外 finding は表示のみ・repair 対象外」を提案。

### #3 whole-file candidate → function 単位 patch → **実現可能（条件付き）**

- FixResult は「修正後ファイル全体」を返す。adapter が `original_code` と `fixed_code` を diff して contract の hunk 集合（start_line / line_count / replacement_text）へ変換する。既存の `packages/core` の hunk 表現・conflict 判定はそのまま使える（**D-004 の設計が正解だったことを確認**）。
- **条件（hands-on で解消済み → §4）**: comment-merge は byte 忠実でないため使わない。Preprocessor（行構造保存 + mapping）の出力を repair に渡し、行保存空間の diff で hunk 化し、raw Original への適用は c-repair 側で行う。これにより非修正領域の byte 保存が構造的に成立する。

### #4 Original/Augmented source map → **実現可能（純連結方式で成立の見込み）**

- adapter は Augmented C（prelude + Original 純連結）を CertFix に渡し、返る行番号から `prelude_line_count` を引けば Original C 座標になる。CertFix 自身の前処理（コメント除去）は `mapping.to_original()` で入力ファイル座標に戻してから返すため、二重変換にはならない見込み。
- D-002 の懸念（Original 内 typedef を prelude が参照できない）は残るが、CertFix 側にも同種の制限（ヘッダ前置）があるため、V1 は純連結で開始し、問題が出た rule/ケースを記録して改良する方針で足りる。

### #5 patch hash / revision 整合 → **実現可能（adapter 層で完結）**

- engine identity は `tool_version` で取得可能。model identity は config 由来なので adapter が `model_identity` として記録。`original_hash` / `context_revision_id` の付与・検証は adapter 層の責務とし、CertFix 側の変更は不要。contract の必須 identity（CONTRACT.md §1）はすべて充足できる。

## 3. contract / 既存実装への影響

- **schema 変更は不要**。FixValidatorResult の 5 gate は `validations[]` に `{name: format|compile|violation_removal|semantic|regression, status, detail}` として写像でき、`retry_count` 等は detail に収められる。
- Phase 1 fixture の validations 名（parse/compile/behavior_check）は Phase 3 で実名に置き換える（fixture は歴史的成果物として維持、adapter 実装時に実データへ）。
- scan も LLM 必須のため、**未決事項 #4（LLM route）と #7（同期 or job API）が Phase 3 の前提判断**になる。timeout 300s 級の処理があるため、localhost prototype は「同期 + 長 timeout + D-011 の in-progress UI」で開始し、job API 化は必要になってから。
- capability 表示（115 rules / 200 行推奨 / 非決定性)は Screen 3/4 の注記として Phase 3 で追加。

## 4. hands-on 検証結果（2026-08-20 実施。scratchpad 上で certfix v0.4.1 + DeepSeek API を実行）

方法: venv に非 editable install（certfix-dev への書き込みなしを git status で確認）、config は同梱 `deepseek-v4-flash-api.yaml`、テストは自作のコメント多め `.c`（STR31-C 相当の strcpy）と prelude 付き Augmented 版。

1. **comment-merge は byte 忠実ではない（採用しない）**: `merge_comments(raw, fixed)` の出力はファイル先頭 block comment の喪失（skipped=1）、inline comment の空白正規化、空行挿入を含み、**非修正関数すら byte 不一致**。素朴な「raw Original vs comment-merged」diff は偽 hunk だらけになる。
2. **代替戦略が成立（これを採用）**: `Preprocessor.process()` は「コメント除去・**行構造保存**・`mapping.to_original()`」を提供する（実測: 21 行入力 → 21 行出力、strcpy L13→L13 恒等）。adapter は CLI の `strip_c_comments`（行構造を壊す）ではなく **Preprocessor の出力を `run_simple_repair` に渡し**、`diff(processed_original, fixed_code)` を行保存空間で取って hunk 化する。**hunk を raw Original C に適用するのは c-repair 側なので、非修正領域のコメント・byte は構造的に保存される**（comment-merge 不要）。修正行の inline comment は失われるが、変更行なので許容（diff 上で利用者が見る）。
3. **Augmented C 入力**: repair は prelude を大きく壊さず（extern は保存）、marker はコメントのため stripped 空間では空行化する。prelude 範囲（L1..prelude_line_count）に掛かる hunk は adapter が破棄/拒否する規則とする。
4. **generic 検出経路の行番号**: `Detector.check_file`（関数チャンク分割）は実ファイル座標の行番号を返す（実測: 対象関数の開始行 L11）。ただし deepseek + qwen36 check profile の組合せでは **rule 同定が `UNKNOWN-CERT-C` に落ちるケース**があり、CLI の batch 経路では line=1 の file-level 出力になる場合もある。adapter は `UNKNOWN-CERT-C` を UNCERTAIN finding へ写像する等の防御的処理を持つ。検出品質そのものは certfix 側の領分であり c-repair では再実装しない。
5. **実測時間（deepseek-v4-flash）**: check 5.6〜8.7 秒/ファイル、repair 42〜46 秒/関数。V1 は「同期 + 長 timeout + in-progress UI（D-011）」で成立する見込み。job API 化は必要になってから（未決 #7 は据え置き）。

### §4 補遺（2026-08-21、V1a live 検証での追加発見）

6. **reasoning モデルの thinking 無効化が必須**: deepseek-v4-flash は reasoning モデルで、repair prompt では思考が max_tokens を使い切り content が空になる（finish_reason=length、completion 全量が reasoning_tokens。16384 に増枠しても思考が比例して伸び解決しない）。`extra_body: {thinking: {type: disabled}}` を fix/validation role に設定して解決。副次効果として repair が 40 秒超 → **2.1 秒**に短縮。§4-5 の repair 実測はこの設定で無効化前の値。
7. **cosmetic hunk フィルタが必要（§4-2 の補正）**: LLM の fixed_code はコメント・空行・行末空白を正規化して返るため、Preprocessor 空間 diff に「実修正と無関係な cosmetic hunk」（コメント除去だけの置換・コメット行削除）が混入し、そのまま適用すると非修正領域のコメットが消える。実測: 5 hunks 中 4 が cosmetic。対策: hunk ごとに raw 対象範囲と replacement を「コメント除去 + rstrip + 空行除去」で正規化比較し、一致するものを破棄（不一致・判定不能は保持側に倒す）。「非修正領域の byte 保存」はこのフィルタとセットで成立する。

## 5. Phase 順序の推奨

**Phase 3（CertFix scan 統合）を先行し、Phase 2 は deterministic 部分のみ前倒し**を推奨する。

- 理由: (a) #2 のとおり関数 inventory 抽出（Phase 2 の deterministic parse）は Phase 3 の前提として必須。(b) Phase 2 の LLM context 補完も LLM route 判断に依存し、その配線は Phase 3 で先に確立できる。(c) リスク最大の項目（#3 comment-merge、行番号写像）は scan/repair の実接続でしか検証できない。
- 改訂順序案: hands-on spike（§4）→ Phase 3a: adapter + scan 統合（関数 inventory 前倒し込み）→ Phase 3b: repair/validation 統合 → Phase 2: LLM context 補完（Context Builder 完全版）→ 以降計画書どおり。

## 6. 確定済み判断

1. Phase 順序の変更: **承認済み**（D-015。Phase 3 → Phase 2）。
2. LLM backend: **API route 承認済み**（D-016。OpenRouter / DeepSeek。local llama-server は将来検討）。
3. hands-on spike: **実施済み**（§4）。spike の結論として、保留 5 項目すべてに実装可能な設計が確定した。

## 7. Phase 3a への引き継ぎ（adapter 設計の確定事項）

- 接続: `services/repair-api`（Python）が certfix package を import（PYTHONPATH または非 editable install）。
- scan: `Detector.check_file`（generic 関数チャンク経路）を使用。入力は Augmented C、出力行から `prelude_line_count` を減算して Original 座標へ。`UNKNOWN-CERT-C` は UNCERTAIN へ写像。
- repair: `Preprocessor.process` の出力を `run_simple_repair` へ。`diff(processed, fixed_code)` → hunk 化 → prelude 範囲の hunk は破棄。validation は `FixValidatorResult` を `validations[]` へ写像。
- identity: tool_version（0.4.1）+ adapter 版数 + config 由来 model 名を adapter が付与。
- 同期実行 + 長 timeout + in-progress UI で開始（実測: check ~8s/file, repair ~45s/function）。
