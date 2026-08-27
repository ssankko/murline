import type { ReactNode } from 'react';

/**
 * Chrome that opens and closes along one axis: the grid track runs between zero and the content's
 * own size, so nothing has to measure the content. The clipped box carries no padding and no
 * border, because neither can shrink to nothing; give the children their own box for those.
 * Closed, the content takes no click, no focus and no place in the accessibility tree.
 */
export function Collapse({
  open,
  axis = 'y',
  children,
}: {
  open: boolean;
  /** `y` for a bar that grows downward, `x` for controls that fold sideways. */
  axis?: 'x' | 'y';
  children: ReactNode;
}) {
  const track =
    axis === 'y'
      ? open
        ? 'grid-rows-[1fr]'
        : 'grid-rows-[0fr]'
      : open
        ? 'grid-cols-[1fr]'
        : 'grid-cols-[0fr]';
  return (
    <div
      inert={!open}
      className={`grid flex-none transition-[grid-template-rows,grid-template-columns,opacity] duration-200 ease-[var(--ease)] motion-reduce:transition-none ${track} ${open ? 'opacity-100' : 'opacity-0'}`}
    >
      {/* Flex, so a block child fills the width and an inline one leaves no room for a baseline. */}
      <div className={`overflow-hidden ${axis === 'y' ? 'flex flex-col' : 'flex items-center'}`}>
        {children}
      </div>
    </div>
  );
}
