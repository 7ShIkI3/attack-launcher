# Vie privée et sécurité

[← Sommaire](Home.md)

Cette page décrit **le launcher** : ce qu'il envoie, à qui, ce qu'il garde sur ton PC, et comment il se protège.
Elle ne couvre ni le mod ATTACK Client ni Minecraft lui-même, qui ont leurs propres connexions une fois le jeu lancé
(Mojang, serveurs de jeu, API ATTACK des cosmétiques : voir le dépôt `attack-client`). Chaque affirmation a été
vérifiée dans le code ; les références sont de la forme `fichier:ligne` (les références `fichier:ligne` datent de la version 0.5.x : les numéros de ligne ont pu bouger depuis, les noms de fonctions restent ; le contenu décrit la version 0.6.0 : pack de mods des trois profils, groupes réglables, OptiFine en 1.8.9).

## En bref

- **Aucune télémétrie.** Le launcher n'a ni statistiques d'usage, ni rapport de plantage, ni identifiant d'installation
  ou de machine, ni publicité. Voir [la recherche faite](#télémétrie--ce-qui-a-été-cherché).
- Il ne parle qu'à **Mojang, Microsoft / Xbox, Forge (Maven), Fabric (`meta.fabricmc.net`, `maven.fabricmc.net`), le CDN
  de Modrinth (`cdn.modrinth.com`) et GitHub** : la liste est fixe et codée en dur.
- Il **ne contacte pas l'API ATTACK** ni **l'API de Modrinth** (aucune des deux n'est dans la liste des hôtes autorisés) :
  les mods du pack sont des adresses et des hash écrits dans le dépôt.
- Il **ne télécharge jamais OptiFine** (sa licence l'interdit) : il copie seulement la copie que tu as récupérée toi-même (avec l'assistant, il surveille ton dossier Téléchargements pendant 10 minutes au plus, sans accès réseau), après
  l'avoir validée ; le lien optifine.net s'ouvre dans ton navigateur, le launcher n'y fait aucune requête.
- **WalksyLib** (mod PvP du pack Fabric) interroge `api.modrinth.com` au démarrage du jeu pour chercher des mises à jour, avec
  l'empreinte de chaque mod : le launcher écrit une fois sa configuration de départ pour couper cette vérification
  (`config/WalksyLib/walksylib.json`, clé « Notify For New Updates » à `false`), seulement si ce fichier n'existe pas. Tu peux la
  rallumer dans l'écran de réglages de WalksyLib. WalksyLib recopie ce fichier dans son fichier partagé
  `%APPDATA%\WalksyLib\walksylib.json` s'il n'y a pas encore de réglage d'apparence : un réglage déjà là n'est jamais changé.
  Mod Menu et Crystal Optimizer ont chacun leur propre vérification de mises à jour, laissée telle quelle.
- Il ne voit **jamais ton mot de passe** Microsoft.
- Le jeton Minecraft reste **en mémoire** ; le jeton de renouvellement est **chiffré par Windows**.
- Tout fichier téléchargé est **vérifié par un hash** ; la page d'interface **n'a pas le droit de faire de requête réseau**.

## Télémétrie : ce qui a été cherché

Recherche faite dans `src/`, `scripts/` et `package.json` des termes suivants : `telemetry`, `analytics`, `sentry`,
`crashReporter`, `gtag`, `mixpanel`, `amplitude`, `posthog`, `machineId`, `hwid`, `hostname()`, `os.userInfo`,
`networkInterfaces`, `beacon`. **Aucun résultat.** Les seuls appels `fetch` du code sont dans `src/main/http.js:37` (téléchargements
vers les hôtes autorisés), et la page d'interface n'en fait aucun : sa politique CSP contient `connect-src 'none'`
(`src/renderer/index.html:5-6`).

La seule dépendance d'exécution, `electron-updater`, ne contient pas non plus de code de télémétrie (recherche faite
dans son code installé et celui de `builder-util-runtime`). **Non vérifié** : le comportement réseau interne de Chromium / Electron lui-même, en dehors du
code du launcher.

Ce que le launcher envoie malgré tout est inévitable pour son fonctionnement (télécharger, se connecter, se mettre à
jour), et détaillé ci-dessous.

## Ce qui part, et à qui

Toute requête réseau révèle ton **adresse IP** au serveur qui la reçoit. Les requêtes du launcher portent l'en-tête
`User-Agent: ATTACK-Launcher (+https://github.com/7ShIkI3/attack-launcher)` (`http.js:12`), sans version ni identifiant.

| Moment | Destinataires | Ce qui est envoyé | Réf. |
| --- | --- | --- | --- |
| Démarrage, puis toutes les 6 h (version installée **ou** portable) | `github.com` (page de la dernière release, `latest.yml`) | Requêtes HTTPS sans jeton ni identifiant | `updates.js:9`, `updates.js:123-124` |
| Démarrage, si un compte Microsoft est actif | Microsoft, Xbox Live, XSTS, `api.minecraftservices.com` | Refresh token (renouvellement), puis jetons de la chaîne de connexion | `main.js:517-526` |
| INSTALLER, Vérifier / réparer | Mojang (manifestes, jar, bibliothèques, ressources), Maven Forge (1.8.9 et 1.7.10), `meta.fabricmc.net` et `maven.fabricmc.net` (Fabric), `cdn.modrinth.com` (pack de mods des trois profils qui en ont un), `api.github.com` et les fichiers de la release | Requêtes GET de fichiers publics | `installer.js` |
| Ajouter un compte | `login.microsoftonline.com`, `user.auth.xboxlive.com`, `xsts.auth.xboxlive.com`, `api.minecraftservices.com`, `textures.minecraft.net` | ID client Azure, code d'appareil, jetons de la chaîne ; le jeton Minecraft sert à lire le profil | `auth.js:93-231` |
| JOUER avec un compte | `piston-meta.mojang.com` (manifeste du runtime Java ; fichiers la première fois) ; si le jeton Minecraft manque ou expire, Microsoft, Xbox, Minecraft | Requêtes GET ; jetons de renouvellement | `runtime.js:60-70`, `accounts.js:119-130` |
| Skin : Appliquer, Par défaut, Actualiser | `api.minecraftservices.com`, puis `textures.minecraft.net` | Jeton Minecraft (en-tête `Authorization`) ; **le PNG choisi, seulement au clic sur Appliquer** | `skins.js:57-80`, `main.js:254-260` |
| Clic sur un lien | Ton navigateur : page de validation Microsoft, dépôt GitHub, page Releases, `portal.azure.com`, `aka.ms/mce-reviewappid` | Rien venant du launcher : il ouvre une adresse fixe (ou la page Microsoft renvoyée, après contrôle du domaine) | `main.js:28`, `main.js:373-380`, `updates.js:13` |

Détails utiles :

- Le **jeton d'accès Microsoft** est envoyé à Xbox Live (`RpsTicket`), puis le jeton XSTS à `login_with_xbox` ; le jeton
  Minecraft n'est envoyé (en-tête `Authorization: Bearer`) qu'à `api.minecraftservices.com` (`auth.js:154`, `auth.js:178`,
  `auth.js:35-50`).
- Les images de skin sont demandées à `textures.minecraft.net` **sans jeton** (`main.js:131-140`).
- La détection « une partie tourne-t-elle ? » est **locale** (PowerShell lit les lignes de commande des processus Java) :
  rien n'en sort (`game.js:178-197`).
- Le **jeu lancé** (Java + Minecraft + Forge + ATTACK Client) a ses propres connexions : le launcher lui passe le jeton
  Minecraft en argument (`--accessToken`), comme tout launcher.

## Ce qui reste sur ton PC

| Emplacement | Contenu | Chiffré ? | Réf. |
| --- | --- | --- | --- |
| `%APPDATA%\ATTACK Launcher\accounts.json` | Pour chaque compte : identifiant (UUID), pseudo, type, image du skin (`data:` URL), modèle de bras, date d'ajout ; **refresh token** | Le refresh token : **oui** (DPAPI). Le reste : non (pas de secret) | `accounts.js:67-75` |
| `%APPDATA%\ATTACK Launcher\settings.json` | Mémoire, dossier de jeu, Java, arguments Java, langue, mode développeur, dossier des jars de test, ID client Azure (pas un secret) ; par profil : groupes du pack (Mods PvP, Packs OptiFine, Replay Mod, Shaders) et OptiFine (réglage et chemin du fichier choisi, `optifineJar`) | Non | `settings.js:53-74` |
| `%APPDATA%\ATTACK Launcher\logs\updater.log` | Journal des mises à jour (dates, versions, erreurs) et erreurs imprévues du processus principal (message et pile) ; passe en `.old` au-delà de 1 Mo | Non | `main.js:74-90` |
| `%LOCALAPPDATA%\ATTACK Launcher\runtime` | Java officiel de Mojang du profil (Java 8, 21 ou 25) | Non | `main.js:33-35` |
| `%LOCALAPPDATA%\attack-launcher-updater` | Mise à jour téléchargée en attente d'installation (cache d'`electron-updater`) | Non | `app-update.yml` généré par electron-builder |
| `%APPDATA%\.minecraft\...` | Versions, bibliothèques, ressources, `launcher_profiles.json` (+ `.bak`) | Non | [Installation](Installation-et-mises-a-jour.md) |
| `%APPDATA%\.attack\...` | Mod, mods du pack (et copie d'OptiFine en 1.8.9), état d'installation `attack-launcher.json`, `logs\launcher\game-*.log` | Non | `installer.js:201-207`, `game.js:162-165` |

- Aucun de ces fichiers n'est envoyé nulle part par le launcher.
- Le **jeton Minecraft n'est jamais écrit sur disque** : il vit dans une `Map` en mémoire (`accounts.js:27`).
- Le journal du jeu (`game-*.log`) contient la ligne de commande Java **avec le jeton masqué** (`<masqué>`), ton pseudo, des
  chemins de dossiers, puis la sortie du jeu. Ne le partage qu'après relecture, comme tout journal.
- Electron range aussi ses propres fichiers internes dans le dossier de données du launcher (non détaillés ici).

## Protections en place

| Risque | Protection | Réf. |
| --- | --- | --- |
| Téléchargement depuis un site non officiel | Liste fixe d'hôtes `https` ; chaque redirection est vérifiée **avant** d'être suivie ; au plus 5 redirections | `constants.js:27-44`, `http.js:22-45` |
| Fichier corrompu ou remplacé | Hash obligatoire (SHA-1, SHA-256 ou SHA-512) calculé pendant le téléchargement ; `.part` supprimé si le hash ou la taille ne correspondent pas ; téléchargement sans hash refusé | `http.js:98-130`, `mod.js:28` |
| Installateur Forge ou jar OptiFine piégé (bombe de décompression) | Lu comme une archive ZIP, **jamais exécuté** ; id de version et nom du jar contrôlés ; dépôts Maven limités à Forge et Mojang ; la taille annoncée par l'archive est contrôlée avant de décompresser et la décompression s'arrête à cette taille (`MANIFEST.MF` d'un jar OptiFine : 1 Mo au plus, `install_profile.json` : 8 Mo, jar universal : 64 Mo) | `forge.js:13-41`, `zip.js`, `optifine.js:57-69` |
| Profil Fabric piégé | JSON de `meta.fabricmc.net` validé strictement (id, version de Minecraft, classe Knot, dépôts `maven.fabricmc.net` / Mojang seulement, hash bien formés, une seule option Java acceptée (valeur exacte de `-DFabricMcEmu=`), aucun argument du jeu), puis réécrit à partir des seuls champs connus ; SHA-1 de `fabric-loader` et `intermediary` figés dans le catalogue | `fabric.js`, `catalog.js` |
| Mod du pack falsifié ou mal nommé | Adresse figée sur `cdn.modrinth.com` uniquement, SHA-512 et taille vérifiés avant de garder le fichier, nom de fichier sans chemin, jars du joueur jamais supprimés | `modpack.js` |
| Chemins malveillants (`..`, absolus) dans des manifestes | `safeJoin` refuse de sortir du dossier ; coordonnées Maven validées ; chemins du runtime Java contrôlés ; extraction des natives par `safeJoin` | `maven.js:5-25`, `maven.js:40-47`, `runtime.js:36-50`, `game.js:75-91` |
| Argument Java piégé (tutoriel qui fait coller une option) | Liste d'autorisation : seules `-Xms`/`-Xss`/`-Xmn`, les `-XX:` à valeur simple (sans celles qui lancent une commande, lisent ou écrivent un fichier) et quelques `-D` sans risque passent. Refusés notamment : agents Java, `-Xbootclasspath`, `-Xrun`, `-Dfabric.addMods` (chargerait un jar), `-Dminecraft.api.*` (enverrait le jeton ailleurs), `-XX:VMOptionsFile`, vidages mémoire (contiendraient le jeton). Vérifié à l'enregistrement et revérifié au lancement | `jvmargs.js`, `main.js` (`settings:set`), `game.js` (`buildCommand`) |
| Fuite du jeton Minecraft | Gardé en mémoire ; jamais transmis à la page ; masqué dans les journaux (`--accessToken`, `--session`, ou toute occurrence) | `accounts.js:27`, `preload.js:1-3`, `game.js:133-139` |
| Vol du refresh token sur disque | Chiffré par `safeStorage` (DPAPI) ; si le chiffrement est indisponible, la connexion échoue plutôt que d'écrire en clair | `main.js:50-58` |
| Page d'interface compromise | `contextIsolation`, `sandbox`, pas de `nodeIntegration` ; CSP stricte ; ouverture de fenêtres et navigation bloquées ; messages IPC acceptés uniquement depuis `index.html`, par une liste fixe de canaux | `main.js:66-71`, `main.js:434-445`, `index.html:5-6`, `preload.js` |
| Réglage forgé | Chaque réglage est validé (type, bornes, chemin absolu, format GUID de l'ID client) | `settings.js:45-74` |
| Skin piégé | Signature PNG, 24 Ko au plus, 64 x 64 ou 64 x 32, modèle `classic` ou `slim` | `skins.js:22-35` |
| Liens ouverts par le launcher | Adresses fixes ; page Microsoft ouverte seulement si `https` et domaine `microsoft.com`, `microsoftonline.com` ou `live.com` | `main.js:28`, `main.js:373-380`, `updates.js:13` |
| Écrasement du profil du launcher officiel | Fusion, copie `.bak`, écriture atomique, fichier illisible jamais écrasé | `profiles.js:54-72` |
| Compte hors ligne détourné | Réservé au mode développeur (canal refusé sinon), jeton « 0 » | `main.js:236-238` |
| Faille Log4Shell | Configuration log4j de Mojang passée au jeu | `game.js:123-127` |
| Mise à jour pendant une partie | Jamais ; voir [Installation et mises à jour](Installation-et-mises-a-jour.md) | `updates.js:134-236` |
| Mise à jour falsifiée | SHA-512 de `latest.yml` vérifié par `electron-updater` ; fichier non conforme rejeté. Pas de jeton GitHub embarqué | `main.js:105`, `updates.js:174` |
| Lancer deux launchers à la fois | Instance unique | `main.js:528` |

## Limites et points non vérifiés

- **Le `.exe` n'est pas signé** : Windows SmartScreen met en garde au premier lancement ([Dépannage](Depannage.md)). Il n'y a pas
  de vérification de signature d'éditeur pour les mises à jour ; seul le SHA-512 est contrôlé.
- **Hash et fichier viennent du même serveur** pour le `.sha1` de Maven Forge et pour le SHA-256 du mod (champ `digest` de
  GitHub ou fichier joint à la release) : ils détectent la corruption, pas une compromission du serveur ou du compte GitHub
  du projet.
- **DPAPI** protège contre la copie du fichier vers un autre compte ou PC, pas contre un programme qui s'exécute sous ta
  propre session Windows.
- **Jeton visible pendant la partie** dans les arguments du processus Java, comme avec tout launcher.
- **Pas d'option pour couper la vérification des mises à jour** (Réglages : mémoire, dossier de jeu, Java, arguments Java, langue, mode
  développeur, ID client). La version portable la fait aussi. Seul un pare-feu l'empêche.
- **Durées de conservation chez les tiers** (Microsoft, Mojang, GitHub, Forge) : non vérifiées, elles dépendent de leurs
  politiques.
- **Le launcher ne révoque pas** le refresh token chez Microsoft quand tu cliques Déconnecter : il l'efface seulement de ton PC.

## Effacer ses données

1. **Déconnecter** chaque compte (page Compte) : supprime son refresh token chiffré et son skin en cache de `accounts.json`.
2. Désinstalle le launcher (ou supprime le `.exe` portable).
3. Supprime à la main, si tu veux tout effacer : `%APPDATA%\ATTACK Launcher`, `%LOCALAPPDATA%\ATTACK Launcher` (runtime Java) et
   `%LOCALAPPDATA%\attack-launcher-updater` (cache de mise à jour).
4. Facultatif : `%APPDATA%\.attack` (mod, mondes, captures, journaux du jeu) et, dans `%APPDATA%\.minecraft`, le profil
   « ATTACK Client » (ou « ATTACK 1.21.1 », « ATTACK 26.3 ») de `launcher_profiles.json` (et sa copie `launcher_profiles.json.bak`)
   et les versions Forge ou Fabric installées. Minecraft lui-même (ses versions, `libraries` et `assets` dans `.minecraft`) est
   partagé avec le launcher officiel : ne le supprime que si tu n'en as plus besoin.

Voir aussi : [Comptes et skin](Comptes-et-skin.md), [Architecture](Architecture.md).
