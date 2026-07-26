# Releasing

## Before anything else: the signing key

Every release is signed with a private key, and an installed copy of Envy will
only accept an update signed by the one key its own build was compiled against.
That public key is baked into `src-tauri/tauri.conf.json`.

The consequence is worth being blunt about: **if the private key is lost, every
existing install is stranded.** Generating a new key does not help — those
installs are still looking for signatures from the old one, so the only way back
is asking people to download and reinstall by hand. Keep it in a password
manager, and add it to the repository secrets before setting up CI.

It is not in this repository, and `.gitignore` is set up so it cannot be added
by accident.

## Cutting a release

1. Bump `version` in `src-tauri/tauri.conf.json`. That single value drives the
   installer filename, the manifest, and the comparison an installed Envy makes
   to decide whether it is out of date.

2. Build, with the signing key in the environment:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/envy-updater-key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run tauri build
   ```

   The build ends by listing two bundles *and* two updater signatures. If the
   signatures are absent, the key was not set — the installers still work for a
   fresh install, but nothing can update to them. Do not publish that.

3. Generate the manifest:

   ```bash
   node scripts/make-latest-json.mjs --notes "What changed in this build."
   ```

4. Publish, tagged `v<version>` to match the URL the manifest generates:

   ```bash
   gh release create v0.1.0 \
     target/release/bundle/nsis/Envy_0.1.0_x64-setup.exe \
     target/release/bundle/msi/Envy_0.1.0_x64_en-US.msi \
     target/release/bundle/latest.json \
     --title "Envy 0.1.0" --notes "..."
   ```

`latest.json` has to be attached to the release itself. The updater endpoint
points at `releases/latest/download/latest.json`, which GitHub resolves to
whichever release is newest — so publishing a release is what makes it the one
existing installs are offered.

The repository has to be public for any of those URLs to resolve. Release assets
on a private repository require an authenticated request, which the updater does
not make and testers cannot make from a browser.

## What testers will see

The app is not code-signed for Windows, so SmartScreen shows "Windows protected
your PC" on first run. They need to click **More info** then **Run anyway**. Say
so wherever the download is offered, or it reads as the app being unsafe rather
than merely unknown.

Signing is a separate thing from the update key above, and is not required for
any of this to work — it only removes that warning. Authenticode certificates
cost real money and, apart from the EV kind, do not remove the warning
immediately anyway: reputation accrues over downloads.
