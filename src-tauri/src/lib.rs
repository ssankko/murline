use tauri_plugin_sql::{Migration, MigrationKind};

mod audio;
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

/// The paper grey the window opens on, dark when macOS is in its dark appearance. The webview
/// paints this until the page paints itself, so a launch never flashes white.
fn paper() -> tauri::window::Color {
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .is_ok_and(|out| out.stdout.starts_with(b"Dark"));
    if dark {
        tauri::window::Color(0x20, 0x20, 0x20, 255)
    } else {
        tauri::window::Color(0xf4, 0xf4, 0xf4, 255)
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    // The window is built from the config, which holds one colour and cannot know the appearance.
    for window in &mut context.config_mut().app.windows {
        window.background_color = Some(paper());
    }

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
            audio::audio_start,
            audio::audio_status,
            audio::audio_click,
            audio::audio_effects,
            audio::audio_chain,
            audio::audio_set_chain,
            audio::audio_show_effect,
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
        .run(context)
        .expect("error while running tauri application");
}
