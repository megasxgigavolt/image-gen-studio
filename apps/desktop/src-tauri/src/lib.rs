mod projects;

use base64::Engine;
use projects::{
    AnimationJob, CaptionSet, Channel, ExportJob, ExportResult, ExportSettings, ImageJob,
    ImageRender, ImageWorkspace, InputAsset, MediaLibraryAsset, ProjectRepository, PromptVersion,
    ResumeState, Timeline, Video, VideoAsset, VideoInputs, VideoProgress, VisualPlan,
};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn application_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

type RepositoryState = Mutex<ProjectRepository>;
type ExportJobsState = Mutex<HashMap<String, u32>>;
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
fn get_video_progress(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VideoProgress, String> {
    with_repository(state, |repository| repository.get_video_progress(&video_id))
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
fn rename_channel(
    state: State<'_, RepositoryState>,
    id: String,
    name: String,
) -> Result<(), String> {
    with_repository(state, |repository| repository.rename_channel(&id, &name))
}

#[tauri::command]
fn rename_video(
    state: State<'_, RepositoryState>,
    id: String,
    title: String,
) -> Result<(), String> {
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
    with_repository(state, |repository| {
        repository.delete_prompt_version(&prompt_version_id)
    })
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
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        let mut last_error = String::new();
        for attempt in 0..4 {
            match repository.generate_image_render(
                &video_id,
                &group_id,
                &prompt_version_id,
                &system_prompt,
                &user_prompt,
                &settings_json,
            ) {
                Ok(render) => return Ok(render),
                Err(error) => {
                    last_error = error;
                    if attempt < 3 {
                        let rate_limited = last_error.contains("429")
                            || last_error
                                .to_ascii_lowercase()
                                .contains("resource exhausted");
                        let delay = if rate_limited {
                            20 * 2_u64.pow(attempt)
                        } else {
                            2 * 2_u64.pow(attempt)
                        };
                        thread::sleep(Duration::from_secs(delay.min(120)));
                    }
                }
            }
        }
        Err(last_error)
    })
    .await
    .map_err(|error| format!("Image generation worker stopped unexpectedly: {error}"))?
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
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.edit_image_render(
            &source_render_id,
            &instruction,
            mask_data_url.as_deref(),
            &edit_strength,
        )
    })
    .await
    .map_err(|error| format!("Image editing worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn set_final_render(
    state: State<'_, RepositoryState>,
    render_id: String,
    is_final: bool,
) -> Result<ImageRender, String> {
    with_repository(state, |repository| {
        repository.set_final_render(&render_id, is_final)
    })
}

#[tauri::command]
fn delete_image_render(state: State<'_, RepositoryState>, render_id: String) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.delete_image_render(&render_id)
    })
}

#[tauri::command]
fn reset_image_workflow(state: State<'_, RepositoryState>, video_id: String) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.reset_image_workflow(&video_id)
    })
}

#[tauri::command]
async fn suggest_image_prompt(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_json: String,
    style_directive: String,
) -> Result<String, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
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
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_educational_visual(&video_id, &group_id, &settings_json, &style_directive)
    })
    .await
    .map_err(|error| format!("Educational planner stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn plan_whole_video_educational_visuals(
    state: State<'_, RepositoryState>,
    video_id: String,
    settings_json: String,
    style_directive: String,
    strategy_mode: String,
) -> Result<projects::WholeVideoEducationalPlan, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_whole_video_educational_visuals(
            &video_id,
            &settings_json,
            &style_directive,
            &strategy_mode,
        )
    })
    .await
    .map_err(|error| format!("Whole-video planner stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn extract_reference_style(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<projects::StyleExtraction, String> {
    with_repository(state, |repository| {
        repository.extract_reference_style(&asset_id)
    })
}

#[tauri::command]
fn set_still_lock(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    settings_locked: bool,
    prompt_locked: bool,
) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.set_still_lock(&video_id, &group_id, settings_locked, prompt_locked)
    })
}

#[tauri::command]
fn extract_image_settings_from_directive(
    state: State<'_, RepositoryState>,
    directive: String,
) -> Result<projects::StyleExtraction, String> {
    with_repository(state, |repository| {
        repository.extract_image_settings_from_directive(&directive)
    })
}

#[tauri::command]
async fn suggest_still_prompt(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    style_directive: String,
    base_settings_json: String,
) -> Result<projects::BulkPlannedStill, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.suggest_still_prompt(&video_id, &group_id, &style_directive, &base_settings_json)
    })
    .await
    .map_err(|e| format!("Prompt suggestion stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn plan_bulk_visuals(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    style_directive: String,
    base_settings_json: String,
    creative_instruction: String,
    character_consistency: bool,
) -> Result<projects::BulkPlanResult, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.plan_bulk_visuals(
            &video_id,
            &style_directive,
            &base_settings_json,
            &creative_instruction,
            character_consistency,
            |planned, total| {
                let _ = app.emit(
                    "bulk_plan_progress",
                    serde_json::json!({ "planned": planned, "total": total }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("Bulk planner stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn analyze_motion_graphics(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
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
        repository.analyze_motion_graphics(&video_id, &engine_dir, |done, total| {
            let _ = app.emit(
                "motion_graphics_progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
    })
    .await
    .map_err(|e| format!("Motion graphics analysis stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn set_timeline_clip_motion_graphic(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    effect: Option<String>,
    settings_json: Option<String>,
    reason: Option<String>,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_motion_graphic(
            &video_id,
            &clip_id,
            effect.as_deref(),
            settings_json.as_deref(),
            reason.as_deref(),
        )
    })
}

#[tauri::command]
async fn approve_bulk_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
    style_directive: String,
    stills: Vec<projects::BulkPlannedStill>,
) -> Result<usize, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.approve_bulk_plan(&video_id, &style_directive, &stills)
    })
    .await
    .map_err(|e| format!("Bulk plan approval stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn apply_creative_instructions_to_all(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    creative_instruction: String,
) -> Result<usize, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.apply_creative_instructions_to_all(
            &video_id,
            &creative_instruction,
            |done, total| {
                let _ = app.emit(
                    "creative_apply_progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("Creative instruction apply failed: {e}"))?
}

#[tauri::command]
async fn apply_style_directive_to_all(
    state: State<'_, RepositoryState>,
    video_id: String,
    style_directive: String,
) -> Result<usize, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.apply_style_directive_to_all(&video_id, &style_directive)
    })
    .await
    .map_err(|e| format!("Style directive update failed: {e}"))?
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
fn get_render_file_path(
    state: State<'_, RepositoryState>,
    render_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository.render_file_path(&render_id).map(|path| path.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn get_asset_file_path(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository.asset_file_path(&asset_id).map(|path| path.to_string_lossy().into_owned())
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
fn pick_export_destination(app: tauri::AppHandle, default_name: String, default_dir: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().add_filter("MP4 video", &["mp4"]).set_file_name(&default_name);
    if let Some(dir) = default_dir.filter(|d| !d.is_empty()) {
        dialog = dialog.set_directory(dir);
    }
    dialog
        .blocking_save_file()
        .and_then(|value| value.as_path().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn pick_export_project_destination(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|value| value.as_path().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn list_export_jobs(state: State<'_, RepositoryState>, video_id: String) -> Result<Vec<ExportJob>, String> {
    with_repository(state, |repository| repository.list_export_jobs(&video_id))
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

#[tauri::command]
fn set_narration_offset(
    state: State<'_, RepositoryState>,
    video_id: String,
    offset_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_narration_offset(&video_id, offset_seconds)
    })
}

#[tauri::command]
fn populate_timeline_from_sources(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.populate_timeline_from_sources(&video_id)
    })
}

#[tauri::command]
fn add_stills_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    start_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_stills_clip(&video_id, &group_id, start_seconds)
    })
}

#[tauri::command]
fn add_caption_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    chunk_index: Option<i64>,
    text: Option<String>,
    start_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_caption_clip(&video_id, chunk_index, text, start_seconds)
    })
}

#[tauri::command]
fn update_timeline_caption_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    start: f64,
    end: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_timeline_caption_clip(&video_id, &clip_id, start, end)
    })
}

#[tauri::command]
fn update_caption_clip_text(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    text: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_caption_clip_text(&video_id, &clip_id, &text)
    })
}

#[tauri::command]
fn split_caption_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    split_at_seconds: f64,
    left_text: String,
    right_text: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.split_caption_clip(&video_id, &clip_id, split_at_seconds, &left_text, &right_text)
    })
}

#[tauri::command]
fn merge_caption_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    first_clip_id: String,
    second_clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.merge_caption_clips(&video_id, &first_clip_id, &second_clip_id)
    })
}

#[tauri::command]
fn set_timeline_caption_style(
    state: State<'_, RepositoryState>,
    video_id: String,
    style: serde_json::Value,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_caption_style(&video_id, &style)
    })
}

#[tauri::command]
fn set_caption_clip_style(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    style: Option<serde_json::Value>,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_caption_clip_style(&video_id, &clip_id, style.as_ref())
    })
}

#[tauri::command]
fn set_timeline_clip_render(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    render_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_render(&video_id, &clip_id, &render_id)
    })
}

#[tauri::command]
fn set_timeline_clip_motion(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    motion_preset: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_motion(&video_id, &clip_id, &motion_preset)
    })
}

#[tauri::command]
fn set_timeline_clip_transition(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    transition_in: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_transition(&video_id, &clip_id, &transition_in)
    })
}

#[tauri::command]
fn set_timeline_clip_transition_out(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    transition_out: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_transition_out(&video_id, &clip_id, &transition_out)
    })
}

#[tauri::command]
fn set_timeline_clip_motion_intensity(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_motion_intensity(&video_id, &clip_id, intensity)
    })
}

#[tauri::command]
fn set_timeline_clip_color_filter(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    preset: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_timeline_clip_color_filter(&video_id, &clip_id, &preset, intensity)
    })
}

#[tauri::command]
fn clear_motion_graphics_for_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.clear_motion_graphics_for_all_clips(&video_id)
    })
}

#[tauri::command]
fn apply_color_filter_to_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    preset: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.apply_color_filter_to_all_clips(&video_id, &preset, intensity)
    })
}

#[tauri::command]
fn apply_motion_to_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    motion_preset: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.apply_motion_to_all_clips(&video_id, &motion_preset, intensity)
    })
}

#[tauri::command]
fn apply_transition_in_to_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    transition_in: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.apply_transition_in_to_all_clips(&video_id, &transition_in)
    })
}

#[tauri::command]
fn apply_transition_out_to_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    transition_out: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.apply_transition_out_to_all_clips(&video_id, &transition_out)
    })
}

#[tauri::command]
fn apply_motion_intensity_to_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.apply_motion_intensity_to_all_clips(&video_id, intensity)
    })
}

#[tauri::command]
fn alternate_zoom_for_all_clips(
    state: State<'_, RepositoryState>,
    video_id: String,
    intensity: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.alternate_zoom_for_all_clips(&video_id, intensity)
    })
}

#[tauri::command]
fn extrapolate_stills_to_fill_gaps(
    state: State<'_, RepositoryState>,
    video_id: String,
    total_duration_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.extrapolate_stills_to_fill_gaps(&video_id, total_duration_seconds)
    })
}

#[tauri::command]
fn reset_stills_timing_to_natural(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.reset_stills_timing_to_natural(&video_id))
}

#[tauri::command]
fn delete_timeline_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.delete_timeline_clip(&video_id, &clip_id)
    })
}

#[tauri::command]
fn duplicate_timeline_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.duplicate_timeline_clip(&video_id, &clip_id)
    })
}

#[tauri::command]
fn delete_timeline_caption_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.delete_timeline_caption_clip(&video_id, &clip_id)
    })
}

#[tauri::command]
fn clear_timeline_track(
    state: State<'_, RepositoryState>,
    video_id: String,
    track: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.clear_timeline_track(&video_id, &track)
    })
}

#[tauri::command]
fn reset_timeline_to_default(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.reset_timeline_to_default(&video_id)
    })
}

#[tauri::command]
fn restore_timeline_snapshot(
    state: State<'_, RepositoryState>,
    video_id: String,
    snapshot_json: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.restore_timeline_snapshot(&video_id, &snapshot_json)
    })
}

// ===== Media library (Editor tab: Stills / Clips / Audio tabs) =====

#[tauri::command]
fn pick_and_import_media_library_asset(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    kind: Option<String>,
) -> Result<Option<MediaLibraryAsset>, String> {
    let mut picker = app.dialog().file();
    picker = match kind.as_deref() {
        Some("still") => picker.add_filter("Images", &["png", "jpg", "jpeg", "webp"]),
        Some("clip") => picker.add_filter("Video clips", &["mp4", "mov", "webm", "mkv"]),
        Some("audio") => picker.add_filter("Audio", &["mp3", "wav", "m4a", "aac", "flac", "ogg"]),
        _ => picker.add_filter(
            "Media",
            &[
                "png", "jpg", "jpeg", "webp", "mp4", "mov", "webm", "mkv", "mp3", "wav", "m4a",
                "aac", "flac", "ogg",
            ],
        ),
    };
    let Some(path) = picker
        .blocking_pick_file()
        .and_then(|file| file.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    let engine_dir = resolve_engine_dir(&app)?;
    with_repository(state, |repository| {
        repository.import_media_library_asset(&video_id, &path, kind.as_deref(), &engine_dir)
    })
    .map(Some)
}

#[tauri::command]
fn list_media_library_assets(
    state: State<'_, RepositoryState>,
    video_id: String,
    kind: Option<String>,
) -> Result<Vec<MediaLibraryAsset>, String> {
    with_repository(state, |repository| {
        repository.list_media_library_assets(&video_id, kind.as_deref())
    })
}

#[tauri::command]
fn remove_media_library_asset(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.remove_media_library_asset(&asset_id)
    })
}

#[tauri::command]
fn get_media_library_asset_file_path(
    state: State<'_, RepositoryState>,
    asset_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository
            .media_library_asset_file_path(&asset_id)
            .map(|path| path.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn list_video_assets(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Vec<VideoAsset>, String> {
    with_repository(state, |repository| repository.list_video_assets(&video_id))
}

#[tauri::command]
fn add_video_asset_clip_to_stills_track(
    state: State<'_, RepositoryState>,
    video_id: String,
    video_asset_id: String,
    start_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_video_asset_clip_to_stills_track(&video_id, &video_asset_id, start_seconds)
    })
}

#[tauri::command]
fn add_library_asset_to_stills_track(
    state: State<'_, RepositoryState>,
    video_id: String,
    media_library_asset_id: String,
    start_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_library_asset_to_stills_track(&video_id, &media_library_asset_id, start_seconds)
    })
}

// ===== Music track =====

#[tauri::command]
fn add_music_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    media_library_asset_id: String,
    start_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_music_clip(&video_id, &media_library_asset_id, start_seconds)
    })
}

#[tauri::command]
fn update_music_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    start: f64,
    end: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_music_clip(&video_id, &clip_id, start, end)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_music_clip_settings(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    volume_percent: f64,
    fade_in_enabled: bool,
    fade_in_seconds: f64,
    fade_out_enabled: bool,
    fade_out_seconds: f64,
    auto_duck: bool,
    loop_enabled: bool,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_music_clip_settings(
            &video_id, &clip_id, volume_percent,
            fade_in_enabled, fade_in_seconds, fade_out_enabled, fade_out_seconds, auto_duck, loop_enabled,
        )
    })
}

#[tauri::command]
fn delete_music_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.delete_music_clip(&video_id, &clip_id)
    })
}

#[tauri::command]
fn set_music_master_settings(
    state: State<'_, RepositoryState>,
    video_id: String,
    master_volume_percent: f64,
    duck_sensitivity_percent: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_music_master_settings(&video_id, master_volume_percent, duck_sensitivity_percent)
    })
}

#[tauri::command]
fn set_sequence_locked(
    state: State<'_, RepositoryState>,
    video_id: String,
    locked: bool,
) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.set_sequence_locked(&video_id, locked))
}

#[tauri::command]
fn set_narration_settings(
    state: State<'_, RepositoryState>,
    video_id: String,
    volume_percent: f64,
    trim_start_seconds: f64,
    trim_end_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_narration_settings(&video_id, volume_percent, trim_start_seconds, trim_end_seconds)
    })
}

// ===== Overlays track: text =====

#[tauri::command]
fn add_text_overlay_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    at_seconds: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_text_overlay_clip(&video_id, at_seconds)
    })
}

#[tauri::command]
fn update_text_overlay_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    start: f64,
    end: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_text_overlay_clip(&video_id, &clip_id, start, end)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_text_overlay_style(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    text: String,
    font_family: String,
    font_size_px: f64,
    bold: bool,
    italic: bool,
    color: String,
    background_mode: String,
    background_color: String,
    position: String,
    animation: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_text_overlay_style(
            &video_id, &clip_id, &text, &font_family, font_size_px, bold, italic,
            &color, &background_mode, &background_color, &position, &animation,
        )
    })
}

#[tauri::command]
fn delete_text_overlay_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.delete_text_overlay_clip(&video_id, &clip_id)
    })
}

// ===== Overlays track: logo/watermark =====

#[tauri::command]
fn add_logo_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    media_library_asset_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.add_logo_clip(&video_id, &media_library_asset_id)
    })
}

#[tauri::command]
fn update_logo_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    start: f64,
    end: f64,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.update_logo_clip(&video_id, &clip_id, start, end)
    })
}

#[tauri::command]
fn set_logo_clip_style(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    position: String,
    size_percent: f64,
    opacity_percent: f64,
    show_throughout: bool,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.set_logo_clip_style(&video_id, &clip_id, &position, size_percent, opacity_percent, show_throughout)
    })
}

#[tauri::command]
fn delete_logo_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.delete_logo_clip(&video_id, &clip_id)
    })
}

#[tauri::command]
fn remove_all_clip_effects(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| {
        repository.remove_all_clip_effects(&video_id)
    })
}

fn spawn_job_workers(
    database_path: std::path::PathBuf,
    projects_dir: std::path::PathBuf,
    job_id: String,
) {
    // Back to a single worker: two concurrent workers both hitting Gemini's image-gen
    // endpoint turned out to cause real 429s (Gemini's image quota is tightly
    // rate-limited per-project), not just a theoretical risk — in practice this showed
    // up as both slower overall throughput (two workers backing off 30-240s at once)
    // and stills stuck failing after 5 attempts because their retries kept colliding
    // with the other worker's requests. One worker paced by the 1s gap below avoids
    // that self-inflicted contention entirely.
    for _ in 0..1 {
        let database_path = database_path.clone();
        let projects_dir = projects_dir.clone();
        let job_id = job_id.clone();
        thread::spawn(move || {
            let Ok(repository) = ProjectRepository::open(&database_path, &projects_dir) else {
                return;
            };
            // One automatic extra pass over anything that ends up 'failed' during this
            // run, once the normal queue empties — a still that hit a real rate-limit
            // 429 earlier may well succeed once retried after the rest of the batch has
            // gone by. Capped at one sweep (not unlimited) so a genuinely broken setup
            // (bad key, no quota at all) can't loop forever instead of ever settling.
            let mut auto_retry_sweeps_remaining = 1;
            loop {
                let (item_id, video_id, group_id, prompt) = match repository.claim_job_item(&job_id) {
                    Ok(Some(item)) => item,
                    Ok(None) => {
                        if auto_retry_sweeps_remaining > 0 {
                            auto_retry_sweeps_remaining -= 1;
                            if matches!(repository.requeue_failed_job_items(&job_id), Ok(count) if count > 0) {
                                continue;
                            }
                        }
                        break;
                    }
                    Err(_) => break,
                };
                let mut last_error = String::new();
                let mut render_id = None;
                for attempt in 0..5 {
                    if matches!(
                        repository.image_job_status(&job_id).ok().as_deref(),
                        Some("stopped") | Some("failed")
                    ) {
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
                                    || last_error
                                        .to_ascii_lowercase()
                                        .contains("resource exhausted");
                                // A per-minute rate-limit window can't reliably clear in
                                // 5s (confirmed: real 429s still happened with that short a
                                // wait) — but it also doesn't need the original 240s. This
                                // ladder guarantees at least one wait past a full 60s
                                // window by the 3rd attempt: 15s/30s/60s/75s (180s worst
                                // case across all 4 waits, vs. 75s too short / 450s too
                                // long).
                                let delay = if rate_limited {
                                    15 * 2_u64.pow(attempt)
                                } else {
                                    3 * 2_u64.pow(attempt)
                                };
                                let mut remaining = delay.min(75);
                                while remaining > 0 {
                                    if matches!(
                                        repository.image_job_status(&job_id).ok().as_deref(),
                                        Some("stopped") | Some("failed")
                                    ) {
                                        break;
                                    }
                                    thread::sleep(Duration::from_secs(1));
                                    remaining -= 1;
                                }
                            }
                        }
                    }
                }
                if matches!(
                    repository.image_job_status(&job_id).ok().as_deref(),
                    Some("stopped") | Some("failed")
                ) {
                    break;
                }
                let result = render_id.ok_or(last_error);
                let _ = repository.finish_job_item(&job_id, &item_id, result);
                // Brief politeness gap between items on this worker — this used to be a
                // flat 8s, which was pure idle time on every single item regardless of
                // whether anything was actually rate-limited (that case is already
                // handled reactively above with real backoff).
                if matches!(
                    repository.image_job_status(&job_id).ok().as_deref(),
                    Some("stopped") | Some("failed")
                ) {
                    break;
                }
                thread::sleep(Duration::from_secs(1));
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
            "cancel" => "failed",
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

// Mirrors `spawn_job_workers` exactly, but each attempt is a full Veo
// submit+poll+download cycle (`generate_animation_clip`) rather than a single
// synchronous Gemini call, so it needs the Python export engine's directory
// to probe/trim the downloaded clip. A single paced worker avoids parallel
// 429 storms against Veo's quota the same way the image job worker does.
fn spawn_animation_job_workers(
    database_path: std::path::PathBuf,
    projects_dir: std::path::PathBuf,
    engine_dir: std::path::PathBuf,
    job_id: String,
) {
    for _ in 0..1 {
        let database_path = database_path.clone();
        let projects_dir = projects_dir.clone();
        let engine_dir = engine_dir.clone();
        let job_id = job_id.clone();
        thread::spawn(move || {
            let Ok(repository) = ProjectRepository::open(&database_path, &projects_dir) else {
                return;
            };
            loop {
                let Ok(Some(item)) = repository.claim_animation_job_item(&job_id) else {
                    break;
                };
                let mut last_error = String::new();
                let mut video_asset_id = None;
                for attempt in 0..5 {
                    if matches!(
                        repository.animation_job_status(&job_id).ok().as_deref(),
                        Some("stopped") | Some("failed")
                    ) {
                        break;
                    }
                    match repository.generate_animation_clip(
                        &item.video_id,
                        &item.clip_id,
                        &item.resolution,
                        &item.prompt,
                        &engine_dir,
                    ) {
                        Ok(asset) => {
                            video_asset_id = Some(asset.id);
                            break;
                        }
                        Err(error) => {
                            last_error = error;
                            if attempt < 4 {
                                let rate_limited = last_error.contains("429")
                                    || last_error
                                        .to_ascii_lowercase()
                                        .contains("resource exhausted");
                                let delay = if rate_limited {
                                    30 * 2_u64.pow(attempt)
                                } else {
                                    3 * 2_u64.pow(attempt)
                                };
                                let mut remaining = delay.min(240);
                                while remaining > 0 {
                                    if matches!(
                                        repository.animation_job_status(&job_id).ok().as_deref(),
                                        Some("stopped") | Some("failed")
                                    ) {
                                        break;
                                    }
                                    thread::sleep(Duration::from_secs(1));
                                    remaining -= 1;
                                }
                            }
                        }
                    }
                }
                if matches!(
                    repository.animation_job_status(&job_id).ok().as_deref(),
                    Some("stopped") | Some("failed")
                ) {
                    break;
                }
                let result = video_asset_id.ok_or(last_error);
                let _ = repository.finish_animation_job_item(&job_id, &item.id, result);
                for _ in 0..8 {
                    if matches!(
                        repository.animation_job_status(&job_id).ok().as_deref(),
                        Some("stopped") | Some("failed")
                    ) {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
        });
    }
}

fn resolve_engine_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../services/python-engine"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("python-engine"))
            .map_err(|e| format!("Could not locate app resource directory: {e}"))
    }
}

#[tauri::command]
fn create_animation_job(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
    resolution: String,
    prompt: String,
) -> Result<AnimationJob, String> {
    let engine_dir = resolve_engine_dir(&app)?;
    let (job, paths) = with_repository(state, |repository| {
        let job = repository.create_animation_job(&video_id, &clip_id, &resolution, &prompt)?;
        Ok((job, repository.paths()))
    })?;
    spawn_animation_job_workers(paths.0, paths.1, engine_dir, job.id.clone());
    Ok(job)
}

#[tauri::command]
fn suggest_animation_prompt(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| repository.suggest_animation_prompt(&video_id, &group_id))
}

#[tauri::command]
fn get_latest_animation_job(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<Option<AnimationJob>, String> {
    with_repository(state, |repository| repository.latest_animation_job(&video_id))
}

#[tauri::command]
fn control_animation_job(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    job_id: String,
    action: String,
) -> Result<AnimationJob, String> {
    let engine_dir = resolve_engine_dir(&app)?;
    let (job, paths) = with_repository(state, |repository| {
        let status = match action.as_str() {
            "pause" => "paused",
            "resume" => "queued",
            "stop" => "stopped",
            "cancel" => "failed",
            _ => return Err("Unknown job action.".into()),
        };
        let job = repository.set_animation_job_status(&job_id, status)?;
        Ok((job, repository.paths()))
    })?;
    if action == "resume" {
        spawn_animation_job_workers(paths.0, paths.1, engine_dir, job.id.clone());
    }
    Ok(job)
}

#[tauri::command]
async fn retime_animation_clip(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    let engine_dir = resolve_engine_dir(&app)?;
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.retime_animation_clip(&video_id, &clip_id, &engine_dir)
    })
    .await
    .map_err(|error| format!("Retime worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_animation_clip(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Option<Timeline>, String> {
    let Some(source) = app
        .dialog()
        .file()
        .add_filter("Video files", &["mp4", "mov", "webm", "mkv", "m4v"])
        .blocking_pick_file()
        .and_then(|file| file.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    let engine_dir = resolve_engine_dir(&app)?;
    let (database_path, projects_dir) = with_repository(state, |repository| Ok(repository.paths()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.import_animation_clip(&video_id, &clip_id, &source, &engine_dir)
    })
    .await
    .map_err(|error| format!("Import worker stopped unexpectedly: {error}"))?
    .map(Some)
}

#[tauri::command]
fn revert_animation_clip_to_still(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.revert_animation_clip_to_still(&video_id, &clip_id))
}

#[tauri::command]
fn restore_animation_clip(
    state: State<'_, RepositoryState>,
    video_id: String,
    clip_id: String,
) -> Result<Timeline, String> {
    with_repository(state, |repository| repository.restore_animation_clip(&video_id, &clip_id))
}

#[tauri::command]
fn get_video_asset_file_path(
    state: State<'_, RepositoryState>,
    video_asset_id: String,
) -> Result<String, String> {
    with_repository(state, |repository| {
        repository
            .video_asset_file_path(&video_asset_id)
            .map(|path| path.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn get_video_asset_record(
    state: State<'_, RepositoryState>,
    video_asset_id: String,
) -> Result<VideoAsset, String> {
    with_repository(state, |repository| {
        repository.get_video_asset_record(&video_asset_id)
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
        repository.generate_visual_plan_with_progress(
            &video_id,
            &engine_dir,
            |percent, stage, detail| {
                let _ = app.emit(
                    "visual-plan-progress",
                    serde_json::json!({
                        "videoId": &event_video_id,
                        "percent": percent,
                        "stage": stage,
                        "detail": detail,
                    }),
                );
            },
        )
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
async fn generate_captions(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    interval_seconds: f64,
) -> Result<CaptionSet, String> {
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
        repository.generate_captions_with_progress(
            &video_id,
            &engine_dir,
            interval_seconds,
            |percent, stage, detail| {
                let _ = app.emit(
                    "caption-progress",
                    serde_json::json!({
                        "videoId": &event_video_id,
                        "percent": percent,
                        "stage": stage,
                        "detail": detail,
                    }),
                );
            },
        )
    })
    .await
    .map_err(|error| format!("Caption worker failed: {error}"))?
}

#[tauri::command]
fn get_captions(state: State<'_, RepositoryState>, video_id: String) -> Result<CaptionSet, String> {
    with_repository(state, |repository| repository.get_captions(&video_id))
}

#[tauri::command]
fn save_captions_file(
    app: tauri::AppHandle,
    srt_text: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("SubRip Subtitle", &["srt"])
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(|value| value.as_path().map(ToOwned::to_owned))
    else {
        return Ok(None);
    };
    fs::write(&path, srt_text).map_err(|error| format!("Could not save captions: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn probe_narration_duration(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<f64, String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
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
        repository.probe_narration_duration_seconds(&video_id, &engine_dir)
    })
    .await
    .map_err(|error| format!("Duration probe worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn detect_render_subject(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    render_id: String,
) -> Result<(f64, f64), String> {
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
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
        repository.detect_render_subject(&video_id, &render_id, &engine_dir)
    })
    .await
    .map_err(|error| format!("Subject detection worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn export_timeline_video(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    destination_path: String,
    options: ExportSettings,
) -> Result<Option<String>, String> {
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
    let job_id = {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.create_export_job(&video_id, &destination_path)?
    };
    let (output_path, srt_path) = {
        let progress_app = app.clone();
        let pid_app = app.clone();
        let cleanup_app = app.clone();
        let event_video_id = video_id.clone();
        let pid_video_id = video_id.clone();
        let cleanup_video_id = video_id.clone();
        let (worker_database_path, worker_projects_dir) = (database_path.clone(), projects_dir.clone());
        let worker_video_id = video_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let repository = ProjectRepository::open(&worker_database_path, &worker_projects_dir)?;
            let result = repository.export_timeline_video_with_progress(
                &worker_video_id,
                &engine_dir,
                &options,
                move |pid| {
                    let jobs = pid_app.state::<ExportJobsState>();
                    jobs.lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(pid_video_id.clone(), pid);
                },
                move |percent, stage, detail| {
                    let _ = progress_app.emit(
                        "export-progress",
                        serde_json::json!({
                            "videoId": &event_video_id,
                            "percent": percent,
                            "stage": stage,
                            "detail": detail,
                        }),
                    );
                },
            );
            let jobs = cleanup_app.state::<ExportJobsState>();
            jobs.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&cleanup_video_id);
            result
        })
        .await
        .map_err(|error| format!("Export worker failed: {error}"))?;
        match result {
            Ok(paths) => paths,
            Err(error) => {
                let repository = ProjectRepository::open(&database_path, &projects_dir)?;
                repository.fail_export_job(&job_id, &error)?;
                return Err(error);
            }
        }
    };
    let dest = PathBuf::from(&destination_path);
    let copy_result = fs::copy(&output_path, &dest).map_err(|e| format!("Could not save exported video: {e}"));
    if let Err(error) = &copy_result {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        repository.fail_export_job(&job_id, error)?;
    }
    copy_result?;
    if let Some(srt_path) = srt_path {
        let srt_dest = dest.with_extension("srt");
        let _ = fs::copy(&srt_path, &srt_dest);
    }
    let repository = ProjectRepository::open(&database_path, &projects_dir)?;
    repository.complete_export_job(&job_id, &destination_path)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn export_timeline_project(
    app: tauri::AppHandle,
    state: State<'_, RepositoryState>,
    video_id: String,
    destination_path: String,
) -> Result<String, String> {
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
    let destination_dir = PathBuf::from(destination_path);
    let progress_app = app.clone();
    let pid_app = app.clone();
    let cleanup_app = app.clone();
    let event_video_id = video_id.clone();
    let pid_video_id = video_id.clone();
    let cleanup_video_id = video_id.clone();
    let output_dir = tauri::async_runtime::spawn_blocking(move || {
        let repository = ProjectRepository::open(&database_path, &projects_dir)?;
        let result = repository.export_timeline_project_with_progress(
            &video_id,
            &engine_dir,
            &destination_dir,
            move |pid| {
                let jobs = pid_app.state::<ExportJobsState>();
                jobs.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(pid_video_id.clone(), pid);
            },
            move |percent, stage, detail| {
                let _ = progress_app.emit(
                    "export-progress",
                    serde_json::json!({
                        "videoId": &event_video_id,
                        "percent": percent,
                        "stage": stage,
                        "detail": detail,
                    }),
                );
            },
        );
        let jobs = cleanup_app.state::<ExportJobsState>();
        jobs.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&cleanup_video_id);
        result
    })
    .await
    .map_err(|error| format!("Export worker failed: {error}"))??;
    Ok(output_dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn cancel_timeline_export(app: tauri::AppHandle, video_id: String) -> Result<bool, String> {
    let jobs = app.state::<ExportJobsState>();
    let pid = jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&video_id);
    let Some(_pid) = pid else {
        return Ok(false);
    };
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &_pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let status = command
            .status()
            .map_err(|e| format!("Could not stop the export: {e}"))?;
        Ok(status.success())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer");
        command.args([format!("/select,{path}")]);
        command.creation_flags(0x08000000);
        command.spawn().map_err(|e| format!("Could not open the file manager: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Could not open the file manager: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Could not open the file manager: {e}"))?;
        Ok(())
    }
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
fn update_plan_sentence_text(
    state: State<'_, RepositoryState>,
    video_id: String,
    sentence_id: String,
    text: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.update_plan_sentence_text(&video_id, &sentence_id, &text)
    })
}

#[tauri::command]
fn split_plan_sentence(
    state: State<'_, RepositoryState>,
    video_id: String,
    sentence_id: String,
    left_text: String,
    right_text: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.split_plan_sentence(&video_id, &sentence_id, &left_text, &right_text)
    })
}

#[tauri::command]
fn merge_plan_sentences(
    state: State<'_, RepositoryState>,
    video_id: String,
    first_sentence_id: String,
    second_sentence_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.merge_plan_sentences(&video_id, &first_sentence_id, &second_sentence_id)
    })
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
    let (database_path, projects_dir) =
        with_repository(state, |repository| Ok(repository.paths()))?;
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
    let comma_pos = data_url.find(',').ok_or("Invalid image data URL.")?;
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
                let workspace_env =
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
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
            repository
                .recover_animation_jobs()
                .map_err(std::io::Error::other)?;
            if repository
                .get_app_setting("gemini_model")
                .map_err(std::io::Error::other)?
                .as_deref()
                != Some("gemini-3.1-flash-image")
            {
                repository
                    .save_app_setting("gemini_model", "gemini-3.1-flash-image")
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
            app.manage(Mutex::new(HashMap::<String, u32>::new()) as ExportJobsState);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            application_version,
            startup_diagnostic,
            list_channels,
            create_channel,
            list_videos,
            get_video_progress,
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
            generate_captions,
            get_captions,
            save_captions_file,
            move_plan_sentence,
            create_plan_group,
            reset_visual_plan,
            update_plan_sentence_text,
            split_plan_sentence,
            merge_plan_sentences,
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
            create_animation_job,
            suggest_animation_prompt,
            get_latest_animation_job,
            control_animation_job,
            retime_animation_clip,
            import_animation_clip,
            revert_animation_clip_to_still,
            restore_animation_clip,
            get_video_asset_file_path,
            get_video_asset_record,
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
            analyze_motion_graphics,
            approve_bulk_plan,
            apply_creative_instructions_to_all,
            apply_style_directive_to_all,
            get_render_data_url,
            get_asset_data_url,
            get_render_file_path,
            get_asset_file_path,
            pick_download_folder,
            pick_export_destination,
            list_export_jobs,
            reveal_in_file_manager,
            copy_render_to_folder,
            export_latest_stills,
            export_project_bundle,
            import_project_bundle,
            build_timeline,
            get_timeline,
            update_timeline_view,
            update_timeline_clip,
            set_narration_offset,
            populate_timeline_from_sources,
            add_stills_clip,
            add_caption_clip,
            update_timeline_caption_clip,
            update_caption_clip_text,
            split_caption_clip,
            merge_caption_clips,
            set_timeline_caption_style,
            set_caption_clip_style,
            set_timeline_clip_render,
            set_timeline_clip_motion,
            set_timeline_clip_transition,
            set_timeline_clip_transition_out,
            set_timeline_clip_motion_intensity,
            set_timeline_clip_color_filter,
            set_timeline_clip_motion_graphic,
            clear_motion_graphics_for_all_clips,
            apply_color_filter_to_all_clips,
            apply_motion_to_all_clips,
            apply_transition_in_to_all_clips,
            apply_transition_out_to_all_clips,
            apply_motion_intensity_to_all_clips,
            alternate_zoom_for_all_clips,
            extrapolate_stills_to_fill_gaps,
            reset_stills_timing_to_natural,
            delete_timeline_clip,
            duplicate_timeline_clip,
            delete_timeline_caption_clip,
            clear_timeline_track,
            reset_timeline_to_default,
            restore_timeline_snapshot,
            pick_and_import_media_library_asset,
            list_media_library_assets,
            remove_media_library_asset,
            get_media_library_asset_file_path,
            list_video_assets,
            add_video_asset_clip_to_stills_track,
            add_library_asset_to_stills_track,
            add_music_clip,
            update_music_clip,
            set_music_clip_settings,
            delete_music_clip,
            set_music_master_settings,
            set_sequence_locked,
            set_narration_settings,
            add_text_overlay_clip,
            update_text_overlay_clip,
            set_text_overlay_style,
            delete_text_overlay_clip,
            add_logo_clip,
            update_logo_clip,
            set_logo_clip_style,
            delete_logo_clip,
            remove_all_clip_effects,
            probe_narration_duration,
            detect_render_subject,
            export_timeline_video,
            pick_export_project_destination,
            export_timeline_project,
            cancel_timeline_export,
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
