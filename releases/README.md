# Releasing and shipping updates

Auto Gen Studio can update itself. Once this is set up, shipping a change to
anyone running the app is: build → publish → they get it automatically the
next time they open it. No more sending installer files around.

## One-time setup (already done on this machine)

1. A signing keypair was generated with `npx tauri signer generate` and
   saved to `%USERPROFILE%\.tauri-keys\auto-gen-studio.key` (private),
   `...\.tauri-keys\auto-gen-studio.key.pub` (public), and
   `...\.tauri-keys\auto-gen-studio.key.password` (the key's password —
   Tauri's empty-password keys are unreliable across CLI versions, so this
   key was given a real generated password rather than a blank one).
   - The **private key and its password never leave this machine** and are
     never committed to git — only this machine (or wherever those two
     files are copied to) can publish updates the app will trust.
   - The **public key** is embedded in `apps/desktop/src-tauri/tauri.conf.json`
     (`plugins.updater.pubkey`) — that's what every installed copy of the
     app uses to verify an update was really signed by this key before
     installing it.
   - **Back up both `auto-gen-studio.key` and `auto-gen-studio.key.password`
     somewhere safe** (a password manager or encrypted backup). If either is
     lost, no future update can be signed for app installs that are already
     out there — they'd need a fresh manual install to move to a new
     signing key.
2. The GitHub CLI (`gh`) is installed and authenticated
   (`gh auth login`, needs `repo` scope) — `publish-release.ps1` uses it to
   create GitHub Releases.

## Normal workflow: shipping a change

From the repo root, after your code changes are committed:

```powershell
# 1. Bump the version in apps/desktop/src-tauri/tauri.conf.json,
#    apps/desktop/package.json, and apps/desktop/src-tauri/Cargo.toml.

# 2. Build (signs automatically if the key from setup step 1 is present):
.\releases\build-release.ps1

# 3. Publish it — this is the step that makes existing installs update:
.\releases\publish-release.ps1
```

`publish-release.ps1`:
- Tags the commit (`vX.Y.Z`) and pushes the tag.
- Creates a GitHub Release with the signed installer attached.
- Writes and uploads `latest.json`, the manifest every running copy of the
  app checks against on launch.

That's it — anyone with the app already installed will see an
"Update available" banner the next time they open it, with a one-click
"Update & Restart". No file needs to be sent to anyone.

## First install (a brand-new machine, e.g. your partner's, once)

They still need the installer once, the normal way — auto-update only
updates an *existing* install. Either:
- Send them `releases/vX.Y.Z/Auto Gen Studio_X.Y.Z_x64-setup.exe` directly, or
- Point them at the GitHub Release page:
  https://github.com/megasxgigavolt/image-gen-studio/releases/latest

After that one install, every future version reaches them automatically.
