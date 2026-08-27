//! The score finder's index: both providers in one sorted list, searched by word-start tokens.
//!
//! Both index files ship inside the binary. A row keeps only its provider and its line in the
//! index, so the 199,627 PDMX rows cost one pointer each; the fields are split out of the line
//! again for the at most 30 rows a search returns.

use std::borrow::Cow;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

const KS_INDEX: &str = include_str!("../index/kernscores.json");
const PDMX_INDEX: &str = include_str!("../index/pdmx.tsv");
const KS_DATA: &str = "https://kern.ccarh.org/cgi-bin/ksdata";
const MAX_ROWS: usize = 30;

/// Built on first use and kept for the process; `warm()` starts it off the UI thread at launch.
pub static INDEX: LazyLock<Index> = LazyLock::new(|| Index::build(KS_INDEX, PDMX_INDEX));

pub fn warm() {
    std::thread::spawn(|| LazyLock::force(&INDEX));
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    KernScores,
    #[serde(rename = "PDMX")]
    Pdmx,
}

/// One search hit, with everything the finder's two lines show and the name the file lands under.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub provider: Provider,
    /// Composer heading, shared by both providers after normalisation ("Frédéric Chopin").
    pub heading: String,
    pub title: String,
    pub opus: Option<String>,
    pub number: Option<String>,
    pub movement: Option<u32>,
    pub movement_name: Option<String>,
    pub key: Option<String>,
    pub time: Option<String>,
    pub bars: Option<u32>,
    pub ratings: u32,
    /// The uploader's own title when it differs from the site's title field.
    pub alt: Option<String>,
    /// KernScores download URL, or the PDMX path under `<pdmx folder>/mxl/`.
    pub file: String,
    pub file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub rows: Vec<Row>,
    /// Matches beyond the 30 rows returned.
    pub more: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KsRow {
    dir: String,
    file: String,
    composer: Option<String>,
    surname: Option<String>,
    title: String,
    opus: Option<String>,
    number: Option<String>,
    movement: Option<u32>,
    movement_name: Option<String>,
    key: Option<String>,
    time: Option<String>,
    bars: Option<u32>,
}

enum Entry {
    Ks(u32),
    Pdmx(&'static str),
}

/// The fields of one index row, borrowed from the index text.
struct Fields<'a> {
    provider: Provider,
    composer: &'a str,
    surname: Cow<'a, str>,
    title: &'a str,
    opus: Option<&'a str>,
    number: Option<&'a str>,
    movement: Option<u32>,
    movement_name: Option<&'a str>,
    key: Option<&'a str>,
    time: Option<&'a str>,
    bars: Option<u32>,
    ratings: u32,
    /// The uploader's own composer line, searched but never shown.
    credit: Option<&'a str>,
    alt: Option<&'a str>,
    file: Cow<'a, str>,
}

pub struct Index {
    ks: Vec<KsRow>,
    entries: Vec<Entry>,
    /// Every row's normalised haystack, in list order, joined by newlines.
    blob: String,
    /// Byte offset of each row's haystack in `blob`, plus one past the last.
    starts: Vec<u32>,
    /// Length of the composer part at the head of each haystack.
    who: Vec<u32>,
}

impl Index {
    pub fn build(ks_json: &str, pdmx_tsv: &'static str) -> Index {
        let ks: Vec<KsRow> = serde_json::from_str(ks_json).expect("kernscores index");
        let mut keyed: Vec<(String, Entry)> = Vec::with_capacity(ks.len() + pdmx_tsv.len() / 130);
        for i in 0..ks.len() {
            keyed.push((sort_key(&ks_fields(&ks[i])), Entry::Ks(i as u32)));
        }
        for line in pdmx_tsv.lines() {
            keyed.push((sort_key(&pdmx_fields(line)), Entry::Pdmx(line)));
        }
        keyed.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        let mut blob = String::with_capacity(keyed.len() * 130);
        let mut starts = Vec::with_capacity(keyed.len() + 1);
        let mut who = Vec::with_capacity(keyed.len());
        let entries: Vec<Entry> = keyed.into_iter().map(|(_, e)| e).collect();
        for e in &entries {
            let f = fields(&ks, e);
            starts.push(blob.len() as u32);
            let composer = norm(&format!("{} {}", f.composer, heading(f.composer)));
            who.push(composer.len() as u32);
            blob.push_str(&composer);
            blob.push(' ');
            blob.push_str(&norm(&format!(
                "{} {} {} {} {} {} {} {}",
                f.title,
                f.alt.unwrap_or(""),
                f.opus.unwrap_or(""),
                f.number.unwrap_or(""),
                f.movement.map(|m| m.to_string()).unwrap_or_default(),
                f.movement_name.unwrap_or(""),
                f.credit.unwrap_or(""),
                f.file,
            )));
            blob.push('\n');
        }
        starts.push(blob.len() as u32);
        Index { ks, entries, blob, starts, who }
    }

    /// One row's haystack, without the newline that closes it in the blob.
    fn hay(&self, i: usize) -> &str {
        &self.blob[self.starts[i] as usize..self.starts[i + 1] as usize - 1]
    }
}

/// Every token of the query must start a word in the row's haystack (composer, title, opus,
/// number, movement number and name, the uploader's composer and title lines, and the file URL);
/// a digit token must match a whole
/// number, so "op 9" skips Op. 59. Rows whose composer matches more tokens come first, so "satie"
/// lists Erik Satie before the Goudimel harmonisations; inside a rank the rows keep list order.
// ponytail: one scan of the whole blob per keystroke, 12 to 30 ms over the 200k shipped rows in a
// debug build; index the tokens if a query stops keeping up with typing.
pub fn search(ix: &Index, query: &str) -> SearchResult {
    let query = norm(query);
    let tokens: Vec<&str> = query.split_whitespace().collect();
    if tokens.is_empty() {
        return SearchResult { rows: Vec::new(), more: 0 };
    }
    let whole: Vec<bool> = tokens.iter().map(|t| t.bytes().all(|b| b.is_ascii_digit())).collect();
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); tokens.len() + 1];

    let mut pos = 0usize;
    while let Some(off) = ix.blob[pos..].find(tokens[0]) {
        let i = row_at(&ix.starts, (pos + off) as u32);
        let hay = ix.hay(i);
        if tokens.iter().zip(&whole).all(|(t, &w)| has_word(hay, t, w)) {
            let who = &hay[..ix.who[i] as usize];
            let rank = tokens.iter().zip(&whole).filter(|&(t, &w)| has_word(who, t, w)).count();
            buckets[rank].push(i);
        }
        pos = ix.starts[i + 1] as usize;
    }

    let more = buckets.iter().map(Vec::len).sum::<usize>().saturating_sub(MAX_ROWS);
    // One heading per normalised composer name, so both providers land under the same one and a
    // third spelling of the name between them does not open it twice. Rows of one composer always
    // share a rank, so the blocks keep the composer-first order.
    let mut blocks: Vec<(String, Vec<Row>)> = Vec::new();
    let mut taken = 0;
    'fill: for bucket in buckets.iter().rev() {
        for &i in bucket {
            if taken == MAX_ROWS {
                break 'fill;
            }
            let row = row_of(ix, i);
            match blocks.iter_mut().find(|(name, _)| *name == norm(&row.heading)) {
                Some((_, block)) => block.push(row),
                None => blocks.push((norm(&row.heading), vec![row])),
            }
            taken += 1;
        }
    }
    let rows: Vec<Row> = blocks
        .into_iter()
        .flat_map(|(_, block)| {
            let spelling = block[0].heading.clone();
            block.into_iter().map(move |mut row| {
                row.heading = spelling.clone();
                row
            })
        })
        .collect();
    SearchResult { rows, more }
}

fn row_of(ix: &Index, i: usize) -> Row {
    let f = fields(&ix.ks, &ix.entries[i]);
    Row {
        provider: f.provider,
        heading: heading(f.composer),
        file_name: file_name(&f),
        title: f.title.to_string(),
        opus: f.opus.map(str::to_string),
        number: f.number.map(str::to_string),
        movement: f.movement,
        movement_name: f.movement_name.map(str::to_string),
        key: f.key.map(str::to_string),
        time: f.time.map(str::to_string),
        bars: f.bars,
        ratings: f.ratings,
        alt: f.alt.map(str::to_string),
        file: f.file.into_owned(),
    }
}

fn fields<'a>(ks: &'a [KsRow], e: &'a Entry) -> Fields<'a> {
    match *e {
        Entry::Ks(i) => ks_fields(&ks[i as usize]),
        Entry::Pdmx(line) => pdmx_fields(line),
    }
}

fn ks_fields(r: &KsRow) -> Fields<'_> {
    let composer = r.composer.as_deref().unwrap_or("?");
    Fields {
        provider: Provider::KernScores,
        composer,
        surname: Cow::Borrowed(r.surname.as_deref().unwrap_or("?")),
        title: &r.title,
        opus: r.opus.as_deref(),
        number: r.number.as_deref(),
        movement: r.movement,
        movement_name: r.movement_name.as_deref(),
        key: r.key.as_deref(),
        time: r.time.as_deref(),
        bars: r.bars,
        ratings: 0,
        credit: None,
        alt: None,
        file: Cow::Owned(format!("{KS_DATA}?l={}&file={}&f=musicxml", r.dir, r.file)),
    }
}

/// One PDMX line: composer_name, artist_name, song_name, title, subtitle, bars, ratings, path.
fn pdmx_fields(line: &str) -> Fields<'_> {
    let mut c = line.split('\t');
    let mut next = || c.next().unwrap_or("");
    let (credit, artist, song, title, subtitle, bars, ratings, path) =
        (next(), next(), next(), next(), next(), next(), next(), next());
    let composer = if artist.is_empty() { "Unknown" } else { artist };
    let same = norm(song).trim() == norm(title).trim();
    Fields {
        provider: Provider::Pdmx,
        composer,
        surname: Cow::Borrowed(composer.rsplit(' ').next().unwrap_or(composer)),
        title: if song.is_empty() { title } else { song },
        opus: None,
        number: None,
        movement: None,
        movement_name: some(subtitle),
        key: None,
        time: None,
        bars: bars.parse().ok().filter(|&b| b > 0),
        ratings: ratings.parse().unwrap_or(0),
        credit: some(credit),
        alt: if song.is_empty() || same { None } else { some(title) },
        file: Cow::Borrowed(path),
    }
}

fn some(s: &str) -> Option<&str> {
    (!s.is_empty()).then_some(s)
}

/// "Frédéric Chopin" from "Chopin, Frédéric"; the PDMX artist is already in that order.
fn heading(composer: &str) -> String {
    if composer.contains(',') {
        let mut parts: Vec<&str> = composer.split(',').map(str::trim).collect();
        parts.reverse();
        parts.join(" ")
    } else {
        composer.to_string()
    }
}

/// The name the file lands under in the library folder.
fn file_name(f: &Fields) -> String {
    let mut name = format!("{} - {}", f.surname, f.title);
    if let Some(mv) = f.movement {
        name.push_str(&format!(" - {mv}"));
        if let Some(m) = f.movement_name {
            name.push_str(&format!(". {m}"));
        }
    }
    name = name.replace(['/', ':'], "-");
    name.push_str(".musicxml");
    name
}

/// Plain string order on this key is the list order: surname, composer, opus, number, most ratings
/// first, title, movement.
fn sort_key(f: &Fields) -> String {
    format!(
        "{}|{}|{:09}|{}|{:09}|{:09}|{}|{:09}",
        norm(&f.surname),
        norm(f.composer),
        leading_number(f.opus.unwrap_or("")),
        norm(f.opus.unwrap_or("")),
        leading_number(f.number.unwrap_or("")),
        999_999_999u64.saturating_sub(f.ratings as u64),
        norm(f.title),
        f.movement.unwrap_or(0),
    )
}

/// The first run of digits in a catalogue number, so "Op. 50" and "50" sort alike.
fn leading_number(s: &str) -> u64 {
    let digits: String = s
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

/// Lowercase, diacritics stripped, dots and commas as spaces, runs of space collapsed.
fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.nfd().flat_map(char::to_lowercase) {
        let c = match c {
            '\u{300}'..='\u{36f}' => continue,
            '.' | ',' => ' ',
            c => c,
        };
        if c.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A word character for the token rules: the digits and letters of the normalised haystack, and
/// every byte of a non-ASCII character.
fn word_byte(b: u8) -> bool {
    b.is_ascii_digit() || b.is_ascii_lowercase() || b >= 0x80
}

/// Whether `t` starts a word in `s`; a whole (digit) token must end one too, so "9" is not "90".
fn has_word(s: &str, t: &str, whole: bool) -> bool {
    let bytes = s.as_bytes();
    s.match_indices(t).any(|(i, _)| {
        (i == 0 || !word_byte(bytes[i - 1]))
            && (!whole || bytes.get(i + t.len()).map_or(true, |&b| !word_byte(b)))
    })
}

/// The row whose haystack holds blob position `p`.
fn row_at(starts: &[u32], p: u32) -> usize {
    starts.partition_point(|&s| s <= p) - 1
}

/// Async so the search runs off the main thread. The first call waits for `warm()` to finish
/// building the index.
#[tauri::command]
pub async fn finder_search(query: String) -> SearchResult {
    search(&INDEX, &query)
}

/// Where the download landed, for the import path to pick up.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub file_name: String,
    pub temp_path: String,
}

/// One path segment and nothing else: no separator and no walk up the tree.
fn plain_name(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && s != "." && s != ".."
}

/// Whether the row's two paths are still the ones its provider hands out. The row makes the round
/// trip through the webview, so `file` says what the app fetches or opens under the PDMX folder and
/// `file_name` says what it writes in the temp directory; neither may address anything else.
fn addressable(row: &Row) -> bool {
    plain_name(&row.file_name)
        && match row.provider {
            Provider::KernScores => row.file.starts_with(KS_DATA),
            // `<d>/<dd>/<hash>.mxl`, the shape of the unpacked tarball.
            Provider::Pdmx => {
                let mut parts = row.file.split('/');
                matches!(
                    (parts.next(), parts.next(), parts.next(), parts.next()),
                    (Some(d), Some(dd), Some(hash), None)
                        if plain_name(d) && plain_name(dd) && hash.ends_with(".mxl")
                )
            }
        }
}

/// Fetches or unzips one row into a temp file. Nothing reaches the library folder from here; the
/// import path a dropped file takes does that.
#[tauri::command]
pub async fn finder_download(row: Row, pdmx_folder: Option<String>) -> Result<Downloaded, String> {
    if !addressable(&row) {
        return Err("file not found".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match row.provider {
            Provider::KernScores => crate::kernscores::download(&row.file)?,
            Provider::Pdmx => {
                let folder = pdmx_folder.filter(|f| !f.is_empty()).ok_or("file not found")?;
                crate::pdmx::extract(std::path::Path::new(&folder), &row.file)?
            }
        };
        let dir = std::env::temp_dir().join("piano-finder");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&row.file_name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(Downloaded {
            file_name: row.file_name,
            temp_path: path.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const KS: &str = r#"[
      {"dir":"users/craig/classical/chopin/mazurka","file":"mazurka50-1.krn","composer":"Chopin, Frédéric","surname":"Chopin","title":"Mazurka in G Major, Op. 50, No. 1","opus":"50","number":"1","movement":null,"movementName":"Vivace","key":"G major","time":"3/4","bars":103},
      {"dir":"users/craig/classical/chopin/nocturne","file":"nocturne09-1.krn","composer":"Chopin, Frédéric","surname":"Chopin","title":"Nocturne in B-flat minor, Op. 9, No. 1","opus":"9","number":"1","movement":null,"movementName":"Larghetto","key":"Bb minor","time":"6/4","bars":85},
      {"dir":"users/craig/classical/beethoven/piano/sonata","file":"sonata01-1.krn","composer":"Beethoven, Ludwig van","surname":"Beethoven","title":"Piano Sonata no. 1 in F minor","opus":"2","number":"1","movement":1,"movementName":"Allegro","key":"F minor","time":"2/2","bars":152},
      {"dir":"users/craig/classical/beethoven/piano/sonata","file":"sonata21-4.krn","composer":"Beethoven, Ludwig van","surname":"Beethoven","title":"Sonata no. 21 for Piano (Waldstein)","opus":"53","number":null,"movement":4,"movementName":null,"key":"C major","time":"2/4","bars":543}
    ]"#;

    /// composer_name, artist_name, song_name, title, subtitle, bars, ratings, path.
    const PDMX: &str = "Erik Satie\tErik Satie\tGymnopédie No. 1\tSatie Gymnopedie 1 (easy)\tLent et douloureux\t39\t120\t1/23/QmSatieOne.mxl\n\
Erik Satie\tErik Satie\tGnossienne No. 3\tGnossienne No. 3\t\t34\t5\t1/54/QmSatieTwo.mxl\n\
Louis Bourgeois harm: Claude Goudimel\tClaude Goudimel\tPsalm 42\tPsalm 42 after Satie\t\t12\t0\t2/34/QmGoudimelOne.mxl\n\
Harmonisatie: Goudimel\tClaude Goudimel\tPsalm 118\tPsalm 118\t\t14\t0\t2/35/QmGoudimelTwo.mxl\n\
Chopin\tFrederic Chopin\tMazurka Op. 50 No. 1\tChopin Mazurka 50/1\t\t103\t9\t3/12/QmChopin.mxl\n";

    fn index() -> Index {
        Index::build(KS, PDMX)
    }

    fn titles(r: &SearchResult) -> Vec<&str> {
        r.rows.iter().map(|row| row.title.as_str()).collect()
    }

    #[test]
    fn a_token_must_start_a_word_and_ignores_diacritics_and_dots() {
        let ix = index();
        // "Harmonisatie: Goudimel" holds "satie" inside a word, so it never answers "satie".
        assert_eq!(
            titles(&search(&ix, "satie")),
            ["Gymnopédie No. 1", "Gnossienne No. 3", "Psalm 42"]
        );
        assert_eq!(titles(&search(&ix, "gymnopedie")), ["Gymnopédie No. 1"]);
        assert_eq!(titles(&search(&ix, "frederic")).len(), 3);
        assert_eq!(titles(&search(&ix, "nocturne op 9")), ["Nocturne in B-flat minor, Op. 9, No. 1"]);
        assert!(search(&ix, "opedie").rows.is_empty());
        assert!(search(&ix, "   ").rows.is_empty());
    }

    #[test]
    fn a_digit_token_matches_a_whole_number() {
        let ix = index();
        // "Op. 9" is a whole number, so it answers "9" and not "50".
        assert_eq!(titles(&search(&ix, "chopin op 9")), ["Nocturne in B-flat minor, Op. 9, No. 1"]);
        assert_eq!(
            titles(&search(&ix, "chopin 50")),
            ["Mazurka in G Major, Op. 50, No. 1", "Mazurka Op. 50 No. 1"]
        );
        assert!(search(&ix, "5").rows.is_empty());
    }

    #[test]
    fn rows_whose_composer_matches_come_first() {
        let ix = index();
        let hits = search(&ix, "satie");
        assert_eq!(hits.rows[0].heading, "Erik Satie");
        assert_eq!(hits.rows[1].heading, "Erik Satie");
        assert_eq!(hits.rows[2].heading, "Claude Goudimel");
        // Ratings order inside a composer: the Gymnopédie has 120, the Gnossienne 5.
        assert_eq!(hits.rows[0].ratings, 120);
    }

    #[test]
    fn both_providers_share_one_composer_heading() {
        let ix = index();
        let hits = search(&ix, "chopin");
        let headings: Vec<&str> = hits.rows.iter().map(|r| r.heading.as_str()).collect();
        assert_eq!(headings, ["Frédéric Chopin"; 3]);
        let providers: Vec<Provider> = hits.rows.iter().map(|r| r.provider).collect();
        assert_eq!(
            providers,
            [Provider::KernScores, Provider::KernScores, Provider::Pdmx]
        );
    }

    /// The sort puts "J. S. Bach" between "Bach, Johann Sebastian" and "Johann Sebastian Bach",
    /// and the shipped index splits six composers that way.
    #[test]
    fn a_composer_gets_one_heading_even_when_the_sort_splits_its_rows() {
        let ks = r#"[{"dir":"d","file":"bwv846.krn","composer":"Bach, Johann Sebastian",
          "surname":"Bach","title":"Prelude in C major","opus":null,"number":null,"movement":null,
          "movementName":null,"key":"C major","time":"4/4","bars":35}]"#;
        let pdmx = "Bach\tJ. S. Bach\tInvention 1\tInvention 1\t\t22\t3\t1/1/QmA.mxl\n\
Bach\tJohann Sebastian Bach\tMinuet in G\tMinuet in G\t\t32\t7\t1/2/QmB.mxl\n";
        let ix = Index::build(ks, pdmx);
        let hits = search(&ix, "bach");
        assert_eq!(
            hits.rows.iter().map(|r| r.heading.as_str()).collect::<Vec<_>>(),
            ["Johann Sebastian Bach", "Johann Sebastian Bach", "J. S. Bach"]
        );
        assert_eq!(
            hits.rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            ["Prelude in C major", "Minuet in G", "Invention 1"]
        );
    }

    #[test]
    fn a_movement_number_answers_its_digit_token() {
        let ks = r#"[{"dir":"d","file":"waldstein.krn","composer":"Beethoven, Ludwig van",
          "surname":"Beethoven","title":"Sonata for Piano (Waldstein)","opus":"53","number":null,
          "movement":4,"movementName":null,"key":"C major","time":"2/4","bars":543}]"#;
        let ix = Index::build(ks, "");
        assert_eq!(search(&ix, "waldstein 4").rows.len(), 1);
        assert!(search(&ix, "waldstein 3").rows.is_empty());
    }

    #[test]
    fn thirty_rows_then_the_remainder() {
        let mut tsv = String::new();
        for i in 0..40 {
            tsv.push_str(&format!("Erik Satie\tErik Satie\tPiece {i}\tPiece {i}\t\t10\t0\t1/1/Qm{i}.mxl\n"));
        }
        let ix = Index::build("[]", Box::leak(tsv.into_boxed_str()));
        let hits = search(&ix, "satie");
        assert_eq!(hits.rows.len(), 30);
        assert_eq!(hits.more, 10);
        assert_eq!(search(&ix, "piece 7").more, 0);
    }

    #[test]
    fn the_file_name_is_the_one_the_library_folder_gets() {
        let ix = index();
        let hits = search(&ix, "beethoven");
        let names: Vec<&str> = hits.rows.iter().map(|r| r.file_name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Beethoven - Piano Sonata no. 1 in F minor - 1. Allegro.musicxml",
                // A numbered movement with no name ends at the number.
                "Beethoven - Sonata no. 21 for Piano (Waldstein) - 4.musicxml",
            ]
        );
        assert_eq!(
            search(&ix, "gymnopedie").rows[0].file_name,
            "Satie - Gymnopédie No. 1.musicxml"
        );
        assert_eq!(
            search(&ix, "chopin 50").rows[0].file_name,
            "Chopin - Mazurka in G Major, Op. 50, No. 1.musicxml"
        );

        // No shipped row names a file with a doubled dot or a space before the extension.
        for row in &INDEX.ks {
            let name = file_name(&ks_fields(row));
            assert!(!name.contains(".."), "{name}");
            assert!(!name.contains(" .musicxml"), "{name}");
        }
    }

    #[test]
    fn a_row_carries_what_the_two_lines_show() {
        let ix = index();
        let row = &search(&ix, "gymnopedie").rows[0];
        assert_eq!(row.provider, Provider::Pdmx);
        assert_eq!(row.alt.as_deref(), Some("Satie Gymnopedie 1 (easy)"));
        assert_eq!(row.movement_name.as_deref(), Some("Lent et douloureux"));
        assert_eq!(row.bars, Some(39));
        assert_eq!(row.key, None);
        assert_eq!(row.file, "1/23/QmSatieOne.mxl");

        let row = &search(&ix, "nocturne").rows[0];
        assert_eq!(row.provider, Provider::KernScores);
        assert_eq!((row.opus.as_deref(), row.number.as_deref()), (Some("9"), Some("1")));
        assert_eq!((row.key.as_deref(), row.time.as_deref()), (Some("Bb minor"), Some("6/4")));
        assert_eq!(row.alt, None);
        assert!(row.file.starts_with("https://kern.ccarh.org/cgi-bin/ksdata?l="));
    }

    #[test]
    fn an_artist_less_row_reads_unknown() {
        let ix = Index::build("[]", "Satie\t\tGymnopédie 1\tGymnopédie 1\t\t78\t0\t1/45/QmX.mxl\n");
        assert_eq!(search(&ix, "gymnopedie").rows[0].heading, "Unknown");
    }

    fn pdmx_row() -> Row {
        Row {
            provider: Provider::Pdmx,
            heading: "Unknown".to_string(),
            title: "Fixture".to_string(),
            opus: None,
            number: None,
            movement: None,
            movement_name: None,
            key: None,
            time: None,
            bars: None,
            ratings: 0,
            alt: None,
            file: "11/34/QmTNyLYrAi5Qgh37iTp9ieLYzAzb2q8JeNPSKEhDsafzeF.mxl".to_string(),
            file_name: "Fixture.musicxml".to_string(),
        }
    }

    /// A row leaves for the webview and comes back, so a crafted one must reach neither the PDMX
    /// folder above its own file nor the temp directory above its own name.
    #[test]
    fn a_crafted_row_is_refused_where_a_whole_one_downloads() {
        let folder = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pdmx");
        let run = |row: Row| {
            tauri::async_runtime::block_on(finder_download(row, Some(folder.to_string())))
        };

        let good = run(pdmx_row()).unwrap();
        std::fs::remove_file(&good.temp_path).unwrap();

        let mut up = pdmx_row();
        up.file = "11/34/../34/QmTNyLYrAi5Qgh37iTp9ieLYzAzb2q8JeNPSKEhDsafzeF.mxl".to_string();
        assert_eq!(run(up).unwrap_err(), "file not found");

        let mut escape = pdmx_row();
        escape.file_name = "../escaped.musicxml".to_string();
        assert_eq!(run(escape).unwrap_err(), "file not found");
        assert!(!std::env::temp_dir().join("escaped.musicxml").exists());
    }

    /// The shipped index loads and answers every query. The time bounds are wide because a loaded
    /// machine is slow; they still catch a search that stopped being one pass over the blob (a
    /// debug build takes 12 to 30 ms per query here).
    #[test]
    fn the_shipped_index_loads_and_answers_every_query() {
        let start = std::time::Instant::now();
        let rows = INDEX.entries.len();
        let load = start.elapsed();
        assert!(rows > 199_000, "{rows} rows");
        println!("load {rows} rows in {load:?}");

        for query in ["satie", "chopin", "minecraft", "debussy", "chopin op 9", "zzzz"] {
            let start = std::time::Instant::now();
            let hits = search(&INDEX, query);
            let took = start.elapsed();
            println!("{query:?}: {} + {} more in {took:?}", hits.rows.len(), hits.more);
            assert!(took.as_millis() < 500, "{query:?} took {took:?}");
        }
        let start = std::time::Instant::now();
        let hits = search(&INDEX, "s");
        let took = start.elapsed();
        println!("\"s\": {} + {} more in {took:?}", hits.rows.len(), hits.more);
        assert!(took.as_millis() < 2000, "one letter took {took:?}");
    }
}

