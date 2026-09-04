import { keyLayout } from '@/lane/keyboard';
import { colorOf } from '@/look/color';
import { pitchClass } from '@/score/pitch';
import { useDark } from '@/look/use-dark';
import { memo } from 'react';

const LOWEST = 21;
const HIGHEST = 108;
/** One white key wide. The strip stretches to its container, so the unit is arbitrary. */
const KEY = 10;
const WHITE_KEYS = 52;

/** Every strip draws the same 88 keys, so they are laid out once for the whole app. */
const KEYS = keyLayout(LOWEST, HIGHEST, WHITE_KEYS * KEY).keys;
const WHITE = KEYS.filter((key) => !key.black);
const BLACK = KEYS.filter((key) => key.black);

/** Ink strength of a key, by whether the piece uses it and whether it is black. */
const FILL = {
  white: 'color-mix(in srgb, var(--ink) 10%, transparent)',
  black: 'color-mix(in srgb, var(--ink) 22%, transparent)',
  whiteUsed: 'color-mix(in srgb, var(--ink) 80%, transparent)',
  blackUsed: 'var(--ink)',
};

/**
 * The piece's range over all 88 keys: the keys it uses in ink, the tonic's keys in the colour the
 * sheet paints that pitch in. Memoised because a library of a few hundred rows draws one each.
 */
export const RangeStrip = memo(function RangeStrip({
  lo,
  hi,
  tonic,
  height = 26,
}: {
  lo: number;
  hi: number;
  /** Pitch class of the key's tonic, or null when the piece has no key. */
  tonic: number | null;
  /** How tall the strip draws. The list pane's rows take a shorter one than the detail pane. */
  height?: number;
}) {
  const dark = useDark();
  const fillOf = ({ midi, black }: (typeof KEYS)[number]): string => {
    const used = midi >= lo && midi <= hi;
    if (used && pitchClass(midi) === tonic) return colorOf(midi, 'muted', dark);
    return FILL[black ? (used ? 'blackUsed' : 'black') : used ? 'whiteUsed' : 'white'];
  };
  return (
    <svg
      className="block w-full"
      height={height}
      viewBox={`0 0 ${WHITE_KEYS * KEY} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {WHITE.map((key) => (
        // A hairline of paper between two white keys is what tells them apart.
        <rect key={key.midi} x={key.x} y={0} width={key.w - 1} height={height} fill={fillOf(key)} />
      ))}
      {BLACK.map((key) => (
        <rect
          key={key.midi}
          x={key.x}
          y={0}
          width={key.w}
          height={height * 0.62}
          fill={fillOf(key)}
        />
      ))}
    </svg>
  );
});
