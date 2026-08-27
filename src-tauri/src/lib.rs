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

/// Numbered SQL files applied in order and tracked by `PRAGMA user_version`.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

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
            library::copy_file,
            library::list_library,
            library::read_file,
            library::remove_temp_file,
            library::reveal_in_finder,
            library::trash_file,
            finder::finder_search,
            finder::finder_download,
            pdmx::pdmx_status,
            pdmx::pdmx_fetch,
            pdmx::pdmx_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

