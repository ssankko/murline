// Reading a score file into OSMD, off screen. Nothing here draws: indexing only needs the model.

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { ScoreError } from './types';

// The letters MuseScore hides behind a SMuFL glyph name when it writes a dynamic as text.
const DYNAMIC_LETTERS: Record<string, string> = {
  dynamicPiano: 'p',
  dynamicMezzo: 'm',
  dynamicForte: 'f',
  dynamicSforzando: 'sf',
  dynamicRinforzando: 'rf',
  dynamicNiente: 'n',
  dynamicZ: 'z',
  dynamicS: 's',
  dynamicR: 'r',
};

/**
 * The one gate every score file passes: bytes in, or a `ScoreError` naming why not. The bytes go in
 * as a Blob whatever the extension, because OSMD fetches a plain string that does not open with
 * `<?xml` as a URL, and because a Blob is also how it recognises a zipped `.mxl`.
 *
 * `sheet.SheetErrors` is ignored: OSMD fills it with notes about the file that do not stop a Score.
 */
export async function loadInto(
  osmd: OpenSheetMusicDisplay,
  bytes: Uint8Array,
  fileName: string,
): Promise<void> {
  try {
    await osmd.load(new Blob([bytes as BlobPart]), fileName);
  } catch (error) {
    throw new ScoreError('Not a MusicXML file', String(error));
  }
  if (!osmd.Sheet) throw new ScoreError('Not a MusicXML file', 'the file holds no score');
  spellSymbols(osmd);
}

/** Loads the bytes of a score file into an OSMD instance that is never rendered. */
export async function loadSheet(
  bytes: Uint8Array,
  fileName: string,
): Promise<OpenSheetMusicDisplay> {
  const host = document.createElement('div');
  const osmd = new OpenSheetMusicDisplay(host, {
    autoResize: false,
    drawCredits: false,
    drawPartNames: false,
  });
  await loadInto(osmd, bytes, fileName);
  return osmd;
}

/**
 * Rewrites the `<sym>dynamicMezzo</sym>` markup MuseScore puts in a `<words>` direction, which OSMD
 * prints as it stands. Each glyph name becomes the letter it stands for, a name with no letter
 * loses only its tags.
 */
function spellSymbols(osmd: OpenSheetMusicDisplay): void {
  for (const measure of osmd.Sheet.SourceMeasures) {
    for (const staff of measure.StaffLinkedExpressions) {
      for (const expression of staff ?? []) {
        for (const entry of expression.EntriesList) {
          if (entry.label.includes('<sym>')) entry.label = spell(entry.label);
        }
      }
    }
  }
}

function spell(text: string): string {
  return text.replace(/<sym>(\w+)<\/sym>/g, (_, name: string) => DYNAMIC_LETTERS[name] ?? name);
}
