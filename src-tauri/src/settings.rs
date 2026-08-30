//! The global settings: one row per key in the `setting` table of the app's SQLite file, each
//! value the JSON the window wrote. The window reads them all once at start and writes them one
//! key at a time; a key the sound engine owns reaches the running engine on its way in.

use crate::audio;
use crate::db::pool;
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use tauri::AppHandle;

/// Every stored setting, by key. A key never written is simply absent, and the window holds the
/// default for it.
pub type Stored = HashMap<String, Value>;

/// Every stored setting. A value that is not JSON is passed over: the window holds a default for
/// every key and a row nobody can read is one of them.
pub async fn read(pool: &SqlitePool) -> Result<Stored, String> {
    let rows = sqlx::query("SELECT key, value FROM setting")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let value: String = row.get("value");
            serde_json::from_str(&value).ok().map(|value| (row.get("key"), value))
        })
        .collect())
}

async fn store(pool: &SqlitePool, key: &str, value: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
        .bind(key)
        .bind(value.to_string())
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Every setting the window starts from, in one read.
#[tauri::command]
pub async fn settings_read(app: AppHandle) -> Result<Stored, String> {
    read(pool(&app)?).await
}

/// One setting. A key the sound engine owns goes on the running engine first, so a value the
/// engine refuses is answered with its reason and never stored.
#[tauri::command]
pub async fn settings_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    write_one(pool(&app)?, &key, value).await
}

async fn write_one(pool: &SqlitePool, key: &str, value: Value) -> Result<(), String> {
    let mut all = read(pool).await?;
    all.insert(key.to_string(), value.clone());
    audio::apply(key, &all)?;
    store(pool, key, &value).await
}

/// Every setting, for the sound engine's own restore at start.
pub async fn all(app: &AppHandle) -> Result<Stored, String> {
    read(pool(app)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::{migrate_to, open};
    use serde_json::json;

    /// A migrated database file of this test's own, so the `setting` table is there to read.
    async fn table() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrate_to(&pool, 6).await;
        (dir, pool)
    }

    #[tokio::test]
    async fn a_written_setting_reads_back_as_the_json_it_was_written_as() {
        let (_dir, pool) = table().await;
        assert!(read(&pool).await.unwrap().is_empty());

        store(&pool, "theme", &json!("dark")).await.unwrap();
        store(&pool, "audio_voices", &json!(256)).await.unwrap();
        store(&pool, "effect_chain", &json!([{ "id": "reverb" }])).await.unwrap();
        // A second write of the same key replaces the value rather than failing on the key.
        store(&pool, "theme", &json!("light")).await.unwrap();

        let all = read(&pool).await.unwrap();
        assert_eq!(all["theme"], json!("light"));
        assert_eq!(all["audio_voices"], json!(256));
        assert_eq!(all["effect_chain"][0]["id"], json!("reverb"));
    }

    /// No engine has been started here, so an audio key is refused whatever its value, and the
    /// refusal is what keeps it out of the table.
    #[tokio::test]
    async fn a_value_the_engine_refuses_is_not_stored() {
        let (_dir, pool) = table().await;
        assert!(write_one(&pool, "audio_voices", json!(999)).await.is_err());
        assert!(!read(&pool).await.unwrap().contains_key("audio_voices"));

        // A key the engine does not own is nobody's to refuse.
        write_one(&pool, "theme", json!("dark")).await.unwrap();
        assert_eq!(read(&pool).await.unwrap()["theme"], json!("dark"));
    }
}
