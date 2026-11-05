'use strict';
// OptiFine pour les profils 1.8.9 et 1.7.10 : détection de LA COPIE DU JOUEUR (jamais de téléchargement), validation du jar, copie dans
// mods suivie dans le fichier d'état, retrait seulement de ce que le launcher a copié. Les tests historiques appellent les fonctions sans
// version de Minecraft (1.8.9 par défaut : non-régression) ; la fin du fichier rejoue une suite complète pour CHAQUE spec.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeZip, declareSize, tempDir } = require('./helpers');
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

test('validation : MANIFEST.MF piégé (bombe de décompression) refusé vite : annoncé trop gros = TOO_BIG, taille mensongère = BAD_ZIP', async () => {
  const s = sandbox();
  const MIB = 1024 * 1024;
  // le manifeste annonce (et contient) 2 Mo : refusé sans être décompressé
  const huge = makeZip({ 'META-INF/MANIFEST.MF': `${MANIFEST}${'x'.repeat(2 * MIB)}\r\n` });
  const refused = await optifine.validate(s.put('OptiFine-1.8.9_huge.jar', huge));
  assert.deepEqual([refused.ok, refused.reason], [false, 'TOO_BIG']);
  // 64 Mo de zéros qui tiennent dans quelques Ko, taille annoncée 100 octets : la décompression s'arrête à 100, le fichier est refusé
  const bomb = declareSize(makeZip({ 'META-INF/MANIFEST.MF': Buffer.alloc(64 * MIB) }), 100);
  assert.ok(bomb.length < 256 * 1024);
  const started = Date.now();
  const lying = await optifine.validate(s.put('OptiFine-1.8.9_bomb.jar', bomb));
  assert.deepEqual([lying.ok, lying.reason], [false, 'BAD_ZIP']);
  assert.ok(Date.now() - started < 2000, 'refusé sans geler');
  // le vrai manifeste d'un jar OptiFine reste accepté
  assert.equal((await optifine.validate(s.put('OptiFine_1.8.9_HD_U_M5.jar', optifineJar()))).ok, true);
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
  assert.deepEqual([after.pending, after.installed, after.kept], [false, true, null], 'la copie d’origine est là : rien n’est « gardé »');
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

test('source supprimée : le jar de mods reste et installed reste true', async () => {
  const s = sandbox();
  const source = s.put(lib('HD_U_M5'), optifineJar());
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  const copy = path.join(s.gameDir, 'mods', 'OptiFine-1.8.9_HD_U_M5.jar');
  const state = () => JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));
  const tracked = state().optifine;
  fs.rmSync(source); // le joueur supprime sa copie d'origine (désinstallation d'OptiFine, nettoyage de libraries)

  const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, tracked });
  assert.deepEqual([view.found, view.installed, view.wantCopy, view.pending], [false, true, false, false], 'rien à faire : le jar marche');
  assert.deepEqual([view.kept, view.version], ['OptiFine-1.8.9_HD_U_M5.jar', 'HD_U_M5'], 'la page sait que le jar est gardé, et sa variante');
  const result = await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  assert.equal(result.action, 'kept');
  assert.ok(fs.existsSync(copy), 'le jar de mods reste');
  assert.deepEqual(state().optifine, tracked, 'l’état est intact');
  // plusieurs installations de suite : toujours rien de retiré
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, {})).action, 'kept');
  assert.ok(fs.existsSync(copy));

  // c'est l'interrupteur coupé qui retire la copie, source présente ou non
  const off = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, enabled: false, tracked });
  assert.deepEqual([off.installed, off.pending, off.kept], [true, true, null], 'coupé : le jar part, il n’est pas « gardé »');
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, { optifine: false })).action, 'removed');
  assert.ok(!fs.existsSync(copy));
  assert.equal(state().optifine, undefined);
  s.clean();
});

test('source supprimée puis OptiFine du joueur ajouté dans mods : la copie du launcher part, celle du joueur reste', async () => {
  const s = sandbox();
  const source = s.put(lib('HD_U_M5'), optifineJar());
  await installer.installOptifine(s.gameDir, s.minecraftDir, {});
  fs.rmSync(source);
  const mine = s.put('game/mods/OptiFine_1.8.9_HD_U_L5.jar', optifineJar('perso'));
  const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, tracked: JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8')).optifine });
  assert.deepEqual([view.own, view.installed, view.wantCopy, view.pending, view.kept], ['OptiFine_1.8.9_HD_U_L5.jar', true, false, true, null]);
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, {})).action, 'removed');
  assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), ['OptiFine_1.8.9_HD_U_L5.jar']);
  assert.ok(fs.existsSync(mine));
  s.clean();
});

test('fichier choisi puis supprimé : sans autre copie le jar de mods reste ; avec une copie de libraries, c’est elle qui prend le relais', async () => {
  const s = sandbox();
  fs.mkdirSync(s.minecraftDir, { recursive: true });
  const chosen = s.put('Telechargements/OptiFine_1.8.9_HD_U_M3.jar', optifineJar('m3'));
  await installer.installOptifine(s.gameDir, s.minecraftDir, { optifineJar: chosen });
  const copy = path.join(s.gameDir, 'mods', 'OptiFine_1.8.9_HD_U_M3.jar');
  const state = () => JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));
  assert.equal(state().optifine.source, 'chosen');
  const tracked = state().optifine;
  fs.rmSync(chosen);

  const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, chosen, tracked });
  assert.deepEqual([view.found, view.chosenError, view.installed, view.pending], [false, 'UNREADABLE', true, false]);
  assert.equal(view.kept, 'OptiFine_1.8.9_HD_U_M3.jar', 'fichier choisi effacé : le jar copié est gardé');
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, { optifineJar: chosen })).action, 'kept');
  assert.ok(fs.existsSync(copy), 'le jar de mods reste');
  assert.deepEqual(state().optifine, tracked);

  // une copie de libraries apparaît : la recherche automatique la trouve, une seule copie reste dans mods
  s.put(lib('HD_U_M5'), optifineJar('m5'));
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, { optifineJar: chosen })).action, 'copied');
  assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), ['OptiFine-1.8.9_HD_U_M5.jar']);
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

  // la copie d'origine disparaît : le jar de mods marche, JOUER reste JOUER
  fs.rmSync(path.join(mc, 'libraries', 'optifine'), { recursive: true, force: true });
  const gone = await status();
  assert.deepEqual([gone.installed, gone.optifine.found, gone.optifine.installed, gone.optifine.pending], [true, false, true, false], 'source supprimée');
  assert.equal((await status({ optifine: false })).installed, false, 'option coupée : le retrait reste à faire');
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

test('suffixe « (n) » du navigateur : versionOf et destName l’ignorent, un nom étranger reste ramené à OptiFine-1.8.9_<variante>.jar', () => {
  assert.equal(optifine.versionOf('OptiFine_1.8.9_HD_U_M5 (1).jar'), 'HD_U_M5');
  assert.equal(optifine.versionOf('OptiFine_1.8.9_HD_U_M5 (12).jar'), 'HD_U_M5');
  assert.equal(optifine.versionOf('OptiFine_1.8.9_HD_U_M5(1).jar'), 'HD_U_M5', 'Firefox : « (1) » collé');
  assert.equal(optifine.versionOf('preview_OptiFine_1.8.9_HD_U_M6_pre2.jar'), 'HD_U_M6_pre2');
  assert.equal(optifine.stripCopySuffix('OptiFine_1.8.9_HD_U_M5 (1).jar'), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.stripCopySuffix('OptiFine_1.8.9_HD_U_M5(1).jar'), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.stripCopySuffix('OptiFine_1.8.9_HD_U_M5(12).JAR'), 'OptiFine_1.8.9_HD_U_M5.JAR');
  assert.equal(optifine.stripCopySuffix('mon OptiFine (copie).jar'), 'mon OptiFine (copie).jar', 'seul un nombre entre parenthèses est retiré');
  assert.equal(optifine.destName({ name: 'OptiFine_1.8.9_HD_U_M5 (1).jar', version: 'HD_U_M5' }), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.destName({ name: 'OptiFine_1.8.9_HD_U_M5 (3).jar', version: 'HD_U_M5' }), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.destName({ name: 'OptiFine_1.8.9_HD_U_M5(1).jar', version: 'HD_U_M5' }), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.destName({ name: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5' }), 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.equal(optifine.destName({ name: 'mon OptiFine 1.8.9 (copie).jar', version: null }), 'OptiFine-1.8.9_custom.jar');
});

test('importCopy : copie privée dans <userData>/optifine (SHA-256, .part renommé), nom propre, deuxième import = rien à recopier', async () => {
  const s = sandbox();
  const source = s.put('Telechargements/OptiFine_1.8.9_HD_U_M5 (1).jar', optifineJar('dl'));
  const userData = path.join(s.root, 'userData');
  const first = await optifine.importCopy(source, userData);
  const dest = path.join(userData, 'optifine', 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.deepEqual([first.file, first.name, first.version, first.reused], [dest, 'OptiFine_1.8.9_HD_U_M5.jar', 'HD_U_M5', false]);
  assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(source)), 'copie identique');
  assert.equal(first.sha256, sha256(fs.readFileSync(source)));
  assert.equal(first.size, fs.statSync(source).size);
  assert.deepEqual(fs.readdirSync(path.join(userData, 'optifine')), ['OptiFine_1.8.9_HD_U_M5.jar'], 'aucun .part');
  assert.ok(fs.existsSync(source), 'le fichier téléchargé n’est pas touché');
  // la copie est elle-même un OptiFine valide, utilisable comme « fichier choisi »
  assert.equal((await optifine.detect({ chosen: dest })).found, true);
  const again = await optifine.importCopy(source, userData);
  assert.equal(again.reused, true);
  assert.equal((await optifine.importCopy(dest, userData)).reused, true, 'la copie elle-même');
  // autre contenu sous le même nom : la copie est remplacée
  const other = s.put('Telechargements/2/OptiFine_1.8.9_HD_U_M5.jar', optifineJar('autre'));
  const replaced = await optifine.importCopy(other, userData);
  assert.equal(replaced.reused, false);
  assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(other)));
  s.clean();
});

test('importCopy : un jar refusé lève OPTIFINE_<raison> et ne laisse rien dans le dossier de données', async () => {
  const s = sandbox();
  const userData = path.join(s.root, 'userData');
  const notTweak = s.put('t/OptiFine_1.8.9_HD_U_M5.jar', makeZip({ 'a.txt': 'x' }));
  await assert.rejects(optifine.importCopy(notTweak, userData), (error) => error.code === 'OPTIFINE_NO_TWEAK' && error.reason === 'NO_TWEAK');
  const wrong = s.put('t/OptiFine_1.8.8_HD_U_I7.jar', optifineJar());
  await assert.rejects(optifine.importCopy(wrong, userData), (error) => error.code === 'OPTIFINE_WRONG_NAME');
  await assert.rejects(optifine.importCopy(path.join(s.root, 'absent-1.8.9.jar'), userData), (error) => error.code === 'OPTIFINE_UNREADABLE');
  const left = fs.existsSync(path.join(userData, 'optifine')) ? fs.readdirSync(path.join(userData, 'optifine')) : [];
  assert.deepEqual(left, []);
  s.clean();
});

test('assistant : l’import règle optifineJar du profil 1.8.9 même quand un autre profil est affiché', () => {
  const base = settings.defaults({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  const onFabric = settings.sanitize({ profileId: 'fabric-26.3' }, base);
  const jar = 'C:\\Users\\x\\AppData\\Roaming\\ATTACK Launcher\\optifine\\OptiFine_1.8.9_HD_U_M5.jar';
  const next = settings.sanitize({ profiles: { 'forge-1.8.9': { optifineJar: jar, optifine: true } } }, onFabric);
  assert.equal(next.profileId, 'fabric-26.3', 'le profil affiché ne change pas');
  assert.equal(settings.forProfile(next, 'forge-1.8.9').optifineJar, jar);
  assert.equal(settings.forProfile(next, 'forge-1.8.9').optifine, true);
  assert.equal('optifineJar' in next.profiles['fabric-26.3'], false);
});

// Jar OptiFine réel du joueur : lance ATTACK_TEST_OPTIFINE_JAR=<chemin d'une copie> pour le vérifier (sinon ignoré).
test('jar OptiFine réel (ATTACK_TEST_OPTIFINE_JAR) : accepté par la validation', { skip: !process.env.ATTACK_TEST_OPTIFINE_JAR }, async () => {
  const result = await optifine.validate(process.env.ATTACK_TEST_OPTIFINE_JAR);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.version, /^HD_U_/);
});

// ---------- table de specs ----------

test('specs : une table fermée (1.8.9 puis 1.7.10), gelée ; une version inconnue n’a pas de spec et fait lever les fonctions qui en ont besoin', async () => {
  assert.deepEqual(Object.keys(optifine.SPECS), ['1.8.9', '1.7.10']);
  assert.deepEqual(optifine.forVersion('1.8.9'), { mc: '1.8.9', edition: 'HD_U_M5', tweak: 'optifine.OptiFineForgeTweaker' });
  // 1.7.10 : édition HD_U_E7, même TweakClass qu'en 1.8.9 (manifeste du jar E7 lu), mod ATTACK 1.1.0 minimum
  assert.deepEqual(optifine.forVersion('1.7.10'), { mc: '1.7.10', edition: 'HD_U_E7', tweak: 'optifine.OptiFineForgeTweaker', minMod: '1.1.0' });
  assert.equal(optifine.forVersion(), optifine.forVersion('1.8.9'), '1.8.9 par défaut');
  assert.equal(optifine.DEFAULT_MC, '1.8.9');
  for (const spec of Object.values(optifine.SPECS)) assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(optifine.SPECS));
  for (const unknown of ['1.12.2', '1.7', '', 'constructor', '__proto__', null, 189]) assert.equal(optifine.forVersion(unknown), null, String(unknown));
  await assert.rejects(optifine.validate('OptiFine_1.12.2_HD_U_G5.jar', '1.12.2'), RangeError);
  await assert.rejects(optifine.detect({ mc: '1.12.2' }), RangeError);
  await assert.rejects(optifine.importCopy('x.jar', tempDir('atk-of-'), '1.12.2'), RangeError);
  assert.throws(() => optifine.checkBuffer(Buffer.alloc(0), 'OptiFine_1.12.2.jar', '1.12.2'), RangeError);
  assert.throws(() => optifine.destName({ name: 'x.jar' }, '1.12.2'), RangeError);
});

test('raisons de refus : le texte porte la version de Minecraft et le TweakClass de la spec', () => {
  assert.match(optifine.describeReason('WRONG_NAME', '1.7.10'), /ne contient pas 1\.7\.10.*Minecraft 1\.7\.10/);
  assert.match(optifine.describeReason('WRONG_NAME', '1.8.9'), /ne contient pas 1\.8\.9.*Minecraft 1\.8\.9/);
  assert.match(optifine.describeReason('NO_TWEAK', '1.7.10'), /Forge 1\.7\.10 \(TweakClass optifine\.OptiFineForgeTweaker absent\)/);
  assert.equal(optifine.describeReason('WRONG_NAME'), optifine.describeReason('WRONG_NAME', '1.8.9'), '1.8.9 sans argument');
  assert.equal(optifine.describeReason('INCONNUE'), undefined);
  for (const code of Object.keys(optifine.REASONS)) {
    assert.ok(!/[{}]/.test(optifine.describeReason(code, '1.7.10')), `${code} : aucun {mc} ni {tweak} ne reste`);
  }
});

test('noms : la version de Minecraft est cherchée entre deux non-chiffres (21.7.10 et 1.7.101 ne sont pas la 1.7.10) ; un OptiFine d’une autre version est « étranger »', () => {
  assert.equal(optifine.mcInName('OptiFine_1.7.10_HD_U_E7.jar', '1.7.10'), true);
  assert.equal(optifine.mcInName('OptiFine_21.7.10_x.jar', '1.7.10'), false);
  assert.equal(optifine.mcInName('OptiFine_1.7.101_x.jar', '1.7.10'), false);
  assert.equal(optifine.mcInName('OptiFine_1.8.99_x.jar', '1.8.9'), false);
  assert.equal(optifine.nameMatches('mon OptiFine 1.7.10 (copie).jar', '1.7.10'), true);
  assert.equal(optifine.nameMatches('autre-mod-1.7.10.jar', '1.7.10'), false, 'il faut « OptiFine » dans le nom');
  assert.equal(optifine.isForeignName('OptiFine_1.8.9_HD_U_M5.jar', '1.7.10'), true);
  assert.equal(optifine.isForeignName('OptiFine_1.8.9_HD_U_M5 (1).jar', '1.7.10'), true, 'suffixe du navigateur ignoré');
  assert.equal(optifine.isForeignName('preview_OptiFine_1.12.2_HD_U_G6_pre1.jar', '1.7.10'), true);
  assert.equal(optifine.isForeignName('OptiFine_1.7.10_HD_U_E7.jar', '1.7.10'), false, 'le sien n’est pas étranger');
  assert.equal(optifine.isForeignName('OptiFine_1.7.10_HD_U_E7.jar', '1.8.9'), true);
  assert.equal(optifine.isForeignName('autre-mod-1.8.9.jar', '1.7.10'), false, 'sans « OptiFine »');
  assert.equal(optifine.isForeignName('OptiFineHelper-2.0.jar', '1.7.10'), false, 'sans version de Minecraft');
  assert.equal(optifine.isForeignName('OptiFine_1.8.9_HD_U_M5.jar.part', '1.7.10'), false, 'fichier temporaire');
});

// ---------- la même suite pour CHAQUE spec : 1.8.9 (HD U M5) et 1.7.10 (HD U E7) ----------

const SPEC_LIST = Object.values(optifine.SPECS);

for (const spec of SPEC_LIST) {
  const MC = spec.mc;
  const EDITION = spec.edition;
  const PROFILE = catalog.list().find((p) => p.optifine === spec);
  const other = SPEC_LIST.find((s) => s !== spec); // l'autre version, pour les refus croisés
  const NAME_OK = `OptiFine_${MC}_${EDITION}.jar`;
  const NAME_OTHER = `OptiFine_${other.mc}_${other.edition}.jar`;
  const manifest = (tweak = spec.tweak) => `Manifest-Version: 1.0\r\nMain-Class: optifine.InstallerFrame\r\nTweakClass: ${tweak}\r\nTweakOrder: -1000\r\n\r\n`;
  const jarOf = (salt = '', forSpec = spec) => makeZip({ 'META-INF/MANIFEST.MF': manifest(forSpec.tweak), 'optifine/OptiFineForgeTweaker.class': `classe ${salt}` });
  const libOf = (version, mc = MC) => `.minecraft/libraries/optifine/OptiFine/${mc}_${version}/OptiFine-${mc}_${version}.jar`;
  const stateOf = (s) => JSON.parse(fs.readFileSync(path.join(s.gameDir, 'attack-launcher.json'), 'utf8'));
  const install = (s, settingsArg = {}) => installer.installOptifine(s.gameDir, s.minecraftDir, settingsArg, PROFILE);

  test(`[${MC}] le profil du catalogue porte la spec, et le jar de ${EDITION} est accepté (empreinte SHA-256, variante lue dans le nom)`, async () => {
    assert.ok(PROFILE, 'un profil du catalogue a cette spec');
    assert.equal(PROFILE.mc, MC);
    assert.equal(catalog.hasOptifine(PROFILE), true);
    const s = sandbox();
    const good = s.put(NAME_OK, jarOf());
    const ok = await optifine.validate(good, MC);
    assert.deepEqual([ok.ok, ok.version, ok.mc, ok.size], [true, EDITION, MC, fs.statSync(good).size]);
    assert.equal(ok.sha256, sha256(fs.readFileSync(good)));
    s.clean();
  });

  test(`[${MC}] refus clairs : mauvais nom, pas un .jar, archive illisible, TweakClass absent ou différent, manifeste piégé, dossier ou fichier absent`, async () => {
    const s = sandbox();
    const reason = async (rel, content) => (await optifine.validate(s.put(rel, content), MC)).reason;
    assert.equal(await reason(`OptiFine_${MC}_${EDITION}.zip`, jarOf()), 'NOT_JAR');
    assert.equal(await reason('OptiFine_1.5.2_HD_U_D5.jar', jarOf()), 'WRONG_NAME', 'une autre version de Minecraft');
    assert.equal(await reason(`OptiFine-${MC}_a.jar`, 'pas une archive'), 'BAD_ZIP');
    assert.equal(await reason(`OptiFine-${MC}_b.jar`, makeZip({ 'a.txt': 'x' })), 'NO_TWEAK', 'archive sans manifeste');
    assert.equal(await reason(`OptiFine-${MC}_c.jar`, makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: autre.Tweaker\r\n\r\n' })), 'NO_TWEAK');
    assert.equal(await reason(`OptiFine-${MC}_d.jar`, makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: optifine.OptiFineTweaker\r\n\r\n' })), 'NO_TWEAK', 'tweaker non Forge');
    const huge = await optifine.validate(s.put(`OptiFine-${MC}_huge.jar`, makeZip({ 'META-INF/MANIFEST.MF': `${manifest()}${'x'.repeat(2 * 1024 * 1024)}\r\n` })), MC);
    assert.deepEqual([huge.ok, huge.reason], [false, 'TOO_BIG']);
    const missing = await optifine.validate(path.join(s.root, `absent-${MC}.jar`), MC);
    assert.deepEqual([missing.ok, missing.reason], [false, 'UNREADABLE']);
    assert.equal((await optifine.validate(s.root, MC)).reason, 'UNREADABLE', 'un dossier n’est pas un jar');
    // le message porte la version de Minecraft de la spec
    const wrong = await optifine.validate(s.put('OptiFine_1.5.2_HD_U_D5.jar', jarOf()), MC);
    assert.equal(wrong.message, optifine.describeReason('WRONG_NAME', MC));
    assert.match(wrong.message, new RegExp(MC.replace(/\./g, '\\.')));
    s.clean();
  });

  test(`[${MC}] refus croisés : un OptiFine ${other.mc} valide (preview_, « (1) », même manifeste) est refusé pour la ${MC}, même fichier validé sous les deux specs`, async () => {
    const s = sandbox();
    const otherJar = s.put(NAME_OTHER, jarOf('autre', other));
    for (const name of [NAME_OTHER, `preview_OptiFine_${other.mc}_${other.edition}_pre2.jar`, `OptiFine_${other.mc}_${other.edition} (1).jar`, `OptiFine_${other.mc}_${other.edition}(1).jar`]) {
      const file = s.put(name, jarOf(name, other));
      const refused = await optifine.validate(file, MC);
      assert.deepEqual([refused.ok, refused.reason], [false, 'WRONG_NAME'], name);
      assert.equal((await optifine.validate(file, other.mc)).ok, true, `${name} : accepté pour sa propre version`);
    }
    // le refus est mis en cache : demandé AVANT la bonne version, il ne doit pas être resservi (la clé contient la version de Minecraft)
    assert.equal((await optifine.validate(otherJar, MC)).reason, 'WRONG_NAME');
    assert.equal((await optifine.validate(otherJar, other.mc)).ok, true, 'refusé pour la mauvaise version, accepté ensuite pour la bonne');
    assert.equal((await optifine.validate(otherJar, MC)).reason, 'WRONG_NAME', 'et toujours refusé pour la première (résultat du cache)');
    // et l'inverse : accepté d'abord pour sa version, il reste refusé pour l'autre
    const mine = s.put(NAME_OK, jarOf('moi'));
    assert.equal((await optifine.validate(mine, MC)).ok, true);
    assert.equal((await optifine.validate(mine, other.mc)).reason, 'WRONG_NAME');
    assert.equal((await optifine.validate(mine, MC)).ok, true);
    s.clean();
  });

  test(`[${MC}] copies du joueur : libraries/optifine d’abord (la plus récente, ordre naturel), puis mods ; les autres versions de Minecraft sont ignorées`, async () => {
    const s = sandbox();
    for (const v of [`HD_U_L5`, `HD_U_M9`, `HD_U_M10`]) s.put(libOf(v), jarOf(v));
    s.put(libOf(other.edition, other.mc), jarOf('autre', other));
    s.put(`.minecraft/mods/${NAME_OK}`, jarOf());
    s.put(`.minecraft/mods/${NAME_OTHER}`, jarOf('autre', other));
    s.put('.minecraft/mods/autre-mod.jar', 'x');
    const list = await optifine.candidates(s.minecraftDir, MC);
    assert.deepEqual(list.map((c) => [c.source, path.basename(c.file)]), [
      ['libraries', `OptiFine-${MC}_HD_U_M10.jar`], ['libraries', `OptiFine-${MC}_HD_U_M9.jar`], ['libraries', `OptiFine-${MC}_HD_U_L5.jar`], ['mods', NAME_OK],
    ]);
    const found = await optifine.detect({ minecraftDir: s.minecraftDir, mc: MC });
    assert.deepEqual([found.found, found.source, found.version, found.mc], [true, 'libraries', 'HD_U_M10', MC]);
    // la détection de l'autre version ne voit que la sienne
    const theirs = await optifine.detect({ minecraftDir: s.minecraftDir, mc: other.mc });
    assert.deepEqual([theirs.found, theirs.version], [true, other.edition]);
    // un dossier .minecraft qui n'a que l'OptiFine de l'autre version : rien de trouvé pour celle-ci
    const lonely = sandbox();
    lonely.put(libOf(other.edition, other.mc), jarOf('autre', other));
    assert.deepEqual(await optifine.detect({ minecraftDir: lonely.minecraftDir, mc: MC }), { found: false });
    lonely.clean();
    s.clean();
  });

  test(`[${MC}] fichier choisi : prioritaire s’il est valide ; l’OptiFine ${other.mc} choisi par erreur est refusé (WRONG_NAME) et la recherche automatique continue`, async () => {
    const s = sandbox();
    s.put(libOf(EDITION), jarOf('auto'));
    const chosen = s.put(`Telechargements/OptiFine_${MC}_HD_U_X1.jar`, jarOf('choisi'));
    const first = await optifine.detect({ minecraftDir: s.minecraftDir, chosen, mc: MC });
    assert.deepEqual([first.source, first.version, first.chosenError], ['chosen', 'HD_U_X1', undefined]);
    const wrongChoice = s.put(`Telechargements/${NAME_OTHER}`, jarOf('autre', other));
    const second = await optifine.detect({ minecraftDir: s.minecraftDir, chosen: wrongChoice, mc: MC });
    assert.deepEqual([second.found, second.source, second.version, second.chosenError], [true, 'libraries', EDITION, 'WRONG_NAME']);
    assert.deepEqual(await optifine.detect({ minecraftDir: path.join(s.root, 'rien'), chosen: wrongChoice, mc: MC }), { found: false, chosenError: 'WRONG_NAME' });
    s.clean();
  });

  test(`[${MC}] installation : copie dans mods, suivie dans l’état ; deuxième passage = rien à refaire ; option coupée = copie retirée, jar du joueur intact`, async () => {
    const s = sandbox();
    const source = s.put(libOf(EDITION), jarOf());
    s.put('game/mods/mon-mod.jar', 'jar du joueur');
    fs.writeFileSync(path.join(s.gameDir, 'attack-launcher.json'), JSON.stringify({ mod: { version: '2.5.4' } }));
    const inspectArgs = { minecraftDir: s.minecraftDir, gameDir: s.gameDir, mc: MC };
    const before = await optifine.inspect(inspectArgs);
    assert.deepEqual([before.found, before.pending, before.installed, before.wantCopy, before.mc, before.edition], [true, true, false, true, MC, EDITION]);
    assert.equal(before.minMod, spec.minMod || null);

    const first = await install(s);
    const copyName = `OptiFine-${MC}_${EDITION}.jar`;
    assert.deepEqual(first, { action: 'copied', name: copyName, source: 'libraries' });
    const copy = path.join(s.gameDir, 'mods', copyName);
    assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(source)), 'copie identique');
    assert.deepEqual(stateOf(s).optifine, { file: copyName, source: 'libraries', from: source, sha256: sha256(fs.readFileSync(source)), size: fs.statSync(source).size, version: EDITION });
    assert.equal(stateOf(s).mod.version, '2.5.4', 'le reste de l’état est gardé');
    assert.equal((await install(s)).action, 'kept');
    const after = await optifine.inspect({ ...inspectArgs, tracked: stateOf(s).optifine });
    assert.deepEqual([after.pending, after.installed, after.kept, after.untested], [false, true, null, false]);
    assert.match(fs.readFileSync(path.join(s.gameDir, 'logs', 'launcher', 'install.log'), 'utf8'), new RegExp(`OptiFine : copie de ${copyName.replace(/\./g, '\\.')} \\(libraries\\) dans mods`));

    const off = await install(s, { optifine: false });
    assert.equal(off.action, 'removed');
    assert.ok(!fs.existsSync(copy));
    assert.equal(stateOf(s).optifine, undefined);
    assert.equal(fs.readFileSync(path.join(s.gameDir, 'mods', 'mon-mod.jar'), 'utf8'), 'jar du joueur');
    assert.equal((await install(s, { optifine: false })).action, 'disabled');
    assert.equal((await install(s, { optifine: true })).action, 'copied', 'réactivée = recopiée');
    assert.ok(fs.existsSync(copy));
    s.clean();
  });

  test(`[${MC}] OptiFine du joueur dans mods : jamais doublé ni retiré ; un OptiFine ${other.mc} dans mods est signalé (foreign), jamais supprimé, et ne compte pas comme « le sien »`, async () => {
    const s = sandbox();
    s.put(libOf(EDITION), jarOf());
    const foreign = s.put(`game/mods/${NAME_OTHER}`, jarOf('autre', other));
    const foreign2 = s.put(`game/mods/OptiFine_1.12.2_HD_U_G5 (1).jar`, 'jar 1.12.2');
    // l'OptiFine d'une autre version ne remplace pas la copie : la nôtre est posée à côté, et l'autre est signalé
    const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, mc: MC });
    assert.deepEqual([view.own, view.wantCopy, view.pending], [null, true, true]);
    assert.deepEqual(view.foreign, ['OptiFine_1.12.2_HD_U_G5 (1).jar', NAME_OTHER].sort((a, b) => new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare(a, b)));
    assert.equal((await install(s)).action, 'copied');
    assert.ok(fs.existsSync(foreign) && fs.existsSync(foreign2), 'les jars étrangers restent');
    // le joueur met le sien dans mods : la copie du launcher part, le sien reste
    const own = s.put(`game/mods/OptiFine_${MC}_HD_U_L5.jar`, jarOf('perso'));
    const result = await install(s);
    assert.equal(result.action, 'removed');
    const view2 = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, mc: MC });
    assert.deepEqual([view2.own, view2.wantCopy, view2.pending, view2.foreign.length], [`OptiFine_${MC}_HD_U_L5.jar`, false, false, 2]);
    assert.ok(fs.existsSync(own) && fs.existsSync(foreign) && fs.existsSync(foreign2));
    assert.equal((await install(s)).action, 'own');
    s.clean();
  });

  test(`[${MC}] édition : ${EDITION} est la vérifiée, une autre édition est acceptée mais « non testée » (copie du launcher comme jar du joueur)`, async () => {
    const s = sandbox();
    s.put(libOf(EDITION), jarOf());
    const verified = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, mc: MC });
    assert.deepEqual([verified.found, verified.version, verified.untested], [true, EDITION, false]);
    s.clean();
    const t = sandbox();
    t.put(libOf('HD_U_Z9'), jarOf('z9'));
    const odd = await optifine.inspect({ minecraftDir: t.minecraftDir, gameDir: t.gameDir, mc: MC });
    assert.deepEqual([odd.found, odd.version, odd.untested], [true, 'HD_U_Z9', true]);
    assert.equal((await install(t)).action, 'copied', 'acceptée malgré tout');
    t.clean();
    const u = sandbox();
    u.put(`game/mods/OptiFine_${MC}_HD_U_Z8.jar`, jarOf('perso'));
    assert.equal((await optifine.inspect({ minecraftDir: u.minecraftDir, gameDir: u.gameDir, mc: MC })).untested, true, 'le jar du joueur aussi');
    u.clean();
    assert.equal((await optifine.inspect({ minecraftDir: u.minecraftDir, gameDir: u.gameDir, mc: MC })).untested, false, 'rien d’utilisé : rien à dire');
  });

  test(`[${MC}] source supprimée : le jar de mods reste et installed reste vrai ; fichier choisi remplacé par une autre variante = une seule copie dans mods`, async () => {
    const s = sandbox();
    const source = s.put(libOf(EDITION), jarOf());
    await install(s);
    const copy = path.join(s.gameDir, 'mods', `OptiFine-${MC}_${EDITION}.jar`);
    const tracked = stateOf(s).optifine;
    fs.rmSync(source);
    const view = await optifine.inspect({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, tracked, mc: MC });
    assert.deepEqual([view.found, view.installed, view.wantCopy, view.pending, view.kept, view.version], [false, true, false, false, `OptiFine-${MC}_${EDITION}.jar`, EDITION]);
    assert.equal((await install(s)).action, 'kept');
    assert.ok(fs.existsSync(copy));
    const older = s.put(`Telechargements/OptiFine_${MC}_HD_U_M3.jar`, jarOf('m3'));
    assert.equal((await install(s, { optifineJar: older })).action, 'copied');
    assert.deepEqual(fs.readdirSync(path.join(s.gameDir, 'mods')), [`OptiFine_${MC}_HD_U_M3.jar`]);
    assert.equal(stateOf(s).optifine.source, 'chosen');
    s.clean();
  });

  test(`[${MC}] importCopy : copie privée dans <userData>/optifine (nom sans « (1) »), deuxième import = rien à recopier ; un jar ${other.mc} est refusé sans rien laisser`, async () => {
    const s = sandbox();
    const userData = path.join(s.root, 'userData');
    const source = s.put(`Telechargements/OptiFine_${MC}_${EDITION} (1).jar`, jarOf('dl'));
    const first = await optifine.importCopy(source, userData, MC);
    const dest = path.join(userData, 'optifine', NAME_OK);
    assert.deepEqual([first.file, first.name, first.version, first.reused], [dest, NAME_OK, EDITION, false]);
    assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(source)));
    assert.equal((await optifine.importCopy(source, userData, MC)).reused, true);
    assert.equal((await optifine.detect({ chosen: dest, mc: MC })).found, true, 'la copie est elle-même un fichier choisi valide');
    assert.equal((await optifine.detect({ chosen: dest, mc: other.mc })).chosenError, 'WRONG_NAME', 'et refusée pour l’autre version');
    const wrong = s.put(`Telechargements/${NAME_OTHER}`, jarOf('autre', other));
    await assert.rejects(optifine.importCopy(wrong, userData, MC), (error) => error.code === 'OPTIFINE_WRONG_NAME' && error.reason === 'WRONG_NAME');
    assert.deepEqual(fs.readdirSync(path.join(userData, 'optifine')), [NAME_OK], 'aucune trace du jar refusé, aucun .part');
    // une copie de l'autre version vit à côté sans collision (le nom porte la version de Minecraft)
    const second = await optifine.importCopy(wrong, userData, other.mc);
    assert.equal(second.name, NAME_OTHER);
    assert.deepEqual(fs.readdirSync(path.join(userData, 'optifine')).sort(), [NAME_OK, NAME_OTHER].sort());
    s.clean();
  });

  test(`[${MC}] état du profil : OptiFine en attente = installation à refaire, version de la spec et exigence de mod exposées ; sans copie ou option coupée, rien à faire`, async () => {
    const s = sandbox();
    s.put(libOf(EDITION), jarOf());
    const status = (extra = {}) => installer.status({ minecraftDir: s.minecraftDir, gameDir: s.gameDir, profile: PROFILE, ...extra });
    const withCopy = (await status()).optifine;
    assert.deepEqual([withCopy.mc, withCopy.edition, withCopy.minMod, withCopy.found, withCopy.pending, withCopy.modOutdated], [MC, EDITION, spec.minMod || null, true, true, false]);
    assert.equal((await status({ optifine: false })).optifine.pending, false, 'option coupée : rien à faire');
    await install(s);
    const done = (await status()).optifine;
    assert.deepEqual([done.installed, done.pending], [true, false]);
    assert.equal((await status({ optifine: false })).optifine.pending, true, 'option coupée alors que la copie est encore dans mods');
    // mod ATTACK trop ancien : seulement quand la spec a une version minimale ET qu'OptiFine est actif
    fs.writeFileSync(path.join(s.gameDir, 'attack-launcher.json'), JSON.stringify({ ...stateOf(s), mod: { version: '1.0.0', source: 'release', name: PROFILE.attackJar.glob.replace('*', '1.0.0') } }));
    const old = await status();
    assert.equal(old.optifine.modOutdated, Boolean(spec.minMod), `mod 1.0.0 ${spec.minMod ? 'plus ancien que' : 'sans exigence de'} ${spec.minMod || 'version'}`);
    assert.equal((await status({ optifine: false })).optifine.modOutdated, false, 'OptiFine coupé : le mod n’a rien à adapter');
    fs.writeFileSync(path.join(s.gameDir, 'attack-launcher.json'), JSON.stringify({ ...stateOf(s), mod: { version: '1.1.0', source: 'release', name: PROFILE.attackJar.glob.replace('*', '1.1.0') } }));
    assert.equal((await status()).optifine.modOutdated, false, 'mod 1.1.0 : à jour');
    s.clean();
  });
}

// ---------- registre à deux profils OptiFine ----------

test('deux profils OptiFine dans une même racine .minecraft : chacun ne copie que son OptiFine, sans toucher à celui de l’autre', async () => {
  const root = tempDir('atk-of2-');
  const put = (rel, content) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const minecraftDir = path.join(root, '.minecraft');
  const jar = (spec, salt) => makeZip({ 'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nTweakClass: ${spec.tweak}\r\n\r\n`, 'optifine/OptiFineForgeTweaker.class': salt });
  const specs = Object.values(optifine.SPECS);
  const profiles = specs.map((spec) => catalog.list().find((p) => p.optifine === spec));
  for (const spec of specs) put(`.minecraft/libraries/optifine/OptiFine/${spec.mc}_${spec.edition}/OptiFine-${spec.mc}_${spec.edition}.jar`, jar(spec, spec.mc));
  const gameDirs = profiles.map((profile) => path.join(root, ...profile.gameDirName.split('/')));
  // les deux profils (1.8.9 = .attack, 1.7.10 = .attack/profiles/forge-1.7.10) installent l'un après l'autre dans la même racine
  for (const [i, profile] of profiles.entries()) {
    const result = await installer.installOptifine(gameDirs[i], minecraftDir, {}, profile);
    assert.equal(result.action, 'copied', profile.id);
  }
  profiles.forEach((profile, i) => {
    const spec = profile.optifine;
    assert.deepEqual(fs.readdirSync(path.join(gameDirs[i], 'mods')), [`OptiFine-${spec.mc}_${spec.edition}.jar`], `${profile.id} : son seul OptiFine`);
  });
  // chaque profil ne voit comme « étranger » que l'OptiFine de l'autre version, s'il traînait dans ses mods
  fs.copyFileSync(path.join(gameDirs[0], 'mods', `OptiFine-${specs[0].mc}_${specs[0].edition}.jar`), path.join(gameDirs[1], 'mods', 'OptiFine_1.8.9_HD_U_M5.jar'));
  const view = await optifine.inspect({ minecraftDir, gameDir: gameDirs[1], mc: specs[1].mc, tracked: JSON.parse(fs.readFileSync(path.join(gameDirs[1], 'attack-launcher.json'), 'utf8')).optifine });
  assert.deepEqual([view.installed, view.pending, view.foreign], [true, false, ['OptiFine_1.8.9_HD_U_M5.jar']]);
  assert.equal((await installer.installOptifine(gameDirs[1], minecraftDir, {}, profiles[1])).action, 'kept');
  assert.ok(fs.existsSync(path.join(gameDirs[1], 'mods', 'OptiFine_1.8.9_HD_U_M5.jar')), 'l’OptiFine étranger n’est jamais supprimé');
  fs.rmSync(root, { recursive: true, force: true });
});

test('installOptifine : un profil sans OptiFine (Fabric) est refusé sans rien écrire ; l’identifiant du profil est accepté comme le profil lui-même', async () => {
  const s = sandbox();
  const fabric = await installer.installOptifine(s.gameDir, s.minecraftDir, {}, 'fabric-26.3');
  assert.equal(fabric.action, 'error');
  assert.match(fabric.error, /n'a pas d'OptiFine/);
  assert.ok(!fs.existsSync(path.join(s.gameDir, 'mods')));
  s.put(`.minecraft/libraries/optifine/OptiFine/1.7.10_HD_U_E7/OptiFine-1.7.10_HD_U_E7.jar`, optifineJar());
  assert.equal((await installer.installOptifine(s.gameDir, s.minecraftDir, {}, 'forge-1.7.10')).action, 'copied');
  s.clean();
});

test('assistant : l’import règle optifineJar du profil visé (1.7.10 ou 1.8.9) même quand un autre profil est affiché, sans toucher aux autres', () => {
  const base = settings.defaults({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  const onFabric = settings.sanitize({ profileId: 'fabric-26.3' }, base);
  const jar7 = 'C:\\Users\\x\\AppData\\Roaming\\ATTACK Launcher\\optifine\\OptiFine_1.7.10_HD_U_E7.jar';
  const jar8 = 'C:\\Users\\x\\AppData\\Roaming\\ATTACK Launcher\\optifine\\OptiFine_1.8.9_HD_U_M5.jar';
  let next = settings.sanitize({ profiles: { 'forge-1.7.10': { optifineJar: jar7, optifine: true } } }, onFabric);
  assert.equal(next.profileId, 'fabric-26.3', 'le profil affiché ne change pas');
  assert.equal(settings.forProfile(next, 'forge-1.7.10').optifineJar, jar7);
  assert.equal(settings.forProfile(next, 'forge-1.8.9').optifineJar, '', 'la 1.8.9 n’a rien reçu');
  next = settings.sanitize({ profiles: { 'forge-1.8.9': { optifineJar: jar8 } } }, next);
  assert.deepEqual([settings.forProfile(next, 'forge-1.8.9').optifineJar, settings.forProfile(next, 'forge-1.7.10').optifineJar], [jar8, jar7]);
  assert.equal('optifineJar' in next.profiles['fabric-26.3'], false);
  // les clés à plat s'appliquent au profil AFFICHÉ au moment de l'appel : c'est pourquoi l'import et le choix passent par `profiles`
  const flat = settings.sanitize({ optifineJar: jar7 }, settings.sanitize({ profileId: 'forge-1.8.9' }, base));
  assert.equal(settings.forProfile(flat, 'forge-1.8.9').optifineJar, jar7);
  assert.equal(settings.forProfile(flat, 'forge-1.7.10').optifineJar, '');
});
