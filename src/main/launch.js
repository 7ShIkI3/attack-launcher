'use strict';
// Ouverture du launcher Minecraft officiel. La version Xbox / Microsoft Store (C:\XboxGames\Minecraft Launcher)
// est une application empaquetée : on la démarre par son identifiant d'application via l'Explorateur.
// L'ancien launcher (MinecraftLauncher.exe) est lancé directement.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STORE_APP_ID = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft';

function xboxLauncherPaths(env = process.env) {
  const drive = env.SystemDrive || 'C:';
  return [path.join(`${drive}\\`, 'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe')];
}

function classicLauncherPaths(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean);
  return [
    ...roots.map((root) => path.join(root, 'Minecraft Launcher', 'MinecraftLauncher.exe')),
    ...roots.map((root) => path.join(root, 'Minecraft', 'MinecraftLauncher.exe')),
  ];
}

/**
 * Choisit comment ouvrir le launcher : { kind: 'store'|'exe', command, args, detected }.
 * `detected` vaut false si aucun launcher n'a été trouvé (on tente quand même la version Store).
 */
function launchPlan(exists = fs.existsSync, env = process.env) {
  const xbox = xboxLauncherPaths(env).find(exists);
  if (xbox) return storePlan(env, xbox);
  const classic = classicLauncherPaths(env).find(exists);
  if (classic) return { kind: 'exe', command: classic, args: [], detected: classic };
  return { ...storePlan(env, null), detected: false };
}

function storePlan(env, detected) {
  const explorer = path.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  return { kind: 'store', command: explorer, args: [`shell:AppsFolder\\${STORE_APP_ID}`], detected };
}

function openLauncher(plan = launchPlan()) {
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return plan;
}

module.exports = { STORE_APP_ID, xboxLauncherPaths, classicLauncherPaths, launchPlan, openLauncher };
