'use strict';
// Catalogue des 3 profils : identifiants, dossiers, règles de nom des jars ATTACK, chemins par défaut.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const catalog = require('../src/main/catalog');
const paths = require('../src/main/paths');
const C = require('../src/main/constants');

test('3 profils : Forge 1.8.9 (inchangé) et Fabric 1.21.1 / 26.3 avec Fabric Loader 0.19.5', () => {
  assert.deepEqual(catalog.list().map((p) => p.id), ['forge-1.8.9', 'fabric-1.21.1', 'fabric-26.3']);
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
    '1.8.9-forge1.8.9-11.15.1.2318-1.8.9', 'fabric-loader-0.19.5-1.21.1', 'fabric-loader-0.19.5-26.3',
  ]);
  assert.equal(catalog.isFabric(catalog.get('forge-1.8.9')), false);
  assert.equal(catalog.isFabric(catalog.get('fabric-26.3')), true);
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
  assert.equal(catalog.hasOptifine(catalog.get('fabric-26.3')), false);
});

test('dossiers de jeu par défaut : .attack pour Forge, .attack/profiles/<profil> pour Fabric', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.equal(paths.defaultGameDir(env), path.join(env.APPDATA, '.attack'));
  assert.equal(paths.defaultGameDir(env, catalog.get('forge-1.8.9')), path.join(env.APPDATA, '.attack'));
  assert.equal(paths.defaultGameDir(env, catalog.get('fabric-1.21.1')), path.join(env.APPDATA, '.attack', 'profiles', 'fabric-1.21.1'));
  assert.equal(paths.defaultGameDir(env, catalog.get('fabric-26.3')), path.join(env.APPDATA, '.attack', 'profiles', 'fabric-26.3'));
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
});

test('hôtes autorisés : Fabric (meta + Maven) et CDN Modrinth, jamais l’API Modrinth', () => {
  for (const host of ['meta.fabricmc.net', 'maven.fabricmc.net', 'cdn.modrinth.com']) assert.ok(C.ALLOWED_HOSTS.has(host), host);
  assert.equal(C.ALLOWED_HOSTS.has('api.modrinth.com'), false);
});
