'use strict';
// Réglages vidéo de départ pour le PvP dans l'options.txt de Minecraft (lignes « clé:valeur »), appliqués UNE fois par
// dossier de jeu Fabric (le drapeau `gameOptions` du fichier d'état, tenu par installer.js, empêche de recommencer) :
//  - dossier neuf (pas d'options.txt) : on écrit les réglages de départ, Minecraft complète le reste avec ses valeurs par défaut ;
//  - dossier existant : seules les deux valeurs par défaut de Minecraft qui brident les FPS sont remplacées (VSync activée,
//    limite à 120 FPS) ; tout autre choix du joueur, les autres lignes, leur ordre et leurs fins de ligne restent tels quels.
// Le fichier est lu et réécrit en latin1 : chaque octet revient identique, quel que soit l'encodage des lignes qu'on ne touche pas.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./http');

const FILE = 'options.txt';
/** Numéro du jeu de réglages de départ : valeur du drapeau `gameOptions` de l'état une fois appliqué. */
const VERSION = 1;
/** maxFps:260 = « illimité » dans Minecraft. */
const START_OPTIONS = { enableVsync: 'false', maxFps: '260', entityShadows: 'false', renderDistance: '10' };
/** Valeurs par défaut de Minecraft remplacées dans un options.txt existant : clé -> [valeur d'origine, valeur de départ]. */
const REPLACED = { enableVsync: ['true', START_OPTIONS.enableVsync], maxFps: ['120', START_OPTIONS.maxFps] };

/** Contenu d'un options.txt neuf (pas de clé `version` : Minecraft complète le reste). */
function startText() {
  return `${Object.entries(START_OPTIONS).map(([key, value]) => `${key}:${value}`).join('\n')}\n`;
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
 * Applique les réglages de départ au dossier de jeu. Ne lève jamais d'erreur (fichier illisible, verrouillé, disque plein) :
 * renvoie { action: 'created' | 'updated' | 'unchanged' | 'error', changed: [clés], error? } et l'appelant décide quoi en faire.
 */
async function apply(gameDir) {
  const file = path.join(gameDir, FILE);
  try {
    let current = null;
    try {
      current = await fsp.readFile(file, 'latin1');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === null) {
      await writeFileAtomic(file, Buffer.from(startText(), 'latin1'));
      return { action: 'created', changed: Object.keys(START_OPTIONS) };
    }
    const { text, changed } = migrate(current);
    if (changed.length === 0) return { action: 'unchanged', changed };
    await writeFileAtomic(file, Buffer.from(text, 'latin1'));
    return { action: 'updated', changed };
  } catch (error) {
    return { action: 'error', changed: [], error: error.message };
  }
}

module.exports = { FILE, VERSION, START_OPTIONS, startText, migrate, apply };
