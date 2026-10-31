'use strict';
// Contrôle d'une release GitHub AVANT de la publier (ou après) : chaque profil du catalogue y trouve-t-il SON jar ?
//   node scripts/check-release.js [<tag>] [--repo <proprio/dépôt>] [--file <release.json>] [--sums <SHA256SUMS>]
//   npm run check-release -- v0.8.0
// <tag>     release à contrôler, brouillon compris : lue avec `gh release view <tag> --json tagName,isDraft,isPrerelease,assets`
//           (gh doit être connecté à GitHub). Sans tag : la dernière release publiée.
// --repo    dépôt de la release (7ShIkI3/attack-launcher par défaut).
// --file    au lieu de gh : un fichier JSON, sortie de `gh release view --json …` ou réponse de l'API GitHub (essais, hors ligne). Un champ
//           « sha256sums » (texte) peut y tenir lieu de SHA256SUMS.
// --sums    fichier SHA256SUMS déjà téléchargé ; sans lui, SHA256SUMS est lu dans la release (`gh release download --output -`).
// Contrôles (la moindre erreur = code de sortie 1) :
//   1. mod.parseRelease() trouve un jar pour CHAQUE profil du catalogue, avec un SHA-256 (digest GitHub ou fichier de sommes) ;
//   2. aucun jar n'est reconnu par deux profils, aucun profil n'en reconnaît deux, aucun nom n'a une « version » douteuse
//      (attack-client-1710-1.0.0.jar serait pris pour le mod 1.8.9 par la règle large attack-client*.jar), aucun jar attack* n'est orphelin ;
//   3. SHA256SUMS existe et a UNE ligne par jar de profil (« <sha256>  <nom exact> »), cohérente avec le digest GitHub.
// Les fichiers du launcher (Setup, blockmap, latest.yml, Portable) manquants sont signalés en avertissement.
// Ce script ne publie ni ne modifie rien ; il ne télécharge que SHA256SUMS (quelques centaines d'octets), et seulement avec `gh`.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const catalog = require('../src/main/catalog');
const mod = require('../src/main/mod');
const { GITHUB_REPO } = require('../src/main/constants');

const SUMS_NAME = 'SHA256SUMS';
const SUMS_LINE = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i;
const FILE_LAUNCHER = [
  [/^ATTACK-Launcher-Setup-.+\.exe$/, 'Setup.exe'],
  [/^ATTACK-Launcher-Setup-.+\.exe\.blockmap$/, 'blockmap du Setup'],
  [/^ATTACK-Launcher-Portable-.+\.exe$/, 'Portable.exe'],
  [/^latest\.yml$/, 'latest.yml'],
];

/** Release au format de l'API GitHub, que l'entrée vienne de `gh release view --json` ou de l'API : { tag_name, draft, prerelease, assets }. */
function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.assets)) throw new Error('Release illisible : le JSON n’a pas de liste « assets »');
  return {
    tag_name: raw.tag_name || raw.tagName || '(sans tag)',
    draft: Boolean(raw.draft ?? raw.isDraft),
    prerelease: Boolean(raw.prerelease ?? raw.isPrerelease),
    sha256sums: typeof raw.sha256sums === 'string' ? raw.sha256sums : undefined,
    assets: raw.assets.filter((a) => a && typeof a.name === 'string').map((a) => ({
      name: a.name,
      size: a.size,
      digest: a.digest || undefined,
      browser_download_url: a.browser_download_url || a.url || `https://github.invalid/${encodeURIComponent(a.name)}`,
    })),
  };
}

/**
 * Lignes d'un SHA256SUMS : { byName: Map(nom -> [hash]), bad: [lignes illisibles] }.
 * Un nom présent deux fois est gardé avec ses deux hash : c'est une erreur à signaler, jamais un choix au hasard.
 */
function parseSums(text) {
  const byName = new Map();
  const bad = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = SUMS_LINE.exec(line);
    if (!match) {
      bad.push(line);
      continue;
    }
    const name = match[2];
    byName.set(name, [...(byName.get(name) || []), match[1].toLowerCase()]);
  }
  return { byName, bad };
}

/**
 * Applique tous les contrôles. `release` : sortie de normalizeRelease ; `sumsText` : contenu de SHA256SUMS (undefined = absent ou illisible).
 * Renvoie { tag, draft, prerelease, files, profiles: [{ id, jar, version, size, sha256 }], errors, warnings }.
 */
function checkRelease(release, sumsText) {
  const errors = [];
  const warnings = [];
  const names = release.assets.map((a) => a.name);
  const result = { tag: release.tag_name, draft: release.draft, prerelease: release.prerelease, files: names.length, profiles: [], errors, warnings };

  // 2. les noms : chaque règle ne reconnaît que son jar, un seul jar par profil
  const audit = mod.auditJarNames(names);
  for (const { name, profiles } of audit.overlaps) errors.push(`« ${name} » est reconnu par plusieurs profils (${profiles.join(', ')}) : le mauvais profil pourrait l'installer.`);
  for (const { name, profile, reason } of audit.dangerous) {
    errors.push(reason === 'no-version'
      ? `« ${name} » est pris pour le jar du profil ${profile}, mais son nom n'a pas de version : renomme-le comme le jar du profil visé.`
      : `« ${name} » est pris pour le jar du profil ${profile} (règle ${catalog.get(profile).attackJar.glob}) mais son nom n'a pas une version propre : `
        + `il serait installé à la place du vrai jar. Renomme-le (attack-forge-<version>+mc1.7.10.jar pour la 1.7.10).`);
  }
  for (const name of audit.orphans) {
    (/^attack/i.test(name) ? errors : warnings).push(`« ${name} » n'est reconnu par aucun profil : le launcher ne l'installera jamais.`);
  }
  for (const [id, jars] of Object.entries(audit.byProfile)) {
    if (jars.length > 1) errors.push(`Le profil ${id} reconnaît ${jars.length} jars (${jars.join(', ')}) : un seul par profil.`);
  }

  // 1. mod.parseRelease() pour chaque profil, comme le fait le launcher
  const jarNames = new Set();
  for (const profile of catalog.list()) {
    let asset;
    try {
      asset = mod.parseRelease(release, profile);
    } catch (error) {
      errors.push(`Profil ${profile.id} : ${error.message} (${error.code || 'erreur'}).`);
      continue;
    }
    jarNames.add(asset.name);
    result.profiles.push({ id: profile.id, jar: asset.name, version: catalog.jarRule(profile).version(asset.name), size: asset.size, sha256: asset.sha256 });
  }

  // 3. SHA256SUMS : une ligne par jar de profil, cohérente avec le digest GitHub
  if (!release.assets.some((a) => a.name === SUMS_NAME)) {
    errors.push(`La release n'a pas de fichier ${SUMS_NAME} (une ligne « <sha256>  <nom exact> » par jar).`);
  } else if (sumsText === undefined) {
    errors.push(`${SUMS_NAME} est joint à la release mais son contenu n'a pas pu être lu : ses lignes ne sont pas vérifiées.`);
  } else {
    const sums = parseSums(sumsText);
    for (const line of sums.bad) errors.push(`${SUMS_NAME} : ligne illisible « ${line} ».`);
    for (const entry of result.profiles) {
      const hashes = sums.byName.get(entry.jar) || [];
      if (hashes.length === 0) errors.push(`${SUMS_NAME} n'a pas de ligne pour « ${entry.jar} ».`);
      else if (hashes.length > 1) errors.push(`${SUMS_NAME} a ${hashes.length} lignes pour « ${entry.jar} » : une seule.`);
      else if (entry.sha256 && entry.sha256 !== hashes[0]) {
        errors.push(`${SUMS_NAME} et le digest GitHub de « ${entry.jar} » ne sont pas le même SHA-256 (${hashes[0].slice(0, 12)}… contre ${entry.sha256.slice(0, 12)}…).`);
      }
      if (hashes.length === 1 && !entry.sha256) entry.sha256 = hashes[0];
    }
    for (const name of sums.byName.keys()) {
      if (/\.jar$/i.test(name) && !jarNames.has(name)) warnings.push(`${SUMS_NAME} a une ligne pour « ${name} », qui n'est le jar d'aucun profil de cette release.`);
    }
  }

  // le launcher lui-même : sans eux, les mises à jour automatiques et le site ne marchent pas
  for (const [pattern, label] of FILE_LAUNCHER) {
    if (!names.some((n) => pattern.test(n))) warnings.push(`Fichier du launcher absent : ${label}. Chaque release doit le contenir (voir Publier-une-version).`);
  }
  return result;
}

/** Texte lisible du résultat (une ligne par profil, puis avertissements et erreurs). */
function format(result) {
  const lines = [`Release ${result.tag}${result.draft ? ' (brouillon)' : result.prerelease ? ' (préversion)' : ''} : ${result.files} fichiers`];
  for (const p of result.profiles) {
    lines.push(`  ${p.id.padEnd(14)} ${p.jar}  (version ${p.version || '?'}, ${p.size != null ? `${p.size} octets, ` : ''}SHA-256 ${p.sha256 ? `${p.sha256.slice(0, 12)}…` : 'non trouvé'})`);
  }
  for (const warning of result.warnings) lines.push(`  AVERTISSEMENT : ${warning}`);
  for (const error of result.errors) lines.push(`  ERREUR : ${error}`);
  lines.push(result.errors.length === 0
    ? `OK : les ${result.profiles.length} profils trouvent chacun leur jar, aucun jar n'est ambigu.`
    : `ÉCHEC : ${result.errors.length} erreur${result.errors.length > 1 ? 's' : ''}. Ne publie pas cette release.`);
  return lines.join('\n');
}

/** Lance `gh` (injectable pour les essais) et renvoie sa sortie texte. */
function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Release et SHA256SUMS : depuis un fichier JSON (`file`), sinon avec gh (`tag`, ou la dernière release publiée).
 * Renvoie { release, sumsText } ; sumsText est undefined si SHA256SUMS est absent ou illisible.
 */
function readRelease({ tag, repo = GITHUB_REPO, file, sumsFile, run = runGh } = {}) {
  let release;
  let sumsText;
  if (file) {
    release = normalizeRelease(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
    sumsText = release.sha256sums;
  } else {
    const view = ['release', 'view', ...(tag ? [tag] : []), '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,assets'];
    release = normalizeRelease(JSON.parse(run(view)));
    if (release.assets.some((a) => a.name === SUMS_NAME) && !sumsFile) {
      try {
        sumsText = run(['release', 'download', release.tag_name, '--repo', repo, '--pattern', SUMS_NAME, '--output', '-']);
      } catch {
        sumsText = undefined; // checkRelease le signale : SHA256SUMS est joint mais illisible
      }
    }
  }
  if (sumsFile) sumsText = fs.readFileSync(sumsFile, 'utf8');
  return { release, sumsText };
}

/** Options de la ligne de commande : { tag, repo, file, sums }. */
function parseArgs(argv) {
  const options = { tag: null, repo: GITHUB_REPO, file: null, sums: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' || arg === '--file' || arg === '--sums') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} attend une valeur`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else if (options.tag === null) {
      options.tag = arg;
    } else {
      throw new Error(`Argument en trop : ${arg}`);
    }
  }
  if (options.file && options.tag) throw new Error('--file et un tag ne vont pas ensemble : le fichier contient déjà la release');
  return options;
}

/** Programme : renvoie le code de sortie (0 = release correcte). `out` et `run` sont injectables pour les essais. */
function main(argv, { out = console.log, run = runGh } = {}) {
  const options = parseArgs(argv);
  const { release, sumsText } = readRelease({ tag: options.tag, repo: options.repo, file: options.file, sumsFile: options.sums, run });
  const result = checkRelease(release, sumsText);
  out(format(result));
  return result.errors.length === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ÉCHEC : ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { SUMS_NAME, normalizeRelease, parseSums, checkRelease, format, readRelease, parseArgs, main, runGh };
