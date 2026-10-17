'use strict';
// Coordonnées Maven « groupe:artefact:version[:classifier][@extension] » -> chemin relatif et URL.
const path = require('node:path');

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

function parseCoordinate(name) {
  if (typeof name !== 'string') throw new Error('Coordonnée Maven invalide');
  let ext = 'jar';
  let body = name;
  const at = name.indexOf('@');
  if (at !== -1) {
    ext = name.slice(at + 1);
    body = name.slice(0, at);
  }
  const parts = body.split(':');
  if (parts.length < 3 || parts.length > 4) throw new Error(`Coordonnée Maven invalide : ${name}`);
  const [group, artifact, version, classifier] = parts;
  for (const segment of [...group.split('.'), artifact, version, ext, ...(classifier ? [classifier] : [])]) {
    if (!SEGMENT.test(segment) || segment.includes('..')) throw new Error(`Coordonnée Maven invalide : ${name}`);
  }
  return { group, artifact, version, classifier: classifier || null, ext };
}

/** Chemin relatif (séparateurs « / ») d'une bibliothèque, ex. org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar */
function mavenPath(name, classifier) {
  const c = parseCoordinate(name);
  const cls = classifier || c.classifier;
  if (cls && !SEGMENT.test(cls)) throw new Error(`Classifier Maven invalide : ${cls}`);
  const file = `${c.artifact}-${c.version}${cls ? `-${cls}` : ''}.${c.ext}`;
  return [...c.group.split('.'), c.artifact, c.version, file].join('/');
}

function mavenUrl(repository, name, classifier) {
  const base = repository.endsWith('/') ? repository : `${repository}/`;
  return base + mavenPath(name, classifier);
}

/** Joint un chemin relatif à une racine en refusant toute sortie de la racine (« .. », chemin absolu). */
function safeJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split('/'));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Chemin hors du dossier autorisé : ${relative}`);
  }
  return target;
}

module.exports = { parseCoordinate, mavenPath, mavenUrl, safeJoin };
