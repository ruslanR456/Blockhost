const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { constants, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const serverFiles = require('./server-files.cjs');
const https = require('node:https');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ALLOWED_DOWNLOAD_HOSTS = new Set(['launcher.mojang.com', 'piston-data.mojang.com']);
const runningServers = new Map();
const onlinePlayers = new Map();
const outputBuffers = new Map();
let mainWindow;
let manifestCache;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function getDataRoot() {
  return path.join(app.getPath('userData'), 'blockhost');
}

function getServersRoot() {
  return path.join(getDataRoot(), 'servers');
}

function getProfilesPath() {
  return path.join(getDataRoot(), 'profiles.json');
}

function safeProfileId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid server profile.');
  return id;
}

function getServerDirectory(id) {
  const resolvedRoot = path.resolve(getServersRoot());
  const resolvedDirectory = path.resolve(resolvedRoot, safeProfileId(id));
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Invalid server directory.');
  return resolvedDirectory;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!hostname) return '';
  if (hostname.length > 253 || !hostname.split('.').every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) throw new Error('Enter a valid hostname, such as myserver.example.local.');
  return hostname;
}

function normalizeProfile(input) {
  const name = String(input?.name || '').trim();
  const version = String(input?.version || '').trim();
  const software = String(input?.software || 'Vanilla').trim();
  const ram = Number(input?.ram);
  const port = Number(input?.port);
  const hostname = normalizeHostname(input?.hostname);

  if (!name || name.length > 36) throw new Error('Server name must be between 1 and 36 characters.');
  if (!version || version.length > 80) throw new Error('Choose a valid Minecraft version.');
  if (software !== 'Vanilla') throw new Error('Only Vanilla Java servers can be installed in this build.');
  if (!Number.isInteger(ram) || ram < 1 || ram > 64) throw new Error('Memory must be between 1 and 64 GB.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');

  return { name, version, software, ram, port, hostname };
}

async function readProfiles() {
  try {
    const data = await fs.readFile(getProfilesPath(), 'utf8');
    const profiles = JSON.parse(data);
    if (!Array.isArray(profiles)) throw new Error('Profiles file is invalid.');
    return profiles;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeProfiles(profiles) {
  await fs.mkdir(getDataRoot(), { recursive: true });
  const filePath = getProfilesPath();
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(profiles, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function findProfile(id) {
  const profileId = safeProfileId(id);
  const profiles = await readProfiles();
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error('Server profile not found.');
  return { profiles, profile };
}

async function getVisibleProfiles() {
  const profiles = await readProfiles();
  return Promise.all(profiles.map(async profile => {
    let installed = false;
    try {
      await fs.access(path.join(getServerDirectory(profile.id), 'server.jar'));
      installed = true;
    } catch { /* The profile can exist before its server files are installed. */ }
    return {
      ...profile,
      installed,
      running: runningServers.has(profile.id),
      joinAddress: `${profile.hostname || 'localhost'}:${profile.port}`
    };
  }));
}

async function fetchJson(url, redirects = 0) {
  if (redirects > 5) throw new Error('Too many redirects while downloading official Minecraft metadata.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS downloads are allowed.');
  const body = await new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: { 'User-Agent': 'Blockhost/0.1', Accept: 'application/json' },
      timeout: 30000
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchJson(new URL(response.headers.location, parsed).href, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download request failed (${response.statusCode}).`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.once('error', reject);
    });
    request.once('timeout', () => request.destroy(new Error('Mojang metadata request timed out.')));
    request.once('error', reject);
  });
  return typeof body === 'string' ? JSON.parse(body) : body;
}

async function getVersionManifest() {
  if (!manifestCache || Date.now() - manifestCache.fetchedAt > 10 * 60 * 1000) {
    manifestCache = { data: await fetchJson(MANIFEST_URL), fetchedAt: Date.now() };
  }
  return manifestCache.data;
}

async function getVersionCatalog() {
  const manifest = await getVersionManifest();
  return {
    latestRelease: manifest.latest.release,
    latestSnapshot: manifest.latest.snapshot,
    versions: manifest.versions.map(version => ({
      id: version.id,
      type: version.type,
      releaseTime: version.releaseTime
    }))
  };
}

async function getVersionMetadata(versionId) {
  const manifest = await getVersionManifest();
  const version = manifest.versions.find(candidate => candidate.id === versionId);
  if (!version) throw new Error('That Minecraft version is not in the official version manifest.');
  const metadataUrl = new URL(version.url);
  if (metadataUrl.protocol !== 'https:' || !metadataUrl.hostname.endsWith('.mojang.com')) {
    throw new Error('The official version metadata URL was not valid.');
  }
  const metadata = await fetchJson(metadataUrl.href);
  const serverDownload = metadata.downloads?.server;
  if (!serverDownload?.url || !serverDownload?.sha1) {
    throw new Error(`Minecraft ${versionId} does not provide an official server JAR.`);
  }
  const downloadUrl = new URL(serverDownload.url);
  if (downloadUrl.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(downloadUrl.hostname)) {
    throw new Error('The official server download URL was not valid.');
  }
  return {
    download: serverDownload,
    javaMajor: Number(metadata.javaVersion?.majorVersion) || 8
  };
}

function getJavaInfo() {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-version'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let versionOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { versionOutput += chunk; });
    child.once('error', error => {
      if (error.code === 'ENOENT') reject(new Error('Java was not found. Install a Java runtime and reopen Blockhost.'));
      else reject(error);
    });
    child.once('close', code => {
      if (code !== 0) return reject(new Error('Java could not be started.'));
      const versionMatch = versionOutput.match(/version "(?:1\.)?(\d+)/i);
      resolve({ version: versionMatch ? versionMatch[1] : 'unknown', raw: versionOutput.trim() });
    });
  });
}

async function installServer(id) {
  const { profile } = await findProfile(id);
  if (profile.software !== 'Vanilla') throw new Error('Only Vanilla Java servers can be installed in this build.');
  const versionInfo = await getVersionMetadata(profile.version);
  const serverDirectory = getServerDirectory(profile.id);
  await fs.mkdir(serverDirectory, { recursive: true });
  const jarPath = path.join(serverDirectory, 'server.jar');
  const partialPath = path.join(serverDirectory, 'server.jar.part');
  const download = await downloadHttpsStream(versionInfo.download.url);
  const expectedSize = download.contentLength;
  const hash = createHash('sha1');
  let downloadedBytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      hash.update(chunk);
      sendToRenderer('blockhost:install-progress', {
        profileId: profile.id,
        downloadedBytes,
        totalBytes: expectedSize,
        percent: expectedSize ? Math.min(100, Math.round(downloadedBytes / expectedSize * 100)) : null
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(download.stream, meter, createWriteStream(partialPath));
    const actualHash = hash.digest('hex');
    if (actualHash.toLowerCase() !== versionInfo.download.sha1.toLowerCase()) {
      throw new Error('Downloaded server JAR failed its SHA-1 verification.');
    }
    await fs.rename(partialPath, jarPath);
    const profiles = await readProfiles();
    const index = profiles.findIndex(candidate => candidate.id === profile.id);
    profiles[index] = { ...profiles[index], requiredJavaMajor: versionInfo.javaMajor, installedAt: new Date().toISOString() };
    await writeProfiles(profiles);
    sendToRenderer('blockhost:install-progress', { profileId: profile.id, complete: true, percent: 100 });
    return getVisibleProfiles();
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

function appendOutput(profileId, chunk) {
  const text = chunk.toString('utf8');
  const logPath = path.join(getServerDirectory(profileId), 'blockhost-console.log');
  fs.appendFile(logPath, text).catch(() => {});
  sendToRenderer('blockhost:server-output', { profileId, text });
  const lines = `${outputBuffers.get(profileId) || ''}${text}`.split(/\r?\n/);
  outputBuffers.set(profileId, lines.pop() || '');
  for (const line of lines) {
    const match = line.match(/There are \d+ of a max of \d+ players online(?::\s*(.*))?/i);
    if (!match) continue;
    const players = match[1] ? match[1].split(',').map(name => name.trim()).filter(Boolean) : [];
    onlinePlayers.set(profileId, players);
    sendToRenderer('blockhost:player-list', { profileId, players });
  }
}

async function readPlayerJson(serverDirectory, filename) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(serverDirectory, filename), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`${filename} could not be read: ${error.message}`);
  }
}

async function getPlayerData(id) {
  const { profile } = await findProfile(id);
  const serverDirectory = getServerDirectory(profile.id);
  const [whitelist, operators, banned] = await Promise.all([
    readPlayerJson(serverDirectory, 'whitelist.json'),
    readPlayerJson(serverDirectory, 'ops.json'),
    readPlayerJson(serverDirectory, 'banned-players.json')
  ]);
  const child = runningServers.get(profile.id);
  if (child) child.stdin.write('list\n');
  return {
    running: Boolean(child),
    online: onlinePlayers.get(profile.id) || [],
    whitelist: whitelist.map(player => player.name).filter(Boolean),
    operators: operators.map(player => player.name).filter(Boolean),
    banned: banned.map(player => player.name).filter(Boolean)
  };
}

async function runPlayerAction(id, action, playerName) {
  const profileId = safeProfileId(id);
  const child = runningServers.get(profileId);
  if (!child) throw new Error('Start the server before managing players.');
  const actions = {
    'whitelist-add': name => `whitelist add ${name}`,
    'whitelist-remove': name => `whitelist remove ${name}`,
    op: name => `op ${name}`,
    deop: name => `deop ${name}`,
    ban: name => `ban ${name}`,
    pardon: name => `pardon ${name}`,
    list: () => 'list'
  };
  const commandBuilder = actions[action];
  if (!commandBuilder) throw new Error('Unsupported player action.');
  const name = String(playerName || '').trim();
  if (action !== 'list' && !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    throw new Error('Enter a valid Minecraft Java username.');
  }
  child.stdin.write(`${commandBuilder(name)}\n`);
  return true;
}

async function ensureServerFolder(id) {
  const serverDirectory = getServerDirectory(id);
  await fs.mkdir(serverDirectory, { recursive: true });
  return serverDirectory;
}

async function addModFiles(id) {
  const serverDirectory = await ensureServerFolder(id);
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Add mod JAR files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Minecraft mod JARs', extensions: ['jar'] }]
  });
  if (selection.canceled) return [];
  await serverFiles.createDirectory(serverDirectory, 'mods');
  const added = [];
  for (const sourcePath of selection.filePaths) {
    if (path.extname(sourcePath).toLowerCase() !== '.jar') continue;
    const fileName = path.basename(sourcePath);
    const destination = serverFiles.resolveInsideRoot(serverDirectory, path.posix.join('mods', fileName));
    await fs.copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
    added.push(fileName);
  }
  return added;
}

async function listServerFiles(id, relativePath) {
  const serverDirectory = await ensureServerFolder(id);
  if (relativePath === 'mods') await serverFiles.createDirectory(serverDirectory, 'mods');
  return serverFiles.listDirectory(serverDirectory, relativePath || '');
}

async function readServerFile(id, relativePath) {
  const serverDirectory = await ensureServerFolder(id);
  return serverFiles.readTextFile(serverDirectory, relativePath);
}

async function writeServerFile(id, relativePath, content) {
  const serverDirectory = await ensureServerFolder(id);
  return serverFiles.writeTextFile(serverDirectory, relativePath, content);
}

async function deleteServerFile(id, relativePath) {
  const serverDirectory = await ensureServerFolder(id);
  return serverFiles.deleteEntry(serverDirectory, relativePath);
}

async function startServer(id) {
  const { profile } = await findProfile(id);
  if (runningServers.has(profile.id)) return getVisibleProfiles();
  const serverDirectory = getServerDirectory(profile.id);
  await fs.access(path.join(serverDirectory, 'server.jar')).catch(() => {
    throw new Error('Install this server version before starting it.');
  });

  const eulaPath = path.join(serverDirectory, 'eula.txt');
  let eulaAccepted = false;
  try {
    eulaAccepted = (await fs.readFile(eulaPath, 'utf8')).includes('eula=true');
  } catch { /* The EULA has not been accepted for this server yet. */ }
  if (!eulaAccepted) {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Minecraft EULA',
      message: 'You must review and accept the Minecraft EULA before running this server.',
      detail: 'Open the EULA at https://aka.ms/MinecraftEULA. Choose “I Agree” only if you accept its terms.',
      buttons: ['Cancel', 'I Agree'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (answer.response !== 1) throw new Error('Server start cancelled because the EULA was not accepted.');
    await fs.writeFile(eulaPath, 'eula=true\n', 'utf8');
  }

  const propertiesPath = path.join(serverDirectory, 'server.properties');
  let properties = '';
  try {
    properties = await fs.readFile(propertiesPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (/^online-mode=/m.test(properties)) {
    properties = properties.replace(/^online-mode=.*$/m, 'online-mode=false');
  } else {
    properties += `${properties && !properties.endsWith('\n') ? '\n' : ''}online-mode=false\n`;
  }
  await fs.writeFile(propertiesPath, properties, 'utf8');

  const java = await getJavaInfo();
  const requiredMajor = Number(profile.requiredJavaMajor) || 8;
  if (java.version !== 'unknown' && Number(java.version) < requiredMajor) {
    throw new Error(`Minecraft ${profile.version} needs Java ${requiredMajor} or newer; found Java ${java.version}.`);
  }
  const minimumMemory = Math.min(1, profile.ram);
  const child = spawn('java', [
    `-Xms${minimumMemory}G`,
    `-Xmx${profile.ram}G`,
    '-jar',
    'server.jar',
    'nogui'
  ], { cwd: serverDirectory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let settled = false;
    runningServers.set(profile.id, child);
    sendToRenderer('blockhost:server-status', { profileId: profile.id, running: true });
    child.stdout.on('data', chunk => appendOutput(profile.id, chunk));
    child.stderr.on('data', chunk => appendOutput(profile.id, chunk));
    child.once('spawn', async () => {
      settled = true;
      setTimeout(() => {
        if (runningServers.get(profile.id) === child) child.stdin.write('list\n');
      }, 1200);
      resolve(await getVisibleProfiles());
    });
    child.once('error', error => {
      runningServers.delete(profile.id);
      sendToRenderer('blockhost:server-status', { profileId: profile.id, running: false });
      if (!settled) reject(error);
    });
    child.once('close', (code, signal) => {
      runningServers.delete(profile.id);
      onlinePlayers.delete(profile.id);
      outputBuffers.delete(profile.id);
      sendToRenderer('blockhost:server-status', { profileId: profile.id, running: false, code, signal });
      if (!settled) reject(new Error('The Java server process exited before it started.'));
    });
  });
}

async function stopServer(id) {
  const profileId = safeProfileId(id);
  const child = runningServers.get(profileId);
  if (!child) return getVisibleProfiles();
  child.stdin.write('stop\n');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (runningServers.get(profileId) === child) child.kill();
      resolve();
    }, 12000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return getVisibleProfiles();
}

async function deleteProfile(id) {
  const { profiles, profile } = await findProfile(id);
  if (runningServers.has(profile.id)) await stopServer(profile.id);
  let removeFiles = false;
  try {
    await fs.access(path.join(getServerDirectory(profile.id), 'server.jar'));
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Delete server profile',
      message: `Remove “${profile.name}”?`,
      detail: 'Choose whether to keep or permanently delete this server’s files.',
      buttons: ['Cancel', 'Keep files', 'Delete files'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice.response === 0) return getVisibleProfiles();
    removeFiles = choice.response === 2;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (removeFiles) await fs.rm(getServerDirectory(profile.id), { recursive: true, force: true });
  await writeProfiles(profiles.filter(candidate => candidate.id !== profile.id));
  return getVisibleProfiles();
}

async function createProfile(input) {
  const profile = normalizeProfile(input);
  const manifest = await getVersionManifest();
  if (!manifest.versions.some(candidate => candidate.id === profile.version)) {
    throw new Error('Choose a version from the official Minecraft version list.');
  }
  const profiles = await readProfiles();
  if (profiles.some(candidate => candidate.port === profile.port)) {
    throw new Error(`Port ${profile.port} is already assigned to another server profile.`);
  }
  profiles.push({ id: randomUUID(), ...profile, createdAt: new Date().toISOString() });
  await writeProfiles(profiles);
  return getVisibleProfiles();
}

function getSystemInfo() {
  return {
    totalMemoryBytes: os.totalmem(),
    platform: process.platform,
    architecture: process.arch
  };
}

async function getRuntimeStatus() {
  try {
    const java = await getJavaInfo();
    return { available: true, version: java.version };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250,
    height: 850,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#f3f5f2',
    title: 'Blockhost',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('blockhost:versions', getVersionCatalog);
ipcMain.handle('blockhost:profiles:list', getVisibleProfiles);
ipcMain.handle('blockhost:profiles:create', (_event, profile) => createProfile(profile));
ipcMain.handle('blockhost:profiles:delete', (_event, id) => deleteProfile(id));
ipcMain.handle('blockhost:server:install', (_event, id) => installServer(id));
ipcMain.handle('blockhost:server:start', (_event, id) => startServer(id));
ipcMain.handle('blockhost:server:stop', (_event, id) => stopServer(id));
ipcMain.handle('blockhost:server:open-folder', async (_event, id) => {
  const directory = getServerDirectory(id);
  await fs.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle('blockhost:players:get', (_event, id) => getPlayerData(id));
ipcMain.handle('blockhost:players:action', (_event, id, action, player) => runPlayerAction(id, action, player));
ipcMain.handle('blockhost:files:list', (_event, id, relativePath) => listServerFiles(id, relativePath));
ipcMain.handle('blockhost:files:read', (_event, id, relativePath) => readServerFile(id, relativePath));
ipcMain.handle('blockhost:files:write', (_event, id, relativePath, content) => writeServerFile(id, relativePath, content));
ipcMain.handle('blockhost:files:delete', (_event, id, relativePath) => deleteServerFile(id, relativePath));
ipcMain.handle('blockhost:mods:add', (_event, id) => addModFiles(id));
ipcMain.handle('blockhost:system-info', getSystemInfo);
ipcMain.handle('blockhost:runtime-status', getRuntimeStatus);
ipcMain.handle('blockhost:open-external', async (_event, url) => {
  const parsedUrl = new URL(String(url));
  if (parsedUrl.protocol !== 'https:') throw new Error('Only HTTPS links can be opened.');
  await shell.openExternal(parsedUrl.href);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const child of runningServers.values()) child.kill();
  if (process.platform !== 'darwin') app.quit();
});

async function downloadHttpsStream(url, redirects = 0) {
  if (redirects > 5) throw new Error('Too many redirects while downloading the server JAR.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS downloads are allowed.');
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: { 'User-Agent': 'Blockhost/0.1', Accept: 'application/java-archive' },
      timeout: 120000
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadHttpsStream(new URL(response.headers.location, parsed).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Server download failed (${response.statusCode}).`));
        return;
      }
      resolve({ stream: response, contentLength: Number(response.headers['content-length']) || 0 });
    });
    request.once('timeout', () => request.destroy(new Error('Server JAR download timed out.')));
    request.once('error', reject);
  });
}