'use strict';
// Installateur Forge « legacy » (1.8.9) lu comme une simple archive : on y prend install_profile.json
// et le jar universal, sans jamais exécuter le moindre code de l'installateur.
const { readEntries, readEntry } = require('./zip');
const { mavenPath, mavenUrl } = require('./maven');
const { FORGE_MAVEN, MOJANG_LIBRARIES } = require('./constants');

/** Adresse de l'installateur Forge d'un profil du catalogue (Maven Forge officiel). */
function installerUrl(profile) {
  const version = profile.loader.fullVersion;
  if (profile.loader.type !== 'forge' || !/^[0-9][0-9A-Za-z._-]*$/.test(version || '')) throw new Error(`Profil Forge invalide : ${profile.id}`);
  return `${FORGE_MAVEN}net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
}

/** Lit l'installateur (Buffer) : { install, versionInfo, universal: Buffer }. */
function readInstallProfile(installerBuffer) {
  const entries = readEntries(installerBuffer);
  const raw = readEntry(installerBuffer, 'install_profile.json', entries);
  if (!raw) throw new Error("install_profile.json absent de l'installateur Forge");
  const profile = JSON.parse(raw.toString('utf8'));
  const { install, versionInfo } = profile;
  if (!install || !versionInfo) throw new Error('install_profile.json : format inattendu (install / versionInfo)');
  if (!install.path || !install.filePath || !install.target) throw new Error('install_profile.json : champs install manquants');
  if (versionInfo.id !== install.target) throw new Error('install_profile.json : id de version incohérent');
  if (!Array.isArray(versionInfo.libraries)) throw new Error('install_profile.json : bibliothèques absentes');
  if (!/^[\w.-]+\.jar$/.test(install.filePath)) throw new Error(`Nom de jar universal suspect : ${install.filePath}`);
  const universal = readEntry(installerBuffer, install.filePath, entries);
  if (!universal) throw new Error(`${install.filePath} absent de l'installateur Forge`);
  return { install, versionInfo, universal };
}

/** Bibliothèques utiles au client (clientreq absent = requis côté client, comme le faisait l'installateur). */
function clientLibraries(versionInfo) {
  return versionInfo.libraries.filter((lib) => lib.clientreq !== false);
}

/** Seuls dépôts acceptés : Maven Forge (ancienne adresse comprise) et bibliothèques Mojang. */
function normalizeRepository(url) {
  if (!url) return MOJANG_LIBRARIES;
  const host = new URL(url).hostname;
  if (host === 'maven.minecraftforge.net' || host === 'files.minecraftforge.net') return FORGE_MAVEN;
  if (host === 'libraries.minecraft.net') return MOJANG_LIBRARIES;
  throw new Error(`Dépôt Maven non officiel refusé : ${url}`);
}

/**
 * Plan de téléchargement d'une bibliothèque Forge :
 * { name, path, url, sha1s, forge } ; `forge` = le jar universal, extrait de l'installateur (pas d'URL).
 */
function libraryPlan(lib, forgeName) {
  const forge = lib.name === forgeName;
  return {
    name: lib.name,
    path: mavenPath(lib.name),
    url: forge ? '' : mavenUrl(normalizeRepository(lib.url), lib.name),
    sha1s: (lib.checksums || []).map((h) => h.toLowerCase()),
    forge,
  };
}

/**
 * JSON de version écrit dans versions/<id>/<id>.json : celui de l'installateur, avec des bibliothèques au format
 * moderne (downloads.artifact + sha1 + taille) pour que le launcher officiel les vérifie sans les retélécharger.
 * resolved : Map nom -> { path, url, sha1, size }.
 */
function buildVersionJson(versionInfo, resolved) {
  const libraries = clientLibraries(versionInfo).map((lib) => {
    const file = resolved.get(lib.name);
    if (!file) throw new Error(`Bibliothèque non installée : ${lib.name}`);
    return { name: lib.name, downloads: { artifact: { path: file.path, url: file.url, sha1: file.sha1, size: file.size } } };
  });
  return { ...versionInfo, libraries };
}

module.exports = { installerUrl, readInstallProfile, clientLibraries, normalizeRepository, libraryPlan, buildVersionJson };
