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

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
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
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  contains() {
    return false;
  }

  querySelectorAll() {
    return [];
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
    querySelectorAll: () => [],
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  const noop = () => {};
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let statusRead = false;
  const attack = {
    info: async () => info,
    getSettings: async () => settings,
    status: async () => {
      statusRead = true;
      return status;
    },
    accounts: { list: async () => ({ accounts: [], hasClientId: false, devMode: false }) },
    update: { state: async () => ({ phase: 'off' }) },
    onProgress: noop, onAuthEvent: noop, onAccountsChanged: noop, onUpdateState: noop, onWindowState: noop,
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
  return { byId, window };
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
  assert.match(view.main, /^À installer : /);
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
  assert.equal(toCopy.main, 'À installer : OptiFine');
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
