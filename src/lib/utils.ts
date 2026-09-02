import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A number held inside a span, both ends inside it. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A value pulled onto the nearest multiple of `grid` when it already lands within `band` of it. */
export function sticky(value: number, grid = 10, band = 2): number {
  const near = Math.round(value / grid) * grid;
  return Math.abs(value - near) <= band ? near : value;
}
