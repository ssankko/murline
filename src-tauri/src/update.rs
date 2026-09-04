//! What version runs, what version waits on the release page, and how far fetching it has come.
//! Nothing is taken without being asked for: the window runs the check, and the user's click runs
//! the install.

use crate::refusal::Refusal;
use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_updater::{Update as Bundle, UpdaterExt};
use tauri_specta::Event;

/// Downloaded bytes between progress messages.
const STEP: u64 = 1024 * 1024;

/// What an install has to say for itself when the release page holds nothing to install.
const NOTHING: &str = "no newer version is waiting";

/// What the release page holds and how far taking it has come. The job outlives the status bar,
/// which is built again on every screen, so nothing a screen change does can lose a download.
struct Job {
    /// The bundle the last check found, which the install fetches without asking again.
    waiting: Option<Bundle>,
    /// Whether the release page has been asked since launch.
    checked: bool,
    /// The version whose bundle is on disk, waiting for the next launch.
    installed: Option<String>,
    running: bool,
    done: u64,
    total: Option<u64>,
    /// Why the last fetch stopped, or none after one that finished.
    error: Option<String>,
}

const IDLE: Job = Job {
    waiting: None,
    checked: false,
    installed: None,
    running: false,
    done: 0,
    total: None,
    error: None,
};
static JOB: Mutex<Job> = Mutex::new(IDLE);

/// Where the update stands, as one shape: what waits, what is already on disk, and how far the
/// fetch has come. A status bar that has just been built knows as much as one that watched the
/// whole download.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename = "UpdateStatus")]
pub struct Status {
    /// The version the release page holds, or none while this build is the newest.
    waiting: Option<String>,
    /// Whether the release page has been asked since launch, which is what keeps moving between
    /// screens from asking it again.
    checked: bool,
    /// The version on disk, which a restart starts.
    installed: Option<String>,
    running: bool,
    done: u64,
    /// Absent while the server has declared no length.
    total: Option<u64>,
    /// Why the last fetch stopped, as one line for the version cell to show.
    error: Option<String>,
}

fn status() -> Status {
    let job = JOB.lock().unwrap();
    Status {
        waiting: job.waiting.as_ref().map(|bundle| bundle.version.clone()),
        checked: job.checked,
        installed: job.installed.clone(),
        running: job.running,
        done: job.done,
        total: job.total,
        error: job.error.clone(),
    }
}

/// How far the download has come, sent about every megabyte.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "update-progress")]
#[serde(rename = "UpdateProgress")]
pub struct Progress {
    done: u64,
    total: Option<u64>,
}

/// The whole status once the fetch has ended, however it ended.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "update-done")]
#[serde(rename = "UpdateDone")]
pub struct Done(pub Status);

/// The version this build was made as, which the status bar shows.
#[tauri::command]
#[specta::specta]
// Tauri hands a command its AppHandle by value; the trait it looks for has no reference form.
#[allow(clippy::needless_pass_by_value)]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Where the update stands, without asking the release page. The status bar reads this every time
/// it is built, so moving between screens costs no request.
#[tauri::command]
#[specta::specta]
pub fn update_status() -> Status {
    status()
}

/// Asks the release page what it holds and answers the whole status. The bundle found is kept, so
/// the install fetches what this check named.
#[tauri::command]
#[specta::specta]
pub async fn update_check(app: AppHandle) -> Result<Status, Refusal> {
    // Marked as asked before the answer arrives, so neither a check still running nor one that
    // could not reach the page leaves the next status bar asking again.
    JOB.lock().unwrap().checked = true;
    let updater = app.updater().map_err(|e| Refusal::failed(e.to_string()))?;
    let found = updater.check().await.map_err(|e| Refusal::failed(e.to_string()))?;
    {
        let mut job = JOB.lock().unwrap();
        // A release newer than the one on disk leaves nothing to restart into.
        if let Some(bundle) = &found
            && job.installed.as_deref() != Some(bundle.version.as_str())
        {
            job.installed = None;
        }
        job.waiting = found;
    }
    Ok(status())
}

/// Starts fetching the bundle the last check found and answers the status at once; the swap on
/// disk happens as the download ends. Nothing restarts, so the new version starts at the next
/// launch and a practice session is never cut short. With nothing waiting there is nothing to
/// install, and that is reported as a failure rather than as an installed version.
#[tauri::command]
#[specta::specta]
pub fn update_install(app: AppHandle) -> Status {
    let bundle = {
        let mut job = JOB.lock().unwrap();
        let bundle = if job.running { None } else { job.waiting.clone() };
        match &bundle {
            // A second click and a re-sent invoke both leave the one running job alone.
            Some(_) => *job = Job { waiting: job.waiting.take(), running: true, ..IDLE },
            None if !job.running => job.error = Some(NOTHING.to_string()),
            None => {}
        }
        job.checked = true;
        bundle
    };
    if let Some(bundle) = bundle {
        tauri::async_runtime::spawn(async move {
            let outcome = take(&app, &bundle).await;
            {
                let mut job = JOB.lock().unwrap();
                job.running = false;
                match outcome {
                    Ok(()) => job.installed = Some(bundle.version.clone()),
                    Err(reason) => job.error = Some(reason),
                }
            }
            let _ = Done(status()).emit(&app);
        });
    }
    status()
}

/// Downloads the bundle and swaps the app on disk, reporting the bytes about every `STEP` of them.
async fn take(app: &AppHandle, bundle: &Bundle) -> Result<(), String> {
    let mut done = 0;
    let mut sent = 0;
    bundle
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                if done - sent >= STEP {
                    sent = done;
                    report(app, done, total);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// The job holds the same numbers the event carries, so a status bar that missed the event and
/// asks for the status reads the download at the same place.
fn report(app: &AppHandle, done: u64, total: Option<u64>) {
    {
        let mut job = JOB.lock().unwrap();
        job.done = done;
        job.total = total;
    }
    let _ = Progress { done, total }.emit(app);
}

/// Starts the app again, which is how a version already on disk takes over. This never returns:
/// the process is replaced by a fresh one.
#[tauri::command]
#[specta::specta]
// Tauri hands a command its AppHandle by value; the trait it looks for has no reference form.
#[allow(clippy::needless_pass_by_value)]
pub fn update_restart(app: AppHandle) {
    app.restart();
}
