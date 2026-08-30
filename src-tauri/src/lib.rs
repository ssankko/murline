mod audio;
mod db;
mod finder;
mod kernscores;
mod library;
mod midi;
mod pdmx;
mod pieces;
mod settings;

/// Creates the library folder, parents included. Already existing is success, so onboarding and a
/// later folder change both call it without checking first.
#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
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
        .setup(|app| {
            // The library's rows and the global settings share one SQLite file; it reaches the
            // current shape before anything reads it.
            db::migrate(app.handle())?;
            // The engine sends its device-list and Preview-progress events from its own threads,
            // so it needs a handle.
            audio::remember(app.handle().clone());
            finder::warm();
            // The MIDI ports open before the webview asks: a key pressed on the boot screen
            // already sounds, and the listening rule arrives from the settings a moment later.
            midi::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_dir,
            settings::settings_read,
            settings::settings_write,
            pieces::piece_list,
            pieces::piece_paths,
            pieces::piece_get,
            pieces::piece_update_settings,
            pieces::piece_update_position,
            pieces::piece_set_favorite,
            pieces::piece_recent_plays,
            pieces::play_insert,
            pieces::performance_insert,
            pieces::index_known_files,
            pieces::index_upsert,
            pieces::index_mark_error,
            pieces::index_set_present,
            pieces::piece_delete,
            audio::audio_start,
            audio::audio_status,
            audio::audio_click,
            audio::audio_note,
            audio::audio_effects,
            audio::audio_chain,
            audio::audio_show_effect,
            audio::audio_output_devices,
            audio::audio_instruments,
            audio::audio_load_instrument,
            audio::audio_show_instrument,
            audio::audio_envelope,
            audio::audio_apply_envelope,
            audio::audio_apply_role_level,
            audio::preview_load,
            audio::preview_play,
            audio::preview_pause,
            audio::preview_seek,
            audio::preview_rate,
            audio::preview_stop,
            midi::midi_status,
            midi::midi_listen,
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
