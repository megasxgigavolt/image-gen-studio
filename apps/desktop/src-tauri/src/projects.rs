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

pub const EDUCATIONAL_VISUAL_PLANNER_VERSION: &str = "3.0.0-bulk-plan-v2";

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
    script_text: String,
    pacing_seconds: i64,
    files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub file_count: usize,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPlanSummary {
    pub total_stills: usize,
    pub visual_type_counts: std::collections::HashMap<String, usize>,
    pub short_overview: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPlanResult {
    pub planner_version: u32,
    pub summary: BulkPlanSummary,
    pub stills: Vec<BulkPlannedStill>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualPlan {
    pub video_id: String,
    pub timing_source: String,
    pub sentences: Vec<PlanSentence>,
    pub groups: Vec<PlanGroup>,
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
        if !["calm", "balanced", "fast", "custom"].contains(&preset) {
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
        let plan = self.get_visual_plan(video_id)?;
        let sentences = plan.sentences.clone();
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
                "SELECT EXISTS(SELECT 1 FROM image_renders WHERE prompt_version_id=?1)",
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
            "SELECT id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, is_final, edit_strength, mask_path, mask_used, created_at
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
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at FROM image_renders WHERE id=?1",
            [render_id], |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?,
                is_final: row.get::<_, i64>(10)? != 0, edit_strength: row.get(11)?,
                mask_path: row.get(12)?, mask_used: row.get::<_, i64>(13)? != 0,
                created_at: row.get(14)?,
            }),
        ).map_err(|_| "Image version was not found.".to_string())?;
        let path = self.render_absolute_path(&render)?;
        self.connection.execute(
            "UPDATE image_renders SET parent_render_id=NULL WHERE parent_render_id=?1", [render_id],
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
        let api_key = self.get_provider_key("openai")?
            .ok_or("Add an OpenAI API key before suggesting prompts.")?;
        let request = format!(
            "Create one concise, production-ready image prompt for this narration still.\n\
             Voiceover: {voiceover}\nType: {}\nTimestamp: {:.1}-{:.1}s (duration {:.1}s)\n\
             Image settings: {settings_json}\nStyle directive: {style_directive}\n\
             Describe the main subject, action/emotion, relevant setting, framing, mood, and directly supportive visual details. \
             Be literal and hyper-relevant. Avoid generic cinematic filler, unrelated metaphors, random people or objects, overcrowding, and text in the image. Return only the prompt.",
            group.kind, start, end, end - start
        );
        request_openai_text(&api_key, &request)
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
        let api_key = self.get_provider_key("openai")?
            .ok_or("Add an OpenAI API key before planning educational visuals.")?;
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
        let planned = request_openai_educational_plan(&api_key, &request)?;
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
        let api_key = self.get_provider_key("openai")?
            .ok_or("Add an OpenAI API key before planning educational visuals.")?;
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
            let response = request_openai_whole_video_plan(&api_key, &request)?;
            if response.plans.len() != chunk.len() {
                return Err(format!(
                    "OpenAI returned {} plans for planning batch {} ({} stills expected).",
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

    pub fn extract_image_settings_from_directive(&self, directive: &str) -> Result<StyleExtraction, String> {
        let auth = self.gemini_auth()?;
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
        let text = request_gemini_text(&auth, &prompt)?;
        let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
        serde_json::from_str(cleaned).map_err(|_| "Style extraction was not valid JSON.".to_string())
    }

    pub fn plan_bulk_visuals<F: Fn(usize, usize)>(&self, video_id: &str, style_directive: &str, base_settings_json: &str, creative_instruction: &str, on_progress: F) -> Result<BulkPlanResult, String> {
        let auth = self.gemini_auth()?;
        let visual_plan = self.get_visual_plan(video_id)?;
        if visual_plan.groups.is_empty() {
            return Err("No stills found. Generate a visual plan first.".into());
        }
        let mut row_data: Vec<serde_json::Value> = Vec::with_capacity(visual_plan.groups.len());
        for group in &visual_plan.groups {
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
        let total = row_data.len();
        let mut planned: Vec<V2PlanStillResponse> = Vec::with_capacity(total);
        let chunk_size: usize = 6;
        let total_batches = total.div_ceil(chunk_size);
        let mut next_to_plan: usize = 0;
        let mut chunk_index: usize = 0;
        let mut api_calls: usize = 0;
        let max_api_calls = total_batches * 5;
        while next_to_plan < total && api_calls < max_api_calls {
            api_calls += 1;
            let chunk_end = (next_to_plan + chunk_size).min(total);
            let chunk = &row_data[next_to_plan..chunk_end];
            let prior_context: Vec<_> = planned.iter().rev().take(3).map(|s| json!({
                "visualPlanRowId": s.visual_plan_row_id,
                "visualType": s.visual_type,
            })).collect();
            let director_note = if creative_instruction.trim().is_empty() {
                String::new()
            } else {
                format!("\nDirector's creative instruction (apply to all stills): {}\n", creative_instruction.trim())
            };
            let prompt = format!(
                r#"You are an Educational Visual Director planning an entire video, not isolated stills.

Style directive: {style_directive}
Base image settings: {base_settings_json}{director_note}
Total stills in video: {total}. This is planning batch {} of {total_batches}.
Previously planned (last 3, newest first): {}

Current batch rows to plan:
{}

CORE GOAL: Ask "What image best helps the viewer understand this concept?" — never "What literally matches the sentence?"

INTERNAL TARGET DISTRIBUTION (soft targets; do not force inappropriate visuals):
Character Scene 25-35%; Behavioral Demonstration 10-15%; Close Detail 10-15%; Environmental Scene 5-10%; Object Focus 5-10%; Comparison 10-15%; Process Illustration 5-10%; Timeline 2-5%; Textless Infographic 5-10%; Scientific Diagram 2-8%; Geographic Map 0-5%; Concept Visualization 2-8%; POV Scene 0-5%; Symbolic Representation 2-8%; Documentary Frame 5-15%.

ANTI-REPETITION (enforce strictly):
- Never assign the same visualType to more than 3 consecutive stills.
- Vary subject framing, environment structure, and subject count across stills.
- For animal/nature/documentary videos: mix types — character scene, close detail, object focus, environment only, comparison, diagram — do not show only character portraits.

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

Rule: at least 6 of the 20 non-aspect settings must differ between consecutive stills.

USER PROMPT RULES — critical, zero overlap with the other two components:
The image is assembled from three SEPARATE layers: Style Directive (global look) + Image Settings (camera/light data) + User Prompt (scene content).
- userPrompt MUST contain ONLY: subjects, objects, actions, environment, spatial relationships — the WHAT of this specific scene
- userPrompt must NOT contain: cinematography style, color grade, film look, rendering style, visual treatment → those live in the Style Directive
- userPrompt must NOT contain: camera angle, lighting type, depth of field, lens, exposure, saturation, or any image-settings term → those live in imageSettings
- Ask yourself: "What is physically in this image?" — write exactly that, nothing more
- ✓ CORRECT: "A wolf pack crossing a frozen river at dusk, pine forest on both banks, snow-covered rocks in the foreground"
- ✗ WRONG: "A cinematic wide shot of a wolf pack with warm golden color grading and shallow depth of field crossing a river"

TEXTLESS VISUAL RULE (Textless Infographic, Timeline, Geographic Map, Scientific Diagram, Process Illustration):
- Use arrows, icons, silhouettes, spatial layout, visual contrast, before/after, symbolic shapes.
- Do NOT include readable text, labels, words, signs, or fake text in userPrompt.

Allowed visualType values: Character Scene; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Process Illustration; Timeline; Textless Infographic; Scientific Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

You MUST return exactly one plan for every row in the current batch. Return JSON only:
{{"plans":[{{"visualPlanRowId":"exact row id","visualType":"...","imageSettings":{{...}},"userPrompt":"scene content only — no style or camera words","reason":"1-2 sentences"}}]}}"#,
                chunk_index + 1,
                serde_json::to_string_pretty(&prior_context).unwrap_or_default(),
                serde_json::to_string_pretty(chunk).unwrap_or_default(),
            );
            let response = request_gemini_v2_plan(&auth, &prompt)?;
            let valid_count = {
                let mut count = 0;
                for (i, plan) in response.plans.iter().enumerate() {
                    if i >= chunk.len() { break; }
                    if plan.visual_plan_row_id == chunk[i]["visualPlanRowId"].as_str().unwrap_or_default() {
                        count += 1;
                    } else {
                        break;
                    }
                }
                count
            };
            if valid_count == 0 {
                return Err(format!(
                    "No usable plans returned for stills {}-{} (batch {}). Please retry.",
                    next_to_plan + 1, chunk_end, chunk_index + 1
                ));
            }
            for (offset, mut plan) in response.plans.into_iter().take(valid_count).enumerate() {
                let row = &chunk[offset];
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
                planned.push(plan);
            }
            next_to_plan += valid_count;
            on_progress(next_to_plan, total);
            chunk_index += 1;
        }
        if next_to_plan < total {
            return Err(format!("Planning incomplete after {api_calls} API calls: only {next_to_plan} of {total} stills planned."));
        }
        for window in planned.windows(4) {
            if window.iter().all(|p| p.visual_type == window[0].visual_type) {
                return Err(format!("Planner produced more than 3 consecutive '{}' stills. Please retry.", window[0].visual_type));
            }
        }
        let mut visual_type_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for p in &planned { *visual_type_counts.entry(p.visual_type.clone()).or_insert(0) += 1; }
        let short_overview = {
            let mut top: Vec<_> = visual_type_counts.iter().collect();
            top.sort_by(|a, b| b.1.cmp(a.1));
            let parts: Vec<_> = top.iter().take(4).map(|(k, v)| format!("{} {} ({}%)", v, k, (*v * 100) / total.max(1))).collect();
            format!("{} stills planned. Leading types: {}.", total, parts.join(", "))
        };
        let stills = planned.into_iter().zip(row_data.iter()).zip(visual_plan.groups.iter()).map(|((plan, row), group)| {
            let narration = row["narration"].as_str().unwrap_or_default().to_string();
            BulkPlannedStill {
                visual_plan_row_id: plan.visual_plan_row_id,
                ordinal: row["ordinal"].as_i64().unwrap_or(0),
                narration_preview: narration.chars().take(110).collect::<String>(),
                timestamp_start: row["startSeconds"].as_f64().unwrap_or(0.0),
                timestamp_end: row["endSeconds"].as_f64().unwrap_or(0.0),
                visual_type: plan.visual_type,
                image_settings: plan.image_settings,
                user_prompt: plan.user_prompt,
                reason: plan.reason,
                settings_locked: group.settings_locked,
                prompt_locked: group.prompt_locked,
            }
        }).collect();
        Ok(BulkPlanResult {
            planner_version: 2,
            summary: BulkPlanSummary { total_stills: total, visual_type_counts, short_overview },
            stills,
        })
    }

    pub fn suggest_still_prompt(&self, video_id: &str, group_id: &str, style_directive: &str, base_settings_json: &str) -> Result<BulkPlannedStill, String> {
        let api_key = self.get_provider_key("openai")?
            .ok_or("Add an OpenAI API key before suggesting a prompt.")?;
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
- Ask: "What is physically in this image?" — write exactly that

Allowed visualType values: Character Scene; Behavioral Demonstration; Close Detail; Environmental Scene; Object Focus; Comparison; Process Illustration; Timeline; Textless Infographic; Scientific Diagram; Geographic Map; Concept Visualization; POV Scene; Symbolic Representation; Documentary Frame.

Return JSON only — one plan object:
{{"plans":[{{"visualPlanRowId":"{}","visualType":"...","imageSettings":{{...}},"userPrompt":"scene content only","reason":"1-2 sentences"}}]}}"#,
            serde_json::to_string(&row).unwrap_or_default(),
            group.id,
        );
        let text = request_openai_text(&api_key, &prompt)?;
        let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
        let parsed: serde_json::Value = serde_json::from_str(cleaned)
            .map_err(|e| format!("OpenAI suggestion was not valid JSON: {e}"))?;
        let plan = parsed.pointer("/plans/0")
            .ok_or("OpenAI returned no plan.")?;
        let response: V2PlanStillResponse = serde_json::from_value(plan.clone())
            .map_err(|e| format!("OpenAI plan had unexpected structure: {e}"))?;
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

    pub fn approve_bulk_plan(&self, video_id: &str, style_directive: &str, stills: &[BulkPlannedStill]) -> Result<usize, String> {
        let now = Utc::now().to_rfc3339();
        let mut saved = 0usize;
        for still in stills {
            let group_id = &still.visual_plan_row_id;
            let (settings_locked, prompt_locked): (bool, bool) = self.connection.query_row(
                "SELECT COALESCE(settings_locked,0), COALESCE(prompt_locked,0) FROM visual_plan_groups WHERE video_id=?1 AND (id LIKE ?2 OR id=?2)",
                params![video_id, format!("%::{group_id}")],
                |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? != 0)),
            ).unwrap_or((false, false));
            if settings_locked && prompt_locked { continue; }
            let settings_json = if settings_locked {
                self.list_prompt_versions(video_id, group_id)?
                    .into_iter().next().map(|p| p.settings_json).unwrap_or_else(|| "{}".into())
            } else {
                still.image_settings.to_string()
            };
            let user_prompt = if prompt_locked {
                self.list_prompt_versions(video_id, group_id)?
                    .into_iter().next().map(|p| p.user_prompt).unwrap_or_default()
            } else {
                still.user_prompt.clone()
            };
            if user_prompt.trim().is_empty() { continue; }
            let next_version: i64 = self.connection.query_row(
                "SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE video_id=?1 AND group_id=?2",
                params![video_id, group_id],
                |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            let pv_id = Uuid::new_v4().to_string();
            self.connection.execute(
                "INSERT INTO prompt_versions(id,video_id,group_id,version,settings_json,system_prompt,user_prompt,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![pv_id, video_id, group_id, next_version, settings_json, style_directive, user_prompt, now],
            ).map_err(|e| e.to_string())?;
            let still_id = self.get_educational_visual_plan(video_id, group_id)?
                .map(|p| p.still_id).unwrap_or_else(|| Uuid::new_v4().to_string());
            let signature = format!("v2-bulk|{}|{}|{}", EDUCATIONAL_VISUAL_PLANNER_VERSION, video_id, group_id);
            self.connection.execute(
                "INSERT INTO educational_visual_plans(still_id,video_id,visual_plan_row_id,educational_objective,visual_intent,subject_strategy,image_settings_json,user_prompt,plan_signature,visual_strategy_mode,planner_version,created_at,updated_at)
                 VALUES(?1,?2,?3,'Planned',?4,'Single Subject',?5,?6,?7,'Auto Educational',?8,?9,?9)
                 ON CONFLICT(still_id) DO UPDATE SET educational_objective='Planned',visual_intent=excluded.visual_intent,subject_strategy='Single Subject',image_settings_json=excluded.image_settings_json,user_prompt=excluded.user_prompt,plan_signature=excluded.plan_signature,updated_at=excluded.updated_at",
                params![still_id, video_id, group_id, still.visual_type, settings_json, user_prompt, signature, EDUCATIONAL_VISUAL_PLANNER_VERSION, now],
            ).map_err(|e| e.to_string())?;
            saved += 1;
        }
        Ok(saved)
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
        let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
        serde_json::from_str(cleaned).map_err(|_| "Style analysis was not valid JSON.".to_string())
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
        let settings: serde_json::Value = serde_json::from_str(settings_json)
            .map_err(|_| "Image settings must be valid JSON.".to_string())?;
        let auth = self.gemini_auth()?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-3.1-flash-image".into());
        let prompt = assemble_image_prompt(system_prompt, user_prompt, &settings);
        let (image_bytes, extension) = request_gemini_image(
            &auth, &model, &prompt, requested_aspect_ratio(&settings),
        )?;
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
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,is_final,edit_strength,mask_path,mask_used,created_at FROM image_renders WHERE id=?1",
            [source_render_id],
            |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?,
                is_final: row.get::<_, i64>(10)? != 0, edit_strength: row.get(11)?,
                mask_path: row.get(12)?, mask_used: row.get::<_, i64>(13)? != 0,
                created_at: row.get(14)?,
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
        let root = self.projects_dir.join(channel_id).join(video_id);
        let mut relative_files = Vec::new();
        collect_relative_files(&root, &root, &mut relative_files)?;
        let manifest = ProjectBundleManifest {
            format: "auto-gen-studio-project".into(),
            version: 1,
            exported_at: Utc::now().to_rfc3339(),
            channel_name,
            video_title,
            stage,
            progress,
            script_text: inputs.script_text,
            pacing_seconds: inputs.pacing_seconds,
            files: relative_files.clone(),
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

    pub fn import_project_bundle(&self, source: &Path) -> Result<Video, String> {
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
        if manifest.format != "auto-gen-studio-project" || manifest.version != 1 {
            return Err("Unsupported project bundle format.".into());
        }
        for path in &manifest.files {
            validate_bundle_path(path)?;
            archive
                .by_name(&format!("assets/{path}"))
                .map_err(|_| format!("Bundle asset is missing: {path}"))?;
        }
        let channel =
            self.create_channel(&format!("{} (Imported)", manifest.channel_name), None)?;
        let video =
            self.create_video(&channel.id, &format!("{} (Imported)", manifest.video_title))?;
        let target = self.projects_dir.join(&channel.id).join(&video.id);
        let result = (|| {
            self.save_video_inputs(&video.id, &manifest.script_text, manifest.pacing_seconds)?;
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
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&target);
            let _ = self
                .connection
                .execute("DELETE FROM video_snapshots WHERE video_id=?1", [&video.id]);
            let _ = self
                .connection
                .execute("DELETE FROM video_inputs WHERE video_id=?1", [&video.id]);
            let _ = self
                .connection
                .execute("DELETE FROM videos WHERE id=?1", [&video.id]);
            let _ = self
                .connection
                .execute("DELETE FROM channels WHERE id=?1", [&channel.id]);
            return Err(error);
        }
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

    pub fn get_timeline(&self, video_id: &str) -> Result<Timeline, String> {
        let (duration_seconds, playhead_seconds, zoom, updated_at) = self.connection.query_row(
            "SELECT duration_seconds,playhead_seconds,zoom,updated_at FROM timelines WHERE video_id=?1",
            [video_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).map_err(|_| "Timeline has not been built.".to_string())?;
        let mut statement = self.connection.prepare(
            "SELECT id,group_id,render_id,ordinal,start_seconds,end_seconds,label FROM timeline_clips WHERE video_id=?1 ORDER BY ordinal"
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
        let duration: f64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(end_seconds),0) FROM timeline_clips WHERE video_id=?1",
                [video_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "UPDATE timelines SET duration_seconds=?1,updated_at=?2 WHERE video_id=?3",
                params![duration, Utc::now().to_rfc3339(), video_id],
            )
            .map_err(|e| e.to_string())?;
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

    pub fn create_image_job(&self, video_id: &str) -> Result<ImageJob, String> {
        let plan = self.get_visual_plan(video_id)?;
        let mut prompts = Vec::new();
        for group in plan.groups {
            let prompt = self.list_prompt_versions(video_id, &group.id)?.into_iter().next()
                .ok_or_else(|| format!("{} needs a saved prompt before bulk generation.", group.label))?;
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
                prompts.push((group.id, prompt.id));
            }
        }
        if prompts.is_empty() {
            return Err("There are no pending stills to generate.".into());
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
        if !["queued", "running", "paused", "stopped"].contains(&status) {
            return Err("Unsupported image job transition.".into());
        }
        self.connection.execute(
            "UPDATE image_jobs SET status=?1,updated_at=?2 WHERE id=?3 AND status NOT IN ('completed','failed')",
            params![status, Utc::now().to_rfc3339(), job_id],
        ).map_err(|e| e.to_string())?;
        if status == "stopped" {
            self.connection.execute(
                "UPDATE image_job_items SET status='stopped',updated_at=?1 WHERE job_id=?2 AND status IN ('queued','running')",
                params![Utc::now().to_rfc3339(), job_id],
            ).map_err(|e| e.to_string())?;
        }
        self.get_image_job(job_id)
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
            let groups = build_groups_range(
                &sentences,
                inputs.pacing_min_seconds as f64,
                inputs.pacing_max_seconds as f64,
            );
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                true,
                "estimated test fixture",
            )?;
            self.save_plan(
                video_id,
                &sentences,
                &groups,
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
            let grouping_engine = engine_dir.join("auto_gen_engine/scene_grouping_engine.py");
            if !grouping_engine.exists() {
                return Err(format!(
                    "Internal scene-grouping engine was not found at {}.",
                    grouping_engine.display()
                ));
            }
            // Ensure openai-whisper (and its torch dependency) is installed.
            // The installer handles the smaller packages; whisper (~1 GB) is
            // deferred to first use because it would make the installer too slow.
            let mut command = Command::new("python");
            command
                .arg(&grouping_engine)
                .arg(&audio_path)
                .arg(&script_path)
                .arg("--min-duration")
                .arg(inputs.pacing_min_seconds.to_string())
                .arg("--max-duration")
                .arg(inputs.pacing_max_seconds.to_string())
                .arg("--output")
                .arg(&output_path)
                .arg("--fallback-on-ai-error")
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
                    }
                })
                .collect::<Vec<_>>();
            self.save_plan(
                video_id,
                &sentences,
                &groups,
                true,
                "whisper + AI boundary scoring",
            )?;
            self.save_plan(
                video_id,
                &sentences,
                &groups,
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
        Ok(VisualPlan {
            video_id: video_id.into(),
            timing_source,
            sentences,
            groups,
            updated_at,
        })
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
        groups[target].sentence_ids.push(sentence_id.into());
        groups[target]
            .sentence_ids
            .sort_by_key(|id| sentence_number(id));
        groups.retain(|group| !group.sentence_ids.is_empty());
        for (index, group) in groups.iter_mut().enumerate() {
            group.ordinal = index as i64 + 1;
        }
        validate_group_chronology(&groups)?;
        let sentences = self.get_visual_plan(video_id)?.sentences;
        let timing_source = self.get_visual_plan(video_id)?.timing_source;
        self.save_plan(video_id, &sentences, &groups, false, &timing_source)?;
        self.get_visual_plan(video_id)
    }

    pub fn reset_visual_plan(&self, video_id: &str) -> Result<VisualPlan, String> {
        let original = self.load_groups(video_id, true)?;
        let sentences = self.get_visual_plan(video_id)?.sentences;
        let timing_source = self.get_visual_plan(video_id)?.timing_source;
        self.save_plan(video_id, &sentences, &original, false, &timing_source)?;
        self.get_visual_plan(video_id)
    }

    pub fn create_plan_group(
        &self,
        video_id: &str,
        sentence_id: &str,
        insert_index: usize,
    ) -> Result<VisualPlan, String> {
        let mut groups = self.load_groups(video_id, false)?;
        let source = groups
            .iter()
            .position(|group| group.sentence_ids.contains(&sentence_id.to_string()))
            .ok_or("Sentence was not found.")?;
        let source_ids = &groups[source].sentence_ids;
        let expected_insert_index = if source_ids.first().map(String::as_str) == Some(sentence_id) {
            source
        } else if source_ids.last().map(String::as_str) == Some(sentence_id) {
            source + 1
        } else {
            return Err(
                "A new still can only be created from the first or last sentence of an existing still."
                    .into(),
            );
        };
        if insert_index != expected_insert_index {
            return Err("Drop at the sentence's chronological boundary to create a new still.".into());
        }
        groups[source].sentence_ids.retain(|id| id != sentence_id);
        groups.retain(|group| !group.sentence_ids.is_empty());
        let next_id = groups
            .iter()
            .map(|group| sentence_number(group.id.trim_start_matches('g')))
            .max()
            .unwrap_or(0)
            + 1;
        let target = insert_index.min(groups.len());
        groups.insert(
            target,
            PlanGroup {
                id: format!("g{next_id}"),
                ordinal: 0,
                label: "New scene".into(),
                kind: "custom".into(),
                sentence_ids: vec![sentence_id.into()],
                settings_locked: false,
                prompt_locked: false,
            },
        );
        for (index, group) in groups.iter_mut().enumerate() {
            group.ordinal = index as i64 + 1;
        }
        validate_group_chronology(&groups)?;
        let current = self.get_visual_plan(video_id)?;
        self.save_plan(
            video_id,
            &current.sentences,
            &groups,
            false,
            &current.timing_source,
        )?;
        self.get_visual_plan(video_id)
    }

    fn save_plan(
        &self,
        video_id: &str,
        sentences: &[PlanSentence],
        groups: &[PlanGroup],
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
                "INSERT INTO visual_plan_groups(id, video_id, ordinal, label, kind, sentence_ids_json, is_original) VALUES(?1,?2,?3,?4,?5,?6,?7)",
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
                    original as i64
                ],
            ).map_err(|e| e.to_string())?;
        }
        self.connection.execute("INSERT INTO visual_plan_meta(video_id,timing_source,generated_at,updated_at) VALUES(?1,?2,?3,?3) ON CONFLICT(video_id) DO UPDATE SET timing_source=excluded.timing_source,updated_at=excluded.updated_at", params![video_id,timing_source,now]).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn load_groups(&self, video_id: &str, original: bool) -> Result<Vec<PlanGroup>, String> {
        let mut statement = self.connection.prepare("SELECT id, ordinal, label, kind, sentence_ids_json, COALESCE(settings_locked,0), COALESCE(prompt_locked,0) FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
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
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
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
}

#[derive(Debug, Deserialize)]
struct V2PlanChunkResponse {
    plans: Vec<V2PlanStillResponse>,
}

fn request_openai_v2_plan(api_key: &str, prompt: &str) -> Result<V2PlanChunkResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| format!("Could not initialize OpenAI client: {e}"))?;
    let mut last_err = String::new();
    let response = loop {
        let attempt = last_err.matches("attempt").count();
        match client.post("https://api.openai.com/v1/responses")
            .bearer_auth(api_key)
            .json(&json!({"model":"gpt-4.1-mini","input":prompt,"max_output_tokens":18000}))
            .send() {
            Ok(r) => break r,
            Err(e) if attempt < 3 => {
                last_err.push_str(&format!(" attempt {attempt}: {e}"));
                std::thread::sleep(std::time::Duration::from_secs(4 * 2_u64.pow(attempt as u32)));
            }
            Err(e) => return Err(format!("Could not reach OpenAI after retries: {e}")),
        }
    };
    let status = response.status();
    let body: serde_json::Value = response.json().map_err(|e| format!("OpenAI returned unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI bulk planning failed ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unknown error")));
    }
    let text = body.pointer("/output/0/content/0/text").and_then(|v| v.as_str())
        .ok_or("OpenAI returned no bulk plan.")?;
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str(cleaned).map_err(|e| format!("OpenAI bulk plan was not valid JSON: {e}"))
}

fn request_openai_directive_extract(api_key: &str, directive: &str) -> Result<StyleExtraction, String> {
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
    let text = request_openai_text(api_key, &prompt)?;
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str(cleaned).map_err(|_| "OpenAI directive extraction was not valid JSON.".to_string())
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
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
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
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
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
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str(cleaned).map_err(|_| "OpenAI style analysis was not valid JSON.".to_string())
}

fn gemini_generatecontent_url(auth: &GeminiAuth, model: &str) -> String {
    match auth {
        GeminiAuth::ApiKey(_) => format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
        GeminiAuth::Vertex { project_id, .. } => format!("https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/google/models/{model}:generateContent"),
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
    body.pointer("/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

fn request_gemini_text(auth: &GeminiAuth, prompt: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let response = gemini_client_request(&client, auth, "gemini-2.0-flash")
        .json(&json!({
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": 2000}
        }))
        .send().map_err(|e| format!("Could not reach Gemini: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().map_err(|e| format!("Gemini returned an unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Gemini error ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("request failed")));
    }
    gemini_extract_text(&body).ok_or_else(|| "Gemini returned no text.".to_string())
}

fn request_gemini_vision(auth: &GeminiAuth, prompt: &str, mime: &str, bytes: &[u8]) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let image_data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let response = gemini_client_request(&client, auth, "gemini-2.0-flash")
        .json(&json!({
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": mime, "data": image_data}},
                {"text": prompt}
            ]}],
            "generationConfig": {"maxOutputTokens": 900}
        }))
        .send().map_err(|e| format!("Could not reach Gemini: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().map_err(|e| format!("Gemini returned an unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Gemini vision error ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("request failed")));
    }
    gemini_extract_text(&body).ok_or_else(|| "Gemini returned no vision analysis.".to_string())
}

fn request_gemini_v2_plan(auth: &GeminiAuth, prompt: &str) -> Result<V2PlanChunkResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| format!("Could not initialize Gemini client: {e}"))?;
    let mut last_err = String::new();
    let response = loop {
        let attempt = last_err.matches("attempt").count();
        match gemini_client_request(&client, auth, "gemini-2.0-flash")
            .json(&json!({
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 18000}
            })).send() {
            Ok(r) => break r,
            Err(e) if attempt < 3 => {
                last_err.push_str(&format!(" attempt {attempt}: {e}"));
                std::thread::sleep(std::time::Duration::from_secs(4 * 2_u64.pow(attempt as u32)));
            }
            Err(e) => return Err(format!("Could not reach Gemini after retries: {e}")),
        }
    };
    let status = response.status();
    let body: serde_json::Value = response.json().map_err(|e| format!("Gemini returned unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Gemini bulk planning failed ({status}): {}", body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unknown error")));
    }
    let text = gemini_extract_text(&body).ok_or("Gemini returned no bulk plan.")?;
    let cleaned = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str(cleaned).map_err(|e| format!("Gemini bulk plan was not valid JSON: {e}"))
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
    let client = reqwest::blocking::Client::new();
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
    let client = reqwest::blocking::Client::new();
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
            return (cleaned, pauses);
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
    (
        cleaned.split_whitespace().collect::<Vec<_>>().join(" "),
        pauses,
    )
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
        let original = repo.generate_visual_plan(&video.id).unwrap();
        assert!(!original.groups.is_empty());
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

    #[test]
    fn rejects_non_chronological_group_sequences() {
        let groups = vec![
            PlanGroup {
                id: "g1".into(),
                ordinal: 1,
                label: "First".into(),
                kind: "still".into(),
                sentence_ids: vec!["s1".into(), "s3".into()],
            },
            PlanGroup {
                id: "g2".into(),
                ordinal: 2,
                label: "Second".into(),
                kind: "still".into(),
                sentence_ids: vec!["s2".into()],
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
            let plan = repo.generate_visual_plan(&video.id).unwrap();
            assert_eq!(plan.sentences[0].id, "s1");
            assert_eq!(plan.groups[0].id, "g1");
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
        let plan = repo.generate_visual_plan(&video.id).unwrap();
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
    fn creates_and_controls_persistent_bulk_jobs() {
        let (temp, repo) = repository();
        let channel = repo.create_channel("Channel", None).unwrap();
        let video = repo.create_video(&channel.id, "Video").unwrap();
        let audio = temp.path().join("voice.wav");
        fs::write(&audio, b"audio").unwrap();
        repo.save_video_inputs(&video.id, "First scene. Second scene.", 4)
            .unwrap();
        repo.import_asset(&video.id, &audio, "audio").unwrap();
        let plan = repo.generate_visual_plan(&video.id).unwrap();
        for group in plan.groups {
            repo.create_prompt_version(&video.id, &group.id, "{}", "system", "scene")
                .unwrap();
        }
        let job = repo.create_image_job(&video.id).unwrap();
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
        let imported = repo.import_project_bundle(&bundle).unwrap();
        assert_ne!(imported.id, video.id);
        assert_eq!(
            repo.get_video_inputs(&imported.id).unwrap().script_text,
            "Portable script."
        );
        assert!(temp
            .path()
            .join("Projects")
            .join(imported.channel_id)
            .join(imported.id)
            .join("renders/sample.png")
            .exists());
    }

    #[test]
    fn rejects_unsafe_bundle_paths() {
        assert!(validate_bundle_path("../secret.txt").is_err());
        assert!(validate_bundle_path("renders/safe.png").is_ok());
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
        repo.generate_visual_plan(&video.id).unwrap();
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
}
