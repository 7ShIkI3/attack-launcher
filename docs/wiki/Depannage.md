# Dépannage

[← Sommaire](Home.md)

Où regarder en premier :

| Problème | Fichier à lire |
| --- | --- |
| Le jeu ne démarre pas ou plante (lancement direct) | `<dossier de jeu>\logs\launcher\game-*.log` (lien **Journaux du jeu** sur l'accueil). La première ligne indique le joueur, la deuxième la ligne de commande Java avec le jeton **masqué** |
| La mise à jour du launcher ne se fait pas | `%APPDATA%\ATTACK Launcher\logs\updater.log` |
| Une erreur s'affiche dans le launcher | Le message de l'erreur (voir les tableaux ci-dessous) |

## Windows SmartScreen

Le `.exe` n'est **pas signé** (un certificat de signature de code coûte cher pour un projet gratuit). Au premier lancement,
Windows peut afficher **« Windows a protégé votre ordinateur »**. Pour continuer :

1. Clique sur **Informations complémentaires**.
2. Vérifie que l'éditeur est inconnu et que le fichier vient bien de la page [Releases](https://github.com/7ShIkI3/attack-launcher/releases)
   de ce dépôt.
3. Clique sur **Exécuter quand même**.

Ne télécharge le launcher **que** depuis la page Releases de ce dépôt. Tu peux comparer l'empreinte SHA-256 affichée sur la
release avec celle de ton fichier :

```powershell
Get-FileHash .\ATTACK-Launcher-Setup-x.y.z.exe -Algorithm SHA256
```

## Erreurs de connexion Microsoft

| Message (résumé) | Cause | Que faire |
| --- | --- | --- |
| « Ce compte Microsoft n'a pas de profil Xbox » | Pas de profil Xbox (erreur XSTS `2148916233`) | Connecte-toi une fois sur xbox.com pour le créer, puis réessaie |
| « Xbox Live n'est pas disponible dans le pays de ce compte » | Erreur XSTS `2148916235` | Rien à faire côté launcher : c'est une restriction Xbox du pays du compte |
| « Ce compte doit être vérifié comme adulte sur xbox.com » | Erreurs XSTS `2148916236` ou `2148916237` | Vérifie le compte comme adulte sur xbox.com |
| « C'est un compte enfant » | Erreur XSTS `2148916238` | Un adulte doit ajouter le compte à une famille Microsoft (account.microsoft.com/family) |
| « Ce compte ne possède pas Minecraft Java Edition » | Aucun achat et aucun profil Minecraft | Il faut posséder le jeu (achat ou Game Pass) |
| « Minecraft Java est acheté mais aucun pseudo n'est choisi » | Jeu acheté, pseudo non créé | Crée ton pseudo sur minecraft.net, puis réessaie |
| « Le code a expiré » | Le code d'appareil n'a pas été validé à temps | Relance la connexion et saisis le code plus vite |
| « Connexion refusée sur la page Microsoft » | Tu as refusé l'autorisation | Relance la connexion et accepte |
| « Session Microsoft expirée : reconnecte ce compte » | Le refresh token n'est plus valide (`invalid_grant`) | Déconnecte le compte puis ajoute-le de nouveau |
| « Aucun ID client Azure valide » ou « Cet ID client Azure n'existe pas chez Microsoft » | ID client absent, mal copié ou inexistant | Vérifie Réglages → ID client Azure (format 8-4-4-4-12) ; laisse vide pour l'app officielle |
| « L'app Azure refuse cette connexion » | ID client refusé par Azure | Vérifie l'ID et que « Autoriser les flux de clients publics » est sur **Oui** ([Publier une version](Publier-une-version.md#créer-lapp-azure-une-seule-fois-pour-qui-publie-le-launcher)) |
| « Ton app Azure n'est pas encore validée par Mojang » | Erreur 403 « Invalid app registration » à l'étape Minecraft | Ne concerne que ceux qui utilisent leur propre app Azure : formulaire https://aka.ms/mce-reviewappid, puis jusqu'à 24 h. Sans compte, JOUER passe par le launcher officiel |
| « Trop de connexions Minecraft d'affilée » | Limitation (HTTP 429) | Attends quelques minutes |
| « Microsoft est momentanément indisponible » | `temporarily_unavailable` | Réessaie dans un instant |
| « Connexion impossible à <hôte>. Vérifie ta connexion Internet. » | Réseau, pare-feu ou proxy bloquant cet hôte | Vérifie ta connexion ; autorise les hôtes de la liste de [Installation et mises à jour](Installation-et-mises-a-jour.md#sources-réseau-autorisées) |
| « Chiffrement Windows indisponible : impossible de garder la connexion » | `safeStorage` n'est pas disponible : le launcher refuse d'écrire le jeton en clair | Relance le launcher sous ta session Windows habituelle ; si le problème persiste, signale-le |
| « Adresse refusée (hors des sources officielles) » | Une redirection ou une adresse hors de la liste autorisée | Normal si un proxy ou un portail capte la connexion ; sinon, signale-le |

Les erreurs « Xbox Live a refusé la connexion (HTTP …) », « Autorisation Xbox refusée » ou « Les services Minecraft ont refusé la
connexion (HTTP …) » indiquent un refus du service : réessaie plus tard.

## Erreurs d'installation et de lancement

| Message | Cause | Que faire |
| --- | --- | --- |
| « Aucune version d'ATTACK Client n'est encore publiée » | La dernière release GitHub n'existe pas (404) | Réessaie plus tard ; si tu compiles le mod, active le mode développeur ([Fonctionnalités](Fonctionnalites.md#mode-développeur)) |
| « La release ne publie pas de SHA-256 pour le jar : installation refusée » | La release n'a ni champ `digest` ni fichier `.sha256` | À signaler : la release doit être corrigée ([Publier une version](Publier-une-version.md#publier-le-mod)) |
| « Mode développeur : aucun jar du mod ATTACK pour ce profil trouvé dans le dossier indiqué » | Dossier de jars vide ou mauvais pour ce profil (`attack-client-*.jar` en 1.8.9, `attack-fabric-<version>+mc<mc>.jar` en Fabric) | Compile le mod ou change le dossier (Réglages, profil par profil) |
| « La dernière release d'ATTACK ne contient pas encore de jar pour ce profil » | La release n'a pas de jar pour la version de Minecraft de ce profil | Réessaie après la prochaine release, ou utilise le mode développeur ; les autres profils ne sont pas touchés |
| « Une partie est en cours : ferme le jeu avant d'installer ou de réparer » | Un jar de mod ouvert par le jeu ne peut pas être remplacé ni retiré. Seule une partie jouée dans le dossier de jeu du profil à installer bloque, qu'elle ait été lancée ici ou par le launcher officiel ; si le dossier de la partie est illisible, le launcher bloque par prudence | Ferme le jeu, puis relance l'installation |
| « Un ancien mod du pack n'a pas pu être retiré » | Un ancien jar du pack est verrouillé (jeu encore ouvert) | Ferme le jeu et relance l'installation : le jar reste suivi et sera retiré |
| « Ce dossier de jeu est déjà utilisé par un autre profil » | Deux profils pointent vers le même dossier de jeu (son `attack-launcher.json` appartient à un autre profil) | Choisis un autre dossier pour ce profil dans Réglages |
| « Pack de mods : adresse refusée / SHA-512 invalide… » | Pack figé de `src/main/packs/` modifié ou corrompu | Réinstalle le launcher ; si tu développes, relance `node scripts/resolve-pack.js` |
| Le voyant « Pack de mods » repasse à « à installer » | Un jar du pack manque ou a changé de taille, ou l'option Shaders a changé | Clique sur **INSTALLER** : seuls les fichiers à refaire sont retéléchargés |
| Fabric affiche « Incompatible mods found » | Un jar ajouté à la main dans `mods` est corrompu ou incompatible (le launcher ne les touche jamais) | Retire ce jar du dossier de jeu du profil |
| « SHA-1 / SHA-256 incorrect pour … » ou « Taille incorrecte » | Fichier reçu différent de celui annoncé (réseau instable, proxy) | Relance **Vérifier / réparer l'installation** ; le fichier fautif est supprimé et sera retéléchargé |
| « launcher_profiles.json est illisible : il n'a pas été modifié » | Le JSON du launcher officiel est cassé | Le launcher n'y touche pas : répare ou supprime ce fichier (une copie `.bak` existe peut-être), puis relance |
| « Une installation est déjà en cours » | Deux installations simultanées | Attends la fin de la première |
| « Fichiers manquants (N) : lance Vérifier / réparer l'installation » | Un fichier du jeu est absent au moment de JOUER | Clique sur **Vérifier / réparer l'installation** |
| « Java introuvable : <chemin> » | Le Java personnalisé choisi dans Réglages n'existe plus | Repasse sur « Fourni par Minecraft » ou choisis un autre `javaw.exe` |
| « Runtime Java … indisponible » | Mojang ne publie pas le runtime pour ta plateforme | À signaler |
| « Installation incomplète » au clic sur JOUER | Un des voyants de l'accueil (quatre pour 1.8.9, cinq pour Fabric) n'est pas vert | Clique sur **INSTALLER** |

**Le jeu se ferme tout de suite** : ouvre le dernier `game-*.log` (Journaux du jeu). Pense à la mémoire allouée (Réglages :
2 à 3 Go suffisent pour la 1.8.9, 3 à 4 Go pour 1.21.1 et 26.3 avec le pack, plus ne donne pas plus de FPS). Si tu as mis des
**arguments Java** (Réglages), vide le champ avec « Par défaut » : une option inconnue de ta version de Java (par exemple
`-XX:+UseZGC` sur Java 8) empêche la JVM de démarrer, et le journal le dit en première ligne. Si tu n'as pas de compte connecté, JOUER ouvre le launcher
officiel : c'est lui qui lance alors le jeu, et c'est son journal qu'il faut lire.

**JOUER ouvre le launcher officiel au lieu du jeu** : aucun compte actif (ou compte hors ligne hors mode développeur). Ajoute un
compte Microsoft dans la page **Compte**.

## Skin

| Message | Que faire |
| --- | --- |
| « Ce fichier n'est pas une image PNG » | Choisis un fichier `.png` |
| « Image trop lourde pour un skin (24 Ko au plus) » | Réduis le fichier |
| « Un skin fait 64 x 64 pixels (ou 64 x 32) » | Redimensionne l'image |
| « Session Minecraft expirée : reconnecte le compte » | Déconnecte puis reconnecte le compte |
| « Trop de changements de skin : réessaie dans une minute » | Attends un peu |
| « Skin refusé par Mojang » | Mojang a refusé l'image ; essaie un autre fichier |

## Mises à jour

- **Aucune bannière** : le launcher lancé depuis les sources (`npm start`) ne vérifie rien. Une partie ou une installation en
  cours fait aussi **reporter** la vérification (nouvel essai 10 minutes plus tard, ou dès la fin d'une partie lancée par le
  launcher).
- **Version portable** : elle ne s'installe pas toute seule, elle affiche « Nouvelle version disponible » avec un lien vers la page
  Releases.
- **« Redémarrer » ne fait rien** : il est refusé tant qu'une partie ou une installation tourne. Ferme le jeu d'abord.
- **Rien dans `updater.log` sauf une erreur** : la dernière release doit contenir `latest.yml` et le `Setup.exe` qu'il désigne
  ([Publier une version](Publier-une-version.md)) ; sans eux le launcher note l'erreur et ne propose rien.
- **Version 0.2.0 ou plus ancienne** : pas de mise à jour automatique ; télécharge la 0.3.0 (ou plus) à la main.
- **Fichier rejeté** : un installateur dont le SHA-512 ne correspond pas à `latest.yml` est rejeté et supprimé.

## Autres

- **Le launcher ne s'ouvre pas une deuxième fois** : une seule instance à la fois ; relancer le programme ramène la fenêtre
  existante au premier plan.
- **Désinstaller proprement** : voir [Vie privée et sécurité](Vie-privee-et-securite.md#effacer-ses-données).

Si rien de cela ne résout ton problème, signale-le sur le
[dépôt GitHub](https://github.com/7ShIkI3/attack-launcher) en indiquant la version du launcher (pied de page des Réglages) et
le message exact. **Ne colle jamais de jeton** ; relis un journal avant de le partager.
