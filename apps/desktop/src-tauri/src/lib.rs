mod projects;

use projects::{
    Channel, ExportResult, ImageJob, ImageRender, ImageWorkspace, InputAsset, ProjectRepository,
    PromptVersion, ResumeState, Timeline, Video, VideoInputs, VisualPlan,
};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use base64::Engine;
use serde_json::json;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn application_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

type RepositoryState = Mutex<ProjectRepository>;
struct StartupState {
    recovery_backup: Option<PathBuf>,
}

#[tauri::command]
fn startup_diagnostic(state: State<'_, StartupState>) -> Option<String> {
    state.recovery_backup.as_ref().map(|path| format!(
        "The local database was damaged and replaced with a clean database. A recovery copy was preserved at {}.",
        path.display()
    ))
}

fn with_repository<T>(
    state: State<'_, RepositoryState>,
    operation: impl FnOnce(&ProjectRepository) -> Result<T, String>,
) -> Result<T, String> {
    // Recover the connection even if a previous command panicked while holding
    // the lock. Without this, one panic would poison the mutex and make EVERY
    // later database call fail until the app is restarted — which manifests as
    // "navigation works once, then never again until relaunch".
    let repository = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
fn rename_channel(state: State<'_, RepositoryState>, id: String, name: String) -> Result<(), String> {
    with_repository(state, |repository| repository.rename_channel(&id, &name))
}

#[tauri::command]
fn rename_video(state: State<'_, RepositoryState>, id: String, title: String) -> Result<(), String> {
    with_repository(state, |repository| repository.rename_video(&id, &title))
}

#[tauri::command]
fn permanent_delete_video(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.permanent_delete_video(&id))
}

#[tauri::command]
fn permanent_delete_channel(state: State<'_, RepositoryState>, id: String) -> Result<(), String> {
    with_repository(state, |repository| repository.permanent_delete_channel(&id))
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
fn save_video_pacing(
    state: State<'_, RepositoryState>,
    video_id: String,
    preset: String,
    min_seconds: i64,
    max_seconds: i64,
) -> Result<VideoInputs, String> {
    with_repository(state, |repository| {
        repository.save_video_pacing(&video_id, &preset, min_seconds, max_seconds)
    })
}

#[tauri::command]
fn get_app_setting(
    state: State<'_, RepositoryState>,
    key: String,
) -> Result<Option<String>, String> {
    with_repository(state, |repository| repository.get_app_setting(&key))
}

#[tauri::command]
fn save_app_setting(
    state: State<'_, RepositoryState>,
    key: String,
    value: String,
) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.save_app_setting(&key, &value)
    })
}

#[tauri::command]
fn list_prompt_versions(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
) -> Result<Vec<PromptVersion>, String> {
    with_repository(state, |repository| {
        repository.list_prompt_versions(&video_id, &group_id)
    })
}

#[tauri::command]
fn create_prompt_version(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_json: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<PromptVersion, String> {
    with_repository(state, |repository| {
        repository.create_prompt_version(
            &video_id,
            &group_id,
            &settings_json,
            &system_prompt,
            &user_prompt,
        )
    })
}

#[tauri::command]
fn delete_prompt_version(
    state: State<'_, RepositoryState>,
    prompt_version_id: String,
) -> Result<(), String> {
    with_repository(state, |repository| repository.delete_prompt_version(&prompt_version_id))
}

#[tauri::command]
fn list_image_renders(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
) -> Result<Vec<ImageRender>, String> {
    with_repository(state, |repository| {
        repository.list_image_renders(&video_id, &group_id)
    })
}

#[tauri::command]
async fn generate_image_render(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    prompt_version_id: String,
    system_prompt: String,
    user_prompt: String,
    settings_json: String,
) -> Result<ImageRender, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        let mut last_error = String::new();
        for attempt in 0..4 {
            match repository.generate_image_render(
                &video_id, &group_id, &prompt_version_id, &system_prompt, &user_prompt, &settings_json,
            ) {
                Ok(render) => return Ok(render),
                Err(error) => {
                    last_error = error;
                    if attempt < 3 {
                        let rate_limited = last_error.contains("429") || last_error.to_ascii_lowercase().contains("resource exhausted");
                        let delay = if rate_limited { 20 * 2_u64.pow(attempt) } else { 2 * 2_u64.pow(attempt) };
                        thread::sleep(Duration::from_secs(delay.min(120)));
                    }
                }
            }
        }
        Err(last_error)
    }).await.map_err(|error| format!("Image generation worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn get_image_workspace(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<ImageWorkspace, String> {
    with_repository(state, |repository| {
        repository.get_image_workspace(&video_id)
    })
}

#[tauri::command]
async fn edit_image_render(
    state: State<'_, RepositoryState>,
    source_render_id: String,
    instruction: String,
    mask_data_url: Option<String>,
    edit_strength: String,
) -> Result<ImageRender, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.edit_image_render(&source_render_id, &instruction, mask_data_url.as_deref(), &edit_strength)
    }).await.map_err(|error| format!("Image editing worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn set_final_render(
    state: State<'_, RepositoryState>,
    render_id: String,
    is_final: bool,
) -> Result<ImageRender, String> {
    with_repository(state, |repository| repository.set_final_render(&render_id, is_final))
}

#[tauri::command]
fn delete_image_render(
    state: State<'_, RepositoryState>,
    render_id: String,
) -> Result<(), String> {
    with_repository(state, |repository| repository.delete_image_render(&render_id))
}

#[tauri::command]
fn reset_image_workflow(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<(), String> {
    with_repository(state, |repository| repository.reset_image_workflow(&video_id))
}

#[tauri::command]
async fn suggest_image_prompt(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_json: String,
    style_directive: String,
) -> Result<String, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.suggest_image_prompt(&video_id, &group_id, &settings_json, &style_directive)
    })
    .await
    .map_err(|error| format!("Prompt worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn plan_educational_visual(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_json: String,
    style_directive: String,
) -> Result<projects::EducationalVisualPlan, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_educational_visual(&video_id, &group_id, &settings_json, &style_directive)
    }).await.map_err(|error| format!("Educational planner stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn plan_whole_video_educational_visuals(
    state: State<'_, RepositoryState>,
    video_id: String,
    settings_json: String,
    style_directive: String,
    strategy_mode: String,
) -> Result<projects::WholeVideoEducationalPlan, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_whole_video_educational_visuals(&video_id, &settings_json, &style_directive, &strategy_mode)
    }).await.map_err(|error| format!("Whole-video planner stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn extract_reference_style(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<projects::StyleExtraction, String> {
    with_repository(state, |repository| repository.extract_reference_style(&asset_id))
}

#[tauri::command]
fn set_still_lock(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_locked: bool,
    prompt_locked: bool,
) -> Result<(), String> {
    with_repository(state, |repository| repository.set_still_lock(&video_id, &group_id, settings_locked, prompt_locked))
}

#[tauri::command]
fn extract_image_settings_from_directive(
    state: State<'_, RepositoryState>,
    directive: String,
) -> Result<projects::StyleExtraction, String> {
    with_repository(state, |repository| repository.extract_image_settings_from_directive(&directive))
}

#[tauri::command]
async fn suggest_still_prompt(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    style_directive: String,
    base_settings_json: String,
) -> Result<projects::BulkPlannedStill, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.suggest_still_prompt(&video_id, &group_id, &style_directive, &base_settings_json)
    }).await.map_err(|e| format!("Prompt suggestion stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn plan_bulk_visuals(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    style_directive: String,
    base_settings_json: String,
    creative_instruction: String,
) -> Result<projects::BulkPlanResult, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_bulk_visuals(&video_id, &style_directive, &base_settings_json, &creative_instruction, |planned, total| {
            let _ = app.emit("bulk_plan_progress", serde_json::json!({ "planned": planned, "total": total }));
        })
    }).await.map_err(|e| format!("Bulk planner stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn approve_bulk_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
    style_directive: String,
    stills: Vec<projects::BulkPlannedStill>,
) -> Result<usize, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.approve_bulk_plan(&video_id, &style_directive, &stills)
    }).await.map_err(|e| format!("Bulk plan approval stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn get_render_data_url(
    state: State<'_, RepositoryState>,
    render_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        let (mime, data) = repository.read_render_file(&render_id)?;
        Ok(format!("data:{mime};base64,{data}"))
    })
}

#[tauri::command]
fn get_asset_data_url(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        let (mime, data) = repository.read_asset_file(&asset_id)?;
        Ok(format!("data:{mime};base64,{data}"))
    })
}

#[tauri::command]
fn pick_download_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|value| value.as_path().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn copy_render_to_folder(
    state: State<'_, RepositoryState>,
    render_id: String,
    folder_path: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository.copy_render_to_folder(&render_id, &folder_path)
    })
}

#[tauri::command]
fn export_latest_stills(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Option<ExportResult>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    with_repository(state, |repository| {
        repository.export_latest_stills(&video_id, &path)
    })
    .map(Some)
}

#[tauri::command]
fn export_project_bundle(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Option<ExportResult>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Auto Gen Studio project", &["agsproj"])
        .set_file_name("project.agsproj")
        .blocking_save_file()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    with_repository(state, |repository| {
        repository.export_project_bundle(&video_id, &path)
    })
    .map(Some)
}

#[tauri::command]
fn import_project_bundle(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
) -> Result<Option<Video>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Auto Gen Studio project", &["agsproj"])
        .blocking_pick_file()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    with_repository(state, |repository| repository.import_project_bundle(&path)).map(Some)
}

#[tauri::command]
fn build_timeline(state: State<'_, RepositoryState>, video_id: String) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.build_timeline(&video_id))
}

#[tauri::command]
fn get_timeline(state: State<'_, RepositoryState>, video_id: String) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.get_timeline(&video_id))
}

#[tauri::command]
fn update_timeline_view(
    state: State<'_, RepositoryState>,
    video_id: String,
    playhead: f64,
    zoom: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_timeline_view(&video_id, playhead, zoom)
    })
}

#[tauri::command]
fn update_timeline_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    start: f64,
    end: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_timeline_clip(&video_id, &clip_id, start, end)
    })
}

fn spawn_job_workers(
    database_path: std::path::PathBuf,
    projects_dir: std::path::PathBuf,
    job_id: String,
) {
    // Vertex image quotas are commonly burst-limited. A single paced worker avoids
    // parallel 429 storms while still allowing the batch to continue after failures.
    for _ in 0..1 {
        let database_path = database_path.clone();
        let projects_dir = projects_dir.clone();
        let job_id = job_id.clone();
        thread::spawn(move || {
            let Ok(repository) = ProjectRepository::open(&database_path, &projects_dir) else {
                return;
            };
            loop {
                let Ok(Some((item_id, video_id, group_id, prompt))) =
                    repository.claim_job_item(&job_id)
                else {
                    break;
                };
                let mut last_error = String::new();
                let mut render_id = None;
                for attempt in 0..5 {
                    if repository.image_job_status(&job_id).ok().as_deref() == Some("stopped") {
                        break;
                    }
                    match repository.generate_image_render(
                        &video_id,
                        &group_id,
                        &prompt.id,
                        &prompt.system_prompt,
                        &prompt.user_prompt,
                        &prompt.settings_json,
                    ) {
                        Ok(render) => {
                            render_id = Some(render.id);
                            break;
                        }
                        Err(error) => {
                            last_error = error;
                            if attempt < 4 {
                                let rate_limited = last_error.contains("429")
                                    || last_error.to_ascii_lowercase().contains("resource exhausted");
                                let delay = if rate_limited { 30 * 2_u64.pow(attempt) } else { 3 * 2_u64.pow(attempt) };
                                let mut remaining = delay.min(240);
                                while remaining > 0 {
                                    if repository.image_job_status(&job_id).ok().as_deref() == Some("stopped") {
                                        break;
                                    }
                                    thread::sleep(Duration::from_secs(1));
                                    remaining -= 1;
                                }
                            }
                        }
                    }
                }
                if repository.image_job_status(&job_id).ok().as_deref() == Some("stopped") {
                    break;
                }
                let result = render_id.ok_or(last_error);
                let _ = repository.finish_job_item(&job_id, &item_id, result);
                for _ in 0..8 {
                    if repository.image_job_status(&job_id).ok().as_deref() == Some("stopped") {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
        });
    }
}

#[tauri::command]
fn create_image_job(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<ImageJob, String> {
    let (job, paths) = with_repository(state, |repository| {
        let job = repository.create_image_job(&video_id)?;
        Ok((job, repository.paths()))
    })?;
    spawn_job_workers(paths.0, paths.1, job.id.clone());
    Ok(job)
}

#[tauri::command]
fn get_latest_image_job(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Option<ImageJob>, String> {
    with_repository(state, |repository| repository.latest_image_job(&video_id))
}

#[tauri::command]
fn control_image_job(
    state: State<'_, RepositoryState>,
    job_id: String,
    action: String,
) -> Result<ImageJob, String> {
    let (job, paths) = with_repository(state, |repository| {
        let status = match action.as_str() {
            "pause" => "paused",
            "resume" => "queued",
            "stop" => "stopped",
            _ => return Err("Unknown job action.".into()),
        };
        let job = repository.set_image_job_status(&job_id, status)?;
        Ok((job, repository.paths()))
    })?;
    if action == "resume" {
        spawn_job_workers(paths.0, paths.1, job.id.clone());
    }
    Ok(job)
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

#[tauri::command]
async fn generate_visual_plan(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VisualPlan, String> {
    let (database_path, projects_dir) = {
        let repository = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        repository.paths()
    };
    let engine_dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../services/python-engine")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| format!("Could not locate app resource directory: {e}"))?
            .join("python-engine")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        let event_video_id = video_id.clone();
        repository.generate_visual_plan_with_progress(&video_id, &engine_dir, |percent, stage, detail| {
            let _ = app.emit(
                "visual-plan-progress",
                serde_json::json!({
                    "videoId": &event_video_id,
                    "percent": percent,
                    "stage": stage,
                    "detail": detail,
                }),
            );
        })
    })
    .await
    .map_err(|error| format!("Visual-plan worker failed: {error}"))?
}

#[tauri::command]
fn get_visual_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| repository.get_visual_plan(&video_id))
}

#[tauri::command]
fn move_plan_sentence(
    state: State<'_, RepositoryState>,
    video_id: String,
    sentence_id: String,
    target_group_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.move_plan_sentence(&video_id, &sentence_id, &target_group_id)
    })
}

#[tauri::command]
fn create_plan_group(
    state: State<'_, RepositoryState>,
    video_id: String,
    sentence_id: String,
    insert_index: usize,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.create_plan_group(&video_id, &sentence_id, insert_index)
    })
}

#[tauri::command]
fn reset_visual_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| repository.reset_visual_plan(&video_id))
}

#[tauri::command]
fn pick_thumbnail_image(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let path = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))?;
    let bytes = fs::read(&path).ok()?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image.png".into());
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let data_url = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    Some(json!({ "dataUrl": data_url, "fileName": file_name }))
}

#[tauri::command]
async fn edit_thumbnail_image(
    state: State<'_, RepositoryState>,
    source_data_url: String,
    instruction: String,
    mask_data_url: Option<String>,
    edit_strength: String,
    aspect_ratio: String,
) -> Result<String, String> {
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = projects::ProjectRepository::open(&database_path, &projects_dir)?;
        repository.edit_thumbnail(
            &source_data_url,
            &instruction,
            mask_data_url.as_deref(),
            &edit_strength,
            &aspect_ratio,
        )
    })
    .await
    .map_err(|error| format!("Thumbnail editing stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn save_thumbnail_image(
    app: tauri::AppHandle,
    data_url: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PNG Image", &["png"])
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    let comma_pos = data_url
        .find(',')
        .ok_or("Invalid image data URL.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_url[comma_pos + 1..])
        .map_err(|error| format!("Could not decode image: {error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("Could not save image: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Load dev-only .env files and service account credentials from the
            // local workspace. In release builds keys come from the keyring only.
            #[cfg(debug_assertions)]
            {
                let engine_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../services/python-engine");
                let workspace_env = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../.env");
                for local_env in [workspace_env, engine_dir.join(".env")] {
                    if let Ok(contents) = fs::read_to_string(local_env) {
                        for line in contents.lines() {
                            let Some((key, value)) = line.split_once('=') else {
                                continue;
                            };
                            let key = key.trim();
                            if ["OPENAI_API_KEY", "GEMINI_API_KEY"].contains(&key)
                                && std::env::var_os(key).is_none()
                            {
                                std::env::set_var(key, value.trim().trim_matches(['"', '\'']));
                            }
                        }
                    }
                }
                let google_credentials = engine_dir.join("google-service-account.json");
                if google_credentials.exists()
                    && std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").is_none()
                {
                    std::env::set_var("GOOGLE_APPLICATION_CREDENTIALS", &google_credentials);
                }
            }
            // Release: load bundled service account credentials for Gemini
            #[cfg(not(debug_assertions))]
            if std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").is_none() {
                if let Ok(resource_dir) = app.path().resource_dir() {
                    let bundled = resource_dir.join("google-service-account.json");
                    if bundled.exists() {
                        std::env::set_var("GOOGLE_APPLICATION_CREDENTIALS", &bundled);
                    }
                }
            }
            // Release: inject API keys that were embedded at compile time from
            // the workspace .env so users never need to configure credentials.
            #[cfg(not(debug_assertions))]
            {
                const EMBEDDED_OPENAI: Option<&str> = option_env!("OPENAI_API_KEY");
                const EMBEDDED_GEMINI: Option<&str> = option_env!("GEMINI_API_KEY");
                for (var, key) in [
                    ("OPENAI_API_KEY", EMBEDDED_OPENAI),
                    ("GEMINI_API_KEY", EMBEDDED_GEMINI),
                ] {
                    if let Some(k) = key {
                        if !k.is_empty() && std::env::var_os(var).is_none() {
                            std::env::set_var(var, k);
                        }
                    }
                }
            }
            let data_dir = app.path().app_local_data_dir()?;
            let (repository, recovery_backup) = ProjectRepository::open_with_recovery(
                &data_dir.join("auto-gen-studio.db"),
                &data_dir.join("Projects"),
            )
            .map_err(std::io::Error::other)?;
            repository
                .recover_image_jobs()
                .map_err(std::io::Error::other)?;
            if repository.get_app_setting("gemini_model").map_err(std::io::Error::other)?
                .as_deref() != Some("gemini-3.1-flash-image")
            {
                repository.save_app_setting("gemini_model", "gemini-3.1-flash-image")
                    .map_err(std::io::Error::other)?;
            }
            for (provider, variable) in [("gemini", "GEMINI_API_KEY"), ("openai", "OPENAI_API_KEY")]
            {
                if let Ok(secret) = std::env::var(variable) {
                    if !secret.trim().is_empty() {
                        repository
                            .save_provider_key(provider, secret.trim())
                            .map_err(std::io::Error::other)?;
                    }
                }
            }
            app.manage(Mutex::new(repository));
            app.manage(StartupState { recovery_backup });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            application_version,
            startup_diagnostic,
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
            save_video_pacing,
            pick_and_import_asset,
            remove_input_asset,
            pick_script_text,
            generate_visual_plan,
            get_visual_plan,
            move_plan_sentence,
            create_plan_group,
            reset_visual_plan,
            get_app_setting,
            save_app_setting,
            list_prompt_versions,
            create_prompt_version,
            delete_prompt_version,
            list_image_renders,
            generate_image_render,
            get_image_workspace,
            create_image_job,
            get_latest_image_job,
            control_image_job,
            edit_image_render,
            set_final_render,
            delete_image_render,
            reset_image_workflow,
            suggest_image_prompt,
            plan_educational_visual,
            plan_whole_video_educational_visuals,
            extract_reference_style,
            set_still_lock,
            extract_image_settings_from_directive,
            suggest_still_prompt,
            plan_bulk_visuals,
            approve_bulk_plan,
            get_render_data_url,
            get_asset_data_url,
            pick_download_folder,
            copy_render_to_folder,
            export_latest_stills,
            export_project_bundle,
            import_project_bundle,
            build_timeline,
            get_timeline,
            update_timeline_view,
            update_timeline_clip,
            rename_channel,
            rename_video,
            permanent_delete_video,
            permanent_delete_channel,
            pick_thumbnail_image,
            edit_thumbnail_image,
            save_thumbnail_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auto Gen Studio");
}
