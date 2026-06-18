# Architecture

## Decision

Auto Gen Studio uses a local-first modular desktop architecture:

- Tauri 2 desktop shell
- React 19, TypeScript, and Vite frontend
- Rust application boundary and native capabilities
- Python sidecar for AI, transcription, image, and media workflows
- SQLite canonical local database
- Project assets stored under `%LOCALAPPDATA%\Auto Gen Studio\Projects`
- Windows Credential Manager for API secrets

The frontend never calls AI providers directly. It invokes typed application
commands. Provider adapters, jobs, retries, persistence, and secret handling
remain outside the presentation layer.

## Product boundaries

```text
Presentation
  React views, components, accessibility, drag and drop

Application
  Use cases, commands, job coordination, undo/redo

Domain
  Channel, video, sentence, visual plan, still, render, prompt version

Infrastructure
  SQLite, filesystem, credentials, OpenAI, Gemini, Whisper, logging
```

Dependencies point inward. Domain code cannot depend on React, Tauri, SQLite,
or provider SDKs.

## Local-first and future cloud support

SQLite remains authoritative for the local product. Every persistent entity
uses a UUID, timestamps, and revision metadata so a future Supabase sync layer
can be added without replacing the local model.

## Persistence

- Meaningful edits are committed immediately in a transaction.
- A safety checkpoint runs every five minutes while a video is open.
- Ten rolling automatic snapshots are retained per video.
- Manual named snapshots are supported in a later release.
- Image versions remain until explicitly cleaned up.
- Unfinished jobs are discovered on startup and the user chooses whether to
  resume them.
- Project deletion moves data to an application trash area.

## Job system

Image jobs may run concurrently. Provider-specific policies determine maximum
parallelism, with two Gemini jobs as the initial default. Rate limits use
provider guidance and exponential backoff. Navigation does not cancel jobs.

## Visual plan invariants

- Sentences retain immutable source timestamps.
- Sentence drag and drop changes group membership, not source timing.
- Chronological order is enforced.
- A still begins at its first sentence and ends at its last sentence.
- Reset restores the original AI-generated plan.

## Distribution

The personal release targets Windows 10 and 11. Portable distribution comes
first. Installer-based updating is deferred until public distribution because
portable self-replacement is less reliable.

