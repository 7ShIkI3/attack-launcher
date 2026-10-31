'use strict';
// Renommage qui réessaie : sous Windows, l'antivirus ou OneDrive ouvrent souvent un fichier tout juste écrit.
// Module à part (sans aucun accès réseau) pour que optifine.js et optifine-watch.js n'importent jamais http.js.
const fsp = require('node:fs/promises');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renommage qui réessaie quelques fois quand le fichier est momentanément verrouillé (EPERM, EBUSY, EACCES). */
async function renameRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await wait(50 * 2 ** Math.min(attempt, 3));
    }
  }
}

module.exports = { renameRetry };
