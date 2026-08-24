## Generate repairs and review

**[Scan & Fix Current File](command:crepair.scanAndFixCurrentFile)** scans,
generates a repair candidate per violation, and opens each diff for review
(Accept / Reject / Regenerate / Next in the diff title bar).

Every candidate carries five validation gates:

| Gate | Meaning |
| --- | --- |
| format / compile | Mechanical checks — a failure blocks Accept. |
| violation_removal | Post-fix detection: is the target violation gone? |
| semantic | LLM review: is behaviour preserved? |
| regression | Derived: did the fix introduce a new problem? |

Judgment gates (the last three) can be overridden with an explicit
confirmation — **you** are the final authority; nothing is ever applied
without an Accept. After reviewing diffs,
**[Accept All Reviewed](command:crepair.acceptAllReviewed)** applies every
reviewed, conflict-free candidate in one pass.

### When a repair needs wider changes

A candidate is a **starting point**, not a finished result: passing the gates
means the fix looks right *for this function*, not that your whole project is
still correct. Mechanical gates (format / compile) **block** Accept; judgment
gates (semantic / violation-removal / regression) only **flag** — Accept stays
available after an explicit confirmation.

When a judgment gate flags a fix, you have three moves:

- **Accept as a starting point**, then finish the wider change yourself — e.g.
  update every caller if the function's signature changed.
- **Reject** it and leave the code as it was.
- **Write a different repair by hand** in the file directly.

Some violations cannot be fixed by editing one function alone. For example,
**STR31-C** (bounded string copy) needs the destination buffer's capacity,
which often lives in the caller — the function in isolation has no way to know
it. Expect to complete such fixes across your project.

The loop is **Accept → edit → re-scan**: apply a candidate, make the wider
changes it implies, then scan again to verify. Editing the file marks the
current results **stale** on purpose — they are a snapshot from scan time, so a
fresh scan is how you confirm the file is now clean.
