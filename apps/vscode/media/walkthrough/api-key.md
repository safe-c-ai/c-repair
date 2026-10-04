## Choose local or API inference

- **Local:** [Use a local model](command:crepair.setUpLocal), choose the model,
  then download and start it. Memory settings and the Python bridge are prepared
  automatically. No API key or separate bridge setup is needed. If you cancel
  setup, choose **Use a local model** again to finish.
- **API:** [Connect OpenRouter](command:crepair.connectOpenRouter), approve in
  your browser, then paste the one-time code into VS Code. An existing key can
  be entered through [Set API Key](command:crepair.setApiKey).

The API key is kept in VS Code's secret storage. API inference sends code to
OpenRouter and the selected provider; local inference runs on your computer.

To switch from Local to API, also select **Preset**, **Free**, or **Custom** in
[Settings](command:crepair.openSettings) → **Models & Routing → Model Mode**.
Connecting a key alone does not switch modes.

[Quick start & user guide](command:crepair.openUserGuide) explains the full workflow.
