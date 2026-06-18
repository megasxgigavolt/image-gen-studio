use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

pub struct ProjectRepository {
    connection: Connection,
    projects_dir: PathBuf,
}

impl ProjectRepository {
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
            projects_dir: projects_dir.to_path_buf(),
        };
        repository.migrate()?;
        Ok(repository)
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
        Ok(())
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
}
