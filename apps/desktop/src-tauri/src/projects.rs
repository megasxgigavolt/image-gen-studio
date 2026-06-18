use base64::Engine;
use chrono::Utc;
use keyring::{Entry, Error as KeyringError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageWorkspaceGroup {
    pub group: PlanGroup,
    pub prompt_versions: Vec<PromptVersion>,
    pub image_renders: Vec<ImageRender>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageWorkspace {
    pub video_id: String,
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
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
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
        let (script_text, pacing_seconds, audio_id, updated_at): (String, i64, Option<String>, String) =
            self.connection.query_row(
                "SELECT script_text, pacing_seconds, audio_asset_id, updated_at FROM video_inputs WHERE video_id = ?1",
                [video_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
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
        let groups = plan
            .groups
            .into_iter()
            .map(|group| {
                let prompt_versions = self.list_prompt_versions(video_id, &group.id)?;
                let image_renders = self.list_image_renders(video_id, &group.id)?;
                Ok(ImageWorkspaceGroup {
                    group,
                    prompt_versions,
                    image_renders,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ImageWorkspace {
            video_id: video_id.into(),
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

    pub fn list_image_renders(
        &self,
        video_id: &str,
        group_id: &str,
    ) -> Result<Vec<ImageRender>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, created_at
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
                    created_at: row.get(10)?,
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
                "INSERT INTO image_renders(id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, video_id, group_id, version, prompt_version_id, file_name, relative_path, parent_render_id, edit_instruction, kind, created_at],
            )
            .map_err(|e| e.to_string())?;
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
            created_at,
        })
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
        let api_key = self
            .get_provider_key("gemini")?
            .ok_or("Add a Gemini API key in Settings before generating an image.")?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-2.5-flash-image".into());
        let prompt = assemble_image_prompt(system_prompt, user_prompt, &settings);
        let (image_bytes, extension) = request_gemini_image(&api_key, &model, &prompt)?;
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
    ) -> Result<ImageRender, String> {
        if instruction.trim().is_empty() {
            return Err("Describe the requested image change.".into());
        }
        let source: ImageRender = self.connection.query_row(
            "SELECT id,video_id,group_id,version,prompt_version_id,file_name,relative_path,parent_render_id,edit_instruction,kind,created_at FROM image_renders WHERE id=?1",
            [source_render_id],
            |row| Ok(ImageRender {
                id: row.get(0)?, video_id: row.get(1)?, group_id: row.get(2)?,
                version: row.get(3)?, prompt_version_id: row.get(4)?, file_name: row.get(5)?,
                relative_path: row.get(6)?, parent_render_id: row.get(7)?,
                edit_instruction: row.get(8)?, kind: row.get(9)?, created_at: row.get(10)?,
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
        let edit_prompt = format!(
            "Edit the provided image according to the user request.\n\nUse the input image as the visual source of truth. Preserve camera angle, composition, lighting, colors, subject identity, background, and every unrelated detail. Only modify what the request requires. Do not add text or watermarks.\n\nExisting style directive:\n{}\n\nOriginal prompt context:\n{}\n\nOriginal settings:\n{}\n\nUser edit request:\n{}",
            prompt.0, prompt.1, prompt.2, instruction.trim()
        );
        let api_key = self
            .get_provider_key("gemini")?
            .ok_or("Add a Gemini API key in Settings before editing an image.")?;
        let model = self
            .get_app_setting("gemini_model")?
            .unwrap_or_else(|| "gemini-2.5-flash-image".into());
        let (image_bytes, extension) = request_gemini_image_with_source(
            &api_key,
            &model,
            &edit_prompt,
            &source_bytes,
            mime_type,
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
        self.insert_image_render(
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
        )
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

    pub fn export_latest_stills(
        &self,
        video_id: &str,
        destination: &Path,
    ) -> Result<ExportResult, String> {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        let plan = self.get_visual_plan(video_id)?;
        let mut files = Vec::new();
        for group in plan.groups {
            if let Some(render) = self
                .list_image_renders(video_id, &group.id)?
                .into_iter()
                .next()
            {
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

    pub fn get_provider_key_status(&self, provider: &str) -> Result<ProviderKeyStatus, String> {
        Ok(ProviderKeyStatus {
            provider: provider.to_string(),
            configured: self.get_provider_key(provider)?.is_some(),
        })
    }

    pub fn create_image_job(&self, video_id: &str) -> Result<ImageJob, String> {
        let plan = self.get_visual_plan(video_id)?;
        let mut prompts = Vec::new();
        for group in plan.groups {
            if self.list_image_renders(video_id, &group.id)?.is_empty() {
                let prompt = self
                    .list_prompt_versions(video_id, &group.id)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| {
                        format!(
                            "{} needs a saved prompt before bulk generation.",
                            group.label
                        )
                    })?;
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
                "UPDATE image_job_items SET status='stopped',updated_at=?1 WHERE job_id=?2 AND status='queued'",
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
            Ok(render_id) => self.connection.execute("UPDATE image_job_items SET status='completed',render_id=?1,last_error=NULL,updated_at=?2 WHERE id=?3", params![render_id, now, item_id]),
            Err(error) => self.connection.execute("UPDATE image_job_items SET status='failed',last_error=?1,updated_at=?2 WHERE id=?3", params![error, now, item_id]),
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

    pub fn generate_visual_plan(&self, video_id: &str) -> Result<VisualPlan, String> {
        let inputs = self.get_video_inputs(video_id)?;
        if inputs.script_text.trim().is_empty() || inputs.audio.is_none() {
            return Err("Script and narration audio are required.".into());
        }
        let texts = split_sentences(&inputs.script_text);
        if texts.is_empty() {
            return Err("No sentences could be extracted from the script.".into());
        }
        let weights: Vec<usize> = texts
            .iter()
            .map(|text| text.split_whitespace().count().max(1))
            .collect();
        let total_words: usize = weights.iter().sum();
        let duration = (total_words as f64 * 0.4).max(1.0);
        let mut cursor = 0.0;
        let mut sentences = Vec::new();
        let sentence_count = texts.len();
        for (index, (text, weight)) in texts.into_iter().zip(weights).enumerate() {
            let end = if index + 1 == sentence_count {
                duration
            } else {
                cursor + duration * weight as f64 / total_words as f64
            };
            sentences.push(PlanSentence {
                id: format!("s{}", index + 1),
                ordinal: index as i64 + 1,
                text,
                start_seconds: cursor,
                end_seconds: end,
            });
            cursor = end;
        }
        if let Some(last) = sentences.last_mut() {
            last.end_seconds = duration;
        }
        let groups = build_groups(&sentences, inputs.pacing_seconds as f64);
        self.save_plan(video_id, &sentences, &groups, true, "estimated")?;
        self.save_plan(video_id, &sentences, &groups, false, "estimated")?;
        self.get_visual_plan(video_id)
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
                Ok(PlanSentence {
                    id: row.get(0)?,
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
        groups[source].sentence_ids.retain(|id| id != sentence_id);
        groups[target].sentence_ids.push(sentence_id.into());
        groups[target]
            .sentence_ids
            .sort_by_key(|id| sentence_number(id));
        groups.retain(|group| !group.sentence_ids.is_empty());
        for (index, group) in groups.iter_mut().enumerate() {
            group.ordinal = index as i64 + 1;
        }
        let sentences = self.get_visual_plan(video_id)?.sentences;
        self.save_plan(video_id, &sentences, &groups, false, "estimated")?;
        self.get_visual_plan(video_id)
    }

    pub fn reset_visual_plan(&self, video_id: &str) -> Result<VisualPlan, String> {
        let original = self.load_groups(video_id, true)?;
        let sentences = self.get_visual_plan(video_id)?.sentences;
        self.save_plan(video_id, &sentences, &original, false, "estimated")?;
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
                self.connection.execute("INSERT INTO visual_plan_sentences(id, video_id, ordinal, text, start_seconds, end_seconds) VALUES(?1,?2,?3,?4,?5,?6)", params![sentence.id, video_id, sentence.ordinal, sentence.text, sentence.start_seconds, sentence.end_seconds]).map_err(|e| e.to_string())?;
            }
        }
        self.connection
            .execute(
                "DELETE FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2",
                params![video_id, original as i64],
            )
            .map_err(|e| e.to_string())?;
        for group in groups {
            self.connection.execute("INSERT INTO visual_plan_groups(id, video_id, ordinal, label, kind, sentence_ids_json, is_original) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![format!("{}-{}", if original {"original"} else {"current"}, group.id), video_id, group.ordinal, group.label, group.kind, serde_json::to_string(&group.sentence_ids).unwrap(), original as i64]).map_err(|e| e.to_string())?;
        }
        self.connection.execute("INSERT INTO visual_plan_meta(video_id,timing_source,generated_at,updated_at) VALUES(?1,?2,?3,?3) ON CONFLICT(video_id) DO UPDATE SET timing_source=excluded.timing_source,updated_at=excluded.updated_at", params![video_id,timing_source,now]).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn load_groups(&self, video_id: &str, original: bool) -> Result<Vec<PlanGroup>, String> {
        let mut statement = self.connection.prepare("SELECT id, ordinal, label, kind, sentence_ids_json FROM visual_plan_groups WHERE video_id = ?1 AND is_original = ?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![video_id, original as i64], |row| {
                let stored_id: String = row.get(0)?;
                Ok(PlanGroup {
                    id: stored_id
                        .split_once('-')
                        .map(|(_, id)| id.to_string())
                        .unwrap_or(stored_id),
                    ordinal: row.get(1)?,
                    label: row.get(2)?,
                    kind: row.get(3)?,
                    sentence_ids: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
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
    format!(
        "SYSTEM DIRECTION:\n{}\n\nSCENE REQUEST:\n{}\n\nIMAGE SETTINGS:\n{}",
        system_prompt.trim(),
        user_prompt.trim(),
        serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into())
    )
}

fn request_gemini_image(
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let model = model.trim();
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
    {
        return Err("Gemini model name is invalid.".into());
    }
    let response = reqwest::blocking::Client::new()
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        ))
        .header("x-goog-api-key", api_key)
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}
        }))
        .send()
        .map_err(|error| format!("Could not reach Gemini: {error}"))?;
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
    api_key: &str,
    model: &str,
    prompt: &str,
    source_bytes: &[u8],
    mime_type: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let model = model.trim();
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
    {
        return Err("Gemini model name is invalid.".into());
    }
    let response = reqwest::blocking::Client::new()
        .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", api_key)
        .json(&json!({
            "contents": [{"parts": [
                {"inlineData": {"mimeType": mime_type, "data": base64::engine::general_purpose::STANDARD.encode(source_bytes)}},
                {"text": prompt}
            ]}],
            "generationConfig": {"responseModalities": ["IMAGE"]}
        }))
        .send()
        .map_err(|error| format!("Could not reach Gemini: {error}"))?;
    parse_gemini_image_response(response)
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
    let mut result = Vec::new();
    let mut current = String::new();
    for character in script.chars() {
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

fn build_groups(sentences: &[PlanSentence], target: f64) -> Vec<PlanGroup> {
    let mut groups = Vec::new();
    let mut pending: Vec<&PlanSentence> = Vec::new();
    for sentence in sentences {
        pending.push(sentence);
        if pending.last().unwrap().end_seconds - pending[0].start_seconds >= target {
            groups.push(make_group(groups.len() + 1, &pending));
            pending.clear();
        }
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
    }
}

fn sentence_number(id: &str) -> i64 {
    id.trim_start_matches('s').parse().unwrap_or(i64::MAX)
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
        repo.finish_job_item(&job.id, &claimed.0, Err("provider unavailable".into()))
            .unwrap();
        assert_eq!(repo.get_image_job(&job.id).unwrap().failed_items, 1);
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
}
