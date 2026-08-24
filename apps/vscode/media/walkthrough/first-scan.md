## Run your first scan

Open a single `.c` file and run
**[Scan Current File](command:crepair.scanCurrentFile)**.

Because C Repair analyzes one file in isolation, external types and macros are
often missing. Before scanning, the extension **infers provisional
declarations** (a "Context Review" may open so you can confirm or edit them —
they are working context only and are **never written into your file**). When
the context still does not fully compile, results are marked **context
incomplete (N symbols still missing)**: detection may then miss violations, so
zero findings is not a safety guarantee for such files.

Findings appear in the **C Repair** view and as squiggles in the editor.
