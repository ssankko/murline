// Reading a score file into OSMD, off screen. Nothing here draws: indexing only needs the model.

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { ScoreError } from './types';

/**
 * Loads the bytes of a score file into an OSMD instance that is never rendered. The bytes go in as
 * a Blob whatever the extension, because OSMD fetches a plain string that does not open with
 * `<?xml` as a URL, and because a Blob is also how it recognises a zipped `.mxl`.
 *
 * `sheet.SheetErrors` is ignored: OSMD fills it with notes about the file that do not stop a Score.
 */
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
  try {
    await osmd.load(new Blob([bytes as BlobPart]), fileName);
  } catch (error) {
    throw new ScoreError('Not a MusicXML file', String(error));
  }
  if (!osmd.Sheet) throw new ScoreError('Not a MusicXML file', 'the file holds no score');
  return osmd;
}
