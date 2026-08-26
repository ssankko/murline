import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { expect, test } from 'vitest';

// Two measures of one voice. OSMD fetches a string that does not open with `<?xml` as a URL, so
// the declaration is load-bearing.
const TWO_MEASURES = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

test('OSMD loads MusicXML and reports its measures', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const osmd = new OpenSheetMusicDisplay(host, { autoResize: false, drawingParameters: 'compact' });

  await osmd.load(TWO_MEASURES);

  expect(osmd.Sheet.SourceMeasures.length).toBe(2);
  expect(osmd.Sheet.Instruments.length).toBe(1);
});
