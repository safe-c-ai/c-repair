# Publishing C Repair

The extension manifest, README and CHANGELOG are in `apps/vscode`. Local and API inference use the same review and Accept workflow.

## Prepare a release

1. Update the extension version in `apps/vscode/package.json` and `package-lock.json`, and the bridge version when the bundled bridge changes. Rebuild the bridge wheels as described in `tools/build-bridge-dist.sh`.
2. Run the checks relevant to the changes: `npm run typecheck:vscode`, `npm run test:vscode`, `npm run test:api`, the Electron tests in `apps/vscode`, and `npm run test:packaging`.
3. Build the platform packages with `npm run package:vsix -- all`. See [VSIX build and distribution](VSIX_PACKAGING.md) for required inputs, hashes and output locations.
4. Check installation, bundled guides and the workflow on the target hosts. Keep the tested VSIX files, `manifest.json` and `SHA256SUMS` together. Package checks do not substitute for local model testing.

## Publish

1. Commit and push the release source, guides, README and CHANGELOG to GitHub. Do not commit generated VSIX files, model weights, wheels, inference engine binaries, credentials or test evidence.
2. Check that the GitHub links and images in the packaged README resolve. Packaging uses `https://github.com/safe-c-ai/c-repair/blob/main/apps/vscode` for content and the corresponding raw URL for images.
3. Publish the same verified `darwin-arm64`, `win32-x64` and `linux-x64` VSIX files under the existing `safe-c-ai.c-repair` extension. Upload them through [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/safe-c-ai), or use `vsce publish --packagePath` with configured publisher authentication. Do not rebuild between verification and upload.
4. Verify the version, platform packages, README, guide links and installation from Marketplace. The packaged README provides the Marketplace overview.

For authentication and platform-specific publication, follow the [official VS Code publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Updating from 0.1.x

After installing 0.2.0 and reloading VS Code, users with an existing bridge run **C Repair gear → Setup → Commands → Set Up Bridge** once. Settings and API keys are retained. Users with a custom Python bridge update its wheels separately; see [the local settings guide](../apps/vscode/docs/local-models.md#custom-python-bridge).
