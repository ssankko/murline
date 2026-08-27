//! The library folder as the frontend sees it: what score files are in it, their bytes, and the
//! file operations the library page runs on them.

use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use trash::macos::TrashContextExtMacos;

const EXTENSIONS: [&str; 3] = ["musicxml", "xml", "mxl"];

/// One score file of the library folder. `rel_path` is the piece's identity, `mtime` (milliseconds)
/// and `size` say whether it changed since it was indexed.
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub rel_path: String,
    pub mtime: i64,
    pub size: i64,
}

/// What a file was when it was last read: enough to tell whether it changed.
#[derive(Debug, Serialize)]
pub struct Stamp {
    pub mtime: i64,
    pub size: i64,
}

/// Every score file under the library folder, at any depth, in no particular order.
#[tauri::command]
pub async fn list_library(folder: String) -> Result<Vec<FileEntry>, String> {
    list_dir(Path::new(&folder)).map_err(|e| e.to_string())
}

/// The bytes of one file, sent raw so a megabyte of MusicXML does not travel as a JSON number array.
#[tauri::command]
pub async fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Copies an imported file into the library folder, overwriting whatever is at `dst`. The stamp of
/// the written file goes back so the caller can index it without listing the folder again.
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<Stamp, String> {
    copy(Path::new(&src), Path::new(&dst)).map_err(|e| e.to_string())
}

/// Deletes the finder's download once the import has read it: a file the user never saw does not
/// belong in the Trash. Nothing outside the OS temp directory is deleted, so the Trash stays the
/// only way a file of the library folder goes.
#[tauri::command]
pub fn remove_temp_file(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    let inside = path.starts_with(std::env::temp_dir())
        && !path.components().any(|c| c == std::path::Component::ParentDir);
    if !inside {
        return Err(format!("not a temp file: {}", path.display()));
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Opens the file's folder in the Finder with the file selected.
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .args(["-R", &path])
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| s.success().then_some(()).ok_or_else(|| s.to_string()))
}

/// Moves the file to the macOS Trash, which is the only undo a delete has. `NSFileManager` does the
/// move instead of the Finder, so deleting never asks the user for automation rights; the cost is
/// that the Trash may not offer "Put Back" for the file.
#[tauri::command]
pub async fn trash_file(path: String) -> Result<(), String> {
    let mut context = trash::TrashContext::default();
    context.set_delete_method(trash::macos::DeleteMethod::NsFileManager);
    context.delete(&path).map_err(|e| e.to_string())
}

fn copy(src: &Path, dst: &Path) -> std::io::Result<Stamp> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(stamp(&std::fs::metadata(dst)?))
}

fn stamp(meta: &std::fs::Metadata) -> Stamp {
    Stamp {
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        size: meta.len() as i64,
    }
}

/// A symlink is never followed, so a link pointing back up the tree cannot loop, and a name that is
/// not UTF-8 is skipped, because a `rel_path` that does not round-trip names no file to reopen.
// ponytail: walks the whole tree on every launch scan; take a depth cap or an incremental walk when
// a library folder gets deep enough for the scan to be felt.
fn list_dir(root: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
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
            let Some(rel) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
                continue;
            };
            let Stamp { mtime, size } = stamp(&entry.metadata()?);
            out.push(FileEntry { rel_path: rel.to_string(), mtime, size });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{copy, list_dir, remove_temp_file, trash_file, FileEntry};
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
    fn copy_creates_the_folder_and_reports_the_written_size() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "away/piece.musicxml", "sixteen letters!");

        let dst = root.path().join("library").join("piece.musicxml");
        let stamp = copy(&root.path().join("away/piece.musicxml"), &dst).unwrap();

        assert_eq!(stamp.size, 16);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "sixteen letters!");
    }

    #[test]
    fn trash_takes_the_file_off_its_path() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "doomed.musicxml", "bytes");
        let path = root.path().join("doomed.musicxml");

        tauri::async_runtime::block_on(trash_file(path.to_string_lossy().into_owned())).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn only_a_file_under_the_temp_directory_is_deleted_outright() {
        let temp = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        write(temp.path(), "download.musicxml", "bytes");
        let path = temp.path().join("download.musicxml");
        remove_temp_file(path.to_string_lossy().into_owned()).unwrap();
        assert!(!path.exists());

        let library = tempfile::tempdir().unwrap();
        write(library.path(), "piece.musicxml", "bytes");
        let outside = library.path().join("..").join("piece.musicxml");
        assert!(remove_temp_file("/Users/somebody/Music/Piano/piece.musicxml".to_string()).is_err());
        assert!(remove_temp_file(outside.to_string_lossy().into_owned()).is_err());
        assert!(library.path().join("piece.musicxml").exists());
    }

    #[test]
    fn a_symlink_that_points_back_up_the_tree_does_not_loop() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "sub/piece.musicxml", "bytes");
        std::os::unix::fs::symlink(root.path(), root.path().join("sub").join("up")).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("sub/piece.musicxml"),
            root.path().join("link.musicxml"),
        )
        .unwrap();

        let list = list_dir(root.path()).unwrap();

        let names: Vec<&str> = list.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(names, ["sub/piece.musicxml"]);
    }

    /// APFS refuses a name that is not UTF-8, so this only bites on a library folder mounted from a
    /// filesystem that allows one.
    #[test]
    fn a_name_that_is_not_utf_8_is_no_piece() {
        use std::os::unix::ffi::OsStrExt;
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "good.musicxml", "bytes");
        let bad = root.path().join(std::ffi::OsStr::from_bytes(b"bad\xff.musicxml"));
        if std::fs::write(&bad, "bytes").is_err() {
            return;
        }

        let list = list_dir(root.path()).unwrap();

        let names: Vec<&str> = list.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(names, ["good.musicxml"]);
    }

    #[test]
    fn a_missing_folder_is_an_error_not_an_empty_library() {
        let root = tempfile::tempdir().unwrap();
        assert!(list_dir(&root.path().join("gone")).is_err());
    }
}
