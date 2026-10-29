'use strict';
// Génère le site statique d'ATTACK Launcher (GitHub Pages) dans _site/ à partir de site/ :
//   node scripts/build-site.js [--out _site] [--src site] [--offline] [--fixture <json>] [--strict] [--check-links]
// Sources : site/template.html, site/404.template.html, site/i18n.js (lu seulement par Node, jamais publié),
// site/styles.css et site/img/ (WebP produits par scripts/site-images.js + manifest.json).
// Rien n'est publié en JavaScript : la page n'a ni script, ni ressource tierce (voir CSP).
//   --out      dossier de sortie, VIDÉ à chaque génération : refusé s'il existe, n'est pas vide et n'est ni nommé _site ni marqué
//              par le fichier .attack-site que ce script y écrit (donc `--out docs` ou `--out src` n'effacent rien) ;
//   --src      autre dossier de sources (ou variable SITE_SRC) : sert aux essais ; SOURCE_DATE_EPOCH fixe {{year}} ;
//   --offline  n'appelle pas le réseau : la release vient de test/fixtures/site-release.json ;
//   --fixture  idem avec un autre fichier (réponse de l'API GitHub, éventuellement avec "_sha256sums" pour les tests) ;
//   --strict   (CI) échoue au lieu de générer la page « sans release » : API GitHub injoignable, release inutilisable (fichiers
//              pas encore joints, version du Setup différente du tag) ou plus ancienne que la version de package.json. Le
//              déploiement est alors sauté et la page déjà en ligne reste en place ; on relit la release quelques fois avant d'échouer ;
//   --check-links  teste ensuite les liens externes des pages générées et de README.md (rapport, aucun fichier écrit).
// Marqueurs du modèle : {{lang}} {{root}} {{year}} {{url.fr}} {{url.en}} {{url.canonical}} ; {{t.<clé.pointée>}} (texte de
// site/i18n.js, HTML de confiance, marqueurs compris) ; {{rel.*}} (release GitHub validée, échappée) avec les blocs
// {{#rel}}…{{/rel}} / {{^rel}}…{{/rel}} et {{#sha}}…{{/sha}} ; {{cat.<forge189|fabric1211|fabric263>.<mc|loader|java>}} ;
// {{img.<clé>[:eager][|sizes=…]}} ; {{html.logo}} {{html.logoHero}} {{html.credits}} {{html.news}}.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const catalog = require('../src/main/catalog');
const logo = require('../src/renderer/logo');
const { render: renderIcon } = require('./make-icons');

const ROOT = path.join(__dirname, '..');
const SITE_ORIGIN = 'https://7shiki3.github.io';
const BASE_PATH = '/attack-launcher/';
const PAGE_URL = { fr: `${SITE_ORIGIN}${BASE_PATH}`, en: `${SITE_ORIGIN}${BASE_PATH}en/` };
const REPO_URL = 'https://github.com/7ShIkI3/attack-launcher';
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const API_URL = 'https://api.github.com/repos/7ShIkI3/attack-launcher/releases/latest';
const DOWNLOAD_PREFIX = `${REPO_URL}/releases/download/`;
const USER_AGENT = 'ATTACK-Launcher-site';
const FIXTURE_DEFAULT = path.join(ROOT, 'test', 'fixtures', 'site-release.json');
/** Avec --strict : relectures de la release quand elle n'est pas (encore) utilisable (fichiers joints après la publication). */
const STRICT_RETRIES = 6;
const STRICT_RETRY_MS = 20000;
/** Fichier écrit dans un dossier de sortie qui n'est pas nommé _site : c'est ce qui autorise à le vider à la génération suivante. */
const OUT_MARKER = '.attack-site';
/** Politique de contenu de chaque page (meta) et de scripts/serve-site.js (en-tête) : strictement la même. */
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const LANGS = ['fr', 'en'];

// --- texte -------------------------------------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatSize(bytes, lang) {
  const number = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${number.format(bytes / 1048576)} ${lang === 'fr' ? 'Mo' : 'MB'}`; // unités binaires, espace insécable
}

function formatDate(date, lang) {
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

// --- release GitHub ----------------------------------------------------------------------------------------------

const SETUP_RE = /^ATTACK-Launcher-Setup-(\d+\.\d+\.\d+)\.exe$/;
const PORTABLE_RE = /^ATTACK-Launcher-Portable-(\d+\.\d+\.\d+)\.exe$/;
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;
const SUMS_ASSET = 'SHA256SUMS';
const MIN_SIZE = 1024 * 1024;
const MAX_SIZE = 1024 ** 3;

/** Une ligne « <sha256>  <nom> » (ou « <sha256> *<nom> ») de SHA256SUMS pour ce fichier, ou null. */
function sumFor(sums, name) {
  const found = String(sums || '').split(/\r?\n/).map((line) => /^([0-9a-fA-F]{64}) [ *](.+?)\s*$/.exec(line)).filter((m) => m && m[2] === name);
  return found.length === 1 ? found[0][1].toLowerCase() : null;
}

/**
 * Valide la réponse de l'API (releases/latest) et en tire ce que la page affiche. Toute valeur douteuse (asset en double,
 * URL hors de ce dépôt, taille absurde, version incohérente) rend la release inutilisable : la page est alors générée
 * « sans release » (bloc {{^rel}}). Le SHA-256 seul est facultatif : champ `digest`, sinon ligne de SHA256SUMS, sinon rien.
 * Retourne { rel, problems } ; rel vaut null quand la release n'est pas utilisable.
 */
function parseRelease(json, { sums = '' } = {}) {
  const problems = [];
  const fail = (message) => {
    problems.push(message);
    return { rel: null, problems };
  };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('réponse de l’API illisible');
  if (json.draft !== false || json.prerelease !== false) return fail('la release est un brouillon ou une préversion');
  const tagMatch = TAG_RE.exec(String(json.tag_name));
  if (!tagMatch) return fail(`tag inattendu : ${JSON.stringify(json.tag_name)}`);
  const tag = String(json.tag_name);
  if (typeof json.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(json.published_at) || Number.isNaN(Date.parse(json.published_at))) {
    return fail('date de publication illisible');
  }
  if (!Array.isArray(json.assets)) return fail('liste des fichiers absente');

  const pick = (regex, label) => {
    const matches = json.assets.filter((a) => a && typeof a.name === 'string' && regex.test(a.name));
    if (matches.length !== 1) {
      problems.push(`${matches.length} fichier(s) ${label} dans la release (un seul attendu)`);
      return null;
    }
    const asset = matches[0];
    if (asset.state !== undefined && asset.state !== 'uploaded') problems.push(`${asset.name} : envoi incomplet`);
    if (asset.browser_download_url !== `${DOWNLOAD_PREFIX}${tag}/${asset.name}`) problems.push(`${asset.name} : adresse de téléchargement hors de ce dépôt`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= MIN_SIZE || asset.size >= MAX_SIZE) problems.push(`${asset.name} : taille invraisemblable`);
    if (regex.exec(asset.name)[1] !== tagMatch[1]) problems.push(`${asset.name} : version différente du tag ${tag}`);
    return asset;
  };
  const setup = pick(SETUP_RE, 'Setup');
  const portable = pick(PORTABLE_RE, 'Portable');
  if (problems.length || !setup || !portable) return { rel: null, problems };

  let sha256 = null;
  if (typeof setup.digest === 'string' && DIGEST_RE.test(setup.digest)) sha256 = DIGEST_RE.exec(setup.digest)[1];
  else sha256 = sumFor(sums, setup.name);
  return {
    rel: {
      tag,
      version: tagMatch[1],
      setupUrl: setup.browser_download_url,
      setupSize: setup.size,
      sha256,
      portableUrl: portable.browser_download_url,
      publishedAt: new Date(json.published_at),
      releaseUrl: `${REPO_URL}/releases/tag/${tag}`,
    },
    problems,
  };
}

async function fetchText(url, { headers = {}, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`réponse trop grosse pour ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`réponse trop grosse pour ${url}`);
  return buffer.toString('utf8');
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Numéros x.y.z comparés champ par champ : négatif si a < b, 0 si égaux, positif si a > b. */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

/**
 * Une lecture de releases/latest : { rel, problems, reachable }. Une release valide mais plus ancienne que la version de
 * package.json est refusée : la page décrirait un launcher que le bouton Télécharger ne donne pas (publier d'abord la release).
 */
async function readLatestOnce({ get, sleep, repoVersion }) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let json = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !json; attempt++) {
    try {
      json = JSON.parse(await get(API_URL, { headers }));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  if (!json) return { rel: null, problems: [`API GitHub injoignable (${lastError && lastError.message})`], reachable: false };
  let parsed = parseRelease(json);
  // pas de digest exploitable : essaie la ligne du fichier SHA256SUMS de la release (jamais avec le jeton)
  if (parsed.rel && !parsed.rel.sha256) {
    const sums = (json.assets || []).find((a) => a && a.name === SUMS_ASSET);
    if (sums && sums.browser_download_url === `${DOWNLOAD_PREFIX}${parsed.rel.tag}/${SUMS_ASSET}`) {
      try {
        parsed = parseRelease(json, { sums: await get(sums.browser_download_url, { maxBytes: 64 * 1024 }) });
      } catch (error) {
        parsed.problems.push(`${SUMS_ASSET} illisible (${error.message})`);
      }
    }
  }
  if (parsed.rel && repoVersion && compareVersions(parsed.rel.version, repoVersion) < 0) {
    return {
      rel: null,
      problems: [`la dernière release publiée (v${parsed.rel.version}) est plus ancienne que la version du dépôt (${repoVersion}) : publie d'abord la release v${repoVersion} (Setup, Portable, SHA256SUMS)`],
      reachable: true,
    };
  }
  return { ...parsed, reachable: true };
}

/**
 * Lit la dernière release : réseau (3 essais), ou fichier d'essai avec --offline / --fixture.
 * Avec --strict, l'API injoignable ou une release inutilisable (après quelques relectures : les fichiers peuvent être joints
 * juste après la publication) font échouer la génération au lieu de produire la page « sans release ».
 * `get` et `sleep` sont remplaçables pour les tests.
 */
async function readRelease({ offline, fixture, strict, log, get = fetchText, sleep = sleepMs, retries = STRICT_RETRIES, retryMs = STRICT_RETRY_MS, repoVersion = null }) {
  if (offline || fixture) {
    const file = fixture ? path.resolve(fixture) : FIXTURE_DEFAULT;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    log(`release : fichier d'essai ${path.relative(ROOT, file)}`);
    return { ...parseRelease(json, { sums: json._sha256sums }), source: 'fixture' };
  }
  let result = null;
  for (let round = 0; round <= (strict ? retries : 0); round++) {
    if (round > 0) {
      log(`release : ${result.problems.join(' ; ')} : nouvelle lecture dans ${Math.round(retryMs / 1000)} s (${round}/${retries})`);
      await sleep(retryMs);
    }
    result = await readLatestOnce({ get, sleep, repoVersion });
    if (result.rel) break;
  }
  return { rel: result.rel, problems: result.problems, source: 'network' };
}

// --- données du launcher (lues, jamais copiées telles quelles) ----------------------------------------------------

/** data.js et i18n.js du launcher sont des scripts de navigateur : on les exécute dans un bac à sable vide. */
function runRendererScript(file) {
  const sandbox = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', file), 'utf8'), sandbox, { filename: file, timeout: 2000 });
  return sandbox.window;
}

/** Libellé du launcher (src/renderer/i18n.js) dans une langue ; une clé inconnue fait échouer la génération. */
function launcherText(i18nApi, lang, key) {
  i18nApi.setLang(lang);
  const text = i18nApi.t(key);
  if (text === key) throw new Error(`Clé absente de src/renderer/i18n.js : ${key}`);
  return text;
}

function loadPacks() {
  const dir = path.join(ROOT, 'src', 'main', 'packs');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const profile = catalog.find(pack.profileId);
    if (!profile || !Array.isArray(pack.mods)) throw new Error(`Pack inattendu : ${f}`);
    return { file: f, profile, mods: pack.mods };
  });
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CREDIT_LABELS = {
  fr: { profiles: 'Profils', group: 'Groupe', others: 'Autres', launcher: 'Launcher', launcherSite: 'Launcher et site', optifineLicense: 'Jamais téléchargé ni redistribué : copie du joueur' },
  en: { profiles: 'Profiles', group: 'Group', others: 'Others', launcher: 'Launcher', launcherSite: 'Launcher and site', optifineLicense: 'Never downloaded or redistributed: the player’s own copy' },
};
/** Lignes fixes du tableau : composants qui ne sont pas dans un pack de mods (licences : src/renderer/vendor, fonts, README). */
const FIXED_CREDITS = [
  { name: 'OptiFine', url: 'https://optifine.net/', author: { fr: 'sp614x', en: 'sp614x' }, license: 'optifine', profiles: 'forge-1.8.9' },
  { name: 'skinview3d', url: 'https://bs-community.github.io/skinview3d/', author: { fr: 'Kent Rasmussen, Haowei Wen, Sean Boult et contributeurs', en: 'Kent Rasmussen, Haowei Wen, Sean Boult and contributors' }, license: 'MIT', profiles: 'launcher' },
  { name: 'three.js', url: 'https://threejs.org/', author: { fr: 'Les auteurs de three.js', en: 'The three.js authors' }, license: 'MIT', profiles: 'launcher' },
  { name: 'Electron', url: 'https://www.electronjs.org/', author: { fr: 'Les contributeurs d’Electron', en: 'Electron contributors' }, license: 'MIT', profiles: 'launcher' },
  { name: 'electron-updater', url: 'https://github.com/electron-userland/electron-builder', author: { fr: 'Vladimir Krivosheev et les contributeurs d’electron-builder', en: 'Vladimir Krivosheev and electron-builder contributors' }, license: 'MIT', profiles: 'launcher' },
  { name: 'Inter', url: 'https://github.com/rsms/inter', author: { fr: 'Les auteurs du projet Inter', en: 'The Inter Project Authors' }, license: 'OFL', profiles: 'launcher' },
  { name: 'Montserrat', url: 'https://github.com/JulietaUla/Montserrat', author: { fr: 'Les auteurs du projet Montserrat', en: 'The Montserrat Project Authors' }, license: 'OFL', profiles: 'launcherSite' },
];

function externalLink(url, label) {
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/** Tableau <table class="credits-table"> : union des mods des packs (un par slug) puis les lignes fixes. */
function creditsHtml(lang, data) {
  const labels = CREDIT_LABELS[lang];
  const launcherLabel = (key) => launcherText(data.launcherI18n, lang, key);
  const groups = {
    pvp: launcherLabel('settings.pvp'),
    optifine: launcherLabel('settings.optifinePacks'),
    replay: launcherLabel('settings.replay'),
  };
  const dash = '—';
  const licenseName = (id) => (data.licenseNames[id] && data.licenseNames[id][lang]) || id;
  const byslug = new Map();
  for (const pack of data.packs) {
    for (const mod of pack.mods) {
      if (!SLUG_RE.test(String(mod.slug))) throw new Error(`Slug de mod invalide : ${JSON.stringify(mod.slug)}`);
      const known = byslug.get(mod.slug);
      const entry = { name: mod.name, author: mod.author, license: mod.license, group: mod.group || '' };
      if (!known) {
        byslug.set(mod.slug, { ...entry, slug: mod.slug, profiles: [pack.profile.label] });
        continue;
      }
      for (const field of Object.keys(entry)) {
        if (known[field] !== entry[field]) throw new Error(`Le mod ${mod.slug} diffère d'un pack à l'autre (${field}) : crédits ambigus`);
      }
      known.profiles.push(pack.profile.label);
    }
  }
  const mods = [...byslug.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug));
  const profileOrder = catalog.list().map((p) => p.label);
  const heads = [launcherLabel('credits.mod'), launcherLabel('credits.author'), launcherLabel('credits.license'), labels.profiles, labels.group];
  const row = (cells) => `<tr><th scope="row" data-label="${escapeHtml(heads[0])}">${cells[0]}</th>${cells.slice(1).map((c, i) => `<td data-label="${escapeHtml(heads[i + 1])}">${c}</td>`).join('')}</tr>`;
  const modRows = mods.map((m) => {
    if (m.group && !groups[m.group]) throw new Error(`Groupe de pack inconnu : ${m.group}`);
    const profiles = [...new Set(m.profiles)].sort((a, b) => profileOrder.indexOf(a) - profileOrder.indexOf(b)).join(', ');
    return row([
      externalLink(`https://modrinth.com/mod/${m.slug}`, m.name),
      escapeHtml(m.author),
      escapeHtml(licenseName(m.license)),
      escapeHtml(profiles),
      escapeHtml(m.group ? groups[m.group] : dash),
    ]);
  });
  const fixedRows = FIXED_CREDITS.map((f) => {
    const license = f.license === 'optifine' ? escapeHtml(labels.optifineLicense)
      : f.license === 'OFL' ? externalLink('https://openfontlicense.org/', 'OFL 1.1')
        : escapeHtml(f.license);
    const profiles = catalog.find(f.profiles) ? catalog.find(f.profiles).label : labels[f.profiles];
    return row([externalLink(f.url, f.name), escapeHtml(f.author[lang]), license, escapeHtml(profiles), escapeHtml(dash)]);
  });
  return [
    '<table class="credits-table">',
    `<thead><tr>${heads.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead>`,
    `<tbody>${modRows.join('')}</tbody>`,
    `<tbody><tr><th scope="rowgroup" colspan="${heads.length}">${escapeHtml(labels.others)}</th></tr>${fixedRows.join('')}</tbody>`,
    '</table>',
  ].join('\n');
}

/** Les 3 entrées les plus récentes du CHANGELOG du launcher (ordre du fichier à date égale), dans la langue de la page. */
function newsHtml(lang, data) {
  const dated = data.changelog.map((entry, index) => ({ entry, index }));
  dated.sort((a, b) => (b.entry.date || '').localeCompare(a.entry.date || '') || a.index - b.index);
  return dated.slice(0, 3).map(({ entry }) => {
    const title = entry[`title_${lang}`];
    const text = entry[lang];
    if (!title || !text || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`Entrée du CHANGELOG incomplète : ${entry.version}`);
    const tag = launcherText(data.launcherI18n, lang, `tag.${entry.tag}`);
    return [
      '<article class="news-item">',
      '<p class="news-meta">',
      `<span class="news-version">${escapeHtml(entry.version)}</span>`,
      `<time class="news-date" datetime="${entry.date}">${escapeHtml(formatDate(new Date(`${entry.date}T00:00:00Z`), lang))}</time>`,
      `<span class="news-tag news-tag-${escapeHtml(entry.tag)}">${escapeHtml(tag)}</span>`,
      '</p>',
      `<h3 class="news-title">${escapeHtml(title)}</h3>`,
      `<p class="news-text">${escapeHtml(text)}</p>`,
      '</article>',
    ].join('\n');
  }).join('\n');
}

/** Logo en ligne : sans rôle « img » (décoratif), avec des identifiants de dégradés uniques par occurrence. */
function logoSvg(id, size, glow) {
  const svg = logo.svg({ id, size, glow });
  const decorative = svg.replace(' role="img" aria-label="ATTACK"', ' aria-hidden="true" focusable="false"');
  if (decorative === svg) throw new Error('Le SVG du logo a changé : adapter scripts/build-site.js');
  return decorative;
}

const CATALOG_IDS = { forge189: 'forge-1.8.9', fabric1211: 'fabric-1.21.1', fabric263: 'fabric-26.3' };

function catalogValue(name, field) {
  const profile = catalog.find(CATALOG_IDS[name]);
  if (!profile) throw new Error(`Profil inconnu dans le marqueur : cat.${name}`);
  if (field === 'mc') return profile.mc;
  if (field === 'java') return String(profile.javaMajor);
  if (field === 'loader') return `${profile.loader.type === 'forge' ? 'Forge' : 'Fabric Loader'} ${profile.loader.version}`;
  throw new Error(`Champ inconnu dans le marqueur : cat.${name}.${field}`);
}

// --- sources du site : i18n et images ----------------------------------------------------------------------------

function flattenKeys(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenKeys(value, full, out);
    else if (typeof value === 'string') out[full] = value;
    else throw new Error(`site/i18n.js : la valeur de ${full} doit être un texte ou un objet`);
  }
  return out;
}

function loadSiteI18n(srcDir) {
  const file = path.join(srcDir, 'i18n.js');
  delete require.cache[require.resolve(file)];
  const module_ = require(file);
  const flat = {};
  for (const lang of LANGS) {
    if (!module_ || typeof module_[lang] !== 'object') throw new Error(`site/i18n.js doit exporter { fr, en } (langue ${lang} absente)`);
    flat[lang] = flattenKeys(module_[lang]);
  }
  const missing = (a, b) => Object.keys(flat[a]).filter((k) => !(k in flat[b]));
  const onlyFr = missing('fr', 'en');
  const onlyEn = missing('en', 'fr');
  if (onlyFr.length || onlyEn.length) {
    throw new Error(`site/i18n.js : clés différentes entre fr et en${onlyFr.length ? ` ; seulement en fr : ${onlyFr.join(', ')}` : ''}${onlyEn.length ? ` ; seulement en en : ${onlyEn.join(', ')}` : ''}`);
  }
  return flat;
}

/** Dimensions d'un WebP (VP8, VP8L ou VP8X) lues dans son en-tête, pour contrôler le manifeste sans le croire sur parole. */
function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('pas un fichier WebP');
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  throw new Error(`format WebP inconnu (${kind})`);
}

const IMAGE_FILE_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(fr|en)-(\d+)\.webp$/;

/** site/img/manifest.json : { images: [{ key, lang, width, height, file, … }] } ; chaque entrée est recoupée avec son fichier. */
function loadManifest(srcDir) {
  const dir = path.join(srcDir, 'img');
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { images: [], dir };
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(manifest.images)) throw new Error('site/img/manifest.json : liste « images » absente');
  for (const image of manifest.images) {
    const match = IMAGE_FILE_RE.exec(String(image.file));
    if (!match || match[1] !== image.key || match[2] !== image.lang || Number(match[3]) !== image.width) throw new Error(`Manifeste d'images : entrée incohérente (${image.file})`);
    const actual = webpSize(fs.readFileSync(path.join(dir, image.file)));
    if (actual.width !== image.width || actual.height !== image.height) throw new Error(`Manifeste d'images : ${image.file} fait ${actual.width}x${actual.height}, le manifeste dit ${image.width}x${image.height} (relancer npm run site:images)`);
  }
  return { images: manifest.images, dir };
}

const SIZES_DEFAULT = {
  launcher: '(min-width: 900px) 560px, calc(100vw - 32px)',
  client: '(min-width: 900px) 640px, calc(100vw - 32px)',
};

/** Largeurs disponibles de l'image `key` : celles de la langue de la page, sinon celles de l'autre langue. */
function imageVariants(manifest, key, lang) {
  const own = manifest.images.filter((i) => i.key === key && i.lang === lang);
  const any = own.length ? own : manifest.images.filter((i) => i.key === key);
  if (!any.length) throw new Error(`Image inconnue : ${key} (absente de site/img/manifest.json)`);
  const chosenLang = any[0].lang;
  return any.filter((i) => i.lang === chosenLang).sort((a, b) => a.width - b.width);
}

// --- moteur de modèle --------------------------------------------------------------------------------------------

const TOKEN_RE = /\{\{\s*([#^/]?)\s*([^{}]*?)\s*\}\}/g;
const SECTIONS = new Set(['rel', 'sha']);
const MAX_DEPTH = 4;

/** Découpe un texte en arbre : { type: 'text'|'var'|'section', … }. Sections : rel et sha seulement. */
function parseTemplate(text, label) {
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  const addText = (value) => {
    if (/\{\{|\}\}/.test(value)) throw new Error(`${label} : marqueur mal formé près de « ${value.match(/.{0,20}(\{\{|\}\}).{0,20}/s)[0].replace(/\s+/g, ' ')} »`);
    if (value) stack[stack.length - 1].children.push({ type: 'text', value });
  };
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text))) {
    addText(text.slice(last, match.index));
    last = TOKEN_RE.lastIndex;
    const [, sigil, name] = match;
    const top = stack[stack.length - 1];
    if (sigil === '#' || sigil === '^') {
      if (!SECTIONS.has(name)) throw new Error(`${label} : bloc inconnu {{${sigil}${name}}}`);
      const node = { type: 'section', name, inverse: sigil === '^', children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      if (stack.length === 1 || top.name !== name) throw new Error(`${label} : {{/${name}}} sans ouverture correspondante`);
      stack.pop();
    } else {
      top.children.push({ type: 'var', name });
    }
  }
  addText(text.slice(last));
  if (stack.length > 1) throw new Error(`${label} : bloc {{#${stack[stack.length - 1].name}}} jamais fermé`);
  return root.children;
}

/** Contrôle statique (indépendant de la release) : rel.* seulement dans {{#rel}}, rel.sha256 seulement dans {{#sha}}. */
function checkNodes(nodes, label, inRel = false, inSha = false) {
  for (const node of nodes) {
    if (node.type === 'section') {
      checkNodes(node.children, label, inRel || (node.name === 'rel' && !node.inverse), inSha || (node.name === 'sha' && !node.inverse));
    } else if (node.type === 'var' && node.name.startsWith('rel.') && node.name !== 'rel.releasesUrl') {
      if (!inRel) throw new Error(`${label} : {{${node.name}}} doit être dans un bloc {{#rel}}…{{/rel}}`);
      if (node.name === 'rel.sha256' && !inSha) throw new Error(`${label} : {{rel.sha256}} doit être dans un bloc {{#sha}}…{{/sha}}`);
    }
  }
}

function lookupText(texts, key) {
  for (const lang of LANGS) {
    if (typeof texts[lang][key] !== 'string') throw new Error(`Texte absent de site/i18n.js (${lang}) : ${key}`);
  }
}

function imageTag(spec, page, env) {
  const [head, ...options] = spec.split('|');
  const [key, ...flags] = head.split(':');
  for (const flag of flags) if (flag !== 'eager') throw new Error(`Option d'image inconnue : ${flag} (dans {{img.${spec}}})`);
  let sizes = null;
  for (const option of options) {
    const m = /^sizes=(.+)$/.exec(option.trim());
    if (!m || /["<>]/.test(m[1])) throw new Error(`Option d'image inconnue : ${option} (dans {{img.${spec}}})`);
    sizes = m[1].trim();
  }
  const variants = imageVariants(env.manifest, key, page.lang);
  const widest = variants[variants.length - 1];
  const altKey = `alt.${key}`;
  lookupText(env.texts, altKey);
  const alt = env.texts[page.lang][altKey];
  if (/</.test(alt)) throw new Error(`${altKey} : pas de balise dans un texte alternatif`);
  for (const variant of variants) env.usedImages.add(variant.file);
  const url = (file) => `${page.root}img/${file}`;
  const eager = flags.includes('eager');
  return `<img src="${url(widest.file)}" srcset="${variants.map((v) => `${url(v.file)} ${v.width}w`).join(', ')}" sizes="${sizes || (key.startsWith('client-') ? SIZES_DEFAULT.client : SIZES_DEFAULT.launcher)}" width="${widest.width}" height="${widest.height}" alt="${alt.replace(/"/g, '&quot;')}"${eager ? '' : ' loading="lazy"'} decoding="async">`;
}

function resolveVariable(name, page, env, depth) {
  if (name === 'lang') return page.lang;
  if (name === 'root') return page.root;
  if (name === 'year') return String(env.year);
  if (name === 'url.fr' || name === 'url.en') return PAGE_URL[name.slice(4)];
  if (name === 'url.canonical') return page.canonical;
  if (name.startsWith('t.')) {
    const key = name.slice(2);
    lookupText(env.texts, key);
    return renderText(env.texts[page.lang][key], page, env, depth + 1, `site/i18n.js (${page.lang}) ${key}`);
  }
  if (name.startsWith('rel.')) {
    const field = name.slice(4);
    if (field === 'releasesUrl') return RELEASES_URL;
    const rel = env.rel;
    const values = rel && {
      version: rel.version,
      setupUrl: rel.setupUrl,
      setupSize: formatSize(rel.setupSize, page.lang),
      sha256: rel.sha256,
      portableUrl: rel.portableUrl,
      date: formatDate(rel.publishedAt, page.lang),
      releaseUrl: rel.releaseUrl,
    };
    if (!values || !(field in values)) throw new Error(`Marqueur inconnu : {{${name}}}`);
    return escapeHtml(values[field] ?? '');
  }
  if (name.startsWith('cat.')) {
    const [, id, field, ...extra] = name.split('.');
    if (!id || !field || extra.length) throw new Error(`Marqueur inconnu : {{${name}}}`);
    return escapeHtml(catalogValue(id, field));
  }
  if (name.startsWith('img.')) return imageTag(name.slice(4), page, env);
  if (name === 'html.logo') return logoSvg(`logo-${++env.logoCount}`, 40, false);
  if (name === 'html.logoHero') return logoSvg(`logo-${++env.logoCount}`, 160, true);
  if (name === 'html.credits') return env.credits[page.lang];
  if (name === 'html.news') return env.news[page.lang];
  throw new Error(`Marqueur inconnu : {{${name}}}`);
}

function renderNodes(nodes, page, env, depth) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'var') out += resolveVariable(node.name, page, env, depth);
    else {
      const on = node.name === 'rel' ? Boolean(env.rel) : Boolean(env.rel && env.rel.sha256);
      if (node.inverse ? !on : on) out += renderNodes(node.children, page, env, depth);
    }
  }
  return out;
}

/** Rend un texte (modèle ou valeur de i18n.js) ; les valeurs de i18n.js peuvent elles-mêmes contenir des marqueurs. */
function renderText(text, page, env, depth, label) {
  if (depth > MAX_DEPTH) throw new Error(`${label} : marqueurs imbriqués trop profondément`);
  const nodes = parseTemplate(text, label);
  checkNodes(nodes, label);
  return renderNodes(nodes, page, env, depth);
}

// --- police : TTF -> WOFF 1.0 ------------------------------------------------------------------------------------

/** Convertit un TrueType (une seule fonte) en WOFF 1.0 : tables compressées seulement si plus petites, alignées sur 4 octets. */
function ttfToWoff(ttf) {
  const flavor = ttf.readUInt32BE(0);
  if (ttf.toString('ascii', 0, 4) === 'ttcf' || ![0x00010000, 0x74727565, 0x4f54544f].includes(flavor)) throw new Error('Police non convertible (collection ou format inconnu)');
  const count = ttf.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const offset = ttf.readUInt32BE(at + 8);
    const length = ttf.readUInt32BE(at + 12);
    if (offset + length > ttf.length) throw new Error('Police tronquée');
    const data = ttf.subarray(offset, offset + length);
    const packed = zlib.deflateSync(data, { level: 9 });
    tables.push({ tag: ttf.subarray(at, at + 4), checksum: ttf.readUInt32BE(at + 4), length, data: packed.length < length ? packed : data });
  }
  tables.sort((a, b) => Buffer.compare(a.tag, b.tag));
  const pad4 = (n) => (n + 3) & ~3;
  const headSize = 44 + 20 * count;
  let offset = headSize;
  let sfntSize = 12 + 16 * count;
  const parts = [];
  const directory = Buffer.alloc(20 * count);
  tables.forEach((table, i) => {
    table.tag.copy(directory, i * 20);
    directory.writeUInt32BE(offset, i * 20 + 4);
    directory.writeUInt32BE(table.data.length, i * 20 + 8);
    directory.writeUInt32BE(table.length, i * 20 + 12);
    directory.writeUInt32BE(table.checksum, i * 20 + 16);
    parts.push(table.data, Buffer.alloc(pad4(table.data.length) - table.data.length));
    offset += pad4(table.data.length);
    sfntSize += pad4(table.length);
  });
  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 'ascii');
  header.writeUInt32BE(flavor, 4);
  header.writeUInt32BE(offset, 8);
  header.writeUInt16BE(count, 12);
  header.writeUInt32BE(sfntSize, 16);
  const head = tables.find((t) => t.tag.toString('ascii') === 'head');
  if (head) {
    // version de la police = fontRevision (Fixed 16.16) de la table head, recopiée dans l'en-tête
    const raw = head.data.length === head.length ? head.data : zlib.inflateSync(head.data);
    header.writeUInt16BE(raw.readUInt16BE(4), 20);
    header.writeUInt16BE(raw.readUInt16BE(6), 22);
  }
  return Buffer.concat([header, directory, ...parts]);
}

// --- fichiers de sortie ------------------------------------------------------------------------------------------

function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}${BASE_PATH}sitemap.xml\n`;
}

function sitemapXml() {
  const alternates = [['fr', PAGE_URL.fr], ['en', PAGE_URL.en], ['x-default', PAGE_URL.fr]]
    .map(([hreflang, href]) => `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>`).join('\n');
  const entry = (url) => `  <url>\n    <loc>${url}</loc>\n${alternates}\n  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entry(PAGE_URL.fr)}\n${entry(PAGE_URL.en)}\n</urlset>\n`;
}

function faviconSvg() {
  return `${logo.svg({ id: 'favicon', size: 64, glow: false })}\n`;
}

/**
 * Le dossier de sortie est vidé à chaque génération : il est refusé s'il contient le dépôt ou les sources, ou s'il est dans
 * les sources, et, quand il existe déjà, s'il n'est pas vide sans être un dossier produit par ce script (nommé _site, ou
 * portant le fichier .attack-site). Sinon `--out docs`, `--out src` ou `--out .git` effaceraient un dossier du dépôt.
 */
function assertSafeOut(out, src) {
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(out, ROOT) || inside(out, src) || inside(src, out) || path.parse(out).root === out) {
    throw new Error(`Dossier de sortie refusé : ${out}`);
  }
  if (!fs.existsSync(out)) return;
  if (!fs.statSync(out).isDirectory()) throw new Error(`Dossier de sortie refusé : ${out} existe et n'est pas un dossier`);
  const generated = path.basename(out) === '_site' || fs.existsSync(path.join(out, OUT_MARKER));
  if (!generated && fs.readdirSync(out).length > 0) {
    throw new Error(`Dossier de sortie refusé : ${out} n'est pas vide et n'a pas été produit par ce script (choisis un dossier neuf ou vide, ou _site)`);
  }
}

/**
 * Génère le site. options : { out, src, offline, fixture, strict, log } (et, pour les tests : get, sleep, retries, retryMs, repoVersion).
 * Retourne { out, rel, problems, pages, images, files }.
 */
async function build(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`Node 20 ou plus récent requis (version ${process.versions.node})`);
  const log = options.log || (() => {});
  // chemins donnés par l'appelant : relatifs au dossier courant ; par défaut site/ (ou SITE_SRC, pour les essais) et _site/
  const given = options.src || process.env.SITE_SRC;
  const src = given ? path.resolve(given) : path.join(ROOT, 'site');
  const out = options.out ? path.resolve(options.out) : path.join(ROOT, '_site');
  assertSafeOut(out, src);
  for (const required of ['template.html', '404.template.html', 'i18n.js', 'styles.css']) {
    if (!fs.existsSync(path.join(src, required))) throw new Error(`Source manquante : ${path.join(src, required)}`);
  }

  const texts = loadSiteI18n(src);
  const manifest = loadManifest(src);
  const { rel, problems, source } = await readRelease({
    offline: options.offline, fixture: options.fixture, strict: options.strict, log, get: options.get, sleep: options.sleep,
    retries: options.retries, retryMs: options.retryMs, repoVersion: options.repoVersion || require('../package.json').version,
  });
  for (const problem of problems) log(`release : ${problem}`);
  if (options.strict && !rel) throw new Error(`Aucune release utilisable (${problems.join(' ; ') || 'raison inconnue'}) : génération refusée avec --strict`);
  log(rel ? `release : v${rel.version} (${source})` : 'release : aucune release utilisable, page « sans release »');

  const rendererData = runRendererScript('data.js').AttackData;
  const data = {
    packs: loadPacks(),
    changelog: rendererData.CHANGELOG,
    licenseNames: rendererData.LICENSE_NAMES,
    launcherI18n: runRendererScript('i18n.js').I18n,
  };
  const now = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date();
  const env = {
    texts,
    manifest,
    rel,
    year: now.getUTCFullYear(),
    usedImages: new Set(),
    logoCount: 0,
    credits: Object.fromEntries(LANGS.map((lang) => [lang, creditsHtml(lang, data)])),
    news: Object.fromEntries(LANGS.map((lang) => [lang, newsHtml(lang, data)])),
  };

  const pages = [
    { file: 'index.html', template: 'template.html', lang: 'fr', root: '', canonical: PAGE_URL.fr },
    { file: 'en/index.html', template: 'template.html', lang: 'en', root: '../', canonical: PAGE_URL.en },
    { file: '404.html', template: '404.template.html', lang: 'fr', root: BASE_PATH, canonical: PAGE_URL.fr },
  ];
  const rendered = pages.map((page) => {
    env.logoCount = 0;
    const text = fs.readFileSync(path.join(src, page.template), 'utf8');
    const html = renderText(text, page, env, 0, `site/${page.template} (${page.file})`);
    if (/\{\{|\}\}/.test(html)) throw new Error(`Marqueur restant dans ${page.file}`);
    return { ...page, html };
  });

  // tout est prêt : on écrit (le dossier de sortie n'est vidé qu'à partir d'ici)
  fs.rmSync(out, { recursive: true, force: true });
  const write = (rel_, content) => {
    const target = path.join(out, rel_);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  for (const page of rendered) write(page.file, page.html);
  write('styles.css', fs.readFileSync(path.join(src, 'styles.css')));
  for (const file of [...env.usedImages].sort()) write(`img/${file}`, fs.readFileSync(path.join(manifest.dir, file)));
  write('fonts/montserrat-bold.woff', ttfToWoff(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'fonts', 'Montserrat-Bold.ttf'))));
  write('fonts/OFL-montserrat.txt', fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'fonts', 'OFL-montserrat.txt')));
  write('favicon.svg', faviconSvg());
  write('apple-touch-icon.png', renderIcon(180, { background: true }));
  const ogSource = [path.join(src, 'img', 'og.png'), path.join(ROOT, 'docs', 'images', 'home.png')].find((f) => fs.existsSync(f));
  write('og.png', fs.readFileSync(ogSource));
  // image de partage de la page anglaise : sans og-en.png dans les sources, on reprend la française (comme pour les captures)
  write('og-en.png', fs.readFileSync([path.join(src, 'img', 'og-en.png'), ogSource].find((f) => fs.existsSync(f))));
  write('robots.txt', robotsTxt());
  write('sitemap.xml', sitemapXml());
  if (path.basename(out) !== '_site') write(OUT_MARKER, 'Dossier produit par scripts/build-site.js : il peut être vidé et regénéré.\n');

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(out, full).split(path.sep).join('/'));
    }
  };
  walk(out);
  if (files.some((f) => f.endsWith('.js'))) throw new Error('Un fichier .js a été publié par erreur');
  log(`site généré dans ${out} : ${files.length} fichiers`);
  return { out, rel, problems, pages: rendered.map((p) => p.file), images: [...env.usedImages].sort(), files };
}

// --- vérification des liens (--check-links) ----------------------------------------------------------------------

function collectLinks(text) {
  const urls = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]`]+/g)) urls.add(match[0].replace(/[.,;:!]+$/, ''));
  for (const namespace of ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml']) urls.delete(namespace); // identifiants XML, pas des liens
  return urls;
}

async function checkUrl(url) {
  let failure = null;
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
      if (method === 'GET') await response.body?.cancel();
      if (method === 'HEAD' && response.status >= 400) {
        failure = { status: response.status };
        continue; // certains serveurs refusent HEAD
      }
      return { status: response.status, finalUrl: response.url };
    } catch (error) {
      failure = { error: error.cause?.code || error.message };
    }
  }
  return failure;
}

/** Teste chaque lien externe des pages générées et de README.md ; retourne le nombre de liens en échec franc. */
async function checkLinks(out, log) {
  const sources = new Map();
  const add = (url, where) => sources.set(url, [...(sources.get(url) || []), where]);
  for (const page of ['index.html', 'en/index.html', '404.html']) {
    for (const url of collectLinks(fs.readFileSync(path.join(out, page), 'utf8'))) add(url, page);
  }
  for (const url of collectLinks(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'))) add(url, 'README.md');
  const urls = [...sources.keys()].sort();
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      results.set(url, await checkUrl(url));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  let hard = 0;
  const own = [];
  const doubtful = [];
  for (const url of urls) {
    const result = results.get(url);
    const where = [...new Set(sources.get(url))].join(', ');
    const line = `${result.status || 'ERREUR'}  ${url}  (${where})${result.error ? ` ${result.error}` : ''}`;
    if (new URL(url).hostname === '7shiki3.github.io') own.push(line);
    else if (result.status >= 200 && result.status < 400) log(`  ok   ${line}`);
    else if ([401, 403, 429, 999].includes(result.status)) doubtful.push(line);
    else {
      hard++;
      log(`  FAIL ${line}`);
    }
  }
  for (const line of doubtful) log(`  ?    ${line}  (refus automatique probable : à ouvrir à la main)`);
  for (const line of own) log(`  site ${line}  (le site n'est joignable qu'une fois GitHub Pages activé)`);
  log(`${urls.length} liens testés : ${hard} en échec, ${doubtful.length} à vérifier à la main, ${own.length} sur le site lui-même`);
  return hard;
}

// --- ligne de commande -------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--offline', '--strict', '--check-links'].includes(arg)) options[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    else if (['--out', '--src', '--fixture'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} attend une valeur`);
      options[arg.slice(2)] = argv[++i];
    } else throw new Error(`Option inconnue : ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await build({ ...options, log: (line) => console.log(line) });
  if (result.problems.length && !result.rel && process.env.GITHUB_ACTIONS) console.log(`::warning::Release inutilisable, page générée sans release : ${result.problems.join(' ; ')}`);
  if (options.checkLinks && (await checkLinks(result.out, (line) => console.log(line))) > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-site : ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  CSP, PAGE_URL, RELEASES_URL, OUT_MARKER, build, assertSafeOut, parseRelease, readRelease, compareVersions, parseArgs, formatSize, formatDate, ttfToWoff,
  webpSize, flattenKeys, escapeHtml, sitemapXml, robotsTxt, checkLinks, collectLinks,
};
