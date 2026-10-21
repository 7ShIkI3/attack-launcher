'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jvm = require('../src/main/jvmargs');

test('arguments valides : découpés aux espaces, texte vide = aucun', () => {
  assert.deepEqual(jvm.parseJvmArgs('  -XX:+UseStringDeduplication   -Dsun.java2d.d3d=false\n-Xms1G '), {
    ok: true, args: ['-XX:+UseStringDeduplication', '-Dsun.java2d.d3d=false', '-Xms1G'],
  });
  assert.deepEqual(jvm.parseJvmArgs(''), { ok: true, args: [] });
  assert.deepEqual(jvm.parseJvmArgs(undefined), { ok: true, args: [] });
  assert.equal(jvm.normalize(' -Xss4M   -XX:+UseG1GC '), '-Xss4M -XX:+UseG1GC');
  // les options -XX par défaut peuvent être remplacées
  assert.equal(jvm.parseJvmArgs('-XX:MaxGCPauseMillis=30 -XX:-UseG1GC -XX:+UseZGC').ok, true);
});

test('refusés : réglé par le launcher, casse le lancement, lance du code', () => {
  for (const arg of ['-Xmx4G', '-xmx4g', '-cp', '-classpath', '--class-path=a.jar', '-jar', '-Djava.library.path=C:\\x',
    '-Dminecraft.launcher.brand=x', '-javaagent:C:\\evil.jar', '-agentlib:jdwp=transport=dt_socket', '-agentpath:C:\\a.dll',
    '-XX:OnError=calc.exe', '-XX:OnOutOfMemoryError=cmd', 'calc.exe', '@args.txt', '-Dx="a', '-Da\u0007b']) {
    const result = jvm.parseJvmArgs(`-XX:+UseG1GC ${arg}`);
    assert.equal(result.ok, false, arg);
    assert.equal(result.arg, arg.trim());
    assert.match(jvm.describe(result), /^Argument Java refusé/);
    assert.equal(jvm.normalize(arg), null);
    assert.deepEqual(jvm.argsOf(arg), []);
  }
});

test('autre ramasse-miettes choisi : options G1 par défaut retirées, le reste gardé', () => {
  const { DEFAULT_JVM_ARGS } = require('../src/main/constants');
  assert.deepEqual(jvm.baseArgs(DEFAULT_JVM_ARGS, ['-XX:+UseStringDeduplication']), DEFAULT_JVM_ARGS.split(' '));
  for (const gc of ['-XX:+UseZGC', '-XX:+UseParallelGC', '-XX:+UseShenandoahGC', '-XX:+UseSerialGC']) {
    assert.deepEqual(jvm.baseArgs(DEFAULT_JVM_ARGS, ['-Xss4M', gc]), ['-XX:+UnlockExperimentalVMOptions'], gc);
  }
  // désactiver un GC n'en choisit pas un autre
  assert.deepEqual(jvm.baseArgs(DEFAULT_JVM_ARGS, ['-XX:-UseZGC']), DEFAULT_JVM_ARGS.split(' '));
});

test('liste d’autorisation : options qui chargent du code, écrivent un fichier ou détournent la connexion refusées', () => {
  for (const arg of ['-Dfabric.addMods=C:\\evil.jar', '-Dminecraft.api.session.host=https://evil', '-Dminecraft.api.env=x',
    '-Dorg.lwjgl.librarypath=C:\\x', '-Dsun.boot.library.path=C:\\x', '-Xbootclasspath/a:C:\\x.jar', '-Djava.ext.dirs=C:\\x',
    '-Xrunjdwp:transport=dt_socket,server=y', '-Xdebug', '--patch-module=java.base=x', '--module-path=x', '-XX:VMOptionsFile=C:\\o.txt',
    '-XX:Flags=x', '-Djava.system.class.loader=x', '-Djavax.net.ssl.trustStore=x', '-Dhttps.proxyHost=evil',
    '-XX:ErrorFile=C:\\x.log', '-XX:LogFile=x', '-XX:HeapDumpPath=x', '-XX:+HeapDumpOnOutOfMemoryError',
    '-XX:StartFlightRecording=filename=x', '-Xlog:gc:file=x', '-XX:MaxRAM=64G', '-XX:MaxHeapSize=8G',
    '-XX:+EnableDynamicAgentLoading', '-Dfml.coreMods.load=x', '-Dlog4j.configurationFile=http://evil/x.xml']) {
    assert.equal(jvm.parseJvmArgs(arg).ok, false, arg);
  }
  assert.equal(jvm.parseJvmArgs('-Xms1G -Xss4M -Xmn512M -XX:+UseG1GC -XX:ParallelGCThreads=4 -XX:+UnlockDiagnosticVMOptions '
    + '-XX:ReservedCodeCacheSize=256M -Dsun.java2d.d3d=false -Dfile.encoding=UTF-8 -Duser.language=fr').ok, true);
});

test('profil du launcher officiel : arguments écrits par ATTACK reconnus, ceux mis à la main non', () => {
  const { DEFAULT_JVM_ARGS } = require('../src/main/constants');
  assert.deepEqual(jvm.writtenExtra(DEFAULT_JVM_ARGS, `-Xmx3072M ${DEFAULT_JVM_ARGS} -XX:+UseStringDeduplication`), ['-XX:+UseStringDeduplication']);
  assert.deepEqual(jvm.writtenExtra(DEFAULT_JVM_ARGS, '-Xmx3072M -XX:+UnlockExperimentalVMOptions -XX:+UseZGC'), ['-XX:+UseZGC']);
  assert.equal(jvm.writtenExtra(DEFAULT_JVM_ARGS, `-Xmx3072M ${DEFAULT_JVM_ARGS}`), null, 'défauts seuls : rien à retirer');
  assert.equal(jvm.writtenExtra(DEFAULT_JVM_ARGS, '-Xmx3072M -XX:+UseG1GC -Dperso=1'), null);
  assert.equal(jvm.writtenExtra(DEFAULT_JVM_ARGS, `-Xmx3072M ${DEFAULT_JVM_ARGS} -Dperso=1`), null, 'option non autorisée : mise à la main');
  assert.equal(jvm.writtenExtra(DEFAULT_JVM_ARGS, undefined), null);
});

test('limites : longueur, nombre, type', () => {
  assert.equal(jvm.parseJvmArgs(`-D${'a'.repeat(jvm.MAX_LENGTH)}`).ok, false);
  assert.equal(jvm.parseJvmArgs(Array.from({ length: jvm.MAX_ARGS + 1 }, (_, i) => `-XX:+Opt${i}`).join(' ')).ok, false);
  assert.equal(jvm.parseJvmArgs(Array.from({ length: jvm.MAX_ARGS }, (_, i) => `-XX:+Opt${i}`).join(' ')).ok, true);
  assert.equal(jvm.parseJvmArgs(42).ok, false);
  assert.match(jvm.describe(jvm.parseJvmArgs(42)), /^Arguments Java refusés/);
});
