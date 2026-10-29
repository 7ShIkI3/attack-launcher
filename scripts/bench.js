'use strict';
// Outil de développement (jamais lancé par le launcher) : banc d'essai FPS sur une installation de test
// (voir scripts/install-test.js), avec un jar ATTACK qui contient le banc (attack-client-fabric, selftest/Bench).
//   node scripts/bench.js <dossier de test> --profile <id> [--label x] [--modules off] [--ram 2048] [--jfr]
// Lance le jeu avec -Dattack.bench (passé par JDK_JAVA_OPTIONS : la liste d'autorisation des arguments Java du launcher
// n'est pas concernée), attend <dossier>/bench-<label>/bench.json et l'affiche sur une ligne. --modules off coupe tous
// les modules ATTACK ; --jfr enregistre aussi un profil Java Flight Recorder (rec.jfr, à lire avec « jfr print »).
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const { installRuntime } = require('../src/main/runtime');
const { launchGame, javaComponent } = require('../src/main/game');
const { offlineUuid } = require('../src/main/accounts');
const catalog = require('../src/main/catalog');
const { gameDirFor } = require('./install-test');

async function main() {
  const valueOptions = new Set(['--profile', '--label', '--modules', '--ram']);
  const root = path.resolve(args.find((a, i) => !a.startsWith('--') && !valueOptions.has(args[i - 1])));
  const profile = catalog.get(option('--profile'));
  const label = option('--label', 'run');
  const ramMb = Number(option('--ram', '2048'));
  const out = path.join(root, `bench-${label}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = gameDirFor(root, profile);
  const versionId = profile.loader.versionId;
  const component = await javaComponent(minecraftDir, versionId);
  const runtime = await installRuntime({ runtimeDir: path.join(root, 'runtime'), component });
  const props = [`-Dattack.bench=${out.replace(/\\/g, '/')}`];
  if (option('--modules')) props.push('-Dattack.bench.modules=' + option('--modules'));
  if (args.includes('--jfr')) props.push('-XX:StartFlightRecording=settings=profile,filename=' + path.join(out, 'rec.jfr').split(path.sep).join('/'));
  process.env.JDK_JAVA_OPTIONS = props.join(' ');
  const identity = { name: 'AttackDev', uuid: offlineUuid('AttackDev'), accessToken: '0', userType: 'legacy' };
  const started = Date.now();
  const { pid, logFile, child } = await launchGame({ java: runtime.java, minecraftDir, gameDir, versionId, identity, ramMb, launcherVersion: 'bench' });
  console.log(`[${label}] ${profile.id}, ${ramMb} Mo, pid ${pid}, journal ${logFile}`);
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  const file = path.join(out, 'bench.json');
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (fs.existsSync(file)) break;
    if (exited !== null) throw new Error(`jeu fermé (code ${exited}) sans bench.json : voir ${logFile}`);
    if (Date.now() - started > 8 * 60000) {
      try { process.kill(pid); } catch { /* déjà fermé */ }
      throw new Error('pas de bench.json en 8 min');
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete result.modIds;
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(`ÉCHEC : ${error.message}`);
  process.exit(1);
});
