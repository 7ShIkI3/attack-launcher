'use strict';
// Installation complète : Minecraft 1.8.9 (JSON, jar, bibliothèques, assets), Forge 1.8.9 (sans exécuter
// l'installateur), le jar ATTACK Client dans le dossier de jeu séparé, puis le profil du launcher officiel.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const C = require('./constants');
const http = require('./http');
const mojang = require('./mojang');
const forge = require('./forge');
const mod = require('./mod');
const profiles = require('./profiles');
const { mavenPath, safeJoin } = require('./maven');

/** Étapes et poids dans la barre de progression globale. */
const STEPS = [
  { id: 'minecraft', weight: 8 },
  { id: 'libraries', weight: 10 },
  { id: 'assets', weight: 57 },
  { id: 'forge', weight: 12 },
  { id: 'mod', weight: 8 },
  { id: 'profile', weight: 5 },
];

class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function progressReporter(onProgress) {
  const offsets = {};
  let acc = 0;
  for (const step of STEPS) {
    offsets[step.id] = acc;
    acc += step.weight;
  }
  return (step, done = 0, total = 1, message = '') => {
    const weight = STEPS.find((s) => s.id === step).weight;
    const percent = Math.min(100, offsets[step] + (weight * (total ? done / total : 1)));
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
async function installMinecraft(mcDir, report, net) {
  report('minecraft', 0, 3, 'Manifeste Mojang');
  const manifest = await http.fetchJson(C.VERSION_MANIFEST_URL, net);
  const entry = mojang.findVersion(manifest, C.MC_VERSION);
  const raw = await http.fetchBuffer(entry.url, { ...net, sha1: entry.sha1 });
  const versionJson = JSON.parse(raw.toString('utf8'));
  await writeIfChanged(safeJoin(mcDir, `versions/${C.MC_VERSION}/${C.MC_VERSION}.json`), raw);
  report('minecraft', 1, 3, 'Jar Minecraft 1.8.9');
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

async function installForge(mcDir, report, net) {
  report('forge', 0, 1, 'Installateur Forge (lu comme une archive, jamais exécuté)');
  const installerSha1 = await remoteSha1(C.FORGE_INSTALLER_URL, net);
  const installer = await http.fetchBuffer(C.FORGE_INSTALLER_URL, { ...net, sha1: installerSha1 });
  const { install, versionInfo, universal } = forge.readInstallProfile(installer);
  if (versionInfo.id !== C.FORGE_VERSION_ID) throw new Error(`Version Forge inattendue : ${versionInfo.id}`);

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

  const versionDir = `versions/${C.FORGE_VERSION_ID}/${C.FORGE_VERSION_ID}.json`;
  const json = forge.buildVersionJson(versionInfo, resolved);
  await writeIfChanged(safeJoin(mcDir, versionDir), Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  return { libraries: resolved.size, universalSha1: resolved.get(install.path).sha1 };
}

/** Jar ATTACK Client -> <gameDir>/mods/attack-client.jar, depuis la release GitHub ou le build local (mode dev). */
async function installMod(gameDir, settings, report, net) {
  const dest = path.join(gameDir, 'mods', C.MOD_FILE);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let info;
  if (settings.devMode) {
    report('mod', 0, 1, 'Copie du jar local (mode développeur)');
    const jar = mod.findDevJar(settings.devJarDir);
    if (!jar) throw new InstallError('NO_DEV_JAR', `Aucun attack-client-*.jar dans ${settings.devJarDir}`);
    await fsp.copyFile(jar.file, `${dest}.part`);
    await fsp.rename(`${dest}.part`, dest);
    info = { source: 'dev', version: mod.versionFromJarName(jar.name), file: jar.file };
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
    const asset = mod.parseRelease(release);
    const sha256 = asset.sha256 || mod.sha256For(await http.fetchText(asset.sha256Url, net), asset.name);
    await http.downloadFile(asset.url, dest, { sha256, size: asset.size }, net);
    info = { source: 'release', version: asset.version, file: asset.url };
  }
  info.sha256 = await http.hashFile(dest, 'sha256');
  report('mod', 1, 1);
  return info;
}

async function installProfile(mcDir, gameDir, settings, icon, report) {
  report('profile', 0, 1, 'Profil du launcher officiel');
  await profiles.updateProfiles(mcDir, (data) =>
    profiles.mergeProfile(data, { gameDir, ramMb: settings.ramMb, javaPath: settings.javaPath, icon }));
  report('profile', 1, 1);
}

/**
 * Installation complète. options : { minecraftDir, settings, icon, onProgress, concurrency, allowedHosts, env }.
 * Le dossier de jeu est settings.gameDir. Renvoie un résumé.
 */
async function install(options) {
  const { minecraftDir, settings, icon, onProgress, env = mojang.currentEnv() } = options;
  const net = { concurrency: options.concurrency || 8, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) };
  const report = progressReporter(onProgress);
  const gameDir = settings.gameDir;
  await fsp.mkdir(gameDir, { recursive: true });

  const versionJson = await installMinecraft(minecraftDir, report, net);
  const libraries = await installLibraries(minecraftDir, versionJson, report, net, env);
  const assets = await installAssets(minecraftDir, versionJson, report, net);
  const forgeResult = await installForge(minecraftDir, report, net);
  const modInfo = await installMod(gameDir, settings, report, net);
  await installProfile(minecraftDir, gameDir, settings, icon, report);

  const state = {
    minecraft: C.MC_VERSION,
    forge: C.FORGE_VERSION_ID,
    mod: modInfo,
    installedAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(gameDir, C.STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  return { ...state, libraries, assets, forgeLibraries: forgeResult.libraries };
}

/** État rapide (présence des fichiers, sans hash) pour l'écran d'accueil. */
async function status({ minecraftDir, gameDir }) {
  const has = (...parts) => fs.existsSync(path.join(...parts));
  const mc = C.MC_VERSION;
  const fid = C.FORGE_VERSION_ID;
  let profile = false;
  let profileError = null;
  try {
    profile = Boolean((await profiles.readProfiles(minecraftDir))?.profiles?.[C.PROFILE_ID]);
  } catch (error) {
    profileError = error.message;
  }
  let state = null;
  try {
    state = JSON.parse(await fsp.readFile(path.join(gameDir, C.STATE_FILE), 'utf8'));
  } catch {
    state = null;
  }
  const result = {
    minecraft: has(minecraftDir, 'versions', mc, `${mc}.json`) && has(minecraftDir, 'versions', mc, `${mc}.jar`)
      && has(minecraftDir, 'assets', 'indexes', '1.8.json'),
    forge: has(minecraftDir, 'versions', fid, `${fid}.json`)
      && has(minecraftDir, 'libraries', ...mavenPath(`net.minecraftforge:forge:${C.FORGE_VERSION}`).split('/')),
    mod: has(gameDir, 'mods', C.MOD_FILE),
    profile,
    profileError,
    modVersion: mod.installedVersion(state?.mod),
    modSource: state?.mod?.source || null,
    installedAt: state?.installedAt || null,
  };
  result.installed = result.minecraft && result.forge && result.mod && result.profile;
  return result;
}

module.exports = { STEPS, InstallError, install, status, installMinecraft, installForge, installMod, progressReporter };
