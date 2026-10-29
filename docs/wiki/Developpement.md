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
| `npm test` | Tests unitaires (`node --test test/*.test.js`), sans réseau : catalogue des profils, manifestes, install_profile, profil Fabric, packs de mods, chemins Maven, profils, téléchargements, connexion Microsoft simulée, comptes, skins, ligne de commande Java (anciens et nouveaux formats), runtime, mises à jour |
| `npm run install-test -- [dossier] [--profile <id>] [--release] [--shaders] [--cycle]` | Installation **réelle** complète d'un profil (`forge-1.8.9` par défaut, `fabric-1.21.1`, `fabric-26.3`) dans un dossier temporaire, puis contre-vérification indépendante de tous les hash. Sans `--release`, le jar du mod vient du build local (mode développeur). `--shaders` installe aussi Iris ; `--cycle` coupe puis remet les shaders et vérifie qu'un jar ajouté à la main n'est jamais touché. Refuse de toucher au vrai `.minecraft` |
| `npm run launch-test -- <dossier> [--profile <id>]` | Lancement direct **réel** avec un compte hors ligne factice, jusqu'à l'écran titre. Forge : « Forge Mod Loader has successfully loaded N mods ». Fabric : liste « Loading N mods » + « Sound engine started », avec le mod `attack` dans la liste. Installe le Java du profil (8, 21 ou 25). `--keep` laisse le jeu ouvert |
| `node scripts/resolve-pack.js [profil] [--check]` | Fige les packs de mods (Fabric et Forge 1.8.9, licence et auteur compris) depuis l'API Modrinth dans `src/main/packs/` (outil de développement : le launcher n'appelle jamais cette API) |
| `npm run screenshot -- <dossier>` | Ouvre l'app dans des dossiers isolés et capture chaque page (`home`, `mods`, `settings`, `account`, `changelog`) ; `ATTACK_PROFILE=fabric-1.21.1` choisit le profil affiché |
| `npm run site` | Construit le site web du projet (voir [Site web](#site-web)) |
| `npm run site:serve` | Sert le site en local, pour le relire avant de publier |
| `npm run site:images` | Produit les images WebP du site, dans `site/img/` |
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
| `site/` | Le site web du projet, en français et en anglais (voir [Site web](#site-web)) |
| `.github/workflows/` | `pages.yml` : le workflow qui publie le site sur GitHub Pages |
| `dist/` | Sortie de `npm run dist` (ignorée par git) |

La logique de `src/main/*.js` (sauf `main.js` et `preload.js`) **n'utilise pas Electron** : elle se teste avec Node seul.
Les dépendances au monde extérieur sont injectées (transport réseau dans `auth.js`, `cipher` dans `accounts.js`, `updater`
et minuteurs dans `updates.js`), ce qui permet de les simuler.

## Tests unitaires (`npm test`)

Les 167 tests tournent en quelques secondes et n'ont besoin ni du réseau ni d'Electron. Les fixtures de `test/fixtures/` sont les vrais JSON de Mojang (1.21.1, 26.3, réduits à quelques bibliothèques) et de Fabric (profils 0.19.5).

| Fichier | Ce qu'il vérifie |
| --- | --- |
| `auth.test.js` | Connexion complète par code d'appareil, `slow_down`, erreurs XSTS, 403 « app non validée », jeu non possédé, Game Pass, code expiré, rafraîchissement, tenant `consumers` |
| `accounts.test.js` | Refresh token chiffré sur disque et absent de la vue publique, jeton Minecraft en mémoire et rafraîchi, plusieurs comptes, compte hors ligne, ID client, skin |
| `skins.test.js` | Contrôle du PNG, skin actif, corps multipart, envoi, réinitialisation, erreurs Mojang |
| `http.test.js` | Hôtes https autorisés seulement, téléchargement vérifié (SHA-1, SHA-256, SHA-512), hash faux rejeté (`.part` supprimé), redirection hors liste refusée, parallélisme |
| `catalog.test.js` | Les 3 profils, règles exactes des jars ATTACK, dossiers de jeu et de jars par profil, alias de `constants.js`, hôtes autorisés |
| `fabric.test.js` | Adresse du profil Fabric, validation stricte (vrais profils 1.21.1 et 26.3, profils piégés refusés), plan de téléchargement avec ou sans hash, JSON de version écrit |
| `optifine.test.js` | OptiFine du joueur : détection (libraries, mods, fichier choisi), validation du manifeste, copie suivie dans l'état, retrait de la seule copie du launcher, copie d'origine disparue (le jar de `mods` reste), OptiFine du joueur jamais touché |
| `renderer.test.js` | Interface : clés de traduction FR/EN complètes, identifiants du HTML, CSP stricte (ni script ni style en ligne, pas d'innerHTML), historique et fiches des mods du pack |
| `renderer-dom.test.js` | Accueil : `app.js` tourne sur un faux DOM avec l'état d'installation réel de `installer.status()` ; phrase « prêt », lignes du détail (OptiFine « à retirer », « déjà copié dans mods », « Mise à jour à appliquer »), compteur, rail, cartes Mods et Réglages, en français et en anglais |
| `gameoptions.test.js` | `options.txt` de départ par étapes (vidéo en Fabric, langue du launcher écrite à la création seulement), choix du joueur et fins de ligne intacts |
| `modpack.test.js` | Packs figés valides (versions demandées, licence et auteur), groupes `pvp` / `optifine` / `replay`, validation (URL, hash, noms), installation, Iris selon l'option, jars gérés supprimés, jars du joueur intacts, échec sans suppression |
| `game-modern.test.js` | Fusion Fabric + Minecraft, arguments modernes (1.21.1 et 26.3), un seul `-cp`, variables sans découpage, natives de 26.x, détection d'une partie |
| `installer.test.js` | Étapes de l'installateur avec un faux réseau (`fetch` remplacé) : Fabric Loader (hash figés, SHA-512, profil piégé refusé avant tout téléchargement), jar ATTACK d'une release (profil, SHA-256, erreurs), pack et fichier d'état (échec au milieu, jar verrouillé) |
| `multi-profils.test.js` | Réglages par profil et migration de l'ancien fichier, profils du launcher officiel, jar ATTACK par release, progression par chargeur, état d'un profil Fabric |
| `zip.test.js` | Lecteur ZIP : plafond de décompression (taille annoncée contrôlée avant, zlib limité à cette taille), zip forgé dont la taille ment, limites de l'installateur Forge |
| `forge.test.js` | Lecteur ZIP, extraction de `install_profile.json` et du jar universal, installateur piégé refusé, bibliothèques, JSON de version |
| `mojang.test.js` | Manifeste, règles par plateforme, bibliothèques et natives, assets, chemins incohérents refusés |
| `maven.test.js` | Chemins et URL Maven, coordonnées malveillantes, `safeJoin` |
| `game.test.js` | Fusion Forge + 1.8.9 (ancien format), classpath, ligne de commande Java, masquage du jeton, natives, runtime Java |
| `profiles.test.js` | `-Xmx`, fusion du profil, `.bak`, fichier illisible jamais écrasé |
| `updates.test.js` | Versions semver, mode installé / portable / sources, vérifications, report pendant une partie ou une installation, fermeture, détection d'une partie |
| `misc.test.js` | Release GitHub et SHA-256, jar de développement, réglages, launcher officiel, progression, état d'installation, version du mod |

## Tests réels (réseau, vrai jeu)

Ces scripts ne font **rien** dans ton vrai `.minecraft` : ils travaillent dans le dossier que tu indiques.

```bash
npm run install-test -- C:\temp\essai          # profil 1.8.9 : Minecraft, Forge, mod, profil, puis recontrôle tous les hash
npm run launch-test -- C:\temp\essai           # Java officiel + jeu jusqu'à l'écran titre
npm run install-test -- C:\temp\fab --profile fabric-1.21.1 --cycle   # Fabric, pack de mods, cycle des shaders
npm run launch-test -- C:\temp\fab --profile fabric-1.21.1            # Java 21 + jeu jusqu'à l'écran titre
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
| `ATTACK_PROFILE=fabric-1.21.1` | Profil affiché (`forge-1.8.9` par défaut, `fabric-1.21.1`, `fabric-26.3`) |
| `ATTACK_SETTINGS='{"replayMod":true}'` | Réglages à plat ajoutés au profil affiché |

Les images de `docs/images/` sont de vraies captures du launcher (0.6.0), prises le 2026-10-29 sur des installations de test
(`npm run install-test`) avec un compte factice (« Raphael ») et un skin de test, dans un dossier de jeu sans nom d'utilisateur
(`C:\Users\Public\ATTACK`) et sans mode développeur. `account.png` est coupée à 618 px de haut : le compte factice, qui n'a pas de
jeton de renouvellement, affiche en bas un message d'erreur. `ATTACK_SETTINGS='{"replayMod":true}'` ajoute des
réglages à plat au profil affiché (pour photographier l'état « à appliquer »). Garde les PNG sous environ 1 Mo.

## Site web

Le site du projet présente le launcher en français ([7shiki3.github.io/attack-launcher](https://7shiki3.github.io/attack-launcher/)) et en
anglais ([/en/](https://7shiki3.github.io/attack-launcher/en/)). Son code est dans le dossier `site/`.

| Commande | Rôle |
| --- | --- |
| `npm run site` | Construit le site |
| `npm run site:serve` | Sert le site en local, pour le relire avant de publier |
| `npm run site:images -- --sources <dossier>` | Produit les images WebP du site à partir d'un dossier de captures PNG (le dossier est **obligatoire**) |

- **Images** : les WebP sont dans `site/img/`, nommés `<clé>-<fr|en>-<largeur>.webp` (par exemple `client-menu-fr-854.webp`, la capture
  du menu ATTACK en jeu, que le README affiche aussi). GitHub sait afficher le WebP. `npm run site:images` demande un dossier de PNG
  nommés `<clé>-<fr|en>.png` (`launcher-home-fr.png`, `client-menu-en.png`…) et **refuse de travailler sans lui** : ces PNG ne sont pas
  dans le dépôt (seuls les WebP et `manifest.json` le sont). Les images sont d'abord toutes encodées dans un dossier d'attente ;
  `site/img/` n'est remplacé (WebP, manifeste, `og.png` et `og-en.png`, les accueils français et anglais pour le partage) qu'ensuite.
  Une capture plus étroite que la plus grande largeur prévue (1120 px pour le launcher, 854 px pour le client) est refusée avec
  « capture trop étroite » et rien n'est modifié. La capture « Compte » est coupée à 618 px de haut : le compte factice affiche
  en bas un message d'erreur de renouvellement.
- **Sortie** : `node scripts/build-site.js --out <dossier>` vide ce dossier avant de générer. Il n'est accepté que s'il n'existe pas,
  est vide, s'appelle `_site` ou porte le fichier `.attack-site` écrit par le script : `--out docs` ou `--out src` sont refusés.
- **Release lue** : la page montre le Setup de la dernière release GitHub. Avec `--strict` (workflow), la génération échoue si l'API ne
  répond pas, si la release est inutilisable (fichiers pas encore joints, version du Setup différente du tag) ou plus ancienne
  que la `version` de `package.json` ; `--offline` utilise `test/fixtures/site-release.json` (sans réseau, sans cette comparaison).
- **Publication** : le workflow `.github/workflows/pages.yml` publie le site sur GitHub Pages ; à la publication d'une release, il
  redéploie le site (voir [Publier une version](Publier-une-version.md), qui donne l'ordre à respecter : release complète d'abord).
- Les liens du README et du wiki vers le site (`7shiki3.github.io/attack-launcher`) ne répondent qu'une fois GitHub Pages activé pour le dépôt.

## Autres variables d'environnement

| Variable | Effet |
| --- | --- |
| `ATTACK_MS_CLIENT_ID` | ID client Azure à utiliser (priorité inférieure à celui des Réglages) |
| `ATTACK_DEV_JAR_DIR` | Dossier des jars du mod pour le mode développeur, profil 1.8.9 |
| `ATTACK_DEV_JAR_DIR_FABRIC_1_21_1`, `ATTACK_DEV_JAR_DIR_FABRIC_26_3` | Idem pour les profils Fabric (par défaut `Documents\attack-client-fabric\versions\<mc>\build\libs`) |
| `ATTACK_USER_DATA`, `ATTACK_MINECRAFT_DIR`, `ATTACK_RUNTIME_DIR` | Dossiers de données, `.minecraft` et runtime Java : **réservés aux tests**, jamais utilisés par une installation normale |

## Conventions

- Messages de commit au format conventionnel (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`) ; branches `feat/...`, `fix/...`.
- Ne pas commiter sur `main` directement : branche, puis pull request.
- Après un changement de code : `npm test`, et pour un changement qui touche l'installation, le lancement ou les mises à
  jour, le script réel correspondant.
- Le dossier `graphify-out/` (graphe de connaissances du dépôt) est ignoré par git.

Voir aussi : [Publier une version](Publier-une-version.md), [Architecture](Architecture.md).
