'use strict';
// Multi-profils : réglages par profil (et migration de l'ancien fichier), profils du launcher officiel, jar ATTACK de
// chaque profil dans une release, progression par chargeur, état d'installation d'un profil Fabric.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const settings = require('../src/main/settings');
const profiles = require('../src/main/profiles');
const mod = require('../src/main/mod');
const modpack = require('../src/main/modpack');
const installer = require('../src/main/installer');

const ENV = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
const GAME_121 = path.join(ENV.APPDATA, '.attack', 'profiles', 'fabric-1.21.1');

// ---------- réglages ----------

test('réglages par défaut : un dossier de jeu par profil, shaders coupés sur Fabric seulement', () => {
  const base = settings.defaults(ENV);
  assert.equal(base.profileId, 'forge-1.8.9');
  assert.deepEqual(Object.keys(base.profiles), ['forge-1.8.9', 'fabric-1.21.1', 'fabric-26.3']);
  assert.equal(settings.forProfile(base).gameDir, path.join(ENV.APPDATA, '.attack'));
  assert.equal(settings.forProfile(base, 'fabric-1.21.1').gameDir, GAME_121);
  assert.equal(settings.forProfile(base, 'fabric-26.3').gameDir, path.join(ENV.APPDATA, '.attack', 'profiles', 'fabric-26.3'));
  assert.equal('shaders' in base.profiles['forge-1.8.9'], false);
  assert.equal(base.profiles['fabric-1.21.1'].shaders, false);
  assert.equal(settings.forProfile(base).shaders, false);
  // profil inconnu : retour au profil par défaut, jamais d'exception
  assert.equal(settings.forProfile(base, 'inconnu').profileId, 'forge-1.8.9');
});

test('migration : l’ancien fichier de réglages garde son dossier de jeu pour le profil 1.8.9', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    ramMb: 3072, gameDir: 'D:\\Jeux\\attack', javaPath: 'C:\\Java\\bin\\javaw.exe', lang: 'en', devMode: true, devJarDir: 'D:\\jars', msClientId: '',
  }));
  const loaded = await settings.load(file, ENV);
  assert.equal(loaded.profileId, 'forge-1.8.9');
  const forge = settings.forProfile(loaded);
  assert.equal(forge.gameDir, 'D:\\Jeux\\attack');
  assert.equal(forge.javaPath, 'C:\\Java\\bin\\javaw.exe');
  assert.equal(forge.devJarDir, 'D:\\jars');
  assert.equal(forge.ramMb, 3072);
  assert.equal(forge.lang, 'en');
  assert.equal(forge.devMode, true);
  // les profils Fabric restent sur leurs valeurs par défaut
  const fabric = settings.forProfile(loaded, 'fabric-1.21.1');
  assert.equal(fabric.gameDir, GAME_121);
  assert.equal(fabric.javaPath, '');
  assert.equal(fabric.ramMb, 3072, 'la mémoire est globale');

  // une fois enregistré, plus de clé à plat : tout est rangé par profil, et la relecture donne la même chose
  await settings.save(file, loaded);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const legacy of ['gameDir', 'javaPath', 'devJarDir']) assert.equal(legacy in written, false, legacy);
  assert.equal(written.profiles['forge-1.8.9'].gameDir, 'D:\\Jeux\\attack');
  assert.deepEqual(await settings.load(file, ENV), loaded);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fichier de réglages absent ou illisible : valeurs par défaut', async () => {
  const dir = tempDir();
  assert.deepEqual(await settings.load(path.join(dir, 'absent.json'), ENV), settings.defaults(ENV));
  fs.writeFileSync(path.join(dir, 'casse.json'), '{ pas du json');
  assert.deepEqual(await settings.load(path.join(dir, 'casse.json'), ENV), settings.defaults(ENV));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profil choisi : validé contre le catalogue, les réglages à plat suivent le profil courant', () => {
  let s = settings.defaults(ENV);
  s = settings.sanitize({ profileId: 'fabric-26.3' }, s);
  assert.equal(s.profileId, 'fabric-26.3');
  assert.equal(settings.sanitize({ profileId: '../evil' }, s).profileId, 'fabric-26.3', 'profil inconnu ignoré');
  assert.equal(settings.sanitize({ profileId: 42 }, s).profileId, 'fabric-26.3');

  // un dossier de jeu choisi s'applique au profil courant seulement
  s = settings.sanitize({ gameDir: 'D:\\mc26' }, s);
  assert.equal(settings.forProfile(s).gameDir, 'D:\\mc26');
  assert.equal(settings.forProfile(s, 'forge-1.8.9').gameDir, path.join(ENV.APPDATA, '.attack'));
  assert.equal(settings.forProfile(s, 'fabric-1.21.1').gameDir, GAME_121);

  // Java par profil
  s = settings.sanitize({ profileId: 'forge-1.8.9', javaPath: 'C:\\Java8\\bin\\javaw.exe' }, s);
  assert.equal(settings.forProfile(s).javaPath, 'C:\\Java8\\bin\\javaw.exe');
  assert.equal(settings.forProfile(s, 'fabric-26.3').javaPath, '');

  // changement de profil et de dossier dans le même envoi : le dossier va au nouveau profil
  s = settings.sanitize({ profileId: 'fabric-1.21.1', gameDir: 'D:\\mc121' }, s);
  assert.equal(settings.forProfile(s, 'fabric-1.21.1').gameDir, 'D:\\mc121');
  assert.equal(settings.forProfile(s, 'forge-1.8.9').gameDir, path.join(ENV.APPDATA, '.attack'));
});

test('shaders : booléen, profils Fabric seulement ; dossier par défaut rétabli par une chaîne vide', () => {
  let s = settings.sanitize({ profileId: 'fabric-1.21.1', shaders: true }, settings.defaults(ENV));
  assert.equal(settings.forProfile(s).shaders, true);
  assert.equal(settings.forProfile(s, 'fabric-26.3').shaders, false, 'le réglage est propre à chaque profil');
  s = settings.sanitize({ shaders: 'oui' }, s);
  assert.equal(settings.forProfile(s).shaders, true, 'valeur non booléenne ignorée');
  const forge = settings.sanitize({ profileId: 'forge-1.8.9', shaders: true }, s);
  assert.equal(settings.forProfile(forge).shaders, false);
  assert.equal('shaders' in forge.profiles['forge-1.8.9'], false);

  s = settings.sanitize({ profileId: 'fabric-1.21.1', gameDir: 'D:\\autre' }, s);
  assert.equal(settings.forProfile(s).gameDir, 'D:\\autre');
  const reset = settings.sanitize({ gameDir: '' }, s);
  assert.equal(settings.forProfile(reset).gameDir, require('../src/main/paths').defaultGameDir(process.env, catalog.get('fabric-1.21.1')),
    'retour au dossier par défaut du profil courant');
});

test('dossier de jeu : refusé s’il est déjà celui d’un autre profil (casse et écriture du chemin ignorées), ancien dossier conservé', () => {
  const base = settings.defaults(ENV);
  const forgeDir = path.join(ENV.APPDATA, '.attack');
  const dirOf = (s, id) => settings.forProfile(s, id).gameDir;

  // Forge veut le dossier par défaut de Fabric 1.21.1, écrit de plusieurs façons
  for (const variant of [GAME_121, GAME_121.toUpperCase(), `${GAME_121}\\`, path.join(GAME_121, '..', 'fabric-1.21.1')]) {
    assert.equal(dirOf(settings.sanitize({ gameDir: variant }, base), 'forge-1.8.9'), forgeDir, variant);
  }
  // Fabric 26.3 veut le dossier par défaut de Forge, ou le dossier choisi pour un autre profil : il garde l'ancien
  let s = settings.sanitize({ profileId: 'fabric-26.3', gameDir: 'D:\\mc26' }, base);
  assert.equal(dirOf(settings.sanitize({ gameDir: forgeDir.toLowerCase() }, s), 'fabric-26.3'), 'D:\\mc26');
  s = settings.sanitize({ profileId: 'fabric-1.21.1', gameDir: 'D:\\MC26\\' }, s);
  assert.equal(dirOf(s, 'fabric-1.21.1'), GAME_121, 'dossier déjà pris par Fabric 26.3');
  assert.equal(dirOf(s, 'fabric-26.3'), 'D:\\mc26');
  // même refus pour la forme rangée par profil du fichier enregistré
  s = settings.sanitize({ profiles: { 'forge-1.8.9': { gameDir: 'd:\\mc26' } } }, s);
  assert.equal(dirOf(s, 'forge-1.8.9'), forgeDir);
  const both = settings.sanitize({ profiles: { 'forge-1.8.9': { gameDir: 'D:\\jeu' }, 'fabric-1.21.1': { gameDir: 'd:\\JEU' } } }, base);
  assert.equal(dirOf(both, 'forge-1.8.9'), 'D:\\jeu');
  assert.equal(dirOf(both, 'fabric-1.21.1'), GAME_121, 'le second profil retrouve son dossier par défaut');

  // un dossier libre, ou le dossier que le profil a déjà, reste accepté
  s = settings.sanitize({ profileId: 'fabric-1.21.1', gameDir: 'D:\\libre' }, base);
  assert.equal(dirOf(s, 'fabric-1.21.1'), 'D:\\libre');
  assert.equal(dirOf(settings.sanitize({ gameDir: 'd:\\LIBRE' }, s), 'fabric-1.21.1'), 'd:\\LIBRE');

  // retour au dossier par défaut (chaîne vide) : refusé aussi s'il a été pris entre-temps par un autre profil
  const real = settings.defaults();
  const default26 = require('../src/main/paths').defaultGameDir(process.env, catalog.get('fabric-26.3'));
  let r = settings.sanitize({ profileId: 'fabric-26.3', gameDir: 'D:\\mc26' }, real);
  r = settings.sanitize({ profileId: 'forge-1.8.9', gameDir: default26 }, r);
  assert.equal(dirOf(r, 'forge-1.8.9'), default26, 'libre : le profil 26.3 l’a quitté');
  r = settings.sanitize({ profileId: 'fabric-26.3', gameDir: '' }, r);
  assert.equal(dirOf(r, 'fabric-26.3'), 'D:\\mc26');
});

// ---------- profils du launcher officiel ----------

const NOW = new Date('2026-10-19T12:00:00.000Z');

test('relecture du fichier : un profil qui a pris le dossier par défaut d’un autre (parti ailleurs) le garde ; doublons résolus', async () => {
  const dirOf = (s, id) => settings.forProfile(s, id).gameDir;
  // à chaud : Fabric 1.21.1 déménage, puis Forge prend l'ancien dossier par défaut de Fabric 1.21.1 (libre)
  let s = settings.sanitize({ profileId: 'fabric-1.21.1', gameDir: 'D:\\x' }, settings.defaults(ENV));
  s = settings.sanitize({ profileId: 'forge-1.8.9', gameDir: GAME_121 }, s);
  assert.equal(dirOf(s, 'forge-1.8.9'), GAME_121);
  // relu depuis le disque : les deux dossiers sont conservés (avant : Forge revenait à .attack sans rien dire)
  const reread = settings.sanitize(JSON.parse(JSON.stringify(s)), settings.defaults(ENV));
  assert.equal(dirOf(reread, 'forge-1.8.9'), GAME_121);
  assert.equal(dirOf(reread, 'fabric-1.21.1'), 'D:\\x');
  assert.equal(dirOf(reread, 'fabric-26.3'), dirOf(settings.defaults(ENV), 'fabric-26.3'));
  // échange de dossiers entre deux profils dans le fichier : accepté
  const swapped = settings.sanitize({ profiles: { 'forge-1.8.9': { gameDir: GAME_121 }, 'fabric-1.21.1': { gameDir: path.join(ENV.APPDATA, '.attack') } } }, settings.defaults(ENV));
  assert.equal(dirOf(swapped, 'forge-1.8.9'), GAME_121);
  assert.equal(dirOf(swapped, 'fabric-1.21.1'), path.join(ENV.APPDATA, '.attack'));
  // fichier édité à la main avec deux fois le même dossier : le premier du catalogue le garde, l'autre revient au défaut
  const dup = settings.sanitize({ profiles: { 'fabric-1.21.1': { gameDir: 'D:\\meme' }, 'fabric-26.3': { gameDir: 'd:\\MEME\\' } } }, settings.defaults(ENV));
  assert.equal(dirOf(dup, 'fabric-1.21.1'), 'D:\\meme');
  assert.equal(dirOf(dup, 'fabric-26.3'), dirOf(settings.defaults(ENV), 'fabric-26.3'));
  // enregistrement : fichier temporaire puis renommage, pas de reste ; fichier illisible mis de côté en .corrupt
  const dir = tempDir('settings-');
  const file = path.join(dir, 'settings.json');
  await Promise.all([settings.save(file, { ...s, ramMb: 1024 }), settings.save(file, { ...s, ramMb: 4096 })]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ramMb, 4096, 'le dernier enregistrement gagne');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  fs.writeFileSync(file, '{"ramMb": 40');
  assert.equal((await settings.load(file, ENV)).ramMb, 2048);
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{"ramMb": 40');
});

test('profils du launcher officiel : un profil par version, chacun avec son id, son nom et sa version', () => {
  const options = (profile) => ({
    ...profiles.identityOf(profile), gameDir: `C:\\jeu\\${profile.id}`, ramMb: 3072, javaPath: '', icon: 'data:image/png;base64,AAAA', now: NOW,
  });
  let data = { profiles: { autre: { name: 'Autre', type: 'custom' } }, settings: { keepLauncherOpen: true }, version: 3 };
  for (const profile of catalog.list()) data = profiles.mergeProfile(data, options(profile));
  assert.deepEqual(Object.keys(data.profiles), ['autre', 'attack-client', 'attack-fabric-1.21.1', 'attack-fabric-26.3']);
  assert.equal(data.profiles.autre.name, 'Autre');
  assert.equal(data.profiles['attack-client'].name, 'ATTACK Client');
  assert.equal(data.profiles['attack-client'].lastVersionId, '1.8.9-forge1.8.9-11.15.1.2318-1.8.9');
  assert.equal(data.profiles['attack-fabric-1.21.1'].name, 'ATTACK 1.21.1');
  assert.equal(data.profiles['attack-fabric-1.21.1'].lastVersionId, 'fabric-loader-0.19.5-1.21.1');
  assert.equal(data.profiles['attack-fabric-1.21.1'].gameDir, 'C:\\jeu\\fabric-1.21.1');
  assert.equal(data.profiles['attack-fabric-26.3'].name, 'ATTACK 26.3');
  assert.equal(data.profiles['attack-fabric-26.3'].lastVersionId, 'fabric-loader-0.19.5-26.3');
  assert.match(data.profiles['attack-fabric-26.3'].javaArgs, /^-Xmx3072M /);

  // mise à jour d'un profil : les autres ne bougent pas ; « dernier utilisé » ne touche que le profil visé
  const later = new Date('2026-11-01T00:00:00.000Z');
  const again = profiles.mergeProfile(data, { ...options(catalog.get('fabric-26.3')), ramMb: 4096, now: later });
  assert.deepEqual(again.profiles['attack-client'], data.profiles['attack-client']);
  assert.deepEqual(again.profiles['attack-fabric-1.21.1'], data.profiles['attack-fabric-1.21.1']);
  assert.match(again.profiles['attack-fabric-26.3'].javaArgs, /^-Xmx4096M /);
  assert.equal(again.profiles['attack-fabric-26.3'].created, NOW.toISOString());
  const marked = profiles.markLastUsed(again, later, 'attack-fabric-1.21.1');
  assert.equal(marked.profiles['attack-fabric-1.21.1'].lastUsed, later.toISOString());
  assert.equal(marked.profiles['attack-client'].lastUsed, NOW.toISOString());
  assert.throws(() => profiles.markLastUsed({ profiles: {} }, later, 'attack-fabric-26.3'), /absent/);
});

// ---------- jar ATTACK dans une release ----------

const HASH = (c) => c.repeat(64);
const asset = (name, extra = {}) => ({ name, size: 10, browser_download_url: `https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/${encodeURIComponent(name)}`, ...extra });
const RELEASE = {
  tag_name: 'v0.5.0',
  assets: [
    asset('attack-client-2.3.0.jar', { digest: `sha256:${HASH('a')}` }),
    asset('attack-fabric-0.1.0+mc1.21.1.jar', { digest: `sha256:${HASH('b')}` }),
    asset('attack-fabric-0.1.0+mc26.3.jar', { digest: `sha256:${HASH('c')}` }),
    asset('attack-fabric-0.1.0+mc1.21.1-sources.jar', { digest: `sha256:${HASH('d')}` }),
    asset('ATTACK-Launcher-Setup-0.5.0.exe'),
    asset('SHA256SUMS'),
  ],
};

test('release : chaque profil trouve son jar, jamais celui d’un autre', () => {
  const forge = mod.parseRelease(RELEASE, 'forge-1.8.9');
  assert.equal(forge.name, 'attack-client-2.3.0.jar');
  assert.equal(forge.sha256, HASH('a'));
  assert.equal(mod.parseRelease(RELEASE).name, 'attack-client-2.3.0.jar', 'sans profil : comportement historique (Forge)');
  const f121 = mod.parseRelease(RELEASE, catalog.get('fabric-1.21.1'));
  assert.equal(f121.name, 'attack-fabric-0.1.0+mc1.21.1.jar');
  assert.equal(f121.sha256, HASH('b'));
  assert.equal(f121.version, 'v0.5.0');
  assert.equal(mod.parseRelease(RELEASE, 'fabric-26.3').name, 'attack-fabric-0.1.0+mc26.3.jar');
  // la même release lue dans l'ordre inverse donne le même résultat : aucun « premier jar qui ressemble »
  const reversed = { ...RELEASE, assets: [...RELEASE.assets].reverse() };
  assert.equal(mod.parseRelease(reversed, 'fabric-1.21.1').name, 'attack-fabric-0.1.0+mc1.21.1.jar');
  assert.equal(mod.parseRelease(reversed, 'forge-1.8.9').name, 'attack-client-2.3.0.jar');
});

test('release : jar du profil absent ou ambigu, SHA256SUMS à plusieurs jars', () => {
  const onlyForge = { assets: [asset('attack-client-2.3.0.jar', { digest: `sha256:${HASH('a')}` })] };
  assert.throws(() => mod.parseRelease(onlyForge, 'fabric-1.21.1'), (e) => e.code === 'NO_JAR' && /attack-fabric.*1\.21\.1/.test(e.message));
  const onlyFabric = { assets: [asset('attack-fabric-0.1.0+mc1.21.1.jar', { digest: `sha256:${HASH('b')}` })] };
  assert.throws(() => mod.parseRelease(onlyFabric, 'forge-1.8.9'), (e) => e.code === 'NO_JAR');
  assert.throws(() => mod.parseRelease(onlyFabric, 'fabric-26.3'), (e) => e.code === 'NO_JAR');
  const twice = { assets: [asset('attack-fabric-0.1.0+mc1.21.1.jar', { digest: `sha256:${HASH('b')}` }), asset('attack-fabric-0.2.0+mc1.21.1.jar', { digest: `sha256:${HASH('c')}` })] };
  assert.throws(() => mod.parseRelease(twice, 'fabric-1.21.1'), (e) => e.code === 'AMBIGUOUS_JAR');

  // somme de contrôle depuis SHA256SUMS : la ligne du jar demandé, jamais celle d'un autre fichier
  const sums = `${HASH('1')}  attack-fabric-0.1.0+mc1.21.1.jar\n${HASH('2')}  attack-fabric-0.1.0+mc26.3.jar\n${HASH('3')}  attack-client-2.3.0.jar\n`;
  assert.equal(mod.sha256For(sums, 'attack-fabric-0.1.0+mc26.3.jar'), HASH('2'));
  assert.equal(mod.sha256For(sums, 'attack-fabric-0.1.0+mc1.21.1.jar'), HASH('1'));
  assert.throws(() => mod.sha256For(sums, 'attack-fabric-0.1.0+mc1.99.jar'), /Aucun SHA-256/);
  assert.equal(mod.sha256For(`${HASH('4')}\n`, 'nimporte.jar'), HASH('4'), 'fichier .sha256 d’un seul jar');
});

test('jar de développement : le plus récent du profil, ni sources ni jar d’une autre version', () => {
  const dir = tempDir();
  const write = (name, mtime) => {
    fs.writeFileSync(path.join(dir, name), name);
    fs.utimesSync(path.join(dir, name), mtime, mtime);
  };
  write('attack-fabric-0.1.0+mc1.21.1.jar', new Date('2026-01-01'));
  write('attack-fabric-0.2.0+mc1.21.1.jar', new Date('2026-06-01'));
  write('attack-fabric-0.3.0+mc26.3.jar', new Date('2026-09-01'));
  write('attack-fabric-0.9.0+mc1.21.1-sources.jar', new Date('2026-10-01'));
  write('attack-client-2.3.0.jar', new Date('2026-10-02'));
  assert.equal(mod.findDevJar(dir, 'fabric-1.21.1').name, 'attack-fabric-0.2.0+mc1.21.1.jar');
  assert.equal(mod.findDevJar(dir, catalog.get('fabric-26.3')).name, 'attack-fabric-0.3.0+mc26.3.jar');
  assert.equal(mod.findDevJar(dir, 'forge-1.8.9').name, 'attack-client-2.3.0.jar');
  assert.equal(mod.findDevJar(dir).name, 'attack-client-2.3.0.jar');
  assert.equal(mod.versionFromJarName('attack-fabric-0.2.0+mc1.21.1.jar', 'fabric-1.21.1'), '0.2.0');
  assert.equal(mod.versionFromJarName('autre.jar', 'fabric-1.21.1'), 'dev');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version du mod affichée pour un profil Fabric : celle du jar, sans « v » ni repli sur le tag du launcher', () => {
  // GitHub écrit le « + » du nom du jar en %2B dans browser_download_url
  const url = 'https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/attack-fabric-3.0.0%2Bmc1.21.1.jar';
  assert.equal(mod.installedVersion({ source: 'release', version: 'v0.5.0', file: 'C:\\x\\attack-fabric-3.0.0+mc1.21.1.jar' }), '3.0.0');
  assert.equal(mod.installedVersion({ source: 'release', version: 'v0.5.0', file: url, name: 'attack-fabric-3.0.0+mc1.21.1.jar' }), '3.0.0', 'nom du jar enregistré');
  assert.equal(mod.installedVersion({ source: 'release', version: 'v0.5.0', file: url }), '3.0.0', 'ancien état sans nom : URL décodée');
  assert.equal(mod.installedVersion({ source: 'release', version: 'v0.5.0', file: 'https://x/y/attack-fabric-3.0.0%2Bmc26.3%.jar' }), '0.5.0', 'URL illisible : repli sur la version enregistrée');
  assert.equal(mod.installedVersion({ source: 'release', version: 'v2.3.0', file: 'https://x/v2.3.0/attack-client-2.3.0.jar', name: 'attack-client-2.3.0.jar' }), '2.3.0');
  assert.equal(mod.installedVersion({ source: 'dev', version: '0.1.0', file: 'C:\\x\\attack-fabric-0.1.0+mc26.3.jar' }), '0.1.0');
  assert.equal(mod.installedVersion(null), null);
});

// ---------- canal bêta : release d'où vient le jar ----------

test('préversion du launcher : reconnue par son « - » semver, une version illisible n’en est pas une', () => {
  for (const version of ['0.5.0-beta.1', 'v1.0.0-rc.1', '0.6.0-alpha']) assert.equal(mod.isPrereleaseVersion(version), true, version);
  for (const version of ['0.5.0', 'v0.4.0', '1.0.0+build.7', '', 'dev', undefined, null]) assert.equal(mod.isPrereleaseVersion(version), false, String(version));
});

test('release du mod : releases/latest pour un launcher normal, première release publiée (préversion comprise) pour une préversion', async () => {
  const LATEST = 'https://api.github.com/repos/7ShIkI3/attack-launcher/releases/latest';
  const LIST = 'https://api.github.com/repos/7ShIkI3/attack-launcher/releases?per_page=10';
  const stable = { tag_name: 'v0.4.0' };
  const releases = [{ tag_name: 'v0.5.1-beta.2', draft: true }, { tag_name: 'v0.5.0-beta.1', prerelease: true, draft: false }, stable];
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    return url === LATEST ? stable : releases;
  };

  // version normale (ou illisible) : comportement inchangé, la liste n'est même pas lue
  for (const version of ['0.4.0', 'v0.5.0', '1.0.0+build.7', undefined, '', 'dev']) {
    calls.length = 0;
    assert.equal(await mod.fetchRelease(version, getJson), stable, String(version));
    assert.deepEqual(calls, [LATEST], String(version));
  }
  // préversion : la première release qui n'est pas un brouillon, préversion acceptée
  for (const version of ['0.5.0-beta.1', 'v1.0.0-rc.1']) {
    calls.length = 0;
    assert.equal((await mod.fetchRelease(version, getJson)).tag_name, 'v0.5.0-beta.1', version);
    assert.deepEqual(calls, [LIST], version);
  }
  // rien de publiable, ou réponse inattendue : NO_RELEASE (le brouillon n'est jamais pris)
  for (const list of [[], [{ tag_name: 'v0.5.0-beta.1', draft: true }], null, {}, 'oups', [null, 3]]) {
    await assert.rejects(mod.fetchRelease('0.5.0-beta.1', async () => list), (error) => error.code === 'NO_RELEASE', JSON.stringify(list));
  }
  // une erreur réseau n'est pas masquée
  await assert.rejects(mod.fetchRelease('0.5.0-beta.1', async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); }), (error) => error.status === 403);
});

// ---------- progression et état ----------

test('progression : 0 à 100 % pour chaque chargeur, étape inconnue sans erreur', () => {
  for (const profile of catalog.list()) {
    const steps = installer.stepsFor(profile);
    assert.equal(steps.reduce((sum, s) => sum + s.weight, 0), 100, profile.id);
    const seen = [];
    const report = installer.progressReporter((p) => seen.push(p.percent), steps);
    for (const step of steps) {
      report(step.id, 0, 4);
      report(step.id, 2, 4);
      report(step.id, 4, 4);
    }
    assert.equal(seen[0], 0);
    assert.equal(seen.at(-1), 100);
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), `${profile.id} croissant`);
  }
  assert.ok(installer.stepsFor(catalog.get('fabric-1.21.1')).some((s) => s.id === 'pack'));
  assert.ok(installer.stepsFor(catalog.get('fabric-1.21.1')).some((s) => s.id === 'fabric'));
  assert.ok(installer.stepsFor(catalog.get('forge-1.8.9')).some((s) => s.id === 'forge'));

  const events = [];
  const report = installer.progressReporter((p) => events.push(p), installer.stepsFor(catalog.get('fabric-26.3')));
  assert.doesNotThrow(() => report('java', 1, 4, 'Java'));
  assert.doesNotThrow(() => report('forge', 1, 1), 'étape d’un autre chargeur');
  assert.equal(events[0].step, 'java');
  assert.equal(events[0].percent, 25);
});

/** Installation factice d'un profil Fabric : fichiers présents, tailles du pack respectées (fichiers creux). */
function fakeInstall(profile, { shaders = false } = {}) {
  const root = tempDir();
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = path.join(root, 'game');
  const put = (file, content = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const vid = profile.loader.versionId;
  put(path.join(minecraftDir, 'versions', profile.mc, `${profile.mc}.json`), JSON.stringify({ assetIndex: { id: '17' } }));
  put(path.join(minecraftDir, 'versions', profile.mc, `${profile.mc}.jar`));
  put(path.join(minecraftDir, 'assets', 'indexes', '17.json'));
  put(path.join(minecraftDir, 'versions', vid, `${vid}.json`));
  put(path.join(minecraftDir, 'libraries', 'net', 'fabricmc', 'fabric-loader', profile.loader.version, `fabric-loader-${profile.loader.version}.jar`));
  put(path.join(minecraftDir, 'launcher_profiles.json'), JSON.stringify({ profiles: { [profile.launcherProfileId]: { name: profile.name } } }));
  put(path.join(gameDir, 'mods', profile.modFile), 'mod');
  const pack = modpack.loadPack(profile);
  const managed = [];
  for (const m of modpack.selectedMods(pack, { shaders })) {
    const file = path.join(gameDir, 'mods', m.filename);
    put(file, '');
    fs.truncateSync(file, m.size);
    managed.push(m.filename);
  }
  put(path.join(gameDir, 'attack-launcher.json'), JSON.stringify({
    mod: { source: 'release', version: 'v0.5.0', file: 'C:\\x\\attack-fabric-0.1.0+mc1.21.1.jar' }, installedAt: '2026-10-19T00:00:00.000Z', pack: { managed },
  }));
  return { root, minecraftDir, gameDir, pack };
}

test('état d’un profil Fabric : installé, puis pack à refaire si un jar manque, change de taille ou si les shaders changent', async () => {
  const profile = catalog.get('fabric-1.21.1');
  const { root, minecraftDir, gameDir, pack } = fakeInstall(profile);
  const status = (shaders = false) => installer.status({ minecraftDir, gameDir, profile, shaders });

  let s = await status();
  assert.equal(s.profileId, 'fabric-1.21.1');
  assert.deepEqual(
    { minecraft: s.minecraft, loader: s.loader, fabric: s.fabric, pack: s.pack, mod: s.mod, profile: s.profile, installed: s.installed },
    { minecraft: true, loader: true, fabric: true, pack: true, mod: true, profile: true, installed: true },
  );
  assert.equal(s.modVersion, '0.1.0');
  assert.equal(s.modSource, 'release');
  assert.equal(s.forge, undefined);

  // shaders activés mais Iris absent : à installer
  s = await status(true);
  assert.equal(s.pack, false);
  assert.equal(s.installed, false);

  // jar du pack de taille inattendue (corrompu) ou manquant
  const sodium = path.join(gameDir, 'mods', pack.mods.find((m) => m.slug === 'sodium').filename);
  fs.truncateSync(sodium, 10);
  assert.equal((await status()).pack, false);
  fs.rmSync(sodium);
  assert.equal((await status()).pack, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('état : Iris encore présent après avoir coupé les shaders = pack à mettre à jour ; mod ATTACK ou profil absent', async () => {
  const profile = catalog.get('fabric-26.3');
  const { root, minecraftDir, gameDir } = fakeInstall(profile, { shaders: true });
  assert.equal((await installer.status({ minecraftDir, gameDir, profile, shaders: true })).installed, true);
  const off = await installer.status({ minecraftDir, gameDir, profile, shaders: false });
  assert.equal(off.pack, false, 'Iris installé alors que l’option est coupée');
  assert.equal(off.installed, false);

  fs.rmSync(path.join(gameDir, 'mods', profile.modFile));
  const noMod = await installer.status({ minecraftDir, gameDir, profile, shaders: true });
  assert.equal(noMod.mod, false);
  assert.equal(noMod.installed, false);

  fs.writeFileSync(path.join(gameDir, 'mods', profile.modFile), 'mod');
  fs.writeFileSync(path.join(minecraftDir, 'launcher_profiles.json'), JSON.stringify({ profiles: {} }));
  assert.equal((await installer.status({ minecraftDir, gameDir, profile, shaders: true })).profile, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('état d’un profil vide, et le profil Forge reste sans pack (champ forge conservé)', async () => {
  const dir = tempDir();
  const fabricStatus = await installer.status({ minecraftDir: path.join(dir, 'mc'), gameDir: path.join(dir, 'g'), profile: 'fabric-26.3' });
  assert.deepEqual(
    { minecraft: fabricStatus.minecraft, loader: fabricStatus.loader, pack: fabricStatus.pack, mod: fabricStatus.mod, installed: fabricStatus.installed },
    { minecraft: false, loader: false, pack: false, mod: false, installed: false },
  );
  const forgeStatus = await installer.status({ minecraftDir: path.join(dir, 'mc'), gameDir: path.join(dir, 'g') });
  assert.equal(forgeStatus.profileId, 'forge-1.8.9');
  assert.equal(forgeStatus.pack, null);
  assert.equal(forgeStatus.forge, false);
  assert.equal(forgeStatus.loader, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arguments Java : propres à chaque profil, normalisés, valeur invalide ignorée', () => {
  let s = settings.sanitize({ jvmArgs: '  -XX:+UseStringDeduplication   -Xss4M ' }, settings.defaults(ENV));
  assert.equal(settings.forProfile(s).jvmArgs, '-XX:+UseStringDeduplication -Xss4M');
  assert.equal(settings.forProfile(s, 'fabric-1.21.1').jvmArgs, '', 'le réglage est propre à chaque profil');
  s = settings.sanitize({ jvmArgs: '-javaagent:C:\\evil.jar' }, s);
  assert.equal(settings.forProfile(s).jvmArgs, '-XX:+UseStringDeduplication -Xss4M', 'ancienne valeur gardée');
  s = settings.sanitize({ profiles: { 'fabric-26.3': { jvmArgs: '-XX:+UseZGC' } } }, s);
  assert.equal(settings.forProfile(s, 'fabric-26.3').jvmArgs, '-XX:+UseZGC');
  assert.equal(settings.forProfile(settings.sanitize({ jvmArgs: '' }, s)).jvmArgs, '');
  // ancien fichier sans la clé
  const old = settings.sanitize({ profiles: { 'forge-1.8.9': { gameDir: 'D:\\jeu' } } }, settings.defaults(ENV));
  assert.equal(settings.forProfile(old).jvmArgs, '');
});
