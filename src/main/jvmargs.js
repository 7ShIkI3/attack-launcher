'use strict';
// Arguments Java ajoutés par le joueur (Réglages, un champ par profil). Ils passent après DEFAULT_JVM_ARGS : pour la JVM,
// la dernière valeur d'une option l'emporte.
// Liste d'AUTORISATION, pas de refus : beaucoup d'options chargent du code (-javaagent, -Xbootclasspath,
// -Dfabric.addMods...), relisent un fichier d'options (-XX:VMOptionsFile), écrivent des fichiers (-XX:ErrorFile) ou
// détournent la connexion (-Dminecraft.api.session.host enverrait le jeton ailleurs). Un tutoriel piégé ne doit pas
// pouvoir faire coller une de ces options. On accepte donc seulement :
//   -Xms / -Xss / -Xmn <taille> ;
//   -XX:+Nom, -XX:-Nom, -XX:Nom=valeur simple (lettres, chiffres, . , + -), sauf les options qui lancent une
//   commande, lisent ou écrivent un fichier, ou règlent la mémoire maximale (curseur Mémoire allouée) ;
//   quelques -D sans risque (rendu Java2D, encodage, langue, IPv4).

const MAX_LENGTH = 1000;
const MAX_ARGS = 40;

const SIZE = /^-X(ms|ss|mn)\d+[kKmMgG]?$/;
const XX = /^-XX:(?:[+-]([A-Za-z][A-Za-z0-9]*)|([A-Za-z][A-Za-z0-9]*)=([\w.,+-]+))$/;
// options -XX refusées même avec une valeur simple (un vidage mémoire écrirait aussi le jeton Minecraft sur le disque)
const XX_REFUSED = /^(OnError|OnOutOfMemoryError|VMOptionsFile|Flags|CompileCommand|CompileOnly|CompileCommandFile|CompilerDirectivesFile|StartFlightRecording|FlightRecorderOptions|SharedArchiveFile|ArchiveClassesAtExit|MaxRAM|MaxRAMPercentage|MaxRAMFraction|MaxHeapSize|EnableDynamicAgentLoading)$|File|Path|Dir|HeapDump/;
const PROPERTY = /^-D([\w.]+)=([\w.,+-]*)$/;
const PROPERTIES = /^(sun\.java2d\.\w+|file\.encoding|sun\.jnu\.encoding|user\.language|user\.country|java\.net\.preferIPv4Stack)$/;

/** Raison du refus d'un argument, ou null s'il est accepté. */
function refusal(arg) {
  if (/^-Xmx/i.test(arg)) return 'la mémoire se règle avec le curseur Mémoire allouée';
  if (SIZE.test(arg)) return null;
  const xx = XX.exec(arg);
  if (xx) {
    const name = xx[1] || xx[2];
    if (/^(MaxRAM|MaxHeapSize)/.test(name)) return 'la mémoire se règle avec le curseur Mémoire allouée';
    return XX_REFUSED.test(name) ? 'cette option lance une commande ou lit ou écrit un fichier' : null;
  }
  if (arg.startsWith('-XX:')) return 'valeur non autorisée (lettres, chiffres et . , + - seulement, pas de chemin)';
  const property = PROPERTY.exec(arg);
  if (property && PROPERTIES.test(property[1])) return null;
  if (arg.startsWith('-D')) return 'propriété non autorisée (seules sun.java2d.*, file.encoding, user.language, user.country, java.net.preferIPv4Stack)';
  return 'option non autorisée (seules -Xms, -Xss, -Xmn, -XX:… et quelques -D sont acceptées)';
}

/**
 * Lit le texte du champ. Renvoie { ok: true, args } ou { ok: false, arg, reason }.
 * Les arguments sont séparés par des espaces (pas de guillemets) ; texte vide = aucun argument.
 */
function parseJvmArgs(text) {
  if (text == null) return { ok: true, args: [] };
  if (typeof text !== 'string') return { ok: false, arg: '', reason: 'texte attendu' };
  if (text.length > MAX_LENGTH) return { ok: false, arg: '', reason: `${MAX_LENGTH} caractères au plus` };
  const args = text.split(/\s+/).filter(Boolean);
  if (args.length > MAX_ARGS) return { ok: false, arg: '', reason: `${MAX_ARGS} arguments au plus` };
  for (const arg of args) {
    const reason = refusal(arg);
    if (reason) return { ok: false, arg, reason };
  }
  return { ok: true, args };
}

/** Texte normalisé (espaces simples) d'une valeur valide, sinon null. */
function normalize(text) {
  const parsed = parseJvmArgs(text);
  return parsed.ok ? parsed.args.join(' ') : null;
}

/** Message d'erreur lisible pour l'interface. */
function describe(result) {
  return result.arg ? `Argument Java refusé (${result.arg.slice(0, 60)}) : ${result.reason}` : `Arguments Java refusés : ${result.reason}`;
}

/** Arguments à ajouter pour une valeur enregistrée ; une valeur devenue invalide n'ajoute rien. */
function argsOf(text) {
  const parsed = parseJvmArgs(text);
  return parsed.ok ? parsed.args : [];
}

// Un seul ramasse-miettes à la fois : « -XX:+UseG1GC -XX:+UseZGC » empêche la JVM de démarrer (Multiple garbage
// collectors selected). Si le joueur en choisit un autre, les options G1 par défaut sont retirées.
const OTHER_GC = /^-XX:\+Use(ZGC|ShenandoahGC|ParallelGC|ParallelOldGC|SerialGC|ConcMarkSweepGC|EpsilonGC)$/;
const G1_OPTION = /^-XX:(\+UseG1GC|G1\w+=|MaxGCPauseMillis=)/;

/** Arguments par défaut (`defaults`, texte) à utiliser avec les arguments `extra` (liste) du joueur. */
function baseArgs(defaults, extra) {
  const args = defaults.split(/\s+/).filter(Boolean);
  return extra.some((arg) => OTHER_GC.test(arg)) ? args.filter((arg) => !G1_OPTION.test(arg)) : args;
}

/**
 * Arguments du joueur que le launcher a écrits dans `javaArgs` (profil du launcher officiel), ou null :
 * `javaArgs` (sans -Xmx) = arguments par défaut adaptés + des arguments valides. Sert à les retirer quand le champ est vidé
 * sans toucher aux arguments modifiés à la main dans le launcher officiel.
 */
function writtenExtra(defaults, javaArgs) {
  const tokens = String(javaArgs || '').split(/\s+/).filter((a) => a && !/^-Xmx\d+[kKmMgG]?$/.test(a));
  for (const base of [baseArgs(defaults, []), baseArgs(defaults, ['-XX:+UseZGC'])]) {
    const rest = tokens.slice(base.length);
    if (rest.length === 0 || base.some((arg, i) => tokens[i] !== arg)) continue;
    const parsed = parseJvmArgs(rest.join(' '));
    if (parsed.ok && baseArgs(defaults, rest).join(' ') === base.join(' ')) return rest;
  }
  return null;
}

module.exports = { MAX_LENGTH, MAX_ARGS, parseJvmArgs, normalize, describe, argsOf, baseArgs, writtenExtra };
