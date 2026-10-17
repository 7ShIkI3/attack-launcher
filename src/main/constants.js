'use strict';
// Versions, adresses officielles et noms fixes du launcher.

const MC_VERSION = '1.8.9';
const FORGE_VERSION = '1.8.9-11.15.1.2318-1.8.9';
const FORGE_VERSION_ID = '1.8.9-forge1.8.9-11.15.1.2318-1.8.9';

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const FORGE_INSTALLER_URL =
  `${FORGE_MAVEN}net/minecraftforge/forge/${FORGE_VERSION}/forge-${FORGE_VERSION}-installer.jar`;

const GITHUB_REPO = '7ShIkI3/attack-launcher';
const GITHUB_LATEST_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

const PROFILE_ID = 'attack-client';
const PROFILE_NAME = 'ATTACK Client';
const MOD_FILE = 'attack-client.jar';
const STATE_FILE = 'attack-launcher.json';

/** Seuls hôtes contactés : Mojang, Forge et GitHub (releases du projet). Les redirections sont vérifiées aussi. */
const ALLOWED_HOSTS = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'maven.minecraftforge.net',
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

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
  GITHUB_REPO,
  GITHUB_LATEST_RELEASE,
  PROFILE_ID,
  PROFILE_NAME,
  MOD_FILE,
  STATE_FILE,
  ALLOWED_HOSTS,
  DEFAULT_JVM_ARGS,
};
