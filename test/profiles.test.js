'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const profiles = require('../src/main/profiles');
const C = require('../src/main/constants');

const NOW = new Date('2026-10-17T12:00:00.000Z');
const OPTIONS = { gameDir: 'C:\\Users\\x\\AppData\\Roaming\\.attack', ramMb: 3072, javaPath: '', icon: 'data:image/png;base64,AAAA', now: NOW };

const EXISTING = {
  profiles: {
    pvp: { name: 'pvp', type: 'custom', lastVersionId: '1.8.9', icon: 'Furnace' },
    fabric: { name: 'fabric', type: 'custom', javaArgs: '-Xmx4G -XX:+UseG1GC' },
  },
  settings: { keepLauncherOpen: true, profileSorting: 'ByLastPlayed' },
  version: 3,
};

test('-Xmx remplacé ou ajouté, autres arguments conservés', () => {
  assert.equal(profiles.withXmx('-Xmx4G -XX:+UseG1GC', 2048), '-Xmx2048M -XX:+UseG1GC');
  assert.equal(profiles.withXmx('-Xms1G -Xmx1024m', 3072), '-Xmx3072M -Xms1G');
  assert.match(profiles.withXmx(undefined, 2048), /^-Xmx2048M -XX:\+UnlockExperimentalVMOptions/);
});

test('fusion : profil ATTACK ajouté, le reste intact', () => {
  const merged = profiles.mergeProfile(EXISTING, OPTIONS);
  assert.deepEqual(merged.profiles.pvp, EXISTING.profiles.pvp);
  assert.deepEqual(merged.profiles.fabric, EXISTING.profiles.fabric);
  assert.deepEqual(merged.settings, EXISTING.settings);
  assert.deepEqual(merged.profiles[C.PROFILE_ID], {
    name: 'ATTACK Client',
    type: 'custom',
    lastVersionId: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
    gameDir: OPTIONS.gameDir,
    javaArgs: profiles.withXmx(undefined, 3072),
    created: NOW.toISOString(),
    lastUsed: NOW.toISOString(),
    icon: OPTIONS.icon,
  });
  assert.equal(EXISTING.profiles[C.PROFILE_ID], undefined, 'l’objet d’origine ne doit pas être modifié');
});

test('fusion d’un profil ATTACK existant : date de création gardée, Java et RAM mis à jour', () => {
  const first = profiles.mergeProfile(EXISTING, { ...OPTIONS, javaPath: 'C:\\Java\\bin\\javaw.exe' });
  first.profiles[C.PROFILE_ID].javaArgs = '-Xmx3072M -XX:+UseG1GC -Dperso=1';
  const later = new Date('2026-11-01T00:00:00.000Z');
  const second = profiles.mergeProfile(first, { ...OPTIONS, ramMb: 4096, now: later });
  const p = second.profiles[C.PROFILE_ID];
  assert.equal(p.created, NOW.toISOString());
  assert.equal(p.javaArgs, '-Xmx4096M -XX:+UseG1GC -Dperso=1');
  assert.equal(p.javaDir, undefined, 'Java personnalisé retiré quand le chemin est vide');
  assert.equal(profiles.mergeProfile(first, OPTIONS).profiles.pvp.icon, 'Furnace');
  assert.equal(profiles.markLastUsed(second, later).profiles[C.PROFILE_ID].lastUsed, later.toISOString());
});

test('fusion sans fichier existant', () => {
  const merged = profiles.mergeProfile(null, OPTIONS);
  assert.deepEqual(Object.keys(merged.profiles), [C.PROFILE_ID]);
  assert.equal(merged.version, 3);
});

test('écriture : sauvegarde .bak, JSON valide ; fichier illisible jamais écrasé', async () => {
  const dir = tempDir();
  const file = path.join(dir, profiles.PROFILES_FILE);
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(EXISTING)}`);
  await profiles.updateProfiles(dir, (data) => profiles.mergeProfile(data, OPTIONS));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8').replace(/^\uFEFF/, '')), EXISTING);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(written.profiles[C.PROFILE_ID]);
  assert.ok(written.profiles.pvp);

  fs.writeFileSync(file, '{ cassé');
  await assert.rejects(profiles.updateProfiles(dir, (data) => profiles.mergeProfile(data, OPTIONS)), /illisible/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ cassé');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arguments Java du joueur : écrits avec ceux par défaut ; sans eux, ceux du profil restent', () => {
  const first = profiles.mergeProfile(EXISTING, OPTIONS);
  first.profiles[C.PROFILE_ID].javaArgs = '-Xmx3072M -XX:+UseG1GC -Dperso=1';
  const withArgs = profiles.mergeProfile(first, { ...OPTIONS, jvmArgs: '-XX:+UseStringDeduplication' }).profiles[C.PROFILE_ID];
  assert.equal(withArgs.javaArgs, `-Xmx3072M ${C.DEFAULT_JVM_ARGS} -XX:+UseStringDeduplication`);
  assert.equal(profiles.mergeProfile(first, { ...OPTIONS, jvmArgs: '' }).profiles[C.PROFILE_ID].javaArgs, '-Xmx3072M -XX:+UseG1GC -Dperso=1');
  // valeur invalide (fichier modifié à la main) : rien d'ajouté
  assert.equal(profiles.mergeProfile(null, { ...OPTIONS, jvmArgs: '-javaagent:x.jar' }).profiles[C.PROFILE_ID].javaArgs,
    profiles.withXmx(undefined, 3072));
});

test('arguments Java vidés : ceux écrits par ATTACK retirés du profil officiel (ZGC puis Par défaut)', () => {
  const zgc = profiles.mergeProfile(null, { ...OPTIONS, jvmArgs: '-XX:+UseZGC' });
  assert.equal(zgc.profiles[C.PROFILE_ID].javaArgs, '-Xmx3072M -XX:+UnlockExperimentalVMOptions -XX:+UseZGC');
  const reset = profiles.mergeProfile(zgc, { ...OPTIONS, jvmArgs: '' });
  assert.equal(reset.profiles[C.PROFILE_ID].javaArgs, profiles.withXmx(undefined, 3072));
});
