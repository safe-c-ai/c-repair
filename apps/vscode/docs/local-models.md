# Local model settings guide

[日本語](local-models.ja.md)

Run detection, repair, and LLM validation on your computer without an API key.

For your first model, start with [First setup](#first-setup). For Scan and repair review, see the [user guide](user-guide.md).

- [Change and save settings](#change-and-save-settings)
- [Adjust reasoning and speed](#adjust-reasoning-and-speed)
- [Adjust token limits and memory](#adjust-token-limits-and-memory)
- [First setup](#first-setup)
- [Troubleshooting](#troubleshooting)
- [Advanced reference](#advanced-reference)

## Change and save settings

Finish any active scan or repair before applying changes. You can edit settings while it runs.

1. Open **C Repair's gear → Setup → Local Setup → Local model settings**.
2. Select a setting and change its value.
3. Choose **✓ Apply changes** at the top.

Changes take effect on the next local operation. **Esc** discards unsaved edits.

You can also open these settings with **C Repair: Configure Local Inference** in the Command Palette.

| Setting | Use it to… |
| --- | --- |
| Scan reasoning | Adjust reasoning for detection and violation-removal checks |
| Repair reasoning | Adjust reasoning for repair and semantic validation |
| Model and quantization | Choose a model or a different quantization |
| Model location | Change the download folder or select an existing model |
| Advanced settings | Change token limits, timeout, and runtime options |

If a different model file is needed, the Apply button becomes **Download and apply** or **Verify model and apply**.

**C Repair Leaderboard** opens [model evaluation results](https://safe-c-ai.github.io/c-repair-leaderboard/cert-c/) without changing your selection.

## Adjust reasoning and speed

Open **Local model settings → Scan reasoning** or **Repair reasoning**.

| Model | Reasoning choices |
| --- | --- |
| Qwen3.8-27B | `xhigh`, `medium`, `low`, `off` |
| Ornith-1.5-35B-A3B | `on`, `off` |

Other models may offer different options.

- **For quality:** use `xhigh` on Qwen3.8. Reasoning can take time, even for small files.
- **For speed on Qwen3.8:** try `medium` or `low`. Check whether detection or repair quality changes.
- **To disable reasoning:** choose `off`.
- **To keep Scan aligned with repair:** choose **Same as repair** under Scan reasoning.

Choose **✓ Apply changes** after editing. Saved reasoning settings are retained across extension updates. See [Advanced reference](#advanced-reference) for **Model default**, `unverified`, and custom options.

## Adjust token limits and memory

Open **Local model settings → Advanced settings**.

| Setting | What it covers in one model request |
| --- | --- |
| Context length | Input + reasoning + final answer |
| Generation limit (MLX) | Reasoning + final answer |
| Repair and detection limit (GGUF) | Reasoning + final answer |
| Declaration completion limit | Generated helper declarations; normally 4,096 tokens |
| Timeout | Waiting time in seconds |

Use the generation setting for your runtime: MLX or GGUF. It applies to detection, repair, and LLM validation.

**The generation limit is not the size of the scanned code.** A small file can still require many reasoning tokens. The 4,096-token declaration limit does not apply to violation detection.

For example, a **32K generation limit** needs context large enough for those 32K tokens **plus the input**. Increasing context requires more KV-cache memory. Raising the generation limit allows longer reasoning and may increase processing time.

If memory is tight, reduce context or choose a smaller quantization under **Model and quantization**. GGUF also offers **KV cache → q8_0** and **GPU layers** to reduce GPU memory use. These GGUF controls are not available for MLX.

## First setup

### Before you start

Initial model and runtime downloads require an internet connection.

Choose the VSIX for the machine running the extension. In WSL or a remote session, use that machine's package, memory, and model files.

| Platform | VSIX |
| --- | --- |
| Apple Silicon Mac | darwin-arm64 |
| Windows x64 | win32-x64 |
| Linux / WSL2 x64 | linux-x64 |

- **Mac:** use ARM64 VS Code on native macOS.
- **Windows:** install the Microsoft Visual C++ x64 runtime. GPU execution also needs a supported NVIDIA GPU and driver.
- **Linux:** NVIDIA GPU execution needs a supported GPU, driver, and AVX2-compatible CPU. CPU-only execution does not need an NVIDIA GPU or driver.

The extension prepares the inference engine. A CUDA Toolkit installation or engine build is not needed.

### Steps

1. Install the VSIX for your platform from the table above.
2. Open **C Repair's gear → Setup → Local Setup → Set up or start local model**, or **Use a local model** in the empty results view.
3. Choose a model. Memory settings are automatic. Change the save location or settings only if needed.
   If you opened **Change settings** during GGUF setup, choose **Done** to return.
4. Choose **Download and start**, or **Start local model** if already downloaded.
5. Open a `.c` file and run **Scan Current File** or **Scan & Fix Current File**.

The extension prepares the model, engine, and Python bridge. You do not need to start an inference server.

If **Context Review** appears, check the inferred declarations before continuing.

### Mac: MLX

Normal downloads use **Qwen3.8-27B in MLX format**. Setup selects quantization and token limits from unified memory:

| Mac memory | Quantization | Context | Generation |
| --- | --- | ---: | ---: |
| 16 / 18 GB | 2bit (experimental) | 32K | 16K |
| 24 GB | 3bit | 64K | 32K |
| 32 / 36 GB | 4bit | 64K | 32K |
| 48 GB or more | 5bit | 64K | 32K |

Here, 1K means 1,024 tokens. macOS and other applications also use unified memory; leave room for them and for reasoning.

New MLX configurations set both **Scan reasoning** and **Repair reasoning** to `xhigh`. Below 16 GB, setup offers **Custom model** without an automatic download recommendation.

### Windows / Linux: GGUF

Choose **Qwen3.8-27B**, **Ornith-1.5-35B-A3B**, or **Custom model** for an existing GGUF. Setup selects quantization and GPU / RAM placement for your chosen model. Automatic Ornith settings require at least **32 GB of RAM**.

For GPUs or engines outside automatic support, select a compatible executable under **Advanced settings → Inference engine**. Automatic GPU acceleration supports NVIDIA on Windows / Linux; AMD and Intel GPU acceleration require a custom engine.

### Where models are stored

Downloads go to `local-models` in the extension's private storage by default. **Model location** shows the actual path.

Downloads can resume after cancellation. Existing models are used in place without copying, and saved models start without repeating setup.

## Troubleshooting

### Generation reached … token limit

The model used up its token budget before finishing.

1. Open **Local model settings → Advanced settings**.
2. Increase the limit for the operation that failed:
   - Detection, repair, or LLM validation: **Generation limit** on MLX, or **Repair and detection limit** on GGUF.
   - Helper declarations: **Declaration completion limit**.
3. Make **Context length** large enough for the new limit **plus the input**. For example, 32K generation plus 8K input needs at least 40K context.
4. Choose **✓ Apply changes** and run the failed operation again.

For detection or repair on Qwen3.8, an alternative is to lower **Scan reasoning** or **Repair reasoning** so it spends fewer reasoning tokens. Choose **✓ Apply changes**, retry, and check the effect on quality.

### Insufficient context or out of memory

- **Context error:** increase **Context length** if memory allows; otherwise reduce input or the generation limit.
- **Memory or load error:** close other applications, then review context, quantization, and placement. For GGUF, also check **KV cache** and **GPU layers**.

Open **Local model settings → Advanced settings** for context, KV cache, and GPU layers, or **Model and quantization** to change quantization. Choose **✓ Apply changes**, then retry.

### Timeout

Open **Local model settings → Advanced settings → Timeout** and increase it. Alternatively, lower **Scan reasoning** or **Repair reasoning** if supported. Choose **✓ Apply changes**, then retry.

### Missing or incomplete model

Open **Local model settings → Model location** and select the model again. For managed downloads, use **Download this model again** to verify files and resume the download. Finish with **✓ Apply changes**, **Download and apply**, or **Verify model and apply**, as shown.

### Cannot reach the bridge

Check the **C Repair** Output log and retry local setup. Initial local setup prepares the bridge automatically. If upgrading from an older extension leaves an outdated bridge, run **C Repair: Set Up Bridge** to update it, then retry.

### Stop an operation

Use **Cancel** in the progress notification. To unload the model, run **C Repair: Stop Local Model**.

### Review a repair

See the [user guide](user-guide.md#review-and-apply-a-repair) for validation evidence, Accept / Reject, rescanning and reports.

## Advanced reference

### Model defaults and custom reasoning

Reasoning options are read from the GGUF chat template or MLX tokenizer settings.

- **Model default:** follow the template's default reasoning.
- **unverified:** the template was not recognized; compatibility is unconfirmed.
- **Custom…:** enter reasoning template arguments as JSON.

These choices depend on recognizing the selected template. Unrecognized templates offer options whose compatibility is unverified.

### Existing and custom models

On Mac, **Custom model** accepts an existing MLX folder or GGUF file. An MLX folder must contain `config.json`, `tokenizer_config.json`, and safetensors weights. GGUF uses llama.cpp.

Saved GGUF models remain usable and are not replaced automatically. Saved Qwen3.6 GGUF configurations also remain supported.

### Reset and recovery

**Restore recommended settings** restores automatic starting values. On MLX it restores inference settings; change quantization separately through **Model and quantization**. **Download this model again** verifies managed files and resumes incomplete downloads. Managed downloads are checked with SHA-256.

### Runtime details

- **MLX:** private Python 3.12 environment; model-dtype KV cache; concurrency 1; prefill step 512. MTP, CPU expert offload, and selectable KV formats are not supported in this implementation.
- **GGUF:** input and physical batch sizes are editable. MTP requires a compatible model and engine plus extra memory; set **MTP draft tokens** to `0` to disable it.
- **New MLX defaults:** declaration reasoning `off`, declaration limit 4,096, timeout 14,400 seconds.

The Mac profiles are starting values. The 5bit model and extension workflows have been checked on an M1 Max with 64 GiB. Other capacities and quantizations have not received the same hardware checks.


### Custom Python bridge

This applies only if `crepair.bridge.pythonPath` names a Python environment you manage. Normal setup uses C Repair's private environment; **Set Up Bridge** updates that environment instead.

1. On the extension host, run `code --locate-extension safe-c-ai.c-repair` to find the installed extension directory. Its `bridge-dist` folder contains the CertFix and repair-api wheels.
2. Use the Python named in `crepair.bridge.pythonPath` to reinstall both wheels. Replace the paths below with your actual paths, keeping CertFix before repair-api:

```sh
# macOS / Linux
"<python-path>" -m pip install --force-reinstall "<certfix-wheel.whl>" "<repair-api-wheel.whl>"
```

```powershell
# Windows PowerShell
& "<python-path>" -m pip install --force-reinstall "<certfix-wheel.whl>" "<repair-api-wheel.whl>"
```

If that environment uses uv rather than pip, use `uv pip install --reinstall --python "<python-path>" "<certfix-wheel.whl>" "<repair-api-wheel.whl>"`.

3. Reload VS Code so the bridge uses the updated environment. For Remote / WSL, perform these steps on the extension host.
