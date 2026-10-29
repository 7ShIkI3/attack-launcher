'use strict';
// Catalogue des profils du launcher : une version de Minecraft, son chargeur de mods (Forge ou Fabric), son dossier
// de jeu, la règle qui désigne le jar ATTACK dans une release GitHub et le pack de mods figé (src/main/packs/).
// Module pur : aucune lecture de fichier ni réseau, pour rester facile à tester.

/** Version de Fabric Loader fixée pour tous les profils Fabric. */
const FABRIC_LOADER_VERSION = '0.19.5';

/**
 * SHA-1 figés des deux bibliothèques que le profil de version de Fabric publie sans hash (fabric-loader et intermediary,
 * seulement pour les versions qui en ont un) : on ne s'appuie pas sur le .sha1 du même serveur que le jar.
 */
const FABRIC_LOADER_SHA1 = 'ff9e65cffca4a67f31523e1807fe0855940fcbfa';
const FABRIC_INTERMEDIARY_SHA1 = { '1.21.1': '4b96f58657aa282efa6bb8ae9369c2d42cf96e8c' };

const DEFAULT_PROFILE_ID = 'forge-1.8.9';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Profil historique : Minecraft 1.8.9 + Forge. Ses identifiants et son dossier de jeu ne changent jamais. */
const FORGE_1_8_9 = {
  id: 'forge-1.8.9',
  label: '1.8.9',
  name: 'ATTACK Client',
  mc: '1.8.9',
  loader: {
    type: 'forge',
    version: '11.15.1.2318',
    fullVersion: '1.8.9-11.15.1.2318-1.8.9',
    versionId: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
  },
  // version de Java à titre indicatif (affichage) : le composant réellement utilisé vient du JSON de version de Mojang
  javaMajor: 8,
  launcherProfileId: 'attack-client',
  gameDirName: '.attack',
  modFile: 'attack-client.jar',
  attackJar: {
    // règle historique : attack-client*.jar (ne correspond jamais à attack-fabric-*)
    regex: '^attack-client.*\\.jar$',
    flags: 'i',
    versionRegex: '^attack-client-(.+)\\.jar$',
    glob: 'attack-client-*.jar',
    unique: false,
    devDir: ['Documents', 'pvp-essentials', 'build', 'libs'],
  },
  pack: 'forge-1.8.9',
  // OptiFine : jamais téléchargé (sa licence l'interdit), seulement la copie que le joueur possède déjà (src/main/optifine.js)
  optifine: true,
};

function fabricProfile(mc, javaMajor) {
  const jarPattern = `attack-fabric-([0-9.]+)\\+mc${escapeRegex(mc)}\\.jar`;
  return {
    id: `fabric-${mc}`,
    label: mc,
    name: `ATTACK ${mc}`,
    mc,
    loader: {
      type: 'fabric',
      version: FABRIC_LOADER_VERSION,
      versionId: `fabric-loader-${FABRIC_LOADER_VERSION}-${mc}`,
      pinnedSha1: {
        [`net.fabricmc:fabric-loader:${FABRIC_LOADER_VERSION}`]: FABRIC_LOADER_SHA1,
        ...(FABRIC_INTERMEDIARY_SHA1[mc] ? { [`net.fabricmc:intermediary:${mc}`]: FABRIC_INTERMEDIARY_SHA1[mc] } : {}),
      },
    },
    javaMajor,
    launcherProfileId: `attack-fabric-${mc}`,
    gameDirName: `.attack/profiles/fabric-${mc}`,
    modFile: 'attack-fabric.jar',
    attackJar: {
      regex: `^${jarPattern}$`,
      flags: '',
      versionRegex: `^${jarPattern}$`,
      glob: `attack-fabric-*+mc${mc}.jar`,
      // plusieurs jars pour la même version de Minecraft dans une release : erreur, jamais un choix au hasard
      unique: true,
      devDir: ['Documents', 'attack-client-fabric', 'versions', mc, 'build', 'libs'],
    },
    pack: `fabric-${mc}`,
  };
}

const PROFILES = Object.freeze([FORGE_1_8_9, fabricProfile('1.21.1', 21), fabricProfile('26.3', 25)].map((p) => Object.freeze(p)));

function list() {
  return PROFILES;
}

/** Profil du catalogue, ou undefined si l'identifiant est inconnu. */
function find(id) {
  return PROFILES.find((p) => p.id === id);
}

/** Profil du catalogue ; erreur si l'identifiant est inconnu. */
function get(id = DEFAULT_PROFILE_ID) {
  const profile = find(id);
  if (!profile) throw new Error(`Profil inconnu : ${id}`);
  return profile;
}

function isValidId(id) {
  return typeof id === 'string' && Boolean(find(id));
}

/** Profil dont le JSON de version est `versionId` (id du profil Fabric / Forge), ou undefined. */
function byVersionId(versionId) {
  return PROFILES.find((p) => p.loader.versionId === versionId);
}

function versionIds() {
  return PROFILES.map((p) => p.loader.versionId);
}

function isFabric(profile) {
  return profile.loader.type === 'fabric';
}

/** Vrai pour le profil qui peut utiliser la copie d'OptiFine du joueur (Forge 1.8.9). */
function hasOptifine(profile) {
  return Boolean(profile.optifine);
}

/**
 * Règle du jar ATTACK du profil : { matches(nom), version(nom) }.
 * `matches` est exacte (jamais « le premier jar qui ressemble »), `version` lit la version dans le nom du jar.
 */
function jarRule(profile) {
  const { regex, flags, versionRegex } = profile.attackJar;
  const match = new RegExp(regex, flags);
  const parse = new RegExp(versionRegex, flags);
  return {
    matches: (name) => match.test(String(name)),
    version: (name) => parse.exec(String(name))?.[1] || null,
  };
}

/** Description du profil sans fonction ni expression régulière, pour l'interface. */
function view(profile) {
  return {
    id: profile.id,
    label: profile.label,
    name: profile.name,
    mc: profile.mc,
    loaderType: profile.loader.type,
    loaderVersion: profile.loader.version,
    versionId: profile.loader.versionId,
    javaMajor: profile.javaMajor,
    launcherProfileId: profile.launcherProfileId,
    modFile: profile.modFile,
    jarGlob: profile.attackJar.glob,
    hasPack: Boolean(profile.pack),
    hasOptifine: hasOptifine(profile),
  };
}

module.exports = {
  FABRIC_LOADER_VERSION,
  DEFAULT_PROFILE_ID,
  escapeRegex,
  list,
  find,
  get,
  isValidId,
  byVersionId,
  versionIds,
  isFabric,
  hasOptifine,
  jarRule,
  view,
};
