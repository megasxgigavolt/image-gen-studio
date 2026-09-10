//! Live connection to the Gemini Chrome extension (see
//! `services/gemini-chrome-extension/`) — the replacement for the earlier
//! manual CSV-upload interchange (formerly `csv_export.rs`; renamed because
//! nothing here writes a CSV file anymore).
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
//! `<watch_folder>/<row_id>.<ext>` — flat, one file per row, named after
//! the `csv_export_rows.id` it belongs to (the correlation key). No
//! per-batch subfolder: row ids are UUIDs, so they're globally unique
//! across every batch without needing one.
//!
//! # Architecture
//!
//! Two cooperating pieces sharing one `LiveState` (`Arc<Mutex<...>>`),
//! started once from `spawn_gemini_extension_server` at app launch:
//!
//! - **Accept-loop**: a plain `std::thread` running a blocking
//!   `TcpListener` accept loop (this codebase has no tokio/async-framework
//!   dependency anywhere — `tungstenite`, not `tokio-tungstenite`, keeps
//!   that true). Each accepted connection gets its own thread that
//!   alternates, on a short read timeout, between checking for an incoming
//!   `{"type":"result",...}` message and draining an outbound queue the
//!   worker loop feeds.
//! - **Worker loop**: the direct descendant of the old CSV-import watcher —
//!   same "own `ProjectRepository` handle, infinite loop, sleep between
//!   ticks" shape as `spawn_single_still_dispatcher`. Each tick it (a)
//!   scans the flat watch folder for files matching any pending row and
//!   imports ready ones (unchanged in spirit from the old watcher), and
//!   (b) — new — if the extension is connected and nothing is currently in
//!   flight, pushes the next dispatchable row to it.
//!
//! A restart of either thread just means: the extension reconnects (or the
//! worker re-opens its own DB handle) and resumes from whatever rows are
//! still `status='exported'` — no in-memory state needs to survive a
//! restart for correctness.

use crate::projects::{PendingCsvExportRow, ProjectRepository};
use std::collections::HashMap;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tungstenite::Message;

/// Fixed local port the extension's background service worker connects
/// out to. A collision (something else already bound here) is the only
/// realistic failure mode for a single-instance desktop app — logged and
/// skipped rather than crashing app startup.
const PORT: u16 = 47215;
const POLL_INTERVAL: Duration = Duration::from_secs(4);
const CONNECTION_READ_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct LiveStateInner {
    connected: bool,
    sender: Option<mpsc::Sender<String>>,
    /// The row id most recently pushed to the extension, cleared once its
    /// `result` message arrives — the gate `next_dispatchable_extension_row`
    /// respects so only one row is ever in flight at a time.
    in_flight_row_id: Option<String>,
    /// Set by the connection thread when a `result` message arrives;
    /// consumed by the next worker tick, which is the only place DB writes
    /// happen (keeps every SQLite write confined to the worker's own
    /// connection, matching this codebase's one-repository-per-thread
    /// convention).
    pending_ack: Option<(String, bool, Option<String>)>,
}

pub type LiveState = Arc<Mutex<LiveStateInner>>;

/// Starts both the accept-loop and worker-loop threads; never returns.
/// Safe to call once at app launch regardless of whether any
/// `'browser-live'`-mode request has ever been enqueued — each worker tick
/// is a cheap no-op until one exists, and the accept loop just sits idle
/// with no connection.
pub fn spawn_gemini_extension_server(database_path: PathBuf, projects_dir: PathBuf, app_handle: AppHandle) {
    let state: LiveState = Arc::new(Mutex::new(LiveStateInner::default()));

    {
        let state = state.clone();
        let app_handle = app_handle.clone();
        thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
                Ok(listener) => listener,
                Err(err) => {
                    eprintln!("gemini_extension: failed to bind 127.0.0.1:{PORT}: {err}");
                    return;
                }
            };
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let state = state.clone();
                let app_handle = app_handle.clone();
                thread::spawn(move || handle_connection(stream, state, app_handle));
            }
        });
    }

    thread::spawn(move || {
        let Ok(repository) = ProjectRepository::open(&database_path, &projects_dir) else {
            return;
        };
        let mut observed_sizes: HashMap<PathBuf, u64> = HashMap::new();
        loop {
            thread::sleep(POLL_INTERVAL);
            worker_tick(&repository, &state, &app_handle, &mut observed_sizes);
        }
    });
}

/// Every other `.emit()` call in this codebase happens inside
/// `tauri::async_runtime::spawn_blocking` (registered with Tauri's own
/// runtime) — this module's threads are plain, unmanaged `std::thread`s
/// instead (matching `spawn_single_still_dispatcher`'s convention), and
/// calling `AppHandle::emit` directly from one of those turned out to
/// silently no-op (no panic, no error — the emit just never reaches any
/// listener). Bridging through `tauri::async_runtime::spawn` for just the
/// emit itself is the fix: it schedules the call onto Tauri's own runtime
/// regardless of which OS thread requested it.
fn emit_from_thread(app_handle: &AppHandle, event: &'static str, payload: serde_json::Value) {
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app_handle.emit(event, payload);
    });
}

fn handle_connection(stream: TcpStream, state: LiveState, app_handle: AppHandle) {
    let Ok(mut socket) = tungstenite::accept(stream) else { return };
    let _ = socket.get_ref().set_read_timeout(Some(CONNECTION_READ_TIMEOUT));
    let (tx, rx) = mpsc::channel::<String>();
    {
        let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.connected = true;
        guard.sender = Some(tx);
    }
    emit_from_thread(&app_handle, "gemini-extension-connection-changed", serde_json::json!({"connected": true}));

    loop {
        match socket.read() {
            Ok(Message::Text(text)) => handle_incoming_message(&text, &state),
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref err))
                if err.kind() == std::io::ErrorKind::WouldBlock || err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
        // Drain whatever the worker loop has queued, on every pass through
        // this loop (whether that pass read a real message or just timed
        // out) — this is what makes outbound dispatch feel "live" rather
        // than bound to the read timeout's own cadence.
        loop {
            let queued = rx.try_recv();
            match queued {
                Ok(message) => {
                    if socket.send(Message::Text(message.into())).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    {
        let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.connected = false;
        guard.sender = None;
        guard.in_flight_row_id = None;
    }
    emit_from_thread(&app_handle, "gemini-extension-connection-changed", serde_json::json!({"connected": false}));
}

fn handle_incoming_message(text: &str, state: &LiveState) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { return };
    if value.get("type").and_then(|v| v.as_str()) != Some("result") {
        return;
    }
    let Some(id) = value.get("id").and_then(|v| v.as_str()) else { return };
    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let reason = value.get("reason").and_then(|v| v.as_str()).map(str::to_string);
    let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.in_flight_row_id = None;
    guard.pending_ack = Some((id.to_string(), ok, reason));
}

fn worker_tick(
    repository: &ProjectRepository,
    state: &LiveState,
    app_handle: &AppHandle,
    observed_sizes: &mut HashMap<PathBuf, u64>,
) {
    let (connected, in_flight, pending_ack) = {
        let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (guard.connected, guard.in_flight_row_id.clone(), guard.pending_ack.take())
    };
    if let Some((row_id, ok, reason)) = pending_ack {
        if !ok {
            let _ = repository.record_extension_row_failure(&row_id, reason.as_deref());
        }
    }

    if let Ok(Some(watch_folder)) = repository.get_app_setting("gemini_extension_watch_folder") {
        if !watch_folder.trim().is_empty() {
            if let Ok(entries) = fs::read_dir(&watch_folder) {
                let mut files_by_stem: HashMap<String, PathBuf> = HashMap::new();
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        files_by_stem.insert(stem.to_string(), path);
                    }
                }
                if let Ok(pending_rows) = repository.all_pending_extension_rows() {
                    for row in &pending_rows {
                        if let Some(render) = import_one_row_if_ready(repository, row, &files_by_stem, observed_sizes) {
                            emit_from_thread(
                                app_handle,
                                "gemini-extension-render-imported",
                                serde_json::json!({
                                    "videoId": row.video_id,
                                    "groupId": row.group_id,
                                    "renderId": render.id,
                                    "isFinal": render.is_final,
                                }),
                            );
                        }
                    }
                }
            }
            observed_sizes.retain(|path, _| path.exists());
        }
    }
    // Deliberately AFTER the file-import scan above, not before: a row
    // whose file already landed (just not yet picked up this exact tick)
    // must get the chance to import — and drop out of 'exported' entirely
    // — before this ever gets to judge it as abandoned. Only a row still
    // genuinely 'exported' at this point, with no file to show for it and
    // no ack ever received, is a real candidate.
    let _ = repository.abandon_stale_dispatched_rows();
    let _ = repository.finalize_browser_live_requests_with_no_pending_rows();

    if connected && in_flight.is_none() {
        if let Ok(Some(next_row)) = repository.next_dispatchable_extension_row() {
            let prompt = dispatch_prompt_text(&next_row);
            // Best-effort — a lookup failure just means the extension
            // treats this as a first attempt (its own default), which is
            // never worse than what already happens today.
            let attempt = repository.extension_row_attempt_count(&next_row.id).unwrap_or(0);
            let message = serde_json::json!({
                "type": "job",
                "id": next_row.id,
                "kind": next_row.kind,
                "prompt": prompt,
                "sourceImagePath": next_row.source_image_path,
                "maskImagePath": next_row.mask_image_path,
                "attempt": attempt,
            })
            .to_string();
            let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(sender) = &guard.sender {
                if sender.send(message).is_ok() {
                    guard.in_flight_row_id = Some(next_row.id.clone());
                    // Durable counterpart to in_flight_row_id above — see
                    // next_dispatchable_extension_row's doc comment for why
                    // the in-memory guard alone isn't enough (it's wiped on
                    // every reconnect, including a routine one).
                    let _ = repository.mark_extension_row_dispatched(&next_row.id);
                }
            }
        }
    }
}

/// A row's `prompt_text` is always stored raw (the assembled prompt for a
/// generate row; the bare instruction for an edit row — see
/// `record_single_still_extension_row`'s doc comment on why an edit's raw
/// instruction is kept separate from what actually gets typed). Only a
/// manual Edit-via-extension row (identified by having a `source_image_path`
/// — a bulk-planned follow-up-edit never does, since it continues the same
/// chat and needs no attachment or elaboration) gets the fuller
/// "Rules: ..." framing wrapped around it here, at dispatch time, mirroring
/// `edit_image_render`'s own API-path prompt wording.
fn dispatch_prompt_text(row: &PendingCsvExportRow) -> String {
    if row.source_image_path.is_none() {
        return row.prompt_text.clone();
    }
    let attachment_note = if row.mask_image_path.is_some() {
        "Two images are attached: the FIRST is the original image to edit; the SECOND is a mask — white marks the exact area to change, black/dark areas must be left untouched. Only modify the masked region."
    } else {
        "One image is attached: the original image to edit. Apply the instruction to the whole image as appropriate."
    };
    format!(
        "Edit the attached image(s) according to this request.\n\nUser request:\n{}\n\n{attachment_note}\n\nRules:\n1. Preserve the rest of the image as much as possible.\n2. Preserve camera angle, lighting, colors, composition, character identity, subject identity, and visual style.\n3. Do not restyle or recreate the full image.\n4. Keep all unrelated objects unchanged.\n5. Return a natural looking edited image.",
        row.prompt_text,
    )
}

fn import_one_row_if_ready(
    repository: &ProjectRepository,
    row: &PendingCsvExportRow,
    files_by_stem: &HashMap<String, PathBuf>,
    observed_sizes: &mut HashMap<PathBuf, u64>,
) -> Option<crate::projects::ImageRender> {
    let path = files_by_stem.get(&row.id)?;
    // known_parent_render_id (a manual Edit-via-extension row) already IS
    // the resolved parent — no chain to walk. Otherwise, an edit row can't
    // import before its generate row has — the generate row always sorts
    // first (row_order), so returning None here just means "try again next
    // tick," never a deadlock.
    let parent_render_id = if let Some(known) = &row.known_parent_render_id {
        Some(known.clone())
    } else {
        match &row.parent_row_id {
            Some(parent_id) => match repository.csv_export_row_imported_render_id(parent_id) {
                Ok(Some(render_id)) => Some(render_id),
                _ => return None,
            },
            None => None,
        }
    };
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    let previous = observed_sizes.insert(path.clone(), size);
    if previous != Some(size) {
        // Still changing (or first time seen this tick) — not stable yet.
        return None;
    }
    let image_bytes = fs::read(path).ok()?;
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
    match result {
        Ok(render) => {
            let _ = repository.mark_csv_export_row_imported(&row.id, &render.id);
            rename_for_readability(repository, row, path, extension);
            observed_sizes.remove(path);
            Some(render)
        }
        // A failed import (corrupt file, I/O error) is left `'exported'` and
        // retried next tick — no special handling needed, same as a row
        // whose file simply hasn't appeared yet.
        Err(_) => None,
    }
}

/// Strips characters Windows (and most other filesystems) disallow in a
/// filename, collapses runs of whitespace, and trims trailing dots/spaces
/// (Windows silently drops these from whatever name you actually give it,
/// so leaving them in would make the visible name not match what a
/// directory listing shows). Falls back to a generic label rather than
/// producing an empty filename if the title turns out to be nothing but
/// disallowed characters.
fn sanitize_for_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() { "video".to_string() } else { trimmed.to_string() }
}

/// Renames a just-imported row's downloaded file from `<row-id>.<ext>` to
/// `<video title> still <N>.<ext>` — purely cosmetic, so it's fully
/// best-effort: the app already links everything by database id and never
/// re-reads this filename for anything, it's only here so a human browsing
/// the flat watch folder can tell which downloaded file is which still
/// without cross-referencing row ids against the database. Any failure
/// (title/ordinal lookup, a filesystem error) just leaves the original
/// `<row-id>.<ext>` name in place — never a reason to fail the import
/// itself, which has already succeeded by the time this runs.
fn rename_for_readability(repository: &ProjectRepository, row: &PendingCsvExportRow, path: &Path, extension: &str) {
    let Ok((title, ordinal)) = repository.video_title_and_group_ordinal(&row.video_id, &row.group_id) else { return };
    let base = format!("{} still {}", sanitize_for_filename(&title), ordinal);
    let mut target = path.with_file_name(format!("{base}.{extension}"));
    if target.exists() {
        // Another file already claims the plain name — this folder is
        // never pruned, so an earlier run's output for the same still
        // (same video title, same ordinal) is routinely still sitting
        // here, not just a same-tick re-generation. Disambiguate with a
        // slice of this row's own globally-unique id rather than silently
        // overwriting whatever's already there.
        let suffix = &row.id[..row.id.len().min(8)];
        target = path.with_file_name(format!("{base} ({suffix}).{extension}"));
    }
    // A file Chrome just finished writing is a common target for a brief
    // real-time-antivirus/indexer lock on Windows — confirmed live that a
    // single rename attempt right after import can lose to that race and
    // silently leave the file under its raw `<row-id>.<ext>` name forever
    // (nothing else ever retries it, since the row is already `'imported'`
    // and drops out of every future tick's pending-row scan). A handful of
    // short-spaced retries is cheap insurance against a lock that, by its
    // nature, only lasts a moment.
    for attempt in 0..5 {
        if fs::rename(path, &target).is_ok() {
            return;
        }
        if attempt < 4 {
            thread::sleep(Duration::from_millis(150));
        }
    }
}
