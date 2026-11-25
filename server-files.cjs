const fs = require('node:fs/promises');
const path = require('node:path');

const TEXT_EXTENSIONS = new Set(['.cfg', '.json', '.properties', '.toml', '.txt', '.yaml', '.yml']);
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function resolveInsideRoot(root, relativePath = '') {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) throw new Error('Invalid file path.');
  const portablePath = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(portablePath) || /^[a-z]:/i.test(portablePath)) throw new Error('File path must stay inside the server folder.');
  const segments = portablePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '..' || segment === '.')) throw new Error('File path must stay inside the server folder.');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('File path must stay inside the server folder.');
  }
  return target;
}

async function assertNoSymlinkComponents(root, target) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, target);
  const segments = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be browsed from Blockhost.');
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('A parent path is not a directory.');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function listDirectory(root, relativePath = '') {
  const target = resolveInsideRoot(root, relativePath);
  await assertNoSymlinkComponents(root, target);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result = await Promise.all(entries.map(async entry => {
    const entryPath = path.join(target, entry.name);
    const stat = await fs.lstat(entryPath);
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    return { name: entry.name, type, size: stat.isFile() ? stat.size : 0, modifiedAt: stat.mtime.toISOString() };
  }));
  result.sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1;
    if (right.type === 'directory' && left.type !== 'directory') return 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  return { path: relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), entries: result };
}

async function readTextFile(root, relativePath) {
  const target = resolveInsideRoot(root, relativePath);
  await assertNoSymlinkComponents(root, target);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Choose a file to edit.');
  if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('This file type cannot be edited in Blockhost.');
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error('Files larger than 1 MB cannot be edited in Blockhost.');
  return { path: relativePath.replace(/\\/g, '/'), content: await fs.readFile(target, 'utf8') };
}

async function writeTextFile(root, relativePath, content) {
  const target = resolveInsideRoot(root, relativePath);
  if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('This file type cannot be edited in Blockhost.');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new Error('Text files must be smaller than 1 MB.');
  }
  await assertNoSymlinkComponents(root, target);
  await fs.writeFile(target, content, 'utf8');
  return true;
}

async function createDirectory(root, relativePath) {
  const target = resolveInsideRoot(root, relativePath);
  await assertNoSymlinkComponents(root, target);
  await fs.mkdir(target, { recursive: true });
  return true;
}

async function deleteEntry(root, relativePath) {
  const target = resolveInsideRoot(root, relativePath);
  if (target === path.resolve(root)) throw new Error('The server root folder cannot be deleted here.');
  if (path.basename(target).toLowerCase() === 'server.jar') throw new Error('The installed server JAR is protected.');
  await assertNoSymlinkComponents(root, target);
  await fs.rm(target, { recursive: true, force: false });
  return true;
}

module.exports = { createDirectory, deleteEntry, listDirectory, readTextFile, resolveInsideRoot, writeTextFile };