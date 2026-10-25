'use strict';
// Ouverture du launcher Minecraft officiel. La version Xbox / Microsoft Store (X:\XboxGames\Minecraft Launcher)
// est une application empaquetée : on la démarre par son identifiant d'application via l'Explorateur.
// L'ancien launcher (MinecraftLauncher.exe) est lancé directement.
//
// Si aucun launcher n'est trouvé, on ne lance RIEN : l'Explorateur, appelé avec l'identifiant d'une application
// qui n'est pas installée, ouvre le dossier Documents au lieu de signaler l'erreur (bug vu chez un joueur).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STORE_PACKAGE = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
const STORE_APP_ID = `${STORE_PACKAGE}!Minecraft`;

/** Lettres de lecteur à visiter : le disque système d'abord (le dossier XboxGames peut être sur un autre disque). */
function driveLetters(env = process.env) {
  const system = (env.SystemDrive || 'C:').charAt(0).toUpperCase();
  const others = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((letter) => letter !== system);
  return [system, ...others];
}

function xboxLauncherPaths(env = process.env) {
  return driveLetters(env).map((letter) => path.join(`${letter}:\\`, 'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe'));
}

/** Dossier de données que Windows crée pour l'application Store quand elle est installée pour ce compte. */
function storePackagePaths(env = process.env) {
  return env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Packages', STORE_PACKAGE)] : [];
}

function classicLauncherPaths(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean);
  return [
    ...roots.map((root) => path.join(root, 'Minecraft Launcher', 'MinecraftLauncher.exe')),
    ...roots.map((root) => path.join(root, 'Minecraft', 'MinecraftLauncher.exe')),
  ];
}

/**
 * Choisit comment ouvrir le launcher : { kind: 'store'|'exe'|'none', command, args, detected }.
 * kind 'none' (detected false) : aucun launcher officiel sur ce PC, il n'y a rien à ouvrir.
 */
function launchPlan(exists = fs.existsSync, env = process.env) {
  const xbox = xboxLauncherPaths(env).find(exists);
  if (xbox) return storePlan(env, xbox);
  const store = storePackagePaths(env).find(exists);
  if (store) return storePlan(env, store);
  const classic = classicLauncherPaths(env).find(exists);
  if (classic) return { kind: 'exe', command: classic, args: [], detected: classic };
  return { kind: 'none', command: null, args: [], detected: false };
}

function storePlan(env, detected) {
  const explorer = path.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  return { kind: 'store', command: explorer, args: [`shell:AppsFolder\\${STORE_APP_ID}`], detected };
}

/** Ouvre le launcher du plan ; un plan 'none' ne lance rien. */
function openLauncher(plan = launchPlan()) {
  if (plan.kind === 'none' || !plan.command) return plan;
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return plan;
}

module.exports = { STORE_APP_ID, STORE_PACKAGE, driveLetters, xboxLauncherPaths, storePackagePaths, classicLauncherPaths, launchPlan, openLauncher };
