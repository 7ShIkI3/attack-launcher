'use strict';
// Catalogue des profils du launcher : une version de Minecraft, son chargeur de mods (Forge ou Fabric), son dossier
// de jeu, la règle qui désigne le jar ATTACK dans une release GitHub, le pack de mods figé (src/main/packs/), s'il en a un
// (le profil 1.7.10 n'en a pas), et l'étape vidéo d'options.txt (`videoStep`, `videoStart`).
// Module pur : aucune lecture de fichier ni réseau, pour rester facile à tester. Il ne lit que la table de specs d'OptiFine (optifine.js),
// qui ne fait rien au chargement : les profils avec OptiFine y trouvent leur spec { mc, edition, tweak, minMod }.
const optifine = require('./optifine');

/** Version de Fabric Loader fixée pour tous les profils Fabric. */
const FABRIC_LOADER_VERSION = '0.19.5';

/**
 * SHA-1 figés des deux bibliothèques que le profil de version de Fabric publie sans hash (fabric-loader et intermediary,
 * seulement pour les versions qui en ont un) : on ne s'appuie pas sur le .sha1 du même serveur que le jar.
 */
const FABRIC_LOADER_SHA1 = 'ff9e65cffca4a67f31523e1807fe0855940fcbfa';
const FABRIC_INTERMEDIARY_SHA1 = { '1.21.1': '4b96f58657aa282efa6bb8ae9369c2d42cf96e8c' };

const DEFAULT_PROFILE_ID = 'forge-1.8.9';

/**
 * Réglages vidéo de départ d'options.txt (voir gameoptions.js), maxFps:260 = « illimité » dans Minecraft. Fabric : dossier neuf avec en plus
 * ombres des entités coupées et distance 10. Forge 1.7.10 : seulement la VSync et la limite de FPS (entityShadows n'existe pas en 1.7.10).
 */
const VIDEO_START = Object.freeze({
  fabric: Object.freeze({ enableVsync: 'false', maxFps: '260', entityShadows: 'false', renderDistance: '10' }),
  forge1710: Object.freeze({ enableVsync: 'false', maxFps: '260' }),
});

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
  // options.txt : pas d'étape vidéo en 1.8.9 (sa VSync n'est jamais touchée), seulement la langue (étape 2)
  videoStep: 0,
  videoStart: null,
  // OptiFine : jamais téléchargé (sa licence l'interdit), seulement la copie que le joueur possède déjà (src/main/optifine.js).
  // La spec { mc, edition, tweak, minMod } est celle de la table SPECS d'optifine.js : une seule source.
  optifine: optifine.forVersion('1.8.9'),
};

/**
 * Minecraft 1.7.10 + Forge 10.13.4.1614 (Java 8, LWJGL 2.9.1). Même format d'installateur Forge que la 1.8.9 : aucun changement dans
 * forge.js. Profil SANS pack de mods : le mod ATTACK 1.7.10, dont le jar s'appelle attack-forge-<version>+mc1.7.10.jar (jamais
 * attack-client*, qui est la règle du profil 1.8.9 : voir les tests de test/catalog.test.js), et, comme en 1.8.9, la copie d'OptiFine du
 * joueur (HD U E7, avec le mod 1.1.0 au moins : voir la spec).
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
  // options.txt : étape vidéo n° 3 (VSync coupée une fois dans un dossier existant, FPS débridés), ajoutée après la langue (étape 2)
  videoStep: 3,
  videoStart: VIDEO_START.forge1710,
  optifine: optifine.forVersion('1.7.10'),
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
    // options.txt : étape vidéo n° 1
    videoStep: 1,
    videoStart: VIDEO_START.fabric,
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

/** Vrai pour les profils qui peuvent utiliser la copie d'OptiFine du joueur (Forge 1.8.9 et 1.7.10) : ceux qui ont une spec `optifine`. */
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
    // spec d'OptiFine { mc, edition, tweak, minMod? } (données pures), ou null : la page n'écrit plus la version en dur
    optifine: profile.optifine ? { ...profile.optifine } : null,
  };
}

module.exports = {
  FABRIC_LOADER_VERSION,
  DEFAULT_PROFILE_ID,
  VIDEO_START,
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
