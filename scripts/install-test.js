'use strict';
// Installation réelle complète dans un dossier temporaire (jamais dans le vrai %APPDATA%\.minecraft),
// puis contre-vérification indépendante de tous les hash.
//   node scripts/install-test.js [dossier] [--release]
// Sans --release, le jar du mod vient du build local (mode développeur), faute de release publiée.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/main/constants');
const installer = require('../src/main/installer');
const mojang = require('../src/main/mojang');
const { hashFile } = require('../src/main/http');
const { defaultDevJarDir } = require('../src/main/paths');
const { findDevJar } = require('../src/main/mod');

async function main() {
  const args = process.argv.slice(2);
  const useRelease = args.includes('--release');
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), `attack-install-test-${Date.now()}`));
  const real = path.resolve(process.env.APPDATA || '', '.minecraft');
  if (root.toLowerCase().startsWith(real.toLowerCase())) throw new Error('Refus : ce test ne doit pas toucher au vrai .minecraft');
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = path.join(root, '.attack');
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

  const settings = { ramMb: 3072, gameDir, javaPath: '', lang: 'fr', devMode: !useRelease, devJarDir: defaultDevJarDir() };
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'assets', 'profile-icon.png')).toString('base64')}`;
  console.log(`Dossier de test : ${root}`);
  const started = Date.now();
  let lastStep = '';
  const summary = await installer.install({
    minecraftDir,
    settings,
    icon,
    onProgress: (p) => {
      if (p.step !== lastStep) {
        lastStep = p.step;
        console.log(`  [${String(p.percent).padStart(5)} %] ${p.step} : ${p.message}`);
      }
    },
  });
  console.log(`Installation terminée en ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // --- contre-vérification indépendante ---
  const failures = [];
  const check = async (file, algorithm, expected, label) => {
    if (!fs.existsSync(file)) return failures.push(`absent : ${label}`);
    const got = await hashFile(file, algorithm);
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(got)) failures.push(`hash faux : ${label}`);
  };
  const versionJson = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'versions', C.MC_VERSION, `${C.MC_VERSION}.json`), 'utf8'));
  await check(path.join(minecraftDir, 'versions', C.MC_VERSION, `${C.MC_VERSION}.jar`), 'sha1', versionJson.downloads.client.sha1, 'client.jar');
  const vanillaLibs = mojang.libraryDownloads(versionJson);
  for (const lib of vanillaLibs) await check(path.join(minecraftDir, 'libraries', lib.path), 'sha1', lib.sha1, lib.path);
  const index = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'assets', 'indexes', `${versionJson.assetIndex.id}.json`), 'utf8'));
  const objects = mojang.assetDownloads(index);
  for (const object of objects) await check(path.join(minecraftDir, 'assets', object.path), 'sha1', object.sha1, object.path);
  const forgeJson = JSON.parse(fs.readFileSync(path.join(minecraftDir, 'versions', C.FORGE_VERSION_ID, `${C.FORGE_VERSION_ID}.json`), 'utf8'));
  for (const lib of forgeJson.libraries) {
    const artifact = lib.downloads.artifact;
    await check(path.join(minecraftDir, 'libraries', artifact.path), 'sha1', artifact.sha1, artifact.path);
  }
  if (forgeJson.inheritsFrom !== C.MC_VERSION || forgeJson.mainClass !== 'net.minecraft.launchwrapper.Launch') {
    failures.push('JSON Forge inattendu');
  }
  const modFile = path.join(gameDir, 'mods', C.MOD_FILE);
  if (!useRelease) await check(modFile, 'sha256', await hashFile(findDevJar(settings.devJarDir).file, 'sha256'), 'mod (copie du build local)');
  else await check(modFile, 'sha256', summary.mod.sha256, 'mod (release)');

  const profilesData = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
  const profile = profilesData.profiles[C.PROFILE_ID];
  if (!profile) failures.push('profil ATTACK absent');
  else {
    if (profile.lastVersionId !== C.FORGE_VERSION_ID) failures.push('profil : mauvaise version');
    if (profile.gameDir !== gameDir) failures.push('profil : mauvais gameDir');
    if (!profile.javaArgs.startsWith('-Xmx3072M ')) failures.push('profil : -Xmx absent');
    if (!profile.icon.startsWith('data:image/png;base64,')) failures.push('profil : icône absente');
  }
  if (!profilesData.profiles.autre) failures.push('fusion : autre profil perdu');
  if (!fs.existsSync(`${profilesFile}.bak`)) failures.push('sauvegarde .bak absente');

  const status = await installer.status({ minecraftDir, gameDir });
  if (!status.installed) failures.push(`status() incomplet : ${JSON.stringify(status)}`);

  console.log(`Vérifié : client.jar, ${vanillaLibs.length} fichiers de bibliothèques Mojang, ${objects.length} assets, ` +
    `${forgeJson.libraries.length} bibliothèques Forge, mod (${summary.mod.source} ${summary.mod.version}, ` +
    `SHA-256 ${summary.mod.sha256.slice(0, 12)}…), profil fusionné + .bak`);
  if (failures.length > 0) {
    console.error(`ÉCHEC (${failures.length}) :\n  ${failures.slice(0, 20).join('\n  ')}`);
    process.exit(1);
  }
  console.log('OK : tous les hash correspondent.');
}

main().catch((error) => {
  console.error(`ÉCHEC : ${error.code ? `[${error.code}] ` : ''}${error.message}`);
  process.exit(1);
});
