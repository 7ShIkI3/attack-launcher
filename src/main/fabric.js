'use strict';
// Fabric Loader : profil de version publié par meta.fabricmc.net, lu comme de simples données (jamais d'installateur
// exécuté). Le JSON est validé strictement (dépôts, hash, options Java en liste blanche) puis réécrit à partir des seuls
// champs connus : le launcher officiel et le lancement direct ne voient jamais un champ inattendu.
const { mavenPath, mavenUrl, parseCoordinate } = require('./maven');
const { FABRIC_META, FABRIC_MAVEN, MOJANG_LIBRARIES } = require('./constants');

const KNOT_CLIENT = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
const SEGMENT = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const HASHES = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/, sha512: /^[0-9a-f]{128}$/ };
// Liste blanche des options Java d'un profil Fabric : la seule valeur exacte que publie meta.fabricmc.net, une seule fois.
// Tout le reste (-javaagent, -cp, --add-opens, -XX:OnError=, -Dfabric.addMods=..., -Dfabric.gameJarPath=...) est refusé :
// une option inconnue arrête l'installation plutôt que d'être passée à Java. Aucun argument du jeu n'est accepté non plus.
const FABRIC_MC_EMU = '-DFabricMcEmu= net.minecraft.client.main.Main ';

/** Adresse du profil de version Fabric Loader pour une version de Minecraft : .../loader/<mc>/<loader>/profile/json */
function profileUrl(mc, loaderVersion) {
  for (const part of [mc, loaderVersion]) {
    if (!SEGMENT.test(part || '') || part.includes('..')) throw new Error(`Version invalide pour Fabric : ${part}`);
  }
  return `${FABRIC_META}v2/versions/loader/${mc}/${loaderVersion}/profile/json`;
}

/** Seuls dépôts acceptés : Maven de Fabric et bibliothèques de Mojang. */
function normalizeRepository(url) {
  if (!url) return MOJANG_LIBRARIES;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Dépôt Maven non officiel refusé : ${url}`);
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'maven.fabricmc.net') return FABRIC_MAVEN;
  if (parsed.protocol === 'https:' && parsed.hostname === 'libraries.minecraft.net') return MOJANG_LIBRARIES;
  throw new Error(`Dépôt Maven non officiel refusé : ${url}`);
}

function checkArguments(list, kind) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`Profil Fabric : arguments ${kind} invalides`);
  return list.map((arg, index) => {
    if (typeof arg !== 'string' || arg.length > 500) throw new Error(`Profil Fabric : argument ${kind} suspect`);
    if (kind === 'jvm' && (arg !== FABRIC_MC_EMU || index > 0)) throw new Error(`Profil Fabric : option Java refusée (${arg.trim().slice(0, 60)})`);
    // le profil officiel n'a aucun argument du jeu : tout ajout (--quickPlayMultiplayer, ${auth_...}) est refusé
    if (kind === 'game') throw new Error(`Profil Fabric : argument du jeu refusé (${arg.trim().slice(0, 60)})`);
    return arg;
  });
}

/**
 * Valide le profil de version Fabric (Buffer, texte ou objet) pour un profil du catalogue.
 * Renvoie { id, inheritsFrom, type, time, releaseTime, mainClass, arguments: { game, jvm }, libraries }
 * où chaque bibliothèque est { name, repository, sha1?, sha256?, sha512?, size? }.
 */
function parseProfile(source, profile) {
  const json = Buffer.isBuffer(source) || typeof source === 'string' ? JSON.parse(String(source)) : source;
  if (!json || typeof json !== 'object') throw new Error('Profil Fabric : format inattendu');
  if (json.id !== profile.loader.versionId) throw new Error(`Profil Fabric : id inattendu (${json.id})`);
  if (json.inheritsFrom !== profile.mc) throw new Error(`Profil Fabric : version de Minecraft inattendue (${json.inheritsFrom})`);
  if (json.mainClass !== KNOT_CLIENT) throw new Error(`Profil Fabric : classe principale inattendue (${json.mainClass})`);
  if (!Array.isArray(json.libraries) || json.libraries.length === 0) throw new Error('Profil Fabric : bibliothèques absentes');
  const libraries = json.libraries.map((lib) => {
    if (!lib || typeof lib.name !== 'string') throw new Error('Profil Fabric : bibliothèque sans nom');
    const coordinate = parseCoordinate(lib.name);
    if (coordinate.ext !== 'jar') throw new Error(`Profil Fabric : extension refusée pour ${lib.name}`);
    const entry = { name: lib.name, repository: normalizeRepository(lib.url) };
    for (const [algorithm, pattern] of Object.entries(HASHES)) {
      if (lib[algorithm] === undefined) continue;
      if (typeof lib[algorithm] !== 'string' || !pattern.test(lib[algorithm].toLowerCase())) {
        throw new Error(`Profil Fabric : ${algorithm} invalide pour ${lib.name}`);
      }
      entry[algorithm] = lib[algorithm].toLowerCase();
    }
    if (lib.size !== undefined) {
      if (!Number.isInteger(lib.size) || lib.size <= 0) throw new Error(`Profil Fabric : taille invalide pour ${lib.name}`);
      entry.size = lib.size;
    }
    return entry;
  });
  const loaderName = `net.fabricmc:fabric-loader:${profile.loader.version}`;
  if (!libraries.some((lib) => lib.name === loaderName)) throw new Error(`Profil Fabric : ${loaderName} absent`);
  const args = json.arguments && typeof json.arguments === 'object' ? json.arguments : {};
  return {
    id: json.id,
    inheritsFrom: json.inheritsFrom,
    type: typeof json.type === 'string' ? json.type : 'release',
    time: typeof json.time === 'string' ? json.time : undefined,
    releaseTime: typeof json.releaseTime === 'string' ? json.releaseTime : undefined,
    mainClass: json.mainClass,
    arguments: { game: checkArguments(args.game, 'game'), jvm: checkArguments(args.jvm, 'jvm') },
    libraries,
  };
}

/**
 * Plan de téléchargement d'une bibliothèque validée : { name, path, url, hashes, size }.
 * `hashes` : { sha512?, sha256?, sha1? } ; vide pour fabric-loader et intermediary, dont le SHA-1 est publié
 * à côté du jar (<url>.sha1).
 */
function libraryPlan(lib) {
  const hashes = {};
  for (const algorithm of ['sha512', 'sha256', 'sha1']) if (lib[algorithm]) hashes[algorithm] = lib[algorithm];
  return { name: lib.name, path: mavenPath(lib.name), url: mavenUrl(lib.repository, lib.name), hashes, size: lib.size };
}

/**
 * JSON de version écrit dans versions/<id>/<id>.json : bibliothèques au format downloads.artifact (chemin, URL,
 * SHA-1, taille) pour que le launcher officiel les vérifie sans les retélécharger.
 * resolved : Map nom -> { path, url, sha1, size }.
 */
function buildVersionJson(parsed, resolved) {
  const libraries = parsed.libraries.map((lib) => {
    const file = resolved.get(lib.name);
    if (!file) throw new Error(`Bibliothèque non installée : ${lib.name}`);
    return { name: lib.name, downloads: { artifact: { path: file.path, url: file.url, sha1: file.sha1, size: file.size } } };
  });
  const json = { id: parsed.id, inheritsFrom: parsed.inheritsFrom, type: parsed.type };
  if (parsed.releaseTime) json.releaseTime = parsed.releaseTime;
  if (parsed.time) json.time = parsed.time;
  json.mainClass = parsed.mainClass;
  json.arguments = { game: parsed.arguments.game, jvm: parsed.arguments.jvm };
  json.libraries = libraries;
  return json;
}

module.exports = { KNOT_CLIENT, profileUrl, normalizeRepository, parseProfile, libraryPlan, buildVersionJson };
