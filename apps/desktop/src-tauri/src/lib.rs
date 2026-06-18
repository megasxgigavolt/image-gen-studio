mod projects;

use projects::{
    Channel, ImageJob, ImageRender, ImageWorkspace, InputAsset, ProjectRepository, PromptVersion,
    ProviderKeyStatus, ResumeState, Video, VideoInputs, VisualPlan,
};
use std::fs;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
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
fn get_provider_key_status(
    state: State<'_, RepositoryState>,
    provider: String,
) -> Result<ProviderKeyStatus, String> {
    with_repository(state, |repository| {
        repository.get_provider_key_status(&provider)
    })
}

#[tauri::command]
fn save_provider_key(
    state: State<'_, RepositoryState>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    with_repository(state, |repository| {
        repository.save_provider_key(&provider, &api_key)
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
fn generate_image_render(
    state: State<'_, RepositoryState>,
    video_id: String,
    group_id: String,
    prompt_version_id: String,
    system_prompt: String,
    user_prompt: String,
    settings_json: String,
) -> Result<ImageRender, String> {
    with_repository(state, |repository| {
        repository.generate_image_render(
            &video_id,
            &group_id,
            &prompt_version_id,
            &system_prompt,
            &user_prompt,
            &settings_json,
        )
    })
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
fn edit_image_render(
    state: State<'_, RepositoryState>,
    source_render_id: String,
    instruction: String,
) -> Result<ImageRender, String> {
    with_repository(state, |repository| {
        repository.edit_image_render(&source_render_id, &instruction)
    })
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

fn spawn_job_workers(
    database_path: std::path::PathBuf,
    projects_dir: std::path::PathBuf,
    job_id: String,
) {
    for _ in 0..2 {
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
                for attempt in 0..3 {
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
                            if attempt < 2 {
                                thread::sleep(Duration::from_secs(2_u64.pow(attempt + 1)));
                            }
                        }
                    }
                }
                let result = render_id.ok_or(last_error);
                let _ = repository.finish_job_item(&job_id, &item_id, result);
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
fn generate_visual_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| {
        repository.generate_visual_plan(&video_id)
    })
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
fn reset_visual_plan(
    state: State<'_, RepositoryState>,
    video_id: String,
) -> Result<VisualPlan, String> {
    with_repository(state, |repository| repository.reset_visual_plan(&video_id))
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
            repository
                .recover_image_jobs()
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
            pick_script_text,
            generate_visual_plan,
            get_visual_plan,
            move_plan_sentence,
            reset_visual_plan,
            get_app_setting,
            save_app_setting,
            get_provider_key_status,
            save_provider_key,
            list_prompt_versions,
            create_prompt_version,
            list_image_renders,
            generate_image_render,
            get_image_workspace,
            create_image_job,
            get_latest_image_job,
            control_image_job,
            edit_image_render,
            get_render_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auto Gen Studio");
}
