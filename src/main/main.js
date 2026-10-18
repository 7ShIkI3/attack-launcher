'use strict';
// Processus principal Electron : fenêtre sans cadre, IPC nommés (et seulement ceux-là), installation,
// comptes Microsoft, lancement du jeu (direct avec un compte, sinon par le launcher officiel) et mise à jour du launcher.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
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
const auth = require('./auth');
const runtime = require('./runtime');
const game = require('./game');
const http = require('./http');
const updates = require('./updates');
const { AccountStore } = require('./accounts');
const { defaultMinecraftDir } = require('./paths');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
const REPO_URL = `https://github.com/${C.GITHUB_REPO}`;
const AZURE_HELP_URLS = ['https://portal.azure.com/', 'https://aka.ms/mce-reviewappid'];

// Dossiers isolés pour les tests (capture d'écran, essais) : jamais utilisés par une installation normale.
if (process.env.ATTACK_USER_DATA) app.setPath('userData', path.resolve(process.env.ATTACK_USER_DATA));
const minecraftDir = process.env.ATTACK_MINECRAFT_DIR ? path.resolve(process.env.ATTACK_MINECRAFT_DIR) : defaultMinecraftDir();
const runtimeDir = process.env.ATTACK_RUNTIME_DIR
  ? path.resolve(process.env.ATTACK_RUNTIME_DIR)
  : path.join(process.env.LOCALAPPDATA || os.homedir(), 'ATTACK Launcher', 'runtime');

let win = null;
let settings = settingsStore.defaults();
let installing = false;
let login = null; // connexion en cours : { cancelled, verificationUri, userCode }
let accounts = null;
let launching = false; // lancement direct en préparation (Java, connexion)
const games = new Set(); // parties lancées directement et encore ouvertes
let updater = null; // contrôleur des mises à jour du launcher
const transport = auth.createTransport();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

/** Chiffrement du refresh token par Windows (DPAPI, lié à la session de l'utilisateur). */
const cipher = {
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new auth.AuthError('NO_ENCRYPTION', 'Chiffrement Windows indisponible : impossible de garder la connexion.');
    return safeStorage.encryptString(text);
  },
  decrypt(buffer) {
    return safeStorage.decryptString(buffer);
  },
};

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

/** Journal des mises à jour : <userData>/logs/updater.log (l'ancien passe en .old au-delà de 1 Mo). */
function createUpdateLog() {
  const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file).size > 1048576) fs.renameSync(file, `${file}.old`);
  } catch {
    // pas encore de journal
  }
  const write = (level) => (...parts) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${parts.map(String).join(' ')}\n`);
    } catch {
      // journal indisponible : la mise à jour continue
    }
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

/** Raison de ne rien faire côté mise à jour : installation, lancement ou partie en cours (même par le launcher officiel). */
async function busyReason() {
  if (installing || launching) return 'install';
  if (games.size > 0 || (await game.detectRunningGame())) return 'game';
  return null;
}

function setupUpdates() {
  const log = createUpdateLog();
  const mode = updates.updateMode({ isPackaged: app.isPackaged });
  let autoUpdater = null;
  let createToken = () => null;
  if (mode !== 'off') {
    // releases GitHub publiques : aucun jeton ; le SHA-512 de latest.yml est vérifié après chaque téléchargement
    const electronUpdater = require('electron-updater');
    autoUpdater = electronUpdater.autoUpdater;
    autoUpdater.logger = log;
    createToken = () => new electronUpdater.CancellationToken();
  }
  updater = new updates.UpdateController({
    updater: autoUpdater,
    mode,
    currentVersion: app.getVersion(),
    busy: busyReason,
    onState: (state) => send('update:state', state),
    log: (message) => log.info(message),
    createToken,
  });
  updater.start();
}

function publicError(error) {
  return { ok: false, code: error.code || 'ERROR', message: error.message };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Skin du profil en data: URL (la page n'a pas le droit de charger d'images externes). */
async function skinDataUrl(url) {
  if (!url) return null;
  try {
    const buffer = await http.fetchBuffer(url.replace(/^http:/, 'https:'), { retries: 1 });
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

const refreshWith = (refreshToken) => auth.refreshAccount(transport, settingsStore.clientId(settings), refreshToken);

function accountsView() {
  return {
    accounts: accounts.list(),
    hasClientId: Boolean(settingsStore.clientId(settings)),
    clientIdFromEnv: settingsStore.clientIdSource(settings) === 'env',
    clientIdDefault: settingsStore.clientIdSource(settings) === 'default',
    devMode: settings.devMode,
    encryption: safeStorage.isEncryptionAvailable(),
  };
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
    updater?.activityStarted('install');
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
      updater?.activityEnded();
    }
  });

  // --- comptes ---
  handle('accounts:list', () => accountsView());

  handle('accounts:login', async () => {
    if (login) return { ok: false, code: 'BUSY', message: 'Connexion déjà en cours' };
    const current = { cancelled: false };
    login = current;
    try {
      const result = await auth.loginWithDeviceCode(transport, settingsStore.clientId(settings), {
        onCode: ({ userCode, verificationUri, expiresIn }) => {
          current.userCode = userCode;
          current.verificationUri = verificationUri;
          send('auth:event', { stage: 'code', userCode, verificationUri, expiresIn });
          openVerification(verificationUri);
        },
        onStage: (stage) => send('auth:event', { stage }),
        isCancelled: () => current.cancelled,
      });
      const skin = await skinDataUrl(result.profile.skinUrl);
      await accounts.saveMicrosoft(result, { skin });
      return { ok: true, name: result.profile.name };
    } catch (error) {
      return publicError(error);
    } finally {
      login = null;
    }
  });
  handle('accounts:cancel', () => {
    if (login) login.cancelled = true;
  });
  handle('accounts:openVerification', () => login?.verificationUri && openVerification(login.verificationUri));
  handle('accounts:copyCode', () => login?.userCode && clipboard.writeText(login.userCode));
  handle('accounts:select', async (_event, id) => {
    await accounts.setActive(String(id));
    return accountsView();
  });
  handle('accounts:remove', async (_event, id) => {
    await accounts.remove(String(id));
    return accountsView();
  });
  handle('accounts:addOffline', async (_event, name) => {
    if (!settings.devMode) return { ok: false, code: 'DEV_ONLY', message: 'Réservé au mode développeur' };
    try {
      await accounts.addOffline(String(name || ''));
      return { ok: true, ...accountsView() };
    } catch (error) {
      return publicError(error);
    }
  });
  handle('shell:openAzureHelp', (_event, index) => {
    const url = AZURE_HELP_URLS[Number(index)];
    if (url) shell.openExternal(url);
  });

  // --- jeu ---
  handle('game:play', async (event) => {
    updater?.activityStarted('game');
    try {
      const status = await installer.status({ minecraftDir, gameDir: settings.gameDir });
      if (!status.installed) return { ok: false, code: 'NOT_INSTALLED', message: 'Installation incomplète' };
      const account = accounts.active();
      // un compte hors ligne ne sert qu'en mode développeur
      if (account && (account.type === 'msa' || settings.devMode)) return await playDirect(event, account);
      // sans compte : profil présélectionné dans le launcher officiel
      await profiles.updateProfiles(minecraftDir, (data) => profiles.markLastUsed(profiles.mergeProfile(data, {
        gameDir: settings.gameDir, ramMb: settings.ramMb, javaPath: settings.javaPath, icon: profileIcon(),
      })));
      const plan = launch.openLauncher();
      return { ok: true, mode: 'official', detected: Boolean(plan.detected) };
    } catch (error) {
      return publicError(error);
    }
  });
  handle('game:openLogs', async () => {
    const dir = path.join(settings.gameDir, 'logs', 'launcher');
    await fsp.mkdir(dir, { recursive: true });
    return shell.openPath(dir);
  });

  handle('shell:openGameDir', async () => {
    await fsp.mkdir(settings.gameDir, { recursive: true });
    return shell.openPath(settings.gameDir);
  });
  handle('shell:openRepo', () => shell.openExternal(REPO_URL));

  // --- mise à jour du launcher ---
  handle('update:state', () => updater?.state || { phase: 'off' });
  handle('update:install', () => (updater ? updater.install() : { ok: false, code: 'NO_UPDATE' }));
  handle('update:openReleases', () => shell.openExternal(updates.RELEASES_URL));

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

  handle('window:minimize', () => win?.minimize());
  handle('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  handle('window:close', () => win?.close());
}

/** N'ouvre que la page de validation Microsoft renvoyée par le serveur (https, domaine Microsoft). */
function openVerification(uri) {
  try {
    const { protocol, hostname } = new URL(uri);
    if (protocol === 'https:' && /(^|\.)(microsoft\.com|microsoftonline\.com|live\.com)$/.test(hostname)) shell.openExternal(uri);
  } catch {
    // adresse invalide : l'utilisateur peut la recopier depuis l'écran
  }
}

/** Lancement direct : Java officiel (ou personnalisé), identité du compte, jeu. */
async function playDirect(event, account) {
  const progress = (step, done, total) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('install:progress', { step, done, total, percent: total ? Math.round((done / total) * 100) : 100 });
    }
  };
  launching = true;
  let result;
  let identity;
  try {
    let java = settings.javaPath;
    if (!java) {
      progress('java', 0, 1);
      java = (await runtime.installRuntime({ runtimeDir, onProgress: ({ done, total }) => progress('java', done, total) })).java;
    }
    progress('auth', 0, 1);
    identity = await accounts.launchIdentity(account.id, refreshWith);
    progress('launch', 0, 1);
    result = await game.launchGame({
      java,
      minecraftDir,
      gameDir: settings.gameDir,
      versionId: C.FORGE_VERSION_ID,
      identity,
      ramMb: settings.ramMb,
      launcherVersion: app.getVersion(),
    });
  } finally {
    launching = false;
  }
  // partie en cours : aucune mise à jour tant que le jeu n'est pas fermé
  games.add(result.child);
  result.child.once('exit', () => {
    games.delete(result.child);
    updater?.activityEnded();
  });
  progress('launch', 1, 1);
  return { ok: true, mode: 'direct', name: identity.name, logFile: result.logFile };
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
  if (process.env.ATTACK_SCREENSHOT_DIR) {
    // mode capture (tests) : fenêtre sans focus et transparente aux clics, pour qu'on ne la prenne pas pour le vrai launcher
    win.setIgnoreMouseEvents(true);
    win.once('ready-to-show', () => win.showInactive());
  } else {
    win.once('ready-to-show', () => win.show());
  }
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
  const js = (code) => win.webContents.executeJavaScript(code);
  // ATTACK_SCREENSHOT_SIZE=940x600 : capture à une autre taille de fenêtre (bornée par la taille minimale)
  const size = /^(\d+)x(\d+)$/.exec(process.env.ATTACK_SCREENSHOT_SIZE || '');
  if (size) win.setSize(Number(size[1]), Number(size[2]));
  await wait(1200);
  if (process.env.ATTACK_SCREENSHOT_UPDATE) {
    // attend la fin de la vérification de mise à jour, capture la bannière, puis clique sur Redémarrer si demandé
    const phase = () => js("document.getElementById('update-banner').dataset.phase || ''");
    const final = ['ready', 'available', 'none', 'error', 'off'];
    for (let i = 0; i < 360 && !final.includes(await phase()); i++) await wait(500);
    await wait(400);
    const shown = await phase();
    await fsp.writeFile(path.join(dir, `update-${app.getVersion()}-${shown || 'aucune'}.png`), (await win.webContents.capturePage()).toPNG());
    if (process.env.ATTACK_SCREENSHOT_UPDATE === 'install' && shown === 'ready') {
      await js("document.getElementById('update-action').click()");
      return; // le launcher se ferme, l'installateur prend le relais puis le relance
    }
  }
  if (process.env.ATTACK_SCREENSHOT_INSTALL) {
    // parcours complet depuis l'interface : clic sur INSTALLER, capture en cours, puis à la fin
    await js("document.getElementById('play-button').click()");
    await wait(1500);
    await fsp.writeFile(path.join(dir, 'installing.png'), (await win.webContents.capturePage()).toPNG());
    for (let i = 0; i < 600 && (await js('document.getElementById("play-button").disabled')); i++) await wait(500);
    await wait(300);
    await fsp.writeFile(path.join(dir, 'installed.png'), (await win.webContents.capturePage()).toPNG());
  }
  if (process.env.ATTACK_SCREENSHOT_PLAY) {
    // clic sur JOUER (compte actif) : capture une fois le lancement terminé
    await js("document.getElementById('play-button').click()");
    await wait(300);
    for (let i = 0; i < 600 && (await js('document.getElementById("play-button").disabled')); i++) await wait(500);
    await wait(300);
    await fsp.writeFile(path.join(dir, 'played.png'), (await win.webContents.capturePage()).toPNG());
  }
  for (const page of ['home', 'mods', 'settings', 'account']) {
    await win.webContents.executeJavaScript(`window.showPage && window.showPage(${JSON.stringify(page)})`);
    await wait(500);
    const image = await win.webContents.capturePage();
    await fsp.writeFile(path.join(dir, `${page}.png`), image.toPNG());
  }
  // historique complet des versions (fenêtre « Tout voir » de l'accueil)
  await js("window.showPage && window.showPage('home'); document.getElementById('changelog-all').click()");
  await wait(500);
  await fsp.writeFile(path.join(dir, 'changelog.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

/** Au démarrage : rafraîchit le compte actif en silence (nouveau jeton, refresh token tenu à jour). */
async function refreshActiveAccount() {
  const account = accounts.active();
  if (!account || account.type !== 'msa' || !settingsStore.clientId(settings)) return;
  try {
    await accounts.refresh(account.id, refreshWith);
    send('accounts:changed', accountsView());
  } catch (error) {
    send('accounts:changed', { ...accountsView(), refreshError: { code: error.code || 'ERROR', message: error.message } });
  }
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
    accounts = await new AccountStore(path.join(app.getPath('userData'), 'accounts.json'), cipher).load();
    registerIpc();
    createWindow();
    setupUpdates();
    refreshActiveAccount();
  });
  app.on('window-all-closed', () => app.quit());
  // mise à jour prête : la fermeture ne l'installe que si aucune partie ni installation ne tourne
  app.on('before-quit', (event) => {
    if (!updater?.needsQuitCheck()) return;
    event.preventDefault();
    updater.prepareQuit().finally(() => app.quit());
  });
}
