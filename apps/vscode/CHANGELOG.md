# Change log

## 0.2.0 — 2026-10-03

### Local inference

- Run detection, repair and LLM validation with a downloaded model without an OpenRouter key.
- Use Qwen3.8-27B for accuracy or Ornith-1.5-35B-A3B for CPU / lower-memory use on Windows and Linux. Initial quantization and memory settings follow the available hardware; Custom supports your own models and settings.
- Use MLX / Metal for normal downloads on Apple Silicon Mac. On Mac, GGUF models can be used through Custom; they are not converted to MLX automatically.
- Change Scan and Repair reasoning, token limits, model location and runtime settings through Local model settings. Reasoning choices are read from the model's chat template. Token-limit failures link back to the relevant settings.
- Prepare and manage the inference runtime through the extension. Stop Local Model releases its memory; cancellation and extension shutdown stop owned work and processes.

### API inference

- Update the OpenRouter Preset to `deepseek/deepseek-v4.1-flash` on DeepInfra for detection, repair and LLM validation.

### Setup, review and guides

- Learn the Scan & Fix → review → Accept → Scan loop with a bundled practice sample. Open a fresh editable copy beside the quick-start guide; find the guide again through the view's book icon.

- Start local setup or connect OpenRouter from the C Repair view. Open setup, model settings, the user guide and report export from C Repair settings.
- Read bundled English or Japanese guides for setup, Scan, Context Review, validation, diff review, Accept / Reject and reports. The display language selects the guide language.
- Show API-only walkthrough steps only in API modes, and mark setup complete after preparation succeeds.
- Preserve explicit review and Accept for both local and API repairs. Mechanical failures block Accept; judgment warnings require confirmation.
- Apply the API reasoning setting to detection, repair and LLM validation. Declaration completion uses reasoning off.
- Handle Apple Clang's missing-declaration diagnostics and improve cancellation and bridge reinstallation.

### Supported extension hosts

This version provides Apple Silicon Mac (`darwin-arm64`), Windows x64 (`win32-x64`) and Linux / WSL2 x64 (`linux-x64`) packages. It does not provide an Intel Mac, Windows ARM64, Linux ARM64 or web package. Local inference uses memory on the extension host, including remote hosts.

The 16/18 GB Mac profiles are experimental. Mac MLX execution was checked on an M1 Max with 64 GiB; automatic profiles for other capacities are starting settings. Quantization and reasoning choices can affect repair quality and speed. See the [local settings guide](https://github.com/safe-c-ai/c-repair/blob/main/apps/vscode/docs/local-models.md).

### Upgrading

After updating, reload VS Code. **If you previously set up the bridge, run C Repair's gear → Setup → Commands → Set Up Bridge once before Scan or local setup.** The extension ships repair-api 0.2.0, but exchanging the VSIX alone does not update an existing Python environment. C Repair settings and the API key are retained. If `crepair.bridge.pythonPath` points to your own environment, [update its bridge wheels separately](https://github.com/safe-c-ai/c-repair/blob/main/apps/vscode/docs/local-models.md#custom-python-bridge).

## 0.1.1 — 2026-08-24

- Updated Quick start to link to the Visual Studio Marketplace installation page.

## 0.1.0 — 2026-08-24

- Initial Marketplace release with OpenRouter inference, CERT C detection, repair validation, diff review and explicit Accept.
