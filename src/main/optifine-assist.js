'use strict';
// Assistants OptiFine du processus principal : UN guetteur par profil (optifine-watch.js), créé au premier « Obtenir OptiFine » de ce profil.
// Module en Node pur : ni Electron ni catalogue ; tout ce qui vient de l'extérieur est injecté, pour que les tests tournent sans rien
// d'autre qu'un dossier temporaire.
//
// Pourquoi un guetteur par profil : le dossier Téléchargements est partagé, et chaque profil attend SON OptiFine (1.8.9, 1.7.10). Le
// guetteur d'un profil ne retient que les noms de sa version de Minecraft, valide pour sa version, et son import écrit dans les
// réglages de SON profil, quel que soit le profil affiché au moment où le jar arrive. L'identifiant du profil et sa version de
// Minecraft sont capturés à la création du guetteur : un changement de profil dans la page n'y change rien.
//
// Contrat vers la page (événement `optifine:assist` et réponses de start / use / cancel) :
//   { profileId, mc, state, downloadsDir, file?, version?, reason?, message?, foreign? }   (voir optifine-watch.js pour `state`)
// Refus : { ok: false, code: 'NO_OPTIFINE', message, profileId } quand `profileId` n'est pas un profil connu qui a OptiFine.
const optifineWatch = require('./optifine-watch');

/** Réponse quand le profil demandé n'existe pas ou n'a pas OptiFine (profil Fabric, identifiant inventé, absent). */
function noOptifine(profileId) {
  return { ok: false, code: 'NO_OPTIFINE', message: "OptiFine : ce profil n'a pas OptiFine.", profileId: typeof profileId === 'string' ? profileId : null };
}

/**
 * options :
 *   resolveProfile(profileId) -> { id, mc } | null   profil connu ET avec OptiFine, sinon null (réponse NO_OPTIFINE)
 *   dir                                              dossier Téléchargements (chaîne ou fonction)
 *   importCopy(file, mc) -> Promise<copie>           copie privée validée pour cette version (optifine.importCopy)
 *   saveChoice(profileId, copie) -> Promise          range la copie dans les réglages de CE profil (optifineJar, optifine: true)
 *   emit(état)                                       envoie `optifine:assist` à la page
 *   openPage() -> boolean                            ouvre optifine.net chez le joueur (une fois par attente)
 *   createWatcher                                    fabrique de guetteurs (injectable pour les essais)
 *   watcherOptions                                   options ajoutées à chaque guetteur (horloge factice, fsApi…)
 * Renvoie { start, use, cancel, isActive, snapshot, dispose, size }.
 */
function createAssistRegistry(options) {
  const {
    resolveProfile, dir, importCopy, saveChoice, emit = () => {}, openPage = () => false,
    createWatcher = optifineWatch.createWatcher, watcherOptions = {},
  } = options;
  const watchers = new Map(); // identifiant du profil -> { watcher, mc }

  const tag = (target, extra = {}) => ({ ...extra, profileId: target.id, mc: target.mc });

  /** Guetteur du profil, créé à la demande avec l'identifiant et la version capturés maintenant. */
  function watcherFor(target) {
    let entry = watchers.get(target.id);
    if (!entry) {
      const { id, mc } = target;
      const watcher = createWatcher({
        ...watcherOptions,
        mc,
        dir,
        onState: (state) => emit(tag(target, state)),
        importFile: async (file) => {
          const copy = await importCopy(file, mc);
          await saveChoice(id, copy);
          return copy;
        },
      });
      entry = { watcher, mc };
      watchers.set(id, entry);
    }
    return entry.watcher;
  }

  /** Lance la surveillance de ce profil (déjà en cours : l'état courant est renvoyé) ; ouvre optifine.net au premier lancement. */
  async function start(profileId, startOptions) {
    const target = resolveProfile(profileId);
    if (!target) return noOptifine(profileId);
    const watcher = watcherFor(target);
    const first = !watcher.isActive();
    const state = await watcher.start(); // l'état de départ est lu AVANT d'ouvrir la page : un jar déjà présent est proposé, pas importé
    if (first && !(startOptions && startOptions.browser === false)) openPage();
    return tag(target, { ok: true, ...state });
  }

  /** « Utiliser ce fichier » : importe le jar proposé par le guetteur de ce profil (NO_FILE sans guetteur ni proposition). */
  async function use(profileId) {
    const target = resolveProfile(profileId);
    if (!target) return noOptifine(profileId);
    const entry = watchers.get(target.id);
    if (!entry) return tag(target, { ok: false, code: 'NO_FILE', state: 'idle' });
    return tag(target, await entry.watcher.use());
  }

  /** Arrête la surveillance de ce profil ; sans guetteur, rien à arrêter. */
  function cancel(profileId) {
    const target = resolveProfile(profileId);
    if (!target) return noOptifine(profileId);
    const entry = watchers.get(target.id);
    return tag(target, { ok: true, ...(entry ? entry.watcher.cancel() : { state: 'idle' }) });
  }

  const isActive = (profileId) => Boolean(watchers.get(profileId)?.watcher.isActive());
  const snapshot = (profileId) => {
    const entry = watchers.get(profileId);
    return entry ? { profileId, mc: entry.mc, ...entry.watcher.snapshot() } : null;
  };

  /** Fermeture de l'application : toutes les minuteries de tous les guetteurs sont arrêtées, sans rien publier. */
  function dispose() {
    for (const { watcher } of watchers.values()) watcher.dispose();
  }

  return { start, use, cancel, isActive, snapshot, dispose, size: () => watchers.size };
}

module.exports = { createAssistRegistry, noOptifine };
