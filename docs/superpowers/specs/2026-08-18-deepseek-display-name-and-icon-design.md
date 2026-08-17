# DeepSeek Display Name and Icon

## Goal

Display the `deepseek-harness` agent as **DeepSeek** throughout AO and render its existing official DeepSeek SVG instead of the letter fallback.

## Compatibility

Keep the durable agent ID `deepseek-harness`. Existing configuration, migrations, stored sessions, and runtime lookup continue using that ID. Only user-facing labels change.

## Changes

- Change the backend adapter manifest name to `DeepSeek`.
- Change the product UI label for `deepseek-harness` to `DeepSeek`.
- Import `deepseek-harness.svg` in the renderer avatar component and map it to the `deepseek-harness` provider.
- Keep runtime descriptions and implementation/package names unchanged where they describe the official DeepSeek Harness technology rather than a UI label.

## Verification

- Update backend manifest and registry tests to expect `DeepSeek`.
- Strengthen the avatar test to require an image backed by `deepseek-harness.svg`, so a letter fallback cannot pass.
- Add or update a product UI label assertion if an existing focused test surface is available.
- Run the focused backend and frontend tests, then restart the Electron main process and verify the agent entry in the native window.

