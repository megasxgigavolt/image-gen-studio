# ADR-001: Desktop Stack

Status: Accepted

Date: 2026-06-18

## Context

The product requires a polished interface, sentence-level drag and drop,
background jobs, image editing, and a future interactive video timeline. The
existing CustomTkinter architecture cannot provide the desired UI quality or
maintainable module boundaries.

## Decision

Use Tauri 2 with React and TypeScript. Keep compute-heavy and existing Python
logic in a separately testable Python engine. Use SQLite and project asset
folders for local persistence.

## Consequences

- The UI can closely follow and exceed the HTML mockup.
- Native capabilities remain permission-scoped through Tauri.
- Rust and Windows C++ build prerequisites are required.
- Python integration must use explicit versioned contracts.
- The old Tkinter UI will not be migrated widget by widget.

