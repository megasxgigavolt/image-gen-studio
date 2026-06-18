# ADR-003: Python Engine Boundary

Status: Accepted

Date: 2026-06-18

## Decision

AI and media processing runs through a versioned JSON-lines Python engine.
Tauri owns process lifecycle, persistence, validation, and filesystem access.
Python receives explicit input paths and emits typed results without writing
the application database.

## Initial operations

- `segment_script`: deterministic sentence extraction and heuristic grouping
- `transcribe`: optional local CPU Whisper word timestamps
- `build_visual_plan`: alignment plus deterministic grouping

## Rules

- Engine functions never call `sys.exit`.
- Errors are serialized with stable codes and human-readable messages.
- Excel is an optional export, never an integration contract.
- Provider-specific code implements adapters behind the engine operation.
- Unit tests use fixtures and do not download models.

