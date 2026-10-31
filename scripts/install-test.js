'use strict';
// Installation réelle complète dans un dossier temporaire (jamais dans le vrai %APPDATA%\.minecraft),
// puis contre-vérification indépendante de tous les hash.
//   node scripts/install-test.js [dossier] [--profile <id>] [--release | --tag <tag>] [--shaders] [--replay] [--optifine <jar>] [--cycle]
// --profile  forge-1.8.9 (défaut), forge-1.7.10, fabric-1.21.1 ou fabric-26.3
// --release  jar ATTACK depuis la dernière release GitHub publiée (sans : build local, mode développeur)
// --tag      jar ATTACK EXACT d'une release précise, BROUILLON compris (les brouillons ne sont pas lisibles sans connexion) : la release est
//            lue et le jar du profil téléchargé avec `gh` (connecté à GitHub), son SHA-256 est vérifié, puis il est installé en mode
//            développeur. C'est l'essai « jars exacts à publier » de la procédure (voir Publier-une-version). Sans --release.
// --shaders  installe aussi Iris (réglage « Shaders » des profils Fabric)
// --replay   installe aussi Replay Mod (réglage « Replay Mod », coupé par défaut)
// --optifine profil 1.8.9 : copie ce jar OptiFine (le vôtre) dans <dossier>/.minecraft/libraries/optifine avant l'installation,
//            comme le ferait l'installateur d'OptiFine : le launcher doit le trouver, le valider et le copier dans mods
// --cycle    Fabric : après l'installation, coupe puis réactive les shaders et vérifie qu'Iris est retiré / remis,
//            qu'un jar ajouté à la main n'est jamais touché
// Sans --release ni --tag, le jar du mod vient du build local. Si le profil Fabric ou le profil 1.7.10 n'a pas encore de jar compilé,
// un JAR FACTICE (mod « attack » vide, créé dans le dossier de test) permet d'essayer tout le reste de la chaîne : c'est dit clairement.
// Le jar factice du profil 1.8.9 n'existe pas : son mod est compilé.
// Profil Forge (1.8.9 comme 1.7.10) : les bibliothèques Forge sont recontrôlées avec les `checksums` de l'install_profile.json de
// l'installateur officiel, retéléchargé à part, et non avec les SHA-1 que le launcher a lui-même écrits dans le JSON de version.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/main/catalog');
const forge = require('../src/main/forge');
const installer = require('../src/main/installer');
const mojang = require('../src/main/mojang');
const modpack = require('../src/main/modpack');
const { mavenPath } = require('../src/main/maven');
const { hashFile } = require('../src/main/http');
const { GITHUB_REPO } = require('../src/main/constants');
const { defaultDevJarDir } = require('../src/main/paths');
const mod = require('../src/main/mod');
const { findDevJar } = mod;
const { KNOT_CLIENT } = require('../src/main/fabric');
const { makeZip } = require('../test/helpers');
const releaseCheck = require('./check-release');

/** Dossier de jeu d'un profil dans une installation de test : <racine>/.attack (Forge) ou <racine>/.attack/profiles/<id>. */
function gameDirFor(root, profile) {
  return path.join(root, ...profile.gameDirName.split('/'));
}

/** Jar « mod ATTACK » FACTICE pour un profil Fabric : un fabric.mod.json et rien d'autre. Test du pipeline uniquement. */
function makeDummyFabricJar(dir, profile) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `attack-fabric-0.0.0+mc${profile.mc}.jar`);
  fs.writeFileSync(file, makeZip({
    'fabric.mod.json': JSON.stringify({
      schemaVersion: 1,
      id: 'attack',
      version: '0.0.0-dummy',
      name: 'ATTACK (JAR FACTICE - test du pipeline du launcher)',
      description: 'Jar factice créé par scripts/install-test.js : il ne contient aucun code.',
      environment: 'client',
      depends: { fabricloader: '>=0.19.0' },
    }),
    'DUMMY.txt': 'Jar factice du launcher ATTACK : aucun code, uniquement pour tester l installation.\n',
  }));
  return file;
}

/**
 * Classe du mod factice de Forge 1.7.10 : `@cpw.mods.fml.common.Mod(modid="attack", name="ATTACK Client", version="0.0.0-dummy")` sur une
 * classe publique sans code (class file version 49 : pas de StackMapTable à fournir). Un mcmod.info seul ne suffit pas : FML 1.7.10
 * n'identifie un mod que par son annotation @Mod, lue dans les classes du jar sans les charger ; sans elle le jar n'est ni un mod ni
 * « FMLFileResourcePack:ATTACK Client » dans le journal, que scripts/launch-test.js cherche.
 */
function dummyModClass() {
  const u1 = (n) => Buffer.from([n]);
  const u2 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const u4 = (n) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const utf8 = (text) => Buffer.concat([u1(1), u2(Buffer.byteLength(text)), Buffer.from(text, 'utf8')]);
  const pool = [
    utf8('attack/dummy/DummyMod'), // 1
    Buffer.concat([u1(7), u2(1)]), // 2 : Class #1
    utf8('java/lang/Object'), // 3
    Buffer.concat([u1(7), u2(3)]), // 4 : Class #3
    utf8('<init>'), // 5
    utf8('()V'), // 6
    Buffer.concat([u1(12), u2(5), u2(6)]), // 7 : NameAndType #5 #6
    Buffer.concat([u1(10), u2(4), u2(7)]), // 8 : Methodref Object.<init>
    utf8('Code'), // 9
    utf8('RuntimeVisibleAnnotations'), // 10
    utf8('Lcpw/mods/fml/common/Mod;'), // 11
    utf8('modid'), // 12
    utf8('attack'), // 13
    utf8('name'), // 14
    utf8('ATTACK Client'), // 15
    utf8('version'), // 16
    utf8('0.0.0-dummy'), // 17
  ];
  const code = Buffer.from([0x2a, 0xb7, 0x00, 0x08, 0xb1]); // aload_0 ; invokespecial Object.<init> ; return
  const codeAttribute = Buffer.concat([u2(9), u4(12 + code.length), u2(1), u2(1), u4(code.length), code, u2(0), u2(0)]);
  const constructor = Buffer.concat([u2(0x0001), u2(5), u2(6), u2(1), codeAttribute]);
  const pair = (name, value) => Buffer.concat([u2(name), u1(0x73), u2(value)]); // 's' : chaîne
  const annotation = Buffer.concat([u2(11), u2(3), pair(12, 13), pair(14, 15), pair(16, 17)]);
  const annotations = Buffer.concat([u2(10), u4(2 + annotation.length), u2(1), annotation]);
  return Buffer.concat([
    u4(0xcafebabe), u2(0), u2(49), u2(pool.length + 1), ...pool,
    u2(0x0021), u2(2), u2(4), u2(0), u2(0), u2(1), constructor, u2(1), annotations,
  ]);
}

/** Jar « mod ATTACK » FACTICE pour le profil Forge 1.7.10 : mcmod.info + un @Mod vide. Test du pipeline uniquement. */
function makeDummyForgeJar(dir, profile) {
  if (profile.id !== 'forge-1.7.10') throw new Error(`Pas de jar factice pour le profil ${profile.id} : compile son mod`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `attack-forge-0.0.0+mc${profile.mc}.jar`);
  fs.writeFileSync(file, makeZip({
    'mcmod.info': JSON.stringify([{
      modid: 'attack',
      name: 'ATTACK Client',
      description: 'JAR FACTICE - test du pipeline du launcher : aucun code.',
      version: '0.0.0-dummy',
      mcversion: profile.mc,
    }]),
    'attack/dummy/DummyMod.class': dummyModClass(),
    'DUMMY.txt': 'Jar factice du launcher ATTACK : aucun code, uniquement pour tester l installation.\n',
  }));
  return file;
}

/** Jar factice du profil : Fabric (fabric.mod.json) ou Forge 1.7.10 ; jamais pour le profil Forge 1.8.9. */
function makeDummyJar(dir, profile) {
  return catalog.isFabric(profile) ? makeDummyFabricJar(dir, profile) : makeDummyForgeJar(dir, profile);
}

/** Ce profil peut-il être essayé avec un jar factice (mod pas encore compilé) ? */
function allowsDummyJar(profile) {
  return catalog.isFabric(profile) || profile.id === 'forge-1.7.10';
}

const sha1Of = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex');

/**
 * Ce que les bibliothèques Forge installées doivent valoir, d'après l'installateur OFFICIEL (Buffer, retéléchargé par le test) et non
 * d'après les SHA-1 écrits par le launcher : [{ name, path, url, sha1: [valeurs acceptées] | null, source }].
 * Le jar universal vaut le fichier contenu dans l'installateur ; une bibliothèque avec `checksums` doit en avoir un parmi eux ;
 * sans checksum (`sha1: null`), le SHA-1 est celui que le dépôt Maven publie à côté du jar (`<url>.sha1`).
 */
function forgeLibraryExpectations(installerBuffer, profile) {
  const { install, versionInfo, universal } = forge.readInstallProfile(installerBuffer);
  if (versionInfo.id !== profile.loader.versionId) throw new Error(`Installateur inattendu : ${versionInfo.id} au lieu de ${profile.loader.versionId}`);
  return forge.clientLibraries(versionInfo).map((lib) => {
    const plan = forge.libraryPlan(lib, install.path);
    if (plan.forge) return { name: lib.name, path: plan.path, url: '', sha1: [sha1Of(universal)], source: 'jar universal de l’installateur' };
    return {
      name: lib.name,
      path: plan.path,
      url: plan.url,
      sha1: plan.sha1s.length > 0 ? plan.sha1s : null,
      source: plan.sha1s.length > 0 ? 'checksums de install_profile.json' : '.sha1 du dépôt Maven',
    };
  });
}

/**
 * Contre-vérification des bibliothèques Forge installées, SANS les SHA-1 que le launcher a écrits dans le JSON de version : l'installateur
 * officiel est retéléchargé (et contrôlé par le .sha1 de Maven), son install_profile.json donne les checksums attendus (forgeLibraryExpectations).
 * `check(fichier, algorithme, attendu(s), libellé)` contrôle un fichier ; `fail(message)` signale un écart d'ensemble ; `fetchFn` : fetch (injectable).
 * Renvoie le résumé à afficher.
 */
async function verifyForgeLibraries({ profile, minecraftDir, loaderJson, check, fail, fetchFn = fetch }) {
  const sha1In = (text) => /\b([0-9a-f]{40})\b/i.exec(text)?.[1]?.toLowerCase();
  const installerUrl = forge.installerUrl(profile);
  const installerJar = Buffer.from(await (await fetchFn(installerUrl)).arrayBuffer());
  const installerSha1 = sha1In(await (await fetchFn(`${installerUrl}.sha1`)).text());
  if (!installerSha1 || installerSha1 !== sha1Of(installerJar)) fail('installateur Forge : SHA-1 différent de celui de Maven');
  const expected = forgeLibraryExpectations(installerJar, profile);
  const installedNames = loaderJson.libraries.map((l) => l.name).sort();
  if (JSON.stringify(installedNames) !== JSON.stringify(expected.map((e) => e.name).sort())) fail('bibliothèques Forge installées ≠ celles de l’installateur officiel');
  const bySource = {};
  for (const lib of expected) {
    const file = path.join(minecraftDir, 'libraries', ...lib.path.split('/'));
    let accepted = lib.sha1;
    if (!accepted) {
      const published = sha1In(await (await fetchFn(`${lib.url}.sha1`)).text());
      accepted = [published || 'introuvable'];
    }
    await check(file, 'sha1', accepted, `${lib.name} (${lib.source})`);
    bySource[lib.source] = (bySource[lib.source] || 0) + 1;
  }
  return `${loaderJson.libraries.length} bibliothèques Forge recontrôlées avec l'installateur officiel (${Object.entries(bySource).map(([source, n]) => `${n} par ${source}`).join(', ')})`;
}

/**
 * Jar ATTACK EXACT d'une release précise (brouillon compris), téléchargé avec `gh` dans `dir` et vérifié par son SHA-256 (digest GitHub,
 * sinon la ligne de SHA256SUMS). Le jar est celui que mod.parseRelease() désigne pour ce profil, comme le ferait le launcher.
 * `run` : exécuteur de gh (injectable pour les essais). Renvoie { file, name, sha256, tag, draft }.
 */
function fetchTagJar({ tag, profile, dir, repo = GITHUB_REPO, run = releaseCheck.runGh }) {
  const { release, sumsText } = releaseCheck.readRelease({ tag, repo, run });
  const asset = mod.parseRelease(release, profile);
  const sha256 = asset.sha256 || (sumsText === undefined ? null : mod.sha256For(sumsText, asset.name));
  if (!sha256) throw new Error(`Aucun SHA-256 connu pour ${asset.name} dans la release ${release.tag_name} : jar refusé`);
  fs.mkdirSync(dir, { recursive: true });
  run(['release', 'download', release.tag_name, '--repo', repo, '--pattern', asset.name, '--dir', dir, '--clobber']);
  const file = path.join(dir, asset.name);
  if (!fs.existsSync(file)) throw new Error(`gh n'a pas téléchargé ${asset.name}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`SHA-256 incorrect pour ${asset.name} (reçu ${actual}, attendu ${sha256}) : jar supprimé`);
  }
  return { file, name: asset.name, sha256, tag: release.tag_name, draft: release.draft };
}

/** Options de la ligne de commande : { profile, useRelease, tag, shaders, replay, cycle, optifine, positional }. */
function parseArgs(args) {
  const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const valued = ['--profile', '--optifine', '--tag'];
  const known = new Set([...valued, '--release', '--shaders', '--replay', '--optifine', '--cycle']);
  const unknown = args.find((a) => a.startsWith('--') && !known.has(a));
  if (unknown) throw new Error(`Option inconnue : ${unknown}`);
  for (const name of valued) if (args.includes(name) && (!option(name) || option(name).startsWith('--'))) throw new Error(`${name} attend une valeur`);
  const options = {
    profile: option('--profile') || catalog.DEFAULT_PROFILE_ID,
    useRelease: args.includes('--release'),
    tag: option('--tag'),
    shaders: args.includes('--shaders') || args.includes('--cycle'),
    replay: args.includes('--replay'),
    cycle: args.includes('--cycle'),
    optifine: option('--optifine'),
    positional: args.filter((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1])),
  };
  if (options.useRelease && options.tag) throw new Error('--release et --tag ne vont pas ensemble : --release lit la dernière release publiée, --tag une release précise (brouillon compris)');
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  const profile = catalog.get(parsed.profile);
  const { useRelease, shaders, replay, tag } = parsed;
  const optifineSource = parsed.optifine;
  const positional = parsed.positional;
  const root = path.resolve(positional[0] || path.join(os.tmpdir(), `attack-install-test-${Date.now()}`));
  const real = path.resolve(process.env.APPDATA || '', '.minecraft');
  if (root.toLowerCase().startsWith(real.toLowerCase())) throw new Error('Refus : ce test ne doit pas toucher au vrai .minecraft');
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = gameDirFor(root, profile);
  fs.mkdirSync(minecraftDir, { recursive: true });

  // un profil existant, pour vérifier que la fusion le garde
  const profilesFile = path.join(minecraftDir, 'launcher_profiles.json');
  if (!fs.existsSync(profilesFile)) {
    fs.writeFileSync(profilesFile, JSON.stringify({
      profiles: { autre: { name: 'Autre profil', type: 'custom', lastVersionId: '1.21.4', icon: 'Furnace' } },
      settings: { keepLauncherOpen: true },
      version: 3,
    }, null, 2));
  }

  let devJarDir = defaultDevJarDir(process.env, profile);
  let dummy = false;
  let tagJar = null;
  if (tag) {
    // jar EXACT de la release (brouillon compris), téléchargé avec gh puis installé comme un jar de développeur : jamais celui du build local
    devJarDir = path.join(root, 'tag-jar');
    tagJar = fetchTagJar({ tag, profile, dir: devJarDir });
    console.log(`Jar exact de la release ${tagJar.tag}${tagJar.draft ? ' (brouillon)' : ''} : ${tagJar.name} (SHA-256 ${tagJar.sha256.slice(0, 12)}… vérifié)`);
  } else if (!useRelease && !findDevJar(devJarDir, profile)) {
    if (!allowsDummyJar(profile)) throw new Error(`Aucun ${profile.attackJar.glob} dans ${devJarDir} : compile le mod d'abord`);
    devJarDir = path.join(root, 'dummy-jar');
    makeDummyJar(devJarDir, profile);
    dummy = true;
    console.log(`!!! JAR FACTICE : aucun jar ${profile.attackJar.glob} compilé trouvé, un mod « attack » vide est utilisé pour tester la chaîne !!!`);
  }
  const settings = { ramMb: 3072, gameDir, javaPath: '', lang: 'fr', devMode: !useRelease, devJarDir, shaders, replayMod: replay };
  const cycle = parsed.cycle;
  if (optifineSource) {
    // copie du joueur déposée là où l'installateur d'OptiFine la laisse (libraries/optifine/OptiFine/1.8.9_<variante>/)
    const variant = /1\.8\.9_([\w.+-]+?)\.jar$/i.exec(path.basename(optifineSource))?.[1] || 'HD_U_M5';
    const libDir = path.join(minecraftDir, 'libraries', 'optifine', 'OptiFine', `1.8.9_${variant}`);
    fs.mkdirSync(libDir, { recursive: true });
    fs.copyFileSync(optifineSource, path.join(libDir, `OptiFine-1.8.9_${variant}.jar`));
    console.log(`OptiFine du joueur (test) : ${path.join(libDir, `OptiFine-1.8.9_${variant}.jar`)}`);
  }
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'assets', 'profile-icon.png')).toString('base64')}`;
  console.log(`Profil : ${profile.id} (Minecraft ${profile.mc}, ${profile.loader.type} ${profile.loader.version})`);
  console.log(`Dossier de test : ${root}`);
  const started = Date.now();
  let lastStep = '';
  const run = (s) => installer.install({
    minecraftDir,
    settings: s,
    profile,
    icon,
    onProgress: (p) => {
      if (p.step !== lastStep) {
        lastStep = p.step;
        console.log(`  [${String(p.percent).padStart(5)} %] ${p.step} : ${p.message}`);
      }
    },
  });
  const summary = await run(settings);
  console.log(`Installation terminée en ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // --- contre-vérification indépendante ---
  const failures = [];
  const check = async (file, algorithm, expected, label) => {
    if (!fs.existsSync(file)) return failures.push(`absent : ${label}`);
    const got = await hashFile(file, algorithm);
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(got)) failures.push(`hash faux : ${label}`);
  };
  const mc = profile.mc;
  const versionJson = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'versions', mc, `${mc}.json`), 'utf8'));
  await check(path.join(minecraftDir, 'versions', mc, `${mc}.jar`), 'sha1', versionJson.downloads.client.sha1, 'client.jar');
  const vanillaLibs = mojang.libraryDownloads(versionJson);
  for (const lib of vanillaLibs) await check(path.join(minecraftDir, 'libraries', lib.path), 'sha1', lib.sha1, lib.path);
  const index = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'assets', 'indexes', `${versionJson.assetIndex.id}.json`), 'utf8'));
  const objects = mojang.assetDownloads(index);
  for (const object of objects) await check(path.join(minecraftDir, 'assets', object.path), 'sha1', object.sha1, object.path);

  const vid = profile.loader.versionId;
  const loaderJson = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'versions', vid, `${vid}.json`), 'utf8'));
  for (const lib of loaderJson.libraries) {
    const artifact = lib.downloads.artifact;
    await check(path.join(minecraftDir, 'libraries', artifact.path), 'sha1', artifact.sha1, artifact.path);
  }
  const extra = [];
  if (profile.loader.type === 'forge') {
    if (loaderJson.inheritsFrom !== mc || loaderJson.mainClass !== 'net.minecraft.launchwrapper.Launch') failures.push('JSON Forge inattendu');
    extra.push(await verifyForgeLibraries({ profile, minecraftDir, loaderJson, check, fail: (message) => failures.push(message) }));
  } else {
    if (loaderJson.id !== vid || loaderJson.inheritsFrom !== mc || loaderJson.mainClass !== KNOT_CLIENT) failures.push('JSON Fabric inattendu');
    // contre-vérification SANS le code du launcher : le profil publié par Fabric est relu, SHA-512 puis .sha1 recalculés
    const meta = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${profile.loader.version}/profile/json`)).json();
    let strong = 0;
    for (const lib of meta.libraries) {
      const rel = mavenPath(lib.name);
      const file = path.join(minecraftDir, 'libraries', rel);
      if (lib.sha512) {
        await check(file, 'sha512', lib.sha512, `${lib.name} (SHA-512 publié par Fabric)`);
        strong++;
      } else {
        const sha1 = /\b([0-9a-f]{40})\b/i.exec(await (await fetch(`${lib.url}${rel}.sha1`)).text())?.[1];
        await check(file, 'sha1', sha1 ? sha1.toLowerCase() : 'introuvable', `${lib.name} (.sha1 Maven)`);
      }
    }
    extra.push(`${loaderJson.libraries.length} bibliothèques Fabric (${strong} par SHA-512, ${meta.libraries.length - strong} par .sha1)`);
  }

  // pack de mods : SHA-512 et SHA-1 recalculés depuis le pack figé
  if (profile.pack) {
    const pack = modpack.loadPack(profile);
    const wanted = modpack.selectedMods(pack, installer.packOptions(settings));
    for (const m of wanted) {
      const file = path.join(gameDir, 'mods', m.filename);
      await check(file, 'sha512', m.sha512, `${m.slug} ${m.version} (SHA-512)`);
      if (m.sha1) await check(file, 'sha1', m.sha1, `${m.slug} ${m.version} (SHA-1)`);
    }
    const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'attack-launcher.json'), 'utf8'));
    if (JSON.stringify([...state.pack.managed].sort()) !== JSON.stringify(wanted.map((m) => m.filename).sort())) failures.push('état : liste de jars gérés inattendue');
    const iris = pack.mods.find((m) => m.optional);
    if (iris && fs.existsSync(path.join(gameDir, 'mods', iris.filename)) !== shaders) failures.push(`Iris ${shaders ? 'absent' : 'présent'} alors que les shaders sont ${shaders ? 'activés' : 'coupés'}`);
    extra.push(`pack de ${wanted.length} mods (${wanted.map((m) => `${m.slug} ${m.version}`).join(', ')})`);

    if (cycle) {
      // shaders coupés puis réactivés ; un jar du joueur ne doit jamais être touché
      const own = path.join(gameDir, 'mods', 'mon-mod-perso.jar');
      fs.writeFileSync(own, 'jar du joueur');
      const irisFile = path.join(gameDir, 'mods', iris.filename);
      await run({ ...settings, shaders: false });
      if (fs.existsSync(irisFile)) failures.push('cycle : Iris encore présent après avoir coupé les shaders');
      if (!fs.existsSync(own)) failures.push('cycle : le jar du joueur a été supprimé');
      await run({ ...settings, shaders: true });
      await check(irisFile, 'sha512', iris.sha512, 'cycle : Iris réinstallé');
      if (!fs.existsSync(own)) failures.push('cycle : le jar du joueur a été supprimé (réactivation)');
      fs.rmSync(own, { force: true }); // faux jar : retiré, sinon Fabric refuserait de démarrer le dossier de test
      extra.push('cycle shaders OK (Iris retiré puis remis, jar du joueur intact)');
    }
  }

  // OptiFine du joueur (1.8.9) : copié dans mods, identique à l'original, suivi dans l'état ; sans copie fournie : rien n'est copié
  if (catalog.hasOptifine(profile)) {
    const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'attack-launcher.json'), 'utf8'));
    if (optifineSource) {
      const copy = state.optifine && path.join(gameDir, 'mods', state.optifine.file);
      if (!copy || !fs.existsSync(copy)) failures.push('OptiFine : copie absente de mods');
      else {
        await check(copy, 'sha256', await hashFile(optifineSource, 'sha256'), 'OptiFine copié dans mods (identique à l’original)');
        extra.push(`OptiFine du joueur copié (${state.optifine.file}, source ${state.optifine.source})`);
      }
      if (summary.optifine?.action !== 'copied') failures.push(`OptiFine : action inattendue (${JSON.stringify(summary.optifine)})`);
    } else if (state.optifine || fs.readdirSync(path.join(gameDir, 'mods')).some((f) => /optifine/i.test(f))) {
      failures.push('OptiFine : un jar a été copié alors que le joueur n’en a pas fourni');
    } else {
      extra.push('aucun OptiFine fourni : rien copié, rien téléchargé');
    }
  }
  // options.txt : langue du launcher écrite (fr_FR en 1.8.9, fr_fr en Fabric)
  const optionsText = fs.existsSync(path.join(gameDir, 'options.txt')) ? fs.readFileSync(path.join(gameDir, 'options.txt'), 'latin1') : '';
  const wantedLang = profile.loader.type === 'forge' ? 'lang:fr_FR' : 'lang:fr_fr';
  if (!optionsText.split(/\r?\n/).includes(wantedLang)) failures.push(`options.txt : ${wantedLang} absent`);
  else extra.push(`options.txt (${wantedLang})`);

  // WalksyLib (groupe PvP du pack Fabric) : sa vérification de mises à jour est coupée dans sa configuration de départ
  if (summary.walksylib) {
    const walksy = path.join(gameDir, 'config', 'WalksyLib', 'walksylib.json');
    const value = fs.existsSync(walksy) ? JSON.parse(fs.readFileSync(walksy, 'utf8')).categories?.Appearance?.groups?.Notifications?.options?.['Notify For New Updates'] : undefined;
    if (value !== false) failures.push(`WalksyLib : « Notify For New Updates » devrait être false (lu : ${value})`);
    else extra.push(`WalksyLib sans vérification de mises à jour (${summary.walksylib.action})`);
  }

  const modFile = path.join(gameDir, 'mods', profile.modFile);
  const localJar = findDevJar(settings.devJarDir, profile);
  if (tagJar) {
    // le jar installé est celui de la release, octet pour octet : son SHA-256 est celui que la release annonce
    await check(modFile, 'sha256', tagJar.sha256, `mod (jar exact de la release ${tagJar.tag})`);
    if (localJar.name !== tagJar.name) failures.push(`jar installé inattendu : ${localJar.name} au lieu de ${tagJar.name}`);
  } else if (!useRelease) await check(modFile, 'sha256', await hashFile(localJar.file, 'sha256'), 'mod (copie du build local)');
  else await check(modFile, 'sha256', summary.mod.sha256, 'mod (release)');

  const profilesData = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
  const launcherProfile = profilesData.profiles[profile.launcherProfileId];
  if (!launcherProfile) failures.push('profil ATTACK absent');
  else {
    if (launcherProfile.name !== profile.name) failures.push('profil : mauvais nom');
    if (launcherProfile.lastVersionId !== vid) failures.push('profil : mauvaise version');
    if (launcherProfile.gameDir !== gameDir) failures.push('profil : mauvais gameDir');
    if (!launcherProfile.javaArgs.startsWith('-Xmx3072M ')) failures.push('profil : -Xmx absent');
    if (!launcherProfile.icon.startsWith('data:image/png;base64,')) failures.push('profil : icône absente');
  }
  if (!profilesData.profiles.autre) failures.push('fusion : autre profil perdu');
  if (!fs.existsSync(`${profilesFile}.bak`)) failures.push('sauvegarde .bak absente');

  const status = await installer.status({ minecraftDir, gameDir, profile, shaders: cycle ? true : shaders, replayMod: replay });
  if (!status.installed) failures.push(`status() incomplet : ${JSON.stringify(status)}`);

  console.log(`Vérifié : client.jar, ${vanillaLibs.length} fichiers de bibliothèques Mojang, ${objects.length} assets, ` +
    `${extra.join(', ')}, mod ${profile.modFile} (${summary.mod.source} ${summary.mod.version}${dummy ? ', JAR FACTICE' : ''}, ` +
    `SHA-256 ${summary.mod.sha256.slice(0, 12)}…), profil « ${profile.name} » fusionné + .bak`);
  if (failures.length > 0) {
    console.error(`ÉCHEC (${failures.length}) :\n  ${failures.slice(0, 20).join('\n  ')}`);
    process.exit(1);
  }
  console.log('OK : tous les hash correspondent.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ÉCHEC : ${error.code ? `[${error.code}] ` : ''}${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  gameDirFor, makeDummyFabricJar, makeDummyForgeJar, makeDummyJar, allowsDummyJar, dummyModClass, forgeLibraryExpectations, verifyForgeLibraries, fetchTagJar, parseArgs,
};
