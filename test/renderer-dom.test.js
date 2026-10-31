'use strict';
// Accueil du launcher : app.js tourne ici sur un faux DOM minimal (pas d'Electron), avec l'état d'installation RÉEL calculé par
// installer.status() dans des dossiers temporaires. On lit la phrase « prêt » et les lignes du détail telles que la page les écrit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeZip, tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const installer = require('../src/main/installer');
const modpack = require('../src/main/modpack');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const FORGE = catalog.get('forge-1.8.9');

// ---------- faux DOM : juste ce que app.js touche au chargement et dans renderStatus ----------

let fakeDocument = null; // document du dernier boot() : focus() et la perte du focus (élément retiré ou grisé) passent par lui

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.listeners = {};
    this.hidden = false;
    this.isDisabled = false;
    this.value = '';
    this.checked = false;
    this.className = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    };
  }

  get textContent() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value) {
    this.children = value === '' ? [] : [String(value)];
  }

  get childNodes() {
    return this.children;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    const active = fakeDocument && fakeDocument.activeElement;
    const lost = Boolean(active) && this.children.some((child) => typeof child !== 'string' && child.contains(active));
    this.children = [...nodes];
    if (lost && !this.contains(active)) fakeDocument.activeElement = fakeDocument.body; // comme un navigateur : l'élément retiré perd le focus
  }

  get disabled() {
    return this.isDisabled;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (this.isDisabled && fakeDocument && fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  focus() {
    if (fakeDocument) fakeDocument.activeElement = this;
  }

  contains(node) {
    return node === this || this.children.some((child) => typeof child !== 'string' && child.contains(node));
  }

  /** Seuls les sélecteurs de la reprise du focus : [data-focus-key], [data-focus-key="…"] et un nom de balise (h1, button) ; le reste : aucun noeud. */
  querySelectorAll(selector) {
    const match = /^\[data-focus-key(?:="([^"]*)")?\]$/.exec(selector);
    const tag = /^[a-z][a-z0-9]*$/.test(selector) ? selector : null;
    if (!match && !tag) return [];
    const all = [];
    const walk = (node) => node.children.forEach((child) => {
      if (typeof child === 'string') return;
      const key = child.attributes['data-focus-key'];
      if (match ? key !== undefined && (match[1] === undefined || key === match[1]) : child.tagName === tag) all.push(child);
      walk(child);
    });
    walk(this);
    return all;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/**
 * Charge i18n.js, data.js, logo.js puis app.js dans un contexte isolé ; `attack` = la fausse API du processus principal.
 * Attend la fin du chargement (init + lecture de l'état) ; renvoie { byId } : les noeuds de la page par identifiant.
 */
async function boot({ info, settings, status }) {
  const nodes = new Map();
  const document = {
    documentElement: new FakeNode('html'),
    body: new FakeNode('body'),
    activeElement: null,
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, new FakeNode());
      return nodes.get(id);
    },
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag),
    importNode: (node) => node,
    querySelectorAll: (selector) => (selector.startsWith('.') ? [...nodes.values()].filter((node) => node.classList.contains(selector.slice(1))) : []), // .page, .nav-item… : les noeuds que le test a marqués
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  fakeDocument = document;
  const noop = () => {};
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let statusRead = false;
  const assistCalls = [];
  const assistHandlers = [];
  const attack = {
    info: async () => info,
    getSettings: async () => settings,
    setSettings: async (patch) => Object.assign(settings, patch),
    status: async () => {
      statusRead = true;
      return status;
    },
    accounts: { list: async () => ({ accounts: [], hasClientId: false, devMode: false }) },
    update: { state: async () => ({ phase: 'off' }) },
    onProgress: noop, onAuthEvent: noop, onAccountsChanged: noop, onUpdateState: noop, onWindowState: noop,
    onOptifineAssist: (callback) => { assistHandlers.push(callback); },
    optifineAssist: {
      start: async (options) => { assistCalls.push(['start', options]); return { ok: true, state: 'waiting', downloadsDir: 'D:\\Dl' }; },
      use: async () => { assistCalls.push(['use']); return { ok: true }; },
      cancel: async () => { assistCalls.push(['cancel']); return { ok: true }; },
    },
  };
  const window = { attack, addEventListener: noop };
  const sandbox = {
    window, self: window, document, console, setTimeout, clearTimeout,
    DOMParser: class { parseFromString() { return { documentElement: new FakeNode('svg') }; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'data.js', 'logo.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, file), 'utf8'), sandbox, { filename: file });
  }
  const byId = (id) => document.getElementById(id);
  // init() enchaîne plusieurs await : on attend que la page ait demandé l'état, puis qu'elle l'ait affiché
  for (let i = 0; i < 100 && !statusRead; i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(byId('message').textContent, '', 'la page n’a pas affiché d’erreur au chargement');
  // événement de l'assistant OptiFine venu du processus principal ; attend la fin des rendus qu'il déclenche
  const emitAssist = async (state) => {
    for (const handler of assistHandlers) await handler(state);
    for (let i = 0; i < 5; i++) await tick();
  };
  return { byId, window, document, assistCalls, emitAssist, tick };
}

// ---------- état d'installation réel ----------

const MANIFEST = 'Manifest-Version: 1.0\r\nTweakClass: optifine.OptiFineForgeTweaker\r\n\r\n';

/** Installation 1.8.9 complète (pack et mod compris) sans OptiFine, comme dans optifine.test.js ; renvoie les dossiers. */
function installed189() {
  const root = tempDir('atk-dom-');
  const put = (rel, content) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const vid = FORGE.loader.versionId;
  put('.minecraft/versions/1.8.9/1.8.9.json', JSON.stringify({ assetIndex: { id: '1.8' } }));
  put('.minecraft/versions/1.8.9/1.8.9.jar', 'x');
  put('.minecraft/assets/indexes/1.8.json', 'x');
  put(`.minecraft/versions/${vid}/${vid}.json`, JSON.stringify({ id: vid }));
  put('.minecraft/libraries/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar', 'x');
  put('.minecraft/launcher_profiles.json', JSON.stringify({ profiles: { [FORGE.launcherProfileId]: { name: FORGE.name } } }));
  put('game/mods/attack-client.jar', 'mod');
  const managed = [];
  for (const m of modpack.selectedMods(modpack.loadPack(FORGE))) {
    fs.truncateSync(put(`game/mods/${m.filename}`, ''), m.size);
    managed.push(m.filename);
  }
  put('game/attack-launcher.json', JSON.stringify({ mod: { version: '2.5.4', source: 'release' }, pack: { id: 'forge-1.8.9', managed } }));
  const source = put('.minecraft/libraries/optifine/OptiFine/1.8.9_HD_U_M5/OptiFine-1.8.9_HD_U_M5.jar',
    makeZip({ 'META-INF/MANIFEST.MF': MANIFEST, 'optifine/OptiFineForgeTweaker.class': 'classe' }));
  return { root, source, minecraftDir: path.join(root, '.minecraft'), gameDir: path.join(root, 'game') };
}

/** Ce que la page affiche pour l'état réel du profil 1.8.9 avec ces réglages. */
async function render(dirs, settings) {
  const status = await installer.status({ minecraftDir: dirs.minecraftDir, gameDir: dirs.gameDir, profile: FORGE, ...settings });
  const info = {
    version: '0.6.0', minecraftDir: dirs.minecraftDir, totalRamMb: 16384, launcherDetected: true,
    profiles: catalog.list().map((p) => ({ ...catalog.view(p), pack: modpack.view(modpack.loadPack(p)) })),
  };
  const page = await boot({
    info, status,
    settings: { ramMb: 3072, gameDir: dirs.gameDir, lang: 'fr', profileId: 'forge-1.8.9', javaPath: '', jvmArgs: '', devMode: false, devJarDir: '', msClientId: '', ...settings },
  });
  const rows = page.byId('ready-pop').children.map((row) => ({
    label: row.children[1].children[0].textContent,
    detail: row.children[1].children[1].textContent,
    bad: /\bbad\b/.test(row.className),
  }));
  return { status, main: page.byId('ready-main').textContent, rows, button: page.byId('play-label').textContent, page };
}

test('accueil : l’état normal montre « Tout est prêt » et JOUER, la ligne OptiFine nomme la copie', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  const view = await render(dirs, {});
  assert.equal(view.main, 'Tout est prêt');
  assert.equal(view.button, 'JOUER');
  const of = view.rows.find((r) => r.label === 'OptiFine');
  assert.deepEqual([of.detail, of.bad], ['OptiFine HD U M5', false]);
  assert.equal(view.rows.some((r) => r.bad), false);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil : seul le retrait d’OptiFine en attente (option coupée) = ligne « à retirer », jamais « À installer : » vide', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  const view = await render(dirs, { optifine: false });
  assert.deepEqual([view.status.installed, view.status.optifine.pending, view.status.optifine.wantCopy], [false, true, false]);
  assert.equal(view.button, 'INSTALLER');
  assert.equal(view.main, 'Mise à jour à appliquer', 'rien à installer, un retrait à faire : texte générique');
  const of = view.rows.find((r) => r.label === 'OptiFine');
  assert.deepEqual([of.detail, of.bad], ['à retirer', true], 'la ligne du détail est marquée à faire');
  assert.deepEqual(view.rows.filter((r) => r.bad).map((r) => r.label), ['OptiFine'], 'le reste est en place');
  assert.doesNotMatch(view.main, /À installer/);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil : retrait d’OptiFine + autre élément manquant = on ne nomme que ce qui est à installer', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  fs.rmSync(path.join(dirs.minecraftDir, 'versions', '1.8.9'), { recursive: true, force: true });
  const view = await render(dirs, { optifine: false });
  assert.match(view.main, /^À installer\u00a0: /); // espace insécable avant « : » (typographie française de t())
  assert.doesNotMatch(view.main, /OptiFine/, 'le retrait n’est pas « à installer »');
  assert.equal(view.rows.find((r) => r.label === 'OptiFine').detail, 'à retirer');
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil : OptiFine du joueur arrivé dans mods alors que la copie du launcher y est encore = « à retirer »', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  fs.writeFileSync(path.join(dirs.gameDir, 'mods', 'OptiFine_1.8.9_HD_U_L5.jar'), 'jar du joueur');
  const view = await render(dirs, {});
  assert.equal(view.main, 'Mise à jour à appliquer');
  assert.deepEqual([view.rows.find((r) => r.label === 'OptiFine').detail], ['à retirer']);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil : copie à poser = « À installer : OptiFine » comme avant ; copie d’origine disparue = tout est prêt', async () => {
  const dirs = installed189();
  const toCopy = await render(dirs, {});
  assert.equal(toCopy.main, 'À installer\u00a0: OptiFine');
  assert.equal(toCopy.rows.find((r) => r.label === 'OptiFine').detail, 'à copier');
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  fs.rmSync(dirs.source);
  const gone = await render(dirs, {});
  assert.equal(gone.main, 'Tout est prêt', 'le jar de mods marche encore');
  assert.equal(gone.button, 'JOUER');
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

/** Tout ce que la page dit d'OptiFine : ligne du détail, compteur, rail « Profil actuel », carte de la page Mods, carte de Réglages. */
function optifineParts(view) {
  const cell = view.page.byId('pc-grid').children.find((c) => c.children[0].textContent === 'OptiFine');
  const card = view.page.byId('mods-grid').children.find((c) => c.children[0].children[1].textContent === 'OptiFine');
  return {
    row: view.rows.find((r) => r.label === 'OptiFine'),
    sum: view.page.byId('ready-sum').textContent,
    rail: cell.children[1].textContent,
    cardOff: /\boff\b/.test(card.className),
    cardMeta: card.children[2].children[0].textContent,
    badge: view.page.byId('optifine-badge').textContent,
    badgeClass: view.page.byId('optifine-badge').className,
    text: view.page.byId('optifine-text').textContent,
  };
}

test('accueil : copie d’origine disparue, le jar gardé dans mods est compté et jamais dit « introuvable » (détail, compteur, rail, cartes)', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  const before = optifineParts(await render(dirs, {}));
  fs.rmSync(dirs.source); // OptiFine désinstallé : le jar copié dans mods marche toujours
  const view = await render(dirs, {});
  const gone = optifineParts(view);
  assert.deepEqual([view.status.optifine.found, view.status.optifine.installed], [false, true]);
  assert.deepEqual([gone.row.detail, gone.row.bad], ['déjà copié dans mods', false], 'la ligne du détail');
  assert.equal(gone.sum, before.sum, 'le compteur de mods compte le jar gardé, comme avant la disparition');
  assert.equal(gone.rail, before.rail, 'le rail « Profil actuel » nomme la variante');
  assert.equal(gone.rail, 'HD U M5');
  assert.equal(gone.cardOff, false, 'la carte de la page Mods n’est pas grisée');
  assert.equal(gone.cardMeta.includes('déjà copié dans mods'), true);
  assert.deepEqual([gone.badge, gone.badgeClass], ['Déjà copié', 'badge good'], 'badge de la carte Réglages');
  assert.match(gone.text, /OptiFine-1\.8\.9_HD_U_M5\.jar/);
  assert.match(gone.text, /Rien à faire/);
  for (const [name, value] of Object.entries(gone)) assert.doesNotMatch(String(value), /introuvable|Introuvable|optifine\.net/, `« introuvable » dans ${name}`);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil : copie d’origine disparue, option coupée = ni gardé ni compté (retrait à faire) ; sans jar suivi = « introuvable » comme avant', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  fs.rmSync(dirs.source);
  const off = optifineParts(await render(dirs, { optifine: false }));
  assert.deepEqual([off.row.detail, off.row.bad], ['à retirer', true]);
  assert.equal(off.cardOff, true);
  assert.equal(off.rail, 'Coupé', 'rail « Profil actuel » : OptiFine est un seul mod (pas « Coupés »)');
  const bare = installed189();
  fs.rmSync(bare.source);
  const none = optifineParts(await render(bare, {}));
  assert.deepEqual([none.row.detail, none.badge, none.cardOff], ['introuvable', 'Introuvable', true], 'rien dans mods : vraiment introuvable');
  fs.rmSync(dirs.root, { recursive: true, force: true });
  fs.rmSync(bare.root, { recursive: true, force: true });
});

test('accueil en anglais : copie d’origine disparue = « already copied to mods », pas « not found »', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  fs.rmSync(dirs.source);
  const gone = optifineParts(await render(dirs, { lang: 'en' }));
  assert.equal(gone.row.detail, 'already copied to mods');
  assert.equal(gone.badge, 'Already copied');
  assert.match(gone.text, /Nothing to do/);
  for (const [name, value] of Object.entries(gone)) assert.doesNotMatch(String(value), /not found|Not found/i, `« not found » dans ${name}`);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('accueil en anglais : « Update to apply » et « to remove »', async () => {
  const dirs = installed189();
  await installer.installOptifine(dirs.gameDir, dirs.minecraftDir, {});
  const view = await render(dirs, { optifine: false, lang: 'en' });
  assert.equal(view.main, 'Update to apply');
  assert.equal(view.rows.find((r) => r.label === 'OptiFine').detail, 'to remove');
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

// ---------- alerte de l'accueil et assistant OptiFine (même faux DOM) ----------

/** Tous les noeuds d'un arbre du faux DOM, dans l'ordre. */
function nodesOf(node, out = []) {
  if (!node || typeof node === 'string') return out;
  out.push(node);
  for (const child of node.children) nodesOf(child, out);
  return out;
}
const labelsOf = (node) => nodesOf(node).filter((n) => n.tagName === 'button').map((n) => n.textContent);
const plain = (value) => JSON.parse(JSON.stringify(value)); // sort l'objet du contexte isolé (prototypes différents)
const clickLabel = (node, label) => nodesOf(node).find((n) => n.tagName === 'button' && n.textContent === label).listeners.click[0]();

test('alerte de l’accueil : role=alert, texte copiable, action selon le code, croix ; une erreur sans action n’a que « Copier »', async () => {
  const dirs = installed189();
  const { page } = await render(dirs, {});
  const { byId } = page;
  assert.equal(byId('message').textContent, '', 'rien au chargement');
  page.window.AttackUI.showError('LAUNCHER_NOT_FOUND');
  assert.equal(byId('alert').classList.contains('hidden'), false);
  assert.match(byId('message').textContent, /Pas de compte connecté/);
  assert.equal(byId('lower').inert, true, 'la ligne « prêt » et les outils recouverts ne sont plus atteignables au clavier');
  assert.equal(byId('alert-action').classList.contains('hidden'), false);
  assert.equal(byId('alert-action').textContent, 'Connecter un compte');
  byId('alert-close').listeners.click[0]();
  assert.equal(byId('alert').classList.contains('hidden'), true);
  assert.equal(byId('lower').inert, false);
  assert.equal(byId('message').textContent, '');
  page.window.AttackUI.showError('SOMETHING_ELSE', 'disque plein');
  assert.equal(byId('alert').classList.contains('hidden'), false);
  assert.equal(byId('alert-action').classList.contains('hidden'), true, 'pas d’action pour un code inconnu');
  assert.match(byId('message').textContent, /disque plein/);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('assistant OptiFine : chaque état a son titre, son texte ou ses étapes et ses boutons, annoncés par la zone aria-live', async () => {
  const dirs = installed189();
  fs.rmSync(dirs.source); // aucune copie : la carte Réglages et la carte de la page Mods portent l'assistant
  const { page } = await render(dirs, {});
  const { byId } = page;
  const live = () => byId('optifine-live').textContent;
  const settingsCard = () => byId('optifine-assist');
  const modsCard = () => byId('mods-grid').children.find((card) => /OptiFine/.test(card.textContent) && /wide/.test(card.className));

  // au repos : rien dans la carte Réglages (le bouton « Obtenir OptiFine » y est), l'invitation sur la carte de la page Mods
  assert.equal(settingsCard().children.length, 0);
  assert.ok(modsCard(), 'carte OptiFine large sans copie');
  assert.deepEqual(labelsOf(modsCard()), ['Obtenir OptiFine', 'Choisir le fichier…']);
  assert.equal(nodesOf(modsCard()).some((n) => n.tagName === 'details'), true, '« Pourquoi ? » sur la carte de la page Mods');
  assert.equal(nodesOf(modsCard()).some((n) => n.tagName === 'input'), false, 'pas d’interrupteur actif sans copie');

  await page.emitAssist({ state: 'waiting', downloadsDir: 'D:\\Telechargements' });
  const waiting = settingsCard().textContent;
  assert.match(waiting, /En attente de ton téléchargement/);
  assert.match(waiting, /\(Mirror\)/);
  assert.match(waiting, /Download/);
  assert.match(waiting, /Conserver/);
  assert.match(waiting, /D:\\Telechargements/);
  assert.deepEqual(labelsOf(settingsCard()), ['Annuler']);
  assert.equal(byId('optifine-download').disabled, true, 'pas de second guetteur');
  assert.match(live(), /En attente de ton téléchargement/);

  await page.emitAssist({ state: 'seen', file: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Fichier repéré/);
  assert.match(settingsCard().textContent, /OptiFine_1\.8\.9_HD_U_M5\.jar était déjà dans D:\\Dl/);
  assert.deepEqual(labelsOf(settingsCard()), ['Utiliser ce fichier', 'Annuler']);
  await clickLabel(settingsCard(), 'Utiliser ce fichier');
  assert.deepEqual(plain(page.assistCalls.at(-1)), ['use']);

  await page.emitAssist({ state: 'checking', file: 'OptiFine_1.8.9_HD_U_M5.jar', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Vérification/);
  assert.deepEqual(labelsOf(settingsCard()), []);

  await page.emitAssist({ state: 'refused', file: 'OptiFine_1.8.9_HD_U_M5.jar', reason: 'NO_TWEAK', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Fichier refusé/);
  assert.match(settingsCard().textContent, /pas OptiFine pour Forge 1\.8\.9/);
  assert.deepEqual(labelsOf(settingsCard()), ['Réessayer', 'Choisir le fichier…']);
  assert.match(live(), /Fichier refusé/);

  await page.emitAssist({ state: 'timeout', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Rien reçu/);
  assert.match(settingsCard().textContent, /10 minutes/);
  assert.deepEqual(labelsOf(settingsCard()), ['Attendre encore', 'Choisir le fichier…']);
  await clickLabel(settingsCard(), 'Attendre encore');
  assert.deepEqual(plain(page.assistCalls.at(-1)), ['start', { browser: false }], '« Attendre encore » ne rouvre pas le navigateur');

  await page.emitAssist({ state: 'cancelled', downloadsDir: 'D:\\Dl' });
  assert.deepEqual(labelsOf(settingsCard()), ['Relancer', 'Choisir le fichier…']);
  await clickLabel(settingsCard(), 'Relancer');
  assert.deepEqual(plain(page.assistCalls.at(-1)), ['start', { browser: true }]);

  await page.emitAssist({ state: 'error', reason: 'DIR_UNREADABLE', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Le dossier Téléchargements est illisible\u00a0: D:\\Dl/);
  await page.emitAssist({ state: 'error', reason: 'ENOSPC', message: 'Disque plein', downloadsDir: 'D:\\Dl' });
  assert.match(settingsCard().textContent, /Impossible de continuer/);

  // « Obtenir OptiFine » (carte Réglages) lance la surveillance ET ouvre optifine.net (le processus principal décide)
  byId('optifine-download').disabled = false;
  await byId('optifine-download').listeners.click[0]();
  assert.deepEqual(plain(page.assistCalls.at(-1)), ['start', { browser: true }]);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('assistant OptiFine : « importé » propose Installer maintenant, et la page relit réglages et état', async () => {
  const dirs = installed189();
  fs.rmSync(dirs.source);
  const { page } = await render(dirs, {});
  await page.emitAssist({ state: 'imported', file: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5', downloadsDir: 'D:\\Dl' });
  const text = page.byId('optifine-assist').textContent;
  assert.match(text, /OptiFine HD U M5 est prêt/);
  assert.match(text, /à la prochaine installation/);
  assert.deepEqual(labelsOf(page.byId('optifine-assist')), ['Installer maintenant']);
  assert.match(page.byId('optifine-live').textContent, /OptiFine HD U M5 est prêt/);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test('assistant OptiFine au clavier : le focus ne retombe jamais sur <body> quand l’état change (Réglages et page Mods)', async (t) => {
  const dirs = installed189();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  fs.rmSync(dirs.source);
  const { page } = await render(dirs, {});
  const { byId } = page;
  const settingsCard = () => byId('optifine-assist');
  const modsCard = () => byId('mods-grid').children.find((card) => /OptiFine/.test(card.textContent) && /wide/.test(card.className));
  const focused = () => page.document.activeElement;
  const keyOf = () => focused() && focused().dataset && focused().dataset.focusKey;
  const button = (root, label) => nodesOf(root).find((n) => n.tagName === 'button' && n.textContent === label);
  /** Entrée sur un bouton : focus puis clic, et attente des rendus qui suivent. */
  const press = async (node) => {
    node.focus();
    await node.listeners.click[0]();
    for (let i = 0; i < 5; i++) await page.tick();
  };
  const onTitle = (card, variant, step) => {
    assert.notEqual(focused(), page.document.body, `${step} : pas sur <body>`);
    assert.equal(keyOf(), `assist:${variant}:title`, `${step} : sur le titre de l’assistant`);
    assert.ok(card.contains(focused()), `${step} : dans le bloc affiché`);
  };

  // Réglages : « Obtenir OptiFine » est hors du bloc et devient grisé pendant la surveillance
  await press(byId('optifine-download'));
  assert.equal(byId('optifine-download').disabled, true);
  onTitle(settingsCard(), 'settings', 'Obtenir OptiFine');
  await press(button(settingsCard(), 'Annuler'));
  await page.emitAssist({ state: 'cancelled', downloadsDir: 'D:\\Dl' });
  onTitle(settingsCard(), 'settings', 'Annuler');
  await press(button(settingsCard(), 'Relancer'));
  onTitle(settingsCard(), 'settings', 'Relancer');
  await page.emitAssist({ state: 'seen', file: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5', downloadsDir: 'D:\\Dl' });
  onTitle(settingsCard(), 'settings', 'titre gardé d’un état à l’autre');
  await press(button(settingsCard(), 'Utiliser ce fichier'));
  await page.emitAssist({ state: 'checking', file: 'OptiFine_1.8.9_HD_U_M5.jar', downloadsDir: 'D:\\Dl' });
  onTitle(settingsCard(), 'settings', 'Utiliser ce fichier (vérification, aucun bouton)');
  await page.emitAssist({ state: 'refused', file: 'OptiFine_1.8.9_HD_U_M5.jar', reason: 'NO_TWEAK', downloadsDir: 'D:\\Dl' });
  onTitle(settingsCard(), 'settings', 'refusé');
  // un bouton présent dans les deux états garde le focus : la clé est son rôle, pas son libellé (Réessayer -> Attendre encore)
  button(settingsCard(), 'Réessayer').focus();
  await page.emitAssist({ state: 'timeout', downloadsDir: 'D:\\Dl' });
  assert.equal(keyOf(), 'assist:settings:start');
  assert.equal(focused().textContent, 'Attendre encore');

  // page Mods : la grille entière est refaite, le focus reste sur la carte OptiFine
  await page.emitAssist({ state: 'cancelled', downloadsDir: 'D:\\Dl' });
  await press(button(modsCard(), 'Relancer'));
  onTitle(modsCard(), 'mods', 'Relancer (page Mods)');
  await press(button(modsCard(), 'Annuler'));
  await page.emitAssist({ state: 'cancelled', downloadsDir: 'D:\\Dl' });
  onTitle(modsCard(), 'mods', 'Annuler (page Mods)');
});

test('assistant OptiFine en anglais : « (Mirror) », « Download », « Keep » dans les étapes', async () => {
  const dirs = installed189();
  fs.rmSync(dirs.source);
  const { page } = await render(dirs, { lang: 'en' });
  await page.emitAssist({ state: 'waiting', downloadsDir: 'D:\\Dl' });
  const text = page.byId('optifine-assist').textContent;
  assert.match(text, /Waiting for your download/);
  assert.match(text, /“\(Mirror\)”/);
  assert.match(text, /“Keep”/);
  assert.deepEqual(labelsOf(page.byId('optifine-assist')), ['Cancel']);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

// ---------- focus clavier : l'élément focalisé disparaît ou sa page est masquée ----------

/** Entrée sur un bouton ou un interrupteur : focus, puis son gestionnaire, puis les rendus qui suivent. */
async function pressKey(page, node, event = 'click', ...args) {
  node.focus();
  await node.listeners[event][0](...args);
  for (let i = 0; i < 5; i++) await page.tick();
}
const dataKey = (node) => node && node.attributes && node.attributes['data-focus-key'];

test('alerte de l’accueil au clavier : fermée ou activée, le focus va à une commande visible, jamais <body>', async (t) => {
  const dirs = installed189();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const { page } = await render(dirs, {});
  const { byId, document } = page;
  // le faux DOM n'a pas la page HTML : on lui donne la hiérarchie dont showPage et l'alerte ont besoin
  const titles = {};
  for (const name of ['home', 'mods', 'settings', 'account']) {
    const section = byId(`page-${name}`);
    section.id = `page-${name}`;
    section.classList.add('page');
    section.classList.toggle('active', name === 'home');
    titles[name] = new FakeNode('h1');
    section.append(titles[name]);
  }
  byId('page-home').append(byId('ready-btn'), byId('play-button'), byId('alert'));
  byId('alert').append(byId('alert-close'), byId('alert-action'), byId('alert-copy'));
  byId('page-mods').append(byId('mods-q'));
  const body = document.body;

  // la croix masque le bouton qui a le focus : la ligne « prêt » de l'accueil le reprend
  page.window.AttackUI.showError('SOMETHING_ELSE', 'disque plein');
  await pressKey(page, byId('alert-close'));
  assert.equal(byId('alert').classList.contains('hidden'), true);
  assert.equal(byId('lower').inert, false);
  assert.notEqual(document.activeElement, body);
  assert.equal(document.activeElement, byId('ready-btn'));

  // le bouton d'action masque l'alerte puis la page d'accueil entière : le titre de la page affichée reprend le focus
  for (const [code, name] of [['NO_ACCOUNT', 'account'], ['JAVA_NOT_FOUND', 'settings']]) {
    page.window.AttackUI.showError(code);
    assert.equal(byId('alert-action').classList.contains('hidden'), false, `${code} : bouton d’action`);
    await pressKey(page, byId('alert-action'));
    assert.equal(byId(`page-${name}`).classList.contains('active'), true, `${code} : page ${name} affichée`);
    assert.equal(byId('page-home').classList.contains('active'), false);
    assert.equal(document.activeElement, titles[name], `${code} : focus sur le titre de la page ${name}`);
    assert.equal(titles[name].tabIndex, -1, 'titre focalisable par programme, hors de l’ordre de tabulation');
    page.window.showPage('home'); // retour à l'accueil depuis la page (le focus y était) : le titre de l'accueil
    assert.equal(document.activeElement, titles.home);
  }

  // le focus était ailleurs : rien n'est volé (champ de la page Mods, onglet de la barre latérale)
  page.window.AttackUI.showError('SOMETHING_ELSE', 'disque plein');
  byId('mods-q').focus();
  byId('alert-close').listeners.click[0]();
  assert.equal(document.activeElement, byId('mods-q'), 'fermer l’alerte sans y avoir le focus ne le déplace pas');
  const sidebar = new FakeNode('button'); // hors de toute page
  sidebar.focus();
  page.window.showPage('account');
  assert.equal(document.activeElement, sidebar, 'un onglet de la barre latérale garde le focus');
  byId('mods-q').focus();
  page.window.showPage('mods'); // la page affichée est celle qui a déjà le focus
  assert.equal(document.activeElement, byId('mods-q'));
});

test('page Mods au clavier : une carte qui sort du filtre ou « Tout afficher » rend le focus au filtre d’état actif, jamais <body>', async (t) => {
  const dirs = installed189();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const { page } = await render(dirs, {});
  const { byId, document } = page;
  const grid = () => byId('mods-grid');
  const switches = () => nodesOf(grid()).filter((n) => n.tagName === 'input' && /^mod:/.test(dataKey(n) || ''));
  const cardOf = (key) => grid().children.find((card) => nodesOf(card).some((n) => dataKey(n) === key));
  const nameOf = (card) => card.children[0].children[1].textContent;
  /** Coche ou décoche l'interrupteur de la clé donnée, au clavier (focus puis changement), et attend l'enregistrement. */
  const flip = async (key, checked) => {
    const node = switches().find((n) => dataKey(n) === key);
    node.checked = checked;
    await pressKey(page, node, 'change');
  };
  // le faux DOM n'a pas la page HTML : les trois boutons du filtre d'état (Tous, Activés, Désactivés)
  const stateButton = {};
  for (const value of ['all', 'on', 'off']) {
    stateButton[value] = new FakeNode('button');
    stateButton[value].dataset.value = value;
    byId('mods-state').append(stateButton[value]);
  }
  const setState = (value) => byId('mods-state').listeners.click[0]({ target: { dataset: { value } } });
  const search = (value) => byId('mods-q').listeners.input[0]({ target: { value } });
  // un mod du pack : son interrupteur règle un groupe (réglage enregistré), alors que celui d'OptiFine suit l'état lu par le processus principal
  const first = switches().map(dataKey).find((key) => key !== 'mod:optifine');
  assert.ok(first, 'le pack 1.8.9 a au moins un mod à interrupteur');

  // témoin, filtre « Tous » : la carte reste, son interrupteur garde le focus
  await flip(first, false);
  assert.equal(dataKey(document.activeElement), first);
  assert.notEqual(document.activeElement, document.body);

  // filtre « Activés » : la coupure fait sortir la carte de la grille
  await flip(first, true);
  setState('on');
  const name = nameOf(cardOf(first));
  await flip(first, false);
  assert.equal(cardOf(first), undefined, `la carte « ${name} » a quitté la grille`);
  assert.notEqual(document.activeElement, document.body);
  assert.equal(document.activeElement, stateButton.on, 'le bouton « Activés », qui a retiré la carte et reste à sa place, reprend le focus');

  // filtre « Désactivés » : la remise en marche fait sortir la carte, et la grille peut devenir vide
  setState('off');
  search(name);
  assert.deepEqual(grid().children.map(nameOf), [name], 'la recherche ne garde que cette carte');
  await flip(first, true);
  assert.equal(cardOf(first), undefined);
  assert.equal(nodesOf(grid()).some((n) => n.className === 'mods-empty'), true, 'plus aucune carte : message « aucun résultat »');
  assert.equal(document.activeElement, stateButton.off);

  // « Tout afficher » : le bouton disparaît avec la reconstruction de la grille
  const clear = nodesOf(grid()).find((n) => n.tagName === 'button' && n.textContent === 'Tout afficher');
  assert.ok(clear, 'bouton « Tout afficher » dans l’état vide');
  await pressKey(page, clear);
  assert.ok(grid().children.length > 1, 'la grille est de nouveau pleine');
  assert.equal(byId('mods-q').value, '');
  assert.equal(document.activeElement, stateButton.all, 'les filtres sont remis à zéro : « Tous » reprend le focus');

  // le focus n'est jamais volé quand il n'était pas dans la grille
  byId('wc-min').focus();
  search('');
  setState('on');
  assert.equal(document.activeElement, byId('wc-min'));
});

test('assistant OptiFine, import réussi sur la page Mods : le focus suit l’assistant jusqu’à l’interrupteur OptiFine', async (t) => {
  const dirs = installed189();
  const other = installed189(); // une installation avec la copie rangée : l'état que la page relira après l'import
  t.after(() => {
    fs.rmSync(dirs.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  });
  await installer.installOptifine(other.gameDir, other.minecraftDir, {});
  const withCopy = await installer.status({ minecraftDir: other.minecraftDir, gameDir: other.gameDir, profile: FORGE });
  assert.equal(withCopy.optifine.found, true);
  fs.rmSync(dirs.source); // aucune copie : la carte de la page Mods porte l'assistant
  const { page, status } = await render(dirs, {});
  assert.equal(status.optifine.found, false, 'départ : aucune copie utilisable');
  const { byId, document } = page;
  const modsCard = () => byId('mods-grid').children.find((card) => /OptiFine/.test(card.textContent) && /wide/.test(card.className));
  const button = (label) => nodesOf(modsCard()).find((n) => n.tagName === 'button' && n.textContent === label);

  await pressKey(page, button('Obtenir OptiFine'));
  assert.equal(dataKey(document.activeElement), 'assist:mods:title');
  await page.emitAssist({ state: 'seen', file: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5', downloadsDir: 'D:\\Dl' });
  await pressKey(page, button('Utiliser ce fichier'));
  await page.emitAssist({ state: 'checking', file: 'OptiFine_1.8.9_HD_U_M5.jar', downloadsDir: 'D:\\Dl' });
  assert.equal(dataKey(document.activeElement), 'assist:mods:title', 'le titre garde le focus pendant la vérification');

  // le processus principal a rangé la copie : la page relit l'état, la carte passe de l'assistant à l'interrupteur
  status.optifine = withCopy.optifine;
  await page.emitAssist({ state: 'imported', file: 'OptiFine_1.8.9_HD_U_M5.jar', version: 'HD_U_M5', downloadsDir: 'D:\\Dl' });
  const card = byId('mods-grid').children.find((c) => /OptiFine/.test(c.textContent) && nodesOf(c).some((n) => dataKey(n) === 'mod:optifine'));
  assert.ok(card, 'la carte OptiFine porte maintenant son interrupteur');
  assert.notEqual(document.activeElement, document.body);
  assert.equal(dataKey(document.activeElement), 'mod:optifine');
  assert.equal(document.activeElement.tagName, 'input');
  assert.ok(card.contains(document.activeElement));
});
