//! The KernScores download and the file rule it runs on the way in.
//!
//! `ksdata?f=musicxml` writes one single-staff `<part>` per kern spine and dynamics as lyric text.
//! `merge` folds every part into one piano part with two staves: two parts are two hands (the
//! F-clef part is staff 2, each keeps its clef changes), three or more are voices that move
//! between fixed staves, so there the clef of the moment decides the staff of every note. A lyric
//! that spells a dynamic becomes a `<dynamics>` direction on staff 1; every other lyric is dropped.

use std::time::Duration;

use quick_xml::escape::{partial_escape, resolve_predefined_entity};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer, XmlVersion};

const TIMEOUT: Duration = Duration::from_secs(15);
/// Children a `<note>` writes after its `<staff>`.
const AFTER_STAFF: [&str; 3] = ["beam", "notations", "play"];
/// The words a KernScores lyric may spell that are dynamics, not text.
const DYNAMICS: [&str; 17] = [
    "p", "pp", "ppp", "pppp", "f", "ff", "fff", "ffff", "mp", "mf", "sf", "sfp", "sfz", "fp", "rf",
    "rfz", "fz",
];
/// Element nesting `parse` accepts. MusicXML reaches about ten, and the tree walks that follow
/// `parse` recurse once per level, so a deeper document is refused instead of overflowing the stack.
const MAX_DEPTH: usize = 64;

/// One request for the row's MusicXML, then the file rule.
pub fn download(url: &str) -> Result<Vec<u8>, String> {
    merge(&fetch(url)?)
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| reason(e.to_string()))?;
    let response = client.get(url).send().map_err(|e| {
        if e.is_timeout() {
            "timed out".to_string()
        } else {
            reason(e.to_string())
        }
    })?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.bytes().map(|b| b.to_vec()).map_err(|e| reason(e.to_string()))
}

/// reqwest ends every message with the whole `ksdata` query it was given. The finder's red bar
/// shows the reason on one line, so the URL comes off.
fn reason(message: String) -> String {
    match message.split_once(" for url (") {
        Some((head, _)) => head.to_string(),
        None => message,
    }
}

/// Every part into one, `<backup>` between them in each measure, staff on every note, voices
/// renumbered so no two parts collide, and the later parts' key, time, print and barline dropped.
pub fn merge(xml: &[u8]) -> Result<Vec<u8>, String> {
    let (prologue, mut root) = parse(xml)?;
    if root.name != "score-partwise" {
        return Err("not MusicXML".to_string());
    }
    merge_parts(&mut root)?;
    let mut w = Writer::new_with_indent(prologue, b'\t', 1);
    write(&root, &mut w).map_err(|e| e.to_string())?;
    let mut out = w.into_inner();
    out.push(b'\n');
    Ok(out)
}

#[derive(Clone, Default)]
struct Elem {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
}

#[derive(Clone)]
enum Node {
    Elem(Elem),
    /// Character data with every reference resolved; the writer escapes it again.
    Text(String),
}

/// What one part is doing while its measures are converted.
struct State {
    staff: u8,
    voice_base: u32,
    first: bool,
    by_clef: bool,
}

fn merge_parts(root: &mut Elem) -> Result<(), String> {
    let mut parts: Vec<Elem> = Vec::new();
    let mut at = 0;
    let mut kept: Vec<Node> = Vec::new();
    for node in std::mem::take(&mut root.children) {
        match node {
            Node::Elem(e) if e.name == "part" => {
                if parts.is_empty() {
                    at = kept.len();
                }
                parts.push(e);
            }
            node => kept.push(node),
        }
    }
    root.children = kept;
    if parts.is_empty() {
        return Err("no parts".to_string());
    }

    let by_clef = parts.len() > 2;
    let mut states: Vec<State> = parts
        .iter()
        .enumerate()
        .map(|(k, p)| State {
            staff: descendant(p, "clef").map_or(1, staff_of_clef),
            voice_base: 4 * k as u32,
            first: k == 0,
            by_clef,
        })
        .collect();
    // Two parts that open on the same clef carry no hint, so their order decides.
    if parts.len() == 2 && states[0].staff == states[1].staff {
        states[0].staff = 1;
        states[1].staff = 2;
    }
    // The clef each staff opens with, taken from the first part that lands on it.
    let mut opening: [Option<Elem>; 2] = [None, None];
    for (p, st) in parts.iter().zip(&states) {
        if let Some(clef) = descendant(p, "clef") {
            let slot = &mut opening[st.staff as usize - 1];
            if slot.is_none() {
                *slot = Some(clef.clone());
            }
        }
    }

    if let Some(list) = child_mut(root, "part-list") {
        let mut seen = false;
        list.children.retain(|n| match n {
            Node::Elem(e) if e.name == "score-part" => !std::mem::replace(&mut seen, true),
            _ => true,
        });
        if let Some(name) = child_mut(list, "score-part").and_then(|p| child_mut(p, "part-name")) {
            name.children = vec![Node::Text("Piano".to_string())];
        }
    }

    let mut measures: Vec<Vec<Elem>> = parts.iter_mut().map(|p| take_all(p, "measure")).collect();
    if measures.iter().any(|m| m.len() != measures[0].len()) {
        return Err("parts differ in measure count".to_string());
    }

    let mut merged = Elem { attrs: parts[0].attrs.clone(), ..elem("part") };
    for i in 0..measures[0].len() {
        let lengths: Vec<i64> = measures.iter().map(|m| length(&m[i])).collect();
        let mut target = Elem { attrs: measures[0][i].attrs.clone(), ..elem("measure") };
        for k in 0..measures.len() {
            if k > 0 {
                let mut backup = elem("backup");
                backup.children.push(Node::Elem(leaf("duration", &lengths[k - 1].to_string())));
                target.children.push(Node::Elem(backup));
            }
            let measure = std::mem::take(&mut measures[k][i]);
            for el in convert(measure, &mut states[k], i == 0) {
                target.children.push(Node::Elem(el));
            }
        }
        if i == 0 {
            open_staves(&mut target, &opening, by_clef);
        }
        merged.children.push(Node::Elem(target));
    }
    root.children.insert(at, Node::Elem(merged));
    Ok(())
}

/// One measure's children, re-tagged for the part's staff; dynamics lyrics become directions.
fn convert(measure: Elem, st: &mut State, first_measure: bool) -> Vec<Elem> {
    let mut out: Vec<Elem> = Vec::new();
    for node in measure.children {
        let mut el = match node {
            Node::Elem(e) => e,
            Node::Text(_) => continue,
        };
        let staff = st.staff.to_string();
        match el.name.as_str() {
            "attributes" => {
                let mut clefs: Vec<Elem> = Vec::new();
                let mut kept: Vec<Node> = Vec::new();
                for child in std::mem::take(&mut el.children) {
                    match child {
                        Node::Elem(mut clef) if clef.name == "clef" => {
                            if st.by_clef {
                                st.staff = staff_of_clef(&clef);
                            } else {
                                set_attr(&mut clef, "number", &st.staff.to_string());
                                clefs.push(clef.clone());
                                kept.push(Node::Elem(clef));
                            }
                        }
                        child => kept.push(child),
                    }
                }
                el.children = kept;
                if st.first {
                    out.push(el);
                } else if !first_measure && !clefs.is_empty() {
                    let mut attributes = elem("attributes");
                    attributes.children = clefs.into_iter().map(Node::Elem).collect();
                    out.push(attributes);
                }
            }
            "print" | "barline" if !st.first => {}
            "direction" => {
                match child_mut(&mut el, "staff") {
                    Some(s) => s.children = vec![Node::Text(staff.clone())],
                    None => el.children.push(Node::Elem(leaf("staff", &staff))),
                }
                out.push(el);
            }
            "note" => {
                let chord = child(&el, "chord").is_some();
                for lyric in take_all(&mut el, "lyric") {
                    let text = child(&lyric, "text").map(text_of).unwrap_or_default();
                    if DYNAMICS.contains(&text.trim()) {
                        // The mark goes on staff 1 like a MuseScore piano export's, whichever part
                        // the lyric was in, before the note or before the first note of its chord.
                        let mut pos = out.len();
                        if chord {
                            while pos > 0 && out[pos - 1].name == "note" {
                                pos -= 1;
                                if child(&out[pos], "chord").is_none() {
                                    break;
                                }
                            }
                        }
                        out.insert(pos, dynamics(text.trim(), "1"));
                    }
                }
                if let Some(voice) = child_mut(&mut el, "voice") {
                    let n: u32 = text_of(voice).trim().parse().unwrap_or(0);
                    voice.children = vec![Node::Text((n + st.voice_base).to_string())];
                }
                let pos = el
                    .children
                    .iter()
                    .position(|n| matches!(n, Node::Elem(e) if AFTER_STAFF.contains(&e.name.as_str())))
                    .unwrap_or(el.children.len());
                el.children.insert(pos, Node::Elem(leaf("staff", &staff)));
                out.push(el);
            }
            _ => out.push(el),
        }
    }
    out
}

/// The first measure's one `<attributes>`: what the parts declared, `<staves>`, then each staff's
/// opening clef, in MusicXML order.
fn open_staves(target: &mut Elem, opening: &[Option<Elem>; 2], by_clef: bool) {
    let mut merged = elem("attributes");
    let mut kept: Vec<Node> = Vec::new();
    for node in std::mem::take(&mut target.children) {
        match node {
            Node::Elem(e) if e.name == "attributes" => {
                for child in e.children {
                    if !matches!(&child, Node::Elem(c) if c.name == "clef") {
                        merged.children.push(child);
                    }
                }
            }
            node => kept.push(node),
        }
    }
    target.children = kept;
    merged.children.push(Node::Elem(leaf("staves", "2")));
    for staff in [1u8, 2] {
        let mut clef = match &opening[staff as usize - 1] {
            Some(c) if !by_clef => c.clone(),
            _ => {
                let mut c = elem("clef");
                c.children.push(Node::Elem(leaf("sign", if staff == 1 { "G" } else { "F" })));
                c.children.push(Node::Elem(leaf("line", if staff == 1 { "2" } else { "4" })));
                c
            }
        };
        set_attr(&mut clef, "number", &staff.to_string());
        merged.children.push(Node::Elem(clef));
    }
    target.children.insert(0, Node::Elem(merged));
}

/// Ticks a measure's content advances: durations of non-chord notes plus forward minus backup.
fn length(measure: &Elem) -> i64 {
    let mut ticks: i64 = 0;
    for node in &measure.children {
        let Node::Elem(el) = node else { continue };
        let Some(duration) = child(el, "duration") else { continue };
        let n: i64 = text_of(duration).trim().parse().unwrap_or(0);
        match el.name.as_str() {
            "note" if child(el, "chord").is_none() => ticks = ticks.saturating_add(n),
            "forward" => ticks = ticks.saturating_add(n),
            "backup" => ticks = ticks.saturating_sub(n),
            _ => {}
        }
    }
    ticks
}

fn staff_of_clef(clef: &Elem) -> u8 {
    if child(clef, "sign").map(text_of).as_deref() == Some("F") {
        2
    } else {
        1
    }
}

fn dynamics(word: &str, staff: &str) -> Elem {
    let mut direction =
        Elem { attrs: vec![("placement".to_string(), "below".to_string())], ..elem("direction") };
    direction.children = vec![
        Node::Elem(wrap("direction-type", wrap("dynamics", elem(word)))),
        Node::Elem(leaf("staff", staff)),
    ];
    direction
}

fn elem(name: &str) -> Elem {
    Elem { name: name.to_string(), ..Elem::default() }
}

fn wrap(name: &str, child: Elem) -> Elem {
    Elem { children: vec![Node::Elem(child)], ..elem(name) }
}

fn leaf(name: &str, text: &str) -> Elem {
    Elem { children: vec![Node::Text(text.to_string())], ..elem(name) }
}

fn child<'a>(el: &'a Elem, name: &str) -> Option<&'a Elem> {
    el.children.iter().find_map(|n| match n {
        Node::Elem(e) if e.name == name => Some(e),
        _ => None,
    })
}

fn child_mut<'a>(el: &'a mut Elem, name: &str) -> Option<&'a mut Elem> {
    el.children.iter_mut().find_map(|n| match n {
        Node::Elem(e) if e.name == name => Some(e),
        _ => None,
    })
}

/// The first element of that name anywhere below `el`, in document order.
fn descendant<'a>(el: &'a Elem, name: &str) -> Option<&'a Elem> {
    for node in &el.children {
        let Node::Elem(e) = node else { continue };
        if e.name == name {
            return Some(e);
        }
        if let Some(found) = descendant(e, name) {
            return Some(found);
        }
    }
    None
}

/// Removes and returns every direct child of that name.
fn take_all(el: &mut Elem, name: &str) -> Vec<Elem> {
    let mut found = Vec::new();
    let mut kept = Vec::new();
    for node in std::mem::take(&mut el.children) {
        match node {
            Node::Elem(e) if e.name == name => found.push(e),
            node => kept.push(node),
        }
    }
    el.children = kept;
    found
}

fn text_of(el: &Elem) -> String {
    el.children
        .iter()
        .filter_map(|n| match n {
            Node::Text(t) => Some(t.as_str()),
            Node::Elem(_) => None,
        })
        .collect()
}

fn set_attr(el: &mut Elem, name: &str, value: &str) {
    match el.attrs.iter_mut().find(|(k, _)| k == name) {
        Some(a) => a.1 = value.to_string(),
        None => el.attrs.push((name.to_string(), value.to_string())),
    }
}

/// Everything outside the root element, kept as it stands, and the root.
fn parse(xml: &[u8]) -> Result<(Vec<u8>, Elem), String> {
    let mut reader = Reader::from_reader(xml);
    let mut prologue: Vec<u8> = Vec::new();
    let mut stack: Vec<Elem> = Vec::new();
    let mut root: Option<Elem> = None;
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| e.to_string())?;
        match event {
            Event::Start(e) => {
                if stack.len() == MAX_DEPTH {
                    return Err("XML nested too deep".to_string());
                }
                stack.push(open(&e)?);
            }
            Event::Empty(e) => {
                let el = open(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(Node::Elem(el)),
                    None => root = Some(el),
                }
            }
            Event::End(_) => {
                let el = stack.pop().ok_or("unbalanced XML")?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(Node::Elem(el)),
                    None => root = Some(el),
                }
            }
            // Whitespace next to another piece of character data is content; whitespace between
            // elements is the source's indentation and goes.
            Event::Text(e) => {
                let text = e.as_ref();
                if let Some(parent) = stack.last_mut()
                    && (!text.trim().is_empty()
                        || matches!(parent.children.last(), Some(Node::Text(_))))
                {
                    parent.children.push(Node::Text(text.to_string()));
                }
            }
            Event::CData(e) => {
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Node::Text(e.into_inner().into_owned()));
                }
            }
            // A reference is its own event, so the character it stands for is put back here.
            Event::GeneralRef(e) => {
                let text = match e.resolve_char_ref().map_err(|err| err.to_string())? {
                    Some(c) => c.to_string(),
                    None => resolve_predefined_entity(&e)
                        .ok_or_else(|| format!("unknown XML entity &{};", &*e))?
                        .to_string(),
                };
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Node::Text(text));
                }
            }
            Event::Decl(e) => {
                prologue.extend_from_slice(b"<?");
                prologue.extend_from_slice(e.as_ref().as_bytes());
                prologue.extend_from_slice(b"?>\n");
            }
            Event::DocType(e) => {
                prologue.extend_from_slice(b"<!DOCTYPE ");
                prologue.extend_from_slice(e.as_ref().as_bytes());
                prologue.extend_from_slice(b">\n");
            }
            // A comment outside the root, wherever the source put it, heads the merged file.
            Event::Comment(e) if stack.is_empty() => {
                prologue.extend_from_slice(b"<!--");
                prologue.extend_from_slice(e.as_ref().as_bytes());
                prologue.extend_from_slice(b"-->\n");
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    root.map(|r| (prologue, r)).ok_or_else(|| "no root element".to_string())
}

/// Attribute values are held unescaped, so a value the source quoted with `'` writes correctly.
fn open(e: &quick_xml::events::BytesStart) -> Result<Elem, String> {
    let mut attrs = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("bad XML attribute: {err}"))?;
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|err| err.to_string())?
            .into_owned();
        attrs.push((attr.key.as_ref().to_string(), value));
    }
    Ok(Elem { name: e.name().as_ref().to_string(), attrs, children: Vec::new() })
}

/// One tab per level. The writer breaks the line before every event but the one after character
/// data, which is what an element of pure text needs and what MusicXML's mixed-content-free
/// documents ask for everywhere else.
fn write(el: &Elem, w: &mut Writer<Vec<u8>>) -> std::io::Result<()> {
    let mut start = BytesStart::new(&el.name);
    for (k, v) in &el.attrs {
        start.push_attribute((k.as_str(), v.as_str()));
    }
    if el.children.is_empty() {
        return w.write_event(Event::Empty(start));
    }
    w.write_event(Event::Start(start))?;
    for node in &el.children {
        match node {
            Node::Elem(child) => write(child, w)?,
            Node::Text(t) => {
                w.write_event(Event::Text(BytesText::from_escaped(partial_escape(t))))?;
            }
        }
    }
    w.write_event(Event::End(BytesEnd::new(&el.name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Name, MusicXML, then the note counts: all notes, right staff, left staff, dynamic marks.
    type Fixture = (&'static str, &'static [u8], usize, usize, usize, usize);

    /// The seven downloads the file rule was settled on.
    const FIXTURES: [Fixture; 7] = [
        ("mazurka-50", include_bytes!("../fixtures/mazurka-50.musicxml"), 1486, 1014, 472, 8),
        ("sonata01-1", include_bytes!("../fixtures/sonata01-1.musicxml"), 1901, 939, 962, 34),
        ("wtc1p01", include_bytes!("../fixtures/wtc1p01.musicxml"), 747, 535, 212, 0),
        ("wtc1f01", include_bytes!("../fixtures/wtc1f01.musicxml"), 847, 475, 372, 0),
        ("wtc1f04", include_bytes!("../fixtures/wtc1f04.musicxml"), 1560, 763, 797, 0),
        ("L001K514", include_bytes!("../fixtures/L001K514.musicxml"), 711, 363, 348, 17),
        ("prelude28-01", include_bytes!("../fixtures/prelude28-01.musicxml"), 510, 282, 228, 0),
    ];

    fn all<'a>(el: &'a Elem, name: &str, out: &mut Vec<&'a Elem>) {
        for node in &el.children {
            let Node::Elem(e) = node else { continue };
            if e.name == name {
                out.push(e);
            }
            all(e, name, out);
        }
    }

    fn find<'a>(el: &'a Elem, name: &str) -> Vec<&'a Elem> {
        let mut out = Vec::new();
        all(el, name, &mut out);
        out
    }

    fn staff_of(note: &Elem) -> &str {
        note.children
            .iter()
            .find_map(|n| match n {
                Node::Elem(e) if e.name == "staff" => Some(e),
                _ => None,
            })
            .map_or("", |e| match e.children.first() {
                Some(Node::Text(t)) => t.as_str(),
                _ => "",
            })
    }

    #[test]
    fn merge_keeps_every_note_and_makes_one_two_staff_part() {
        for (name, raw, notes, staff1, staff2, dynamics) in FIXTURES {
            let (_, before) = parse(raw).unwrap();
            assert_eq!(find(&before, "note").len(), notes, "{name}: notes before");

            let out = merge(raw).unwrap();
            let (_, after) = parse(&out).unwrap();
            let merged = find(&after, "note");
            assert_eq!(merged.len(), notes, "{name}: notes after");
            assert_eq!(find(&after, "part").len(), 1, "{name}: parts");
            assert_eq!(find(&after, "score-part").len(), 1, "{name}: score-parts");
            assert_eq!(
                merged.iter().filter(|n| staff_of(n) == "1").count(),
                staff1,
                "{name}: notes on staff 1"
            );
            assert_eq!(
                merged.iter().filter(|n| staff_of(n) == "2").count(),
                staff2,
                "{name}: notes on staff 2"
            );
            assert_eq!(find(&after, "dynamics").len(), dynamics, "{name}: dynamics");
            assert_eq!(find(&after, "lyric").len(), 0, "{name}: lyrics");
        }
    }

    #[test]
    fn three_or_more_parts_take_the_staff_of_their_clef() {
        // The WTC I/1 prelude's middle voice moves to the bass staff at bar 10, and both staves
        // keep the clef they open with.
        let out = merge(include_bytes!("../fixtures/wtc1p01.musicxml")).unwrap();
        let (_, root) = parse(&out).unwrap();
        let clefs = find(&root, "clef");
        assert_eq!(clefs.len(), 2, "one clef per staff, none mid-score");
        assert_eq!(text_of(child(clefs[0], "sign").unwrap()), "G");
        assert_eq!(text_of(child(clefs[1], "sign").unwrap()), "F");
        assert_eq!(text_of(find(&root, "staves")[0]), "2");

        let measures = find(&root, "measure");
        let on_staff2 = |m: &Elem| find(m, "note").iter().filter(|n| staff_of(n) == "2").count();
        assert_eq!(on_staff2(measures[8]), 2, "bar 9, the middle voice is still on top");
        assert_eq!(on_staff2(measures[9]), 8, "bar 10, the middle voice moved down");
    }

    #[test]
    fn voices_are_renumbered_per_part() {
        let out = merge(include_bytes!("../fixtures/wtc1f04.musicxml")).unwrap();
        let (_, root) = parse(&out).unwrap();
        let voices: std::collections::BTreeSet<String> =
            find(&root, "voice").iter().map(|v| text_of(v)).collect();
        assert_eq!(voices, ["1", "13", "17", "5", "9"].map(String::from).into_iter().collect());
    }

    /// Two parts, the dynamic lyric in the F-clef one.
    const TWO_HANDS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
 <part-list>
  <score-part id="P1"><part-name>right</part-name></score-part>
  <score-part id="P2"><part-name>left</part-name></score-part>
 </part-list>
 <part id="P1">
  <measure number="1">
   <attributes><divisions>1</divisions><clef><sign>@1</sign><line>2</line></clef></attributes>
   <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice></note>
  </measure>
 </part>
 <part id="P2">
  <measure number="1">
   <attributes><divisions>1</divisions><clef><sign>@2</sign><line>4</line></clef></attributes>
   <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice>
    <lyric><text>p</text></lyric></note>
  </measure>
 </part>
</score-partwise>"#;

    fn two_hands(first: &str, second: &str) -> Vec<u8> {
        TWO_HANDS.replace("@1", first).replace("@2", second).into_bytes()
    }

    /// Two parts are two staves whatever clefs they open with, and the lyric of the second part
    /// becomes a `<dynamics>` mark named for its word, on staff 1.
    #[test]
    fn two_parts_become_two_staves_with_their_dynamics_on_staff_1() {
        for (first, second) in [("G", "F"), ("G", "G"), ("F", "F")] {
            let out = merge(&two_hands(first, second)).unwrap();
            let (_, root) = parse(&out).unwrap();
            // The note that carried the lyric stays on its own staff.
            let notes = find(&root, "note");
            assert_eq!(
                notes.iter().map(|n| staff_of(n)).collect::<Vec<_>>(),
                ["1", "2"],
                "{first} over {second}"
            );
            let directions = find(&root, "direction");
            assert_eq!(directions.len(), 1, "{first} over {second}");
            assert_eq!(text_of(child(directions[0], "staff").unwrap()), "1");
            let mark = child(child(directions[0], "direction-type").unwrap(), "dynamics").unwrap();
            assert!(matches!(&mark.children[..], [Node::Elem(e)] if e.name == "p"));
        }
    }

    /// A download whose title or credit carries a reference, and an attribute delimited with `'`
    /// around both quote characters: the merged file must hold the same text and parse again.
    #[test]
    fn references_and_quotes_come_through_the_merge() {
        let xml = r#"<score-partwise version="3.1">
 <work><work-title>Prelude &amp; Fugue in C&#233; &lt;fast&gt;</work-title></work>
 <movement-title><![CDATA[Piu mosso < forte]]></movement-title>
 <part-list><score-part id='P"1" &amp; only'><part-name>right</part-name></score-part></part-list>
 <part id="P1"><measure number="1">
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note>
 </measure></part>
</score-partwise>"#;
        let out = merge(xml.as_bytes()).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.contains("Prelude &amp; Fugue in C\u{e9} &lt;fast&gt;"), "{text}");

        let (_, root) = parse(&out).unwrap();
        assert_eq!(
            text_of(find(&root, "work-title")[0]),
            "Prelude & Fugue in C\u{e9} <fast>"
        );
        assert_eq!(text_of(find(&root, "movement-title")[0]), "Piu mosso < forte");
        assert_eq!(
            find(&root, "score-part")[0].attrs,
            [("id".to_string(), "P\"1\" & only".to_string())]
        );
    }

    #[test]
    fn a_malformed_attribute_is_refused_instead_of_dropped() {
        let xml = "<score-partwise><part id=unquoted><measure/></part></score-partwise>";
        assert!(merge(xml.as_bytes()).unwrap_err().starts_with("bad XML attribute"));
    }

    #[test]
    fn a_file_that_is_not_musicxml_is_refused() {
        assert_eq!(merge(b"<html><body>nope</body></html>"), Err("not MusicXML".to_string()));
    }

    #[test]
    fn a_download_failure_reads_without_the_request_url() {
        let message = "error sending request for url \
            (https://kern.ccarh.org/cgi-bin/ksdata?l=d&file=f.krn&f=musicxml)";
        assert_eq!(reason(message.to_string()), "error sending request");
        assert_eq!(reason("timed out".to_string()), "timed out");
    }

    #[test]
    fn a_document_nested_past_the_cap_is_refused_instead_of_walked() {
        let deep = format!(
            "<score-partwise>{}{}</score-partwise>",
            "<a>".repeat(100),
            "</a>".repeat(100)
        );
        assert_eq!(merge(deep.as_bytes()), Err("XML nested too deep".to_string()));
    }

    #[test]
    fn durations_that_would_overflow_a_measure_saturate() {
        let xml = format!(
            "<measure><note><duration>{max}</duration></note>\
             <note><duration>{max}</duration></note></measure>",
            max = i64::MAX
        );
        let (_, measure) = parse(xml.as_bytes()).unwrap();
        assert_eq!(length(&measure), i64::MAX);
    }
}
