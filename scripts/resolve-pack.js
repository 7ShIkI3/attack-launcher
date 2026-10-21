'use strict';
// Outil de développement (jamais lancé par le launcher) : fige les packs de mods Fabric.
//   node scripts/resolve-pack.js [profil ...] [--check]
// Interroge l'API Modrinth, sélectionne EXACTEMENT les versions listées ci-dessous et écrit
// src/main/packs/<profil>.json (URL cdn.modrinth.com, SHA-512, SHA-1, taille). À l'exécution, le launcher ne
// contacte jamais l'API Modrinth : il télécharge seulement ces URL figées, vérifiées par SHA-512.
//   --check : ne réécrit rien, compare les fichiers existants avec ce que Modrinth publie aujourd'hui.
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = '7ShIkI3/attack-launcher/0.5.2 (github.com/7ShIkI3/attack-launcher)';
const OUT_DIR = path.join(__dirname, '..', 'src', 'main', 'packs');
const CDN_HOST = 'cdn.modrinth.com';

/**
 * versionNumber = numéro de version Modrinth exact (version_number) ; version = texte affiché dans le launcher.
 * optional : mod installé seulement si le réglage « Shaders (Iris) » est activé.
 * ModMenu embarque déjà Text Placeholder API (META-INF/jars) : pas besoin de placeholder-api à côté.
 */
const SPECS = {
  'fabric-1.21.1': {
    mc: '1.21.1',
    mods: [
      { slug: 'fabric-api', name: 'Fabric API', versionNumber: '0.116.17+1.21.1', version: '0.116.17' },
      { slug: 'sodium', name: 'Sodium', versionNumber: 'mc1.21.1-0.8.13-fabric', version: '0.8.13' },
      { slug: 'lithium', name: 'Lithium', versionNumber: 'mc1.21.1-0.15.4-fabric', version: '0.15.4' },
      { slug: 'ferrite-core', name: 'FerriteCore', versionNumber: '7.0.3-fabric', version: '7.0.3' },
      { slug: 'immediatelyfast', name: 'ImmediatelyFast', versionNumber: '1.6.15+1.21.1-fabric', version: '1.6.15' },
      { slug: 'modmenu', name: 'Mod Menu', versionNumber: '11.0.5', version: '11.0.5' },
      { slug: 'iris', name: 'Iris Shaders', versionNumber: '1.8.14-beta.1+1.21.1-fabric', version: '1.8.14-beta.1', optional: true },
    ],
  },
  'fabric-26.3': {
    mc: '26.3',
    mods: [
      { slug: 'fabric-api', name: 'Fabric API', versionNumber: '0.164.0+26.3', version: '0.164.0' },
      { slug: 'sodium', name: 'Sodium', versionNumber: 'mc26.3-0.9.2-fabric', version: '0.9.2' },
      { slug: 'lithium', name: 'Lithium', versionNumber: 'mc26.3-0.26.2-fabric', version: '0.26.2' },
      { slug: 'ferrite-core', name: 'FerriteCore', versionNumber: '9.0.0-fabric', version: '9.0.0' },
      { slug: 'immediatelyfast', name: 'ImmediatelyFast', versionNumber: '1.17.1+26.3-fabric', version: '1.17.1' },
      { slug: 'modmenu', name: 'Mod Menu', versionNumber: '21.0.0', version: '21.0.0' },
      { slug: 'iris', name: 'Iris Shaders', versionNumber: '1.11.7+26.3-fabric', version: '1.11.7', optional: true },
    ],
  },
};

async function api(pathAndQuery) {
  const response = await fetch(`${API}${pathAndQuery}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Modrinth ${response.status} pour ${pathAndQuery}`);
  return response.json();
}

async function resolveMod(spec, mc) {
  const query = `?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  const versions = await api(`/project/${spec.slug}/version${query}`);
  const found = versions.filter((v) => v.version_number === spec.versionNumber);
  if (found.length !== 1) {
    throw new Error(`${spec.slug} ${spec.versionNumber} : ${found.length} version(s) trouvée(s) pour ${mc} (disponibles : ${versions.slice(0, 8).map((v) => v.version_number).join(', ')})`);
  }
  const version = found[0];
  if (!version.loaders.includes('fabric') || !version.game_versions.includes(mc)) {
    throw new Error(`${spec.slug} ${spec.versionNumber} : pas compatible Fabric ${mc}`);
  }
  const file = version.files.find((f) => f.primary) || version.files[0];
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || url.hostname !== CDN_HOST) throw new Error(`${spec.slug} : URL hors ${CDN_HOST} (${file.url})`);
  if (!/^[\w.+-]+\.jar$/.test(file.filename)) throw new Error(`${spec.slug} : nom de fichier suspect (${file.filename})`);
  if (!/^[0-9a-f]{128}$/.test(file.hashes.sha512 || '') || !/^[0-9a-f]{40}$/.test(file.hashes.sha1 || '')) {
    throw new Error(`${spec.slug} : hash manquant`);
  }
  const entry = {
    slug: spec.slug,
    name: spec.name,
    version: spec.version,
    versionNumber: version.version_number,
    filename: file.filename,
    url: file.url,
    sha512: file.hashes.sha512,
    sha1: file.hashes.sha1,
    size: file.size,
  };
  if (spec.optional) entry.optional = true;
  return { entry, version };
}

/** Noms lisibles des dépendances « required » de Modrinth, pour relire à la main ce qui n'est pas dans le pack. */
async function dependencyNotes(version, packSlugs) {
  const ids = [...new Set((version.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id))];
  if (ids.length === 0) return [];
  const projects = await api(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  return projects.filter((p) => !packSlugs.has(p.slug)).map((p) => p.slug);
}

async function resolveProfile(profileId, spec) {
  const slugs = new Set(spec.mods.map((m) => m.slug));
  const mods = [];
  for (const modSpec of spec.mods) {
    const { entry, version } = await resolveMod(modSpec, spec.mc);
    const missing = await dependencyNotes(version, slugs);
    const note = missing.length > 0 ? `  dépendance requise hors pack : ${missing.join(', ')} (à vérifier : embarquée ?)` : '';
    console.log(`  ${entry.slug.padEnd(16)} ${entry.version.padEnd(9)} ${version.version_type.padEnd(8)} ${entry.filename} (${entry.size} o)${entry.optional ? ' [optionnel]' : ''}${note}`);
    mods.push(entry);
  }
  return { profileId, mc: spec.mc, loader: 'fabric', mods };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const ids = wanted.length > 0 ? wanted : Object.keys(SPECS);
  for (const id of ids) if (!SPECS[id]) throw new Error(`Profil inconnu : ${id}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let differences = 0;
  for (const id of ids) {
    console.log(`${id} (Minecraft ${SPECS[id].mc})`);
    const pack = await resolveProfile(id, SPECS[id]);
    const file = path.join(OUT_DIR, `${id}.json`);
    const text = `${JSON.stringify(pack, null, 2)}\n`;
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
      console.log(same ? '  identique au fichier figé' : '  DIFFÉRENT du fichier figé');
      if (!same) differences++;
    } else {
      fs.writeFileSync(file, text);
      console.log(`  écrit : ${path.relative(process.cwd(), file)}`);
    }
  }
  if (differences > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`ÉCHEC : ${error.message}`);
  process.exit(1);
});
