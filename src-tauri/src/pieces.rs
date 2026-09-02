//! The library's rows: the `piece` table and the `play` ledger. Every shape here is the one
//! `src/library/queries.ts` declares, so the window reads what it asks for without a translation.
//! History numbers are worked out from `play` on the spot; nothing derived is stored.

use crate::db::pool;
use crate::refusal::Refusal;
use crate::library::{entry, list_dir, FileEntry};
use crate::settings::Json;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::query::Query;
use sqlx::sqlite::SqliteArguments;
use sqlx::{FromRow, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// A piece as the library page reads it: its index columns, its file facts and its history.
#[derive(Debug, Serialize, FromRow, specta::Type)]
pub struct PieceRow {
    path: String,
    title: Option<String>,
    composer: Option<String>,
    measure_count: Option<i64>,
    duration_s: Option<f64>,
    midi_lo: Option<i64>,
    midi_hi: Option<i64>,
    has_tempo: Option<i64>,
    constant_tempo: Option<i64>,
    key_sharps: Option<i64>,
    key_mode: Option<String>,
    part_count: Option<i64>,
    part_name: Option<String>,
    favorite: i64,
    error: Option<String>,
    /// Piece settings. NULL in any of them means the piece has never been given that one.
    tempo_mode: Option<String>,
    tempo_value: Option<f64>,
    metronome: Option<i64>,
    count_in_bars: Option<i64>,
    hands: Option<String>,
    mode: Option<String>,
    #[sqlx(rename = "loop")]
    #[serde(rename = "loop")]
    r#loop: Option<i64>,
    section_from: Option<i64>,
    section_to: Option<i64>,
    /// Played tick the practice was left at, which is where the piece reopens. NULL is its start.
    position_tick: Option<i64>,
    best_grade: Option<f64>,
    last_played: Option<i64>,
    practised_s: Option<f64>,
}

/// One play of a piece, as the History ledger reads it. A practice leaves the last columns NULL.
#[derive(Debug, Serialize, FromRow, specta::Type)]
pub struct PlayRow {
    id: i64,
    kind: String,
    started_at: i64,
    // Never NaN, so it crosses as a plain number and not as specta's `number | null` for an f64.
    #[specta(type = specta_typescript::Number)]
    duration_s: f64,
    tempo_mode: Option<String>,
    tempo_value: Option<f64>,
    hands: Option<String>,
    grade: Option<f64>,
}

/// A piece's summary as indexing produced it.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PieceIndex {
    title: String,
    composer: String,
    measure_count: i64,
    duration_s: f64,
    midi_lo: i64,
    midi_hi: i64,
    has_tempo: bool,
    constant_tempo: bool,
    key_sharps: i64,
    key_mode: String,
    part_count: i64,
    part_name: String,
}

/// One complete performance: what it ran at, then what it earned.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Performance {
    started_at: f64,
    seconds: f64,
    tempo_mode: String,
    tempo_value: f64,
    hands: String,
    /// Null when the run asked nothing of the player, so there was nothing to grade.
    grade: Option<Grade>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
// The webview sends the fields by name, `grade` among them.
#[allow(clippy::struct_field_names)]
pub struct Grade {
    grade: f64,
    expected: i64,
    matched: i64,
    extras: i64,
    mean_timing: f64,
    mean_velocity: Option<f64>,
    mean_release: f64,
}

const HISTORY: &str = "
  (SELECT MAX(grade) FROM play WHERE piece_path = piece.path AND kind = 'performance') AS best_grade,
  (SELECT MAX(started_at) FROM play WHERE piece_path = piece.path) AS last_played,
  (SELECT SUM(duration_s) FROM play WHERE piece_path = piece.path) AS practised_s";

const BY_TITLE: &str = "title COLLATE NOCASE";

/// How the list pane is ordered. SQLite sorts NULL below every value, so a descending sort puts
/// the never-played and the ungraded last on its own.
fn ordering(sort: &str) -> String {
    match sort {
        "recent" => format!("last_played DESC, {BY_TITLE}"),
        "composer" => format!("composer COLLATE NOCASE, {BY_TITLE}"),
        "grade" => format!("best_grade DESC, {BY_TITLE}"),
        _ => BY_TITLE.to_string(),
    }
}

/// Milliseconds since the epoch, the stamp `imported_at` holds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// Every piece whose file is in the folder. A missing file hides its piece until it is back.
#[tauri::command]
#[specta::specta]
pub async fn piece_list(app: AppHandle, sort: String) -> Result<Vec<PieceRow>, Refusal> {
    Ok(list(pool(&app)?, &sort).await?)
}

async fn list(pool: &SqlitePool, sort: &str) -> Result<Vec<PieceRow>, String> {
    let favorites = if sort == "favorites" { "AND favorite = 1" } else { "" };
    let sql = format!(
        "SELECT piece.*,{HISTORY} FROM piece WHERE present = 1 {favorites} ORDER BY {}",
        ordering(sort)
    );
    sqlx::query_as(&sql).fetch_all(pool).await.map_err(|e| e.to_string())
}

/// The path of every piece whose file is in the folder, whatever the list pane is filtered to. The
/// finder reads it to know which of its rows are already downloaded.
#[tauri::command]
#[specta::specta]
pub async fn piece_paths(app: AppHandle) -> Result<Vec<String>, Refusal> {
    Ok(paths(pool(&app)?).await?)
}

async fn paths(pool: &SqlitePool) -> Result<Vec<String>, String> {
    sqlx::query_scalar("SELECT path FROM piece WHERE present = 1")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn piece_get(app: AppHandle, path: String) -> Result<Option<PieceRow>, Refusal> {
    Ok(get(pool(&app)?, &path).await?)
}

async fn get(pool: &SqlitePool, path: &str) -> Result<Option<PieceRow>, String> {
    sqlx::query_as(&format!("SELECT piece.*,{HISTORY} FROM piece WHERE path = ?1"))
        .bind(path)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

/// The `piece` columns the play toolbar writes. A key outside this list is passed over, so the SET
/// clause is only ever built from names spelled here.
const SETTINGS: [&str; 9] = [
    "tempo_mode",
    "tempo_value",
    "metronome",
    "count_in_bars",
    "hands",
    "mode",
    "loop",
    "section_from",
    "section_to",
];

/// A setting as SQLite takes it. A column set to null unsets that setting again.
fn bind_json<'q>(
    query: Query<'q, Sqlite, SqliteArguments<'q>>,
    value: &Value,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    match value {
        Value::Bool(yes) => query.bind(i64::from(*yes)),
        Value::Number(number) if number.is_f64() => query.bind(number.as_f64()),
        Value::Number(number) => query.bind(number.as_i64()),
        Value::String(text) => query.bind(text.clone()),
        _ => query.bind(None::<f64>),
    }
}

/// Stores what the play screen just changed.
#[tauri::command]
#[specta::specta]
pub async fn piece_update_settings(
    app: AppHandle,
    path: String,
    values: HashMap<String, Json>,
) -> Result<(), Refusal> {
    let values = values.into_iter().map(|(column, value)| (column, value.0)).collect();
    Ok(update_settings(pool(&app)?, &path, &values).await?)
}

async fn update_settings(
    pool: &SqlitePool,
    path: &str,
    values: &Map<String, Value>,
) -> Result<(), String> {
    let columns: Vec<&str> = SETTINGS
        .iter()
        .copied()
        .filter(|column| values.contains_key(*column))
        .collect();
    if columns.is_empty() {
        return Ok(());
    }
    let set = columns
        .iter()
        .enumerate()
        .map(|(at, column)| format!("\"{column}\" = ?{}", at + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("UPDATE piece SET {set} WHERE path = ?1");
    let mut query = sqlx::query(&sql).bind(path);
    for column in &columns {
        query = bind_json(query, &values[*column]);
    }
    query.execute(pool).await.map(|_| ()).map_err(|e| e.to_string())
}

/// Stores where the play screen left the cursor, in played ticks. It is state of the piece rather
/// than a setting: no control shows it and no play reads it out of its settings.
#[tauri::command]
#[specta::specta]
pub async fn piece_update_position(
    app: AppHandle,
    path: String,
    tick: i64,
) -> Result<(), Refusal> {
    Ok(update_position(pool(&app)?, &path, tick).await?)
}

async fn update_position(pool: &SqlitePool, path: &str, tick: i64) -> Result<(), String> {
    run(pool, "UPDATE piece SET position_tick = ?2 WHERE path = ?1", |q| {
        q.bind(path.to_string()).bind(tick)
    })
    .await
}

/// The one thing the library writes about a piece.
#[tauri::command]
#[specta::specta]
pub async fn piece_set_favorite(
    app: AppHandle,
    path: String,
    favorite: bool,
) -> Result<(), Refusal> {
    Ok(set_favorite(pool(&app)?, &path, favorite).await?)
}

async fn set_favorite(pool: &SqlitePool, path: &str, favorite: bool) -> Result<(), String> {
    run(pool, "UPDATE piece SET favorite = ?2 WHERE path = ?1", |q| {
        q.bind(path.to_string()).bind(i64::from(favorite))
    })
    .await
}

/// The last plays of a piece, newest first: the History ledger of the detail pane.
#[tauri::command]
#[specta::specta]
pub async fn piece_recent_plays(
    app: AppHandle,
    path: String,
    limit: i64,
) -> Result<Vec<PlayRow>, Refusal> {
    Ok(recent_plays(pool(&app)?, &path, limit).await?)
}

async fn recent_plays(pool: &SqlitePool, path: &str, limit: i64) -> Result<Vec<PlayRow>, String> {
    sqlx::query_as(
        "SELECT id, kind, started_at, duration_s, tempo_mode, tempo_value, hands, grade
         FROM play WHERE piece_path = ?1 ORDER BY started_at DESC LIMIT ?2",
    )
    .bind(path)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Stores one finished play. Nothing on screen announces it.
#[tauri::command]
#[specta::specta]
pub async fn play_insert(
    app: AppHandle,
    path: String,
    kind: String,
    started_at: f64,
    duration_s: f64,
) -> Result<(), Refusal> {
    Ok(insert_play(pool(&app)?, &path, &kind, started_at, duration_s).await?)
}

async fn insert_play(
    pool: &SqlitePool,
    path: &str,
    kind: &str,
    started_at: f64,
    duration_s: f64,
) -> Result<(), String> {
    run(
        pool,
        "INSERT INTO play (piece_path, kind, started_at, duration_s) VALUES (?1, ?2, ?3, ?4)",
        |q| {
            q.bind(path.to_string())
                .bind(kind.to_string())
                .bind(started_at.round() as i64)
                .bind(duration_s)
        },
    )
    .await
}

/// Stores one complete performance. A run with nothing to grade leaves the grade columns empty.
#[tauri::command]
#[specta::specta]
pub async fn performance_insert(
    app: AppHandle,
    path: String,
    run: Performance,
) -> Result<(), Refusal> {
    Ok(insert_performance(pool(&app)?, &path, &run).await?)
}

async fn insert_performance(
    pool: &SqlitePool,
    path: &str,
    performance: &Performance,
) -> Result<(), String> {
    let grade = performance.grade.as_ref();
    run(
        pool,
        "INSERT INTO play (piece_path, kind, started_at, duration_s, tempo_mode, tempo_value,
                           hands, grade, expected, matched, extras, mean_timing, mean_velocity,
                           mean_release)
         VALUES (?1, 'performance', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        |q| {
            q.bind(path.to_string())
                .bind(performance.started_at.round() as i64)
                .bind(performance.seconds)
                .bind(performance.tempo_mode.clone())
                .bind(performance.tempo_value)
                .bind(performance.hands.clone())
                .bind(grade.map(|g| g.grade))
                .bind(grade.map(|g| g.expected))
                .bind(grade.map(|g| g.matched))
                .bind(grade.map(|g| g.extras))
                .bind(grade.map(|g| g.mean_timing))
                .bind(grade.and_then(|g| g.mean_velocity))
                .bind(grade.map(|g| g.mean_release))
        },
    )
    .await
}

/// The files whose bytes the window must parse: the library folder walked, or the one file at
/// `path` looked at, against the rows. A row whose file came back untouched is restored here and a
/// row whose file is gone is hidden here, so the window is left with the parsing alone.
#[tauri::command]
#[specta::specta]
pub async fn index_plan(
    app: AppHandle,
    folder: String,
    path: Option<String>,
) -> Result<Vec<FileEntry>, Refusal> {
    Ok(plan(pool(&app)?, Path::new(&folder), path.as_deref()).await?)
}

async fn plan(
    pool: &SqlitePool,
    folder: &Path,
    only: Option<&str>,
) -> Result<Vec<FileEntry>, String> {
    let files = match only {
        Some(rel) => entry(folder, rel).into_iter().collect(),
        None => list_dir(folder).map_err(|e| e.to_string())?,
    };
    // One path asks about one row, so a piece open never reads the whole table.
    let rows: Vec<(String, i64, i64, i64)> = match only {
        Some(rel) => sqlx::query_as("SELECT path, mtime, size, present FROM piece WHERE path = ?1")
            .bind(rel)
            .fetch_all(pool)
            .await,
        None => {
            sqlx::query_as("SELECT path, mtime, size, present FROM piece").fetch_all(pool).await
        }
    }
    .map_err(|e| e.to_string())?;

    let on_disk: HashSet<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
    for (path, .., present) in &rows {
        if *present == 1 && !on_disk.contains(path.as_str()) {
            set_present(pool, path, false).await?;
        }
    }
    let known: HashMap<&str, (i64, i64, i64)> = rows
        .iter()
        .map(|(path, mtime, size, present)| (path.as_str(), (*mtime, *size, *present)))
        .collect();
    let mut parse = Vec::new();
    for file in files {
        match known.get(file.rel_path.as_str()) {
            Some(&(mtime, size, present)) if mtime == file.mtime && size == file.size => {
                if present == 0 {
                    set_present(pool, &file.rel_path, true).await?;
                }
            }
            _ => parse.push(file),
        }
    }
    Ok(parse)
}

/// Writes a fresh index. The row's favorite, settings and history survive, and any error clears.
#[tauri::command]
#[specta::specta]
pub async fn index_upsert(
    app: AppHandle,
    path: String,
    index: PieceIndex,
    mtime: i64,
    size: i64,
) -> Result<(), Refusal> {
    Ok(upsert_index(pool(&app)?, &path, &index, mtime, size).await?)
}

async fn upsert_index(
    pool: &SqlitePool,
    path: &str,
    index: &PieceIndex,
    mtime: i64,
    size: i64,
) -> Result<(), String> {
    run(
        pool,
        "INSERT INTO piece (path, title, composer, measure_count, duration_s, midi_lo, midi_hi,
                            has_tempo, constant_tempo, key_sharps, key_mode, part_count, part_name,
                            mtime, size, present, imported_at, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, NULL)
         ON CONFLICT(path) DO UPDATE SET
           title = ?2, composer = ?3, measure_count = ?4, duration_s = ?5, midi_lo = ?6,
           midi_hi = ?7, has_tempo = ?8, constant_tempo = ?9, key_sharps = ?10, key_mode = ?11,
           part_count = ?12, part_name = ?13, mtime = ?14, size = ?15, present = 1, error = NULL",
        |q| {
            q.bind(path.to_string())
                .bind(index.title.clone())
                .bind(index.composer.clone())
                .bind(index.measure_count)
                .bind(index.duration_s)
                .bind(index.midi_lo)
                .bind(index.midi_hi)
                .bind(i64::from(index.has_tempo))
                .bind(i64::from(index.constant_tempo))
                .bind(index.key_sharps)
                .bind(index.key_mode.clone())
                .bind(index.part_count)
                .bind(index.part_name.clone())
                .bind(mtime)
                .bind(size)
                .bind(now_ms())
        },
    )
    .await
}

/// A file the app cannot read stays a piece: it gains the reason and keeps its old index columns.
#[tauri::command]
#[specta::specta]
pub async fn index_mark_error(
    app: AppHandle,
    path: String,
    error: String,
    mtime: i64,
    size: i64,
) -> Result<(), Refusal> {
    Ok(mark_error(pool(&app)?, &path, &error, mtime, size).await?)
}

async fn mark_error(
    pool: &SqlitePool,
    path: &str,
    error: &str,
    mtime: i64,
    size: i64,
) -> Result<(), String> {
    run(
        pool,
        "INSERT INTO piece (path, mtime, size, present, imported_at, error)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET mtime = ?2, size = ?3, present = 1, error = ?5",
        |q| {
            q.bind(path.to_string())
                .bind(mtime)
                .bind(size)
                .bind(now_ms())
                .bind(error.to_string())
        },
    )
    .await
}

/// Whether the file is in the folder. A row absent from it keeps its history and leaves the list.
async fn set_present(pool: &SqlitePool, path: &str, present: bool) -> Result<(), String> {
    run(pool, "UPDATE piece SET present = ?2 WHERE path = ?1", |q| {
        q.bind(path.to_string()).bind(i64::from(present))
    })
    .await
}

/// Drops the piece, and its plays with it through the foreign key that cascades.
#[tauri::command]
#[specta::specta]
pub async fn piece_delete(app: AppHandle, path: String) -> Result<(), Refusal> {
    Ok(delete(pool(&app)?, &path).await?)
}

async fn delete(pool: &SqlitePool, path: &str) -> Result<(), String> {
    run(pool, "DELETE FROM piece WHERE path = ?1", |q| {
        q.bind(path.to_string())
    })
    .await
}

/// One statement with its values bound, answering with nothing but whether it ran.
async fn run<'q, F>(pool: &SqlitePool, sql: &'q str, bind: F) -> Result<(), String>
where
    F: FnOnce(Query<'q, Sqlite, SqliteArguments<'q>>) -> Query<'q, Sqlite, SqliteArguments<'q>>,
{
    bind(sqlx::query(sql))
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::{migrate_to, open};
    use serde_json::json;

    /// A database with every migration applied and one indexed piece in it.
    async fn library() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(&dir);
        migrate_to(&pool, 6).await;
        upsert_index(&pool, "Bach.musicxml", &index("Prelude in C", "J. S. Bach"), 1, 2)
            .await
            .unwrap();
        (dir, pool)
    }

    /// A library folder holding the seeded piece's file, with the row's stamp made to match it.
    async fn folder(pool: &SqlitePool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "Bach.musicxml", "bytes");
        let file = entry(dir.path(), "Bach.musicxml").unwrap();
        let bach = index("Prelude in C", "J. S. Bach");
        upsert_index(pool, "Bach.musicxml", &bach, file.mtime, file.size).await.unwrap();
        dir
    }

    fn write(dir: &tempfile::TempDir, rel: &str, body: &str) {
        std::fs::write(dir.path().join(rel), body).unwrap();
    }

    /// The file facts of one row: what it was indexed at, and whether its file is in the folder.
    async fn facts(pool: &SqlitePool, path: &str) -> (i64, i64, i64) {
        sqlx::query_as("SELECT mtime, size, present FROM piece WHERE path = ?1")
            .bind(path)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The paths `plan` answers with, in a settled order.
    async fn to_parse(
        pool: &SqlitePool,
        dir: &tempfile::TempDir,
        only: Option<&str>,
    ) -> Vec<String> {
        let mut paths: Vec<String> = plan(pool, dir.path(), only)
            .await
            .unwrap()
            .into_iter()
            .map(|file| file.rel_path)
            .collect();
        paths.sort();
        paths
    }

    fn index(title: &str, composer: &str) -> PieceIndex {
        serde_json::from_value(json!({
            "title": title,
            "composer": composer,
            "measureCount": 24,
            "durationS": 61.5,
            "midiLo": 36,
            "midiHi": 84,
            "hasTempo": true,
            "constantTempo": false,
            "keySharps": 0,
            "keyMode": "major",
            "partCount": 1,
            "partName": "Piano",
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn an_indexed_piece_reads_back_as_the_row_the_library_page_draws() {
        let (_dir, pool) = library().await;
        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("Prelude in C"));
        assert_eq!(row.duration_s, Some(61.5));
        assert_eq!(row.has_tempo, Some(1));
        assert_eq!(row.constant_tempo, Some(0));
        assert_eq!(row.favorite, 0);
        // A piece never played has no history and no settings of its own.
        assert_eq!(row.best_grade, None);
        assert_eq!(row.last_played, None);
        assert_eq!(row.practised_s, None);
        assert_eq!(row.tempo_value, None);
        assert_eq!(row.r#loop, None);
        assert!(get(&pool, "Chopin.musicxml").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_setting_written_is_the_only_column_that_moves_and_null_unsets_it() {
        let (_dir, pool) = library().await;
        let values = json!({ "tempo_mode": "bpm", "tempo_value": 96, "loop": 1 });
        update_settings(&pool, "Bach.musicxml", values.as_object().unwrap())
            .await
            .unwrap();
        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.tempo_mode.as_deref(), Some("bpm"));
        assert_eq!(row.tempo_value, Some(96.0));
        assert_eq!(row.r#loop, Some(1));
        assert_eq!(row.hands, None);

        // A column outside the nine is not a setting, so it is passed over rather than written.
        let unsettable = json!({ "section_from": null, "favorite": 1 });
        update_settings(&pool, "Bach.musicxml", unsettable.as_object().unwrap())
            .await
            .unwrap();
        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.section_from, None);
        assert_eq!(row.favorite, 0);
        assert_eq!(row.tempo_value, Some(96.0));
    }

    #[tokio::test]
    async fn the_history_of_a_piece_is_read_off_its_plays() {
        let (_dir, pool) = library().await;
        insert_play(&pool, "Bach.musicxml", "practice", 1_000.4, 30.0).await.unwrap();
        let run: Performance = serde_json::from_value(json!({
            "startedAt": 2_000.6,
            "seconds": 45.5,
            "tempoMode": "bpm",
            "tempoValue": 96,
            "hands": "both",
            "grade": {
                "grade": 82.5,
                "expected": 40,
                "matched": 38,
                "extras": 1,
                "meanTiming": 90.0,
                "meanVelocity": null,
                "meanRelease": 70.0,
            },
        }))
        .unwrap();
        insert_performance(&pool, "Bach.musicxml", &run).await.unwrap();

        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.best_grade, Some(82.5));
        assert_eq!(row.last_played, Some(2001));
        assert_eq!(row.practised_s, Some(75.5));

        let plays = recent_plays(&pool, "Bach.musicxml", 6).await.unwrap();
        assert_eq!(plays.len(), 2);
        assert_eq!(plays[0].kind, "performance");
        assert_eq!(plays[0].started_at, 2001);
        assert_eq!(plays[0].grade, Some(82.5));
        assert_eq!(plays[1].kind, "practice");
        assert_eq!(plays[1].grade, None);
        assert_eq!(recent_plays(&pool, "Bach.musicxml", 1).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_piece_dropped_takes_its_plays_with_it() {
        let (_dir, pool) = library().await;
        insert_play(&pool, "Bach.musicxml", "practice", 1_000.0, 30.0).await.unwrap();
        delete(&pool, "Bach.musicxml").await.unwrap();
        assert!(get(&pool, "Bach.musicxml").await.unwrap().is_none());
        let left: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM play")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left.0, 0);
    }

    #[tokio::test]
    async fn a_file_gone_leaves_the_list_and_keeps_everything_it_had() {
        let (_dir, pool) = library().await;
        set_favorite(&pool, "Bach.musicxml", true).await.unwrap();
        update_position(&pool, "Bach.musicxml", 480).await.unwrap();
        set_present(&pool, "Bach.musicxml", false).await.unwrap();

        assert_eq!(paths(&pool).await.unwrap(), Vec::<String>::new());
        assert!(list(&pool, "title").await.unwrap().is_empty());
        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.favorite, 1);
        assert_eq!(row.position_tick, Some(480));
        assert_eq!(facts(&pool, "Bach.musicxml").await.2, 0);

        set_present(&pool, "Bach.musicxml", true).await.unwrap();
        assert_eq!(paths(&pool).await.unwrap(), vec!["Bach.musicxml".to_string()]);
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_read_keeps_its_row_and_gains_the_reason() {
        let (_dir, pool) = library().await;
        mark_error(&pool, "Bach.musicxml", "Not a MusicXML file", 9, 8).await.unwrap();
        let row = get(&pool, "Bach.musicxml").await.unwrap().unwrap();
        assert_eq!(row.error.as_deref(), Some("Not a MusicXML file"));
        assert_eq!(row.title.as_deref(), Some("Prelude in C"));
        assert_eq!(facts(&pool, "Bach.musicxml").await.0, 9);

        // Indexing it again clears the reason.
        upsert_index(&pool, "Bach.musicxml", &index("Prelude in C", "J. S. Bach"), 1, 2)
            .await
            .unwrap();
        assert_eq!(get(&pool, "Bach.musicxml").await.unwrap().unwrap().error, None);
    }

    #[tokio::test]
    async fn the_list_is_ordered_by_what_the_pane_was_asked_for() {
        let (_dir, pool) = library().await;
        upsert_index(&pool, "b.musicxml", &index("adagio", "Zelenka"), 1, 2).await.unwrap();
        upsert_index(&pool, "c.musicxml", &index("Etude", "Chopin"), 1, 2).await.unwrap();
        set_favorite(&pool, "c.musicxml", true).await.unwrap();
        insert_play(&pool, "c.musicxml", "practice", 5_000.0, 10.0).await.unwrap();

        let titles = |rows: Vec<PieceRow>| {
            rows.into_iter().map(|row| row.title.unwrap()).collect::<Vec<_>>()
        };
        // Case never decides the order.
        assert_eq!(titles(list(&pool, "title").await.unwrap()), ["adagio", "Etude", "Prelude in C"]);
        assert_eq!(titles(list(&pool, "composer").await.unwrap()), ["Etude", "Prelude in C", "adagio"]);
        // The never-played sort below the one that has been played.
        assert_eq!(titles(list(&pool, "recent").await.unwrap()), ["Etude", "adagio", "Prelude in C"]);
        assert_eq!(titles(list(&pool, "favorites").await.unwrap()), ["Etude"]);
    }

    #[tokio::test]
    async fn only_a_file_the_rows_do_not_match_is_answered_for_parsing() {
        let (_dir, pool) = library().await;
        let folder = folder(&pool).await;
        write(&folder, "Chopin.musicxml", "unseen");

        assert_eq!(to_parse(&pool, &folder, None).await, ["Chopin.musicxml"]);

        // The same file in a new shape is parsed again.
        write(&folder, "Bach.musicxml", "more bytes than before");
        assert_eq!(to_parse(&pool, &folder, None).await, ["Bach.musicxml", "Chopin.musicxml"]);
    }

    #[tokio::test]
    async fn a_file_back_untouched_is_restored_rather_than_parsed() {
        let (_dir, pool) = library().await;
        let folder = folder(&pool).await;
        set_present(&pool, "Bach.musicxml", false).await.unwrap();

        assert_eq!(to_parse(&pool, &folder, None).await, Vec::<String>::new());
        assert_eq!(facts(&pool, "Bach.musicxml").await.2, 1);
    }

    #[tokio::test]
    async fn a_row_whose_file_is_gone_is_hidden() {
        let (_dir, pool) = library().await;
        let folder = folder(&pool).await;
        std::fs::remove_file(folder.path().join("Bach.musicxml")).unwrap();

        assert_eq!(to_parse(&pool, &folder, None).await, Vec::<String>::new());
        assert_eq!(facts(&pool, "Bach.musicxml").await.2, 0);
        assert!(list(&pool, "title").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn one_path_asks_about_that_path_alone() {
        let (_dir, pool) = library().await;
        let folder = folder(&pool).await;
        write(&folder, "Chopin.musicxml", "unseen");

        // The unseen file beside it is not walked, and a matching row is left as it is.
        assert_eq!(to_parse(&pool, &folder, Some("Bach.musicxml")).await, Vec::<String>::new());
        assert_eq!(to_parse(&pool, &folder, Some("Chopin.musicxml")).await, ["Chopin.musicxml"]);

        // A file gone hides its own row and no other.
        std::fs::remove_file(folder.path().join("Bach.musicxml")).unwrap();
        upsert_index(&pool, "Chopin.musicxml", &index("Etude", "Chopin"), 1, 2).await.unwrap();
        assert_eq!(to_parse(&pool, &folder, Some("Bach.musicxml")).await, Vec::<String>::new());
        assert_eq!(facts(&pool, "Bach.musicxml").await.2, 0);
        assert_eq!(facts(&pool, "Chopin.musicxml").await.2, 1);
    }
}
