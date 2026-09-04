import { fakeRust, idleUpdate } from '@/rust.fake';
import { checkUpdate, takeUpdate, updateLabel, updateOf, versions, versionText } from '@/update';
import { expect, test } from 'vitest';

/** The release page holding one newer version, asked for and not yet fetched. */
const waiting = { ...idleUpdate(), checked: true, waiting: '0.1.1' };

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
  expect(
    updateLabel({ current, update: { kind: 'taking', version: '0.1.1', done: 0, total: null } }),
  ).toBe('Fetching 0.1.1…');
  expect(updateLabel({ current, update: { kind: 'ready', version: '0.1.1' } })).toBe(
    '0.1.1 is in place. Press again to start it now.',
  );
  expect(updateLabel({ current, update: { kind: 'failed', why: 'No release page' } })).toBe(
    'No release page',
  );
});

test('the cell reads the bytes while fetching, Restart once on disk and the reason on a failure', () => {
  const current = '0.1.0';
  expect(versionText({ current, update: updateOf(idleUpdate()) })).toBe('0.1.0');
  expect(versionText({ current, update: { kind: 'checking' } })).toBe('Checking');
  expect(versionText({ current, update: updateOf(waiting) })).toBe('0.1.0');
  expect(
    versionText({
      current,
      update: updateOf({ ...waiting, running: true, done: 12e6, total: 34e6 }),
    }),
  ).toBe('12 of 34 MB');
  expect(versionText({ current, update: updateOf({ ...waiting, installed: '0.1.1' }) })).toBe(
    'Restart',
  );
  expect(versionText({ current, update: updateOf({ ...waiting, error: 'no disk space' }) })).toBe(
    'no disk space',
  );
});

test('the check names the version waiting, and says nothing while this build is the newest', async () => {
  fakeRust({ app_version: () => '0.1.0', update_check: () => waiting });
  await checkUpdate();
  expect(versions()).toEqual({ current: '0.1.0', update: { kind: 'found', version: '0.1.1' } });

  fakeRust({ update_check: () => ({ ...idleUpdate(), checked: true }) });
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
  const rust = fakeRust({
    app_version: () => '0.1.0',
    update_check: () => waiting,
    update_install: () => ({ ...waiting, installed: '0.1.1' }),
  });
  await checkUpdate();
  expect(rust.argsOf('update_install')).toHaveLength(0);

  await takeUpdate();
  expect(rust.argsOf('update_install')).toHaveLength(1);
  expect(versions().update).toEqual({ kind: 'ready', version: '0.1.1' });

  // A later check finds the same version, and what is already on disk stays as it is.
  fakeRust({ update_check: () => ({ ...waiting, installed: '0.1.1' }) });
  await checkUpdate();
  expect(versions().update).toEqual({ kind: 'ready', version: '0.1.1' });
});

test('an install with nothing waiting fails rather than reporting a version in place', async () => {
  fakeRust({ app_version: () => '0.1.0', update_check: () => waiting });
  await checkUpdate();

  await takeUpdate();
  expect(versions().update).toEqual({ kind: 'failed', why: 'no newer version is waiting' });
});
