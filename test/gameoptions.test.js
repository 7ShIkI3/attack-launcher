'use strict';
// Réglages vidéo de départ (options.txt de Minecraft) : dossier neuf, valeurs par défaut de Minecraft remplacées une seule
// fois, choix du joueur et mise en forme du fichier intacts, erreurs sans conséquence pour l'installation.
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
  assert.match(log, /options\.txt : réglages vidéo de départ non appliqués/);

  // le fichier redevient normal : la nouvelle installation applique les réglages
  fs.rmdirSync(optionsFile(dir));
  fs.writeFileSync(optionsFile(dir), 'enableVsync:true\n');
  assert.equal((await installer.installGameOptions(dir)).action, 'updated');
  assert.equal(readState(dir).gameOptions, gameoptions.VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});
