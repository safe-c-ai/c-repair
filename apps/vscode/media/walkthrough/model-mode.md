## Choose a model mode

**[Choose Model Mode](command:crepair.chooseModelMode)** picks how repairs are
paid for:

- **Preset** — the model/provider preset of this C Repair release, tested on the
  CERT C benchmark (the preset may change in future releases). A single-file
  scan typically costs a few cents.
- **Free** — a community free-pool model at **$0**. Quality is lower and the
  shared pool rate-limits under load; good for trying the flow.

You can re-run this choice at any time from the Command Palette. Custom
model/provider overrides live under `crepair.*` settings for advanced use.
