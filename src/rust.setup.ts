// Installs the in-memory Rust side before every test in both vitest projects. A test that needs
// other answers calls `fakeRust` itself and keeps the handle.

import { fakeRust } from '@/rust.fake';
import { beforeEach } from 'vitest';

beforeEach(() => {
  fakeRust();
});
