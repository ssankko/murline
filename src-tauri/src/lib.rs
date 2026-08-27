use tauri_plugin_sql::{Migration, MigrationKind};

mod finder;
mod kernscores;
mod library;
mod pdmx;

/// Creates the library folder, parents included. Already existing is success, so onboarding and a
/// later folder change both call it without checking first.
#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// The user's home directory, so the frontend can offer `~/Music/Piano/` as an absolute path.
#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::home_dir()
        .ok_or_else(|| "no home directory".to_string())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Numbered SQL files applied in order and tracked by `PRAGMA user_version`.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_midi::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:piano.db", migrations())
                .build(),
        )
        .setup(|_app| {
            finder::warm();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_dir,
            home_dir,
            library::copy_file,
            library::list_library,
            library::read_file,
            library::remove_temp_file,
            library::reveal_in_finder,
            library::trash_file,
            finder::finder_search,
            finder::finder_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

