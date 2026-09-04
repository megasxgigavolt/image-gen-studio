//! CSV interchange for the Gemini Chrome extension pipeline (see
//! `services/gemini-chrome-extension/`) — the replacement for the earlier,
//! fully-reverted embedded-webview approach. Two halves:
//!
//! - **Export**: `ProjectRepository::export_bulk_request_to_csv` (in
//!   `projects.rs`, alongside the rest of the bulk-generation queue logic
//!   it's part of) writes a planned `'csv-export'`-mode request's rows to a
//!   CSV file via `write_csv_rows` below. The user uploads that file into
//!   the extension by hand.
//! - **Import**: `spawn_csv_import_watcher`, started once at app launch
//!   (mirrors `spawn_single_still_dispatcher` in `lib.rs`), polls the same
//!   folder tree for images the extension downloaded and imports them back
//!   via `ProjectRepository::import_external_render`.
//!
//! # Why a separate `gemini_extension_watch_folder` setting, not `download_folder`
//!
//! `chrome.downloads.download()`'s `filename` argument is always relative
//! to Chrome's own configured default Downloads directory (see
//! `chrome://settings/downloads`) — an extension has no API to write to an
//! arbitrary absolute path this app picks. So the folder this app watches
//! has to be wherever the user's real Chrome downloads actually land, which
//! has nothing to do with `download_folder` (this app's own "Save
//! Location" for files *it* writes out, e.g. a single-still Download
//! button). Both settings can legitimately point at the same folder if the
//! user wants, but they're independent knobs.
//!
//! # Folder layout
//!
//! `<watch_folder>/gemini-bulk-gen/<bulk_request_id>.csv` (written by
//! export — a flat filename, not `prompts.csv` inside a per-batch folder,
//! since a browser `<input type="file">` only ever exposes the uploaded
//! file's *name* to the extension's popup, never its original folder path
//! — encoding the batch id into the filename is the only way for it to
//! learn which batch it was handed) and
//! `<watch_folder>/gemini-bulk-gen/<bulk_request_id>/<row_id>.<ext>`
//! (written by the extension, one file per row, named after the CSV row's
//! `id` column — the correlation key back to `csv_export_rows`).

use crate::projects::{PendingCsvExportRow, ProjectRepository};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

/// One row of an exported CSV — the writer's own shape (`id,kind,prompt`),
/// distinct from `PendingCsvExportRow` (the watcher's richer, DB-sourced
/// shape used for import correlation).
pub struct CsvExportRow {
    pub id: String,
    pub kind: String,
    pub prompt: String,
}

/// Writes `rows` to `path` (creating its parent directory if needed) with
/// header `id,kind,prompt`. Uses the `csv` crate rather than hand-rolled
/// string joining specifically so a prompt containing a comma, quote, or
/// embedded newline (all real, expected content — narration-derived scene
/// prompts are free text) round-trips correctly per RFC4180.
///
/// `path` is deliberately named `<bulk_request_id>.csv` by the caller
/// (`ProjectRepository::export_bulk_request_to_csv`), not a fixed
/// `prompts.csv` inside a per-batch folder — a browser `<input
/// type="file">` only ever exposes the uploaded file's *name*, never its
/// original folder path, so the extension's popup has no other way to
/// learn which batch it was handed. Encoding the batch id directly into the
/// filename lets it derive that from `file.name` alone.
pub fn write_csv_rows(path: &Path, rows: &[CsvExportRow]) -> Result<PathBuf, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut writer = csv::WriterBuilder::new()
        .from_path(path)
        .map_err(|e| e.to_string())?;
    writer.write_record(["id", "kind", "prompt"]).map_err(|e| e.to_string())?;
    for row in rows {
        writer.write_record([&row.id, &row.kind, &row.prompt]).map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;
    Ok(path.to_path_buf())
}

const POLL_INTERVAL: Duration = Duration::from_secs(4);

/// Starts the always-on background import watcher — never returns, mirrors
/// `spawn_single_still_dispatcher`'s shape exactly (own `ProjectRepository`
/// handle, infinite loop, sleep on nothing-to-do). Safe to call once at app
/// launch regardless of whether any `'csv-export'`-mode request has ever
/// been enqueued: each tick is a cheap no-op (`bulk_requests_awaiting_csv_import`
/// returns empty) until one exists.
pub fn spawn_csv_import_watcher(database_path: PathBuf, projects_dir: PathBuf) {
    thread::spawn(move || {
        let Ok(repository) = ProjectRepository::open(&database_path, &projects_dir) else {
            return;
        };
        // (batch_dir, filename) -> size last observed. A file only imports
        // once its size is unchanged across two consecutive ticks — the
        // guard against importing a still-downloading file. Local to this
        // thread and never persisted: a watcher restart just re-observes
        // from scratch, which is safe (worst case, one extra poll tick
        // before a genuinely-finished download is noticed).
        let mut observed_sizes: HashMap<PathBuf, u64> = HashMap::new();
        loop {
            thread::sleep(POLL_INTERVAL);
            let Ok(Some(watch_folder)) = repository.get_app_setting("gemini_extension_watch_folder") else {
                continue;
            };
            if watch_folder.trim().is_empty() {
                continue;
            }
            let Ok(batch_ids) = repository.bulk_requests_awaiting_csv_import() else { continue };
            for batch_id in batch_ids {
                let batch_dir = Path::new(&watch_folder).join("gemini-bulk-gen").join(&batch_id);
                let Ok(entries) = fs::read_dir(&batch_dir) else { continue };
                // filename stem -> full path, for every file currently in
                // the batch folder (this includes prompts.csv itself, which
                // simply never matches any row id below).
                let mut files_by_stem: HashMap<String, PathBuf> = HashMap::new();
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        files_by_stem.insert(stem.to_string(), path);
                    }
                }
                let Ok(pending_rows) = repository.pending_csv_export_rows(&batch_id) else { continue };
                for row in pending_rows {
                    import_one_row_if_ready(&repository, &row, &files_by_stem, &mut observed_sizes);
                }
            }
            // Drop stale entries for files no longer present anywhere this
            // tick (imported, or removed) — keeps the map from growing
            // unbounded across a long-running app session.
            observed_sizes.retain(|path, _| path.exists());
        }
    });
}

fn import_one_row_if_ready(
    repository: &ProjectRepository,
    row: &PendingCsvExportRow,
    files_by_stem: &HashMap<String, PathBuf>,
    observed_sizes: &mut HashMap<PathBuf, u64>,
) {
    let Some(path) = files_by_stem.get(&row.id) else { return };
    // An edit row can't import before its generate row has — the generate
    // row always sorts first (row_order), so this just means "try again
    // next tick," never a deadlock.
    let parent_render_id = match &row.parent_row_id {
        Some(parent_id) => match repository.csv_export_row_imported_render_id(parent_id) {
            Ok(Some(render_id)) => Some(render_id),
            _ => return,
        },
        None => None,
    };
    let Ok(metadata) = fs::metadata(path) else { return };
    let size = metadata.len();
    let previous = observed_sizes.insert(path.clone(), size);
    if previous != Some(size) {
        // Still changing (or first time seen this tick) — not stable yet.
        return;
    }
    let Ok(image_bytes) = fs::read(path) else { return };
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let is_edit = row.kind == "edit";
    let result = repository.import_external_render(
        &row.video_id,
        &row.group_id,
        &row.prompt_version_id,
        if is_edit { "edit" } else { "generation" },
        parent_render_id.as_deref(),
        is_edit.then_some(row.prompt_text.as_str()),
        image_bytes,
        extension,
    );
    if let Ok(render) = result {
        let _ = repository.mark_csv_export_row_imported(&row.id, &render.id);
        observed_sizes.remove(path);
    }
    // A failed import (corrupt file, I/O error) is left `'exported'` and
    // retried next tick — no special handling needed, same as a row whose
    // file simply hasn't appeared yet.
}
