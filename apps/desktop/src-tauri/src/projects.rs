use base64::Engine;
use chrono::Utc;
use keyring::{Entry, Error as KeyringError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::io::{BufRead, BufReader};
#[cfg(not(test))]
use std::process::{Command, Stdio};
#[cfg(all(not(test), windows))]
use std::os::windows::process::CommandExt;

// Cached Python executable name — probed once per process, tries the Windows
// Python Launcher (py) first since it survives fresh installs before PATH reload.
#[cfg(not(test))]
static PYTHON_EXE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[cfg(not(test))]
fn find_python() -> &'static str {
    PYTHON_EXE.get_or_init(|| {
        for candidate in ["py", "python", "python3"] {
            let ok = std::process::Command::new(candidate)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok();
            if ok {
                return candidate.to_string();
            }
        }
        "python".to_string()
    })
}

// Cached "is a logged-in Claude Code CLI on PATH" probe — used only to decide
// whether `analyze_motion_graphics` can proceed without an OpenAI/Gemini key
// configured (motion_graphics_engine.py tries the CLI itself; this is just the
// up-front gate so a missing-key error isn't shown when the CLI alone is enough).
#[cfg(not(test))]
static CLAUDE_CLI_AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg(not(test))]
fn claude_cli_available() -> bool {
    *CLAUDE_CLI_AVAILABLE.get_or_init(|| {
        std::process::Command::new("claude")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

#[derive(Clone, Serialize, Deserialize)]
struct GoogleServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    token_uri: String,
}

#[derive(Serialize)]
struct GoogleJwtClaims {
    iss: String,
    scope: String,
    aud: String,
    exp: usize,
    iat: usize,
}

enum GeminiAuth {
    ApiKey(String),
    Vertex { access_token: String, project_id: String },
}

/// Resolved credentials for a motion-graphics engine invocation
/// (`analyze_motion_graphics`) — factored out into its own resolution/gating
/// step rather than inlined, so the credential logic and `Command` env-var
/// wiring stay in one place.
struct MotionGraphicsCredentials {
    openai_api_key: Option<String>,
    gemini_api_key: Option<String>,
    gemini_vertex: Option<(String, String)>,
    gemini_auth_error: Option<String>,
}

impl MotionGraphicsCredentials {
    #[cfg(not(test))]
    fn apply_env(&self, command: &mut Command) {
        if let Some(key) = &self.openai_api_key {
            command.env("OPENAI_API_KEY", key);
        }
        if let Some(key) = &self.gemini_api_key {
            command.env("GEMINI_API_KEY", key);
        }
        if let Some((access_token, project_id)) = &self.gemini_vertex {
            command
                .env("GEMINI_VERTEX_ACCESS_TOKEN", access_token)
                .env("GEMINI_VERTEX_PROJECT_ID", project_id);
        }
        if let Some(error) = &self.gemini_auth_error {
            command.env("GEMINI_AUTH_ERROR", error);
        }
    }
}

pub const EDUCATIONAL_VISUAL_PLANNER_VERSION: &str = "3.0.0-bulk-plan-v2";

/// Shared validation list for `timeline_clips.motion_preset` — kept as one
/// const so `set_timeline_clip_motion`/`apply_motion_to_all_clips` can't drift
/// out of sync with each other.
pub const MOTION_PRESETS: [&str; 10] = [
    "none", "zoom-in", "zoom-out", "pan-left", "pan-right",
    "zoom-pulse", "zoom-in-subject", "zoom-out-subject", "ken-burns", "cuts",
];

/// Shared validation list for `timeline_clips.transition_in`/`transition_out`
/// — was 4 separate inline `const VALID` arrays that could (and did) drift.
/// The last 4 ("join" transitions) blend two adjacent clips' pixel data —
/// the export engine and canvas preview only ever honor them via a clip's
/// `transition_out` (see `expand_join_transitions` in video_export_engine.py);
/// `transition_in` still accepts them for schema simplicity, but the picker
/// UI only offers them on the "out" side to avoid a setting that visibly
/// does nothing.
pub const VALID_TRANSITIONS: [&str; 9] = [
    "cut", "fade", "dip-to-white",
    "cross-fade", "slide-left", "slide-right", "zoom-blur", "whip-pan", "blur-transition",
];

/// Shared validation list for `timeline_clips.color_filter_preset`. The
/// brightness/contrast/saturation targets each preset maps to live in both
/// `TimelineView.tsx` (canvas preview) and `video_export_engine.py` (ffmpeg
/// `eq` filter) — kept numerically identical there so preview and export agree.
pub const COLOR_FILTER_PRESETS: [&str; 7] = ["none", "warm", "cool", "cinematic", "bright", "muted", "dark"];

/// Maps a clip's freely-composed `motion_graphic_settings_json` recipe (see
/// services/motion-engine/src/types.ts's `MotionRecipe` — there is no fixed
/// catalog of named treatments anymore, just a shared vocabulary of
/// independent primitives) onto the nearest existing `MOTION_PRESETS` value,
/// for the canvas's instant-scrub live preview only (`timeline-rendering.ts`'s
/// `applyMotion`) — the real export doesn't use this approximation for a clip
/// that has a motion graphic assigned; it renders the actual recipe via
/// `services/motion-engine` instead (see `video_export_engine.py`'s
/// `_render_motion_graphic`). This function stays only because re-running a
/// full Remotion/Chromium render on every timeline scrub would make the
/// editor unusably slow — the preview trades exactness for speed, the export
/// doesn't have to. Reads the recipe's own numeric fields directly (a
/// dominant pan, an organic flicker, a reveal mask, a panel-cut sequence)
/// rather than switching on an effect name, since that name is now free text
/// the AI invented for display purposes and carries no structural meaning.
fn approximate_motion_preset_for_effect(_effect: &str, settings_json: Option<&str>) -> &'static str {
    let settings: serde_json::Value = settings_json
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));
    let num = |key: &str| settings.get(key).and_then(|v| v.as_f64());

    let pan_x_delta = num("panXTo").unwrap_or(0.0) - num("panXFrom").unwrap_or(0.0);
    let pan_y_delta = num("panYTo").unwrap_or(0.0) - num("panYFrom").unwrap_or(0.0);
    // A dominant horizontal pan reads best as a directional pan preset — sign
    // encodes direction (positive-to-negative is left-to-right).
    if pan_x_delta.abs() > 0.5 && pan_x_delta.abs() >= pan_y_delta.abs() {
        return if num("panXFrom").unwrap_or(0.0) > num("panXTo").unwrap_or(0.0) { "pan-right" } else { "pan-left" };
    }
    // An organic flicker (candle/firelight-style) reads closest as a pulse —
    // a flat zoom wouldn't capture the "breathing" quality.
    if num("glowFlicker").unwrap_or(0.0) > 0.05 {
        return "zoom-pulse";
    }
    // A reveal/rack-focus mask is the case "zoom-in-subject"'s content-aware
    // push — `useTimelineAssets.ts` auto-calls `detect_render_subject` for
    // any clip with this preset, anchoring the push at a real detected
    // subject point instead of frame-center — is the closest available
    // analog for.
    if settings.get("maskShape").and_then(|v| v.as_str()).unwrap_or("none") != "none" {
        return "zoom-in-subject";
    }
    // Zoom + pan from off-center toward center — the one preset that
    // actually combines both motions.
    if pan_x_delta.abs() > 0.5 || pan_y_delta.abs() > 0.5 {
        return "ken-burns";
    }
    "zoom-in"
}

/// Parses a `TimelineClip`'s raw `motion_graphic_settings_json` string
/// column into a `serde_json::Value` for embedding directly in the export
/// manifest — `video_export_engine.py` needs a real JSON object under
/// `motionGraphicSettings`, not a JSON-encoded string.
fn motion_graphic_settings_value(clip: &TimelineClip) -> Option<serde_json::Value> {
    clip.motion_graphic_settings_json
        .as_ref()
        .and_then(|raw| serde_json::from_str(raw).ok())
}

const MIGRATION_001: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT
);
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    title TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT
);
CREATE TABLE IF NOT EXISTS resume_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    channel_id TEXT,
    video_id TEXT,
    stage TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS video_snapshots (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id, trashed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_video ON video_snapshots(video_id, created_at DESC);
"#;

const MIGRATION_002: &str = r#"
CREATE TABLE IF NOT EXISTS video_inputs (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    script_text TEXT NOT NULL DEFAULT '',
    pacing_seconds INTEGER NOT NULL DEFAULT 8 CHECK(pacing_seconds BETWEEN 4 AND 14),
    audio_asset_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS input_assets (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    kind TEXT NOT NULL CHECK(kind IN ('audio', 'reference')),
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_input_assets_video ON input_assets(video_id, kind);
"#;

const MIGRATION_003: &str = r#"
CREATE TABLE IF NOT EXISTS visual_plan_sentences (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS visual_plan_groups (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    sentence_ids_json TEXT NOT NULL,
    is_original INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS visual_plan_meta (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    timing_source TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_sentences_video ON visual_plan_sentences(video_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_plan_groups_video ON visual_plan_groups(video_id, is_original, ordinal);
"#;

const MIGRATION_004: &str = r#"
CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    user_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_video_group ON prompt_versions(video_id, group_id, version DESC);

CREATE TABLE IF NOT EXISTS image_renders (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
    file_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_renders_video_group ON image_renders(video_id, group_id, version DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

const MIGRATION_005: &str = r#"
CREATE TABLE IF NOT EXISTS image_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    status TEXT NOT NULL CHECK(status IN ('queued','running','paused','stopped','completed','failed')),
    total_items INTEGER NOT NULL,
    completed_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS image_job_items (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES image_jobs(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','stopped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    render_id TEXT REFERENCES image_renders(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_jobs_video ON image_jobs(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_job_items_job ON image_job_items(job_id, status, created_at);
"#;

const MIGRATION_006: &str = r#"
ALTER TABLE image_renders ADD COLUMN parent_render_id TEXT REFERENCES image_renders(id);
ALTER TABLE image_renders ADD COLUMN edit_instruction TEXT;
ALTER TABLE image_renders ADD COLUMN kind TEXT NOT NULL DEFAULT 'generation';
CREATE INDEX IF NOT EXISTS idx_image_renders_parent ON image_renders(parent_render_id);
"#;

const MIGRATION_007: &str = r#"
CREATE TABLE IF NOT EXISTS timelines (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    duration_seconds REAL NOT NULL,
    playhead_seconds REAL NOT NULL DEFAULT 0,
    zoom REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    render_id TEXT REFERENCES image_renders(id),
    ordinal INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_clips_video ON timeline_clips(video_id, ordinal);
"#;

const MIGRATION_008: &str = r#"
ALTER TABLE video_inputs ADD COLUMN pacing_preset TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE video_inputs ADD COLUMN pacing_min_seconds INTEGER NOT NULL DEFAULT 6;
ALTER TABLE video_inputs ADD COLUMN pacing_max_seconds INTEGER NOT NULL DEFAULT 10;
"#;

const MIGRATION_009: &str = r#"
ALTER TABLE image_renders ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_renders ADD COLUMN edit_strength TEXT;
ALTER TABLE image_renders ADD COLUMN mask_path TEXT;
ALTER TABLE image_renders ADD COLUMN mask_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visual_plan_groups ADD COLUMN plan_signature TEXT;
CREATE INDEX IF NOT EXISTS idx_image_renders_final ON image_renders(video_id, group_id, is_final);
"#;

const MIGRATION_010: &str = r#"
CREATE TABLE IF NOT EXISTS educational_visual_plans (
    still_id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    visual_plan_row_id TEXT NOT NULL,
    educational_objective TEXT NOT NULL,
    visual_intent TEXT NOT NULL,
    subject_strategy TEXT NOT NULL,
    image_settings_json TEXT NOT NULL,
    user_prompt TEXT NOT NULL,
    plan_signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_educational_plans_video ON educational_visual_plans(video_id);
"#;

const MIGRATION_011: &str = r#"
ALTER TABLE educational_visual_plans ADD COLUMN visual_strategy_mode TEXT NOT NULL DEFAULT 'Auto Educational';
ALTER TABLE educational_visual_plans ADD COLUMN planner_version TEXT NOT NULL DEFAULT '1.0.0-legacy';
"#;

const MIGRATION_012: &str = r#"
ALTER TABLE visual_plan_groups ADD COLUMN settings_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visual_plan_groups ADD COLUMN prompt_locked INTEGER NOT NULL DEFAULT 0;
"#;

const MIGRATION_013: &str = r#"
CREATE TABLE IF NOT EXISTS captions (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    interval_seconds REAL NOT NULL DEFAULT 1.0,
    srt_text TEXT NOT NULL,
    chunks_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

const MIGRATION_014: &str = r#"
CREATE TABLE IF NOT EXISTS timeline_caption_clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    source_chunk_index INTEGER,
    text TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_caption_clips_video ON timeline_caption_clips(video_id, start_seconds);
"#;

const MIGRATION_015: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN motion_preset TEXT NOT NULL DEFAULT 'none';
ALTER TABLE timeline_clips ADD COLUMN transition_in TEXT NOT NULL DEFAULT 'cut';
"#;

const MIGRATION_016: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN transition_out TEXT NOT NULL DEFAULT 'cut';
ALTER TABLE timeline_clips ADD COLUMN motion_intensity REAL NOT NULL DEFAULT 0.22;
"#;

const MIGRATION_017: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN clip_kind TEXT NOT NULL DEFAULT 'still';
ALTER TABLE timeline_clips ADD COLUMN video_asset_id TEXT;
CREATE INDEX IF NOT EXISTS idx_timeline_clips_video_asset ON timeline_clips(video_asset_id);
"#;

const MIGRATION_018: &str = r#"
CREATE TABLE IF NOT EXISTS video_assets (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    source_render_id TEXT NOT NULL REFERENCES image_renders(id),
    version INTEGER NOT NULL,
    parent_video_asset_id TEXT REFERENCES video_assets(id),
    kind TEXT NOT NULL DEFAULT 'generation',
    file_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    resolution TEXT NOT NULL,
    requested_duration_seconds REAL NOT NULL,
    veo_duration_seconds INTEGER NOT NULL,
    actual_duration_seconds REAL NOT NULL,
    veo_model TEXT NOT NULL,
    veo_operation_name TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_assets_video_group ON video_assets(video_id, group_id, version DESC);

CREATE TABLE IF NOT EXISTS animation_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    status TEXT NOT NULL CHECK(status IN ('queued','running','paused','stopped','completed','failed')),
    total_items INTEGER NOT NULL,
    completed_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS animation_job_items (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES animation_jobs(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    clip_id TEXT NOT NULL REFERENCES timeline_clips(id),
    source_render_id TEXT NOT NULL REFERENCES image_renders(id),
    resolution TEXT NOT NULL,
    requested_duration_seconds REAL NOT NULL,
    veo_duration_seconds INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','stopped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    veo_operation_name TEXT,
    video_asset_id TEXT REFERENCES video_assets(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_animation_jobs_video ON animation_jobs(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_animation_job_items_job ON animation_job_items(job_id, status, created_at);
"#;

const MIGRATION_019: &str = r#"
ALTER TABLE video_assets ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE animation_job_items ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
"#;

const MIGRATION_020: &str = r#"
ALTER TABLE timelines ADD COLUMN caption_style_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE timeline_caption_clips ADD COLUMN style_json TEXT;
UPDATE videos SET stage = 'timeline' WHERE stage = 'captions';
UPDATE resume_state SET stage = 'timeline' WHERE stage = 'captions';
"#;

const MIGRATION_021: &str = r#"
ALTER TABLE timeline_caption_clips ADD COLUMN words_json TEXT;
"#;

const MIGRATION_022: &str = r#"
ALTER TABLE image_renders ADD COLUMN subject_x REAL;
ALTER TABLE image_renders ADD COLUMN subject_y REAL;
"#;

const MIGRATION_023: &str = r#"
ALTER TABLE timelines ADD COLUMN narration_offset_seconds REAL NOT NULL DEFAULT 0;
"#;

const MIGRATION_024: &str = r#"
CREATE TABLE IF NOT EXISTS media_library_assets (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    kind TEXT NOT NULL CHECK(kind IN ('still','clip','audio')),
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_seconds REAL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_library_assets_video_kind ON media_library_assets(video_id, kind, created_at DESC);
ALTER TABLE timeline_clips ADD COLUMN media_library_asset_id TEXT REFERENCES media_library_assets(id);
CREATE INDEX IF NOT EXISTS idx_timeline_clips_media_asset ON timeline_clips(media_library_asset_id);
"#;

const MIGRATION_025: &str = r#"
ALTER TABLE timelines ADD COLUMN music_master_volume_percent REAL NOT NULL DEFAULT 100;
ALTER TABLE timelines ADD COLUMN music_duck_sensitivity_percent REAL NOT NULL DEFAULT 50;
CREATE TABLE IF NOT EXISTS timeline_music_clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    media_library_asset_id TEXT NOT NULL REFERENCES media_library_assets(id),
    ordinal INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    label TEXT NOT NULL,
    volume_percent REAL NOT NULL DEFAULT 30,
    fade_in_enabled INTEGER NOT NULL DEFAULT 0,
    fade_in_seconds REAL NOT NULL DEFAULT 1.0,
    fade_out_enabled INTEGER NOT NULL DEFAULT 0,
    fade_out_seconds REAL NOT NULL DEFAULT 1.0,
    auto_duck INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timeline_music_clips_video ON timeline_music_clips(video_id, ordinal);
"#;

const MIGRATION_026: &str = r#"
CREATE TABLE IF NOT EXISTS timeline_text_clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    text TEXT NOT NULL,
    font_family TEXT NOT NULL DEFAULT 'Rubik',
    font_size_px REAL NOT NULL DEFAULT 32,
    bold INTEGER NOT NULL DEFAULT 0,
    italic INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#FFFFFF',
    background_mode TEXT NOT NULL DEFAULT 'none' CHECK(background_mode IN ('none','solid','blur')),
    background_color TEXT NOT NULL DEFAULT '#000000',
    position TEXT NOT NULL DEFAULT 'bottom-center',
    animation TEXT NOT NULL DEFAULT 'none' CHECK(animation IN ('none','fade','slide'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_text_clips_video ON timeline_text_clips(video_id, start_seconds);
"#;

const MIGRATION_027: &str = r#"
CREATE TABLE IF NOT EXISTS timeline_logo_clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    media_library_asset_id TEXT NOT NULL REFERENCES media_library_assets(id),
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(position IN ('top-left','top-right','bottom-left','bottom-right','center')),
    size_percent REAL NOT NULL DEFAULT 10,
    opacity_percent REAL NOT NULL DEFAULT 80,
    show_throughout INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_timeline_logo_clips_video ON timeline_logo_clips(video_id, start_seconds);
"#;

const MIGRATION_028: &str = r#"
ALTER TABLE timelines ADD COLUMN sequence_locked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE timelines ADD COLUMN narration_volume_percent REAL NOT NULL DEFAULT 100;
ALTER TABLE timelines ADD COLUMN narration_trim_start_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE timelines ADD COLUMN narration_trim_end_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE timeline_music_clips ADD COLUMN loop_enabled INTEGER NOT NULL DEFAULT 0;
"#;

const MIGRATION_029: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN color_filter_preset TEXT NOT NULL DEFAULT 'none';
ALTER TABLE timeline_clips ADD COLUMN color_filter_intensity REAL NOT NULL DEFAULT 100;
"#;

const MIGRATION_030: &str = r#"
CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    status TEXT NOT NULL DEFAULT 'running',
    destination_path TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_video ON export_jobs(video_id, created_at DESC);
"#;

const MIGRATION_031: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN motion_graphic_effect TEXT;
ALTER TABLE timeline_clips ADD COLUMN motion_graphic_settings_json TEXT;
ALTER TABLE timeline_clips ADD COLUMN motion_graphic_reason TEXT;
"#;

/// `visual_plan_sentences` (unlike `visual_plan_groups`) has never had an
/// original/current duplication — "Reset original" could only restore
/// grouping boundaries, never sentence text/splits/merges, since there was
/// nowhere to restore them FROM. Storing a full JSON snapshot on
/// `visual_plan_meta` (captured once at generation time) rather than
/// duplicating `visual_plan_sentences` rows avoids touching that table's
/// existing id scheme/primary key at all — see `reset_visual_plan`.
const MIGRATION_032: &str = r#"
ALTER TABLE visual_plan_meta ADD COLUMN original_sentences_json TEXT;
"#;

/// Snapshot of the exact inputs (script/audio/pacing) used for the plan
/// currently on `visual_plan_meta`. Without this, "does the existing plan
/// still match the current inputs" could only be judged by comparing
/// against whatever `video_inputs` holds *right now* — which is correct
/// only within a single session (from the moment pacing/script actually
/// changes) and silently resets to "matches" on every fresh hydration,
/// since there was nowhere to persist "what was actually used last time."
/// See `get_video_inputs`'s `plan_matches_current_inputs` computation.
const MIGRATION_033: &str = r#"
ALTER TABLE visual_plan_meta ADD COLUMN generation_script_text TEXT;
ALTER TABLE visual_plan_meta ADD COLUMN generation_audio_id TEXT;
ALTER TABLE visual_plan_meta ADD COLUMN generation_pacing_preset TEXT;
ALTER TABLE visual_plan_meta ADD COLUMN generation_pacing_min_seconds INTEGER;
ALTER TABLE visual_plan_meta ADD COLUMN generation_pacing_max_seconds INTEGER;
"#;

/// Frees `animation_job_items.clip_id` from its original NOT NULL
/// constraint, so the Animate pipeline stage can enqueue animation jobs for
/// stills that aren't on the Editor timeline yet (no clip row exists to
/// reference). SQLite has no `ALTER COLUMN`, so this is the standard
/// rebuild-and-swap: create the new shape, copy every row across by
/// explicit column name (not `SELECT *`, so column reordering across the
/// original CREATE TABLE + later `ADD COLUMN`s can't silently misalign
/// values), drop the old table, rename in.
const MIGRATION_034: &str = r#"
CREATE TABLE animation_job_items_new (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES animation_jobs(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    group_id TEXT NOT NULL,
    clip_id TEXT REFERENCES timeline_clips(id),
    source_render_id TEXT NOT NULL REFERENCES image_renders(id),
    resolution TEXT NOT NULL,
    requested_duration_seconds REAL NOT NULL,
    veo_duration_seconds INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','stopped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    veo_operation_name TEXT,
    video_asset_id TEXT REFERENCES video_assets(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT ''
);
INSERT INTO animation_job_items_new (id,job_id,video_id,group_id,clip_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,status,attempts,last_error,veo_operation_name,video_asset_id,created_at,updated_at,prompt)
SELECT id,job_id,video_id,group_id,clip_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,status,attempts,last_error,veo_operation_name,video_asset_id,created_at,updated_at,prompt FROM animation_job_items;
DROP TABLE animation_job_items;
ALTER TABLE animation_job_items_new RENAME TO animation_job_items;
CREATE INDEX IF NOT EXISTS idx_animation_job_items_job ON animation_job_items(job_id, status, created_at);
"#;

/// Preserves Auto Motion's own composition for a clip (`{effect,
/// settingsJson, reason}`, serialized) separately from the live
/// `motion_graphic_*` columns a manual edit in `MotionSettingsPanel` freely
/// overwrites — without this there was nowhere to restore FROM once a
/// manual tweak overwrote the AI's original recipe (see
/// `reset_timeline_clip_motion_graphic_to_ai`). Only ever written by
/// `analyze_motion_graphics_batch` composing a fresh treatment; a manual
/// edit (`set_timeline_clip_motion_graphic`) never touches it, so it always
/// reflects the last thing Auto Motion actually composed for that clip,
/// even across "Remove effects" clearing the live columns back to null.
const MIGRATION_035: &str = r#"
ALTER TABLE timeline_clips ADD COLUMN motion_graphic_ai_snapshot_json TEXT;
"#;

/// The Scene layer of the Visual Plan tab: a larger narrative/visual unit
/// that can span several `visual_plan_groups` (stills). `is_original`
/// mirrors `visual_plan_groups`' own snapshot pattern (a generated-at-plan-
/// time copy that `reset_visual_plan` restores from, and a live copy that
/// edits apply to). `expanded` defaults to true so every scene reads as
/// expanded immediately after generation (and again after a reset), per the
/// product decision that only later manual collapses should persist. This
/// same flag is shared by the Visual Plan tab and the Images tab's left
/// pane, so a collapse/expand in one is reflected in the other — the Bulk
/// Generation panel's own scene collapse state is intentionally NOT tied to
/// this flag (see SceneBulkRow's local expand state in App.tsx).
const MIGRATION_036: &str = r#"
CREATE TABLE IF NOT EXISTS visual_plan_scenes (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    narrative_role TEXT,
    core_idea TEXT,
    emotional_state TEXT,
    visual_opportunities_json TEXT NOT NULL DEFAULT '[]',
    sentence_ids_json TEXT NOT NULL,
    is_original INTEGER NOT NULL DEFAULT 0,
    expanded INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_plan_scenes_video ON visual_plan_scenes(video_id, is_original, ordinal);
"#;

/// A still's parent scene. Nullable (and left null) for plans generated
/// before this column existed, or for the rare case a still's member
/// sentences don't fall inside any known scene range — the frontend treats
/// a null scene_id as "no strip", not an error.
const MIGRATION_037: &str = r#"
ALTER TABLE visual_plan_groups ADD COLUMN scene_id TEXT;
CREATE INDEX IF NOT EXISTS idx_plan_groups_scene ON visual_plan_groups(scene_id);
"#;

/// Per-scene overrides for Bulk Generation, layered on top of the existing
/// global bulk settings (style directive / creative instructions /
/// character consistency / reference image, today all per-video-only via
/// `app_settings`/`input_assets`). Every override column is nullable —
/// null means "inherit the global value"; a video with no row for a scene
/// has no overrides at all. Keyed by (video_id, scene_id) rather than a
/// composite id like `visual_plan_scenes`/`visual_plan_groups`, since this
/// table's own `id` never needs to be referenced elsewhere.
const MIGRATION_038: &str = r#"
CREATE TABLE IF NOT EXISTS bulk_scene_settings (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    scene_id TEXT NOT NULL,
    style_directive TEXT,
    creative_instruction TEXT,
    character_consistency INTEGER,
    reference_asset_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulk_scene_settings_scene ON bulk_scene_settings(video_id, scene_id);
"#;

/// Adds Location Consistency (mirrors the existing Character Consistency
/// columns exactly — a toggle plus a reference asset id, kept as real
/// columns rather than folded into `dials_json` below specifically so
/// `location_reference_asset_id` participates in the same id-remap system
/// `reference_asset_id` already does on project bundle import) and
/// `dials_json` — a single JSON blob holding the newer Visual Director /
/// Diversity & Consistency dials (visual interpretation, visual metaphor,
/// cinematic intensity, prompt creativity, mood + mood mode, and the
/// per-dimension diversity/consistency sliders). Blobbed rather than given
/// one column each because none of them are cross-row references (unlike
/// the reference-asset ids) and the set is expected to keep growing —
/// see `BulkVisualDials`. `bulk_global_settings` is the video-wide
/// counterpart to `bulk_scene_settings`, structured identically, so the
/// same resolver code can layer one on top of the other.
const MIGRATION_039: &str = r#"
ALTER TABLE bulk_scene_settings ADD COLUMN location_consistency INTEGER;
ALTER TABLE bulk_scene_settings ADD COLUMN location_reference_asset_id TEXT;
ALTER TABLE bulk_scene_settings ADD COLUMN dials_json TEXT;
CREATE TABLE IF NOT EXISTS bulk_global_settings (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    location_consistency INTEGER,
    location_reference_asset_id TEXT,
    dials_json TEXT,
    updated_at TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub video_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub stage: String,
    pub progress: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub video_id: String,
    pub total_stills: i64,
    pub generated_stills: i64,
    pub preview_render_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub channel_id: Option<String>,
    pub video_id: Option<String>,
    pub stage: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputAsset {
    pub id: String,
    pub video_id: String,
    pub kind: String,
    pub original_name: String,
    pub relative_path: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInputs {
    pub video_id: String,
    pub script_text: String,
    pub pacing_seconds: i64,
    pub pacing_preset: String,
    pub pacing_min_seconds: i64,
    pub pacing_max_seconds: i64,
    pub audio: Option<InputAsset>,
    pub references: Vec<InputAsset>,
    pub updated_at: String,
    /// None when no plan has ever been generated for this video, or the
    /// plan predates this field (legacy data, no generation snapshot
    /// recorded) — the frontend treats that as "assume it matches" rather
    /// than nagging to regenerate a plan that's probably fine.
    pub plan_matches_current_inputs: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionWord {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionChunk {
    pub index: i64,
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    #[serde(default)]
    pub words: Vec<CaptionWord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSet {
    pub video_id: String,
    pub interval_seconds: f64,
    pub srt_text: String,
    pub chunks: Vec<CaptionChunk>,
    pub generated_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub id: String,
    pub video_id: String,
    pub group_id: String,
    pub version: i64,
    pub settings_json: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageRender {
    pub id: String,
    pub video_id: String,
    pub group_id: String,
    pub version: i64,
    pub prompt_version_id: String,
    pub file_name: String,
    pub relative_path: String,
    pub parent_render_id: Option<String>,
    pub edit_instruction: Option<String>,
    pub kind: String,
    pub is_final: bool,
    pub edit_strength: Option<String>,
    pub mask_path: Option<String>,
    pub mask_used: bool,
    pub created_at: String,
    pub subject_x: Option<f64>,
    pub subject_y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSetting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleExtraction {
    pub style_directive: String,
    pub image_settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EducationalVisualPlan {
    pub still_id: String,
    pub visual_plan_row_id: String,
    pub educational_objective: String,
    pub visual_intent: String,
    pub subject_strategy: String,
    pub image_settings: serde_json::Value,
    pub user_prompt: String,
    pub plan_signature: String,
    pub visual_strategy_mode: String,
    pub planner_version: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WholeVideoEducationalPlan {
    pub strategy_mode: String,
    pub planner_version: String,
    pub plans: Vec<EducationalVisualPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageWorkspaceGroup {
    pub group: PlanGroup,
    pub educational_plan: Option<EducationalVisualPlan>,
    pub prompt_versions: Vec<PromptVersion>,
    pub image_renders: Vec<ImageRender>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageWorkspace {
    pub video_id: String,
    pub sentences: Vec<PlanSentence>,
    pub groups: Vec<ImageWorkspaceGroup>,
    pub settings: Vec<AppSetting>,
    /// The same scenes `get_visual_plan` already returns — carried along so
    /// the Images tab's left pane and Bulk Generation panel can section
    /// `groups` by scene (via `sectionGroupsByScene`) without a second
    /// round trip to `get_visual_plan`.
    pub scenes: Vec<PlanScene>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageJobItem {
    pub id: String,
    pub group_id: String,
    pub prompt_version_id: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub render_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageJob {
    pub id: String,
    pub video_id: String,
    pub status: String,
    pub total_items: i64,
    pub completed_items: i64,
    pub failed_items: i64,
    pub created_at: String,
    pub updated_at: String,
    pub items: Vec<ImageJobItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBundleManifest {
    format: String,
    version: i64,
    exported_at: String,
    channel_name: String,
    video_title: String,
    stage: String,
    progress: i64,
    /// Kept for version-1 bundles (exported before full-fidelity mode) and
    /// still filled on every export for backward display purposes — the
    /// authoritative copy for version-2+ bundles lives in
    /// `tables["video_inputs"]`.
    script_text: String,
    pacing_seconds: i64,
    files: Vec<String>,
    /// Version 2+ only: the source project's own ids, used to seed the
    /// id-remap table on import so every row's ids can be rewritten to fresh
    /// ones without colliding with anything already in the importer's
    /// database (see `restore_project_tables`).
    #[serde(default)]
    video_id: String,
    #[serde(default)]
    channel_id: String,
    /// Version 2+ only: a full row-for-row dump of every table that makes up
    /// this video's state (visual plan, renders, animations, timeline,
    /// media library, captions, music/text/logo overlays — everything short
    /// of ephemeral job-queue/undo history), keyed by table name. This is
    /// what makes the bundle a complete, self-contained copy of the project
    /// rather than just its raw files.
    #[serde(default)]
    tables: std::collections::BTreeMap<String, Vec<serde_json::Map<String, serde_json::Value>>>,
}

/// Every table that makes up a video's project state, in an order that's
/// safe to INSERT in under `PRAGMA foreign_keys = ON` (each table only
/// references tables earlier in this list, or itself via a nullable
/// self-reference that's always satisfied because rows are restored in
/// original creation order). `import_project_bundle`'s rollback path
/// deletes in the reverse of this order.
///
/// Deliberately excluded: `image_jobs`/`image_job_items`,
/// `animation_jobs`/`animation_job_items`, `export_jobs` (operational job
/// history — doesn't affect what the project looks like), and
/// `video_snapshots` (undo history — starts fresh for the importer, same as
/// any other newly opened project).
const PROJECT_TABLES: &[&str] = &[
    "video_inputs",
    "input_assets",
    "visual_plan_sentences",
    "visual_plan_scenes",
    "visual_plan_groups",
    "visual_plan_meta",
    "bulk_scene_settings",
    "bulk_global_settings",
    "prompt_versions",
    "image_renders",
    "media_library_assets",
    "video_assets",
    "educational_visual_plans",
    "captions",
    "timeline_caption_clips",
    "timelines",
    "timeline_clips",
    "timeline_music_clips",
    "timeline_text_clips",
    "timeline_logo_clips",
];

/// Columns whose value is a single, whole id — looked up directly (O(1)) in
/// the id-remap table. Covers both a row's own primary key (`id`,
/// `still_id`, `video_id`) and every foreign-key-shaped reference to another
/// row in the bundle. Harmless to list a column that doesn't exist on a
/// given table — `remap_row`/`seed_id_map` only ever look one up if it's
/// actually present on that row.
const ATOMIC_ID_COLUMNS: &[&str] = &[
    "id", "video_id", "group_id", "render_id", "prompt_version_id", "parent_render_id",
    "source_render_id", "video_asset_id", "parent_video_asset_id", "media_library_asset_id",
    "still_id", "visual_plan_row_id", "audio_asset_id", "generation_audio_id", "clip_id",
    "scene_id", "reference_asset_id", "location_reference_asset_id",
];

/// `visual_plan_sentences.id` and `visual_plan_groups.id` are the only
/// primary keys in the schema that aren't a flat id — `save_plan`/
/// `write_renumbered_plan` store them namespaced as `{video_id}::{id}`
/// (groups: `{video_id}::{current|original}::{id}`) so an id can't collide
/// across videos even outside this bundle format. Every other column that
/// references a sentence/group (`sentence_ids_json`, `group_id` on
/// `prompt_versions`/`image_renders`/`timeline_clips`) uses the bare
/// suffix — the same one `get_visual_plan`/`load_groups` strip back out for
/// the rest of the app. Bundle restore has to know about this to remap the
/// suffix consistently everywhere it appears, not just inside these two
/// tables' own `id` column.
const COMPOSITE_ID_TABLES: &[&str] = &["visual_plan_sentences", "visual_plan_groups", "visual_plan_scenes"];

fn composite_id_suffix(value: &str) -> &str {
    value.rsplit_once("::").map(|(_, suffix)| suffix).unwrap_or(value)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub file_count: usize,
}

/// User-facing export choices for the single-file video export — everything
/// here used to be implicit/hardcoded (1080p, CRF 18, captions always
/// burned-in, narration mandatory, music never mixed in).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    /// "2160p" | "1080p" | "720p"
    pub resolution: String,
    /// "high" | "balanced" | "compressed"
    pub quality: String,
    /// "burned-in" | "srt" | "both"
    pub captions_mode: String,
    pub include_narration: bool,
    pub include_music: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            resolution: "1080p".into(),
            quality: "high".into(),
            captions_mode: "burned-in".into(),
            include_narration: true,
            include_music: true,
        }
    }
}

/// One row per export attempt (success or failure) — the titlebar's "Export
/// history" list reads these back via `list_export_jobs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub id: String,
    pub video_id: String,
    /// "running" | "completed" | "failed"
    pub status: String,
    pub destination_path: String,
    pub error: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

pub const EXPORT_RESOLUTIONS: [&str; 3] = ["2160p", "1080p", "720p"];
pub const EXPORT_QUALITIES: [&str; 3] = ["high", "balanced", "compressed"];
pub const EXPORT_CAPTIONS_MODES: [&str; 3] = ["burned-in", "srt", "both"];

fn resolution_dimensions(resolution: &str, aspect_ratio: &str) -> (i64, i64) {
    let (w, h) = match resolution {
        "2160p" => (3840, 2160),
        "720p" => (1280, 720),
        _ => (1920, 1080),
    };
    if aspect_ratio == "9:16" { (h, w) } else { (w, h) }
}

/// (crf, preset) for the final muxing pass only — the intermediate
/// per-segment encodes stay near-lossless regardless of quality choice (see
/// encode_segment's own comment on why: avoiding double-generation loss).
fn quality_crf_preset(quality: &str) -> (i64, &'static str) {
    match quality {
        "balanced" => (23, "fast"),
        "compressed" => (28, "faster"),
        _ => (18, "fast"),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    pub group_id: String,
    pub render_id: Option<String>,
    pub ordinal: i64,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub label: String,
    pub motion_preset: String,
    pub transition_in: String,
    pub transition_out: String,
    pub motion_intensity: f64,
    pub clip_kind: String,
    pub video_asset_id: Option<String>,
    /// Set for `clip_kind` 'imported-still'/'imported-clip' — points at the
    /// media library asset backing this clip instead of a render/video_asset.
    pub media_library_asset_id: Option<String>,
    pub color_filter_preset: String,
    pub color_filter_intensity: f64,
    /// AI-composed free-text treatment label, or `None` if this clip hasn't
    /// been analyzed yet — display/debugging metadata only, not validated
    /// against any list (see `set_timeline_clip_motion_graphic`'s doc comment).
    pub motion_graphic_effect: Option<String>,
    /// JSON-serialized `MotionRecipe` (see services/motion-engine/src/types.ts)
    /// — the actual freely-composed treatment `motion_graphic_effect` labels.
    pub motion_graphic_settings_json: Option<String>,
    /// Short AI-written justification for the assigned effect.
    pub motion_graphic_reason: Option<String>,
    /// Serialized `{effect, settingsJson, reason}` snapshot of the last
    /// treatment Auto Motion actually composed for this clip — untouched by
    /// manual edits, so `reset_timeline_clip_motion_graphic_to_ai` always has
    /// something to restore. `None` for a clip Auto Motion has never
    /// analyzed (including one built from scratch via "start from scratch").
    pub motion_graphic_ai_snapshot_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoAsset {
    pub id: String,
    pub video_id: String,
    pub group_id: String,
    pub source_render_id: String,
    pub version: i64,
    pub parent_video_asset_id: Option<String>,
    pub kind: String,
    pub file_name: String,
    pub relative_path: String,
    pub resolution: String,
    pub requested_duration_seconds: f64,
    pub veo_duration_seconds: i64,
    pub actual_duration_seconds: f64,
    pub veo_model: String,
    pub veo_operation_name: Option<String>,
    pub prompt: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimationJobItem {
    pub id: String,
    pub video_id: String,
    /// `None` for items created by the Animate pipeline stage (no timeline
    /// clip exists yet) — `Some` for the Editor's per-clip "Animate this
    /// clip" flow, which retimes/duration-fits against a real clip.
    pub clip_id: Option<String>,
    pub group_id: String,
    pub source_render_id: String,
    pub resolution: String,
    pub requested_duration_seconds: f64,
    pub veo_duration_seconds: i64,
    pub prompt: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub video_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimationJob {
    pub id: String,
    pub video_id: String,
    pub status: String,
    pub total_items: i64,
    pub completed_items: i64,
    pub failed_items: i64,
    pub created_at: String,
    pub updated_at: String,
    pub items: Vec<AnimationJobItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineCaptionClip {
    pub id: String,
    pub source_chunk_index: Option<i64>,
    pub text: String,
    pub ordinal: i64,
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// Partial style override, shallow-merged onto the timeline's caption_style.
    /// `None` means this clip fully inherits the timeline default.
    pub style: Option<serde_json::Value>,
    /// Whisper's real per-word timestamps, carried over from the source
    /// caption chunk — enables word-by-word highlight styling. `None` once
    /// the clip's text has been hand-edited (the old timings no longer
    /// correspond to the new words) or for a fully user-authored clip.
    pub words: Option<Vec<CaptionWord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibraryAsset {
    pub id: String,
    pub video_id: String,
    /// 'still' | 'clip' | 'audio'
    pub kind: String,
    pub original_name: String,
    pub relative_path: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub duration_seconds: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMusicClip {
    pub id: String,
    pub media_library_asset_id: String,
    pub ordinal: i64,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub label: String,
    pub volume_percent: f64,
    pub fade_in_enabled: bool,
    pub fade_in_seconds: f64,
    pub fade_out_enabled: bool,
    pub fade_out_seconds: f64,
    pub auto_duck: bool,
    pub loop_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTextClip {
    pub id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
    pub font_family: String,
    pub font_size_px: f64,
    pub bold: bool,
    pub italic: bool,
    pub color: String,
    /// 'none' | 'solid' | 'blur'
    pub background_mode: String,
    pub background_color: String,
    /// One of the 9-point grid values, e.g. "bottom-center".
    pub position: String,
    /// 'none' | 'fade' | 'slide'
    pub animation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLogoClip {
    pub id: String,
    pub media_library_asset_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
    pub position: String,
    pub size_percent: f64,
    pub opacity_percent: f64,
    /// When true, start/end are kept in sync with the full timeline duration.
    pub show_throughout: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub video_id: String,
    pub duration_seconds: f64,
    pub playhead_seconds: f64,
    pub zoom: f64,
    pub updated_at: String,
    pub clips: Vec<TimelineClip>,
    pub caption_clips: Vec<TimelineCaptionClip>,
    /// Global default caption style for this video's timeline; `{}` = built-in defaults.
    pub caption_style: serde_json::Value,
    /// Seconds of delay before narration audio starts, relative to the visual
    /// timeline (0 = plays from the very start, matching legacy behavior).
    pub narration_offset_seconds: f64,
    pub music_clips: Vec<TimelineMusicClip>,
    pub text_clips: Vec<TimelineTextClip>,
    pub logo_clips: Vec<TimelineLogoClip>,
    pub music_master_volume_percent: f64,
    pub music_duck_sensitivity_percent: f64,
    /// When true (the default), Stills-track clips can't be reordered by
    /// dragging — only resized/effects-edited — keeping them locked to the
    /// narration sync they were generated from.
    pub sequence_locked: bool,
    pub narration_volume_percent: f64,
    pub narration_trim_start_seconds: f64,
    pub narration_trim_end_seconds: f64,
}

/// The built-in caption look, chosen to exactly match what was previously
/// hardcoded in the export engine, so an empty style ({}) is a visual no-op.
pub fn default_caption_style() -> serde_json::Value {
    json!({
        "fontFamily": "Rubik",
        "fontSizePx": 22,
        "bold": true,
        "color": "#FFFFFF",
        "opacity": 100,
        "outlineColor": "#000000",
        "outlineWidthPx": 2,
        "shadow": { "enabled": false, "color": "#000000", "opacity": 70, "blur": 30, "distance": 2, "angle": 90 },
        "position": "bottom",
        "wordHighlight": { "enabled": false, "color": "#FFEB3B" },
    })
}

/// Shallow-merges `overlay`'s present top-level keys onto `base`. Used to
/// layer a video's global caption default and then a clip's own partial
/// override on top of it.
pub fn merge_style(base: &serde_json::Value, overlay: &serde_json::Value) -> serde_json::Value {
    let mut merged = base.clone();
    if let (Some(merged_obj), Some(overlay_obj)) = (merged.as_object_mut(), overlay.as_object()) {
        for (key, value) in overlay_obj {
            merged_obj.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Serializes a clip's per-word timestamps for storage, or `None` if there's
/// nothing precise to save (an empty list is treated the same as "no timing").
fn words_to_json(words: &[CaptionWord]) -> Option<String> {
    if words.is_empty() {
        return None;
    }
    serde_json::to_string(words).ok()
}

/// When a caption clip has no real per-word timestamps — never transcribed
/// with word-level timing, or lost them after a text edit (see
/// `update_caption_clip_text`, which intentionally drops stale ones) — word
/// highlight still needs *something* to animate through. Splits the clip's
/// `[start, end]` window across its words, weighted by each word's
/// character count (a longer word roughly takes longer to say than "a" or
/// "the") rather than splitting evenly, so the highlight still tracks the
/// rhythm of the line reasonably well instead of just not lighting up at
/// all. Computed on every read, never persisted — real per-word timing
/// (from Whisper, or a fresh caption generation) should always take
/// priority, and estimates sitting in the DB looking like real data would
/// get in its way.
fn estimate_word_windows(text: &str, start_seconds: f64, end_seconds: f64) -> Option<Vec<CaptionWord>> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() || end_seconds <= start_seconds {
        return None;
    }
    let duration = end_seconds - start_seconds;
    let weights: Vec<f64> = words.iter().map(|word| word.chars().count().max(1) as f64).collect();
    let total_weight: f64 = weights.iter().sum();
    let mut cursor = start_seconds;
    let mut result = Vec::with_capacity(words.len());
    for (word, weight) in words.into_iter().zip(weights) {
        let word_end = (cursor + duration * weight / total_weight).min(end_seconds);
        result.push(CaptionWord {
            text: word.to_string(),
            start_seconds: cursor,
            end_seconds: word_end,
        });
        cursor = word_end;
    }
    Some(result)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanSentence {
    pub id: String,
    pub ordinal: i64,
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanGroup {
    pub id: String,
    pub ordinal: i64,
    pub label: String,
    pub kind: String,
    pub sentence_ids: Vec<String>,
    pub settings_locked: bool,
    pub prompt_locked: bool,
    /// The scene this still belongs to, assigned by containment against
    /// `VisualPlan.scenes` at generation time and kept up to date by
    /// `assign_scene_ids` on every subsequent move/split/merge/create. Null
    /// for plans generated before scenes existed, or if no scene's sentence
    /// range happens to contain this still's first sentence.
    pub scene_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanScene {
    pub id: String,
    pub ordinal: i64,
    pub label: String,
    pub narrative_role: Option<String>,
    pub core_idea: Option<String>,
    pub emotional_state: Option<String>,
    pub visual_opportunities: Vec<String>,
    pub sentence_ids: Vec<String>,
    pub expanded: bool,
}

/// The Visual Director / Diversity & Consistency Controller dials, layered
/// the same way every other Bulk Generation setting is: `None` means
/// "inherit," a concrete value means "this level overrides it." Every
/// slider is 0-100 unless noted. Deliberately grouped into one JSON blob
/// (see `MIGRATION_039`) rather than one column each — none of these are
/// cross-row references, and resolving them is always all-or-nothing per
/// level (global, then scene), so a blob keeps `resolve_effective_bulk_settings`
/// simple: read the scene's blob, fall back field-by-field to the global
/// blob, done.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkVisualDials {
    /// Literal (0) <-> Creative (100): how directly the AI should translate
    /// the sentence into an image vs. reach for a more conceptual take.
    pub visual_interpretation: Option<i64>,
    /// Literal (0) <-> Symbolic (100): how often/aggressively the AI should
    /// reach for a visual metaphor instead of a direct depiction.
    pub visual_metaphor: Option<i64>,
    /// Documentary (0) <-> Cinematic (100): overall photographic/production
    /// intensity of the imagery.
    pub cinematic_intensity: Option<i64>,
    /// Strict script interpretation (0) <-> Highly creative (100): how much
    /// the prompt-writing step itself is allowed to elaborate beyond the
    /// literal narration when describing the scene.
    pub prompt_creativity: Option<i64>,
    /// A specific mood word to bias toward, or `None` to let the AI decide
    /// per still (only meaningful when `mood_mode` is `"user"`).
    pub mood: Option<String>,
    /// `"ai"` (default) or `"user"` — whether `mood` above is a hint the AI
    /// can override per still, or a fixed target it should stay close to.
    pub mood_mode: Option<String>,
    /// Consistent (0) <-> Dynamic (100): how aggressively camera angle
    /// should vary between stills, independent of the other diversity dials.
    pub diversity_camera: Option<i64>,
    /// Same idea, for composition (framing, subject placement, layout).
    pub diversity_composition: Option<i64>,
    /// Same idea, for shot type / visualType (wide, close-up, diagram...).
    pub diversity_shot_type: Option<i64>,
    /// Flexible (0) <-> Consistent (100): how strictly a recurring
    /// character's identity must be held to versus loosely reinterpreted.
    pub consistency_character: Option<i64>,
    /// Same idea, for a recurring location.
    pub consistency_location: Option<i64>,
    /// Same idea, for how strictly the style directive should be followed
    /// versus treated as loose inspiration.
    pub consistency_style: Option<i64>,
}

impl BulkVisualDials {
    /// True if every field is `None` — used to decide whether a scene's
    /// dials blob is worth writing at all vs. just leaving the column null.
    fn is_empty(&self) -> bool {
        self == &BulkVisualDials::default()
    }
}

/// Per-scene overrides for Bulk Generation, layered on top of the video's
/// global bulk settings. Every field is nullable — `None` means "inherit
/// the global value" for that one field; a scene with no row at all (see
/// `get_bulk_scene_settings`, which only returns rows that exist) has no
/// overrides. The caller (the Bulk Generation panel) always holds the full
/// current override state in memory and re-sends every field on every save,
/// so there's no separate "leave untouched" wire state to model here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkSceneSettings {
    pub scene_id: String,
    pub style_directive: Option<String>,
    pub creative_instruction: Option<String>,
    pub character_consistency: Option<bool>,
    pub reference_asset_id: Option<String>,
    pub location_consistency: Option<bool>,
    pub location_reference_asset_id: Option<String>,
    #[serde(default)]
    pub dials: BulkVisualDials,
}

/// The video-wide counterpart to `BulkSceneSettings` — structured
/// identically (minus `scene_id`) so the exact same dials/consistency
/// concepts resolve the same way at both levels; a scene layers its own
/// version of this same shape on top.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkGlobalVisualSettings {
    pub location_consistency: Option<bool>,
    pub location_reference_asset_id: Option<String>,
    #[serde(default)]
    pub dials: BulkVisualDials,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPlannedStill {
    pub visual_plan_row_id: String,
    pub ordinal: i64,
    pub narration_preview: String,
    pub timestamp_start: f64,
    pub timestamp_end: f64,
    pub visual_type: String,
    pub image_settings: serde_json::Value,
    pub user_prompt: String,
    pub reason: String,
    pub settings_locked: bool,
    pub prompt_locked: bool,
}

/// Result of planning (and immediately persisting) ONE batch of stills —
/// see `plan_bulk_visuals_batch`. The frontend drives the full run by
/// calling that command repeatedly, advancing its own index by
/// `plannedCount` each time, the same way it already drives per-still
/// "Auto Educational" prompt preparation — this is what makes the whole
/// run pausable/resumable and each batch durable the moment it lands,
/// rather than living only in memory until a separate "approve" step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPlanBatchResult {
    pub planned_count: usize,
    pub total_stills: usize,
    pub last_ordinal: i64,
    pub done: bool,
}

/// Result of one `analyze_motion_graphics_batch` call — see that function's
/// doc comment for why Auto Motion moved to this same per-batch, resumable
/// shape as `plan_bulk_visuals_batch`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionGraphicsBatchResult {
    pub completed: usize,
    pub total: usize,
    pub done: bool,
}

/// Clips per Auto Motion subprocess call — matches
/// motion_graphics_engine.py's own `DEFAULT_BATCH_SIZE`, since each Rust
/// call now maps to exactly one of the engine's own composition batches
/// (see `analyze_motion_graphics_batch`).
const MOTION_GRAPHICS_BATCH_SIZE: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualPlan {
    pub video_id: String,
    pub timing_source: String,
    pub sentences: Vec<PlanSentence>,
    pub groups: Vec<PlanGroup>,
    pub scenes: Vec<PlanScene>,
    pub updated_at: String,
}

pub struct ProjectRepository {
    connection: Connection,
    database_path: PathBuf,
    projects_dir: PathBuf,
}

impl ProjectRepository {
    pub fn open_with_recovery(
        database_path: &Path,
        projects_dir: &Path,
    ) -> Result<(Self, Option<PathBuf>), String> {
        match Self::open(database_path, projects_dir) {
            Ok(repository) => {
                repository.verify_integrity()?;
                Ok((repository, None))
            }
            Err(first_error) => {
                if !database_path.exists() {
                    return Err(first_error);
                }
                let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
                let backup = database_path
                    .with_file_name(format!("auto-gen-studio-recovery-{timestamp}.db"));
                fs::copy(database_path, &backup).map_err(|error| {
                    format!("Database failed to open ({first_error}) and backup failed: {error}")
                })?;
                for suffix in ["-wal", "-shm"] {
                    let sidecar = PathBuf::from(format!("{}{}", database_path.display(), suffix));
                    if sidecar.exists() {
                        let _ = fs::copy(
                            &sidecar,
                            PathBuf::from(format!("{}{}", backup.display(), suffix)),
                        );
                        let _ = fs::remove_file(sidecar);
                    }
                }
                fs::remove_file(database_path).map_err(|error| {
                    format!(
                        "Database backup was created at {} but recovery failed: {error}",
                        backup.display()
                    )
                })?;
                let repository = Self::open(database_path, projects_dir).map_err(|error| {
                    format!(
                        "Recovery backup: {}. Clean database initialization failed: {error}",
                        backup.display()
                    )
                })?;
                Ok((repository, Some(backup)))
            }
        }
    }

    pub fn open(database_path: &Path, projects_dir: &Path) -> Result<Self, String> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(projects_dir).map_err(|error| error.to_string())?;
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;")
            .map_err(|error| error.to_string())?;
        let repository = Self {
            connection,
            database_path: database_path.to_path_buf(),
            projects_dir: projects_dir.to_path_buf(),
        };
        repository.migrate()?;
        Ok(repository)
    }

    fn verify_integrity(&self) -> Result<(), String> {
        let status: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|error| format!("Database integrity check failed: {error}"))?;
        if status == "ok" {
            Ok(())
        } else {
            Err(format!("Database integrity check reported: {status}"))
        }
    }

    fn migrate(&self) -> Result<(), String> {
        self.connection
            .execute_batch(MIGRATION_001)
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute_batch(MIGRATION_002)
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute_batch(MIGRATION_003)
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute_batch(MIGRATION_004)
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute_batch(MIGRATION_005)
            .map_err(|error| error.to_string())?;
        let has_render_kind: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('image_renders') WHERE name='kind')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_render_kind {
            self.connection
                .execute_batch(MIGRATION_006)
                .map_err(|error| error.to_string())?;
        }
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute_batch(MIGRATION_007)
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(7, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        let has_pacing_preset: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('video_inputs') WHERE name='pacing_preset')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !has_pacing_preset {
            self.connection
                .execute_batch(MIGRATION_008)
                .map_err(|error| error.to_string())?;
        }
        self.connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(8, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        let has_is_final: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('image_renders') WHERE name='is_final')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !has_is_final {
            self.connection.execute_batch(MIGRATION_009).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(9, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_010).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(10, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_strategy_mode: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('educational_visual_plans') WHERE name='visual_strategy_mode')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !has_strategy_mode {
            self.connection.execute_batch(MIGRATION_011).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(11, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_still_locks: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('visual_plan_groups') WHERE name='settings_locked')",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !has_still_locks {
            self.connection.execute_batch(MIGRATION_012).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(12, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_013).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(13, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_014).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(14, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_motion_preset: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='motion_preset')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_motion_preset {
            self.connection.execute_batch(MIGRATION_015).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(15, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_transition_out: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='transition_out')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_transition_out {
            self.connection.execute_batch(MIGRATION_016).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(16, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_clip_kind: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='clip_kind')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_clip_kind {
            self.connection.execute_batch(MIGRATION_017).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(17, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_018).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(18, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_asset_prompt: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('video_assets') WHERE name='prompt')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_asset_prompt {
            self.connection.execute_batch(MIGRATION_019).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(19, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_caption_style: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timelines') WHERE name='caption_style_json')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_caption_style {
            self.connection.execute_batch(MIGRATION_020).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(20, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_words_json: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_caption_clips') WHERE name='words_json')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_words_json {
            self.connection.execute_batch(MIGRATION_021).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(21, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_subject_x: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('image_renders') WHERE name='subject_x')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_subject_x {
            self.connection.execute_batch(MIGRATION_022).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(22, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_narration_offset: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timelines') WHERE name='narration_offset_seconds')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_narration_offset {
            self.connection.execute_batch(MIGRATION_023).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(23, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_media_library_asset_id: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='media_library_asset_id')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_media_library_asset_id {
            self.connection.execute_batch(MIGRATION_024).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(24, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_music_master_volume: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timelines') WHERE name='music_master_volume_percent')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_music_master_volume {
            self.connection.execute_batch(MIGRATION_025).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(25, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_026).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(26, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_027).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(27, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_sequence_locked: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timelines') WHERE name='sequence_locked')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_sequence_locked {
            self.connection.execute_batch(MIGRATION_028).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(28, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_color_filter_preset: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='color_filter_preset')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_color_filter_preset {
            self.connection.execute_batch(MIGRATION_029).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(29, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_030).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(30, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_motion_graphic_effect: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='motion_graphic_effect')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_motion_graphic_effect {
            self.connection.execute_batch(MIGRATION_031).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(31, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_original_sentences_json: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('visual_plan_meta') WHERE name='original_sentences_json')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_original_sentences_json {
            self.connection.execute_batch(MIGRATION_032).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(32, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_generation_script_text: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('visual_plan_meta') WHERE name='generation_script_text')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_generation_script_text {
            self.connection.execute_batch(MIGRATION_033).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(33, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let clip_id_not_null: i64 = self
            .connection
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('animation_job_items') WHERE name='clip_id'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if clip_id_not_null != 0 {
            self.connection.execute_batch(MIGRATION_034).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(34, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_motion_graphic_ai_snapshot: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('timeline_clips') WHERE name='motion_graphic_ai_snapshot_json')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_motion_graphic_ai_snapshot {
            self.connection.execute_batch(MIGRATION_035).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(35, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_036).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(36, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_group_scene_id: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('visual_plan_groups') WHERE name='scene_id')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_group_scene_id {
            self.connection.execute_batch(MIGRATION_037).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(37, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        self.connection.execute_batch(MIGRATION_038).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(38, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        let has_location_consistency: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('bulk_scene_settings') WHERE name='location_consistency')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_location_consistency {
            self.connection.execute_batch(MIGRATION_039).map_err(|error| error.to_string())?;
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(39, ?1)",
            [Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn paths(&self) -> (PathBuf, PathBuf) {
        (self.database_path.clone(), self.projects_dir.clone())
    }

    pub fn list_channels(&self, include_trashed: bool) -> Result<Vec<Channel>, String> {
        let filter = if include_trashed {
            "c.trashed_at IS NOT NULL"
        } else {
            "c.trashed_at IS NULL"
        };
        let sql = format!(
            "SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
             COUNT(v.id) FROM channels c
             LEFT JOIN videos v ON v.channel_id = c.id AND v.trashed_at IS NULL
             WHERE {filter} GROUP BY c.id ORDER BY c.updated_at DESC"
        );
        let mut statement = self.connection.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    video_count: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn create_channel(&self, name: &str, description: Option<&str>) -> Result<Channel, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Channel name is required.".into());
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT INTO channels(id, name, description, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?4)",
                params![id, name, description, now],
            )
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(self.projects_dir.join(&id)).map_err(|e| e.to_string())?;
        Ok(Channel {
            id,
            name: name.to_string(),
            description: description.map(str::to_string),
            video_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_videos(
        &self,
        channel_id: &str,
        include_trashed: bool,
    ) -> Result<Vec<Video>, String> {
        let comparison = if include_trashed {
            "IS NOT NULL"
        } else {
            "IS NULL"
        };
        let sql = format!(
            "SELECT id, channel_id, title, stage, progress, created_at, updated_at
             FROM videos WHERE channel_id = ?1 AND trashed_at {comparison}
             ORDER BY updated_at DESC"
        );
        let mut statement = self.connection.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([channel_id], map_video)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_video_progress(&self, video_id: &str) -> Result<VideoProgress, String> {
        let total_stills: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM visual_plan_groups WHERE video_id=?1 AND is_original=0",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let generated_stills: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(DISTINCT group_id) FROM image_renders WHERE video_id=?1",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let preview_render_id: Option<String> = self
            .connection
            .query_row(
                "SELECT ir.id FROM image_renders ir
                 JOIN visual_plan_groups g ON g.id = ir.group_id AND g.video_id = ir.video_id
                 WHERE ir.video_id = ?1 AND g.is_original = 0
                 ORDER BY g.ordinal ASC, ir.version DESC
                 LIMIT 1",
                [video_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(VideoProgress {
            video_id: video_id.into(),
            total_stills,
            generated_stills,
            preview_render_id,
        })
    }

    pub fn create_video(&self, channel_id: &str, title: &str) -> Result<Video, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("Video title is required.".into());
        }
        let channel_exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM channels WHERE id = ?1 AND trashed_at IS NULL)",
                [channel_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !channel_exists {
            return Err("Channel was not found.".into());
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT INTO videos(id, channel_id, title, stage, progress, created_at, updated_at)
                 VALUES(?1, ?2, ?3, 'inputs', 0, ?4, ?4)",
                params![id, channel_id, title, now],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE channels SET updated_at = ?1 WHERE id = ?2",
                params![now, channel_id],
            )
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(self.projects_dir.join(channel_id).join(&id))
            .map_err(|e| e.to_string())?;
        Ok(Video {
            id,
            channel_id: channel_id.to_string(),
            title: title.to_string(),
            stage: "inputs".into(),
            progress: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn set_resume(
        &self,
        channel_id: &str,
        video_id: &str,
        stage: &str,
    ) -> Result<ResumeState, String> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT INTO resume_state(singleton, channel_id, video_id, stage, updated_at)
                 VALUES(1, ?1, ?2, ?3, ?4)
                 ON CONFLICT(singleton) DO UPDATE SET channel_id=excluded.channel_id,
                 video_id=excluded.video_id, stage=excluded.stage, updated_at=excluded.updated_at",
                params![channel_id, video_id, stage, now],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE videos SET stage = ?1, updated_at = ?2 WHERE id = ?3",
                params![stage, now, video_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(ResumeState {
            channel_id: Some(channel_id.to_string()),
            video_id: Some(video_id.to_string()),
            stage: stage.to_string(),
            updated_at: now,
        })
    }

    pub fn get_resume(&self) -> Result<Option<ResumeState>, String> {
        self.connection
            .query_row(
                "SELECT r.channel_id, r.video_id, r.stage, r.updated_at FROM resume_state r
                 JOIN channels c ON c.id = r.channel_id AND c.trashed_at IS NULL
                 JOIN videos v ON v.id = r.video_id AND v.trashed_at IS NULL WHERE r.singleton = 1",
                [],
                |row| {
                    Ok(ResumeState {
                        channel_id: row.get(0)?,
                        video_id: row.get(1)?,
                        stage: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn trash_channel(&self, id: &str) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE channels SET trashed_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn restore_channel(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE channels SET trashed_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn trash_video(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE videos SET trashed_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn restore_video(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE videos SET trashed_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rename_channel(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Channel name is required.".into());
        }
        self.connection
            .execute(
                "UPDATE channels SET name = ?1, updated_at = ?2 WHERE id = ?3 AND trashed_at IS NULL",
                params![name, Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rename_video(&self, id: &str, title: &str) -> Result<(), String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("Video title is required.".into());
        }
        self.connection
            .execute(
                "UPDATE videos SET title = ?1, updated_at = ?2 WHERE id = ?3 AND trashed_at IS NULL",
                params![title, Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn permanent_delete_video(&self, id: &str) -> Result<(), String> {
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        let stmts = [
            "DELETE FROM timeline_clips WHERE timeline_id IN (SELECT id FROM timelines WHERE video_id = ?1)",
            "DELETE FROM timelines WHERE video_id = ?1",
            "DELETE FROM image_job_items WHERE job_id IN (SELECT id FROM image_jobs WHERE video_id = ?1)",
            "DELETE FROM image_jobs WHERE video_id = ?1",
            "DELETE FROM image_renders WHERE video_id = ?1",
            "DELETE FROM educational_visual_plans WHERE video_id = ?1",
            "DELETE FROM prompt_versions WHERE video_id = ?1",
            "DELETE FROM visual_plan_sentences WHERE video_id = ?1",
            "DELETE FROM visual_plan_groups WHERE video_id = ?1",
            "DELETE FROM visual_plan_meta WHERE video_id = ?1",
            "DELETE FROM captions WHERE video_id = ?1",
            "DELETE FROM input_assets WHERE video_id = ?1",
            "DELETE FROM video_inputs WHERE video_id = ?1",
            "DELETE FROM video_snapshots WHERE video_id = ?1",
            "DELETE FROM videos WHERE id = ?1",
        ];
        for stmt in &stmts {
            self.connection.execute(stmt, params![id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn permanent_delete_channel(&self, id: &str) -> Result<(), String> {
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        let stmts = [
            "DELETE FROM timeline_clips WHERE timeline_id IN (SELECT t.id FROM timelines t JOIN videos v ON v.id = t.video_id WHERE v.channel_id = ?1)",
            "DELETE FROM timelines WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM image_job_items WHERE job_id IN (SELECT j.id FROM image_jobs j JOIN videos v ON v.id = j.video_id WHERE v.channel_id = ?1)",
            "DELETE FROM image_jobs WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM image_renders WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM educational_visual_plans WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM prompt_versions WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM visual_plan_sentences WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM visual_plan_groups WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM visual_plan_meta WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM captions WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM input_assets WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM video_inputs WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM video_snapshots WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?1)",
            "DELETE FROM videos WHERE channel_id = ?1",
            "DELETE FROM channels WHERE id = ?1",
        ];
        for stmt in &stmts {
            self.connection.execute(stmt, params![id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(self.projects_dir.join(id));
        Ok(())
    }

    pub fn create_snapshot(&self, video_id: &str, payload_json: &str) -> Result<String, String> {
        serde_json::from_str::<serde_json::Value>(payload_json)
            .map_err(|_| "Snapshot payload must be valid JSON.".to_string())?;
        let id = Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO video_snapshots(id, video_id, kind, payload_json, created_at)
                 VALUES(?1, ?2, 'automatic', ?3, ?4)",
                params![id, video_id, payload_json, Utc::now().to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "DELETE FROM video_snapshots WHERE video_id = ?1 AND kind = 'automatic'
                 AND id NOT IN (SELECT id FROM video_snapshots WHERE video_id = ?1
                 AND kind = 'automatic' ORDER BY created_at DESC, rowid DESC LIMIT 10)",
                [video_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn get_video_inputs(&self, video_id: &str) -> Result<VideoInputs, String> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT OR IGNORE INTO video_inputs(video_id, updated_at) VALUES(?1, ?2)",
                params![video_id, now],
            )
            .map_err(|e| e.to_string())?;
        let (script_text, pacing_seconds, pacing_preset, pacing_min_seconds, pacing_max_seconds, audio_id, updated_at): (String, i64, String, i64, i64, Option<String>, String) =
            self.connection.query_row(
                "SELECT script_text,pacing_seconds,pacing_preset,pacing_min_seconds,pacing_max_seconds,audio_asset_id,updated_at FROM video_inputs WHERE video_id=?1",
                [video_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            ).map_err(|e| e.to_string())?;
        let audio = audio_id
            .map(|id| self.asset_by_id(&id))
            .transpose()?
            .flatten();
        let references = self.list_assets(video_id, "reference")?;
        let generation_snapshot: Option<(Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>)> = self
            .connection
            .query_row(
                "SELECT generation_script_text, generation_audio_id, generation_pacing_preset, generation_pacing_min_seconds, generation_pacing_max_seconds FROM visual_plan_meta WHERE video_id=?1",
                [video_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let plan_matches_current_inputs = generation_snapshot.and_then(
            |(gen_script, gen_audio_id, gen_preset, gen_min, gen_max)| {
                // gen_script is only absent for rows written before this
                // snapshot existed (or no plan generated yet) — anything
                // else missing here would be a real bug, not a legacy case.
                gen_script.map(|gen_script| {
                    gen_script == script_text
                        && gen_audio_id == audio.as_ref().map(|a| a.id.clone())
                        && gen_preset.as_deref() == Some(pacing_preset.as_str())
                        && gen_min == Some(pacing_min_seconds)
                        && gen_max == Some(pacing_max_seconds)
                })
            },
        );
        Ok(VideoInputs {
            video_id: video_id.into(),
            script_text,
            pacing_seconds,
            pacing_preset,
            pacing_min_seconds,
            pacing_max_seconds,
            audio,
            references,
            updated_at,
            plan_matches_current_inputs,
        })
    }

    pub fn save_video_inputs(
        &self,
        video_id: &str,
        script_text: &str,
        pacing_seconds: i64,
    ) -> Result<VideoInputs, String> {
        if !(4..=14).contains(&pacing_seconds) {
            return Err("Scene pacing must be between 4 and 14 seconds.".into());
        }
        if script_text.len() > 1_000_000 {
            return Err("Script exceeds the 1 MB limit.".into());
        }
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO video_inputs(video_id, script_text, pacing_seconds, updated_at)
             VALUES(?1, ?2, ?3, ?4) ON CONFLICT(video_id) DO UPDATE SET
             script_text=excluded.script_text, pacing_seconds=excluded.pacing_seconds, updated_at=excluded.updated_at",
            params![video_id, script_text, pacing_seconds, now],
        ).map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE videos SET updated_at = ?1 WHERE id = ?2",
                params![now, video_id],
            )
            .map_err(|e| e.to_string())?;
        self.create_snapshot(
            video_id,
            &serde_json::json!({"reason":"inputs-saved","scriptLength":script_text.len(),"pacingSeconds":pacing_seconds}).to_string(),
        )?;
        self.get_video_inputs(video_id)
    }

    pub fn save_video_pacing(
        &self,
        video_id: &str,
        preset: &str,
        min_seconds: i64,
        max_seconds: i64,
    ) -> Result<VideoInputs, String> {
        if min_seconds < 2 || max_seconds > 30 || min_seconds > max_seconds {
            return Err("Scene pacing must use a valid 2–30 second range.".into());
        }
        if !["calm", "balanced", "fast", "custom", "per-sentence"].contains(&preset) {
            return Err("Unknown pacing preset.".into());
        }
        self.get_video_inputs(video_id)?;
        self.connection.execute(
            "UPDATE video_inputs SET pacing_preset=?1,pacing_min_seconds=?2,pacing_max_seconds=?3,pacing_seconds=?4,updated_at=?5 WHERE video_id=?6",
            params![preset,min_seconds,max_seconds,(min_seconds+max_seconds)/2,Utc::now().to_rfc3339(),video_id],
        ).map_err(|e| e.to_string())?;
        self.get_video_inputs(video_id)
    }

    pub fn import_asset(
        &self,
        video_id: &str,
        source: &Path,
        kind: &str,
    ) -> Result<InputAsset, String> {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let allowed = match kind {
            "audio" => ["wav", "mp3", "m4a", "aac", "flac"].contains(&extension.as_str()),
            "reference" => ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()),
            _ => false,
        };
        if !allowed {
            return Err("Unsupported input file type.".into());
        }
        let (channel_id,): (String,) = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1 AND trashed_at IS NULL",
                [video_id],
                |row| Ok((row.get(0)?,)),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let original_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Invalid file name.")?
            .to_string();
        let id = Uuid::new_v4().to_string();
        let folder = if kind == "audio" {
            "audio"
        } else {
            "references"
        };
        let destination_dir = self
            .projects_dir
            .join(&channel_id)
            .join(video_id)
            .join(folder);
        fs::create_dir_all(&destination_dir).map_err(|e| e.to_string())?;
        let stored_name = format!("{id}.{extension}");
        let destination = destination_dir.join(&stored_name);
        fs::copy(source, &destination).map_err(|e| e.to_string())?;
        let size_bytes = fs::metadata(&destination).map_err(|e| e.to_string())?.len() as i64;
        let relative_path = format!("{folder}/{stored_name}");
        let media_type = extension_to_media_type(&extension).to_string();
        let created_at = Utc::now().to_rfc3339();
        if kind == "audio" {
            if let Some(existing) = self.get_video_inputs(video_id)?.audio {
                self.remove_asset(&existing.id)?;
            }
        } else if kind == "reference" {
            for existing in self.get_video_inputs(video_id)?.references {
                self.remove_asset(&existing.id)?;
            }
        }
        self.connection.execute(
            "INSERT INTO input_assets(id, video_id, kind, original_name, relative_path, media_type, size_bytes, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, video_id, kind, original_name, relative_path, media_type, size_bytes, created_at],
        ).map_err(|e| e.to_string())?;
        if kind == "audio" {
            self.connection.execute(
                "INSERT INTO video_inputs(video_id, audio_asset_id, updated_at) VALUES(?1, ?2, ?3)
                 ON CONFLICT(video_id) DO UPDATE SET audio_asset_id=excluded.audio_asset_id, updated_at=excluded.updated_at",
                params![video_id, id, created_at],
            ).map_err(|e| e.to_string())?;
        }
        self.create_snapshot(
            video_id,
            &serde_json::json!({"reason":"input-asset-imported","kind":kind,"assetId":id})
                .to_string(),
        )?;
        Ok(InputAsset {
            id,
            video_id: video_id.into(),
            kind: kind.into(),
            original_name,
            relative_path,
            media_type,
            size_bytes,
            created_at,
        })
    }

    pub fn remove_asset(&self, asset_id: &str) -> Result<(), String> {
        let asset = self.asset_by_id(asset_id)?.ok_or("Asset was not found.")?;
        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1",
                [&asset.video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let path = self
            .projects_dir
            .join(channel_id)
            .join(&asset.video_id)
            .join(&asset.relative_path);
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        self.connection
            .execute(
                "UPDATE video_inputs SET audio_asset_id = NULL WHERE audio_asset_id = ?1",
                [asset_id],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute("DELETE FROM input_assets WHERE id = ?1", [asset_id])
            .map_err(|e| e.to_string())?;
        self.create_snapshot(
            &asset.video_id,
            &serde_json::json!({"reason":"input-asset-removed","kind":asset.kind,"assetId":asset.id}).to_string(),
        )?;
        Ok(())
    }

    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn save_app_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO app_settings(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_app_settings(&self) -> Result<Vec<AppSetting>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT key, value FROM app_settings ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(AppSetting {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_image_workspace(&self, video_id: &str) -> Result<ImageWorkspace, String> {
        // A project that never had a visual plan generated (e.g. an
        // "Import video" asset-folder project, which is built directly from
        // finished clips and has no plan at all) isn't an error state for a
        // pure read like this one — every caller here is display-only, so
        // it degrades to an empty workspace instead of failing outright.
        // `get_visual_plan` itself stays strict: its many *mutation* callers
        // (split/merge sentence, save plan edits, etc.) genuinely have
        // nothing valid to act on without a real plan, and should keep
        // erroring.
        let plan = self.get_visual_plan(video_id).unwrap_or_else(|_| VisualPlan {
            video_id: video_id.into(),
            timing_source: String::new(),
            sentences: Vec::new(),
            groups: Vec::new(),
            scenes: Vec::new(),
            updated_at: String::new(),
        });
        let sentences = plan.sentences.clone();
        let scenes = plan.scenes.clone();
        let groups = plan
            .groups
            .into_iter()
            .map(|group| {
                let educational_plan = self.get_educational_visual_plan(video_id, &group.id)?;
                let prompt_versions = self.list_prompt_versions(video_id, &group.id)?;
                let image_renders = self.list_image_renders(video_id, &group.id)?;
                Ok(ImageWorkspaceGroup {
                    group,
                    educational_plan,
                    prompt_versions,
                    image_renders,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ImageWorkspace {
            video_id: video_id.into(),
            sentences,
            groups,
            settings: self.list_app_settings()?,
            scenes,
        })
    }

    pub fn list_prompt_versions(
        &self,
        video_id: &str,
        group_id: &str,
    ) -> Result<Vec<PromptVersion>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, video_id, group_id, version, settings_json, system_prompt, user_prompt, created_at
             FROM prompt_versions WHERE video_id = ?1 AND group_id = ?2 ORDER BY version DESC",
        ).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, group_id], |row| {
                Ok(PromptVersion {
                    id: row.get(0)?,
                    video_id: row.get(1)?,
                    group_id: row.get(2)?,
                    version: row.get(3)?,
                    settings_json: row.get(4)?,
                    system_prompt: row.get(5)?,
                    user_prompt: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn create_prompt_version(
        &self,
        video_id: &str,
        group_id: &str,
        settings_json: &str,
        system_prompt: &str,
        user_prompt: &str,
    ) -> Result<PromptVersion, String> {
        serde_json::from_str::<serde_json::Value>(settings_json)
            .map_err(|_| "Image settings must be valid JSON.".to_string())?;
        if system_prompt.trim().is_empty() {
            return Err("System prompt is required.".into());
        }
        if user_prompt.trim().is_empty() {
            return Err("Scene prompt is required.".into());
        }
        let version: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM prompt_versions WHERE video_id = ?1 AND group_id = ?2",
                params![video_id, group_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT INTO prompt_versions(id, video_id, group_id, version, settings_json, system_prompt, user_prompt, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, video_id, group_id, version, settings_json, system_prompt, user_prompt, created_at],
            )
            .map_err(|e| e.to_string())?;
        let stale_prompts: Vec<String> = self.connection.prepare(
            "SELECT id FROM prompt_versions WHERE video_id=?1 AND group_id=?2 ORDER BY version DESC LIMIT -1 OFFSET 5"
        ).map_err(|e| e.to_string())?
            .query_map(params![video_id, group_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        for stale_id in stale_prompts {
            let used: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM image_renders WHERE prompt_version_id=?1 UNION ALL SELECT 1 FROM image_job_items WHERE prompt_version_id=?1)",
                [&stale_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if !used {
                self.connection.execute("DELETE FROM prompt_versions WHERE id=?1", [&stale_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(PromptVersion {
            id,
            video_id: video_id.into(),
            group_id: group_id.into(),
            version,
            settings_json: settings_json.into(),
            system_prompt: system_prompt.into(),
            user_prompt: user_prompt.into(),
            created_at,
        })
    }

    pub fn delete_prompt_version(&self, prompt_version_id: &str) -> Result<(), String> {
        let render_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM image_renders WHERE prompt_version_id=?1",
            [prompt_version_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if render_count > 0 {
            return Err("This prompt version is used by an image version. Delete that image version first.".into());
        }
        let job_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM image_job_items WHERE prompt_version_id=?1",
            [prompt_version_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if job_count > 0 {
            return Err("This prompt version is queued in an active bulk job. Stop the job before deleting.".into());
        }
        let deleted = self.connection.execute(
            "DELETE FROM prompt_versions WHERE id=?1", [prompt_version_id],
        ).map_err(|e| e.to_string())?;
        if deleted == 0 { return Err("Prompt version was not found.".into()); }
        Ok(())
    }

    pub fn list_image_renders(
        &self,
        video_id: &str,
        group_id: &str,
    ) -> Result<Vec<ImageRender>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, is_final, edit_strength, mask_path, mask_used, created_at, subject_x, subject_y
             FROM image_renders WHERE video_id = ?1 AND group_id = ?2 ORDER BY version DESC",
        ).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, group_id], |row| {
                Ok(ImageRender {
                    id: row.get(0)?,
                    video_id: row.get(1)?,
                    group_id: row.get(2)?,
                    version: row.get(3)?,
                    prompt_version_id: row.get(4)?,
                    file_name: row.get(5)?,
                    relative_path: row.get(6)?,
                    parent_render_id: row.get(7)?,
                    edit_instruction: row.get(8)?,
                    kind: row.get(9)?,
                    is_final: row.get::<_, i64>(10)? != 0,
                    edit_strength: row.get(11)?,
                    mask_path: row.get(12)?,
                    mask_used: row.get::<_, i64>(13)? != 0,
                    created_at: row.get(14)?,
                    subject_x: row.get(15)?,
                    subject_y: row.get(16)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    fn insert_image_render(
        &self,
        id: &str,
        video_id: &str,
        group_id: &str,
        version: i64,
        prompt_version_id: &str,
        file_name: &str,
        relative_path: &str,
        parent_render_id: Option<&str>,
        edit_instruction: Option<&str>,
        kind: &str,
    ) -> Result<ImageRender, String> {
        let created_at = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE image_renders SET is_final=0 WHERE video_id=?1 AND group_id=?2",
                params![video_id, group_id],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "INSERT INTO image_renders(id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, is_final, mask_used, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, 0, ?11)",
                params![id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, created_at],
            )
            .map_err(|e| e.to_string())?;
        let stale: Vec<ImageRender> = self.list_image_renders(video_id, group_id)?
            .into_iter().filter(|render| !render.is_final).skip(4).collect();
        for render in stale {
            if let Ok(path) = self.render_absolute_path(&render) {
                let _ = fs::remove_file(path);
            }
            // Null FK references before deletion to avoid constraint failures.
            self.connection.execute("UPDATE image_renders SET parent_render_id=NULL WHERE parent_render_id=?1", [&render.id]).map_err(|e| e.to_string())?;
            self.connection.execute("UPDATE image_job_items SET render_id=NULL WHERE render_id=?1", [&render.id]).map_err(|e| e.to_string())?;
            self.connection.execute("UPDATE timeline_clips SET render_id=NULL WHERE render_id=?1", [&render.id]).map_err(|e| e.to_string())?;
            self.connection.execute("DELETE FROM image_renders WHERE id=?1", [&render.id])
                .map_err(|e| e.to_string())?;
        }
        Ok(ImageRender {
            id: id.into(),
            video_id: video_id.into(),
            group_id: group_id.into(),
            version,
            prompt_version_id: prompt_version_id.into(),
            file_name: file_name.into(),
            relative_path: relative_path.into(),
            parent_render_id: parent_render_id.map(str::to_string),
            edit_instruction: edit_instruction.map(str::to_string),
            kind: kind.into(),
            is_final: true,
            edit_strength: None,
            mask_path: None,
            mask_used: false,
            created_at,
            subject_x: None,
            subject_y: None,
        })
    }

    pub fn set_final_render(&self, render_id: &str, is_final: bool) -> Result<ImageRender, String> {
        let (video_id, group_id): (String, String) = self.connection.query_row(
            "SELECT video_id,group_id FROM image_renders WHERE id=?1", [render_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Image version was not found.".to_string())?;
        if is_final {
            self.connection.execute(
                "UPDATE image_renders SET is_final=0 WHERE video_id=?1 AND group_id=?2",
                params![video_id, group_id],
            ).map_err(|e| e.to_string())?;
        }
        self.connection.execute(
            "UPDATE image_renders SET is_final=?2 WHERE id=?1",
            params![render_id, is_final as i64],
        ).map_err(|e| e.to_string())?;
        self.list_image_renders(&video_id, &group_id)?.into_iter()
            .find(|render| render.id == render_id)
            .ok_or_else(|| "Image version was not found.".to_string())
    }

    pub fn delete_image_render(&self, render_id: &str) -> Result<(), String> {
        let render = self.connection.query_row(
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at,subject_x,subject_y FROM image_renders WHERE id=?1",
            [render_id], |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?,
                is_final: row.get::<_, i64>(10)? != 0, edit_strength: row.get(11)?,
                mask_path: row.get(12)?, mask_used: row.get::<_, i64>(13)? != 0,
                created_at: row.get(14)?, subject_x: row.get(15)?, subject_y: row.get(16)?,
            }),
        ).map_err(|_| "Image version was not found.".to_string())?;
        let path = self.render_absolute_path(&render)?;
        // NULL out every FK that points at this render before deleting
        self.connection.execute(
            "UPDATE image_renders SET parent_render_id=NULL WHERE parent_render_id=?1", [render_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE image_job_items SET render_id=NULL WHERE render_id=?1", [render_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE timeline_clips SET render_id=NULL WHERE render_id=?1", [render_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM image_renders WHERE id=?1", [render_id])
            .map_err(|e| e.to_string())?;
        let _ = fs::remove_file(path);
        if let Some(mask_path) = render.mask_path {
            let channel_id: String = self.connection.query_row(
                "SELECT channel_id FROM videos WHERE id=?1", [&render.video_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(self.projects_dir.join(channel_id).join(&render.video_id).join(mask_path));
        }
        if render.is_final {
            if let Some(next) = self.list_image_renders(&render.video_id, &render.group_id)?.first() {
                self.set_final_render(&next.id, true)?;
            }
        }
        Ok(())
    }

    pub fn copy_render_to_folder(&self, render_id: &str, dest_folder: &str) -> Result<String, String> {
        let render: ImageRender = self.connection.query_row(
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at,subject_x,subject_y FROM image_renders WHERE id=?1",
            [render_id],
            |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?,
                file_name: row.get(5)?, relative_path: row.get(6)?,
                parent_render_id: row.get(7)?, edit_instruction: row.get(8)?,
                kind: row.get(9)?, is_final: row.get(10)?,
                edit_strength: row.get(11)?, mask_path: row.get(12)?,
                mask_used: row.get(13)?, created_at: row.get(14)?,
                subject_x: row.get(15)?, subject_y: row.get(16)?,
            }),
        ).map_err(|_| "Render not found.".to_string())?;
        let src = self.render_absolute_path(&render)?;
        let dest_dir = std::path::Path::new(dest_folder);
        // The remembered download folder (saved app-wide after the first pick — see
        // downloadStill in App.tsx) can go stale if the user later moves, renames, or
        // deletes it outside the app. Recreate it rather than failing with a raw "path
        // not found" error — that's what a "download" action should do when its target
        // folder is simply gone, the same way browsers do.
        fs::create_dir_all(dest_dir)
            .map_err(|e| format!("Could not create download folder {}: {e}", dest_dir.display()))?;
        let dest = dest_dir.join(&render.file_name);
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        Ok(render.file_name)
    }

    pub fn reset_image_workflow(&self, video_id: &str) -> Result<(), String> {
        let renders = self.get_visual_plan(video_id)?.groups.into_iter()
            .map(|group| self.list_image_renders(video_id, &group.id))
            .collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect::<Vec<_>>();
        self.connection.execute("UPDATE timeline_clips SET render_id=NULL WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM image_job_items WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM image_jobs WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("UPDATE image_renders SET parent_render_id=NULL WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM image_renders WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        for render in renders {
            if let Ok(path) = self.render_absolute_path(&render) { let _ = fs::remove_file(path); }
            if let Some(mask_path) = render.mask_path {
                if let Ok(channel_id) = self.connection.query_row("SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get::<_, String>(0)) {
                    let _ = fs::remove_file(self.projects_dir.join(channel_id).join(video_id).join(mask_path));
                }
            }
        }
        self.connection.execute("DELETE FROM prompt_versions WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM educational_visual_plans WHERE video_id=?1", [video_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM app_settings WHERE key=?1", [format!("prompt_prep.{video_id}")]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn suggest_image_prompt(
        &self,
        video_id: &str,
        group_id: &str,
        settings_json: &str,
        style_directive: &str,
    ) -> Result<String, String> {
        let plan = self.get_visual_plan(video_id)?;
        let group = plan.groups.iter().find(|item| item.id == group_id)
            .ok_or("Visual plan still was not found.")?;
        let members: Vec<_> = group.sentence_ids.iter()
            .filter_map(|id| plan.sentences.iter().find(|sentence| &sentence.id == id))
            .collect();
        let start = members.first().map(|item| item.start_seconds).unwrap_or(0.0);
        let end = members.last().map(|item| item.end_seconds).unwrap_or(start);
        let voiceover = members.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join(" ");
        let auth = self.gemini_auth()?;
        let request = format!(
            "Create one concise, production-ready image prompt for this narration still.\n\
             Voiceover: {voiceover}\nType: {}\nTimestamp: {:.1}-{:.1}s (duration {:.1}s)\n\
             Image settings: {settings_json}\nStyle directive: {style_directive}\n\
             Describe the main subject, action/emotion, relevant setting, framing, mood, and directly supportive visual details. \
             Be literal and hyper-relevant. Avoid generic cinematic filler, unrelated metaphors, random people or objects, overcrowding, and text in the image. Return only the prompt.",
            group.kind, start, end, end - start
        );
        request_gemini_text(&auth, &request)
    }

    pub fn get_educational_visual_plan(
        &self,
        video_id: &str,
        group_id: &str,
    ) -> Result<Option<EducationalVisualPlan>, String> {
        self.connection.query_row(
            "SELECT still_id,visual_plan_row_id,educational_objective,visual_intent,subject_strategy,image_settings_json,user_prompt,plan_signature,visual_strategy_mode,planner_version,created_at,updated_at
             FROM educational_visual_plans WHERE video_id=?1 AND visual_plan_row_id=?2",
            params![video_id, group_id],
            |row| {
                Ok(EducationalVisualPlan {
                    still_id: row.get(0)?,
                    visual_plan_row_id: row.get(1)?,
                    educational_objective: row.get(2)?,
                    visual_intent: row.get(3)?,
                    subject_strategy: row.get(4)?,
                    image_settings: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_else(|_| json!({})),
                    user_prompt: row.get(6)?,
                    plan_signature: row.get(7)?,
                    visual_strategy_mode: row.get(8)?,
                    planner_version: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        ).optional().map_err(|e| e.to_string())
    }

    pub fn plan_educational_visual(
        &self,
        video_id: &str,
        group_id: &str,
        base_settings_json: &str,
        style_directive: &str,
    ) -> Result<EducationalVisualPlan, String> {
        let plan = self.get_visual_plan(video_id)?;
        let group = plan.groups.iter().find(|item| item.id == group_id)
            .ok_or("Visual plan still was not found.")?;
        let members: Vec<_> = group.sentence_ids.iter()
            .filter_map(|id| plan.sentences.iter().find(|sentence| &sentence.id == id)).collect();
        let voiceover = members.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join(" ");
        let start = members.first().map(|item| item.start_seconds).unwrap_or(0.0);
        let end = members.last().map(|item| item.end_seconds).unwrap_or(start);
        let signature = format!("{}|{}|{}|{}|{}|{}", EDUCATIONAL_VISUAL_PLANNER_VERSION, voiceover, group.kind, base_settings_json, style_directive, end - start);
        if let Some(existing) = self.get_educational_visual_plan(video_id, group_id)? {
            if existing.plan_signature == signature {
                return Ok(existing);
            }
        }
        let auth = self.gemini_auth()?;
        let request = format!(
            r#"You are an Educational Visual Planner. Do not ask what image merely matches the sentence. Decide what image teaches the concept best.

Narration: {voiceover}
Visual plan type: {}
Timestamp: {:.1}-{:.1}s
Base image settings: {base_settings_json}
Style directive: {style_directive}

Choose exactly one educationalObjective from:
Introduce Subject; Show Relationship; Explain Process; Explain Sequence; Explain Location; Explain Structure; Highlight Detail; Show Environment; Explain Concept; Show Evidence; Compare Alternatives; Explain Cause Effect; Demonstrate Behavior; Clarify Misconception.

Choose exactly one visualIntent from:
Character Scene; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Process Illustration; Timeline; Textless Infographic; Scientific Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

Choose exactly one subjectStrategy from:
Single Subject; Subject Plus Object; Object Only; Environment Only; Split Comparison; Diagram Subject; Map Subject; Abstract Subject.

Rules:
- Prefer the visual structure that teaches the idea best.
- Avoid humans unless narration requires them.
- Prefer one primary subject.
- For relationships or ancestry, prefer comparison/relationship visuals over a random portrait.
- Keep the scene directly grounded in the narration.
- Choose image settings only after writing the scene concept, so every choice supports the userPrompt.
- Preserve the supplied aspectRatio. Do not invent a different aspect ratio.
- imageSettings must include these keys: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, composition, contrast, saturation, motion. Use concrete values only; never Undefined.
- cameraAngle MUST reflect the narration's spatial perspective: detail/examination → Close Up or Extreme Close Up; wide environment → Wide Shot or Birds Eye View; dramatic → Dutch Angle or Low Angle; following → Over the Shoulder; neutral explanation → Eye Level only.
- colorTemperature sets tonal warmth (Very Warm Golden / Warm / Neutral / Cool / Very Cool Blue Tinted / Mixed Contrasting Warm Cool).
- weatherAtmosphere sets environment context (Clear / Foggy Misty / Rainy / Overcast Sky / Snowy / Hazy Dusty / Stormy, etc.).
- saturation controls color intensity (Highly Saturated Vivid / Natural / Muted / Desaturated / Black and White Greyscale).
- At least 4 of the 10 required settings must be actively driven by this specific narration (not generic defaults): cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, composition, contrast, saturation, motion.
- userPrompt must be a production-ready, textless image prompt implementing the educational plan.

Return JSON only:
{{"educationalObjective":"...","visualIntent":"...","subjectStrategy":"...","imageSettings":{{...}},"userPrompt":"..."}}"#,
            group.kind, start, end
        );
        let text = request_gemini_text(&auth, &request)?;
        let cleaned_plan = extract_json_from_text(&text);
        let planned: EducationalPlanResponse = serde_json::from_str(cleaned_plan)
            .map_err(|e| format!("Educational plan was not valid JSON: {e}"))?;
        validate_educational_plan(&planned)?;
        let now = Utc::now().to_rfc3339();
        let still_id = self.get_educational_visual_plan(video_id, group_id)?
            .map(|item| item.still_id).unwrap_or_else(|| Uuid::new_v4().to_string());
        self.connection.execute(
            "INSERT INTO educational_visual_plans(still_id,video_id,visual_plan_row_id,educational_objective,visual_intent,subject_strategy,image_settings_json,user_prompt,plan_signature,visual_strategy_mode,planner_version,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'Auto Educational',?10,?11,?11)
             ON CONFLICT(still_id) DO UPDATE SET educational_objective=excluded.educational_objective,visual_intent=excluded.visual_intent,subject_strategy=excluded.subject_strategy,image_settings_json=excluded.image_settings_json,user_prompt=excluded.user_prompt,plan_signature=excluded.plan_signature,updated_at=excluded.updated_at",
            params![still_id,video_id,group_id,planned.educational_objective,planned.visual_intent,planned.subject_strategy,planned.image_settings.to_string(),planned.user_prompt,signature,EDUCATIONAL_VISUAL_PLANNER_VERSION,now],
        ).map_err(|e| e.to_string())?;
        self.get_educational_visual_plan(video_id, group_id)?
            .ok_or_else(|| "Educational visual plan was not saved.".to_string())
    }

    pub fn plan_whole_video_educational_visuals(
        &self,
        video_id: &str,
        base_settings_json: &str,
        style_directive: &str,
        strategy_mode: &str,
    ) -> Result<WholeVideoEducationalPlan, String> {
        const MODES: &[&str] = &["Auto Educational", "Storytelling", "Documentary", "Scientific", "Infographic Heavy"];
        if !MODES.contains(&strategy_mode) {
            return Err("Unsupported visual strategy mode.".into());
        }
        let visual_plan = self.get_visual_plan(video_id)?;
        let rows = visual_plan.groups.iter().map(|group| {
            let members: Vec<_> = group.sentence_ids.iter()
                .filter_map(|id| visual_plan.sentences.iter().find(|sentence| &sentence.id == id)).collect();
            json!({
                "visualPlanRowId": group.id,
                "ordinal": group.ordinal,
                "type": group.kind,
                "startSeconds": members.first().map(|item| item.start_seconds).unwrap_or(0.0),
                "endSeconds": members.last().map(|item| item.end_seconds).unwrap_or(0.0),
                "narration": members.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join(" ")
            })
        }).collect::<Vec<_>>();
        let global_signature = format!(
            "{}|{}|{}|{}|{}",
            EDUCATIONAL_VISUAL_PLANNER_VERSION,
            strategy_mode,
            style_directive,
            base_settings_json,
            serde_json::to_string(&rows).unwrap_or_default()
        );
        let existing = visual_plan.groups.iter()
            .map(|group| self.get_educational_visual_plan(video_id, &group.id))
            .collect::<Result<Vec<_>, _>>()?;
        if existing.iter().all(|item| item.as_ref().is_some_and(|plan| plan.plan_signature.starts_with(&global_signature))) {
            return Ok(WholeVideoEducationalPlan {
                strategy_mode: strategy_mode.into(),
                planner_version: EDUCATIONAL_VISUAL_PLANNER_VERSION.into(),
                plans: existing.into_iter().flatten().collect(),
            });
        }
        let weights = match strategy_mode {
            "Storytelling" => "Favor Character Scene, Behavioral Demonstration, POV Scene, Environmental Scene, and Documentary Frame while retaining educational clarity.",
            "Documentary" => "Favor Documentary Frame, Environmental Scene, Object Focus, Close Detail, and evidence-based Comparison.",
            "Scientific" => "Favor Scientific Diagram, Process Illustration, Close Detail, Comparison, Textless Infographic, and Geographic Map.",
            "Infographic Heavy" => "Favor Textless Infographic, Scientific Diagram, Timeline, Comparison, Process Illustration, and Geographic Map.",
            _ => "Use this approximate whole-video distribution: Character Scene 30-40%; Behavioral Demonstration 10-15%; Close Detail 10-15%; Comparison 10-15%; Environmental Scene 5-10%; Object Focus 5-10%; Process Illustration 5-10%; Timeline 2-5%; Textless Infographic 2-8%; Scientific Diagram 2-8%; Geographic Map 0-5%; Concept Visualization 2-8%; Documentary Frame 5-15%.",
        };
        let auth = self.gemini_auth()?;
        let mut planned_rows = Vec::with_capacity(rows.len());
        for (chunk_index, chunk) in rows.chunks(12).enumerate() {
            let prior_context = planned_rows.iter().rev().take(3).cloned().collect::<Vec<EducationalPlanResponse>>();
            let request = format!(
            r#"You are an Educational Visual Director planning an entire video, not isolated stills.

Strategy mode: {strategy_mode}
Planner version: {EDUCATIONAL_VISUAL_PLANNER_VERSION}
Style directive: {style_directive}
Base image settings: {base_settings_json}
This is planning batch {} of {}. The full video has {} stills.
The current chronological rows are:
{}

The most recent assigned plans (newest first) are:
{}

Work in three internal phases:
A. Analyze each supplied still and its educational role in the video.
B. Assign visual intents while considering previous stills, upcoming stills, educational flow, and visual rhythm.
C. Generate image settings and a production-ready user prompt for every still.

{weights}

Anti-repetition:
- Track the last 3 visual intents, objectives, and subject strategies.
- Never assign more than 3 consecutive identical visual intents.
- Avoid repetitive subject strategies when another teaching structure communicates the idea better.

Image settings rules:
- imageSettings must include: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, composition, contrast, saturation, motion. Use concrete values only; never Undefined.
- cameraAngle MUST vary based on spatial perspective. Do NOT default to Eye Level. Choose: detail/examination → Close Up or Extreme Close Up; wide environment → Wide Shot or Birds Eye View; dramatic → Dutch Angle or Low Angle; following action → Over the Shoulder; neutral explanation → Eye Level only.
- colorTemperature: Very Warm Golden, Warm, Neutral, Cool, Very Cool Blue Tinted, Mixed Contrasting Warm Cool.
- weatherAtmosphere: Clear, Foggy Misty, Rainy, Overcast Sky, Snowy, Hazy Dusty, Stormy, etc.
- saturation: Highly Saturated Vivid, Natural, Muted, Desaturated, Black and White Greyscale.
- Across consecutive stills, at least 4 of these must differ from the immediately prior still: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, composition, contrast, saturation, motion.

Core rule: ask “What image teaches the concept best?”, never merely “What image matches the sentence?”
Avoid humans unless narration requires them. Prefer one primary subject.

Allowed educationalObjective values:
Introduce Subject; Show Relationship; Explain Process; Explain Sequence; Explain Location; Explain Structure; Highlight Detail; Show Environment; Explain Concept; Show Evidence; Compare Alternatives; Explain Cause Effect; Demonstrate Behavior; Clarify Misconception.

Allowed visualIntent values:
Character Scene; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Process Illustration; Timeline; Textless Infographic; Scientific Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

Allowed subjectStrategy values:
Single Subject; Subject Plus Object; Object Only; Environment Only; Split Comparison; Diagram Subject; Map Subject; Abstract Subject.

Return JSON only:
{{"plans":[{{"visualPlanRowId":"exact row id","educationalObjective":"...","visualIntent":"...","subjectStrategy":"...","imageSettings":{{...}},"userPrompt":"..."}}]}}

Return exactly one plan for every supplied row, in the same order."#,
                chunk_index + 1,
                rows.len().div_ceil(12),
                rows.len(),
                serde_json::to_string_pretty(chunk).unwrap_or_default(),
                serde_json::to_string_pretty(&prior_context).unwrap_or_default(),
            );
            let text = request_gemini_text(&auth, &request)?;
            let cleaned_wvp = extract_json_from_text(&text);
            let response: WholeVideoPlanResponse = serde_json::from_str(cleaned_wvp)
                .map_err(|e| format!("Whole-video plan was not valid JSON: {e}"))?;
            if response.plans.len() != chunk.len() {
                return Err(format!(
                    "Planner returned {} plans for batch {} ({} stills expected).",
                    response.plans.len(),
                    chunk_index + 1,
                    chunk.len()
                ));
            }
            for (offset, plan) in response.plans.iter().enumerate() {
                let expected_id = chunk[offset].get("visualPlanRowId").and_then(|value| value.as_str()).unwrap_or_default();
                if plan.visual_plan_row_id != expected_id {
                    return Err(format!("OpenAI planning batch {} returned rows out of order.", chunk_index + 1));
                }
            }
            planned_rows.extend(response.plans);
        }
        for window in planned_rows.windows(4) {
            if window.iter().all(|plan| plan.visual_intent == window[0].visual_intent) {
                return Err(format!("Whole-video planner repeated visual intent '{}' more than three times consecutively.", window[0].visual_intent));
            }
        }
        let now = Utc::now().to_rfc3339();
        let mut saved = Vec::with_capacity(planned_rows.len());
        for (index, planned) in planned_rows.into_iter().enumerate() {
            validate_educational_plan(&planned)?;
            let group = &visual_plan.groups[index];
            if planned.visual_plan_row_id != group.id {
                return Err("OpenAI whole-video plan row order did not match the visual plan.".into());
            }
            let row_signature = format!("{}|{}", global_signature, group.id);
            let still_id = self.get_educational_visual_plan(video_id, &group.id)?
                .map(|item| item.still_id).unwrap_or_else(|| Uuid::new_v4().to_string());
            self.connection.execute(
                "INSERT INTO educational_visual_plans(still_id,video_id,visual_plan_row_id,educational_objective,visual_intent,subject_strategy,image_settings_json,user_prompt,plan_signature,visual_strategy_mode,planner_version,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
                 ON CONFLICT(still_id) DO UPDATE SET educational_objective=excluded.educational_objective,visual_intent=excluded.visual_intent,subject_strategy=excluded.subject_strategy,image_settings_json=excluded.image_settings_json,user_prompt=excluded.user_prompt,plan_signature=excluded.plan_signature,visual_strategy_mode=excluded.visual_strategy_mode,planner_version=excluded.planner_version,updated_at=excluded.updated_at",
                params![still_id,video_id,group.id,planned.educational_objective,planned.visual_intent,planned.subject_strategy,planned.image_settings.to_string(),planned.user_prompt,row_signature,strategy_mode,EDUCATIONAL_VISUAL_PLANNER_VERSION,now],
            ).map_err(|e| e.to_string())?;
            saved.push(self.get_educational_visual_plan(video_id, &group.id)?
                .ok_or("Educational visual plan was not saved.")?);
        }
        Ok(WholeVideoEducationalPlan {
            strategy_mode: strategy_mode.into(),
            planner_version: EDUCATIONAL_VISUAL_PLANNER_VERSION.into(),
            plans: saved,
        })
    }

    pub fn set_still_lock(&self, video_id: &str, group_id: &str, settings_locked: bool, prompt_locked: bool) -> Result<(), String> {
        self.connection.execute(
            "UPDATE visual_plan_groups SET settings_locked=?1, prompt_locked=?2 WHERE video_id=?3 AND (id LIKE ?4 OR id=?4)",
            params![settings_locked as i64, prompt_locked as i64, video_id, format!("%::{group_id}")],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Every scene that has at least one Bulk Generation override saved for
    /// this video — a scene with no overrides simply has no row and isn't
    /// present in this list, rather than a row of all-nulls.
    pub fn get_bulk_scene_settings(&self, video_id: &str) -> Result<Vec<BulkSceneSettings>, String> {
        let mut statement = self.connection.prepare(
            "SELECT scene_id, style_directive, creative_instruction, character_consistency, reference_asset_id,
                    location_consistency, location_reference_asset_id, dials_json
             FROM bulk_scene_settings WHERE video_id=?1 ORDER BY scene_id",
        ).map_err(|e| e.to_string())?;
        let rows = statement.query_map([video_id], |row| {
            let dials_json: Option<String> = row.get(7)?;
            Ok(BulkSceneSettings {
                scene_id: row.get(0)?,
                style_directive: row.get(1)?,
                creative_instruction: row.get(2)?,
                character_consistency: row.get::<_, Option<i64>>(3)?.map(|v| v != 0),
                reference_asset_id: row.get(4)?,
                location_consistency: row.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                location_reference_asset_id: row.get(6)?,
                dials: dials_json.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default(),
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Upserts one scene's full override state — the caller (the Bulk
    /// Generation panel) always holds the complete current override record
    /// in memory and re-sends every field, so this always writes every
    /// column rather than patching individual ones. A scene whose fields
    /// are all `None`/empty still leaves a row behind (harmless — reads back
    /// identically to "no overrides"); the panel doesn't bother deleting it.
    pub fn save_bulk_scene_settings(
        &self,
        video_id: &str,
        scene_id: &str,
        style_directive: Option<String>,
        creative_instruction: Option<String>,
        character_consistency: Option<bool>,
        reference_asset_id: Option<String>,
        location_consistency: Option<bool>,
        location_reference_asset_id: Option<String>,
        dials: BulkVisualDials,
    ) -> Result<BulkSceneSettings, String> {
        let dials_json = if dials.is_empty() { None } else { Some(serde_json::to_string(&dials).map_err(|e| e.to_string())?) };
        self.connection.execute(
            "INSERT INTO bulk_scene_settings(id,video_id,scene_id,style_directive,creative_instruction,character_consistency,reference_asset_id,location_consistency,location_reference_asset_id,dials_json,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(video_id,scene_id) DO UPDATE SET
                style_directive=excluded.style_directive,
                creative_instruction=excluded.creative_instruction,
                character_consistency=excluded.character_consistency,
                reference_asset_id=excluded.reference_asset_id,
                location_consistency=excluded.location_consistency,
                location_reference_asset_id=excluded.location_reference_asset_id,
                dials_json=excluded.dials_json,
                updated_at=excluded.updated_at",
            params![
                Uuid::new_v4().to_string(), video_id, scene_id,
                style_directive, creative_instruction,
                character_consistency.map(|v| v as i64), reference_asset_id,
                location_consistency.map(|v| v as i64), location_reference_asset_id,
                dials_json,
                Utc::now().to_rfc3339(),
            ],
        ).map_err(|e| e.to_string())?;
        Ok(BulkSceneSettings {
            scene_id: scene_id.to_string(), style_directive, creative_instruction, character_consistency, reference_asset_id,
            location_consistency, location_reference_asset_id, dials,
        })
    }

    /// Video-wide defaults for the Visual Director / Diversity & Consistency
    /// dials plus Location Consistency — the `bulk_global_settings`
    /// counterpart to `get_bulk_scene_settings`. Returns the empty/default
    /// shape for a video that has never saved anything here, exactly like
    /// the existing global style directive / creative instruction (kept in
    /// `app_settings`) already behave when unset.
    pub fn get_bulk_global_settings(&self, video_id: &str) -> Result<BulkGlobalVisualSettings, String> {
        let row: Option<(Option<i64>, Option<String>, Option<String>)> = self.connection.query_row(
            "SELECT location_consistency, location_reference_asset_id, dials_json FROM bulk_global_settings WHERE video_id=?1",
            [video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((location_consistency, location_reference_asset_id, dials_json)) = row else {
            return Ok(BulkGlobalVisualSettings::default());
        };
        Ok(BulkGlobalVisualSettings {
            location_consistency: location_consistency.map(|v| v != 0),
            location_reference_asset_id,
            dials: dials_json.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default(),
        })
    }

    /// Upserts the video's full global dials/Location Consistency state —
    /// same full-replace convention as `save_bulk_scene_settings`.
    pub fn save_bulk_global_settings(
        &self,
        video_id: &str,
        location_consistency: Option<bool>,
        location_reference_asset_id: Option<String>,
        dials: BulkVisualDials,
    ) -> Result<BulkGlobalVisualSettings, String> {
        let dials_json = if dials.is_empty() { None } else { Some(serde_json::to_string(&dials).map_err(|e| e.to_string())?) };
        self.connection.execute(
            "INSERT INTO bulk_global_settings(video_id,location_consistency,location_reference_asset_id,dials_json,updated_at)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(video_id) DO UPDATE SET
                location_consistency=excluded.location_consistency,
                location_reference_asset_id=excluded.location_reference_asset_id,
                dials_json=excluded.dials_json,
                updated_at=excluded.updated_at",
            params![
                video_id,
                location_consistency.map(|v| v as i64), location_reference_asset_id,
                dials_json,
                Utc::now().to_rfc3339(),
            ],
        ).map_err(|e| e.to_string())?;
        Ok(BulkGlobalVisualSettings { location_consistency, location_reference_asset_id, dials })
    }

    pub fn extract_image_settings_from_directive(&self, directive: &str) -> Result<StyleExtraction, String> {
        // Claude CLI first — no metered cost, rides whatever Claude
        // subscription is already logged into the CLI on this machine (see
        // run_claude_cli's doc comment). Gemini is the fallback. OpenAI has
        // been removed from Bulk Gen planning entirely.
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        if claude_cli {
            match request_claude_cli_directive_extract(directive) {
                Ok(result) => return Ok(result),
                Err(claude_error) => match self.gemini_auth() {
                    Ok(auth) => return self.extract_image_settings_via_gemini(&auth, directive)
                        .map_err(|gemini_error| format!("Claude CLI: {claude_error} (Gemini fallback also failed: {gemini_error})")),
                    Err(_) => return Err(format!("Claude CLI: {claude_error}")),
                },
            }
        }
        let auth = self.gemini_auth()?;
        self.extract_image_settings_via_gemini(&auth, directive)
    }

    fn extract_image_settings_via_gemini(&self, auth: &GeminiAuth, directive: &str) -> Result<StyleExtraction, String> {
        let prompt = format!(
            r#"You are a visual production assistant. Your job is to clean up a Style Directive so it contains ONLY global visual style rules — nothing about specific subjects, characters, objects, or scene content.

Style Directive to clean:
{directive}

WHAT TO KEEP in the cleaned styleDirective (global aesthetics that apply to every still):
- Art style name / brand (e.g. "Pixar 3D animation", "photorealistic", "watercolor illustration")
- Color palette description (e.g. "warm oranges and browns", "desaturated cool tones")
- Color grading (e.g. "teal and orange", "vintage film grain", "high saturation")
- Rendering quality / medium (e.g. "polished 3D render", "oil painting texture", "cel-shaded")
- Detail level and texture rules (e.g. "highly detailed", "smooth surfaces", "grainy film look")
- Global mood / atmosphere (e.g. "cozy and heartwarming", "dark and moody") — only if NOT tied to a specific scene subject
- Genre or era style (e.g. "cyberpunk", "fantasy", "retro 1980s")
- Lighting style as a global rule (e.g. "cinematic lighting overall", "soft diffused look") — only very general rules, not per-shot specifics
- Visual consistency rules, brand rules, exclusion rules (e.g. "no text", "always soft shadows")

WHAT TO REMOVE from the styleDirective (these go in the User Prompt per still, NOT here):
- Any specific characters: named people, animals, creatures
- Any physical descriptions of subjects
- Any scene-specific content
- Anything that answers "WHO is in the image" or "WHAT specific object/creature"

Per-still structured fields to extract from imageSettings:
Available fields: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, lensType, lightDirection, lightQuality, shadowType, contrast, focusType, exposure, motion, composition, saturation, vignette, grainIntensity, colorCastTint, surfaceEffects.
Only populate imageSettings if the directive specifies a concrete per-shot value. Leave imageSettings as {{}} if nothing concrete is specified.

Return JSON only — no markdown, no explanation:
{{"styleDirective":"<global style rules only>","imageSettings":{{"<field>":"<value>"}}}}"#
        );
        let text = request_gemini_text(auth, &prompt)?;
        let cleaned = extract_json_from_text(&text);
        serde_json::from_str(cleaned).map_err(|_| "Style extraction was not valid JSON.".to_string())
    }

    /// Derives a reusable character description from the video's reference
    /// image (see `list_assets(video_id, "reference")` — guaranteed 0-or-1
    /// row, `import_asset` deletes any prior reference before inserting a
    /// new one) for the "Character Consistency" toggle in Bulk Gen Config.
    /// Returns plain prose (not JSON) — deliberately, to sidestep the
    /// markdown-fence JSON-parsing footguns fixed elsewhere in this file.
    /// Claude CLI first, Gemini fallback — same provider order as the rest
    /// of Bulk Gen planning (OpenAI has been removed from this path
    /// entirely), unlike `extract_reference_style` which hard-codes Gemini.
    /// Reads a reference image's bytes. `asset_id` selects one specific
    /// `input_assets` row directly (used for a scene's overridden reference,
    /// via `bulk_scene_settings.reference_asset_id`) — bypassing it falls
    /// back to whichever asset `global_reference_asset.{video_id}` names, or
    /// (for videos saved before that setting existed) the oldest
    /// `reference`-kind row for the video, matching the original "0-or-1
    /// reference per video" assumption `importReference`'s evict-before-
    /// import behavior used to guarantee on its own. Scene references don't
    /// evict anything, so more than one `reference`-kind row can now coexist
    /// per video — `asset_id`/the setting are what keep the global path from
    /// picking up a scene's reference by accident. Shared by
    /// `character_description_for_video` (vision analysis) and
    /// `generate_image_render` (passed as actual generation input, not just
    /// description text — see that function's comment for why both matter).
    fn reference_image_bytes(&self, video_id: &str, asset_id: Option<&str>) -> Result<Option<(String, Vec<u8>)>, String> {
        let references = self.list_assets(video_id, "reference")?;
        let reference = match asset_id {
            Some(id) => references.into_iter().find(|asset| asset.id == id),
            None => {
                let global_id = self.get_app_setting(&format!("global_reference_asset.{video_id}"))?;
                match global_id {
                    Some(id) => references.into_iter().find(|asset| asset.id == id),
                    None => references.into_iter().next(),
                }
            }
        };
        let Some(reference) = reference else {
            return Ok(None);
        };
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let bytes = fs::read(self.projects_dir.join(&channel_id).join(video_id).join(&reference.relative_path))
            .map_err(|_| "Reference image file is missing.".to_string())?;
        Ok(Some((reference.media_type, bytes)))
    }

    fn character_description_for_video(
        &self,
        video_id: &str,
        gemini_auth: &Option<GeminiAuth>,
        reference_asset_id: Option<&str>,
    ) -> Result<String, String> {
        let (media_type, bytes) = self.reference_image_bytes(video_id, reference_asset_id)?
            .ok_or("Character Consistency requires a reference image — upload one in Bulk Gen Config first.")?;
        let prompt = "Identify the single main character or protagonist in this reference image (a person, animal, or creature — not a background object or environment). Write a concise, reusable physical description of that character for an illustrator to redraw consistently across dozens of separate scenes. You MUST explicitly cover: species/type; approximate age; physical proportions and build; exact hair color, length, and style (or fur/feather coloring and pattern if not human) — this is the single most common detail illustrators get inconsistent, so describe it precisely; eye color; skin/fur tone; and any distinguishing marks or features. Deliberately do NOT describe clothing, outfit, or props — those must change scene-to-scene to match each still's own context, not stay fixed like the physical identity. Do not describe the pose, background, camera angle, or art/rendering style either — only the character's inherent physical identity, in 4-6 sentences of plain prose. If no clear single character is present, describe the closest candidate subject instead. Return only the description, no preamble, no labels, no markdown.";
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        if claude_cli {
            match request_claude_cli_character_description(prompt, &media_type, &bytes) {
                Ok(result) => return Ok(result),
                Err(claude_error) => match gemini_auth.as_ref() {
                    Some(auth) => return request_gemini_vision(auth, prompt, &media_type, &bytes).map_err(|gemini_error| {
                        format!("Claude CLI: {claude_error} (Gemini fallback also failed: {gemini_error})")
                    }),
                    None => return Err(format!("Claude CLI: {claude_error}")),
                },
            }
        }
        request_gemini_vision(
            gemini_auth.as_ref().ok_or("Configure a Gemini API key, or log in with the Claude Code CLI, to use Character Consistency.")?,
            prompt, &media_type, &bytes,
        )
    }

    /// Location Consistency's counterpart to `character_description_for_video`
    /// — same reference-image-to-reusable-description mechanism, same
    /// Claude CLI first / Gemini fallback provider order, just pointed at
    /// the environment instead of a subject. Callers cache the result the
    /// same way (see the `location_description.{video_id}[.{scene_id}]`
    /// cache key in `plan_bulk_visuals_batch`).
    fn location_description_for_video(
        &self,
        video_id: &str,
        gemini_auth: &Option<GeminiAuth>,
        reference_asset_id: Option<&str>,
    ) -> Result<String, String> {
        let (media_type, bytes) = self.reference_image_bytes(video_id, reference_asset_id)?
            .ok_or("Location Consistency requires a reference image — upload one in Bulk Gen Config first.")?;
        let prompt = "Identify the single main location, environment, or setting shown in this reference image. Write a concise, reusable description of that place for an illustrator to redraw consistently across dozens of separate scenes. You MUST explicitly cover: type of space (interior/exterior, room type, or landscape type); architecture or geography; layout and scale; distinctive furniture, structures, or landmarks; and characteristic color palette/materials. Deliberately do NOT describe the people, weather, or time of day present in this specific reference photo, and do NOT describe lighting or camera angle — those must change scene-to-scene to match each still's own narration and mood, not stay fixed like the place's own physical identity. Describe only the location's inherent physical identity, in 4-6 sentences of plain prose. If no single clear location is identifiable, describe the closest candidate setting instead. Return only the description, no preamble, no labels, no markdown.";
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        if claude_cli {
            match request_claude_cli_character_description(prompt, &media_type, &bytes) {
                Ok(result) => return Ok(result),
                Err(claude_error) => match gemini_auth.as_ref() {
                    Some(auth) => return request_gemini_vision(auth, prompt, &media_type, &bytes).map_err(|gemini_error| {
                        format!("Claude CLI: {claude_error} (Gemini fallback also failed: {gemini_error})")
                    }),
                    None => return Err(format!("Claude CLI: {claude_error}")),
                },
            }
        }
        request_gemini_vision(
            gemini_auth.as_ref().ok_or("Configure a Gemini API key, or log in with the Claude Code CLI, to use Location Consistency.")?,
            prompt, &media_type, &bytes,
        )
    }

    /// A genuine whole-script comprehension pass for Bulk Generation's
    /// planning prompt — reads the ENTIRE script in ONE call, unlike the
    /// scene-segmentation engine's Pass 1 (which analyzes the script in
    /// parallel batches with no shared context between them, despite being
    /// told to "read the entire script first"). Produces a compact prose
    /// summary of the video's actual throughline: what it's about, its
    /// overall argument/structure, its tone, and how it's meant to build —
    /// not a sentence-by-sentence recap. Cached per video (see
    /// `script_understanding_source.{video_id}`, which stores the exact
    /// script text the cached summary was derived from, so a script edit
    /// invalidates it automatically without needing a hashing dependency).
    /// Fully automatic — there's no user-facing toggle for this, so a
    /// failure here degrades to "no whole-script context available" rather
    /// than blocking planning entirely; see its one call site in
    /// `plan_bulk_visuals_batch`.
    fn script_understanding_for_video(&self, video_id: &str, gemini_auth: &Option<GeminiAuth>) -> Result<String, String> {
        let inputs = self.get_video_inputs(video_id)?;
        let (script_text, _) = remove_tts_pause_markers(&inputs.script_text);
        if script_text.trim().is_empty() {
            return Ok(String::new());
        }
        let source_key = format!("script_understanding_source.{video_id}");
        let cache_key = format!("script_understanding.{video_id}");
        if self.get_app_setting(&source_key)?.as_deref() == Some(script_text.as_str()) {
            if let Some(cached) = self.get_app_setting(&cache_key)? {
                if !cached.trim().is_empty() {
                    return Ok(cached);
                }
            }
        }
        let prompt = format!(
            "Read this ENTIRE video script and form a genuine understanding of it as a whole — not a \
             sentence-by-sentence summary. Identify: (1) what the video is actually about and its \
             central argument or claim, (2) its overall structure or shape (for example: a countdown, \
             a single sustained argument, a narrative arc with a turning point, a comparison, a \
             how-to sequence), (3) its overall tone, and (4) how it is meant to build or escalate from \
             beginning to end. Write this as 4-8 sentences of plain prose that a visual director could \
             use to keep every single image in the video faithful to the whole story, not just its own \
             sentence in isolation. Return only the description, no preamble, no labels, no markdown.\n\n\
             SCRIPT:\n{script_text}"
        );
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        let description = if claude_cli {
            match run_claude_cli(&prompt, &[]) {
                Ok(result) => result,
                Err(claude_error) => match gemini_auth.as_ref() {
                    Some(auth) => request_gemini_text(auth, &prompt).map_err(|gemini_error| {
                        format!("Claude CLI: {claude_error} (Gemini fallback also failed: {gemini_error})")
                    })?,
                    None => return Err(format!("Claude CLI: {claude_error}")),
                },
            }
        } else {
            request_gemini_text(
                gemini_auth.as_ref().ok_or("Configure a Gemini API key, or log in with the Claude Code CLI, for whole-script understanding.")?,
                &prompt,
            )?
        };
        self.save_app_setting(&source_key, &script_text)?;
        self.save_app_setting(&cache_key, &description)?;
        Ok(description)
    }

    /// Reads back up to `limit` already-*persisted* stills immediately
    /// before `before_index` (in ordinal order) as the same diversity/
    /// continuity context shape `plan_bulk_visuals_batch`'s prompt expects
    /// — reconstructed from the database rather than threaded through
    /// memory, since a resumed run is a fresh function call with no memory
    /// of earlier batches. `_coreVisualDevice`, stashed inside each still's
    /// `settings_json` when it was persisted (see `persist_bulk_planned_still`),
    /// round-trips back out here into the `coreVisualDevice` field the
    /// "RECURRING SYMBOL TRACKING" prompt rule reads.
    fn bulk_plan_prior_context(
        &self,
        video_id: &str,
        groups: &[PlanGroup],
        before_index: usize,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        let start = before_index.saturating_sub(limit);
        let mut context = Vec::new();
        for group in &groups[start..before_index] {
            let Some(latest) = self.list_prompt_versions(video_id, &group.id)?.into_iter().next() else {
                continue;
            };
            let settings: serde_json::Value =
                serde_json::from_str(&latest.settings_json).unwrap_or_else(|_| json!({}));
            let visual_type = self.get_educational_visual_plan(video_id, &group.id)?
                .map(|plan| plan.visual_intent).unwrap_or_default();
            context.push(json!({
                "visualPlanRowId": group.id,
                "visualType": visual_type,
                "mood": settings.get("mood").and_then(|v| v.as_str()),
                "cameraAngle": settings.get("cameraAngle").and_then(|v| v.as_str()),
                "lighting": settings.get("lighting").and_then(|v| v.as_str()),
                "colorTemperature": settings.get("colorTemperature").and_then(|v| v.as_str()),
                "weatherAtmosphere": settings.get("weatherAtmosphere").and_then(|v| v.as_str()),
                "sceneAndEmotionPreview": latest.user_prompt.chars().take(320).collect::<String>(),
                "coreVisualDevice": settings.get("_coreVisualDevice").and_then(|v| v.as_str()).unwrap_or_default(),
            }));
        }
        Ok(context)
    }

    /// Database-backed counterpart to `aggregate_video_visual_history` —
    /// reads every already-planned still among `groups` (normally the
    /// video's ENTIRE plan, not just the current batch/selection) and
    /// tallies visual type and settings. This is the "whole script" half of
    /// the diversity/repetition rules in `plan_bulk_visuals_batch`'s
    /// prompt: `bulk_plan_prior_context` above only sees the last ~12
    /// stills, which is fine for local continuity but can't actually tell
    /// whether a "no more than 30% of the whole video" rule is being kept —
    /// this can, because it looks at everything already planned, at a
    /// bounded, compact size regardless of how long the video is.
    fn video_visual_history(&self, video_id: &str, groups: &[PlanGroup]) -> Result<VideoVisualHistory, String> {
        let mut entries = Vec::with_capacity(groups.len());
        for group in groups {
            let Some(latest) = self.list_prompt_versions(video_id, &group.id)?.into_iter().next() else {
                continue;
            };
            let visual_type = self.get_educational_visual_plan(video_id, &group.id)?
                .map(|plan| plan.visual_intent).unwrap_or_default();
            entries.push((visual_type, latest.settings_json));
        }
        Ok(aggregate_video_visual_history(&entries))
    }

    /// Saves one AI-planned still (a prompt version + the `educational_visual_plans`
    /// row `create_image_job` checks to decide what needs rendering) — the same
    /// persistence `approve_bulk_plan` used to do only once, for every still, after
    /// a separate manual review step. Called immediately after each batch is
    /// planned instead, so progress survives a pause, a crash, or the app being
    /// closed — there is no longer an in-memory-only "planned but not saved" state.
    /// Returns `None` (without error) for a still that's fully locked (nothing to
    /// change) or that resolved to empty text — the same "skip, don't fail the
    /// batch" behavior `approve_bulk_plan` had.
    fn persist_bulk_planned_still(
        &self,
        video_id: &str,
        style_directive: &str,
        group: &PlanGroup,
        row: &serde_json::Value,
        mut still: V2PlanStillResponse,
    ) -> Result<Option<BulkPlannedStill>, String> {
        if group.settings_locked && group.prompt_locked {
            return Ok(None);
        }
        let now = Utc::now().to_rfc3339();
        let settings_json = if group.settings_locked {
            self.list_prompt_versions(video_id, &group.id)?.into_iter().next()
                .map(|p| p.settings_json).unwrap_or_else(|| "{}".into())
        } else {
            if let Some(obj) = still.image_settings.as_object_mut() {
                obj.insert("_coreVisualDevice".to_string(), json!(still.core_visual_device));
            }
            still.image_settings.to_string()
        };
        let user_prompt = if group.prompt_locked {
            self.list_prompt_versions(video_id, &group.id)?.into_iter().next()
                .map(|p| p.user_prompt).unwrap_or_default()
        } else {
            still.user_prompt.clone()
        };
        if user_prompt.trim().is_empty() {
            return Ok(None);
        }
        let next_version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE video_id=?1 AND group_id=?2",
            params![video_id, &group.id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let pv_id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO prompt_versions(id,video_id,group_id,version,settings_json,system_prompt,user_prompt,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![pv_id, video_id, &group.id, next_version, &settings_json, style_directive, &user_prompt, &now],
        ).map_err(|e| e.to_string())?;
        let still_id = self.get_educational_visual_plan(video_id, &group.id)?
            .map(|plan| plan.still_id).unwrap_or_else(|| Uuid::new_v4().to_string());
        let signature = format!("v2-bulk|{}|{}|{}", EDUCATIONAL_VISUAL_PLANNER_VERSION, video_id, group.id);
        self.connection.execute(
            "INSERT INTO educational_visual_plans(still_id,video_id,visual_plan_row_id,educational_objective,visual_intent,subject_strategy,image_settings_json,user_prompt,plan_signature,visual_strategy_mode,planner_version,created_at,updated_at)
             VALUES(?1,?2,?3,'Planned',?4,'Single Subject',?5,?6,?7,'Auto Educational',?8,?9,?9)
             ON CONFLICT(still_id) DO UPDATE SET educational_objective='Planned',visual_intent=excluded.visual_intent,subject_strategy='Single Subject',image_settings_json=excluded.image_settings_json,user_prompt=excluded.user_prompt,plan_signature=excluded.plan_signature,updated_at=excluded.updated_at",
            params![still_id, video_id, &group.id, &still.visual_type, &settings_json, &user_prompt, &signature, EDUCATIONAL_VISUAL_PLANNER_VERSION, &now],
        ).map_err(|e| e.to_string())?;
        Ok(Some(BulkPlannedStill {
            visual_plan_row_id: group.id.clone(),
            ordinal: row["ordinal"].as_i64().unwrap_or(0),
            narration_preview: row["narration"].as_str().unwrap_or_default().chars().take(110).collect(),
            timestamp_start: row["startSeconds"].as_f64().unwrap_or(0.0),
            timestamp_end: row["endSeconds"].as_f64().unwrap_or(0.0),
            visual_type: still.visual_type,
            image_settings: serde_json::from_str(&settings_json).unwrap_or_else(|_| json!({})),
            user_prompt,
            reason: still.reason,
            settings_locked: group.settings_locked,
            prompt_locked: group.prompt_locked,
        }))
    }

    /// Writes (overwriting) a plain-language log of every still's narration
    /// alongside its current final generation prompt, to
    /// `{video}/visual-plan/prompt-log.md` — refreshed after every Bulk
    /// Generation batch so it always reflects the live plan rather than a
    /// stale snapshot from whenever bulk gen first ran. Best-effort: an I/O
    /// failure here is returned as an error but callers may choose to treat
    /// it as non-fatal to the batch that triggered it.
    fn write_bulk_prompt_log(&self, video_id: &str) -> Result<(), String> {
        let plan = self.get_visual_plan(video_id)?;
        let (channel_id, video_title): (String, String) = self.connection.query_row(
            "SELECT channel_id,title FROM videos WHERE id=?1", [video_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?;
        let dir = self.projects_dir.join(&channel_id).join(video_id).join("visual-plan");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let mut doc = format!(
            "# Bulk Generation prompt log — {video_title}\n\n{} stills. Regenerated automatically after every Bulk Generation batch — this always reflects the current plan, not a one-time snapshot.\n\n",
            plan.groups.len(),
        );
        for group in &plan.groups {
            let narration = group.sentence_ids.iter()
                .filter_map(|id| plan.sentences.iter().find(|s| &s.id == id))
                .map(|sentence| sentence.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let Some(latest) = self.list_prompt_versions(video_id, &group.id)?.into_iter().next() else {
                continue;
            };
            doc.push_str(&format!("## Still {} — {}\n\n", group.ordinal, group.label));
            doc.push_str(&format!(
                "**Narration:** {}\n\n**Prompt:** {}\n\n---\n\n",
                if narration.trim().is_empty() { "(no narration)" } else { narration.trim() },
                latest.user_prompt.trim(),
            ));
        }
        fs::write(dir.join("prompt-log.md"), doc).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Plans AND persists ONE batch of stills, starting at `start_index` in
    /// ordinal order — the resumable, incrementally-committing replacement
    /// for the old `plan_bulk_visuals` (which planned the entire video in
    /// one long call, held every result only in memory, and needed a
    /// separate manual "approve" step before anything was saved or
    /// generation could start). The frontend drives a full run by calling
    /// this repeatedly, advancing its own index by `plannedCount` each time
    /// — the exact same pattern already used for per-still "Auto
    /// Educational" prompt preparation — checking a pause/stop flag between
    /// calls. Because every batch is committed to the database the moment
    /// it's planned, pausing mid-run (or the app closing) never loses
    /// completed work, and there's nothing left to "approve" afterward:
    /// once the run reaches the end, the caller can queue generation
    /// immediately.
    pub fn plan_bulk_visuals_batch(
        &self,
        video_id: &str,
        style_directive: &str,
        base_settings_json: &str,
        creative_instruction: &str,
        character_consistency: bool,
        selected_group_ids: &[String],
        start_index: usize,
    ) -> Result<BulkPlanBatchResult, String> {
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        let gemini_auth = if claude_cli {
            self.gemini_auth().ok()
        } else {
            Some(self.gemini_auth()?)
        };
        if gemini_auth.is_none() && !claude_cli {
            return Err("A logged-in Claude Code CLI, or a Gemini API key, is required for Bulk planning. Run `claude` once to log in, or add a Gemini key in Settings.".into());
        }
        // Upper bound on how many stills a single AI planning call covers —
        // no longer the primary chunking unit (a scene boundary always wins,
        // see below), just a prompt-size safety cap for scenes larger than
        // this.
        let chunk_size: usize = if claude_cli || gemini_auth.is_none() { 6 } else { 3 };
        let visual_plan = self.get_visual_plan(video_id)?;
        if visual_plan.groups.is_empty() {
            return Err("No stills found. Generate a visual plan first.".into());
        }
        // The caller (the Bulk Generation panel) hands us exactly the stills
        // the user selected, in scene-then-ordinal order — everything below
        // operates on this filtered/reordered list, not the full plan.
        // Unknown ids (e.g. a still deleted between selection and this call)
        // are silently skipped rather than erroring.
        let groups_by_id: std::collections::HashMap<&str, &PlanGroup> =
            visual_plan.groups.iter().map(|group| (group.id.as_str(), group)).collect();
        let selected_groups: Vec<PlanGroup> = selected_group_ids.iter()
            .filter_map(|id| groups_by_id.get(id.as_str()).map(|group| (*group).clone()))
            .collect();
        if selected_groups.is_empty() {
            return Err("No stills selected.".into());
        }
        let total = selected_groups.len();
        if start_index >= total {
            return Ok(BulkPlanBatchResult { planned_count: 0, total_stills: total, last_ordinal: 0, done: true });
        }
        let mut row_data: Vec<serde_json::Value> = Vec::with_capacity(total);
        for group in &selected_groups {
            let members: Vec<_> = group.sentence_ids.iter()
                .filter_map(|id| visual_plan.sentences.iter().find(|s| &s.id == id)).collect();
            let narration = members.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
            let start = members.first().map(|s| s.start_seconds).unwrap_or(0.0);
            let end = members.last().map(|s| s.end_seconds).unwrap_or(start);
            let existing_prompt = self.list_prompt_versions(video_id, &group.id)?.into_iter().next();
            row_data.push(json!({
                "visualPlanRowId": group.id,
                "ordinal": group.ordinal,
                "type": group.kind,
                "startSeconds": start,
                "endSeconds": end,
                "narration": narration,
                "settingsLocked": group.settings_locked,
                "promptLocked": group.prompt_locked,
                "existingSettings": existing_prompt.as_ref()
                    .and_then(|p| serde_json::from_str::<serde_json::Value>(&p.settings_json).ok()),
                "existingPrompt": existing_prompt.as_ref().map(|p| p.user_prompt.as_str()),
            }));
        }
        self.save_app_setting(
            &format!("character_consistency.{video_id}"),
            if character_consistency { "true" } else { "false" },
        )?;
        // A chunk never spans two scenes (see chunk_end below), so the scene
        // the still at start_index belongs to is this whole call's scene —
        // any bulk_scene_settings override for it replaces the matching
        // global param for this call only.
        let current_scene_id = selected_groups[start_index].scene_id.clone();
        let scene_settings = match &current_scene_id {
            Some(id) => self.get_bulk_scene_settings(video_id)?.into_iter().find(|s| &s.scene_id == id),
            None => None,
        };
        let global_visual = self.get_bulk_global_settings(video_id)?;
        let EffectiveBulkSettings {
            style_directive: effective_style_directive,
            creative_instruction: effective_creative_instruction,
            character_consistency: effective_character_consistency,
            reference_asset_id: effective_reference_asset_id,
            location_consistency: effective_location_consistency,
            location_reference_asset_id: effective_location_reference_asset_id,
            dials: effective_dials,
        } = resolve_effective_bulk_settings(
            scene_settings.as_ref(), style_directive, creative_instruction, character_consistency, &global_visual,
        );
        // Character description is a real vision API call — expensive enough
        // that it's worth caching across batches (a fresh function call per
        // batch has no in-memory way to reuse it otherwise). Invalidated by
        // simply toggling Character Consistency off and back on with a new
        // reference image (see the frontend), which is the only time the
        // cached description would ever go stale. Scoped per-scene only when
        // that scene actually overrides the reference image — a scene that
        // only overrides character_consistency (on/off) still shares the
        // global description/reference, so it shares the global cache entry
        // too.
        let character_block = if effective_character_consistency {
            let cache_key = match (&current_scene_id, &effective_reference_asset_id) {
                (Some(scene_id), Some(_)) => format!("character_description.{video_id}.{scene_id}"),
                _ => format!("character_description.{video_id}"),
            };
            let description = match self.get_app_setting(&cache_key)? {
                Some(cached) if !cached.trim().is_empty() => cached,
                _ => {
                    let description = self.character_description_for_video(
                        video_id, &gemini_auth, effective_reference_asset_id.as_deref(),
                    )?;
                    self.save_app_setting(&cache_key, &description)?;
                    description
                }
            };
            format!(
                "\n\n════════════════════════════════════════\n\
                 MANDATORY CHARACTER CONSISTENCY — NON-NEGOTIABLE\n\
                 ════════════════════════════════════════\n\
                 This rule governs IDENTITY ONLY — it does NOT mean the character must appear in every\n\
                 still. IF a still genuinely depicts a character, protagonist, or narrator figure, THEN\n\
                 that figure MUST be this EXACT same character, described from the user's reference image:\n\n\
                 {}\n\n\
                 Maintain this character's species/type, physical proportions, coloring, and distinguishing\n\
                 features consistently across every still that DOES include them — do not redesign or vary\n\
                 their physical identity between stills. Clothing/attire is the one exception: do NOT keep it\n\
                 fixed — design each still's outfit to fit that still's own narration, setting, weather, and\n\
                 activity (e.g. a coat in a cold-weather scene, workout clothes in an exercise scene), the\n\
                 same way you would for any other subject.\n\n\
                 WHEN TO OMIT THE CHARACTER (do this deliberately, not as an afterthought):\n\
                 - Second-person (\"you\") narration describing an internal state, a fact, a process, a\n\
                   diagram, a statistic, an object, or an environment does NOT require a literal on-screen\n\
                   character — express it through the object/environment/diagram/abstraction alone instead.\n\
                 - For any visualType other than Character Scene or Character Close-Up / Reaction, do NOT\n\
                   include this character at all — not even a partial glimpse (hand, silhouette, shadow,\n\
                   reflection) — unless the still is literally impossible to plan without them.\n\
                 - Budget: across the WHOLE video, this character should appear in roughly a THIRD of\n\
                   stills, not most or all of them. If the running share for this batch (accounting for\n\
                   prior batches in the context below) is already near or above that, plan the remaining\n\
                   stills in this batch WITHOUT the character.\n\
                 SELF-CHECK before finalizing this batch: count how many of your planned stills include the\n\
                 character. If it is more than roughly a third, revise the weakest justifications — the ones\n\
                 where the character isn't doing anything the scene actually needs — to remove them.\n\
                 ════════════════════════════════════════\n",
                description.trim()
            )
        } else {
            String::new()
        };

        // Location Consistency's own cached-description block — same
        // caching shape as character_block just above (per-scene cache key
        // only when the scene overrides the location reference itself),
        // but text-only: unlike the character reference, the location
        // reference image is NOT attached to the actual generation call
        // here (planning has no image output to condition), only used to
        // derive this description. See generate_image_render for where a
        // location reference image DOES get attached to the render itself.
        let location_block = if effective_location_consistency {
            let cache_key = match (&current_scene_id, &effective_location_reference_asset_id) {
                (Some(scene_id), Some(_)) => format!("location_description.{video_id}.{scene_id}"),
                _ => format!("location_description.{video_id}"),
            };
            let description = match self.get_app_setting(&cache_key)? {
                Some(cached) if !cached.trim().is_empty() => cached,
                _ => {
                    let description = self.location_description_for_video(
                        video_id, &gemini_auth, effective_location_reference_asset_id.as_deref(),
                    )?;
                    self.save_app_setting(&cache_key, &description)?;
                    description
                }
            };
            format!(
                "\n\n════════════════════════════════════════\n\
                 LOCATION CONSISTENCY\n\
                 ════════════════════════════════════════\n\
                 Whenever a still's narration places its subject in this recurring setting, depict THIS\n\
                 EXACT location, described from the user's reference image:\n\n\
                 {}\n\n\
                 Keep architecture, layout, scale, and characteristic materials/colors consistent with this\n\
                 description across every still set here. Weather, time of day, lighting, and who/what is\n\
                 present may still vary freely per still — only the place's own physical identity is fixed.\n\
                 Do not force this location into stills whose narration clearly belongs somewhere else.\n\
                 ════════════════════════════════════════\n",
                description.trim()
            )
        } else {
            String::new()
        };

        let chunk_end = bulk_batch_chunk_end(&selected_groups, start_index, chunk_size);
        let chunk = &row_data[start_index..chunk_end];
        let prior_context = self.bulk_plan_prior_context(video_id, &selected_groups, start_index, 12)?;
        // The "whole script" half of continuity/diversity — bulk_plan_prior_context
        // above only sees roughly the last 12 stills, which is enough for
        // local B-roll-style continuity but not enough to know whether a
        // "no more than 30% of the whole video" rule (see SETTINGS
        // DIVERSITY below) is actually being kept on a long video.
        let video_history = self.video_visual_history(video_id, &visual_plan.groups)?;
        let video_history_block = if video_history.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nWHOLE-VIDEO SETTINGS TALLY SO FAR ({} stills already planned, not just this batch or the recent context above) — use this to actually check the SETTINGS DIVERSITY and ANTI-REPETITION rules below, which are measured across the WHOLE video, not just what you can see nearby:\n{}\n",
                video_history.total_planned,
                video_history.summary_text(),
            )
        };
        // Story context: a genuine whole-script understanding (computed
        // once, cached, read the ENTIRE script — see
        // script_understanding_for_video's doc comment for how this differs
        // from the segmentation engine's own per-sentence passes) plus this
        // batch's scene's own already-computed narrative summary, which
        // existed in the database before this but was never read by
        // planning until now. Best-effort: the whole-script half silently
        // degrades to empty on any failure (no AI credentials, transient
        // error) rather than blocking the batch — there's no user-facing
        // toggle for this, so it should never be why a bulk run fails.
        let script_understanding = self.script_understanding_for_video(video_id, &gemini_auth).unwrap_or_default();
        let current_scene = current_scene_id.as_ref()
            .and_then(|id| visual_plan.scenes.iter().find(|scene| &scene.id == id));
        let story_context_block = format_story_context_block(&script_understanding, current_scene);
        // Visual Director dials (WHAT this batch should show) and Diversity
        // & Consistency Controller dials (HOW it should differ from or
        // match what's already been generated) — user-set levels resolved
        // through the same Global -> Scene hierarchy as everything else
        // above. Absent/unset dials render no line at all, so a video that
        // never touches these controls gets a prompt identical to before
        // they existed.
        let mut director_dial_lines = Vec::new();
        if let Some(value) = effective_dials.visual_interpretation {
            director_dial_lines.push(format!(
                "- Visual interpretation: {value}/100 (0 = depict the narration literally, 100 = favor a conceptual/creative take over a literal one)."
            ));
        }
        if let Some(value) = effective_dials.visual_metaphor {
            director_dial_lines.push(format!(
                "- Visual metaphor: {value}/100 (0 = avoid metaphor, depict things directly, 100 = actively reach for symbolic/metaphorical imagery where the narration supports it)."
            ));
        }
        if let Some(value) = effective_dials.cinematic_intensity {
            director_dial_lines.push(format!(
                "- Cinematic intensity: {value}/100 (0 = documentary/plain photographic framing, 100 = heightened, dramatic, Hollywood-style cinematography)."
            ));
        }
        if let Some(value) = effective_dials.prompt_creativity {
            director_dial_lines.push(format!(
                "- Prompt creativity: {value}/100 (0 = describe only what the narration states, plainly, 100 = elaborate the scene substantially beyond the literal sentence — added sensory/environmental detail, richer staging)."
            ));
        }
        if let Some(mood) = effective_dials.mood.as_deref().filter(|m| !m.trim().is_empty()) {
            let mode = effective_dials.mood_mode.as_deref().unwrap_or("ai");
            if mode == "user" {
                director_dial_lines.push(format!(
                    "- Mood: hold close to \"{mood}\" for every still in this batch unless a still's own narration genuinely conflicts with it."
                ));
            } else {
                director_dial_lines.push(format!(
                    "- Mood: \"{mood}\" is the user's preferred default — lean toward it, but you may still choose a different mood per still where the narration clearly calls for one."
                ));
            }
        }
        let visual_director_block = if director_dial_lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nVISUAL DIRECTOR SETTINGS — WHAT these stills should show (user-set):\n{}\n",
                director_dial_lines.join("\n"),
            )
        };
        fn diversity_word(value: i64) -> &'static str {
            if value >= 75 { "very high" } else if value >= 55 { "high" } else if value >= 35 { "moderate" } else if value >= 15 { "low" } else { "very low" }
        }
        fn consistency_word(value: i64) -> &'static str {
            if value >= 75 { "very strict" } else if value >= 55 { "strict" } else if value >= 35 { "moderate" } else if value >= 15 { "loose" } else { "very loose" }
        }
        let mut diversity_dial_lines = Vec::new();
        if let Some(value) = effective_dials.diversity_camera {
            diversity_dial_lines.push(format!("- Camera angle diversity: {} ({value}/100) — vary cameraAngle between stills accordingly, independent of the other settings diversity rules below.", diversity_word(value)));
        }
        if let Some(value) = effective_dials.diversity_composition {
            diversity_dial_lines.push(format!("- Composition diversity: {} ({value}/100) — vary composition/framing/subject placement between stills accordingly.", diversity_word(value)));
        }
        if let Some(value) = effective_dials.diversity_shot_type {
            diversity_dial_lines.push(format!("- Shot type diversity: {} ({value}/100) — vary visualType/shot scale between stills accordingly, on top of (not instead of) the ANTI-REPETITION rule below.", diversity_word(value)));
        }
        if let Some(value) = effective_dials.consistency_character {
            diversity_dial_lines.push(format!("- Character identity strictness: {} ({value}/100) — how tightly the character description above must be followed when the character does appear (higher = must match precisely; lower = the description is loose inspiration, more variation is acceptable).", consistency_word(value)));
        }
        if let Some(value) = effective_dials.consistency_location {
            diversity_dial_lines.push(format!("- Location identity strictness: {} ({value}/100) — how tightly the location description above must be followed when that setting appears.", consistency_word(value)));
        }
        if let Some(value) = effective_dials.consistency_style {
            diversity_dial_lines.push(format!("- Style directive strictness: {} ({value}/100) — how tightly the Style directive above should be followed versus treated as loose inspiration.", consistency_word(value)));
        }
        let diversity_controller_block = if diversity_dial_lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nDIVERSITY & CONSISTENCY CONTROLLER SETTINGS — HOW these stills should differ from (or match) what's already been generated (user-set):\n{}\n",
                diversity_dial_lines.join("\n"),
            )
        };
        let director_note = if effective_creative_instruction.trim().is_empty() {
            String::new()
        } else {
            format!(
                "\n\n════════════════════════════════════════\n\
                 MANDATORY CREATIVE RULES — NON-NEGOTIABLE\n\
                 ════════════════════════════════════════\n\
                 The following rules were set by the user and override any other planning preference.\n\
                 They MUST be applied to EVERY still in this batch without exception:\n\n\
                 {}\n\n\
                 HOW TO EMBED THESE RULES IN userPrompt (mandatory — not optional):\n\
                 1. POSITIVE rules (include X / always show Y / use Z / feature W):\n\
                    → Weave the required subject, character, or element directly into the scene description as a concrete physical presence.\n\
                    → If the rule contains style words such as realistic, animated, cartoon, 3D, anime, cinematic, or illustration, treat those as Style Directive content and do NOT copy those words into userPrompt.\n\
                    → Example rule \"always include the orange cat\" → userPrompt must contain the orange cat as an active participant in every scene.\n\
                 2. NEGATIVE rules (avoid X / no Y / never Z / do not show W / exclude V):\n\
                    → Parse every avoidance directive and collect them.\n\
                    → Append them at the END of the userPrompt in this exact format: [Avoid: item1, item2, item3]\n\
                    → Also reflect the avoidance in your choice of visualType and imageSettings where applicable.\n\
                 3. Both positive and negative rules must be clearly visible in the output userPrompt — a reviewer must be able to confirm compliance by reading the userPrompt alone.\n\
                 ════════════════════════════════════════\n",
                effective_creative_instruction.trim()
            )
        };
        let prompt = format!(
            r#"You are an Educational Visual Director planning an entire video, not isolated stills.
{story_context_block}
Style directive: {effective_style_directive}
Base image settings: {base_settings_json}{director_note}{character_block}{location_block}{visual_director_block}{diversity_controller_block}
Total stills in video: {total}. This batch covers stills {} of {total} (selected for this run).
Previously planned context (chronological; includes earlier batches and must guide continuity, emotional variety, and non-repetition): {}{video_history_block}

Current batch rows to plan:
{}

════════════════════════════════════════
VISUAL DIRECTOR — decide WHAT each still shows
════════════════════════════════════════
CORE GOAL: Ask "What image best helps the viewer understand this concept?" — never "What literally matches the sentence?"

LITERAL-TRANSLATION TRAP (the most common planning mistake — watch for this specifically):
- If the narration states a number ("10 reasons", "twelve followers", "ten thousand attempts"), do NOT render that number as a literal count of objects, people, or items in the image (ten steps, twelve people, thousands of coins). Convey the IDEA the number represents — scale, imbalance, rarity, crowding — never a countable illustration of the digit itself.
- If the narration already contains its own figure of speech, analogy, or borrowed image ("you're looking at a lottery winner", "the invisible dice", "a custom-built house", "one side of a coin"), do NOT simply stage that exact image. That is the sentence's own crutch, not a visual plan — invent an independent translation of the underlying point instead. Treat the sentence's specific words as what to communicate, never as a literal shot list of what to draw.
- Before finalizing a still, ask: "if this exact idea were phrased in a completely different sentence, would I still draw this image?" If the image only makes sense because of this sentence's specific word choice, it has failed this check — revise it.

EXPRESSIVE STORYTELLING LAYER (required, not a style):
- Every still needs a clear emotional beat or physical tension that helps the viewer feel the idea, not just identify the subject.
- For people, animals, or character-like subjects: make the subject visibly expressive through action, posture, gesture, facial reaction, eye direction, body tension, interaction, or relationship to another subject/object.
- For object, environment, diagram, map, or infographic stills: express emotion through physical consequences, contrast, stakes, motion, arrangement, scale, proximity, damage, comfort, isolation, pressure, relief, or discovery.
- Vary emotional energy across adjacent stills: curiosity, surprise, worry, relief, tenderness, urgency, triumph, hesitation, focus, confusion, wonder. Do not repeat neutral standing/sitting/watching beats.
- userPrompt should name physical emotion signals only when they are visible scene content, e.g. "a child gripping a blanket and peering from behind a doorway", "a tired worker rubbing their forehead beside scattered notes", "a fish darting away from a sudden ripple".
- Keep expression choices faithful to narration and previous planned context. Use the previous context above to continue the story and avoid repeating the same pose, emotion, environment, or subject arrangement across batches.

INTERNAL TARGET DISTRIBUTION (soft targets; do not force inappropriate visuals):
Character Scene 20-28%; Character Close-Up / Reaction 2-6%; Behavioral Demonstration 8-14%; Close Detail 8-14%; Environmental Scene 5-10%; Object Focus 4-8%; Comparison 8-13%; Before/After or Transformation 6-12%; Size / Scale Comparison 1-4%; Process Illustration 4-8%; Timeline 5-9%; Title / Statement Card 10-18%; Textless Infographic 3-8%; Scientific Diagram 2-6%; Family Tree / Lineage Diagram 0-4%; Geographic Map 0-4%; Concept Visualization 2-8%; POV Scene 0-5%; Symbolic Representation 2-8%; Documentary Frame 3-10%.

NEW VISUAL TYPE DEFINITIONS (use these exact meanings):
- Character Close-Up / Reaction: a face/character shown close-up conveying a specific emotion or reaction — distinct from a wider Character Scene.
- Before/After or Transformation: two states of the SAME subject shown to contrast a change over time.
- Size / Scale Comparison: subjects drawn at relative scale to each other (e.g. two animals sized against one another).
- Title / Statement Card: a still composed to carry a short on-screen punchline or chapter statement — generous negative space, low visual complexity, uncluttered background so a caption overlay has room. Also covers a posed question or an unrelated relatable analogy scene standing in for an abstract idea.
- Family Tree / Lineage Diagram: a branching ancestry/relationship diagram — distinct from a generic Scientific Diagram.

════════════════════════════════════════
DIVERSITY & CONSISTENCY CONTROLLER — decide HOW each still should differ from, or match, the others
════════════════════════════════════════
ANTI-REPETITION (enforce strictly):
- Never assign the same visualType to more than 3 consecutive stills.
- Vary subject framing, environment structure, and subject count across stills.
- For animal/nature/documentary videos: mix types — character scene, close detail, object focus, environment only, comparison, diagram — do not show only character portraits.

RECURRING SYMBOL TRACKING: an abstract idea (luck, a hidden mechanism, a process, a hidden truth) often recurs across a video — when it does, do not reach for the same literal object every time it comes up. Each still in the "Previously planned context" below carries a `coreVisualDevice` field naming exactly which concrete symbol/object it already used — if the idea you're planning for now has come up before, check that list and choose a genuinely different concrete image, not a repeat of the same prop or scene shape.

COMPOSITIONAL DEVICE VARIETY: a split-screen / mirrored-panel / before-after layout is a legitimate device for a genuine two-state contrast, but must not become the default solution for every contrast or every "Number N" transition. Reserve it for moments that specifically need two states shown at once side by side, and vary how you visualize contrast the rest of the time instead — a single image carrying visible tension or change, a sequence built across consecutive stills rather than one split image, a before/after implied through one telling detail rather than a literal divided frame.

NARRATIVE POINT CONTINUITY (decide this FIRST, before applying SETTINGS DIVERSITY below):
- A "point" is one idea, claim, scene, or beat in the narration — usually spanning several consecutive stills before the narration moves on to its next distinct idea.
- For each still, judge whether its narration is still elaborating the SAME point as the still immediately before it, or whether the narration has moved on to a NEW point.
- SAME point as previous still → keep `lighting`, `colorTemperature`, `weatherAtmosphere`, and the implied location/background/environment CONSISTENT with the previous still (do not re-roll them just to satisfy the diversity targets below — those targets are measured across points, not within one). Still make the still visually distinct by varying framing/technical settings instead: cameraAngle, composition, lensType, depthOfField, focusType, contrast, motion, shadowType, saturation. Think "same scene, different shot" — like real B-roll of one continuous moment, not a slideshow of unrelated images.
- NEW point vs. the previous still → this is a fresh scene: freely re-choose background, lighting, colorTemperature, and weatherAtmosphere per the SETTINGS DIVERSITY rules below.
- The "no single value in more than 30%" and "full daily cycle" targets below apply across point transitions over the whole video, not still-to-still — do not break same-point continuity just to hit them early.

SETTINGS DIVERSITY — the AI defaults to warm/golden/indoor; actively counter this bias:
- No single value for `lighting`, `colorTemperature`, or `weatherAtmosphere` may appear in more than 30% of stills across the video.
- Time-of-day implied by lighting must span the full daily cycle across the video: include daytime, late-afternoon, dusk/blue-hour, night, overcast, and dawn — do not cluster everything in golden-hour daytime.
- `colorTemperature` must spread across Warm, Neutral, AND Cool stills — all three bands must appear.
- Consecutive stills that start a NEW point must NOT share both the same `lighting` AND the same `colorTemperature` as the point that preceded them — vary at least one. Consecutive stills continuing the SAME point are exempt from this (see NARRATIVE POINT CONTINUITY above) — keep them matching on purpose.
- Location default: if the narration does not explicitly place the subject indoors, choose an EXTERIOR or NATURE setting. Resist defaulting to "home", "office", "classroom", or "bedroom" unless the narration forces it.

IMAGE SETTINGS RULES — provide ALL of the following keys; never leave any as "Undefined":
BASIC: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere
ADVANCED: lensType, lightDirection, lightQuality, shadowType, contrast, focusType, exposure, motion, composition, saturation, vignette, grainIntensity, colorCastTint, surfaceEffects

Field value guidance:
- cameraAngle: Wide Shot | Medium Shot | Close Up | Extreme Close Up | Birds Eye View | Worms Eye View | Low Angle | High Angle | Eye Level | Over the Shoulder | Dutch Angle | Establishing Shot | Point of View POV
- lighting: Natural Daylight | Golden Hour | Blue Hour Dusk | Overcast Soft Diffused | Studio Lighting | Backlit Silhouette | Low Key Dark | High Key Bright | Night Moonlit | Candlelight Firelight | Window Light | Neon Lit
- mood: Serene Peaceful | Tense Anxious | Dramatic Intense | Warm and Cozy | Cold Distant | Mysterious | Cheerful Upbeat | Melancholic | Hopeful | Playful | Triumphant
- depthOfField: Shallow Blurred Background | Deep Everything Sharp | Medium | Macro Extreme Close Focus | Bokeh Heavy
- colorTemperature: Very Warm Golden | Warm | Neutral | Cool | Very Cool Blue Tinted | Mixed Contrasting Warm Cool
- weatherAtmosphere: Clear | Foggy Misty | Rainy | Overcast Sky | Snowy | Hazy Dusty | Stormy | Steamy Humid
- lensType: Wide Angle | Standard Normal | Telephoto | Macro | Fisheye | Tilt Shift Lens | Anamorphic
- lightDirection: Front Lighting | Backlighting | Side Lighting | Top Lighting | Rim Lighting | Bottom Underlighting
- lightQuality: Hard Direct Light | Soft Diffused Light | Dappled Light | Reflected Bounced Light | Mixed
- shadowType: Hard Defined Shadows | Soft Graduated Shadows | No Shadow | Long Dramatic Shadows | Subtle Ambient
- contrast: High Contrast | Medium Contrast | Low Contrast | Flat | Cinematic S-Curve
- focusType: Sharp Overall | Selective Focus | Rack Focus Effect | Soft Focus Dreamy
- exposure: Standard | Slightly Overexposed | Slightly Underexposed | High Key | Low Key | HDR Look
- motion: Static | Slight Motion Blur | Dynamic Motion Blur | Frozen Action | Long Exposure Light Trail
- composition: Rule of Thirds | Center Symmetry | Leading Lines | Framing Within Frame | Negative Space | Diagonal Tension | Golden Ratio
- saturation: Highly Saturated Vivid | Natural | Muted | Desaturated | Black and White Greyscale
- vignette: None | Subtle Vignette | Strong Vignette | Bright Center Vignette
- grainIntensity: None | Light Film Grain | Medium Film Grain | Heavy Film Grain | Digital Noise
- colorCastTint: None | Warm Orange Tint | Cool Blue Tint | Teal and Orange | Green Tint | Sepia | Cross Processed
- surfaceEffects: None | Lens Flare | Chromatic Aberration | Anamorphic Flare | Dust and Scratches | Wet Glass | Fog Layer

Rule: at least 6 of the 20 non-aspect settings must differ between consecutive stills. Within the SAME narrative point, satisfy this through framing/technical fields (cameraAngle, composition, lensType, depthOfField, focusType, contrast, motion, shadowType, saturation, etc.) — NOT by changing lighting, colorTemperature, weatherAtmosphere, or the implied background, which should stay put until the point changes.

USER PROMPT — ABSOLUTE RULES (the most common AI planning mistake is bleeding image-settings language into userPrompt; read carefully):
The final image is built from THREE completely independent layers — each owns exclusive territory and must NOT overlap:
  Layer A → Style Directive  : global rendering style, art style, color grade, film look, visual treatment
  Layer B → imageSettings    : ALL technical camera/lighting data (the 20 fields above)
  Layer C → userPrompt       : ONLY the physical scene — WHO, WHAT, WHERE, doing WHAT

userPrompt MUST contain: subjects, characters, animals, objects, actions, environment, props, spatial relationships, and visible emotional/expressive cues when a subject is present.
userPrompt MUST NOT copy, paraphrase, or restate the Style Directive. If the style directive says animated, realistic, 3D, watercolor, cinematic, etc., those words belong ONLY to Layer A and must be absent from userPrompt.
userPrompt MUST NOT contain ANY of the following — these words are BANNED inside userPrompt:
  • Camera/framing words  : shot, angle, frame, lens, perspective, view, close-up, wide, macro, POV, zoom, cinematic
  • Lighting descriptors  : lit, light, lighting, illuminated, glow, bright, dark, shadow, sunlit, backlit, "warm light", "golden light", "soft light", "harsh light", dim, luminous, shimmering, gleaming
  • Color grade / style   : color grade, tones, palette, hue, saturated, vivid, muted, desaturated, warm, cool, teal, orange, sepia, cross-processed
  • Atmosphere as quality : moody, dreamy (only use fog/mist when physically present as weather, not as aesthetic)
  • Depth/focus words     : depth of field, bokeh, sharp, blurred background, in focus, out of focus, dreamy
  • Render/medium/style language: realistic, realism, photorealistic, 4K, HDR, film grain, cinematic, documentary style, animated, animation, cartoon, Pixar, Disney, anime, 3D, CGI, render, rendered, illustration, painting, watercolor, claymation, stop motion, hyper-detailed, highly detailed

SELF-CHECK before writing userPrompt: scan your draft for every banned word above. If any appear → rewrite without them.
✓ CORRECT: "A wolf pack crossing a frozen river at dusk, pine forest on both banks, snow-covered rocks in the foreground"
✗ WRONG:   "A wolf pack bathed in warm golden light crossing a glimmering river, cinematic wide shot with soft bokeh"
✓ CORRECT: "A worried teenager clutching a cracked phone beside an empty bus stop, shoulders raised, eyes fixed on the road"
✗ WRONG:   "A realistic animated teenager in a cinematic frame clutching a phone"
✓ CORRECT: "A wooden desk near a window, a cup of tea, open notebook, potted plant on the sill, morning cityscape outside"
✗ WRONG:   "Softly lit bedroom interior, warm morning light streaming through curtains onto a wooden desk"
If MANDATORY CREATIVE RULES are present above: positive inclusions are woven into the scene description; negative exclusions appear as [Avoid: ...] at the end of the prompt.

TEXTLESS VISUAL RULE (Textless Infographic, Timeline, Geographic Map, Scientific Diagram, Process Illustration, Title / Statement Card, Family Tree / Lineage Diagram):
- Use arrows, icons, silhouettes, spatial layout, visual contrast, before/after, symbolic shapes.
- Do NOT include readable text, labels, words, signs, or fake text in userPrompt.
- For Title / Statement Card specifically: this rule means compose the SCENE for a downstream caption overlay (generous negative space, a clear focal subject off to one side, an uncluttered background) — it does NOT mean render text into the image.

Allowed visualType values: Character Scene; Character Close-Up / Reaction; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Before/After or Transformation; Size / Scale Comparison; Process Illustration; Timeline; Title / Statement Card; Textless Infographic; Scientific Diagram; Family Tree / Lineage Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

You MUST return exactly one plan for every row in the current batch.
OUTPUT FORMAT — NON-NEGOTIABLE: your entire response must be ONE JSON object and NOTHING else. Do not write any introduction, restatement of the task, narration of your planning process, explanation, commentary, or markdown fences before, between, or after it. Do not describe what you are about to plan — just plan it, silently, and output only the resulting JSON. The very first character of your response must be {{ and the very last character must be }}.
{{"plans":[{{"visualPlanRowId":"exact row id","visualType":"...","imageSettings":{{...}},"userPrompt":"scene content — mandatory creative rules embedded; negatives as [Avoid: ...]","coreVisualDevice":"2-6 words naming the concrete symbol/object this still leans on, e.g. 'dice and coin', 'gears', 'split panel: podium vs porch'"}}]}}"#,
            format!("{}-{}", start_index + 1, chunk_end),
            serde_json::to_string_pretty(&prior_context).unwrap_or_default(),
            serde_json::to_string_pretty(chunk).unwrap_or_default(),
        );
        let response = if claude_cli {
            match request_claude_cli_v2_plan(&prompt) {
                Ok(response) => response,
                Err(claude_error) => match gemini_auth.as_ref() {
                    Some(auth) => request_gemini_v2_plan(auth, &prompt).map_err(|gemini_error| {
                        format!("Claude CLI: {claude_error} | Gemini fallback also failed: {gemini_error}")
                    })?,
                    None => return Err(format!("Claude CLI: {claude_error}")),
                },
            }
        } else {
            request_gemini_v2_plan(gemini_auth.as_ref().unwrap(), &prompt)?
        };
        let mut plans_by_id: std::collections::HashMap<String, V2PlanStillResponse> = response.plans
            .into_iter()
            .map(|plan| (plan.visual_plan_row_id.clone(), plan))
            .collect();
        let valid_count = chunk.iter()
            .take_while(|row| {
                row["visualPlanRowId"].as_str()
                    .map(|id| plans_by_id.contains_key(id))
                    .unwrap_or(false)
            })
            .count();
        if valid_count == 0 {
            return Err(format!(
                "No usable plans returned for stills {}-{}. Please retry.",
                start_index + 1, chunk_end
            ));
        }
        let mut batch_plans: Vec<V2PlanStillResponse> = Vec::with_capacity(valid_count);
        for row in chunk.iter().take(valid_count) {
            let id = row["visualPlanRowId"].as_str().unwrap_or_default();
            if let Some(plan) = plans_by_id.remove(id) {
                batch_plans.push(plan);
            }
        }
        // Seed the "no more than 3 consecutive same visualType" check with the
        // run already in progress at the end of prior_context, so a run that
        // crosses this batch's own boundary still gets caught — the repair
        // pass otherwise only ever sees this one batch's slice.
        let (seed_run_type, seed_run_len) = {
            let mut run_type = String::new();
            let mut run_len = 0usize;
            for entry in prior_context.iter().rev() {
                let visual_type = entry.get("visualType").and_then(|v| v.as_str()).unwrap_or_default();
                if run_len == 0 {
                    run_type = visual_type.to_string();
                    run_len = 1;
                } else if visual_type == run_type {
                    run_len += 1;
                } else {
                    break;
                }
            }
            (run_type, run_len)
        };
        repair_excessive_consecutive_visual_types(&mut batch_plans, &chunk[..valid_count], &seed_run_type, seed_run_len);

        let mut planned_count = 0usize;
        let mut last_ordinal = row_data.get(start_index.wrapping_sub(1)).and_then(|row| row["ordinal"].as_i64()).unwrap_or(0);
        for (offset, mut plan) in batch_plans.into_iter().enumerate() {
            let index = start_index + offset;
            let group = &selected_groups[index];
            let row = &row_data[index];
            if row["settingsLocked"].as_bool().unwrap_or(false) {
                if let Some(obj) = row["existingSettings"].as_object() {
                    plan.image_settings = serde_json::Value::Object(obj.clone());
                }
            }
            if row["promptLocked"].as_bool().unwrap_or(false) {
                if let Some(existing) = row["existingPrompt"].as_str() {
                    plan.user_prompt = existing.to_string();
                }
            }
            if let Some(saved) = self.persist_bulk_planned_still(video_id, &effective_style_directive, group, row, plan)? {
                last_ordinal = saved.ordinal;
            }
            planned_count += 1;
        }
        // Best-effort: a log-write failure shouldn't fail an otherwise-successful
        // batch that's already durably saved in the database.
        let _ = self.write_bulk_prompt_log(video_id);

        Ok(BulkPlanBatchResult {
            planned_count,
            total_stills: total,
            last_ordinal,
            done: start_index + planned_count >= total,
        })
    }

    /// Resolves and gates credentials for a motion-graphics engine run
    /// (`analyze_motion_graphics`). OpenAI is preferred (see the Python
    /// engine's module docstring); Gemini credentials are forwarded too so
    /// the engine can fall back to it if OpenAI itself fails (rate limit,
    /// exhausted billing credits) or isn't configured at all — same
    /// OpenAI-primary/Gemini-last-resort pattern used throughout this file.
    /// Reuses gemini_auth() (the exact function every other successful
    /// Gemini call in this app already goes through) rather than re-deriving
    /// credentials independently, so whichever of its two auth paths — a
    /// plain API key, or a Vertex service account — is actually configured
    /// just works here too. The Vertex access token is short-lived (~1hr),
    /// but that's fine: one analysis run completes well within that window.
    /// The Err case from gemini_auth() is intentionally not fatal by itself
    /// (OpenAI alone is a valid setup) — but the reason it failed is
    /// forwarded to the Python engine too (GEMINI_AUTH_ERROR) rather than
    /// silently discarded, so a real, fixable Gemini-side problem doesn't
    /// look identical to "no Gemini configured at all" if OpenAI's own call
    /// also fails. Claude CLI (tried first inside the Python engine — see
    /// its module docstring) needs no key here, just a logged-in `claude` on
    /// PATH, so it alone is enough to skip the final gate below even with no
    /// OpenAI/Gemini configured.
    fn resolve_motion_graphics_credentials(&self) -> Result<MotionGraphicsCredentials, String> {
        let openai_api_key = self.get_provider_key("openai")?;
        let mut gemini_auth_error: Option<String> = None;
        let (gemini_api_key, gemini_vertex): (Option<String>, Option<(String, String)>) =
            match self.gemini_auth() {
                Ok(GeminiAuth::ApiKey(key)) => (Some(key), None),
                Ok(GeminiAuth::Vertex { access_token, project_id }) => (None, Some((access_token, project_id))),
                Err(error) => {
                    gemini_auth_error = Some(error);
                    (None, None)
                }
            };
        #[cfg(not(test))]
        let claude_available = claude_cli_available();
        #[cfg(test)]
        let claude_available = false;
        if openai_api_key.is_none() && gemini_api_key.is_none() && gemini_vertex.is_none() && !claude_available {
            return Err(gemini_auth_error.map(|error| format!(
                "An OpenAI or Gemini API key, or a logged-in Claude Code CLI, is required for Motion Graphics analysis. Add a key in Settings, or run `claude` once to log in. (Gemini: {error})"
            )).unwrap_or_else(|| "An OpenAI or Gemini API key, or a logged-in Claude Code CLI, is required for Motion Graphics analysis. Add a key in Settings, or run `claude` once to log in.".into()));
        }
        Ok(MotionGraphicsCredentials { openai_api_key, gemini_api_key, gemini_vertex, gemini_auth_error })
    }

    /// Assigns every timeline clip that has a rendered image a freely-composed
    /// motion recipe (see services/motion-engine/src/types.ts's `MotionRecipe`
    /// — there's no fixed catalog of named treatments to pick from), by
    /// batching them (image + the clip's own narration text together) through
    /// `services/python-engine/auto_gen_engine/motion_graphics_engine.py` —
    /// see that module's docstring for why this replaced the old per-clip,
    /// image-only, single-OpenAI-call-in-Rust implementation (it converged
    /// heavily on "Ken Burns" with no way to see either the narration or
    /// what neighboring clips had already been assigned). The Python engine
    /// batches clips together and carries forward what earlier clips in the
    /// same video were already given so far across the whole video into every
    /// batch, actively varying the mix instead of picking each clip in a vacuum.
    /// Analyzes AND applies motion graphics for the next batch of not-yet-
    /// analyzed clips (those with a rendered still and no
    /// `motion_graphic_effect` yet) — the resumable, pausable replacement for
    /// the old `analyze_motion_graphics`, which ran the entire video through
    /// one long-lived Python subprocess call with no way to interrupt it
    /// partway through. The frontend drives a full run by calling this
    /// repeatedly until `done`, checking a pause/stop flag between calls —
    /// the same pattern `plan_bulk_visuals_batch` uses. Because a clip's
    /// `motion_graphic_effect` is written to the database the moment its
    /// batch finishes, "resume" is simply calling this again: it naturally
    /// only ever sees clips that don't have one yet, so a pause never redoes
    /// or loses completed work.
    ///
    /// `treatmentHistory` (what earlier, already-analyzed clips in this same
    /// video were given, feeding the engine's own diversity mechanism — see
    /// motion_graphics_engine.py's module docstring) is reconstructed from
    /// the database each call and passed into the manifest, rather than kept
    /// in memory across calls the way it used to accumulate across batches
    /// within one long subprocess run — `run()` now seeds its own
    /// `treatment_history` from this instead of always starting empty.
    pub fn analyze_motion_graphics_batch(
        &self, video_id: &str, engine_dir: &Path,
    ) -> Result<MotionGraphicsBatchResult, String> {
        let credentials = self.resolve_motion_graphics_credentials()?;
        let timeline = self.get_timeline(video_id)?;
        let eligible: Vec<&TimelineClip> = timeline.clips.iter().filter(|clip| clip.render_id.is_some()).collect();
        let total = eligible.len();
        if total == 0 {
            return Err("No stills with a rendered image were found on this timeline.".into());
        }
        let already_done = eligible.iter().filter(|clip| clip.motion_graphic_effect.is_some()).count();
        let remaining: Vec<&TimelineClip> = eligible.iter().copied().filter(|clip| clip.motion_graphic_effect.is_none()).collect();
        if remaining.is_empty() {
            return Ok(MotionGraphicsBatchResult { completed: total, total, done: true });
        }
        let history_all: Vec<String> = eligible.iter().filter_map(|clip| clip.motion_graphic_effect.clone()).collect();
        let treatment_history: Vec<String> = history_all.iter().rev().take(12).rev().cloned().collect();
        let batch: Vec<&TimelineClip> = remaining.into_iter().take(MOTION_GRAPHICS_BATCH_SIZE).collect();

        #[cfg(test)]
        {
            let _ = engine_dir;
            let _ = &credentials;
            let _ = &treatment_history;
            // No Python/network in tests — deterministically cycle through a
            // few fixture labels so callers can still exercise the resulting
            // Timeline shape. The label is free text now (see doc comment
            // above), so any small fixed set works fine here.
            const TEST_FIXTURE_LABELS: [&str; 3] = ["test push", "test reveal", "test drift"];
            for (index, clip) in batch.iter().enumerate() {
                let effect = TEST_FIXTURE_LABELS[index % TEST_FIXTURE_LABELS.len()];
                self.set_timeline_clip_motion_graphic(
                    video_id, &clip.id, Some(effect), Some("{}"), Some("test fixture"),
                )?;
                self.record_ai_motion_graphic_snapshot(&clip.id, effect, "{}", "test fixture")?;
            }
            let completed = already_done + batch.len();
            return Ok(MotionGraphicsBatchResult { completed, total, done: completed >= total });
        }
        #[cfg(not(test))]
        {
            let visual_plan = self.get_visual_plan(video_id)?;
            let narration_for_group = |group_id: &str| -> String {
                let Some(group) = visual_plan.groups.iter().find(|g| &g.id == group_id) else {
                    return String::new();
                };
                group.sentence_ids.iter()
                    .filter_map(|sentence_id| visual_plan.sentences.iter().find(|s| &s.id == sentence_id))
                    .map(|sentence| sentence.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            };

            let channel_id: String = self.connection
                .query_row("SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            let work_dir = self.projects_dir.join(channel_id).join(video_id).join("motion-graphics");
            fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
            let manifest_path = work_dir.join("manifest.json");
            let results_path = work_dir.join("results.json");

            let clip_manifest: Vec<serde_json::Value> = batch.iter().map(|clip| {
                let render_id = clip.render_id.as_ref().expect("filtered to Some above");
                let (mime, base64_data) = self.read_render_file(render_id)?;
                Ok::<_, String>(json!({
                    "clipId": clip.id,
                    "mime": mime,
                    "base64Data": base64_data,
                    "narration": narration_for_group(&clip.group_id),
                    "startSeconds": clip.start_seconds,
                    "endSeconds": clip.end_seconds,
                }))
            }).collect::<Result<_, _>>()?;
            // Only used by the engine's validator pass (renders a few sample
            // frames of each candidate recipe to actually look at — see
            // motion_graphics_engine.py's `_render_validation_frames`), not
            // by composition itself: every recipe field is fraction/percent-
            // based, not absolute-pixel, so this doesn't need to match the
            // eventual real export resolution exactly. Mirrors the same
            // "1080p + configured aspect ratio" default the real export uses
            // (see run_export's own resolution_dimensions call) rather than
            // a value pulled from thin air.
            let settings_raw = self.get_app_setting("image_settings")?.unwrap_or_default();
            let image_settings: serde_json::Value =
                serde_json::from_str(&settings_raw).unwrap_or_else(|_| json!({}));
            let (manifest_width, manifest_height) = resolution_dimensions("1080p", requested_aspect_ratio(&image_settings));
            fs::write(
                &manifest_path,
                serde_json::to_vec(&json!({
                    "clips": clip_manifest,
                    "width": manifest_width,
                    "height": manifest_height,
                    "fps": 30,
                    "treatmentHistory": treatment_history,
                })).unwrap_or_default(),
            ).map_err(|e| e.to_string())?;

            let engine_script = engine_dir.join("auto_gen_engine/motion_graphics_engine.py");
            if !engine_script.exists() {
                return Err(format!(
                    "Internal motion-graphics engine was not found at {}.",
                    engine_script.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&engine_script)
                .arg(&manifest_path)
                .arg("--output")
                .arg(&results_path)
                // This batch's own manifest already contains only ONE
                // batch's worth of clips (see MOTION_GRAPHICS_BATCH_SIZE) —
                // telling the engine its batch size equals the whole
                // manifest keeps its own internal batching from subdividing
                // it further.
                .arg("--batch-size")
                .arg(batch.len().to_string())
                .current_dir(engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            credentials.apply_env(&mut command);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command.output().map_err(|e| format!("Could not start the Python motion-graphics engine: {e}"))?;
            if !output.status.success() {
                return Err(format!("Motion graphics analysis failed. {}", String::from_utf8_lossy(&output.stderr).trim()));
            }

            let results: serde_json::Value = serde_json::from_slice(
                &fs::read(&results_path).map_err(|e| format!("Could not read motion-graphics results: {e}"))?,
            ).map_err(|e| format!("Motion-graphics results were invalid: {e}"))?;
            let analyses = results["analyses"].as_array().ok_or("Motion-graphics results contained no analyses.")?;
            for analysis in analyses {
                let clip_id = analysis["clipId"].as_str().ok_or("Motion-graphics result missing clipId.")?;
                let effect = analysis["effect"].as_str().ok_or("Motion-graphics result missing effect.")?;
                let settings = analysis.get("settings").cloned().unwrap_or_else(|| json!({}));
                let reason = analysis["reason"].as_str().unwrap_or_default();
                let settings_json = serde_json::to_string(&settings).unwrap_or_default();
                self.set_timeline_clip_motion_graphic(
                    video_id, clip_id, Some(effect), Some(&settings_json), Some(reason),
                )?;
                self.record_ai_motion_graphic_snapshot(clip_id, effect, &settings_json, reason)?;
                // Tier 3 of the recipe (see motion_graphics_engine.py) is how
                // this clip hands off to the next one — apply it to the same
                // `transition_out` column a human could otherwise set
                // manually from the Timeline (see VALID_TRANSITIONS), rather
                // than inventing a separate storage path for it.
                if let Some(transition) = settings.get("transitionOut").and_then(|v| v.as_str()) {
                    if VALID_TRANSITIONS.contains(&transition) {
                        self.set_timeline_clip_transition_out(video_id, clip_id, transition)?;
                    }
                }
            }
            let completed = already_done + analyses.len();
            Ok(MotionGraphicsBatchResult { completed, total, done: completed >= total })
        }
    }

    pub fn suggest_still_prompt(&self, video_id: &str, group_id: &str, style_directive: &str, base_settings_json: &str) -> Result<BulkPlannedStill, String> {
        let auth = self.gemini_auth()?;
        let visual_plan = self.get_visual_plan(video_id)?;
        let group = visual_plan.groups.iter().find(|g| g.id == group_id)
            .ok_or("Still not found in visual plan.")?;
        let members: Vec<_> = group.sentence_ids.iter()
            .filter_map(|id| visual_plan.sentences.iter().find(|s| &s.id == id)).collect();
        let narration = members.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        let start = members.first().map(|s| s.start_seconds).unwrap_or(0.0);
        let end = members.last().map(|s| s.end_seconds).unwrap_or(start);
        let existing_prompt = self.list_prompt_versions(video_id, group_id)?.into_iter().next();
        let row = json!({
            "visualPlanRowId": group.id,
            "ordinal": group.ordinal,
            "type": group.kind,
            "startSeconds": start,
            "endSeconds": end,
            "narration": narration,
            "existingSettings": existing_prompt.as_ref()
                .and_then(|p| serde_json::from_str::<serde_json::Value>(&p.settings_json).ok()),
            "existingPrompt": existing_prompt.as_ref().map(|p| p.user_prompt.as_str()),
        });
        let prompt = format!(
            r#"You are an Educational Visual Director suggesting a prompt for a single still image.

Style directive: {style_directive}
Base image settings: {base_settings_json}

Still to plan:
{}

CORE GOAL: Ask "What image best helps the viewer understand this concept?" — never "What literally matches the sentence?"

IMAGE SETTINGS RULES — provide ALL of the following keys; never leave any as "Undefined":
BASIC: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere
ADVANCED: lensType, lightDirection, lightQuality, shadowType, contrast, focusType, exposure, motion, composition, saturation, vignette, grainIntensity, colorCastTint, surfaceEffects

USER PROMPT RULES:
- Describe ONLY the WHAT: subjects, objects, actions, environment for THIS specific narration
- NO cinematography style, color grade, rendering style (those go in Style Directive)
- NO camera angle, lighting type, depth of field, or image-settings terms (those go in imageSettings)
- NO style/medium words in userPrompt, including realistic, realism, photorealistic, animated, animation, cartoon, Pixar, Disney, anime, 3D, CGI, rendered, illustration, painting, watercolor, cinematic, 4K, HDR, or hyper-detailed
- Make the subject expressive when a subject is present: visible action, posture, facial reaction, gesture, body tension, interaction, or relationship to an object/environment
- If there is no character-like subject, express stakes through physical arrangement, contrast, motion, scale, damage, comfort, isolation, pressure, relief, or discovery
- Ask: "What is physically in this image?" — write exactly that

Allowed visualType values: Character Scene; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Process Illustration; Timeline; Textless Infographic; Scientific Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

Return JSON only — one plan object:
{{"plans":[{{"visualPlanRowId":"{}","visualType":"...","imageSettings":{{...}},"userPrompt":"scene content only","reason":"1-2 sentences"}}]}}"#,
            serde_json::to_string(&row).unwrap_or_default(),
            group.id,
        );
        let text = request_gemini_text(&auth, &prompt)?;
        let cleaned = extract_json_from_text(&text);
        let parsed: serde_json::Value = serde_json::from_str(cleaned)
            .map_err(|e| format!("Prompt suggestion was not valid JSON: {e}"))?;
        let plan = parsed.pointer("/plans/0")
            .ok_or("No plan returned.")?;
        let response: V2PlanStillResponse = serde_json::from_value(plan.clone())
            .map_err(|e| format!("Plan had unexpected structure: {e}"))?;
        Ok(BulkPlannedStill {
            visual_plan_row_id: response.visual_plan_row_id,
            ordinal: group.ordinal as i64,
            narration_preview: narration.chars().take(110).collect(),
            timestamp_start: start,
            timestamp_end: end,
            visual_type: response.visual_type,
            image_settings: response.image_settings,
            user_prompt: response.user_prompt,
            reason: response.reason,
            settings_locked: group.settings_locked,
            prompt_locked: group.prompt_locked,
        })
    }

    /// Suggests a short Veo motion prompt for animating a still, grounded in
    /// that still's narration (visual intent) and its existing image prompt
    /// (what's actually depicted) — not just a generic "add motion" request.
    /// Called fresh each time the user clicks "Suggest prompt", so repeated
    /// clicks intentionally return different phrasings/variations rather than
    /// a cached single suggestion.
    pub fn suggest_animation_prompt(&self, video_id: &str, group_id: &str) -> Result<String, String> {
        let auth = self.gemini_auth()?;
        let visual_plan = self.get_visual_plan(video_id)?;
        let group = visual_plan.groups.iter().find(|g| g.id == group_id)
            .ok_or("Still not found in visual plan.")?;
        let members: Vec<_> = group.sentence_ids.iter()
            .filter_map(|id| visual_plan.sentences.iter().find(|s| &s.id == id)).collect();
        let narration = members.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        let existing_still_prompt = self.list_prompt_versions(video_id, group_id)?
            .into_iter().next().map(|p| p.user_prompt);
        // `request_gemini_text` always sets `responseMimeType: application/json`
        // (every other caller needs structured output) — asking it for bare
        // prose under that constraint reliably comes back empty, so this
        // wraps the suggestion in a trivial JSON envelope like every other
        // caller does, rather than fighting the shared helper's contract.
        let prompt = format!(
            r#"You are directing a brief Veo 3 image-to-video animation of a single still image in an explainer video.

Narration spoken while this still is on screen (its visual intent):
{narration}

What the still image actually depicts:
{}

Write ONE short, concrete motion/camera prompt (1-2 sentences, under 40 words) describing ONLY subtle, natural movement to bring this exact still to life — e.g. gentle camera drift/push-in, wind, steam, blinking, small gestures, parallax — that supports (never contradicts) the narration's intent. Do not introduce new subjects, objects, or scene changes not already in the still. Do not mention "Veo," camera brand names, resolution, or duration.

Return JSON only, in exactly this shape: {{"prompt": "the motion prompt text"}}"#,
            existing_still_prompt.as_deref().unwrap_or("(no description available)"),
        );
        let text = request_gemini_text(&auth, &prompt)?;
        let cleaned = extract_json_from_text(&text);
        let parsed: serde_json::Value = serde_json::from_str(cleaned)
            .map_err(|e| format!("Prompt suggestion was not valid JSON: {e}"))?;
        let suggestion = parsed.get("prompt")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .ok_or("No prompt returned.")?;
        if suggestion.is_empty() {
            return Err("Gemini returned an empty prompt suggestion.".into());
        }
        Ok(suggestion.to_string())
    }

    /// Explains why (or whether) a Motion Graphics preset fits a specific
    /// still, for the live per-clip description in the Editor's clip panel.
    /// Text-only and OpenAI-primary/Gemini-fallback (same provider
    /// preference as `analyze_motion_graphics`'s bulk run), unlike that bulk
    /// run this never touches the Python engine or the image bytes
    /// themselves — it reasons from the still's own stored scene
    /// description and narration, which keeps it fast enough to re-run on
    /// every clip selection/preset change.
    pub fn explain_motion_graphic_choice(
        &self, video_id: &str, group_id: &str, effect_label: &str, effect_summary: &str,
    ) -> Result<String, String> {
        let api_key = self.get_provider_key("openai")?;
        let mut gemini_auth_error: Option<String> = None;
        let gemini_auth = match self.gemini_auth() {
            Ok(auth) => Some(auth),
            Err(error) => { gemini_auth_error = Some(error); None }
        };
        if api_key.is_none() && gemini_auth.is_none() {
            return Err(gemini_auth_error.map(|error| format!(
                "An OpenAI or Gemini API key is required. Add one in Settings. (Gemini: {error})"
            )).unwrap_or_else(|| "An OpenAI or Gemini API key is required. Add one in Settings.".into()));
        }
        let visual_plan = self.get_visual_plan(video_id)?;
        let group = visual_plan.groups.iter().find(|g| g.id == group_id)
            .ok_or("Still not found in visual plan.")?;
        let narration = group.sentence_ids.iter()
            .filter_map(|id| visual_plan.sentences.iter().find(|s| &s.id == id))
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let still_description = self.list_prompt_versions(video_id, group_id)?
            .into_iter().next().map(|p| p.user_prompt);
        let prompt = format!(
            r#"You are a motion-graphics director explaining a treatment choice for one still image in an explainer video.

Narration spoken while this still is on screen:
{narration}

What the still image depicts:
{}

The treatment being considered — "{effect_label}": {effect_summary}

In 1-2 sentences (under 45 words), explain why this treatment fits this specific still and narration — or, if it's a poor fit, say so plainly and briefly explain why. Be concrete about this still, not generic. Do not mention "Veo," camera brand names, resolution, or duration.

Return JSON only, in exactly this shape: {{"description": "the explanation text"}}"#,
            still_description.as_deref().unwrap_or("(no description available)"),
        );
        let raw = match &api_key {
            Some(key) => match request_openai_text(key, &prompt) {
                Ok(text) => text,
                Err(openai_error) => match &gemini_auth {
                    Some(auth) => request_gemini_text(auth, &prompt)
                        .map_err(|gemini_error| format!("{openai_error} (Gemini fallback also failed: {gemini_error})"))?,
                    None => return Err(openai_error),
                },
            },
            None => request_gemini_text(gemini_auth.as_ref().expect("checked above"), &prompt)?,
        };
        let cleaned = extract_json_from_text(&raw);
        let parsed: serde_json::Value = serde_json::from_str(cleaned)
            .map_err(|e| format!("Response was not valid JSON: {e}"))?;
        let description = parsed.get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("No description returned.")?;
        Ok(description.to_string())
    }

    pub fn apply_creative_instructions_to_all(
        &self,
        video_id: &str,
        creative_instruction: &str,
        on_progress: impl Fn(usize, usize),
    ) -> Result<usize, String> {
        if creative_instruction.trim().is_empty() {
            return Err("Creative instructions cannot be empty.".into());
        }

        // Collect latest prompt version for each still that has one
        struct StillEntry {
            group_id: String,
            user_prompt: String,
            settings_json: String,
            system_prompt: String,
        }

        let plan = self.get_visual_plan(video_id)?;
        let mut entries: Vec<StillEntry> = Vec::new();
        for group in &plan.groups {
            if let Some(pv) = self.list_prompt_versions(video_id, &group.id)?.into_iter().next() {
                entries.push(StillEntry {
                    group_id: group.id.clone(),
                    user_prompt: strip_avoid_block(&pv.user_prompt),
                    settings_json: pv.settings_json.clone(),
                    system_prompt: pv.system_prompt.clone(),
                });
            }
        }

        if entries.is_empty() {
            return Err("No stills with saved prompts found. Run Bulk Gen Config first.".into());
        }

        let total = entries.len();
        // Claude CLI first — no metered cost, rides whatever Claude
        // subscription is already logged into the CLI on this machine.
        // Gemini is the only fallback — OpenAI has been removed from Bulk
        // Gen planning entirely (see run_claude_cli's doc comment).
        #[cfg(not(test))]
        let claude_cli = claude_cli_available();
        #[cfg(test)]
        let claude_cli = false;
        let gemini_auth = if claude_cli {
            self.gemini_auth().ok()
        } else {
            Some(self.gemini_auth()?)
        };
        if gemini_auth.is_none() && !claude_cli {
            return Err("A logged-in Claude Code CLI, or a Gemini API key, is required to apply creative instructions. Run `claude` once to log in, or add a Gemini key in Settings.".into());
        }
        // Gemini Flash hard-caps output at ~8000 tokens; Claude comfortably supports
        // larger batches — see plan_bulk_visuals for why this sizes for Claude
        // whenever it's the primary path, not just when Gemini is entirely absent.
        let chunk_size: usize = if claude_cli || gemini_auth.is_none() { 6 } else { 3 };
        let now = Utc::now().to_rfc3339();
        let mut applied = 0usize;

        for chunk in entries.chunks(chunk_size) {
            // Use a numeric index (n) for matching — LLMs can corrupt long UUID strings.
            let batch: Vec<_> = chunk.iter().enumerate().map(|(i, s)| json!({
                "n": i + 1,
                "currentUserPrompt": s.user_prompt,
            })).collect();

            let prompt = format!(
                r#"Your task: add creative rules to existing image scene descriptions.
IMPORTANT: DO NOT rewrite, shorten, or remove any existing content. ONLY add what the rules require.

CREATIVE RULES TO EMBED IN EVERY STILL:
{}

HOW TO EMBED:
1. POSITIVE rules (include X / always show Y / always use Z / feature W):
   → Naturally extend the scene description to include the required element as a physical presence.
   → The original scene must remain fully intact — you are adding to it, not replacing it.
2. NEGATIVE rules (avoid X / no Y / never Z / do not include W / exclude V):
   → Collect every avoidance item and append ONE [Avoid: item1, item2, item3] block at the very end.
   → Never embed avoidance language inside the scene description itself.
3. Output the FULL modified userPrompt — not a summary, not a truncation.

STILLS TO MODIFY:
{}

Return JSON only:
{{"results":[{{"n":1,"userPrompt":"full modified prompt"}},{{"n":2,"userPrompt":"full modified prompt"}}]}}"#,
                creative_instruction.trim(),
                serde_json::to_string_pretty(&batch).unwrap_or_default(),
            );

            let response_text = if claude_cli {
                match run_claude_cli(&prompt, &[]) {
                    Ok(text) => text,
                    Err(claude_error) => match gemini_auth.as_ref() {
                        Some(auth) => request_gemini_text(auth, &prompt).map_err(|gemini_error| {
                            format!("Claude CLI: {claude_error} | Gemini fallback also failed: {gemini_error}")
                        })?,
                        None => return Err(format!("Claude CLI: {claude_error}")),
                    },
                }
            } else {
                request_gemini_text(gemini_auth.as_ref().unwrap(), &prompt)?
            };

            let cleaned = extract_json_from_text(&response_text);
            let parsed: serde_json::Value = serde_json::from_str(cleaned)
                .map_err(|_| "AI returned invalid JSON while applying creative instructions.".to_string())?;

            let results = parsed["results"].as_array()
                .ok_or("AI response missing 'results' array.")?;

            for result in results {
                // Match by numeric index — immune to LLM ID corruption.
                let n = result["n"].as_u64().unwrap_or(0) as usize;
                if n < 1 || n > chunk.len() { continue; }
                let entry = &chunk[n - 1];

                let new_prompt = result["userPrompt"].as_str().unwrap_or("").trim();
                if new_prompt.is_empty() { continue; }

                let next_version: i64 = self.connection.query_row(
                    "SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE video_id=?1 AND group_id=?2",
                    params![video_id, &entry.group_id],
                    |row| row.get(0),
                ).map_err(|e| e.to_string())?;

                let pv_id = Uuid::new_v4().to_string();
                self.connection.execute(
                    "INSERT INTO prompt_versions(id,video_id,group_id,version,settings_json,system_prompt,user_prompt,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![pv_id, video_id, &entry.group_id, next_version, entry.settings_json, entry.system_prompt, new_prompt, now],
                ).map_err(|e| e.to_string())?;

                applied += 1;
                on_progress(applied, total);
            }
        }

        Ok(applied)
    }

    pub fn apply_style_directive_to_all(&self, video_id: &str, style_directive: &str) -> Result<usize, String> {
        if style_directive.trim().is_empty() {
            return Err("Style directive cannot be empty.".into());
        }
        // Update system_prompt on every prompt_version for this video.
        // This does NOT change user_prompt or image_settings — only the style layer.
        let count = self.connection.execute(
            "UPDATE prompt_versions SET system_prompt = ?1 WHERE video_id = ?2",
            params![style_directive.trim(), video_id],
        ).map_err(|e| e.to_string())?;
        Ok(count)
    }

    pub fn extract_reference_style(&self, asset_id: &str) -> Result<StyleExtraction, String> {
        let (video_id, relative_path, media_type): (String, String, String) = self.connection.query_row(
            "SELECT video_id,relative_path,media_type FROM input_assets WHERE id=?1 AND kind='reference'",
            [asset_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| "Reference image was not found.".to_string())?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let bytes = fs::read(self.projects_dir.join(channel_id).join(video_id).join(relative_path))
            .map_err(|_| "Reference image file is missing.".to_string())?;
        let auth = self.gemini_auth()?;
        let prompt = "Analyze this image as a reusable production style reference. Return only JSON with styleDirective (string describing art style, rendering, color language, recurring subjects, and visual consistency rules) and imageSettings (object with any of: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, lensType, lightDirection, lightQuality, shadowType, contrast, saturation, composition, motion — use only values strongly supported by the image).";
        let text = request_gemini_vision(&auth, prompt, &media_type, &bytes)?;
        let cleaned = extract_json_from_text(&text);
        serde_json::from_str(cleaned).map_err(|_| format!("Style analysis was not valid JSON. Raw response: {}", text.chars().take(300).collect::<String>()))
    }

    /// Quick pre-generation check that this still's planned prompt/settings
    /// still match the visual intent of its own narration. Plans are
    /// produced in AI batches under token/context pressure (see
    /// `plan_bulk_visuals`) and prompts/settings can also be hand-edited
    /// afterward — both are common ways they drift out of alignment with
    /// what the sentence(s) are actually about. Best-effort: any failure
    /// here (bad JSON, network error) returns None and generation proceeds
    /// with the original prompt/settings rather than blocking on a
    /// validator that couldn't do its job.
    fn validate_visual_intent(
        &self,
        auth: &GeminiAuth,
        narration: &str,
        user_prompt: &str,
        settings_json: &str,
    ) -> Option<(String, String)> {
        if narration.trim().is_empty() {
            return None;
        }
        let check_prompt = format!(
            "You are a quality-control step in an automated video illustration pipeline, checking a \
             single still right before it is generated.\n\n\
             Narration this still represents: \"{narration}\"\n\n\
             Planned image prompt (what will be drawn): \"{user_prompt}\"\n\
             Planned image settings: {settings_json}\n\n\
             Judge only one thing: does the planned prompt actually depict the visual intent of THIS \
             narration — the concept, subject, or moment it describes — rather than something generic or \
             mismatched? Also check whether the settings (mood, lighting, weatherAtmosphere, etc.) \
             contradict the narration's own implied tone or setting (e.g. a cheerful mood for a somber \
             line, indoor lighting for an explicitly outdoor scene).\n\n\
             Return ONLY JSON: {{\"aligned\": boolean, \"correctedUserPrompt\": string or null, \
             \"correctedSettings\": object or null}}.\n\
             If aligned is true, correctedUserPrompt and correctedSettings MUST both be null.\n\
             If aligned is false, correctedUserPrompt MUST be a rewritten prompt that fixes ONLY the \
             mismatch (keep everything that already works), and correctedSettings MUST be the COMPLETE \
             settings object with every original key present, changing only the fields that were \
             actually wrong."
        );
        let raw = request_gemini_text(auth, &check_prompt).ok()?;
        let cleaned = extract_json_from_text(&raw);
        let parsed: serde_json::Value = serde_json::from_str(cleaned).ok()?;
        if parsed.get("aligned").and_then(|v| v.as_bool()).unwrap_or(true) {
            return None;
        }
        let corrected_prompt = parsed.get("correctedUserPrompt").and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())?.to_string();
        let corrected_settings = parsed.get("correctedSettings").filter(|v| v.is_object())?.to_string();
        Some((corrected_prompt, corrected_settings))
    }

    // Post-generation QC gate: looks at the actual rendered pixels (not just the text
    // prompt, unlike validate_visual_intent above) and flags only clear, obvious misses —
    // wrong subject/setting, missing the described action, a garbled render. Deliberately
    // strict about what counts as non-compliant so this triggers a regeneration sparingly,
    // not on every stylistic nitpick.
    fn check_generated_image_compliance(
        &self,
        auth: &GeminiAuth,
        narration: &str,
        user_prompt: &str,
        previous_still_context: Option<&str>,
        image_bytes: &[u8],
        mime: &str,
    ) -> Option<String> {
        if narration.trim().is_empty() {
            return None;
        }
        let continuity_note = match previous_still_context {
            Some(context) => format!(
                "For reference only, here is the immediately preceding still's narration and scene \
                 (context, not a requirement to match): {context}\n\
                 If this still's narration is clearly still the same point/moment as the preceding one, \
                 a similar background/setting is CORRECT, not a defect — do not flag it as repetitive. \
                 If the narration has moved on to a new point, a different background/setting is expected.\n\n"
            ),
            None => String::new(),
        };
        let check_prompt = format!(
            "You are a final quality-control reviewer for one still in an automated video illustration \
             pipeline. You are shown the actual generated image.\n\n\
             Narration this still represents: \"{narration}\"\n\
             Intended scene description: \"{user_prompt}\"\n\n\
             {continuity_note}\
             Judge only clear, obvious problems: does the image depict something recognizably DIFFERENT \
             from the intended scene (wrong subject, wrong setting, missing the described action or \
             object entirely, badly malformed or garbled rendering)? Do NOT flag minor stylistic \
             differences, imperfect anatomy, or subjective composition choices — only flag a still that \
             a viewer would call clearly wrong for this narration.\n\n\
             Return ONLY JSON: {{\"compliant\": boolean, \"reason\": string}}. reason should be a short \
             one-sentence explanation, only populated when compliant is false."
        );
        let raw = request_gemini_vision(auth, &check_prompt, mime, image_bytes).ok()?;
        let cleaned = extract_json_from_text(&raw);
        let parsed: serde_json::Value = serde_json::from_str(cleaned).ok()?;
        if parsed.get("compliant").and_then(|v| v.as_bool()).unwrap_or(true) {
            return None;
        }
        Some(
            parsed.get("reason").and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Did not match the intended scene.")
                .to_string(),
        )
    }

    // Best-effort context about the still immediately before this one (by ordinal), used
    // only to help check_generated_image_compliance judge whether a similar background is
    // intentional continuity or an actual repetition defect. Absence of context (new video,
    // first still, lookup failure) just means the compliance check skips that nuance.
    fn previous_still_context(&self, video_id: &str, group_id: &str) -> Option<String> {
        let plan = self.get_visual_plan(video_id).ok()?;
        let current = plan.groups.iter().find(|g| g.id == group_id)?;
        let previous = plan.groups.iter()
            .filter(|g| g.ordinal < current.ordinal)
            .max_by_key(|g| g.ordinal)?;
        let previous_narration = previous.sentence_ids.iter()
            .filter_map(|id| plan.sentences.iter().find(|s| &s.id == id))
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let previous_prompt = self.list_prompt_versions(video_id, &previous.id).ok()?.into_iter().next()?;
        Some(json!({
            "narration": previous_narration,
            "scene": previous_prompt.user_prompt,
        }).to_string())
    }

    pub fn generate_image_render(
        &self,
        video_id: &str,
        group_id: &str,
        prompt_version_id: &str,
        system_prompt: &str,
        user_prompt: &str,
        settings_json: &str,
    ) -> Result<ImageRender, String> {
        let prompt_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM prompt_versions WHERE id = ?1 AND video_id = ?2 AND group_id = ?3)",
            params![prompt_version_id, video_id, group_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !prompt_exists {
            return Err("The selected prompt version does not belong to this still.".into());
        }
        let auth = self.gemini_auth()?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-3.1-flash-image".into());
        let plan = self.get_visual_plan(video_id).ok();
        let scene_id = plan.as_ref()
            .and_then(|plan| plan.groups.iter().find(|g| g.id == group_id))
            .and_then(|group| group.scene_id.clone());
        let (narration, ordinal) = plan.as_ref()
            .and_then(|plan| {
                let group = plan.groups.iter().find(|g| g.id == group_id)?;
                let narration = group.sentence_ids.iter()
                    .filter_map(|id| plan.sentences.iter().find(|s| &s.id == id))
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                Some((narration, group.ordinal))
            })
            .unwrap_or((String::new(), 0));
        // Sampled, like the post-generation compliance check below (offset so they land
        // on different stills, spreading QC coverage instead of stacking it): every
        // still used to pay for both an always-on pre-generation Gemini call here AND
        // the post-generation one below, on top of the actual generation call itself —
        // 2-3 Gemini calls per still is what was driving repeated real 429s and pushing
        // per-still time up to minutes once the account's rate limit was actually
        // exercised. Most stills now cost exactly one Gemini call (the generation
        // itself); only every 3rd gets the extra pre-check.
        let intent_check = if ordinal % 3 == 1 {
            self.validate_visual_intent(&auth, &narration, user_prompt, settings_json)
        } else {
            None
        };
        let (prompt_version_id, effective_user_prompt, effective_settings_json) =
            match intent_check {
                Some((corrected_prompt, corrected_settings)) => {
                    let version = self.create_prompt_version(
                        video_id, group_id, &corrected_settings, system_prompt, &corrected_prompt,
                    )?;
                    (version.id, corrected_prompt, corrected_settings)
                }
                None => (prompt_version_id.to_string(), user_prompt.to_string(), settings_json.to_string()),
            };
        let prompt_version_id = prompt_version_id.as_str();
        let settings: serde_json::Value = serde_json::from_str(&effective_settings_json)
            .map_err(|_| "Image settings must be valid JSON.".to_string())?;
        let prompt = assemble_image_prompt(system_prompt, &effective_user_prompt, &settings);
        // When Character Consistency is on (flag set by plan_bulk_visuals),
        // pass the actual reference image as generation input, not just the
        // character description baked into user_prompt as text. A text
        // description alone doesn't reliably reproduce fine visual details
        // (hair color/style especially) across independent generations —
        // conditioning on the real image is what actually anchors them.
        // A scene override (see bulk_scene_settings) takes precedence over
        // the video-global character_consistency.{video_id} flag/reference,
        // the same way plan_bulk_visuals_batch already resolves it at
        // planning time — generation has to agree with what was planned.
        let scene_settings = match &scene_id {
            Some(id) => self.get_bulk_scene_settings(video_id)?.into_iter().find(|s| &s.scene_id == id),
            None => None,
        };
        let character_consistency_enabled = scene_settings.as_ref().and_then(|s| s.character_consistency)
            .unwrap_or(
                self.get_app_setting(&format!("character_consistency.{video_id}"))?.as_deref() == Some("true")
            );
        let reference_asset_id = scene_settings.as_ref().and_then(|s| s.reference_asset_id.clone());
        let reference_for_generation = if character_consistency_enabled {
            self.reference_image_bytes(video_id, reference_asset_id.as_deref())?
        } else {
            None
        };
        // Location Consistency's own reference image, attached the same
        // way — but only when there's no character reference already
        // occupying this call's one "attached reference image" input. A
        // specific character's identity is generally harder for the model
        // to hold onto from text alone than an environment is, so
        // character wins the slot when both are enabled for the same
        // still; location still gets its text description woven into the
        // prompt either way (see plan_bulk_visuals_batch's location_block),
        // just without image conditioning on top in that combined case.
        let global_visual = self.get_bulk_global_settings(video_id)?;
        let location_consistency_enabled = reference_for_generation.is_none()
            && scene_settings.as_ref().and_then(|s| s.location_consistency)
                .unwrap_or_else(|| global_visual.location_consistency.unwrap_or(false));
        let location_reference_asset_id = scene_settings.as_ref().and_then(|s| s.location_reference_asset_id.clone())
            .or_else(|| global_visual.location_reference_asset_id.clone());
        let location_reference_for_generation = if location_consistency_enabled {
            self.reference_image_bytes(video_id, location_reference_asset_id.as_deref())?
        } else {
            None
        };
        let render_once = || -> Result<(Vec<u8>, &'static str), String> {
            if let Some((reference_mime, reference_bytes)) = reference_for_generation.as_ref() {
                // request_gemini_image_with_source is otherwise only used for
                // in-place edits (edit_render/edit_thumbnail), where the source
                // image IS the thing being modified and the prompt says to
                // preserve it. That's the opposite of what we want here — the
                // attached image is a CHARACTER REFERENCE for an entirely new
                // scene, not an image to edit — so this framing is mandatory,
                // not optional, or the model tends to keep the reference's
                // background/pose instead of generating the new scene.
                let character_reference_prompt = format!(
                    "The attached image is a CHARACTER REFERENCE ONLY. Reproduce that character's exact \
                     physical appearance (hair, coloring, build, distinguishing features) — but IGNORE the \
                     reference image's background, pose, camera angle, composition, and clothing entirely. \
                     Dress the character in whatever outfit fits the new scene described below (do not copy \
                     the reference image's outfit unless that scene independently calls for the same \
                     clothing). Generate a completely new scene as described below, featuring that \
                     character:\n\n{prompt}"
                );
                request_gemini_image_with_source(
                    &auth, &model, &character_reference_prompt, reference_bytes, reference_mime, None,
                    requested_aspect_ratio(&settings),
                )
            } else if let Some((location_mime, location_bytes)) = location_reference_for_generation.as_ref() {
                let location_reference_prompt = format!(
                    "The attached image is a LOCATION REFERENCE ONLY. Reproduce that setting's exact \
                     architecture, layout, scale, and characteristic materials/colors — but IGNORE the \
                     reference image's weather, time of day, lighting, and any people or objects present \
                     in it. Populate the scene with whatever the description below actually calls for. \
                     Generate a completely new moment as described below, set in that same \
                     location:\n\n{prompt}"
                );
                request_gemini_image_with_source(
                    &auth, &model, &location_reference_prompt, location_bytes, location_mime, None,
                    requested_aspect_ratio(&settings),
                )
            } else {
                // Either consistency flag but no reference found (e.g. removed
                // after planning) falls back to text-only rather than blocking
                // generation entirely.
                request_gemini_image(
                    &auth, &model, &prompt, requested_aspect_ratio(&settings),
                )
            }
        };
        let (mut image_bytes, mut extension) = render_once()?;
        // Sparing post-generation QC gate: adds a full extra vision call per still it
        // runs on, so it only samples roughly 1 in 3 stills (by ordinal) rather than
        // every one — checking every single image nearly doubled per-image latency
        // across a whole bulk job for comparatively little extra coverage. When it does
        // run, it only ever escalates to ONE regeneration attempt (never loops further),
        // and only for a confident, obvious mismatch — see
        // check_generated_image_compliance's doc comment for what qualifies.
        let mut regeneration_reason: Option<String> = None;
        if ordinal % 3 == 0 {
            if let Some(reason) = self.check_generated_image_compliance(
                &auth,
                &narration,
                &effective_user_prompt,
                self.previous_still_context(video_id, group_id).as_deref(),
                &image_bytes,
                extension_to_media_type(extension),
            ) {
                if let Ok((retry_bytes, retry_extension)) = render_once() {
                    image_bytes = retry_bytes;
                    extension = retry_extension;
                }
                regeneration_reason = Some(reason);
            }
        }
        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1 AND trashed_at IS NULL",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let render_dir = self
            .projects_dir
            .join(channel_id)
            .join(video_id)
            .join("renders")
            .join(group_id);
        fs::create_dir_all(&render_dir).map_err(|e| e.to_string())?;
        let version: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM image_renders WHERE video_id = ?1 AND group_id = ?2",
                params![video_id, group_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file_name = format!("render-v{}.{}", version, extension);
        let relative_path = format!("renders/{}/{}", group_id, file_name);
        let out_path = render_dir.join(&file_name);
        fs::write(&out_path, image_bytes).map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let render = self.insert_image_render(
            &id,
            video_id,
            group_id,
            version,
            prompt_version_id,
            &file_name,
            &relative_path,
            None,
            None,
            "generation",
        )?;
        self.create_snapshot(
            video_id,
            &json!({
                "reason": "image-rendered",
                "groupId": group_id,
                "renderId": render.id,
                "promptVersionId": prompt_version_id,
                "version": render.version,
                "regenerated": regeneration_reason.is_some(),
                "regenerationReason": regeneration_reason,
            })
            .to_string(),
        )?;
        Ok(render)
    }

    pub fn edit_image_render(
        &self,
        source_render_id: &str,
        instruction: &str,
        mask_data_url: Option<&str>,
        edit_strength: &str,
    ) -> Result<ImageRender, String> {
        if instruction.trim().is_empty() {
            return Err("Describe the requested image change.".into());
        }
        let source: ImageRender = self.connection.query_row(
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at,subject_x,subject_y FROM image_renders WHERE id=?1",
            [source_render_id],
            |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?,
                is_final: row.get::<_, i64>(10)? != 0, edit_strength: row.get(11)?,
                mask_path: row.get(12)?, mask_used: row.get::<_, i64>(13)? != 0,
                created_at: row.get(14)?, subject_x: row.get(15)?, subject_y: row.get(16)?,
            }),
        ).map_err(|_| "Source image version was not found.".to_string())?;
        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id=?1 AND trashed_at IS NULL",
                [&source.video_id],
                |row| row.get(0),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let source_path = self
            .projects_dir
            .join(&channel_id)
            .join(&source.video_id)
            .join(&source.relative_path);
        let source_bytes =
            fs::read(&source_path).map_err(|_| "Source render file is missing.".to_string())?;
        let mime_type = extension_to_media_type(
            source_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("png"),
        );
        let prompt = self
            .connection
            .query_row(
                "SELECT system_prompt,user_prompt,settings_json FROM prompt_versions WHERE id=?1",
                [&source.prompt_version_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let original_settings: serde_json::Value = serde_json::from_str(&prompt.2)
            .unwrap_or_else(|_| json!({}));
        let mask = mask_data_url.map(decode_data_url).transpose()?;
        let edit_prompt = format!(
            "Edit the provided image according to the user request.\n\nUser request:\n{}\n\nEdit strength: {}\n\nRules:\n1. Only change the white painted area shown in the mask image when a mask is provided.\n2. Preserve the rest of the image as much as possible.\n3. Preserve camera angle, lighting, colors, composition, character identity, subject identity, and visual style.\n4. Do not restyle or recreate the full image.\n5. Keep all unrelated objects unchanged.\n6. Return a natural looking edited image.\n\nExisting style directive:\n{}\n\nOriginal prompt context:\n{}\n\nOriginal settings:\n{}",
            instruction.trim(), edit_strength, prompt.0, prompt.1, prompt.2
        );
        let auth = self.gemini_auth()?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-3.1-flash-image".into());
        let (image_bytes, extension) = request_gemini_image_with_source(
            &auth,
            &model,
            &edit_prompt,
            &source_bytes,
            mime_type,
            mask.as_ref().map(|(_, bytes)| bytes.as_slice()),
            requested_aspect_ratio(&original_settings),
        )?;
        let render_dir = self
            .projects_dir
            .join(channel_id)
            .join(&source.video_id)
            .join("renders")
            .join(&source.group_id);
        fs::create_dir_all(&render_dir).map_err(|e| e.to_string())?;
        let version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM image_renders WHERE video_id=?1 AND group_id=?2",
            params![source.video_id, source.group_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let file_name = format!("render-v{version}.{extension}");
        let relative_path = format!("renders/{}/{}", source.group_id, file_name);
        fs::write(render_dir.join(&file_name), image_bytes).map_err(|e| e.to_string())?;
        let mut render = self.insert_image_render(
            &Uuid::new_v4().to_string(),
            &source.video_id,
            &source.group_id,
            version,
            &source.prompt_version_id,
            &file_name,
            &relative_path,
            Some(&source.id),
            Some(instruction.trim()),
            "edit",
        )?;
        let mask_path = if let Some((_, bytes)) = mask {
            let path = render_dir.join(format!("mask-v{version}.png"));
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
            Some(format!("renders/{}/mask-v{version}.png", source.group_id))
        } else { None };
        self.connection.execute(
            "UPDATE image_renders SET edit_strength=?2,mask_path=?3,mask_used=?4 WHERE id=?1",
            params![render.id, edit_strength, mask_path, mask_path.is_some() as i64],
        ).map_err(|e| e.to_string())?;
        render.edit_strength = Some(edit_strength.into());
        render.mask_path = mask_path;
        render.mask_used = render.mask_path.is_some();
        Ok(render)
    }

    pub fn edit_thumbnail(
        &self,
        source_data_url: &str,
        instruction: &str,
        mask_data_url: Option<&str>,
        edit_strength: &str,
        aspect_ratio: &str,
    ) -> Result<String, String> {
        if instruction.trim().is_empty() {
            return Err("Describe the requested change.".into());
        }
        let (mime_type, source_bytes) = decode_data_url(source_data_url)?;
        let mask = mask_data_url.map(decode_data_url).transpose()?;
        let edit_prompt = format!(
            "Edit the provided image according to the user request.\n\nUser request:\n{}\n\nEdit strength: {}\n\nRules:\n1. Only change the white painted area shown in the mask image when a mask is provided.\n2. Preserve the rest of the image as much as possible.\n3. Preserve camera angle, lighting, colors, composition, character identity, subject identity, and visual style.\n4. Do not restyle or recreate the full image.\n5. Keep all unrelated objects unchanged.\n6. Return a natural looking edited image.",
            instruction.trim(), edit_strength
        );
        let auth = self.gemini_auth()?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-3.1-flash-image".into());
        let (image_bytes, extension) = request_gemini_image_with_source(
            &auth,
            &model,
            &edit_prompt,
            &source_bytes,
            &mime_type,
            mask.as_ref().map(|(_, bytes)| bytes.as_slice()),
            aspect_ratio,
        )?;
        let data_url = format!(
            "data:{};base64,{}",
            extension_to_media_type(extension),
            base64::engine::general_purpose::STANDARD.encode(image_bytes)
        );
        Ok(data_url)
    }

    pub fn read_render_file(&self, render_id: &str) -> Result<(String, String), String> {
        let (video_id, relative_path): (String, String) = self
            .connection
            .query_row(
                "SELECT video_id,relative_path FROM image_renders WHERE id=?1",
                [render_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Image version was not found.".to_string())?;
        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id=?1",
                [&video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let path = self
            .projects_dir
            .join(channel_id)
            .join(video_id)
            .join(relative_path);
        let bytes = fs::read(&path).map_err(|_| "Image version file is missing.".to_string())?;
        let mime = extension_to_media_type(
            path.extension()
                .and_then(|value| value.to_str())
                .unwrap_or("png"),
        );
        Ok((
            mime.into(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
    }

    pub fn read_asset_file(&self, asset_id: &str) -> Result<(String, String), String> {
        let asset = self.asset_by_id(asset_id)?.ok_or("Asset was not found.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let bytes = fs::read(self.projects_dir.join(channel_id).join(&asset.video_id).join(&asset.relative_path))
            .map_err(|_| "Asset file is missing.".to_string())?;
        Ok((asset.media_type, base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    /// Absolute path to a render's image file, for loading via Tauri's asset
    /// protocol (convertFileSrc) instead of a base64 round-trip — much faster
    /// for the dozens of thumbnails ImagesView/TimelineView load per visit.
    pub fn render_file_path(&self, render_id: &str) -> Result<PathBuf, String> {
        let render = self.get_render_by_id(render_id)?;
        self.render_absolute_path(&render)
    }

    /// Absolute path to an uploaded asset (narration audio, reference image),
    /// for the same asset-protocol fast path as `render_file_path`.
    pub fn asset_file_path(&self, asset_id: &str) -> Result<PathBuf, String> {
        let asset = self.asset_by_id(asset_id)?.ok_or("Asset was not found.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(self.projects_dir.join(channel_id).join(&asset.video_id).join(&asset.relative_path))
    }

    fn get_video_asset(&self, id: &str) -> Result<VideoAsset, String> {
        self.connection.query_row(
            "SELECT id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at FROM video_assets WHERE id=?1",
            [id],
            |row| Ok(VideoAsset {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?, source_render_id: row.get(3)?,
                version: row.get(4)?, parent_video_asset_id: row.get(5)?, kind: row.get(6)?,
                file_name: row.get(7)?, relative_path: row.get(8)?, resolution: row.get(9)?,
                requested_duration_seconds: row.get(10)?, veo_duration_seconds: row.get(11)?,
                actual_duration_seconds: row.get(12)?, veo_model: row.get(13)?, veo_operation_name: row.get(14)?,
                prompt: row.get(15)?, created_at: row.get(16)?,
            }),
        ).map_err(|_| "Animation clip was not found.".to_string())
    }

    /// Public read accessor for a single generated/retimed animation clip
    /// version, used by the timeline inspector to compare its real duration
    /// against the slot it currently occupies.
    pub fn get_video_asset_record(&self, id: &str) -> Result<VideoAsset, String> {
        self.get_video_asset(id)
    }

    fn video_asset_absolute_path(&self, asset: &VideoAsset) -> Result<PathBuf, String> {
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(self.projects_dir.join(channel_id).join(&asset.video_id).join(&asset.relative_path))
    }

    /// Absolute path to a generated animation clip's video file, for the same
    /// asset-protocol fast path `render_file_path` uses for stills.
    pub fn video_asset_file_path(&self, video_asset_id: &str) -> Result<PathBuf, String> {
        let asset = self.get_video_asset(video_asset_id)?;
        self.video_asset_absolute_path(&asset)
    }

    pub fn export_latest_stills(
        &self,
        video_id: &str,
        destination: &Path,
    ) -> Result<ExportResult, String> {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        let plan = self.get_visual_plan(video_id)?;
        let mut files = Vec::new();
        for group in plan.groups {
            if let Some(render) = self.list_image_renders(video_id, &group.id)?
                .into_iter().find(|render| render.is_final) {
                let source = self.render_absolute_path(&render)?;
                let extension = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png");
                let name = format!(
                    "still-{:03}-v{}.{}",
                    group.ordinal, render.version, extension
                );
                fs::copy(source, destination.join(&name)).map_err(|e| e.to_string())?;
                files.push(name);
            }
        }
        fs::write(
            destination.join("manifest.json"),
            serde_json::to_vec_pretty(&json!({
                "format": "auto-gen-studio-stills", "version": 1, "videoId": video_id,
                "exportedAt": Utc::now().to_rfc3339(), "files": files
            }))
            .unwrap(),
        )
        .map_err(|e| e.to_string())?;
        Ok(ExportResult {
            path: destination.display().to_string(),
            file_count: files.len(),
        })
    }

    pub fn export_project_bundle(
        &self,
        video_id: &str,
        destination: &Path,
    ) -> Result<ExportResult, String> {
        let (channel_name, video_title, stage, progress, channel_id): (String, String, String, i64, String) =
            self.connection.query_row(
                "SELECT c.name,v.title,v.stage,v.progress,c.id FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=?1",
                [video_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            ).map_err(|_| "Video was not found.".to_string())?;
        let inputs = self.get_video_inputs(video_id)?;
        let root = self.projects_dir.join(&channel_id).join(video_id);
        let mut relative_files = Vec::new();
        collect_relative_files(&root, &root, &mut relative_files)?;
        let mut tables = std::collections::BTreeMap::new();
        for table in PROJECT_TABLES {
            tables.insert((*table).to_string(), self.dump_table_rows(table, video_id)?);
        }
        let manifest = ProjectBundleManifest {
            format: "auto-gen-studio-project".into(),
            version: 2,
            exported_at: Utc::now().to_rfc3339(),
            channel_name,
            video_title,
            stage,
            progress,
            script_text: inputs.script_text,
            pacing_seconds: inputs.pacing_seconds,
            files: relative_files.clone(),
            video_id: video_id.to_string(),
            channel_id,
            tables,
        };
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = fs::File::create(destination).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut zip, &serde_json::to_vec_pretty(&manifest).unwrap())
            .map_err(|e| e.to_string())?;
        for relative in &relative_files {
            zip.start_file(format!("assets/{relative}"), SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(
                &mut zip,
                &fs::read(root.join(relative)).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(ExportResult {
            path: destination.display().to_string(),
            file_count: relative_files.len() + 1,
        })
    }

    /// Imports into `channel_id` — an existing channel, picked by whoever's
    /// importing, exactly like "+ New video" — rather than spawning a new
    /// channel of its own. A project bundle is just a video; it doesn't
    /// need a home of its own any more than any other video does.
    pub fn import_project_bundle(&self, source: &Path, channel_id: &str) -> Result<Video, String> {
        let file = fs::File::open(source)
            .map_err(|_| "Project bundle could not be opened.".to_string())?;
        let mut archive = ZipArchive::new(file)
            .map_err(|_| "Project bundle is not a valid ZIP archive.".to_string())?;
        let manifest: ProjectBundleManifest = {
            let mut entry = archive
                .by_name("manifest.json")
                .map_err(|_| "Project bundle manifest is missing.".to_string())?;
            serde_json::from_reader(&mut entry)
                .map_err(|_| "Project bundle manifest is invalid.".to_string())?
        };
        if manifest.format != "auto-gen-studio-project" || !(1..=2).contains(&manifest.version) {
            return Err("Unsupported project bundle format.".into());
        }
        for path in &manifest.files {
            validate_bundle_path(path)?;
            archive
                .by_name(&format!("assets/{path}"))
                .map_err(|_| format!("Bundle asset is missing: {path}"))?;
        }
        // create_video validates channel_id itself ("Channel was not found."
        // if it's missing or trashed) — no separate check needed here.
        let video = self.create_video(channel_id, &format!("{} (Imported)", manifest.video_title))?;
        let target = self.projects_dir.join(channel_id).join(&video.id);
        let result = (|| {
            for path in &manifest.files {
                let mut entry = archive
                    .by_name(&format!("assets/{path}"))
                    .map_err(|e| e.to_string())?;
                let destination = target.join(path);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut output = fs::File::create(destination).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
            }
            if manifest.version >= 2 && !manifest.tables.is_empty() {
                self.restore_project_tables(&manifest, &video.id)?;
            } else {
                // Version-1 bundle (or a version-2 bundle exported before any
                // real project state existed): all we ever had was the raw
                // script — same as before full-fidelity mode.
                self.save_video_inputs(&video.id, &manifest.script_text, manifest.pacing_seconds)?;
            }
            self.connection.execute(
                "UPDATE videos SET stage=?1, progress=?2, updated_at=?3 WHERE id=?4",
                params![manifest.stage, manifest.progress, Utc::now().to_rfc3339(), video.id],
            ).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&target);
            for table in PROJECT_TABLES.iter().rev() {
                let _ = self
                    .connection
                    .execute(&format!("DELETE FROM {table} WHERE video_id=?1"), [&video.id]);
            }
            let _ = self
                .connection
                .execute("DELETE FROM video_snapshots WHERE video_id=?1", [&video.id]);
            let _ = self
                .connection
                .execute("DELETE FROM videos WHERE id=?1", [&video.id]);
            return Err(error);
        }
        let mut video = video;
        video.stage = manifest.stage.clone();
        video.progress = manifest.progress;
        Ok(video)
    }

    /// Reads every column of every row in `table` for `video_id`, as a
    /// generic `column name -> JSON value` map — no per-table struct to
    /// maintain, and it automatically picks up any column ever added to
    /// these tables. Used only for building a project bundle export; live
    /// reads elsewhere in the app go through their own typed queries.
    fn dump_table_rows(
        &self,
        table: &str,
        video_id: &str,
    ) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
        let sql = format!("SELECT * FROM {table} WHERE video_id = ?1 ORDER BY rowid");
        let mut statement = self.connection.prepare(&sql).map_err(|e| e.to_string())?;
        let column_names: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        let rows = statement
            .query_map([video_id], |row| {
                let mut map = serde_json::Map::new();
                for (index, name) in column_names.iter().enumerate() {
                    let json_value = match row.get_ref(index)? {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(value) => serde_json::Value::from(value),
                        rusqlite::types::ValueRef::Real(value) => serde_json::Number::from_f64(value)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null),
                        rusqlite::types::ValueRef::Text(value) => {
                            serde_json::Value::String(String::from_utf8_lossy(value).into_owned())
                        }
                        rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                    };
                    map.insert(name.clone(), json_value);
                }
                Ok(map)
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Real column names for `table`, read straight from the live schema —
    /// used as an allowlist so a bundle's JSON can only ever supply
    /// *values*, never table/column names, when it's turned back into SQL.
    fn table_columns(&self, table: &str) -> Result<Vec<String>, String> {
        let sql = format!("PRAGMA table_info({table})");
        let mut statement = self.connection.prepare(&sql).map_err(|e| e.to_string())?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(names)
    }

    /// Every dumped row, id-remapped and reinserted, in `PROJECT_TABLES`
    /// order — reconstructs the imported video's entire visual plan,
    /// renders, animations, timeline, media library, captions, and overlay
    /// tracks so the project opens looking exactly like it did for whoever
    /// exported it, not just its finished clips.
    fn restore_project_tables(
        &self,
        manifest: &ProjectBundleManifest,
        new_video_id: &str,
    ) -> Result<(), String> {
        let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if !manifest.video_id.is_empty() {
            id_map.insert(manifest.video_id.clone(), new_video_id.to_string());
        }
        seed_id_map(&manifest.tables, &mut id_map);
        for table in PROJECT_TABLES {
            let Some(rows) = manifest.tables.get(*table) else { continue };
            if rows.is_empty() {
                continue;
            }
            let known_columns = self.table_columns(table)?;
            for row in rows {
                let remapped = remap_row(table, row.clone(), &id_map);
                self.insert_dynamic_row(table, &remapped, &known_columns)?;
            }
        }
        Ok(())
    }

    /// Inserts one dumped-and-remapped row back into `table`, keeping only
    /// the columns that actually exist on the live schema (`known_columns`)
    /// — both a safety allowlist (see `table_columns`) and forward/backward
    /// compatibility if the exporting and importing app versions differ.
    fn insert_dynamic_row(
        &self,
        table: &str,
        row: &serde_json::Map<String, serde_json::Value>,
        known_columns: &[String],
    ) -> Result<(), String> {
        let columns: Vec<&String> = known_columns.iter().filter(|c| row.contains_key(c.as_str())).collect();
        if columns.is_empty() {
            return Ok(());
        }
        let column_list = columns.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(",");
        let placeholders = (1..=columns.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
        let sql = format!("INSERT INTO {table} ({column_list}) VALUES ({placeholders})");
        let boxed: Vec<Box<dyn rusqlite::ToSql>> =
            columns.iter().map(|c| json_to_sql(&row[c.as_str()])).collect();
        let refs: Vec<&dyn rusqlite::ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
        self.connection
            .execute(&sql, refs.as_slice())
            .map_err(|e| format!("Could not restore {table} row: {e}"))?;
        Ok(())
    }

    /// Imports a raw asset folder produced by the "Export project" (editor
    /// bundle) flow — `clips/seg_NNNN.mp4` + `timing.txt` + `narration.*` +
    /// an optional `captions.srt` — and rebuilds it as a new project whose
    /// Editor timeline matches the original layout exactly. Unlike
    /// `import_project_bundle` (which round-trips this app's own `.agsproj`
    /// zip), this reads the plain folder a user gets after unzipping that
    /// export, or one assembled by hand/another tool in the same shape.
    pub fn import_asset_folder(&self, source_dir: &Path, engine_dir: &Path) -> Result<Video, String> {
        if !source_dir.is_dir() {
            return Err("That folder could not be found.".into());
        }
        let timing_text = fs::read_to_string(source_dir.join("timing.txt")).map_err(|_| {
            "This doesn't look like an exported project folder — timing.txt is missing.".to_string()
        })?;
        let segments = parse_timing_file(&timing_text)?;
        let clips_dir = source_dir.join("clips");
        if !clips_dir.is_dir() {
            return Err(
                "This doesn't look like an exported project folder — a clips/ folder is missing.".into(),
            );
        }
        let narration_path = fs::read_dir(source_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                path.file_stem().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("narration")).unwrap_or(false)
                    && path.extension().and_then(|e| e.to_str())
                        .map(|ext| ["mp3", "wav", "m4a", "aac", "flac", "ogg"].contains(&ext.to_ascii_lowercase().as_str()))
                        .unwrap_or(false)
            })
            .ok_or("This doesn't look like an exported project folder — no narration audio file was found.")?;

        let channel_label = source_dir
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Imported");
        let video_label = source_dir
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Imported Video");

        let channel = self.create_channel(&format!("{channel_label} (Imported)"), None)?;
        let mut video = self.create_video(&channel.id, video_label)?;

        let result = (|| -> Result<(), String> {
            self.import_asset(&video.id, &narration_path, "audio")?;

            let captions_path = source_dir.join("captions.srt");
            if captions_path.is_file() {
                let srt_text = fs::read_to_string(&captions_path).map_err(|e| e.to_string())?;
                let entries = parse_srt(&srt_text);
                // The Script tab has nothing else to source text from for a raw
                // asset-folder import (there's no original script file) — the
                // captions ARE what was actually narrated, so re-join them into
                // one script, in reading order, deduplicating a caption engine's
                // typical one-line-repeated-as-several-word-groups pattern isn't
                // attempted here: this is a best-effort read-only reference, not
                // something regeneration will run against.
                let script_text = entries.iter().map(|(_, _, text)| text.as_str()).collect::<Vec<_>>().join(" ");
                if !script_text.is_empty() {
                    self.save_video_inputs(&video.id, &script_text, 8)?;
                }
                for (ordinal, (start, end, text)) in entries.into_iter().enumerate() {
                    self.connection.execute(
                        "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,words_json) VALUES(?1,?2,NULL,?3,?4,?5,?6,NULL)",
                        params![Uuid::new_v4().to_string(), video.id, text, ordinal as i64, start, end],
                    ).map_err(|e| e.to_string())?;
                }
            }

            self.ensure_timeline_row(&video.id)?;
            for (ordinal, (file_name, start, end)) in segments.iter().enumerate() {
                let clip_path = clips_dir.join(file_name);
                if !clip_path.is_file() {
                    // Timing entries with no matching file on disk are skipped
                    // rather than aborting the whole import — the rest of the
                    // timeline is still worth having.
                    continue;
                }
                let asset = self.import_media_library_asset_with_known_duration(
                    &video.id, &clip_path, Some("clip"), engine_dir, Some(end - start),
                )?;
                self.connection.execute(
                    "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label,clip_kind,media_library_asset_id) VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,'imported-clip',?8)",
                    params![Uuid::new_v4().to_string(), video.id, format!("library:{}", asset.id), ordinal as i64, start, end, asset.original_name, asset.id],
                ).map_err(|e| e.to_string())?;
            }
            self.recompute_timeline_duration(&video.id)?;
            self.connection.execute(
                "UPDATE videos SET stage='timeline', progress=100, updated_at=?1 WHERE id=?2",
                params![Utc::now().to_rfc3339(), video.id],
            ).map_err(|e| e.to_string())?;
            Ok(())
        })();

        if let Err(error) = result {
            let _ = fs::remove_dir_all(self.projects_dir.join(&channel.id).join(&video.id));
            let _ = self.connection.execute("DELETE FROM timeline_clips WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM timeline_caption_clips WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM media_library_assets WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM timelines WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM input_assets WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM video_inputs WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM video_snapshots WHERE video_id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM videos WHERE id=?1", [&video.id]);
            let _ = self.connection.execute("DELETE FROM channels WHERE id=?1", [&channel.id]);
            return Err(error);
        }
        video.stage = "timeline".into();
        video.progress = 100;
        Ok(video)
    }

    fn render_absolute_path(&self, render: &ImageRender) -> Result<PathBuf, String> {
        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id=?1",
                [&render.video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(self
            .projects_dir
            .join(channel_id)
            .join(&render.video_id)
            .join(&render.relative_path))
    }

    pub fn build_timeline(&self, video_id: &str) -> Result<Timeline, String> {
        let plan = self.get_visual_plan(video_id)?;
        let sentence_map: std::collections::HashMap<_, _> = plan
            .sentences
            .iter()
            .map(|sentence| (sentence.id.as_str(), sentence))
            .collect();
        self.connection
            .execute("DELETE FROM timeline_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        let mut duration: f64 = 0.0;
        for group in &plan.groups {
            let sentences: Vec<_> = group
                .sentence_ids
                .iter()
                .filter_map(|id| sentence_map.get(id.as_str()))
                .collect();
            let start = sentences
                .first()
                .map(|sentence| sentence.start_seconds)
                .unwrap_or(duration);
            let end = sentences
                .last()
                .map(|sentence| sentence.end_seconds)
                .unwrap_or(start + 1.0);
            let render_id = self
                .list_image_renders(video_id, &group.id)?
                .into_iter()
                .next()
                .map(|render| render.id);
            self.connection.execute(
                "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![Uuid::new_v4().to_string(), video_id, group.id, render_id, group.ordinal, start, end, group.label],
            ).map_err(|e| e.to_string())?;
            duration = duration.max(end);
        }
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,?2,0,1,?3) ON CONFLICT(video_id) DO UPDATE SET duration_seconds=excluded.duration_seconds,playhead_seconds=0,updated_at=excluded.updated_at",
            params![video_id, duration, now],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// A timeline clip's `render_id` is only ever set once, at the moment the
    /// clip is first created (`populate_timeline_from_sources`/`add_stills_clip`)
    /// — if that still's image hadn't finished generating yet at that exact
    /// moment, the clip was left pointing at nothing, and nothing ever
    /// revisits it once a final render does show up later (regenerating
    /// stills, or just finishing a bulk-generate job after the timeline was
    /// already built, is a completely normal order of operations). Self-heals
    /// on every read instead of leaving affected stills permanently blank.
    fn backfill_missing_clip_renders(&self, video_id: &str) -> Result<(), String> {
        self.connection.execute(
            "UPDATE timeline_clips
             SET render_id = (
                 SELECT id FROM image_renders
                 WHERE image_renders.video_id = timeline_clips.video_id
                   AND image_renders.group_id = timeline_clips.group_id
                   AND image_renders.is_final = 1
                 ORDER BY image_renders.version DESC LIMIT 1
             )
             WHERE video_id = ?1 AND (render_id IS NULL OR render_id = '')",
            [video_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_timeline(&self, video_id: &str) -> Result<Timeline, String> {
        #[allow(clippy::type_complexity)]
        let (
            duration_seconds, playhead_seconds, zoom, updated_at, caption_style_raw, narration_offset_seconds,
            music_master_volume_percent, music_duck_sensitivity_percent,
            sequence_locked, narration_volume_percent, narration_trim_start_seconds, narration_trim_end_seconds,
        ): (f64, f64, f64, String, String, f64, f64, f64, bool, f64, f64, f64) = self.connection.query_row(
            "SELECT duration_seconds,playhead_seconds,zoom,updated_at,caption_style_json,narration_offset_seconds,music_master_volume_percent,music_duck_sensitivity_percent,sequence_locked,narration_volume_percent,narration_trim_start_seconds,narration_trim_end_seconds FROM timelines WHERE video_id=?1",
            [video_id], |row| Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                row.get(6)?, row.get(7)?,
                row.get::<_, i64>(8)? != 0, row.get(9)?, row.get(10)?, row.get(11)?,
            )),
        ).map_err(|_| "Timeline has not been built.".to_string())?;
        let caption_style = serde_json::from_str(&caption_style_raw).unwrap_or_else(|_| json!({}));
        self.backfill_missing_clip_renders(video_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id,group_id,render_id,ordinal,start_seconds,end_seconds,label,motion_preset,transition_in,transition_out,motion_intensity,clip_kind,video_asset_id,media_library_asset_id,color_filter_preset,color_filter_intensity,motion_graphic_effect,motion_graphic_settings_json,motion_graphic_reason,motion_graphic_ai_snapshot_json FROM timeline_clips WHERE video_id=?1 ORDER BY ordinal"
        ).map_err(|e| e.to_string())?;
        let clips = statement
            .query_map([video_id], |row| {
                Ok(TimelineClip {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    render_id: row.get(2)?,
                    ordinal: row.get(3)?,
                    start_seconds: row.get(4)?,
                    end_seconds: row.get(5)?,
                    label: row.get(6)?,
                    motion_preset: row.get(7)?,
                    transition_in: row.get(8)?,
                    transition_out: row.get(9)?,
                    motion_intensity: row.get(10)?,
                    clip_kind: row.get(11)?,
                    video_asset_id: row.get(12)?,
                    media_library_asset_id: row.get(13)?,
                    color_filter_preset: row.get(14)?,
                    color_filter_intensity: row.get(15)?,
                    motion_graphic_effect: row.get(16)?,
                    motion_graphic_settings_json: row.get(17)?,
                    motion_graphic_reason: row.get(18)?,
                    motion_graphic_ai_snapshot_json: row.get(19)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut caption_statement = self.connection.prepare(
            "SELECT id,source_chunk_index,text,ordinal,start_seconds,end_seconds,style_json,words_json FROM timeline_caption_clips WHERE video_id=?1 ORDER BY start_seconds"
        ).map_err(|e| e.to_string())?;
        let caption_clips = caption_statement
            .query_map([video_id], |row| {
                let style_raw: Option<String> = row.get(6)?;
                let words_raw: Option<String> = row.get(7)?;
                let text: String = row.get(2)?;
                let start_seconds: f64 = row.get(4)?;
                let end_seconds: f64 = row.get(5)?;
                let real_words: Option<Vec<CaptionWord>> =
                    words_raw.and_then(|raw| serde_json::from_str(&raw).ok());
                // Real (Whisper/regenerated) timing always wins; only estimate
                // when there's genuinely nothing precise on this clip — see
                // `estimate_word_windows`.
                let words = real_words
                    .filter(|words| !words.is_empty())
                    .or_else(|| estimate_word_windows(&text, start_seconds, end_seconds));
                Ok(TimelineCaptionClip {
                    id: row.get(0)?,
                    source_chunk_index: row.get(1)?,
                    text,
                    ordinal: row.get(3)?,
                    start_seconds,
                    end_seconds,
                    style: style_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
                    words,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut music_statement = self.connection.prepare(
            "SELECT id,media_library_asset_id,ordinal,start_seconds,end_seconds,label,volume_percent,fade_in_enabled,fade_in_seconds,fade_out_enabled,fade_out_seconds,auto_duck,loop_enabled FROM timeline_music_clips WHERE video_id=?1 ORDER BY ordinal"
        ).map_err(|e| e.to_string())?;
        let music_clips = music_statement
            .query_map([video_id], |row| {
                Ok(TimelineMusicClip {
                    id: row.get(0)?,
                    media_library_asset_id: row.get(1)?,
                    ordinal: row.get(2)?,
                    start_seconds: row.get(3)?,
                    end_seconds: row.get(4)?,
                    label: row.get(5)?,
                    volume_percent: row.get(6)?,
                    fade_in_enabled: row.get::<_, i64>(7)? != 0,
                    fade_in_seconds: row.get(8)?,
                    fade_out_enabled: row.get::<_, i64>(9)? != 0,
                    fade_out_seconds: row.get(10)?,
                    auto_duck: row.get::<_, i64>(11)? != 0,
                    loop_enabled: row.get::<_, i64>(12)? != 0,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut text_statement = self.connection.prepare(
            "SELECT id,start_seconds,end_seconds,text,font_family,font_size_px,bold,italic,color,background_mode,background_color,position,animation FROM timeline_text_clips WHERE video_id=?1 ORDER BY start_seconds"
        ).map_err(|e| e.to_string())?;
        let text_clips = text_statement
            .query_map([video_id], |row| {
                Ok(TimelineTextClip {
                    id: row.get(0)?,
                    start_seconds: row.get(1)?,
                    end_seconds: row.get(2)?,
                    text: row.get(3)?,
                    font_family: row.get(4)?,
                    font_size_px: row.get(5)?,
                    bold: row.get::<_, i64>(6)? != 0,
                    italic: row.get::<_, i64>(7)? != 0,
                    color: row.get(8)?,
                    background_mode: row.get(9)?,
                    background_color: row.get(10)?,
                    position: row.get(11)?,
                    animation: row.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut logo_statement = self.connection.prepare(
            "SELECT id,media_library_asset_id,start_seconds,end_seconds,position,size_percent,opacity_percent,show_throughout FROM timeline_logo_clips WHERE video_id=?1 ORDER BY start_seconds"
        ).map_err(|e| e.to_string())?;
        let logo_clips = logo_statement
            .query_map([video_id], |row| {
                Ok(TimelineLogoClip {
                    id: row.get(0)?,
                    media_library_asset_id: row.get(1)?,
                    start_seconds: row.get(2)?,
                    end_seconds: row.get(3)?,
                    position: row.get(4)?,
                    size_percent: row.get(5)?,
                    opacity_percent: row.get(6)?,
                    show_throughout: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(Timeline {
            video_id: video_id.into(),
            duration_seconds,
            playhead_seconds,
            zoom,
            updated_at,
            clips,
            caption_clips,
            caption_style,
            narration_offset_seconds,
            music_clips,
            text_clips,
            logo_clips,
            music_master_volume_percent,
            music_duck_sensitivity_percent,
            sequence_locked,
            narration_volume_percent,
            narration_trim_start_seconds,
            narration_trim_end_seconds,
        })
    }

    pub fn update_timeline_view(
        &self,
        video_id: &str,
        playhead: f64,
        zoom: f64,
    ) -> Result<Timeline, String> {
        let timeline = self.get_timeline(video_id)?;
        self.connection
            .execute(
                "UPDATE timelines SET playhead_seconds=?1,zoom=?2,updated_at=?3 WHERE video_id=?4",
                params![
                    playhead.clamp(0.0, timeline.duration_seconds),
                    zoom.clamp(0.5, 4.0),
                    Utc::now().to_rfc3339(),
                    video_id
                ],
            )
            .map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Shifts when narration audio starts relative to the visual timeline
    /// (re-syncing narration, or skipping leading silence) without altering
    /// the audio file itself — trimming the tail is out of scope for now.
    pub fn set_narration_offset(&self, video_id: &str, offset_seconds: f64) -> Result<Timeline, String> {
        self.connection
            .execute(
                "UPDATE timelines SET narration_offset_seconds=?1,updated_at=?2 WHERE video_id=?3",
                params![offset_seconds.max(0.0), Utc::now().to_rfc3339(), video_id],
            )
            .map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn update_timeline_clip(
        &self,
        video_id: &str,
        clip_id: &str,
        start: f64,
        end: f64,
    ) -> Result<Timeline, String> {
        if start < 0.0 || end <= start {
            return Err("Clip boundaries are invalid.".into());
        }
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_clips WHERE video_id=?1 AND id<>?2 AND ?3 < end_seconds AND ?4 > start_seconds)",
            params![video_id, clip_id, start, end], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("Timeline clips may not overlap.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET start_seconds=?1,end_seconds=?2 WHERE id=?3 AND video_id=?4",
            params![start, end, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    fn recompute_timeline_duration(&self, video_id: &str) -> Result<(), String> {
        let stills_max: f64 = self.connection.query_row(
            "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_clips WHERE video_id=?1",
            [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let captions_max: f64 = self.connection.query_row(
            "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_caption_clips WHERE video_id=?1",
            [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let music_max: f64 = self.connection.query_row(
            "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_music_clips WHERE video_id=?1",
            [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let text_max: f64 = self.connection.query_row(
            "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_text_clips WHERE video_id=?1",
            [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        // Logo clips are intentionally excluded here: a `show_throughout` logo
        // always mirrors the current duration (kept in sync by
        // `add_logo_clip`/`set_logo_clip_style`), so folding it into this max
        // would make the duration a one-way ratchet that never shrinks.
        let duration = stills_max.max(captions_max).max(music_max).max(text_max);
        self.connection.execute(
            "UPDATE timelines SET duration_seconds=?1,updated_at=?2 WHERE video_id=?3",
            params![duration, Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn ensure_timeline_row(&self, video_id: &str) -> Result<(), String> {
        self.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,0,0,1,?2) ON CONFLICT(video_id) DO NOTHING",
            params![video_id, Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Adds a timeline clip for every visual-plan still and caption chunk that
    /// isn't on the timeline yet. Additive — re-running after generating more
    /// stills or captions fills gaps without disturbing existing arrangement.
    pub fn populate_timeline_from_sources(&self, video_id: &str) -> Result<Timeline, String> {
        self.ensure_timeline_row(video_id)?;

        let plan = self.get_visual_plan(video_id)?;
        let sentence_map: std::collections::HashMap<_, _> =
            plan.sentences.iter().map(|s| (s.id.as_str(), s)).collect();
        let mut cursor = 0.0;
        for group in &plan.groups {
            let sentences: Vec<_> = group
                .sentence_ids
                .iter()
                .filter_map(|id| sentence_map.get(id.as_str()))
                .collect();
            let start = sentences.first().map(|s| s.start_seconds).unwrap_or(cursor);
            let end = sentences.last().map(|s| s.end_seconds).unwrap_or(start + 3.0);
            cursor = cursor.max(end);
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM timeline_clips WHERE video_id=?1 AND group_id=?2)",
                params![video_id, group.id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if exists {
                continue;
            }
            let render_id = self
                .list_image_renders(video_id, &group.id)?
                .into_iter()
                .find(|render| render.is_final)
                .map(|render| render.id);
            self.connection.execute(
                "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![Uuid::new_v4().to_string(), video_id, group.id, render_id, group.ordinal, start, end, group.label],
            ).map_err(|e| e.to_string())?;
        }

        if let Ok(captions) = self.get_captions(video_id) {
            for chunk in &captions.chunks {
                let exists: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM timeline_caption_clips WHERE video_id=?1 AND source_chunk_index=?2)",
                    params![video_id, chunk.index], |row| row.get(0),
                ).map_err(|e| e.to_string())?;
                if exists {
                    continue;
                }
                let words_json = words_to_json(&chunk.words);
                self.connection.execute(
                    "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,words_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![Uuid::new_v4().to_string(), video_id, chunk.index, chunk.text, chunk.index, chunk.start_seconds, chunk.end_seconds, words_json],
                ).map_err(|e| e.to_string())?;
            }
        }

        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn add_stills_clip(&self, video_id: &str, group_id: &str, start_seconds: f64) -> Result<Timeline, String> {
        if start_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let plan = self.get_visual_plan(video_id)?;
        let group = plan.groups.iter().find(|g| g.id == group_id)
            .ok_or("Still was not found in the visual plan.")?;
        let sentence_map: std::collections::HashMap<_, _> =
            plan.sentences.iter().map(|s| (s.id.as_str(), s)).collect();
        let sentences: Vec<_> = group.sentence_ids.iter()
            .filter_map(|id| sentence_map.get(id.as_str())).collect();
        let natural_duration = match (sentences.first(), sentences.last()) {
            (Some(first), Some(last)) => (last.end_seconds - first.start_seconds).max(0.5),
            _ => 3.0,
        };
        let end_seconds = start_seconds + natural_duration;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, start_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing clip on the stills track.".into());
        }
        let render_id = self
            .list_image_renders(video_id, group_id)?
            .into_iter()
            .find(|render| render.is_final)
            .map(|render| render.id);
        self.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![Uuid::new_v4().to_string(), video_id, group_id, render_id, group.ordinal, start_seconds, end_seconds, group.label],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    /// `chunk_index` sources the clip's text/duration from a generated caption
    /// chunk; when `None`, `text` must be provided instead for a fully
    /// user-authored clip with no backing chunk.
    pub fn add_caption_clip(
        &self,
        video_id: &str,
        chunk_index: Option<i64>,
        text: Option<String>,
        start_seconds: f64,
    ) -> Result<Timeline, String> {
        if start_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let (resolved_text, duration, words_json) = if let Some(index) = chunk_index {
            let captions = self.get_captions(video_id)?;
            let chunk = captions.chunks.iter().find(|c| c.index == index)
                .ok_or("Caption chunk was not found.")?;
            (chunk.text.clone(), (chunk.end_seconds - chunk.start_seconds).max(0.3), words_to_json(&chunk.words))
        } else {
            let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
                .ok_or("Caption text is required.")?;
            (text, 2.0, None)
        };
        let end_seconds = start_seconds + duration;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_caption_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, start_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing clip on the captions track.".into());
        }
        self.connection.execute(
            "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,words_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![Uuid::new_v4().to_string(), video_id, chunk_index, resolved_text, chunk_index.unwrap_or(0), start_seconds, end_seconds, words_json],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn update_timeline_caption_clip(&self, video_id: &str, clip_id: &str, start: f64, end: f64) -> Result<Timeline, String> {
        if start < 0.0 || end <= start {
            return Err("Clip boundaries are invalid.".into());
        }
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_caption_clips WHERE video_id=?1 AND id<>?2 AND ?3 < end_seconds AND ?4 > start_seconds)",
            params![video_id, clip_id, start, end], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("Timeline clips may not overlap on the same track.".into());
        }
        self.connection.execute(
            "UPDATE timeline_caption_clips SET start_seconds=?1,end_seconds=?2 WHERE id=?3 AND video_id=?4",
            params![start, end, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn update_caption_clip_text(&self, video_id: &str, clip_id: &str, text: &str) -> Result<Timeline, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Caption text is required.".into());
        }
        // The old per-word timestamps no longer correspond to the new text,
        // so drop them — the caption falls back to the estimated word-timing
        // renderer until it's regenerated.
        self.connection.execute(
            "UPDATE timeline_caption_clips SET text=?1,words_json=NULL WHERE id=?2 AND video_id=?3",
            params![trimmed, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Splits one caption clip into two at `split_at_seconds`, assigning
    /// `left_text`/`right_text` to the resulting halves. There's no word-level
    /// timing within a single chunk to auto-split by, so the caller (driven by
    /// where the user's caret was) supplies both resulting texts directly.
    /// If the clip carries real per-word timestamps, they're partitioned by
    /// `split_at_seconds` and preserved on each half.
    pub fn split_caption_clip(
        &self,
        video_id: &str,
        clip_id: &str,
        split_at_seconds: f64,
        left_text: &str,
        right_text: &str,
    ) -> Result<Timeline, String> {
        let (start, end, words_raw): (f64, f64, Option<String>) = self.connection.query_row(
            "SELECT start_seconds,end_seconds,words_json FROM timeline_caption_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| "Caption clip was not found.".to_string())?;
        if split_at_seconds <= start || split_at_seconds >= end {
            return Err("Split point must fall inside the clip.".into());
        }
        let left_text = left_text.trim();
        let right_text = right_text.trim();
        if left_text.is_empty() || right_text.is_empty() {
            return Err("Both halves of a split caption need text.".into());
        }
        let (left_words, right_words) = match words_raw.and_then(|raw| serde_json::from_str::<Vec<CaptionWord>>(&raw).ok()) {
            Some(words) => {
                let (left, right): (Vec<_>, Vec<_>) = words.into_iter().partition(|w| w.end_seconds <= split_at_seconds);
                (words_to_json(&left), words_to_json(&right))
            }
            None => (None, None),
        };
        self.connection.execute(
            "UPDATE timeline_caption_clips SET text=?1,end_seconds=?2,words_json=?3 WHERE id=?4 AND video_id=?5",
            params![left_text, split_at_seconds, left_words, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,words_json) VALUES(?1,?2,NULL,?3,0,?4,?5,?6)",
            params![Uuid::new_v4().to_string(), video_id, right_text, split_at_seconds, end, right_words],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Merges two adjacent caption clips into one, keeping the first clip's
    /// id and style override. The two clips must already be touching
    /// (first.end == second.start) — the caller is expected to only offer
    /// this action for clips that are genuinely adjacent on the lane. Per-word
    /// timestamps are preserved only if BOTH halves still have them.
    pub fn merge_caption_clips(&self, video_id: &str, first_clip_id: &str, second_clip_id: &str) -> Result<Timeline, String> {
        let (first_text, first_end, first_words_raw): (String, f64, Option<String>) = self.connection.query_row(
            "SELECT text,end_seconds,words_json FROM timeline_caption_clips WHERE id=?1 AND video_id=?2",
            params![first_clip_id, video_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| "Caption clip was not found.".to_string())?;
        let (second_text, second_start, second_end, second_words_raw): (String, f64, f64, Option<String>) = self.connection.query_row(
            "SELECT text,start_seconds,end_seconds,words_json FROM timeline_caption_clips WHERE id=?1 AND video_id=?2",
            params![second_clip_id, video_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Caption clip was not found.".to_string())?;
        if (first_end - second_start).abs() > 0.01 {
            return Err("Only adjacent captions can be merged.".into());
        }
        let merged_words = match (
            first_words_raw.and_then(|raw| serde_json::from_str::<Vec<CaptionWord>>(&raw).ok()),
            second_words_raw.and_then(|raw| serde_json::from_str::<Vec<CaptionWord>>(&raw).ok()),
        ) {
            (Some(mut first), Some(second)) => {
                first.extend(second);
                words_to_json(&first)
            }
            _ => None,
        };
        self.connection.execute(
            "UPDATE timeline_caption_clips SET text=?1,end_seconds=?2,words_json=?3 WHERE id=?4 AND video_id=?5",
            params![format!("{first_text} {second_text}"), second_end, merged_words, first_clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "DELETE FROM timeline_caption_clips WHERE id=?1 AND video_id=?2",
            params![second_clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    /// Sets this video's global default caption style (used by any caption
    /// clip that has no override of its own).
    pub fn set_timeline_caption_style(&self, video_id: &str, style: &serde_json::Value) -> Result<Timeline, String> {
        if !style.is_object() {
            return Err("Caption style must be a JSON object.".into());
        }
        self.ensure_timeline_row(video_id)?;
        self.connection.execute(
            "UPDATE timelines SET caption_style_json=?1,updated_at=?2 WHERE video_id=?3",
            params![style.to_string(), Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Sets (or, with `None`, clears back to fully inheriting) one caption
    /// clip's own style override.
    pub fn set_caption_clip_style(&self, video_id: &str, clip_id: &str, style: Option<&serde_json::Value>) -> Result<Timeline, String> {
        if let Some(value) = style {
            if !value.is_object() {
                return Err("Caption style must be a JSON object.".into());
            }
        }
        let style_raw = style.map(|v| v.to_string());
        self.connection.execute(
            "UPDATE timeline_caption_clips SET style_json=?1 WHERE id=?2 AND video_id=?3",
            params![style_raw, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_render(&self, video_id: &str, clip_id: &str, render_id: &str) -> Result<Timeline, String> {
        let clip_group_id: String = self.connection.query_row(
            "SELECT group_id FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id], |row| row.get(0),
        ).map_err(|_| "Timeline clip was not found.".to_string())?;
        let render_group_id: String = self.connection.query_row(
            "SELECT group_id FROM image_renders WHERE id=?1 AND video_id=?2",
            params![render_id, video_id], |row| row.get(0),
        ).map_err(|_| "Image render was not found.".to_string())?;
        if clip_group_id != render_group_id {
            return Err("That version belongs to a different still.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET render_id=?1 WHERE id=?2 AND video_id=?3",
            params![render_id, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Reverts an animation clip to showing its source still, WITHOUT
    /// clearing `video_asset_id` — the generated clip stays cached (on disk
    /// and in `video_assets`) so `restore_animation_clip` can bring it right
    /// back with no re-generation, right up until a fresh "Generate
    /// Animation" replaces `video_asset_id` with a new version.
    pub fn revert_animation_clip_to_still(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        let updated = self.connection.execute(
            "UPDATE timeline_clips SET clip_kind='still' WHERE id=?1 AND video_id=?2 AND clip_kind='animation'",
            params![clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("This clip is not currently animated.".into());
        }
        self.get_timeline(video_id)
    }

    /// Re-applies a clip's cached animation (from `video_asset_id`) without
    /// calling Veo again — the counterpart to `revert_animation_clip_to_still`.
    pub fn restore_animation_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        let has_cached_asset: bool = self.connection.query_row(
            "SELECT video_asset_id IS NOT NULL FROM timeline_clips WHERE id=?1 AND video_id=?2 AND clip_kind='still'",
            params![clip_id, video_id],
            |row| row.get(0),
        ).map_err(|_| "This clip is not currently a still.".to_string())?;
        if !has_cached_asset {
            return Err("No cached animation to restore — generate one first.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET clip_kind='animation' WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_motion(&self, video_id: &str, clip_id: &str, motion_preset: &str) -> Result<Timeline, String> {
        if !MOTION_PRESETS.contains(&motion_preset) {
            return Err("Unknown camera movement preset.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET motion_preset=?1 WHERE id=?2 AND video_id=?3",
            params![motion_preset, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_transition(&self, video_id: &str, clip_id: &str, transition_in: &str) -> Result<Timeline, String> {
        if !VALID_TRANSITIONS.contains(&transition_in) {
            return Err("Unknown transition preset.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET transition_in=?1 WHERE id=?2 AND video_id=?3",
            params![transition_in, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_transition_out(&self, video_id: &str, clip_id: &str, transition_out: &str) -> Result<Timeline, String> {
        if !VALID_TRANSITIONS.contains(&transition_out) {
            return Err("Unknown transition preset.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET transition_out=?1 WHERE id=?2 AND video_id=?3",
            params![transition_out, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_motion_intensity(&self, video_id: &str, clip_id: &str, intensity: f64) -> Result<Timeline, String> {
        let clamped = intensity.clamp(0.02, 0.6);
        self.connection.execute(
            "UPDATE timeline_clips SET motion_intensity=?1 WHERE id=?2 AND video_id=?3",
            params![clamped, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_timeline_clip_color_filter(&self, video_id: &str, clip_id: &str, preset: &str, intensity: f64) -> Result<Timeline, String> {
        if !COLOR_FILTER_PRESETS.contains(&preset) {
            return Err("Unknown color filter preset.".into());
        }
        let clamped = intensity.clamp(0.0, 100.0);
        self.connection.execute(
            "UPDATE timeline_clips SET color_filter_preset=?1, color_filter_intensity=?2 WHERE id=?3 AND video_id=?4",
            params![preset, clamped, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Sets (or clears, when `effect` is `None`) a clip's AI-composed or
    /// manually-overridden motion graphic treatment. `settings_json` and
    /// `reason` are cleared together with `effect` since they only make
    /// sense alongside an assigned effect. `effect` itself is now a free-text
    /// label the AI invented (see services/python-engine/auto_gen_engine/
    /// motion_graphics_engine.py's module docstring — there's no fixed
    /// catalog to validate against anymore), kept as its own column purely
    /// for quick display/debugging; the actual recipe lives in
    /// `settings_json`. Also approximates the recipe onto the existing
    /// `motion_preset` field so it's visible in the canvas preview and
    /// rendered on export via the ffmpeg pipeline as a fallback — the real
    /// export renders the full recipe for real via services/motion-engine,
    /// this approximation is preview-only (see `approximate_motion_preset_for_effect`).
    pub fn set_timeline_clip_motion_graphic(&self, video_id: &str, clip_id: &str, effect: Option<&str>, settings_json: Option<&str>, reason: Option<&str>) -> Result<Timeline, String> {
        match effect.map(|chosen| approximate_motion_preset_for_effect(chosen, settings_json)) {
            Some(preset) => self.connection.execute(
                "UPDATE timeline_clips SET motion_graphic_effect=?1, motion_graphic_settings_json=?2, motion_graphic_reason=?3, motion_preset=?4 WHERE id=?5 AND video_id=?6",
                params![effect, settings_json, reason, preset, clip_id, video_id],
            ),
            None => self.connection.execute(
                "UPDATE timeline_clips SET motion_graphic_effect=?1, motion_graphic_settings_json=?2, motion_graphic_reason=?3 WHERE id=?4 AND video_id=?5",
                params![effect, settings_json, reason, clip_id, video_id],
            ),
        }.map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Records what Auto Motion just composed for a clip into the separate
    /// `motion_graphic_ai_snapshot_json` column, independent of the live
    /// `motion_graphic_*` columns `set_timeline_clip_motion_graphic` also
    /// just wrote for this same clip — called right alongside it, only from
    /// `analyze_motion_graphics_batch`'s own persistence (never from a
    /// manual edit), so this is always "the last thing the AI actually
    /// composed," regardless of what a person does to the live columns
    /// afterward.
    fn record_ai_motion_graphic_snapshot(&self, clip_id: &str, effect: &str, settings_json: &str, reason: &str) -> Result<(), String> {
        let snapshot = json!({ "effect": effect, "settingsJson": settings_json, "reason": reason });
        self.connection.execute(
            "UPDATE timeline_clips SET motion_graphic_ai_snapshot_json=?1 WHERE id=?2",
            params![serde_json::to_string(&snapshot).unwrap_or_default(), clip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Restores a clip's live motion graphic treatment to exactly what Auto
    /// Motion last composed for it, discarding any manual edit made since —
    /// the undo counterpart to freely reconfiguring it in
    /// `MotionSettingsPanel`. Errors if this clip was never analyzed by Auto
    /// Motion (no snapshot to restore from), including one built entirely by
    /// hand via "start from scratch".
    pub fn reset_timeline_clip_motion_graphic_to_ai(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        let snapshot_raw: Option<String> = self.connection.query_row(
            "SELECT motion_graphic_ai_snapshot_json FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| row.get(0),
        ).map_err(|_| "Clip was not found.".to_string())?;
        let Some(snapshot_raw) = snapshot_raw else {
            return Err("This still has no AI-composed motion to reset to.".into());
        };
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_raw)
            .map_err(|e| format!("Stored AI motion snapshot was invalid: {e}"))?;
        let effect = snapshot["effect"].as_str().unwrap_or_default();
        let settings_json = snapshot["settingsJson"].as_str().unwrap_or("{}");
        let reason = snapshot["reason"].as_str();
        self.set_timeline_clip_motion_graphic(video_id, clip_id, Some(effect), Some(settings_json), reason)
    }

    /// Clears the AI-assigned/overridden motion graphic on every clip in the
    /// video — the bulk counterpart to `set_timeline_clip_motion_graphic`,
    /// used by the Timeline toolbar's "Remove all effects" action.
    pub fn clear_motion_graphics_for_all_clips(&self, video_id: &str) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timeline_clips SET motion_graphic_effect=NULL, motion_graphic_settings_json=NULL, motion_graphic_reason=NULL WHERE video_id=?1",
            [video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn apply_color_filter_to_all_clips(&self, video_id: &str, preset: &str, intensity: f64) -> Result<Timeline, String> {
        if !COLOR_FILTER_PRESETS.contains(&preset) {
            return Err("Unknown color filter preset.".into());
        }
        let clamped = intensity.clamp(0.0, 100.0);
        self.connection.execute(
            "UPDATE timeline_clips SET color_filter_preset=?1, color_filter_intensity=?2 WHERE video_id=?3",
            params![preset, clamped, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn apply_motion_to_all_clips(&self, video_id: &str, motion_preset: &str, intensity: f64) -> Result<Timeline, String> {
        if !MOTION_PRESETS.contains(&motion_preset) {
            return Err("Unknown camera movement preset.".into());
        }
        let clamped = intensity.clamp(0.02, 0.6);
        self.connection.execute(
            "UPDATE timeline_clips SET motion_preset=?1, motion_intensity=?2 WHERE video_id=?3",
            params![motion_preset, clamped, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn apply_transition_in_to_all_clips(&self, video_id: &str, transition_in: &str) -> Result<Timeline, String> {
        if !VALID_TRANSITIONS.contains(&transition_in) {
            return Err("Unknown transition preset.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET transition_in=?1 WHERE video_id=?2",
            params![transition_in, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn apply_transition_out_to_all_clips(&self, video_id: &str, transition_out: &str) -> Result<Timeline, String> {
        if !VALID_TRANSITIONS.contains(&transition_out) {
            return Err("Unknown transition preset.".into());
        }
        self.connection.execute(
            "UPDATE timeline_clips SET transition_out=?1 WHERE video_id=?2",
            params![transition_out, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn apply_motion_intensity_to_all_clips(&self, video_id: &str, intensity: f64) -> Result<Timeline, String> {
        let clamped = intensity.clamp(0.02, 0.6);
        self.connection.execute(
            "UPDATE timeline_clips SET motion_intensity=?1 WHERE video_id=?2",
            params![clamped, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Assigns alternating zoom-in/zoom-out to every still on the timeline,
    /// in start-time order, all at the given intensity.
    pub fn alternate_zoom_for_all_clips(&self, video_id: &str, intensity: f64) -> Result<Timeline, String> {
        let clamped = intensity.clamp(0.02, 0.6);
        let mut statement = self.connection.prepare(
            "SELECT id FROM timeline_clips WHERE video_id=?1 ORDER BY start_seconds"
        ).map_err(|e| e.to_string())?;
        let clip_ids: Vec<String> = statement.query_map([video_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);
        for (index, clip_id) in clip_ids.iter().enumerate() {
            let preset = if index % 2 == 0 { "zoom-in" } else { "zoom-out" };
            self.connection.execute(
                "UPDATE timeline_clips SET motion_preset=?1, motion_intensity=?2 WHERE id=?3",
                params![preset, clamped, clip_id],
            ).map_err(|e| e.to_string())?;
        }
        self.get_timeline(video_id)
    }

    /// Stretches every still to close the gaps between them (and any leading
    /// gap before the first one, and trailing gap after the last one), so
    /// stills tile back-to-back with no silent black filler in between —
    /// this is what makes fade transitions actually visible, since a fade
    /// into/out of an existing black gap otherwise looks like nothing happened.
    pub fn extrapolate_stills_to_fill_gaps(&self, video_id: &str, total_duration_seconds: f64) -> Result<Timeline, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, start_seconds, end_seconds FROM timeline_clips WHERE video_id=?1 ORDER BY start_seconds"
        ).map_err(|e| e.to_string())?;
        let mut clips: Vec<(String, f64, f64)> = statement
            .query_map([video_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);

        if clips.is_empty() {
            return self.get_timeline(video_id);
        }
        // Snapshotted before any mutation below, so the update loop can tell
        // which clips actually moved and invalidate their stale motion recipe
        // accordingly (see the loop's comment).
        let original: Vec<(f64, f64)> = clips.iter().map(|c| (c.1, c.2)).collect();
        clips[0].1 = 0.0;
        let len = clips.len();
        for i in 0..len.saturating_sub(1) {
            let next_start = clips[i + 1].1;
            clips[i].2 = next_start;
        }
        if let Some(last) = clips.last_mut() {
            last.2 = last.2.max(total_duration_seconds);
        }

        for (i, (id, start, end)) in clips.iter().enumerate() {
            self.connection.execute(
                "UPDATE timeline_clips SET start_seconds=?1, end_seconds=?2 WHERE id=?3",
                params![start, end, id],
            ).map_err(|e| e.to_string())?;
            // A still's AI-composed motion recipe is validated against its
            // duration at the time Auto Motion ran — several of its fields
            // (fadeInFrames/fadeOutFrames, maskHoldFrames, freezeHoldFrames)
            // are absolute frame counts, not proportions, so silently
            // stretching/shrinking the clip underneath an existing recipe
            // can leave it badly mismatched rather than just slightly off.
            // Clear it here so the clip falls back to "no motion assigned"
            // (see ClipInspector's empty state) and Auto Motion recomputes
            // it fresh for the new duration next time it runs.
            let (orig_start, orig_end) = original[i];
            if (*start - orig_start).abs() > 1e-6 || (*end - orig_end).abs() > 1e-6 {
                self.connection.execute(
                    "UPDATE timeline_clips SET motion_graphic_effect=NULL, motion_graphic_settings_json=NULL, motion_graphic_reason=NULL WHERE id=?1 AND motion_graphic_effect IS NOT NULL",
                    [id],
                ).map_err(|e| e.to_string())?;
            }
        }
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    /// Resets every stills clip's start/end back to its natural sentence-based
    /// timing from the visual plan — undoes whatever `extrapolate_stills_to_fill_gaps`
    /// stretched, without touching motion/transitions/version selection.
    pub fn reset_stills_timing_to_natural(&self, video_id: &str) -> Result<Timeline, String> {
        let plan = self.get_visual_plan(video_id)?;
        let sentence_map: std::collections::HashMap<_, _> =
            plan.sentences.iter().map(|s| (s.id.as_str(), s)).collect();
        let group_timing: std::collections::HashMap<&str, (f64, f64)> = plan.groups.iter().map(|group| {
            let sentences: Vec<_> = group.sentence_ids.iter().filter_map(|id| sentence_map.get(id.as_str())).collect();
            let start = sentences.first().map(|s| s.start_seconds).unwrap_or(0.0);
            let end = sentences.last().map(|s| s.end_seconds).unwrap_or(start + 1.0);
            (group.id.as_str(), (start, end))
        }).collect();

        let timeline = self.get_timeline(video_id)?;
        for clip in &timeline.clips {
            if let Some(&(start, end)) = group_timing.get(clip.group_id.as_str()) {
                self.connection.execute(
                    "UPDATE timeline_clips SET start_seconds=?1, end_seconds=?2 WHERE id=?3",
                    params![start, end, clip.id],
                ).map_err(|e| e.to_string())?;
            }
        }
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn delete_timeline_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        self.connection.execute(
            "DELETE FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    /// Copies a Stills-track clip's settings (motion/transitions/source) into
    /// a new clip appended after everything else on the track — appending
    /// (rather than inserting right next to the original) sidesteps the
    /// overlap check entirely, which is the least surprising default for a
    /// context-menu "Duplicate clip" action.
    #[allow(clippy::type_complexity)]
    pub fn duplicate_timeline_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        let (
            group_id, render_id, label, motion_preset, transition_in, transition_out, motion_intensity,
            clip_kind, video_asset_id, media_library_asset_id, start_seconds, end_seconds,
            color_filter_preset, color_filter_intensity,
            motion_graphic_effect, motion_graphic_settings_json, motion_graphic_reason, motion_graphic_ai_snapshot_json,
        ): (String, Option<String>, String, String, String, String, f64, String, Option<String>, Option<String>, f64, f64, String, f64, Option<String>, Option<String>, Option<String>, Option<String>) = self.connection.query_row(
            "SELECT group_id,render_id,label,motion_preset,transition_in,transition_out,motion_intensity,clip_kind,video_asset_id,media_library_asset_id,start_seconds,end_seconds,color_filter_preset,color_filter_intensity,motion_graphic_effect,motion_graphic_settings_json,motion_graphic_reason,motion_graphic_ai_snapshot_json FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?,
                row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?,
                row.get(14)?, row.get(15)?, row.get(16)?, row.get(17)?,
            )),
        ).map_err(|_| "Clip was not found.".to_string())?;
        let duration = (end_seconds - start_seconds).max(0.5);
        let timeline_end: f64 = self.connection.query_row(
            "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_clips WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let new_start = timeline_end;
        let new_end = new_start + duration;
        let next_ordinal: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM timeline_clips WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label,motion_preset,transition_in,transition_out,motion_intensity,clip_kind,video_asset_id,media_library_asset_id,color_filter_preset,color_filter_intensity,motion_graphic_effect,motion_graphic_settings_json,motion_graphic_reason,motion_graphic_ai_snapshot_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![Uuid::new_v4().to_string(), video_id, group_id, render_id, next_ordinal, new_start, new_end, label, motion_preset, transition_in, transition_out, motion_intensity, clip_kind, video_asset_id, media_library_asset_id, color_filter_preset, color_filter_intensity, motion_graphic_effect, motion_graphic_settings_json, motion_graphic_reason, motion_graphic_ai_snapshot_json],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    // ===== Media library (Editor tab: Stills / Clips / Audio tabs) =====

    fn media_library_asset_by_id(&self, id: &str) -> Result<Option<MediaLibraryAsset>, String> {
        self.connection.query_row(
            "SELECT id,video_id,kind,original_name,relative_path,media_type,size_bytes,duration_seconds,created_at FROM media_library_assets WHERE id=?1",
            [id],
            |row| Ok(MediaLibraryAsset {
                id: row.get(0)?, video_id: row.get(1)?, kind: row.get(2)?, original_name: row.get(3)?,
                relative_path: row.get(4)?, media_type: row.get(5)?, size_bytes: row.get(6)?,
                duration_seconds: row.get(7)?, created_at: row.get(8)?,
            }),
        ).optional().map_err(|e| e.to_string())
    }

    /// Imports a file into the per-video media library. `kind` is `None` for
    /// the top-level "+ Import" entry point, which has no pre-selected kind —
    /// the kind is inferred from the file's extension instead.
    pub fn import_media_library_asset(
        &self,
        video_id: &str,
        source: &Path,
        kind: Option<&str>,
        engine_dir: &Path,
    ) -> Result<MediaLibraryAsset, String> {
        self.import_media_library_asset_with_known_duration(video_id, source, kind, engine_dir, None)
    }

    /// Same as `import_media_library_asset`, but skips the ffprobe duration
    /// probe when the caller already knows the exact duration (e.g.
    /// `import_asset_folder`, where `timing.txt` already states it) — probing
    /// spawns a Python subprocess per file, which is the whole cost of
    /// importing dozens of clips one at a time.
    fn import_media_library_asset_with_known_duration(
        &self,
        video_id: &str,
        source: &Path,
        kind: Option<&str>,
        engine_dir: &Path,
        known_duration_seconds: Option<f64>,
    ) -> Result<MediaLibraryAsset, String> {
        let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        let resolved_kind = match kind {
            Some(k) => k,
            None => media_library_kind_for_extension(&extension)
                .ok_or("Unsupported file type for the media library.")?,
        };
        let allowed = match resolved_kind {
            "still" => ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()),
            // Clips accept video files as well as images — a still can be
            // dropped onto the Clips track and treated as a static clip.
            "clip" => ["mp4", "mov", "webm", "mkv", "png", "jpg", "jpeg", "webp"].contains(&extension.as_str()),
            "audio" => ["mp3", "wav", "m4a", "aac", "flac", "ogg"].contains(&extension.as_str()),
            _ => false,
        };
        if !allowed {
            return Err("Unsupported media library file type.".into());
        }
        let (channel_id,): (String,) = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1 AND trashed_at IS NULL",
            [video_id], |row| Ok((row.get(0)?,)),
        ).map_err(|_| "Video was not found.".to_string())?;
        let original_name = source.file_name().and_then(|value| value.to_str())
            .ok_or("Invalid file name.")?.to_string();
        let id = Uuid::new_v4().to_string();
        let folder = match resolved_kind {
            "still" => "library/stills",
            "clip" => "library/clips",
            _ => "library/audio",
        };
        let destination_dir = self.projects_dir.join(&channel_id).join(video_id).join(folder);
        fs::create_dir_all(&destination_dir).map_err(|e| e.to_string())?;
        let stored_name = format!("{id}.{extension}");
        let destination = destination_dir.join(&stored_name);
        fs::copy(source, &destination).map_err(|e| e.to_string())?;
        let size_bytes = fs::metadata(&destination).map_err(|e| e.to_string())?.len() as i64;
        let relative_path = format!("{folder}/{stored_name}");
        let media_type = extension_to_media_type(&extension).to_string();
        // Stills don't need a probed duration (the timeline gives them a
        // default slot length); clips and audio do, via the same ffprobe
        // wrapper used for narration duration — unless the caller already
        // knows it precisely, in which case probing would be redundant work.
        let duration_seconds = if known_duration_seconds.is_some() {
            known_duration_seconds
        } else if resolved_kind != "still" {
            Self::probe_audio_duration(engine_dir, &destination).ok()
        } else {
            None
        };
        let created_at = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO media_library_assets(id,video_id,kind,original_name,relative_path,media_type,size_bytes,duration_seconds,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id, video_id, resolved_kind, original_name, relative_path, media_type, size_bytes, duration_seconds, created_at],
        ).map_err(|e| e.to_string())?;
        Ok(MediaLibraryAsset {
            id, video_id: video_id.into(), kind: resolved_kind.into(), original_name,
            relative_path, media_type, size_bytes, duration_seconds, created_at,
        })
    }

    pub fn list_media_library_assets(&self, video_id: &str, kind: Option<&str>) -> Result<Vec<MediaLibraryAsset>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id,video_id,kind,original_name,relative_path,media_type,size_bytes,duration_seconds,created_at FROM media_library_assets WHERE video_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let assets = statement.query_map(params![video_id, kind], |row| {
            Ok(MediaLibraryAsset {
                id: row.get(0)?, video_id: row.get(1)?, kind: row.get(2)?, original_name: row.get(3)?,
                relative_path: row.get(4)?, media_type: row.get(5)?, size_bytes: row.get(6)?,
                duration_seconds: row.get(7)?, created_at: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(assets)
    }

    /// Removes a media library asset's file + row, cascading to any timeline
    /// clips (Stills/Music/Logo tracks) that reference it — the frontend
    /// confirms this with the user first, listing what will be affected.
    pub fn remove_media_library_asset(&self, asset_id: &str) -> Result<(), String> {
        let asset = self.media_library_asset_by_id(asset_id)?.ok_or("Media library asset was not found.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let path = self.projects_dir.join(channel_id).join(&asset.video_id).join(&asset.relative_path);
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        self.connection.execute("DELETE FROM timeline_clips WHERE media_library_asset_id=?1", [asset_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_music_clips WHERE media_library_asset_id=?1", [asset_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_logo_clips WHERE media_library_asset_id=?1", [asset_id]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM media_library_assets WHERE id=?1", [asset_id]).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(&asset.video_id)?;
        Ok(())
    }

    pub fn media_library_asset_file_path(&self, asset_id: &str) -> Result<PathBuf, String> {
        let asset = self.media_library_asset_by_id(asset_id)?.ok_or("Media library asset was not found.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(self.projects_dir.join(channel_id).join(&asset.video_id).join(&asset.relative_path))
    }

    /// Removes steady-state background noise (hiss, hum, static) from an
    /// Audio-tab library asset. Non-destructive like every other
    /// file-producing action in the editor (motion graphics, retiming): the
    /// cleaned audio lands as a brand-new library asset alongside the
    /// original rather than overwriting it, so the source is never lost and
    /// any timeline clip already using the original is unaffected.
    pub fn denoise_media_library_asset(&self, asset_id: &str, engine_dir: &Path) -> Result<MediaLibraryAsset, String> {
        let asset = self.media_library_asset_by_id(asset_id)?.ok_or("Media library asset was not found.")?;
        if asset.kind != "audio" {
            return Err("Only files in the Audio tab can have background noise removed.".into());
        }
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [&asset.video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let video_dir = self.projects_dir.join(&channel_id).join(&asset.video_id);
        let source_path = video_dir.join(&asset.relative_path);
        let extension = Path::new(&asset.relative_path)
            .extension().and_then(|value| value.to_str()).unwrap_or("mp3");
        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}.{extension}");
        let destination_dir = video_dir.join("library/audio");
        fs::create_dir_all(&destination_dir).map_err(|e| e.to_string())?;
        let destination = destination_dir.join(&stored_name);
        Self::run_denoise_audio(engine_dir, &source_path, &destination)?;
        let size_bytes = fs::metadata(&destination).map_err(|e| e.to_string())?.len() as i64;
        // Loudness-normalizing shouldn't meaningfully change duration, but
        // re-probe rather than trust the source's stored value — cheap, and
        // matches how every other imported/derived audio file gets its
        // duration (see `import_media_library_asset`).
        let duration_seconds = Self::probe_audio_duration(engine_dir, &destination).ok();
        let relative_path = format!("library/audio/{stored_name}");
        let original_name = match asset.original_name.rsplit_once('.') {
            Some((stem, ext)) => format!("{stem} (denoised).{ext}"),
            None => format!("{} (denoised)", asset.original_name),
        };
        let created_at = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO media_library_assets(id,video_id,kind,original_name,relative_path,media_type,size_bytes,duration_seconds,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id, asset.video_id, "audio", original_name, relative_path, asset.media_type, size_bytes, duration_seconds, created_at],
        ).map_err(|e| e.to_string())?;
        Ok(MediaLibraryAsset {
            id, video_id: asset.video_id.clone(), kind: "audio".into(), original_name,
            relative_path, media_type: asset.media_type.clone(), size_bytes, duration_seconds, created_at,
        })
    }

    /// All Veo-generated clips for a video (across every still), for the
    /// Clips tab's "Generated" section — re-placeable onto the Stills track.
    pub fn list_video_assets(&self, video_id: &str) -> Result<Vec<VideoAsset>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at FROM video_assets WHERE video_id=?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let assets = statement.query_map([video_id], |row| Ok(VideoAsset {
            id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?, source_render_id: row.get(3)?,
            version: row.get(4)?, parent_video_asset_id: row.get(5)?, kind: row.get(6)?,
            file_name: row.get(7)?, relative_path: row.get(8)?, resolution: row.get(9)?,
            requested_duration_seconds: row.get(10)?, veo_duration_seconds: row.get(11)?,
            actual_duration_seconds: row.get(12)?, veo_model: row.get(13)?, veo_operation_name: row.get(14)?,
            prompt: row.get(15)?, created_at: row.get(16)?,
        })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(assets)
    }

    // ===== Placing library/generated assets onto the Stills track =====

    pub fn add_video_asset_clip_to_stills_track(&self, video_id: &str, video_asset_id: &str, start_seconds: f64) -> Result<Timeline, String> {
        if start_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let asset = self.get_video_asset(video_asset_id)?;
        let duration = asset.actual_duration_seconds.max(0.5);
        let end_seconds = start_seconds + duration;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, start_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing clip on the stills track.".into());
        }
        let next_ordinal: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM timeline_clips WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label,clip_kind,video_asset_id) VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,'animation',?8)",
            params![Uuid::new_v4().to_string(), video_id, asset.group_id, next_ordinal, start_seconds, end_seconds, asset.file_name, video_asset_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn add_library_asset_to_stills_track(&self, video_id: &str, media_library_asset_id: &str, start_seconds: f64) -> Result<Timeline, String> {
        if start_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let asset = self.media_library_asset_by_id(media_library_asset_id)?.ok_or("Media library asset was not found.")?;
        let (clip_kind, duration) = match asset.kind.as_str() {
            "still" => ("imported-still", 3.0),
            "clip" => ("imported-clip", asset.duration_seconds.unwrap_or(3.0).max(0.5)),
            _ => return Err("That asset cannot be placed on the stills track.".into()),
        };
        let end_seconds = start_seconds + duration;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, start_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing clip on the stills track.".into());
        }
        let next_ordinal: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM timeline_clips WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label,clip_kind,media_library_asset_id) VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9)",
            params![Uuid::new_v4().to_string(), video_id, format!("library:{media_library_asset_id}"), next_ordinal, start_seconds, end_seconds, asset.original_name, clip_kind, media_library_asset_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    // ===== Music track =====

    pub fn add_music_clip(&self, video_id: &str, media_library_asset_id: &str, start_seconds: f64) -> Result<Timeline, String> {
        if start_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let asset = self.media_library_asset_by_id(media_library_asset_id)?.ok_or("Media library asset was not found.")?;
        if asset.kind != "audio" {
            return Err("Only audio assets can be placed on the music track.".into());
        }
        let duration = asset.duration_seconds.unwrap_or(3.0).max(0.5);
        let end_seconds = start_seconds + duration;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_music_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, start_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing clip on the music track.".into());
        }
        let next_ordinal: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM timeline_music_clips WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        // 30% matches the spec's stated default for music under narration —
        // set explicitly rather than relying on the column DEFAULT so it
        // applies consistently even against a database created before this
        // default changed.
        self.connection.execute(
            "INSERT INTO timeline_music_clips(id,video_id,media_library_asset_id,ordinal,start_seconds,end_seconds,label,volume_percent) VALUES(?1,?2,?3,?4,?5,?6,?7,30)",
            params![Uuid::new_v4().to_string(), video_id, media_library_asset_id, next_ordinal, start_seconds, end_seconds, asset.original_name],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn update_music_clip(&self, video_id: &str, clip_id: &str, start: f64, end: f64) -> Result<Timeline, String> {
        if start < 0.0 || end <= start {
            return Err("Clip boundaries are invalid.".into());
        }
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_music_clips WHERE video_id=?1 AND id<>?2 AND ?3 < end_seconds AND ?4 > start_seconds)",
            params![video_id, clip_id, start, end], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("Timeline clips may not overlap on the same track.".into());
        }
        self.connection.execute(
            "UPDATE timeline_music_clips SET start_seconds=?1,end_seconds=?2 WHERE id=?3 AND video_id=?4",
            params![start, end, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_music_clip_settings(
        &self, video_id: &str, clip_id: &str, volume_percent: f64,
        fade_in_enabled: bool, fade_in_seconds: f64, fade_out_enabled: bool, fade_out_seconds: f64,
        auto_duck: bool, loop_enabled: bool,
    ) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timeline_music_clips SET volume_percent=?1,fade_in_enabled=?2,fade_in_seconds=?3,fade_out_enabled=?4,fade_out_seconds=?5,auto_duck=?6,loop_enabled=?7 WHERE id=?8 AND video_id=?9",
            params![volume_percent.clamp(0.0, 200.0), fade_in_enabled as i64, fade_in_seconds.max(0.0), fade_out_enabled as i64, fade_out_seconds.max(0.0), auto_duck as i64, loop_enabled as i64, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn delete_music_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        self.connection.execute("DELETE FROM timeline_music_clips WHERE id=?1 AND video_id=?2", params![clip_id, video_id]).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn set_sequence_locked(&self, video_id: &str, locked: bool) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timelines SET sequence_locked=?1,updated_at=?2 WHERE video_id=?3",
            params![locked as i64, Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_narration_settings(&self, video_id: &str, volume_percent: f64, trim_start_seconds: f64, trim_end_seconds: f64) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timelines SET narration_volume_percent=?1,narration_trim_start_seconds=?2,narration_trim_end_seconds=?3,updated_at=?4 WHERE video_id=?5",
            params![volume_percent.clamp(0.0, 200.0), trim_start_seconds.max(0.0), trim_end_seconds.max(0.0), Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_music_master_settings(&self, video_id: &str, master_volume_percent: f64, duck_sensitivity_percent: f64) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timelines SET music_master_volume_percent=?1,music_duck_sensitivity_percent=?2,updated_at=?3 WHERE video_id=?4",
            params![master_volume_percent.clamp(0.0, 200.0), duck_sensitivity_percent.clamp(0.0, 100.0), Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    // ===== Overlays track: text =====

    pub fn add_text_overlay_clip(&self, video_id: &str, at_seconds: f64) -> Result<Timeline, String> {
        if at_seconds < 0.0 {
            return Err("Clip position is invalid.".into());
        }
        self.ensure_timeline_row(video_id)?;
        let end_seconds = at_seconds + 3.0;
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_text_clips WHERE video_id=?1 AND ?2 < end_seconds AND ?3 > start_seconds)",
            params![video_id, at_seconds, end_seconds], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("That position overlaps an existing text overlay. Move the playhead or trim the other overlay first.".into());
        }
        self.connection.execute(
            "INSERT INTO timeline_text_clips(id,video_id,start_seconds,end_seconds,text) VALUES(?1,?2,?3,?4,?5)",
            params![Uuid::new_v4().to_string(), video_id, at_seconds, end_seconds, "New text"],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn update_text_overlay_clip(&self, video_id: &str, clip_id: &str, start: f64, end: f64) -> Result<Timeline, String> {
        if start < 0.0 || end <= start {
            return Err("Clip boundaries are invalid.".into());
        }
        let overlap: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_text_clips WHERE video_id=?1 AND id<>?2 AND ?3 < end_seconds AND ?4 > start_seconds)",
            params![video_id, clip_id, start, end], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if overlap {
            return Err("Text overlays may not overlap on the same track.".into());
        }
        self.connection.execute(
            "UPDATE timeline_text_clips SET start_seconds=?1,end_seconds=?2 WHERE id=?3 AND video_id=?4",
            params![start, end, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_text_overlay_style(
        &self, video_id: &str, clip_id: &str, text: &str, font_family: &str, font_size_px: f64,
        bold: bool, italic: bool, color: &str, background_mode: &str, background_color: &str,
        position: &str, animation: &str,
    ) -> Result<Timeline, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Overlay text is required.".into());
        }
        if !["none", "solid", "blur"].contains(&background_mode) {
            return Err("Unsupported background mode.".into());
        }
        if !["none", "fade", "slide"].contains(&animation) {
            return Err("Unsupported animation.".into());
        }
        self.connection.execute(
            "UPDATE timeline_text_clips SET text=?1,font_family=?2,font_size_px=?3,bold=?4,italic=?5,color=?6,background_mode=?7,background_color=?8,position=?9,animation=?10 WHERE id=?11 AND video_id=?12",
            params![trimmed, font_family, font_size_px.max(4.0), bold as i64, italic as i64, color, background_mode, background_color, position, animation, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn delete_text_overlay_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        self.connection.execute("DELETE FROM timeline_text_clips WHERE id=?1 AND video_id=?2", params![clip_id, video_id]).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    // ===== Overlays track: logo/watermark =====

    pub fn add_logo_clip(&self, video_id: &str, media_library_asset_id: &str) -> Result<Timeline, String> {
        self.ensure_timeline_row(video_id)?;
        let asset = self.media_library_asset_by_id(media_library_asset_id)?.ok_or("Media library asset was not found.")?;
        if asset.kind != "still" {
            return Err("Logo/watermark must be an image asset.".into());
        }
        let duration_seconds: f64 = self.connection.query_row(
            "SELECT duration_seconds FROM timelines WHERE video_id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO timeline_logo_clips(id,video_id,media_library_asset_id,start_seconds,end_seconds,position,size_percent,opacity_percent,show_throughout) \
             VALUES(?1,?2,?3,0,?4,'bottom-right',10,80,1)",
            params![Uuid::new_v4().to_string(), video_id, media_library_asset_id, duration_seconds.max(1.0)],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Manually dragging/resizing a logo clip means it can no longer claim to
    /// run the entire video, so this turns off `show_throughout` — re-enabling
    /// it (via `set_logo_clip_style`) resnaps start/end to the full duration.
    pub fn update_logo_clip(&self, video_id: &str, clip_id: &str, start: f64, end: f64) -> Result<Timeline, String> {
        if start < 0.0 || end <= start {
            return Err("Clip boundaries are invalid.".into());
        }
        self.connection.execute(
            "UPDATE timeline_logo_clips SET start_seconds=?1,end_seconds=?2,show_throughout=0 WHERE id=?3 AND video_id=?4",
            params![start, end, clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn set_logo_clip_style(&self, video_id: &str, clip_id: &str, position: &str, size_percent: f64, opacity_percent: f64, show_throughout: bool) -> Result<Timeline, String> {
        if !["top-left", "top-right", "bottom-left", "bottom-right", "center"].contains(&position) {
            return Err("Unsupported logo position.".into());
        }
        let clamped_size = size_percent.clamp(5.0, 30.0);
        let clamped_opacity = opacity_percent.clamp(0.0, 100.0);
        if show_throughout {
            let duration_seconds: f64 = self.connection.query_row(
                "SELECT duration_seconds FROM timelines WHERE video_id=?1", [video_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            self.connection.execute(
                "UPDATE timeline_logo_clips SET position=?1,size_percent=?2,opacity_percent=?3,show_throughout=1,start_seconds=0,end_seconds=?4 WHERE id=?5 AND video_id=?6",
                params![position, clamped_size, clamped_opacity, duration_seconds.max(1.0), clip_id, video_id],
            ).map_err(|e| e.to_string())?;
        } else {
            self.connection.execute(
                "UPDATE timeline_logo_clips SET position=?1,size_percent=?2,opacity_percent=?3,show_throughout=0 WHERE id=?4 AND video_id=?5",
                params![position, clamped_size, clamped_opacity, clip_id, video_id],
            ).map_err(|e| e.to_string())?;
        }
        self.get_timeline(video_id)
    }

    pub fn delete_logo_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        self.connection.execute("DELETE FROM timeline_logo_clips WHERE id=?1 AND video_id=?2", params![clip_id, video_id]).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    /// Resets every Stills-track clip's motion/transitions back to defaults —
    /// distinct from a single clip's "Remove effects" and from
    /// `clear_timeline_track` (which deletes clips outright).
    pub fn remove_all_clip_effects(&self, video_id: &str) -> Result<Timeline, String> {
        self.connection.execute(
            "UPDATE timeline_clips SET motion_preset='none', transition_in='cut', transition_out='cut', motion_intensity=0.22, color_filter_preset='none', color_filter_intensity=100, motion_graphic_effect=NULL, motion_graphic_settings_json=NULL, motion_graphic_reason=NULL WHERE video_id=?1",
            [video_id],
        ).map_err(|e| e.to_string())?;
        self.get_timeline(video_id)
    }

    pub fn delete_timeline_caption_clip(&self, video_id: &str, clip_id: &str) -> Result<Timeline, String> {
        self.connection.execute(
            "DELETE FROM timeline_caption_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
        ).map_err(|e| e.to_string())?;
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn clear_timeline_track(&self, video_id: &str, track: &str) -> Result<Timeline, String> {
        match track {
            "stills" => {
                self.connection.execute("DELETE FROM timeline_clips WHERE video_id=?1", [video_id])
                    .map_err(|e| e.to_string())?;
            }
            "captions" => {
                self.connection.execute("DELETE FROM timeline_caption_clips WHERE video_id=?1", [video_id])
                    .map_err(|e| e.to_string())?;
            }
            "music" => {
                self.connection.execute("DELETE FROM timeline_music_clips WHERE video_id=?1", [video_id])
                    .map_err(|e| e.to_string())?;
            }
            "overlays" => {
                self.connection.execute("DELETE FROM timeline_text_clips WHERE video_id=?1", [video_id])
                    .map_err(|e| e.to_string())?;
                self.connection.execute("DELETE FROM timeline_logo_clips WHERE video_id=?1", [video_id])
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err("Unknown timeline track.".into()),
        }
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    /// Discards every timeline customization (still order/timing/motion/
    /// transitions, caption edits/styles, narration offset, zoom/playhead,
    /// music/text/logo placements) and rebuilds fresh from the visual plan
    /// and the last-generated captions — as if the timeline had just been
    /// opened for the first time. Imported media library assets themselves
    /// are NOT deleted (only their placement on a track), since the library
    /// is a separate concept from any one timeline arrangement.
    pub fn reset_timeline_to_default(&self, video_id: &str) -> Result<Timeline, String> {
        // animation_job_items.clip_id has a hard FK to timeline_clips(id) —
        // clear that generation bookkeeping first (the cached video_asset it
        // points to is left untouched, same as revert_animation_clip_to_still,
        // so nothing actually generated is lost, only the job history).
        self.connection.execute("DELETE FROM animation_job_items WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM animation_jobs WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_caption_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_music_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_text_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_logo_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE timelines SET caption_style_json='{}', narration_offset_seconds=0, zoom=1, playhead_seconds=0, music_master_volume_percent=100, music_duck_sensitivity_percent=50, updated_at=?1 WHERE video_id=?2",
            params![Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        self.populate_timeline_from_sources(video_id)
    }

    /// Restores every timeline track table from a full `Timeline` snapshot
    /// (JSON-serialized) — the frontend keeps an in-memory undo/redo stack of
    /// up to 50 whole-timeline snapshots and calls this to jump back to one.
    /// Deletes and reinserts every row rather than diffing, which keeps this
    /// simple and correct regardless of how many fields changed since the
    /// snapshot was taken. Mirrors `reset_timeline_to_default`'s FK-ordering:
    /// animation_job_items/animation_jobs reference timeline_clips.id and
    /// must be cleared before timeline_clips itself.
    pub fn restore_timeline_snapshot(&self, video_id: &str, snapshot_json: &str) -> Result<Timeline, String> {
        let snapshot: Timeline = serde_json::from_str(snapshot_json)
            .map_err(|e| format!("Invalid timeline snapshot: {e}"))?;
        if snapshot.video_id != video_id {
            return Err("Snapshot does not belong to this video.".to_string());
        }

        self.connection.execute("DELETE FROM animation_job_items WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM animation_jobs WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_caption_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_music_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_text_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM timeline_logo_clips WHERE video_id=?1", [video_id])
            .map_err(|e| e.to_string())?;

        for clip in &snapshot.clips {
            self.connection.execute(
                "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label,motion_preset,transition_in,transition_out,motion_intensity,clip_kind,video_asset_id,media_library_asset_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    clip.id, video_id, clip.group_id, clip.render_id, clip.ordinal, clip.start_seconds, clip.end_seconds,
                    clip.label, clip.motion_preset, clip.transition_in, clip.transition_out, clip.motion_intensity,
                    clip.clip_kind, clip.video_asset_id, clip.media_library_asset_id,
                ],
            ).map_err(|e| e.to_string())?;
        }
        for clip in &snapshot.caption_clips {
            let style_json = clip.style.as_ref().map(|value| value.to_string());
            let words_json = clip.words.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
            self.connection.execute(
                "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,style_json,words_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![clip.id, video_id, clip.source_chunk_index, clip.text, clip.ordinal, clip.start_seconds, clip.end_seconds, style_json, words_json],
            ).map_err(|e| e.to_string())?;
        }
        for clip in &snapshot.music_clips {
            self.connection.execute(
                "INSERT INTO timeline_music_clips(id,video_id,media_library_asset_id,ordinal,start_seconds,end_seconds,label,volume_percent,fade_in_enabled,fade_in_seconds,fade_out_enabled,fade_out_seconds,auto_duck,loop_enabled) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    clip.id, video_id, clip.media_library_asset_id, clip.ordinal, clip.start_seconds, clip.end_seconds,
                    clip.label, clip.volume_percent, clip.fade_in_enabled, clip.fade_in_seconds, clip.fade_out_enabled,
                    clip.fade_out_seconds, clip.auto_duck, clip.loop_enabled,
                ],
            ).map_err(|e| e.to_string())?;
        }
        for clip in &snapshot.text_clips {
            self.connection.execute(
                "INSERT INTO timeline_text_clips(id,video_id,start_seconds,end_seconds,text,font_family,font_size_px,bold,italic,color,background_mode,background_color,position,animation) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    clip.id, video_id, clip.start_seconds, clip.end_seconds, clip.text, clip.font_family, clip.font_size_px,
                    clip.bold, clip.italic, clip.color, clip.background_mode, clip.background_color, clip.position, clip.animation,
                ],
            ).map_err(|e| e.to_string())?;
        }
        for clip in &snapshot.logo_clips {
            self.connection.execute(
                "INSERT INTO timeline_logo_clips(id,video_id,media_library_asset_id,start_seconds,end_seconds,position,size_percent,opacity_percent,show_throughout) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![clip.id, video_id, clip.media_library_asset_id, clip.start_seconds, clip.end_seconds, clip.position, clip.size_percent, clip.opacity_percent, clip.show_throughout],
            ).map_err(|e| e.to_string())?;
        }

        self.connection.execute(
            "UPDATE timelines SET playhead_seconds=?1,zoom=?2,caption_style_json=?3,narration_offset_seconds=?4,music_master_volume_percent=?5,music_duck_sensitivity_percent=?6,sequence_locked=?7,narration_volume_percent=?8,narration_trim_start_seconds=?9,narration_trim_end_seconds=?10,updated_at=?11 WHERE video_id=?12",
            params![
                snapshot.playhead_seconds, snapshot.zoom, snapshot.caption_style.to_string(), snapshot.narration_offset_seconds,
                snapshot.music_master_volume_percent, snapshot.music_duck_sensitivity_percent, snapshot.sequence_locked,
                snapshot.narration_volume_percent, snapshot.narration_trim_start_seconds, snapshot.narration_trim_end_seconds,
                Utc::now().to_rfc3339(), video_id,
            ],
        ).map_err(|e| e.to_string())?;

        // duration_seconds is always derived from track contents (see
        // recompute_timeline_duration's own doc comment on why logo clips are
        // excluded) rather than trusted verbatim from the snapshot.
        self.recompute_timeline_duration(video_id)?;
        self.get_timeline(video_id)
    }

    pub fn save_provider_key(&self, provider: &str, api_key: &str) -> Result<(), String> {
        let entry = Entry::new("auto-gen-studio", provider).map_err(|e| e.to_string())?;
        entry.set_password(api_key).map_err(|e| e.to_string())
    }

    fn get_provider_key(&self, provider: &str) -> Result<Option<String>, String> {
        let entry = Entry::new("auto-gen-studio", provider).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn gemini_auth(&self) -> Result<GeminiAuth, String> {
        if let Some(key) = self.get_provider_key("gemini")? {
            if !key.trim().is_empty() {
                return Ok(GeminiAuth::ApiKey(key));
            }
        }
        let credentials_path = std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
            .map_err(|_| "Configure GEMINI_API_KEY or GOOGLE_APPLICATION_CREDENTIALS.".to_string())?;
        let account: GoogleServiceAccount = serde_json::from_slice(
            &fs::read(&credentials_path)
                .map_err(|_| "Google Cloud credentials JSON could not be read.".to_string())?,
        ).map_err(|_| "Google Cloud credentials JSON is invalid.".to_string())?;
        let now = Utc::now().timestamp() as usize;
        let assertion = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &GoogleJwtClaims {
                iss: account.client_email,
                scope: "https://www.googleapis.com/auth/cloud-platform".into(),
                aud: account.token_uri.clone(),
                iat: now,
                exp: now + 3600,
            },
            &jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes())
                .map_err(|_| "Google service-account private key is invalid.".to_string())?,
        ).map_err(|error| format!("Could not sign Google authentication request: {error}"))?;
        let response = reqwest::blocking::Client::new()
            .post(&account.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .map_err(|error| format!("Could not authenticate with Google Cloud: {error}"))?;
        let status = response.status();
        let body: serde_json::Value = response.json()
            .map_err(|_| "Google Cloud returned an unreadable authentication response.".to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Google Cloud authentication failed ({status}): {}",
                body.pointer("/error_description").and_then(|value| value.as_str()).unwrap_or("unknown error")
            ));
        }
        Ok(GeminiAuth::Vertex {
            access_token: body.get("access_token").and_then(|value| value.as_str())
                .ok_or("Google Cloud returned no access token.")?.to_string(),
            project_id: account.project_id,
        })
    }

    pub fn get_provider_key_status(&self, provider: &str) -> Result<ProviderKeyStatus, String> {
        let configured = if provider == "gemini" {
            self.get_provider_key(provider)?.is_some()
                || std::env::var("GOOGLE_APPLICATION_CREDENTIALS").ok()
                    .is_some_and(|path| Path::new(&path).exists())
        } else {
            self.get_provider_key(provider)?.is_some()
        };
        Ok(ProviderKeyStatus {
            provider: provider.to_string(),
            configured,
        })
    }

    /// Preferences' "Test" button — a minimal real call to confirm a saved
    /// key actually works, not just that something is stored under it.
    pub fn test_provider_key(&self, provider: &str) -> Result<(), String> {
        match provider {
            "openai" => {
                let key = self.get_provider_key("openai")?.filter(|value| !value.trim().is_empty())
                    .ok_or("No OpenAI API key is saved.")?;
                request_openai_text(&key, "Reply with the single word: OK").map(|_| ())
            }
            "gemini" => {
                let auth = self.gemini_auth()?;
                request_gemini_text(&auth, r#"Reply with exactly this JSON: {"ok": true}"#).map(|_| ())
            }
            _ => Err(format!("Unknown provider: {provider}")),
        }
    }

    /// Every still whose newest render is missing or stale relative to its
    /// newest prompt/educational plan — the same "needs (re)generation"
    /// check `create_image_job` used to run internally before selection
    /// existed. Used by the Bulk Generation panel purely to compute its
    /// default pre-checked selection (empty/outdated stills start checked,
    /// up-to-date ones start unchecked but remain manually selectable) —
    /// `create_image_job` itself no longer re-derives this on its own.
    pub fn pending_still_ids(&self, video_id: &str) -> Result<Vec<String>, String> {
        let plan = self.get_visual_plan(video_id)?;
        let mut pending = Vec::new();
        for group in plan.groups {
            // A still with no prompt at all yet (never planned — the normal
            // state for a fresh/never-bulk-planned project, and the whole
            // reason this panel exists) is simply pending, not an error.
            // This used to hard-fail here (inherited from create_image_job's
            // OLD internal check, which only ever ran AFTER planning had
            // already produced a prompt for every still) — which broke
            // opening the Bulk Generation panel at all on any project with
            // an unplanned still, well before the user ever gets a chance
            // to plan one.
            let Some(prompt) = self.list_prompt_versions(video_id, &group.id)?.into_iter().next() else {
                pending.push(group.id);
                continue;
            };
            let renders = self.list_image_renders(video_id, &group.id)?;
            let educational_updated_at = self.get_educational_visual_plan(video_id, &group.id)?
                .map(|plan| plan.updated_at);
            let needs_generation = renders.first()
                .map(|render| {
                    render.prompt_version_id != prompt.id
                        || educational_updated_at.as_ref().is_some_and(|updated| updated > &render.created_at)
                })
                .unwrap_or(true);
            if needs_generation {
                pending.push(group.id);
            }
        }
        Ok(pending)
    }

    /// Creates a job for exactly the given stills, forced — every id in
    /// `group_ids` becomes a job item using its current newest prompt
    /// version, whether or not that still's render is already up to date.
    /// The staleness check that used to gate this (see `pending_still_ids`)
    /// now only informs the panel's *default* selection; an explicit
    /// selection always means "(re)generate this," including an
    /// already-generated still the user checked on purpose.
    pub fn create_image_job(&self, video_id: &str, group_ids: &[String]) -> Result<ImageJob, String> {
        if group_ids.is_empty() {
            return Err("No stills selected.".into());
        }
        let plan = self.get_visual_plan(video_id)?;
        let groups_by_id: std::collections::HashMap<&str, &PlanGroup> =
            plan.groups.iter().map(|group| (group.id.as_str(), group)).collect();
        let mut prompts = Vec::with_capacity(group_ids.len());
        for group_id in group_ids {
            let group = groups_by_id.get(group_id.as_str())
                .ok_or_else(|| format!("Still {group_id} was not found in this video's plan."))?;
            let prompt = self.list_prompt_versions(video_id, &group.id)?.into_iter().next()
                .ok_or_else(|| format!("{} needs a saved prompt before bulk generation.", group.label))?;
            prompts.push((group.id.clone(), prompt.id));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO image_jobs(id,video_id,status,total_items,created_at,updated_at) VALUES(?1,?2,'queued',?3,?4,?4)",
            params![id, video_id, prompts.len() as i64, now],
        ).map_err(|e| e.to_string())?;
        for (group_id, prompt_id) in prompts {
            self.connection.execute(
                "INSERT INTO image_job_items(id,job_id,video_id,group_id,prompt_version_id,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'queued',?6,?6)",
                params![Uuid::new_v4().to_string(), id, video_id, group_id, prompt_id, now],
            ).map_err(|e| e.to_string())?;
        }
        self.get_image_job(&id)
    }

    pub fn get_image_job(&self, job_id: &str) -> Result<ImageJob, String> {
        let mut job: ImageJob = self.connection.query_row(
            "SELECT id,video_id,status,total_items,completed_items,failed_items,created_at,updated_at FROM image_jobs WHERE id=?1",
            [job_id],
            |row| Ok(ImageJob { id: row.get(0)?, video_id: row.get(1)?, status: row.get(2)?, total_items: row.get(3)?, completed_items: row.get(4)?, failed_items: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, items: vec![] }),
        ).map_err(|_| "Image job was not found.".to_string())?;
        let mut statement = self.connection.prepare(
            "SELECT id,group_id,prompt_version_id,status,attempts,last_error,render_id FROM image_job_items WHERE job_id=?1 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;
        job.items = statement
            .query_map([job_id], |row| {
                Ok(ImageJobItem {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    prompt_version_id: row.get(2)?,
                    status: row.get(3)?,
                    attempts: row.get(4)?,
                    last_error: row.get(5)?,
                    render_id: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(job)
    }

    pub fn image_job_status(&self, job_id: &str) -> Result<String, String> {
        self.connection.query_row(
            "SELECT status FROM image_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        ).map_err(|_| "Image job was not found.".to_string())
    }

    pub fn latest_image_job(&self, video_id: &str) -> Result<Option<ImageJob>, String> {
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM image_jobs WHERE video_id=?1 ORDER BY created_at DESC LIMIT 1",
                [video_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        id.map(|id| self.get_image_job(&id)).transpose()
    }

    pub fn set_image_job_status(&self, job_id: &str, status: &str) -> Result<ImageJob, String> {
        if !["queued", "running", "paused", "stopped", "failed"].contains(&status) {
            return Err("Unsupported image job transition.".into());
        }
        let now = Utc::now().to_rfc3339();
        if status == "queued" {
            // "queued" is also how a job that finished with some items failed gets
            // retried (see control_image_job's "resume" action) — the one transition
            // allowed to escape a terminal state, since otherwise a failed still had no
            // way to be retried short of re-approving the whole plan from scratch.
            // "completed" stays excluded: it only happens with zero failed items, so
            // there's nothing to retry.
            self.connection.execute(
                "UPDATE image_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status != 'completed'",
                params![status, now, job_id],
            ).map_err(|e| e.to_string())?;
            self.requeue_failed_job_items(job_id)?;
        } else {
            self.connection.execute(
                "UPDATE image_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status NOT IN ('completed','failed')",
                params![status, now, job_id],
            ).map_err(|e| e.to_string())?;
        }
        if matches!(status, "stopped" | "failed") {
            self.connection.execute(
                "UPDATE image_job_items SET status='stopped',updated_at=?1 WHERE job_id=?2 AND status IN ('queued','running')",
                params![now, job_id],
            ).map_err(|e| e.to_string())?;
        }
        self.get_image_job(job_id)
    }

    // Resets any 'failed' items for this job back to 'queued' (clearing attempts/
    // last_error) and recomputes failed_items. Returns how many were requeued. Shared by
    // the manual "resume"/retry action above and spawn_job_workers' own single automatic
    // sweep once a job's queue empties — a still that failed early in a run may well
    // succeed once retried after the rest of the batch has gone by and any rate-limit
    // window has had time to clear.
    pub fn requeue_failed_job_items(&self, job_id: &str) -> Result<usize, String> {
        let now = Utc::now().to_rfc3339();
        let requeued = self.connection.execute(
            "UPDATE image_job_items SET status='queued',attempts=0,last_error=NULL,updated_at=?1 WHERE job_id=?2 AND status='failed'",
            params![now, job_id],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE image_jobs SET failed_items=(SELECT COUNT(*) FROM image_job_items WHERE job_id=?1 AND status='failed'),updated_at=?2 WHERE id=?1",
            params![job_id, now],
        ).map_err(|e| e.to_string())?;
        Ok(requeued)
    }

    pub fn recover_image_jobs(&self) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE image_job_items SET status='queued',updated_at=?1 WHERE status='running'",
                [&now],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE image_jobs SET status='paused',updated_at=?1 WHERE status='running'",
                [&now],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn claim_job_item(
        &self,
        job_id: &str,
    ) -> Result<Option<(String, String, String, PromptVersion)>, String> {
        let job_status: String = self
            .connection
            .query_row(
                "SELECT status FROM image_jobs WHERE id=?1",
                [job_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !matches!(job_status.as_str(), "queued" | "running") {
            return Ok(None);
        }
        let item: Option<(String, String, String)> = self.connection.query_row(
            "SELECT id,video_id,group_id FROM image_job_items WHERE job_id=?1 AND status='queued' ORDER BY created_at LIMIT 1",
            [job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((item_id, video_id, group_id)) = item else {
            return Ok(None);
        };
        let claimed = self.connection.execute(
            "UPDATE image_job_items SET status='running',attempts=attempts+1,updated_at=?1 WHERE id=?2 AND status='queued'",
            params![Utc::now().to_rfc3339(), item_id],
        ).map_err(|e| e.to_string())?;
        if claimed == 0 {
            return self.claim_job_item(job_id);
        }
        self.connection.execute(
            "UPDATE image_jobs SET status='running',updated_at=?1 WHERE id=?2 AND status='queued'",
            params![Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        let prompt = self.connection.query_row(
            "SELECT p.id,p.video_id,p.group_id,p.version,p.settings_json,p.system_prompt,p.user_prompt,p.created_at FROM prompt_versions p JOIN image_job_items i ON i.prompt_version_id=p.id WHERE i.id=?1",
            [&item_id], |row| Ok(PromptVersion { id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?, version: row.get(3)?, settings_json: row.get(4)?, system_prompt: row.get(5)?, user_prompt: row.get(6)?, created_at: row.get(7)? }),
        ).map_err(|e| e.to_string())?;
        Ok(Some((item_id, video_id, group_id, prompt)))
    }

    pub fn finish_job_item(
        &self,
        job_id: &str,
        item_id: &str,
        result: Result<String, String>,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        match result {
            Ok(render_id) => self.connection.execute("UPDATE image_job_items SET status='completed',render_id=?1,last_error=NULL,updated_at=?2 WHERE id=?3 AND status='running'", params![render_id, now, item_id]),
            Err(error) => self.connection.execute("UPDATE image_job_items SET status='failed',last_error=?1,updated_at=?2 WHERE id=?3 AND status='running'", params![error, now, item_id]),
        }.map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE image_jobs SET completed_items=(SELECT COUNT(*) FROM image_job_items WHERE job_id=?1 AND status='completed'),failed_items=(SELECT COUNT(*) FROM image_job_items WHERE job_id=?1 AND status='failed'),updated_at=?2 WHERE id=?1",
            params![job_id, now],
        ).map_err(|e| e.to_string())?;
        let (pending, failed): (i64, i64) = self.connection.query_row(
            "SELECT SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) FROM image_job_items WHERE job_id=?1",
            [job_id], |row| Ok((row.get::<_, Option<i64>>(0)?.unwrap_or(0), row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        ).map_err(|e| e.to_string())?;
        if pending == 0 {
            self.connection.execute("UPDATE image_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status NOT IN ('paused','stopped')", params![if failed > 0 {"failed"} else {"completed"}, now, job_id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn create_animation_job(&self, video_id: &str, clip_id: &str, resolution: &str, prompt: &str) -> Result<AnimationJob, String> {
        if !matches!(resolution, "720p" | "1080p") {
            return Err("Resolution must be 720p or 1080p.".into());
        }
        let (group_id, render_id, start_seconds, end_seconds): (String, Option<String>, f64, f64) = self.connection.query_row(
            "SELECT group_id,render_id,start_seconds,end_seconds FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Timeline clip was not found.".to_string())?;
        let source_render_id = render_id.ok_or("Select a still with a generated image before animating it.")?;
        let requested_duration_seconds = (end_seconds - start_seconds).max(0.1);
        let veo_duration_seconds = pick_veo_duration(requested_duration_seconds);

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO animation_jobs(id,video_id,status,total_items,created_at,updated_at) VALUES(?1,?2,'queued',1,?3,?3)",
            params![id, video_id, now],
        ).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO animation_job_items(id,job_id,video_id,group_id,clip_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,prompt,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'queued',?11,?11)",
            params![Uuid::new_v4().to_string(), id, video_id, group_id, clip_id, source_render_id, resolution, requested_duration_seconds, veo_duration_seconds, prompt.trim(), now],
        ).map_err(|e| e.to_string())?;
        self.get_animation_job(&id)
    }

    /// Bulk counterpart of `create_animation_job` for the Animate pipeline
    /// stage's "Animate All Stills" — one job with N items, each targeting a
    /// still directly (`clip_id` NULL) rather than a placed timeline clip.
    /// `items` is expected to already be filtered to stills that have a
    /// generated image (the frontend has that list on hand); a still
    /// missing one fails the whole call rather than silently shrinking the
    /// job, since that would leave the reported item count for a still the
    /// user asked to animate quietly wrong.
    pub fn create_animation_bulk_job(
        &self, video_id: &str, resolution: &str, items: &[(String, String)],
    ) -> Result<AnimationJob, String> {
        if !matches!(resolution, "720p" | "1080p") {
            return Err("Resolution must be 720p or 1080p.".into());
        }
        if items.is_empty() {
            return Err("No stills to animate.".into());
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO animation_jobs(id,video_id,status,total_items,created_at,updated_at) VALUES(?1,?2,'queued',?3,?4,?4)",
            params![id, video_id, items.len() as i64, now],
        ).map_err(|e| e.to_string())?;
        let requested_duration_seconds: f64 = *VEO_ALLOWED_DURATIONS.last().expect("non-empty") as f64;
        let veo_duration_seconds = pick_veo_duration(requested_duration_seconds);
        for (group_id, prompt) in items {
            let source_render_id = self.list_image_renders(video_id, group_id)?
                .into_iter().next().map(|render| render.id)
                .ok_or_else(|| format!("Still {group_id} has no generated image yet."))?;
            self.connection.execute(
                "INSERT INTO animation_job_items(id,job_id,video_id,group_id,clip_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,prompt,status,created_at,updated_at) VALUES(?1,?2,?3,?4,NULL,?5,?6,?7,?8,?9,'queued',?10,?10)",
                params![Uuid::new_v4().to_string(), id, video_id, group_id, source_render_id, resolution, requested_duration_seconds, veo_duration_seconds, prompt.trim(), now],
            ).map_err(|e| e.to_string())?;
        }
        self.get_animation_job(&id)
    }

    pub fn get_animation_job(&self, job_id: &str) -> Result<AnimationJob, String> {
        let mut job: AnimationJob = self.connection.query_row(
            "SELECT id,video_id,status,total_items,completed_items,failed_items,created_at,updated_at FROM animation_jobs WHERE id=?1",
            [job_id],
            |row| Ok(AnimationJob { id: row.get(0)?, video_id: row.get(1)?, status: row.get(2)?, total_items: row.get(3)?, completed_items: row.get(4)?, failed_items: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, items: vec![] }),
        ).map_err(|_| "Animation job was not found.".to_string())?;
        let mut statement = self.connection.prepare(
            "SELECT id,video_id,clip_id,group_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,prompt,status,attempts,last_error,video_asset_id FROM animation_job_items WHERE job_id=?1 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;
        job.items = statement
            .query_map([job_id], |row| {
                Ok(AnimationJobItem {
                    id: row.get(0)?, video_id: row.get(1)?, clip_id: row.get(2)?, group_id: row.get(3)?, source_render_id: row.get(4)?,
                    resolution: row.get(5)?, requested_duration_seconds: row.get(6)?, veo_duration_seconds: row.get(7)?,
                    prompt: row.get(8)?, status: row.get(9)?, attempts: row.get(10)?, last_error: row.get(11)?, video_asset_id: row.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(job)
    }

    pub fn animation_job_status(&self, job_id: &str) -> Result<String, String> {
        self.connection.query_row(
            "SELECT status FROM animation_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        ).map_err(|_| "Animation job was not found.".to_string())
    }

    pub fn latest_animation_job(&self, video_id: &str) -> Result<Option<AnimationJob>, String> {
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM animation_jobs WHERE video_id=?1 ORDER BY created_at DESC LIMIT 1",
                [video_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        id.map(|id| self.get_animation_job(&id)).transpose()
    }

    pub fn set_animation_job_status(&self, job_id: &str, status: &str) -> Result<AnimationJob, String> {
        if !["queued", "running", "paused", "stopped", "failed"].contains(&status) {
            return Err("Unsupported animation job transition.".into());
        }
        self.connection.execute(
            "UPDATE animation_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status NOT IN ('completed','failed')",
            params![status, Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        if matches!(status, "stopped" | "failed") {
            self.connection.execute(
                "UPDATE animation_job_items SET status='stopped',updated_at=?1 WHERE job_id=?2 AND status IN ('queued','running')",
                params![Utc::now().to_rfc3339(), job_id],
            ).map_err(|e| e.to_string())?;
        }
        self.get_animation_job(job_id)
    }

    pub fn recover_animation_jobs(&self) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE animation_job_items SET status='queued',updated_at=?1 WHERE status='running'",
                [&now],
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE animation_jobs SET status='paused',updated_at=?1 WHERE status='running'",
                [&now],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn claim_animation_job_item(&self, job_id: &str) -> Result<Option<AnimationJobItem>, String> {
        let job_status: String = self
            .connection
            .query_row(
                "SELECT status FROM animation_jobs WHERE id=?1",
                [job_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !matches!(job_status.as_str(), "queued" | "running") {
            return Ok(None);
        }
        let item_id: Option<String> = self.connection.query_row(
            "SELECT id FROM animation_job_items WHERE job_id=?1 AND status='queued' ORDER BY created_at LIMIT 1",
            [job_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        let Some(item_id) = item_id else {
            return Ok(None);
        };
        let claimed = self.connection.execute(
            "UPDATE animation_job_items SET status='running',attempts=attempts+1,updated_at=?1 WHERE id=?2 AND status='queued'",
            params![Utc::now().to_rfc3339(), item_id],
        ).map_err(|e| e.to_string())?;
        if claimed == 0 {
            return self.claim_animation_job_item(job_id);
        }
        self.connection.execute(
            "UPDATE animation_jobs SET status='running',updated_at=?1 WHERE id=?2 AND status='queued'",
            params![Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        let mut statement = self.connection.prepare(
            "SELECT id,video_id,clip_id,group_id,source_render_id,resolution,requested_duration_seconds,veo_duration_seconds,prompt,status,attempts,last_error,video_asset_id FROM animation_job_items WHERE id=?1"
        ).map_err(|e| e.to_string())?;
        let item = statement.query_row([&item_id], |row| {
            Ok(AnimationJobItem {
                id: row.get(0)?, video_id: row.get(1)?, clip_id: row.get(2)?, group_id: row.get(3)?, source_render_id: row.get(4)?,
                resolution: row.get(5)?, requested_duration_seconds: row.get(6)?, veo_duration_seconds: row.get(7)?,
                prompt: row.get(8)?, status: row.get(9)?, attempts: row.get(10)?, last_error: row.get(11)?, video_asset_id: row.get(12)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(Some(item))
    }

    pub fn finish_animation_job_item(
        &self,
        job_id: &str,
        item_id: &str,
        result: Result<String, String>,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        match result {
            Ok(video_asset_id) => self.connection.execute("UPDATE animation_job_items SET status='completed',video_asset_id=?1,last_error=NULL,updated_at=?2 WHERE id=?3 AND status='running'", params![video_asset_id, now, item_id]),
            Err(error) => self.connection.execute("UPDATE animation_job_items SET status='failed',last_error=?1,updated_at=?2 WHERE id=?3 AND status='running'", params![error, now, item_id]),
        }.map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE animation_jobs SET completed_items=(SELECT COUNT(*) FROM animation_job_items WHERE job_id=?1 AND status='completed'),failed_items=(SELECT COUNT(*) FROM animation_job_items WHERE job_id=?1 AND status='failed'),updated_at=?2 WHERE id=?1",
            params![job_id, now],
        ).map_err(|e| e.to_string())?;
        let (pending, failed): (i64, i64) = self.connection.query_row(
            "SELECT SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) FROM animation_job_items WHERE job_id=?1",
            [job_id], |row| Ok((row.get::<_, Option<i64>>(0)?.unwrap_or(0), row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        ).map_err(|e| e.to_string())?;
        if pending == 0 {
            self.connection.execute("UPDATE animation_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status NOT IN ('paused','stopped')", params![if failed > 0 {"failed"} else {"completed"}, now, job_id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Generates a Veo animation for a timeline clip's source still, then
    /// flips the same clip row from `clip_kind='still'` to `'animation'` in
    /// place (same id/start/end/ordinal) rather than inserting a new clip —
    /// this avoids any ordinal/overlap bookkeeping and gives a natural
    /// "revert to still" path later. The requested duration is always the
    /// clip's current slot width; `pick_veo_duration` picks the largest of
    /// Veo's fixed 4s/6s/8s durations that still fits, and if the slot itself
    /// is under 4s the excess is trimmed immediately after download.
    pub fn generate_animation_clip(
        &self,
        video_id: &str,
        clip_id: &str,
        resolution: &str,
        prompt: &str,
        engine_dir: &Path,
    ) -> Result<VideoAsset, String> {
        if !matches!(resolution, "720p" | "1080p") {
            return Err("Resolution must be 720p or 1080p.".into());
        }
        let (group_id, render_id, start_seconds, end_seconds): (String, Option<String>, f64, f64) = self.connection.query_row(
            "SELECT group_id,render_id,start_seconds,end_seconds FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Timeline clip was not found.".to_string())?;
        let source_render_id = render_id.ok_or("Select a still with a generated image before animating it.")?;
        let render = self.get_render_by_id(&source_render_id)?;
        let source_path = self.render_absolute_path(&render)?;
        let source_bytes = fs::read(&source_path).map_err(|_| "Source still file is missing.".to_string())?;
        let mime_type = extension_to_media_type(
            source_path.extension().and_then(|value| value.to_str()).unwrap_or("png"),
        );

        let requested_duration_seconds = (end_seconds - start_seconds).max(0.1);
        let veo_duration_seconds = pick_veo_duration(requested_duration_seconds);

        let auth = self.gemini_auth()?;
        // "veo-3.1-lite-generate-preview" is the same model ID on both the
        // Gemini Developer API (API-key auth) and Vertex AI, and is the
        // cheapest Veo 3.1 tier ($0.05/sec @720p). An explicit `veo_model`
        // app setting always wins.
        let model = self.get_app_setting("veo_model")?.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "veo-3.1-lite-generate-preview".to_string());

        let operation_name = request_veo_generate(
            &auth, &model, prompt, &source_bytes, mime_type, resolution, veo_duration_seconds,
        )?;

        let started = std::time::Instant::now();
        let poll_timeout = std::time::Duration::from_secs(600);
        let video_bytes = loop {
            if started.elapsed() > poll_timeout {
                return Err("Animation generation timed out.".into());
            }
            match poll_veo_operation(&auth, &model, &operation_name)? {
                Some(bytes) => break bytes,
                None => std::thread::sleep(std::time::Duration::from_secs(10)),
            }
        };

        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1 AND trashed_at IS NULL",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let animation_dir = self.projects_dir.join(&channel_id).join(video_id).join("animations").join(&group_id);
        fs::create_dir_all(&animation_dir).map_err(|e| e.to_string())?;
        let version: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM video_assets WHERE video_id = ?1 AND group_id = ?2",
                params![video_id, group_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file_name = format!("animation-v{}.mp4", version);
        let relative_path = format!("animations/{}/{}", group_id, file_name);
        let raw_path = animation_dir.join(format!("animation-v{}.raw.mp4", version));
        fs::write(&raw_path, &video_bytes).map_err(|e| e.to_string())?;
        let raw_duration = Self::probe_audio_duration(engine_dir, &raw_path)?;

        let out_path = animation_dir.join(&file_name);
        // The slot was under 4s, so we generated Veo's 4s minimum anyway —
        // trim the excess now rather than leaving an oversized stored file.
        let actual_duration_seconds = if requested_duration_seconds < raw_duration - 0.05 {
            Self::run_retime(engine_dir, &raw_path, raw_duration, requested_duration_seconds, &out_path)?;
            let _ = fs::remove_file(&raw_path);
            requested_duration_seconds.min(raw_duration)
        } else {
            fs::rename(&raw_path, &out_path).map_err(|e| e.to_string())?;
            raw_duration
        };

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO video_assets(id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at) VALUES(?1,?2,?3,?4,?5,NULL,'generation',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![id, video_id, group_id, source_render_id, version, file_name, relative_path, resolution, requested_duration_seconds, veo_duration_seconds, actual_duration_seconds, model, operation_name, prompt.trim(), now],
        ).map_err(|e| e.to_string())?;

        self.connection.execute(
            "UPDATE timeline_clips SET clip_kind='animation', video_asset_id=?1 WHERE id=?2",
            params![id, clip_id],
        ).map_err(|e| e.to_string())?;

        self.create_snapshot(
            video_id,
            &json!({
                "reason": "animation-generated",
                "groupId": group_id,
                "clipId": clip_id,
                "videoAssetId": id,
                "version": version,
            })
            .to_string(),
        )?;

        self.get_video_asset(&id)
    }

    /// Generates a Veo animation for a still directly — no timeline clip
    /// required, unlike `generate_animation_clip`. Used by the Animate
    /// pipeline stage, which runs before stills are ever placed on the
    /// Editor timeline. Always requests Veo's longest supported duration
    /// (8s) since there's no timeline slot to size against yet — the
    /// Editor's existing "Adjust animation to duration" retime already
    /// handles shrinking a cached animation to fit wherever it ends up.
    pub fn generate_animation_for_still(
        &self,
        video_id: &str,
        group_id: &str,
        resolution: &str,
        prompt: &str,
        engine_dir: &Path,
    ) -> Result<VideoAsset, String> {
        if !matches!(resolution, "720p" | "1080p") {
            return Err("Resolution must be 720p or 1080p.".into());
        }
        let source_render_id = self.list_image_renders(video_id, group_id)?
            .into_iter().next().map(|render| render.id)
            .ok_or("Generate an image for this still before animating it.")?;
        let render = self.get_render_by_id(&source_render_id)?;
        let source_path = self.render_absolute_path(&render)?;
        let source_bytes = fs::read(&source_path).map_err(|_| "Source still file is missing.".to_string())?;
        let mime_type = extension_to_media_type(
            source_path.extension().and_then(|value| value.to_str()).unwrap_or("png"),
        );

        let requested_duration_seconds: f64 = *VEO_ALLOWED_DURATIONS.last().expect("non-empty") as f64;
        let veo_duration_seconds = pick_veo_duration(requested_duration_seconds);

        let auth = self.gemini_auth()?;
        let model = self.get_app_setting("veo_model")?.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "veo-3.1-lite-generate-preview".to_string());

        let operation_name = request_veo_generate(
            &auth, &model, prompt, &source_bytes, mime_type, resolution, veo_duration_seconds,
        )?;

        let started = std::time::Instant::now();
        let poll_timeout = std::time::Duration::from_secs(600);
        let video_bytes = loop {
            if started.elapsed() > poll_timeout {
                return Err("Animation generation timed out.".into());
            }
            match poll_veo_operation(&auth, &model, &operation_name)? {
                Some(bytes) => break bytes,
                None => std::thread::sleep(std::time::Duration::from_secs(10)),
            }
        };

        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1 AND trashed_at IS NULL",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let animation_dir = self.projects_dir.join(&channel_id).join(video_id).join("animations").join(group_id);
        fs::create_dir_all(&animation_dir).map_err(|e| e.to_string())?;
        let version: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM video_assets WHERE video_id = ?1 AND group_id = ?2",
                params![video_id, group_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file_name = format!("animation-v{}.mp4", version);
        let relative_path = format!("animations/{}/{}", group_id, file_name);
        let out_path = animation_dir.join(&file_name);
        fs::write(&out_path, &video_bytes).map_err(|e| e.to_string())?;
        let actual_duration_seconds = Self::probe_audio_duration(engine_dir, &out_path)?;

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO video_assets(id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at) VALUES(?1,?2,?3,?4,?5,NULL,'generation',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![id, video_id, group_id, source_render_id, version, file_name, relative_path, resolution, requested_duration_seconds, veo_duration_seconds, actual_duration_seconds, model, operation_name, prompt.trim(), now],
        ).map_err(|e| e.to_string())?;

        self.create_snapshot(
            video_id,
            &json!({
                "reason": "animation-generated-for-still",
                "groupId": group_id,
                "videoAssetId": id,
                "version": version,
            })
            .to_string(),
        )?;

        self.get_video_asset(&id)
    }

    /// Imports a user-supplied video file as this clip's animation. Unlike
    /// `generate_animation_clip`, an upload can land on either side of the
    /// slot's duration, so it's unconditionally run through `run_retime` to
    /// stretch or trim it to fit — the same fit-to-slot step Veo output gets
    /// only when it overshoots. This also normalizes the container/codec to
    /// the same libx264 MP4 every generated clip uses, so playback and
    /// export behave identically regardless of the source file's format.
    /// From here on the clip behaves exactly like a generated one: same
    /// revert/restore-to-still controls, same re-adjust-to-duration button.
    pub fn import_animation_clip(
        &self,
        video_id: &str,
        clip_id: &str,
        source: &Path,
        engine_dir: &Path,
    ) -> Result<Timeline, String> {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp4", "mov", "webm", "mkv", "m4v"].contains(&extension.as_str()) {
            return Err("Unsupported video file type. Use MP4, MOV, WebM, MKV, or M4V.".into());
        }
        let (group_id, render_id, start_seconds, end_seconds): (String, Option<String>, f64, f64) = self.connection.query_row(
            "SELECT group_id,render_id,start_seconds,end_seconds FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Timeline clip was not found.".to_string())?;
        let source_render_id = render_id.ok_or("Select a still with a generated image before animating it.")?;
        let requested_duration_seconds = (end_seconds - start_seconds).max(0.1);

        let channel_id: String = self
            .connection
            .query_row(
                "SELECT channel_id FROM videos WHERE id = ?1 AND trashed_at IS NULL",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|_| "Video was not found.".to_string())?;
        let animation_dir = self.projects_dir.join(&channel_id).join(video_id).join("animations").join(&group_id);
        fs::create_dir_all(&animation_dir).map_err(|e| e.to_string())?;
        let version: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM video_assets WHERE video_id = ?1 AND group_id = ?2",
                params![video_id, group_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file_name = format!("animation-v{}.mp4", version);
        let relative_path = format!("animations/{}/{}", group_id, file_name);
        let raw_path = animation_dir.join(format!("animation-v{}.upload.{}", version, extension));
        fs::copy(source, &raw_path).map_err(|_| "Could not read the selected video file.".to_string())?;
        let raw_duration = Self::probe_audio_duration(engine_dir, &raw_path).map_err(|_| {
            let _ = fs::remove_file(&raw_path);
            "Could not read the selected file as a video.".to_string()
        })?;

        let out_path = animation_dir.join(&file_name);
        Self::run_retime(engine_dir, &raw_path, raw_duration, requested_duration_seconds, &out_path)?;
        let _ = fs::remove_file(&raw_path);
        let actual_duration_seconds = Self::probe_audio_duration(engine_dir, &out_path)?;

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO video_assets(id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at) VALUES(?1,?2,?3,?4,?5,NULL,'upload',?6,?7,'original',?8,?9,?10,'upload',NULL,'',?11)",
            params![id, video_id, group_id, source_render_id, version, file_name, relative_path, requested_duration_seconds, raw_duration.round() as i64, actual_duration_seconds, now],
        ).map_err(|e| e.to_string())?;

        self.connection.execute(
            "UPDATE timeline_clips SET clip_kind='animation', video_asset_id=?1 WHERE id=?2",
            params![id, clip_id],
        ).map_err(|e| e.to_string())?;

        self.create_snapshot(
            video_id,
            &json!({
                "reason": "animation-uploaded",
                "groupId": group_id,
                "clipId": clip_id,
                "videoAssetId": id,
                "version": version,
            })
            .to_string(),
        )?;

        self.get_timeline(video_id)
    }

    /// Slows a generated animation clip down (or trims it) to exactly fill
    /// its current timeline slot. Always re-derives from the ORIGINAL Veo
    /// output or upload (`kind` in `'generation'`/`'upload'`), never from a
    /// previously-retimed version, so repeated clicks don't compound
    /// re-encode quality loss.
    pub fn retime_animation_clip(
        &self,
        video_id: &str,
        clip_id: &str,
        engine_dir: &Path,
    ) -> Result<Timeline, String> {
        let (clip_kind, video_asset_id, start_seconds, end_seconds): (String, Option<String>, f64, f64) = self.connection.query_row(
            "SELECT clip_kind,video_asset_id,start_seconds,end_seconds FROM timeline_clips WHERE id=?1 AND video_id=?2",
            params![clip_id, video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Timeline clip was not found.".to_string())?;
        if clip_kind != "animation" {
            return Err("Only animation clips can be adjusted to a duration.".into());
        }
        let asset_id = video_asset_id.ok_or("This clip has no generated animation yet.")?;
        let mut root_asset = self.get_video_asset(&asset_id)?;
        while !matches!(root_asset.kind.as_str(), "generation" | "upload") {
            let Some(parent_id) = root_asset.parent_video_asset_id.clone() else { break };
            root_asset = self.get_video_asset(&parent_id)?;
        }
        let source_path = self.video_asset_absolute_path(&root_asset)?;
        let target_duration = (end_seconds - start_seconds).max(0.1);

        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let animation_dir = self.projects_dir.join(&channel_id).join(video_id).join("animations").join(&root_asset.group_id);
        fs::create_dir_all(&animation_dir).map_err(|e| e.to_string())?;
        let version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM video_assets WHERE video_id=?1 AND group_id=?2",
            params![video_id, root_asset.group_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let file_name = format!("animation-v{}.mp4", version);
        let relative_path = format!("animations/{}/{}", root_asset.group_id, file_name);
        let out_path = animation_dir.join(&file_name);

        Self::run_retime(engine_dir, &source_path, root_asset.actual_duration_seconds, target_duration, &out_path)?;
        let actual_duration_seconds = Self::probe_audio_duration(engine_dir, &out_path)?;

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO video_assets(id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at) VALUES(?1,?2,?3,?4,?5,?6,'retimed',?7,?8,?9,?10,?11,?12,?13,NULL,?14,?15)",
            params![id, video_id, root_asset.group_id, root_asset.source_render_id, version, root_asset.id, file_name, relative_path, root_asset.resolution, target_duration, root_asset.veo_duration_seconds, actual_duration_seconds, root_asset.veo_model, root_asset.prompt, now],
        ).map_err(|e| e.to_string())?;

        self.connection.execute(
            "UPDATE timeline_clips SET video_asset_id=?1 WHERE id=?2",
            params![id, clip_id],
        ).map_err(|e| e.to_string())?;

        self.create_snapshot(
            video_id,
            &json!({
                "reason": "animation-retimed",
                "clipId": clip_id,
                "videoAssetId": id,
                "version": version,
            })
            .to_string(),
        )?;

        self.get_timeline(video_id)
    }

    fn asset_by_id(&self, id: &str) -> Result<Option<InputAsset>, String> {
        self.connection.query_row(
            "SELECT id, video_id, kind, original_name, relative_path, media_type, size_bytes, created_at FROM input_assets WHERE id = ?1",
            [id], map_asset,
        ).optional().map_err(|e| e.to_string())
    }

    fn list_assets(&self, video_id: &str, kind: &str) -> Result<Vec<InputAsset>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, video_id, kind, original_name, relative_path, media_type, size_bytes, created_at
             FROM input_assets WHERE video_id = ?1 AND kind = ?2 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, kind], map_asset)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn generate_visual_plan(&self, video_id: &str, engine_dir: &Path) -> Result<VisualPlan, String> {
        self.generate_visual_plan_with_progress(video_id, engine_dir, |_, _, _| {})
    }

    pub fn generate_visual_plan_with_progress<F>(
        &self,
        video_id: &str,
        engine_dir: &Path,
        mut progress: F,
    ) -> Result<VisualPlan, String>
    where
        F: FnMut(i64, &str, &str),
    {
        let inputs = self.get_video_inputs(video_id)?;
        if inputs.script_text.trim().is_empty() || inputs.audio.is_none() {
            return Err("Script and narration audio are required.".into());
        }
        #[cfg(test)]
        {
            let (clean_script, _) = remove_tts_pause_markers(&inputs.script_text);
            let texts = split_sentences(&clean_script);
            let weights: Vec<usize> = texts
                .iter()
                .map(|text| text.split_whitespace().count().max(1))
                .collect();
            let total_words: usize = weights.iter().sum();
            let duration = (total_words as f64 * 0.4).max(1.0);
            let mut cursor = 0.0;
            let sentence_count = texts.len();
            let sentences = texts
                .into_iter()
                .zip(weights)
                .enumerate()
                .map(|(index, (text, weight))| {
                    let end = if index + 1 == sentence_count {
                        duration
                    } else {
                        cursor + duration * weight as f64 / total_words as f64
                    };
                    let sentence = PlanSentence {
                        id: format!("s{}", index + 1),
                        ordinal: index as i64 + 1,
                        text,
                        start_seconds: cursor,
                        end_seconds: end,
                    };
                    cursor = end;
                    sentence
                })
                .collect::<Vec<_>>();
            let mut groups = build_groups_range(
                &sentences,
                inputs.pacing_min_seconds as f64,
                inputs.pacing_max_seconds as f64,
            );
            let scenes = build_scenes_range(&groups);
            assign_scene_ids(&mut groups, &scenes);
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                &scenes,
                true,
                "estimated test fixture",
            )?;
            self.save_original_sentences_snapshot(video_id, &sentences)?;
            self.save_plan_generation_inputs(video_id, &inputs)?;
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                &scenes,
                false,
                "estimated test fixture",
            )?;
            return self.get_visual_plan(video_id);
        }
        #[cfg(not(test))]
        {
            let audio = inputs.audio.as_ref().unwrap();
            let channel_id: String = self
                .connection
                .query_row(
                    "SELECT channel_id FROM videos WHERE id=?1",
                    [video_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let video_dir = self.projects_dir.join(channel_id).join(video_id);
            let audio_path = video_dir.join(&audio.relative_path);
            let work_dir = video_dir.join("visual-plan");
            fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
            let script_path = work_dir.join("authoritative-script.txt");
            let output_path = work_dir.join("visual-plan.xlsx");
            let (clean_script, _) = remove_tts_pause_markers(&inputs.script_text);
            fs::write(&script_path, clean_script).map_err(|e| e.to_string())?;
            // Best-effort, computed once here so the Python engine's own
            // scene-boundary and scene-summary passes can use the exact
            // same whole-script understanding Bulk Generation's own
            // planning prompt will later reuse from cache (see
            // script_understanding_for_video) — one shared understanding
            // grounding both, not two independently-computed ones. Never
            // blocks visual plan generation: there's no user-facing toggle
            // for this, so any failure (no AI credentials configured yet,
            // a transient error) just means the engine falls back to its
            // existing local-only boundary/summary behavior, unchanged
            // from before this existed.
            let gemini_auth = self.gemini_auth().ok();
            let script_understanding_path = match self.script_understanding_for_video(video_id, &gemini_auth) {
                Ok(understanding) if !understanding.trim().is_empty() => {
                    let path = work_dir.join("script-understanding.txt");
                    fs::write(&path, &understanding).ok().map(|_| path)
                }
                _ => None,
            };
            let grouping_engine = engine_dir.join("auto_gen_engine/scene_grouping_engine.py");
            if !grouping_engine.exists() {
                return Err(format!(
                    "Internal scene-grouping engine was not found at {}.",
                    grouping_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&grouping_engine)
                .arg(&audio_path)
                .arg(&script_path);
            if inputs.pacing_preset == "per-sentence" {
                // Skips AI boundary-scoring/duration-window grouping
                // entirely — every sentence becomes its own group. Duration
                // bounds are meaningless here so they're omitted rather than
                // passed with placeholder values.
                command.arg("--per-sentence");
            } else {
                command
                    .arg("--min-duration")
                    .arg(inputs.pacing_min_seconds.to_string())
                    .arg("--max-duration")
                    .arg(inputs.pacing_max_seconds.to_string());
            }
            command
                .arg("--output")
                .arg(&output_path)
                .arg("--fallback-on-ai-error");
            if let Some(path) = &script_understanding_path {
                command.arg("--script-understanding").arg(path);
            }
            command
                .current_dir(&engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(openai_key) = self.get_provider_key("openai")? {
                command.env("OPENAI_API_KEY", openai_key);
            }
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start the Python visual-plan engine: {e}"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or("Could not capture visual-plan engine output.")?;
            let stderr = child
                .stderr
                .take()
                .ok_or("Could not capture visual-plan engine errors.")?;
            let stderr_thread = std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut bytes = Vec::new();
                let mut output = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => output.push(String::from_utf8_lossy(&bytes).trim().to_string()),
                    }
                }
                output.join("\n")
            });
            let mut output_lines = Vec::new();
            let mut stdout_reader = BufReader::new(stdout);
            let mut line_bytes = Vec::new();
            loop {
                line_bytes.clear();
                let count = stdout_reader
                    .read_until(b'\n', &mut line_bytes)
                    .map_err(|e| format!("Could not read engine progress: {e}"))?;
                if count == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if let Some(payload) = line.strip_prefix("AUTOGEN_PROGRESS ") {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        progress(
                            value["percent"].as_i64().unwrap_or(0),
                            value["stage"].as_str().unwrap_or("Building visual plan"),
                            value["detail"].as_str().unwrap_or_default(),
                        );
                    }
                } else {
                    output_lines.push(line);
                }
            }
            let status = child
                .wait()
                .map_err(|e| format!("Could not wait for visual-plan engine: {e}"))?;
            let raw_stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                // Strip tqdm progress bars, Python UserWarning blocks, and blank
                // lines so the message shown to the user is concise and actionable.
                let clean_stdout: Vec<&str> = output_lines
                    .iter()
                    .map(String::as_str)
                    .filter(|l| {
                        !l.is_empty()
                            && !l.chars().all(|c| "#|-% \t".contains(c))
                            && !l.contains("iB/s")
                            && !l.contains("eta 0:")
                    })
                    .collect();
                let clean_stderr: Vec<&str> = raw_stderr
                    .lines()
                    .filter(|l| {
                        !l.is_empty()
                            && !l.contains("UserWarning")
                            && !l.contains("warnings.warn")
                            && !l.contains("FP16")
                    })
                    .collect();
                let mut parts = clean_stdout.join("\n");
                if !clean_stderr.is_empty() {
                    if !parts.is_empty() {
                        parts.push('\n');
                    }
                    parts.push_str(&clean_stderr.join("\n"));
                }
                return Err(format!("Visual-plan engine failed. {parts}"));
            }
            let audit_path = output_path.with_extension("json");
            let audit: serde_json::Value = serde_json::from_slice(
                &fs::read(&audit_path)
                    .map_err(|e| format!("Could not read visual-plan audit: {e}"))?,
            )
            .map_err(|e| format!("Visual-plan audit was invalid: {e}"))?;
            let sentences = audit["sentences"]
                .as_array()
                .ok_or("Visual-plan audit contained no sentences.")?
                .iter()
                .map(|item| PlanSentence {
                    id: format!("s{}", item["sentence_id"].as_i64().unwrap_or(0)),
                    ordinal: item["sentence_id"].as_i64().unwrap_or(0),
                    text: item["text"].as_str().unwrap_or_default().to_string(),
                    start_seconds: item["start"].as_f64().unwrap_or(0.0),
                    end_seconds: item["end"].as_f64().unwrap_or(0.0),
                })
                .collect::<Vec<_>>();
            let groups = audit["groups"]
                .as_array()
                .ok_or("Visual-plan audit contained no groups.")?
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let start = item["start_sentence_id"].as_i64().unwrap_or(1);
                    let end = item["end_sentence_id"].as_i64().unwrap_or(start);
                    PlanGroup {
                        id: format!("g{}", index + 1),
                        ordinal: index as i64 + 1,
                        label: item["visual_anchor"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| {
                                item["scene_description"].as_str().unwrap_or("Visual scene")
                            })
                            .to_string(),
                        kind: item["scene_type"].as_str().unwrap_or("still").to_string(),
                        sentence_ids: (start..=end).map(|id| format!("s{id}")).collect(),
                        settings_locked: false,
                        prompt_locked: false,
                        // Assigned authoritatively by the Python engine (it
                        // already knows both partitions from the same
                        // computation) — Rust only has to recompute this by
                        // containment on later edits, see assign_scene_ids.
                        scene_id: item["scene_id"].as_i64().map(|id| format!("sc{id}")),
                    }
                })
                .collect::<Vec<_>>();
            let scenes = audit["scenes"]
                .as_array()
                .ok_or("Visual-plan audit contained no scenes.")?
                .iter()
                .map(|item| {
                    let start = item["start_sentence_id"].as_i64().unwrap_or(1);
                    let end = item["end_sentence_id"].as_i64().unwrap_or(start);
                    PlanScene {
                        id: format!("sc{}", item["scene_id"].as_i64().unwrap_or(0)),
                        ordinal: item["scene_id"].as_i64().unwrap_or(0),
                        label: item["title"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .unwrap_or("Scene")
                            .to_string(),
                        narrative_role: item["narrative_role"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .map(str::to_string),
                        core_idea: item["core_idea"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .map(str::to_string),
                        emotional_state: item["emotional_state"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .map(str::to_string),
                        visual_opportunities: item["visual_opportunities"]
                            .as_array()
                            .map(|values| {
                                values.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
                            })
                            .unwrap_or_default(),
                        sentence_ids: (start..=end).map(|id| format!("s{id}")).collect(),
                        expanded: true,
                    }
                })
                .collect::<Vec<_>>();
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                &scenes,
                true,
                "whisper + AI boundary scoring",
            )?;
            self.save_original_sentences_snapshot(video_id, &sentences)?;
            self.save_plan_generation_inputs(video_id, &inputs)?;
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                &scenes,
                false,
                "whisper + AI boundary scoring",
            )?;
            self.get_visual_plan(video_id)
        }
    }

    pub fn get_visual_plan(&self, video_id: &str) -> Result<VisualPlan, String> {
        let (timing_source, updated_at): (String, String) = self
            .connection
            .query_row(
                "SELECT timing_source, updated_at FROM visual_plan_meta WHERE video_id = ?1",
                [video_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Visual plan has not been generated.".to_string())?;
        let mut sentence_statement = self.connection.prepare(
            "SELECT id, ordinal, text, start_seconds, end_seconds FROM visual_plan_sentences WHERE video_id = ?1 ORDER BY ordinal"
        ).map_err(|e| e.to_string())?;
        let sentences = sentence_statement
            .query_map([video_id], |row| {
                let stored_id: String = row.get(0)?;
                Ok(PlanSentence {
                    id: stored_id
                        .rsplit_once("::")
                        .map(|(_, id)| id.to_string())
                        .unwrap_or(stored_id),
                    ordinal: row.get(1)?,
                    text: row.get(2)?,
                    start_seconds: row.get(3)?,
                    end_seconds: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let groups = self.load_groups(video_id, false)?;
        let scenes = self.load_scenes(video_id, false)?;
        Ok(VisualPlan {
            video_id: video_id.into(),
            timing_source,
            sentences,
            groups,
            scenes,
            updated_at,
        })
    }

    pub fn generate_captions(
        &self,
        video_id: &str,
        engine_dir: &Path,
        interval_seconds: f64,
    ) -> Result<CaptionSet, String> {
        self.generate_captions_with_progress(video_id, engine_dir, interval_seconds, |_, _, _| {})
    }

    pub fn generate_captions_with_progress<F>(
        &self,
        video_id: &str,
        engine_dir: &Path,
        interval_seconds: f64,
        mut progress: F,
    ) -> Result<CaptionSet, String>
    where
        F: FnMut(i64, &str, &str),
    {
        if !(0.2..=5.0).contains(&interval_seconds) {
            return Err("Caption window must be between 0.2 and 5 seconds.".into());
        }
        let inputs = self.get_video_inputs(video_id)?;
        if inputs.script_text.trim().is_empty() || inputs.audio.is_none() {
            return Err("Script and narration audio are required.".into());
        }
        #[cfg(test)]
        {
            let _ = engine_dir;
            let (clean_script, _) = remove_tts_pause_markers(&inputs.script_text);
            let words: Vec<&str> = clean_script.split_whitespace().collect();
            let mut chunks = Vec::new();
            for (index, group) in words.chunks(3).enumerate() {
                chunks.push(CaptionChunk {
                    index: index as i64 + 1,
                    text: group.join(" "),
                    start_seconds: index as f64,
                    end_seconds: index as f64 + 1.0,
                    words: Vec::new(),
                });
            }
            self.save_caption_set(video_id, interval_seconds, "1\n00:00:00,000 --> 00:00:01,000\ntest\n", &chunks)?;
            return self.get_captions(video_id);
        }
        #[cfg(not(test))]
        {
            let audio = inputs.audio.as_ref().unwrap();
            let channel_id: String = self
                .connection
                .query_row(
                    "SELECT channel_id FROM videos WHERE id=?1",
                    [video_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let video_dir = self.projects_dir.join(channel_id).join(video_id);
            let audio_path = video_dir.join(&audio.relative_path);
            let work_dir = video_dir.join("captions");
            fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
            let script_path = work_dir.join("authoritative-script.txt");
            let output_srt = work_dir.join("captions.srt");
            let output_json = output_srt.with_extension("json");
            let (clean_script, _) = remove_tts_pause_markers(&inputs.script_text);
            fs::write(&script_path, clean_script).map_err(|e| e.to_string())?;
            let caption_engine = engine_dir.join("auto_gen_engine/caption_engine.py");
            if !caption_engine.exists() {
                return Err(format!(
                    "Internal caption engine was not found at {}.",
                    caption_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&caption_engine)
                .arg(&audio_path)
                .arg(&script_path)
                .arg("--interval")
                .arg(interval_seconds.to_string())
                .arg("--output")
                .arg(&output_srt)
                .current_dir(&engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start the Python caption engine: {e}"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or("Could not capture caption engine output.")?;
            let stderr = child
                .stderr
                .take()
                .ok_or("Could not capture caption engine errors.")?;
            let stderr_thread = std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut bytes = Vec::new();
                let mut output = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => output.push(String::from_utf8_lossy(&bytes).trim().to_string()),
                    }
                }
                output.join("\n")
            });
            let mut output_lines = Vec::new();
            let mut stdout_reader = BufReader::new(stdout);
            let mut line_bytes = Vec::new();
            loop {
                line_bytes.clear();
                let count = stdout_reader
                    .read_until(b'\n', &mut line_bytes)
                    .map_err(|e| format!("Could not read engine progress: {e}"))?;
                if count == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if let Some(payload) = line.strip_prefix("AUTOGEN_PROGRESS ") {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        progress(
                            value["percent"].as_i64().unwrap_or(0),
                            value["stage"].as_str().unwrap_or("Building captions"),
                            value["detail"].as_str().unwrap_or_default(),
                        );
                    }
                } else {
                    output_lines.push(line);
                }
            }
            let status = child
                .wait()
                .map_err(|e| format!("Could not wait for caption engine: {e}"))?;
            let raw_stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                let clean_stdout: Vec<&str> = output_lines
                    .iter()
                    .map(String::as_str)
                    .filter(|l| {
                        !l.is_empty()
                            && !l.chars().all(|c| "#|-% \t".contains(c))
                            && !l.contains("iB/s")
                            && !l.contains("eta 0:")
                    })
                    .collect();
                let clean_stderr: Vec<&str> = raw_stderr
                    .lines()
                    .filter(|l| {
                        !l.is_empty()
                            && !l.contains("UserWarning")
                            && !l.contains("warnings.warn")
                            && !l.contains("FP16")
                    })
                    .collect();
                let mut parts = clean_stdout.join("\n");
                if !clean_stderr.is_empty() {
                    if !parts.is_empty() {
                        parts.push('\n');
                    }
                    parts.push_str(&clean_stderr.join("\n"));
                }
                return Err(format!("Caption engine failed. {parts}"));
            }
            let srt_text =
                fs::read_to_string(&output_srt).map_err(|e| format!("Could not read captions: {e}"))?;
            let audit: serde_json::Value = serde_json::from_slice(
                &fs::read(&output_json)
                    .map_err(|e| format!("Could not read caption audit: {e}"))?,
            )
            .map_err(|e| format!("Caption audit was invalid: {e}"))?;
            let chunks = audit
                .as_array()
                .ok_or("Caption audit contained no chunks.")?
                .iter()
                .map(|item| CaptionChunk {
                    index: item["index"].as_i64().unwrap_or(0),
                    text: item["text"].as_str().unwrap_or_default().to_string(),
                    start_seconds: item["start"].as_f64().unwrap_or(0.0),
                    end_seconds: item["end"].as_f64().unwrap_or(0.0),
                    words: item["words"].as_array().map(|words| words.iter().map(|w| CaptionWord {
                        text: w["text"].as_str().unwrap_or_default().to_string(),
                        start_seconds: w["start"].as_f64().unwrap_or(0.0),
                        end_seconds: w["end"].as_f64().unwrap_or(0.0),
                    }).collect()).unwrap_or_default(),
                })
                .collect::<Vec<_>>();
            self.save_caption_set(video_id, interval_seconds, &srt_text, &chunks)?;
            self.get_captions(video_id)
        }
    }

    fn save_caption_set(
        &self,
        video_id: &str,
        interval_seconds: f64,
        srt_text: &str,
        chunks: &[CaptionChunk],
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let chunks_json = serde_json::to_string(chunks).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO captions(video_id, interval_seconds, srt_text, chunks_json, generated_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(video_id) DO UPDATE SET
             interval_seconds=excluded.interval_seconds, srt_text=excluded.srt_text,
             chunks_json=excluded.chunks_json, generated_at=excluded.generated_at, updated_at=excluded.updated_at",
            params![video_id, interval_seconds, srt_text, chunks_json, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_captions(&self, video_id: &str) -> Result<CaptionSet, String> {
        let (interval_seconds, srt_text, chunks_json, generated_at, updated_at): (
            f64,
            String,
            String,
            String,
            String,
        ) = self
            .connection
            .query_row(
                "SELECT interval_seconds, srt_text, chunks_json, generated_at, updated_at FROM captions WHERE video_id = ?1",
                [video_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|_| "Captions have not been generated.".to_string())?;
        let chunks: Vec<CaptionChunk> =
            serde_json::from_str(&chunks_json).map_err(|e| e.to_string())?;
        Ok(CaptionSet {
            video_id: video_id.into(),
            interval_seconds,
            srt_text,
            chunks,
            generated_at,
            updated_at,
        })
    }

    fn get_render_by_id(&self, render_id: &str) -> Result<ImageRender, String> {
        self.connection.query_row(
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at,subject_x,subject_y FROM image_renders WHERE id=?1",
            [render_id],
            |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?,
                is_final: row.get::<_, i64>(10)? != 0, edit_strength: row.get(11)?,
                mask_path: row.get(12)?, mask_used: row.get::<_, i64>(13)? != 0,
                created_at: row.get(14)?, subject_x: row.get(15)?, subject_y: row.get(16)?,
            }),
        ).map_err(|_| "Image render was not found.".to_string())
    }

    /// Builds the ffmpeg export manifest from the CURRENT timeline arrangement
    /// (not the source visual-plan/captions tables) — export renders exactly
    /// what's on the timeline. Returns (video_dir, manifest_path).
    fn build_timeline_export_manifest(
        &self,
        video_id: &str,
        engine_dir: &Path,
        options: &ExportSettings,
    ) -> Result<(PathBuf, PathBuf), String> {
        let inputs = self.get_video_inputs(video_id)?;
        let audio = inputs.audio.as_ref().ok_or("Narration audio is required to export a video.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let video_dir = self.projects_dir.join(&channel_id).join(video_id);
        let narration_audio_path = video_dir.join(&audio.relative_path);
        // Ask ffmpeg itself for the narration's real duration rather than
        // trusting a browser-measured value — browser APIs (Web Audio,
        // <audio> element) can each disagree with ffmpeg's own duration for
        // compressed audio by tens to a hundred-plus milliseconds, which
        // previously made exported/extrapolated stills fall slightly short
        // of the actual audio length.
        let narration_duration_seconds = Self::probe_audio_duration(engine_dir, &narration_audio_path)?;

        let timeline = self.get_timeline(video_id)?;
        if timeline.clips.is_empty() {
            return Err("Add at least one still to the timeline before exporting.".into());
        }

        let mut stills = Vec::new();
        for clip in &timeline.clips {
            if clip.clip_kind == "animation" {
                let Some(video_asset_id) = &clip.video_asset_id else { continue };
                let asset = self.get_video_asset(video_asset_id)?;
                let video_path = self.video_asset_absolute_path(&asset)?;
                stills.push(json!({
                    "kind": "video",
                    "videoPath": video_path.to_string_lossy(),
                    "start": clip.start_seconds,
                    "end": clip.end_seconds,
                    "sourceDurationSeconds": asset.actual_duration_seconds,
                    "transitionIn": clip.transition_in,
                    "transitionOut": clip.transition_out,
                    "colorFilter": clip.color_filter_preset,
                    "colorFilterIntensity": clip.color_filter_intensity,
                }));
                continue;
            }
            if clip.clip_kind == "imported-clip" {
                let Some(asset_id) = &clip.media_library_asset_id else { continue };
                let video_path = self.media_library_asset_file_path(asset_id)?;
                let asset = self.media_library_asset_by_id(asset_id)?.ok_or("Media library asset was not found.")?;
                stills.push(json!({
                    "kind": "video",
                    "videoPath": video_path.to_string_lossy(),
                    "start": clip.start_seconds,
                    "end": clip.end_seconds,
                    "sourceDurationSeconds": asset.duration_seconds.unwrap_or(clip.end_seconds - clip.start_seconds),
                    "transitionIn": clip.transition_in,
                    "transitionOut": clip.transition_out,
                    "colorFilter": clip.color_filter_preset,
                    "colorFilterIntensity": clip.color_filter_intensity,
                }));
                continue;
            }
            if clip.clip_kind == "imported-still" {
                let Some(asset_id) = &clip.media_library_asset_id else { continue };
                let image_path = self.media_library_asset_file_path(asset_id)?;
                stills.push(json!({
                    "kind": "image",
                    "imagePath": image_path.to_string_lossy(),
                    "start": clip.start_seconds,
                    "end": clip.end_seconds,
                    "motion": clip.motion_preset,
                    "motionIntensity": clip.motion_intensity,
                    "transitionIn": clip.transition_in,
                    "transitionOut": clip.transition_out,
                    "subjectX": 0.5,
                    "subjectY": 0.5,
                    "colorFilter": clip.color_filter_preset,
                    "colorFilterIntensity": clip.color_filter_intensity,
                    "motionGraphicEffect": clip.motion_graphic_effect,
                    "motionGraphicSettings": motion_graphic_settings_value(&clip),
                }));
                continue;
            }
            let Some(render_id) = &clip.render_id else { continue };
            let render = self.get_render_by_id(render_id)?;
            let image_path = self.render_absolute_path(&render)?;
            stills.push(json!({
                "kind": "image",
                "imagePath": image_path.to_string_lossy(),
                "start": clip.start_seconds,
                "end": clip.end_seconds,
                "motion": clip.motion_preset,
                "motionIntensity": clip.motion_intensity,
                "transitionIn": clip.transition_in,
                "transitionOut": clip.transition_out,
                "subjectX": render.subject_x.unwrap_or(0.5),
                "subjectY": render.subject_y.unwrap_or(0.5),
                "colorFilter": clip.color_filter_preset,
                "colorFilterIntensity": clip.color_filter_intensity,
                "motionGraphicEffect": clip.motion_graphic_effect,
                "motionGraphicSettings": motion_graphic_settings_value(&clip),
            }));
        }
        if stills.is_empty() {
            return Err("None of the stills on the timeline have a generated image yet.".into());
        }
        // Always open the exported video on the first still rather than a
        // leading black segment — narration audio starting before any
        // picture appears (from a small silence before the first sentence)
        // reads as broken, not as an intentional pause.
        if let Some(min_index) = stills.iter().enumerate()
            .min_by(|(_, a), (_, b)| {
                a["start"].as_f64().unwrap_or(0.0)
                    .partial_cmp(&b["start"].as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index)
        {
            if stills[min_index]["start"].as_f64().unwrap_or(0.0) > 0.0 {
                stills[min_index]["start"] = json!(0.0);
            }
        }

        // Captions burn in from the user-editable timeline copy (timeline_caption_clips),
        // not the frozen caption-engine output, so retiming/text-edits/splits/merges/style
        // overrides made on the Timeline lane are reflected in the final export.
        let caption_default_style = merge_style(&default_caption_style(), &timeline.caption_style);
        let captions: Vec<serde_json::Value> = timeline.caption_clips.iter().map(|clip| {
            let resolved_style = match &clip.style {
                Some(overlay) => merge_style(&caption_default_style, overlay),
                None => caption_default_style.clone(),
            };
            json!({
                "text": clip.text,
                "start": clip.start_seconds,
                "end": clip.end_seconds,
                "style": resolved_style,
                "words": clip.words.as_ref().map(|words| words.iter().map(|w| json!({
                    "text": w.text, "start": w.start_seconds, "end": w.end_seconds,
                })).collect::<Vec<_>>()),
            })
        }).collect();

        let settings_raw = self.get_app_setting("image_settings")?.unwrap_or_default();
        let settings: serde_json::Value =
            serde_json::from_str(&settings_raw).unwrap_or_else(|_| json!({}));
        let (width, height) = resolution_dimensions(&options.resolution, requested_aspect_ratio(&settings));
        let (crf, preset) = quality_crf_preset(&options.quality);

        let last_still_end = timeline.clips.iter().map(|c| c.end_seconds).fold(0.0f64, f64::max);
        let last_caption_end = captions.iter()
            .filter_map(|c| c.get("end").and_then(|v| v.as_f64()))
            .fold(0.0f64, f64::max);
        let duration_seconds = [last_still_end, last_caption_end, timeline.narration_offset_seconds + narration_duration_seconds]
            .into_iter()
            .fold(0.0f64, f64::max);

        // Auto-duck is a *constant* attenuation for whichever portion of a
        // music clip overlaps narration's span (not dynamic sidechain
        // compression against the actual narration waveform) — see
        // MusicTool.tsx's own "Lowers music volume automatically for the
        // entire span where narration audio is present" description.
        let narration_span = (
            timeline.narration_offset_seconds,
            timeline.narration_offset_seconds + narration_duration_seconds,
        );
        let mut music = Vec::new();
        if options.include_music {
            for clip in &timeline.music_clips {
                let asset_path = self.media_library_asset_file_path(&clip.media_library_asset_id)?;
                let duck_overlap = if clip.auto_duck {
                    let overlap_start = clip.start_seconds.max(narration_span.0);
                    let overlap_end = clip.end_seconds.min(narration_span.1);
                    if overlap_end > overlap_start { Some((overlap_start, overlap_end)) } else { None }
                } else {
                    None
                };
                music.push(json!({
                    "path": asset_path.to_string_lossy(),
                    "start": clip.start_seconds,
                    "end": clip.end_seconds,
                    "volumePercent": clip.volume_percent * (timeline.music_master_volume_percent / 100.0),
                    "fadeInEnabled": clip.fade_in_enabled,
                    "fadeInSeconds": clip.fade_in_seconds,
                    "fadeOutEnabled": clip.fade_out_enabled,
                    "fadeOutSeconds": clip.fade_out_seconds,
                    "loopEnabled": clip.loop_enabled,
                    "duckOverlapStart": duck_overlap.map(|(s, _)| s),
                    "duckOverlapEnd": duck_overlap.map(|(_, e)| e),
                    "duckMultiplier": 1.0 - (timeline.music_duck_sensitivity_percent / 100.0).clamp(0.0, 1.0),
                }));
            }
        }

        let manifest = json!({
            "width": width,
            "height": height,
            "fps": 30,
            "crf": crf,
            "preset": preset,
            "narrationAudioPath": narration_audio_path.to_string_lossy(),
            "narrationOffsetSeconds": timeline.narration_offset_seconds,
            "narrationVolumePercent": timeline.narration_volume_percent,
            "narrationTrimStartSeconds": timeline.narration_trim_start_seconds,
            "narrationTrimEndSeconds": timeline.narration_trim_end_seconds,
            "narrationDurationSeconds": narration_duration_seconds,
            "includeNarration": options.include_narration,
            "music": music,
            "stills": stills,
            "captions": captions,
            "captionDefaultStyle": caption_default_style,
            "burnCaptions": options.captions_mode != "srt",
            "writeSrt": options.captions_mode != "burned-in",
            "durationSeconds": duration_seconds,
        });

        let work_dir = video_dir.join("export");
        fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
        let manifest_path = work_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
        ).map_err(|e| e.to_string())?;
        Ok((video_dir, manifest_path))
    }

    /// The ffmpeg-measured duration of this video's narration audio — the
    /// same authoritative value export uses. Exposed so "Extrapolate stills
    /// to fill gaps" targets exactly what export will, instead of a
    /// browser-measured duration that can disagree with ffmpeg by tens to a
    /// hundred-plus milliseconds for compressed audio.
    pub fn probe_narration_duration_seconds(&self, video_id: &str, engine_dir: &Path) -> Result<f64, String> {
        let inputs = self.get_video_inputs(video_id)?;
        let audio = inputs.audio.as_ref().ok_or("Narration audio is required.")?;
        let channel_id: String = self.connection.query_row(
            "SELECT channel_id FROM videos WHERE id=?1", [video_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let audio_path = self.projects_dir.join(&channel_id).join(video_id).join(&audio.relative_path);
        Self::probe_audio_duration(engine_dir, &audio_path)
    }

    fn probe_audio_duration(engine_dir: &Path, audio_path: &Path) -> Result<f64, String> {
        #[cfg(test)]
        {
            let _ = (engine_dir, audio_path);
            Ok(1.0)
        }
        #[cfg(not(test))]
        {
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(audio_path)
                .arg("--mode")
                .arg("probe")
                .current_dir(engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command
                .output()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Could not determine narration duration: {}", stderr.trim()));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.trim().parse::<f64>()
                .map_err(|_| format!("Could not parse narration duration from engine output: {}", stdout.trim()))
        }
    }

    /// Resolves the automatic zoom-anchor point for a still, for the
    /// "-subject" motion presets. Subject position is intrinsic to the image
    /// itself (a still can have multiple render versions), so it's cached on
    /// `image_renders.subject_x/y` after the first detection — later calls
    /// for the same render are free.
    pub fn detect_render_subject(
        &self,
        video_id: &str,
        render_id: &str,
        engine_dir: &Path,
    ) -> Result<(f64, f64), String> {
        let render = self.get_render_by_id(render_id)?;
        if render.video_id != video_id {
            return Err("Image render was not found.".to_string());
        }
        if let (Some(x), Some(y)) = (render.subject_x, render.subject_y) {
            return Ok((x, y));
        }
        let image_path = self.render_absolute_path(&render)?;
        let (x, y) = Self::run_detect_subject(engine_dir, &image_path)?;
        self.connection.execute(
            "UPDATE image_renders SET subject_x=?2, subject_y=?3 WHERE id=?1",
            params![render_id, x, y],
        ).map_err(|e| e.to_string())?;
        Ok((x, y))
    }

    fn run_detect_subject(engine_dir: &Path, image_path: &Path) -> Result<(f64, f64), String> {
        #[cfg(test)]
        {
            let _ = (engine_dir, image_path);
            Ok((0.5, 0.5))
        }
        #[cfg(not(test))]
        {
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(image_path)
                .arg("--mode")
                .arg("detect-subject")
                .current_dir(engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command
                .output()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Could not detect the image's subject: {}", stderr.trim()));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let value: serde_json::Value = serde_json::from_str(stdout.trim())
                .map_err(|_| format!("Could not parse subject detection from engine output: {}", stdout.trim()))?;
            let x = value.get("x").and_then(|v| v.as_f64())
                .ok_or_else(|| "Subject detection output was missing 'x'.".to_string())?;
            let y = value.get("y").and_then(|v| v.as_f64())
                .ok_or_else(|| "Subject detection output was missing 'y'.".to_string())?;
            Ok((x, y))
        }
    }

    /// Stretches (slows down) or trims a generated animation clip to exactly
    /// fill its timeline slot, via the export engine's `--mode retime`. Never
    /// speeds a clip up — only ever stretches or trims, per product decision.
    fn run_retime(
        engine_dir: &Path,
        source_path: &Path,
        source_duration: f64,
        target_duration: f64,
        output_path: &Path,
    ) -> Result<(), String> {
        #[cfg(test)]
        {
            let _ = (engine_dir, source_duration, target_duration);
            fs::copy(source_path, output_path).map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(not(test))]
        {
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(source_path)
                .arg("--output")
                .arg(output_path)
                .arg("--mode")
                .arg("retime")
                .arg("--source-duration")
                .arg(format!("{source_duration}"))
                .arg("--target-duration")
                .arg(format!("{target_duration}"))
                .current_dir(engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command
                .output()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Could not adjust the animation's duration: {}", stderr.trim()));
            }
            Ok(())
        }
    }

    /// Runs the export engine's `--mode denoise` on a single audio file:
    /// removes steady-state background noise (hiss, hum, fan/AC static) via
    /// an FFT noise gate plus a highpass/lowpass to trim rumble and top-end
    /// hiss, then loudness-normalizes so the cleaned file doesn't come out
    /// perceptibly quieter than the source. See `denoise_media_library_asset`
    /// for the caller — it writes the result to a brand-new library asset
    /// rather than overwriting `source_path`, so a disappointing result
    /// never costs the original file.
    fn run_denoise_audio(engine_dir: &Path, source_path: &Path, output_path: &Path) -> Result<(), String> {
        #[cfg(test)]
        {
            let _ = engine_dir;
            fs::copy(source_path, output_path).map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(not(test))]
        {
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(source_path)
                .arg("--output")
                .arg(output_path)
                .arg("--mode")
                .arg("denoise")
                .current_dir(engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command
                .output()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Could not remove background noise: {}", stderr.trim()));
            }
            Ok(())
        }
    }

    pub fn create_export_job(&self, video_id: &str, destination_path: &str) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO export_jobs(id,video_id,status,destination_path,created_at) VALUES(?1,?2,'running',?3,?4)",
            params![id, video_id, destination_path, Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn complete_export_job(&self, job_id: &str, destination_path: &str) -> Result<(), String> {
        self.connection.execute(
            "UPDATE export_jobs SET status='completed', destination_path=?1, completed_at=?2 WHERE id=?3",
            params![destination_path, Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn fail_export_job(&self, job_id: &str, error: &str) -> Result<(), String> {
        self.connection.execute(
            "UPDATE export_jobs SET status='failed', error=?1, completed_at=?2 WHERE id=?3",
            params![error, Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_export_jobs(&self, video_id: &str) -> Result<Vec<ExportJob>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id,video_id,status,destination_path,error,created_at,completed_at FROM export_jobs WHERE video_id=?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let jobs = statement.query_map([video_id], |row| Ok(ExportJob {
            id: row.get(0)?,
            video_id: row.get(1)?,
            status: row.get(2)?,
            destination_path: row.get(3)?,
            error: row.get(4)?,
            created_at: row.get(5)?,
            completed_at: row.get(6)?,
        })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(jobs)
    }

    pub fn export_timeline_video_with_progress<F, S>(
        &self,
        video_id: &str,
        engine_dir: &Path,
        options: &ExportSettings,
        mut on_spawn: S,
        mut progress: F,
    ) -> Result<(PathBuf, Option<PathBuf>), String>
    where
        F: FnMut(i64, &str, &str),
        S: FnMut(u32),
    {
        #[cfg(test)]
        {
            let _ = (engine_dir, options, &mut on_spawn);
            progress(100, "Export ready", "test");
            Ok((PathBuf::from("test-output.mp4"), None))
        }
        #[cfg(not(test))]
        {
            let (video_dir, manifest_path) =
                self.build_timeline_export_manifest(video_id, engine_dir, options)?;
            let output_path = video_dir.join("export").join("output.mp4");
            let srt_path = video_dir.join("export").join("captions.srt");
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(&manifest_path)
                .arg("--output")
                .arg(&output_path)
                .current_dir(&engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            on_spawn(child.id());
            let stdout = child
                .stdout
                .take()
                .ok_or("Could not capture export engine output.")?;
            let stderr = child
                .stderr
                .take()
                .ok_or("Could not capture export engine errors.")?;
            let stderr_thread = std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut bytes = Vec::new();
                let mut output = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => output.push(String::from_utf8_lossy(&bytes).trim().to_string()),
                    }
                }
                output.join("\n")
            });
            let mut output_lines = Vec::new();
            let mut stdout_reader = BufReader::new(stdout);
            let mut line_bytes = Vec::new();
            loop {
                line_bytes.clear();
                let count = stdout_reader
                    .read_until(b'\n', &mut line_bytes)
                    .map_err(|e| format!("Could not read engine progress: {e}"))?;
                if count == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if let Some(payload) = line.strip_prefix("AUTOGEN_PROGRESS ") {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        progress(
                            value["percent"].as_i64().unwrap_or(0),
                            value["stage"].as_str().unwrap_or("Exporting video"),
                            value["detail"].as_str().unwrap_or_default(),
                        );
                    }
                } else {
                    output_lines.push(line);
                }
            }
            let status = child
                .wait()
                .map_err(|e| format!("Could not wait for export engine: {e}"))?;
            let raw_stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                let clean_stdout: Vec<&str> = output_lines
                    .iter()
                    .map(String::as_str)
                    .filter(|l| {
                        !l.is_empty()
                            && !l.chars().all(|c| "#|-% \t".contains(c))
                            && !l.contains("iB/s")
                            && !l.contains("eta 0:")
                    })
                    .collect();
                let clean_stderr: Vec<&str> = raw_stderr
                    .lines()
                    .filter(|l| {
                        !l.is_empty()
                            && !l.contains("UserWarning")
                            && !l.contains("warnings.warn")
                            && !l.contains("FP16")
                    })
                    .collect();
                let mut parts = clean_stdout.join("\n");
                if !clean_stderr.is_empty() {
                    if !parts.is_empty() {
                        parts.push('\n');
                    }
                    parts.push_str(&clean_stderr.join("\n"));
                }
                return Err(format!("Video export failed. {parts}"));
            }
            if !output_path.exists() {
                return Err("Video export finished but no output file was produced.".into());
            }
            let produced_srt = (options.captions_mode != "burned-in" && srt_path.exists())
                .then_some(srt_path);
            Ok((output_path, produced_srt))
        }
    }

    /// Exports the timeline as separate editor-ready assets (CapCut, Premiere,
    /// etc.) instead of one baked video — each still becomes its own clip file,
    /// stretched to close any silence gap and trimmed to its exact timeline
    /// slot, so placing them back-to-back in order reproduces the whole
    /// timeline without manual trimming. See `video_export_engine.py`'s
    /// `run_bundle` for the actual asset generation.
    pub fn export_timeline_project_with_progress<F, S>(
        &self,
        video_id: &str,
        engine_dir: &Path,
        destination_dir: &Path,
        mut on_spawn: S,
        mut progress: F,
    ) -> Result<PathBuf, String>
    where
        F: FnMut(i64, &str, &str),
        S: FnMut(u32),
    {
        #[cfg(test)]
        {
            let _ = (engine_dir, destination_dir, &mut on_spawn);
            progress(100, "Export ready", "test");
            Ok(PathBuf::from("test-bundle"))
        }
        #[cfg(not(test))]
        {
            // Bundle export hands each clip to another editor as its own file
            // at native resolution/quality — the single-file video's
            // resolution/quality/captions-mode/music-mix settings don't apply.
            let (_video_dir, manifest_path) =
                self.build_timeline_export_manifest(video_id, engine_dir, &ExportSettings::default())?;
            let export_engine = engine_dir.join("auto_gen_engine/video_export_engine.py");
            if !export_engine.exists() {
                return Err(format!(
                    "Internal video export engine was not found at {}.",
                    export_engine.display()
                ));
            }
            let mut command = Command::new(find_python());
            command
                .arg(&export_engine)
                .arg(&manifest_path)
                .arg("--output")
                .arg(destination_dir)
                .arg("--mode")
                .arg("bundle")
                .current_dir(&engine_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command
                .spawn()
                .map_err(|e| format!("Could not start the video export engine: {e}"))?;
            on_spawn(child.id());
            let stdout = child
                .stdout
                .take()
                .ok_or("Could not capture export engine output.")?;
            let stderr = child
                .stderr
                .take()
                .ok_or("Could not capture export engine errors.")?;
            let stderr_thread = std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut bytes = Vec::new();
                let mut output = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => output.push(String::from_utf8_lossy(&bytes).trim().to_string()),
                    }
                }
                output.join("\n")
            });
            let mut output_lines = Vec::new();
            let mut stdout_reader = BufReader::new(stdout);
            let mut line_bytes = Vec::new();
            loop {
                line_bytes.clear();
                let count = stdout_reader
                    .read_until(b'\n', &mut line_bytes)
                    .map_err(|e| format!("Could not read engine progress: {e}"))?;
                if count == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if let Some(payload) = line.strip_prefix("AUTOGEN_PROGRESS ") {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        progress(
                            value["percent"].as_i64().unwrap_or(0),
                            value["stage"].as_str().unwrap_or("Exporting project"),
                            value["detail"].as_str().unwrap_or_default(),
                        );
                    }
                } else {
                    output_lines.push(line);
                }
            }
            let status = child
                .wait()
                .map_err(|e| format!("Could not wait for export engine: {e}"))?;
            let raw_stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                let clean_stdout: Vec<&str> = output_lines
                    .iter()
                    .map(String::as_str)
                    .filter(|l| {
                        !l.is_empty()
                            && !l.chars().all(|c| "#|-% \t".contains(c))
                            && !l.contains("iB/s")
                            && !l.contains("eta 0:")
                    })
                    .collect();
                let clean_stderr: Vec<&str> = raw_stderr
                    .lines()
                    .filter(|l| {
                        !l.is_empty()
                            && !l.contains("UserWarning")
                            && !l.contains("warnings.warn")
                            && !l.contains("FP16")
                    })
                    .collect();
                let mut parts = clean_stdout.join("\n");
                if !clean_stderr.is_empty() {
                    if !parts.is_empty() {
                        parts.push('\n');
                    }
                    parts.push_str(&clean_stderr.join("\n"));
                }
                return Err(format!("Project export failed. {parts}"));
            }
            if !destination_dir.exists() {
                return Err("Project export finished but no output folder was produced.".into());
            }
            Ok(destination_dir.to_path_buf())
        }
    }

    pub fn move_plan_sentence(
        &self,
        video_id: &str,
        sentence_id: &str,
        target_group_id: &str,
    ) -> Result<VisualPlan, String> {
        let mut groups = self.load_groups(video_id, false)?;
        let source = groups
            .iter()
            .position(|group| group.sentence_ids.contains(&sentence_id.to_string()))
            .ok_or("Sentence was not found.")?;
        let target = groups
            .iter()
            .position(|group| group.id == target_group_id)
            .ok_or("Target group was not found.")?;
        if source.abs_diff(target) > 1 {
            return Err("Sentences may only move to an adjacent scene.".into());
        }
        if source == target {
            return self.get_visual_plan(video_id);
        }
        let source_ids = &groups[source].sentence_ids;
        let is_valid_boundary_move = if source < target {
            source_ids.last().map(String::as_str) == Some(sentence_id)
        } else {
            source_ids.first().map(String::as_str) == Some(sentence_id)
        };
        if !is_valid_boundary_move {
            return Err(
                "Only the first or last sentence of a still can cross its boundary. Chronological order must remain intact."
                    .into(),
            );
        }
        groups[source].sentence_ids.retain(|id| id != sentence_id);
        // Captured before the push (any sentence already in the target
        // group other than the one we're about to add) — used below to
        // resolve which scene the target group belongs to, without relying
        // on `target`'s index still being valid after groups.retain() may
        // remove the now-possibly-empty source group and shift indices.
        let target_anchor_sentence = groups[target].sentence_ids.first().cloned();
        groups[target].sentence_ids.push(sentence_id.into());
        groups[target]
            .sentence_ids
            .sort_by_key(|id| sentence_number(id));
        groups.retain(|group| !group.sentence_ids.is_empty());
        for (index, group) in groups.iter_mut().enumerate() {
            group.ordinal = index as i64 + 1;
        }
        validate_group_chronology(&groups)?;
        let plan = self.get_visual_plan(video_id)?;
        let mut scenes = plan.scenes.clone();
        // A boundary-crossing move — "drag a sentence into the scene above
        // or below" — shifts the scene boundary itself: the departing
        // scene's range shrinks, the receiving scene's grows. Only the
        // scenes' own `sentence_ids` change here; assign_scene_ids below
        // re-derives every group's scene_id from the result.
        if let (Some(source_scene), Some(target_scene)) = (
            scene_containing_sentence(&scenes, sentence_id),
            target_anchor_sentence.as_deref().and_then(|anchor| scene_containing_sentence(&scenes, anchor)),
        ) {
            if source_scene != target_scene {
                scenes[source_scene].sentence_ids.retain(|id| id != sentence_id);
                scenes[target_scene].sentence_ids.push(sentence_id.into());
                scenes[target_scene].sentence_ids.sort_by_key(|id| sentence_number(id));
                rebalance_scene_ordinals(&mut scenes);
            }
        }
        assign_scene_ids(&mut groups, &scenes);
        self.save_plan(video_id, &plan.sentences, &groups, &scenes, false, &plan.timing_source)?;
        self.get_visual_plan(video_id)
    }

    /// Restores the plan to exactly how it looked right after generation —
    /// grouping boundaries AND sentence text/splits/merges. Sentences have
    /// no is_original duplication like groups do (see MIGRATION_032's doc
    /// comment), so the snapshot lives as JSON on `visual_plan_meta`,
    /// captured once by `save_original_sentences_snapshot` right after
    /// generation. Plans generated before that existed have no snapshot
    /// (`original_sentences_json` is NULL) — falls back to the old
    /// groups-only reset for those rather than erroring.
    pub fn reset_visual_plan(&self, video_id: &str) -> Result<VisualPlan, String> {
        let original_groups = self.load_groups(video_id, true)?;
        let original_scenes = self.load_scenes(video_id, true)?;
        let plan = self.get_visual_plan(video_id)?;
        let snapshot_json: Option<String> = self.connection.query_row(
            "SELECT original_sentences_json FROM visual_plan_meta WHERE video_id=?1",
            [video_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let original_sentences: Vec<PlanSentence> = match snapshot_json {
            Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string())?,
            None => plan.sentences,
        };
        // save_plan's sentence-write and is_original=1 group/scene-write are
        // both gated by the same `original: bool` — writing original_groups
        // and original_scenes back over themselves here is a harmless no-op,
        // it's what unlocks restoring sentences without a separate write
        // path. Scenes restored this way also naturally come back expanded
        // (the original snapshot was always written with expanded=true at
        // generation time), which is the intended "reset = fresh start"
        // behavior rather than something specially engineered here.
        self.save_plan(video_id, &original_sentences, &original_groups, &original_scenes, true, &plan.timing_source)?;
        self.save_plan(video_id, &original_sentences, &original_groups, &original_scenes, false, &plan.timing_source)?;
        self.get_visual_plan(video_id)
    }

    pub fn create_plan_group(
        &self,
        video_id: &str,
        sentence_id: &str,
        insert_index: usize,
        force_new_scene: bool,
    ) -> Result<VisualPlan, String> {
        let mut groups = self.load_groups(video_id, false)?;
        let source = groups
            .iter()
            .position(|group| group.sentence_ids.contains(&sentence_id.to_string()))
            .ok_or("Sentence was not found.")?;
        let source_ids = &groups[source].sentence_ids;
        let is_first = source_ids.first().map(String::as_str) == Some(sentence_id);
        let is_last = source_ids.last().map(String::as_str) == Some(sentence_id);
        if !is_first && !is_last {
            return Err(
                "A new still can only be created from the first or last sentence of an existing still."
                    .into(),
            );
        }
        // A still with exactly one sentence is simultaneously its own first
        // AND last sentence — so both the divider immediately before it and
        // the one immediately after are equally valid, zero-distance
        // chronological boundaries (e.g. peeling an already-solo still off
        // into a brand new scene right after it, one of the most common
        // cases for the "drag across a scene seam" feature, since scenes
        // built from fast/per-sentence pacing are mostly solo-sentence
        // stills). A multi-sentence still still only allows the one side
        // its dragged sentence actually sits on.
        let valid_insert_indexes: Vec<usize> = if is_first && is_last {
            vec![source, source + 1]
        } else if is_first {
            vec![source]
        } else {
            vec![source + 1]
        };
        if !valid_insert_indexes.contains(&insert_index) {
            return Err("Drop at the sentence's chronological boundary to create a new still.".into());
        }
        // Captured before mutating: if this sentence is its group's only
        // one, that whole group is about to vanish from `groups` below —
        // which shifts every later index down by one. `insert_index` was
        // computed by the caller against the PRE-removal array, so it needs
        // the same adjustment or the new group lands one slot too far right
        // (silently wrong chronological order — see the seam test that
        // covers this).
        let source_group_disappears = groups[source].sentence_ids.len() == 1;
        groups[source].sentence_ids.retain(|id| id != sentence_id);
        groups.retain(|group| !group.sentence_ids.is_empty());
        let next_id = groups
            .iter()
            .map(|group| sentence_number(group.id.trim_start_matches('g')))
            .max()
            .unwrap_or(0)
            + 1;
        let adjusted_insert_index = if source_group_disappears && source < insert_index {
            insert_index - 1
        } else {
            insert_index
        };
        let target = adjusted_insert_index.min(groups.len());
        groups.insert(
            target,
            PlanGroup {
                id: format!("g{next_id}"),
                ordinal: 0,
                label: "New still".into(),
                kind: "custom".into(),
                sentence_ids: vec![sentence_id.into()],
                settings_locked: false,
                prompt_locked: false,
                // Resolved below by assign_scene_ids, after scenes are
                // rebalanced — usually the scene that already contained
                // this sentence, or a brand new scene if the split lands
                // exactly at an existing scene seam (see below).
                scene_id: None,
            },
        );
        for (index, group) in groups.iter_mut().enumerate() {
            group.ordinal = index as i64 + 1;
        }
        validate_group_chronology(&groups)?;
        let current = self.get_visual_plan(video_id)?;
        let mut scenes = current.scenes.clone();
        // "Create a new still" defaults to staying in the still's own
        // (ambient) scene, full stop — regardless of whether the split
        // point also happens to sit at a pre-existing scene seam. That
        // used to auto-promote to "start a new scene" any time the split
        // landed at a seam, which swallowed the plain "just split this
        // still" gesture for every scene with only one or two stills (its
        // only valid split points ARE the seams either side of it) — this
        // is what force_new_scene (the frontend's Shift-modifier) now
        // exists to opt into explicitly: peel the sentence into a brand
        // new scene at exactly this position, unconditionally. Since
        // `scenes` is otherwise left untouched, the new still's sentence
        // is still listed under whatever scene it always was, so
        // assign_scene_ids below naturally keeps it there by default.
        if force_new_scene {
            if let Some(departing_scene) = scene_containing_sentence(&scenes, sentence_id) {
                scenes[departing_scene].sentence_ids.retain(|id| id != sentence_id);
            }
            let next_scene_id = scenes.iter()
                .map(|scene| sentence_number(scene.id.trim_start_matches("sc")))
                .max()
                .unwrap_or(0)
                + 1;
            scenes.push(PlanScene {
                id: format!("sc{next_scene_id}"),
                ordinal: 0,
                label: "Scene".into(),
                narrative_role: None,
                core_idea: None,
                emotional_state: None,
                visual_opportunities: Vec::new(),
                sentence_ids: vec![sentence_id.into()],
                expanded: true,
            });
            rebalance_scene_ordinals(&mut scenes);
        }
        assign_scene_ids(&mut groups, &scenes);
        self.save_plan(
            video_id,
            &current.sentences,
            &groups,
            &scenes,
            false,
            &current.timing_source,
        )?;
        self.get_visual_plan(video_id)
    }

    /// Persists a scene's collapsed/expanded state — shared by the Visual
    /// Plan tab and the Images tab's left pane (both read/write the same
    /// `visual_plan_scenes.expanded` column, so toggling a scene in one is
    /// reflected in the other). The Bulk Generation panel's own scene
    /// collapse state is intentionally NOT tied to this — it's local
    /// component state in App.tsx, not persisted here. Reshaping scene
    /// boundaries themselves still isn't a user action (see the Visual
    /// Scene Segmentor plan's "explicitly out of scope" list). Only ever
    /// touches the current (`is_original=0`) snapshot — expand state isn't
    /// part of what `reset_visual_plan` restores from the original
    /// snapshot, it naturally comes back to every scene's generation-time
    /// default (expanded) on reset, same as everything else in that
    /// snapshot.
    pub fn set_plan_scene_expanded(
        &self,
        video_id: &str,
        scene_id: &str,
        expanded: bool,
    ) -> Result<VisualPlan, String> {
        let updated = self.connection.execute(
            "UPDATE visual_plan_scenes SET expanded=?1 WHERE video_id=?2 AND is_original=0 AND id=?3",
            params![expanded as i64, video_id, format!("{video_id}::current::{scene_id}")],
        ).map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Scene was not found.".into());
        }
        self.get_visual_plan(video_id)
    }

    /// Renumbers every sentence id (`"sN"`) referenced across a group set
    /// via `renumber`, in place — shared by `split_plan_sentence` and
    /// `merge_plan_sentences` to keep both the "current" and "original"
    /// snapshots consistent with a sentence id shift. `renumber` returns
    /// `None` to drop a reference entirely (used by merge to remove the
    /// absorbed sentence's id) or `Some(new_ids)` to replace it with one or
    /// more ids in order (used by split to expand one id into two).
    fn renumber_group_sentence_ids<F>(groups: &mut Vec<PlanGroup>, mut renumber: F)
    where
        F: FnMut(&str) -> Option<Vec<String>>,
    {
        for group in groups.iter_mut() {
            group.sentence_ids = group
                .sentence_ids
                .iter()
                .flat_map(|id| renumber(id).unwrap_or_default())
                .collect();
        }
        groups.retain(|group| !group.sentence_ids.is_empty());
    }

    /// Same shift as `renumber_group_sentence_ids`, applied to scenes'
    /// sentence ranges instead of stills' — without this, a scene's
    /// `sentence_ids_json` goes stale (referring to ids that no longer exist)
    /// the moment a split/merge shifts every later sentence's id. A scene
    /// can legitimately empty out and get dropped the same way a group can
    /// (e.g. a one-sentence scene whose sole sentence gets merged into the
    /// previous, differently-scened, sentence).
    fn renumber_scene_sentence_ids<F>(scenes: &mut Vec<PlanScene>, mut renumber: F)
    where
        F: FnMut(&str) -> Option<Vec<String>>,
    {
        for scene in scenes.iter_mut() {
            scene.sentence_ids = scene
                .sentence_ids
                .iter()
                .flat_map(|id| renumber(id).unwrap_or_default())
                .collect();
        }
        scenes.retain(|scene| !scene.sentence_ids.is_empty());
    }

    /// Writes both the "current" and "original" `visual_plan_groups`
    /// snapshots plus the full `visual_plan_sentences` set in one pass —
    /// used by `split_plan_sentence`/`merge_plan_sentences`, which (unlike
    /// every other plan-editing method) must rewrite sentence text/ids
    /// themselves, not just group membership. Deliberately bypasses
    /// `save_plan` (its sentence-write path is gated by the same `original`
    /// flag that controls which group snapshot gets overwritten, and it
    /// only ever writes one group snapshot per call) rather than
    /// complicating that method's contract for every other caller.
    fn write_renumbered_plan(
        &self,
        video_id: &str,
        sentences: &[PlanSentence],
        current_groups: &[PlanGroup],
        original_groups: &[PlanGroup],
        current_scenes: &[PlanScene],
        original_scenes: &[PlanScene],
    ) -> Result<(), String> {
        self.connection.execute(
            "DELETE FROM visual_plan_sentences WHERE video_id = ?1",
            [video_id],
        ).map_err(|e| e.to_string())?;
        for sentence in sentences {
            self.connection.execute(
                "INSERT INTO visual_plan_sentences(id, video_id, ordinal, text, start_seconds, end_seconds) VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    format!("{video_id}::{}", sentence.id),
                    video_id,
                    sentence.ordinal,
                    sentence.text,
                    sentence.start_seconds,
                    sentence.end_seconds
                ],
            ).map_err(|e| e.to_string())?;
        }
        for (groups, original) in [(current_groups, false), (original_groups, true)] {
            self.connection.execute(
                "DELETE FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2",
                params![video_id, original as i64],
            ).map_err(|e| e.to_string())?;
            for group in groups {
                self.connection.execute(
                    "INSERT INTO visual_plan_groups(id, video_id, ordinal, label, kind, sentence_ids_json, is_original, scene_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        format!("{video_id}::{}::{}", if original {"original"} else {"current"}, group.id),
                        video_id,
                        group.ordinal,
                        group.label,
                        group.kind,
                        serde_json::to_string(&group.sentence_ids).unwrap(),
                        original as i64,
                        group.scene_id
                    ],
                ).map_err(|e| e.to_string())?;
            }
        }
        for (scenes, original) in [(current_scenes, false), (original_scenes, true)] {
            self.connection.execute(
                "DELETE FROM visual_plan_scenes WHERE video_id = ?1 AND is_original = ?2",
                params![video_id, original as i64],
            ).map_err(|e| e.to_string())?;
            for scene in scenes {
                self.connection.execute(
                    "INSERT INTO visual_plan_scenes(id, video_id, ordinal, label, narrative_role, core_idea, emotional_state, visual_opportunities_json, sentence_ids_json, is_original, expanded) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![
                        format!("{video_id}::{}::{}", if original {"original"} else {"current"}, scene.id),
                        video_id,
                        scene.ordinal,
                        scene.label,
                        scene.narrative_role,
                        scene.core_idea,
                        scene.emotional_state,
                        serde_json::to_string(&scene.visual_opportunities).unwrap(),
                        serde_json::to_string(&scene.sentence_ids).unwrap(),
                        original as i64,
                        scene.expanded as i64
                    ],
                ).map_err(|e| e.to_string())?;
            }
        }
        self.connection.execute(
            "UPDATE visual_plan_meta SET updated_at=?1 WHERE video_id=?2",
            params![Utc::now().to_rfc3339(), video_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Plain text edit for one sentence (double-click-to-edit in the Visual
    /// Plan view) — no renumbering needed since it doesn't change how many
    /// sentences exist. Mid-text-period edits are handled by
    /// `split_plan_sentence` instead, called by the frontend before this
    /// one whenever it detects a period was typed.
    pub fn update_plan_sentence_text(&self, video_id: &str, sentence_id: &str, text: &str) -> Result<VisualPlan, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Sentence text is required.".into());
        }
        self.connection.execute(
            "UPDATE visual_plan_sentences SET text=?1 WHERE video_id=?2 AND id=?3",
            params![trimmed, video_id, format!("{video_id}::{sentence_id}")],
        ).map_err(|e| e.to_string())?;
        self.get_visual_plan(video_id)
    }

    /// Splits one sentence's text into two, given the two halves' text
    /// directly (NOT a byte offset into whatever text happens to be stored
    /// server-side) — the frontend sends the actual live-edited left/right
    /// text, since the DOM being edited can already differ from what's in
    /// the database (the just-typed period, plus any other unsaved edits
    /// made earlier in the same editing session before the split
    /// triggered). An offset computed against the live DOM text but applied
    /// against stale server-side text silently splits at the wrong point —
    /// this is what `split_caption_clip` already does it this way for the
    /// same reason. Renumbers every later sentence id and every group's
    /// `sentence_ids_json` (both snapshots) to keep the gapless-consecutive-
    /// id chronology invariant (`validate_group_chronology`) intact. No
    /// word-level timestamps exist per sentence (confirmed: `visual_plan_
    /// sentences` has no per-word column), so timing splits proportionally
    /// by word count either side — the same approach `split_caption_clip`
    /// uses, just word-count instead of that feature's true per-word
    /// timestamps.
    pub fn split_plan_sentence(
        &self,
        video_id: &str,
        sentence_id: &str,
        left_text: &str,
        right_text: &str,
    ) -> Result<VisualPlan, String> {
        let plan = self.get_visual_plan(video_id)?;
        let target_number = sentence_number(sentence_id);
        let mut sentences = plan.sentences;
        let target_index = sentences
            .iter()
            .position(|s| s.id == sentence_id)
            .ok_or("Sentence was not found.")?;
        let left_text = left_text.trim().to_string();
        let right_text = right_text.trim().to_string();
        if left_text.is_empty() || right_text.is_empty() {
            return Err("Split point must have text on both sides.".into());
        }
        let left_words = left_text.split_whitespace().count().max(1) as f64;
        let right_words = right_text.split_whitespace().count().max(1) as f64;
        let fraction = left_words / (left_words + right_words);
        let start = sentences[target_index].start_seconds;
        let end = sentences[target_index].end_seconds;
        let midpoint = start + (end - start) * fraction;

        let new_right_id = format!("s{}", target_number + 1);
        sentences[target_index].text = left_text;
        sentences[target_index].end_seconds = midpoint;
        // Shift every existing sentence's OWN id past the split point up by
        // one, freeing `target_number + 1` for the new right-half and
        // keeping the sentences table's ids in sync with what `renumber`
        // below applies to group references — this loop was missing
        // entirely in the first version, leaving groups pointing at ids
        // that don't exist in `visual_plan_sentences`.
        for sentence in sentences.iter_mut() {
            let n = sentence_number(&sentence.id);
            if n > target_number {
                sentence.id = format!("s{}", n + 1);
            }
        }
        let right_sentence = PlanSentence {
            id: new_right_id.clone(),
            ordinal: 0,
            text: right_text,
            start_seconds: midpoint,
            end_seconds: end,
        };
        sentences.insert(target_index + 1, right_sentence);
        for (index, sentence) in sentences.iter_mut().enumerate() {
            sentence.ordinal = index as i64 + 1;
        }

        let renumber = |id: &str| -> Option<Vec<String>> {
            let n = sentence_number(id);
            if n == target_number {
                Some(vec![format!("s{n}"), new_right_id.clone()])
            } else if n > target_number {
                Some(vec![format!("s{}", n + 1)])
            } else {
                Some(vec![id.to_string()])
            }
        };
        let mut current_groups = self.load_groups(video_id, false)?;
        let mut original_groups = self.load_groups(video_id, true)?;
        let mut current_scenes = self.load_scenes(video_id, false)?;
        let mut original_scenes = self.load_scenes(video_id, true)?;
        Self::renumber_group_sentence_ids(&mut current_groups, renumber);
        Self::renumber_group_sentence_ids(&mut original_groups, renumber);
        Self::renumber_scene_sentence_ids(&mut current_scenes, renumber);
        Self::renumber_scene_sentence_ids(&mut original_scenes, renumber);
        for groups in [&mut current_groups, &mut original_groups] {
            for (index, group) in groups.iter_mut().enumerate() {
                group.ordinal = index as i64 + 1;
            }
        }
        for scenes in [&mut current_scenes, &mut original_scenes] {
            for (index, scene) in scenes.iter_mut().enumerate() {
                scene.ordinal = index as i64 + 1;
            }
        }
        assign_scene_ids(&mut current_groups, &current_scenes);
        assign_scene_ids(&mut original_groups, &original_scenes);
        validate_group_chronology(&current_groups)?;
        validate_group_chronology(&original_groups)?;

        self.write_renumbered_plan(
            video_id,
            &sentences,
            &current_groups,
            &original_groups,
            &current_scenes,
            &original_scenes,
        )?;
        self.get_visual_plan(video_id)
    }

    /// Merges two chronologically ADJACENT sentences into one (dragging one
    /// sentence onto another), renumbering everything after the merge point
    /// down by one id — the merge counterpart to `split_plan_sentence`. Only
    /// adjacent sentences are accepted (same convention as `move_plan_
    /// sentence`'s boundary check and `merge_caption_clips`'s adjacency
    /// requirement) since merging non-adjacent sentences would silently
    /// reorder narration, violating chronology.
    pub fn merge_plan_sentences(
        &self,
        video_id: &str,
        first_sentence_id: &str,
        second_sentence_id: &str,
    ) -> Result<VisualPlan, String> {
        let plan = self.get_visual_plan(video_id)?;
        let first_number = sentence_number(first_sentence_id);
        let second_number = sentence_number(second_sentence_id);
        if second_number != first_number + 1 {
            return Err("Only chronologically adjacent sentences can be merged.".into());
        }
        let mut sentences = plan.sentences;
        let first_index = sentences
            .iter()
            .position(|s| s.id == first_sentence_id)
            .ok_or("Sentence was not found.")?;
        let second_index = sentences
            .iter()
            .position(|s| s.id == second_sentence_id)
            .ok_or("Sentence was not found.")?;
        let second = sentences.remove(second_index);
        let first = &mut sentences[first_index];
        // Strip the first half's trailing period at the join so the merge
        // is reversible the same way it was created: typing "." back at
        // that exact spot re-triggers the auto-split. Only a plain "."
        // is stripped (not "?"/"!") — those change the sentence's meaning
        // if dropped and aren't what the split trigger looks for anyway.
        let first_trimmed = first.text.trim();
        let first_joined = first_trimmed.strip_suffix('.').unwrap_or(first_trimmed);
        first.text = format!("{} {}", first_joined, second.text.trim());
        first.start_seconds = first.start_seconds.min(second.start_seconds);
        first.end_seconds = first.end_seconds.max(second.end_seconds);
        // Same fix as split_plan_sentence: shift every remaining sentence's
        // OWN id past the removed one down by one, keeping the sentences
        // table in sync with what `renumber` below applies to group
        // references — this loop was missing entirely in the first version.
        for sentence in sentences.iter_mut() {
            let n = sentence_number(&sentence.id);
            if n > second_number {
                sentence.id = format!("s{}", n - 1);
            }
        }
        for (index, sentence) in sentences.iter_mut().enumerate() {
            sentence.ordinal = index as i64 + 1;
        }

        let renumber = |id: &str| -> Option<Vec<String>> {
            let n = sentence_number(id);
            if n == second_number {
                None
            } else if n > second_number {
                Some(vec![format!("s{}", n - 1)])
            } else {
                Some(vec![id.to_string()])
            }
        };
        let mut current_groups = self.load_groups(video_id, false)?;
        let mut original_groups = self.load_groups(video_id, true)?;
        let mut current_scenes = self.load_scenes(video_id, false)?;
        let mut original_scenes = self.load_scenes(video_id, true)?;
        Self::renumber_group_sentence_ids(&mut current_groups, renumber);
        Self::renumber_group_sentence_ids(&mut original_groups, renumber);
        Self::renumber_scene_sentence_ids(&mut current_scenes, renumber);
        Self::renumber_scene_sentence_ids(&mut original_scenes, renumber);
        for groups in [&mut current_groups, &mut original_groups] {
            for (index, group) in groups.iter_mut().enumerate() {
                group.ordinal = index as i64 + 1;
            }
        }
        for scenes in [&mut current_scenes, &mut original_scenes] {
            for (index, scene) in scenes.iter_mut().enumerate() {
                scene.ordinal = index as i64 + 1;
            }
        }
        assign_scene_ids(&mut current_groups, &current_scenes);
        assign_scene_ids(&mut original_groups, &original_scenes);
        validate_group_chronology(&current_groups)?;
        validate_group_chronology(&original_groups)?;

        self.write_renumbered_plan(
            video_id,
            &sentences,
            &current_groups,
            &original_groups,
            &current_scenes,
            &original_scenes,
        )?;
        self.get_visual_plan(video_id)
    }

    /// Captures the just-generated sentence list as a JSON snapshot on
    /// `visual_plan_meta`, so `reset_visual_plan` has something to restore
    /// sentence text/splits/merges FROM — called once, right after
    /// generation, never touched by `split_plan_sentence`/`merge_plan_
    /// sentences`/`update_plan_sentence_text`. Requires the `visual_plan_
    /// meta` row to already exist (call after `save_plan`, which upserts
    /// it) since this is a plain UPDATE, not an upsert.
    fn save_original_sentences_snapshot(&self, video_id: &str, sentences: &[PlanSentence]) -> Result<(), String> {
        let json = serde_json::to_string(sentences).map_err(|e| e.to_string())?;
        self.connection.execute(
            "UPDATE visual_plan_meta SET original_sentences_json=?1 WHERE video_id=?2",
            params![json, video_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Captures the exact script/audio/pacing used for this generation, so
    /// a later `get_video_inputs` call can tell whether the existing plan
    /// still matches current inputs even after a full app restart — see
    /// MIGRATION_033's doc comment for why this can't just be reconstructed
    /// from `video_inputs` at read time. Called once, right after
    /// generation, alongside `save_original_sentences_snapshot`.
    fn save_plan_generation_inputs(&self, video_id: &str, inputs: &VideoInputs) -> Result<(), String> {
        self.connection.execute(
            "UPDATE visual_plan_meta SET generation_script_text=?1, generation_audio_id=?2, generation_pacing_preset=?3, generation_pacing_min_seconds=?4, generation_pacing_max_seconds=?5 WHERE video_id=?6",
            params![
                inputs.script_text,
                inputs.audio.as_ref().map(|a| a.id.clone()),
                inputs.pacing_preset,
                inputs.pacing_min_seconds,
                inputs.pacing_max_seconds,
                video_id
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn save_plan(
        &self,
        video_id: &str,
        sentences: &[PlanSentence],
        groups: &[PlanGroup],
        scenes: &[PlanScene],
        original: bool,
        timing_source: &str,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        if original {
            self.connection
                .execute(
                    "DELETE FROM visual_plan_sentences WHERE video_id = ?1",
                    [video_id],
                )
                .map_err(|e| e.to_string())?;
            for sentence in sentences {
                self.connection.execute(
                    "INSERT INTO visual_plan_sentences(id, video_id, ordinal, text, start_seconds, end_seconds) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![
                        format!("{video_id}::{}", sentence.id),
                        video_id,
                        sentence.ordinal,
                        sentence.text,
                        sentence.start_seconds,
                        sentence.end_seconds
                    ],
                ).map_err(|e| e.to_string())?;
            }
        }
        self.connection
            .execute(
                "DELETE FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2",
                params![video_id, original as i64],
            )
            .map_err(|e| e.to_string())?;
        for group in groups {
            self.connection.execute(
                "INSERT INTO visual_plan_groups(id, video_id, ordinal, label, kind, sentence_ids_json, is_original, scene_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    format!(
                        "{video_id}::{}::{}",
                        if original {"original"} else {"current"},
                        group.id
                    ),
                    video_id,
                    group.ordinal,
                    group.label,
                    group.kind,
                    serde_json::to_string(&group.sentence_ids).unwrap(),
                    original as i64,
                    group.scene_id
                ],
            ).map_err(|e| e.to_string())?;
        }
        self.connection
            .execute(
                "DELETE FROM visual_plan_scenes WHERE video_id = ?1 AND is_original = ?2",
                params![video_id, original as i64],
            )
            .map_err(|e| e.to_string())?;
        for scene in scenes {
            self.connection.execute(
                "INSERT INTO visual_plan_scenes(id, video_id, ordinal, label, narrative_role, core_idea, emotional_state, visual_opportunities_json, sentence_ids_json, is_original, expanded) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    format!(
                        "{video_id}::{}::{}",
                        if original {"original"} else {"current"},
                        scene.id
                    ),
                    video_id,
                    scene.ordinal,
                    scene.label,
                    scene.narrative_role,
                    scene.core_idea,
                    scene.emotional_state,
                    serde_json::to_string(&scene.visual_opportunities).unwrap(),
                    serde_json::to_string(&scene.sentence_ids).unwrap(),
                    original as i64,
                    scene.expanded as i64
                ],
            ).map_err(|e| e.to_string())?;
        }
        self.connection.execute("INSERT INTO visual_plan_meta(video_id,timing_source,generated_at,updated_at) VALUES(?1,?2,?3,?3) ON CONFLICT(video_id) DO UPDATE SET timing_source=excluded.timing_source,updated_at=excluded.updated_at", params![video_id,timing_source,now]).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn load_groups(&self, video_id: &str, original: bool) -> Result<Vec<PlanGroup>, String> {
        let mut statement = self.connection.prepare("SELECT id, ordinal, label, kind, sentence_ids_json, COALESCE(settings_locked,0), COALESCE(prompt_locked,0), scene_id FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, original as i64], |row| {
                let stored_id: String = row.get(0)?;
                Ok(PlanGroup {
                    id: stored_id
                        .rsplit_once("::")
                        .map(|(_, id)| id.to_string())
                        .or_else(|| {
                            stored_id
                                .split_once('-')
                                .map(|(_, id)| id.to_string())
                        })
                        .unwrap_or(stored_id),
                    ordinal: row.get(1)?,
                    label: row.get(2)?,
                    kind: row.get(3)?,
                    sentence_ids: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    settings_locked: row.get::<_, i64>(5)? != 0,
                    prompt_locked: row.get::<_, i64>(6)? != 0,
                    scene_id: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    fn load_scenes(&self, video_id: &str, original: bool) -> Result<Vec<PlanScene>, String> {
        let mut statement = self.connection.prepare("SELECT id, ordinal, label, narrative_role, core_idea, emotional_state, visual_opportunities_json, sentence_ids_json, COALESCE(expanded,1) FROM visual_plan_scenes WHERE video_id = ?1 AND is_original = ?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, original as i64], |row| {
                let stored_id: String = row.get(0)?;
                Ok(PlanScene {
                    id: stored_id
                        .rsplit_once("::")
                        .map(|(_, id)| id.to_string())
                        .unwrap_or(stored_id),
                    ordinal: row.get(1)?,
                    label: row.get(2)?,
                    narrative_role: row.get(3)?,
                    core_idea: row.get(4)?,
                    emotional_state: row.get(5)?,
                    visual_opportunities: serde_json::from_str(&row.get::<_, String>(6)?)
                        .unwrap_or_default(),
                    sentence_ids: serde_json::from_str(&row.get::<_, String>(7)?)
                        .unwrap_or_default(),
                    expanded: row.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    #[cfg(test)]
    fn snapshot_count(&self, video_id: &str) -> i64 {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM video_snapshots WHERE video_id = ?1",
                [video_id],
                |row| row.get(0),
            )
            .unwrap()
    }
}

fn map_video(row: &rusqlite::Row<'_>) -> rusqlite::Result<Video> {
    Ok(Video {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        title: row.get(2)?,
        stage: row.get(3)?,
        progress: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn map_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<InputAsset> {
    Ok(InputAsset {
        id: row.get(0)?,
        video_id: row.get(1)?,
        kind: row.get(2)?,
        original_name: row.get(3)?,
        relative_path: row.get(4)?,
        media_type: row.get(5)?,
        size_bytes: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn extension_to_media_type(extension: &str) -> &'static str {
    match extension {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// Infers a media-library `kind` ('still'|'clip'|'audio') from a file
/// extension — used by the top-level "+ Import" entry point, which has no
/// pre-selected kind and routes the imported file into the matching tab.
fn media_library_kind_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" | "jpg" | "jpeg" | "webp" => Some("still"),
        "mp4" | "mov" | "webm" | "mkv" => Some("clip"),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" => Some("audio"),
        _ => None,
    }
}

fn strip_avoid_block(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if let Some(idx) = trimmed.rfind("[Avoid:") {
        let after = &trimmed[idx..];
        if after.contains(']') {
            return trimmed[..idx].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn assemble_image_prompt(
    system_prompt: &str,
    user_prompt: &str,
    settings: &serde_json::Value,
) -> String {
    let settings = public_image_settings(settings);
    format!(
        "STYLE DIRECTIVE:\n{}\n\nIMAGE SETTINGS:\n{}\n\nUSER PROMPT:\n{}",
        system_prompt.trim(),
        serde_json::to_string_pretty(&settings).unwrap_or_else(|_| "{}".into()),
        user_prompt.trim(),
    )
}

fn public_image_settings(settings: &serde_json::Value) -> serde_json::Value {
    let mut cleaned = settings.clone();
    if let Some(object) = cleaned.as_object_mut() {
        object.retain(|key, _| !key.starts_with('_') && key != "aspectRatio");
    }
    cleaned
}

fn requested_aspect_ratio(settings: &serde_json::Value) -> &'static str {
    match settings.get("aspectRatio").and_then(|value| value.as_str()) {
        Some("9:16") => "9:16",
        _ => "16:9",
    }
}

/// Veo 3 only generates clips at these fixed lengths — never an arbitrary duration.
const VEO_ALLOWED_DURATIONS: [i64; 3] = [4, 6, 8];

/// Picks the largest Veo-supported duration that still fits inside the target gap,
/// so "Adjust animation to duration" only ever needs to slow the clip down (stretch),
/// never speed it up. Falls back to the shortest duration if the gap is under 4s —
/// the caller is expected to trim the excess immediately after generation.
fn pick_veo_duration(gap_seconds: f64) -> i64 {
    VEO_ALLOWED_DURATIONS
        .into_iter()
        .filter(|duration| (*duration as f64) <= gap_seconds)
        .max()
        .unwrap_or(4)
}

fn request_openai_text(api_key: &str, prompt: &str) -> Result<String, String> {
    let response = reqwest::blocking::Client::new()
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&json!({
            "model": "gpt-4.1-mini",
            "input": prompt,
            "max_output_tokens": 1200
        }))
        .send()
        .map_err(|error| format!("Could not reach OpenAI: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json()
        .map_err(|error| format!("OpenAI returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let message = body.pointer("/error/message").and_then(|value| value.as_str())
            .unwrap_or("Prompt suggestion failed.");
        return Err(format!("OpenAI error ({status}): {message}"));
    }
    body.pointer("/output/0/content/0/text").and_then(|value| value.as_str())
        .map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
        .ok_or_else(|| "OpenAI returned no prompt text.".to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2PlanStillResponse {
    visual_plan_row_id: String,
    #[serde(alias = "visual_type", alias = "type")]
    visual_type: String,
    #[serde(alias = "image_settings", alias = "settings")]
    image_settings: serde_json::Value,
    #[serde(alias = "user_prompt", alias = "prompt", alias = "scene_prompt", alias = "image_prompt", default)]
    user_prompt: String,
    #[serde(default)]
    reason: String,
    /// A short (2-6 word) name for the concrete symbol/object/device this
    /// still's image leans on to carry its idea (e.g. "dice and coin",
    /// "gears", "split panel: podium vs. porch") — not shown to the user,
    /// only fed back into future batches' `priorContext` so the model can
    /// see it's already used a given literal symbol and reach for a
    /// different one next time an abstract idea recurs. See the
    /// "RECURRING SYMBOL TRACKING" prompt section.
    #[serde(alias = "core_visual_device", default)]
    core_visual_device: String,
}

#[derive(Debug, Deserialize)]
struct V2PlanChunkResponse {
    plans: Vec<V2PlanStillResponse>,
}

/// Where a single `plan_bulk_visuals_batch` AI call's chunk ends, starting
/// from `start_index`: walk forward while still inside the same scene as
/// `groups[start_index]` (a `None` scene_id — legacy plan — is its own
/// "no scene" run), capped at `chunk_size` either way. Guarantees a chunk
/// never straddles a scene boundary; an oversized scene just takes multiple
/// sequential calls, each still scoped to that one scene. Extracted as a
/// pure function (rather than left inline) so the boundary logic itself is
/// unit-testable without the AI credentials `plan_bulk_visuals_batch` as a
/// whole requires.
fn bulk_batch_chunk_end(groups: &[PlanGroup], start_index: usize, chunk_size: usize) -> usize {
    let total = groups.len();
    let current_scene_id = &groups[start_index].scene_id;
    let mut end = start_index + 1;
    while end < total && end < start_index + chunk_size && &groups[end].scene_id == current_scene_id {
        end += 1;
    }
    end
}

/// The Bulk Generation settings resolved for one AI planning call, after
/// layering a scene's `bulk_scene_settings` override (if any) on top of the
/// video's global params. An override field only wins if it's `Some` and
/// (for the two string fields) non-blank — an empty-string override is
/// treated the same as "not overridden," matching how the frontend clears a
/// field back to "inherit" by leaving it blank rather than needing a
/// separate clear action. `style_directive`/`creative_instruction`/
/// `character_consistency`/`reference_asset_id` are unchanged from before —
/// still resolved against the raw scalar globals the caller already had on
/// hand (backed by `app_settings`, not `bulk_global_settings`). Location
/// Consistency and the dials are newer and DO have a proper structured
/// global source (`BulkGlobalVisualSettings`), passed in as `global_visual`.
struct EffectiveBulkSettings {
    style_directive: String,
    creative_instruction: String,
    character_consistency: bool,
    reference_asset_id: Option<String>,
    location_consistency: bool,
    /// Unlike `reference_asset_id` above, this DOES fall back to a global
    /// value inside this function (`global_visual.location_reference_asset_id`)
    /// rather than relying on `reference_image_bytes`'s own built-in
    /// fallback — that fallback is hard-coded to the CHARACTER's global
    /// reference (`global_reference_asset.{video_id}`), which would be
    /// wrong for location. Callers must therefore never pass `None` here
    /// into `reference_image_bytes` expecting a location-appropriate
    /// fallback; `None` here means "genuinely no location reference set at
    /// either level."
    location_reference_asset_id: Option<String>,
    dials: BulkVisualDials,
}

fn resolve_effective_bulk_settings(
    scene_settings: Option<&BulkSceneSettings>,
    style_directive: &str,
    creative_instruction: &str,
    character_consistency: bool,
    global_visual: &BulkGlobalVisualSettings,
) -> EffectiveBulkSettings {
    EffectiveBulkSettings {
        style_directive: scene_settings
            .and_then(|s| s.style_directive.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| style_directive.to_string()),
        creative_instruction: scene_settings
            .and_then(|s| s.creative_instruction.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| creative_instruction.to_string()),
        character_consistency: scene_settings
            .and_then(|s| s.character_consistency)
            .unwrap_or(character_consistency),
        reference_asset_id: scene_settings.and_then(|s| s.reference_asset_id.clone()),
        location_consistency: scene_settings
            .and_then(|s| s.location_consistency)
            .unwrap_or_else(|| global_visual.location_consistency.unwrap_or(false)),
        location_reference_asset_id: scene_settings
            .and_then(|s| s.location_reference_asset_id.clone())
            .or_else(|| global_visual.location_reference_asset_id.clone()),
        dials: resolve_effective_dials(scene_settings.map(|s| &s.dials), &global_visual.dials),
    }
}

/// Field-by-field layering for `BulkVisualDials`, same "scene wins if set,
/// else fall back to global" rule as every other Bulk Generation setting.
fn resolve_effective_dials(scene: Option<&BulkVisualDials>, global: &BulkVisualDials) -> BulkVisualDials {
    BulkVisualDials {
        visual_interpretation: scene.and_then(|d| d.visual_interpretation).or(global.visual_interpretation),
        visual_metaphor: scene.and_then(|d| d.visual_metaphor).or(global.visual_metaphor),
        cinematic_intensity: scene.and_then(|d| d.cinematic_intensity).or(global.cinematic_intensity),
        prompt_creativity: scene.and_then(|d| d.prompt_creativity).or(global.prompt_creativity),
        mood: scene.and_then(|d| d.mood.clone()).or_else(|| global.mood.clone()),
        mood_mode: scene.and_then(|d| d.mood_mode.clone()).or_else(|| global.mood_mode.clone()),
        diversity_camera: scene.and_then(|d| d.diversity_camera).or(global.diversity_camera),
        diversity_composition: scene.and_then(|d| d.diversity_composition).or(global.diversity_composition),
        diversity_shot_type: scene.and_then(|d| d.diversity_shot_type).or(global.diversity_shot_type),
        consistency_character: scene.and_then(|d| d.consistency_character).or(global.consistency_character),
        consistency_location: scene.and_then(|d| d.consistency_location).or(global.consistency_location),
        consistency_style: scene.and_then(|d| d.consistency_style).or(global.consistency_style),
    }
}

/// Compact whole-video tally of what's already been decided for every
/// already-planned still — the "whole script" half of the diversity/
/// repetition rules already baked into the planning prompt (see SETTINGS
/// DIVERSITY in `plan_bulk_visuals_batch`), which previously only had
/// visibility into the last ~12 stills via `bulk_plan_prior_context`. A
/// "no single value in more than 30% of stills" rule is unenforceable
/// without knowing the true whole-video percentages; this is what supplies
/// them. Deliberately a compact set of counts, not a full per-still dump —
/// stays small regardless of how long the video is.
#[derive(Debug, Clone, Default, PartialEq)]
struct VideoVisualHistory {
    total_planned: usize,
    visual_type_counts: std::collections::BTreeMap<String, usize>,
    camera_angle_counts: std::collections::BTreeMap<String, usize>,
    lighting_counts: std::collections::BTreeMap<String, usize>,
    color_temperature_counts: std::collections::BTreeMap<String, usize>,
    weather_atmosphere_counts: std::collections::BTreeMap<String, usize>,
    mood_counts: std::collections::BTreeMap<String, usize>,
}

impl VideoVisualHistory {
    fn is_empty(&self) -> bool {
        self.total_planned == 0
    }

    /// Renders the tally as a compact text block for the planning prompt —
    /// percentages (matching how the SETTINGS DIVERSITY rule is phrased),
    /// sorted most-common-first. Only dimensions with at least one tallied
    /// value produce a line; an empty history renders as an empty string,
    /// so the caller can skip the whole section on a video's first batch.
    fn summary_text(&self) -> String {
        fn line(label: &str, counts: &std::collections::BTreeMap<String, usize>, total: usize) -> Option<String> {
            if counts.is_empty() || total == 0 {
                return None;
            }
            let mut entries: Vec<(&String, &usize)> = counts.iter().collect();
            entries.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let rendered = entries.iter()
                .map(|(value, count)| format!("{value} {}%", (**count * 100) / total))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("- {label}: {rendered}"))
        }
        [
            line("visualType", &self.visual_type_counts, self.total_planned),
            line("lighting", &self.lighting_counts, self.total_planned),
            line("colorTemperature", &self.color_temperature_counts, self.total_planned),
            line("weatherAtmosphere", &self.weather_atmosphere_counts, self.total_planned),
            line("cameraAngle", &self.camera_angle_counts, self.total_planned),
            line("mood", &self.mood_counts, self.total_planned),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n")
    }
}

/// Pure aggregation behind `ProjectRepository::video_visual_history` —
/// `entries` is (visualType, settingsJson) for every still that already has
/// a saved prompt, in any order. Extracted as a free function (rather than
/// left inline) so the tallying logic is unit-testable without a database.
fn aggregate_video_visual_history(entries: &[(String, String)]) -> VideoVisualHistory {
    let mut history = VideoVisualHistory::default();
    for (visual_type, settings_json) in entries {
        history.total_planned += 1;
        if !visual_type.is_empty() {
            *history.visual_type_counts.entry(visual_type.clone()).or_insert(0) += 1;
        }
        let settings: serde_json::Value = serde_json::from_str(settings_json).unwrap_or_else(|_| json!({}));
        let fields: [(&str, &mut std::collections::BTreeMap<String, usize>); 5] = [
            ("cameraAngle", &mut history.camera_angle_counts),
            ("lighting", &mut history.lighting_counts),
            ("colorTemperature", &mut history.color_temperature_counts),
            ("weatherAtmosphere", &mut history.weather_atmosphere_counts),
            ("mood", &mut history.mood_counts),
        ];
        for (key, map) in fields {
            if let Some(value) = settings.get(key).and_then(|v| v.as_str()) {
                if !value.is_empty() && value != "Undefined" {
                    *map.entry(value.to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    history
}

/// Formats the STORY CONTEXT block injected into `plan_bulk_visuals_batch`'s
/// prompt: the whole-script understanding (from `script_understanding_for_video`)
/// plus this batch's scene's own already-computed narrative summary — title,
/// narrative role, core idea, emotional tone, visual opportunities (from
/// `scene_grouping_engine.py`'s Pass 3, saved to `visual_plan_scenes` but
/// never read by planning before this). Either half can be legitimately
/// empty — no whole-script understanding yet (first batch of a video, or
/// the AI call failed), or a scene with no AI analysis at all (e.g. one
/// created by a manual scene-boundary drag, which ships with empty
/// context) — without breaking the other. Returns an empty string only
/// when BOTH are empty, so the caller can skip the section header entirely
/// rather than show an empty block.
fn format_story_context_block(script_understanding: &str, scene: Option<&PlanScene>) -> String {
    let mut sections = Vec::new();
    if !script_understanding.trim().is_empty() {
        sections.push(format!("WHOLE VIDEO: {}", script_understanding.trim()));
    }
    if let Some(scene) = scene {
        let mut scene_lines = Vec::new();
        if let Some(role) = scene.narrative_role.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            scene_lines.push(format!("Narrative role: {role}"));
        }
        if let Some(idea) = scene.core_idea.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            scene_lines.push(format!("Core idea: {idea}"));
        }
        if let Some(mood) = scene.emotional_state.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            scene_lines.push(format!("Emotional tone: {mood}"));
        }
        if !scene.visual_opportunities.is_empty() {
            scene_lines.push(format!("Visual opportunities to consider: {}", scene.visual_opportunities.join(", ")));
        }
        if !scene_lines.is_empty() {
            sections.push(format!("THIS SCENE — \"{}\":\n{}", scene.label, scene_lines.join("\n")));
        }
    }
    if sections.is_empty() {
        return String::new();
    }
    format!(
        "\n\n════════════════════════════════════════\n\
         STORY CONTEXT — read this before deciding what each still shows\n\
         ════════════════════════════════════════\n\
         {}\n\
         ════════════════════════════════════════\n",
        sections.join("\n\n"),
    )
}

/// `seed_run_type`/`seed_run_len` let the caller carry a same-type run
/// already in progress at the END of whatever came immediately before
/// `planned` (e.g. the tail of `bulk_plan_prior_context`, when `planned` is
/// only one batch of a larger resumable run — see
/// `plan_bulk_visuals_batch`) into this check, so a run that started in an
/// earlier, already-persisted batch and continues into this one still gets
/// caught. Pass `("", 0)` when there's no such context (a single, complete
/// list planned in one call).
fn repair_excessive_consecutive_visual_types(
    planned: &mut [V2PlanStillResponse],
    row_data: &[serde_json::Value],
    seed_run_type: &str,
    seed_run_len: usize,
) {
    let alternatives = [
        "Behavioral Demonstration",
        "Close Detail",
        "Environmental Scene",
        "Object Focus",
        "Comparison",
        "Before/After or Transformation",
        "Title / Statement Card",
        "Process Illustration",
        "Textless Infographic",
        "Concept Visualization",
        "Documentary Frame",
    ];
    let mut run_type = seed_run_type.to_string();
    let mut run_len = seed_run_len;

    for index in 0..planned.len() {
        if planned[index].visual_type == run_type {
            run_len += 1;
        } else {
            run_type = planned[index].visual_type.clone();
            run_len = 1;
        }
        if run_len <= 3 {
            continue;
        }

        let is_locked = row_data.get(index).is_some_and(|row| {
            row["settingsLocked"].as_bool().unwrap_or(false) || row["promptLocked"].as_bool().unwrap_or(false)
        });
        if is_locked {
            continue;
        }

        let previous = index.checked_sub(1).and_then(|prior| planned.get(prior)).map(|plan| plan.visual_type.as_str());
        let next = planned.get(index + 1).map(|plan| plan.visual_type.as_str());
        if let Some(replacement) = alternatives.iter().copied().find(|candidate| {
            *candidate != run_type && Some(*candidate) != previous && Some(*candidate) != next
        }) {
            planned[index].visual_type = replacement.to_string();
            planned[index].reason = if planned[index].reason.trim().is_empty() {
                "Adjusted visual type to prevent repetitive consecutive stills.".into()
            } else {
                format!("{} Adjusted visual type to prevent repetitive consecutive stills.", planned[index].reason.trim())
            };
            run_type = planned[index].visual_type.clone();
            run_len = 1;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EducationalPlanResponse {
    #[serde(default)]
    visual_plan_row_id: String,
    educational_objective: String,
    visual_intent: String,
    subject_strategy: String,
    image_settings: serde_json::Value,
    user_prompt: String,
}

#[derive(Deserialize)]
struct WholeVideoPlanResponse {
    plans: Vec<EducationalPlanResponse>,
}

fn request_openai_educational_plan(api_key: &str, prompt: &str) -> Result<EducationalPlanResponse, String> {
    let text = request_openai_text(api_key, prompt)?;
    let cleaned = extract_json_from_text(&text);
    serde_json::from_str(cleaned).map_err(|_| "OpenAI educational plan was not valid JSON.".to_string())
}

fn request_openai_whole_video_plan(api_key: &str, prompt: &str) -> Result<WholeVideoPlanResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build().map_err(|error| format!("Could not initialize OpenAI client: {error}"))?;
    let mut last_transport_error = String::new();
    let response = loop {
        let attempt = last_transport_error.matches("attempt").count();
        match client.post("https://api.openai.com/v1/responses")
            .bearer_auth(api_key)
            .json(&json!({"model":"gpt-4.1-mini","input":prompt,"max_output_tokens":16000}))
            .send() {
                Ok(response) => break response,
                Err(error) if attempt < 3 => {
                    last_transport_error.push_str(&format!(" attempt {attempt}: {error}"));
                    std::thread::sleep(std::time::Duration::from_secs(3 * 2_u64.pow(attempt as u32)));
                }
                Err(error) => return Err(format!("Could not reach OpenAI after retries: {error}")),
            }
    };
    let status = response.status();
    let body: serde_json::Value = response.json()
        .map_err(|error| format!("OpenAI returned an unreadable response: {error}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI whole-video planning failed ({status}): {}", body.pointer("/error/message").and_then(|value| value.as_str()).unwrap_or("unknown error")));
    }
    let text = body.pointer("/output/0/content/0/text").and_then(|value| value.as_str())
        .ok_or("OpenAI returned no whole-video plan.")?;
    let cleaned = extract_json_from_text(text);
    serde_json::from_str(cleaned).map_err(|_| "OpenAI whole-video plan was not valid JSON.".to_string())
}

fn validate_educational_plan(plan: &EducationalPlanResponse) -> Result<(), String> {
    const OBJECTIVES: &[&str] = &["Introduce Subject","Show Relationship","Explain Process","Explain Sequence","Explain Location","Explain Structure","Highlight Detail","Show Environment","Explain Concept","Show Evidence","Compare Alternatives","Explain Cause Effect","Demonstrate Behavior","Clarify Misconception"];
    const INTENTS: &[&str] = &["Character Scene","Behavioral Demonstration","Close Detail","Environmental Scene","Object Focus","Comparison","Process Illustration","Timeline","Textless Infographic","Scientific Diagram","Geographic Map","Concept Visualization","POV Scene","Symbolic Representation","Documentary Frame"];
    const STRATEGIES: &[&str] = &["Single Subject","Subject Plus Object","Object Only","Environment Only","Split Comparison","Diagram Subject","Map Subject","Abstract Subject"];
    if !OBJECTIVES.contains(&plan.educational_objective.as_str()) { return Err("OpenAI returned an unsupported educational objective.".into()); }
    if !INTENTS.contains(&plan.visual_intent.as_str()) { return Err("OpenAI returned an unsupported visual intent.".into()); }
    if !STRATEGIES.contains(&plan.subject_strategy.as_str()) { return Err("OpenAI returned an unsupported subject strategy.".into()); }
    if !plan.image_settings.is_object() || plan.user_prompt.trim().is_empty() { return Err("OpenAI returned an incomplete educational visual plan.".into()); }
    Ok(())
}

fn request_openai_style(api_key: &str, mime: &str, bytes: &[u8]) -> Result<StyleExtraction, String> {
    let image_url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    let response = reqwest::blocking::Client::new()
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&json!({
            "model": "gpt-4.1-mini",
            "input": [{"role":"user","content":[
                {"type":"input_text","text":"Analyze this image as a reusable production style reference. Return only JSON with styleDirective (string describing art style, rendering, color language, recurring subjects, and visual consistency rules) and imageSettings (object with any of: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, lensType, lightDirection, lightQuality, shadowType, contrast, saturation, composition, motion — use only values strongly supported by the image)."},
                {"type":"input_image","image_url":image_url}
            ]}],
            "max_output_tokens": 900
        }))
        .send().map_err(|error| format!("Could not reach OpenAI: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json()
        .map_err(|error| format!("OpenAI returned an unreadable response: {error}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI style extraction failed ({status}): {}", body.pointer("/error/message").and_then(|value| value.as_str()).unwrap_or("unknown error")));
    }
    let text = body.pointer("/output/0/content/0/text").and_then(|value| value.as_str())
        .ok_or("OpenAI returned no style analysis.")?;
    let cleaned = extract_json_from_text(text);
    serde_json::from_str(cleaned).map_err(|_| "OpenAI style analysis was not valid JSON.".to_string())
}

fn gemini_generatecontent_url(auth: &GeminiAuth, model: &str) -> String {
    match auth {
        GeminiAuth::ApiKey(_) => format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
        GeminiAuth::Vertex { project_id, .. } => format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent"),
    }
}

// Returns the model to use for text/vision tasks (structured JSON output, style
// analysis, etc — never actual image generation, see generate_image_render for that).
// The Vertex case used to point at the image-generation model (gemini-3.1-flash-image)
// on the assumption the project might not have a real text model enabled — confirmed
// by directly probing this app's actual configured Vertex project that "gemini-2.0-flash"
// 404s there, but "gemini-2.5-flash" works. The image model was also the wrong choice
// anyway: it tends to narrate/describe rather than reliably return structured JSON for
// anything non-trivial (see request_gemini_v2_plan's prompt-hardening comment for a
// case this caused).
fn gemini_text_model(auth: &GeminiAuth) -> &'static str {
    match auth {
        GeminiAuth::ApiKey(_) => "gemini-2.0-flash",
        GeminiAuth::Vertex { .. } => "gemini-2.5-flash",
    }
}

fn gemini_client_request(client: &reqwest::blocking::Client, auth: &GeminiAuth, model: &str) -> reqwest::blocking::RequestBuilder {
    let url = gemini_generatecontent_url(auth, model);
    match auth {
        GeminiAuth::ApiKey(key) => client.post(url).header("x-goog-api-key", key),
        GeminiAuth::Vertex { access_token, .. } => client.post(url).bearer_auth(access_token),
    }
}

fn gemini_extract_text(body: &serde_json::Value) -> Option<String> {
    let parts = body.pointer("/candidates/0/content/parts")?.as_array()?;
    let text: String = parts.iter()
        .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
        .collect();
    if text.trim().is_empty() { None } else { Some(text) }
}

// Extracts the first complete JSON object or array from a response that may
// contain markdown fences or leading/trailing prose.
fn extract_json_from_text(raw: &str) -> &str {
    let s = raw.trim();
    // Strip markdown fences
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    let s = s.trim();
    // Find the first complete JSON object or array, ignoring any prose or
    // repeated JSON-looking blocks after it.
    let obj_start = s.find('{');
    let arr_start = s.find('[');
    let start = match (obj_start, arr_start) {
        (Some(o), Some(a)) => Some(o.min(a)),
        (Some(o), None) => Some(o),
        (None, Some(a)) => Some(a),
        (None, None) => return s,
    };
    let start = start.unwrap();
    let opening = s.as_bytes()[start];
    let closing = if opening == b'{' { b'}' } else { b']' };
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, byte) in s[start..].bytes().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        if byte == b'"' {
            in_string = true;
        } else if byte == opening {
            depth += 1;
        } else if byte == closing {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return &s[start..=start + offset];
            }
        }
    }

    s
}

fn request_gemini_text(auth: &GeminiAuth, prompt: &str) -> Result<String, String> {
    // See request_gemini_image's comment: Client::new() has no default timeout, which
    // would let an unresponsive server hang this call (and the whole worker) forever.
    let client = match reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(60)).build() {
        Ok(client) => client,
        Err(e) => return Err(format!("Could not initialize Gemini client: {e}")),
    };
    for attempt in 0u32..3 {
        let response = gemini_client_request(&client, auth, gemini_text_model(auth))
            .json(&json!({
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 4000, "responseMimeType": "application/json"}
            }))
            .send().map_err(|e| format!("Could not reach Gemini: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_secs(20 * 2_u64.pow(attempt)));
                continue;
            }
            return Err("Gemini rate limit hit. Wait a minute and try again.".to_string());
        }
        let body: serde_json::Value = response.json().map_err(|e| format!("Gemini returned an unreadable response: {e}"))?;
        if !status.is_success() {
            return Err(format!("Gemini error ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("request failed")));
        }
        return gemini_extract_text(&body).ok_or_else(|| "Gemini returned no text.".to_string());
    }
    Err("Gemini rate limit persists after retries.".to_string())
}

fn request_gemini_vision(auth: &GeminiAuth, prompt: &str, mime: &str, bytes: &[u8]) -> Result<String, String> {
    // See request_gemini_image's comment: Client::new() has no default timeout, which
    // would let an unresponsive server hang this call (and the whole worker) forever.
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Could not initialize Gemini client: {e}"))?;
    let image_data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let response = gemini_client_request(&client, auth, gemini_text_model(auth))
        .json(&json!({
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": mime, "data": image_data}},
                {"text": prompt}
            ]}],
            "generationConfig": {"maxOutputTokens": 2000, "responseMimeType": "application/json"}
        }))
        .send().map_err(|e| format!("Could not reach Gemini: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().map_err(|e| format!("Gemini returned an unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Gemini vision error ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("request failed")));
    }
    gemini_extract_text(&body).ok_or_else(|| "Gemini returned no vision analysis.".to_string())
}

// Gemini sometimes returns `"plans": {...}` (single object) instead of `"plans": [{...}]`,
// or returns the array directly without a wrapper, or returns a bare single-plan object.
// This normalises all of those into a V2PlanChunkResponse before deserialising.
fn normalize_bulk_plan_response(cleaned: &str) -> Result<V2PlanChunkResponse, String> {
    let mut value: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|e| format!("Gemini bulk plan was not valid JSON: {e}"))?;

    // Case: top-level array → wrap into {"plans": [...]}
    if value.is_array() {
        value = json!({"plans": value});
    }

    // Case: top-level object missing "plans" → treat the whole object as a single plan
    if value.is_object() && value.get("plans").is_none() {
        let single = value.clone();
        value = json!({"plans": [single]});
    }

    // Case: "plans" is a single object (not array) → wrap in array
    if let Some(plans) = value.get_mut("plans") {
        if plans.is_object() {
            let obj = plans.clone();
            *plans = serde_json::Value::Array(vec![obj]);
        }
    }

    serde_json::from_value(value)
        .map_err(|e| format!("Gemini bulk plan was not valid JSON: {e}"))
}

/// Shared low-level Claude CLI invocation for every Bulk Gen planning call in
/// this file (plan batches, style-directive extraction, character
/// description, retroactive creative-instruction application) — none of
/// these hold a billed API client the way the OpenAI/Gemini paths did before
/// OpenAI was removed from Bulk Gen entirely. Instead this shells out to a
/// locally installed, already-authenticated `claude` binary (Claude Code)
/// and rides whatever Claude subscription is already logged into it on this
/// machine — no ANTHROPIC_API_KEY, no separate bill. Same idea as the Python
/// engine's `parse_structured_vision_claude_cli` (see that function's doc
/// comment in ai_client.py), reimplemented directly in Rust since none of
/// these calls need a Python round trip — the one call that needs vision
/// (`request_claude_cli_character_description`) attaches its image via a
/// scratch temp file + the CLI's own `Read` tool, the same trick the Python
/// helper uses. `--no-session-persistence` keeps every call stateless — no
/// leftover conversation history should leak from one planning batch into
/// the next. `extra_args` carries whatever a specific caller needs on top of
/// the shared flags (e.g. `--effort high` for planning, or
/// `--tools Read --allowedTools Read --add-dir <dir>` for vision).
fn run_claude_cli(prompt: &str, extra_args: &[&str]) -> Result<String, String> {
    #[cfg(test)]
    {
        let _ = (prompt, extra_args);
        Err("Claude CLI is not available in tests.".to_string())
    }
    #[cfg(not(test))]
    {
        let mut command = Command::new("claude");
        command
            .arg("-p").arg(prompt)
            .arg("--output-format").arg("json")
            .arg("--no-session-persistence")
            .arg("--model").arg("sonnet")
            .args(extra_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = command.output().map_err(|e| format!("Could not start the Claude CLI: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Claude CLI exited with an error: {}", stderr.trim()));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let payload: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|_| {
            format!("Claude CLI returned non-JSON output: {}", stdout.chars().take(500).collect::<String>())
        })?;
        if payload.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(format!(
                "Claude CLI reported an error: {}",
                payload.get("result").and_then(|v| v.as_str()).unwrap_or("unknown error")
            ));
        }
        payload.get("result").and_then(|v| v.as_str())
            .map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Claude CLI returned no text.".to_string())
    }
}

/// Claude CLI plan request for `plan_bulk_visuals`. Worth spending `--effort
/// high` on specifically — visual planning is a real creative/compositional
/// judgment call across dozens of stills, not a quick lookup, and it draws
/// no metered cost here the way it would through a billed API. Reuses
/// `normalize_bulk_plan_response`/`extract_json_from_text` on the raw result
/// text rather than requesting a JSON-schema-constrained reply — matches how
/// Gemini is parsed here too, and avoids needing a JSON-schema generator for
/// `V2PlanChunkResponse` on the Rust side.
fn request_claude_cli_v2_plan(prompt: &str) -> Result<V2PlanChunkResponse, String> {
    let text = run_claude_cli(prompt, &["--effort", "high"])?;
    normalize_bulk_plan_response(extract_json_from_text(&text))
        .map_err(|e| e.replace("Gemini", "Claude CLI"))
}

/// Claude CLI request for `extract_image_settings_from_directive`, routed
/// through `run_claude_cli` — no metered cost, rides an existing Claude
/// subscription instead of a billed API.
fn request_claude_cli_directive_extract(directive: &str) -> Result<StyleExtraction, String> {
    let prompt = format!(
        r#"You are a visual production assistant. Your job is to clean up a Style Directive so it contains ONLY global visual style rules — nothing about specific subjects, characters, objects, or scene content.

Style Directive to clean:
{directive}

WHAT TO KEEP in the cleaned styleDirective (global aesthetics that apply to every still):
- Art style name / brand (e.g. "Pixar 3D animation", "photorealistic", "watercolor illustration")
- Color palette description (e.g. "warm oranges and browns", "desaturated cool tones")
- Color grading (e.g. "teal and orange", "vintage film grain", "high saturation")
- Rendering quality / medium (e.g. "polished 3D render", "oil painting texture", "cel-shaded")
- Detail level and texture rules (e.g. "highly detailed", "smooth surfaces", "grainy film look")
- Global mood / atmosphere (e.g. "cozy and heartwarming", "dark and moody") — only if NOT tied to a specific scene subject
- Genre or era style (e.g. "cyberpunk", "fantasy", "retro 1980s")
- Lighting style as a global rule (e.g. "cinematic lighting overall", "soft diffused look") — only very general rules, not per-shot specifics
- Visual consistency rules, brand rules, exclusion rules (e.g. "no text", "always soft shadows")

WHAT TO REMOVE from the styleDirective (these go in the User Prompt per still, NOT here):
- Any specific characters: named people, animals, creatures (e.g. "a young woman", "a cute cat", "a wizard")
- Any physical descriptions of subjects (e.g. "large eyes", "soft smile", "fluffy fur")
- Any scene-specific content (e.g. "sitting on a chair", "in a forest")
- Anything that answers "WHO is in the image" or "WHAT specific object/creature"

Per-still structured fields to extract from imageSettings:
Available fields: cameraAngle, lighting, mood, depthOfField, colorTemperature, weatherAtmosphere, lensType, lightDirection, lightQuality, shadowType, contrast, focusType, exposure, motion, composition, saturation, vignette, grainIntensity, colorCastTint, surfaceEffects.
Only populate imageSettings if the directive specifies a concrete per-shot value (e.g. "shallow depth of field" → depthOfField). Leave imageSettings as {{}} if nothing concrete is specified.

Return JSON only — no markdown, no explanation:
{{"styleDirective":"<global style rules only — no subjects, no scene content>","imageSettings":{{"<field>":"<value>"}}}}"#
    );
    let text = run_claude_cli(&prompt, &[])?;
    let cleaned = extract_json_from_text(&text);
    serde_json::from_str(cleaned).map_err(|_| "Style extraction was not valid JSON.".to_string())
}

/// Deletes its directory (and everything written into it) when dropped —
/// cleans up the scratch temp folder `request_claude_cli_character_description`
/// writes the reference image into for the CLI's `Read` tool to load, on
/// every exit path (success, error, or an early `?` return) without
/// duplicating a cleanup call at each one.
struct ScratchDirGuard(PathBuf);

impl Drop for ScratchDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Claude CLI request for `character_description_for_video`'s vision call.
/// The CLI has no way to attach an inline image the way the OpenAI/Gemini
/// SDKs do, so the reference image is written out to a scratch temp file
/// first and referenced by path in the prompt text — the only tool granted
/// to the session (`Read`) is what actually loads it off disk on Claude's
/// side. Mirrors the Python engine's `parse_structured_vision_claude_cli`
/// (used by motion graphics) for the same reason, just without needing a
/// Python round trip for this one call.
fn request_claude_cli_character_description(prompt: &str, mime: &str, bytes: &[u8]) -> Result<String, String> {
    let extension = mime.split('/').next_back().unwrap_or("png");
    let scratch_dir = std::env::temp_dir().join(format!("ags-claude-vision-{}", Uuid::new_v4()));
    fs::create_dir_all(&scratch_dir).map_err(|e| e.to_string())?;
    let _guard = ScratchDirGuard(scratch_dir.clone());
    let image_path = scratch_dir.join(format!("reference.{extension}"));
    fs::write(&image_path, bytes).map_err(|e| e.to_string())?;
    let full_prompt = format!("{prompt}\n\n[image: {}]", image_path.display());
    let scratch_dir_arg = scratch_dir.to_string_lossy().into_owned();
    run_claude_cli(&full_prompt, &["--tools", "Read", "--allowedTools", "Read", "--add-dir", scratch_dir_arg.as_str()])
}

fn request_gemini_v2_plan(auth: &GeminiAuth, prompt: &str) -> Result<V2PlanChunkResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| format!("Could not initialize Gemini client: {e}"))?;
    let model = gemini_text_model(auth);
    for attempt in 0u32..4 {
        let response = gemini_client_request(&client, auth, model)
            .json(&json!({
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                // gemini-2.0-flash hard cap is 8192 output tokens; asking for more is silently clamped
                "generationConfig": {"maxOutputTokens": 8000, "responseMimeType": "application/json"}
            }))
            .send()
            .map_err(|e| format!("Could not reach Gemini: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt < 3 {
                let delay = 20 * 2_u64.pow(attempt); // 20s, 40s, 80s
                std::thread::sleep(std::time::Duration::from_secs(delay));
                continue;
            }
            return Err("Gemini rate limit hit. Wait a minute and try again.".to_string());
        }
        let body: serde_json::Value = match response.json() {
            Ok(value) => value,
            Err(_) if attempt < 3 => continue,
            Err(e) => return Err(format!("Gemini returned unreadable response: {e}")),
        };
        if !status.is_success() {
            return Err(format!("Gemini bulk planning failed ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unknown error")));
        }
        let text = gemini_extract_text(&body).ok_or("Gemini returned no bulk plan.")?;
        let cleaned = extract_json_from_text(&text);
        match normalize_bulk_plan_response(cleaned) {
            Ok(r) => return Ok(r),
            Err(e) => {
                // Retry on any parse failure, not just EOF truncation — Gemini
                // occasionally narrates its planning process in prose instead of
                // emitting JSON at all for this large a prompt, which is usually a
                // one-off sampling fluke rather than a hard failure; a fresh attempt
                // often succeeds.
                if attempt < 3 {
                    continue;
                }
                // Include a raw-text preview — "not valid JSON" alone doesn't say whether
                // Gemini refused, got confused, or was cut off, all of which look
                // identical from the parse error text alone.
                return Err(format!("{e} Raw response: {}", text.chars().take(300).collect::<String>()));
            }
        }
    }
    Err("Gemini rate limit persists after retries.".to_string())
}

/// Submits an image-to-video generation request to Veo's long-running-operation
/// endpoint and returns the operation's resource name to poll. Structurally
/// mirrors `request_gemini_image`'s auth/URL branching. Request shape
/// confirmed against Google's published Veo 3.1 REST reference: the source
/// image goes under `instances[0].image.inlineData` (same envelope Gemini
/// image generation uses for uploaded images), not a bare `bytesBase64Encoded`.
/// There is no documented way to request audio-free generation — Veo always
/// returns audio for image-to-video, so it's stripped in post via ffmpeg
/// `-an` instead (see `generate_animation_clip` / `video_export_engine.py`).
///
/// Unlike Gemini text/image models, Veo is NOT available at Vertex AI's
/// "global" location — it must be called against a region-prefixed host
/// (`{location}-aiplatform.googleapis.com`) with a concrete location such as
/// `us-central1` in both the URL path and the hostname.
const VERTEX_VEO_LOCATION: &str = "us-central1";

fn request_veo_generate(
    auth: &GeminiAuth,
    model: &str,
    prompt: &str,
    image_bytes: &[u8],
    image_mime: &str,
    resolution: &str,
    duration_seconds: i64,
) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
    {
        return Err("Veo model name is invalid.".into());
    }
    let client = reqwest::blocking::Client::new();
    let encoded_image = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    // The Gemini Developer API and Vertex AI genuinely diverge here despite
    // both fronting "Veo": the API-key surface wants the image nested under
    // `inlineData` (the same envelope Gemini image generation uses), while
    // Vertex wants `bytesBase64Encoded`/`mimeType` directly on `image` — the
    // same shape Vertex's Imagen API uses. Sending the wrong one to Vertex
    // produces a 400 "image is empty" (the nested inlineData field is simply
    // not recognized, so Vertex sees no image at all).
    let image_field = match auth {
        GeminiAuth::ApiKey(_) => json!({
            "inlineData": { "mimeType": image_mime, "data": encoded_image }
        }),
        GeminiAuth::Vertex { .. } => json!({
            "bytesBase64Encoded": encoded_image, "mimeType": image_mime
        }),
    };
    let parameters = json!({
        "aspectRatio": "16:9",
        "resolution": resolution,
        "durationSeconds": duration_seconds,
    });
    let request = match auth {
        GeminiAuth::ApiKey(api_key) => client
            .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning"))
            .header("x-goog-api-key", api_key),
        GeminiAuth::Vertex { access_token, project_id } => client
            .post(format!("https://{VERTEX_VEO_LOCATION}-aiplatform.googleapis.com/v1/projects/{project_id}/locations/{VERTEX_VEO_LOCATION}/publishers/google/models/{model}:predictLongRunning"))
            .bearer_auth(access_token),
    };
    let response = request
        .json(&json!({
            "instances": [{"prompt": prompt.trim(), "image": image_field}],
            "parameters": parameters,
        }))
        .send()
        .map_err(|error| format!("Could not reach Veo: {error}"))?;
    let status = response.status();
    let raw_text = response.text().map_err(|error| format!("Could not read Veo's response ({status}): {error}"))?;
    let body: serde_json::Value = serde_json::from_str(&raw_text).map_err(|_| {
        let snippet: String = raw_text.chars().take(500).collect();
        format!("Veo returned a non-JSON response ({status}): {snippet}")
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Animation generation failed to start.");
        return Err(format!("Veo error ({status}): {message}"));
    }
    body.get("name")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Veo did not return an operation to track.".to_string())
}

/// Checks a Veo long-running operation once (not a loop — the caller owns
/// the poll interval/timeout). Returns `Ok(None)` while still running, or
/// the decoded video bytes once done.
///
/// The Gemini Developer API exposes operations as plain REST resources
/// (`GET /v1beta/{operation_name}`), but Vertex AI's publisher-model
/// long-running operations are NOT directly gettable that way — they must be
/// polled via `POST {model}:fetchPredictOperation` with `{"operationName": ...}`
/// in the body, against the same region-prefixed host/model used to submit.
fn poll_veo_operation(auth: &GeminiAuth, model: &str, operation_name: &str) -> Result<Option<Vec<u8>>, String> {
    let client = reqwest::blocking::Client::new();
    let response = match auth {
        GeminiAuth::ApiKey(api_key) => client
            .get(format!("https://generativelanguage.googleapis.com/v1beta/{operation_name}"))
            .header("x-goog-api-key", api_key)
            .send(),
        GeminiAuth::Vertex { access_token, project_id } => client
            .post(format!("https://{VERTEX_VEO_LOCATION}-aiplatform.googleapis.com/v1/projects/{project_id}/locations/{VERTEX_VEO_LOCATION}/publishers/google/models/{model}:fetchPredictOperation"))
            .bearer_auth(access_token)
            .json(&json!({"operationName": operation_name}))
            .send(),
    }
    .map_err(|error| format!("Could not reach Veo: {error}"))?;
    let status = response.status();
    let raw_text = response.text().map_err(|error| format!("Could not read Veo's response ({status}): {error}"))?;
    let body: serde_json::Value = serde_json::from_str(&raw_text).map_err(|_| {
        let snippet: String = raw_text.chars().take(500).collect();
        format!("Veo returned a non-JSON response ({status}): {snippet}")
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Could not check animation status.");
        return Err(format!("Veo error ({status}): {message}"));
    }
    if let Some(error) = body.get("error") {
        let message = error.get("message").and_then(|value| value.as_str()).unwrap_or("Animation generation failed.");
        return Err(format!("Veo generation failed: {message}"));
    }
    if !body.get("done").and_then(|value| value.as_bool()).unwrap_or(false) {
        return Ok(None);
    }
    let sample = body
        .pointer("/response/generateVideoResponse/generatedSamples/0/video")
        .or_else(|| body.pointer("/response/videos/0"))
        .ok_or("Veo finished but returned no video.")?;
    if let Some(data) = sample.get("bytesBase64Encoded").and_then(|value| value.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "Veo returned invalid video data.".to_string())?;
        return Ok(Some(bytes));
    }
    let uri = sample
        .get("uri")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            if sample.get("gcsUri").is_some() {
                "Veo delivered the video to Cloud Storage (gcsUri), which this app does not yet download from — configure the request to return an inline/HTTPS URI instead.".to_string()
            } else {
                "Veo returned a video with no retrievable data.".to_string()
            }
        })?;
    let download_request = match auth {
        GeminiAuth::ApiKey(api_key) => client.get(uri).header("x-goog-api-key", api_key),
        GeminiAuth::Vertex { access_token, .. } => client.get(uri).bearer_auth(access_token),
    };
    let bytes = download_request
        .send()
        .map_err(|error| format!("Could not download the generated animation: {error}"))?
        .bytes()
        .map_err(|error| format!("Could not read the generated animation: {error}"))?;
    Ok(Some(bytes.to_vec()))
}

fn request_gemini_image(
    auth: &GeminiAuth,
    model: &str,
    prompt: &str,
    aspect_ratio: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let model = model.trim();
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
    {
        return Err("Gemini model name is invalid.".into());
    }
    // Client::new() has NO default request timeout — if Gemini's server accepts the
    // connection but never responds, this call would otherwise block forever with no
    // way for the retry loop or Stop button to ever intervene. This is the actual image
    // generation call in the bulk-gen pipeline, so a real hang here reads exactly like
    // "stuck retrying" with zero CPU/network activity that never resolves.
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Could not initialize Gemini client: {e}"))?;
    let (request, aspect_ratio, image_size) = match auth {
        GeminiAuth::ApiKey(api_key) => (client
            .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
            .header("x-goog-api-key", api_key), aspect_ratio, "1K"),
        GeminiAuth::Vertex { access_token, project_id } => {
            let url = format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent");
            let vertex_ratio = if aspect_ratio == "9:16" { "ASPECT_RATIO_9_16" } else { "ASPECT_RATIO_16_9" };
            (client.post(url).bearer_auth(access_token), vertex_ratio, "IMAGE_SIZE_1K")
        }
    };
    let response = request
        .json(&json!({
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "responseFormat": {"image": {"aspectRatio": aspect_ratio, "imageSize": image_size}}
            }
        }))
        .send()
        .map_err(|error| format!("Could not reach Gemini: {error}"))?;
    let response = if response.status() == reqwest::StatusCode::BAD_REQUEST {
        let fallback_request = match auth {
            GeminiAuth::ApiKey(api_key) => client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                .header("x-goog-api-key", api_key),
            GeminiAuth::Vertex { access_token, project_id } => client
                .post(format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent"))
                .bearer_auth(access_token),
        };
        fallback_request.json(&json!({
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}
        })).send().map_err(|error| format!("Could not reach Gemini: {error}"))?
    } else { response };
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .map_err(|error| format!("Gemini returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Image generation failed.");
        return Err(format!("Gemini error ({status}): {message}"));
    }
    let parts = body
        .pointer("/candidates/0/content/parts")
        .and_then(|value| value.as_array())
        .ok_or("Gemini returned no image.")?;
    for part in parts {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        if let Some(inline) = inline {
            let data = inline
                .get("data")
                .and_then(|value| value.as_str())
                .ok_or("Gemini image data was empty.")?;
            let mime = inline
                .get("mimeType")
                .or_else(|| inline.get("mime_type"))
                .and_then(|value| value.as_str())
                .unwrap_or("image/png");
            let extension = match mime {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "Gemini returned invalid image data.".to_string())?;
            return Ok((bytes, extension));
        }
    }
    Err("Gemini returned text but no image. Try a supported image model.".into())
}

fn request_gemini_image_with_source(
    auth: &GeminiAuth,
    model: &str,
    prompt: &str,
    source_bytes: &[u8],
    mime_type: &str,
    mask_bytes: Option<&[u8]>,
    aspect_ratio: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let model = model.trim();
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
    {
        return Err("Gemini model name is invalid.".into());
    }
    // See request_gemini_image's comment: Client::new() has no default timeout, which
    // would let an unresponsive server hang this call (and the whole worker) forever.
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Could not initialize Gemini client: {e}"))?;
    let (request, aspect_ratio, image_size) = match auth {
        GeminiAuth::ApiKey(api_key) => (client
            .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
            .header("x-goog-api-key", api_key), aspect_ratio, "1K"),
        GeminiAuth::Vertex { access_token, project_id } => {
            let vertex_ratio = if aspect_ratio == "9:16" { "ASPECT_RATIO_9_16" } else { "ASPECT_RATIO_16_9" };
            (client
                .post(format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent"))
                .bearer_auth(access_token), vertex_ratio, "IMAGE_SIZE_1K")
        },
    };
    let mut parts = vec![
        json!({"inlineData": {"mimeType": mime_type, "data": base64::engine::general_purpose::STANDARD.encode(source_bytes)}}),
    ];
    if let Some(mask) = mask_bytes {
        parts.push(json!({"inlineData": {"mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(mask)}}));
    }
    parts.push(json!({"text": prompt}));
    let response = request
        .json(&json!({
            "contents": [{"role": "user", "parts": parts.clone()}],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "responseFormat": {"image": {"aspectRatio": aspect_ratio, "imageSize": image_size}}
            }
        }))
        .send()
        .map_err(|error| format!("Could not reach Gemini: {error}"))?;
    let response = if response.status() == reqwest::StatusCode::BAD_REQUEST {
        let fallback_request = match auth {
            GeminiAuth::ApiKey(api_key) => client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                .header("x-goog-api-key", api_key),
            GeminiAuth::Vertex { access_token, project_id } => client
                .post(format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent"))
                .bearer_auth(access_token),
        };
        fallback_request.json(&json!({
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["IMAGE"]}
        })).send().map_err(|error| format!("Could not reach Gemini: {error}"))?
    } else { response };
    parse_gemini_image_response(response)
}

fn decode_data_url(value: &str) -> Result<(String, Vec<u8>), String> {
    let (header, data) = value.split_once(',')
        .ok_or("Mask image data is invalid.")?;
    let mime = header.strip_prefix("data:").and_then(|item| item.split(';').next())
        .unwrap_or("image/png").to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(data)
        .map_err(|_| "Mask image data is invalid.".to_string())?;
    Ok((mime, bytes))
}

fn parse_gemini_image_response(
    response: reqwest::blocking::Response,
) -> Result<(Vec<u8>, &'static str), String> {
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .map_err(|error| format!("Gemini returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Image editing failed.");
        return Err(format!("Gemini error ({status}): {message}"));
    }
    let parts = body
        .pointer("/candidates/0/content/parts")
        .and_then(|value| value.as_array())
        .ok_or("Gemini returned no edited image.")?;
    for part in parts {
        if let Some(inline) = part.get("inlineData").or_else(|| part.get("inline_data")) {
            let data = inline
                .get("data")
                .and_then(|value| value.as_str())
                .ok_or("Gemini image data was empty.")?;
            let mime = inline
                .get("mimeType")
                .or_else(|| inline.get("mime_type"))
                .and_then(|value| value.as_str())
                .unwrap_or("image/png");
            let extension = match mime {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "Gemini returned invalid image data.".to_string())?;
            return Ok((bytes, extension));
        }
    }
    Err("Gemini returned no edited image.".into())
}

fn split_sentences(script: &str) -> Vec<String> {
    let cleaned = remove_tts_pause_markers(script).0;
    let mut result = Vec::new();
    let mut current = String::new();
    for character in cleaned.chars() {
        current.push(character);
        if matches!(character, '.' | '!' | '?') {
            let text = current.split_whitespace().collect::<Vec<_>>().join(" ");
            if !text.is_empty() {
                result.push(text);
            }
            current.clear();
        }
    }
    let remaining = current.split_whitespace().collect::<Vec<_>>().join(" ");
    if !remaining.is_empty() {
        result.push(remaining);
    }
    result
}

fn remove_tts_pause_markers(script: &str) -> (String, f64) {
    let mut cleaned = String::new();
    let mut pauses = 0.0;
    let mut rest = script;
    while let Some(start) = rest.find("<#") {
        cleaned.push_str(&rest[..start]);
        let marker = &rest[start + 2..];
        let Some(end) = marker.find("#>") else {
            cleaned.push_str(&rest[start..]);
            return (normalize_paragraphs(&cleaned), pauses);
        };
        if let Ok(seconds) = marker[..end].trim().parse::<f64>() {
            pauses += seconds.max(0.0);
        } else {
            cleaned.push_str(&rest[start..start + end + 4]);
        }
        cleaned.push(' ');
        rest = &marker[end + 2..];
    }
    cleaned.push_str(rest);
    (normalize_paragraphs(&cleaned), pauses)
}

/// Collapses whitespace WITHIN each paragraph to single spaces (the tidying
/// remove_tts_pause_markers always did) while preserving paragraph breaks
/// (blank lines) BETWEEN paragraphs, which it used to destroy entirely via a
/// single `split_whitespace().join(" ")` over the whole script.
///
/// That mattered more than it looked: the visual-plan engine's own
/// `read_script()` (services/python-engine/auto_gen_engine/
/// scene_grouping_engine.py) detects paragraph boundaries by splitting on
/// exactly this kind of blank line, and `paragraph_scenes()` — the Scene
/// layer's fallback for per-sentence pacing and the AI-error path, since
/// neither has AI boundary data to work from — groups sentences into scenes
/// by paragraph. With every paragraph break silently flattened away before
/// the script ever reached the engine, `read_script()` could never see more
/// than one paragraph no matter how the user had actually formatted the
/// script, so those modes could never produce more than a single scene.
fn normalize_paragraphs(text: &str) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !current_lines.is_empty() {
                paragraphs.push(current_lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" "));
                current_lines.clear();
            }
        } else {
            current_lines.push(line);
        }
    }
    if !current_lines.is_empty() {
        paragraphs.push(current_lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" "));
    }
    paragraphs.join("\n\n")
}

fn build_groups_range(
    sentences: &[PlanSentence],
    min_seconds: f64,
    max_seconds: f64,
) -> Vec<PlanGroup> {
    let mut groups = Vec::new();
    let mut pending: Vec<&PlanSentence> = Vec::new();
    for sentence in sentences {
        let proposed = pending
            .first()
            .map(|first| sentence.end_seconds - first.start_seconds)
            .unwrap_or(0.0);
        if !pending.is_empty()
            && proposed > max_seconds
            && pending.last().unwrap().end_seconds - pending[0].start_seconds >= min_seconds
        {
            groups.push(make_group(groups.len() + 1, &pending));
            pending.clear();
        }
        pending.push(sentence);
    }
    if !pending.is_empty() {
        groups.push(make_group(groups.len() + 1, &pending));
    }
    groups
}

fn make_group(ordinal: usize, sentences: &[&PlanSentence]) -> PlanGroup {
    PlanGroup {
        id: format!("g{ordinal}"),
        ordinal: ordinal as i64,
        label: format!("Scene {ordinal}"),
        kind: if ordinal == 1 {
            "establishing".into()
        } else {
            "subject".into()
        },
        sentence_ids: sentences
            .iter()
            .map(|sentence| sentence.id.clone())
            .collect(),
        settings_locked: false,
        prompt_locked: false,
        // Filled in by assign_scene_ids once scenes exist — build_groups_range
        // has no scene knowledge of its own.
        scene_id: None,
    }
}

/// Test-fixture stand-in for real scene segmentation (no Python involved in
/// tests): chunks consecutive groups into scenes of a few stills each, the
/// same crude fidelity `build_groups_range` itself already has. Tests assert
/// structural invariants (every group has a valid scene_id, scenes stay
/// gapless), not narrative quality.
const TEST_GROUPS_PER_SCENE: usize = 3;

fn build_scenes_range(groups: &[PlanGroup]) -> Vec<PlanScene> {
    groups
        .chunks(TEST_GROUPS_PER_SCENE)
        .enumerate()
        .map(|(index, chunk)| {
            let ordinal = index as i64 + 1;
            PlanScene {
                id: format!("sc{ordinal}"),
                ordinal,
                label: format!("Scene {ordinal}"),
                narrative_role: None,
                core_idea: None,
                emotional_state: None,
                visual_opportunities: Vec::new(),
                sentence_ids: chunk
                    .iter()
                    .flat_map(|group| group.sentence_ids.iter().cloned())
                    .collect(),
                expanded: true,
            }
        })
        .collect()
}

/// Recomputes every group's `scene_id` by containment against `scenes` (a
/// group belongs to whichever scene's sentence range contains its first
/// sentence). Callers that need a move/split to actually cross a scene
/// boundary (see `scene_containing_sentence`/`rebalance_scene_ordinals`)
/// must update `scenes`' own `sentence_ids` themselves *before* calling
/// this — it only ever re-derives `scene_id` from whatever `scenes` already
/// says, it never changes a scene's range on its own.
fn assign_scene_ids(groups: &mut [PlanGroup], scenes: &[PlanScene]) {
    for group in groups.iter_mut() {
        group.scene_id = group.sentence_ids.first().and_then(|first_sentence_id| {
            scenes
                .iter()
                .find(|scene| scene.sentence_ids.iter().any(|id| id == first_sentence_id))
                .map(|scene| scene.id.clone())
        });
    }
}

/// Index of whichever scene's `sentence_ids` currently lists `sentence_id`.
fn scene_containing_sentence(scenes: &[PlanScene], sentence_id: &str) -> Option<usize> {
    scenes.iter().position(|scene| scene.sentence_ids.iter().any(|id| id == sentence_id))
}

/// After a boundary-crossing move/split has already added/removed sentence
/// ids on the affected scenes' `sentence_ids`, this: drops any scene that's
/// now empty (its one sentence just left), re-sorts scenes into chronological
/// order by each one's earliest sentence (so a freshly-inserted scene lands
/// in the right slot without the caller needing to compute an insert index),
/// and renumbers `ordinal` to match — the same drop-empty-then-renumber
/// pattern `split_plan_sentence`/`merge_plan_sentences` already use.
fn rebalance_scene_ordinals(scenes: &mut Vec<PlanScene>) {
    scenes.retain(|scene| !scene.sentence_ids.is_empty());
    scenes.sort_by_key(|scene| {
        scene.sentence_ids.iter().map(|id| sentence_number(id)).min().unwrap_or(i64::MAX)
    });
    for (index, scene) in scenes.iter_mut().enumerate() {
        scene.ordinal = index as i64 + 1;
    }
}

fn sentence_number(id: &str) -> i64 {
    id.trim_start_matches('s').parse().unwrap_or(i64::MAX)
}

fn validate_group_chronology(groups: &[PlanGroup]) -> Result<(), String> {
    let flattened = groups
        .iter()
        .flat_map(|group| group.sentence_ids.iter())
        .map(|id| sentence_number(id))
        .collect::<Vec<_>>();
    if flattened
        .windows(2)
        .any(|pair| pair[1] != pair[0].saturating_add(1))
    {
        return Err("This move would disrupt the chronological sentence sequence.".into());
    }
    Ok(())
}

fn collect_relative_files(
    root: &Path,
    current: &Path,
    output: &mut Vec<String>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            collect_relative_files(root, &path, output)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            validate_bundle_path(&relative)?;
            output.push(relative);
        }
    }
    output.sort();
    Ok(())
}

/// Scans every `ATOMIC_ID_COLUMNS` value across every dumped table/row and
/// assigns each distinct old id a fresh random one, so a bundle imported
/// into any database (including the one it was exported from) never
/// collides with an existing row. Table order/column role doesn't matter
/// here — the same old id always maps to the same new id everywhere it's
/// seen, whether that occurrence is a row's own primary key or a foreign
/// key pointing at another row in the bundle, because `HashMap::entry`
/// only ever assigns a mapping the first time an old id is encountered.
fn seed_id_map(
    tables: &std::collections::BTreeMap<String, Vec<serde_json::Map<String, serde_json::Value>>>,
    id_map: &mut std::collections::HashMap<String, String>,
) {
    for table in PROJECT_TABLES {
        let Some(rows) = tables.get(*table) else { continue };
        let is_composite_table = COMPOSITE_ID_TABLES.contains(table);
        for row in rows {
            for column in ATOMIC_ID_COLUMNS {
                if let Some(serde_json::Value::String(value)) = row.get(*column) {
                    if value.is_empty() {
                        continue;
                    }
                    // For the two namespaced tables, seed the bare suffix
                    // (what every reference to this row elsewhere in the
                    // bundle actually uses) — not the raw `video_id::...`
                    // column value, which appears nowhere else verbatim.
                    let key = if is_composite_table && *column == "id" {
                        composite_id_suffix(value).to_string()
                    } else {
                        value.clone()
                    };
                    id_map.entry(key).or_insert_with(|| Uuid::new_v4().to_string());
                }
            }
        }
    }
}

/// Splits a namespaced id (`video_id::suffix` or `video_id::variant::suffix`)
/// on `::`, remaps the first segment (video_id) and the last segment
/// (suffix) via exact lookups, and rejoins — never substring-matching.
/// Substring matching was tried first and was wrong: this app's own
/// split-sentence ids are literally one id with a digit appended (`s1` →
/// `s1`/`s2`, or a group's `…d18` → `…d18`/`…d182`), so a shorter id is
/// routinely a prefix of an unrelated longer one. Scanning for "does this
/// string contain that id" would rewrite `s1` inside `s10`..`s19`, or
/// `…d18` inside `…d182`, corrupting ids that were never supposed to
/// change. Splitting on the known `::` boundaries first and only
/// exact-matching each whole segment avoids that entirely.
fn remap_composite_id(value: &str, id_map: &std::collections::HashMap<String, String>) -> String {
    let mut parts: Vec<&str> = value.split("::").collect();
    let Some(last) = parts.len().checked_sub(1).filter(|&n| n > 0) else {
        return value.to_string();
    };
    let mapped_head = id_map.get(parts[0]).map(String::as_str);
    let mapped_tail = id_map.get(parts[last]).map(String::as_str);
    if mapped_head.is_none() && mapped_tail.is_none() {
        return value.to_string();
    }
    if let Some(head) = mapped_head {
        parts[0] = head;
    }
    if let Some(tail) = mapped_tail {
        parts[last] = tail;
    }
    parts.join("::")
}

/// Remaps `visual_plan_groups.sentence_ids_json` (a plain JSON array of bare
/// sentence-suffix ids) — parses it, exact-matches each element against
/// `id_map`, re-serializes. Same "no substring matching" reasoning as
/// `remap_composite_id`.
fn remap_id_array_json(value: &str, id_map: &std::collections::HashMap<String, String>) -> String {
    let Ok(mut ids) = serde_json::from_str::<Vec<String>>(value) else {
        return value.to_string();
    };
    let mut changed = false;
    for id in ids.iter_mut() {
        if let Some(mapped) = id_map.get(id.as_str()) {
            if mapped != id {
                *id = mapped.clone();
                changed = true;
            }
        }
    }
    if !changed {
        return value.to_string();
    }
    serde_json::to_string(&ids).unwrap_or_else(|_| value.to_string())
}

/// Remaps `visual_plan_meta.original_sentences_json` (a JSON array of
/// sentence-snapshot objects, each with a bare-suffix `id` field) — parses,
/// exact-matches each object's `id`, re-serializes. Every other field
/// (text, timing) is copied through untouched.
fn remap_sentence_snapshot_json(value: &str, id_map: &std::collections::HashMap<String, String>) -> String {
    let Ok(mut items) = serde_json::from_str::<Vec<serde_json::Value>>(value) else {
        return value.to_string();
    };
    let mut changed = false;
    for item in items.iter_mut() {
        let serde_json::Value::Object(obj) = item else { continue };
        let Some(serde_json::Value::String(id)) = obj.get("id") else { continue };
        if let Some(mapped) = id_map.get(id.as_str()) {
            if mapped != id {
                let mapped = mapped.clone();
                obj.insert("id".to_string(), serde_json::Value::String(mapped));
                changed = true;
            }
        }
    }
    if !changed {
        return value.to_string();
    }
    serde_json::to_string(&items).unwrap_or_else(|_| value.to_string())
}

/// Rewrites every id-shaped value in one dumped row using `id_map`: an
/// exact lookup for `ATOMIC_ID_COLUMNS`, and structured (never
/// substring-based — see `remap_composite_id`) handling for the two
/// namespaced tables' own `id` column and the JSON columns that embed ids.
/// Any id with no entry in the map (nothing in the bundle ever introduced
/// it — e.g. a stale id left over in a point-in-time snapshot) is left
/// exactly as exported.
fn remap_row(
    table: &str,
    mut row: serde_json::Map<String, serde_json::Value>,
    id_map: &std::collections::HashMap<String, String>,
) -> serde_json::Map<String, serde_json::Value> {
    let is_composite_table = COMPOSITE_ID_TABLES.contains(&table);
    for column in ATOMIC_ID_COLUMNS {
        // `id` on the two namespaced tables is `video_id::[variant::]suffix`
        // — not a single opaque id — handled below via remap_composite_id.
        if is_composite_table && *column == "id" {
            continue;
        }
        if let Some(serde_json::Value::String(value)) = row.get(*column) {
            if let Some(mapped) = id_map.get(value) {
                if mapped != value {
                    row.insert((*column).to_string(), serde_json::Value::String(mapped.clone()));
                }
            }
        }
    }
    if is_composite_table {
        if let Some(serde_json::Value::String(value)) = row.get("id") {
            let updated = remap_composite_id(value, id_map);
            if &updated != value {
                row.insert("id".to_string(), serde_json::Value::String(updated));
            }
        }
    }
    if let Some(serde_json::Value::String(value)) = row.get("sentence_ids_json") {
        let updated = remap_id_array_json(value, id_map);
        if &updated != value {
            row.insert("sentence_ids_json".to_string(), serde_json::Value::String(updated));
        }
    }
    if let Some(serde_json::Value::String(value)) = row.get("original_sentences_json") {
        let updated = remap_sentence_snapshot_json(value, id_map);
        if &updated != value {
            row.insert("original_sentences_json".to_string(), serde_json::Value::String(updated));
        }
    }
    row
}

fn json_to_sql(value: &serde_json::Value) -> Box<dyn rusqlite::ToSql> {
    match value {
        serde_json::Value::Null => Box::new(Option::<String>::None),
        serde_json::Value::Bool(flag) => Box::new(*flag as i64),
        serde_json::Value::Number(number) => match number.as_i64() {
            Some(value) => Box::new(value),
            None => Box::new(number.as_f64().unwrap_or(0.0)),
        },
        serde_json::Value::String(text) => Box::new(text.clone()),
        other => Box::new(other.to_string()),
    }
}

fn validate_bundle_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Project bundle contains an unsafe path.".into());
    }
    Ok(())
}

/// Parses the `timing.txt` written by `video_export_engine.py`'s editor
/// bundle export — tab-separated lines of
/// `<clip file>\t<kind>\t<start>s - <end>s\t(<duration>s)`, interleaved with
/// free-form instruction prose that this simply ignores (any line that
/// doesn't start with a recognized clip filename is skipped).
fn parse_timing_file(text: &str) -> Result<Vec<(String, f64, f64)>, String> {
    const CLIP_EXTENSIONS: &[&str] = &["mp4", "mov", "webm", "mkv", "png", "jpg", "jpeg", "webp"];
    let mut segments = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let file_name = parts[0].trim();
        let has_clip_extension = file_name
            .rsplit('.')
            .next()
            .map(|ext| CLIP_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !has_clip_extension {
            continue;
        }
        let Some((start_str, end_str)) = parts[2].trim().split_once(" - ") else { continue };
        let Some(start_str) = start_str.trim().strip_suffix('s') else { continue };
        let Some(end_str) = end_str.trim().strip_suffix('s') else { continue };
        let (Ok(start), Ok(end)) = (start_str.parse::<f64>(), end_str.parse::<f64>()) else { continue };
        segments.push((file_name.to_string(), start, end));
    }
    if segments.is_empty() {
        return Err("timing.txt did not contain any recognizable clip timing entries.".into());
    }
    Ok(segments)
}

/// Parses a plain `.srt` file into `(start_seconds, end_seconds, text)`
/// entries. Tolerant of the index-number line, CRLF line endings, and
/// multi-line captions — anything it can't confidently parse is skipped
/// rather than aborting the whole import.
fn parse_srt(text: &str) -> Vec<(f64, f64, String)> {
    let normalized = text.replace("\r\n", "\n");
    let mut entries = Vec::new();
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|line| !line.trim().is_empty()).collect();
        let Some(timestamp_index) = lines.iter().position(|line| line.contains("-->")) else { continue };
        let Some((start_str, end_str)) = lines[timestamp_index].split_once("-->") else { continue };
        let (Some(start), Some(end)) = (parse_srt_timestamp(start_str.trim()), parse_srt_timestamp(end_str.trim())) else { continue };
        let text = lines[timestamp_index + 1..].join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        entries.push((start, end, text));
    }
    entries
}

fn parse_srt_timestamp(value: &str) -> Option<f64> {
    let value = value.trim();
    let (time_part, millis_part) = value.split_once(',').or_else(|| value.split_once('.'))?;
    let mut components = time_part.split(':');
    let hours: f64 = components.next()?.trim().parse().ok()?;
    let minutes: f64 = components.next()?.trim().parse().ok()?;
    let seconds: f64 = components.next()?.trim().parse().ok()?;
    let millis: f64 = millis_part.trim().parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds + millis / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn repository() -> (TempDir, ProjectRepository) {
        let temp = TempDir::new().unwrap();
        let repo =
            ProjectRepository::open(&temp.path().join("app.db"), &temp.path().join("Projects"))
                .unwrap();
        (temp, repo)
    }

    #[test]
    fn creates_channels_videos_and_resume_state() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Beneath the Fins", None).unwrap();
        let video = repo.create_video(&channel.id, "Twilight Zone").unwrap();
        repo.set_resume(&channel.id, &video.id, "visual-plan")
            .unwrap();

        assert_eq!(repo.list_channels(false).unwrap()[0].video_count, 1);
        assert_eq!(
            repo.list_videos(&channel.id, false).unwrap()[0].title,
            "Twilight Zone"
        );
        assert_eq!(repo.get_resume().unwrap().unwrap().stage, "visual-plan");
    }

    #[test]
    fn trash_is_recoverable() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        repo.trash_channel(&channel.id).unwrap();
        assert!(repo.list_channels(false).unwrap().is_empty());
        assert_eq!(repo.list_channels(true).unwrap().len(), 1);
        repo.restore_channel(&channel.id).unwrap();
        assert_eq!(repo.list_channels(false).unwrap().len(), 1);
    }

    #[test]
    fn automatic_snapshots_retain_ten() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        for revision in 0..14 {
            repo.create_snapshot(&video.id, &format!(r#"{{"revision":{revision}}}"#))
                .unwrap();
        }
        assert_eq!(repo.snapshot_count(&video.id), 10);
    }

    #[test]
    fn saves_video_inputs_and_imports_assets() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let source = temp.path().join("voice.wav");
        fs::write(&source, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "A script.", 9).unwrap();
        let asset = repo.import_asset(&video.id, &source, "audio").unwrap();
        let inputs = repo.get_video_inputs(&video.id).unwrap();
        assert_eq!(inputs.script_text, "A script.");
        assert_eq!(inputs.pacing_seconds, 9);
        assert_eq!(inputs.audio.unwrap().id, asset.id);
    }

    #[test]
    fn generates_moves_and_resets_visual_plan() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let original = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert!(!original.groups.is_empty());
        assert!(!original.scenes.is_empty(), "generation must always produce at least one scene");
        assert!(
            original.scenes.iter().all(|scene| scene.expanded),
            "every scene must start expanded right after generation"
        );
        assert!(
            original.groups.iter().all(|group| group.scene_id.is_some()),
            "every still must be assigned to a scene at generation time"
        );
        if original.groups.len() > 1 {
            let sentence = original.groups[0].sentence_ids.last().unwrap().clone();
            let target = original.groups[1].id.clone();
            repo.move_plan_sentence(&video.id, &sentence, &target)
                .unwrap();
            assert_eq!(
                repo.reset_visual_plan(&video.id).unwrap().groups,
                original.groups
            );
        }
    }

    /// Seeds a plan with one sentence per still (simplest fixture for
    /// boundary tests — every sentence is both first and last of its own
    /// group, so any of them is a valid drag-boundary candidate) and one
    /// scene per entry in `scene_sentence_counts`, in chronological order.
    /// e.g. `&[2, 2]` builds scenes sc1={s1,s2}/sc2={s3,s4} over groups
    /// g1..g4. Writes both snapshots (original + current), same as real
    /// generation, so `save_plan`'s invariants hold.
    fn seed_plan_with_scenes(repo: &ProjectRepository, video_id: &str, scene_sentence_counts: &[usize]) {
        let mut sentences = Vec::new();
        let mut groups = Vec::new();
        let mut scenes = Vec::new();
        let mut next_sentence = 1i64;
        for (scene_index, &count) in scene_sentence_counts.iter().enumerate() {
            let mut scene_sentence_ids = Vec::new();
            for _ in 0..count {
                let id = format!("s{next_sentence}");
                sentences.push(PlanSentence {
                    id: id.clone(),
                    ordinal: next_sentence,
                    text: format!("Sentence {next_sentence}."),
                    start_seconds: next_sentence as f64,
                    end_seconds: next_sentence as f64 + 1.0,
                });
                groups.push(PlanGroup {
                    id: format!("g{next_sentence}"),
                    ordinal: next_sentence,
                    label: format!("Still {next_sentence}"),
                    kind: "custom".into(),
                    sentence_ids: vec![id.clone()],
                    settings_locked: false,
                    prompt_locked: false,
                    scene_id: None,
                });
                scene_sentence_ids.push(id);
                next_sentence += 1;
            }
            scenes.push(PlanScene {
                id: format!("sc{}", scene_index + 1),
                ordinal: scene_index as i64 + 1,
                label: "Scene".into(),
                narrative_role: None,
                core_idea: None,
                emotional_state: None,
                visual_opportunities: Vec::new(),
                sentence_ids: scene_sentence_ids,
                expanded: true,
            });
        }
        assign_scene_ids(&mut groups, &scenes);
        repo.save_plan(video_id, &sentences, &groups, &scenes, true, "test").unwrap();
        repo.save_plan(video_id, &sentences, &groups, &scenes, false, "test").unwrap();
    }

    /// A still's sentences must all belong to the SAME scene's sentence_ids
    /// — a stronger check than production's `assign_scene_ids`, which only
    /// ever inspects a group's first sentence. Boundary-editing bugs would
    /// otherwise hide behind that leniency.
    fn assert_no_group_straddles_two_scenes(plan: &VisualPlan) {
        for group in &plan.groups {
            let owning_scenes: std::collections::HashSet<&str> = group.sentence_ids.iter()
                .filter_map(|id| plan.scenes.iter().find(|scene| scene.sentence_ids.contains(id)))
                .map(|scene| scene.id.as_str())
                .collect();
            assert!(
                owning_scenes.len() <= 1,
                "still {} straddles multiple scenes: {owning_scenes:?}",
                group.id
            );
        }
    }

    #[test]
    fn move_plan_sentence_across_a_scene_boundary_shifts_the_boundary() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        seed_plan_with_scenes(&repo, &video.id, &[3, 3]); // sc1={s1,s2,s3}, sc2={s4,s5,s6}

        // s3 is the last sentence of g3 (scene 1's last still) — drag it
        // into g4 (scene 2's first still, adjacent).
        let plan = repo.move_plan_sentence(&video.id, "s3", "g4").unwrap();

        let scene1 = plan.scenes.iter().find(|s| s.ordinal == 1).unwrap();
        let scene2 = plan.scenes.iter().find(|s| s.ordinal == 2).unwrap();
        assert_eq!(scene1.sentence_ids, vec!["s1", "s2"], "scene 1 must lose s3");
        assert_eq!(scene2.sentence_ids, vec!["s3", "s4", "s5", "s6"], "scene 2 must gain s3, in chronological order");

        let merged_group = plan.groups.iter().find(|g| g.sentence_ids.contains(&"s3".to_string())).unwrap();
        assert_eq!(merged_group.scene_id.as_deref(), Some(scene2.id.as_str()));
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn move_plan_sentence_that_empties_a_scene_drops_and_renumbers_it() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        seed_plan_with_scenes(&repo, &video.id, &[1, 3]); // sc1={s1} (single-still scene), sc2={s2,s3,s4}

        // s1 is scene 1's only sentence — moving it into scene 2 must leave
        // scene 1 empty and it should disappear entirely, not linger as a
        // 0-sentence scene.
        let plan = repo.move_plan_sentence(&video.id, "s1", "g2").unwrap();

        assert_eq!(plan.scenes.len(), 1, "the emptied scene must be dropped");
        let remaining = &plan.scenes[0];
        assert_eq!(remaining.ordinal, 1, "the sole remaining scene must renumber to ordinal 1");
        assert_eq!(remaining.sentence_ids, vec!["s1", "s2", "s3", "s4"]);
        assert!(plan.groups.iter().all(|g| g.scene_id.as_deref() == Some(remaining.id.as_str())));
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn create_plan_group_at_a_scene_seam_inserts_a_new_scene() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        // sc1={s1,s2,s3} over g1(s1),g2(s2,s3); sc2={s4} over g3(s4). Use a
        // 2-sentence g2 (not a solo still) so removing just its last
        // sentence doesn't empty/remove it — keeps group indices stable
        // and isolates the "insert a new scene" behavior being tested.
        let mut sentences = vec![
            PlanSentence { id: "s1".into(), ordinal: 1, text: "One.".into(), start_seconds: 1.0, end_seconds: 2.0 },
            PlanSentence { id: "s2".into(), ordinal: 2, text: "Two.".into(), start_seconds: 2.0, end_seconds: 3.0 },
            PlanSentence { id: "s3".into(), ordinal: 3, text: "Three.".into(), start_seconds: 3.0, end_seconds: 4.0 },
            PlanSentence { id: "s4".into(), ordinal: 4, text: "Four.".into(), start_seconds: 4.0, end_seconds: 5.0 },
        ];
        sentences.sort_by_key(|s| s.ordinal);
        let mut groups = vec![
            PlanGroup { id: "g1".into(), ordinal: 1, label: "Still 1".into(), kind: "custom".into(), sentence_ids: vec!["s1".into()], settings_locked: false, prompt_locked: false, scene_id: None },
            PlanGroup { id: "g2".into(), ordinal: 2, label: "Still 2".into(), kind: "custom".into(), sentence_ids: vec!["s2".into(), "s3".into()], settings_locked: false, prompt_locked: false, scene_id: None },
            PlanGroup { id: "g3".into(), ordinal: 3, label: "Still 3".into(), kind: "custom".into(), sentence_ids: vec!["s4".into()], settings_locked: false, prompt_locked: false, scene_id: None },
        ];
        let mut scenes = vec![
            PlanScene { id: "sc1".into(), ordinal: 1, label: "Scene".into(), narrative_role: None, core_idea: None, emotional_state: None, visual_opportunities: Vec::new(), sentence_ids: vec!["s1".into(), "s2".into(), "s3".into()], expanded: true },
            PlanScene { id: "sc2".into(), ordinal: 2, label: "Scene".into(), narrative_role: None, core_idea: None, emotional_state: None, visual_opportunities: Vec::new(), sentence_ids: vec!["s4".into()], expanded: true },
        ];
        assign_scene_ids(&mut groups, &scenes);
        repo.save_plan(&video.id, &sentences, &groups, &scenes, true, "test").unwrap();
        repo.save_plan(&video.id, &sentences, &groups, &scenes, false, "test").unwrap();

        // s3 is the last sentence of g2 (scene 1's last still) — drop it at
        // the divider immediately after g2, which is also exactly the seam
        // between scene 1 and scene 2. force_new_scene=true is the
        // frontend's Shift-modifier: an explicit "start a new scene here"
        // rather than the default plain split (see the sibling test below
        // for the force=false / default behavior at the same seam).
        let plan = repo.create_plan_group(&video.id, "s3", 2, true).unwrap();

        assert_eq!(plan.scenes.len(), 3, "a new scene must be inserted at the seam");
        let new_scene = plan.scenes.iter().find(|s| s.ordinal == 2).unwrap();
        assert_eq!(new_scene.sentence_ids, vec!["s3"]);
        let old_scene1 = plan.scenes.iter().find(|s| s.ordinal == 1).unwrap();
        assert_eq!(old_scene1.sentence_ids, vec!["s1", "s2"], "scene 1 must lose s3 to the new scene");
        let old_scene2 = plan.scenes.iter().find(|s| s.ordinal == 3).unwrap();
        assert_eq!(old_scene2.sentence_ids, vec!["s4"], "the old scene 2 must renumber to ordinal 3");
        let new_group = plan.groups.iter().find(|g| g.sentence_ids == vec!["s3".to_string()]).unwrap();
        assert_eq!(new_group.scene_id.as_deref(), Some(new_scene.id.as_str()));
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn create_plan_group_from_a_solo_sentence_still_at_a_scene_seam_inserts_a_new_scene() {
        // Regression test: a still with exactly ONE sentence is simultaneously
        // its own first AND last sentence. The original boundary check picked
        // the "first" branch before ever considering "last", computing
        // expected_insert_index = source (the divider BEFORE the still) even
        // when the frontend correctly sent source+1 (the divider AFTER it,
        // which is where the seam divider between two scenes actually sits)
        // — surfacing as "Drop at the sentence's chronological boundary to
        // create a new still." on the exact drag this feature exists for,
        // since fast/per-sentence pacing produces mostly solo-sentence stills.
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        seed_plan_with_scenes(&repo, &video.id, &[2, 2]); // sc1={s1,s2} g1(s1),g2(s2); sc2={s3,s4} g3(s3),g4(s4)

        // s2 is g2's only sentence (both first and last) and scene 1's last
        // still. Drop it at insert_index = source+1 = 2 — the divider AFTER
        // g2, exactly where the real seam divider sits — not source (1).
        // force_new_scene=true, the Shift-modifier.
        let plan = repo.create_plan_group(&video.id, "s2", 2, true).unwrap();

        assert_eq!(plan.scenes.len(), 3, "a new scene must be inserted at the seam");
        let scene1 = plan.scenes.iter().find(|s| s.ordinal == 1).unwrap();
        let new_scene = plan.scenes.iter().find(|s| s.ordinal == 2).unwrap();
        let scene2 = plan.scenes.iter().find(|s| s.ordinal == 3).unwrap();
        assert_eq!(scene1.sentence_ids, vec!["s1"], "scene 1 must lose s2 to the new scene");
        assert_eq!(new_scene.sentence_ids, vec!["s2"]);
        assert_eq!(scene2.sentence_ids, vec!["s3", "s4"], "scene 2 must renumber to ordinal 3, unchanged otherwise");
        // Chronological order must be preserved: s1, s2, s3, s4 in that order
        // across the resulting stills — this is exactly what the index-shift
        // bug (inserting one slot too far right once the solo still's own
        // group vanished) would have violated.
        let flattened: Vec<&str> = plan.groups.iter().flat_map(|g| g.sentence_ids.iter().map(String::as_str)).collect();
        assert_eq!(flattened, vec!["s1", "s2", "s3", "s4"]);
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn create_plan_group_at_a_scene_seam_without_force_stays_in_the_current_scene() {
        // The actual bug this default protects against: a scene with only
        // one or two stills has NO valid split point that isn't also a
        // scene seam (its only still's boundaries border neighboring
        // scenes) — so the old "always promote to a new scene at a seam"
        // behavior meant "create a new still" was unreachable for exactly
        // the small scenes it's needed on most. Without force_new_scene,
        // dropping at a seam must just split the still and keep both
        // halves in whichever scene the sentence already belonged to.
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        seed_plan_with_scenes(&repo, &video.id, &[2, 2]); // sc1={s1,s2} g1(s1),g2(s2); sc2={s3,s4} g3(s3),g4(s4)

        // Same drag as the solo-sentence seam test above, but without the
        // Shift modifier: s2 is scene 1's last (solo) still, dropped at the
        // divider right after it — exactly the seam with scene 2.
        let plan = repo.create_plan_group(&video.id, "s2", 2, false).unwrap();

        assert_eq!(plan.scenes.len(), 2, "no new scene should be created without force_new_scene");
        let scene1 = plan.scenes.iter().find(|s| s.ordinal == 1).unwrap();
        assert_eq!(scene1.sentence_ids, vec!["s1", "s2"], "s2 stays in scene 1, its ambient scene");
        let new_group = plan.groups.iter().find(|g| g.sentence_ids == vec!["s2".to_string()]).unwrap();
        assert_eq!(new_group.scene_id.as_deref(), Some(scene1.id.as_str()), "the new still joins scene 1, not a new scene");
        let flattened: Vec<&str> = plan.groups.iter().flat_map(|g| g.sentence_ids.iter().map(String::as_str)).collect();
        assert_eq!(flattened, vec!["s1", "s2", "s3", "s4"], "chronological order is unaffected");
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn create_plan_group_inside_a_scene_does_not_create_a_new_scene() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        // One scene spanning g1(s1), g2(s2,s3), g3(s4) — splitting inside it
        // must not create a new scene, since both neighbors of the split
        // already share the same scene. g2 starts with 2 sentences (not a
        // solo still) so removing just its last one doesn't empty/remove
        // the group, keeping indices stable.
        let sentences: Vec<PlanSentence> = (1..=4).map(|n| PlanSentence {
            id: format!("s{n}"), ordinal: n, text: format!("Sentence {n}."),
            start_seconds: n as f64, end_seconds: n as f64 + 1.0,
        }).collect();
        let mut groups = vec![
            PlanGroup { id: "g1".into(), ordinal: 1, label: "Still 1".into(), kind: "custom".into(), sentence_ids: vec!["s1".into()], settings_locked: false, prompt_locked: false, scene_id: None },
            PlanGroup { id: "g2".into(), ordinal: 2, label: "Still 2".into(), kind: "custom".into(), sentence_ids: vec!["s2".into(), "s3".into()], settings_locked: false, prompt_locked: false, scene_id: None },
            PlanGroup { id: "g3".into(), ordinal: 3, label: "Still 3".into(), kind: "custom".into(), sentence_ids: vec!["s4".into()], settings_locked: false, prompt_locked: false, scene_id: None },
        ];
        let mut scenes = vec![
            PlanScene { id: "sc1".into(), ordinal: 1, label: "Scene".into(), narrative_role: None, core_idea: None, emotional_state: None, visual_opportunities: Vec::new(), sentence_ids: vec!["s1".into(), "s2".into(), "s3".into(), "s4".into()], expanded: true },
        ];
        assign_scene_ids(&mut groups, &scenes);
        repo.save_plan(&video.id, &sentences, &groups, &scenes, true, "test").unwrap();
        repo.save_plan(&video.id, &sentences, &groups, &scenes, false, "test").unwrap();
        let scene_before = scenes[0].clone();

        // s3 is the last sentence of g2 — drop it at the divider right
        // after g2 (between g2 and g3, both already inside the one scene).
        let plan = repo.create_plan_group(&video.id, "s3", 2, false).unwrap();

        assert_eq!(plan.scenes.len(), 1, "splitting inside one scene must not create a new scene");
        assert_eq!(plan.scenes[0].sentence_ids, scene_before.sentence_ids, "the scene's own range is unchanged by an intra-scene split");
        let new_group = plan.groups.iter().find(|g| g.sentence_ids == vec!["s3".to_string()]).unwrap();
        assert_eq!(new_group.scene_id.as_deref(), Some(plan.scenes[0].id.as_str()));
        assert_no_group_straddles_two_scenes(&plan);
    }

    #[test]
    fn scene_boundaries_stay_consistent_across_a_sequence_of_boundary_edits() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        seed_plan_with_scenes(&repo, &video.id, &[2, 2, 2]); // sc1={s1,s2} sc2={s3,s4} sc3={s5,s6}

        // Move the boundary between scene 1 and scene 2 forward by one
        // sentence (s2 crosses into scene 2)...
        let after_first_move = repo.move_plan_sentence(&video.id, "s2", "g3").unwrap();
        assert_no_group_straddles_two_scenes(&after_first_move);
        assert_eq!(after_first_move.scenes.len(), 3, "no scene emptied out yet");
        let scene1 = after_first_move.scenes.iter().find(|s| s.ordinal == 1).unwrap();
        let scene2 = after_first_move.scenes.iter().find(|s| s.ordinal == 2).unwrap();
        assert_eq!(scene1.sentence_ids, vec!["s1"]);
        assert_eq!(scene2.sentence_ids, vec!["s2", "s3", "s4"]);

        // ...then move the boundary between scene 2 and scene 3 backward by
        // one sentence (s4 crosses back out of scene 2, into scene 3) —
        // two independent boundary edits in a row must both leave every
        // still cleanly inside exactly one scene.
        let group_containing_s5 = after_first_move.groups.iter()
            .find(|g| g.sentence_ids.contains(&"s5".to_string())).unwrap().id.clone();
        let after_second_move = repo.move_plan_sentence(&video.id, "s4", &group_containing_s5).unwrap();
        assert_no_group_straddles_two_scenes(&after_second_move);
        assert_eq!(after_second_move.scenes.len(), 3);
        let scene2_final = after_second_move.scenes.iter().find(|s| s.ordinal == 2).unwrap();
        let scene3_final = after_second_move.scenes.iter().find(|s| s.ordinal == 3).unwrap();
        assert_eq!(scene2_final.sentence_ids, vec!["s2", "s3"]);
        assert_eq!(scene3_final.sentence_ids, vec!["s4", "s5", "s6"]);
    }

    #[test]
    fn scene_expanded_state_toggles_and_survives_unrelated_edits_but_not_reset() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let original = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let scene_id = original.scenes[0].id.clone();
        assert!(original.scenes[0].expanded);

        let collapsed = repo.set_plan_scene_expanded(&video.id, &scene_id, false).unwrap();
        assert!(!collapsed.scenes.iter().find(|s| s.id == scene_id).unwrap().expanded);

        // A fresh read must see the same persisted state, not just the
        // in-memory return value.
        assert!(
            !repo.get_visual_plan(&video.id).unwrap().scenes.iter().find(|s| s.id == scene_id).unwrap().expanded
        );

        // Reset restores the generation-time default (expanded) along with
        // everything else — see set_plan_scene_expanded's doc comment.
        let reset = repo.reset_visual_plan(&video.id).unwrap();
        assert!(reset.scenes.iter().find(|s| s.id == scene_id).unwrap().expanded);

        assert!(repo.set_plan_scene_expanded(&video.id, "not-a-real-scene", true).is_err());
    }

    #[test]
    fn plan_match_flag_survives_a_fresh_read_and_flips_when_pacing_changes() {
        // Regression test: "does the existing plan match current inputs"
        // used to live only in frontend state, reconstructed from whatever
        // video_inputs held *right now* on every hydration — so after a
        // full app restart it always reported "matches," even right after
        // switching pacing presets and never regenerating. This asserts
        // the match flag is derived from what was actually used at
        // generation time, not from current video_inputs.
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();

        // No plan generated yet: no opinion either way.
        assert_eq!(
            repo.get_video_inputs(&video.id).unwrap().plan_matches_current_inputs,
            None
        );

        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert_eq!(
            repo.get_video_inputs(&video.id).unwrap().plan_matches_current_inputs,
            Some(true)
        );

        // Changing pacing after generation must flip the flag — and, since
        // this is read straight from the database (not frontend state),
        // this simulates the flag surviving a full app restart.
        repo.save_video_pacing(&video.id, "per-sentence", 3, 6).unwrap();
        assert_eq!(
            repo.get_video_inputs(&video.id).unwrap().plan_matches_current_inputs,
            Some(false)
        );

        // Regenerating brings it back in sync.
        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert_eq!(
            repo.get_video_inputs(&video.id).unwrap().plan_matches_current_inputs,
            Some(true)
        );
    }

    #[test]
    fn splits_and_merges_plan_sentences_keeping_ids_consistent() {
        // Regression test: the first version of split_plan_sentence/
        // merge_plan_sentences renumbered group `sentence_ids` references
        // but never renumbered the sentences table's OWN ids, leaving
        // groups pointing at sentence ids that didn't exist — crashed the
        // Visual Plan view with "Cannot read properties of undefined
        // (reading 'startSeconds')" as soon as it tried to resolve a
        // group's members.
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let original = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert!(original.sentences.len() >= 3);

        fn assert_groups_reference_real_sentences(plan: &VisualPlan) {
            for group in &plan.groups {
                for id in &group.sentence_ids {
                    assert!(
                        plan.sentences.iter().any(|s| &s.id == id),
                        "group {} references missing sentence {id}",
                        group.id
                    );
                }
            }
        }

        fn assert_ids_are_gapless(plan: &VisualPlan) {
            let mut numbers: Vec<i64> = plan.sentences.iter().map(|s| sentence_number(&s.id)).collect();
            numbers.sort();
            for pair in numbers.windows(2) {
                assert_eq!(pair[1], pair[0] + 1, "sentence ids are not gapless: {numbers:?}");
            }
        }

        // A group's scene_id (if set) must point at a scene that actually
        // exists, and every scene's own sentence_ids must reference real,
        // still-existing sentences — both invariants a split/merge's
        // renumbering pass has to preserve alongside the sentence-id ones
        // above.
        fn assert_scenes_are_consistent(plan: &VisualPlan) {
            for group in &plan.groups {
                if let Some(scene_id) = &group.scene_id {
                    assert!(
                        plan.scenes.iter().any(|scene| &scene.id == scene_id),
                        "group {} references missing scene {scene_id}",
                        group.id
                    );
                }
            }
            for scene in &plan.scenes {
                for id in &scene.sentence_ids {
                    assert!(
                        plan.sentences.iter().any(|s| &s.id == id),
                        "scene {} references missing sentence {id}",
                        scene.id
                    );
                }
            }
        }

        let first = original.sentences[0].clone();
        let offset = (first.text.len() / 2).max(1);
        let (left_text, right_text) = first.text.split_at(offset);
        let after_split = repo.split_plan_sentence(&video.id, &first.id, left_text, right_text).unwrap();
        assert_eq!(after_split.sentences.len(), original.sentences.len() + 1);
        assert_groups_reference_real_sentences(&after_split);
        assert_ids_are_gapless(&after_split);
        assert_scenes_are_consistent(&after_split);

        let merged = repo
            .merge_plan_sentences(&video.id, &after_split.sentences[0].id, &after_split.sentences[1].id)
            .unwrap();
        assert_eq!(merged.sentences.len(), original.sentences.len());
        assert_groups_reference_real_sentences(&merged);
        assert_ids_are_gapless(&merged);
        assert_scenes_are_consistent(&merged);
        assert_eq!(merged.sentences[0].text, first.text);
    }

    #[test]
    fn merging_sentences_strips_the_join_period_so_it_can_be_resplit() {
        // The left half of a real split always ends with a plain "." (it's
        // where the user's cursor was) — merging back should drop exactly
        // that period so typing "." at the same spot re-triggers a split,
        // round-tripping cleanly, while the merged sentence's OWN final
        // punctuation (from the absorbed second half) must survive intact.
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let original = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert!(original.sentences.len() >= 2);
        assert!(original.sentences[0].text.ends_with('.'));

        let merged = repo
            .merge_plan_sentences(&video.id, &original.sentences[0].id, &original.sentences[1].id)
            .unwrap();
        let joined = &merged.sentences[0].text;
        assert!(
            !joined.contains(". "),
            "join point should have no period left in it: {joined:?}"
        );
        assert!(
            joined.ends_with('.'),
            "the merged sentence's own trailing punctuation (from the second half) must survive: {joined:?}"
        );
    }

    #[test]
    fn reset_visual_plan_is_a_true_factory_reset_of_sentences_too() {
        // Before this, reset_visual_plan only restored GROUP boundaries —
        // sentence text/splits/merges were permanent, with no way back.
        // Requested explicitly: "reset original" should restore everything
        // to exactly how it was right after generation.
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(
            &video.id,
            "One short sentence. A second sentence follows. The final sentence closes.",
            4,
        )
        .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let original = repo.generate_visual_plan(&video.id, temp.path()).unwrap();

        // Mutate sentences three different ways: edit text, merge two, and
        // (on what's left) split one — all should be undone by reset.
        repo.update_plan_sentence_text(&video.id, &original.sentences[2].id, "A rewritten third sentence.")
            .unwrap();
        let after_merge = repo
            .merge_plan_sentences(&video.id, &original.sentences[0].id, &original.sentences[1].id)
            .unwrap();
        let merged_text = &after_merge.sentences[0].text;
        let (left_text, right_text) = merged_text.split_at(5.min(merged_text.len()));
        repo.split_plan_sentence(&video.id, &after_merge.sentences[0].id, left_text, right_text).unwrap();

        // Merge (3->2 sentences) then split (2->3) nets back to the same
        // COUNT by coincidence — text is the reliable signal that the plan
        // actually diverged from its generated state.
        let mutated = repo.get_visual_plan(&video.id).unwrap();
        assert_ne!(mutated.sentences[0].text, original.sentences[0].text);

        let reset = repo.reset_visual_plan(&video.id).unwrap();
        assert_eq!(reset.sentences, original.sentences);
        assert_eq!(reset.groups, original.groups);
        assert_eq!(reset.scenes, original.scenes);
    }

    #[test]
    fn rejects_non_chronological_group_sequences() {
        let groups = vec![
            PlanGroup {
                id: "g1".into(),
                ordinal: 1,
                label: "First".into(),
                kind: "still".into(),
                sentence_ids: vec!["s1".into(), "s3".into()],
                settings_locked: false,
                prompt_locked: false,
                scene_id: None,
            },
            PlanGroup {
                id: "g2".into(),
                ordinal: 2,
                label: "Second".into(),
                kind: "still".into(),
                sentence_ids: vec!["s2".into()],
                settings_locked: false,
                prompt_locked: false,
                scene_id: None,
            },
        ];
        assert!(validate_group_chronology(&groups).is_err());
    }

    #[test]
    fn visual_plan_ids_are_scoped_per_video() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        for title in ["First", "Second"] {
            let video = repo.create_video(&channel.id, title).unwrap();
            let audio = temp.path().join(format!("{title}.wav"));
            fs::write(&audio, b"audio").unwrap();
            repo.save_video_inputs(&video.id, "One. Two. Three.", 6)
                .unwrap();
            repo.import_asset(&video.id, &audio, "audio").unwrap();
            let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
            assert_eq!(plan.sentences[0].id, "s1");
            assert_eq!(plan.groups[0].id, "g1");
            assert_eq!(plan.scenes[0].id, "sc1");
        }
    }

    #[test]
    fn persists_prompt_versions_and_image_workspace_settings() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "A complete scene.", 8)
            .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        repo.save_app_setting("gemini_model", "gemini-2.5-flash-image")
            .unwrap();
        let first = repo
            .create_prompt_version(
                &video.id,
                &plan.groups[0].id,
                r#"{"aspectRatio":"16:9"}"#,
                "Create a cinematic documentary still.",
                "A deep ocean scene.",
            )
            .unwrap();
        let second = repo
            .create_prompt_version(
                &video.id,
                &plan.groups[0].id,
                r#"{"aspectRatio":"16:9"}"#,
                "Create a cinematic documentary still.",
                "A wider deep ocean scene.",
            )
            .unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(second.version, 2);
        let workspace = repo.get_image_workspace(&video.id).unwrap();
        assert_eq!(workspace.sentences[0].text, "A complete scene.");
        assert_eq!(workspace.groups[0].prompt_versions[0].version, 2);
        assert_eq!(workspace.settings[0].key, "gemini_model");
    }

    #[test]
    fn rejects_invalid_prompt_layers() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        assert!(repo
            .create_prompt_version(&video.id, "g1", "not-json", "system", "scene")
            .is_err());
        assert!(repo
            .create_prompt_version(&video.id, "g1", "{}", "", "scene")
            .is_err());
        assert!(repo
            .create_prompt_version(&video.id, "g1", "{}", "system", "")
            .is_err());
    }

    #[test]
    fn repairs_repetitive_bulk_planner_visual_types() {
        let mut planned: Vec<V2PlanStillResponse> = (1..=5)
            .map(|index| V2PlanStillResponse {
                visual_plan_row_id: format!("g{index}"),
                visual_type: "Character Scene".into(),
                image_settings: json!({}),
                user_prompt: format!("Scene {index}"),
                reason: String::new(),
                core_visual_device: String::new(),
            })
            .collect();
        let row_data: Vec<serde_json::Value> = (1..=5)
            .map(|index| {
                json!({
                    "visualPlanRowId": format!("g{index}"),
                    "settingsLocked": false,
                    "promptLocked": false
                })
            })
            .collect();

        repair_excessive_consecutive_visual_types(&mut planned, &row_data, "", 0);

        assert!(planned
            .windows(4)
            .all(|window| !window.iter().all(|plan| plan.visual_type == window[0].visual_type)));
        assert_eq!(planned[0].visual_type, "Character Scene");
        assert_ne!(planned[3].visual_type, "Character Scene");
    }

    #[test]
    fn repair_visual_types_honors_a_run_already_in_progress_from_a_prior_batch() {
        // A run of 3 "Character Scene" already ended the PREVIOUS batch (as
        // plan_bulk_visuals_batch reconstructs from bulk_plan_prior_context)
        // — this batch's very first item continuing that same type should
        // trip the repair immediately, not need 3 more of its own first.
        let mut planned: Vec<V2PlanStillResponse> = (1..=2)
            .map(|index| V2PlanStillResponse {
                visual_plan_row_id: format!("g{index}"),
                visual_type: "Character Scene".into(),
                image_settings: json!({}),
                user_prompt: format!("Scene {index}"),
                reason: String::new(),
                core_visual_device: String::new(),
            })
            .collect();
        let row_data: Vec<serde_json::Value> = (1..=2)
            .map(|index| json!({ "visualPlanRowId": format!("g{index}"), "settingsLocked": false, "promptLocked": false }))
            .collect();

        repair_excessive_consecutive_visual_types(&mut planned, &row_data, "Character Scene", 3);

        assert_ne!(planned[0].visual_type, "Character Scene");
    }

    #[test]
    fn persist_bulk_planned_still_saves_prompt_and_educational_plan() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let group = &plan.groups[0];
        let row = json!({
            "ordinal": group.ordinal, "narration": "First scene.", "startSeconds": 0.0, "endSeconds": 2.0,
        });
        let still = V2PlanStillResponse {
            visual_plan_row_id: group.id.clone(),
            visual_type: "Character Scene".into(),
            image_settings: json!({ "mood": "Hopeful" }),
            user_prompt: "A hopeful scene.".into(),
            reason: "Fits the narration.".into(),
            core_visual_device: "lantern".into(),
        };

        let saved = repo.persist_bulk_planned_still(&video.id, "Cinematic style", group, &row, still)
            .unwrap()
            .expect("should have persisted");
        assert_eq!(saved.visual_type, "Character Scene");
        assert_eq!(saved.user_prompt, "A hopeful scene.");

        let pv = repo.list_prompt_versions(&video.id, &group.id).unwrap().into_iter().next().unwrap();
        assert_eq!(pv.user_prompt, "A hopeful scene.");
        assert_eq!(pv.system_prompt, "Cinematic style");
        let settings: serde_json::Value = serde_json::from_str(&pv.settings_json).unwrap();
        assert_eq!(settings["mood"], "Hopeful");
        // Embedded so a later batch's prior-context can read it back (see
        // bulk_plan_prior_context) without a schema migration.
        assert_eq!(settings["_coreVisualDevice"], "lantern");

        let educational = repo.get_educational_visual_plan(&video.id, &group.id).unwrap().unwrap();
        assert_eq!(educational.visual_intent, "Character Scene");
        assert_eq!(educational.user_prompt, "A hopeful scene.");
    }

    #[test]
    fn persist_bulk_planned_still_respects_locked_fields_and_skips_fully_locked() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let mut group = plan.groups[0].clone();
        let row = json!({ "ordinal": group.ordinal, "narration": "First scene.", "startSeconds": 0.0, "endSeconds": 2.0 });

        // Establish a v1 to lock onto.
        let first = V2PlanStillResponse {
            visual_plan_row_id: group.id.clone(), visual_type: "Object Focus".into(),
            image_settings: json!({ "mood": "Serene Peaceful" }), user_prompt: "Original prompt.".into(),
            reason: String::new(), core_visual_device: String::new(),
        };
        repo.persist_bulk_planned_still(&video.id, "Style", &group, &row, first).unwrap();

        // Settings locked, prompt NOT locked: the AI's new settings must be
        // ignored in favor of what's already saved, but the prompt is free
        // to update.
        group.settings_locked = true;
        group.prompt_locked = false;
        let second = V2PlanStillResponse {
            visual_plan_row_id: group.id.clone(), visual_type: "Object Focus".into(),
            image_settings: json!({ "mood": "Dramatic Intense" }), user_prompt: "An updated prompt.".into(),
            reason: String::new(), core_visual_device: String::new(),
        };
        let saved = repo.persist_bulk_planned_still(&video.id, "Style", &group, &row, second).unwrap()
            .expect("a partially-locked still still persists a new version");
        assert_eq!(saved.user_prompt, "An updated prompt.");
        assert_eq!(saved.image_settings["mood"], "Serene Peaceful");

        // Fully locked (both) is treated as "nothing to do" — no new version at all.
        group.prompt_locked = true;
        let before_count = repo.list_prompt_versions(&video.id, &group.id).unwrap().len();
        let third = V2PlanStillResponse {
            visual_plan_row_id: group.id.clone(), visual_type: "Object Focus".into(),
            image_settings: json!({}), user_prompt: "Yet another prompt.".into(),
            reason: String::new(), core_visual_device: String::new(),
        };
        let result = repo.persist_bulk_planned_still(&video.id, "Style", &group, &row, third).unwrap();
        assert!(result.is_none());
        assert_eq!(repo.list_prompt_versions(&video.id, &group.id).unwrap().len(), before_count);
    }

    /// Directly inserts `count` one-sentence-each groups (bypassing the
    /// heuristic auto-grouper's own duration-driven merging, which can't
    /// be relied on to produce an exact group count from short fixture
    /// sentences) — mirrors the same fixture pattern
    /// `project_bundle_remaps_prefix_colliding_sequential_ids` uses.
    /// Returns the resulting `VisualPlan`.
    fn seed_one_group_per_sentence(repo: &ProjectRepository, video_id: &str, count: i64) -> VisualPlan {
        repo.connection.execute(
            "INSERT INTO visual_plan_meta(video_id,timing_source,generated_at,updated_at) VALUES(?1,'test',?2,?2)",
            params![video_id, Utc::now().to_rfc3339()],
        ).unwrap();
        for n in 1..=count {
            let sentence_id = format!("{video_id}::s{n}");
            repo.connection.execute(
                "INSERT INTO visual_plan_sentences(id,video_id,ordinal,text,start_seconds,end_seconds) VALUES(?1,?2,?3,?4,?5,?6)",
                params![sentence_id, video_id, n, format!("Sentence {n}."), (n - 1) as f64 * 2.0, n as f64 * 2.0],
            ).unwrap();
            let group_id = format!("{video_id}::current::g{n}");
            repo.connection.execute(
                "INSERT INTO visual_plan_groups(id,video_id,ordinal,label,kind,sentence_ids_json,is_original) VALUES(?1,?2,?3,?4,'subject',?5,0)",
                params![group_id, video_id, n, format!("Scene {n}"), serde_json::to_string(&vec![format!("s{n}")]).unwrap()],
            ).unwrap();
        }
        repo.get_visual_plan(video_id).unwrap()
    }

    #[test]
    fn bulk_plan_prior_context_reads_back_core_visual_device() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let plan = seed_one_group_per_sentence(&repo, &video.id, 2);
        let group0 = &plan.groups[0];
        let row0 = json!({ "ordinal": group0.ordinal, "narration": "First scene.", "startSeconds": 0.0, "endSeconds": 2.0 });
        let still = V2PlanStillResponse {
            visual_plan_row_id: group0.id.clone(), visual_type: "Object Focus".into(),
            image_settings: json!({ "mood": "Hopeful", "lighting": "Golden Hour" }),
            user_prompt: "A lantern glowing in the dark.".into(),
            reason: String::new(), core_visual_device: "lantern".into(),
        };
        repo.persist_bulk_planned_still(&video.id, "Style", group0, &row0, still).unwrap();

        let context = repo.bulk_plan_prior_context(&video.id, &plan.groups, 1, 12).unwrap();
        assert_eq!(context.len(), 1);
        assert_eq!(context[0]["visualType"], "Object Focus");
        assert_eq!(context[0]["coreVisualDevice"], "lantern");
        assert_eq!(context[0]["lighting"], "Golden Hour");

        // Nothing precedes the very first group.
        let empty_context = repo.bulk_plan_prior_context(&video.id, &plan.groups, 0, 12).unwrap();
        assert!(empty_context.is_empty());
    }

    #[test]
    fn write_bulk_prompt_log_contains_narration_and_prompt() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "A lantern flickers in the dark.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let group = &plan.groups[0];
        let row = json!({ "ordinal": group.ordinal, "narration": "A lantern flickers in the dark.", "startSeconds": 0.0, "endSeconds": 2.0 });
        let still = V2PlanStillResponse {
            visual_plan_row_id: group.id.clone(), visual_type: "Object Focus".into(),
            image_settings: json!({}), user_prompt: "A brass lantern casting long shadows.".into(),
            reason: String::new(), core_visual_device: "lantern".into(),
        };
        repo.persist_bulk_planned_still(&video.id, "Style", group, &row, still).unwrap();

        repo.write_bulk_prompt_log(&video.id).unwrap();

        let channel_id = channel.id.clone();
        let log_path = temp.path().join("Projects").join(&channel_id).join(&video.id).join("visual-plan").join("prompt-log.md");
        let contents = fs::read_to_string(&log_path).unwrap();
        assert!(contents.contains("A lantern flickers in the dark."));
        assert!(contents.contains("A brass lantern casting long shadows."));
    }

    #[test]
    fn analyze_motion_graphics_batch_resumes_and_skips_completed_clips() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        // 7 groups/stills, so with MOTION_GRAPHICS_BATCH_SIZE = 5 this needs
        // two batches to fully resolve.
        let plan = seed_one_group_per_sentence(&repo, &video.id, 7);
        for group in &plan.groups {
            let prompt = repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene").unwrap();
            let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join(&group.id);
            fs::create_dir_all(&render_dir).unwrap();
            fs::write(render_dir.join("render-v1.png"), b"bytes").unwrap();
            repo.insert_image_render(
                &format!("render-{}", group.id), &video.id, &group.id, 1, &prompt.id, "render-v1.png",
                &format!("renders/{}/render-v1.png", group.id), None, None, "generation",
            ).unwrap();
        }
        repo.build_timeline(&video.id).unwrap();

        let total_clips = plan.groups.len();
        assert!(total_clips > MOTION_GRAPHICS_BATCH_SIZE, "test needs more than one batch to be meaningful");

        let first = repo.analyze_motion_graphics_batch(&video.id, temp.path()).unwrap();
        assert_eq!(first.completed, MOTION_GRAPHICS_BATCH_SIZE);
        assert_eq!(first.total, total_clips);
        assert!(!first.done);

        let timeline_after_first = repo.get_timeline(&video.id).unwrap();
        let analyzed_after_first = timeline_after_first.clips.iter().filter(|c| c.motion_graphic_effect.is_some()).count();
        assert_eq!(analyzed_after_first, MOTION_GRAPHICS_BATCH_SIZE);

        let second = repo.analyze_motion_graphics_batch(&video.id, temp.path()).unwrap();
        assert_eq!(second.completed, total_clips);
        assert!(second.done);

        // A third call (e.g. the frontend calling once more before noticing
        // `done`) must be a safe no-op, not reprocess anything.
        let third = repo.analyze_motion_graphics_batch(&video.id, temp.path()).unwrap();
        assert_eq!(third.completed, total_clips);
        assert!(third.done);
    }

    /// A manual edit (the settings panel) must never disturb what Auto
    /// Motion originally composed — `reset_timeline_clip_motion_graphic_to_ai`
    /// depends on the snapshot surviving untouched underneath any number of
    /// live edits.
    #[test]
    fn manual_motion_edit_resets_back_to_what_auto_motion_composed() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let plan = seed_one_group_per_sentence(&repo, &video.id, 1);
        let group = &plan.groups[0];
        let prompt = repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene").unwrap();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join(&group.id);
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"bytes").unwrap();
        repo.insert_image_render(
            "render-1", &video.id, &group.id, 1, &prompt.id, "render-v1.png",
            &format!("renders/{}/render-v1.png", group.id), None, None, "generation",
        ).unwrap();
        repo.build_timeline(&video.id).unwrap();

        let result = repo.analyze_motion_graphics_batch(&video.id, temp.path()).unwrap();
        assert!(result.done);
        let timeline = repo.get_timeline(&video.id).unwrap();
        let clip = timeline.clips.iter().find(|c| c.render_id.is_some()).unwrap();
        let ai_effect = clip.motion_graphic_effect.clone().unwrap();
        let ai_settings = clip.motion_graphic_settings_json.clone().unwrap();
        assert!(clip.motion_graphic_ai_snapshot_json.is_some(), "Auto Motion should have recorded a snapshot");
        let clip_id = clip.id.clone();

        // Simulate a manual edit in MotionSettingsPanel — a different effect
        // label and recipe entirely.
        repo.set_timeline_clip_motion_graphic(
            &video.id, &clip_id, Some("manual override"), Some(r#"{"cameraEffect":"zoom_out"}"#), Some("hand-picked"),
        ).unwrap();
        let after_edit = repo.get_timeline(&video.id).unwrap();
        let edited_clip = after_edit.clips.iter().find(|c| c.id == clip_id).unwrap();
        assert_eq!(edited_clip.motion_graphic_effect.as_deref(), Some("manual override"));
        // The snapshot must be untouched by the manual edit.
        assert!(edited_clip.motion_graphic_ai_snapshot_json.is_some());

        let restored = repo.reset_timeline_clip_motion_graphic_to_ai(&video.id, &clip_id).unwrap();
        let restored_clip = restored.clips.iter().find(|c| c.id == clip_id).unwrap();
        assert_eq!(restored_clip.motion_graphic_effect.as_deref(), Some(ai_effect.as_str()));
        assert_eq!(restored_clip.motion_graphic_settings_json.as_deref(), Some(ai_settings.as_str()));
    }

    /// A clip Auto Motion never analyzed (e.g. composed entirely by hand via
    /// "start from scratch") has no snapshot to reset to — must error
    /// clearly rather than silently clearing the manually-authored recipe.
    #[test]
    fn reset_to_ai_errors_when_clip_was_never_analyzed_by_auto_motion() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let plan = seed_one_group_per_sentence(&repo, &video.id, 1);
        let group = &plan.groups[0];
        let prompt = repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene").unwrap();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join(&group.id);
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"bytes").unwrap();
        repo.insert_image_render(
            "render-1", &video.id, &group.id, 1, &prompt.id, "render-v1.png",
            &format!("renders/{}/render-v1.png", group.id), None, None, "generation",
        ).unwrap();
        repo.build_timeline(&video.id).unwrap();
        let timeline = repo.get_timeline(&video.id).unwrap();
        let clip = timeline.clips.iter().find(|c| c.render_id.is_some()).unwrap();

        // Hand-composed via "start from scratch" — never touched Auto Motion.
        repo.set_timeline_clip_motion_graphic(
            &video.id, &clip.id, Some("Manual: Push In"), Some(r#"{"cameraEffect":"push_in"}"#), None,
        ).unwrap();

        let err = repo.reset_timeline_clip_motion_graphic_to_ai(&video.id, &clip.id).unwrap_err();
        assert!(err.contains("no AI-composed motion"), "unexpected error: {err}");
    }

    #[test]
    fn extracts_json_when_prompt_suggestion_has_trailing_text() {
        let raw = "{\"plans\":[{\"visualPlanRowId\":\"g1\"}]}\nDone.";

        assert_eq!(extract_json_from_text(raw), "{\"plans\":[{\"visualPlanRowId\":\"g1\"}]}");
    }

    #[test]
    fn extracts_first_json_when_prompt_suggestion_repeats_json() {
        let raw = "{\"plans\":[{\"visualPlanRowId\":\"g1\"}]}\n{\"extra\":true}";

        assert_eq!(extract_json_from_text(raw), "{\"plans\":[{\"visualPlanRowId\":\"g1\"}]}");
    }

    #[test]
    fn creates_and_controls_persistent_bulk_jobs() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4)
            .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let group_ids: Vec<String> = plan.groups.iter().map(|group| group.id.clone()).collect();
        for group in plan.groups {
            repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene")
                .unwrap();
        }
        let job = repo.create_image_job(&video.id, &group_ids).unwrap();
        assert_eq!(job.total_items, job.items.len() as i64);
        assert_eq!(
            repo.set_image_job_status(&job.id, "paused").unwrap().status,
            "paused"
        );
        assert_eq!(
            repo.set_image_job_status(&job.id, "queued").unwrap().status,
            "queued"
        );
        let claimed = repo.claim_job_item(&job.id).unwrap().unwrap();
        let stopped = repo.set_image_job_status(&job.id, "stopped").unwrap();
        assert_eq!(stopped.status, "stopped");
        assert!(stopped.items.iter().all(|item| item.status == "stopped"));
        repo.finish_job_item(&job.id, &claimed.0, Err("late provider response".into()))
            .unwrap();
        let after_late_result = repo.get_image_job(&job.id).unwrap();
        assert_eq!(after_late_result.status, "stopped");
        assert_eq!(after_late_result.failed_items, 0);
        assert!(repo.claim_job_item(&job.id).unwrap().is_none());
        let refreshed_plan = repo.get_visual_plan(&video.id).unwrap();
        let group = &refreshed_plan.groups[0];
        let prompt = repo.list_prompt_versions(&video.id, &group.id).unwrap()[0].clone();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join(&group.id);
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("reset-test.png"), b"image").unwrap();
        repo.insert_image_render("reset-render", &video.id, &group.id, 1, &prompt.id, "reset-test.png", &format!("renders/{}/reset-test.png", group.id), None, None, "generation").unwrap();
        repo.build_timeline(&video.id).unwrap();
        repo.reset_image_workflow(&video.id).unwrap();
        let workspace = repo.get_image_workspace(&video.id).unwrap();
        assert!(workspace.groups.iter().all(|group| group.prompt_versions.is_empty() && group.image_renders.is_empty() && group.educational_plan.is_none()));
        assert!(repo.latest_image_job(&video.id).unwrap().is_none());
    }

    fn scene_tagged_group(ordinal: i64, scene_id: Option<&str>) -> PlanGroup {
        PlanGroup {
            id: format!("g{ordinal}"),
            ordinal,
            label: format!("Still {ordinal}"),
            kind: "still".into(),
            sentence_ids: vec![format!("s{ordinal}")],
            settings_locked: false,
            prompt_locked: false,
            scene_id: scene_id.map(str::to_string),
        }
    }

    #[test]
    fn bulk_batch_chunk_end_never_crosses_a_scene_boundary() {
        // 2 stills in "sc1", 5 in "sc2" (bigger than the chunk_size cap
        // below), 1 with no scene at all — see the Bulk Generation redesign
        // plan's "dynamic, scene-bounded chunking" requirement.
        let groups: Vec<PlanGroup> = vec![
            scene_tagged_group(1, Some("sc1")),
            scene_tagged_group(2, Some("sc1")),
            scene_tagged_group(3, Some("sc2")),
            scene_tagged_group(4, Some("sc2")),
            scene_tagged_group(5, Some("sc2")),
            scene_tagged_group(6, Some("sc2")),
            scene_tagged_group(7, Some("sc2")),
            scene_tagged_group(8, None),
        ];
        // sc1 (2 stills) fits in one chunk even though the cap is higher.
        assert_eq!(bulk_batch_chunk_end(&groups, 0, 6), 2);
        // sc2 (5 stills) also fits under a generous cap — the whole scene is
        // one batch.
        assert_eq!(bulk_batch_chunk_end(&groups, 2, 6), 7);
        // The same scene under a tight cap (3) takes multiple calls, each
        // still entirely inside sc2 — never spilling into the no-scene tail.
        assert_eq!(bulk_batch_chunk_end(&groups, 2, 3), 5);
        assert_eq!(bulk_batch_chunk_end(&groups, 5, 3), 7);
        // A lone no-scene still is its own one-item chunk.
        assert_eq!(bulk_batch_chunk_end(&groups, 7, 6), 8);
    }

    #[test]
    fn resolve_effective_bulk_settings_layers_scene_override_over_global() {
        let global_visual = BulkGlobalVisualSettings::default();
        // No override at all — every field falls back to the global param.
        let none = resolve_effective_bulk_settings(None, "global style", "global rule", false, &global_visual);
        assert_eq!(none.style_directive, "global style");
        assert_eq!(none.creative_instruction, "global rule");
        assert!(!none.character_consistency);
        assert_eq!(none.reference_asset_id, None);
        assert!(!none.location_consistency);
        assert_eq!(none.location_reference_asset_id, None);

        // A partial override: only style_directive and character_consistency
        // are set, the rest stay null ("inherit").
        let partial = BulkSceneSettings {
            scene_id: "sc1".into(),
            style_directive: Some("scene style".into()),
            creative_instruction: None,
            character_consistency: Some(true),
            reference_asset_id: None,
            location_consistency: None,
            location_reference_asset_id: None,
            dials: BulkVisualDials::default(),
        };
        let resolved = resolve_effective_bulk_settings(Some(&partial), "global style", "global rule", false, &global_visual);
        assert_eq!(resolved.style_directive, "scene style");
        assert_eq!(resolved.creative_instruction, "global rule", "null override must inherit the global value");
        assert!(resolved.character_consistency);
        assert_eq!(resolved.reference_asset_id, None);

        // A blank-string override is treated the same as "not overridden" —
        // the frontend clears a field back to inherit by leaving it blank.
        let blank = BulkSceneSettings {
            scene_id: "sc1".into(),
            style_directive: Some("   ".into()),
            creative_instruction: None,
            character_consistency: None,
            reference_asset_id: Some("asset-1".into()),
            location_consistency: None,
            location_reference_asset_id: None,
            dials: BulkVisualDials::default(),
        };
        let resolved = resolve_effective_bulk_settings(Some(&blank), "global style", "global rule", true, &global_visual);
        assert_eq!(resolved.style_directive, "global style");
        assert!(resolved.character_consistency, "no override must fall back to the global param");
        assert_eq!(resolved.reference_asset_id, Some("asset-1".into()));
    }

    #[test]
    fn resolve_effective_bulk_settings_layers_location_and_dials() {
        let global_visual = BulkGlobalVisualSettings {
            location_consistency: Some(true),
            location_reference_asset_id: Some("global-location-asset".into()),
            dials: BulkVisualDials { visual_interpretation: Some(40), diversity_camera: Some(70), mood: Some("Hopeful".into()), ..Default::default() },
        };

        // No scene override at all — everything inherits from global,
        // including the location reference id (unlike the character
        // reference, which relies on reference_image_bytes' own fallback).
        let none = resolve_effective_bulk_settings(None, "style", "rule", false, &global_visual);
        assert!(none.location_consistency);
        assert_eq!(none.location_reference_asset_id.as_deref(), Some("global-location-asset"));
        assert_eq!(none.dials.visual_interpretation, Some(40));
        assert_eq!(none.dials.diversity_camera, Some(70));
        assert_eq!(none.dials.mood.as_deref(), Some("Hopeful"));
        assert_eq!(none.dials.visual_metaphor, None, "a dial never set at either level stays None");

        // A scene overriding only ONE dial and its own location reference —
        // every other dial, and location_consistency itself, still falls
        // back to global.
        let scene = BulkSceneSettings {
            scene_id: "sc1".into(),
            style_directive: None,
            creative_instruction: None,
            character_consistency: None,
            reference_asset_id: None,
            location_consistency: None,
            location_reference_asset_id: Some("scene-location-asset".into()),
            dials: BulkVisualDials { visual_interpretation: Some(90), ..Default::default() },
        };
        let resolved = resolve_effective_bulk_settings(Some(&scene), "style", "rule", false, &global_visual);
        assert!(resolved.location_consistency, "location_consistency itself isn't overridden, so it inherits");
        assert_eq!(resolved.location_reference_asset_id.as_deref(), Some("scene-location-asset"));
        assert_eq!(resolved.dials.visual_interpretation, Some(90), "scene's override wins");
        assert_eq!(resolved.dials.diversity_camera, Some(70), "un-overridden dial still inherits from global");
        assert_eq!(resolved.dials.mood.as_deref(), Some("Hopeful"));
    }

    #[test]
    fn aggregate_video_visual_history_tallies_percentages_across_the_whole_video() {
        let entries: Vec<(String, String)> = vec![
            ("Character Scene".into(), r#"{"lighting":"Golden Hour","colorTemperature":"Warm"}"#.into()),
            ("Character Scene".into(), r#"{"lighting":"Golden Hour","colorTemperature":"Warm"}"#.into()),
            ("Environmental Scene".into(), r#"{"lighting":"Natural Daylight","colorTemperature":"Neutral"}"#.into()),
            ("Object Focus".into(), r#"{"lighting":"Undefined","colorTemperature":"Cool"}"#.into()),
        ];
        let history = aggregate_video_visual_history(&entries);
        assert_eq!(history.total_planned, 4);
        assert_eq!(history.visual_type_counts.get("Character Scene"), Some(&2));
        assert_eq!(history.lighting_counts.get("Golden Hour"), Some(&2));
        assert_eq!(
            history.lighting_counts.get("Undefined"), None,
            "the placeholder value 'Undefined' must never be tallied as a real choice",
        );
        let summary = history.summary_text();
        assert!(summary.contains("visualType: Character Scene 50%"), "summary was: {summary}");
        assert!(summary.contains("lighting: Golden Hour 50%"), "summary was: {summary}");

        assert!(VideoVisualHistory::default().is_empty());
        assert!(!history.is_empty());
        assert_eq!(VideoVisualHistory::default().summary_text(), "");
    }

    #[test]
    fn format_story_context_block_combines_whole_video_and_scene_understanding() {
        let analyzed_scene = PlanScene {
            id: "sc1".into(), ordinal: 1, label: "Why Familiar Feels Safe".into(),
            narrative_role: Some("explanation".into()),
            core_idea: Some("Familiarity gets mistaken for actual safety.".into()),
            emotional_state: Some("uneasy".into()),
            visual_opportunities: vec!["comfort zones".into(), "invisible walls".into()],
            sentence_ids: vec!["s1".into()], expanded: true,
        };

        // Both halves present.
        let block = format_story_context_block("This video argues that comfort is often mistaken for safety.", Some(&analyzed_scene));
        assert!(block.contains("STORY CONTEXT"));
        assert!(block.contains("WHOLE VIDEO: This video argues that comfort is often mistaken for safety."));
        assert!(block.contains("THIS SCENE — \"Why Familiar Feels Safe\":"));
        assert!(block.contains("Narrative role: explanation"));
        assert!(block.contains("Core idea: Familiarity gets mistaken for actual safety."));
        assert!(block.contains("Emotional tone: uneasy"));
        assert!(block.contains("Visual opportunities to consider: comfort zones, invisible walls"));

        // Whole-video half only (e.g. this scene was never AI-analyzed —
        // created by a manual scene-boundary drag, which ships with empty
        // context per create_plan_group).
        let unanalyzed_scene = PlanScene {
            id: "sc2".into(), ordinal: 2, label: "Scene".into(),
            narrative_role: None, core_idea: None, emotional_state: None, visual_opportunities: Vec::new(),
            sentence_ids: vec!["s2".into()], expanded: true,
        };
        let whole_video_only = format_story_context_block("This video argues that comfort is often mistaken for safety.", Some(&unanalyzed_scene));
        assert!(whole_video_only.contains("WHOLE VIDEO:"));
        assert!(!whole_video_only.contains("THIS SCENE"), "an unanalyzed scene must not render an empty section: {whole_video_only}");

        // Scene half only (whole-script understanding not yet available —
        // first batch of a video, or the AI call failed).
        let scene_only = format_story_context_block("", Some(&analyzed_scene));
        assert!(!scene_only.contains("WHOLE VIDEO"));
        assert!(scene_only.contains("THIS SCENE"));

        // Neither half available at all — no section, not even an empty header.
        assert_eq!(format_story_context_block("", None), "");
        assert_eq!(format_story_context_block("   ", Some(&unanalyzed_scene)), "");
    }

    #[test]
    fn bulk_global_settings_round_trip_and_clear_back_to_default() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();

        assert_eq!(repo.get_bulk_global_settings(&video.id).unwrap(), BulkGlobalVisualSettings::default());

        let dials = BulkVisualDials { visual_interpretation: Some(65), mood: Some("Tense Anxious".into()), ..Default::default() };
        let saved = repo.save_bulk_global_settings(&video.id, Some(true), Some("loc-asset".into()), dials.clone()).unwrap();
        assert_eq!(saved.location_consistency, Some(true));
        assert_eq!(saved.dials.visual_interpretation, Some(65));

        let loaded = repo.get_bulk_global_settings(&video.id).unwrap();
        assert_eq!(loaded, saved);

        // Re-saving with an empty dials struct and location fields cleared
        // rolls it all the way back to the default shape, and upserts in
        // place rather than creating a second row.
        let cleared = repo.save_bulk_global_settings(&video.id, None, None, BulkVisualDials::default()).unwrap();
        assert_eq!(cleared, BulkGlobalVisualSettings::default());
        assert_eq!(repo.get_bulk_global_settings(&video.id).unwrap(), BulkGlobalVisualSettings::default());
    }

    #[test]
    fn bulk_scene_settings_round_trip_and_clear_back_to_inherit() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();

        assert!(repo.get_bulk_scene_settings(&video.id).unwrap().is_empty());

        let saved = repo.save_bulk_scene_settings(
            &video.id, "sc1",
            Some("scene style".into()), Some("scene rule".into()), Some(true), Some("asset-1".into()),
            None, None, BulkVisualDials::default(),
        ).unwrap();
        assert_eq!(saved.style_directive.as_deref(), Some("scene style"));

        let loaded = repo.get_bulk_scene_settings(&video.id).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scene_id, "sc1");
        assert_eq!(loaded[0].character_consistency, Some(true));
        assert_eq!(loaded[0].reference_asset_id.as_deref(), Some("asset-1"));

        // Re-saving with the same (video, scene) upserts in place, and a
        // field set back to None clears that override back to "inherit"
        // rather than leaving the old value behind.
        let updated = repo.save_bulk_scene_settings(&video.id, "sc1", None, Some("scene rule".into()), None, None, None, None, BulkVisualDials::default()).unwrap();
        assert_eq!(updated.style_directive, None);
        assert_eq!(updated.character_consistency, None);
        assert_eq!(updated.reference_asset_id, None);
        assert_eq!(repo.get_bulk_scene_settings(&video.id).unwrap().len(), 1, "upsert must not create a second row");
    }

    #[test]
    fn pending_still_ids_matches_needs_generation_semantics() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        for group in &plan.groups {
            repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene").unwrap();
        }
        // Give exactly the first still an up-to-date render; the rest stay
        // pending (no render at all).
        let up_to_date_group = &plan.groups[0];
        let prompt = repo.list_prompt_versions(&video.id, &up_to_date_group.id).unwrap()[0].clone();
        repo.insert_image_render(
            "render-1", &video.id, &up_to_date_group.id, 1, &prompt.id, "a.png", "renders/a.png", None, None, "generation",
        ).unwrap();

        let pending = repo.pending_still_ids(&video.id).unwrap();
        assert!(!pending.contains(&up_to_date_group.id), "an up-to-date still must not be pending");
        for group in plan.groups.iter().skip(1) {
            assert!(pending.contains(&group.id), "a still with no render must be pending");
        }
    }

    #[test]
    fn pending_still_ids_treats_a_never_planned_still_as_pending_not_an_error() {
        // Regression test: a still with no prompt version AT ALL (the normal
        // state for a project right after generation, before Bulk Generation
        // has ever run) used to hard-error out of pending_still_ids entirely
        // — inherited from create_image_job's OLD internal check, which only
        // ever ran after planning had already produced a prompt for every
        // still. Since pending_still_ids now also runs the moment the Bulk
        // Generation panel opens (to compute its default selection), that
        // made the panel itself fail to open on any project with an
        // unplanned still — i.e. almost every fresh project.
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert!(!plan.groups.is_empty());

        // No create_prompt_version call at all — every still is unplanned.
        let pending = repo.pending_still_ids(&video.id).unwrap();
        for group in &plan.groups {
            assert!(pending.contains(&group.id), "an unplanned still must be pending, not an error");
        }
    }

    #[test]
    fn create_image_job_with_explicit_group_ids_forces_regeneration_of_up_to_date_still() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let group = &plan.groups[0];
        let prompt = repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene").unwrap();
        repo.insert_image_render(
            "render-1", &video.id, &group.id, 1, &prompt.id, "a.png", "renders/a.png", None, None, "generation",
        ).unwrap();

        // This still is fully up to date — pending_still_ids would not
        // surface it — but an explicit selection forces it anyway.
        assert!(!repo.pending_still_ids(&video.id).unwrap().contains(&group.id));
        let job = repo.create_image_job(&video.id, &[group.id.clone()]).unwrap();
        assert_eq!(job.total_items, 1);
        assert_eq!(job.items[0].group_id, group.id);

        assert!(repo.create_image_job(&video.id, &[]).is_err(), "an empty selection must be rejected");
        assert!(
            repo.create_image_job(&video.id, &["does-not-exist".to_string()]).is_err(),
            "an unknown still id must be rejected"
        );
    }

    #[test]
    fn stores_image_edit_lineage_and_reads_render_files() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let prompt = repo
            .create_prompt_version(&video.id, "g1", "{}", "system", "scene")
            .unwrap();
        let render_dir = temp
            .path()
            .join("Projects")
            .join(&channel.id)
            .join(&video.id)
            .join("renders")
            .join("g1");
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"source").unwrap();
        let original = repo
            .insert_image_render(
                "original",
                &video.id,
                "g1",
                1,
                &prompt.id,
                "render-v1.png",
                "renders/g1/render-v1.png",
                None,
                None,
                "generation",
            )
            .unwrap();
        fs::write(render_dir.join("render-v2.png"), b"edited").unwrap();
        let edited = repo
            .insert_image_render(
                "edited",
                &video.id,
                "g1",
                2,
                &prompt.id,
                "render-v2.png",
                "renders/g1/render-v2.png",
                Some(&original.id),
                Some("Remove the buoy"),
                "edit",
            )
            .unwrap();
        assert_eq!(edited.parent_render_id.as_deref(), Some("original"));
        assert_eq!(edited.edit_instruction.as_deref(), Some("Remove the buoy"));
        assert_eq!(repo.read_render_file("edited").unwrap().1, "ZWRpdGVk");
    }

    #[test]
    fn exports_and_imports_validated_project_bundles() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Source Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Source Video").unwrap();
        repo.save_video_inputs(&video.id, "Portable script.", 8)
            .unwrap();
        let asset_dir = temp
            .path()
            .join("Projects")
            .join(&channel.id)
            .join(&video.id)
            .join("renders");
        fs::create_dir_all(&asset_dir).unwrap();
        fs::write(asset_dir.join("sample.png"), b"portable-image").unwrap();
        let bundle = temp.path().join("project.agsproj");
        assert!(
            repo.export_project_bundle(&video.id, &bundle)
                .unwrap()
                .file_count
                >= 2
        );
        // Imports into an existing, unrelated channel — the destination
        // someone picks, exactly like "+ New video" — never a channel of
        // its own.
        let destination_channel = repo.create_channel("Friend's Channel", None).unwrap();
        let imported = repo
            .import_project_bundle(&bundle, &destination_channel.id)
            .unwrap();
        assert_ne!(imported.id, video.id);
        assert_eq!(imported.channel_id, destination_channel.id);
        assert_eq!(repo.list_channels(false).unwrap().len(), 2);
        assert_eq!(
            repo.get_video_inputs(&imported.id).unwrap().script_text,
            "Portable script."
        );
        assert!(repo.import_project_bundle(&bundle, "missing-channel").is_err());
        assert!(temp
            .path()
            .join("Projects")
            .join(imported.channel_id)
            .join(imported.id)
            .join("renders/sample.png")
            .exists());
    }

    /// The shallow v1 bundle only ever round-tripped the raw script — a
    /// friend importing it got an empty Visuals/Animate/Editor. This drives
    /// a real project through visual plan, an image render, the Editor
    /// timeline, a media-library asset, and a music clip, then asserts the
    /// imported copy's own rows are internally consistent (every foreign
    /// key resolves to a row that actually exists in the *imported*
    /// project) rather than merely checking the old ids were preserved —
    /// they're deliberately not, so a bundle can be imported anywhere,
    /// including back into the database it was exported from, without id
    /// collisions.
    #[test]
    fn project_bundle_round_trips_full_project_state() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Source Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Source Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        assert!(!plan.groups.is_empty());
        let group_id = plan.groups[0].id.clone();

        let prompt = repo
            .create_prompt_version(&video.id, &group_id, "{}", "system prompt", "scene prompt")
            .unwrap();
        let render_dir = temp
            .path()
            .join("Projects")
            .join(&channel.id)
            .join(&video.id)
            .join("renders")
            .join(&group_id);
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"render-bytes").unwrap();
        let render = repo
            .insert_image_render(
                "render-1", &video.id, &group_id, 1, &prompt.id, "render-v1.png",
                &format!("renders/{group_id}/render-v1.png"), None, None, "generation",
            )
            .unwrap();
        let timeline = repo.build_timeline(&video.id).unwrap();
        assert!(timeline.clips.iter().any(|clip| clip.render_id.as_deref() == Some(render.id.as_str())));

        let still_path = temp.path().join("logo.png");
        fs::write(&still_path, b"still-bytes").unwrap();
        let media_asset = repo
            .import_media_library_asset(&video.id, &still_path, Some("still"), temp.path())
            .unwrap();
        let audio_path = temp.path().join("song.mp3");
        fs::write(&audio_path, b"song-bytes").unwrap();
        let music_asset = repo
            .import_media_library_asset(&video.id, &audio_path, Some("audio"), temp.path())
            .unwrap();
        repo.add_music_clip(&video.id, &music_asset.id, 0.0).unwrap();

        let bundle = temp.path().join("full-project.agsproj");
        repo.export_project_bundle(&video.id, &bundle).unwrap();
        // Imported back into the very same channel it came from — this is
        // the no-collision case that matters most, since ids from the
        // export are already live in this exact database.
        let imported = repo.import_project_bundle(&bundle, &channel.id).unwrap();
        assert_ne!(imported.id, video.id);
        assert_eq!(imported.channel_id, channel.id);
        assert_eq!(repo.list_channels(false).unwrap().len(), 1);

        // Visual plan carried over, with fresh ids.
        let imported_plan = repo.get_visual_plan(&imported.id).unwrap();
        assert_eq!(imported_plan.groups.len(), plan.groups.len());
        assert_eq!(imported_plan.sentences.len(), plan.sentences.len());
        assert_ne!(imported_plan.groups[0].id, group_id);
        // A group's sentence_ids_json must point at THIS project's sentences,
        // not the leftover ids from the source project.
        let imported_sentence_ids: std::collections::HashSet<_> =
            imported_plan.sentences.iter().map(|s| s.id.as_str()).collect();
        assert!(imported_plan.groups[0]
            .sentence_ids
            .iter()
            .all(|id| imported_sentence_ids.contains(id.as_str())));

        // The render survived, with its file, under the new group id.
        let imported_group_id = imported_plan.groups[0].id.clone();
        let imported_renders = repo.list_image_renders(&imported.id, &imported_group_id).unwrap();
        assert_eq!(imported_renders.len(), 1);
        assert_ne!(imported_renders[0].id, render.id);
        assert_ne!(imported_renders[0].prompt_version_id, prompt.id);
        assert!(temp
            .path()
            .join("Projects")
            .join(&imported.channel_id)
            .join(&imported.id)
            .join(&imported_renders[0].relative_path)
            .exists());

        // The Editor timeline's clip points at a render that actually
        // exists in the imported project (not the old, now-foreign id).
        let imported_timeline = repo.get_timeline(&imported.id).unwrap();
        let imported_render_ids: std::collections::HashSet<_> =
            imported_renders.iter().map(|r| r.id.as_str()).collect();
        assert!(imported_timeline
            .clips
            .iter()
            .any(|clip| clip.render_id.as_deref().is_some_and(|id| imported_render_ids.contains(id))));

        // Media library + music clip survived and reference each other correctly.
        let imported_stills = repo.list_media_library_assets(&imported.id, Some("still")).unwrap();
        assert_eq!(imported_stills.len(), 1);
        assert_ne!(imported_stills[0].id, media_asset.id);
        assert_eq!(imported_timeline.music_clips.len(), 1);
        assert_ne!(imported_timeline.music_clips[0].media_library_asset_id, music_asset.id);
        let imported_audio_assets: std::collections::HashSet<_> = repo
            .list_media_library_assets(&imported.id, Some("audio"))
            .unwrap()
            .into_iter()
            .map(|asset| asset.id)
            .collect();
        assert!(imported_audio_assets.contains(&imported_timeline.music_clips[0].media_library_asset_id));

        // Re-importing the exact same bundle a second time (e.g. the friend
        // downloads it twice, or it's imported back on the machine that
        // exported it) must not collide on any primary key.
        let second_import = repo.import_project_bundle(&bundle, &channel.id).unwrap();
        assert_ne!(second_import.id, imported.id);
        assert_ne!(second_import.id, video.id);
        assert_eq!(repo.get_visual_plan(&second_import.id).unwrap().groups.len(), plan.groups.len());
    }

    /// Regression test for a real bug found in production: sentences and
    /// groups get plain sequential ids (`s1`, `s2`, … and `g1`, `g2`, …), so
    /// `s1` is a literal string prefix of `s10`..`s19`, and `g1` of
    /// `g10`..`g19`. An earlier version of `remap_row` rewrote ids with a
    /// substring scan-and-replace, which would find `s1` *inside* `s10` and
    /// corrupt it. On a real 82-still project this silently broke ~45 of
    /// the 82 stills — they looked generated (the render existed) but the
    /// Visuals tab showed "No image generated yet" because the timeline
    /// clip's `render_id`/`group_id` no longer pointed at a row that
    /// existed under the new, mangled id. This builds 12 sentences/groups
    /// (enough to guarantee `s1`/`g1` collide with `s10`+/`g10`+) directly
    /// via SQL — bypassing the generation pipeline's own grouping
    /// heuristics, which aren't the thing under test — and asserts every
    /// single one survives the round trip correctly paired, not just that
    /// the totals match.
    #[test]
    fn project_bundle_remaps_prefix_colliding_sequential_ids() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let render_root = temp
            .path()
            .join("Projects")
            .join(&channel.id)
            .join(&video.id)
            .join("renders");

        repo.connection.execute(
            "INSERT INTO visual_plan_meta(video_id,timing_source,generated_at,updated_at) VALUES(?1,'test',?2,?2)",
            params![video.id, Utc::now().to_rfc3339()],
        ).unwrap();

        for n in 1..=12i64 {
            let sentence_id = format!("{}::s{n}", video.id);
            repo.connection.execute(
                "INSERT INTO visual_plan_sentences(id,video_id,ordinal,text,start_seconds,end_seconds) VALUES(?1,?2,?3,?4,?5,?6)",
                params![sentence_id, video.id, n, format!("Sentence {n}."), (n - 1) as f64 * 2.0, n as f64 * 2.0],
            ).unwrap();
            let group_id = format!("{}::current::g{n}", video.id);
            repo.connection.execute(
                "INSERT INTO visual_plan_groups(id,video_id,ordinal,label,kind,sentence_ids_json,is_original) VALUES(?1,?2,?3,?4,'subject',?5,0)",
                params![group_id, video.id, n, format!("Scene {n}"), serde_json::to_string(&vec![format!("s{n}")]).unwrap()],
            ).unwrap();

            let group_suffix = format!("g{n}");
            let prompt = repo.create_prompt_version(&video.id, &group_suffix, "{}", "system", "scene").unwrap();
            let render_dir = render_root.join(&group_suffix);
            fs::create_dir_all(&render_dir).unwrap();
            fs::write(render_dir.join("render-v1.png"), format!("bytes-{n}")).unwrap();
            repo.insert_image_render(
                &format!("render-{n}"), &video.id, &group_suffix, 1, &prompt.id, "render-v1.png",
                &format!("renders/{group_suffix}/render-v1.png"), None, None, "generation",
            ).unwrap();
        }
        let timeline = repo.build_timeline(&video.id).unwrap();
        assert_eq!(timeline.clips.len(), 12);
        assert!(timeline.clips.iter().all(|clip| clip.render_id.is_some()));

        let bundle = temp.path().join("collision-test.agsproj");
        repo.export_project_bundle(&video.id, &bundle).unwrap();
        let imported = repo.import_project_bundle(&bundle, &channel.id).unwrap();

        let imported_plan = repo.get_visual_plan(&imported.id).unwrap();
        assert_eq!(imported_plan.groups.len(), 12);
        assert_eq!(imported_plan.sentences.len(), 12);
        let imported_sentence_ids: std::collections::HashSet<_> =
            imported_plan.sentences.iter().map(|s| s.id.as_str()).collect();

        let imported_timeline = repo.get_timeline(&imported.id).unwrap();
        assert_eq!(imported_timeline.clips.len(), 12);
        let mut linked_render_ids = std::collections::HashSet::new();
        for group in &imported_plan.groups {
            // Every group's own sentence must resolve within THIS project —
            // this is exactly what the substring-scan bug corrupted for g1
            // (whose sentence_ids_json entry "s1" got mangled wherever an
            // unrelated s10/s11/s12 remap ran first).
            assert!(
                group.sentence_ids.iter().all(|id| imported_sentence_ids.contains(id.as_str())),
                "group {} (ordinal {}) has a sentence id that doesn't exist in the imported plan: {:?}",
                group.id, group.ordinal, group.sentence_ids,
            );
            let renders = repo.list_image_renders(&imported.id, &group.id).unwrap();
            assert_eq!(
                renders.iter().filter(|r| r.is_final).count(), 1,
                "group {} (ordinal {}) should have exactly one final render after import", group.id, group.ordinal,
            );
            let render = renders.iter().find(|r| r.is_final).unwrap();
            assert!(temp.path().join("Projects").join(&imported.channel_id).join(&imported.id).join(&render.relative_path).exists());
            linked_render_ids.insert(render.id.clone());

            let clip = imported_timeline.clips.iter().find(|c| c.group_id == group.id)
                .unwrap_or_else(|| panic!("no timeline clip for group {} (ordinal {})", group.id, group.ordinal));
            assert_eq!(
                clip.render_id.as_deref(), Some(render.id.as_str()),
                "timeline clip for group {} (ordinal {}) points at the wrong render", group.id, group.ordinal,
            );
        }
        // All 12 renders are distinct — none of them collapsed onto each
        // other via a corrupted shared id.
        assert_eq!(linked_render_ids.len(), 12);
    }

    #[test]
    fn remap_composite_id_does_not_corrupt_ids_that_are_prefixes_of_others() {
        let mut id_map = std::collections::HashMap::new();
        id_map.insert("video-a".to_string(), "video-Z".to_string());
        id_map.insert("s1".to_string(), "sentence-A".to_string());
        id_map.insert("s10".to_string(), "sentence-B".to_string());
        id_map.insert("g1".to_string(), "group-A".to_string());
        id_map.insert("g18".to_string(), "group-B".to_string());

        assert_eq!(remap_composite_id("video-a::s1", &id_map), "video-Z::sentence-A");
        assert_eq!(remap_composite_id("video-a::s10", &id_map), "video-Z::sentence-B");
        assert_eq!(remap_composite_id("video-a::current::g1", &id_map), "video-Z::current::group-A");
        assert_eq!(remap_composite_id("video-a::current::g18", &id_map), "video-Z::current::group-B");
        // The video_id segment still gets remapped even when the suffix has
        // no entry in the map (e.g. a group with no matching row survived
        // in this bundle) — only the unmapped suffix is left untouched.
        assert_eq!(remap_composite_id("video-a::original::g99", &id_map), "video-Z::original::g99");
        // Nothing in the map at all: the whole id is left untouched.
        assert_eq!(remap_composite_id("video-b::original::g99", &id_map), "video-b::original::g99");
    }

    #[test]
    fn remap_id_array_json_does_not_corrupt_prefix_colliding_ids() {
        let mut id_map = std::collections::HashMap::new();
        id_map.insert("s1".to_string(), "sentence-A".to_string());
        id_map.insert("s10".to_string(), "sentence-B".to_string());
        id_map.insert("s11".to_string(), "sentence-C".to_string());

        let result = remap_id_array_json(r#"["s1","s10","s11"]"#, &id_map);
        let parsed: Vec<String> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed, vec!["sentence-A", "sentence-B", "sentence-C"]);
    }

    #[test]
    fn remap_sentence_snapshot_json_remaps_id_field_only() {
        let mut id_map = std::collections::HashMap::new();
        id_map.insert("s1".to_string(), "sentence-A".to_string());
        id_map.insert("s10".to_string(), "sentence-B".to_string());

        let source = r#"[{"id":"s1","ordinal":1,"text":"Hello","startSeconds":0.0,"endSeconds":1.0},{"id":"s10","ordinal":2,"text":"World","startSeconds":1.0,"endSeconds":2.0}]"#;
        let result = remap_sentence_snapshot_json(source, &id_map);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed[0]["id"], "sentence-A");
        assert_eq!(parsed[0]["text"], "Hello");
        assert_eq!(parsed[1]["id"], "sentence-B");
        assert_eq!(parsed[1]["text"], "World");
    }

    #[test]
    fn rejects_unsafe_bundle_paths() {
        assert!(validate_bundle_path("../secret.txt").is_err());
        assert!(validate_bundle_path("renders/safe.png").is_ok());
    }

    #[test]
    fn imports_editor_bundle_asset_folder() {
        let (temp, repo) = repository();
        let source_dir = temp.path().join("Life OK").join("Project 1");
        let clips_dir = source_dir.join("clips");
        fs::create_dir_all(&clips_dir).unwrap();
        fs::write(clips_dir.join("seg_0001.mp4"), b"clip-one").unwrap();
        fs::write(clips_dir.join("seg_0002.mp4"), b"clip-two").unwrap();
        fs::write(source_dir.join("narration.mp3"), b"narration-bytes").unwrap();
        fs::write(
            source_dir.join("timing.txt"),
            "Import the files in clips/ in numeric filename order onto a video track.\n\n\
             Narration audio starts at 0 on its track and needs no further alignment.\n\n\
             seg_0001.mp4\timage\t0.000s - 3.000s\t(3.000s)\n\
             seg_0002.mp4\timage\t3.000s - 7.500s\t(4.500s)\n",
        )
        .unwrap();
        fs::write(
            source_dir.join("captions.srt"),
            "1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n\
             2\n00:00:02,500 --> 00:00:05,000\nSecond caption line.\n",
        )
        .unwrap();

        let imported = repo.import_asset_folder(&source_dir, temp.path()).unwrap();
        assert_eq!(imported.stage, "timeline");

        let channel: String = repo.connection.query_row(
            "SELECT name FROM channels WHERE id=?1", [&imported.channel_id], |row| row.get(0),
        ).unwrap();
        assert_eq!(channel, "Life OK (Imported)");
        assert_eq!(imported.title, "Project 1");

        let timeline = repo.get_timeline(&imported.id).unwrap();
        assert_eq!(timeline.clips.len(), 2);
        assert_eq!(timeline.clips[0].clip_kind, "imported-clip");
        assert_eq!(timeline.clips[0].start_seconds, 0.0);
        assert_eq!(timeline.clips[0].end_seconds, 3.0);

        // A raw asset-folder import has no visual plan at all — Visuals/
        // Animate/Editor all read the workspace to render, and it must
        // degrade to empty rather than erroring (get_visual_plan itself
        // still errors for this video; only the display-only aggregator
        // tolerates the missing plan).
        assert!(repo.get_visual_plan(&imported.id).is_err());
        let workspace = repo.get_image_workspace(&imported.id).unwrap();
        assert!(workspace.groups.is_empty());
        assert!(workspace.sentences.is_empty());
        assert_eq!(timeline.clips[1].start_seconds, 3.0);
        assert_eq!(timeline.clips[1].end_seconds, 7.5);

        let clips = repo.list_media_library_assets(&imported.id, Some("clip")).unwrap();
        assert_eq!(clips.len(), 2);

        let inputs = repo.get_video_inputs(&imported.id).unwrap();
        assert!(inputs.audio.is_some());
        assert_eq!(inputs.script_text, "Hello there. Second caption line.");

        let captions = repo.get_timeline(&imported.id).unwrap().caption_clips;
        assert_eq!(captions.len(), 2);
        assert_eq!(captions[0].text, "Hello there.");
        assert_eq!(captions[1].start_seconds, 2.5);
    }

    #[test]
    fn parses_timing_file_and_srt() {
        let segments = parse_timing_file(
            "instructions here\n\nseg_0001.mp4\timage\t0.000s - 3.000s\t(3.000s)\nseg_0002.mp4\timage\t3.000s - 7.500s\t(4.500s)\n",
        ).unwrap();
        assert_eq!(segments, vec![
            ("seg_0001.mp4".to_string(), 0.0, 3.0),
            ("seg_0002.mp4".to_string(), 3.0, 7.5),
        ]);
        assert!(parse_timing_file("no clip lines here").is_err());

        let entries = parse_srt("1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n2\n00:00:02,500 --> 00:00:05,000\nSecond line.\n");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], (0.0, 2.5, "Hello there.".to_string()));
        assert_eq!(entries[1].1, 5.0);
    }

    #[test]
    fn builds_and_persists_non_overlapping_timeline() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene. Third scene.", 4)
            .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let timeline = repo.build_timeline(&video.id).unwrap();
        assert!(!timeline.clips.is_empty());
        assert!(timeline
            .clips
            .windows(2)
            .all(|clips| clips[0].end_seconds <= clips[1].start_seconds));
        let updated = repo.update_timeline_view(&video.id, 999.0, 9.0).unwrap();
        assert_eq!(updated.playhead_seconds, updated.duration_seconds);
        assert_eq!(updated.zoom, 4.0);
        if timeline.clips.len() > 1 {
            let first = &timeline.clips[0];
            assert!(repo
                .update_timeline_clip(
                    &video.id,
                    &first.id,
                    first.start_seconds,
                    timeline.clips[1].end_seconds
                )
                .is_err());
        }
    }

    #[test]
    fn imports_media_library_assets_and_lists_by_kind() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let image_path = temp.path().join("logo.png");
        fs::write(&image_path, b"png-bytes").unwrap();
        let audio_path = temp.path().join("song.mp3");
        fs::write(&audio_path, b"mp3-bytes").unwrap();

        let still_asset = repo
            .import_media_library_asset(&video.id, &image_path, Some("still"), temp.path())
            .unwrap();
        assert_eq!(still_asset.kind, "still");
        assert_eq!(still_asset.duration_seconds, None);
        let audio_asset = repo
            .import_media_library_asset(&video.id, &audio_path, Some("audio"), temp.path())
            .unwrap();
        assert_eq!(audio_asset.kind, "audio");
        assert_eq!(audio_asset.duration_seconds, Some(1.0));

        let stills = repo.list_media_library_assets(&video.id, Some("still")).unwrap();
        assert_eq!(stills.len(), 1);
        assert_eq!(stills[0].id, still_asset.id);
        let all = repo.list_media_library_assets(&video.id, None).unwrap();
        assert_eq!(all.len(), 2);

        // The top-level "+ Import" entry point has no pre-selected kind — an
        // unsupported extension should be rejected outright...
        let unknown_path = temp.path().join("data.xyz");
        fs::write(&unknown_path, b"???").unwrap();
        assert!(repo
            .import_media_library_asset(&video.id, &unknown_path, None, temp.path())
            .is_err());
        // ...while a known extension is routed to the correct kind automatically.
        let inferred = repo
            .import_media_library_asset(&video.id, &image_path, None, temp.path())
            .unwrap();
        assert_eq!(inferred.kind, "still");

        repo.remove_media_library_asset(&still_asset.id).unwrap();
        assert_eq!(repo.list_media_library_assets(&video.id, Some("still")).unwrap().len(), 1);
    }

    #[test]
    fn denoises_audio_asset_non_destructively() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio_path = temp.path().join("narration.mp3");
        fs::write(&audio_path, b"mp3-bytes").unwrap();
        let asset = repo
            .import_media_library_asset(&video.id, &audio_path, Some("audio"), temp.path())
            .unwrap();

        let cleaned = repo.denoise_media_library_asset(&asset.id, temp.path()).unwrap();
        // A brand-new asset, not a mutation of the original.
        assert_ne!(cleaned.id, asset.id);
        assert_eq!(cleaned.kind, "audio");
        assert_eq!(cleaned.original_name, "narration (denoised).mp3");
        assert_eq!(cleaned.video_id, video.id);

        // The original is untouched and still listed alongside the cleaned copy.
        let all = repo.list_media_library_assets(&video.id, Some("audio")).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|item| item.id == asset.id));
        assert!(all.iter().any(|item| item.id == cleaned.id));

        // Only Audio-tab assets qualify.
        let image_path = temp.path().join("logo.png");
        fs::write(&image_path, b"png-bytes").unwrap();
        let still_asset = repo
            .import_media_library_asset(&video.id, &image_path, Some("still"), temp.path())
            .unwrap();
        assert!(repo.denoise_media_library_asset(&still_asset.id, temp.path()).is_err());
    }

    #[test]
    fn edited_captions_fall_back_to_estimated_word_highlight_timing() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();
        let real_words = serde_json::to_string(&vec![
            CaptionWord { text: "Hello".into(), start_seconds: 0.0, end_seconds: 0.4 },
            CaptionWord { text: "world.".into(), start_seconds: 0.4, end_seconds: 1.0 },
        ]).unwrap();
        let clip_id = Uuid::new_v4().to_string();
        repo.connection.execute(
            "INSERT INTO timeline_caption_clips(id,video_id,source_chunk_index,text,ordinal,start_seconds,end_seconds,words_json) VALUES(?1,?2,NULL,'Hello world.',0,0,1,?3)",
            params![clip_id, video.id, real_words],
        ).unwrap();

        // Real per-word timing round-trips untouched.
        let before = repo.get_timeline(&video.id).unwrap();
        let clip = before.caption_clips.iter().find(|c| c.id == clip_id).unwrap();
        let words = clip.words.as_ref().expect("real words should be present");
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[1].end_seconds, 1.0);

        // Editing the text drops the now-stale real timing (existing
        // behavior — the words no longer correspond to the new text)...
        let after_edit = repo
            .update_caption_clip_text(&video.id, &clip_id, "A completely different sentence now.")
            .unwrap();
        let edited = after_edit.caption_clips.iter().find(|c| c.id == clip_id).unwrap();
        // ...but word highlight still has something to animate through: an
        // estimated timing spanning the clip's own [start, end], one entry
        // per word of the NEW text, in order, filling the whole window.
        let estimated = edited.words.as_ref().expect("should fall back to an estimate, not None");
        assert_eq!(estimated.len(), 5); // "A completely different sentence now."
        assert_eq!(estimated[0].text, "A");
        assert_eq!(estimated.last().unwrap().text, "now.");
        assert_eq!(estimated[0].start_seconds, edited.start_seconds);
        assert!((estimated.last().unwrap().end_seconds - edited.end_seconds).abs() < 1e-9);
        // Windows are contiguous (no gaps a highlight could fall through)
        // and in order.
        for pair in estimated.windows(2) {
            assert_eq!(pair[0].end_seconds, pair[1].start_seconds);
        }
        // Longer words get proportionally more time than short ones —
        // "completely" should span more than "A".
        let a_span = estimated[0].end_seconds - estimated[0].start_seconds;
        let completely_span = estimated[1].end_seconds - estimated[1].start_seconds;
        assert!(completely_span > a_span);

        // The estimate is never written back to the database as if it were
        // real — only NULL is stored, so a future real transcription is
        // never shadowed by a stale-looking estimate.
        let stored_words_json: Option<String> = repo.connection.query_row(
            "SELECT words_json FROM timeline_caption_clips WHERE id=?1", [&clip_id], |row| row.get(0),
        ).unwrap();
        assert!(stored_words_json.is_none());
    }

    #[test]
    fn music_clips_persist_settings_and_reject_overlap() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();
        let audio_path = temp.path().join("song.mp3");
        fs::write(&audio_path, b"mp3-bytes").unwrap();
        let asset = repo
            .import_media_library_asset(&video.id, &audio_path, Some("audio"), temp.path())
            .unwrap();

        let timeline = repo.add_music_clip(&video.id, &asset.id, 0.0).unwrap();
        assert_eq!(timeline.music_clips.len(), 1);
        let clip_id = timeline.music_clips[0].id.clone();

        assert!(repo.add_music_clip(&video.id, &asset.id, 0.5).is_err());

        let updated = repo
            .set_music_clip_settings(&video.id, &clip_id, 40.0, true, 2.0, true, 1.5, true, true)
            .unwrap();
        let clip = updated.music_clips.iter().find(|c| c.id == clip_id).unwrap();
        assert_eq!(clip.volume_percent, 40.0);
        assert!(clip.fade_in_enabled);
        assert!(clip.loop_enabled);
        assert!(clip.auto_duck);

        let after_master = repo.set_music_master_settings(&video.id, 150.0, 75.0).unwrap();
        assert_eq!(after_master.music_master_volume_percent, 150.0);
        assert_eq!(after_master.music_duck_sensitivity_percent, 75.0);

        let after_delete = repo.delete_music_clip(&video.id, &clip_id).unwrap();
        assert!(after_delete.music_clips.is_empty());
    }

    #[test]
    fn color_filter_and_dip_to_white_transition_are_validated_and_applied() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let timeline = repo.build_timeline(&video.id).unwrap();
        assert!(timeline.clips.iter().all(|c| c.color_filter_preset == "none" && (c.color_filter_intensity - 100.0).abs() < 1e-9));
        let first_clip_id = timeline.clips[0].id.clone();

        assert!(repo.set_timeline_clip_color_filter(&video.id, &first_clip_id, "bogus", 50.0).is_err());
        assert!(repo.set_timeline_clip_transition(&video.id, &first_clip_id, "dip-to-white").is_ok());
        for join_transition in ["cross-fade", "slide-left", "slide-right", "zoom-blur", "whip-pan", "blur-transition"] {
            assert!(
                repo.set_timeline_clip_transition_out(&video.id, &first_clip_id, join_transition).is_ok(),
                "{join_transition} should be a valid transition_out value",
            );
        }
        assert!(repo.set_timeline_clip_transition_out(&video.id, &first_clip_id, "bogus-transition").is_err());

        let updated = repo.set_timeline_clip_color_filter(&video.id, &first_clip_id, "warm", 150.0).unwrap();
        let clip = updated.clips.iter().find(|c| c.id == first_clip_id).unwrap();
        assert_eq!(clip.color_filter_preset, "warm");
        assert_eq!(clip.color_filter_intensity, 100.0); // clamped

        let all = repo.apply_color_filter_to_all_clips(&video.id, "cinematic", 60.0).unwrap();
        assert!(all.clips.iter().all(|c| c.color_filter_preset == "cinematic" && (c.color_filter_intensity - 60.0).abs() < 1e-9));
    }

    #[test]
    fn text_overlay_clip_validates_style_fields() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();

        let timeline = repo.add_text_overlay_clip(&video.id, 2.0).unwrap();
        assert_eq!(timeline.text_clips.len(), 1);
        let clip_id = timeline.text_clips[0].id.clone();

        assert!(repo.set_text_overlay_style(
            &video.id, &clip_id, "Hello", "Rubik", 40.0, true, false, "#FFFFFF", "bogus", "#000000", "bottom-center", "fade",
        ).is_err());

        let updated = repo.set_text_overlay_style(
            &video.id, &clip_id, "Hello", "Rubik", 40.0, true, false, "#FFFFFF", "solid", "#000000", "bottom-center", "fade",
        ).unwrap();
        let clip = updated.text_clips.iter().find(|c| c.id == clip_id).unwrap();
        assert_eq!(clip.text, "Hello");
        assert_eq!(clip.background_mode, "solid");

        let after_delete = repo.delete_text_overlay_clip(&video.id, &clip_id).unwrap();
        assert!(after_delete.text_clips.is_empty());
    }

    #[test]
    fn text_overlay_clips_reject_overlap() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();

        let timeline = repo.add_text_overlay_clip(&video.id, 0.0).unwrap();
        let first_id = timeline.text_clips[0].id.clone();

        // A second overlay starting inside the first one's [0,3) span must be rejected.
        assert!(repo.add_text_overlay_clip(&video.id, 1.0).is_err());
        // Non-overlapping placement still succeeds.
        let timeline = repo.add_text_overlay_clip(&video.id, 5.0).unwrap();
        assert_eq!(timeline.text_clips.len(), 2);

        // Dragging the first clip to overlap the second must also be rejected.
        assert!(repo.update_text_overlay_clip(&video.id, &first_id, 4.5, 6.0).is_err());
    }

    #[test]
    fn logo_show_throughout_resyncs_and_manual_resize_disables_it() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,20,0,1,'now')",
            [&video.id],
        ).unwrap();
        let image_path = temp.path().join("logo.png");
        fs::write(&image_path, b"png-bytes").unwrap();
        let asset = repo
            .import_media_library_asset(&video.id, &image_path, Some("still"), temp.path())
            .unwrap();

        let timeline = repo.add_logo_clip(&video.id, &asset.id).unwrap();
        assert_eq!(timeline.logo_clips.len(), 1);
        let clip = &timeline.logo_clips[0];
        assert!(clip.show_throughout);
        assert_eq!(clip.start_seconds, 0.0);
        assert_eq!(clip.end_seconds, 20.0);
        let clip_id = clip.id.clone();

        let after_resize = repo.update_logo_clip(&video.id, &clip_id, 2.0, 8.0).unwrap();
        let resized = after_resize.logo_clips.iter().find(|c| c.id == clip_id).unwrap();
        assert!(!resized.show_throughout);
        assert_eq!(resized.start_seconds, 2.0);
        assert_eq!(resized.end_seconds, 8.0);

        let after_style = repo.set_logo_clip_style(&video.id, &clip_id, "top-left", 20.0, 80.0, true).unwrap();
        let restyled = after_style.logo_clips.iter().find(|c| c.id == clip_id).unwrap();
        assert!(restyled.show_throughout);
        assert_eq!(restyled.start_seconds, 0.0);
        assert_eq!(restyled.end_seconds, 20.0);
        assert_eq!(restyled.position, "top-left");
    }

    #[test]
    fn remove_all_clip_effects_resets_every_stills_clip() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let timeline = repo.build_timeline(&video.id).unwrap();
        assert!(!timeline.clips.is_empty());
        let first_clip_id = timeline.clips[0].id.clone();
        repo.set_timeline_clip_motion(&video.id, &first_clip_id, "zoom-in").unwrap();
        repo.set_timeline_clip_motion_intensity(&video.id, &first_clip_id, 0.5).unwrap();
        repo.set_timeline_clip_transition(&video.id, &first_clip_id, "fade").unwrap();
        repo.set_timeline_clip_color_filter(&video.id, &first_clip_id, "warm", 80.0).unwrap();

        let reset = repo.remove_all_clip_effects(&video.id).unwrap();
        assert!(reset.clips.iter().all(|clip| {
            clip.motion_preset == "none"
                && clip.transition_in == "cut"
                && clip.transition_out == "cut"
                && (clip.motion_intensity - 0.22).abs() < 1e-9
                && clip.color_filter_preset == "none"
                && (clip.color_filter_intensity - 100.0).abs() < 1e-9
        }));
    }

    #[test]
    fn export_jobs_track_lifecycle_and_list_newest_first() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();

        let job1 = repo.create_export_job(&video.id, "/tmp/first.mp4").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let job2 = repo.create_export_job(&video.id, "/tmp/second.mp4").unwrap();

        repo.complete_export_job(&job1, "/tmp/first-final.mp4").unwrap();
        repo.fail_export_job(&job2, "ffmpeg exploded").unwrap();

        let jobs = repo.list_export_jobs(&video.id).unwrap();
        assert_eq!(jobs.len(), 2);
        // Newest first.
        assert_eq!(jobs[0].id, job2);
        assert_eq!(jobs[0].status, "failed");
        assert_eq!(jobs[0].error.as_deref(), Some("ffmpeg exploded"));
        assert!(jobs[0].completed_at.is_some());
        assert_eq!(jobs[1].id, job1);
        assert_eq!(jobs[1].status, "completed");
        assert_eq!(jobs[1].destination_path, "/tmp/first-final.mp4");

        let other_video = repo.create_video(&channel.id, "Other").unwrap();
        assert!(repo.list_export_jobs(&other_video.id).unwrap().is_empty());
    }

    #[test]
    fn restores_timeline_from_snapshot_after_mutation() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4).unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        repo.generate_visual_plan(&video.id, temp.path()).unwrap();
        let before = repo.build_timeline(&video.id).unwrap();
        assert!(!before.clips.is_empty());
        let first_clip_id = before.clips[0].id.clone();

        let song_path = temp.path().join("song.mp3");
        fs::write(&song_path, b"mp3-bytes").unwrap();
        let asset = repo.import_media_library_asset(&video.id, &song_path, Some("audio"), temp.path()).unwrap();
        let before = repo.add_music_clip(&video.id, &asset.id, 0.0).unwrap();
        assert_eq!(before.music_clips.len(), 1);

        let snapshot_json = serde_json::to_string(&before).unwrap();

        // Mutate the timeline: change the first clip's motion, delete the
        // music clip entirely — both should be undone by the restore below.
        repo.set_timeline_clip_motion(&video.id, &first_clip_id, "zoom-in").unwrap();
        let music_clip_id = before.music_clips[0].id.clone();
        repo.delete_music_clip(&video.id, &music_clip_id).unwrap();
        let mutated = repo.get_timeline(&video.id).unwrap();
        assert!(mutated.music_clips.is_empty());
        assert_eq!(mutated.clips.iter().find(|c| c.id == first_clip_id).unwrap().motion_preset, "zoom-in");

        let restored = repo.restore_timeline_snapshot(&video.id, &snapshot_json).unwrap();
        assert_eq!(restored.clips.len(), before.clips.len());
        assert_eq!(restored.clips.iter().find(|c| c.id == first_clip_id).unwrap().motion_preset, "none");
        assert_eq!(restored.music_clips.len(), 1);
        assert_eq!(restored.music_clips[0].id, music_clip_id);

        // A snapshot from a different video must be rejected outright.
        let other_video = repo.create_video(&channel.id, "Other").unwrap();
        assert!(repo.restore_timeline_snapshot(&other_video.id, &snapshot_json).is_err());
    }

    #[test]
    fn removing_media_library_asset_cascades_to_placed_clips() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();
        let audio_path = temp.path().join("song.mp3");
        fs::write(&audio_path, b"mp3-bytes").unwrap();
        let asset = repo
            .import_media_library_asset(&video.id, &audio_path, Some("audio"), temp.path())
            .unwrap();
        let timeline = repo.add_music_clip(&video.id, &asset.id, 0.0).unwrap();
        assert_eq!(timeline.music_clips.len(), 1);

        repo.remove_media_library_asset(&asset.id).unwrap();

        let after = repo.get_timeline(&video.id).unwrap();
        assert!(after.music_clips.is_empty());
        assert!(repo.list_media_library_assets(&video.id, None).unwrap().is_empty());
    }

    #[test]
    fn animation_clip_can_be_reverted_and_restored_from_cache() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let prompt = repo
            .create_prompt_version(&video.id, "g1", "{}", "system", "scene")
            .unwrap();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join("g1");
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"source").unwrap();
        let render = repo
            .insert_image_render(
                "render1", &video.id, "g1", 1, &prompt.id, "render-v1.png", "renders/g1/render-v1.png", None, None, "generation",
            )
            .unwrap();

        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip1',?1,'g1',?2,1,0,5,'Scene 1')",
            params![video.id, render.id],
        ).unwrap();
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip2',?1,'g1',?2,2,5,10,'Scene 2')",
            params![video.id, render.id],
        ).unwrap();

        let animation_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("animations").join("g1");
        fs::create_dir_all(&animation_dir).unwrap();
        fs::write(animation_dir.join("animation-v1.mp4"), b"video").unwrap();
        repo.connection.execute(
            "INSERT INTO video_assets(id,video_id,group_id,source_render_id,version,parent_video_asset_id,kind,file_name,relative_path,resolution,requested_duration_seconds,veo_duration_seconds,actual_duration_seconds,veo_model,veo_operation_name,prompt,created_at) VALUES('asset1',?1,'g1',?2,1,NULL,'generation','animation-v1.mp4','animations/g1/animation-v1.mp4','720p',5,6,6,'test-model',NULL,'',   'now')",
            params![video.id, render.id],
        ).unwrap();
        repo.connection.execute(
            "UPDATE timeline_clips SET clip_kind='animation', video_asset_id='asset1' WHERE id='clip1'",
            [],
        ).unwrap();

        // Reverting an animation clip keeps video_asset_id cached, not cleared.
        let timeline = repo.revert_animation_clip_to_still(&video.id, "clip1").unwrap();
        let clip = timeline.clips.iter().find(|c| c.id == "clip1").unwrap();
        assert_eq!(clip.clip_kind, "still");
        assert_eq!(clip.video_asset_id.as_deref(), Some("asset1"));

        // Reverting again fails — it's not currently animated.
        assert!(repo.revert_animation_clip_to_still(&video.id, "clip1").is_err());

        // Restoring re-applies the cached animation with no Veo call.
        let timeline = repo.restore_animation_clip(&video.id, "clip1").unwrap();
        let clip = timeline.clips.iter().find(|c| c.id == "clip1").unwrap();
        assert_eq!(clip.clip_kind, "animation");
        assert_eq!(clip.video_asset_id.as_deref(), Some("asset1"));

        // Restoring again fails — it's not currently a still.
        assert!(repo.restore_animation_clip(&video.id, "clip1").is_err());

        // A still with no cached animation at all can't be "restored".
        assert!(repo.restore_animation_clip(&video.id, "clip2").is_err());
    }

    #[test]
    fn extrapolate_stills_clears_motion_only_on_clips_whose_duration_actually_changed() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();

        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,20,0,1,'now')",
            [&video.id],
        ).unwrap();
        // clip1 has a gap before clip2 (5 -> 7) — its end must stretch, so its
        // motion recipe should be invalidated.
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip1',?1,'g1',NULL,1,0,5,'Scene 1')",
            [&video.id],
        ).unwrap();
        // clip2 already abuts clip3 exactly (10 -> 10) — no gap, so its end
        // should end up unchanged and its motion recipe should survive.
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip2',?1,'g2',NULL,2,7,10,'Scene 2')",
            [&video.id],
        ).unwrap();
        // clip3 is the last clip and its end (20) already covers the total
        // duration (20), so it's untouched too.
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip3',?1,'g3',NULL,3,10,20,'Scene 3')",
            [&video.id],
        ).unwrap();

        repo.set_timeline_clip_motion_graphic(&video.id, "clip1", Some("push in"), Some(r#"{"cameraEffect":"push_in"}"#), Some("test reason")).unwrap();
        repo.set_timeline_clip_motion_graphic(&video.id, "clip2", Some("pan left"), Some(r#"{"cameraEffect":"position_pan"}"#), Some("test reason")).unwrap();

        let timeline = repo.extrapolate_stills_to_fill_gaps(&video.id, 20.0).unwrap();
        let clip1 = timeline.clips.iter().find(|c| c.id == "clip1").unwrap();
        let clip2 = timeline.clips.iter().find(|c| c.id == "clip2").unwrap();
        let clip3 = timeline.clips.iter().find(|c| c.id == "clip3").unwrap();

        // clip1's end moved from 5 to 7 (closing the gap) — its stale recipe
        // must be cleared so Auto Motion recomputes it for the new duration.
        assert_eq!(clip1.end_seconds, 7.0);
        assert!(clip1.motion_graphic_effect.is_none());
        assert!(clip1.motion_graphic_settings_json.is_none());
        assert!(clip1.motion_graphic_reason.is_none());

        // clip2's start/end are both unchanged — its recipe must survive.
        assert_eq!((clip2.start_seconds, clip2.end_seconds), (7.0, 10.0));
        assert_eq!(clip2.motion_graphic_effect.as_deref(), Some("pan left"));
        assert!(clip2.motion_graphic_settings_json.is_some());
        assert_eq!(clip2.motion_graphic_reason.as_deref(), Some("test reason"));

        // clip3 had no motion assigned to begin with — stays that way.
        assert_eq!((clip3.start_seconds, clip3.end_seconds), (10.0, 20.0));
        assert!(clip3.motion_graphic_effect.is_none());
    }

    #[test]
    fn imports_uploaded_video_as_clip_animation_and_allows_retime() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let prompt = repo
            .create_prompt_version(&video.id, "g1", "{}", "system", "scene")
            .unwrap();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join("g1");
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"source").unwrap();
        let render = repo
            .insert_image_render(
                "render1", &video.id, "g1", 1, &prompt.id, "render-v1.png", "renders/g1/render-v1.png", None, None, "generation",
            )
            .unwrap();

        repo.connection.execute(
            "INSERT INTO timelines(video_id,duration_seconds,playhead_seconds,zoom,updated_at) VALUES(?1,10,0,1,'now')",
            [&video.id],
        ).unwrap();
        repo.connection.execute(
            "INSERT INTO timeline_clips(id,video_id,group_id,render_id,ordinal,start_seconds,end_seconds,label) VALUES('clip1',?1,'g1',?2,1,0,5,'Scene 1')",
            params![video.id, render.id],
        ).unwrap();

        let uploaded = temp.path().join("my-clip.mov");
        fs::write(&uploaded, b"uploaded-video").unwrap();

        let timeline = repo.import_animation_clip(&video.id, "clip1", &uploaded, temp.path()).unwrap();
        let clip = timeline.clips.iter().find(|c| c.id == "clip1").unwrap();
        assert_eq!(clip.clip_kind, "animation");
        let asset_id = clip.video_asset_id.clone().unwrap();
        let asset = repo.get_video_asset_record(&asset_id).unwrap();
        assert_eq!(asset.kind, "upload");
        assert_eq!(asset.requested_duration_seconds, 5.0);
        assert!(repo.video_asset_file_path(&asset_id).unwrap().exists());

        // Rejects an unsupported file type up front.
        let bad = temp.path().join("notes.txt");
        fs::write(&bad, b"nope").unwrap();
        assert!(repo.import_animation_clip(&video.id, "clip1", &bad, temp.path()).is_err());

        // The relaxed retime root-lookup treats an upload as a valid re-derivation root.
        assert!(repo.retime_animation_clip(&video.id, "clip1", temp.path()).is_ok());
    }

    #[test]
    fn bulk_animation_job_items_target_stills_directly_with_no_clip() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let prompt = repo.create_prompt_version(&video.id, "g1", "{}", "system", "scene").unwrap();
        let render_dir = temp.path().join("Projects").join(&channel.id).join(&video.id).join("renders").join("g1");
        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("render-v1.png"), b"source").unwrap();
        let render = repo
            .insert_image_render("render1", &video.id, "g1", 1, &prompt.id, "render-v1.png", "renders/g1/render-v1.png", None, None, "generation")
            .unwrap();
        let _ = render;

        assert!(repo.create_animation_bulk_job(&video.id, "4K", &[("g1".into(), "gentle drift".into())]).is_err());
        assert!(repo.create_animation_bulk_job(&video.id, "720p", &[]).is_err());
        // A group with no generated render is rejected rather than silently dropped.
        assert!(repo.create_animation_bulk_job(&video.id, "720p", &[("g-missing".into(), "prompt".into())]).is_err());

        let job = repo.create_animation_bulk_job(&video.id, "720p", &[("g1".into(), "gentle drift".into())]).unwrap();
        assert_eq!(job.total_items, 1);
        assert_eq!(job.status, "queued");
        assert_eq!(job.items.len(), 1);
        assert_eq!(job.items[0].clip_id, None);
        assert_eq!(job.items[0].group_id, "g1");
        assert_eq!(job.items[0].prompt, "gentle drift");
        assert_eq!(job.items[0].status, "queued");
    }

    #[test]
    fn preserves_corrupt_database_before_recovery() {
        let temp = TempDir::new().unwrap();
        let database = temp.path().join("app.db");
        fs::write(&database, b"not a sqlite database").unwrap();
        let (repo, backup) =
            ProjectRepository::open_with_recovery(&database, &temp.path().join("Projects"))
                .unwrap();
        assert!(backup.as_ref().unwrap().exists());
        assert_eq!(fs::read(backup.unwrap()).unwrap(), b"not a sqlite database");
        assert!(repo.verify_integrity().is_ok());
    }

    #[test]
    fn strips_tts_pause_tags_and_preserves_pause_duration() {
        let (cleaned, pause) = remove_tts_pause_markers("One. <#0.5#> Two. <# 1.25 #>");
        assert_eq!(cleaned, "One. Two.");
        assert_eq!(pause, 1.75);
        assert_eq!(split_sentences("One. <#0.5#> Two."), vec!["One.", "Two."]);
    }

    #[test]
    fn cleaning_the_script_preserves_paragraph_breaks() {
        // Regression test: remove_tts_pause_markers used to collapse the
        // whole script to one line via a single split_whitespace().join(" "),
        // destroying every blank-line paragraph break before the script ever
        // reached the visual-plan engine. Its read_script() detects
        // paragraphs by splitting on exactly those blank lines, and
        // paragraph_scenes() (the Scene layer's fallback for per-sentence
        // pacing and the AI-error path) groups sentences into scenes by
        // paragraph — so a flattened script could never produce more than
        // one scene in those modes, no matter how the user had actually
        // formatted it.
        let (cleaned, _) = remove_tts_pause_markers(
            "Paragraph one, sentence one.\nStill paragraph one. <#0.5#>\n\nParagraph two starts here.\n\n\nParagraph three.",
        );
        let paragraphs: Vec<&str> = cleaned.split("\n\n").collect();
        assert_eq!(
            paragraphs,
            vec![
                "Paragraph one, sentence one. Still paragraph one.",
                "Paragraph two starts here.",
                "Paragraph three.",
            ]
        );
    }

    #[test]
    fn saves_pacing_presets_and_custom_ranges() {
        let (_temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let pacing = repo.save_video_pacing(&video.id, "calm", 10, 16).unwrap();
        assert_eq!(pacing.pacing_preset, "calm");
        assert_eq!(
            (pacing.pacing_min_seconds, pacing.pacing_max_seconds),
            (10, 16)
        );
        assert!(repo.save_video_pacing(&video.id, "custom", 12, 4).is_err());
    }

    #[test]
    fn picks_largest_veo_duration_that_fits_the_gap() {
        assert_eq!(pick_veo_duration(8.0), 8);
        assert_eq!(pick_veo_duration(7.9), 6);
        assert_eq!(pick_veo_duration(6.0), 6);
        assert_eq!(pick_veo_duration(5.9), 4);
        assert_eq!(pick_veo_duration(4.0), 4);
        assert_eq!(pick_veo_duration(3.0), 4);
        assert_eq!(pick_veo_duration(0.0), 4);
    }
}
