'use strict';
// Réglages de départ dans l'options.txt de Minecraft (lignes « clé:valeur »), appliqués par ÉTAPES et une seule fois par dossier
// de jeu : le drapeau `gameOptions` du fichier d'état (tenu par installer.js) garde le numéro de la dernière étape faite.
//  - étape 1 (profils Fabric seulement) : réglages vidéo pour le PvP. Dossier neuf (pas d'options.txt) : on écrit les réglages de
//    départ, Minecraft complète le reste avec ses valeurs par défaut ; dossier existant : seules les deux valeurs par défaut de
//    Minecraft qui brident les FPS sont remplacées (VSync activée, limite à 120 FPS) ;
//  - étape 2 (tous les profils, 1.8.9 compris) : langue du launcher. Écrite à la création d'options.txt ; dans un options.txt
//    existant, seulement si la langue est encore celle par défaut de Minecraft (en_us) et que le launcher est en français.
// Tout autre choix du joueur, les autres lignes, leur ordre et leurs fins de ligne restent tels quels. Le fichier est lu et
// réécrit en latin1 : chaque octet revient identique, quel que soit l'encodage des lignes qu'on ne touche pas.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./http');

const FILE = 'options.txt';
/** Numéro de la dernière étape : valeur du drapeau `gameOptions` de l'état une fois tout appliqué. */
const VERSION = 2;
/** maxFps:260 = « illimité » dans Minecraft. */
const START_OPTIONS = { enableVsync: 'false', maxFps: '260', entityShadows: 'false', renderDistance: '10' };
/** Valeurs par défaut de Minecraft remplacées dans un options.txt existant : clé -> [valeur d'origine, valeur de départ]. */
const REPLACED = { enableVsync: ['true', START_OPTIONS.enableVsync], maxFps: ['120', START_OPTIONS.maxFps] };

/**
 * Valeur de `lang` pour la langue du launcher ('fr' ou 'en'), ou null : fr_fr / en_us depuis la 1.11, fr_FR / en_US en 1.8.9
 * (`legacy`).
 */
function langValue(lang, legacy = false) {
  if (lang !== 'fr' && lang !== 'en') return null;
  const value = lang === 'fr' ? 'fr_fr' : 'en_us';
  return legacy ? value.replace(/_(\w+)$/, (_, region) => `_${region.toUpperCase()}`) : value;
}

/**
 * Contenu d'un options.txt neuf (pas de clé `version` : Minecraft complète le reste).
 * options : { video (réglages de départ, vrai par défaut), lang ('fr' | 'en'), legacy (écriture 1.8.9) }.
 */
function startText({ video = true, lang = null, legacy = false } = {}) {
  const lines = video ? Object.entries(START_OPTIONS).map(([key, value]) => `${key}:${value}`) : [];
  const value = langValue(lang, legacy);
  if (value) lines.push(`lang:${value}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Remplace, dans le texte d'un options.txt, les valeurs par défaut de Minecraft (enableVsync:true, maxFps:120).
 * Renvoie { text, changed: [clés modifiées] } ; le texte est identique si le joueur a choisi autre chose.
 */
function migrate(text) {
  const changed = [];
  // les séparateurs sont gardés tels quels (CRLF ou LF, ligne par ligne) : seules les valeurs remplacées changent
  const parts = String(text).split(/(\r\n|\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = /^([^:]+):(.*)$/.exec(parts[i]);
    const rule = line && Object.hasOwn(REPLACED, line[1]) ? REPLACED[line[1]] : null;
    if (rule && line[2] === rule[0]) {
      parts[i] = `${line[1]}:${rule[1]}`;
      changed.push(line[1]);
    }
  }
  return { text: parts.join(''), changed };
}

/**
 * Étape 2 sur un options.txt existant : `lang:en_us` (la valeur par défaut de Minecraft, ou aucune ligne `lang`) devient la langue du
 * launcher, seulement quand elle est française ; une autre langue choisie par le joueur n'est jamais touchée.
 * Renvoie { text, changed: ['lang'] | [] }.
 */
function migrateLang(text, { lang, legacy = false } = {}) {
  const target = langValue(lang, legacy);
  if (lang !== 'fr' || !target) return { text: String(text), changed: [] };
  const parts = String(text).split(/(\r\n|\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = /^lang:(.*)$/.exec(parts[i]);
    if (!line) continue;
    if (line[1].trim().toLowerCase() !== 'en_us') return { text: String(text), changed: [] };
    parts[i] = `lang:${target}`;
    return { text: parts.join(''), changed: ['lang'] };
  }
  // pas de ligne `lang` : Minecraft utilise sa valeur par défaut (en_us)
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const body = String(text);
  return { text: `${body}${body === '' || body.endsWith('\n') ? '' : eol}lang:${target}${eol}`, changed: ['lang'] };
}

/**
 * Applique les étapes manquantes au dossier de jeu. options :
 *   from    dernière étape déjà appliquée (drapeau `gameOptions` de l'état, 0 par défaut) : une étape faite n'est jamais refaite
 *   video   étape 1 permise (profils Fabric ; vrai par défaut)
 *   lang    langue du launcher ('fr' | 'en') pour l'étape 2 ; absente : l'étape 2 ne fait rien
 *   legacy  options.txt de la 1.8.9 (fr_FR au lieu de fr_fr)
 * Ne lève jamais d'erreur (fichier illisible, verrouillé, disque plein) :
 * renvoie { action: 'created' | 'updated' | 'unchanged' | 'error', changed: [clés], error? } et l'appelant décide quoi en faire.
 */
async function apply(gameDir, { from = 0, video = true, lang = null, legacy = false } = {}) {
  const file = path.join(gameDir, FILE);
  const doVideo = video && from < 1;
  const doLang = from < 2 && Boolean(langValue(lang));
  try {
    let current = null;
    try {
      current = await fsp.readFile(file, 'latin1');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === null) {
      const text = startText({ video: doVideo, lang: doLang ? lang : null, legacy });
      if (text === '') return { action: 'unchanged', changed: [] };
      await writeFileAtomic(file, Buffer.from(text, 'latin1'));
      return { action: 'created', changed: [...(doVideo ? Object.keys(START_OPTIONS) : []), ...(doLang ? ['lang'] : [])] };
    }
    let text = current;
    const changed = [];
    if (doVideo) {
      const step = migrate(text);
      text = step.text;
      changed.push(...step.changed);
    }
    if (doLang) {
      const step = migrateLang(text, { lang, legacy });
      text = step.text;
      changed.push(...step.changed);
    }
    if (changed.length === 0) return { action: 'unchanged', changed };
    await writeFileAtomic(file, Buffer.from(text, 'latin1'));
    return { action: 'updated', changed };
  } catch (error) {
    return { action: 'error', changed: [], error: error.message };
  }
}

module.exports = { FILE, VERSION, START_OPTIONS, langValue, startText, migrate, migrateLang, apply };
