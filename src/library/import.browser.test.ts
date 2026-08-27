import { beforeEach, describe, expect, test, vi } from 'vitest';
import { importFiles, isScoreFile } from './import';

// Vite serves the fixture files as URLs, which is the closest a browser test gets to the bytes the
// app reads from disk.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** What the fake library folder holds. The test sets it before each case. */
let folderFiles: string[] = [];
const copies: { src: string; dst: string }[] = [];
const indexed: { path: string; title: string }[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, string>) => {
    if (command === 'read_file') {
      const name = args.path!.split('/').pop()!;
      if (name === 'locked.musicxml') throw new Error(`Permission denied (os error 13)`);
      const url = FIXTURES[`../score/fixtures/${name}`];
      if (!url) throw new Error(`No such file or directory (os error 2): ${args.path}`);
      return (await fetch(url as string)).arrayBuffer();
    }
    if (command === 'list_library') {
      return folderFiles.map((rel_path) => ({ rel_path, mtime: 1, size: 1 }));
    }
    if (command === 'copy_file') {
      copies.push({ src: args.src!, dst: args.dst! });
      return { mtime: 2, size: 2 };
    }
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('./queries', () => ({
  upsertIndex: async (path: string, index: { title: string }) => {
    indexed.push({ path, title: index.title });
  },
}));

const keepBoth = async () => 'keep-both' as const;

async function importOne(fileName: string) {
  return importFiles('/library', [`/away/${fileName}`], keepBoth);
}

beforeEach(() => {
  folderFiles = [];
  copies.length = 0;
  indexed.length = 0;
});

describe('a file the app cannot turn into a Score', () => {
  const cases: [string, string][] = [
    ['not-a-score.txt', 'Not a MusicXML file'],
    ['empty.musicxml', 'Not a MusicXML file'],
    ['timewise.musicxml', 'Not a MusicXML file'],
    ['rests-only.musicxml', 'No notes in the first part'],
    ['gone.musicxml', 'File not found'],
    ['locked.musicxml', 'Could not read the file'],
  ];

  test.each(cases)('%s fails with "%s" and is never copied', async (fileName, reason) => {
    const result = await importOne(fileName);
    expect(result.failures).toEqual([{ fileName, reason }]);
    expect(result.imported).toEqual([]);
    expect(copies).toEqual([]);
    expect(indexed).toEqual([]);
  });
});

describe('a file the app can read', () => {
  test('is copied into the folder and indexed, once the checks have passed', async () => {
    const result = await importOne('MuzioClementi_SonatinaOpus36No1_Part1.xml');
    expect(result.failures).toEqual([]);
    expect(result.imported).toEqual(['MuzioClementi_SonatinaOpus36No1_Part1.xml']);
    expect(copies).toEqual([
      {
        src: '/away/MuzioClementi_SonatinaOpus36No1_Part1.xml',
        dst: '/library/MuzioClementi_SonatinaOpus36No1_Part1.xml',
      },
    ]);
    expect(indexed).toEqual([
      { path: 'MuzioClementi_SonatinaOpus36No1_Part1.xml', title: 'Sonatina Op.36 No 1 Teil 1 Allegro' },
    ]);
  });

  test('Keep both writes the next free copy of the name', async () => {
    folderFiles = ['dynamics-and-tempo.musicxml', 'dynamics-and-tempo (2).musicxml'];
    const result = await importOne('dynamics-and-tempo.musicxml');
    expect(result.imported).toEqual(['dynamics-and-tempo (3).musicxml']);
    expect(copies[0]!.dst).toBe('/library/dynamics-and-tempo (3).musicxml');
  });

  test('a name that differs only in case is the same file to the folder', async () => {
    folderFiles = ['Dynamics-And-Tempo.MUSICXML'];
    const result = await importOne('dynamics-and-tempo.musicxml');
    expect(result.imported).toEqual(['dynamics-and-tempo (2).musicxml']);
  });

  test('Replace keeps the path, so the row and its history survive', async () => {
    folderFiles = ['dynamics-and-tempo.musicxml'];
    const result = await importFiles(
      '/library',
      ['/away/dynamics-and-tempo.musicxml'],
      async () => 'replace',
    );
    expect(result.imported).toEqual(['dynamics-and-tempo.musicxml']);
    expect(copies[0]!.dst).toBe('/library/dynamics-and-tempo.musicxml');
  });

  test('Replace over a name that differs only in case keeps the folder\'s own name', async () => {
    folderFiles = ['Dynamics-And-Tempo.MUSICXML'];
    const result = await importFiles(
      '/library',
      ['/away/dynamics-and-tempo.musicxml'],
      async () => 'replace',
    );
    expect(result.imported).toEqual(['Dynamics-And-Tempo.MUSICXML']);
    expect(copies[0]!.dst).toBe('/library/Dynamics-And-Tempo.MUSICXML');
    expect(indexed.map((row) => row.path)).toEqual(['Dynamics-And-Tempo.MUSICXML']);
  });

  test('Cancel at a clash writes nothing and reports no failure', async () => {
    folderFiles = ['dynamics-and-tempo.musicxml'];
    const result = await importFiles(
      '/library',
      ['/away/dynamics-and-tempo.musicxml'],
      async () => 'cancel',
    );
    expect(result).toEqual({ imported: [], failures: [] });
    expect(copies).toEqual([]);
  });
});

test('only the three score extensions are read at all', () => {
  expect(['a.musicxml', 'a.xml', 'a.MXL'].map(isScoreFile)).toEqual([true, true, true]);
  expect(['a.pdf', 'a.mid', 'a'].map(isScoreFile)).toEqual([false, false, false]);
});
