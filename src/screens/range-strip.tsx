import { colorOf, isBlackKey } from '@/look/color';
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
  const whites = [];
  const blacks = [];
  let x = 0;
  for (let midi = LOWEST; midi <= HIGHEST; midi++) {
    const used = midi >= lo && midi <= hi;
    const black = isBlackKey(midi);
    const fill =
      used && midi % 12 === tonic
        ? colorOf(midi, 'muted', dark)
        : FILL[black ? (used ? 'blackUsed' : 'black') : used ? 'whiteUsed' : 'white'];
    if (black) {
      blacks.push(
        <rect key={midi} x={x - KEY * 0.3} y={0} width={KEY * 0.6} height={HEIGHT * 0.62} fill={fill} />,
      );
    } else {
      whites.push(<rect key={midi} x={x} y={0} width={KEY - 1} height={HEIGHT} fill={fill} />);
      x += KEY;
    }
  }
  return (
    <svg
      className="block w-full"
      height={HEIGHT}
      viewBox={`0 0 ${WHITE_KEYS * KEY} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {whites}
      {blacks}
    </svg>
  );
}
