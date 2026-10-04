# C Repair quick start

[日本語](user-guide.ja.md)

Before Scan, complete [local](#local-use-a-model-on-your-computer) or [OpenRouter](#api-use-openrouter) setup. Already set up? Continue below.

1. **Open practice sample** in the C Repair view (or its **…** menu after a scan). A fresh `quick-start.c` opens beside this guide.
2. **Right-click in the code → Scan & Fix Current File**. Wait for the proposed fix. If Context Review opens, check the declarations and choose **Confirm & Scan**. API use sends the sample to OpenRouter; paid modes incur token charges.
3. **Read the diff and the checks under Proposed fix** in the C Repair view. Does the fix check both index bounds and return `-1` when invalid?
4. **Diff toolbar → Accept Repair (✓) or Reject Repair (⊘)**. Accept edits the practice file; save with **Ctrl+S** (**⌘S** on Mac). Reject leaves it unchanged.
5. **Return to the `quick-start.c` editor tab → right-click → Scan Current File**. Check whether the original finding is still reported.

**Accept is the step that changes your code.** Scan detects findings; Scan & Fix also proposes repairs. Every practice file is a new copy outside your project. Opening it does not start inference.

The sample reads `values[index]` without checking its bounds. The diff can appear side by side or inline, and results vary with the model. Format or compile failures block Accept; read warnings before confirming them. If compile is skipped, see the [requirements](../README.md#requirements).

Reopen this guide from the view's **book icon**, or **gear → Setup → Commands → Quick start & user guide**. **Open practice sample** is also in the view's **…** menu and **gear → Setup → Commands**.

### More detail

- [Set up local or API inference](#set-up-local-or-api-inference)
- [Scan a C file](#scan-a-c-file)
- [Read findings and validation results](#read-findings-and-validation-results)
- [Review and apply a repair](#review-and-apply-a-repair)
- [Scan again and export a report](#scan-again-and-export-a-report)
- [Change settings or recover from an error](#change-settings-or-recover-from-an-error)

## Set up local or API inference

Open the **C Repair** view from the Activity Bar. Choose one of the two paths below.

### Local: use a model on your computer

1. Choose **Use a local model** in the empty C Repair view. You can also use **gear → Setup → Local Setup → Set up or start local model**.
2. Choose a model. The extension selects initial quantization and memory settings automatically. Check the download size and model location, then choose **Download and start**. For an existing model, choose **Start local model**.
3. Wait for the model-ready message, then scan your C file.

This prepares the inference runtime and Python bridge as well as the model. You do not need an API key or a separate **Set Up Bridge** step for initial setup. Initial downloads require internet access.

For supported systems, existing models, memory requirements and tuning, see the [local model settings guide](local-models.md#first-setup). Saved settings are retained when you update the extension. If setup is cancelled or fails, choose **Use a local model** or **Set up or start local model** again to finish it.

### API: use OpenRouter

1. Choose **Connect OpenRouter** in the C Repair view. Approve in the browser, copy the one-time code, and paste it into the VS Code prompt. To use an existing key, open **gear → Setup → Api Key → Set API Key manually**.
2. When prompted, choose **Use the preset model** or **Try the free model first**. Preset uses this release's model/provider configuration; Free uses a shared free pool. To choose your own model and provider, select **Custom** under **gear → Models & Routing → Model Mode**. All API modes need an OpenRouter key.
3. Open **gear → Setup → Commands → Set Up Bridge** once and wait for the bridge-ready message. Then scan your C file.

If `crepair.bridge.pythonPath` names your own environment, follow the [custom bridge update steps](local-models.md#custom-python-bridge). Set Up Bridge updates C Repair's private environment, not that custom environment.

API inference sends the scanned code and helper declarations to OpenRouter and the selected provider. Your key is kept in VS Code's secret storage. Paid usage depends on the model and tokens; Free may be slower or rate-limited.

If you are switching from Local to API, select **Preset**, **Free**, or **Custom** under **Model Mode** as well as connecting your key. Connecting a key does not switch an existing local configuration.

## Scan a C file

1. Open a single `.c` file in the editor.
2. Right-click in the editor and choose **Scan Current File** to detect violations, or **Scan & Fix Current File** to also generate repair candidates.
3. If **Context Review** opens, check the inferred declarations and choose **Confirm & Scan** in the notification to continue. If the notification was dismissed, use **C Repair: Confirm Context & Scan** from the Command Palette.

Context Review supplies working declarations for external types, functions and macros that cannot be resolved from this file alone. Correct inaccurate declarations before continuing. **These helper declarations are never written into your source file.**

If you skip the review or context remains incomplete, the result depends on unresolved assumptions and some checks may be skipped. Check the context warning before relying on the findings.

The C Repair view lists findings by function; editor squiggles point to their locations. Plain **Scan Current File** does not generate repairs. To repair an individual finding, use its **Generate Repair** action.

## Read findings and validation results

A finding identifies the function, CERT C rule and explanation. Expand its repair candidate to inspect validation evidence, or open the proposed diff.

Each candidate has five checks:

| Check | What it tells you |
| --- | --- |
| format | Whether the returned repair has a usable format |
| compile | Whether the repaired code passes the available compile check |
| violation_removal | Whether a new detection finds the target violation removed |
| semantic | Whether the model judges the original behaviour preserved |
| regression | Whether the validation evidence indicates no new problem |

**Pass**, **fail** and **skipped** mean different things. A skipped check has not established that the repair is correct. For example, compile may be skipped if the compiler or required declarations are unavailable.

A **format or compile failure blocks Accept**. A warning from violation removal, semantic or regression still allows Accept after an explicit confirmation. Read the evidence before overriding a warning.

Click a validation entry or a validation message in the diff to read its details. Passing checks does not prove that your whole project is correct. Zero detected violations is also not a proof of safety.

## Review and apply a repair

Open a candidate's diff. In side-by-side view, the original code is on the left and the proposal on the right; in inline view, removed and added lines appear in one pane. The diff toolbar offers these actions:

| Action | Result |
| --- | --- |
| Accept | Apply this candidate to your file |
| Reject | Leave your file unchanged and record the rejection |
| Regenerate | Request a new candidate for this finding |
| Next | Move to the next candidate without accepting this one |

Read the changes and validation evidence, then choose an action. **Accept All Reviewed** in the C Repair view applies reviewed, eligible, conflict-free candidates; it does not bypass review or per-candidate warning confirmations.

Some repairs require wider changes. A changed function signature may require caller updates; a safe string copy may need a buffer capacity known only to the caller. If you accept a candidate as a starting point, finish those changes yourself and check the project.

Only accepted repair patches are applied. Helper context is kept separate; includes introduced by an accepted repair may be added to your file.

## Scan again and export a report

After Accept or manual edits, run **Scan Current File** again to inspect the updated file. Changed code makes earlier results stale; those results describe the previous scan.

Use **Export Repair Report** from the C Repair view toolbar or **gear → Setup → Commands** to save the session's findings, validation evidence and repair decisions as Markdown. The report may contain source-code diffs, so choose where to save and share it accordingly.

C Repair analyzes one file at a time and handles one finding per function. Finish any project-wide changes and run your project's normal build and tests as well.

## Change settings or recover from an error

- **Local model, reasoning, memory or tokens:** open **gear → Setup → Local Setup → Local model settings**. Choose **✓ Apply changes** after editing. See [local settings and troubleshooting](local-models.md#troubleshooting).
- **API model, provider or reasoning:** open **gear → Models & Routing**. Apply changes to the bridge using the restart action offered by C Repair. API settings do not change local inference settings.
- **Missing includes:** use **gear → Scanning & Context → Compile Include Paths** for project header directories, then scan again.
- **Bridge setup error:** resolve the reported issue and retry setup. After updating from an older version, **Set Up Bridge** updates the bridge, including in Local mode. Open **View → Output → C Repair** for details.
- **Stop a scan or generation:** choose Cancel in the progress notification. For a local model, **Stop Local Model** releases its memory; the next local operation loads it again.

The status display shows session token usage and, for API modes when available, approximate cost. Reasoning can make a small file take longer to process; adjust local limits using the settings guide rather than judging the budget from source-file size alone.
