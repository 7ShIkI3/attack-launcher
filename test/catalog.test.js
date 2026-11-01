'use strict';
// Catalogue des 4 profils : identifiants, dossiers, règles de nom des jars ATTACK, chemins par défaut.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const catalog = require('../src/main/catalog');
const paths = require('../src/main/paths');
const settings = require('../src/main/settings');
const mod = require('../src/main/mod');
const C = require('../src/main/constants');

test('4 profils : Forge 1.8.9 (inchangé), Fabric 1.21.1 / 26.3 avec Fabric Loader 0.19.5, puis Forge 1.7.10', () => {
  assert.deepEqual(catalog.list().map((p) => p.id), ['forge-1.8.9', 'fabric-1.21.1', 'fabric-26.3', 'forge-1.7.10']);
  assert.equal(catalog.DEFAULT_PROFILE_ID, 'forge-1.8.9');

  const forge = catalog.get('forge-1.8.9');
  assert.equal(forge.mc, '1.8.9');
  assert.deepEqual(forge.loader, {
    type: 'forge', version: '11.15.1.2318', fullVersion: '1.8.9-11.15.1.2318-1.8.9', versionId: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
  });
  assert.equal(forge.launcherProfileId, 'attack-client');
  assert.equal(forge.name, 'ATTACK Client');
  assert.equal(forge.gameDirName, '.attack');
  assert.equal(forge.pack, 'forge-1.8.9', 'le profil 1.8.9 a lui aussi un pack de mods');
  assert.equal(forge.optifine, true, 'et l’OptiFine du joueur');

  for (const mc of ['1.21.1', '26.3']) {
    const p = catalog.get(`fabric-${mc}`);
    assert.equal(p.mc, mc);
    assert.deepEqual({ type: p.loader.type, version: p.loader.version, versionId: p.loader.versionId },
      { type: 'fabric', version: '0.19.5', versionId: `fabric-loader-0.19.5-${mc}` });
    // SHA-1 figés des deux bibliothèques que Fabric publie sans hash (intermediary n'existe pas pour 26.3)
    assert.deepEqual(Object.keys(p.loader.pinnedSha1),
      mc === '1.21.1' ? ['net.fabricmc:fabric-loader:0.19.5', 'net.fabricmc:intermediary:1.21.1'] : ['net.fabricmc:fabric-loader:0.19.5']);
    assert.ok(Object.values(p.loader.pinnedSha1).every((h) => /^[0-9a-f]{40}$/.test(h)));
    assert.equal(p.launcherProfileId, `attack-fabric-${mc}`);
    assert.equal(p.name, `ATTACK ${mc}`);
    assert.equal(p.gameDirName, `.attack/profiles/fabric-${mc}`);
    assert.equal(p.pack, `fabric-${mc}`);
    assert.ok(p.attackJar.devDir.join('/').endsWith(`attack-client-fabric/versions/${mc}/build/libs`));
  }
});

test('profil Forge 1.7.10 : Forge 10.13.4.1614, Java 8, jar attack-forge-<version>+mc1.7.10.jar, ni pack ni OptiFine', () => {
  const p = catalog.get('forge-1.7.10');
  assert.equal(p.label, '1.7.10');
  assert.equal(p.name, 'ATTACK 1.7.10');
  assert.equal(p.mc, '1.7.10');
  assert.deepEqual(p.loader, {
    type: 'forge', version: '10.13.4.1614', fullVersion: '1.7.10-10.13.4.1614-1.7.10', versionId: '1.7.10-Forge10.13.4.1614-1.7.10',
  });
  assert.equal(p.javaMajor, 8);
  assert.equal(p.launcherProfileId, 'attack-forge-1.7.10');
  assert.equal(p.gameDirName, '.attack/profiles/forge-1.7.10');
  assert.equal(p.modFile, 'attack-forge.jar');
  assert.equal(p.pack, null, 'pas de pack de mods en v1');
  assert.equal(Boolean(p.optifine), false, 'ni OptiFine');
  assert.equal(catalog.hasPack(p), false);
  assert.equal(catalog.hasPack(catalog.get('forge-1.8.9')), true);
  assert.deepEqual(p.attackJar, {
    regex: '^attack-forge-([0-9.]+)\\+mc1\\.7\\.10\\.jar$',
    flags: '',
    versionRegex: '^attack-forge-([0-9.]+)\\+mc1\\.7\\.10\\.jar$',
    glob: 'attack-forge-*+mc1.7.10.jar',
    unique: true,
    devDir: ['Documents', 'attack-forge-1710', 'build', 'libs'],
  });
  assert.equal(catalog.isFabric(p), false);
  assert.equal(catalog.byVersionId('1.7.10-Forge10.13.4.1614-1.7.10').id, 'forge-1.7.10');
});

test('chaque profil a tous les champs obligatoires, et les réglages par défaut se calculent sans erreur', () => {
  // sans devDir, paths.defaultDevJarDir lève une TypeError dès settings.defaults()
  for (const p of catalog.list()) {
    for (const key of ['id', 'label', 'name', 'mc', 'javaMajor', 'launcherProfileId', 'gameDirName', 'modFile']) assert.ok(p[key], `${p.id} : ${key}`);
    for (const key of ['type', 'version', 'versionId']) assert.ok(p.loader[key], `${p.id} : loader.${key}`);
    for (const key of ['regex', 'versionRegex', 'glob', 'devDir']) assert.ok(p.attackJar[key], `${p.id} : attackJar.${key}`);
    assert.equal(typeof p.attackJar.unique, 'boolean', `${p.id} : unique`);
    assert.ok(Array.isArray(p.attackJar.devDir) && p.attackJar.devDir.every((x) => typeof x === 'string'), `${p.id} : devDir`);
    assert.ok(p.pack === null || typeof p.pack === 'string', `${p.id} : pack`);
    if (p.loader.type === 'forge') assert.ok(p.loader.fullVersion, `${p.id} : loader.fullVersion`);
  }
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.doesNotThrow(() => settings.defaults(env));
  assert.doesNotThrow(() => settings.defaults({}));
  assert.deepEqual(Object.keys(settings.defaults(env).profiles), catalog.list().map((p) => p.id));
  // identifiants, profils du launcher officiel et dossiers de jeu : tous distincts (attack-fabric.jar est partagé par les deux profils Fabric : un jar par dossier)
  for (const key of ['id', 'launcherProfileId', 'gameDirName']) {
    const values = catalog.list().map((p) => p[key]);
    assert.equal(new Set(values).size, values.length, key);
  }
  assert.equal(new Set(catalog.versionIds()).size, catalog.list().length, 'versions distinctes');
});

test('les alias historiques de constants.js désignent toujours le profil Forge 1.8.9', () => {
  const forge = catalog.get('forge-1.8.9');
  assert.equal(C.MC_VERSION, '1.8.9');
  assert.equal(C.FORGE_VERSION, forge.loader.fullVersion);
  assert.equal(C.FORGE_VERSION_ID, forge.loader.versionId);
  assert.equal(C.PROFILE_ID, 'attack-client');
  assert.equal(C.MOD_FILE, 'attack-client.jar');
});

test('recherche : identifiant inconnu refusé, profil retrouvé par son id de version', () => {
  assert.equal(catalog.find('autre'), undefined);
  assert.equal(catalog.isValidId('fabric-26.3'), true);
  assert.equal(catalog.isValidId('../etc'), false);
  assert.equal(catalog.isValidId(undefined), false);
  assert.throws(() => catalog.get('autre'), /inconnu/);
  assert.equal(catalog.byVersionId('fabric-loader-0.19.5-1.21.1').id, 'fabric-1.21.1');
  assert.equal(catalog.byVersionId('1.21.1'), undefined);
  assert.deepEqual(catalog.versionIds(), [
    '1.8.9-forge1.8.9-11.15.1.2318-1.8.9', 'fabric-loader-0.19.5-1.21.1', 'fabric-loader-0.19.5-26.3', '1.7.10-Forge10.13.4.1614-1.7.10',
  ]);
  assert.equal(catalog.isFabric(catalog.get('forge-1.8.9')), false);
  assert.equal(catalog.isFabric(catalog.get('fabric-26.3')), true);
  assert.equal(catalog.isFabric(catalog.get('forge-1.7.10')), false);
  assert.equal(catalog.isValidId('forge-1.7.10'), true);
});

test('règle du jar ATTACK : chaque profil ne reconnaît que le sien', () => {
  const forge = catalog.jarRule(catalog.get('forge-1.8.9'));
  const f121 = catalog.jarRule(catalog.get('fabric-1.21.1'));
  const f263 = catalog.jarRule(catalog.get('fabric-26.3'));

  assert.equal(forge.matches('attack-client-2.3.0.jar'), true);
  assert.equal(forge.matches('attack-client.jar'), true);
  assert.equal(forge.matches('Attack-Client-2.3.0.jar'), true, 'comportement historique : insensible à la casse');
  assert.equal(forge.matches('attack-fabric-0.1.0+mc1.21.1.jar'), false, 'le jar Fabric n’est jamais pris pour Forge');
  assert.equal(forge.version('attack-client-2.3.0.jar'), '2.3.0');

  assert.equal(f121.matches('attack-fabric-0.1.0+mc1.21.1.jar'), true);
  assert.equal(f121.matches('attack-fabric-0.1.0+mc26.3.jar'), false);
  assert.equal(f121.matches('attack-client-2.3.0.jar'), false);
  assert.equal(f121.matches('attack-fabric-0.1.0+mc1x21x1.jar'), false, 'les points de la version sont échappés');
  assert.equal(f121.matches('attack-fabric-0.1.0+mc1.21.1-sources.jar'), false);
  assert.equal(f121.matches('attack-fabric-0.1.0+mc1.21.1.jar.sha256'), false);
  assert.equal(f121.matches('xattack-fabric-0.1.0+mc1.21.1.jar'), false);
  assert.equal(f121.version('attack-fabric-0.1.0+mc1.21.1.jar'), '0.1.0');
  assert.equal(f263.matches('attack-fabric-12.3.4+mc26.3.jar'), true);
  assert.equal(f263.version('attack-fabric-12.3.4+mc26.3.jar'), '12.3.4');
  assert.equal(f263.version('autre.jar'), null);

  const f1710 = catalog.jarRule(catalog.get('forge-1.7.10'));
  assert.equal(f1710.matches('attack-forge-1.0.0+mc1.7.10.jar'), true);
  assert.equal(f1710.version('attack-forge-1.0.0+mc1.7.10.jar'), '1.0.0');
  for (const other of ['attack-forge-1.0.0+mc1.8.9.jar', 'attack-forge-1.0.0+mc1x7x10.jar', 'attack-forge-1.0.0+mc1.7.10-sources.jar', 'attack-forge-1.0.0+mc1.7.10.jar.sha256',
    'xattack-forge-1.0.0+mc1.7.10.jar', 'Attack-Forge-1.0.0+mc1.7.10.jar', 'attack-client-1.0.0.jar', 'attack-fabric-1.0.0+mc1.7.10.jar', 'attack-forge-1.0.0-beta.1+mc1.7.10.jar']) {
    assert.equal(f1710.matches(other), false, other);
  }
  assert.equal(forge.matches('attack-forge-1.0.0+mc1.7.10.jar'), false, 'le jar 1.7.10 n’est jamais pris pour le mod 1.8.9');
  assert.equal(f121.matches('attack-forge-1.0.0+mc1.7.10.jar'), false);
  assert.equal(catalog.jarFamily(catalog.get('forge-1.7.10')), 'attack-forge');
  assert.equal(catalog.jarFamily(catalog.get('fabric-26.3')), 'attack-fabric');
  assert.equal(catalog.jarFamily(catalog.get('forge-1.8.9')), 'attack-client');
});

// noms de fichiers d'une release complète : le jar de chaque profil, leurs .sha256, SHA256SUMS et les fichiers du launcher
const RELEASE_FILES = [
  'attack-client-2.7.0.jar', 'attack-client-2.7.0.jar.sha256',
  'attack-fabric-3.6.0+mc1.21.1.jar', 'attack-fabric-3.6.0+mc1.21.1.jar.sha256',
  'attack-fabric-3.6.0+mc26.3.jar', 'attack-fabric-3.6.0+mc26.3.jar.sha256',
  'attack-forge-1.0.0+mc1.7.10.jar', 'attack-forge-1.0.0+mc1.7.10.jar.sha256',
  'ATTACK-Launcher-Setup-0.8.0.exe', 'ATTACK-Launcher-Setup-0.8.0.exe.blockmap', 'ATTACK-Launcher-Portable-0.8.0.exe', 'latest.yml', 'SHA256SUMS',
];

test('aucun fichier de release ne correspond à deux règles : un jar, un profil', () => {
  const rules = catalog.list().map((p) => [p.id, catalog.jarRule(p)]);
  const owners = (name) => rules.filter(([, rule]) => rule.matches(name)).map(([id]) => id);
  for (const name of RELEASE_FILES) assert.ok(owners(name).length <= 1, `${name} : ${owners(name)}`);
  assert.deepEqual(owners('attack-client-2.7.0.jar'), ['forge-1.8.9']);
  assert.deepEqual(owners('attack-fabric-3.6.0+mc1.21.1.jar'), ['fabric-1.21.1']);
  assert.deepEqual(owners('attack-fabric-3.6.0+mc26.3.jar'), ['fabric-26.3']);
  assert.deepEqual(owners('attack-forge-1.0.0+mc1.7.10.jar'), ['forge-1.7.10']);
  for (const name of ['SHA256SUMS', 'latest.yml', 'attack-forge-1.0.0+mc1.7.10.jar.sha256', 'ATTACK-Launcher-Setup-0.8.0.exe']) assert.deepEqual(owners(name), [], name);

  // nom canonique de chaque profil, pour une version quelconque : seul son profil le reconnaît (les règles ne se recouvrent pas)
  const canonical = (p) => (p.loader.type === 'fabric' ? `attack-fabric-9.8.7+mc${p.mc}.jar` : p.id === 'forge-1.8.9' ? 'attack-client-9.8.7.jar' : `attack-forge-9.8.7+mc${p.mc}.jar`);
  for (const p of catalog.list()) assert.deepEqual(owners(canonical(p)), [p.id], canonical(p));

  const audit = mod.auditJarNames(RELEASE_FILES);
  assert.deepEqual(audit.overlaps, []);
  assert.deepEqual(audit.dangerous, []);
  assert.deepEqual(audit.orphans, []);
  assert.deepEqual(audit.byProfile, {
    'forge-1.8.9': ['attack-client-2.7.0.jar'],
    'fabric-1.21.1': ['attack-fabric-3.6.0+mc1.21.1.jar'],
    'fabric-26.3': ['attack-fabric-3.6.0+mc26.3.jar'],
    'forge-1.7.10': ['attack-forge-1.0.0+mc1.7.10.jar'],
  });
});

test('attack-client-1710-1.0.0.jar (le nom que Gradle donnerait) est signalé comme dangereux : la règle 1.8.9 le prendrait', () => {
  const name = 'attack-client-1710-1.0.0.jar';
  const rules = catalog.list().map((p) => [p.id, catalog.jarRule(p)]);
  assert.deepEqual(rules.filter(([, rule]) => rule.matches(name)).map(([id]) => id), ['forge-1.8.9'], 'le piège : seule la règle large du 1.8.9 le reconnaît');
  const forge = catalog.jarRule(catalog.get('forge-1.8.9'));
  assert.equal(forge.suspect(name), 'odd-version');
  const audit = mod.auditJarNames([...RELEASE_FILES, name]);
  assert.deepEqual(audit.dangerous, [{ name, profile: 'forge-1.8.9', reason: 'odd-version' }]);
  assert.deepEqual(audit.overlaps, []);
  // mêmes pièges de nom : version collée au nom de Minecraft, nombre de Minecraft seul, « fabric » dans le nom, sans version
  for (const trap of ['attack-client-1.7.10-1.0.0.jar', 'attack-client-1710.jar', 'attack-client-fabric-1.0.jar']) assert.equal(forge.suspect(trap), 'odd-version', trap);
  assert.equal(forge.suspect('attack-client.jar'), 'no-version');
  // les vraies versions du mod 1.8.9 restent propres, préversions comprises
  for (const clean of ['attack-client-2.7.0.jar', 'attack-client-2.3.jar', 'attack-client-2.8.0-beta.1.jar', 'attack-client-3.0.0-rc2.jar']) assert.equal(forge.suspect(clean), null, clean);
  assert.equal(forge.suspect('attack-fabric-3.6.0+mc26.3.jar'), null, 'un nom que la règle ne reconnaît pas n’est pas « suspect »');
  // un jar qu'aucun profil ne reconnaît est signalé à part ; les -sources sont ignorés comme à l'installation
  const other = mod.auditJarNames(['attack-forge-1.0.0+mc1.8.9.jar', 'attack-fabric-3.6.0+mc26.3-sources.jar', 'attack-forge-1.0.0+mc1.7.10-sources.jar']);
  assert.deepEqual(other.orphans, ['attack-forge-1.0.0+mc1.8.9.jar']);
});

test('vue pour l’interface : ni fonction ni expression régulière', () => {
  for (const profile of catalog.list()) {
    const view = catalog.view(profile);
    assert.equal(JSON.stringify(view), JSON.stringify(structuredClone(view)));
    assert.equal(view.id, profile.id);
    assert.ok(!('attackJar' in view));
  }
  assert.equal(catalog.view(catalog.get('fabric-1.21.1')).hasPack, true);
  assert.equal(catalog.view(catalog.get('forge-1.8.9')).hasPack, true);
  assert.equal(catalog.view(catalog.get('forge-1.8.9')).hasOptifine, true);
  assert.equal(catalog.view(catalog.get('fabric-1.21.1')).hasOptifine, false, 'OptiFine : profil 1.8.9 seulement');
  assert.equal(catalog.view(catalog.get('forge-1.7.10')).hasPack, false);
  assert.equal(catalog.view(catalog.get('forge-1.7.10')).hasOptifine, false);
  assert.equal(catalog.view(catalog.get('forge-1.7.10')).loaderType, 'forge');
  assert.equal(catalog.view(catalog.get('forge-1.7.10')).jarGlob, 'attack-forge-*+mc1.7.10.jar');
  assert.equal(catalog.hasOptifine(catalog.get('fabric-26.3')), false);
});

test('dossiers de jeu par défaut : .attack pour Forge 1.8.9, .attack/profiles/<profil> pour les autres', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.equal(paths.defaultGameDir(env), path.join(env.APPDATA, '.attack'));
  assert.equal(paths.defaultGameDir(env, catalog.get('forge-1.8.9')), path.join(env.APPDATA, '.attack'));
  assert.equal(paths.defaultGameDir(env, catalog.get('fabric-1.21.1')), path.join(env.APPDATA, '.attack', 'profiles', 'fabric-1.21.1'));
  assert.equal(paths.defaultGameDir(env, catalog.get('fabric-26.3')), path.join(env.APPDATA, '.attack', 'profiles', 'fabric-26.3'));
  assert.equal(paths.defaultGameDir(env, catalog.get('forge-1.7.10')), path.join(env.APPDATA, '.attack', 'profiles', 'forge-1.7.10'));
});

test('jars de développement : dossier par profil, surcharges par variable d’environnement', () => {
  const home = require('node:os').homedir();
  assert.equal(paths.defaultDevJarDir({}, catalog.get('forge-1.8.9')), path.join(home, 'Documents', 'pvp-essentials', 'build', 'libs'));
  assert.equal(paths.defaultDevJarDir({}), path.join(home, 'Documents', 'pvp-essentials', 'build', 'libs'));
  assert.equal(paths.defaultDevJarDir({}, catalog.get('fabric-26.3')), path.join(home, 'Documents', 'attack-client-fabric', 'versions', '26.3', 'build', 'libs'));
  assert.equal(paths.defaultDevJarDir({ ATTACK_DEV_JAR_DIR: 'D:\\forge' }, catalog.get('forge-1.8.9')), 'D:\\forge');
  assert.equal(paths.defaultDevJarDir({ ATTACK_DEV_JAR_DIR: 'D:\\forge' }, catalog.get('fabric-1.21.1')),
    path.join(home, 'Documents', 'attack-client-fabric', 'versions', '1.21.1', 'build', 'libs'), 'la surcharge Forge ne touche pas Fabric');
  assert.equal(paths.defaultDevJarDir({ ATTACK_DEV_JAR_DIR_FABRIC_1_21_1: 'D:\\fab' }, catalog.get('fabric-1.21.1')), 'D:\\fab');
  // profil 1.7.10 : Documents/attack-forge-1710/build/libs, ou ATTACK_DEV_JAR_DIR_FORGE_1_7_10 ; la surcharge du profil 1.8.9 ne le touche pas
  assert.equal(paths.defaultDevJarDir({}, catalog.get('forge-1.7.10')), path.join(home, 'Documents', 'attack-forge-1710', 'build', 'libs'));
  assert.equal(paths.defaultDevJarDir({ ATTACK_DEV_JAR_DIR: 'D:\\forge' }, catalog.get('forge-1.7.10')), path.join(home, 'Documents', 'attack-forge-1710', 'build', 'libs'));
  assert.equal(paths.defaultDevJarDir({ ATTACK_DEV_JAR_DIR_FORGE_1_7_10: 'D:\\old' }, catalog.get('forge-1.7.10')), 'D:\\old');
});

test('hôtes autorisés : Fabric (meta + Maven) et CDN Modrinth, jamais l’API Modrinth', () => {
  for (const host of ['meta.fabricmc.net', 'maven.fabricmc.net', 'cdn.modrinth.com']) assert.ok(C.ALLOWED_HOSTS.has(host), host);
  assert.equal(C.ALLOWED_HOSTS.has('api.modrinth.com'), false);
});
