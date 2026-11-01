'use strict';
// Interface (src/renderer) : textes FR/EN complets, identifiants du HTML, CSP stricte (ni script ni style en ligne, pas d'innerHTML),
// données de la vitrine (historique, mods du pack, licences) alignées sur les packs figés.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../src/main/catalog');
const modpack = require('../src/main/modpack');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const read = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

/** Charge un script du renderer (IIFE qui remplit window) dans un contexte isolé. */
function load(name) {
  const window = {};
  const sandbox = { window, document: { documentElement: {}, querySelectorAll: () => [] }, self: window };
  vm.runInNewContext(read(name), sandbox, { filename: name });
  return window;
}

const i18n = load('i18n.js').I18n;
const data = load('data.js').AttackData;

/** Clés de traduction employées : data-i18n* du HTML et t('…') des scripts. */
function usedKeys() {
  const keys = new Set();
  for (const file of ['index.html', 'app.js', 'skin.js']) {
    const text = read(file);
    for (const m of text.matchAll(/data-i18n(?:-title|-placeholder|-label)?="([\w.-]+)"/g)) keys.add(m[1]);
    for (const m of text.matchAll(/\bt\('([\w.-]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

test('textes : chaque clé employée par la page existe en français et en anglais', () => {
  const missing = [];
  for (const lang of ['fr', 'en']) {
    i18n.setLang(lang);
    for (const key of usedKeys()) if (i18n.t(key) === key) missing.push(`${lang}:${key}`);
  }
  assert.deepEqual(missing, []);
});

test('textes : mêmes clés en français et en anglais (rien d’oublié dans une langue)', () => {
  const source = read('i18n.js');
  const block = (start, end) => new Set([...source.slice(start, end).matchAll(/^\s+'([\w.-]+)':/gm)].map((m) => m[1]));
  const en = source.indexOf('    en: {');
  const fr = block(source.indexOf('    fr: {'), en);
  const eng = block(en, source.length);
  // les messages d'erreur de l'API (error.*) restent en français tels quels : seule la langue anglaise les traduit
  const frOnly = [...fr].filter((k) => !eng.has(k));
  const enOnly = [...eng].filter((k) => !fr.has(k) && !k.startsWith('error.') && !k.startsWith('skin.') );
  assert.deepEqual(frOnly, [], 'clés françaises sans anglais');
  assert.deepEqual(enOnly, [], 'clés anglaises sans français');
});

test('textes : variables {x} identiques dans les deux langues', () => {
  const vars = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = [...usedKeys()].filter((k) => !/\$\{/.test(k));
  for (const key of keys) {
    i18n.setLang('fr');
    const fr = i18n.t(key);
    i18n.setLang('en');
    const en = i18n.t(key);
    assert.equal(vars(fr), vars(en), key);
  }
  i18n.setLang('fr');
});

test('page : chaque identifiant lu par les scripts existe dans index.html', () => {
  const html = read('index.html');
  const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const file of ['app.js', 'skin.js']) {
    for (const m of read(file).matchAll(/\$\('([\w-]+)'\)/g)) if (!ids.has(m[1])) missing.push(`${file}:${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('CSP stricte : aucun script ni style en ligne, aucun gestionnaire d’événement, aucun innerHTML', () => {
  const html = read('index.html');
  assert.match(html, /Content-Security-Policy[^>]*script-src 'self'; style-src 'self'/);
  assert.equal(/<script(?![^>]*\ssrc=)/.test(html), false, 'script en ligne');
  assert.equal(/<style[\s>]/.test(html), false, 'balise style');
  assert.equal(/\sstyle="/.test(html), false, 'attribut style');
  assert.equal(/\son[a-z]+="/i.test(html), false, 'gestionnaire en ligne');
  for (const file of ['app.js', 'skin.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), false, `${file} : injection de HTML`);
    assert.equal(/setAttribute\(\s*'style'/.test(code), false, `${file} : style en ligne`);
  }
});

test('historique : chaque entrée a son titre FR/EN et une étiquette connue ; la version du paquet en tête', () => {
  const pkg = require('../package.json');
  assert.equal(data.CHANGELOG[0].version, `Launcher ${pkg.version}`);
  for (const entry of data.CHANGELOG) {
    assert.ok(entry.title_fr && entry.title_en, `${entry.version} : titres`);
    assert.ok(['perf', 'new', 'fix', 'tweak'].includes(entry.tag), `${entry.version} : étiquette`);
    assert.ok(entry.fr && entry.en, `${entry.version} : textes`);
    assert.ok(entry.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(entry.date), `${entry.version} : date`);
  }
  assert.equal(new Set(data.CHANGELOG.map((e) => e.version)).size, data.CHANGELOG.length, 'versions uniques');
  // 0.8.0 : le profil 1.7.10 ; son entrée est suivie de celle du mod ATTACK 1.7.10 1.0.0 qu'il installe (même date), puis de la 0.7.0
  assert.equal(data.CHANGELOG[0].tag, 'new');
  assert.deepEqual(Array.from(data.CHANGELOG.slice(0, 3), (e) => e.version), ['Launcher 0.8.0', 'ATTACK Client 1.7.10 1.0.0', 'Launcher 0.7.0']);
  for (const lang of ['fr', 'en']) assert.match(data.CHANGELOG[0][lang], /1\.7\.10/, `0.8.0 (${lang}) : le profil 1.7.10`);
  // le mod 1.7.10 a toutes les fonctions du mod 1.8.9 sauf OptiFine : ni « lite » ni « sélection de modules »
  for (const lang of ['fr', 'en']) {
    assert.match(data.CHANGELOG[0][lang], /1\.8\.9/, `0.8.0 (${lang}) : le contenu du mod 1.8.9`);
    assert.match(data.CHANGELOG[0][lang], /OptiFine/, `0.8.0 (${lang}) : sauf OptiFine`);
    assert.equal(/\blite\b|sélection|selection of/i.test(data.CHANGELOG[0][lang]), false, `0.8.0 (${lang}) : plus de version « lite »`);
  }
  const mod = data.CHANGELOG[1];
  assert.deepEqual([mod.date, mod.tag, mod.date === data.CHANGELOG[0].date], ['2026-10-31', 'new', true]);
  for (const lang of ['fr', 'en']) {
    const text = mod[lang];
    for (const needle of ['1.7.10', '1.8.9', 'OptiFine', '61', '37', 'Minimap', 'Waypoints', 'Titles', 'Mouse Delay Fix', 'Perspective']) assert.ok(text.includes(needle), `mod 1.7.10 (${lang}) : ${needle}`);
    assert.match(text, lang === 'fr' ? /Amis/ : /Friends/);
    assert.match(text, /\b9 (ailes|wings)/);
    assert.match(text, /6 (auréoles|halos)/);
    assert.match(text, /6 (effets|effects)/);
    assert.equal(/\blite\b|sélection|selection of/i.test(text), false, `mod 1.7.10 (${lang}) : pas de « lite »`);
  }
  // les deux versions d'ATTACK Client livrées avec le launcher 0.7.0 suivent son entrée : Fabric (3.6.0) d'abord, puis la 1.8.9 (2.7.0), même date
  const from070 = data.CHANGELOG.findIndex((e) => e.version === 'Launcher 0.7.0');
  assert.deepEqual(Array.from(data.CHANGELOG.slice(from070 + 1, from070 + 3), (e) => [e.version, e.date, e.tag]), [
    ['ATTACK Client 3.6.0', data.CHANGELOG[from070].date, 'new'],
    ['ATTACK Client 2.7.0', data.CHANGELOG[from070].date, 'new'],
  ]);
  // la page découpe chaque texte en puces (une phrase chacune) : aucun texte n'est un bloc unique
  for (const entry of data.CHANGELOG.slice(0, 2).concat(data.CHANGELOG.slice(from070 + 1, from070 + 3))) {
    for (const lang of ['fr', 'en']) assert.ok(entry[lang].split(/(?<=[.!?])\s+(?=[A-ZÉÈÀ«“"(])/).length >= 3, `${entry.version} (${lang}) : plusieurs phrases`);
  }
});

test('vitrine : chaque mod des packs figés a sa fiche (icône, catégorie, textes) et chaque licence son nom lisible', () => {
  const categories = new Set(data.CATEGORIES.map((c) => c.id));
  for (const profile of catalog.list().filter(catalog.hasPack)) {
    for (const mod of modpack.loadPack(profile).mods) {
      const info = data.PACK_INFO[mod.slug];
      assert.ok(info, `${profile.id} : fiche de ${mod.slug}`);
      assert.ok(info.icon && info.fr && info.en && categories.has(info.cat), `${mod.slug} : champs`);
      assert.ok(data.LICENSE_NAMES[mod.license], `${mod.slug} : licence ${mod.license}`);
      assert.ok(mod.author, `${mod.slug} : auteur`);
    }
  }
});

test('textes : la phrase de crédit et la carte OptiFine disent que rien n’est téléchargé', () => {
  i18n.setLang('fr');
  assert.match(i18n.t('credits.credit'), /Modrinth/);
  assert.match(i18n.t('credits.note'), /ne l’embarque pas et ne le télécharge pas/);
  assert.match(i18n.t('optifine.textMissing'), /interdit au launcher de le télécharger/);
  i18n.setLang('en');
  assert.match(i18n.t('credits.note'), /neither ships nor downloads it/);
  assert.match(i18n.t('optifine.textMissing'), /forbids the launcher from downloading it/);
  i18n.setLang('fr');
});

test('pont IPC : chaque canal du preload a son gestionnaire dans main.js, et chaque appel de la page existe dans le preload', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const handled = new Set([...main.matchAll(/handle\('([\w:]+)'/g)].map((m) => m[1]));
  const invoked = [...preload.matchAll(/invoke\('([\w:]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(invoked.filter((channel) => !handled.has(channel)), [], 'canal sans gestionnaire');
  for (const channel of ['optifine:pick', 'shell:openOptifine']) assert.ok(invoked.includes(channel), channel);
  // méthodes de window.attack appelées par la page : toutes exposées par le preload
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  const calls = new Set([...read('app.js').matchAll(/\bapi\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...calls].filter((name) => !exposed.has(name)), [], 'appel de la page sans méthode exposée');
});

test('typographie : espace insécable avant « : ; ! ? » et dans « », apostrophe ’, singulier « 1 mod » (les variables ne sont jamais touchées)', () => {
  const NBSP = '\u00a0';
  i18n.setLang('fr');
  assert.equal(i18n.t('home.needs', { items: 'a : b' }), `À installer${NBSP}: a : b`, 'seul le texte du modèle est typographié, pas la valeur');
  assert.equal(i18n.t('pc.sub', { name: 'ATTACK Client' }), `Profil du launcher officiel${NBSP}: «${NBSP}ATTACK Client${NBSP}»`, '« » jamais orphelin');
  assert.equal(i18n.t('home.mods', { n: 1 }), '1 mod');
  assert.equal(i18n.t('home.mods', { n: 0 }), '0 mod', 'zéro est singulier en français');
  assert.equal(i18n.t('home.mods', { n: 5 }), '5 mods');
  assert.equal(i18n.t('mods.countModules', { n: 1 }), '1 module en jeu');
  assert.match(i18n.t('credits.note'), /l’embarque/, 'apostrophe typographique');
  assert.equal(/\p{L}'\p{L}/u.test(i18n.t('credits.note')), false);
  assert.equal(i18n.t('settings.about', { version: '0.7.0', dir: 'C:\\a : b' }).includes('C:\\a : b'), true, 'un chemin passe tel quel');
  i18n.setLang('en');
  assert.equal(i18n.t('home.mods', { n: 1 }), '1 mod');
  assert.equal(i18n.t('home.mods', { n: 0 }), '0 mods', 'zéro est pluriel en anglais');
  assert.equal(i18n.t('home.changelog'), 'What’s new');
  assert.equal(i18n.t('home.needs', { items: 'x' }), 'To install: x', 'pas d’espace insécable en anglais');
  i18n.setLang('fr');
  // chaque texte français qui a un « : » précédé d'une espace en a une insécable après typographie
  const fr = (key) => i18n.t(key);
  for (const key of usedKeys()) assert.equal(/[^\u00a0] [:;!?»]/.test(fr(key).replace(/\{\w+\}/g, '')), false, `${key} : espace sécable avant la ponctuation`);
});

test('échelle : toute taille de police et tout rayon du CSS passent par les jetons (rien sous 11 px, 4 rayons et la pastille)', () => {
  const css = read('styles.css');
  const sizes = [...css.matchAll(/font-size:\s*([^;}]+)[;}]/g)].map((m) => m[1].replace(/\s*!important$/, '').trim());
  assert.deepEqual(sizes.filter((v) => !/^var\(--fs-(xs|sm|md|base|lg|xl|2xl|hero|hero-sm|code)\)$/.test(v)), [], 'taille hors échelle');
  const tokens = Object.fromEntries([...css.matchAll(/--fs-([\w-]+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]));
  assert.ok(Object.values(tokens).every((px) => px >= 11), 'aucun texte sous 11 px');
  const radii = [...css.matchAll(/border-radius:\s*([^;}]+)[;}]/g)].map((m) => m[1].trim());
  assert.deepEqual(radii.filter((v) => !/^(var\(--r-(xs|sm|md|lg|pill)\)|var\(--radius\)|50%|2px|0 3px 3px 0)$/.test(v)), [], 'rayon hors échelle');
  // le rouge porteur de texte blanc est --accent-btn (4,98:1) ; color-scheme et contraste élevé sont là
  assert.match(css, /--accent-btn:\s*#d32f2f/);
  assert.match(css, /\.btn\.accent \{ background: var\(--accent-btn\)/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.equal(/input\[type='text'\]:focus \{[^}]*outline:\s*none/.test(css), false, 'le champ garde son anneau de focus');
  assert.match(css, /input\[type='text'\]:focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('sémantique : onglets liés à leurs panneaux, boutons de la barre de titre hors tabulation, alertes annoncées, zone aria-live de l’assistant', () => {
  const html = read('index.html');
  for (const tab of ['profile', 'launcher', 'advanced']) {
    assert.match(html, new RegExp(`id="tabbtn-${tab}"[^>]*aria-controls="tab-${tab}"`));
    assert.match(html, new RegExp(`id="tab-${tab}" role="tabpanel" aria-labelledby="tabbtn-${tab}"`));
  }
  for (const id of ['wc-min', 'wc-max', 'wc-close']) assert.match(html, new RegExp(`id="${id}" tabindex="-1"`));
  assert.match(html, /id="alert" role="alert"/);
  assert.match(html, /id="account-message" role="alert"/);
  assert.match(html, /id="optifine-live" role="status" aria-live="polite"/);
  assert.match(html, /<button class="nav-item active" data-page="home" aria-current="page">/);
  for (const id of ['optifine-enabled', 'dev-mode']) assert.match(html, new RegExp(`id="${id}" aria-labelledby="[\\w-]+"`), `${id} a un nom`);
  for (const id of ['game-dir', 'dev-dir']) assert.match(html, new RegExp(`id="${id}" readonly aria-labelledby="[\\w-]+"`), `${id} a un nom`);
  // les groupes à choix unique sont des radiogroups (un arrêt de tabulation, flèches)
  for (const id of ['profile-select', 'java-mode', 'lang', 'mods-filters', 'mods-state', 'mods-density', 'changelog-filters']) assert.match(html, new RegExp(`id="${id}"[^>]*role="radiogroup"`), id);
  // « Pourquoi ? » : un <details> à trois puces
  const why = /<details class="why" id="optifine-why">([\s\S]*?)<\/details>/.exec(html);
  assert.ok(why, 'details Pourquoi ?');
  assert.equal((why[1].match(/<li\b/g) || []).length, 3);
});

test('« Pourquoi ? » : trois raisons (licence, vérification locale, profils 1.21.1 et 26.3), rien sur les autres launchers ni sur les capes', () => {
  for (const lang of ['fr', 'en']) {
    i18n.setLang(lang);
    const bullets = ['optifine.why1', 'optifine.why2', 'optifine.why3'].map((key) => i18n.t(key));
    assert.equal(bullets.every((text) => text.length > 30), true);
    assert.match(bullets[0], lang === 'fr' ? /licence/ : /license/);
    assert.match(bullets[2], /1\.21\.1/);
    assert.match(bullets[2], /26\.3/);
    for (const text of [...bullets, i18n.t('optifine.assist.idle'), i18n.t('optifine.assist.step1'), i18n.t('optifine.assist.step2')]) {
      assert.equal(/prism|multimc|lunar|badlion|feather|hmcl|tlauncher|atlauncher|gdlauncher|curseforge|modrinth|\bcapes?\b/i.test(text), false, `${lang} : ${text}`);
    }
  }
  i18n.setLang('fr');
});

test('profil 1.7.10 : tous les modules de la page Mods sauf Mouse Delay Fix et Titles (liste d’exclusion, jamais une liste « lite » à garder)', () => {
  const own = data.MODULES_BY_PROFILE['forge-1.7.10'];
  const known = new Set(data.MODS.map((m) => m.name));
  // le mod 1.7.10 reprend tout le contenu du mod 1.8.9 sauf OptiFine : l'entrée ne porte qu'`exclude` et `overrides`, aucune liste de modules retenus
  assert.deepEqual(Object.keys(own).sort(), ['exclude', 'overrides'], 'ni `names` ni autre liste de modules à garder');
  assert.equal(own.names, undefined, 'plus de liste « lite »');
  // deux modules seulement : Mouse Delay Fix (sans objet, natif en 1.7.10) et Titles (impossible en 1.7.10)
  assert.deepEqual(Array.from(own.exclude), ['Mouse Delay Fix', 'Titles']);
  assert.deepEqual(Array.from(own.exclude).filter((n) => !known.has(n)), [], 'chaque exclu existe dans MODS');
  const shown = data.MODS.filter((m) => !own.exclude.includes(m.name)).map((m) => m.name);
  assert.equal(shown.length, data.MODS.length - 2, 'tout MODS, moins ces deux-là');
  // les modules interdits en classé, les Amis, la Minimap et les autres de la liste d'avant sont bien présents
  for (const name of ['No Jump Delay', 'No Hit Delay', 'Perspective', 'Amis', 'Minimap', 'Waypoints', 'Motion Blur', 'FPS Boost', 'Personnalisation', 'Capes ATTACK', 'ToggleSprint',
    'Hitboxes', 'Enchant Glint', 'Environment Changer', 'Container Blur', 'Color Saturation', 'Tab List', 'Auto Text', 'Boss Bar']) assert.ok(shown.includes(name), name);
  for (const name of ['Mouse Delay Fix', 'Titles', 'OptiFine']) assert.ok(!shown.includes(name), `${name} n’est pas dans la liste 1.7.10`);
  // textes propres à ce profil : seulement pour un module qui y est présenté, et là où le texte écrit pour la 1.8.9 y serait faux
  assert.deepEqual(Object.keys(own.overrides), ['Animations 1.7'], 'seule Animations a un texte à elle (position, style et vitesse du coup ; blocage et pose natifs)');
  for (const [name, text] of Object.entries(own.overrides)) {
    assert.ok(shown.includes(name), `${name} : texte propre à ce profil pour un module de sa liste`);
    assert.ok(text.fr && text.en, `${name} : FR et EN`);
    assert.notEqual(text.fr, data.MODS.find((m) => m.name === name).fr, `${name} : texte différent de celui de la 1.8.9`);
  }
  assert.match(own.overrides['Animations 1.7'].fr, /vitesse du coup/);
  assert.match(own.overrides['Animations 1.7'].en, /swing/);
  // les chiffres de la vitrine sont ceux du mod 1.7.10 (37 capes, 9 ailes, 6 auréoles, 6 effets, 22 polices) : aucun autre texte propre
  const capes = data.MODS.find((m) => m.name === 'Capes ATTACK');
  assert.match(capes.fr, /37 capes.*9 paires d’ailes, 6 auréoles et 6 effets/);
  assert.match(data.MODS.find((m) => m.name === 'Personnalisation').fr, /^22 polices/);
  // le profil 1.8.9 n'a pas d'entrée à lui : il garde tous les modules
  assert.equal(data.MODULES_BY_PROFILE['forge-1.8.9'], undefined);
});

test('profil 1.7.10 : plus aucun texte ne parle d’une version « lite » ni de modules absents parce qu’interdits en classé', () => {
  const lite = /\blite\b|sélection de modules|selection of modules|une partie des modules|part of the modules|interdits en classé|banned in ranked|plus légère|is lighter/i;
  for (const file of ['data.js', 'app.js']) assert.equal(lite.test(read(file)), false, `${file} : texte « lite » restant`);
  assert.equal(lite.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'catalog.js'), 'utf8')), false, 'catalog.js : texte « lite » restant');
  for (const entry of data.CHANGELOG) for (const lang of ['fr', 'en']) assert.equal(lite.test(entry[lang]), false, `${entry.version} (${lang}) : texte « lite »`);
});

test('profil 1.7.10 : étiquette de carte, textes de profil sans pack et version dans l’aide de mémoire', () => {
  i18n.setLang('fr');
  assert.equal(i18n.t('home.tag.forge-1.7.10'), 'PvP 1.7');
  assert.equal(i18n.t('pc.none'), 'Aucun');
  assert.equal(i18n.t('settings.ramHelp', { mc: '1.7.10' }), "2 à 3 Go suffisent pour la 1.7.10. Plus n’augmente pas les FPS.");
  assert.equal(i18n.t('settings.ramHelp', { mc: '1.8.9' }), "2 à 3 Go suffisent pour la 1.8.9. Plus n’augmente pas les FPS.");
  assert.doesNotMatch(i18n.t('mods.subtitleNoPack', { modules: 18 }), /\b0 mod\b/);
  assert.match(i18n.t('mods.subtitleNoPack', { modules: 18 }), /18 modules/);
  assert.match(i18n.t('credits.noPack', { label: '1.7.10' }), /1\.7\.10/);
  i18n.setLang('en');
  assert.equal(i18n.t('home.tag.forge-1.7.10'), '1.7 PvP');
  assert.equal(i18n.t('pc.none'), 'None');
  assert.equal(i18n.t('settings.ramHelp', { mc: '1.7.10' }), '2 to 3 GB is enough for 1.7.10. More does not raise FPS.');
  assert.match(i18n.t('mods.subtitleNoPack', { modules: 18 }), /no mod pack/);
  i18n.setLang('fr');
  // une étiquette par profil du catalogue, dans les deux langues
  for (const lang of ['fr', 'en']) {
    i18n.setLang(lang);
    for (const profile of catalog.list()) assert.notEqual(i18n.t(`home.tag.${profile.id}`), `home.tag.${profile.id}`, `${lang} : ${profile.id}`);
  }
  i18n.setLang('fr');
});

test('puce choisie (Go, filtres, historique) : contour rouge opaque, la teinte seule ne suffit pas à la distinguer (3:1)', () => {
  const css = read('styles.css');
  const rule = css.match(/\.chip\.active \{([^}]*)\}/);
  assert.ok(rule, 'règle .chip.active');
  assert.match(rule[1], /border-color: var\(--accent\);/);
  assert.doesNotMatch(rule[1], /--accent-line/, 'le contour translucide (60 %) ne fait que 2,14:1 contre la teinte');
});

test('profils : quatre colonnes, le nom du chargeur sous la version, sans débordement (colonne de 484 px, fenêtre minimale de 940 px)', () => {
  const css = read('styles.css');
  assert.match(css, /\.profiles \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.profile \{[^}]*min-width: 0;/);
  assert.match(css, /\.profile \.pv \{ display: flex; flex-direction: column;/);
  assert.equal(/repeat\(3, 1fr\)/.test(css.slice(css.indexOf('.profiles {'), css.indexOf('.profiles {') + 200)), false);
  assert.match(css, /\.launch-col \{ width: 484px; max-width: 100%;/);
  // 940 px de fenêtre : la colonne gauche de l'accueil (940 - 84 de navigation - 282 de rail - 20 d'espace - marges) tient 484 px
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /minWidth: 940/);
  assert.match(css, /@media \(max-width: 1040px\) \{\s*\.home-grid \{ grid-template-columns: 1fr 282px; gap: 20px; \}/);
});
