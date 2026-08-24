## Connect your OpenRouter key (BYOK)

C Repair is **bring-your-own-key**: scans and repairs run through *your*
[OpenRouter](https://openrouter.ai) account, and you pay OpenRouter directly —
the extension has no backend of its own.

- **[Connect OpenRouter](command:crepair.connectOpenRouter)** — opens the
  OpenRouter approval page in your browser. After you approve, the page shows
  a one-time code (valid for 10 minutes): **copy it and paste it into the
  VS Code prompt**. C Repair exchanges it for a key and stores it. This works
  the same everywhere — local, WSL, and remote setups.
- **[Set API Key](command:crepair.setApiKey)** — paste an existing key from
  the OpenRouter dashboard instead.

The key is kept in VS Code's secret storage. It is never written to settings,
logs, or the command line.
