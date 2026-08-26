import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';

/** Master-detail frame. The list is empty until importing lands. */
export function Library({ folder }: { folder: string | null }) {
  return (
    <div className="flex h-full">
      <div className="border-edge-soft flex w-[340px] flex-none flex-col border-r">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
          <h1 className="mr-auto text-[15px] font-semibold">Library</h1>
          <Button variant="ghost" size="icon" aria-label="Settings">
            <Settings />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-muted-ink text-center text-[12px]">No pieces yet.</p>
        </div>
        <div className="border-edge-soft flex gap-2 border-t px-3 py-2.5">
          <Button variant="outline" size="sm" disabled>
            Import
          </Button>
          <Button variant="outline" size="sm" disabled>
            Find online
          </Button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-12">
        <div className="flex max-w-[420px] flex-col gap-2 text-center">
          <p className="text-[13px]">Drop a MusicXML file here to add a piece.</p>
          <p className="text-muted-ink text-[12px]">{folder ?? 'No library folder set'}</p>
        </div>
      </div>
    </div>
  );
}
