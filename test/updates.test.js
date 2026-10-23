'use strict';
// Mise à jour du launcher : comparaison de versions, choix NSIS ou portable, rien pendant une partie
// ni pendant une installation (vérification, téléchargement, redémarrage, fermeture), détection d'une partie.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const updates = require('../src/main/updates');
const game = require('../src/main/game');

const { compareVersions, isNewer, updateMode, UpdateController, CHECK_INTERVAL_MS, BUSY_RETRY_MS, RELEASES_URL } = updates;

test('versions : ordre semver, préfixe v, préversions', () => {
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1); // numérique, pas alphabétique
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0);
  // ordre de la spécification semver 2.0.0
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1, `${ordered[i]} > ${ordered[i - 1]}`);
  }
  assert.throws(() => compareVersions('1.0', '1.0.0'), /illisible : 1\.0$/);
  assert.throws(() => compareVersions('1.0.0', 'latest'), /illisible : latest/);
});

test('versions : isNewer strict, faux pour une version illisible', () => {
  assert.equal(isNewer('0.3.0', '0.2.0'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('0.3.0-beta.1', '0.2.0'), true);
  assert.equal(isNewer('0.3.0-beta.1', '0.3.0'), false);
  assert.equal(isNewer('n/a', '0.2.0'), false);
  assert.equal(isNewer(undefined, '0.2.0'), false);
});

test('mode : NSIS si un désinstalleur est à côté de l\'exe, sinon portable ; rien depuis les sources', () => {
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\ATTACK Launcher\\ATTACK Launcher.exe';
  const seen = [];
  const listDir = (files) => (dir) => {
    seen.push(dir);
    return files;
  };
  const base = { isPackaged: true, platform: 'win32', env: {}, execPath: exe };
  assert.equal(updateMode({ ...base, listDir: listDir(['ATTACK Launcher.exe', 'Uninstall ATTACK Launcher.exe']) }), 'nsis');
  assert.equal(seen[0], 'C:\\Users\\x\\AppData\\Local\\Programs\\ATTACK Launcher');
  // exe portable : variables posées par le lanceur portable d'electron-builder, même si un désinstalleur traîne
  assert.equal(updateMode({ ...base, env: { PORTABLE_EXECUTABLE_FILE: 'D:\\ATTACK-Launcher-Portable-0.3.0.exe' }, listDir: listDir(['Uninstall ATTACK Launcher.exe']) }), 'portable');
  assert.equal(updateMode({ ...base, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' }, listDir: listDir([]) }), 'portable');
  // dossier copié à la main (win-unpacked) : pas d'installateur à relancer
  assert.equal(updateMode({ ...base, listDir: listDir(['ATTACK Launcher.exe', 'resources']) }), 'portable');
  assert.equal(updateMode({ ...base, listDir: () => { throw new Error('EACCES'); } }), 'portable');
  assert.equal(updateMode({ ...base, isPackaged: false, listDir: listDir(['Uninstall ATTACK Launcher.exe']) }), 'off');
  assert.equal(updateMode({ ...base, platform: 'linux', listDir: listDir(['Uninstall ATTACK Launcher.exe']) }), 'off');
});

// --- faux electron-updater et fausses horloges ---

function fakeUpdater({ latest = '0.3.0', checkError = null } = {}) {
  const u = new EventEmitter();
  u.checks = 0;
  u.downloads = [];
  u.installs = [];
  u.checkForUpdates = async () => {
    u.checks++;
    if (checkError) throw checkError;
    return latest ? { updateInfo: { version: latest } } : null;
  };
  // le téléchargement reste en cours jusqu'à finish() ou jusqu'à l'annulation du jeton
  u.downloadUpdate = (token) => new Promise((resolve, reject) => {
    const download = { token, finish: resolve };
    token.onCancel = () => reject(new Error('cancelled'));
    u.downloads.push(download);
  });
  u.quitAndInstall = (...args) => u.installs.push(args);
  return u;
}

function fakeToken() {
  return {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      this.onCancel?.();
    },
  };
}

function fakeTimers() {
  const timers = { timeouts: [], intervals: [] };
  timers.setTimeout = (fn, ms) => {
    const entry = { fn, ms, cleared: false, fired: false };
    timers.timeouts.push(entry);
    return entry;
  };
  timers.fire = (entry) => {
    entry.fired = true;
    entry.fn();
  };
  timers.clearTimeout = (entry) => {
    if (entry) entry.cleared = true;
  };
  timers.setInterval = (fn, ms) => {
    const entry = { fn, ms };
    timers.intervals.push(entry);
    return entry;
  };
  timers.clearInterval = () => {};
  timers.pending = () => timers.timeouts.filter((t) => !t.cleared && !t.fired);
  return timers;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function controller({ mode = 'nsis', updater = fakeUpdater(), busy = null, currentVersion = '0.2.0' } = {}) {
  const states = [];
  const timers = fakeTimers();
  const box = { reason: busy };
  const c = new UpdateController({
    updater,
    mode,
    currentVersion,
    busy: async () => box.reason,
    onState: (state) => states.push(state.phase),
    createToken: fakeToken,
    timers,
  });
  return { c, updater, states, timers, box };
}

test('NSIS : vérifie au démarrage puis toutes les 6 h, télécharge en arrière-plan, puis « prête »', async () => {
  const { c, updater, states, timers } = controller();
  c.start();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, CHECK_INTERVAL_MS);
  assert.equal(CHECK_INTERVAL_MS, 6 * 3600 * 1000);
  await tick();
  assert.equal(updater.checks, 1);
  assert.equal(c.state.phase, 'downloading');
  updater.emit('download-progress', { percent: 42.7 });
  assert.equal(c.state.percent, 42);
  updater.downloads[0].finish();
  await tick();
  assert.equal(c.state.phase, 'ready');
  assert.equal(c.state.version, '0.3.0');
  assert.deepEqual(states, ['checking', 'downloading', 'downloading', 'ready']);
  // une fois prête, les vérifications suivantes ne retéléchargent rien
  await timers.intervals[0].fn();
  assert.equal(updater.checks, 1);
  assert.deepEqual(await c.install(), { ok: true });
  assert.deepEqual(updater.installs, [[true, true]]); // installation silencieuse puis relance
});

test('portable : simple avis avec le lien Releases, aucun téléchargement', async () => {
  const { c, updater } = controller({ mode: 'portable' });
  await c.check();
  assert.equal(c.state.phase, 'available');
  assert.equal(c.state.version, '0.3.0');
  assert.equal(c.state.url, RELEASES_URL);
  assert.equal(RELEASES_URL, 'https://github.com/7ShIkI3/attack-launcher/releases/latest');
  assert.equal(updater.downloads.length, 0);
  assert.deepEqual(await c.install(), { ok: false, code: 'NO_UPDATE' });
  assert.equal(updater.installs.length, 0);
});

test('déjà à jour, ou version publiée plus ancienne : rien à faire', async () => {
  for (const latest of ['0.2.0', '0.1.0', null]) {
    const { c, updater } = controller({ updater: fakeUpdater({ latest }) });
    await c.check();
    assert.equal(c.state.phase, 'none', String(latest));
    assert.equal(updater.downloads.length, 0);
  }
});

test('échec réseau : phase error, sans planter', async () => {
  const { c } = controller({ updater: fakeUpdater({ checkError: new Error('net::ERR_INTERNET_DISCONNECTED') }) });
  await c.check();
  assert.equal(c.state.phase, 'error');
  assert.match(c.state.message, /DISCONNECTED/);
});

test('depuis les sources (off) : aucune vérification', async () => {
  const { c, timers } = controller({ mode: 'off', updater: null });
  c.start();
  assert.equal(timers.intervals.length, 0);
  assert.equal((await c.check()).phase, 'off');
});

test('partie en cours : pas de vérification ; nouvel essai plus tard, ou dès la fin de la partie', async () => {
  const { c, updater, timers, box } = controller({ busy: 'game' });
  await c.check();
  assert.equal(updater.checks, 0);
  assert.equal(c.state.phase, 'waiting');
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].ms, BUSY_RETRY_MS);
  // toujours en partie au nouvel essai : on attend encore
  timers.fire(timers.pending()[0]);
  await tick();
  assert.equal(updater.checks, 0);
  assert.equal(timers.pending().length, 1);
  // partie terminée : la vérification reportée repart tout de suite
  box.reason = null;
  c.activityEnded();
  await tick();
  assert.equal(updater.checks, 1);
  assert.equal(c.state.phase, 'downloading');
  assert.equal(timers.pending().length, 0);
});

test('installation en cours : ni vérification ni téléchargement', async () => {
  const { c, updater } = controller({ busy: 'install' });
  await c.check();
  assert.equal(updater.checks, 0);
  assert.equal(updater.downloads.length, 0);
  assert.equal(c.state.phase, 'waiting');
});

test('une partie démarre pendant le téléchargement : il est annulé, puis repris après la partie', async () => {
  const { c, updater, box } = controller();
  const checking = c.check();
  await tick();
  assert.equal(c.state.phase, 'downloading');
  box.reason = 'game';
  c.activityStarted('game');
  await checking;
  assert.equal(updater.downloads[0].token.cancelled, true);
  assert.equal(c.state.phase, 'waiting');
  assert.equal(updater.installs.length, 0);
  box.reason = null;
  c.activityEnded();
  await tick();
  assert.equal(updater.downloads.length, 2);
  updater.downloads[1].finish();
  await tick();
  assert.equal(c.state.phase, 'ready');
});

test('Redémarrer pendant une partie ou une installation : refusé, rien n\'est installé', async () => {
  const { c, updater, box } = controller();
  const checking = c.check();
  await tick();
  updater.downloads[0].finish();
  await checking;
  assert.equal(c.state.phase, 'ready');
  box.reason = 'game';
  assert.deepEqual(await c.install(), { ok: false, code: 'GAME_RUNNING' });
  box.reason = 'install';
  assert.deepEqual(await c.install(), { ok: false, code: 'BUSY' });
  assert.equal(updater.installs.length, 0);
  box.reason = null;
  assert.deepEqual(await c.install(), { ok: true });
  assert.equal(updater.installs.length, 1);
  assert.equal(c.needsQuitCheck(), false); // quitAndInstall gère lui-même la fermeture
});

test('Redémarrer échoue (installateur bloqué) : la mise à jour reste prête, l’erreur est renvoyée à la bannière', async () => {
  const { c, updater } = controller();
  c.start();
  await tick();
  updater.downloads[0].finish();
  await tick();
  assert.equal(c.state.phase, 'ready');
  updater.quitAndInstall = () => {
    throw new Error('installateur introuvable');
  };
  assert.deepEqual(await c.install(), { ok: false, code: 'INSTALL_FAILED', message: 'installateur introuvable' });
  assert.equal(c.state.phase, 'ready');
  // erreur asynchrone d'electron-updater pendant une tentative : toujours proposée
  updater.emit('error', new Error('refusé par l’antivirus'));
  assert.equal(c.state.phase, 'ready');
  c.stop();
});

test('fermeture avec une mise à jour prête : installée seulement si aucune partie ne tourne', async () => {
  for (const [reason, expected] of [['game', false], [null, true]]) {
    const { c, updater, box } = controller();
    const checking = c.check();
    await tick();
    updater.downloads[0].finish();
    await checking;
    assert.equal(c.needsQuitCheck(), true);
    box.reason = reason;
    await c.prepareQuit();
    assert.equal(updater.autoInstallOnAppQuit, expected, String(reason));
    assert.equal(c.needsQuitCheck(), false); // la 2e fermeture passe sans attendre
  }
  // rien de prêt : la fermeture n'attend pas
  const { c } = controller();
  assert.equal(c.needsQuitCheck(), false);
});

test('détection d\'une partie : ligne de commande Java avec la version Forge du launcher', async () => {
  const forge = '"C:\\runtime\\bin\\javaw.exe" -Xmx3072M -cp a.jar net.minecraft.launchwrapper.Launch --username Steve --version 1.8.9-forge1.8.9-11.15.1.2318-1.8.9 --gameDir C:\\Users\\x\\AppData\\Roaming\\.attack';
  const gradle = '"C:\\jdk\\bin\\java.exe" -Xmx2g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.14';
  assert.equal(game.isGameCommandLine(`${gradle}\r\n${forge}\r\n`), true);
  assert.equal(game.isGameCommandLine(`${gradle}\r\n`), false);
  assert.equal(game.isGameCommandLine(''), false);
  assert.equal(game.isGameCommandLine(undefined), false);

  const calls = [];
  const run = (output, error = null) => (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, output);
  };
  assert.equal(await game.detectRunningGame({ platform: 'win32', run: run(forge) }), true);
  assert.equal(await game.detectRunningGame({ platform: 'win32', run: run(gradle) }), false);
  // PowerShell indisponible : on ne bloque pas les mises à jour
  assert.equal(await game.detectRunningGame({ platform: 'win32', run: run('', new Error('ENOENT')) }), false);
  assert.equal(await game.detectRunningGame({ platform: 'linux', run: run(forge) }), false);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true);
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), game.JAVA_PROCESSES_PS);

  // mêmes lignes en liste (pour comparer leur --gameDir) ; PowerShell indisponible ou autre système : liste vide
  assert.deepEqual(await game.runningGameLines({ platform: 'win32', run: run(`${gradle}\r\n${forge}\r\n`) }), [forge]);
  assert.deepEqual(await game.runningGameLines({ platform: 'win32', run: run('', new Error('ENOENT')) }), []);
  assert.deepEqual(await game.runningGameLines({ platform: 'linux', run: run(forge) }), []);
});

test('installation : seule une partie jouée dans le dossier de jeu du profil bloque, lancée ici ou par le launcher officiel', () => {
  const forgeDir = 'C:\\Users\\x\\AppData\\Roaming\\.attack';
  const f121Dir = `${forgeDir}\\profiles\\fabric-1.21.1`;
  const f263Dir = `${forgeDir}\\profiles\\fabric-26.3`;
  const FORGE_ID = '1.8.9-forge1.8.9-11.15.1.2318-1.8.9';
  const line = (versionId, gameDir) => `"C:\\runtime\\bin\\javaw.exe" -Xmx3072M -cp a.jar net.minecraft.client.main.Main --username Steve --version ${versionId} --gameDir ${gameDir} --assetsDir C:\\Users\\x\\AppData\\Roaming\\.minecraft\\assets`;

  // --gameDir lu dans la ligne de commande : sans guillemets, entre guillemets (espaces), en fin de ligne, avec « = »
  assert.equal(game.gameDirOfCommandLine(line(FORGE_ID, forgeDir)), forgeDir);
  assert.equal(game.gameDirOfCommandLine(line(FORGE_ID, '"C:\\Users\\Jean Dupont\\AppData\\Roaming\\.attack"')), 'C:\\Users\\Jean Dupont\\AppData\\Roaming\\.attack');
  assert.equal(game.gameDirOfCommandLine(`javaw.exe Main --version x --gameDir ${forgeDir}  `), forgeDir);
  assert.equal(game.gameDirOfCommandLine(`javaw.exe Main --gameDir=${f121Dir} --version x`), f121Dir);
  assert.equal(game.gameDirOfCommandLine('javaw.exe Main --version x'), null, 'absent');
  assert.equal(game.gameDirOfCommandLine('javaw.exe Main --gameDir .attack --version x'), null, 'chemin relatif');
  assert.equal(game.gameDirOfCommandLine('javaw.exe Main --gameDir --assetsDir C:\\a'), null, 'valeur manquante');

  // partie du launcher officiel (ligne de commande seulement) : bloque son dossier, pas celui d'un autre profil
  const official = [line(FORGE_ID, forgeDir)];
  assert.equal(game.gameBlocksInstall(forgeDir, [], official), true);
  assert.equal(game.gameBlocksInstall(f121Dir, [], official), false, 'le dossier de Forge contient celui de Fabric mais ce n’est pas le même');
  assert.equal(game.gameBlocksInstall(f263Dir, [], official), false);
  assert.equal(game.gameBlocksInstall(forgeDir, [], [line('fabric-loader-0.19.5-1.21.1', f121Dir)]), false, 'Fabric 1.21.1 ne gêne pas Forge');
  assert.equal(game.gameBlocksInstall(f121Dir, [], [line('fabric-loader-0.19.5-1.21.1', f121Dir), line(FORGE_ID, forgeDir)]), true);
  // casse, séparateur final et « .. » ne changent rien
  assert.equal(game.gameBlocksInstall('c:\\USERS\\X\\appdata\\roaming\\.ATTACK\\', [], official), true);
  assert.equal(game.gameBlocksInstall(`${f121Dir}\\..\\..`, [], official), true);
  assert.equal(game.gameBlocksInstall(f121Dir.toUpperCase(), [], [line('fabric-loader-0.19.5-1.21.1', f121Dir.toLowerCase())]), true);

  // parties lancées par ce launcher : dossier mémorisé de chacune, seul celui-là bloque
  assert.equal(game.gameBlocksInstall(f121Dir, [f121Dir], []), true);
  assert.equal(game.gameBlocksInstall(f121Dir, [forgeDir, f263Dir], []), false);
  assert.equal(game.gameBlocksInstall(f121Dir, [f263Dir, f121Dir.toUpperCase()], []), true);

  // comparaison impossible (pas de --gameDir lisible) : on bloque par prudence, quel que soit le dossier
  assert.equal(game.gameBlocksInstall(f121Dir, [], [`javaw.exe Main --version ${FORGE_ID}`]), true);
  assert.equal(game.gameBlocksInstall(f121Dir, [], [`javaw.exe Main --version ${FORGE_ID} --gameDir .attack`]), true);

  // aucune partie : rien ne bloque
  assert.equal(game.gameBlocksInstall(f121Dir), false);
  assert.equal(game.gameBlocksInstall(f121Dir, [], []), false);
});
