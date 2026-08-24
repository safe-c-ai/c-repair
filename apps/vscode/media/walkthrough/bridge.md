## Set up the local bridge

C Repair runs a small **local** bridge process (Python) that wraps the repair
harness. It listens on 127.0.0.1 only.

- **Installed from the vsix?** Run
  **[Set Up Bridge](command:crepair.setUpBridge)** — the extension provisions a
  private Python environment from the wheels bundled inside the vsix. If the
  `uv` tool is missing you are asked for consent before its official installer
  runs (declining shows manual instructions).
- **Developing in the monorepo?** Nothing to do: the repo's
  `services/repair-api/.venv` is detected automatically and takes priority.
- **Custom environment?** Point `crepair.bridge.pythonPath` at a Python with
  `repair-api` installed.
