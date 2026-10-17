'use strict';
// Test réel de la mise à jour automatique, sans GitHub ni publication :
//   node scripts/update-test.js <dossier de travail> [--keep]
// 1. Construit deux installateurs de test (0.2.0 et 0.2.1) avec le code actuel, sous un autre nom et un autre appId
//    (« ATTACK Launcher UpdateTest ») : un vrai ATTACK Launcher installé n'est jamais touché.
// 2. Sert la 0.2.1 depuis un serveur local (provider generic, http://127.0.0.1) et installe la 0.2.0 en silence
//    dans <dossier>/install.
// 3. latest.yml falsifié (SHA-512 faux) : la 0.2.0 doit rejeter le fichier téléchargé.
// 4. latest.yml correct : la 0.2.0 détecte, télécharge et propose la 0.2.1 (capture de la bannière), puis le clic
//    sur « Redémarrer » installe la 0.2.1 en silence et la relance.
// Résultat dans <dossier>/report.json. Sans --keep, l'app de test est ensuite désinstallée et ses dossiers supprimés.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const builder = require('electron-builder');
const asar = require('@electron/asar');
const pkg = require('../package.json');
const { detectRunningGame } = require('../src/main/game');

const ROOT = path.join(__dirname, '..');
const NAME = 'ATTACK Launcher UpdateTest';
const EXE = `${NAME}.exe`;
const PACKAGE_NAME = 'attack-launcher-updatetest';
const APP_ID = 'io.github.7shiki3.attacklauncher.updatetest';
const OLD = '0.2.0';
const NEW = '0.2.1';
const setupName = (version) => `ATTACK-Launcher-UpdateTest-Setup-${version}.exe`;
const appData = process.env.APPDATA;
const localAppData = process.env.LOCALAPPDATA;
const relaunchUserData = path.join(appData, NAME); // la relance par l'installateur n'hérite pas de nos variables
const updaterCache = path.join(localAppData, `${PACKAGE_NAME}-updater`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message) => console.log(`[update-test] ${message}`);

/** Serveur de mise à jour local : sert les fichiers (à plat) de `server.root` et note chaque requête. */
function startServer(requests) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const file = path.join(server.root, name);
    const ok = /^[\w.-]+$/.test(name) && fs.existsSync(file);
    requests.push(`${new Date().toISOString()} ${req.method} /${name} ${ok ? 200 : 404}`);
    if (!ok) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Length': fs.statSync(file).size, 'Content-Type': 'application/octet-stream' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Installateur NSIS de test : même code et même config que la release, nom et appId à part, flux generic local. */
async function buildVersion(version, outDir, feedUrl) {
  const config = {
    ...pkg.build,
    appId: APP_ID,
    productName: NAME,
    directories: { output: outDir, buildResources: 'build' },
    extraMetadata: { name: PACKAGE_NAME, productName: NAME, version },
    publish: [{ provider: 'generic', url: feedUrl }],
    win: { ...pkg.build.win, target: ['nsis'] },
    nsis: {
      ...pkg.build.nsis,
      shortcutName: NAME,
      createDesktopShortcut: false,
      createStartMenuShortcut: false,
      artifactName: 'ATTACK-Launcher-UpdateTest-Setup-${version}.${ext}',
    },
  };
  delete config.portable;
  // fichier à part : un objet passé directement serait fusionné avec le "build" de package.json (publish github)
  const configFile = path.join(path.dirname(outDir), `builder-${version}.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  say(`construction de la ${version}…`);
  await builder.build({ projectDir: ROOT, targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64), config: configFile, publish: 'never' });
  for (const file of ['latest.yml', setupName(version), `${setupName(version)}.blockmap`]) {
    if (!fs.existsSync(path.join(outDir, file))) throw new Error(`${file} absent de ${outDir}`);
  }
}

function installedVersion(installDir) {
  const archive = path.join(installDir, 'resources', 'app.asar');
  if (!fs.existsSync(archive)) return null;
  try {
    return JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version;
  } catch {
    return null; // archive en cours de remplacement
  }
}

function testAppRunning() {
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return out.split(/\r?\n/).some((line) => line.startsWith(`"${EXE}"`));
}

function readLog(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Lance l'app de test installée dans des dossiers isolés et attend sa fermeture (elle se ferme seule en mode capture). */
function runApp(installDir, env, timeoutMs) {
  const result = spawnSync(path.join(installDir, EXE), [], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: timeoutMs });
  return result.status;
}

async function waitFor(check, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(stepMs);
  }
  return null;
}

/**
 * Une vraie partie en cours ferait (à raison) reporter la mise à jour, et la fenêtre de test gênerait le joueur :
 * on attend la fin de la partie avant d'ouvrir l'app de test.
 */
async function waitForNoGame() {
  if (!(await detectRunningGame())) return;
  say('partie d\'ATTACK Client en cours : attente de sa fin avant d\'ouvrir l\'app de test…');
  if (!(await waitFor(async () => !(await detectRunningGame()), 6 * 3600 * 1000, 30000))) throw new Error('Partie toujours en cours après 6 h');
  say('partie terminée, reprise du test');
}

async function uninstall(installDir) {
  if (testAppRunning()) spawnSync('taskkill', ['/IM', EXE, '/F', '/T'], { stdio: 'ignore' });
  const uninstaller = path.join(installDir, `Uninstall ${NAME}.exe`);
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/currentuser', '/S'], { stdio: 'ignore', timeout: 120000 });
    // le désinstalleur se recopie dans %TEMP% et continue après la fin de ce processus
    await waitFor(() => !fs.existsSync(path.join(installDir, EXE)), 60000);
  }
  for (const dir of [updaterCache, relaunchUserData]) fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const work = path.resolve(process.argv[2] || '');
  const keep = process.argv.includes('--keep');
  if (!process.argv[2]) throw new Error('Usage : node scripts/update-test.js <dossier de travail> [--keep]');
  fs.mkdirSync(work, { recursive: true });
  const dirs = {
    oldBuild: path.join(work, `build-${OLD}`),
    newBuild: path.join(work, `build-${NEW}`),
    goodFeed: path.join(work, 'feed-ok'),
    badFeed: path.join(work, 'feed-sha512-faux'),
    install: path.join(work, 'install'),
    userData: path.join(work, 'userdata'),
    minecraft: path.join(work, '.minecraft'),
    shots: path.join(work, 'captures'),
  };
  for (const dir of [dirs.goodFeed, dirs.badFeed, dirs.userData, dirs.shots]) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify({ gameDir: path.join(work, '.attack'), lang: 'fr' }));

  const requests = [];
  const server = await startServer(requests);
  const feedUrl = `http://127.0.0.1:${server.address().port}/`;
  say(`serveur de mise à jour : ${feedUrl}`);
  const report = { feedUrl, steps: {} };
  try {
    await buildVersion(NEW, dirs.newBuild, feedUrl);
    await buildVersion(OLD, dirs.oldBuild, feedUrl);

    // flux correct : ce qu'une release GitHub contiendrait (latest.yml, Setup.exe, .blockmap)
    for (const file of ['latest.yml', setupName(NEW), `${setupName(NEW)}.blockmap`]) {
      fs.copyFileSync(path.join(dirs.newBuild, file), path.join(dirs.goodFeed, file));
    }
    // flux falsifié : même exe, SHA-512 annoncé faux
    const fakeSha = crypto.createHash('sha512').update('fichier falsifié').digest('base64');
    const latest = fs.readFileSync(path.join(dirs.goodFeed, 'latest.yml'), 'utf8');
    fs.writeFileSync(path.join(dirs.badFeed, 'latest.yml'), latest.replace(/sha512: .+/g, `sha512: ${fakeSha}`));
    fs.copyFileSync(path.join(dirs.goodFeed, setupName(NEW)), path.join(dirs.badFeed, setupName(NEW)));
    report.latestYml = latest;

    say(`installation silencieuse de la ${OLD} dans ${dirs.install}…`);
    await uninstall(dirs.install);
    const setup = spawnSync(path.join(dirs.oldBuild, setupName(OLD)), ['/S', `/D=${dirs.install}`], {
      stdio: 'ignore', timeout: 300000, windowsVerbatimArguments: true,
    });
    report.steps.installOld = { exitCode: setup.status, version: installedVersion(dirs.install) };
    if (report.steps.installOld.version !== OLD) throw new Error(`Installation de la ${OLD} ratée (${JSON.stringify(report.steps.installOld)})`);

    const appLog = path.join(dirs.userData, 'logs', 'updater.log');
    const env = { ATTACK_USER_DATA: dirs.userData, ATTACK_MINECRAFT_DIR: dirs.minecraft };

    // 3. SHA-512 faux : le fichier téléchargé doit être rejeté, aucune bannière
    await waitForNoGame();
    say('scénario 1 : latest.yml au SHA-512 falsifié…');
    server.root = dirs.badFeed;
    const badShots = path.join(dirs.shots, 'sha512-faux');
    const badExit = runApp(dirs.install, { ...env, ATTACK_SCREENSHOT_DIR: badShots, ATTACK_SCREENSHOT_UPDATE: '1' }, 300000);
    const badLog = readLog(appLog);
    report.steps.tampered = {
      exitCode: badExit,
      rejected: /sha512 checksum mismatch/i.test(badLog),
      noBanner: fs.existsSync(path.join(badShots, `update-${OLD}-error.png`)),
      offeredUpdate: badLog.includes(`Mise à jour ${NEW} prête`),
      installedVersion: installedVersion(dirs.install),
    };

    // 4. flux correct : détection, téléchargement, bannière, puis Redémarrer
    await waitForNoGame();
    say('scénario 2 : latest.yml correct, puis clic sur Redémarrer…');
    server.root = dirs.goodFeed;
    fs.rmSync(relaunchUserData, { recursive: true, force: true });
    const goodShots = path.join(dirs.shots, 'mise-a-jour');
    const goodExit = runApp(dirs.install, { ...env, ATTACK_SCREENSHOT_DIR: goodShots, ATTACK_SCREENSHOT_UPDATE: 'install' }, 300000);
    const goodLog = readLog(appLog).slice(badLog.length);
    const upgraded = await waitFor(() => installedVersion(dirs.install) === NEW, 180000);
    const relaunched = await waitFor(() => testAppRunning(), 60000);
    const relaunchLogFile = path.join(relaunchUserData, 'logs', 'updater.log');
    const relaunchLog = (await waitFor(() => {
      const text = readLog(relaunchLogFile);
      return /À jour|Échec/.test(text) ? text : null;
    }, 90000)) || readLog(relaunchLogFile);
    report.steps.update = {
      exitCode: goodExit,
      detected: goodLog.includes(`Téléchargement de la version ${NEW}`),
      downloaded: goodLog.includes(`Mise à jour ${NEW} prête`),
      // capture prise pendant que la bannière « prête » était affichée (phase dans le nom du fichier)
      bannerScreenshot: fs.existsSync(path.join(goodShots, `update-${OLD}-ready.png`)) ? path.join(goodShots, `update-${OLD}-ready.png`) : null,
      restartClicked: goodLog.includes(`Redémarrage pour installer la version ${NEW}`),
      installedVersion: installedVersion(dirs.install),
      upgraded: Boolean(upgraded),
      relaunched: Boolean(relaunched),
      relaunchedUpToDate: relaunchLog.includes(`Launcher ${NEW}, mode nsis`) && relaunchLog.includes('À jour'),
    };
    report.logs = { app: readLog(appLog), relaunch: relaunchLog };
  } finally {
    report.requests = requests;
    server.close();
    fs.writeFileSync(path.join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (!keep) {
      say('désinstallation de l\'app de test…');
      await uninstall(dirs.install);
      report.cleanedUp = !fs.existsSync(path.join(dirs.install, EXE));
      fs.writeFileSync(path.join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
  }

  const { tampered, update } = report.steps;
  const checks = {
    'SHA-512 faux rejeté': tampered.rejected && tampered.noBanner && !tampered.offeredUpdate && tampered.installedVersion === OLD,
    [`${NEW} détectée et téléchargée`]: update.detected && update.downloaded,
    'bannière capturée': Boolean(update.bannerScreenshot),
    [`Redémarrer installe la ${NEW}`]: update.restartClicked && update.upgraded,
    [`${NEW} relancée et à jour`]: update.relaunched && update.relaunchedUpToDate,
  };
  for (const [label, ok] of Object.entries(checks)) say(`${ok ? 'OK ' : 'ÉCHEC'} ${label}`);
  say(`rapport : ${path.join(work, 'report.json')}`);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}

main().catch((error) => {
  console.error(`[update-test] ${error.stack || error.message}`);
  process.exit(1);
});
