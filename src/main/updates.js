'use strict';
// Mise à jour du launcher par les releases GitHub du dépôt (electron-updater) : comparaison de versions,
// choix NSIS (téléchargement en arrière-plan puis installation au redémarrage) ou portable (simple avis),
// et contrôleur qui ne fait rien pendant une partie ou une installation. Sans Electron : testable avec Node seul.
const fs = require('node:fs');
const path = require('node:path');
const { GITHUB_REPO } = require('./constants');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Nouvel essai quand une partie ou une installation a fait reporter la vérification. */
const BUSY_RETRY_MS = 10 * 60 * 1000;
/** Adresse fixe : on n'ouvre jamais un lien fourni par le serveur de mise à jour. */
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

/** Ordre semver : -1, 0 ou 1. Une préversion (0.3.0-beta.1) passe avant la version finale. Version illisible : erreur. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Version illisible : ${x ? b : a}`);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) return Number(p) < Number(q) ? -1 : 1;
    if (pNum !== qNum) return pNum ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Vrai si `candidate` est strictement plus récente que `current` ; faux pour une version illisible. */
function isNewer(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

/**
 * Façon de se mettre à jour :
 * - 'nsis' : installé par Setup.exe (désinstalleur à côté de l'exe) → téléchargement puis installation au redémarrage ;
 * - 'portable' : exe portable, ou copie non installée → simple avis avec un lien vers la page Releases ;
 * - 'off' : lancé depuis les sources (npm start) ou hors Windows.
 */
function updateMode({ isPackaged, platform = process.platform, env = process.env, execPath = process.execPath, listDir = fs.readdirSync } = {}) {
  if (!isPackaged || platform !== 'win32') return 'off';
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  try {
    if (listDir(path.win32.dirname(execPath)).some((name) => /^Uninstall .+\.exe$/i.test(name))) return 'nsis';
  } catch {
    // dossier illisible : on se contente de prévenir
  }
  return 'portable';
}

/**
 * Pilote electron-updater. Phases envoyées à la page : off, idle, waiting (reportée), checking, none (à jour),
 * downloading, ready (NSIS : prête à installer), available (portable : à télécharger soi-même), error.
 *
 * options : { updater, mode, currentVersion, busy, onState, log, createToken, timers }
 * - updater : autoUpdater d'electron-updater (un faux dans les tests) ;
 * - busy() : Promise<'game' | 'install' | null>, la raison de ne rien faire maintenant ;
 * - createToken() : jeton d'annulation du téléchargement (CancellationToken d'electron-updater).
 */
class UpdateController {
  constructor({ updater, mode, currentVersion, busy = async () => null, onState = () => {}, log = () => {}, createToken, timers = globalThis }) {
    this.updater = updater;
    this.mode = mode;
    this.currentVersion = currentVersion;
    this.busy = busy;
    this.onState = onState;
    this.log = log;
    this.createToken = createToken;
    this.timers = timers;
    this.state = { phase: mode === 'off' ? 'off' : 'idle', mode, version: null, percent: 0, url: RELEASES_URL };
    this.checking = false;
    this.token = null;
    this.retry = null;
    this.interval = null;
    this.quitChecked = false;
    this.installing = false;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  /** Vérifie tout de suite, puis toutes les 6 h. */
  start() {
    if (this.mode === 'off') {
      this.log('Mises à jour désactivées (lancement depuis les sources ou hors Windows)');
      return;
    }
    const u = this.updater;
    u.autoDownload = false; // téléchargement lancé par nous, seulement quand rien ne tourne
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    u.allowPrerelease = false;
    u.disableWebInstaller = true;
    u.on('download-progress', (progress) => {
      const percent = Math.floor(progress.percent || 0);
      if (this.state.phase === 'downloading' && percent !== this.state.percent) this.setState({ percent });
    });
    this.log(`Launcher ${this.currentVersion}, mode ${this.mode}`);
    this.check();
    this.interval = this.timers.setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop() {
    this.timers.clearInterval(this.interval);
    this.timers.clearTimeout(this.retry);
    this.token?.cancel();
  }

  /** Reporte la vérification (partie ou installation en cours) et réessaie plus tard. */
  defer(reason) {
    this.log(`Mise à jour reportée : ${reason === 'game' ? 'partie en cours' : 'installation en cours'}`);
    this.timers.clearTimeout(this.retry);
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      this.check();
    }, BUSY_RETRY_MS);
    if (!['available', 'ready'].includes(this.state.phase)) this.setState({ phase: 'waiting' });
  }

  async check() {
    if (this.mode === 'off' || this.checking || this.state.phase === 'ready') return this.state;
    this.checking = true;
    try {
      const reason = await this.busy();
      if (reason) {
        this.defer(reason);
        return this.state;
      }
      this.setState({ phase: 'checking' });
      const result = await this.updater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!version || !isNewer(version, this.currentVersion)) {
        this.log(`À jour (dernière version publiée : ${version || 'inconnue'})`);
        this.setState({ phase: 'none', version: null });
      } else if (this.mode === 'portable') {
        this.log(`Version ${version} disponible (portable : téléchargement manuel)`);
        this.setState({ phase: 'available', version });
      } else {
        await this.download(version);
      }
    } catch (error) {
      this.log(`Échec de la mise à jour : ${error.message}`);
      this.setState({ phase: 'error', message: error.message });
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  /** Téléchargement en arrière-plan ; electron-updater vérifie le SHA-512 annoncé dans latest.yml. */
  async download(version) {
    const reason = await this.busy();
    if (reason) {
      this.defer(reason);
      return;
    }
    const token = this.createToken();
    this.token = token;
    this.log(`Téléchargement de la version ${version}`);
    this.setState({ phase: 'downloading', version, percent: 0 });
    try {
      await this.updater.downloadUpdate(token);
    } catch (error) {
      if (!token?.cancelled) throw error;
      this.log('Téléchargement interrompu (partie ou installation lancée)');
      this.setState({ phase: this.retry ? 'waiting' : 'idle', version: null, percent: 0 });
      return;
    } finally {
      this.token = null;
    }
    this.log(`Mise à jour ${version} prête`);
    this.setState({ phase: 'ready', version, percent: 100 });
  }

  /** Une installation ou une partie démarre : on coupe le téléchargement et on réessaiera plus tard. */
  activityStarted(reason) {
    if (this.mode === 'off') return;
    if (this.token) this.token.cancel();
    if (this.state.phase !== 'ready') this.defer(reason);
  }

  /** L'activité est finie : la vérification reportée repart tout de suite. */
  activityEnded() {
    if (this.mode === 'off' || !this.retry) return;
    this.timers.clearTimeout(this.retry);
    this.retry = null;
    this.check();
  }

  /** Bouton « Redémarrer » : installe la mise à jour prête (installation silencieuse puis relance). */
  async install() {
    if (this.mode !== 'nsis' || this.state.phase !== 'ready') return { ok: false, code: 'NO_UPDATE' };
    const reason = await this.busy();
    if (reason) return { ok: false, code: reason === 'game' ? 'GAME_RUNNING' : 'BUSY' };
    this.installing = true;
    this.log(`Redémarrage pour installer la version ${this.state.version}`);
    this.updater.quitAndInstall(true, true);
    return { ok: true };
  }

  /** Vrai si la fermeture doit attendre prepareQuit() (mise à jour prête, pas encore décidée). */
  needsQuitCheck() {
    return this.mode === 'nsis' && this.state.phase === 'ready' && !this.installing && !this.quitChecked;
  }

  /** À la fermeture : n'installe la mise à jour prête que si aucune partie ni installation ne tourne. */
  async prepareQuit() {
    this.quitChecked = true;
    const reason = await this.busy();
    this.updater.autoInstallOnAppQuit = !reason;
    this.log(reason ? 'Fermeture pendant une partie : installation au prochain démarrage' : 'Installation de la mise à jour à la fermeture');
  }
}

module.exports = { CHECK_INTERVAL_MS, BUSY_RETRY_MS, RELEASES_URL, parseVersion, compareVersions, isNewer, updateMode, UpdateController };
