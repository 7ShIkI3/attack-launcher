'use strict';
// Assistant OptiFine : surveille le dossier Téléchargements pendant que le joueur télécharge LUI-MÊME OptiFine 1.8.9 sur optifine.net
// (sa licence interdit au launcher de le redistribuer ou de le récupérer à sa place), puis le valide et le range en copie privée.
// Module en Node pur : ni Electron, ni accès réseau, aucun « shell ». Dossier, validation, import, horloge et minuteries sont injectables,
// pour que les tests tournent dans un dossier temporaire avec de fausses minuteries.
//
// Déroulé :
//  - start()  : un seul guetteur à la fois. Premier sondage = état de départ ; un jar déjà présent (et valide) est PROPOSÉ (état « seen »),
//               jamais importé sans clic sur « Utiliser ce fichier » (use()).
//  - sondage toutes les secondes pendant 10 minutes (« Attendre encore » = start() à nouveau). Un jar NOUVEAU (ou modifié) dont le nom est
//               accepté et qui est stable sur deux sondages est validé (optifine.validate), puis importé : « imported » ou « refused ».
//  - cancel() / fin du délai / fermeture de l'app (dispose) : toutes les minuteries sont arrêtées.
const fsp = require('node:fs/promises');
const path = require('node:path');
const optifine = require('./optifine');

const POLL_MS = 1000;
const TIMEOUT_MS = 10 * 60 * 1000;
/** Nom accepté une fois le suffixe « (n) » du navigateur retiré : OptiFine_1.8.9_HD_U_M5.jar, preview_OptiFine_1.8.9_HD_U_M6_pre2.jar… */
const ACCEPTED_NAME = /^(preview_)?optifine[_-]1\.8\.9[_-][\w.+-]+\.jar$/i;
/** Fichiers temporaires des navigateurs : jamais pris pour un jar fini. */
const TEMPORARY = /\.(crdownload|part|tmp)$/i;

/** Ce nom désigne-t-il un OptiFine 1.8.9 (hors fichier temporaire) ? */
function acceptedName(name) {
  const text = String(name);
  return !TEMPORARY.test(text) && ACCEPTED_NAME.test(optifine.stripCopySuffix(text));
}

const signature = (candidate) => `${candidate.size}:${candidate.mtimeMs}`;
const newestFirst = (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);

/**
 * options : { dir (chaîne ou fonction), importFile(file, checked) -> Promise, onState(état), validate, setTimer, clearTimer, fsApi,
 *             pollMs, timeoutMs }. Renvoie { start, use, cancel, dispose, snapshot, whenIdle }.
 * Les états émis : { state, downloadsDir, file?, version?, reason?, message? } avec state = waiting | seen | checking | imported |
 * refused | timeout | cancelled | error (et « idle » avant le premier start). `file` est un nom de fichier, jamais un chemin.
 */
function createWatcher(options) {
  const {
    importFile,
    onState = () => {},
    validate = optifine.validate,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    fsApi = fsp,
    pollMs = POLL_MS,
    timeoutMs = TIMEOUT_MS,
  } = options;
  const dirOf = typeof options.dir === 'function' ? options.dir : () => options.dir;

  let run = 0; // numéro de la surveillance en cours : toute suite asynchrone d'une surveillance finie est abandonnée
  let active = false;
  let busy = false; // validation ou import en cours
  let pollTimer = null;
  let deadlineTimer = null;
  let baseline = null; // Map nom -> signature des jars présents au départ
  let lastSeen = new Map(); // nom -> signature vue au sondage précédent (stabilité sur deux sondages)
  let proposal = null; // jar déjà présent au départ, proposé : { file, name, version }
  let inflight = Promise.resolve();
  let current = { state: 'idle', downloadsDir: dirOf() };

  function emit(state, extra = {}) {
    current = { state, downloadsDir: dirOf(), ...extra };
    try {
      onState({ ...current });
    } catch {
      // un écouteur qui échoue ne doit jamais arrêter la surveillance
    }
  }

  function clearTimers() {
    if (pollTimer !== null) clearTimer(pollTimer);
    if (deadlineTimer !== null) clearTimer(deadlineTimer);
    pollTimer = null;
    deadlineTimer = null;
  }

  /** Fin de surveillance : minuteries arrêtées, état final publié. */
  function finish(state, extra) {
    run += 1;
    active = false;
    busy = false;
    proposal = null;
    clearTimers();
    emit(state, extra);
    return true;
  }

  const timer = (fn, ms) => {
    const handle = setTimer(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref(); // une minuterie d'assistant ne retient jamais l'application
    return handle;
  };

  function schedule(id) {
    if (id !== run || !active) return;
    pollTimer = timer(() => {
      pollTimer = null;
      inflight = poll(id);
    }, pollMs);
  }

  function expire(id) {
    if (id !== run || !active) return;
    if (busy) {
      deadlineTimer = timer(() => expire(id), pollMs); // une validation est en cours : on la laisse finir
      return;
    }
    deadlineTimer = null;
    finish('timeout');
  }

  /** Jar candidat d'un nom du dossier, ou null : nom refusé, temporaire, vide, trop gros, `.part` voisin, ou pas un fichier ordinaire. */
  async function candidate(dir, name, lowerNames) {
    if (!acceptedName(name)) return null;
    if (lowerNames.has(`${name}.part`.toLowerCase())) return null; // Firefox : le téléchargement n'est pas fini
    let stat;
    try {
      stat = await fsApi.lstat(path.join(dir, name)); // lstat : un lien n'est jamais suivi
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > optifine.MAX_JAR) return null;
    return { name, file: path.join(dir, name), size: stat.size, mtimeMs: stat.mtimeMs };
  }

  /** Validation (par optifine.validate) puis import ; publie l'état final. Renvoie true quand la surveillance est terminée. */
  async function checkAndImport(id, name, file) {
    busy = true;
    proposal = null;
    emit('checking', { file: name });
    try {
      const checked = await validate(file);
      if (id !== run) return true;
      if (!checked.ok) return finish('refused', { file: name, reason: checked.reason, message: checked.message });
      const copy = await importFile(file, checked);
      if (id !== run) return true;
      return finish('imported', { file: name, version: (copy && copy.version) || checked.version || undefined });
    } catch (error) {
      if (id !== run) return true;
      // l'import revalide le jar : un refus à ce moment-là est un refus comme un autre
      if (error && error.reason) return finish('refused', { file: name, reason: error.reason, message: error.message });
      return finish('error', { file: name, reason: (error && error.code) || 'ERROR', message: String((error && error.message) || error) });
    } finally {
      if (id === run) busy = false;
    }
  }

  /** Premier sondage : le jar valide le plus récent déjà présent est proposé (jamais importé sans clic). */
  async function proposeExisting(id, existing) {
    for (const item of [...existing].sort(newestFirst)) {
      const checked = await validate(item.file);
      if (id !== run) return;
      if (checked.ok) {
        proposal = { file: item.file, name: item.name, version: checked.version };
        emit('seen', { file: item.name, version: checked.version || undefined });
        return;
      }
    }
  }

  async function poll(id) {
    if (id !== run || !active) return;
    if (busy) {
      schedule(id); // « Utiliser ce fichier » est en cours : ce sondage n'apporterait rien
      return;
    }
    const dir = dirOf();
    let names = null;
    try {
      names = await fsApi.readdir(dir);
    } catch (error) {
      // dossier illisible dès le départ : inutile d'attendre ; plus tard (dossier déplacé, OneDrive) on réessaie au sondage suivant
      if (baseline === null) {
        finish('error', { reason: 'DIR_UNREADABLE', message: String((error && error.message) || error) });
        return;
      }
    }
    if (id !== run) return;
    if (names !== null) {
      const lowerNames = new Set(names.map((n) => String(n).toLowerCase()));
      const found = [];
      for (const name of names) {
        const item = await candidate(dir, String(name), lowerNames);
        if (item) found.push(item);
      }
      if (id !== run) return;
      if (baseline === null) {
        baseline = new Map(found.map((c) => [c.name, signature(c)]));
        await proposeExisting(id, found);
        if (id !== run) return;
      } else {
        const fresh = found.filter((c) => baseline.get(c.name) !== signature(c));
        const stable = fresh.filter((c) => lastSeen.get(c.name) === signature(c)).sort(newestFirst);
        lastSeen = new Map(fresh.map((c) => [c.name, signature(c)]));
        // le premier jar stable met fin à la surveillance (importé, refusé ou en erreur) ; un clic sur « Utiliser » en cours : on attend
        if (stable.length > 0 && !busy) {
          await checkAndImport(id, stable[0].name, stable[0].file);
          return;
        }
      }
    }
    schedule(id);
  }

  /**
   * Lance la surveillance (un seul guetteur : déjà en cours = rien de plus, l'état courant est renvoyé). Attend le premier sondage,
   * donc le jar déjà présent éventuel est connu au retour. Renvoie l'état courant.
   */
  async function start() {
    if (active) return { ...current };
    run += 1;
    const id = run;
    active = true;
    busy = false;
    baseline = null;
    lastSeen = new Map();
    proposal = null;
    emit('waiting');
    deadlineTimer = timer(() => expire(id), timeoutMs);
    inflight = poll(id);
    await inflight;
    return { ...current };
  }

  /** « Utiliser ce fichier » : importe le jar proposé (présent avant le départ). Renvoie { ok, ...état } ; NO_FILE sans proposition. */
  async function use() {
    if (!active || !proposal || busy) return { ok: false, code: 'NO_FILE', ...current };
    const { name, file } = proposal;
    await checkAndImport(run, name, file);
    return { ok: current.state === 'imported', ...current };
  }

  /** Arrête la surveillance en cours (état « cancelled ») ; sans surveillance, ne change rien. */
  function cancel() {
    if (active) finish('cancelled');
    return { ...current };
  }

  /** Fermeture de l'application : toutes les minuteries sont arrêtées, sans rien publier. */
  function dispose() {
    run += 1;
    active = false;
    busy = false;
    proposal = null;
    clearTimers();
  }

  return { start, use, cancel, dispose, snapshot: () => ({ ...current }), whenIdle: () => inflight, isActive: () => active };
}

module.exports = { POLL_MS, TIMEOUT_MS, ACCEPTED_NAME, acceptedName, createWatcher };
