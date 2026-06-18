mod projects;

use projects::{Channel, ProjectRepository, ResumeState, Video};
use std::sync::Mutex;
use tauri::{Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            create_video_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auto Gen Studio");
}
