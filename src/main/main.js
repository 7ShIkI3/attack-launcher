'use strict';
// Processus principal Electron : fenêtre sans cadre, IPC nommés (et seulement ceux-là), installation et lancement.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const C = require('./constants');
const installer = require('./installer');
const settingsStore = require('./settings');
const profiles = require('./profiles');
const launch = require('./launch');
const { defaultMinecraftDir } = require('./paths');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
const REPO_URL = `https://github.com/${C.GITHUB_REPO}`;

// Dossiers isolés pour les tests (capture d'écran, essais) : jamais utilisés par une installation normale.
if (process.env.ATTACK_USER_DATA) app.setPath('userData', path.resolve(process.env.ATTACK_USER_DATA));
const minecraftDir = process.env.ATTACK_MINECRAFT_DIR ? path.resolve(process.env.ATTACK_MINECRAFT_DIR) : defaultMinecraftDir();

let win = null;
let settings = settingsStore.defaults();
let installing = false;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function profileIcon() {
  const file = path.join(ROOT, 'assets', 'profile-icon.png');
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

/** N'accepte que les messages venant de notre propre page. */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.senderFrame?.url !== INDEX_URL) throw new Error('Origine IPC refusée');
    return fn(event, ...args);
  });
}

function publicError(error) {
  return { ok: false, code: error.code || 'ERROR', message: error.message };
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    totalRamMb: Math.floor(os.totalmem() / 1048576),
    minecraftDir,
    launcherDetected: Boolean(launch.launchPlan().detected),
    forgeVersion: C.FORGE_VERSION,
    mcVersion: C.MC_VERSION,
  }));

  handle('settings:get', () => settings);
  handle('settings:set', async (_event, patch) => {
    settings = settingsStore.sanitize(patch, settings);
    await settingsStore.save(settingsFile(), settings);
    return settings;
  });

  handle('install:status', () => installer.status({ minecraftDir, gameDir: settings.gameDir }));

  handle('install:run', async (event) => {
    if (installing) return { ok: false, code: 'BUSY', message: 'Installation déjà en cours' };
    installing = true;
    try {
      const summary = await installer.install({
        minecraftDir,
        settings,
        icon: profileIcon(),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('install:progress', progress);
        },
      });
      return { ok: true, summary };
    } catch (error) {
      return publicError(error);
    } finally {
      installing = false;
    }
  });

  handle('game:play', async () => {
    try {
      const status = await installer.status({ minecraftDir, gameDir: settings.gameDir });
      if (!status.installed) return { ok: false, code: 'NOT_INSTALLED', message: 'Installation incomplète' };
      // réglages actuels (RAM, Java, dossier) + profil présélectionné dans le launcher officiel
      await profiles.updateProfiles(minecraftDir, (data) => profiles.markLastUsed(profiles.mergeProfile(data, {
        gameDir: settings.gameDir, ramMb: settings.ramMb, javaPath: settings.javaPath, icon: profileIcon(),
      })));
      const plan = launch.openLauncher();
      return { ok: true, detected: Boolean(plan.detected) };
    } catch (error) {
      return publicError(error);
    }
  });

  handle('dialog:pickFolder', async (_event, current) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : undefined,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('dialog:pickJava', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Java', extensions: ['exe'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('shell:openGameDir', async () => {
    await fsp.mkdir(settings.gameDir, { recursive: true });
    return shell.openPath(settings.gameDir);
  });
  handle('shell:openRepo', () => shell.openExternal(REPO_URL));

  handle('window:minimize', () => win?.minimize());
  handle('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  handle('window:close', () => win?.close());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#09090C',
    title: 'ATTACK Launcher',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  const sendState = () => win.webContents.send('window:state', { maximized: win.isMaximized() });
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(INDEX_HTML);
  if (process.env.ATTACK_SCREENSHOT_DIR) win.webContents.once('did-finish-load', () => captureScreens());
}

/** Mode capture (tests) : photographie chaque page puis quitte. */
async function captureScreens() {
  const dir = path.resolve(process.env.ATTACK_SCREENSHOT_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  if (process.env.ATTACK_SCREENSHOT_INSTALL) {
    // parcours complet depuis l'interface : clic sur INSTALLER, capture en cours, puis à la fin
    const js = (code) => win.webContents.executeJavaScript(code);
    await js("document.getElementById('play-button').click()");
    await wait(1500);
    await fsp.writeFile(path.join(dir, 'installing.png'), (await win.webContents.capturePage()).toPNG());
    for (let i = 0; i < 600 && (await js('document.getElementById("play-button").disabled')); i++) await wait(500);
    await wait(300);
    await fsp.writeFile(path.join(dir, 'installed.png'), (await win.webContents.capturePage()).toPNG());
  }
  for (const page of ['home', 'mods', 'settings', 'account']) {
    await win.webContents.executeJavaScript(`window.showPage && window.showPage(${JSON.stringify(page)})`);
    await wait(500);
    const image = await win.webContents.capturePage();
    await fsp.writeFile(path.join(dir, `${page}.png`), image.toPNG());
  }
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    settings = await settingsStore.load(settingsFile());
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
