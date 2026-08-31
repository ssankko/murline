//! What version runs and what version waits on the release page. Nothing is taken without being
//! asked for: the window runs the check, and the user's click runs the install.

use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// The version this build was made as, which the status bar shows.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The version waiting on the release page, or nothing when this build is the newest.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<String>, String> {
    Ok(waiting(&app).await?.map(|update| update.version))
}

/// Fetches the newer bundle and swaps the app on disk. Nothing restarts, so the new version starts
/// at the next launch and a practice session is never cut short.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let Some(update) = waiting(&app).await? else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

/// Starts the app again, which is how a version already on disk takes over. This never returns:
/// the process is replaced by a fresh one.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

/// The one check both commands run. The install asks the release page again instead of holding on
/// to what the check before it found, so there is no update to go stale.
async fn waiting(app: &AppHandle) -> Result<Option<Update>, String> {
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}
