// The settings panel's Folders tab: the three places on disk the app reads, which are the library
// folder, the instruments folder, and the PDMX scores the score finder offers.

import { Button } from "@/components/ui/button";
import { progressLabel, usePdmx } from "@/library/pdmx";
import { Loading } from "@/look/loading";
import { Row, Rows } from "@/look/rows";
import { Path } from "@/settings/controls";
import { set, useSetting } from "@/settings/settings";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export function FoldersTab() {
  const library = useSetting("library_folder");
  const instruments = useSetting("instruments_folder");
  // The Rust side owns the download, so every mount of the tab reads the row off its job.
  const pdmx = usePdmx();
  const downloading = pdmx.status?.running ?? false;

  /** One line for the PDMX row: how far the download has got, or what is on disk. */
  const pdmxStatus = !pdmx.status
    ? ""
    : pdmx.status.running
      ? progressLabel(pdmx.status)
      : pdmx.status.ready
        ? "Ready"
        : "Not downloaded";

  /** The chooser for one folder setting, opening where that setting already points. */
  async function choose(key: "library_folder" | "instruments_folder", at: string): Promise<void> {
    const picked = await openDialog({
      directory: true,
      ...(at ? { defaultPath: at } : {}),
    });
    if (typeof picked === "string") void set(key, picked);
  }

  return (
    // The tab strip's own border stands right above this group, so the group leaves its top
    // hairline off.
    <Rows top={false}>
      <Row
        id="library_folder"
        hint="A new folder re-points the app. No file is moved."
      >
        <Path
          value={library}
          onChoose={() => choose("library_folder", library).catch(console.error)}
        />
      </Row>
      <Row
        id="instruments_folder"
        hint="Every .sf2 and .exs file in it is offered on the Sound tab."
      >
        <Path
          value={instruments}
          onChoose={() =>
            choose("instruments_folder", instruments).catch(console.error)
          }
        />
      </Row>
      <Row
        id="pdmx_scores"
        hint="The score finder needs them to offer PDMX rows."
      >
        <span className="flex flex-none flex-col items-end gap-0.5">
          <span className="flex items-center gap-3">
            <span className="text-muted-ink flex items-center gap-2 text-[12px] tabular-nums">
              {pdmxStatus}
              <Loading on={downloading} label="Downloading the PDMX scores" />
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-none"
              onClick={() => {
                if (downloading) pdmx.cancel();
                else pdmx.start();
              }}
            >
              {downloading ? "Cancel" : "Download (1.9 GB)"}
            </Button>
          </span>
          {pdmx.status?.error && (
            <span className="text-[11px] text-red-600 dark:text-red-400">
              {pdmx.status.error}
            </span>
          )}
        </span>
      </Row>
    </Rows>
  );
}
