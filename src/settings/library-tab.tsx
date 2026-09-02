// The settings panel's Library tab: the folder the library lives in, and the PDMX scores the score
// finder offers.

import { Button } from "@/components/ui/button";
import { cancelPdmx, downloadPdmx, progressLabel, usePdmxDownload } from "@/library/pdmx";
import { Loading } from "@/look/loading";
import { Row, Rows } from "@/look/rows";
import { Path } from "@/settings/controls";
import { set, useSetting } from "@/settings/settings";
import { commands } from "@/bindings";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

export function LibraryTab() {
  const folder = useSetting("library_folder");
  const [pdmxReady, setPdmxReady] = useState<boolean | null>(null);
  const pdmx = usePdmxDownload();
  const downloading = pdmx.progress !== null;

  // Whether the tarball is unpacked. Rust answers off the disk and owns the folder it looks in, so
  // it is asked once the tab is on the page and again once a download has ended.
  useEffect(() => {
    let live = true;
    const hold = (ready: boolean) => {
      if (live) setPdmxReady(ready);
    };
    commands.pdmxStatus().then(hold, () => hold(false));
    return () => {
      live = false;
    };
  }, [downloading]);

  /** One line for the PDMX row: how far the download has got, or what is on disk. */
  const pdmxStatus = pdmx.progress
    ? progressLabel(pdmx.progress)
    : pdmxReady === null
      ? ""
      : pdmxReady
        ? "Ready"
        : "Not downloaded";

  async function chooseFolder(): Promise<void> {
    const picked = await openDialog({
      directory: true,
      ...(folder ? { defaultPath: folder } : {}),
    });
    if (typeof picked === "string") void set("library_folder", picked);
  }

  return (
    <>
      <p className="text-muted-ink text-[11.5px]">
        A new library folder re-points the app. No file is moved.
      </p>
      <Rows>
        <Row id="library_folder">
          <Path
            value={folder}
            onChoose={() =>
              chooseFolder().catch(console.error)
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
                <Loading
                  on={downloading}
                  label="Downloading the PDMX scores"
                />
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 flex-none"
                onClick={() => {
                  if (downloading) cancelPdmx();
                  else void downloadPdmx();
                }}
              >
                {downloading ? "Cancel" : "Download (1.9 GB)"}
              </Button>
            </span>
            {pdmx.error && (
              <span className="text-[11px] text-red-600 dark:text-red-400">
                {pdmx.error}
              </span>
            )}
          </span>
        </Row>
      </Rows>
    </>
  );
}
