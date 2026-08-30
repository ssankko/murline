//! The app's one SQLite file: the pool every module reads it through, and the migrations that
//! bring it up to date before anything does.

use sqlx::migrate::{Migration, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::borrow::Cow;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static POOL: OnceLock<SqlitePool> = OnceLock::new();

/// `murline.db` in the app config directory. The pool connects on first use, so nothing waits for
/// a connection here.
pub fn pool(app: &AppHandle) -> Result<&'static SqlitePool, String> {
    if let Some(pool) = POOL.get() {
        return Ok(pool);
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let options = SqliteConnectOptions::new()
        .filename(dir.join("murline.db"))
        .create_if_missing(true);
    Ok(POOL.get_or_init(|| SqlitePoolOptions::new().connect_lazy_with(options)))
}

/// One numbered SQL file, under the version its name begins with.
fn step(version: i64, description: &'static str, sql: &'static str) -> Migration {
    Migration::new(
        version,
        Cow::Borrowed(description),
        MigrationType::Simple,
        Cow::Borrowed(sql),
        false,
    )
}

/// The migration files in order. Each is recorded in `_sqlx_migrations` under its version and the
/// SHA-384 of its text, so a file already applied by an earlier build never runs a second time.
fn migrator() -> Migrator {
    Migrator {
        migrations: Cow::Owned(vec![
            step(1, "init", include_str!("../migrations/0001_init.sql")),
            step(
                2,
                "no inheritance",
                include_str!("../migrations/0002_no_inheritance.sql"),
            ),
            step(
                3,
                "practice state",
                include_str!("../migrations/0003_practice_state.sql"),
            ),
            step(
                4,
                "velocity remap",
                include_str!("../migrations/0004_velocity_remap.sql"),
            ),
            step(
                5,
                "no velocity offset",
                include_str!("../migrations/0005_no_velocity_offset.sql"),
            ),
            step(
                6,
                "piece position",
                include_str!("../migrations/0006_piece_position.sql"),
            ),
        ]),
        ..Migrator::DEFAULT
    }
}

/// Brings the file up to the current shape. Runs before the window exists, so every read after it
/// meets the tables the window expects. The pool is built inside the runtime because it keeps a
/// task of its own that has to be spawned somewhere.
pub fn migrate(app: &AppHandle) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        migrator().run(pool(app)?).await.map_err(|e| e.to_string())
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sqlx::Row;

    /// A pool on an empty database file of this test's own, with nothing applied to it yet.
    pub fn open(dir: &tempfile::TempDir) -> SqlitePool {
        SqlitePoolOptions::new().connect_lazy_with(
            SqliteConnectOptions::new()
                .filename(dir.path().join("murline.db"))
                .create_if_missing(true),
        )
    }

    /// Applies the first `upto` migrations, which is the shape the one after them meets.
    pub async fn migrate_to(pool: &SqlitePool, upto: usize) {
        let full = migrator();
        let partial = Migrator {
            migrations: Cow::Owned(full.migrations[..upto].to_vec()),
            ..Migrator::DEFAULT
        };
        partial.run(pool).await.unwrap();
    }

    /// Every migration applied, with `seed` run once `upto` of them are in and the rest are not.
    async fn migrated(pool: &SqlitePool, upto: usize, seed: &str) {
        migrate_to(pool, upto).await;
        for statement in seed.split(';').filter(|s| !s.trim().is_empty()) {
            sqlx::query(statement).execute(pool).await.unwrap();
        }
        migrator().run(pool).await.unwrap();
    }

    async fn setting(pool: &SqlitePool, key: &str) -> Option<Value> {
        let row: Option<(String,)> = sqlx::query_as("SELECT value FROM setting WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .unwrap();
        row.map(|(value,)| serde_json::from_str(&value).unwrap())
    }

    async fn columns(pool: &SqlitePool, table: &str) -> Vec<String> {
        sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("name"))
            .collect()
    }

    /// One column of the one piece row as SQLite holds it, whatever type the column was declared.
    async fn number(pool: &SqlitePool, column: &str) -> Option<f64> {
        sqlx::query(&format!("SELECT \"{column}\" FROM piece"))
            .fetch_one(pool)
            .await
            .unwrap()
            .try_get_unchecked(0)
            .unwrap()
    }

    async fn text(pool: &SqlitePool, column: &str) -> Option<String> {
        sqlx::query(&format!("SELECT \"{column}\" FROM piece"))
            .fetch_one(pool)
            .await
            .unwrap()
            .try_get_unchecked(0)
            .unwrap()
    }

    /// Before 0002: a piece holding settings of its own, under global defaults it fell back to.
    const INHERITING: &str = "
        INSERT INTO piece (path, mtime, size, imported_at, favorite, tempo_mode, tempo_value,
                           metronome, count_in_bars, hands, keyboard_preset, keyboard_lo, keyboard_hi)
        VALUES ('Bach.musicxml', 1, 2, 3, 1, 'bpm', 96, 1, 2, 'left', '61', NULL, NULL);
        INSERT INTO setting (key, value) VALUES ('default_tempo_value', '80');
        INSERT INTO setting (key, value) VALUES ('default_metronome', 'true');
        INSERT INTO setting (key, value) VALUES ('default_count_in_bars', '2');
        INSERT INTO setting (key, value) VALUES ('default_hands', '\"left\"');
        INSERT INTO setting (key, value) VALUES ('library_folder', '\"/Users/me/Scores\"');
    ";

    /// Before 0003: a piece practised under the settings it keeps, with nowhere to hold the rest.
    const PRACTISED: &str = "
        INSERT INTO piece (path, mtime, size, imported_at, favorite, tempo_mode, tempo_value,
                           metronome, count_in_bars, hands)
        VALUES ('Bach.musicxml', 1, 2, 3, 1, 'bpm', 96, 1, 2, 'left');
        INSERT INTO setting (key, value) VALUES ('library_folder', '\"/Users/me/Scores\"');
    ";

    /// Before 0006: a piece with its practice setup, and nowhere to hold the place it was left at.
    const PRACTICE_SETUP: &str = "
        INSERT INTO piece (path, mtime, size, imported_at, favorite, tempo_mode, tempo_value,
                           metronome, count_in_bars, hands, mode, loop, section_from, section_to)
        VALUES ('Bach.musicxml', 1, 2, 3, 1, 'bpm', 96, 1, 2, 'left', 'wait', 1, 4, 7);
    ";

    #[tokio::test]
    async fn v0002_carries_the_chosen_keyboard_size_into_a_global_row() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        let seed = format!(
            "{INHERITING}
             INSERT INTO setting (key, value) VALUES ('default_keyboard_preset', '\"custom\"');
             INSERT INTO setting (key, value) VALUES ('default_keyboard_lo', '36');
             INSERT INTO setting (key, value) VALUES ('default_keyboard_hi', '71');"
        );
        migrated(&pool, 1, &seed).await;
        assert_eq!(setting(&pool, "keyboard_preset").await, Some(json!("custom")));
        assert_eq!(setting(&pool, "keyboard_lo").await, Some(json!(36)));
        assert_eq!(setting(&pool, "keyboard_hi").await, Some(json!(71)));
        assert_eq!(setting(&pool, "default_keyboard_preset").await, None);
    }

    #[tokio::test]
    async fn v0002_leaves_no_keyboard_size_behind_for_a_user_who_never_chose_one() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 1, INHERITING).await;
        assert_eq!(setting(&pool, "keyboard_preset").await, None);
        assert_eq!(setting(&pool, "keyboard_lo").await, None);
    }

    #[tokio::test]
    async fn v0002_drops_the_playing_defaults_and_keeps_every_other_setting() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 1, INHERITING).await;
        let keys: Vec<String> = sqlx::query("SELECT key FROM setting")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("key"))
            .collect();
        assert!(!keys.iter().any(|key| key.starts_with("default_")));
        assert_eq!(setting(&pool, "library_folder").await, Some(json!("/Users/me/Scores")));
    }

    #[tokio::test]
    async fn v0002_drops_the_keyboard_columns_and_keeps_the_piece_and_its_other_settings() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 1, INHERITING).await;
        let names = columns(&pool, "piece").await;
        for gone in ["keyboard_preset", "keyboard_lo", "keyboard_hi"] {
            assert!(!names.contains(&gone.to_string()), "{gone} is still a column");
        }
        assert_eq!(text(&pool, "path").await.as_deref(), Some("Bach.musicxml"));
        assert_eq!(text(&pool, "tempo_mode").await.as_deref(), Some("bpm"));
        assert_eq!(text(&pool, "hands").await.as_deref(), Some("left"));
        assert_eq!(number(&pool, "favorite").await, Some(1.0));
        assert_eq!(number(&pool, "tempo_value").await, Some(96.0));
        assert_eq!(number(&pool, "count_in_bars").await, Some(2.0));
    }

    #[tokio::test]
    async fn v0003_gives_a_piece_practised_before_it_the_practice_state_unset() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 2, PRACTISED).await;
        // NULL in all four is what opens a piece in flow, with no Section and Loop off.
        for unset in ["mode", "loop", "section_from", "section_to"] {
            assert_eq!(number(&pool, unset).await, None, "{unset} is set");
        }
        assert_eq!(text(&pool, "hands").await.as_deref(), Some("left"));
        assert_eq!(setting(&pool, "library_folder").await, Some(json!("/Users/me/Scores")));
    }

    #[tokio::test]
    async fn v0003_takes_a_database_still_in_the_shape_before_0002_all_the_way() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 1, INHERITING).await;
        assert_eq!(text(&pool, "hands").await.as_deref(), Some("left"));
        assert_eq!(text(&pool, "mode").await, None);
        assert!(columns(&pool, "piece").await.contains(&"section_from".to_string()));
    }

    #[tokio::test]
    async fn v0004_carries_the_softest_note_volume_across_as_a_minimum_velocity() {
        for (percent, expected) in [(60, 77), (0, 1), (100, 127)] {
            let dir = tempfile::tempdir().unwrap();
            let pool = open(&dir);
            let seed = format!(
                "INSERT INTO setting (key, value) VALUES ('velocity_floor', '{percent}');
                 INSERT INTO setting (key, value) VALUES ('velocity_curve', '1.6');"
            );
            migrated(&pool, 3, &seed).await;
            assert_eq!(setting(&pool, "velocity_min").await, Some(json!(expected)));
            assert_eq!(setting(&pool, "velocity_floor").await, None);
            assert_eq!(setting(&pool, "velocity_curve").await, Some(json!(1.6)));
            // Nothing stored a maximum, and its default is the 127 the old mapping's end was.
            assert_eq!(setting(&pool, "velocity_max").await, None);
        }
    }

    #[tokio::test]
    async fn v0004_writes_no_minimum_for_a_user_who_never_moved_the_slider() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(
            &pool,
            3,
            "INSERT INTO setting (key, value) VALUES ('library_folder', '\"/Users/me/Scores\"');",
        )
        .await;
        assert_eq!(setting(&pool, "velocity_min").await, None);
        assert_eq!(setting(&pool, "library_folder").await, Some(json!("/Users/me/Scores")));
    }

    #[tokio::test]
    async fn v0005_clears_the_velocity_offset_the_remap_replaced_and_leaves_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(
            &pool,
            4,
            "INSERT INTO setting (key, value) VALUES ('velocity_offset', '-12');
             INSERT INTO setting (key, value) VALUES ('grade_weight_velocity', '0.1');",
        )
        .await;
        assert_eq!(setting(&pool, "velocity_offset").await, None);
        assert_eq!(setting(&pool, "grade_weight_velocity").await, Some(json!(0.1)));
    }

    #[tokio::test]
    async fn v0006_leaves_a_piece_practised_before_it_with_no_place_and_every_setting_it_had() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrated(&pool, 5, PRACTICE_SETUP).await;
        assert_eq!(text(&pool, "mode").await.as_deref(), Some("wait"));
        assert_eq!(number(&pool, "section_from").await, Some(4.0));
        assert_eq!(number(&pool, "section_to").await, Some(7.0));
        // NULL is what opens the piece at its start.
        assert_eq!(number(&pool, "position_tick").await, None);
    }

    #[tokio::test]
    async fn a_database_that_was_never_opened_before_ends_with_every_table_and_no_row() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrator().run(&pool).await.unwrap();
        let names = columns(&pool, "piece").await;
        for column in ["position_tick", "section_to", "mode"] {
            assert!(names.contains(&column.to_string()), "{column} is missing");
        }
        assert!(!names.contains(&"keyboard_preset".to_string()));
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM piece")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn every_migration_file_is_in_the_list() {
        // A file written but never listed runs on no database at all, and nothing else would say so.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), migrator().iter().count());
    }

    /// The version rows of a user's database, taken off the machine that wrote them. A checksum
    /// is what says a migration is already applied, so these are the bytes that must match.
    const APPLIED: [(i64, &str, &str); 6] = [
        (1, "init", "a154fcf0ddf0f0ee70b7bda5614142633b6b48be15dbba061d35a91b6a894ac32574248e91eea354f1d4807de4d4bbc7"),
        (2, "no inheritance", "041652767bd2e0452fd2283f985aba3dea0cc1029aca71b47eef06ebf96e77735bf097094f7a8122540c30818fc0b63b"),
        (3, "practice state", "470d8c40585a89575257d946fbfb35de50a890578299fe697dd74c43cf222597a4c380f8d67cc46472a04639fe3f47b7"),
        (4, "velocity remap", "4694eb72c01d9e64b28afdb0dccb6d383e7be5c9d108a0e4734d134e17fceacfbc5e3ac539ea1a9bf508e393e0d00fed"),
        (5, "no velocity offset", "8a24fb54cfb78aec98ca86828e7ea11be894c563625f3b5fb33b45ffdfe59a46df64a2d9131ddb11801f7ceb1b28b2b6"),
        (6, "piece position", "d1f14e5759509c2780f4b3595973f26efd35ff1dfe83a767442fef8c1fa572a8f1bbc685d6feb7a0066a0c6c0a01d346"),
    ];

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len() / 2)
            .map(|at| u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn a_database_already_migrated_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        // The tables as the last migration leaves them, under a user's own version rows.
        migrate_to(&pool, 6).await;
        sqlx::query("DELETE FROM _sqlx_migrations").execute(&pool).await.unwrap();
        for (version, description, checksum) in APPLIED {
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, 1, ?3, 0)",
            )
            .bind(version)
            .bind(description)
            .bind(bytes(checksum))
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO piece (path, mtime, size, imported_at) VALUES ('Bach.musicxml', 1, 2, 3)")
            .execute(&pool)
            .await
            .unwrap();

        // A migration run again would fail on its own CREATE TABLE or ALTER TABLE.
        migrator().run(&pool).await.unwrap();
        assert_eq!(text(&pool, "path").await.as_deref(), Some("Bach.musicxml"));
    }
}
