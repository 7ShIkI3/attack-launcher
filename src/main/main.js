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
const catalog = require('./catalog');
const modpack = require('./modpack');
const optifine = require('./optifine');
const installer = require('./installer');
const settingsStore = require('./settings');
const profiles = require('./profiles');
const jvmargs = require('./jvmargs');
const launch = require('./launch');
const auth = require('./auth');
const runtime = require('./runtime');
const game = require('./game');
const http = require('./http');
const updates = require('./updates');
const { AccountStore } = require('./accounts');
const skins = require('./skins');
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
let settings = settingsStore.defaults(); // réglages complets (globaux + par profil) ; la page reçoit la vue à plat du profil courant
let installing = false;
let login = null; // connexion en cours : { cancelled, verificationUri, userCode }
let accounts = null;
let launching = false; // lancement direct en préparation (Java, connexion)
const games = new Map(); // parties lancées directement et encore ouvertes : processus -> dossier de jeu du profil
let updater = null; // contrôleur des mises à jour du launcher
const transport = auth.createTransport();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

/** Profil choisi (catalogue) et ses réglages effectifs à plat : dossier de jeu, Java, jars de développement, groupes du pack, OptiFine. */
const currentProfile = () => catalog.get(settings.profileId);
const effective = () => settingsStore.forProfile(settings);

/** Réglages qui décident du contenu attendu du dossier de jeu : les mêmes pour l'état affiché et pour le lancement. */
const statusOptions = (eff) => ({
  shaders: eff.shaders,
  pvpMods: eff.pvpMods,
  optifinePacks: eff.optifinePacks,
  replayMod: eff.replayMod,
  optifine: eff.optifine,
  optifineJar: eff.optifineJar,
});

/** Description des profils pour la page : catalogue + contenu du pack de mods figé (nom, version, optionnel, groupe). */
function profilesView() {
  return catalog.list().map((profile) => {
    let pack = [];
    try {
      pack = modpack.view(modpack.loadPack(profile));
    } catch {
      pack = [];
    }
    return { ...catalog.view(profile), pack };
  });
}

/** Chiffrement du refresh token par Windows (DPAPI, lié à la session de l'utilisateur). */
const cipher = {
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new auth.AuthError('NO_ENCRYPTION', 'Chiffrement Windows indisponible : impossible de garder la connexion.');
    return safeStorage.encryptString(text);
  },
  decrypt(buffer) {
    try {
      return safeStorage.decryptString(buffer);
    } catch {
      // autre session Windows, profil restauré ou accounts.json copié d'un autre PC : la clé DPAPI n'est plus la même
      throw new auth.AuthError('SESSION_EXPIRED', 'Session illisible sur ce Windows : reconnecte ce compte.');
    }
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
  if (installing) return 'install';
  if (launching) return 'launch';
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

/** Erreur du dernier rafraîchissement du compte actif au démarrage ({ code, message }), effacée par un succès ou un changement de compte. */
let lastRefreshError = null;

function accountsView() {
  return {
    accounts: accounts.list(),
    refreshError: lastRefreshError,
    hasClientId: Boolean(settingsStore.clientId(settings)),
    clientIdFromEnv: settingsStore.clientIdSource(settings) === 'env',
    clientIdDefault: settingsStore.clientIdSource(settings) === 'default',
    devMode: settings.devMode,
    encryption: safeStorage.isEncryptionAvailable(),
  };
}

/** Enregistre un changement de réglages venu de la page (validé par settings.sanitize) ; renvoie les réglages effectifs du profil choisi. */
async function applySettings(patch) {
  // pas de changement de profil pendant une installation ou un lancement : ils travaillent sur le profil choisi au départ
  const safePatch = (installing || launching) && patch && typeof patch === 'object' ? { ...patch, profileId: undefined } : patch;
  // arguments Java refusés : message clair plutôt qu'un retour silencieux à l'ancienne valeur
  if (safePatch && typeof safePatch === 'object' && 'jvmArgs' in safePatch) {
    const parsed = jvmargs.parseJvmArgs(safePatch.jvmArgs);
    if (!parsed.ok) throw new Error(jvmargs.describe(parsed));
  }
  const previous = settings;
  settings = settingsStore.sanitize(safePatch, settings);
  try {
    await settingsStore.save(settingsFile(), settings);
  } catch (error) {
    settings = previous; // enregistrement impossible (disque plein, antivirus) : le profil choisi ne doit pas changer en cachette
    throw error;
  }
  return effective();
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    totalRamMb: Math.floor(os.totalmem() / 1048576),
    minecraftDir,
    launcherDetected: Boolean(launch.launchPlan().detected),
    profiles: profilesView(),
  }));

  handle('settings:get', () => effective());
  handle('settings:set', (_event, patch) => applySettings(patch));

  handle('install:status', () => {
    const profile = currentProfile();
    const eff = effective();
    return installer.status({ minecraftDir, gameDir: eff.gameDir, profile, ...statusOptions(eff) });
  });

  // --- OptiFine (profil 1.8.9) : la copie du joueur, jamais téléchargée ---
  handle('optifine:pick', async () => {
    if (!catalog.hasOptifine(currentProfile())) return { ok: false, code: 'NO_OPTIFINE', message: 'OptiFine : profil 1.8.9 seulement.' };
    const result = await dialog.showOpenDialog(win, {
      title: 'Choisir OptiFine pour Minecraft 1.8.9 (.jar)',
      properties: ['openFile'],
      defaultPath: app.getPath('downloads'),
      filters: [{ name: 'OptiFine 1.8.9', extensions: ['jar'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, code: 'CANCELLED' };
    const checked = await optifine.validate(result.filePaths[0]);
    if (!checked.ok) return { ok: false, code: `OPTIFINE_${checked.reason}`, message: checked.message };
    await applySettings({ optifineJar: checked.file, optifine: true });
    return { ok: true, name: checked.name };
  });
  handle('shell:openOptifine', () => shell.openExternal(optifine.DOWNLOAD_URL));

  handle('install:run', async (event) => {
    if (installing) return { ok: false, code: 'BUSY', message: 'Installation déjà en cours' };
    installing = true; // posé avant la détection des parties (asynchrone) : un deuxième clic ne lance pas une deuxième installation
    try {
      const eff = effective();
      // un jar de mod ouvert par une partie ne peut pas être remplacé ni retiré : on attend la fin de la partie de ce profil
      if (launching || game.gameBlocksInstall(eff.gameDir, [...games.values()], await game.runningGameLines())) {
        return { ok: false, code: 'GAME_RUNNING', message: 'Une partie est en cours' };
      }
      updater?.activityStarted('install');
      const summary = await installer.install({
        minecraftDir,
        settings: eff,
        profile: currentProfile(),
        icon: profileIcon(),
        appVersion: app.getVersion(),
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
          if (current.cancelled) return; // annulée pendant la demande du code : rien à montrer ni à ouvrir
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
      // une connexion annulée a déjà libéré la place : ne pas effacer celle qui a pu démarrer depuis
      if (login === current) login = null;
    }
  });
  handle('accounts:cancel', () => {
    // la boucle d'attente le verra à son prochain réveil ; une nouvelle connexion est possible tout de suite
    if (login) login.cancelled = true;
    login = null;
  });
  handle('accounts:openVerification', () => login?.verificationUri && openVerification(login.verificationUri));
  handle('accounts:copyCode', () => login?.userCode && clipboard.writeText(login.userCode));
  handle('accounts:select', async (_event, id) => {
    await accounts.setActive(String(id));
    lastRefreshError = null;
    return accountsView();
  });
  handle('accounts:remove', async (_event, id) => {
    await accounts.remove(String(id));
    lastRefreshError = null;
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
  // --- skin du compte actif (le jeton Minecraft reste ici ; la page ne voit que les images) ---
  let pendingSkin = null; // { png: Buffer, dataUrl } choisi mais pas encore envoye
  const skinAccount = () => {
    const account = accounts.active();
    if (!account || account.type !== 'msa') {
      throw Object.assign(new Error('Connecte un compte Microsoft pour changer de skin.'), { code: 'NO_ACCOUNT' });
    }
    return account;
  };
  const afterSkinChange = async (account, skin) => {
    const image = skin ? await skinDataUrl(skin.url) : null;
    await accounts.setSkin(account.id, image, skin?.variant || 'classic');
    const view = accountsView();
    send('accounts:changed', view);
    return { ok: true, ...view };
  };
  handle('skins:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choisir un skin (PNG 64 x 64)',
      properties: ['openFile'],
      filters: [{ name: 'Skin Minecraft', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, code: 'CANCELLED' };
    try {
      const png = await fsp.readFile(result.filePaths[0]);
      const size = skins.checkSkinPng(png);
      pendingSkin = { png, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
      return { ok: true, dataUrl: pendingSkin.dataUrl, legacy: size.height === 32 };
    } catch (error) {
      pendingSkin = null;
      return publicError(error);
    }
  });
  handle('skins:discard', () => {
    pendingSkin = null;
  });
  handle('skins:apply', async (_event, variant) => {
    try {
      const account = skinAccount();
      if (!pendingSkin) return { ok: false, code: 'NO_SKIN', message: 'Choisis d’abord une image.' };
      const identity = await accounts.launchIdentity(account.id, refreshWith);
      const skin = await skins.uploadSkin(transport, identity.accessToken, pendingSkin.png, variant === 'slim' ? 'slim' : 'classic');
      pendingSkin = null;
      return await afterSkinChange(account, skin);
    } catch (error) {
      // skin peut-être déjà changé chez Mojang (échec après l'envoi) : la page reçoit l'erreur et abandonne l'image choisie
      pendingSkin = null;
      return publicError(error);
    }
  });
  handle('skins:reset', async () => {
    try {
      const account = skinAccount();
      const identity = await accounts.launchIdentity(account.id, refreshWith);
      return await afterSkinChange(account, await skins.resetSkin(transport, identity.accessToken));
    } catch (error) {
      return publicError(error);
    }
  });
  handle('skins:refresh', async () => {
    try {
      const account = skinAccount();
      const identity = await accounts.launchIdentity(account.id, refreshWith);
      return await afterSkinChange(account, await skins.readSkin(transport, identity.accessToken));
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
    // pas de lancement pendant une installation : elle réécrit mods/ et le jar du mod (l'interface le bloque déjà)
    if (installing) return { ok: false, code: 'BUSY', message: 'Installation en cours' };
    if (launching) return { ok: false, code: 'LAUNCHING', message: 'Lancement déjà en cours' };
    // posé avant le premier await : ni deuxième lancement ni installation pendant la préparation (Java, compte)
    launching = true;
    let started = false;
    try {
      const profile = currentProfile();
      const eff = effective();
      // une partie de ce profil tourne déjà : relancer réextrairait ses natives (DLL) sous ses pieds
      if (game.gameBlocksInstall(eff.gameDir, [...games.values()])) {
        return { ok: false, code: 'ALREADY_PLAYING', message: 'Une partie de ce profil est déjà ouverte : ferme-la avant d’en lancer une autre.' };
      }
      const status = await installer.status({ minecraftDir, gameDir: eff.gameDir, profile, ...statusOptions(eff) });
      if (!status.installed) return { ok: false, code: 'NOT_INSTALLED', message: 'Installation incomplète' };
      const account = accounts.active();
      // une partie va démarrer : le téléchargement de mise à jour s'arrête et reprendra à la fin
      started = true;
      updater?.activityStarted('game');
      // un compte hors ligne ne sert qu'en mode développeur
      if (account && (account.type === 'msa' || eff.devMode)) return await playDirect(event, account, profile, eff);
      // sans compte : profil présélectionné dans le launcher officiel
      await profiles.updateProfiles(minecraftDir, (data) => profiles.markLastUsed(profiles.mergeProfile(data, {
        ...profiles.identityOf(profile), gameDir: eff.gameDir, ramMb: eff.ramMb, javaPath: eff.javaPath, jvmArgs: eff.jvmArgs, icon: profileIcon(),
      }), new Date(), profile.launcherProfileId));
      const plan = launch.launchPlan();
      if (!plan.detected) {
        // aucun launcher officiel sur ce PC : rien ne démarre (le profil, lui, est prêt pour quand il sera installé)
        updater?.activityEnded();
        return {
          ok: false,
          code: 'LAUNCHER_NOT_FOUND',
          message: 'Pas de compte connecté et launcher Minecraft officiel introuvable : connecte ton compte Microsoft dans la page Compte, ou installe le launcher officiel.',
        };
      }
      launch.openLauncher(plan);
      // le launcher officiel prend la main : la vérification reportée réessaiera dans 10 min, quand la partie qu'il
      // lance sera détectable par busy() (processus javaw)
      return { ok: true, mode: 'official', detected: true };
    } catch (error) {
      // lancement raté (Java, compte, spawn) : rien ne tourne, la mise à jour reportée peut repartir
      if (started) updater?.activityEnded();
      return publicError(error);
    } finally {
      launching = false;
    }
  });
  handle('game:openLogs', async () => {
    const dir = path.join(effective().gameDir, 'logs', 'launcher');
    await fsp.mkdir(dir, { recursive: true });
    return openPathChecked(dir);
  });

  handle('shell:openGameDir', async () => {
    const { gameDir } = effective();
    await fsp.mkdir(gameDir, { recursive: true });
    return openPathChecked(gameDir);
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

/** shell.openPath ne rejette jamais : il renvoie le message d'erreur, qu'on transforme en exception pour l'interface. */
async function openPathChecked(dir) {
  const error = await shell.openPath(dir);
  if (error) throw new Error(error);
  return '';
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

/**
 * Lancement direct : Java officiel (ou personnalisé), identité du compte, jeu.
 * Le composant Java vient du JSON de version du profil : Java 8 (1.8.9), Java 21 (1.21.x), Java 25 (26.x).
 */
async function playDirect(event, account, profile, eff) {
  const progress = (step, done, total) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('install:progress', { step, done, total, percent: total ? Math.round((done / total) * 100) : 100 });
    }
  };
  // `launching` est posé et relâché par game:play, autour de tout le lancement
  let java = eff.javaPath;
  if (!java) {
    progress('java', 0, 1);
    const component = await game.javaComponent(minecraftDir, profile.loader.versionId);
    java = (await runtime.installRuntime({
      runtimeDir,
      component,
      onProgress: ({ done, total }) => progress('java', done, total),
    })).java;
  }
  progress('auth', 0, 1);
  const identity = await accounts.launchIdentity(account.id, refreshWith);
  progress('launch', 0, 1);
  const result = await game.launchGame({
    java,
    minecraftDir,
    gameDir: eff.gameDir,
    versionId: profile.loader.versionId,
    identity,
    ramMb: eff.ramMb,
    jvmArgs: eff.jvmArgs,
    launcherVersion: app.getVersion(),
  });
  // partie en cours : aucune mise à jour tant que le jeu n'est pas fermé
  games.set(result.child, eff.gameDir);
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
  if (process.env.ATTACK_SCREENSHOT_DIR) {
    // mode capture : les avertissements et erreurs de la page (CSP comprise) sont repris dans la sortie, pour ne rien laisser passer
    win.webContents.on('console-message', (...args) => {
      const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (['warning', 'error', 2, 3].includes(detail.level)) console.error(`[page ${detail.level}] ${detail.message}`);
    });
    win.webContents.once('did-finish-load', () => captureScreens());
  }
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
  // capturePage peut rendre l'image précédente quand la fenêtre n'a pas le focus : une première capture jetée force le rendu à jour
  const shot = async (name) => {
    win.webContents.invalidate();
    await wait(250);
    await win.webContents.capturePage();
    await wait(150);
    return fsp.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  for (const page of ['home', 'mods', 'settings', 'account']) {
    await win.webContents.executeJavaScript(`window.showPage && window.showPage(${JSON.stringify(page)})`);
    await wait(500);
    await shot(page);
    if (page === 'settings') {
      // bas de la page (pack de mods, OptiFine) quand elle dépasse la fenêtre
      await js("document.getElementById('page-settings').scrollTop = 9999");
      await wait(300);
      await shot('settings-bas');
      await js("document.getElementById('page-settings').scrollTop = 0");
    }
  }
  // détail de la ligne « prêt » de l'accueil, onglets Launcher et Avancé des réglages, crédits des mods
  await js("window.showPage('home'); document.getElementById('ready-btn').click()");
  await wait(400);
  await shot('home-details');
  await js("document.getElementById('ready-btn').click()");
  for (const tab of ['launcher', 'advanced']) {
    await js(`window.showPage('settings'); window.selectSettingsTab(${JSON.stringify(tab)})`);
    await wait(400);
    await shot(`settings-${tab}`);
  }
  await js("window.selectSettingsTab('launcher'); document.getElementById('credits-open').click()");
  await wait(400);
  await shot('credits');
  await js("document.getElementById('credits-close').click(); window.selectSettingsTab('profile')");
  if (process.env.ATTACK_SCREENSHOT_JVM) {
    // champ « Arguments Java » : un argument refusé (message sous le champ), puis un argument accepté
    await js("window.showPage && window.showPage('settings'); window.selectSettingsTab('advanced')");
    for (const [name, value] of [['jvm-refused', '-javaagent:C:\\evil.jar'], ['jvm-saved', '-XX:+UseStringDeduplication']]) {
      await js(`(() => { const f = document.getElementById('jvm-args'); f.value = ${JSON.stringify(value)};
        document.getElementById('jvm-args-save').click(); f.scrollIntoView({ block: 'center' }); })()`);
      await wait(1500);
      await fsp.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    }
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
    lastRefreshError = null;
  } catch (error) {
    lastRefreshError = { code: error.code || 'ERROR', message: error.message };
  }
  send('accounts:changed', accountsView());
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
