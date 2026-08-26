// Builds the KernScores provider index: one JSON row per .krn file in the piano directories below.
// Usage: node scripts/kernscores-index.mjs   (raw listings are cached in scripts/cache/, delete to refetch)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
const OUT = join(HERE, '..', 'src-tauri', 'index', 'kernscores.json');
const BASE = 'https://kern.ccarh.org/cgi-bin/ksdata';

const DIRS = [
  'users/craig/classical/beethoven/piano/sonata',
  'users/craig/classical/beethoven/piano/variations',
  'users/craig/classical/beethoven/piano/misc',
  'users/craig/classical/mozart/piano/sonata',
  'users/craig/classical/mozart/piano/sonatina',
  'users/craig/classical/mozart/piano/variations/k265',
  'users/craig/classical/haydn/keyboard/uesonatas',
  'users/craig/classical/scarlatti/longo',
  'users/craig/classical/clementi/op36',
  'users/craig/classical/chopin/mazurka',
  'users/craig/classical/chopin/prelude',
  'users/craig/classical/chopin/etude',
  'users/craig/classical/chopin/waltz',
  'users/craig/classical/chopin/nocturne',
  'users/craig/classical/chopin/ballade',
  'users/craig/classical/chopin/scherzo',
  'users/duguay/chopin/waltz',
  'users/duguay/chopin/scherzo',
  'users/duguay/chopin/etude',
  'users/craig/ragtime/joplin',
  'osu/classical/bach/inventions',
  'musedata/bach/keyboard/wtc',
  'users/craig/classical/bach/wtc2preludes',
  'users/craig/classical/bach/keyboard',
  'users/craig/classical/schubert/piano/d0576',
  'users/craig/classical/schubert/piano/op90',
  'users/craig/classical/schumann/op68',
  'users/craig/classical/mendelssohn',
  'users/craig/classical/grieg/op43',
  'users/craig/classical/grieg/op46',
  'users/craig/classical/grieg/op01',
  'users/craig/classical/grieg/op03',
  'users/craig/classical/grieg/op06',
  'users/craig/classical/grieg/op07',
  'users/craig/classical/grieg/op12',
  'users/craig/classical/grieg/op17',
  'users/craig/classical/grieg/op66',
  'users/craig/classical/liszt',
  'users/craig/classical/brahms/op39',
  'users/craig/classical/brahms/op01',
  'users/craig/classical/brahms/op04',
  'users/craig/classical/brahms/op10',
  'users/craig/classical/hummel/op67',
];

async function listing(dir) {
  const file = join(CACHE, dir.replaceAll('/', '_') + '.txt');
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const r = await fetch(`${BASE}?l=${dir}&format=info`);
  if (!r.ok) throw new Error(`${dir}: HTTP ${r.status}`);
  const text = await r.text();
  writeFileSync(file, text);
  return text;
}

const ENTITIES = { uuml: 'ü', Uuml: 'Ü', ouml: 'ö', auml: 'ä', Egrave: 'È', eacute: 'é', egrave: 'è', szlig: 'ß', amp: '&' };
const clean = (v) => v.replace(/<[^>]+>/g, '').replace(/&([a-zA-Z]+);/g, (m, e) => ENTITIES[e] ?? m).trim();

/** Reference records of one segment: `!!!KEY: value`; an English `@ENG` value beats the original-language one, otherwise first wins. */
function refs(lines) {
  const out = {};
  for (const l of lines) {
    const m = l.match(/^!!!([A-Z]+)[0-9]?(@@?[A-Z]+)?:\s*(.*)$/);
    if (!m || !m[3]) continue;
    const [, key, lang] = m;
    if (!(key in out) || lang === '@ENG') out[key] = clean(m[3]);
  }
  return out;
}

const KEY_NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLAT_NAMES = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
/** "F minor" from the `*f:` token, else the title's "in F minor", else the `*k[...]` signature read as major. */
function keyOf(lines, title) {
  for (const l of lines) {
    const m = l.match(/^\*([A-Ga-g])([#-]?):/);
    if (m) {
      const tonic = m[1].toUpperCase() + (m[2] === '-' ? 'b' : m[2]);
      return `${tonic} ${m[1] === m[1].toLowerCase() ? 'minor' : 'major'}`;
    }
  }
  const t = title.match(/\bin ([A-G])(?:-?(sharp|flat|#|b))? ?-?(major|minor)/i);
  if (t) return `${t[1].toUpperCase()}${t[2] ? (/sharp|#/i.test(t[2]) ? '#' : 'b') : ''} ${t[3].toLowerCase()}`;
  for (const l of lines) {
    const m = l.match(/^\*k\[([a-g#-]*)\]/);
    if (m) {
      const n = (m[1].match(/[a-g]/g) ?? []).length;
      return m[1].includes('-') ? `${FLAT_NAMES[n]} major` : `${KEY_NAMES[n]} major`;
    }
  }
  return null;
}

function timeOf(lines) {
  for (const l of lines) {
    const m = l.match(/^\*M(\d+\/\d+)/);
    if (m) return m[1];
  }
  return null;
}

function barsOf(lines) {
  let max = 0;
  for (const l of lines) {
    const m = l.match(/^=(\d+)/);
    if (m) max = Math.max(max, +m[1]);
  }
  return max || null;
}

/** Per-collection title fixes; everything else is `OTL` as written, then the parent work, then the file name. */
function titleOf(dir, r, file) {
  if (dir === 'musedata/bach/keyboard/wtc') return `${r.OPR ?? 'Well-Tempered Clavier'} ${r.OVM ?? ''}, ${r.OTL} ${r.ONM ?? ''}${r.OKY ? ` in ${r.OKY}` : ''}`.replace(/\s+/g, ' ');
  if (dir === 'users/craig/classical/bach/wtc2preludes') return `Well-Tempered Clavier Book II, ${FILE_TITLE[file]?.[0] ?? r.OTL}`;
  if (dir === 'users/craig/classical/clementi/op36') return r.OTL.replace(/^Sonata/, 'Sonatina').replace(/, Mvmt\. \d+$/, '');
  if (r.OTL) return r.OTL;
  if (r.OPR) return r.OPR;
  return FILE_TITLE[file]?.[0] ?? file.replace(/\.krn$/, '');
}

/** Composers of directories whose files name none. */
const DIR_COMPOSER = { bach: 'Bach, Johann Sebastian', chopin: 'Chopin, Frederic' };

/** Composer of a file: `COM`, else `COM1` or `COA`, else the composer the other files in the directory name, else the directory's. */
function composerOf(r, dir, dirComposer) {
  return r.COM ?? r.COA ?? dirComposer ?? DIR_COMPOSER[dir.split('/').find((seg) => seg in DIR_COMPOSER)] ?? null;
}

/** Files with no reference records at all, or a wrong one. */
const FILE_TITLE = {
  'scherzo-op20.krn': ['Scherzo No. 1 in B minor', '20'],
  'scherzo-op31.krn': ['Scherzo No. 2 in B-flat minor', '31'],
  'scherzo-op39.krn': ['Scherzo No. 3 in C-sharp minor', '39'],
  'wtc2p21.krn': ['Prelude No. 21 in B-flat major', null],
};

/** One spelling per composer, keyed by surname; the collections disagree on accents and order. */
const CANON = { Chopin: 'Chopin, Frédéric', 'Müler': 'Müller, August Eberhard', Mozart: 'Mozart, Wolfgang Amadeus', Bach: 'Bach, Johann Sebastian' };

/** A movement heading: the `\n` the files write for a line break becomes a comma, tempo marks in brackets go. */
const movementName = (s) => s.replace(/\\n/g, ', ').replace(/\s*[\[(].*$/, '').replace(/\.$/, '').trim() || null;

/** Files that duplicate another row: chord-annotation twins and lettered variants of the same etude. */
const DUPLICATE = /-chord\.krn$|^etude10-02b\.krn$/;

const rows = [];
const problems = [];
for (const dir of DIRS) {
  let text;
  try {
    text = await listing(dir);
  } catch (e) {
    problems.push(String(e));
    continue;
  }
  const segments = text.split(/^!!!!SEGMENT:\s*/m).slice(1).map((seg) => {
    const lines = seg.split('\n');
    return { file: lines[0].trim(), lines, r: refs(lines) };
  });
  const dirComposer = segments.map((s) => s.r.COM).find(Boolean);
  for (const { file, lines, r } of segments) {
    if (DUPLICATE.test(file)) continue;
    let composer = composerOf(r, dir, dirComposer);
    const surname = composer ? (composer.includes(',') ? composer.split(',')[0] : composer.split(' ')[0]).trim() : null;
    composer = CANON[surname] ?? composer;
    const title = titleOf(dir, r, file);
    const wtc = dir.includes('/wtc');
    const opus = r.OPS ?? r.SCT ?? FILE_TITLE[file]?.[1] ?? null;
    rows.push({
      dir,
      file,
      composer,
      surname,
      title,
      opus: opus ? opus.replace(/^(Op\.|op\.)\s*/, '').replace(/^K1 /, 'K. ') : null,
      number: r.ONM ? r.ONM.replace(/^no\.\s*/i, '') : null,
      movement: r.OMV && !wtc ? +r.OMV.replace(/\D/g, '') || null : null,
      movementName: r.OMD ? movementName(r.OMD) : null,
      key: keyOf(lines, title),
      time: timeOf(lines),
      bars: barsOf(lines),
    });
    if (!r.COM || !r.OTL) problems.push(`${dir}/${file}: COM=${r.COM ?? '-'} OTL=${r.OTL ?? '-'} -> ${composer} | ${title}`);
  }
  console.log(dir, segments.length);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} rows -> ${OUT}`);
if (problems.length) console.log(`\n${problems.length} rows missing COM or OTL:\n` + problems.slice(0, 40).join('\n'));
