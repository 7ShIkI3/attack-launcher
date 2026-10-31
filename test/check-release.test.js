'use strict';
// scripts/check-release.js : contrôle d'une release (brouillon compris) avant publication, sans réseau (gh est simulé).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const check = require('../scripts/check-release');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-release.js');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Fichiers d'une release 0.8.0 complète : un jar par profil (avec digest), SHA256SUMS et les fichiers du launcher. */
const JARS = ['attack-client-2.7.0.jar', 'attack-fabric-3.6.0+mc1.21.1.jar', 'attack-fabric-3.6.0+mc26.3.jar', 'attack-forge-1.0.0+mc1.7.10.jar'];
const LAUNCHER = ['ATTACK-Launcher-Setup-0.8.0.exe', 'ATTACK-Launcher-Setup-0.8.0.exe.blockmap', 'ATTACK-Launcher-Portable-0.8.0.exe', 'latest.yml'];

/** Release au format `gh release view --json` ; `jars` : noms des jars, `extra` : autres fichiers ; sans digest quand `digest` est faux. */
function release({ jars = JARS, extra = [], digest = true, tag = 'v0.8.0', draft = true } = {}) {
  const file = (name, withDigest) => ({ name, size: name.length * 1000, ...(withDigest ? { digest: `sha256:${sha(name)}` } : {}), url: `https://github.com/7ShIkI3/attack-launcher/releases/download/${tag}/${encodeURIComponent(name)}` });
  return {
    tagName: tag, isDraft: draft, isPrerelease: false,
    assets: [...jars.map((n) => file(n, digest)), ...LAUNCHER.map((n) => file(n, true)), ...extra.map((n) => file(n, true)), file('SHA256SUMS', true)],
  };
}
/** SHA256SUMS qui a une ligne par nom donné. */
const sums = (names = JARS) => `${names.map((n) => `${sha(n)}  ${n}`).join('\n')}\n`;
const run = (raw, sumsText, extra) => check.checkRelease(check.normalizeRelease(raw), sumsText, extra);

test('release complète : chaque profil trouve son jar, SHA256SUMS a une ligne par jar, aucune erreur ni avertissement', () => {
  const result = run(release(), sums());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.tag, 'v0.8.0');
  assert.equal(result.draft, true);
  assert.deepEqual(result.profiles.map((p) => [p.id, p.jar, p.version]), [
    ['forge-1.8.9', 'attack-client-2.7.0.jar', '2.7.0'],
    ['fabric-1.21.1', 'attack-fabric-3.6.0+mc1.21.1.jar', '3.6.0'],
    ['fabric-26.3', 'attack-fabric-3.6.0+mc26.3.jar', '3.6.0'],
    ['forge-1.7.10', 'attack-forge-1.0.0+mc1.7.10.jar', '1.0.0'],
  ]);
  assert.equal(result.profiles.length, catalog.list().length, 'un jar pour chaque profil du catalogue');
  assert.ok(result.profiles.every((p) => /^[0-9a-f]{64}$/.test(p.sha256)));
  const text = check.format(result);
  assert.match(text, /^Release v0\.8\.0 \(brouillon\) : 9 fichiers/, '4 jars, les 4 fichiers du launcher et SHA256SUMS');
  assert.match(text, /OK : les 4 profils trouvent chacun leur jar/);
});

test('release 0.7.0 réelle (fixture) : trois profils trouvent leur jar, la 1.7.10 n’en a pas encore', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'release-0.7.0.json'), 'utf8'));
  const realSums = `${raw.assets.filter((a) => /\.jar$/.test(a.name)).map((a) => `${a.digest.replace('sha256:', '')}  ${a.name}`).join('\n')}\n`;
  const result = run(raw, realSums);
  assert.deepEqual(result.profiles.map((p) => p.id), ['forge-1.8.9', 'fabric-1.21.1', 'fabric-26.3']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /forge-1\.7\.10.*attack-forge-\*\+mc1\.7\.10\.jar.*NO_JAR/);
  assert.deepEqual(result.warnings, [], 'les fichiers du launcher y sont');
  // la même release 0.7.0 avec le jar 1.7.10 ajouté (comme le brouillon 0.8.0) : rien à redire
  const withOld = structuredClone(raw);
  const jar = 'attack-forge-1.0.0+mc1.7.10.jar';
  withOld.assets.push({ name: jar, size: 1234, digest: `sha256:${sha(jar)}`, url: `https://example.invalid/${jar}` });
  const ok = run(withOld, `${realSums}${sha(jar)}  ${jar}\n`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.profiles.map((p) => p.id), ['forge-1.8.9', 'fabric-1.21.1', 'fabric-26.3', 'forge-1.7.10']);
});

test('jar manquant, en double ou mal nommé : erreur claire par profil', () => {
  // pas de jar 1.7.10, mais un jar de préversion (hors règle) : il est cité
  let result = run(release({ jars: [...JARS.slice(0, 3), 'attack-forge-1.0.0-beta.1+mc1.7.10.jar'] }), sums(JARS.slice(0, 3)));
  assert.ok(result.errors.some((e) => /Profil forge-1\.7\.10 : .*attack-forge-1\.0\.0-beta\.1\+mc1\.7\.10\.jar.*NO_JAR/.test(e)), result.errors.join('\n'));
  assert.ok(result.errors.some((e) => /attack-forge-1\.0\.0-beta\.1\+mc1\.7\.10\.jar.*aucun profil/.test(e)), 'et il est orphelin');

  // deux jars pour la 1.7.10 : jamais un choix au hasard
  const twice = [...JARS, 'attack-forge-1.0.1+mc1.7.10.jar'];
  result = run(release({ jars: twice }), sums(twice));
  assert.ok(result.errors.some((e) => /forge-1\.7\.10.*AMBIGUOUS_JAR/.test(e)), result.errors.join('\n'));
  assert.ok(result.errors.some((e) => /Le profil forge-1\.7\.10 reconnaît 2 jars/.test(e)));

  // jar d'un autre profil de Minecraft : pas pris pour le sien
  result = run(release({ jars: [...JARS.slice(0, 3), 'attack-forge-1.0.0+mc1.8.9.jar'] }), sums(JARS.slice(0, 3)));
  assert.ok(result.errors.some((e) => /forge-1\.7\.10/.test(e)));
  assert.ok(result.errors.some((e) => /attack-forge-1\.0\.0\+mc1\.8\.9\.jar.*aucun profil/.test(e)));
});

test('attack-client-1710-1.0.0.jar : signalé comme dangereux, la règle 1.8.9 l’installerait à la place du vrai jar', () => {
  const trap = 'attack-client-1710-1.0.0.jar';
  const jars = [...JARS.slice(0, 3), trap]; // le jar 1.7.10 a été publié sous le nom que Gradle donne par défaut
  const result = run(release({ jars }), sums(jars));
  const text = result.errors.join('\n');
  assert.match(text, /attack-client-1710-1\.0\.0\.jar.*profil forge-1\.8\.9.*pas une version propre/);
  assert.match(text, /Le profil forge-1\.8\.9 reconnaît 2 jars \(attack-client-2\.7\.0\.jar, attack-client-1710-1\.0\.0\.jar\)/);
  assert.match(text, /Profil forge-1\.7\.10 : .*NO_JAR/, 'et la 1.7.10 n’a toujours pas son jar');
  assert.equal(result.errors.length, 3);
  // et seul, sans le vrai jar 1.8.9 : toujours dangereux
  const alone = run(release({ jars: ['attack-fabric-3.6.0+mc1.21.1.jar', 'attack-fabric-3.6.0+mc26.3.jar', 'attack-forge-1.0.0+mc1.7.10.jar', trap] }), '');
  assert.ok(alone.errors.some((e) => /pas une version propre/.test(e)));
  const noVersion = run(release({ jars: [...JARS, 'attack-client.jar'] }), sums());
  assert.ok(noVersion.errors.some((e) => /attack-client\.jar.*pas de version/.test(e)));
});

test('SHA256SUMS : absent, sans ligne pour un jar, en double, contraire au digest ou illisible = erreur ; ligne de trop = avertissement', () => {
  // pas de fichier SHA256SUMS dans la release
  const raw = release();
  raw.assets = raw.assets.filter((a) => a.name !== 'SHA256SUMS');
  assert.match(run(raw, undefined).errors.join('\n'), /n'a pas de fichier SHA256SUMS/);
  // joint mais illisible (gh a échoué)
  assert.match(run(release(), undefined).errors.join('\n'), /joint à la release mais son contenu n'a pas pu être lu/);
  // une ligne manque : celle du jar 1.7.10
  assert.deepEqual(run(release(), sums(JARS.slice(0, 3))).errors, ['SHA256SUMS n\'a pas de ligne pour « attack-forge-1.0.0+mc1.7.10.jar ».']);
  // une ligne en double
  assert.match(run(release(), `${sums()}${sha(JARS[0])}  ${JARS[0]}\n`).errors.join('\n'), /2 lignes pour « attack-client-2\.7\.0\.jar »/);
  // hash qui n'est pas celui du digest GitHub
  const wrong = sums().replace(sha(JARS[3]), 'a'.repeat(64));
  assert.match(run(release(), wrong).errors.join('\n'), /digest GitHub de « attack-forge-1\.0\.0\+mc1\.7\.10\.jar » ne sont pas le même SHA-256/);
  // ligne illisible
  assert.match(run(release(), `${sums()}pas un hash  fichier.jar\n`).errors.join('\n'), /ligne illisible « pas un hash {2}fichier\.jar »/);
  // un nom approximatif (sans le « + » exact) n'est pas la ligne du jar
  assert.match(run(release(), sums().replace('attack-forge-1.0.0+mc1.7.10.jar', 'attack-forge-1.0.0-mc1.7.10.jar')).errors.join('\n'), /pas de ligne pour « attack-forge-1\.0\.0\+mc1\.7\.10\.jar »/);
  // format « * » (mode binaire de sha256sum) accepté ; ligne d'un jar qui n'est plus dans la release : avertissement seulement
  const binary = sums().replace(`  ${JARS[1]}`, ` *${JARS[1]}`);
  const lenient = run(release(), `${binary}${sha('vieux')}  attack-client-1.0.0.jar\n`);
  assert.deepEqual(lenient.errors, []);
  assert.deepEqual(lenient.warnings, ['SHA256SUMS a une ligne pour « attack-client-1.0.0.jar », qui n\'est le jar d\'aucun profil de cette release.']);
});

test('sans digest GitHub : le hash vient de SHA256SUMS ; sans digest ni SHA256SUMS, l’installation serait refusée donc la release aussi', () => {
  const noDigest = run(release({ digest: false }), sums());
  assert.deepEqual(noDigest.errors, []);
  assert.deepEqual(noDigest.profiles.map((p) => p.sha256), JARS.map(sha), 'le hash de chaque jar est lu dans les lignes de SHA256SUMS');
  // SHA256SUMS joint (il sert de somme au launcher) mais sans la ligne du jar 1.7.10 : une erreur de ligne, et rien d'autre
  assert.equal(run(release({ digest: false }), sums(JARS.slice(0, 3))).errors.length, 1);
  // aucun hash nulle part pour un jar : le launcher refuserait de l'installer
  const bare = release({ digest: false });
  bare.assets = bare.assets.filter((a) => a.name !== 'SHA256SUMS');
  const result = run(bare, undefined);
  assert.ok(result.errors.some((e) => /ne publie pas de SHA-256/.test(e)), result.errors.join('\n'));
});

test('jar orphelin : erreur s’il s’appelle attack*, simple avertissement sinon ; fichiers du launcher manquants signalés', () => {
  const orphan = run(release({ extra: ['attack-tools-1.0.jar', 'autre-bibliotheque.jar'] }), sums());
  assert.ok(orphan.errors.some((e) => /attack-tools-1\.0\.jar.*aucun profil/.test(e)));
  assert.ok(orphan.warnings.some((w) => /autre-bibliotheque\.jar.*aucun profil/.test(w)));
  assert.ok(!orphan.errors.some((e) => /autre-bibliotheque/.test(e)));
  // -sources, -javadoc, -dev et -deobf sont ignorés comme à l'installation
  const sources = run(release({ extra: ['attack-forge-1.0.0+mc1.7.10-sources.jar', 'attack-client-2.7.0-dev.jar'] }), sums());
  assert.deepEqual(sources.errors, []);

  const raw = release();
  raw.assets = raw.assets.filter((a) => !/latest\.yml|Portable/.test(a.name));
  const missing = run(raw, sums());
  assert.deepEqual(missing.errors, []);
  assert.deepEqual(missing.warnings.map((w) => w.replace(/\. Chaque.*$/, '')), ['Fichier du launcher absent : Portable.exe', 'Fichier du launcher absent : latest.yml']);
});

test('formats d’entrée : gh (tagName, url) et API GitHub (tag_name, browser_download_url) donnent la même release', () => {
  const gh = check.normalizeRelease(release());
  const api = check.normalizeRelease({
    tag_name: 'v0.8.0', draft: true, prerelease: false,
    assets: release().assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest, browser_download_url: a.url })),
  });
  assert.deepEqual(gh, api);
  assert.equal(gh.draft, true);
  assert.throws(() => check.normalizeRelease({ tagName: 'v1' }), /liste « assets »/);
  assert.throws(() => check.normalizeRelease(null), /illisible/);
  assert.deepEqual(check.parseSums(`${sha('a')}  a.jar\r\n\r\n${sha('b')} *b.jar\n`).byName, new Map([['a.jar', [sha('a')]], ['b.jar', [sha('b')]]]));
});

test('ligne de commande : options, tag unique, --file et un tag incompatibles', () => {
  assert.deepEqual(check.parseArgs([]), { tag: null, repo: '7ShIkI3/attack-launcher', file: null, sums: null });
  assert.deepEqual(check.parseArgs(['v0.8.0', '--repo', 'a/b', '--sums', 's.txt']), { tag: 'v0.8.0', repo: 'a/b', file: null, sums: 's.txt' });
  assert.throws(() => check.parseArgs(['--inconnue']), /Option inconnue/);
  assert.throws(() => check.parseArgs(['v1', 'v2']), /Argument en trop/);
  assert.throws(() => check.parseArgs(['--file']), /attend une valeur/);
  assert.throws(() => check.parseArgs(['--file', 'x.json', 'v1']), /ne vont pas ensemble/);
});

test('gh : la release est lue avec `release view` (brouillon compris), SHA256SUMS avec `release download --output -`', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify(release());
    if (args[1] === 'download') return sums();
    throw new Error(`appel inattendu : ${args.join(' ')}`);
  };
  const output = [];
  assert.equal(check.main(['v0.8.0'], { run: gh, out: (t) => output.push(t) }), 0);
  assert.deepEqual(calls, [
    ['release', 'view', 'v0.8.0', '--repo', '7ShIkI3/attack-launcher', '--json', 'tagName,isDraft,isPrerelease,assets'],
    ['release', 'download', 'v0.8.0', '--repo', '7ShIkI3/attack-launcher', '--pattern', 'SHA256SUMS', '--output', '-'],
  ]);
  assert.match(output[0], /OK : les 4 profils/);
  // sans tag : la dernière release publiée ; un SHA256SUMS local évite tout téléchargement
  calls.length = 0;
  const dir = tempDir();
  const local = path.join(dir, 'SHA256SUMS');
  fs.writeFileSync(local, sums());
  assert.equal(check.main(['--sums', local], { run: gh, out: () => {} }), 0);
  assert.deepEqual(calls, [['release', 'view', '--repo', '7ShIkI3/attack-launcher', '--json', 'tagName,isDraft,isPrerelease,assets']]);
  // le téléchargement de SHA256SUMS échoue : la release n'est pas validée
  const failing = (args) => {
    if (args[1] === 'download') throw new Error('gh : introuvable');
    return JSON.stringify(release());
  };
  const out = [];
  assert.equal(check.main(['v0.8.0'], { run: failing, out: (t) => out.push(t) }), 1);
  assert.match(out[0], /n'a pas pu être lu/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('programme : code 0 pour une release correcte, 1 pour la 0.7.0 réelle (sans jar 1.7.10), message d’échec sur la sortie d’erreur', () => {
  const dir = tempDir();
  const good = path.join(dir, 'release.json');
  fs.writeFileSync(good, JSON.stringify({ ...release(), sha256sums: sums() }));
  let run1 = spawnSync(process.execPath, [SCRIPT, '--file', good], { encoding: 'utf8' });
  assert.equal(run1.status, 0, run1.stdout + run1.stderr);
  assert.match(run1.stdout, /OK : les 4 profils trouvent chacun leur jar/);

  run1 = spawnSync(process.execPath, [SCRIPT, '--file', path.join(__dirname, 'fixtures', 'release-0.7.0.json')], { encoding: 'utf8' });
  assert.equal(run1.status, 1);
  assert.match(run1.stdout, /ERREUR : Profil forge-1\.7\.10/);
  assert.match(run1.stdout, /ÉCHEC : 2 erreurs/, 'SHA256SUMS de la fixture n’est pas lisible : seul le contenu manque');

  run1 = spawnSync(process.execPath, [SCRIPT, '--file', path.join(dir, 'absent.json')], { encoding: 'utf8' });
  assert.equal(run1.status, 1);
  assert.match(run1.stderr, /ÉCHEC : /);
  run1 = spawnSync(process.execPath, [SCRIPT, '--option-inconnue'], { encoding: 'utf8' });
  assert.equal(run1.status, 1);
  assert.match(run1.stderr, /Option inconnue/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('package.json : npm run check-release, et la procédure de publication le cite', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['check-release'], 'node scripts/check-release.js');
  const wiki = fs.readFileSync(path.join(__dirname, '..', 'docs', 'wiki', 'Publier-une-version.md'), 'utf8');
  assert.match(wiki, /check-release/);
});
