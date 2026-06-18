mod projects;

use projects::{Channel, InputAsset, ProjectRepository, ResumeState, Video, VideoInputs};
use std::fs;
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn application_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

type RepositoryState = Mutex<ProjectRepository>;

fn with_repository<T>(
    state: State<'_, RepositoryState>,
    operation: impl FnOnce(&ProjectRepository) -> Result<T, String>,
) -> Result<T, String> {
    let repository = state
        .lock()
        .map_err(|_| "Project database lock was poisoned.".to_string())?;
    operation(&repository)
}

#[tauri::command]
fn list_channels(
    state: State<'_, RepositoryState>,
    include_trashed: Option<bool>,
) -> Result<Vec<Channel>, String> {
    with_repository(state, |repository| {
        repository.list_channels(include_trashed.unwrap_or(false))
    })
}

#[tauri::command]
fn create_channel(
    state: State<'_, RepositoryState>,
    name: String,
    description: Option<String>,
) -> Result<Channel, String> {
    with_repository(state, |repository| {
        repository.create_channel(&name, description.as_deref())
    })
}

#[tauri::command]
fn list_videos(
    state: State<'_, RepositoryState>,
    channel_id: String,
    include_trashed: Option<bool>,
) -> Result<Vec<Video>, String> {
    with_repository(state, |repository| {
        repository.list_videos(&channel_id, include_trashed.unwrap_or(false))
    })
}

#[tauri::command]
fn create_video(
    state: State<'_, RepositoryState>,
    channel_id: String,
    title: String,
) -> Result<Video, String> {
    with_repository(state, |repository| {
        repository.create_video(&channel_id, &title)
    })
}

#[tauri::command]
fn get_resume_state(state: State<'_, RepositoryState>) -> Result<Option<ResumeState>, String> {
    with_repository(state, ProjectRepository::get_resume)
}

#[tauri::command]
fn set_resume_state(
    state: State<'_, RepositoryState>,
    channel_id: String,
    video_id: String,
    stage: String,
) -> Result<ResumeState, String> {
    with_repository(state, |repository| {
        repository.set_resume(&channel_id, &video_id, &stage)
    })
}

#[tauri::command]
fn trash_channel(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.trash_channel(&id))
}

#[tauri::command]
fn restore_channel(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.restore_channel(&id))
}

#[tauri::command]
fn trash_video(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.trash_video(&id))
}

#[tauri::command]
fn restore_video(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.restore_video(&id))
}

#[tauri::command]
fn create_video_snapshot(
    state: State<'_, RepositoryState>,
    video_id: String,
    payload_json: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository.create_snapshot(&video_id, &payload_json)
    })
}

#[tauri::command]
fn get_video_inputs(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VideoInputs, String> {
    with_repository(state, |repository| repository.get_video_inputs(&video_id))
}

#[tauri::command]
fn save_video_inputs(
    state: State<'_, RepositoryState>,
    video_id: String,
    script_text: String,
    pacing_seconds: i64,
) -> Result<VideoInputs, String> {
    with_repository(state, |repository| {
        repository.save_video_inputs(&video_id, &script_text, pacing_seconds)
    })
}

#[tauri::command]
fn pick_and_import_asset(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    kind: String,
) -> Result<Option<InputAsset>, String> {
    let mut picker = app.dialog().file();
    picker = if kind == "audio" {
        picker.add_filter("Narration audio", &["wav", "mp3", "m4a", "aac", "flac"])
    } else {
        picker.add_filter("Reference images", &["png", "jpg", "jpeg", "webp"])
    };
    let Some(path) = picker
        .blocking_pick_file()
        .and_then(|file| file.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    with_repository(state, |repository| {
        repository.import_asset(&video_id, &path, &kind)
    })
    .map(Some)
}

#[tauri::command]
fn remove_input_asset(state: State<'_, RepositoryState>, asset_id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.remove_asset(&asset_id))
}

#[tauri::command]
fn pick_script_text(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Plain text", &["txt"])
        .blocking_pick_file()
        .and_then(|file| file.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 1_000_000 {
        return Err("Script exceeds the 1 MB limit.".into());
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|_| "Script must be a UTF-8 plain-text file.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let repository = ProjectRepository::open(
                &data_dir.join("auto-gen-studio.db"),
                &data_dir.join("Projects"),
            )
            .map_err(std::io::Error::other)?;
            app.manage(Mutex::new(repository));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            application_version,
            list_channels,
            create_channel,
            list_videos,
            create_video,
            get_resume_state,
            set_resume_state,
            trash_channel,
            restore_channel,
            trash_video,
            restore_video,
            create_video_snapshot,
            get_video_inputs,
            save_video_inputs,
            pick_and_import_asset,
            remove_input_asset,
            pick_script_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auto Gen Studio");
}
