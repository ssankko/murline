//! The PDMX tarball: the app fetches and unpacks it, and opens one `.mxl` out of it for its
//! MusicXML.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use zip::ZipArchive;

/// The Zenodo record of the PDMX `.mxl` files, 1.89 GB gzipped.
const ARCHIVE: &str = "https://zenodo.org/api/records/15571083/files/mxl.tar.gz/content";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The blocking client applies its timeout to each single read of the body, so this bounds the
/// wait for the next bytes and never the hours the whole 1.89 GB may take.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Downloaded bytes between progress messages.
const STEP: u64 = 4 * 1024 * 1024;

/// One fetch at a time, and the flag `pdmx_cancel` raises to stop it.
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// The most one member may expand to. The largest MusicXML scores run to a few megabytes, and
/// whatever comes out is held in memory here, written to a temp file and read back over IPC.
// ponytail: one flat ceiling for every member; raise it if a real score ever meets it.
const MAX_SCORE: u64 = 32 * 1024 * 1024;

/// Whether the folder holds an unpacked tarball, which is the one thing the finder needs to
/// deliver a PDMX row. An unset folder is no folder, never the working directory.
#[tauri::command]
pub fn pdmx_status(folder: String) -> bool {
    !folder.is_empty() && Path::new(&folder).join("mxl").is_dir()
}

/// How far the download has come; `total` is absent when the server sends no `Content-Length`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Downloads the tarball into `<app data>/pdmx` and answers with that folder. The archive never
/// reaches the disk: it is unpacked as it arrives.
#[tauri::command]
pub async fn pdmx_fetch(
    app: tauri::AppHandle,
    progress: Channel<Progress>,
) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("already downloading".to_string());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let home = app.path().app_data_dir();
    let done = tauri::async_runtime::spawn_blocking(move || {
        let folder = home.map_err(|_| "download failed".to_string())?.join("pdmx");
        fetch_into(&folder, progress)?;
        Ok(folder.to_string_lossy().into_owned())
    })
    .await;
    RUNNING.store(false, Ordering::SeqCst);
    done.unwrap_or_else(|_| Err("download failed".to_string()))
}

/// Stops the running fetch, which then removes what it had unpacked.
#[tauri::command]
pub fn pdmx_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn fetch_into(folder: &Path, progress: Channel<Progress>) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT)
        .build()
        .map_err(|_| "download failed".to_string())?;
    let response = client.get(ARCHIVE).send().map_err(|_| "download failed".to_string())?;
    if !response.status().is_success() {
        return Err("download failed".to_string());
    }
    let total = response.content_length();
    let mut body = Counting { inner: response, done: 0, sent: 0, total, progress };
    unpack(&mut body, folder, &CANCEL)?;
    let _ = body.progress.send(Progress { done: body.done, total });
    Ok(())
}

/// Reports the bytes read from the body about every `STEP` of them.
struct Counting<R> {
    inner: R,
    done: u64,
    sent: u64,
    total: Option<u64>,
    progress: Channel<Progress>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        if self.done - self.sent >= STEP {
            self.sent = self.done;
            let _ = self.progress.send(Progress { done: self.done, total: self.total });
        }
        Ok(n)
    }
}

/// Every `mxl/**/*.mxl` member of the gzipped tarball into `folder`; anything else in the archive
/// is skipped. A failure or a raised `cancel` removes the folder, so a half unpacked tree never
/// stays behind for `pdmx_status` to call finished.
fn unpack(reader: impl Read, folder: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let result = unpack_entries(reader, folder, cancel);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(folder);
    }
    result
}

fn unpack_entries(reader: impl Read, folder: &Path, cancel: &AtomicBool) -> Result<(), String> {
    std::fs::create_dir_all(folder).map_err(io_reason)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    for entry in archive.entries().map_err(io_reason)? {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let mut entry = entry.map_err(io_reason)?;
        let path = entry.path().map_err(io_reason)?.to_string_lossy().into_owned();
        let name = path.strip_prefix("./").unwrap_or(&path);
        if !(name.starts_with("mxl/") && name.ends_with(".mxl")) {
            continue;
        }
        // `unpack_in` drops the leading `./` and refuses any member that walks out of the folder.
        entry.unpack_in(folder).map_err(io_reason)?;
    }
    Ok(())
}

/// The finder shows the reason on one line, so it names no URL and no path.
fn io_reason(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::StorageFull => "not enough disk space",
        _ => "download failed",
    }
    .to_string()
}

/// The score `META-INF/container.xml` names, or the first `.xml` outside `META-INF/` when the
/// archive names none. Anything the app cannot open there is the one failure the finder reports,
/// so an unpacked tarball is the only thing the user has to get right.
pub fn extract(folder: &Path, path: &str) -> Result<Vec<u8>, String> {
    let file = File::open(folder.join("mxl").join(path)).map_err(|_| "file not found")?;
    let mut zip = ZipArchive::new(file).map_err(|_| "file not found")?;
    let name = root_file(&mut zip).or_else(|| first_xml(&mut zip)).ok_or("not MusicXML")?;
    read_capped(&mut zip, &name)
}

/// The member `META-INF/container.xml` points at, when the archive has one and it names a member.
fn root_file(zip: &mut ZipArchive<File>) -> Option<String> {
    let container = read_capped(zip, "META-INF/container.xml").ok()?;
    let mut reader = Reader::from_reader(container.as_slice());
    let mut buf = Vec::new();
    loop {
        let named = match reader.read_event_into(&mut buf).ok()? {
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == "rootfile" => e
                .attributes()
                .flatten()
                .find(|a| a.key.as_ref() == "full-path")
                .map(|a| a.value.into_owned()),
            Event::Eof => return None,
            _ => None,
        };
        if let Some(name) = named
            && zip.index_for_name(&name).is_some()
        {
            return Some(name);
        }
        buf.clear();
    }
}

fn first_xml(zip: &mut ZipArchive<File>) -> Option<String> {
    (0..zip.len()).find_map(|i| {
        let name = zip.by_index(i).ok()?.name().to_string();
        (name.ends_with(".xml") && !name.starts_with("META-INF/")).then_some(name)
    })
}

fn read_capped(zip: &mut ZipArchive<File>, name: &str) -> Result<Vec<u8>, String> {
    let entry = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    entry.take(MAX_SCORE + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() as u64 > MAX_SCORE {
        return Err("file too large".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FOLDER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pdmx");
    const ROW: &str = "11/34/QmTNyLYrAi5Qgh37iTp9ieLYzAzb2q8JeNPSKEhDsafzeF.mxl";

    /// Writes `<folder>/mxl/9/99/made.mxl` from name and body pairs, each body repeated `times`, so
    /// a test can build a member larger than the cap without a fixture on disk.
    fn write_mxl(folder: &Path, members: &[(&str, &[u8])], times: usize) -> String {
        let dir = folder.join("mxl").join("9").join("99");
        std::fs::create_dir_all(&dir).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(dir.join("made.mxl")).unwrap());
        for (name, body) in members {
            zip.start_file::<_, ()>(*name, zip::write::SimpleFileOptions::default()).unwrap();
            for _ in 0..times {
                zip.write_all(body).unwrap();
            }
        }
        zip.finish().unwrap();
        "9/99/made.mxl".to_string()
    }

    #[test]
    fn extract_takes_the_musicxml_out_of_the_mxl() {
        let bytes = extract(Path::new(FOLDER), ROW).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("<?xml"), "{}", &text[..40]);
        assert!(text.contains("<score-partwise"));
    }

    #[test]
    fn a_row_with_no_file_on_disk_is_file_not_found() {
        assert_eq!(extract(Path::new(FOLDER), "0/00/nothing.mxl"), Err("file not found".to_string()));
        assert_eq!(extract(Path::new("/no/such/folder"), ROW), Err("file not found".to_string()));
    }

    /// A member stored before the score is not the score; the container says which one is.
    #[test]
    fn the_container_names_the_score_among_several_xml_members() {
        let folder = tempfile::tempdir().unwrap();
        let container = br#"<?xml version="1.0"?><container><rootfiles>
            <rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/>
            </rootfiles></container>"#;
        let path = write_mxl(
            folder.path(),
            &[
                ("cover.xml", b"<not-a-score/>"),
                ("META-INF/container.xml", container),
                ("score.xml", b"<score-partwise/>"),
            ],
            1,
        );
        assert_eq!(extract(folder.path(), &path), Ok(b"<score-partwise/>".to_vec()));
    }

    #[test]
    fn an_archive_without_a_container_falls_back_to_the_first_xml() {
        let folder = tempfile::tempdir().unwrap();
        let path = write_mxl(folder.path(), &[("score.xml", b"<score-partwise/>")], 1);
        assert_eq!(extract(folder.path(), &path), Ok(b"<score-partwise/>".to_vec()));
    }

    #[test]
    fn a_member_that_expands_past_the_cap_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let megabyte = vec![b' '; 1 << 20];
        let over = (MAX_SCORE >> 20) as usize + 1;
        let path = write_mxl(folder.path(), &[("score.xml", &megabyte)], over);
        assert_eq!(extract(folder.path(), &path), Err("file too large".to_string()));
    }

    /// The four members of the built tarball: two `.mxl` files under `mxl/`, one of them written
    /// with a leading `./`, and two members the unpack must skip.
    const MEMBERS: [&str; 4] = ["mxl/1/11/a.mxl", "./mxl/2/22/b.mxl", "pdf/x.pdf", "mxl/notes.txt"];

    fn write_tar_gz(path: &Path) {
        let gz = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut builder = tar::Builder::new(gz);
        for name in MEMBERS {
            let body = format!("body of {name}");
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            builder.append_data(&mut header, name, body.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    /// Every file under `dir`, as sorted paths relative to it.
    fn files(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let name = format!("{prefix}{}", e.file_name().to_string_lossy());
                if e.path().is_dir() {
                    walk(&e.path(), &format!("{name}/"), out);
                } else {
                    out.push(name);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out.sort();
        out
    }

    #[test]
    fn only_the_mxl_members_are_unpacked() {
        let temp = tempfile::tempdir().unwrap();
        let tarball = temp.path().join("mxl.tar.gz");
        write_tar_gz(&tarball);
        let folder = temp.path().join("pdmx");

        unpack(File::open(&tarball).unwrap(), &folder, &AtomicBool::new(false)).unwrap();
        assert_eq!(files(&folder), ["mxl/1/11/a.mxl", "mxl/2/22/b.mxl"]);
        assert!(pdmx_status(folder.to_string_lossy().into_owned()));
    }

    #[test]
    fn a_cancelled_unpack_leaves_no_folder() {
        let temp = tempfile::tempdir().unwrap();
        let tarball = temp.path().join("mxl.tar.gz");
        write_tar_gz(&tarball);
        let folder = temp.path().join("pdmx");
        unpack(File::open(&tarball).unwrap(), &folder, &AtomicBool::new(false)).unwrap();

        let cancel = AtomicBool::new(true);
        let again = unpack(File::open(&tarball).unwrap(), &folder, &cancel);
        assert_eq!(again, Err("cancelled".to_string()));
        assert!(!folder.exists());
        assert!(!pdmx_status(folder.to_string_lossy().into_owned()));
        assert!(!pdmx_status(String::new()));
    }

    #[test]
    fn a_truncated_download_leaves_no_folder() {
        let temp = tempfile::tempdir().unwrap();
        let tarball = temp.path().join("mxl.tar.gz");
        write_tar_gz(&tarball);
        let whole = std::fs::read(&tarball).unwrap();
        let folder = temp.path().join("pdmx");

        let half = &whole[..whole.len() / 2];
        let torn = unpack(half, &folder, &AtomicBool::new(false));
        assert_eq!(torn, Err("download failed".to_string()));
        assert!(!folder.exists());
    }
}
