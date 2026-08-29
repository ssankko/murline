import { keyLayout } from '@/lane/keyboard';
import { colorOf } from '@/look/color';
import { pitchClass } from '@/score/pitch';
import { useDark } from '@/look/use-dark';

const LOWEST = 21;
const HIGHEST = 108;
/** One white key wide. The strip stretches to its container, so the unit is arbitrary. */
const KEY = 10;
const WHITE_KEYS = 52;
const HEIGHT = 26;

/** Ink strength of a key, by whether the piece uses it and whether it is black. */
const FILL = {
  white: 'color-mix(in srgb, var(--ink) 10%, transparent)',
  black: 'color-mix(in srgb, var(--ink) 22%, transparent)',
  whiteUsed: 'color-mix(in srgb, var(--ink) 80%, transparent)',
  blackUsed: 'var(--ink)',
};

/**
 * The piece's range over all 88 keys: the keys it uses in ink, the tonic's keys in the colour the
 * sheet paints that pitch in.
 */
export function RangeStrip({
  lo,
  hi,
  tonic,
}: {
  lo: number;
  hi: number;
  /** Pitch class of the key's tonic, or null when the piece has no key. */
  tonic: number | null;
}) {
  const dark = useDark();
  const keys = keyLayout(LOWEST, HIGHEST, WHITE_KEYS * KEY).keys;
  const fillOf = ({ midi, black }: (typeof keys)[number]): string => {
    const used = midi >= lo && midi <= hi;
    if (used && pitchClass(midi) === tonic) return colorOf(midi, 'muted', dark);
    return FILL[black ? (used ? 'blackUsed' : 'black') : used ? 'whiteUsed' : 'white'];
  };
  return (
    <svg
      className="block w-full"
      height={HEIGHT}
      viewBox={`0 0 ${WHITE_KEYS * KEY} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {keys
        .filter((key) => !key.black)
        .map((key) => (
          // A hairline of paper between two white keys is what tells them apart.
          <rect key={key.midi} x={key.x} y={0} width={key.w - 1} height={HEIGHT} fill={fillOf(key)} />
        ))}
      {keys
        .filter((key) => key.black)
        .map((key) => (
          <rect
            key={key.midi}
            x={key.x}
            y={0}
            width={key.w}
            height={HEIGHT * 0.62}
            fill={fillOf(key)}
          />
        ))}
    </svg>
  );
}
