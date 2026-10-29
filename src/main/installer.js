'use strict';
// Installation complète d'un profil : Minecraft (JSON, jar, bibliothèques, assets), son chargeur de mods (Forge 1.8.9 ou
// Fabric Loader, sans jamais exécuter d'installateur), le pack de mods figé du profil, la copie d'OptiFine du joueur (1.8.9)
// et les réglages de départ d'options.txt (vidéo en Fabric, langue partout), le jar
// ATTACK dans le dossier de jeu séparé du profil, puis le profil du launcher officiel.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const C = require('./constants');
const catalog = require('./catalog');
const http = require('./http');
const mojang = require('./mojang');
const forge = require('./forge');
const fabric = require('./fabric');
const gameoptions = require('./gameoptions');
const modpack = require('./modpack');
const optifine = require('./optifine');
const mod = require('./mod');
const profiles = require('./profiles');
const { mavenPath, safeJoin } = require('./maven');

/** Étapes et poids dans la barre de progression globale, par type de chargeur. */
const STEPS_FORGE = [
  { id: 'minecraft', weight: 8 },
  { id: 'libraries', weight: 10 },
  { id: 'assets', weight: 53 },
  { id: 'forge', weight: 12 },
  { id: 'pack', weight: 4 },
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
  // atomique : un JSON de version tronqué (coupure pendant l'écriture) serait vu comme installé mais empêcherait de jouer
  await http.writeFileAtomic(file, buffer);
}

/** Vrai si `file` existe et contient un JSON lisible. */
async function isJsonFile(file) {
  try {
    JSON.parse(await fsp.readFile(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
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
 * sinon SHA-1) ; fabric-loader et intermediary n'en portent pas dans le profil : on prend le SHA-1 figé du catalogue, à
 * défaut le .sha1 à côté du jar. Un SHA-1 figé est toujours vérifié, même quand le profil Fabric publie un autre hash.
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
    // SHA-1 figé dans le catalogue : il fait toujours foi, même si le profil Fabric publie lui aussi un hash
    const pinned = profile.loader.pinnedSha1?.[plan.name];
    if (pinned && plan.hashes.sha1 && plan.hashes.sha1 !== pinned) throw new Error(`SHA-1 du profil Fabric différent du SHA-1 figé pour ${plan.name}`);
    // hash du profil Fabric, sinon SHA-1 figé dans le catalogue, sinon celui publié à côté du jar
    const expect = Object.keys(plan.hashes).length > 0 ? { ...plan.hashes }
      : { sha1: pinned || await remoteSha1(plan.url, net) };
    await http.downloadFile(plan.url, dest, expect, net);
    const sha1 = await http.hashFile(dest, 'sha1');
    if (plan.hashes.sha1 && plan.hashes.sha1 !== sha1) throw new Error(`SHA-1 incorrect pour ${plan.name}`);
    if (pinned && pinned !== sha1) {
      await fsp.rm(dest, { force: true }); // le hash du profil Fabric (SHA-512, SHA-256) désignait un autre jar que celui figé
      throw new Error(`SHA-1 incorrect pour ${plan.name} (SHA-1 figé du catalogue : ${pinned})`);
    }
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
  await http.renameRetry(tmp, file);
}

/**
 * Groupes du pack voulus par les réglages d'un profil : { shaders, pvp, optifine, replay } (pvp et optifine activés par
 * défaut, replay coupé). Seuls les groupes que le pack contient comptent.
 */
function packOptions(settings = {}) {
  return {
    shaders: Boolean(settings.shaders),
    pvp: settings.pvpMods !== false,
    optifine: settings.optifinePacks !== false,
    replay: Boolean(settings.replayMod),
  };
}

/**
 * Pack de mods du profil : télécharge les jars figés, supprime ceux d'un ancien pack qui n'en font plus partie
 * (jamais un jar ajouté par le joueur) et garde la liste dans l'état.
 */
async function installPack(gameDir, profile, settings, report, net, pack = modpack.loadPack(profile)) {
  const previous = await readState(gameDir);
  const options = packOptions(settings);
  const result = await modpack.installPack(gameDir, pack, {
    ...options,
    previousManaged: previous?.pack?.managed || [],
    protectedNames: [profile.modFile],
    net,
    report,
  });
  const info = {
    id: pack.profileId, shaders: options.shaders, pvpMods: options.pvp, optifinePacks: options.optifine, replayMod: options.replay,
    managed: result.managed, mods: result.mods,
  };
  // enregistré tout de suite : si la suite échoue, la liste des jars gérés reste exacte
  await writeState(gameDir, { ...(previous || {}), pack: info });
  if (result.removeFailed.length > 0) {
    throw new InstallError('PACK_CLEANUP', `Impossible de retirer un ancien mod du pack (${result.removeFailed.join(', ')}) : ferme le jeu puis relance l'installation.`);
  }
  report('pack', result.mods.length, result.mods.length);
  return { ...result, info };
}

/** Ajoute une ligne à <gameDir>/logs/launcher/install.log (le dossier des journaux de la page Réglages) ; sans effet si c'est impossible. */
async function journal(gameDir, message) {
  try {
    const dir = path.join(gameDir, 'logs', 'launcher');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, 'install.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // journal indisponible : l'installation continue
  }
}

/**
 * Réglages de départ d'options.txt (voir gameoptions.js), par étapes : 1 = vidéo (profils Fabric), 2 = langue du launcher (tous
 * les profils). Chaque étape est appliquée une seule fois par dossier de jeu : le drapeau `gameOptions` du fichier d'état garde la
 * dernière faite (un dossier déjà à 1 ne refait pas l'étape 1). Un échec (fichier illisible ou verrouillé) est journalisé sans faire
 * échouer l'installation ; le drapeau n'est alors pas posé et la prochaine installation réessaie.
 * `profile` : entrée du catalogue (Fabric = étape vidéo ; Forge 1.8.9 = langue en écriture « fr_FR »), Fabric par défaut ;
 * `lang` : langue du launcher ('fr' | 'en').
 * Renvoie { action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'error', changed, error? }.
 */
async function installGameOptions(gameDir, profile = null, lang = null) {
  try {
    const state = await readState(gameDir);
    if (state?.gameOptions >= gameoptions.VERSION) return { action: 'skipped', changed: [] };
    const fabric = !profile || catalog.isFabric(profile);
    const result = await gameoptions.apply(gameDir, { from: Number(state?.gameOptions) || 0, video: fabric, lang, legacy: !fabric });
    if (result.action === 'error') {
      await journal(gameDir, `options.txt : réglages de départ non appliqués (${result.error})`);
      return result;
    }
    await writeState(gameDir, { ...(state || {}), gameOptions: gameoptions.VERSION });
    if (result.changed.length > 0) await journal(gameDir, `options.txt : réglages de départ appliqués (${result.action} : ${result.changed.join(', ')})`);
    return result;
  } catch (error) {
    await journal(gameDir, `options.txt : réglages de départ non appliqués (${error.message})`);
    return { action: 'error', changed: [], error: error.message };
  }
}

/**
 * OptiFine (profil 1.8.9) : copie dans <gameDir>/mods la copie d'OptiFine que le joueur possède déjà (jamais téléchargée), ou
 * retire celle que le launcher y avait copiée quand l'option est coupée (voir optifine.js). Le jar copié est suivi dans l'état
 * (`optifine`). Un échec est journalisé sans faire échouer l'installation (le jeu marche sans OptiFine) : l'état n'est pas
 * modifié et la prochaine installation réessaie.
 * Renvoie { action: 'copied' | 'kept' | 'removed' | 'own' | 'missing' | 'disabled' | 'error', name?, source?, error? }.
 */
async function installOptifine(gameDir, minecraftDir, settings = {}) {
  try {
    const state = await readState(gameDir);
    const result = await optifine.apply({
      minecraftDir,
      gameDir,
      enabled: settings.optifine !== false,
      chosen: settings.optifineJar || '',
      tracked: state?.optifine || null,
    });
    const next = { ...(state || {}) };
    if (result.info) next.optifine = result.info;
    else delete next.optifine;
    if (JSON.stringify(next.optifine) !== JSON.stringify(state?.optifine)) await writeState(gameDir, next);
    if (result.action === 'copied') await journal(gameDir, `OptiFine : copie de ${result.info.file} (${result.info.source}) dans mods`);
    else if (result.action === 'removed') await journal(gameDir, 'OptiFine : copie retirée de mods (option coupée ou OptiFine du joueur déjà présent)');
    return { action: result.action, name: result.info?.file || result.view.name, source: result.view.source };
  } catch (error) {
    await journal(gameDir, `OptiFine : non appliqué (${error.message})`);
    return { action: 'error', error: error.message };
  }
}

/**
 * Configuration que WalksyLib lit à son premier démarrage (config/WalksyLib/walksylib.json, format 2) : sa vérification de mises à
 * jour (« Notify For New Updates », Appearance > Notifications) est coupée. Sans cela, WalksyLib interroge api.modrinth.com au
 * démarrage avec l'empreinte de chaque mod, puis propose d'installer des jars dans mods : le pack est figé, vérifié par SHA-512,
 * et un jar ajouté à côté ferait deux versions du même mod. Le joueur peut la rallumer dans l'écran de réglages de WalksyLib.
 * Vérifié avec WalksyLib 2.0.4 en 26.3 (le mod relit ce fichier au premier démarrage et en tire son fichier partagé).
 */
const WALKSYLIB_CONFIG = { format: 2, categories: { Appearance: { groups: { Notifications: { options: { 'Notify For New Updates': false } } } } } };

/**
 * Écrit la configuration de WalksyLib UNE SEULE FOIS par dossier de jeu (drapeau `walksylibConfig` de l'état), et seulement si le
 * fichier n'existe pas : un fichier déjà là, le choix du joueur, n'est jamais modifié. Un échec est journalisé sans faire échouer
 * l'installation. Renvoie { action: 'written' | 'exists' | 'skipped' | 'error', error? }.
 */
async function installWalksyLibConfig(gameDir) {
  try {
    const state = await readState(gameDir);
    if (state?.walksylibConfig) return { action: 'skipped' };
    const file = path.join(gameDir, 'config', 'WalksyLib', 'walksylib.json');
    let action = 'exists';
    if (!fs.existsSync(file)) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await http.writeFileAtomic(file, Buffer.from(`${JSON.stringify(WALKSYLIB_CONFIG, null, 2)}\n`));
      action = 'written';
      await journal(gameDir, 'WalksyLib : vérification de mises à jour coupée (config/WalksyLib/walksylib.json)');
    }
    await writeState(gameDir, { ...(state || {}), walksylibConfig: true });
    return { action };
  } catch (error) {
    await journal(gameDir, `WalksyLib : configuration non écrite (${error.message})`);
    return { action: 'error', error: error.message };
  }
}

/**
 * Jar ATTACK -> <gameDir>/mods/<profile.modFile>, depuis la release GitHub (jar du profil, choisi par sa règle exacte)
 * ou le build local (mode développeur). `appVersion` : version du launcher ; une préversion (0.5.0-beta.1) prend la
 * dernière release publiée, préversion comprise, au lieu de la dernière release stable.
 */
async function installMod(gameDir, settings, report, net, profile = catalog.get(), appVersion) {
  const dest = path.join(gameDir, 'mods', profile.modFile);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let info;
  if (settings.devMode) {
    report('mod', 0, 1, 'Copie du jar local (mode développeur)');
    const jar = mod.findDevJar(settings.devJarDir, profile);
    if (!jar) throw new InstallError('NO_DEV_JAR', `Aucun ${profile.attackJar.glob} dans ${settings.devJarDir}`);
    await fsp.copyFile(jar.file, `${dest}.part`);
    await http.renameRetry(`${dest}.part`, dest);
    info = { source: 'dev', version: mod.versionFromJarName(jar.name, profile), file: jar.file };
  } else {
    report('mod', 0, 1, 'Dernière release GitHub');
    let release;
    try {
      release = await mod.fetchRelease(appVersion, (url) => http.fetchJson(url, { ...net, headers: { Accept: 'application/vnd.github+json' } }));
    } catch (error) {
      if (error.status === 404 || error.code === 'NO_RELEASE') {
        throw new InstallError('NO_RELEASE', "Aucune release d'ATTACK Client n'est encore publiée sur GitHub.");
      }
      if (error.rateLimited) {
        const minutes = error.retryAfterMs ? Math.max(1, Math.ceil(error.retryAfterMs / 60000)) : 60;
        throw new InstallError('GITHUB_RATE_LIMIT', `GitHub limite les requêtes depuis ta connexion : réessaie dans ${minutes} min.`);
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
    info = { source: 'release', version: asset.version, file: asset.url, name: asset.name };
  }
  info.sha256 = await http.hashFile(dest, 'sha256');
  report('mod', 1, 1);
  return info;
}

async function installProfile(mcDir, gameDir, settings, icon, report, profile = catalog.get()) {
  report('profile', 0, 1, 'Profil du launcher officiel');
  await profiles.updateProfiles(mcDir, (data) =>
    profiles.mergeProfile(data, { ...profiles.identityOf(profile), gameDir, ramMb: settings.ramMb, javaPath: settings.javaPath, jvmArgs: settings.jvmArgs, icon }));
  report('profile', 1, 1);
}

/**
 * L'état lu dans un dossier de jeu désigne-t-il un autre profil que `profile` ? Un état sans profileId (ancien launcher,
 * installation interrompue) se reconnaît à ses champs : `pack.id` est l'identifiant du profil qui a posé le pack (Forge 1.8.9
 * comme Fabric), `forge` vient du profil 1.8.9 ; un `pack` sans identifiant date d'avant les packs Forge : il vient d'un profil Fabric.
 */
function gameDirConflict(state, profile) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.profileId === 'string') return state.profileId !== profile.id;
  const pack = state.pack && typeof state.pack === 'object' ? state.pack : null;
  if (pack && typeof pack.id === 'string' && pack.id !== '') return pack.id !== profile.id;
  if (state.forge) return profile.loader.type !== 'forge';
  if (pack) return !catalog.isFabric(profile);
  return false;
}

/**
 * Installation complète. options : { minecraftDir, settings, profile, icon, onProgress, concurrency, allowedHosts, env, appVersion }.
 * `profile` : entrée du catalogue ou son identifiant (Forge 1.8.9 par défaut). `settings` : réglages effectifs du profil
 * (gameDir, javaPath, ramMb, devMode, devJarDir, shaders, pvpMods). Renvoie un résumé.
 */
async function install(options) {
  const { minecraftDir, settings, icon, onProgress, env = mojang.currentEnv() } = options;
  const profile = resolveProfile(options.profile);
  const net = { concurrency: options.concurrency || 8, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) };
  const report = progressReporter(onProgress, stepsFor(profile));
  const gameDir = settings.gameDir;
  // deux profils dans le même dossier se marcheraient dessus (mods, pack, état) : on s'arrête avant de toucher à quoi que ce soit
  if (gameDirConflict(await readState(gameDir), profile)) {
    throw new InstallError('GAMEDIR_IN_USE', 'Ce dossier de jeu est déjà utilisé par un autre profil. Choisis un autre dossier dans Réglages.');
  }
  await fsp.mkdir(gameDir, { recursive: true });

  const versionJson = await installMinecraft(minecraftDir, report, net, profile.mc);
  const libraries = await installLibraries(minecraftDir, versionJson, report, net, env);
  const assets = await installAssets(minecraftDir, versionJson, report, net);
  let loaderLibraries;
  let optifineResult;
  if (catalog.isFabric(profile)) {
    loaderLibraries = (await installFabric(minecraftDir, profile, report, net)).libraries;
  } else {
    loaderLibraries = (await installForge(minecraftDir, report, net, profile)).libraries;
  }
  // pack de mods du profil (Fabric comme Forge 1.8.9), puis OptiFine du joueur (1.8.9) et réglages de départ d'options.txt
  const packResult = profile.pack ? await installPack(gameDir, profile, settings, report, net) : null;
  // WalksyLib (groupe PvP) : sa vérification de mises à jour est coupée avant son premier démarrage
  const walksylib = packResult?.info.mods.some((m) => m.slug === 'walksylib') ? await installWalksyLibConfig(gameDir) : undefined;
  if (catalog.hasOptifine(profile)) optifineResult = await installOptifine(gameDir, minecraftDir, settings);
  const gameOptions = await installGameOptions(gameDir, profile, settings.lang);
  const modInfo = await installMod(gameDir, settings, report, net, profile, options.appVersion);
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
    optifine: optifineResult,
    walksylib,
    gameOptions,
  };
}

/** Le jar du pack est-il dans le dossier mods avec la taille exacte ? */
async function modPresent(gameDir, m) {
  try {
    return (await fsp.stat(path.join(gameDir, 'mods', m.filename))).size === m.size;
  } catch {
    return false;
  }
}

/**
 * Le pack du profil est-il complet dans le dossier de jeu ? (fichiers présents, taille exacte ; pas de jar en trop)
 * `options` : { shaders, pvp, optifine, replay } (voir packOptions).
 * Renvoie { complete, groups } ; `groups` donne, pour chaque groupe (shaders = mods optionnels, pvp, optifine, replay), le nombre de
 * mods du pack et combien sont présents : la page en déduit « appliqué » ou « à appliquer » pour chaque réglage.
 */
async function packStatus(gameDir, profile, options, state) {
  let pack;
  try {
    pack = modpack.loadPack(profile);
  } catch {
    return { complete: false, groups: null };
  }
  const groups = {};
  for (const m of pack.mods) {
    const name = m.optional ? 'shaders' : m.group;
    if (!name) continue;
    groups[name] ||= { total: 0, present: 0 };
    groups[name].total++;
    if (await modPresent(gameDir, m)) groups[name].present++;
  }
  const selected = modpack.selectedMods(pack, options);
  const wanted = new Set(selected.map((m) => m.filename));
  for (const m of selected) {
    if (!(await modPresent(gameDir, m))) return { complete: false, groups };
  }
  // un mod optionnel ou d'un groupe désactivé depuis (Iris, Crystal Optimizer, Replay Mod…) mais encore installé : le pack est à mettre à jour
  const leftover = (state?.pack?.managed || []).some((name) => !wanted.has(name) && fs.existsSync(path.join(gameDir, 'mods', name)));
  return { complete: !leftover, groups };
}

/**
 * État rapide (présence des fichiers, sans hash) pour l'écran d'accueil. `profile` : catalogue, Forge 1.8.9 par défaut.
 * Réglages du profil : shaders, pvpMods, optifinePacks, replayMod (groupes du pack) ; optifine et optifineJar (profil 1.8.9 :
 * la copie d'OptiFine du joueur, voir optifine.js). Le résultat contient `optifine` pour ce profil.
 */
async function status({
  minecraftDir, gameDir, profile: profileOption, shaders = false, pvpMods = true, optifinePacks = true, replayMod = false,
  optifine: optifineEnabled = true, optifineJar = '',
}) {
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
  const packInfo = profile.pack ? await packStatus(gameDir, profile, packOptions({ shaders, pvpMods, optifinePacks, replayMod }), state) : null;
  const result = {
    profileId: profile.id,
    minecraft: has(minecraftDir, 'versions', mc, `${mc}.json`) && has(minecraftDir, 'versions', mc, `${mc}.jar`)
      && Boolean(assetIndex) && /^[\w.-]+$/.test(assetIndex) && has(minecraftDir, 'assets', 'indexes', `${assetIndex}.json`),
    loader: (await isJsonFile(path.join(minecraftDir, 'versions', vid, `${vid}.json`))) && has(minecraftDir, 'libraries', ...loaderLibrary.split('/')),
    pack: packInfo ? packInfo.complete : null,
    packGroups: packInfo ? packInfo.groups : null,
    mod: has(gameDir, 'mods', profile.modFile),
    profile: launcherProfile,
    profileError,
    modVersion: mod.installedVersion(state?.mod),
    modSource: state?.mod?.source || null,
    installedAt: state?.installedAt || null,
  };
  // OptiFine du joueur (1.8.9) : à copier, à remplacer ou à retirer = l'installation a quelque chose à faire
  if (catalog.hasOptifine(profile)) {
    result.optifine = await optifine.inspect({ minecraftDir, gameDir, enabled: optifineEnabled, chosen: optifineJar, tracked: state?.optifine || null });
  }
  // nom historique du chargeur (forge / fabric) à côté de `loader`
  result[profile.loader.type] = result.loader;
  result.installed = result.minecraft && result.loader && result.pack !== false && result.mod && result.profile && !result.optifine?.pending;
  return result;
}

module.exports = {
  STEPS, STEPS_FORGE, STEPS_FABRIC, stepsFor, InstallError, install, status, progressReporter,
  installMinecraft, installForge, installFabric, installPack, installGameOptions, installOptifine, installWalksyLibConfig, WALKSYLIB_CONFIG, installMod, readState, gameDirConflict, packOptions,
};
