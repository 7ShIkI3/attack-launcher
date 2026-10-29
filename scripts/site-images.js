'use strict';
// Convertit les captures PNG du site en WebP : site/img/<clé>-<fr|en>-<largeur>.webp, site/img/manifest.json, site/img/og.png et site/img/og-en.png.
//   npm run site:images -- --sources <dossier>      (ou SITE_IMAGES_SOURCES=<dossier>)
// --sources est OBLIGATOIRE : le dossier contient des PNG nommés <clé>-<fr|en>.png (launcher-home-fr.png, client-menu-en.png…).
// Ces PNG ne sont pas dans le dépôt (seuls les WebP et le manifeste sont versionnés) : sans eux, la commande refuse de
// travailler au lieu d'effacer les images déjà produites. Une langue absente n'est pas une erreur (le générateur,
// scripts/build-site.js, reprend alors l'autre langue) ; une clé absente dans les deux langues en est une.
// Tout est d'abord encodé dans un dossier d'attente ; site/img/ n'est modifié qu'une fois toutes les images produites.
// og.png et og-en.png (images de partage) sont les captures d'accueil française et anglaise des sources, sans réencodage.
// Une capture plus étroite que la plus grande largeur prévue (1120 px pour le launcher, 854 px pour le client) est refusée
// (« capture trop étroite ») et rien n'est remplacé : jamais d'agrandissement, jamais de largeur silencieusement manquante.
// Se lance avec Electron (encodeur WebP de Chromium) : aucune dépendance de plus. À refaire seulement quand une capture change.
// Captures du launcher : ATTACK_LANG=<fr|en> ATTACK_OFFLINE=<pseudo> ATTACK_ACCOUNT_TYPE=msa ATTACK_SKIN=<skin.png>
//   node scripts/screenshot.js <dossier> <.minecraft> <dossier de jeu> (voir docs/wiki/Developpement.md) : compte factice sans
//   mention « mode développeur », skin de test, chemins sans nom d'utilisateur.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'img');
const STAGING = path.join(ROOT, 'site', '.img-staging'); // même volume que OUT : les fichiers s'y déplacent par simple renommage
const MAX_BYTES = 150 * 1024;
const LAUNCHER_WIDTHS = [560, 1120];
const CLIENT_WIDTHS = [854];
// clé -> { widths, cropHeight? : hauteur gardée de la capture, en pixels du PNG source (le reste est coupé avant l'encodage) }
const KEYS = {
  'launcher-home': { widths: LAUNCHER_WIDTHS },
  'launcher-home-fabric': { widths: LAUNCHER_WIDTHS },
  'launcher-mods': { widths: LAUNCHER_WIDTHS },
  'launcher-mods-fabric': { widths: LAUNCHER_WIDTHS },
  'launcher-settings': { widths: LAUNCHER_WIDTHS },
  // Compte factice : le launcher affiche en bas un message d'erreur (jeton de renouvellement absent). On garde le haut de la page.
  'launcher-account': { widths: LAUNCHER_WIDTHS, cropHeight: 618 },
  'launcher-changelog': { widths: LAUNCHER_WIDTHS },
  'client-menu': { widths: CLIENT_WIDTHS },
  'client-search': { widths: CLIENT_WIDTHS },
  'client-favorites': { widths: CLIENT_WIDTHS },
  'client-hud-editor': { widths: CLIENT_WIDTHS },
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('pas un fichier PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Refuse une capture trop basse pour sa coupe ou plus étroite que la plus grande largeur prévue (jamais d'agrandissement). */
function checkSource(job, source) {
  if (job.cropHeight && job.cropHeight > source.height) throw new Error(`${job.origin} : ${source.height} px de haut, moins que la coupe prévue (${job.cropHeight} px). Rien n’a été modifié.`);
  const widest = Math.max(...job.widths);
  if (source.width < widest) throw new Error(`${job.origin} : capture trop étroite : ${source.width} px, minimum ${widest} px. Rien n’a été modifié.`);
}

/** Réduit/encode une image (en ne gardant que les `keepHeight` pixels du haut) dans une page Chromium cachée : WebP et qualité retenue. */
async function encode(win, png, width, height, keepHeight) {
  const code = `(async (base64, width, height, keepHeight, quality) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, bitmap.width, keepHeight, 0, 0, width, height);
    return canvas.toDataURL('image/webp', quality);
  })`;
  for (let quality = 0.86; quality >= 0.58; quality -= 0.04) {
    const url = await win.webContents.executeJavaScript(`(${code})(${JSON.stringify(png.toString('base64'))}, ${width}, ${height}, ${keepHeight}, ${quality.toFixed(2)})`);
    if (!url.startsWith('data:image/webp;base64,')) throw new Error('Chromium n’a pas produit de WebP');
    const webp = Buffer.from(url.slice('data:image/webp;base64,'.length), 'base64');
    if (webp.length <= MAX_BYTES) return { webp, quality: Number(quality.toFixed(2)) };
  }
  throw new Error(`image > ${MAX_BYTES / 1024} Ko même à la qualité minimale`);
}

async function run() {
  const sourcesDir = argValue('--sources') || process.env.SITE_IMAGES_SOURCES || '';
  if (!sourcesDir) {
    throw new Error('--sources <dossier> est obligatoire : le dossier de PNG <clé>-<fr|en>.png (ces PNG ne sont pas dans le dépôt). Rien n’a été modifié.');
  }
  if (!fs.existsSync(sourcesDir) || !fs.statSync(sourcesDir).isDirectory()) throw new Error(`Dossier de sources introuvable : ${sourcesDir}. Rien n’a été modifié.`);

  const jobs = [];
  for (const [key, spec] of Object.entries(KEYS)) {
    const found = [];
    for (const lang of ['fr', 'en']) {
      const file = path.resolve(sourcesDir, `${key}-${lang}.png`);
      if (fs.existsSync(file)) found.push({ key, lang, widths: spec.widths, cropHeight: spec.cropHeight, file, origin: `sources/${key}-${lang}.png` });
      else console.log(`absent : ${key} (${lang}) : le site reprendra l'autre langue`);
    }
    if (!found.length) throw new Error(`Aucune capture pour ${key} (ni -fr ni -en) dans ${sourcesDir}. Rien n’a été modifié.`);
    jobs.push(...found);
  }
  // toutes les captures sont contrôlées avant le premier encodage
  for (const job of jobs) checkSource(job, pngSize(fs.readFileSync(job.file)));

  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  try {
    const images = [];
    const og = {}; // langue -> PNG de l'accueil du launcher (images de partage)
    for (const job of jobs) {
      const png = fs.readFileSync(job.file);
      const source = pngSize(png);
      checkSource(job, source); // déjà fait plus haut ; refait au cas où le fichier aurait changé entre-temps
      const keepHeight = job.cropHeight || source.height;
      const sourceSha256 = crypto.createHash('sha256').update(png).digest('hex');
      for (const width of job.widths) {
        const height = Math.round((keepHeight * width) / source.width);
        const { webp, quality } = await encode(win, png, width, height, keepHeight);
        const file = `${job.key}-${job.lang}-${width}.webp`;
        fs.writeFileSync(path.join(STAGING, file), webp);
        const entry = { key: job.key, lang: job.lang, width, height, file, bytes: webp.length, quality, source: job.origin, sourceWidth: source.width, sourceHeight: source.height, sourceSha256 };
        if (job.cropHeight) entry.cropHeight = job.cropHeight;
        images.push(entry);
        console.log(`${file} : ${width}x${height}, ${(webp.length / 1024).toFixed(1)} Ko (qualité ${quality})`);
      }
      // images de partage (og:image) : l'accueil du launcher dans chaque langue, sans réencodage
      if (job.key === 'launcher-home') og[job.lang] = png;
    }
    const order = Object.keys(KEYS);
    images.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key) || a.lang.localeCompare(b.lang) || a.width - b.width);
    fs.writeFileSync(path.join(STAGING, 'manifest.json'), `${JSON.stringify({ images }, null, 2)}\n`);
    if (og.fr) fs.writeFileSync(path.join(STAGING, 'og.png'), og.fr);
    if (og.en) fs.writeFileSync(path.join(STAGING, 'og-en.png'), og.en);

    // tout est encodé : on remplace (les anciens WebP et le manifeste ne sont retirés qu'ici)
    fs.mkdirSync(OUT, { recursive: true });
    for (const file of fs.readdirSync(OUT)) if (file.endsWith('.webp') || file === 'manifest.json') fs.rmSync(path.join(OUT, file));
    for (const file of fs.readdirSync(STAGING)) fs.renameSync(path.join(STAGING, file), path.join(OUT, file));
    console.log(`${images.length} images, manifeste écrit dans ${path.relative(ROOT, path.join(OUT, 'manifest.json'))}${og.fr ? ', og.png remplacé' : ', og.png inchangé (pas de launcher-home-fr.png)'}${og.en ? ', og-en.png remplacé' : ', og-en.png inchangé (pas de launcher-home-en.png)'}`);
  } finally {
    fs.rmSync(STAGING, { recursive: true, force: true });
  }
}

// Lancé par Electron seulement (sous Electron, require.main n'est pas ce module : on teste process.versions.electron).
// Electron n'est chargé qu'ici : les tests lisent checkSource() avec Node seul (sans node_modules en CI).
if (process.versions.electron) {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(os.tmpdir(), 'attack-site-images')); // dossier fixe : pas de cache qui s'accumule
  app.whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
      console.error(`site-images : ${error.message}`);
      app.exit(1);
    });
}

module.exports = { KEYS, LAUNCHER_WIDTHS, CLIENT_WIDTHS, pngSize, checkSource };
