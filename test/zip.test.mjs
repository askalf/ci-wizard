// zipEntries reads a zip's central directory for the names and sizes it holds, and reads nothing
// it cannot establish: a truncated file, a zip64 directory, or bytes that are not a zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipEntries } from '../src/zip.mjs';
import { storedZip } from './zip-helper.mjs';

test('zipEntries: the entries by name and size, in the directory\'s order, a directory entry with its slash, a comment skipped', () => {
  const one = storedZip([{ name: 'results.sarif', data: 'x'.repeat(71521) }]);
  assert.deepEqual(zipEntries(one), [{ name: 'results.sarif', size: 71521 }]);
  const many = storedZip([{ name: 'reports/' }, { name: 'reports/a.sarif', data: 'aa' }, { name: 'reports/b.sarif', data: 'bbb' }], { comment: 'built by hand' });
  assert.deepEqual(zipEntries(many), [{ name: 'reports/', size: 0 }, { name: 'reports/a.sarif', size: 2 }, { name: 'reports/b.sarif', size: 3 }]);
  assert.deepEqual(zipEntries(storedZip([])), []);
});

test('zipEntries: not a zip, truncated, or zip64 is null, never a guess', () => {
  assert.equal(zipEntries(Buffer.from('not a zip at all, just text')), null);
  assert.equal(zipEntries(Buffer.alloc(0)), null);
  const zip = storedZip([{ name: 'results.sarif', data: 'data' }]);
  assert.equal(zipEntries(zip.subarray(0, zip.length - 5)), null, 'no end record');
  // A directory that the end record places past the end record itself cannot be read.
  const bad = Buffer.from(zip);
  bad.writeUInt32LE(zip.length, zip.length - 22 + 16);
  assert.equal(zipEntries(bad), null);
  const zip64 = Buffer.from(zip);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  assert.equal(zipEntries(zip64), null);
  assert.equal(zipEntries('a string'), null);
});
