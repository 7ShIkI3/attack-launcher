# Développement

[← Sommaire](Home.md)

## Prérequis et démarrage

- **Node.js 22.12 ou plus récent** (Electron 44 l'exige ; `package.json` déclare `node >= 20`). Windows pour tout ce qui
  touche à la mise à jour, à DPAPI et au lancement réel du jeu.
- Dépendances : une seule à l'exécution, `electron-updater` ; en développement `electron`, `electron-builder` et
  `skinview3d` (copié ensuite dans `src/renderer/vendor/`).

```bash
npm install
npm start
```

`npm start` lance l'app depuis les sources (`electron .`). Dans ce mode, les mises à jour automatiques sont
**désactivées** (`updateMode` renvoie `off` si l'app n'est pas empaquetée).

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm start` | Lance le launcher depuis les sources |
| `npm test` | Tests unitaires (`node --test test/*.test.js`), sans réseau : manifestes, install_profile, chemins Maven, profils, téléchargements, connexion Microsoft simulée, comptes, skins, ligne de commande Java, runtime, mises à jour |
| `npm run install-test -- [dossier] [--release]` | Installation **réelle** complète dans un dossier temporaire, puis contre-vérification indépendante de tous les hash. Sans `--release`, le jar du mod vient du build local (mode développeur). Refuse de toucher au vrai `.minecraft` |
| `npm run launch-test -- <dossier>` | Lancement direct **réel** avec un compte hors ligne factice, jusqu'à l'écran titre (cherche « Forge Mod Loader has successfully loaded N mods » et vérifie qu'ATTACK Client est chargé). `--keep` laisse le jeu ouvert |
| `npm run screenshot -- <dossier>` | Ouvre l'app dans des dossiers isolés et capture chaque page (`home`, `mods`, `settings`, `account`, `changelog`) |
| `npm run icons` | Régénère les icônes PNG à partir des polygones du logo (`scripts/make-icons.js`) |
| `npm run update-test -- <dossier>` | Mise à jour **réelle** 0.2.0 vers 0.2.1 sans GitHub (voir plus bas) |
| `npm run dist` | Construit `dist/ATTACK-Launcher-Setup-*.exe` (NSIS) avec `latest.yml` et `.blockmap`, et `dist/ATTACK-Launcher-Portable-*.exe` ; **ne publie rien** (`--publish never`) |
| `npm run pack` | Construit seulement le dossier non empaqueté `dist/win-unpacked` (plus rapide, pour tester) |

## Organisation du dépôt

| Dossier | Contenu |
| --- | --- |
| `src/main/` | Processus principal et logique (voir [Architecture](Architecture.md)) |
| `src/renderer/` | Page d'interface, polices, `vendor/` (skinview3d, three.js) |
| `test/` | Tests unitaires `node:test` et `helpers.js` (ZIP construit en mémoire, dossiers temporaires) |
| `scripts/` | Scripts de test réels, icônes, captures |
| `assets/`, `build/` | Icône de l'app et icône du profil Minecraft ; ressources d'electron-builder |
| `cosmetics/` | `cosmetics.json` lu par le mod ([Capes réservées](Capes-reservees.md)) |
| `docs/` | Ce wiki (`docs/wiki/`) et les captures (`docs/images/`) |
| `dist/` | Sortie de `npm run dist` (ignorée par git) |

La logique de `src/main/*.js` (sauf `main.js` et `preload.js`) **n'utilise pas Electron** : elle se teste avec Node seul.
Les dépendances au monde extérieur sont injectées (transport réseau dans `auth.js`, `cipher` dans `accounts.js`, `updater`
et minuteurs dans `updates.js`), ce qui permet de les simuler.

## Tests unitaires (`npm test`)

Les 85 tests tournent en moins d'une seconde et n'ont besoin ni du réseau ni d'Electron.

| Fichier | Ce qu'il vérifie |
| --- | --- |
| `auth.test.js` | Connexion complète par code d'appareil, `slow_down`, erreurs XSTS, 403 « app non validée », jeu non possédé, Game Pass, code expiré, rafraîchissement, tenant `consumers` |
| `accounts.test.js` | Refresh token chiffré sur disque et absent de la vue publique, jeton Minecraft en mémoire et rafraîchi, plusieurs comptes, compte hors ligne, ID client, skin |
| `skins.test.js` | Contrôle du PNG, skin actif, corps multipart, envoi, réinitialisation, erreurs Mojang |
| `http.test.js` | Hôtes https autorisés seulement, téléchargement vérifié, hash faux rejeté (`.part` supprimé), redirection hors liste refusée, parallélisme |
| `forge.test.js` | Lecteur ZIP, extraction de `install_profile.json` et du jar universal, installateur piégé refusé, bibliothèques, JSON de version |
| `mojang.test.js` | Manifeste, règles par plateforme, bibliothèques et natives, assets, chemins incohérents refusés |
| `maven.test.js` | Chemins et URL Maven, coordonnées malveillantes, `safeJoin` |
| `game.test.js` | Fusion Forge + 1.8.9, classpath, ligne de commande Java, masquage du jeton, natives, runtime Java |
| `profiles.test.js` | `-Xmx`, fusion du profil, `.bak`, fichier illisible jamais écrasé |
| `updates.test.js` | Versions semver, mode installé / portable / sources, vérifications, report pendant une partie ou une installation, fermeture, détection d'une partie |
| `misc.test.js` | Release GitHub et SHA-256, jar de développement, réglages, launcher officiel, progression, état d'installation, version du mod |

## Tests réels (réseau, vrai jeu)

Ces scripts ne font **rien** dans ton vrai `.minecraft` : ils travaillent dans le dossier que tu indiques.

```bash
npm run install-test -- C:\temp\essai          # installe Minecraft, Forge, mod, profil, puis recontrôle tous les hash
npm run launch-test -- C:\temp\essai           # Java officiel + jeu jusqu'à l'écran titre
npm run update-test -- C:\temp\maj             # mise à jour automatique de bout en bout
```

`update-test` construit deux installateurs de test (0.2.0 et 0.2.1) avec le code actuel, sous un autre nom et un autre
`appId` (« ATTACK Launcher UpdateTest ») : un vrai ATTACK Launcher installé n'est jamais touché. Il sert la 0.2.1 depuis un
serveur local (`127.0.0.1`), vérifie qu'un `latest.yml` au SHA-512 falsifié est **rejeté**, puis qu'un `latest.yml` correct
mène à la bannière « prête », au clic sur Redémarrer et à l'installation. Résultat dans `<dossier>/report.json` ;
sans `--keep`, l'app de test est désinstallée ensuite. Détails dans l'en-tête de `scripts/update-test.js`.

## Captures d'écran

`npm run screenshot -- <dossier>` lance Electron avec des dossiers de données **isolés** (`ATTACK_USER_DATA`,
`ATTACK_MINECRAFT_DIR`) : l'écran montre l'état « à installer », sans compte. Variables d'environnement utiles
(définies avant la commande) :

| Variable | Effet |
| --- | --- |
| `ATTACK_LANG=en` | Interface en anglais |
| `ATTACK_DEV=1` | Mode développeur actif |
| `ATTACK_OFFLINE=<pseudo>` | Ajoute un compte factice actif (hors ligne par défaut) |
| `ATTACK_ACCOUNT_TYPE=msa` | Avec `ATTACK_OFFLINE`, fait passer ce compte pour un compte Microsoft (boutons du skin visibles) |
| `ATTACK_SKIN=<fichier.png>` | Skin affiché pour ce compte factice |
| `ATTACK_SCREENSHOT_INSTALL=1` | Clique d'abord sur INSTALLER (installation réelle dans les dossiers donnés) |
| `ATTACK_SCREENSHOT_PLAY=1` | Clique sur JOUER avec le compte actif |
| `ATTACK_SCREENSHOT_SIZE=940x600` | Taille de fenêtre (bornée par la taille minimale) |

Les images de `docs/images/` sont de vraies captures du launcher, prises le 2026-10-19 avec un compte factice
(« Raphou ») et un skin de test. Garde les PNG sous environ 1 Mo.

## Autres variables d'environnement

| Variable | Effet |
| --- | --- |
| `ATTACK_MS_CLIENT_ID` | ID client Azure à utiliser (priorité inférieure à celui des Réglages) |
| `ATTACK_DEV_JAR_DIR` | Dossier des jars du mod pour le mode développeur |
| `ATTACK_USER_DATA`, `ATTACK_MINECRAFT_DIR`, `ATTACK_RUNTIME_DIR` | Dossiers de données, `.minecraft` et runtime Java : **réservés aux tests**, jamais utilisés par une installation normale |

## Conventions

- Messages de commit au format conventionnel (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`) ; branches `feat/...`, `fix/...`.
- Ne pas commiter sur `main` directement : branche, puis pull request.
- Après un changement de code : `npm test`, et pour un changement qui touche l'installation, le lancement ou les mises à
  jour, le script réel correspondant.
- Le dossier `graphify-out/` (graphe de connaissances du dépôt) est ignoré par git.

Voir aussi : [Publier une version](Publier-une-version.md), [Architecture](Architecture.md).
