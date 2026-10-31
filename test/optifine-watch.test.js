'use strict';
// Assistant OptiFine (src/main/optifine-watch.js) : sondage du dossier Téléchargements dans un dossier TEMPORAIRE, avec de fausses
// minuteries (aucune attente réelle) et un faux jar OptiFine valide. Rien ne touche au vrai dossier Téléchargements ni au réseau.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { makeZip, tempDir } = require('./helpers');
const optifine = require('../src/main/optifine');
const watch = require('../src/main/optifine-watch');

const MANIFEST = 'Manifest-Version: 1.0\r\nMain-Class: optifine.InstallerFrame\r\nTweakClass: optifine.OptiFineForgeTweaker\r\nTweakOrder: -1000\r\n\r\n';
const optifineJar = (salt = '') => makeZip({ 'META-INF/MANIFEST.MF': MANIFEST, 'optifine/OptiFineForgeTweaker.class': `classe ${salt}` });
const NAME = 'OptiFine_1.8.9_HD_U_M5.jar';

/** Horloge factice : les minuteries ne partent que quand le test fait avancer le temps ; `pending()` = minuteries restantes. */
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
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    now: () => time,
    /** Avance de `ms`, en lançant les minuteries échues dans l'ordre, et attend la fin de chaque sondage. */
    async advance(ms, watcher) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await watcher.whenIdle();
      }
      time = target;
    },
  };
}

/** Un dossier Téléchargements factice + un dossier de données + un guetteur branché sur la VRAIE importation. */
function setup(extra = {}) {
  const root = tempDir('atk-watch-');
  const downloads = path.join(root, 'Telechargements');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(downloads, { recursive: true });
  const clock = fakeClock();
  const events = [];
  const imports = [];
  const watcher = watch.createWatcher({
    dir: downloads,
    onState: (state) => events.push(state),
    importFile: async (file) => {
      imports.push(file);
      return optifine.importCopy(file, userData);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  const put = (name, content) => {
    const file = path.join(downloads, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const states = () => events.map((e) => e.state);
  return { root, downloads, userData, clock, events, imports, watcher, put, states, clean: () => { watcher.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('noms acceptés : OptiFine 1.8.9, preview_, suffixe « (n) » retiré, insensible à la casse ; le reste refusé', () => {
  for (const ok of [
    'OptiFine_1.8.9_HD_U_M5.jar', 'OptiFine-1.8.9-HD_U_M5.jar', 'preview_OptiFine_1.8.9_HD_U_M6_pre2.jar',
    'OptiFine_1.8.9_HD_U_M5 (1).jar', 'OptiFine_1.8.9_HD_U_M5 (12).jar', 'PREVIEW_OPTIFINE_1.8.9_HD_U_M6_PRE2.JAR', 'optifine_1.8.9_hd_u_l5.jar',
    'OptiFine_1.8.9_HD_U_M5(1).jar', // Firefox : « (1) » collé
  ]) assert.equal(watch.acceptedName(ok), true, ok);
  for (const bad of [
    'OptiFine_1.8.8_HD_U_I7.jar', 'OptiFine_1.12.2_HD_U_G5.jar', 'OptiFine_1.8.9.jar', 'OptiFine_1.8.9_HD_U_M5.jar.crdownload',
    'OptiFine_1.8.9_HD_U_M5.jar.part', 'OptiFine_1.8.9_HD_U_M5.tmp', 'OptiFine_1.8.9_HD_U_M5.zip', 'OptiFine_1.8.9_HD_U_M5 (copie).jar',
    'OptiFine_1.8.9_HD_U_M5(copie).jar', 'mon OptiFine_1.8.9_HD_U_M5.jar', 'Unconfirmed 123456.crdownload', 'autre-mod-1.8.9.jar', '',
  ]) assert.equal(watch.acceptedName(bad), false, bad);
});

test('fichiers partiels, vides, trop gros et pas encore finis : ignorés, rien n’est importé', async () => {
  const s = setup();
  s.put('OptiFine_1.8.9_HD_U_M5.jar.crdownload', optifineJar());
  s.put('OptiFine_1.8.9_HD_U_M6.jar.part', optifineJar());
  s.put('Unconfirmed 1.crdownload', 'x');
  s.put('OptiFine_1.8.9_HD_U_M3.tmp', 'x');
  await s.watcher.start();
  // apparaissent APRÈS le départ : vide ; jar avec son .part voisin (Firefox n'a pas fini)
  s.put('OptiFine_1.8.9_HD_U_L5.jar', '');
  s.put('OptiFine_1.8.9_HD_U_M4.jar', optifineJar('encours'));
  s.put('OptiFine_1.8.9_HD_U_M4.jar.part', 'reste');
  await s.clock.advance(5000, s.watcher);
  assert.deepEqual(s.states(), ['waiting'], 'toujours en attente');
  assert.deepEqual(s.imports, []);
  // le .part disparaît (téléchargement fini) : le jar devient un candidat, stable puis importé
  fs.rmSync(path.join(s.downloads, 'OptiFine_1.8.9_HD_U_M4.jar.part'));
  await s.clock.advance(3000, s.watcher);
  assert.equal(s.states().at(-1), 'imported');
  assert.deepEqual(s.imports.map((f) => path.basename(f)), ['OptiFine_1.8.9_HD_U_M4.jar']);
  s.clean();
});

test('fichier trop gros ou lien : ignorés (taille lue par lstat, lien jamais suivi)', async () => {
  const fake = (real) => ({
    readdir: (dir) => fsp.readdir(dir),
    lstat: async (file) => {
      const base = path.basename(file);
      if (base.includes('BIG')) return { isFile: () => true, isSymbolicLink: () => false, size: optifine.MAX_JAR + 1, mtimeMs: 1 };
      if (base.includes('LINK')) return { isFile: () => false, isSymbolicLink: () => true, size: 10, mtimeMs: 1 };
      return real.lstat(file);
    },
  });
  const s = setup({ fsApi: fake(fsp) });
  await s.watcher.start();
  s.put('OptiFine_1.8.9_BIG.jar', optifineJar());
  s.put('OptiFine_1.8.9_LINK.jar', optifineJar('lien'));
  fs.mkdirSync(path.join(s.downloads, 'OptiFine_1.8.9_DIR.jar')); // un dossier portant un nom de jar
  await s.clock.advance(6000, s.watcher);
  assert.deepEqual(s.states(), ['waiting']);
  assert.deepEqual(s.imports, []);
  s.clean();
});

test('vrai lien symbolique vers un jar valide : ignoré (essai sauté si Windows refuse de créer le lien)', async (t) => {
  const s = setup();
  const target = path.join(s.root, 'ailleurs', 'vrai.jar');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, optifineJar('cible'));
  await s.watcher.start();
  try {
    fs.symlinkSync(target, path.join(s.downloads, 'OptiFine_1.8.9_HD_U_M5.jar'), 'file');
  } catch (error) {
    s.clean();
    t.skip(`lien symbolique impossible ici (${error.code})`);
    return;
  }
  await s.clock.advance(6000, s.watcher);
  assert.deepEqual(s.states(), ['waiting']);
  assert.deepEqual(s.imports, []);
  s.clean();
});

test('stabilité : un fichier qui change de taille n’est repris qu’après deux sondages identiques ; le partiel n’est jamais validé', async () => {
  let validated = 0;
  const s = setup({ validate: async (file) => { validated++; return optifine.validate(file); } });
  await s.watcher.start();
  s.put(NAME, 'début du téléchargement'); // partiel : pas un jar
  await s.clock.advance(1000, s.watcher); // vu une première fois
  assert.equal(validated, 0);
  s.put(NAME, optifineJar()); // le fichier a grossi : nouvelle signature
  await s.clock.advance(1000, s.watcher);
  assert.equal(validated, 0, 'signature changée : pas encore stable');
  assert.deepEqual(s.states(), ['waiting']);
  await s.clock.advance(1000, s.watcher); // deux sondages de suite identiques
  assert.equal(validated, 1);
  assert.deepEqual(s.states(), ['waiting', 'checking', 'imported']);
  s.clean();
});

test('import d’un faux jar valide : copie privée dans <userData>/optifine, identique, état « imported », plus aucune minuterie', async () => {
  const s = setup();
  await s.watcher.start();
  const source = s.put(NAME, optifineJar('vrai'));
  await s.clock.advance(2000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'checking', 'imported']);
  const last = s.events.at(-1);
  assert.equal(last.file, NAME, 'un nom de fichier, jamais un chemin');
  assert.equal(last.version, 'HD_U_M5');
  assert.equal(last.downloadsDir, s.downloads);
  const copy = path.join(s.userData, 'optifine', NAME);
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(source)), 'copie identique');
  assert.equal(fs.readdirSync(path.join(s.userData, 'optifine')).some((f) => f.endsWith('.part')), false, 'aucun fichier temporaire');
  assert.equal(s.clock.pending(), 0, 'minuteries arrêtées après l’import');
  assert.equal(s.watcher.isActive(), false);
  s.clean();
});

test('refus : TweakClass absent, archive illisible, nom refusé par la validation ; l’état dit pourquoi et rien n’est copié', async () => {
  const cases = [
    ['NO_TWEAK', makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nTweakClass: autre.Tweaker\r\n\r\n' })],
    ['BAD_ZIP', 'pas une archive'],
  ];
  for (const [reason, content] of cases) {
    const s = setup();
    await s.watcher.start();
    s.put(NAME, content);
    await s.clock.advance(2000, s.watcher);
    assert.deepEqual(s.states(), ['waiting', 'checking', 'refused'], reason);
    assert.equal(s.events.at(-1).reason, reason);
    assert.equal(s.events.at(-1).file, NAME);
    assert.deepEqual(s.imports, []);
    assert.equal(fs.existsSync(path.join(s.userData, 'optifine')), false, 'rien copié');
    assert.equal(s.clock.pending(), 0);
    s.clean();
  }
  // WRONG_NAME : le nom accepté par le guetteur est refusé par la validation (injectée ici)
  const s = setup({ validate: async (file) => ({ ok: false, file, reason: 'WRONG_NAME', message: 'nom' }) });
  await s.watcher.start();
  s.put(NAME, optifineJar());
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.events.at(-1).state, 'refused');
  assert.equal(s.events.at(-1).reason, 'WRONG_NAME');
  s.clean();
});

test('suffixe « (1) » : OptiFine_1.8.9_HD_U_M5 (1).jar est repris et rangé sans le suffixe', async () => {
  const s = setup();
  await s.watcher.start();
  s.put('OptiFine_1.8.9_HD_U_M5 (1).jar', optifineJar());
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.states().at(-1), 'imported');
  assert.equal(s.events.at(-1).version, 'HD_U_M5');
  assert.deepEqual(fs.readdirSync(path.join(s.userData, 'optifine')), [NAME]);
  s.clean();
});

test('suffixe « (1) » collé de Firefox : le retéléchargement d’un jar déjà présent est repris et rangé sans le suffixe', async () => {
  const s = setup();
  s.put(NAME, optifineJar('ancien'));
  assert.equal((await s.watcher.start()).state, 'seen', 'l’ancien jar est seulement proposé');
  const source = s.put('OptiFine_1.8.9_HD_U_M5(1).jar', optifineJar('firefox'));
  await s.clock.advance(2000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'seen', 'checking', 'imported']);
  assert.equal(s.events.at(-1).file, 'OptiFine_1.8.9_HD_U_M5(1).jar');
  assert.equal(s.events.at(-1).version, 'HD_U_M5');
  assert.deepEqual(fs.readdirSync(path.join(s.userData, 'optifine')), [NAME]);
  assert.ok(fs.readFileSync(path.join(s.userData, 'optifine', NAME)).equals(fs.readFileSync(source)), 'le nouveau fichier, pas l’ancien');
  s.clean();
});

test('preview_ : la préversion OptiFine_1.8.9_HD_U_M6_pre2 est reprise', async () => {
  const s = setup();
  await s.watcher.start();
  s.put('preview_OptiFine_1.8.9_HD_U_M6_pre2.jar', optifineJar('pre2'));
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.states().at(-1), 'imported');
  assert.equal(s.events.at(-1).version, 'HD_U_M6_pre2');
  s.clean();
});

test('fichier déjà présent au départ : proposé (« seen »), jamais importé sans clic ; le clic l’importe', async () => {
  const s = setup();
  s.put('OptiFine_1.8.9_HD_U_L5.jar', optifineJar('ancien'));
  s.put('OptiFine_1.8.9_HD_U_M5.jar', optifineJar('recent'));
  const old = new Date(Date.now() - 86400000 * 30);
  fs.utimesSync(path.join(s.downloads, 'OptiFine_1.8.9_HD_U_L5.jar'), old, old);
  const start = await s.watcher.start();
  assert.equal(start.state, 'seen');
  assert.equal(start.file, 'OptiFine_1.8.9_HD_U_M5.jar', 'le plus récent est proposé');
  await s.clock.advance(60000, s.watcher);
  assert.deepEqual(s.imports, [], 'jamais importé sans clic');
  assert.deepEqual(s.states(), ['waiting', 'seen']);
  const used = await s.watcher.use();
  assert.equal(used.ok, true);
  assert.equal(used.state, 'imported');
  assert.deepEqual(s.imports.map((f) => path.basename(f)), ['OptiFine_1.8.9_HD_U_M5.jar']);
  assert.ok(fs.existsSync(path.join(s.userData, 'optifine', 'OptiFine_1.8.9_HD_U_M5.jar')));
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('fichier déjà présent mais invalide : ignoré, l’attente continue ; sans proposition, « use » répond NO_FILE', async () => {
  const s = setup();
  s.put(NAME, 'abîmé');
  const start = await s.watcher.start();
  assert.equal(start.state, 'waiting');
  const used = await s.watcher.use();
  assert.deepEqual([used.ok, used.code], [false, 'NO_FILE']);
  assert.deepEqual(s.imports, []);
  s.clean();
});

test('un nouveau téléchargement pendant une proposition la remplace : importé tout seul, la proposition disparaît', async () => {
  const s = setup();
  s.put('OptiFine_1.8.9_HD_U_L5.jar', optifineJar('ancien'));
  assert.equal((await s.watcher.start()).state, 'seen');
  s.put('OptiFine_1.8.9_HD_U_M5.jar', optifineJar('neuf'));
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.states().at(-1), 'imported');
  assert.equal(s.events.at(-1).file, 'OptiFine_1.8.9_HD_U_M5.jar');
  assert.deepEqual((await s.watcher.use()).code, 'NO_FILE');
  s.clean();
});

test('délai de 10 minutes dépassé : état « timeout » et plus AUCUNE minuterie ; « Attendre encore » relance un tour complet', async () => {
  const s = setup();
  await s.watcher.start();
  assert.equal(s.clock.pending(), 2, 'un sondage et le délai');
  await s.clock.advance(watch.TIMEOUT_MS - 1000, s.watcher);
  assert.equal(s.states().at(-1), 'waiting');
  await s.clock.advance(1000, s.watcher);
  assert.equal(s.states().at(-1), 'timeout');
  assert.equal(s.clock.pending(), 0, 'aucune minuterie restante');
  assert.equal(s.watcher.isActive(), false);
  // « Attendre encore »
  await s.watcher.start();
  assert.equal(s.states().at(-1), 'waiting');
  s.put(NAME, optifineJar());
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.states().at(-1), 'imported');
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('annulation : état « cancelled », minuteries arrêtées, plus rien n’est repris ensuite', async () => {
  const s = setup();
  await s.watcher.start();
  const cancelled = s.watcher.cancel();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(s.clock.pending(), 0);
  s.put(NAME, optifineJar());
  await s.clock.advance(20000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'cancelled']);
  assert.deepEqual(s.imports, []);
  s.watcher.cancel(); // sans surveillance : ne publie rien de plus
  assert.deepEqual(s.states(), ['waiting', 'cancelled']);
  s.clean();
});

test('un seul guetteur : un deuxième start ne crée aucune minuterie de plus et renvoie l’état courant', async () => {
  const s = setup();
  await s.watcher.start();
  const before = s.clock.pending();
  const again = await s.watcher.start();
  assert.equal(s.clock.pending(), before);
  assert.equal(again.state, 'waiting');
  assert.deepEqual(s.states(), ['waiting'], 'pas de deuxième « waiting »');
  s.clean();
});

test('fermeture de l’application : dispose arrête les minuteries sans rien publier', async () => {
  const s = setup();
  await s.watcher.start();
  assert.ok(s.clock.pending() > 0);
  const count = s.events.length;
  s.watcher.dispose();
  assert.equal(s.clock.pending(), 0);
  s.put(NAME, optifineJar());
  await s.clock.advance(60000, s.watcher);
  assert.equal(s.events.length, count);
  assert.deepEqual(s.imports, []);
  s.clean();
});

test('dossier Téléchargements introuvable : état « error » tout de suite, minuteries arrêtées', async () => {
  const s = setup();
  fs.rmSync(s.downloads, { recursive: true }); // dossier absent, sans autre dossier temporaire : s.clean() range tout
  const state = await s.watcher.start();
  assert.equal(state.state, 'error');
  assert.equal(state.reason, 'DIR_UNREADABLE');
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('import qui échoue (disque plein…) : état « error » avec le message, minuteries arrêtées', async () => {
  const s = setup({ importFile: async () => { throw Object.assign(new Error('Disque plein'), { code: 'ENOSPC' }); } });
  await s.watcher.start();
  s.put(NAME, optifineJar());
  await s.clock.advance(2000, s.watcher);
  assert.equal(s.states().at(-1), 'error');
  assert.equal(s.events.at(-1).reason, 'ENOSPC');
  assert.match(s.events.at(-1).message, /Disque plein/);
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

/** validate ou import qui échoue `times` fois (verrou d'antivirus ou de OneDrive), puis fait le vrai travail. */
function flaky(times, fail, real) {
  let calls = 0;
  const fn = async (...args) => (++calls <= times ? fail(...args) : real(...args));
  fn.calls = () => calls;
  return fn;
}
const unreadable = async (file) => ({ ok: false, file, reason: 'UNREADABLE', message: optifine.REASONS.UNREADABLE });
const busyLock = async () => { throw Object.assign(new Error('EBUSY: resource busy or locked, copyfile'), { code: 'EBUSY' }); };

test('verrou passager à la validation (antivirus, OneDrive) : repris aux sondages suivants, puis importé', async () => {
  for (const times of [1, 2]) {
    const validate = flaky(times, unreadable, optifine.validate);
    const s = setup({ validate });
    await s.watcher.start();
    s.put(NAME, optifineJar());
    await s.clock.advance(2000, s.watcher); // stable : première validation, refusée par le verrou
    assert.deepEqual(s.states(), ['waiting', 'checking'], `${times} : pas de refus définitif`);
    assert.equal(s.watcher.isActive(), true);
    await s.clock.advance(times * 1000, s.watcher);
    assert.deepEqual(s.states(), ['waiting', 'checking', 'imported'], `${times} : « checking » n’est pas republié`);
    assert.equal(validate.calls(), times + 1);
    assert.ok(fs.existsSync(path.join(s.userData, 'optifine', NAME)));
    assert.equal(s.clock.pending(), 0);
    s.clean();
  }
});

test('verrou passager à la copie (EBUSY, EPERM, refus UNREADABLE de la revalidation) : l’import est repris puis réussit', async () => {
  const locks = [
    busyLock,
    async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); },
    async () => { throw Object.assign(new Error(optifine.REASONS.UNREADABLE), { code: 'OPTIFINE_UNREADABLE', reason: 'UNREADABLE' }); },
  ];
  for (const lock of locks) {
    let userData = null;
    const importFile = flaky(2, lock, async (file) => optifine.importCopy(file, userData));
    const s = setup({ importFile });
    userData = s.userData;
    await s.watcher.start();
    s.put(NAME, optifineJar());
    await s.clock.advance(3000, s.watcher);
    assert.deepEqual(s.states(), ['waiting', 'checking'], 'deux échecs : toujours en cours');
    await s.clock.advance(1000, s.watcher);
    assert.deepEqual(s.states(), ['waiting', 'checking', 'imported']);
    assert.equal(importFile.calls(), 3);
    assert.ok(fs.existsSync(path.join(s.userData, 'optifine', NAME)));
    assert.equal(s.clock.pending(), 0);
    s.clean();
  }
});

test('« Utiliser ce fichier » sur un jar verrouillé : repris aux sondages suivants, sans nouveau clic', async () => {
  let locks = 0; // la proposition du départ lit le jar sans verrou ; le clic tombe sur un verrou qui dure deux lectures
  const s = setup({ validate: async (file) => (locks-- > 0 ? unreadable(file) : optifine.validate(file)) });
  s.put(NAME, optifineJar());
  assert.equal((await s.watcher.start()).state, 'seen');
  locks = 2;
  const used = await s.watcher.use();
  assert.deepEqual([used.ok, used.state, used.code], [false, 'checking', undefined], 'pas de refus ni de code d’erreur au clic');
  await s.clock.advance(1000, s.watcher);
  assert.equal(s.states().at(-1), 'checking');
  await s.clock.advance(1000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'seen', 'checking', 'imported']);
  assert.equal(s.clock.pending(), 0);
  s.clean();
});

test('verrou qui dure : refus « UNREADABLE » (ou erreur de copie) après LOCK_RETRIES sondages, plus aucune minuterie', async () => {
  const s = setup({ validate: unreadable });
  await s.watcher.start();
  s.put(NAME, optifineJar());
  await s.clock.advance(2000 + (watch.LOCK_RETRIES - 1) * 1000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'checking'], 'encore une tentative à faire');
  await s.clock.advance(1000, s.watcher);
  assert.deepEqual(s.states(), ['waiting', 'checking', 'refused']);
  assert.equal(s.events.at(-1).reason, 'UNREADABLE');
  assert.equal(s.clock.pending(), 0);
  assert.equal(s.watcher.isActive(), false);
  s.clean();

  const importFile = flaky(Infinity, busyLock, null);
  const c = setup({ importFile });
  await c.watcher.start();
  c.put(NAME, optifineJar());
  await c.clock.advance(2000 + watch.LOCK_RETRIES * 1000, c.watcher);
  assert.equal(c.states().at(-1), 'error');
  assert.equal(c.events.at(-1).reason, 'EBUSY');
  assert.equal(importFile.calls(), watch.LOCK_RETRIES + 1);
  assert.equal(c.clock.pending(), 0);
  c.clean();
});

test('« use » ne fait rien pendant qu’une validation tourne, et jamais deux fois', async () => {
  const s = setup();
  s.put(NAME, optifineJar());
  await s.watcher.start();
  const [a, b] = await Promise.all([s.watcher.use(), s.watcher.use()]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'un seul import');
  assert.equal(s.imports.length, 1);
  s.clean();
});

test('aucun accès réseau : ces modules n’importent ni http, ni réseau, ni Electron, et n’appellent jamais fetch ni shell', () => {
  const allowed = new Set([
    'node:fs', 'node:fs/promises', 'node:path', 'node:crypto', './zip', './maven', './fsretry', './optifine',
  ]);
  for (const name of ['optifine.js', 'optifine-watch.js', 'fsretry.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', name), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of stripped.matchAll(/require\(\s*'([^']+)'\s*\)/g)) assert.ok(allowed.has(m[1]), `${name} : require('${m[1]}') hors de la liste`);
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bdns\b|\bnet\.|https?\.(get|request)|openExternal|from 'electron'|require\('electron'\)/.test(stripped), false, `${name} : appel réseau ou shell`);
    assert.equal(/\bhttps?:\/\/(?!optifine\.net)/.test(stripped), false, `${name} : adresse inattendue`);
  }
});
