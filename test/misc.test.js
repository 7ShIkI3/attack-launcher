'use strict';
// Release GitHub du mod, jar de développement, réglages, choix du launcher officiel, progression.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const mod = require('../src/main/mod');
const settings = require('../src/main/settings');
const launch = require('../src/main/launch');
const installer = require('../src/main/installer');

const HASH = 'ab'.repeat(32);

test('release GitHub : SHA-256 depuis le champ digest', () => {
  const asset = mod.parseRelease({
    tag_name: 'v2.0.0',
    assets: [
      { name: 'attack-client-2.0.0-sources.jar', browser_download_url: 'https://github.com/x/sources' },
      { name: 'attack-client-2.0.0.jar', size: 1234, digest: `sha256:${HASH.toUpperCase()}`, browser_download_url: 'https://github.com/x/jar' },
    ],
  });
  assert.deepEqual(asset, {
    version: 'v2.0.0', name: 'attack-client-2.0.0.jar', url: 'https://github.com/x/jar', size: 1234,
    sha256: HASH, sha256Url: null, sha256File: null,
  });
});

test('release GitHub : SHA-256 depuis un fichier .sha256, et refus sans hash', () => {
  const asset = mod.parseRelease({
    tag_name: 'v2.1.0',
    assets: [
      { name: 'attack-client.jar', size: 1, browser_download_url: 'https://github.com/x/jar' },
      { name: 'attack-client.jar.sha256', browser_download_url: 'https://github.com/x/sha' },
    ],
  });
  assert.equal(asset.sha256, null);
  assert.equal(asset.sha256Url, 'https://github.com/x/sha');
  assert.equal(mod.sha256For(`${HASH}  attack-client.jar\n`, 'attack-client.jar'), HASH);
  assert.equal(mod.sha256For(`${'cd'.repeat(32)} *autre.jar\n${HASH} *attack-client.jar`, 'attack-client.jar'), HASH);
  assert.throws(() => mod.parseRelease({ assets: [{ name: 'attack-client.jar' }] }), /SHA-256/);
  assert.throws(() => mod.parseRelease({ assets: [] }), /pas de jar/);
  assert.throws(() => mod.parseSha256File('rien'), /hash/);
});

test('jar de développement : le plus récent, sans -sources', () => {
  const dir = tempDir();
  const write = (name, mtime) => {
    fs.writeFileSync(path.join(dir, name), name);
    fs.utimesSync(path.join(dir, name), mtime, mtime);
  };
  write('attack-client-1.9.0.jar', new Date('2026-01-01'));
  write('attack-client-2.0.0.jar', new Date('2026-06-01'));
  write('attack-client-2.0.0-sources.jar', new Date('2026-07-01'));
  write('autre-mod.jar', new Date('2026-08-01'));
  assert.equal(mod.findDevJar(dir).name, 'attack-client-2.0.0.jar');
  assert.equal(mod.versionFromJarName('attack-client-2.0.0.jar'), '2.0.0');
  assert.equal(mod.findDevJar(path.join(dir, 'absent')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('réglages : bornes, chemins absolus, langue (réglages à plat du profil courant)', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  const base = settings.defaults(env);
  const view = (input) => settings.forProfile(settings.sanitize(input, base));
  assert.equal(settings.forProfile(base).gameDir, path.join('C:\\Users\\x\\AppData\\Roaming', '.attack'));
  assert.equal(view({ ramMb: 100 }).ramMb, settings.RAM_MIN);
  assert.equal(view({ ramMb: 999999 }).ramMb, settings.RAM_MAX);
  assert.equal(view({ ramMb: '3000' }).ramMb, 3072);
  assert.equal(view({ lang: 'de' }).lang, 'fr');
  assert.equal(view({ lang: 'en' }).lang, 'en');
  assert.equal(view({ gameDir: 'relatif\\dossier' }).gameDir, settings.forProfile(base).gameDir);
  assert.equal(view({ javaPath: 'C:\\Windows\\notepad.exe' }).javaPath, '');
  assert.equal(view({ javaPath: 'C:\\Java\\bin\\javaw.exe' }).javaPath, 'C:\\Java\\bin\\javaw.exe');
  assert.equal(view({ javaPath: 'C:\\Java\\bin\\java.exe' }).javaPath, 'C:\\Java\\bin\\java.exe');
  assert.equal(view({ javaPath: 'C:\\x\\notjava.exe' }).javaPath, '');
  assert.equal(view({ devMode: 'oui' }).devMode, false);
  assert.equal(settings.sanitize({ hack: 1 }, base).hack, undefined);
});

test('launcher officiel : version Xbox/Store, puis ancien .exe, sinon Store par défaut', () => {
  const env = { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const xbox = launch.launchPlan((p) => p.includes('XboxGames'), env);
  assert.equal(xbox.kind, 'store');
  assert.deepEqual(xbox.args, [`shell:AppsFolder\\${launch.STORE_APP_ID}`]);
  assert.ok(xbox.detected);
  const classic = launch.launchPlan((p) => p.endsWith('MinecraftLauncher.exe') && p.includes('(x86)'), env);
  assert.equal(classic.kind, 'exe');
  assert.equal(classic.command, path.join('C:\\Program Files (x86)', 'Minecraft Launcher', 'MinecraftLauncher.exe'));
  const none = launch.launchPlan(() => false, env);
  assert.equal(none.kind, 'store');
  assert.equal(none.detected, false);
});

test('progression globale croissante de 0 à 100 %', () => {
  const seen = [];
  const report = installer.progressReporter((p) => seen.push(p.percent));
  report('minecraft', 0, 3);
  report('assets', 0, 10);
  report('assets', 5, 10);
  report('assets', 10, 10);
  report('profile', 1, 1);
  assert.equal(seen[0], 0);
  assert.equal(seen.at(-1), 100);
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]));
});

test('état d’installation sur un dossier vide', async () => {
  const dir = tempDir();
  const status = await installer.status({ minecraftDir: path.join(dir, 'mc'), gameDir: path.join(dir, 'game') });
  assert.deepEqual(
    { minecraft: status.minecraft, forge: status.forge, mod: status.mod, profile: status.profile, installed: status.installed },
    { minecraft: false, forge: false, mod: false, profile: false, installed: false },
  );
  assert.equal(status.modVersion, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version du mod affichée : celle du jar, sans « v » en double', async () => {
  const url = 'https://github.com/7ShIkI3/attack-launcher/releases/download/v0.3.0/attack-client-2.1.0.jar';
  assert.equal(mod.installedVersion({ source: 'release', version: 'v0.3.0', file: url }), '2.1.0');
  assert.equal(mod.installedVersion({ source: 'dev', version: '2.0.0', file: 'C:\\mod\\build\\libs\\attack-client-2.0.0.jar' }), '2.0.0');
  assert.equal(mod.installedVersion({ source: 'release', version: 'v2.1.0', file: 'https://github.com/x/attack-client.jar' }), '2.1.0');
  assert.equal(mod.installedVersion(null), null);

  // installation faite avant le correctif : l'état garde le tag du launcher comme version
  const dir = tempDir();
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'attack-launcher.json'), JSON.stringify({ mod: { source: 'release', version: 'v0.3.0', file: url } }));
  const status = await installer.status({ minecraftDir: path.join(dir, 'mc'), gameDir });
  assert.equal(status.modVersion, '2.1.0');
  fs.rmSync(dir, { recursive: true, force: true });
});
