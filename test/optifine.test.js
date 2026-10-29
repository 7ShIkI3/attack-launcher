'use strict';
// OptiFine pour le profil 1.8.9 : détection de LA COPIE DU JOUEUR (jamais de téléchargement), validation du jar, copie dans
// mods suivie dans le fichier d'état, retrait seulement de ce que le launcher a copié.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeZip, tempDir } = require('./helpers');
const optifine = require('../src/main/optifine');
const installer = require('../src/main/installer');
const settings = require('../src/main/settings');
const catalog = require('../src/main/catalog');

const FORGE = catalog.get('forge-1.8.9');
const MANIFEST = 'Manifest-Version: 1.0\r\nMain-Class: optifine.InstallerFrame\r\nTweakClass: optifine.OptiFineForgeTweaker\r\nTweakOrder: -1000\r\n\r\n';
/** Jar OptiFine factice mais valide : archive avec le manifeste d'OptiFine ; `salt` rend le contenu différent. */
const optifineJar = (salt = '') => makeZip({ 'META-INF/MANIFEST.MF': MANIFEST, 'optifine/OptiFineForgeTweaker.class': `classe ${salt}` });
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Dossiers de test : <racine>/.minecraft (avec libraries) et <racine>/game ; `put` écrit un fichier relatif à la racine. */
function sandbox() {
  const root = tempDir('atk-of-');
  const put = (rel, content) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, minecraftDir: path.join(root, '.minecraft'), gameDir: path.join(root, 'game'), put, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const lib = (version) => `.minecraft/libraries/optifine/OptiFine/1.8.9_${version}/OptiFine-1.8.9_${version}.jar`;

test('manifeste : attributs principaux, lignes repliées recollées, arrêt à la première section', () => {
  const text = 'Manifest-Version: 1.0\r\nTweakClass: optifine.OptiFineForge\r\n Tweaker\r\n\r\nName: autre\r\nTweakClass: faux\r\n';
  assert.equal(optifine.parseManifest(text).TweakClass, 'optifine.OptiFineForgeTweaker');
  assert.equal(optifine.parseManifest(text).Name, undefined);
});

test('variante lue dans le nom du fichier', () => {
  assert.equal(optifine.versionOf('OptiFine-1.8.9_HD_U_M5.jar'), 'HD_U_M5');
  assert.equal(optifine.versionOf('OptiFine_1.8.9_HD_U_M5.jar'), 'HD_U_M5');
  assert.equal(optifine.versionOf('OptiFine_1.8.9.jar'), null);
});

test('validation : jar OptiFine 1.8.9 accepté (empreinte SHA-256 calculée), refus clairs pour tout le reste', async () => {
  const s = sandbox();
  const good = s.put('OptiFine_1.8.9_HD_U_M5.jar', optifineJar());
  const ok = await optifine.validate(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.version, 'HD_U_M5');
  assert.equal(ok.sha256, sha256(fs.readFileSync(good)));
  assert.equal(ok.size, fs.statSync(good).size);

  const reason = async (rel, content) => (await optifine.validate(s.put(rel, content))).reason;
  assert.equal(await reason('OptiFine_1.8.8_HD_U_I7.jar', optifineJar()), 'WRONG_NAME', 'autre version de Minecraft');
  assert.equal(await reason('OptiFine_1.8.9_HD_U_M5.zip', optifineJar()), 'NOT_JAR');
  assert.equal(await reason('OptiFine-1.8.9_a.jar', 'pas une archive'), 'BAD_ZIP');
  assert.equal(await reason('OptiFine-1.8.9_b.jar', makeZip({ 'a.txt': 'x' })), 'NO_TWEAK', 'archive sans manifeste');
  assert.equal(await reason('OptiFine-1.8.9_c.jar', makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: autre.Tweaker\r\n\r\n' })), 'NO_TWEAK');
  assert.equal(await reason('OptiFine-1.8.9_d.jar', makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: optifine.OptiFineTweaker\r\n\r\n' })), 'NO_TWEAK', 'tweaker non Forge');
  const missing = await optifine.validate(path.join(s.root, 'absent-1.8.9.jar'));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'UNREADABLE');
  assert.equal((await optifine.validate(s.root)).reason, 'UNREADABLE', 'un dossier n’est pas un jar');
  for (const code of Object.keys(optifine.REASONS)) assert.ok(optifine.REASONS[code].length > 10);
  s.clean();
});

test('copies du joueur : libraries/optifine d’abord (la plus récente), puis mods ; les autres versions de Minecraft ignorées', async () => {
  const s = sandbox();
  for (const v of ['HD_U_L5', 'HD_U_M3', 'HD_U_M5']) s.put(lib(v), optifineJar(v));
  s.put('.minecraft/libraries/optifine/OptiFine/1.8.8_HD_U_I7/OptiFine-1.8.8_HD_U_I7.jar', optifineJar('x'));
  s.put('.minecraft/mods/OptiFine_1.8.9_HD_U_M5.jar', optifineJar());
  s.put('.minecraft/mods/autre-mod.jar', 'x');
  s.put('.minecraft/mods/OptiFine_1.8.8_HD_U_I7.jar', optifineJar());
  const list = await optifine.candidates(s.minecraftDir);
  assert.deepEqual(list.map((c) => [c.source, path.basename(c.file)]), [
    ['libraries', 'OptiFine-1.8.9_HD_U_M5.jar'], ['libraries', 'OptiFine-1.8.9_HD_U_M3.jar'], ['libraries', 'OptiFine-1.8.9_HD_U_L5.jar'],
    ['mods', 'OptiFine_1.8.9_HD_U_M5.jar'],
  ]);
  const found = await optifine.detect({ minecraftDir: s.minecraftDir });
  assert.deepEqual([found.found, found.source, found.version], [true, 'libraries', 'HD_U_M5']);
  s.clean();
});

test('copies du joueur : M10 passe avant M9 (ordre naturel)', async () => {
  const s = sandbox();
  for (const v of ['HD_U_M9', 'HD_U_M10']) s.put(lib(v), optifineJar(v));
  assert.equal((await optifine.detect({ minecraftDir: s.minecraftDir })).version, 'HD_U_M10');
  s.clean();
});

test('détection : un jar invalide est sauté, rien de trouvé = found:false, dossier absent sans erreur', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M6'), 'abîmé');
  s.put(lib('HD_U_M5'), optifineJar());
  assert.equal((await optifine.detect({ minecraftDir: s.minecraftDir })).version, 'HD_U_M5');
  const none = await optifine.detect({ minecraftDir: path.join(s.root, 'rien') });
  assert.deepEqual(none, { found: false });
  assert.deepEqual(await optifine.detect({}), { found: false });
  s.clean();
});

test('fichier choisi par le joueur : prioritaire quand il est valide ; refusé = raison donnée et recherche automatique', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M5'), optifineJar('auto'));
  const chosen = s.put('Telechargements/OptiFine_1.8.9_HD_U_M3.jar', optifineJar('choisi'));
  const first = await optifine.detect({ minecraftDir: s.minecraftDir, chosen });
  assert.deepEqual([first.source, first.version, first.chosenError], ['chosen', 'HD_U_M3', undefined]);
  const bad = s.put('Telechargements/OptiFine_1.8.8_HD_U_I7.jar', optifineJar());
  const second = await optifine.detect({ minecraftDir: s.minecraftDir, chosen: bad });
  assert.deepEqual([second.found, second.source, second.version, second.chosenError], [true, 'libraries', 'HD_U_M5', 'WRONG_NAME']);
  const third = await optifine.detect({ minecraftDir: path.join(s.root, 'rien'), chosen: bad });
  assert.deepEqual(third, { found: false, chosenError: 'WRONG_NAME' });
  s.clean();
});

test('installation : copie dans mods, suivie dans l’état ; deuxième passage = rien à refaire ; le reste de l’état est gardé', async () => {
  const s = sandbox();
  const source = s.put(lib('HD_U_M5'), optifineJar());
  fs.mkdirSync(path.join(s.gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(s.gameDir, 'mods', 'mon-mod.jar'), 'jar du joueur');
  fs.writeFileSync(path.join(s.gameDir, 'attack-launcher.json'), JSON.stringify({ mod: { version: '2.5.4' }, pack: { managed: ['a.jar'] } }));
  const state = () => JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));

  const before = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir });
  assert.deepEqual([before.found, before.pending, before.installed, before.wantCopy], [true, true, false, true]);

  const first = await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.deepEqual(first, { action: 'copied', name: 'OptiFine-1.8.9_HD_U_M5.jar', source: 'libraries' });
  const copy = path.join(s.gameDir, 'mods', 'OptiFine-1.8.9_HD_U_M5.jar');
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(source)), 'copie identique');
  assert.deepEqual(state().optifine, {
    file: 'OptiFine-1.8.9_HD_U_M5.jar', source: 'libraries', from: source, sha256: sha256(fs.readFileSync(source)), size: fs.statSync(source).size, version: 'HD_U_M5',
  });
  assert.equal(state().mod.version, '2.5.4');
  assert.deepEqual(state().pack.managed, ['a.jar']);
  assert.equal(fs.readdirSync(path.join(s.gameDir, 'mods')).some((f) => f.endsWith('.part')), false, 'aucun fichier temporaire');

  const second = await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.equal(second.action, 'kept');
  const after = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, tracked: state().optifine });
  assert.deepEqual([after.pending, after.installed], [false, true]);
  assert.equal(fs.readFileSync(path.join(s.gameDir, 'mods', 'mon-mod.jar'), 'utf8'), 'jar du joueur');
  const log = fs.readFileSync(path.join(s.gameDir, 'logs', 'launcher', 'install.log'), 'utf8');
  assert.match(log, /OptiFine : copie de OptiFine-1\.8\.9_HD_U_M5\.jar \(libraries\) dans mods/);
  s.clean();
});

test('option coupée : la copie du launcher est retirée, jamais un jar du joueur ; réactivée = recopiée', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M5'), optifineJar());
  s.put('game/mods/mon-mod.jar', 'jar du joueur');
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  const copy = path.join(s.gameDir, 'mods', 'OptiFine-1.8.9_HD_U_M5.jar');
  assert.ok(fs.existsSync(copy));
  const state = () => JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));

  const pending = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, enabled: false, tracked: state().optifine });
  assert.deepEqual([pending.wantCopy, pending.pending], [false, true], 'option coupée mais copie encore là : installation à refaire');
  const off = await installer.installOptifine(s.gameDir, s.minecraftDir, { optifine: false });
  assert.equal(off.action, 'removed');
  assert.ok(!fs.existsSync(copy));
  assert.equal(state().optifine, undefined, 'plus suivi');
  assert.equal(fs.readFileSync(path.join(s.gameDir, 'mods', 'mon-mod.jar'), 'utf8'), 'jar du joueur');
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, { optifine: false })).action, 'disabled');

  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, { optifine: true })).action, 'copied');
  assert.ok(fs.existsSync(copy));
  s.clean();
});

test('un OptiFine que le joueur a mis lui-même dans mods n’est jamais doublé, ni retiré', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M5'), optifineJar());
  const own = s.put('game/mods/OptiFine_1.8.9_HD_U_L5.jar', optifineJar('perso'));
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.equal(result.action, 'own');
  assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), ['OptiFine_1.8.9_HD_U_L5.jar']);
  assert.ok(fs.existsSync(own));
  const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir });
  assert.deepEqual([view.own, view.wantCopy, view.pending], ['OptiFine_1.8.9_HD_U_L5.jar', false, false]);
  // la copie du launcher déjà là quand le joueur ajoute le sien : elle part, le sien reste (deux OptiFine feraient échouer Forge)
  s.put('game/mods/OptiFine-1.8.9_HD_U_M5.jar', optifineJar());
  fs.rmSync(own);
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.ok(fs.existsSync(path.join(s.gameDir, 'mods', 'OptiFine-1.8.9_HD_U_M5.jar')), 'sans état, un OptiFine déjà là est celui du joueur');
  s.clean();
});

test('jar remplacé par le joueur depuis la copie du launcher : plus suivi, jamais supprimé', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M5'), optifineJar());
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  const copy = path.join(s.gameDir, 'mods', 'OptiFine-1.8.9_HD_U_M5.jar');
  fs.writeFileSync(copy, optifineJar('modifié par le joueur'));
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, { optifine: false });
  assert.equal(result.action, 'disabled');
  assert.ok(fs.existsSync(copy), 'le jar du joueur reste');
  const state = JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));
  assert.equal(state.optifine, undefined);
  s.clean();
});

test('autre variante choisie : la nouvelle est copiée et l’ancienne copie du launcher retirée (un seul OptiFine dans mods)', async () => {
  const s = sandbox();
  s.put(lib('HD_U_M5'), optifineJar('m5'));
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  const older = s.put('Telechargements/OptiFine_1.8.9_HD_U_M3.jar', optifineJar('m3'));
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, { optifineJar: older });
  assert.equal(result.action, 'copied');
  assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), ['OptiFine_1.8.9_HD_U_M3.jar']);
  const state = JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));
  assert.equal(state.optifine.source, 'chosen');
  assert.equal(state.optifine.version, 'HD_U_M3');
  s.clean();
});

test('aucune copie trouvée : rien n’est copié ni téléchargé, installation sans erreur', async () => {
  const s = sandbox();
  fs.mkdirSync(s.minecraftDir, { recursive: true });
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.deepEqual(result, { action: 'missing', name: null, source: null });
  assert.ok(!fs.existsSync(path.join(s.gameDir, 'mods')) || fs.readdirSync(path.join(s.gameDir, 'mods')).length === 0);
  assert.equal(optifine.DOWNLOAD_URL, 'https://optifine.net/downloads');
  s.clean();
});

test('nom de copie sûr : un nom étranger (espaces, caractères spéciaux) devient OptiFine-1.8.9_<variante>.jar', async () => {
  const s = sandbox();
  const odd = s.put('Telechargements/mon OptiFine 1.8.9 (copie).jar', optifineJar());
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, { optifineJar: odd });
  assert.equal(result.action, 'copied');
  assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), ['OptiFine-1.8.9_custom.jar']);
  s.clean();
});

test('état du profil 1.8.9 : OptiFine en attente = installation à refaire ; sans copie ou option coupée, rien à faire', async () => {
  const s = sandbox();
  const mc = s.minecraftDir;
  // installation 1.8.9 factice complète (sans OptiFine), pack inclus
  const profile = FORGE;
  const modpack = require('../src/main/modpack');
  const vid = profile.loader.versionId;
  s.put('.minecraft/versions/1.8.9/1.8.9.json', JSON.stringify({ assetIndex: { id: '1.8' } }));
  s.put('.minecraft/versions/1.8.9/1.8.9.jar', 'x');
  s.put('.minecraft/assets/indexes/1.8.json', 'x');
  s.put(`.minecraft/versions/${vid}/${vid}.json`, JSON.stringify({ id: vid }));
  s.put('.minecraft/libraries/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar', 'x');
  s.put('.minecraft/launcher_profiles.json', JSON.stringify({ profiles: { [profile.launcherProfileId]: { name: profile.name } } }));
  s.put('game/mods/attack-client.jar', 'mod');
  const managed = [];
  for (const m of modpack.selectedMods(modpack.loadPack(profile))) {
    const file = s.put(`game/mods/${m.filename}`, '');
    fs.truncateSync(file, m.size);
    managed.push(m.filename);
  }
  s.put('game/attack-launcher.json', JSON.stringify({ mod: { version: '2.5.4', source: 'release' }, pack: { id: 'forge-1.8.9', managed } }));
  const status = (extra = {}) => installer.status({ minecraftDir: mc, gameDir: s.gameDir, profile, ...extra });

  const noCopy = await status();
  assert.deepEqual([noCopy.installed, noCopy.optifine.found, noCopy.optifine.pending], [true, false, false], 'pas d’OptiFine sur le PC : rien à faire');

  s.put(lib('HD_U_M5'), optifineJar());
  const withCopy = await status();
  assert.deepEqual([withCopy.installed, withCopy.optifine.found, withCopy.optifine.pending], [false, true, true], 'copie trouvée mais pas encore dans mods');
  assert.equal((await status({ optifine: false })).installed, true, 'option coupée : rien à faire');

  await installer.installOptifine(s.gameDir, mc, {});
  const done = await status();
  assert.deepEqual([done.installed, done.optifine.installed, done.optifine.pending], [true, true, false]);
  const off = await status({ optifine: false });
  assert.deepEqual([off.installed, off.optifine.pending], [false, true], 'option coupée alors que la copie est encore dans mods');
  s.clean();
});

test('réglages OptiFine du profil 1.8.9 : interrupteur par défaut vrai, fichier choisi = chemin absolu de .jar, autres profils sans', () => {
  const base = settings.defaults({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.equal(base.profiles['forge-1.8.9'].optifine, true);
  assert.equal(base.profiles['forge-1.8.9'].optifineJar, '');
  assert.equal('optifine' in base.profiles['fabric-26.3'], false);
  let s = settings.sanitize({ optifine: false, optifineJar: 'C:\\Telechargements\\OptiFine_1.8.9_HD_U_M5.jar' }, base);
  assert.equal(settings.forProfile(s).optifine, false);
  assert.equal(settings.forProfile(s).optifineJar, 'C:\\Telechargements\\OptiFine_1.8.9_HD_U_M5.jar');
  s = settings.sanitize({ optifineJar: 'relatif\\OptiFine.jar' }, s);
  assert.equal(settings.forProfile(s).optifineJar, 'C:\\Telechargements\\OptiFine_1.8.9_HD_U_M5.jar', 'chemin relatif refusé');
  s = settings.sanitize({ optifineJar: 'C:\\Telechargements\\autre.exe' }, s);
  assert.equal(settings.forProfile(s).optifineJar, 'C:\\Telechargements\\OptiFine_1.8.9_HD_U_M5.jar', 'pas un .jar : refusé');
  s = settings.sanitize({ optifineJar: '' }, s);
  assert.equal(settings.forProfile(s).optifineJar, '', 'chaîne vide = recherche automatique');
  s = settings.sanitize({ optifine: 'oui' }, s);
  assert.equal(settings.forProfile(s).optifine, false, 'valeur non booléenne ignorée');
  const fabric = settings.sanitize({ profileId: 'fabric-26.3', optifine: false, optifineJar: 'C:\\x.jar' }, settings.defaults());
  assert.equal('optifine' in fabric.profiles['fabric-26.3'], false, 'réglage propre au profil 1.8.9');
});

// Jar OptiFine réel du joueur : lance ATTACK_TEST_OPTIFINE_JAR=<chemin d'une copie> pour le vérifier (sinon ignoré).
test('jar OptiFine réel (ATTACK_TEST_OPTIFINE_JAR) : accepté par la validation', { skip: !process.env.ATTACK_TEST_OPTIFINE_JAR }, async () => {
  const result = await optifine.validate(process.env.ATTACK_TEST_OPTIFINE_JAR);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.version, /^HD_U_/);
});
