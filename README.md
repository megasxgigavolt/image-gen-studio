# Auto Gen Studio

Auto Gen Studio is a Windows desktop production workspace for faceless YouTube
automation. The first product track covers script and narration input, visual
planning, image generation, image editing, and export.

The retired Python prototype is retained under `legacy/prototype` as a
behavioral reference.

## Repository layout

```text
apps/desktop/          React and TypeScript desktop UI
services/python-engine/ Python AI and media engine (introduced incrementally)
packages/contracts/    Shared versioned contracts
docs/                  Architecture, releases, and engineering records
legacy/                Migration notes for the existing prototype
tools/                 Standalone utility scripts
releases/              Local release artifacts (not committed)
mockup/                Current visual source of truth
```

## Current release

Version 1.0.0 is the stable personal Windows release. It includes local project
persistence, source intake, visual planning, Gemini image generation and
editing, durable bulk jobs, exports, project bundles, and timeline foundations.

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

Build the verified Windows installer:

```powershell
npm run tauri -- build
```

The installer is written under
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

Local project data is kept outside the repository:

```text
%LOCALAPPDATA%\studio.autogen.desktop\auto-gen-studio.db
%LOCALAPPDATA%\studio.autogen.desktop\Projects
```
