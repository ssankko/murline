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
python3 scripts/pdmx-index.py <file>   # PDMX.csv from Zenodo -> src-tauri/index/pdmx.tsv
```

## UI primitives

Every file under `src/components/ui/` is stock shadcn, written by the registry:

```sh
pnpm dlx shadcn@latest add <name> --overwrite   # button, dialog, dropdown-menu, input, popover, tooltip
```

Never edit them by hand; the next `add` throws the edit away. Unused exports and
variants that come with a component stay. The look comes from elsewhere: the
colour and radius tokens in `src/index.css`, and the `className` each caller passes.
