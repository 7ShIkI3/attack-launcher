'use strict';
// Réglages de départ d'options.txt (Minecraft), par étapes : 1 = vidéo (Fabric), 2 = langue du launcher (tous les profils).
// Dossier neuf, valeurs par défaut de Minecraft remplacées une seule fois, choix du joueur et mise en forme du fichier intacts,
// erreurs sans conséquence pour l'installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const gameoptions = require('../src/main/gameoptions');
const installer = require('../src/main/installer');

const optionsFile = (dir) => path.join(dir, 'options.txt');
const stateFile = (dir) => path.join(dir, 'attack-launcher.json');
const readState = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));

test('texte de départ : VSync coupée, FPS illimités, ombres des entités coupées, distance 10, pas de clé version', () => {
  assert.equal(gameoptions.startText(), 'enableVsync:false\nmaxFps:260\nentityShadows:false\nrenderDistance:10\n');
  assert.ok(!gameoptions.startText().includes('version'));
});

test('valeurs par défaut de Minecraft remplacées (VSync activée, 120 FPS), les autres lignes et leur ordre conservés', () => {
  const text = 'version:3955\nautoJump:false\nenableVsync:true\nrenderDistance:12\nmaxFps:120\nentityShadows:true\n';
  const result = gameoptions.migrate(text);
  assert.equal(result.text, 'version:3955\nautoJump:false\nenableVsync:false\nrenderDistance:12\nmaxFps:260\nentityShadows:true\n');
  assert.deepEqual(result.changed, ['enableVsync', 'maxFps']);
  // une seule des deux valeurs par défaut
  assert.equal(gameoptions.migrate('enableVsync:true\nmaxFps:75\n').text, 'enableVsync:false\nmaxFps:75\n');
  assert.equal(gameoptions.migrate('enableVsync:false\nmaxFps:120\n').text, 'enableVsync:false\nmaxFps:260\n');
});

test('valeurs choisies par le joueur : jamais modifiées', () => {
  for (const text of [
    'enableVsync:false\nmaxFps:60\n',
    'maxFps:144\n',
    'maxFps:260\n',
    'maxFps:1200\n', // commence comme 120 mais n'en est pas un
    'maxFps:12\n',
    'enableVsync:TRUE\n',
    'enableVsync:true \n', // pas la valeur écrite par Minecraft : on n'y touche pas
    'lastServer:maxFps:120\n', // la clé est « lastServer », pas maxFps
    'resourcePacks:["vanilla","file/enableVsync:true"]\n',
    'entityShadows:true\nrenderDistance:32\n',
    '',
  ]) {
    const result = gameoptions.migrate(text);
    assert.equal(result.text, text, JSON.stringify(text));
    assert.deepEqual(result.changed, []);
  }
});

test('fins de ligne conservées : CRLF, LF, mélange et absence de retour final', () => {
  assert.equal(gameoptions.migrate('a:1\r\nenableVsync:true\r\nmaxFps:120\r\nb:2\r\n').text, 'a:1\r\nenableVsync:false\r\nmaxFps:260\r\nb:2\r\n');
  assert.equal(gameoptions.migrate('a:1\nenableVsync:true\nb:2').text, 'a:1\nenableVsync:false\nb:2');
  assert.equal(gameoptions.migrate('enableVsync:true\r\nmaxFps:120\nb:2\r\n').text, 'enableVsync:false\r\nmaxFps:260\nb:2\r\n');
  assert.equal(gameoptions.migrate('maxFps:120').text, 'maxFps:260');
});

test('dossier sans options.txt : fichier créé avec les réglages de départ, sans fichier temporaire', async () => {
  const dir = tempDir();
  const result = await gameoptions.apply(dir);
  assert.equal(result.action, 'created');
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'enableVsync:false\nmaxFps:260\nentityShadows:false\nrenderDistance:10\n');
  assert.deepEqual(fs.readdirSync(dir), ['options.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('options.txt existant : seules les valeurs par défaut changent, octet pour octet (CRLF, accents non UTF-8)', async () => {
  const dir = tempDir();
  const before = Buffer.concat([
    Buffer.from('version:3955\r\nenableVsync:true\r\nlastServer:caf'),
    Buffer.from([0xe9]), // « é » en latin1 : ce n'est pas de l'UTF-8 valide, le fichier doit revenir tel quel
    Buffer.from('.example.net\r\nmaxFps:120\r\nrenderDistance:16\r\n'),
  ]);
  fs.writeFileSync(optionsFile(dir), before);
  const result = await gameoptions.apply(dir);
  assert.equal(result.action, 'updated');
  assert.deepEqual(result.changed, ['enableVsync', 'maxFps']);
  const after = fs.readFileSync(optionsFile(dir));
  const expected = Buffer.from(before.toString('latin1').replace('enableVsync:true', 'enableVsync:false').replace('maxFps:120', 'maxFps:260'), 'latin1');
  assert.ok(after.equals(expected));
  assert.deepEqual(fs.readdirSync(dir), ['options.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('options.txt avec des choix du joueur : rien n’est réécrit', async () => {
  const dir = tempDir();
  fs.writeFileSync(optionsFile(dir), 'enableVsync:false\nmaxFps:144\n');
  const before = fs.statSync(optionsFile(dir)).mtimeMs;
  const result = await gameoptions.apply(dir);
  assert.deepEqual(result, { action: 'unchanged', changed: [] });
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'enableVsync:false\nmaxFps:144\n');
  assert.equal(fs.statSync(optionsFile(dir)).mtimeMs, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('options.txt illisible (ici un dossier) ou dossier de jeu absent : erreur renvoyée, jamais levée', async () => {
  const dir = tempDir();
  fs.mkdirSync(optionsFile(dir));
  const unreadable = await gameoptions.apply(dir);
  assert.equal(unreadable.action, 'error');
  assert.ok(unreadable.error);
  assert.ok(fs.statSync(optionsFile(dir)).isDirectory(), 'rien n’est écrasé');
  const missing = await gameoptions.apply(path.join(dir, 'absent'));
  assert.equal(missing.action, 'error');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installation : appliqué une seule fois par dossier de jeu (drapeau gameOptions de l’état), le reste de l’état est conservé', async () => {
  const dir = tempDir();
  fs.writeFileSync(stateFile(dir), JSON.stringify({ mod: { source: 'release', version: 'v0.5.0' }, pack: { managed: ['sodium.jar'] } }));
  fs.writeFileSync(optionsFile(dir), 'version:3955\nenableVsync:true\nmaxFps:120\n');

  const first = await installer.installGameOptions(dir);
  assert.equal(first.action, 'updated');
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'version:3955\nenableVsync:false\nmaxFps:260\n');
  assert.equal(readState(dir).gameOptions, gameoptions.VERSION);
  assert.equal(readState(dir).mod.version, 'v0.5.0');
  assert.deepEqual(readState(dir).pack.managed, ['sodium.jar']);

  // le joueur remet la VSync et 120 FPS : les installations suivantes n'y retouchent plus
  fs.writeFileSync(optionsFile(dir), 'version:3955\nenableVsync:true\nmaxFps:120\n');
  const second = await installer.installGameOptions(dir);
  assert.equal(second.action, 'skipped');
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'version:3955\nenableVsync:true\nmaxFps:120\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installation : dossier neuf = options.txt créé et drapeau posé ; choix du joueur seuls = drapeau posé sans rien réécrire', async () => {
  const fresh = tempDir();
  assert.equal((await installer.installGameOptions(fresh)).action, 'created');
  assert.equal(readState(fresh).gameOptions, gameoptions.VERSION);
  assert.equal(fs.readFileSync(optionsFile(fresh), 'utf8'), gameoptions.startText());

  const custom = tempDir();
  fs.writeFileSync(optionsFile(custom), 'enableVsync:false\nmaxFps:90\n');
  assert.equal((await installer.installGameOptions(custom)).action, 'unchanged');
  assert.equal(readState(custom).gameOptions, gameoptions.VERSION);
  assert.equal(fs.readFileSync(optionsFile(custom), 'utf8'), 'enableVsync:false\nmaxFps:90\n');
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(custom, { recursive: true, force: true });
});

test('installation : options.txt illisible = journalisé, pas d’exception, drapeau non posé (nouvel essai à la prochaine installation)', async () => {
  const dir = tempDir();
  fs.mkdirSync(optionsFile(dir));
  const result = await installer.installGameOptions(dir);
  assert.equal(result.action, 'error');
  assert.ok(!fs.existsSync(stateFile(dir)), 'état non modifié');
  const log = fs.readFileSync(path.join(dir, 'logs', 'launcher', 'install.log'), 'utf8');
  assert.match(log, /options\.txt : réglages de départ non appliqués/);

  // le fichier redevient normal : la nouvelle installation applique les réglages
  fs.rmdirSync(optionsFile(dir));
  fs.writeFileSync(optionsFile(dir), 'enableVsync:true\n');
  assert.equal((await installer.installGameOptions(dir)).action, 'updated');
  assert.equal(readState(dir).gameOptions, gameoptions.VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- étape 2 : langue du launcher (tous les profils) ----------

const catalog = require('../src/main/catalog');
const FORGE = catalog.get('forge-1.8.9');
const FABRIC = catalog.get('fabric-26.3');

test('langue : fr_fr / en_us depuis la 1.11, fr_FR / en_US en 1.8.9, rien pour une langue inconnue', () => {
  assert.equal(gameoptions.langValue('fr'), 'fr_fr');
  assert.equal(gameoptions.langValue('en'), 'en_us');
  assert.equal(gameoptions.langValue('fr', true), 'fr_FR');
  assert.equal(gameoptions.langValue('en', true), 'en_US');
  assert.equal(gameoptions.langValue('de'), null);
  assert.equal(gameoptions.langValue(undefined), null);
  assert.equal(gameoptions.VERSION, 2, 'deux étapes : vidéo (1) puis langue (2)');
});

test('texte de départ avec la langue : ajoutée à la fin, seule pour la 1.8.9 (pas de réglage vidéo)', () => {
  assert.equal(gameoptions.startText({ lang: 'fr' }), 'enableVsync:false\nmaxFps:260\nentityShadows:false\nrenderDistance:10\nlang:fr_fr\n');
  assert.equal(gameoptions.startText({ video: false, lang: 'fr', legacy: true }), 'lang:fr_FR\n');
  assert.equal(gameoptions.startText({ video: false, lang: 'en', legacy: true }), 'lang:en_US\n');
  assert.equal(gameoptions.startText({ video: false }), '', 'rien à écrire');
});

test('migrateLang : lang:en_us (valeur par défaut) devient français seulement quand le launcher est en français', () => {
  const text = 'version:3955\nlang:en_us\nautoJump:false\n';
  assert.deepEqual(gameoptions.migrateLang(text, { lang: 'fr' }), { text: 'version:3955\nlang:fr_fr\nautoJump:false\n', changed: ['lang'] });
  assert.deepEqual(gameoptions.migrateLang('lang:en_US\r\nfov:0.5\r\n', { lang: 'fr', legacy: true }), { text: 'lang:fr_FR\r\nfov:0.5\r\n', changed: ['lang'] });
  assert.equal(gameoptions.migrateLang(text, { lang: 'en' }).text, text, 'launcher en anglais : rien');
  assert.equal(gameoptions.migrateLang(text, {}).changed.length, 0);
  // choix du joueur : jamais touché
  for (const chosen of ['de_de', 'fr_ca', 'fr_fr', 'es_es']) {
    const mine = `lang:${chosen}\nautoJump:true\n`;
    assert.deepEqual(gameoptions.migrateLang(mine, { lang: 'fr' }), { text: mine, changed: [] }, chosen);
  }
});

test('migrateLang : fichier sans ligne lang (valeur par défaut) = ligne ajoutée avec la fin de ligne du fichier', () => {
  assert.equal(gameoptions.migrateLang('enableVsync:false\n', { lang: 'fr' }).text, 'enableVsync:false\nlang:fr_fr\n');
  assert.equal(gameoptions.migrateLang('enableVsync:false', { lang: 'fr' }).text, 'enableVsync:false\nlang:fr_fr\n', 'sans retour final');
  assert.equal(gameoptions.migrateLang('a:1\r\nb:2\r\n', { lang: 'fr' }).text, 'a:1\r\nb:2\r\nlang:fr_fr\r\n');
  assert.equal(gameoptions.migrateLang('', { lang: 'fr', legacy: true }).text, 'lang:fr_FR\n');
});

test('apply : un dossier à l’étape 1 ne refait pas la vidéo mais fait la langue', async () => {
  const dir = tempDir();
  // le joueur a remis la VSync et 120 FPS après l'étape 1 : seule la langue change
  fs.writeFileSync(optionsFile(dir), 'version:3955\nenableVsync:true\nmaxFps:120\nlang:en_us\n');
  const result = await gameoptions.apply(dir, { from: 1, lang: 'fr' });
  assert.deepEqual(result, { action: 'updated', changed: ['lang'] });
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'version:3955\nenableVsync:true\nmaxFps:120\nlang:fr_fr\n');
  // dossier neuf déjà à l'étape 1 : seulement la langue est écrite
  const fresh = tempDir();
  assert.deepEqual(await gameoptions.apply(fresh, { from: 1, lang: 'fr' }), { action: 'created', changed: ['lang'] });
  assert.equal(fs.readFileSync(optionsFile(fresh), 'utf8'), 'lang:fr_fr\n');
  // étape 2 déjà faite : rien
  assert.deepEqual(await gameoptions.apply(dir, { from: 2, lang: 'fr' }), { action: 'unchanged', changed: [] });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('installation Forge 1.8.9 : options.txt créé avec lang:fr_FR seulement (pas de réglage vidéo), drapeau posé, jamais refait', async () => {
  const dir = tempDir();
  const first = await installer.installGameOptions(dir, FORGE, 'fr');
  assert.deepEqual(first, { action: 'created', changed: ['lang'] });
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'lang:fr_FR\n');
  assert.equal(readState(dir).gameOptions, gameoptions.VERSION);
  // le joueur passe en anglais : les installations suivantes n'y retouchent plus
  fs.writeFileSync(optionsFile(dir), 'lang:en_US\n');
  assert.equal((await installer.installGameOptions(dir, FORGE, 'fr')).action, 'skipped');
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'lang:en_US\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installation Forge 1.8.9 : options.txt existant en en_US passe en fr_FR, un autre choix de langue reste', async () => {
  const dir = tempDir();
  fs.writeFileSync(optionsFile(dir), 'invertYMouse:false\r\nfov:0.0\r\nlang:en_US\r\nmaxFps:120\r\n');
  const result = await installer.installGameOptions(dir, FORGE, 'fr');
  assert.deepEqual(result, { action: 'updated', changed: ['lang'] });
  assert.equal(fs.readFileSync(optionsFile(dir), 'latin1'), 'invertYMouse:false\r\nfov:0.0\r\nlang:fr_FR\r\nmaxFps:120\r\n', '120 FPS : réglage vidéo non touché en 1.8.9');
  const german = tempDir();
  fs.writeFileSync(optionsFile(german), 'lang:de_DE\n');
  assert.equal((await installer.installGameOptions(german, FORGE, 'fr')).action, 'unchanged');
  assert.equal(fs.readFileSync(optionsFile(german), 'utf8'), 'lang:de_DE\n');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(german, { recursive: true, force: true });
});

test('installation Fabric : un dossier déjà à gameOptions=1 ne refait pas l’étape 1 mais fait la langue (une fois)', async () => {
  const dir = tempDir();
  fs.writeFileSync(stateFile(dir), JSON.stringify({ gameOptions: 1, mod: { version: '1' } }));
  fs.writeFileSync(optionsFile(dir), 'version:3955\nenableVsync:true\nmaxFps:120\nlang:en_us\n');
  const result = await installer.installGameOptions(dir, FABRIC, 'fr');
  assert.deepEqual(result, { action: 'updated', changed: ['lang'] });
  assert.equal(fs.readFileSync(optionsFile(dir), 'utf8'), 'version:3955\nenableVsync:true\nmaxFps:120\nlang:fr_fr\n', 'VSync et 120 FPS laissés');
  assert.equal(readState(dir).gameOptions, 2);
  assert.equal(readState(dir).mod.version, '1');
  assert.equal((await installer.installGameOptions(dir, FABRIC, 'fr')).action, 'skipped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installation Fabric : dossier neuf = réglages vidéo + langue ; launcher en anglais = lang:en_us écrit, existant intact', async () => {
  const fresh = tempDir();
  assert.equal((await installer.installGameOptions(fresh, FABRIC, 'fr')).action, 'created');
  assert.equal(fs.readFileSync(optionsFile(fresh), 'utf8'), 'enableVsync:false\nmaxFps:260\nentityShadows:false\nrenderDistance:10\nlang:fr_fr\n');
  const english = tempDir();
  await installer.installGameOptions(english, FABRIC, 'en');
  assert.equal(fs.readFileSync(optionsFile(english), 'utf8'), 'enableVsync:false\nmaxFps:260\nentityShadows:false\nrenderDistance:10\nlang:en_us\n');
  const existing = tempDir();
  fs.writeFileSync(optionsFile(existing), 'lang:en_us\n');
  assert.equal((await installer.installGameOptions(existing, FABRIC, 'en')).action, 'unchanged');
  assert.equal(readState(existing).gameOptions, 2);
  for (const dir of [fresh, english, existing]) fs.rmSync(dir, { recursive: true, force: true });
});
