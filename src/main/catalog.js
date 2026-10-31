'use strict';
// Catalogue des profils du launcher : une version de Minecraft, son chargeur de mods (Forge ou Fabric), son dossier
// de jeu, la règle qui désigne le jar ATTACK dans une release GitHub et le pack de mods figé (src/main/packs/), s'il en a un
// (le profil 1.7.10 n'en a pas).
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

/**
 * Minecraft 1.7.10 + Forge 10.13.4.1614 (Java 8, LWJGL 2.9.1). Même format d'installateur Forge que la 1.8.9 : aucun changement dans
 * forge.js. Profil SANS pack de mods ni OptiFine (v1) : seulement le mod ATTACK 1.7.10 « lite », dont le jar s'appelle
 * attack-forge-<version>+mc1.7.10.jar (jamais attack-client*, qui est la règle du profil 1.8.9 : voir les tests de test/catalog.test.js).
 */
const FORGE_1_7_10 = {
  id: 'forge-1.7.10',
  label: '1.7.10',
  name: 'ATTACK 1.7.10',
  mc: '1.7.10',
  loader: {
    type: 'forge',
    version: '10.13.4.1614',
    fullVersion: '1.7.10-10.13.4.1614-1.7.10',
    versionId: '1.7.10-Forge10.13.4.1614-1.7.10',
  },
  javaMajor: 8,
  launcherProfileId: 'attack-forge-1.7.10',
  gameDirName: '.attack/profiles/forge-1.7.10',
  modFile: 'attack-forge.jar',
  attackJar: {
    regex: '^attack-forge-([0-9.]+)\\+mc1\\.7\\.10\\.jar$',
    flags: '',
    versionRegex: '^attack-forge-([0-9.]+)\\+mc1\\.7\\.10\\.jar$',
    glob: 'attack-forge-*+mc1.7.10.jar',
    // plusieurs jars 1.7.10 dans une release : erreur, jamais un choix au hasard
    unique: true,
    devDir: ['Documents', 'attack-forge-1710', 'build', 'libs'],
  },
  pack: null,
  optifine: false,
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

const PROFILES = Object.freeze([FORGE_1_8_9, fabricProfile('1.21.1', 21), fabricProfile('26.3', 25), FORGE_1_7_10].map((p) => Object.freeze(p)));

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

/** Vrai si le profil installe un pack de mods figé (tous, sauf Forge 1.7.10). */
function hasPack(profile) {
  return Boolean(profile.pack);
}

/** Version « propre » dans un nom de jar : 2.7.0, 3.6, 1.0.0-beta.2 (jamais 1710-1.0.0, 1.7.10-1.0.0 ni 1710). */
const CLEAN_VERSION = /^[0-9]+\.[0-9]+(\.[0-9]+)?(-(alpha|beta|rc)\.?[0-9]*)?$/i;

/**
 * Règle du jar ATTACK du profil : { matches(nom), version(nom), suspect(nom) }.
 * `matches` est exacte (jamais « le premier jar qui ressemble »), `version` lit la version dans le nom du jar.
 * `suspect` : null si le nom est propre, sinon 'no-version' (aucune version lisible dans le nom) ou 'odd-version' (une
 * « version » qui n'en est pas une). Exemple : attack-client-1710-1.0.0.jar, le nom que Gradle donnerait au mod 1.7.10, est
 * pris pour le mod 1.8.9 par sa règle large attack-client*.jar. Sert à scripts/check-release.js.
 */
function jarRule(profile) {
  const { regex, flags, versionRegex } = profile.attackJar;
  const match = new RegExp(regex, flags);
  const parse = new RegExp(versionRegex, flags);
  const version = (name) => parse.exec(String(name))?.[1] || null;
  return {
    matches: (name) => match.test(String(name)),
    version,
    suspect: (name) => {
      if (!match.test(String(name))) return null;
      const found = version(name);
      if (!found) return 'no-version';
      return CLEAN_VERSION.test(found) ? null : 'odd-version';
    },
  };
}

/** Début (en minuscules) des noms de jars d'un profil, tiré de son glob : « attack-fabric », « attack-forge », « attack-client ». */
function jarFamily(profile) {
  return profile.attackJar.glob.split('*')[0].replace(/-$/, '').toLowerCase();
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
    hasPack: hasPack(profile),
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
  hasPack,
  jarRule,
  jarFamily,
  view,
};
