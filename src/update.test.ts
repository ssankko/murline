import { fakeRust } from '@/rust.fake';
import { checkUpdate, takeUpdate, updateLabel, versions } from '@/update';
import { expect, test } from 'vitest';

test('the tooltip says what the last check made of the version running', () => {
  const current = '0.1.0';
  expect(updateLabel({ current, update: { kind: 'idle' } })).toBe(
    'Murline 0.1.0 is the newest there is. Click to look again.',
  );
  expect(updateLabel({ current, update: { kind: 'checking' } })).toBe(
    'Looking for a newer version…',
  );
  expect(updateLabel({ current, update: { kind: 'found', version: '0.1.1' } })).toBe(
    'Update available 0.1.0 → 0.1.1',
  );
  expect(updateLabel({ current, update: { kind: 'taking', version: '0.1.1' } })).toBe(
    'Fetching 0.1.1…',
  );
  expect(updateLabel({ current, update: { kind: 'ready', version: '0.1.1' } })).toBe(
    '0.1.1 is in place. Press again to start it now.',
  );
  expect(updateLabel({ current, update: { kind: 'failed', why: 'No release page' } })).toBe(
    'No release page',
  );
});

test('the check names the version waiting, and says nothing while this build is the newest', async () => {
  fakeRust({ app_version: () => '0.1.0', update_check: () => '0.1.1' });
  await checkUpdate();
  expect(versions()).toEqual({ current: '0.1.0', update: { kind: 'found', version: '0.1.1' } });

  fakeRust({ update_check: () => null });
  await checkUpdate();
  expect(versions()).toEqual({ current: '0.1.0', update: { kind: 'idle' } });
});

test('a check that cannot reach the release page says why', async () => {
  fakeRust({
    update_check: () => {
      throw 'The release page could not be reached';
    },
  });
  await checkUpdate();
  expect(versions().update).toEqual({
    kind: 'failed',
    why: 'The release page could not be reached',
  });
});

test('the version is fetched on the ask alone, and is not offered a second time', async () => {
  const rust = fakeRust({ app_version: () => '0.1.0', update_check: () => '0.1.1' });
  await checkUpdate();
  expect(rust.argsOf('update_install')).toHaveLength(0);

  await takeUpdate();
  expect(rust.argsOf('update_install')).toHaveLength(1);
  expect(versions().update).toEqual({ kind: 'ready', version: '0.1.1' });

  // The bar checks again on every screen; what is already on disk stays as it is.
  await checkUpdate();
  expect(versions().update).toEqual({ kind: 'ready', version: '0.1.1' });
});
