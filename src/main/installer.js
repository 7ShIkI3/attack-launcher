'use strict';
// Installation complète d'un profil : Minecraft (JSON, jar, bibliothèques, assets), son chargeur de mods (Forge 1.8.9 ou
// Fabric Loader, sans jamais exécuter d'installateur), le pack de mods Fabric figé, le jar ATTACK dans le dossier de jeu
// séparé du profil, puis le profil du launcher officiel.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const C = require('./constants');
const catalog = require('./catalog');
const http = require('./http');
const mojang = require('./mojang');
const forge = require('./forge');
const fabric = require('./fabric');
const modpack = require('./modpack');
const mod = require('./mod');
const profiles = require('./profiles');
const { mavenPath, safeJoin } = require('./maven');

/** Étapes et poids dans la barre de progression globale, par type de chargeur. */
const STEPS_FORGE = [
  { id: 'minecraft', weight: 8 },
  { id: 'libraries', weight: 10 },
  { id: 'assets', weight: 57 },
  { id: 'forge', weight: 12 },
  { id: 'mod', weight: 8 },
  { id: 'profile', weight: 5 },
];
const STEPS_FABRIC = [
  { id: 'minecraft', weight: 6 },
  { id: 'libraries', weight: 10 },
  { id: 'assets', weight: 55 },
  { id: 'fabric', weight: 6 },
  { id: 'pack', weight: 10 },
  { id: 'mod', weight: 8 },
  { id: 'profile', weight: 5 },
];
/** Étapes du profil historique (Forge 1.8.9). */
const STEPS = STEPS_FORGE;

/** Étapes d'un profil du catalogue. */
function stepsFor(profile) {
  return catalog.isFabric(profile) ? STEPS_FABRIC : STEPS_FORGE;
}

class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Profil du catalogue à partir d'un objet, d'un identifiant, ou du profil historique par défaut. */
function resolveProfile(profile) {
  if (!profile) return catalog.get();
  return typeof profile === 'string' ? catalog.get(profile) : profile;
}

/**
 * Rapporteur de progression : (étape, fait, total, message) -> onProgress({ step, done, total, percent, message }).
 * Une étape hors de la liste (java, auth, launch…) n'est pas une erreur : sa part est calculée sur elle-même.
 */
function progressReporter(onProgress, steps = STEPS) {
  const offsets = {};
  let acc = 0;
  for (const step of steps) {
    offsets[step.id] = acc;
    acc += step.weight;
  }
  return (step, done = 0, total = 1, message = '') => {
    const known = steps.find((s) => s.id === step);
    const ratio = total ? done / total : 1;
    const percent = Math.min(100, known ? offsets[step] + known.weight * ratio : ratio * 100);
    onProgress?.({ step, done, total, percent: Math.round(percent * 10) / 10, message });
  };
}

async function writeIfChanged(file, buffer) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && (await fsp.readFile(file)).equals(buffer)) return;
  await fsp.writeFile(file, buffer);
}

async function sizeOf(file) {
  return (await fsp.stat(file)).size;
}

/** Minecraft vanilla : JSON de version (hash vérifié), jar client, config log4j. Renvoie le JSON. */
async function installMinecraft(mcDir, report, net, mcVersion = C.MC_VERSION) {
  report('minecraft', 0, 3, 'Manifeste Mojang');
  const manifest = await http.fetchJson(C.VERSION_MANIFEST_URL, net);
  const entry = mojang.findVersion(manifest, mcVersion);
  const raw = await http.fetchBuffer(entry.url, { ...net, sha1: entry.sha1 });
  const versionJson = JSON.parse(raw.toString('utf8'));
  await writeIfChanged(safeJoin(mcDir, `versions/${mcVersion}/${mcVersion}.json`), raw);
  report('minecraft', 1, 3, `Jar Minecraft ${mcVersion}`);
  const client = mojang.clientDownload(versionJson);
  await http.downloadFile(client.url, safeJoin(mcDir, client.path), client, net);
  report('minecraft', 2, 3, 'Configuration des journaux');
  const logging = mojang.loggingDownload(versionJson);
  if (logging) await http.downloadFile(logging.url, safeJoin(mcDir, logging.path), logging, net);
  report('minecraft', 3, 3);
  return versionJson;
}

async function installLibraries(mcDir, versionJson, report, net, env) {
  const files = mojang.libraryDownloads(versionJson, env);
  let done = 0;
  report('libraries', 0, files.length, 'Bibliothèques');
  await http.pool(files, net.concurrency, async (file) => {
    await http.downloadFile(file.url, safeJoin(path.join(mcDir, 'libraries'), file.path), file, net);
    report('libraries', ++done, files.length, file.name);
  });
  return files.length;
}

async function installAssets(mcDir, versionJson, report, net) {
  const index = versionJson.assetIndex;
  if (!index || !/^[\w.-]+$/.test(index.id)) throw new Error("Index d'assets absent du JSON de version");
  const raw = await http.fetchBuffer(index.url, { ...net, sha1: index.sha1 });
  await writeIfChanged(safeJoin(mcDir, `assets/indexes/${index.id}.json`), raw);
  const objects = mojang.assetDownloads(JSON.parse(raw.toString('utf8')));
  const assetsDir = path.join(mcDir, 'assets');
  let done = 0;
  let bytes = 0;
  report('assets', 0, objects.length, 'Ressources du jeu');
  await http.pool(objects, net.concurrency, async (object) => {
    const result = await http.downloadFile(object.url, safeJoin(assetsDir, object.path), object, net);
    bytes += result.bytes;
    report('assets', ++done, objects.length, `${(bytes / 1048576).toFixed(1)} Mo téléchargés`);
  });
  return objects.length;
}

/** Hash SHA-1 publié à côté d'un fichier Maven (<url>.sha1). */
async function remoteSha1(url, net) {
  const text = await http.fetchText(`${url}.sha1`, net);
  const match = /\b([0-9a-f]{40})\b/i.exec(text);
  if (!match) throw new Error(`Hash SHA-1 introuvable pour ${url}`);
  return match[1].toLowerCase();
}

async function installForge(mcDir, report, net, profile = catalog.get()) {
  const installerUrl = forge.installerUrl(profile);
  report('forge', 0, 1, 'Installateur Forge (lu comme une archive, jamais exécuté)');
  const installerSha1 = await remoteSha1(installerUrl, net);
  const installer = await http.fetchBuffer(installerUrl, { ...net, sha1: installerSha1 });
  const { install, versionInfo, universal } = forge.readInstallProfile(installer);
  if (versionInfo.id !== profile.loader.versionId) throw new Error(`Version Forge inattendue : ${versionInfo.id}`);

  const librariesDir = path.join(mcDir, 'libraries');
  const resolved = new Map();
  const forgePath = mavenPath(install.path);
  await writeIfChanged(safeJoin(librariesDir, forgePath), universal);
  resolved.set(install.path, { path: forgePath, url: '', sha1: http.hashBuffer(universal), size: universal.length });

  const plans = forge.clientLibraries(versionInfo)
    .map((lib) => forge.libraryPlan(lib, install.path))
    .filter((plan) => !plan.forge);
  let done = 0;
  report('forge', 0, plans.length, 'Bibliothèques Forge');
  await http.pool(plans, net.concurrency, async (plan) => {
    const sha1s = plan.sha1s.length > 0 ? plan.sha1s : [await remoteSha1(plan.url, net)];
    const dest = safeJoin(librariesDir, plan.path);
    const result = await http.downloadFile(plan.url, dest, { sha1s }, net);
    resolved.set(plan.name, { path: plan.path, url: plan.url, sha1: result.sha1, size: await sizeOf(dest) });
    report('forge', ++done, plans.length, plan.name);
  });

  const versionDir = `versions/${profile.loader.versionId}/${profile.loader.versionId}.json`;
  const json = forge.buildVersionJson(versionInfo, resolved);
  await writeIfChanged(safeJoin(mcDir, versionDir), Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  return { libraries: resolved.size, universalSha1: resolved.get(install.path).sha1 };
}

/**
 * Fabric Loader : profil de version de meta.fabricmc.net (validé strictement), puis ses bibliothèques depuis
 * maven.fabricmc.net / libraries.minecraft.net. Chaque jar est vérifié par le hash le plus fort publié (SHA-512,
 * sinon SHA-1) ; fabric-loader et intermediary n'en portent pas dans le profil : on prend le .sha1 à côté du jar.
 */
async function installFabric(mcDir, profile, report, net) {
  report('fabric', 0, 1, `Fabric Loader ${profile.loader.version}`);
  const raw = await http.fetchBuffer(fabric.profileUrl(profile.mc, profile.loader.version), net);
  const parsed = fabric.parseProfile(raw, profile);
  const plans = parsed.libraries.map(fabric.libraryPlan);

  const librariesDir = path.join(mcDir, 'libraries');
  const resolved = new Map();
  let done = 0;
  report('fabric', 0, plans.length, 'Bibliothèques Fabric');
  await http.pool(plans, net.concurrency, async (plan) => {
    const dest = safeJoin(librariesDir, plan.path);
    // hash du profil Fabric, sinon SHA-1 figé dans le catalogue, sinon celui publié à côté du jar
    const expect = Object.keys(plan.hashes).length > 0 ? { ...plan.hashes }
      : { sha1: profile.loader.pinnedSha1?.[plan.name] || await remoteSha1(plan.url, net) };
    await http.downloadFile(plan.url, dest, expect, net);
    const sha1 = await http.hashFile(dest, 'sha1');
    if (plan.hashes.sha1 && plan.hashes.sha1 !== sha1) throw new Error(`SHA-1 incorrect pour ${plan.name}`);
    resolved.set(plan.name, { path: plan.path, url: plan.url, sha1, size: await sizeOf(dest) });
    report('fabric', ++done, plans.length, plan.name);
  });

  const versionId = profile.loader.versionId;
  const json = fabric.buildVersionJson(parsed, resolved);
  await writeIfChanged(safeJoin(mcDir, `versions/${versionId}/${versionId}.json`), Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  return { libraries: resolved.size };
}

/** État enregistré dans le dossier de jeu (attack-launcher.json) ; null s'il manque ou s'il est illisible. */
async function readState(gameDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(gameDir, C.STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Écriture atomique (fichier temporaire puis renommage) : un état tronqué ferait oublier les jars du pack à retirer. */
async function writeState(gameDir, state) {
  await fsp.mkdir(gameDir, { recursive: true });
  const file = path.join(gameDir, C.STATE_FILE);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

/**
 * Pack de mods du profil : télécharge les jars figés, supprime ceux d'un ancien pack qui n'en font plus partie
 * (jamais un jar ajouté par le joueur) et garde la liste dans l'état.
 */
async function installPack(gameDir, profile, settings, report, net, pack = modpack.loadPack(profile)) {
  const previous = await readState(gameDir);
  const result = await modpack.installPack(gameDir, pack, {
    shaders: Boolean(settings.shaders),
    previousManaged: previous?.pack?.managed || [],
    protectedNames: [profile.modFile],
    net,
    report,
  });
  const info = { id: pack.profileId, shaders: Boolean(settings.shaders), managed: result.managed, mods: result.mods };
  // enregistré tout de suite : si la suite échoue, la liste des jars gérés reste exacte
  await writeState(gameDir, { ...(previous || {}), pack: info });
  if (result.removeFailed.length > 0) {
    throw new InstallError('PACK_CLEANUP', `Impossible de retirer un ancien mod du pack (${result.removeFailed.join(', ')}) : ferme le jeu puis relance l'installation.`);
  }
  report('pack', result.mods.length, result.mods.length);
  return { ...result, info };
}

/**
 * Jar ATTACK -> <gameDir>/mods/<profile.modFile>, depuis la release GitHub (jar du profil, choisi par sa règle exacte)
 * ou le build local (mode développeur).
 */
async function installMod(gameDir, settings, report, net, profile = catalog.get()) {
  const dest = path.join(gameDir, 'mods', profile.modFile);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let info;
  if (settings.devMode) {
    report('mod', 0, 1, 'Copie du jar local (mode développeur)');
    const jar = mod.findDevJar(settings.devJarDir, profile);
    if (!jar) throw new InstallError('NO_DEV_JAR', `Aucun ${profile.attackJar.glob} dans ${settings.devJarDir}`);
    await fsp.copyFile(jar.file, `${dest}.part`);
    await fsp.rename(`${dest}.part`, dest);
    info = { source: 'dev', version: mod.versionFromJarName(jar.name, profile), file: jar.file };
  } else {
    report('mod', 0, 1, 'Dernière release GitHub');
    let release;
    try {
      release = await http.fetchJson(C.GITHUB_LATEST_RELEASE, { ...net, headers: { Accept: 'application/vnd.github+json' } });
    } catch (error) {
      if (error.status === 404) {
        throw new InstallError('NO_RELEASE', "Aucune release d'ATTACK Client n'est encore publiée sur GitHub.");
      }
      throw error;
    }
    let asset;
    try {
      asset = mod.parseRelease(release, profile);
    } catch (error) {
      if (error.code === 'NO_JAR') throw new InstallError('NO_PROFILE_JAR', error.message);
      throw error;
    }
    const sha256 = asset.sha256 || mod.sha256For(await http.fetchText(asset.sha256Url, net), asset.name);
    await http.downloadFile(asset.url, dest, { sha256, size: asset.size }, net);
    info = { source: 'release', version: asset.version, file: asset.url };
  }
  info.sha256 = await http.hashFile(dest, 'sha256');
  report('mod', 1, 1);
  return info;
}

async function installProfile(mcDir, gameDir, settings, icon, report, profile = catalog.get()) {
  report('profile', 0, 1, 'Profil du launcher officiel');
  await profiles.updateProfiles(mcDir, (data) =>
    profiles.mergeProfile(data, { ...profiles.identityOf(profile), gameDir, ramMb: settings.ramMb, javaPath: settings.javaPath, icon }));
  report('profile', 1, 1);
}

/**
 * Installation complète. options : { minecraftDir, settings, profile, icon, onProgress, concurrency, allowedHosts, env }.
 * `profile` : entrée du catalogue ou son identifiant (Forge 1.8.9 par défaut). `settings` : réglages effectifs du profil
 * (gameDir, javaPath, ramMb, devMode, devJarDir, shaders). Renvoie un résumé.
 */
async function install(options) {
  const { minecraftDir, settings, icon, onProgress, env = mojang.currentEnv() } = options;
  const profile = resolveProfile(options.profile);
  const net = { concurrency: options.concurrency || 8, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) };
  const report = progressReporter(onProgress, stepsFor(profile));
  const gameDir = settings.gameDir;
  await fsp.mkdir(gameDir, { recursive: true });

  const versionJson = await installMinecraft(minecraftDir, report, net, profile.mc);
  const libraries = await installLibraries(minecraftDir, versionJson, report, net, env);
  const assets = await installAssets(minecraftDir, versionJson, report, net);
  let loaderLibraries;
  let packResult = null;
  if (catalog.isFabric(profile)) {
    loaderLibraries = (await installFabric(minecraftDir, profile, report, net)).libraries;
    packResult = await installPack(gameDir, profile, settings, report, net);
  } else {
    loaderLibraries = (await installForge(minecraftDir, report, net, profile)).libraries;
  }
  const modInfo = await installMod(gameDir, settings, report, net, profile);
  await installProfile(minecraftDir, gameDir, settings, icon, report, profile);

  const previous = await readState(gameDir);
  const state = {
    ...(previous || {}),
    profileId: profile.id,
    minecraft: profile.mc,
    loader: profile.loader.versionId,
    mod: modInfo,
    installedAt: new Date().toISOString(),
  };
  if (profile.loader.type === 'forge') state.forge = profile.loader.versionId;
  if (packResult) state.pack = packResult.info;
  await writeState(gameDir, state);
  return {
    ...state,
    libraries,
    assets,
    loaderLibraries,
    forgeLibraries: profile.loader.type === 'forge' ? loaderLibraries : undefined,
    pack: packResult ? { ...packResult.info, downloaded: packResult.downloaded, skipped: packResult.skipped, removed: packResult.removed } : undefined,
  };
}

/** Le pack du profil est-il complet dans le dossier de jeu ? (fichiers présents, taille exacte ; pas de jar en trop) */
async function packStatus(gameDir, profile, shaders, state) {
  let pack;
  try {
    pack = modpack.loadPack(profile);
  } catch {
    return false;
  }
  const selected = modpack.selectedMods(pack, { shaders });
  const wanted = new Set(selected.map((m) => m.filename));
  for (const m of selected) {
    try {
      if ((await fsp.stat(path.join(gameDir, 'mods', m.filename))).size !== m.size) return false;
    } catch {
      return false;
    }
  }
  // un mod optionnel désactivé depuis (Iris) mais encore installé : le pack est à mettre à jour
  return !(state?.pack?.managed || []).some((name) => !wanted.has(name) && fs.existsSync(path.join(gameDir, 'mods', name)));
}

/** État rapide (présence des fichiers, sans hash) pour l'écran d'accueil. `profile` : catalogue, Forge 1.8.9 par défaut. */
async function status({ minecraftDir, gameDir, profile: profileOption, shaders = false }) {
  const profile = resolveProfile(profileOption);
  const has = (...parts) => fs.existsSync(path.join(...parts));
  const mc = profile.mc;
  const vid = profile.loader.versionId;
  let launcherProfile = false;
  let profileError = null;
  try {
    launcherProfile = Boolean((await profiles.readProfiles(minecraftDir))?.profiles?.[profile.launcherProfileId]);
  } catch (error) {
    profileError = error.message;
  }
  const state = await readState(gameDir);
  let assetIndex = null;
  try {
    assetIndex = JSON.parse(await fsp.readFile(path.join(minecraftDir, 'versions', mc, `${mc}.json`), 'utf8')).assetIndex?.id || null;
  } catch {
    assetIndex = null;
  }
  const loaderLibrary = profile.loader.type === 'forge'
    ? mavenPath(`net.minecraftforge:forge:${profile.loader.fullVersion}`)
    : mavenPath(`net.fabricmc:fabric-loader:${profile.loader.version}`);
  const result = {
    profileId: profile.id,
    minecraft: has(minecraftDir, 'versions', mc, `${mc}.json`) && has(minecraftDir, 'versions', mc, `${mc}.jar`)
      && Boolean(assetIndex) && /^[\w.-]+$/.test(assetIndex) && has(minecraftDir, 'assets', 'indexes', `${assetIndex}.json`),
    loader: has(minecraftDir, 'versions', vid, `${vid}.json`) && has(minecraftDir, 'libraries', ...loaderLibrary.split('/')),
    pack: profile.pack ? await packStatus(gameDir, profile, shaders, state) : null,
    mod: has(gameDir, 'mods', profile.modFile),
    profile: launcherProfile,
    profileError,
    modVersion: mod.installedVersion(state?.mod),
    modSource: state?.mod?.source || null,
    installedAt: state?.installedAt || null,
  };
  // nom historique du chargeur (forge / fabric) à côté de `loader`
  result[profile.loader.type] = result.loader;
  result.installed = result.minecraft && result.loader && result.pack !== false && result.mod && result.profile;
  return result;
}

module.exports = {
  STEPS, STEPS_FORGE, STEPS_FABRIC, stepsFor, InstallError, install, status, progressReporter,
  installMinecraft, installForge, installFabric, installPack, installMod, readState,
};
