#!/usr/bin/env python3
"""Build src-tauri/index/pdmx.tsv, the PDMX provider index.

Keeps every row with one or two piano tracks (General MIDI program 0) and an .mxl file. One line is
composer_name, artist_name, song_name, title, subtitle, bars, ratings and the .mxl path without its
leading "./mxl/", tab separated; tabs and line breaks inside a field become spaces. `artist_name`
and `song_name` are the site's clean fields, `composer_name` and `title` the uploader's free text,
so the finder groups by the artist, shows the song name first and the title in grey, and searches
all four.

The argument is `PDMX.csv` (Zenodo record 15571083, 225 MB, not committed).

Usage: python3 scripts/pdmx-index.py /path/to/PDMX.csv
"""
import csv
import os
import sys

csv.field_size_limit(10**9)
src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'index', 'pdmx.tsv')


def csv_rows(path):
    na = lambda v: '' if v == 'NA' else v
    for r in csv.DictReader(open(path, newline='', encoding='utf-8')):
        if r['n_tracks'] not in ('1', '2') or set(r['tracks'].split('-')) != {'0'}:
            continue
        if r['mxl'] == 'NA':
            continue
        yield [
            na(r['composer_name']),
            na(r['artist_name']),
            na(r['song_name']),
            na(r['title']),
            na(r['subtitle']),
            int(float(na(r['song_length.bars']) or 0)),
            int(float(na(r['n_ratings']) or 0)),
            r['mxl'][len('./mxl/'):],
        ]


clean = lambda v: str(v).replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
rows = csv_rows(src)
n = 0
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    for r in rows:
        f.write('\t'.join(clean(v) for v in r) + '\n')
        n += 1
print(f'{n} rows, {os.path.getsize(out)} bytes -> {out}')
