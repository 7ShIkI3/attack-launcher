'use strict';
// Comptes enregistrés (accounts.json dans le dossier de données de l'app).
// Le refresh token Microsoft est chiffré par `cipher` (safeStorage / DPAPI en production) ; le jeton Minecraft
// ne reste qu'en mémoire. list() ne renvoie jamais de jeton : c'est ce que voit l'interface.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** UUID hors ligne, calculé comme Minecraft : UUID v3 de « OfflinePlayer:<pseudo> », sans tirets. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

class AccountStore {
  /** cipher = { encrypt(string) -> Buffer, decrypt(Buffer) -> string } */
  constructor(file, cipher) {
    this.file = file;
    this.cipher = cipher;
    this.data = { version: 1, active: null, accounts: [] };
    this.minecraft = new Map(); // id -> { accessToken, expiresAt } (mémoire seulement)
  }

  async load() {
    if (!fs.existsSync(this.file)) return this;
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (Array.isArray(data.accounts)) this.data = { version: 1, active: data.active || null, accounts: data.accounts };
    } catch {
      // fichier abîmé : on repart d'une liste vide plutôt que de planter
    }
    return this;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** Vue publique, sans aucun jeton. */
  list() {
    return this.data.accounts.map((a) => ({
      id: a.id, name: a.name, type: a.type, skin: a.skin || null, active: a.id === this.data.active,
    }));
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  active() {
    return this.get(this.data.active);
  }

  /** Ajoute ou met à jour un compte Microsoft ; après une connexion (makeActive), il devient le compte actif. */
  async saveMicrosoft({ profile, minecraft, microsoft }, { skin = null, makeActive = true } = {}) {
    const existing = this.get(profile.id);
    const account = {
      id: profile.id,
      name: profile.name,
      type: 'msa',
      skin: skin ?? existing?.skin ?? null,
      refreshToken: this.cipher.encrypt(microsoft.refreshToken).toString('base64'),
      addedAt: existing?.addedAt || new Date().toISOString(),
    };
    this.data.accounts = [...this.data.accounts.filter((a) => a.id !== profile.id), account];
    if (makeActive || !this.data.active) this.data.active = profile.id;
    this.minecraft.set(profile.id, minecraft);
    await this.save();
    return account;
  }

  /** Compte hors ligne (mode développeur uniquement) : pseudo seul, jeton « 0 ». */
  async addOffline(name) {
    if (!NAME.test(name || '')) throw new Error('Pseudo invalide (3 à 16 caractères : lettres, chiffres, _)');
    const id = offlineUuid(name);
    this.data.accounts = [...this.data.accounts.filter((a) => a.id !== id), { id, name, type: 'offline', addedAt: new Date().toISOString() }];
    this.data.active = id;
    await this.save();
    return id;
  }

  async setActive(id) {
    if (!this.get(id)) throw new Error('Compte inconnu');
    this.data.active = id;
    await this.save();
  }

  async remove(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.minecraft.delete(id);
    if (this.data.active === id) this.data.active = this.data.accounts[0]?.id || null;
    await this.save();
  }

  /**
   * Identité pour lancer le jeu : { name, uuid, accessToken, userType }.
   * refresh(refreshToken) -> résultat de auth.refreshAccount ; appelé si le jeton Minecraft manque ou expire bientôt.
   */
  async launchIdentity(id, refresh, now = Date.now) {
    const account = this.get(id);
    if (!account) throw new Error('Aucun compte sélectionné');
    if (account.type === 'offline') return { name: account.name, uuid: account.id, accessToken: '0', userType: 'legacy' };
    let minecraft = this.minecraft.get(id);
    if (!minecraft || minecraft.expiresAt - now() < REFRESH_MARGIN_MS) {
      await this.refresh(id, refresh);
      minecraft = this.minecraft.get(id);
    }
    return { name: account.name, uuid: account.id, accessToken: minecraft.accessToken, userType: 'msa' };
  }

  /** Rafraîchit un compte Microsoft et enregistre le nouveau refresh token (chiffré). */
  async refresh(id, refresh) {
    const account = this.get(id);
    if (!account || account.type !== 'msa') return null;
    const refreshToken = this.cipher.decrypt(Buffer.from(account.refreshToken, 'base64'));
    const result = await refresh(refreshToken);
    if (result.profile.id !== id) throw new Error('Le compte Microsoft a changé de profil Minecraft');
    await this.saveMicrosoft(result, { makeActive: false });
    return result.profile;
  }
}

module.exports = { AccountStore, offlineUuid, NAME };
