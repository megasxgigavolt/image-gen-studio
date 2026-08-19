//! Process-wide "planning session" log: an Excel workbook capturing every
//! still a bulk-generation run or a single-still "Suggest Prompt" click
//! actually planned via the Claude CLI / Gemini planner (see
//! `run_claude_cli`/`request_claude_cli_v2_plan` in `projects.rs`) — the
//! narration it was planning against, its in-depth reasoning, the user
//! prompt it settled on, and (once available) the final text sent to
//! Gemini for generation plus the resulting image.
//!
//! One workbook per app run ("session"), written under
//! `<Preferences save location>/Logs/Session-<timestamp>.xlsx`, rewritten
//! from scratch on every event — the same "regenerate the whole file every
//! time" approach `projects.rs`'s own `write_bulk_prompt_log` already uses
//! for its per-video markdown log, chosen because `rust_xlsxwriter` can
//! only build a workbook from nothing, never reopen/edit an existing one.
//!
//! Deliberately a free-standing module rather than a field on
//! `ProjectRepository`: that struct is not one long-lived instance
//! everywhere in this app — the background image-generation job loop
//! (`lib.rs`) opens its own separate `ProjectRepository` on its own
//! thread. A `static` here is reachable identically from every instance
//! and thread, the same reasoning as `projects.rs`'s own
//! `CLAUDE_CLI_AVAILABLE` static.

use chrono::Utc;
use rust_xlsxwriter::{Format, FormatAlign, Image, Workbook};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// One planned still, as known at planning time (before generation).
pub struct PlannedEntry {
    pub group_id: String,
    pub ordinal: i64,
    pub narration: String,
    pub decision_reasoning: String,
    pub user_prompt: String,
    /// "Claude CLI" or "Gemini" — whichever actually answered this
    /// planning call, so a run that fell back is still fully logged, just
    /// labeled honestly rather than silently dropped.
    pub provider: &'static str,
}

struct SessionLogRow {
    video_id: String,
    group_id: String,
    ordinal: i64,
    narration: String,
    decision_reasoning: String,
    user_prompt: String,
    provider: &'static str,
    final_gemini_prompt: Option<String>,
    thumbnail: Option<Vec<u8>>,
    /// Monotonic insertion order across the whole session — used to pick
    /// the MOST RECENT still-pending row for a (video, still) pair when a
    /// generation completes, rather than an exact prompt-version match,
    /// so a QC-auto-corrected prompt (`validate_visual_intent`) still
    /// lands on the right row instead of being silently dropped.
    sequence: u64,
}

struct SessionLog {
    file_path: Option<PathBuf>,
    // Insertion-ordered sheet list — a plain Vec (not a map) since a
    // session realistically holds at most a few dozen sheets, and
    // preserving the order sheets were first created in is exactly the
    // order they should appear in the workbook.
    sheets: Vec<(String, Vec<SessionLogRow>)>,
    // video_id -> next "Bulk N" number to hand out.
    bulk_run_counters: HashMap<String, u32>,
    // A stable per-run key (the bulk_generation_requests id when planning
    // rides the durable queue, or a synthesized key otherwise) -> the
    // sheet name already assigned to it, so repeated chunk calls for the
    // SAME run keep landing on the SAME sheet instead of minting a new
    // "Bulk N" every chunk.
    run_key_to_sheet: HashMap<String, String>,
    next_sequence: u64,
}

impl SessionLog {
    fn new() -> Self {
        Self {
            file_path: None,
            sheets: Vec::new(),
            bulk_run_counters: HashMap::new(),
            run_key_to_sheet: HashMap::new(),
            next_sequence: 0,
        }
    }
}

static SESSION_LOG: OnceLock<Mutex<SessionLog>> = OnceLock::new();

fn session_log() -> &'static Mutex<SessionLog> {
    SESSION_LOG.get_or_init(|| Mutex::new(SessionLog::new()))
}

/// Excel sheet names: max 31 chars, and none of `: \ / ? * [ ]`. Truncates
/// and strips forbidden characters; the caller is responsible for
/// de-duplicating against sheet names already in use (see
/// `unique_sheet_name`).
fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if ":\\/?*[]".contains(c) { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    let base = if trimmed.is_empty() { "Sheet" } else { trimmed };
    base.chars().take(31).collect()
}

/// Appends " (2)", " (3)", ... (truncating the base name if needed to stay
/// within Excel's 31-char limit) until the name doesn't collide with any
/// sheet already in this session.
fn unique_sheet_name(sheets: &[(String, Vec<SessionLogRow>)], candidate: &str) -> String {
    let sanitized = sanitize_sheet_name(candidate);
    if !sheets.iter().any(|(name, _)| name == &sanitized) {
        return sanitized;
    }
    for suffix in 2..1000u32 {
        let tag = format!(" ({suffix})");
        let base_len = 31usize.saturating_sub(tag.len());
        let candidate = format!(
            "{}{tag}",
            sanitized.chars().take(base_len).collect::<String>()
        );
        if !sheets.iter().any(|(name, _)| name == &candidate) {
            return candidate;
        }
    }
    sanitized
}

fn resolve_file_path(log: &mut SessionLog, base_dir: &Path) -> PathBuf {
    if let Some(path) = &log.file_path {
        return path.clone();
    }
    let dir = base_dir.join("Logs");
    let _ = fs::create_dir_all(&dir);
    let name = format!("Session-{}.xlsx", Utc::now().format("%Y-%m-%d_%H-%M-%S"));
    let path = dir.join(name);
    log.file_path = Some(path.clone());
    path
}

/// Records one bulk-planned still. `run_key` identifies the run this still
/// belongs to (a `bulk_generation_requests` id, or any other value stable
/// across every chunk of the same run) — repeated calls with the same
/// `run_key` append to the same "<video> — Bulk N" sheet; a new `run_key`
/// for the same video starts a new numbered sheet. Best-effort: an I/O
/// failure here is returned as an error string for the caller to swallow,
/// mirroring `write_bulk_prompt_log`'s own non-fatal-logging convention —
/// a log-write failure must never fail the planning batch that triggered it.
pub fn record_bulk_planned_still(
    base_dir: &Path,
    video_id: &str,
    video_title: &str,
    run_key: &str,
    entry: PlannedEntry,
) -> Result<(), String> {
    let mut log = session_log()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = resolve_file_path(&mut log, base_dir);
    let sheet_key = format!("{video_id}::{run_key}");
    let sheet_name = if let Some(existing) = log.run_key_to_sheet.get(&sheet_key) {
        existing.clone()
    } else {
        let number = {
            let counter = log
                .bulk_run_counters
                .entry(video_id.to_string())
                .or_insert(0);
            *counter += 1;
            *counter
        };
        let candidate = format!("{video_title} — Bulk {number}");
        let assigned = unique_sheet_name(&log.sheets, &candidate);
        log.run_key_to_sheet.insert(sheet_key, assigned.clone());
        assigned
    };
    push_row(&mut log, &sheet_name, video_id, entry);
    write_workbook(&log, &path)
}

/// Records one single-still "Suggest Prompt" result — every such click for
/// a given video in this session lands on the same shared, ever-growing
/// "<video> — Suggestions" sheet (there is no natural "run" grouping for
/// individual clicks the way there is for a bulk batch).
pub fn record_suggested_still(
    base_dir: &Path,
    video_id: &str,
    video_title: &str,
    entry: PlannedEntry,
) -> Result<(), String> {
    let mut log = session_log()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = resolve_file_path(&mut log, base_dir);
    let sheet_key = format!("{video_id}::suggestions");
    let sheet_name = if let Some(existing) = log.run_key_to_sheet.get(&sheet_key) {
        existing.clone()
    } else {
        let candidate = format!("{video_title} — Suggestions");
        let assigned = unique_sheet_name(&log.sheets, &candidate);
        log.run_key_to_sheet.insert(sheet_key, assigned.clone());
        assigned
    };
    push_row(&mut log, &sheet_name, video_id, entry);
    write_workbook(&log, &path)
}

fn push_row(log: &mut SessionLog, sheet_name: &str, video_id: &str, entry: PlannedEntry) {
    let sequence = log.next_sequence;
    log.next_sequence += 1;
    let row = SessionLogRow {
        video_id: video_id.to_string(),
        group_id: entry.group_id,
        ordinal: entry.ordinal,
        narration: entry.narration,
        decision_reasoning: entry.decision_reasoning,
        user_prompt: entry.user_prompt,
        provider: entry.provider,
        final_gemini_prompt: None,
        thumbnail: None,
        sequence,
    };
    match log.sheets.iter_mut().find(|(name, _)| name == sheet_name) {
        Some((_, rows)) => rows.push(row),
        None => log.sheets.push((sheet_name.to_string(), vec![row])),
    }
}

/// Fills in the still-pending row (if any) for `(video_id, group_id)` with
/// the actual generation result — the most recently planned one, not an
/// exact prompt-version match, so a QC-auto-corrected prompt still lands
/// on the right row. No pending row (the prompt was hand-typed/edited,
/// never planned by Claude/Gemini in this session) is a silent no-op —
/// only stills that were actually planned get logged at all.
pub fn record_generated_image(
    base_dir: &Path,
    video_id: &str,
    group_id: &str,
    final_gemini_prompt: String,
    thumbnail: Option<Vec<u8>>,
) -> Result<(), String> {
    let mut log = session_log()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if log.file_path.is_none() {
        // Nothing has ever been planned this session, so there is
        // nothing this could possibly belong to yet.
        return Ok(());
    }
    let path = resolve_file_path(&mut log, base_dir);
    let mut best: Option<(usize, usize, u64)> = None; // (sheet index, row index, sequence)
    for (sheet_index, (_, rows)) in log.sheets.iter().enumerate() {
        for (row_index, row) in rows.iter().enumerate() {
            if row.video_id != video_id
                || row.group_id != group_id
                || row.final_gemini_prompt.is_some()
            {
                continue;
            }
            if best.map(|(_, _, seq)| row.sequence > seq).unwrap_or(true) {
                best = Some((sheet_index, row_index, row.sequence));
            }
        }
    }
    let Some((sheet_index, row_index, _)) = best else {
        return Ok(());
    };
    let row = &mut log.sheets[sheet_index].1[row_index];
    row.final_gemini_prompt = Some(final_gemini_prompt);
    row.thumbnail = thumbnail;
    write_workbook(&log, &path)
}

const HEADERS: [&str; 6] = [
    "Still #",
    "Sentence(s) assigned",
    "Decision reasoning",
    "Final user prompt",
    "Final Gemini prompt",
    "Generated image",
];

fn write_workbook(log: &SessionLog, path: &Path) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let header_format = Format::new().set_bold().set_background_color("#E8E8E8");
    let wrap_format = Format::new().set_text_wrap().set_align(FormatAlign::Top);
    for (sheet_name, rows) in &log.sheets {
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(sheet_name).map_err(|e| e.to_string())?;
        for (col, header) in HEADERS.iter().enumerate() {
            worksheet
                .write_with_format(0, col as u16, *header, &header_format)
                .map_err(|e| e.to_string())?;
        }
        worksheet
            .set_column_width(0, 8)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_column_width(1, 40)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_column_width(2, 55)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_column_width(3, 45)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_column_width(4, 45)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_column_width(5, 24)
            .map_err(|e| e.to_string())?;
        for (index, row) in rows.iter().enumerate() {
            let excel_row = (index + 1) as u32;
            worksheet
                .write_with_format(excel_row, 0, row.ordinal, &wrap_format)
                .map_err(|e| e.to_string())?;
            worksheet
                .write_with_format(excel_row, 1, row.narration.as_str(), &wrap_format)
                .map_err(|e| e.to_string())?;
            let reasoning = format!("[{}] {}", row.provider, row.decision_reasoning);
            worksheet
                .write_with_format(excel_row, 2, reasoning.as_str(), &wrap_format)
                .map_err(|e| e.to_string())?;
            worksheet
                .write_with_format(excel_row, 3, row.user_prompt.as_str(), &wrap_format)
                .map_err(|e| e.to_string())?;
            worksheet
                .write_with_format(
                    excel_row,
                    4,
                    row.final_gemini_prompt
                        .as_deref()
                        .unwrap_or("(pending — image not generated yet)"),
                    &wrap_format,
                )
                .map_err(|e| e.to_string())?;
            worksheet
                .set_row_height(excel_row, 110)
                .map_err(|e| e.to_string())?;
            if let Some(bytes) = &row.thumbnail {
                if let Ok(image) = Image::new_from_buffer(bytes) {
                    let image = image.set_scale_to_size(160, 140, true);
                    let _ = worksheet.insert_image(excel_row, 5, &image);
                }
            } else {
                worksheet
                    .write_with_format(excel_row, 5, "(pending)", &wrap_format)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if log.sheets.is_empty() {
        // A workbook needs at least one sheet — shouldn't happen in
        // practice (this is only ever called right after pushing a row),
        // but keeps `save` from erroring if it somehow did.
        workbook.add_worksheet();
    }
    workbook.save(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(group_id: &str, ordinal: i64) -> PlannedEntry {
        PlannedEntry {
            group_id: group_id.to_string(),
            ordinal,
            narration: "Some narration.".to_string(),
            decision_reasoning: "Because reasons.".to_string(),
            user_prompt: "A scene.".to_string(),
            provider: "Claude CLI",
        }
    }

    // `SESSION_LOG` is one process-wide static, deliberately (see the
    // module doc comment) — shared by every test in this file (cargo test
    // runs them concurrently in one process). Each test below uses its
    // own UUID-suffixed video id/title so their sheets/rows can never
    // collide with — or be mistaken for — another test's, and locks are
    // taken poison-tolerantly so one test's assertion failure (which
    // panics while still holding the guard) can't cascade into spurious
    // failures in its siblings.
    fn unique_id(label: &str) -> String {
        format!("{label}-{}", uuid::Uuid::new_v4())
    }

    fn lock() -> std::sync::MutexGuard<'static, SessionLog> {
        session_log()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn sanitizes_and_deduplicates_sheet_names() {
        assert_eq!(sanitize_sheet_name("A: Video/Name?"), "A  Video Name");
        let long = "x".repeat(50);
        assert_eq!(sanitize_sheet_name(&long).chars().count(), 31);

        let mut sheets: Vec<(String, Vec<SessionLogRow>)> =
            vec![("My Video — Bulk 1".to_string(), Vec::new())];
        let unique = unique_sheet_name(&sheets, "My Video — Bulk 1");
        assert_eq!(unique, "My Video — Bulk 1 (2)");
        sheets.push((unique, Vec::new()));
        let unique2 = unique_sheet_name(&sheets, "My Video — Bulk 1");
        assert_eq!(unique2, "My Video — Bulk 1 (3)");
    }

    #[test]
    fn repeated_chunks_of_the_same_run_share_one_sheet_new_run_gets_a_new_one() {
        let dir = std::env::temp_dir().join(unique_id("ags-session-log-test"));
        let video_id = unique_id("video");
        let title = unique_id("Title");
        record_bulk_planned_still(&dir, &video_id, &title, "run-a", entry("g1", 1)).unwrap();
        record_bulk_planned_still(&dir, &video_id, &title, "run-a", entry("g2", 2)).unwrap();
        record_bulk_planned_still(&dir, &video_id, &title, "run-b", entry("g3", 3)).unwrap();
        let log = lock();
        let run_a_sheet = log
            .run_key_to_sheet
            .get(&format!("{video_id}::run-a"))
            .unwrap()
            .clone();
        let run_b_sheet = log
            .run_key_to_sheet
            .get(&format!("{video_id}::run-b"))
            .unwrap()
            .clone();
        assert_ne!(run_a_sheet, run_b_sheet);
        let run_a_rows = log
            .sheets
            .iter()
            .find(|(name, _)| name == &run_a_sheet)
            .unwrap();
        assert_eq!(
            run_a_rows.1.len(),
            2,
            "both chunks of the same run must land on one sheet"
        );
        let run_b_rows = log
            .sheets
            .iter()
            .find(|(name, _)| name == &run_b_sheet)
            .unwrap();
        assert_eq!(run_b_rows.1.len(), 1);
    }

    #[test]
    fn generation_fills_in_the_most_recent_pending_row_for_that_still_and_skips_if_none() {
        let dir = std::env::temp_dir().join(unique_id("ags-session-log-test"));
        let video_id = unique_id("video");
        let title = unique_id("Title");
        // A still with no planned entry at all — generating for it must be a silent no-op.
        record_generated_image(&dir, &video_id, "ghost", "final prompt".to_string(), None).unwrap();
        {
            let log = lock();
            assert!(log.sheets.iter().all(|(_, rows)| rows
                .iter()
                .all(|r| r.video_id != video_id || r.group_id != "ghost")));
        }

        record_bulk_planned_still(&dir, &video_id, &title, "run-a", entry("g1", 1)).unwrap();
        record_bulk_planned_still(&dir, &video_id, &title, "run-a", entry("g1", 1)).unwrap(); // a second version of the same still
        record_generated_image(
            &dir,
            &video_id,
            "g1",
            "final prompt for g1".to_string(),
            Some(vec![1, 2, 3]),
        )
        .unwrap();

        let log = lock();
        let sheet_name = log
            .run_key_to_sheet
            .get(&format!("{video_id}::run-a"))
            .unwrap()
            .clone();
        let sheet = log
            .sheets
            .iter()
            .find(|(name, _)| name == &sheet_name)
            .unwrap();
        let g1_rows: Vec<&SessionLogRow> = sheet.1.iter().filter(|r| r.group_id == "g1").collect();
        assert_eq!(
            g1_rows.len(),
            2,
            "a second planned version must add a new row, not overwrite"
        );
        assert!(
            g1_rows[0].final_gemini_prompt.is_none(),
            "the OLDER version must stay pending"
        );
        assert_eq!(
            g1_rows[1].final_gemini_prompt.as_deref(),
            Some("final prompt for g1"),
            "the MOST RECENT pending version is the one that gets filled in"
        );
        assert_eq!(g1_rows[1].thumbnail, Some(vec![1, 2, 3]));
    }
}
