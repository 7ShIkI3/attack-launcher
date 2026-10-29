'use strict';
// Sert le site généré (_site) comme GitHub Pages le ferait, pour le contrôler en local :
//   node scripts/serve-site.js [--port 4173] [--dir _site]
// Adresse : http://127.0.0.1:<port>/attack-launcher/ (la racine / y redirige). Écoute 127.0.0.1 seulement, lecture seule,
// aucune remontée de dossier (même par un lien ou une jonction : chemin réel vérifié), 404 = 404.html, et le même en-tête Content-Security-Policy que la meta des pages.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { CSP } = require('./build-site');

const ROOT = path.join(__dirname, '..');
const BASE = '/attack-launcher/';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Serveur HTTP du dossier `dir` (déjà généré). Retourne un http.Server non démarré. */
function createServer(dir) {
  const root = path.resolve(dir);

  function send(res, status, headers, body) {
    res.writeHead(status, {
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function notFound(req, res) {
    const page = path.join(root, '404.html');
    const body = fs.existsSync(page) ? fs.readFileSync(page) : Buffer.from('404');
    send(res, 404, { 'Content-Type': MIME['.html'] }, req.method === 'HEAD' ? undefined : body);
  }

  function forbidden(res) {
    return send(res, 403, { 'Content-Type': MIME['.txt'] }, 'Accès refusé\n');
  }

  /**
   * Chemin réel de `target` (liens résolus) et ses attributs, avant toute lecture : { real, stat } ; { outside: true } si le
   * chemin réel sort du dossier servi ; { stat: null } si le fichier est absent.
   */
  function locate(target) {
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(target);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { outside: true };
      return { real, stat: fs.statSync(real) };
    } catch {
      return { stat: null };
    }
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': MIME['.txt'] }, 'Méthode refusée\n');
    const raw = String(req.url || '/').split('?')[0].split('#')[0];
    if (raw === '/') return send(res, 302, { Location: BASE }, '');
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return send(res, 400, { 'Content-Type': MIME['.txt'] }, 'Adresse invalide\n');
    }
    // remontée de dossier, séparateur Windows, octet nul ou chemin relatif : refus net, avant toute lecture de fichier
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..') || !decoded.startsWith('/')) {
      return forbidden(res);
    }
    if (decoded !== BASE.slice(0, -1) && !decoded.startsWith(BASE)) return notFound(req, res);
    if (decoded === BASE.slice(0, -1)) return send(res, 301, { Location: BASE }, '');

    let target = path.resolve(root, decoded.slice(BASE.length));
    if (target !== root && !target.startsWith(root + path.sep)) return forbidden(res);
    // le contrôle ci-dessus est lexical : une jonction ou un lien symbolique du dossier peut pointer ailleurs
    let found = locate(target);
    if (found.outside) return forbidden(res);
    if (!found.stat) return notFound(req, res);
    if (found.stat.isDirectory()) {
      // comme GitHub Pages : /en redirige vers /en/, qui sert en/index.html
      if (!decoded.endsWith('/')) return send(res, 301, { Location: `${decoded}/` }, '');
      target = path.join(target, 'index.html');
      found = locate(target);
      if (found.outside) return forbidden(res);
      if (!found.stat) return notFound(req, res);
    }
    if (!found.stat.isFile() || path.basename(target).startsWith('.')) return notFound(req, res);
    const body = fs.readFileSync(found.real);
    send(res, 200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length }, req.method === 'HEAD' ? undefined : body);
  });
}

/** --port et --dir, avec la valeur après un espace ou un « = ». Tout autre argument est refusé (jamais ignoré en silence). */
function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(port|dir)(?:=(.*))?$/s.exec(args[i]);
    if (!m) throw new Error(`argument inconnu : ${args[i]} (attendus : --port <numéro>, --dir <dossier>)`);
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out[m[1]] = args[++i];
    else out[m[1]] = undefined; // « --dir » sans valeur (ou suivi d'une autre option) : refusé plus loin avec un message clair
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`serve-site : ${error.message}`);
    process.exit(1);
  }
  const value = (name, fallback) => (Object.hasOwn(args, name.slice(2)) ? args[name.slice(2)] : fallback);
  const port = Number(value('--port', '4173'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('serve-site : --port attend un numéro de port valide');
    process.exit(1);
  }
  const dirArg = value('--dir', '_site');
  if (typeof dirArg !== 'string' || !dirArg.trim() || dirArg.startsWith('--')) {
    console.error('serve-site : --dir attend un dossier (par exemple --dir _site)');
    process.exit(1);
  }
  const dir = path.resolve(ROOT, dirArg);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`serve-site : ${dir} est vide ou absent : lance d'abord « npm run site »`);
    process.exit(1);
  }
  const server = createServer(dir);
  server.on('error', (error) => {
    console.error(`serve-site : ${error.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Site servi sur http://127.0.0.1:${port}${BASE} (Ctrl+C pour arrêter)`));
}

if (require.main === module) main();

module.exports = { createServer, parseArgs, BASE };
