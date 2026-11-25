const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDirectory, deleteEntry, listDirectory, readTextFile, resolveInsideRoot, writeTextFile } = require('./server-files.cjs');

test('rejects absolute paths and traversal outside the server root', () => {
  const root = path.join(os.tmpdir(), 'blockhost-server');
  assert.throws(() => resolveInsideRoot(root, '../outside.txt'), /stay inside/);
  assert.throws(() => resolveInsideRoot(root, '/tmp/outside.txt'), /stay inside/);
  assert.throws(() => resolveInsideRoot(root, 'C:\\outside.txt'), /stay inside/);
});

test('lists and edits supported text files inside the server root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createDirectory(root, 'mods');
  await writeTextFile(root, 'server.properties', 'motd=Local world\n');

  const listing = await listDirectory(root);
  assert.deepEqual(listing.entries.map(entry => entry.name), ['mods', 'server.properties']);
  assert.equal((await readTextFile(root, 'server.properties')).content, 'motd=Local world\n');
  await writeTextFile(root, 'server.properties', 'motd=Updated\n');
  assert.equal((await readTextFile(root, 'server.properties')).content, 'motd=Updated\n');
  await assert.rejects(readTextFile(root, 'mods'), /Choose a file/);
  await deleteEntry(root, 'mods');
  assert.equal((await listDirectory(root)).entries.some(entry => entry.name === 'mods'), false);
});

test('refuses to follow symbolic links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-links-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'not for this server');
  await fs.symlink(outside, path.join(root, 'linked'), 'dir');
  await assert.rejects(listDirectory(root, 'linked'), /Symbolic links/);
});