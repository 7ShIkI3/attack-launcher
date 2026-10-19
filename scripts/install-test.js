'use strict';
// Installation réelle complète dans un dossier temporaire (jamais dans le vrai %APPDATA%\.minecraft),
// puis contre-vérification indépendante de tous les hash.
//   node scripts/install-test.js [dossier] [--profile <id>] [--release] [--shaders] [--cycle]
// --profile  forge-1.8.9 (défaut), fabric-1.21.1 ou fabric-26.3
// --release  jar ATTACK depuis la dernière release GitHub (sans : build local, mode développeur)
// --shaders  installe aussi Iris (réglage « Shaders » des profils Fabric)
// --cycle    Fabric : après l'installation, coupe puis réactive les shaders et vérifie qu'Iris est retiré / remis,
//            qu'un jar ajouté à la main n'est jamais touché
// Sans --release, le jar du mod vient du build local. Si le profil Fabric n'a pas encore de jar compilé, un JAR FACTICE
// (mod « attack » vide, créé dans le dossier de test) permet d'essayer tout le reste de la chaîne : c'est dit clairement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/main/catalog');
const installer = require('../src/main/installer');
const mojang = require('../src/main/mojang');
const modpack = require('../src/main/modpack');
const { mavenPath } = require('../src/main/maven');
const { hashFile } = require('../src/main/http');
const { defaultDevJarDir } = require('../src/main/paths');
const { findDevJar } = require('../src/main/mod');
const { KNOT_CLIENT } = require('../src/main/fabric');
const { makeZip } = require('../test/helpers');

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

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const profile = catalog.get(option('--profile') || catalog.DEFAULT_PROFILE_ID);
  const useRelease = args.includes('--release');
  const shaders = args.includes('--shaders') || args.includes('--cycle');
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile');
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
  if (!useRelease && !findDevJar(devJarDir, profile)) {
    if (!catalog.isFabric(profile)) throw new Error(`Aucun ${profile.attackJar.glob} dans ${devJarDir} : compile le mod d'abord`);
    devJarDir = path.join(root, 'dummy-jar');
    makeDummyFabricJar(devJarDir, profile);
    dummy = true;
    console.log('!!! JAR FACTICE : aucun jar attack-fabric compilé trouvé, un mod « attack » vide est utilisé pour tester la chaîne !!!');
  }
  const settings = { ramMb: 3072, gameDir, javaPath: '', lang: 'fr', devMode: !useRelease, devJarDir, shaders };
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
    extra.push(`${loaderJson.libraries.length} bibliothèques Forge`);
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
    const wanted = modpack.selectedMods(pack, { shaders });
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

    if (args.includes('--cycle')) {
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
      extra.push('cycle shaders OK (Iris retiré puis remis, jar du joueur intact)');
    }
  }

  const modFile = path.join(gameDir, 'mods', profile.modFile);
  const localJar = findDevJar(settings.devJarDir, profile);
  if (!useRelease) await check(modFile, 'sha256', await hashFile(localJar.file, 'sha256'), 'mod (copie du build local)');
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

  const status = await installer.status({ minecraftDir, gameDir, profile, shaders: args.includes('--cycle') ? true : shaders });
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

module.exports = { gameDirFor, makeDummyFabricJar };
