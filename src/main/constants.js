'use strict';
// Versions, adresses officielles et noms fixes du launcher.

// Les versions de chaque profil vivent dans catalog.js ; ces alias désignent le profil historique forge-1.8.9.
const { get: catalogProfile } = require('./catalog');

const LEGACY = catalogProfile('forge-1.8.9');
const MC_VERSION = LEGACY.mc;
const FORGE_VERSION = LEGACY.loader.fullVersion;
const FORGE_VERSION_ID = LEGACY.loader.versionId;

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const FORGE_INSTALLER_URL =
  `${FORGE_MAVEN}net/minecraftforge/forge/${FORGE_VERSION}/forge-${FORGE_VERSION}-installer.jar`;
const FABRIC_META = 'https://meta.fabricmc.net/';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';
const MODRINTH_CDN_HOST = 'cdn.modrinth.com';

const GITHUB_REPO = '7ShIkI3/attack-launcher';
const GITHUB_LATEST_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
/** Les 10 dernières releases, préversions comprises (canal bêta : launcher en préversion). */
const GITHUB_RELEASES = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`;

const PROFILE_ID = LEGACY.launcherProfileId;
const PROFILE_NAME = LEGACY.name;
const MOD_FILE = LEGACY.modFile;
const STATE_FILE = 'attack-launcher.json';

/**
 * Seuls hôtes contactés : Mojang, Forge, Fabric (meta + Maven), le CDN de Modrinth (URL figées dans les packs, jamais
 * l'API), GitHub (releases du projet) et la connexion Microsoft / Xbox / Minecraft.
 * Les redirections sont vérifiées aussi.
 */
const ALLOWED_HOSTS = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'maven.minecraftforge.net',
  'meta.fabricmc.net',
  'maven.fabricmc.net',
  'cdn.modrinth.com',
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'login.microsoftonline.com',
  'user.auth.xboxlive.com',
  'xsts.auth.xboxlive.com',
  'api.minecraftservices.com',
  'textures.minecraft.net',
]);

/** Manifeste officiel des runtimes Java de Mojang (celui du launcher officiel). */
const JAVA_RUNTIME_MANIFEST =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/** Connexion Microsoft (comptes personnels) puis Xbox Live, XSTS et services Minecraft. */
const AUTH = {
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  scope: 'XboxLive.signin offline_access',
  xboxUser: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  entitlements: 'https://api.minecraftservices.com/entitlements/mcstore',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
};

/** Arguments Java par défaut du launcher officiel ; seul -Xmx est réglé par le launcher ATTACK. */
const DEFAULT_JVM_ARGS =
  '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 ' +
  '-XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M';

module.exports = {
  MC_VERSION,
  FORGE_VERSION,
  FORGE_VERSION_ID,
  VERSION_MANIFEST_URL,
  MOJANG_LIBRARIES,
  RESOURCES_URL,
  FORGE_MAVEN,
  FORGE_INSTALLER_URL,
  FABRIC_META,
  FABRIC_MAVEN,
  MODRINTH_CDN_HOST,
  GITHUB_REPO,
  GITHUB_LATEST_RELEASE,
  GITHUB_RELEASES,
  PROFILE_ID,
  PROFILE_NAME,
  MOD_FILE,
  STATE_FILE,
  ALLOWED_HOSTS,
  DEFAULT_JVM_ARGS,
  JAVA_RUNTIME_MANIFEST,
  AUTH,
};
