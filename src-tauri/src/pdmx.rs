//! The PDMX download: one `.mxl` from the tarball the user unpacked, opened for its MusicXML.

use std::io::Read;
use std::path::Path;

/// The `.xml` inside `<pdmx folder>/mxl/<path>`. Anything the app cannot open there is the one
/// failure the finder reports, so an unpacked tarball is the only thing the user has to get right.
pub fn extract(folder: &Path, path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(folder.join("mxl").join(path)).map_err(|_| "file not found")?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "file not found")?;
    let name = (0..zip.len())
        .find_map(|i| {
            let entry = zip.by_index(i).ok()?;
            let name = entry.name().to_string();
            (name.ends_with(".xml") && !name.starts_with("META-INF/")).then_some(name)
        })
        .ok_or("not MusicXML")?;
    let mut out = Vec::new();
    zip.by_name(&name)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pdmx");
    const ROW: &str = "11/34/QmTNyLYrAi5Qgh37iTp9ieLYzAzb2q8JeNPSKEhDsafzeF.mxl";

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
}
