# Auto Gen Studio

Auto Gen Studio is a Windows desktop production workspace for faceless YouTube
automation. The first product track covers script and narration input, visual
planning, image generation, image editing, and export.

The existing `image_gen_studio.py` application is retained as a legacy reference
while the product is rebuilt incrementally.

## Repository layout

```text
apps/desktop/          React and TypeScript desktop UI
services/python-engine/ Python AI and media engine (introduced incrementally)
packages/contracts/    Shared versioned contracts
docs/                  Architecture, releases, and engineering records
legacy/                Migration notes for the existing prototype
mockup/                Current visual source of truth
```

## Current release

Development is starting with `v0.1.0-foundation`. See
[`docs/releases/ROADMAP.md`](docs/releases/ROADMAP.md) and
[`docs/releases/v0.1.0.md`](docs/releases/v0.1.0.md).

## Development

Requirements:

- Node.js 22.12 or newer
- npm 10 or newer
- Rust stable, Microsoft C++ Build Tools, and WebView2 for Tauri development
- Python 3.10 or newer for the future AI engine

```powershell
npm install
npm run dev
```

Build the optimized Windows executable:

```powershell
npm run tauri -- build --no-bundle
```

The output is written under
`apps/desktop/src-tauri/target/release/auto-gen-studio.exe`.
