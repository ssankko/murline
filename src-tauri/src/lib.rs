mod audio;
mod db;
mod finder;
mod kernscores;
mod library;
mod midi;
mod pdmx;
mod pieces;
mod refusal;
mod settings;
mod update;

use refusal::Refusal;

/// Creates the library folder, parents included. Already existing is success, so onboarding and a
/// later folder change both call it without checking first.
#[tauri::command]
#[specta::specta]
fn ensure_dir(path: &str) -> Result<(), Refusal> {
    Ok(std::fs::create_dir_all(path)?)
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

/// Every command the window may call and every event it may listen to, in one list. The app is
/// built from it, and so is `src/bindings.ts`, which is the window's half of the same seam.
fn bindings() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
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
            pieces::index_plan,
            pieces::index_upsert,
            pieces::index_mark_error,
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
            audio::audio_unload_instrument,
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
            pdmx::pdmx_cancel,
            update::app_version,
            update::update_check,
            update::update_install,
            update::update_restart,
        ])
        .events(tauri_specta::collect_events![
            audio::AudioChainChanged,
            audio::AudioDevicesChanged,
            audio::Load,
            audio::Progress,
            midi::Pedal,
            midi::Status,
            midi::Strike,
        ])
        // A command that refuses rejects with its Refusal, which is what every catch site reads.
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        // The library rows carry i64 columns, which travel as JSON numbers and are read as numbers.
        .dangerously_cast_bigints_to_number()
}

/// Writes the window's half of the seam. Run by `cargo test` and by every debug launch, so the
/// checked-in file is never behind the Rust source.
#[cfg(any(debug_assertions, test))]
fn export_bindings() {
    bindings()
        .export(
            specta_typescript::Typescript::default()
                .header("// Written by `cargo test` in src-tauri."),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts"),
        )
        .expect("failed to write src/bindings.ts");
}

/// Builds the app and hands the process to Tauri, which returns only once the app is closed.
///
/// # Panics
///
/// When Tauri cannot run the app at all, there being no window left to report it in.
pub fn run() {
    let mut context = tauri::generate_context!();
    // The window is built from the config, which holds one colour and cannot know the appearance.
    for window in &mut context.config_mut().app.windows {
        window.background_color = Some(paper());
    }

    #[cfg(debug_assertions)]
    export_bindings();

    let builder = bindings();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            // Every typed event is named to Tauri here, before anything can send one.
            builder.mount_events(app);
            // The library's rows and the global settings share one SQLite file; it reaches the
            // current shape before anything reads it.
            db::migrate(app.handle())?;
            // The engine sends its device-list and Preview-progress events from its own threads,
            // so it needs a handle.
            audio::remember(app.handle().clone());
            finder::warm();
            // The MIDI ports open before the webview asks, on the listening rule read from the
            // settings, so a key pressed on the boot screen sounds and a hidden port does not.
            midi::start(app.handle().clone());
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// Writing the bindings is the check: an export that cannot be rendered is an error, and a
    /// file that changes here is one the commit carries.
    #[test]
    fn the_window_half_of_the_seam_is_written() {
        super::export_bindings();
    }
}
