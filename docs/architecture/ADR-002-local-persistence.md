# ADR-002: Local Persistence

Status: Accepted

Date: 2026-06-18

## Decision

Use SQLite through `rusqlite` in the Tauri process. Store binary and large media
assets in application-controlled project folders, with paths referenced by the
database.

The database is located under the Windows local application data directory.
Each channel receives `Projects/<channel-id>/`, and each video receives a
directory below its channel.

## Rationale

- SQLite supports transactions, migrations, crash recovery, and local querying.
- The application remains fully usable without internet access.
- UUID identifiers and revision metadata preserve a future Supabase sync path.
- Keeping media outside SQLite prevents database bloat.

## Deletion and recovery

Rows use nullable `trashed_at` timestamps. Normal queries exclude trashed rows.
Physical asset deletion is deferred to a future cleanup operation.

## Snapshots

Snapshots store versioned JSON state. Automatic snapshots retain the newest ten
per video. This release establishes the mechanism with workspace metadata;
later releases add script, plan, and render state to the snapshot payload.

