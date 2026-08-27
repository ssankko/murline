# Piano

Practise piano from sheet music with a MIDI keyboard.

```sh
pnpm dev                                  # run the app
pnpm build                                # typecheck and build the frontend
pnpm test                                 # Vitest, node and browser projects
cd src-tauri && cargo test                # Rust tests
```

The two provider indexes are built by hand and committed:

```sh
node scripts/kernscores-index.mjs      # listings from scripts/cache/, else the live site -> src-tauri/index/kernscores.json
python3 scripts/pdmx-index.py <file>   # PDMX.csv from Zenodo, or a .json of kept rows -> src-tauri/index/pdmx.tsv
```
