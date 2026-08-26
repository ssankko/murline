mod library;

use std::path::Path;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Creates the library folder, parents included. Already existing is success, so onboarding and a
/// later folder change both call it without checking first.
#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    ensure_dir_at(Path::new(&path)).map_err(|e| e.to_string())
}

fn ensure_dir_at(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
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
        .invoke_handler(tauri::generate_handler![
            ensure_dir,
            home_dir,
            library::list_library,
            library::read_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::ensure_dir_at;

    #[test]
    fn ensure_dir_creates_nested_and_repeats_without_error() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Music").join("Piano");

        ensure_dir_at(&target).unwrap();
        assert!(target.is_dir());

        ensure_dir_at(&target).unwrap();
        assert!(target.is_dir());
    }
}
