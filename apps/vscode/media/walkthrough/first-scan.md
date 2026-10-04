## Try your first repair on a practice file

Choose **[Open practice sample](command:crepair.openPracticeSample)** to open a
fresh, editable `quick-start.c` beside the quick-start guide. Your project and
previous practice copies are unchanged; opening it does not start inference.

Finish local or API setup, then **right-click inside the sample → Scan & Fix
Current File**. If Context Review opens, check the declarations and choose
**Confirm & Scan** in the notification.

Wait for findings, a proposed diff and validation results. The sample has an
unchecked array index; look for a bounds check that returns `-1` when invalid.
Results depend on your model. API scans and repairs send the sample to
OpenRouter and consume tokens.

Review the proposal and choose **Accept Repair (✓)** or **Reject Repair (⊘)**. Accept edits the
practice copy; save it with Ctrl+S (⌘S on Mac). Return to the `quick-start.c`
editor tab and run **Scan Current File** again to inspect the current code.

**Scan Current File** detects findings. **Scan & Fix Current File** also
generates repairs. Format or compile failures block Accept; inspect any warning
before confirming it. Use the [Quick start & user guide](command:crepair.openUserGuide)
for the full steps.
