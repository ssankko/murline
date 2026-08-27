//! The PDMX download: one `.mxl` from the tarball the user unpacked, opened for its MusicXML.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

/// The most one member may expand to. The largest MusicXML scores run to a few megabytes, and
/// whatever comes out is held in memory here, written to a temp file and read back over IPC.
// ponytail: one flat ceiling for every member; raise it if a real score ever meets it.
const MAX_SCORE: u64 = 32 * 1024 * 1024;

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
}
