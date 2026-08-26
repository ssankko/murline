//! The library folder as the frontend sees it: what score files are in it, and their bytes.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const EXTENSIONS: [&str; 3] = ["musicxml", "xml", "mxl"];

/// One score file of the library folder. `rel_path` is the piece's identity, `mtime` (milliseconds)
/// and `size` say whether it changed since it was indexed.
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub rel_path: String,
    pub mtime: i64,
    pub size: i64,
}

/// Every score file under the library folder, at any depth, in no particular order.
#[tauri::command]
pub fn list_library(folder: String) -> Result<Vec<FileEntry>, String> {
    list_dir(Path::new(&folder)).map_err(|e| e.to_string())
}

/// The bytes of one file, sent raw so a megabyte of MusicXML does not travel as a JSON number array.
#[tauri::command]
pub fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

fn list_dir(root: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let meta = entry.metadata()?;
            out.push(FileEntry {
                rel_path: rel.to_string_lossy().into_owned(),
                mtime: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                size: meta.len() as i64,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{list_dir, FileEntry};
    use std::path::Path;

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn find<'a>(list: &'a [FileEntry], rel: &str) -> Option<&'a FileEntry> {
        list.iter().find(|e| e.rel_path == rel)
    }

    #[test]
    fn lists_score_files_at_any_depth_and_ignores_the_rest() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "a.musicxml", "one");
        write(root.path(), "sub/b.xml", "two");
        write(root.path(), "sub/deep/c.MXL", "three");
        write(root.path(), "notes.txt", "not a score");
        write(root.path(), "sub/cover.png", "not a score");

        let mut list = list_dir(root.path()).unwrap();
        list.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

        let names: Vec<&str> = list.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(names, ["a.musicxml", "sub/b.xml", "sub/deep/c.MXL"]);
        assert_eq!(find(&list, "a.musicxml").unwrap().size, 3);
    }

    #[test]
    fn listing_follows_a_file_through_new_changed_missing_and_restored() {
        let root = tempfile::tempdir().unwrap();
        assert!(list_dir(root.path()).unwrap().is_empty());

        write(root.path(), "piece.musicxml", "short");
        let new = list_dir(root.path()).unwrap();
        assert_eq!(find(&new, "piece.musicxml").unwrap().size, 5);

        write(root.path(), "piece.musicxml", "much longer body");
        let changed = list_dir(root.path()).unwrap();
        assert_eq!(find(&changed, "piece.musicxml").unwrap().size, 16);

        std::fs::remove_file(root.path().join("piece.musicxml")).unwrap();
        assert!(find(&list_dir(root.path()).unwrap(), "piece.musicxml").is_none());

        write(root.path(), "piece.musicxml", "short");
        assert!(find(&list_dir(root.path()).unwrap(), "piece.musicxml").is_some());
    }

    #[test]
    fn a_missing_folder_is_an_error_not_an_empty_library() {
        let root = tempfile::tempdir().unwrap();
        assert!(list_dir(&root.path().join("gone")).is_err());
    }
}
