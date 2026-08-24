# VSCODE_V1B_DESIGN.md — VS Code extension MVP の設計（正本）

> Note: references like "D-0xx" point to internal decision records not included in this repository.

前提: VSCODE_PIVOT_PLAN.md §4/§5（承認済み）、D-017、CONTRACT.md、STATE_MODEL.md。
scope: **V1b = scan → Diagnostics/TreeView → candidate 生成 → native diff + validation evidence → Accept（WorkspaceEdit）/ Reject**。V1c（reviewed / Accept all reviewed / 一括操作）と V2（Context Review UI）は含まないが、設計はそれらが後から載る形にする。

## 1. 配置と技術

```
apps/vscode/
├── package.json           VS Code extension manifest（engines.vscode ^1.85 目安）
├── tsconfig.json          strict
├── esbuild.mjs            bundle（CJS 出力。@core ESM は bundle 内に取り込む）
├── src/
│   ├── extension.ts       activate/deactivate、コマンド登録
│   ├── bridge/
│   │   ├── BridgeManager.ts    spawn / port / token / handshake / pin / 終了
│   │   └── BridgeClient.ts     HTTP client（contract JSON をそのまま送受信）
│   ├── session/
│   │   └── ScanSession.ts      snapshot・状態機械（STATE_MODEL の移植）
│   ├── ui/
│   │   ├── diagnostics.ts      DiagnosticCollection への写像
│   │   ├── tree.ts             C Repair TreeView（function / finding / candidate / validation）
│   │   └── diffView.ts         virtual document + vscode.diff
│   └── apply/
│       └── acceptCandidate.ts  WorkspaceEdit 適用 + stale guard
└── test/                   pure logic の unit test（Node、VS Code API 非依存部分）
```

- **contract 型の昇格**: `apps/web/src/contract/types.ts` を `packages/contract/types.ts` へ移し、web と vscode の両方が import（web 側は re-export で無変更に近い追随）。
- **packages/core をそのまま import**（applyHunks / conflict / marker。esbuild で bundle）。
- UI 文字列は英語（将来の Marketplace を考慮）。

## 2. bridge lifecycle（BridgeManager）

1. **python 解決**: 設定 `crepair.bridge.pythonPath`。未設定時は `${workspaceFolder}/services/repair-api/.venv/bin/python`（monorepo 開発時の自動検出。Windows は `Scripts/python.exe`）→ 見つからなければ「bridge 未構成」エラーと導入手順への案内（uv 自動 bootstrap は V3）。
2. **spawn**: 空きポートを拡張側で確保（net.createServer で 0 を listen→close）し、`python -m uvicorn repair_api.main:app --host 127.0.0.1 --port <p>`。env に `CREPAIR_BRIDGE_TOKEN=<crypto.randomUUID>` と `DEEPSEEK_API_KEY=<SecretStorage から>`（未設定なら渡さない）。**token / API key を argv・ログ・設定ファイルに出さない**。
3. **handshake**: `/health` を token 付きで poll（起動待ち最大 15s）。検査: `contract_version === "1"`（不一致 → エラーで停止）、`harness.version` が **pin 範囲（`0.4.x`）**か（範囲外 → **警告表示のうえ続行可**。D-017b: 自動更新はしない）。capabilities は表示用に保持。
4. **終了**: deactivate / ウィンドウ終了で child kill。クラッシュ検知（exit event）→ status bar に表示、次回コマンドで再 spawn。
5. status bar item: `C Repair: starting / ready / scanning / error`。

## 3. scan flow（ScanSession）

- コマンド **`C Repair: Scan Current File`**（Command Palette + エディタ context menu、`.c` のみ有効）。
- 実行時に **snapshot** を取る: `{uri, content, content_hash}`。SourceDocument は `origin: "vscode_document"`、`source_id = content_hash 派生`。
- flow: `/context/infer`（V1b は items 空 draft が返る）→ `/context/confirm` → `/scan`。`withProgress`（notification, cancellable=false）で in-progress 表示。
- 結果保持: `ScanSession { snapshot, revisionId, scanResult, candidates: Map<function_id, candidate>, decisions: Map<candidate_id, decision> }`。**1 ファイル 1 session、再 scan で置換**。
- **stale 判定（D-006 の写像）**: TextDocument の変更を `onDidChangeTextDocument` で監視し、snapshot と hash 不一致になったら session を stale にする。stale 中は candidate 生成・Accept を拒否し、Diagnostics に「results are stale — rescan」を出す。**revert で hash が戻れば stale 解除**（hash 比較ベース）。

## 4. 結果表示

### Diagnostics（Problems パネル）
- finding ごとに `vscode.Diagnostic`: range = `location`（0-index 変換）、severity = violation→Warning / uncertain→Information、message = `[rule_id] rule_summary`（uncertain は `[uncertain] explanation 先頭`）、source = `"C Repair"`、code = rule_id（CERT C の URL は V1 では張らない）。
- assumption_dependent は message 末尾に `(assumption-dependent)`。
- stale で全 Diagnostic をクリアし stale 通知 1 件に置換。

### TreeView（view id: `crepairResults`）
```
<filename>  (6 functions / 2 violations / 1 uncertain)
├─ fn scale_reading      CLEAN
├─ fn average_two        INT32-C violation
│   └─ candidate cand-xx  [repair_ready] / [insufficient evidence] / [validation_failed]
│       ├─ ✓ format: pass
│       ├─ ⚠ compile: skipped — compiler not found（検証証拠不足）
│       └─ ...
└─ fn sample_index       ...
```
- finding node の inline action: `Generate Repair`（violation のみ）。candidate node の action: `Show Diff` / `Accept` / `Reject`。
- **D-017c**: validations に skipped/not_run が 1 つでもあれば candidate バッジを `[insufficient evidence]` にし、pass 全揃いの `[repair_ready]` と視覚的に区別（icon も分ける）。fail があれば `[validation_failed]`（Accept 無効）。

## 5. diff と Accept / Reject

- **Show Diff**: `vscode.diff(originalUri, proposedUri, title)`。両側とも TextDocumentContentProvider の virtual doc（scheme `crepair`）: 左 = snapshot content（**常に Original**、D-004）、右 = `applyHunks(snapshot.content, candidate.hunks)`（core）。title に rule_id と validation 概況。
- **Accept**（candidate 単位）:
  1. stale guard: 現在の document text hash === snapshot hash でなければ拒否（「ファイルが変更されています。再 scan してください」）。
  2. conflict guard: 既 accept 済み candidate と `candidatesConflict`（core）なら拒否し相手を表示（V1b では同一 scan 内の複数 accept をサポート。適用は都度エディタへ）。
  3. `WorkspaceEdit`: hunks（Original 座標）を snapshot 基準の Range 置換に変換して一括適用（**undo 1 回で戻る**）。適用後、document は変わるので session 上は「applied candidate の hunks を反映した新 hash」を expected として記録し、これと一致する間は他 candidate の Accept を許す（座標は全 candidate が Original 基準で独立・非 conflict なら、適用済み hunk による行 offset を補正して Range 計算する。offset 補正は core の hunk 情報から決定論的に計算）。
  4. 適用済み candidate は TreeView で `[accepted]`、対応 Diagnostic を除去。
- **Reject**: decision 記録、TreeView `[rejected]`、Diagnostic は残す。
- V1b では「複数同時 accept の行 offset 補正」が複雑になりすぎる場合、**縮退案として「Accept は 1 scan につき逐次、適用後は自動 re-scan を促す」を許容**する（実装時に判断し報告させる。どちらでも受入基準は Accept→undo→再 Accept が成立すること）。

## 6. BYOK / 設定

- コマンド `C Repair: Set DeepSeek API Key` → `context.secrets.store`。`Clear API Key` も用意。
- API key 未設定で scan 実行 → 案内メッセージ（コマンドへの誘導）。**key は SecretStorage のみ**。
- 設定（`contributes.configuration`）: `crepair.bridge.pythonPath`（string）、`crepair.bridge.port`（number, 0=auto）、`crepair.externalRouteNotice`（bool, default true: scan 前に「code が LLM provider へ送信される」確認を初回のみ表示 — D-016 の明示義務）。

## 7. テスト戦略

- **unit（Node, VS Code API 非依存）**: hunk→Range 変換・offset 補正、stale hash 判定、pin 範囲判定、/health 応答の互換チェック、validation バッジ導出（skipped→insufficient evidence）。vitest か node:test。
- **統合（@vscode/test-electron）**: xvfb 環境で「activate → 擬似 bridge（fixture 応答を返す http server を test が立てる）→ scan コマンド → Diagnostics 件数 / TreeView 構造 → Accept で document が期待どおり書き換わり undo で戻る」を検証。**実 bridge・実 LLM は使わない**（fixture 応答で決定論化。実結合は R-3 相当として手動実施）。xvfb が使えない場合は unit + 手動 checklist に縮退し報告。
- **手動 checklist**（user 向け）: Extension Development Host での実操作手順を README に記載。

## 8. 実装ラウンド分割

- **V1b-1**: scaffold + 型昇格（packages/contract/types.ts + web 追随）+ BridgeManager/BridgeClient + Scan コマンド + Diagnostics + TreeView（finding まで）+ status bar + BYOK + 外部送信 notice。unit test + 可能なら test-electron の起動 smoke。
- **V1b-2**: candidate 生成（Generate Repair）+ validation evidence 表示（insufficient evidence バッジ）+ diff view + Accept/Reject（WorkspaceEdit + stale/conflict guard + undo）+ 統合テスト拡充。
- 受入は各ラウンドで: `npm run typecheck` / extension build / unit test / （可能なら）test-electron、既存の validate / test:api / E2E 非退行。最終的な実 bridge 結合は手動で検証。

## 9. V1b の制約

- Marketplace 公開・publisher ID 取得をしない。remote/push なし。
- Web UI の機能追加なし（型昇格の re-export 追随のみ）。
- certfix-dev / experiments 無変更。
- Independent Auditor / 自動 accept / reviewed 一括（V1c）を先取りしない。
