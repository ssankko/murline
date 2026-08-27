import { describe, expect, test } from 'vitest';
import { buildScore } from './build';
import { analyzeHarmony } from './harmony';
import { loadSheet } from './load';
import type { Score } from './types';

const FIXTURES = import.meta.glob('./fixtures/*', { query: '?url', import: 'default', eager: true });

async function score(fileName: string): Promise<Score> {
  const url = FIXTURES[`./fixtures/${fileName}`] as string;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const built = buildScore((await loadSheet(bytes, fileName)).Sheet);
  built.harmony = analyzeHarmony(built);
  return built;
}

// The prelude is one chord per bar with a textbook analysis, so its readout is the gate on the
// whole segmentation. Three bars depart from the textbook and stay so: bar 8 and bar 16 are major
// sevenths, which have no template, and bar 34's pedal C outweighs its G.
const BACH = [
  'C', 'Dm7/C', 'G7/B', 'C', 'Am/C', 'D7/C', 'G/B', 'C',
  'Am7', 'D7', 'G', 'G°7', 'Dm/F', 'F°7', 'C/E', 'F',
  'Dm7', 'G7', 'C', 'C7', 'F', 'F#°7', 'Ab°7', 'G7',
  'C/G', 'G7', 'Aø7/G', 'C/G', 'G7', 'C7', 'F/C', 'Dm7/C',
  'C',
];
const DEPARTURES = new Map([
  [8, 'C'],
  [16, 'F'],
  [34, 'Dm7/C'],
]);

/** The name in force in a bar: the last change at or before its bar line. */
function nameInBar(built: Score, bar: number): string | undefined {
  const start = built.measures.find((m) => m.number === bar)!.startTick;
  return built.harmony.findLast((e) => e.tick <= start)?.absolute;
}

describe('Bach BWV 846', () => {
  test('names one chord per bar as the textbook does, on the Onset that opens it', async () => {
    const built = await score('JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml');
    expect(built.harmony.map((e) => e.absolute)).toEqual(BACH);
    // 35 bars for 33 names: three bars carry the name of the change before them.
    for (const [bar, name] of DEPARTURES) expect(nameInBar(built, bar)).toBe(name);
    for (const event of built.harmony) expect(built.onsets[event.onsetIndex]!.tick).toBe(event.tick);
    // One change alone starts inside a bar: the D of the closing chord enters on bar 33's last beat.
    const offBar = built.harmony.filter(
      (e) => e.tick !== built.measures[e.measureIndex]!.startTick,
    );
    expect(offBar.map((e) => `${built.measures[e.measureIndex]!.number} ${e.absolute}`)).toEqual([
      '33 Dm7/C',
    ]);
    expect(built.harmony.slice(0, 4).map((e) => e.degree)).toEqual(['1', '2m⁷/1', '5⁷/7', '1']);
  });
});

describe('the sonatina and the rag', () => {
  // Both files split the hands into two `<score-part>`s and the Score keeps the first part, so the
  // analysis reads the right hand alone. It still names every segment.
  test.each([['MuzioClementi_SonatinaOpus36No1_Part1.xml'], ['ScottJoplin_The_Entertainer.xml']])(
    '%s names every chord',
    async (file) => {
      const built = await score(file);
      expect(built.harmony.length).toBeGreaterThan(0);
      expect(built.harmony.filter((e) => e.absolute.includes('?'))).toEqual([]);
      expect(built.harmony.filter((e) => e.degree.includes('?'))).toEqual([]);
    },
  );
});
