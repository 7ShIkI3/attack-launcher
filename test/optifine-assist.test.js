'use strict';
// Assistants OptiFine du processus principal (src/main/optifine-assist.js) : un guetteur PAR PROFIL, créé avec l'identifiant et la version
// de Minecraft capturés au démarrage. Dossier Téléchargements TEMPORAIRE, fausses minuteries, vrais guetteurs et vraie importation ;
// les réglages passent par le vrai module settings. Rien ne touche au vrai dossier Téléchargements ni au réseau.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeZip, tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const optifine = require('../src/main/optifine');
const settings = require('../src/main/settings');
const assistModule = require('../src/main/optifine-assist');

const jarFor = (mc, salt = '') => makeZip({
  'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nTweakClass: ${optifine.forVersion(mc).tweak}\r\n\r\n`,
  'optifine/OptiFineForgeTweaker.class': `classe ${salt}`,
});
const nameFor = (mc) => `OptiFine_${mc}_${optifine.forVersion(mc).edition}.jar`;

/** Horloge factice partagée par tous les guetteurs : les minuteries ne partent que quand le test fait avancer le temps. */
function fakeClock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++sequence;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(ms, registry, profileIds) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        for (const id of profileIds) await registry.watcherOf(id)?.whenIdle();
      }
      time = target;
    },
  };
}

/**
 * Registre branché comme dans main.js : profils du catalogue qui ont OptiFine, réglages du vrai module settings (profil AFFICHÉ distinct),
 * événements enregistrés, ouverture d'optifine.net comptée.
 */
function setup({ shown = 'fabric-26.3' } = {}) {
  const root = tempDir('atk-assist-');
  const downloads = path.join(root, 'Telechargements');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(downloads, { recursive: true });
  const clock = fakeClock();
  const state = { settings: settings.sanitize({ profileId: shown }, settings.defaults({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })) };
  const events = [];
  const watchers = new Map();
  const saves = [];
  let opened = 0;
  const registry = assistModule.createAssistRegistry({
    resolveProfile: (profileId) => {
      const profile = typeof profileId === 'string' ? catalog.find(profileId) : undefined;
      return profile && catalog.hasOptifine(profile) ? { id: profile.id, mc: profile.mc } : null;
    },
    dir: downloads,
    importCopy: (file, mc) => optifine.importCopy(file, userData, mc),
    saveChoice: async (profileId, copy) => {
      saves.push([profileId, path.basename(copy.file)]);
      state.settings = settings.sanitize({ profiles: { [profileId]: { optifineJar: copy.file, optifine: true } } }, state.settings);
    },
    emit: (event) => events.push(event),
    openPage: () => { opened++; return true; },
    createWatcher: (options) => {
      const watcher = require('../src/main/optifine-watch').createWatcher(options);
      watchers.set(options.mc, watcher);
      return watcher;
    },
    watcherOptions: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  const byMc = { '1.8.9': 'forge-1.8.9', '1.7.10': 'forge-1.7.10' };
  const watcherOf = (profileId) => watchers.get(Object.keys(byMc).find((mc) => byMc[mc] === profileId));
  const wrapped = Object.assign(registry, { watcherOf });
  const put = (name, content) => {
    fs.writeFileSync(path.join(downloads, name), content);
  };
  const advance = (ms, ids = ['forge-1.8.9', 'forge-1.7.10']) => clock.advance(ms, wrapped, ids);
  const stateOf = (profileId) => events.filter((e) => e.profileId === profileId).map((e) => e.state);
  return {
    root, downloads, userData, registry: wrapped, clock, state, events, saves, put, advance, stateOf, opened: () => opened,
    clean: () => { registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('profil inconnu, sans OptiFine (Fabric) ou mal formé : NO_OPTIFINE pour start, use et cancel, aucun guetteur créé, rien d’émis', async () => {
  const s = setup();
  for (const bad of ['fabric-26.3', 'fabric-1.21.1', 'inconnu', '', undefined, null, 189, {}, '__proto__', 'constructor']) {
    for (const call of [() => s.registry.start(bad), () => s.registry.use(bad), () => s.registry.cancel(bad)]) {
      const result = await call();
      assert.equal(result.ok, false, String(bad));
      assert.equal(result.code, 'NO_OPTIFINE', String(bad));
      assert.match(result.message, /n'a pas OptiFine/);
      assert.equal(result.profileId, typeof bad === 'string' ? bad : null);
    }
  }
  assert.equal(s.registry.size(), 0);
  assert.deepEqual(s.events, []);
  assert.equal(s.opened(), 0);
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('start : le guetteur du profil est créé avec son identifiant et sa version ; chaque état émis et chaque réponse portent { profileId, mc }', async () => {
  const s = setup();
  const started = await s.registry.start('forge-1.7.10', { browser: false });
  assert.deepEqual([started.ok, started.profileId, started.mc, started.state, started.downloadsDir], [true, 'forge-1.7.10', '1.7.10', 'waiting', s.downloads]);
  assert.deepEqual(s.events.map((e) => [e.profileId, e.mc, e.state]), [['forge-1.7.10', '1.7.10', 'waiting']]);
  assert.equal(s.registry.size(), 1, 'un seul guetteur : celui de la 1.7.10');
  assert.equal(s.registry.isActive('forge-1.7.10'), true);
  assert.equal(s.registry.isActive('forge-1.8.9'), false);
  assert.equal(s.opened(), 0, 'browser:false : optifine.net n’est pas rouvert');
  assert.deepEqual(s.registry.snapshot('forge-1.7.10').mc, '1.7.10');
  assert.equal(s.registry.snapshot('forge-1.8.9'), null);
  s.clean();
});

test('optifine.net est ouvert une seule fois par attente : au premier start, pas au deuxième tant que le guetteur tourne, de nouveau après une annulation', async () => {
  const s = setup();
  await s.registry.start('forge-1.8.9');
  assert.equal(s.opened(), 1);
  const again = await s.registry.start('forge-1.8.9');
  assert.equal(s.opened(), 1, 'déjà en cours : l’état courant est renvoyé');
  assert.equal(again.state, 'waiting');
  assert.equal(s.clock.pending(), 2, 'un seul jeu de minuteries (sondage + délai)');
  await s.registry.start('forge-1.7.10');
  assert.equal(s.opened(), 2, 'l’autre profil a sa propre attente');
  s.registry.cancel('forge-1.8.9');
  await s.registry.start('forge-1.8.9');
  assert.equal(s.opened(), 3);
  s.clean();
});

test('import : le jar arrivé écrit dans les réglages du profil du guetteur (capturé au départ), pas dans ceux du profil affiché ni de l’autre', async () => {
  const s = setup({ shown: 'fabric-26.3' }); // la page affiche un profil Fabric pendant le téléchargement
  await s.registry.start('forge-1.7.10', { browser: false });
  s.put(nameFor('1.7.10'), jarFor('1.7.10', 'e7'));
  await s.advance(3000);
  assert.deepEqual(s.stateOf('forge-1.7.10'), ['waiting', 'checking', 'imported']);
  const imported = s.events.at(-1);
  assert.deepEqual([imported.profileId, imported.mc, imported.file, imported.version], ['forge-1.7.10', '1.7.10', nameFor('1.7.10'), 'HD_U_E7']);
  assert.deepEqual(s.saves, [['forge-1.7.10', nameFor('1.7.10')]]);
  const copy = path.join(s.userData, 'optifine', nameFor('1.7.10'));
  assert.equal(settings.forProfile(s.state.settings, 'forge-1.7.10').optifineJar, copy);
  assert.equal(settings.forProfile(s.state.settings, 'forge-1.7.10').optifine, true);
  assert.equal(settings.forProfile(s.state.settings, 'forge-1.8.9').optifineJar, '', 'la 1.8.9 n’a rien reçu');
  assert.equal(s.state.settings.profileId, 'fabric-26.3', 'le profil affiché ne change pas');
  assert.equal('optifineJar' in s.state.settings.profiles['fabric-26.3'], false);
  assert.equal(s.registry.isActive('forge-1.7.10'), false, 'fini');
  s.clean();
});

test('deux profils en même temps : chacun n’importe que son OptiFine, chacun écrit ses réglages, le jar de l’autre version est signalé (foreign) sans être importé', async () => {
  const s = setup();
  await s.registry.start('forge-1.8.9', { browser: false });
  await s.registry.start('forge-1.7.10', { browser: false });
  assert.deepEqual([s.registry.isActive('forge-1.8.9'), s.registry.isActive('forge-1.7.10')], [true, true]);
  s.put(nameFor('1.8.9'), jarFor('1.8.9', 'm5'));
  await s.advance(3000);
  assert.deepEqual(s.saves, [['forge-1.8.9', nameFor('1.8.9')]]);
  assert.equal(s.registry.isActive('forge-1.8.9'), false);
  assert.equal(s.registry.isActive('forge-1.7.10'), true, 'le guetteur 1.7.10 attend toujours son jar');
  const seen = s.events.filter((e) => e.profileId === 'forge-1.7.10' && e.foreign);
  assert.deepEqual(seen.map((e) => [e.state, e.foreign]), [['waiting', [nameFor('1.8.9')]]], 'le 1.7.10 signale l’OptiFine 1.8.9 arrivé');
  s.put(nameFor('1.7.10'), jarFor('1.7.10', 'e7'));
  await s.advance(3000);
  assert.deepEqual(s.saves, [['forge-1.8.9', nameFor('1.8.9')], ['forge-1.7.10', nameFor('1.7.10')]]);
  assert.equal(settings.forProfile(s.state.settings, 'forge-1.8.9').optifineJar, path.join(s.userData, 'optifine', nameFor('1.8.9')));
  assert.equal(settings.forProfile(s.state.settings, 'forge-1.7.10').optifineJar, path.join(s.userData, 'optifine', nameFor('1.7.10')));
  assert.deepEqual(fs.readdirSync(path.join(s.userData, 'optifine')).sort(), [nameFor('1.7.10'), nameFor('1.8.9')].sort());
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('use : sans guetteur, NO_FILE ; avec un jar déjà présent au départ, « Utiliser ce fichier » importe celui du profil demandé seulement', async () => {
  const s = setup();
  const idle = await s.registry.use('forge-1.7.10');
  assert.deepEqual([idle.ok, idle.code, idle.profileId, idle.mc, idle.state], [false, 'NO_FILE', 'forge-1.7.10', '1.7.10', 'idle']);
  s.put(nameFor('1.8.9'), jarFor('1.8.9', 'ancien'));
  s.put(nameFor('1.7.10'), jarFor('1.7.10', 'ancien'));
  await s.registry.start('forge-1.7.10', { browser: false });
  await s.registry.start('forge-1.8.9', { browser: false });
  assert.deepEqual([s.registry.snapshot('forge-1.7.10').state, s.registry.snapshot('forge-1.7.10').file], ['seen', nameFor('1.7.10')]);
  assert.deepEqual([s.registry.snapshot('forge-1.8.9').state, s.registry.snapshot('forge-1.8.9').file], ['seen', nameFor('1.8.9')]);
  assert.deepEqual(s.saves, [], 'rien n’est importé sans clic');
  const used = await s.registry.use('forge-1.7.10');
  assert.deepEqual([used.ok, used.profileId, used.mc, used.state], [true, 'forge-1.7.10', '1.7.10', 'imported']);
  assert.deepEqual(s.saves, [['forge-1.7.10', nameFor('1.7.10')]]);
  assert.equal(s.registry.snapshot('forge-1.8.9').state, 'seen', 'la proposition de la 1.8.9 attend toujours son clic');
  const none = await s.registry.use('forge-1.7.10');
  assert.equal(none.ok, false, 'déjà importé');
  s.clean();
});

test('cancel : n’arrête que le guetteur du profil demandé ; sans guetteur, rien à arrêter', async () => {
  const s = setup();
  assert.deepEqual(await s.registry.cancel('forge-1.7.10'), { ok: true, state: 'idle', profileId: 'forge-1.7.10', mc: '1.7.10' });
  await s.registry.start('forge-1.8.9', { browser: false });
  await s.registry.start('forge-1.7.10', { browser: false });
  const cancelled = await s.registry.cancel('forge-1.7.10');
  assert.deepEqual([cancelled.ok, cancelled.state, cancelled.profileId, cancelled.mc], [true, 'cancelled', 'forge-1.7.10', '1.7.10']);
  assert.deepEqual([s.registry.isActive('forge-1.8.9'), s.registry.isActive('forge-1.7.10')], [true, false]);
  assert.equal(s.clock.pending(), 2, 'seules les minuteries du 1.8.9 restent');
  s.put(nameFor('1.8.9'), jarFor('1.8.9', 'm5'));
  await s.advance(3000);
  assert.deepEqual(s.stateOf('forge-1.8.9'), ['waiting', 'checking', 'imported']);
  assert.deepEqual(s.stateOf('forge-1.7.10'), ['waiting', 'cancelled']);
  s.clean();
});

test('dispose (fermeture de l’application) : les minuteries de tous les guetteurs sont arrêtées, rien n’est publié', async () => {
  const s = setup();
  await s.registry.start('forge-1.8.9', { browser: false });
  await s.registry.start('forge-1.7.10', { browser: false });
  const before = s.events.length;
  assert.ok(s.clock.pending() >= 2);
  s.registry.dispose();
  assert.equal(s.clock.pending(), 0);
  assert.equal(s.events.length, before, 'aucun état publié');
  assert.deepEqual([s.registry.isActive('forge-1.8.9'), s.registry.isActive('forge-1.7.10')], [false, false]);
  s.clean();
});

test('refus : un jar sans TweakClass reçu par le guetteur 1.7.10 est « refused » avec son message en 1.7.10, sans rien enregistrer', async () => {
  const s = setup();
  await s.registry.start('forge-1.7.10', { browser: false });
  s.put(nameFor('1.7.10'), makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: autre.Tweaker\r\n\r\n' }));
  await s.advance(3000);
  const last = s.events.at(-1);
  assert.deepEqual([last.state, last.reason, last.profileId, last.mc], ['refused', 'NO_TWEAK', 'forge-1.7.10', '1.7.10']);
  assert.match(last.message, /Forge 1\.7\.10/);
  assert.deepEqual(s.saves, []);
  s.clean();
});
