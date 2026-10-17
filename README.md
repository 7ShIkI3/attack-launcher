# ATTACK Launcher

Launcher Windows d'**ATTACK Client**, le client PvP pour Minecraft 1.8.9 (Forge).
En un clic, il installe Minecraft 1.8.9, Forge 1.8.9-11.15.1.2318 et le mod ATTACK Client, puis ajoute
un profil « ATTACK Client » au **launcher Minecraft officiel**, que le bouton **JOUER** ouvre ensuite.

![Accueil d'ATTACK Launcher](docs/accueil.png)

> La connexion Microsoft se fait pour l'instant dans le launcher officiel. Une connexion intégrée
> (page « Compte ») arrivera dans une prochaine version.

## Installation

1. Ouvre la page [Releases](https://github.com/7ShIkI3/attack-launcher/releases) et télécharge :
   - `ATTACK-Launcher-Setup-x.y.z.exe` : installateur classique (raccourci dans le menu Démarrer) ;
   - ou `ATTACK-Launcher-Portable-x.y.z.exe` : version portable, sans installation.
2. Lance le fichier. Le launcher Minecraft officiel doit déjà être installé (version Xbox / Microsoft Store
   ou ancienne version) et tu dois posséder Minecraft Java Edition.
3. Clique sur **INSTALLER**, puis sur **JOUER** : le launcher officiel s'ouvre avec le profil
   « ATTACK Client » en tête de liste. Lance la partie depuis ce profil.

### ⚠️ Avertissement Windows SmartScreen

Le `.exe` n'est **pas signé** (un certificat de signature de code coûte cher pour un projet gratuit).
Au premier lancement, Windows peut afficher **« Windows a protégé votre ordinateur »**. Pour continuer :
clique sur **Informations complémentaires**, vérifie que l'éditeur est inconnu et que le fichier vient bien
de la page Releases de ce dépôt, puis clique sur **Exécuter quand même**.

Ne télécharge le launcher **que** depuis la page Releases de ce dépôt. Tu peux comparer l'empreinte
SHA-256 affichée sur la release avec celle de ton fichier :

```powershell
Get-FileHash .\ATTACK-Launcher-Setup-x.y.z.exe -Algorithm SHA256
```

## Ce que fait le launcher (et où vont les fichiers)

| Élément | Emplacement |
| --- | --- |
| Minecraft 1.8.9 (JSON, jar, bibliothèques, ressources) | `%APPDATA%\.minecraft\versions\1.8.9`, `libraries`, `assets` |
| Forge 1.8.9-11.15.1.2318 | `%APPDATA%\.minecraft\versions\1.8.9-forge1.8.9-11.15.1.2318-1.8.9` |
| Dossier de jeu séparé (mods, réglages, captures, mondes) | `%APPDATA%\.attack` (modifiable dans Réglages) |
| Mod ATTACK Client | `%APPDATA%\.attack\mods\attack-client.jar` |
| Profil « ATTACK Client » | fusionné dans `%APPDATA%\.minecraft\launcher_profiles.json` |

- Le **dossier de jeu séparé** évite tout mélange avec les autres mods de ton `.minecraft`.
- `launcher_profiles.json` est **fusionné** : tes autres profils et réglages restent intacts, et l'ancien
  fichier est sauvegardé en `launcher_profiles.json.bak` avant chaque écriture. Ferme le launcher officiel
  pendant l'installation : il peut réécrire ce fichier.
- Réglages : mémoire (-Xmx), dossier de jeu, Java (celui fourni par Minecraft par défaut), langue FR/EN.
- **Vérifier / réparer l'installation** recontrôle chaque fichier et ne retélécharge que ce qui manque ou est abîmé.

## Sécurité

- Sources de téléchargement limitées à : Mojang (`piston-meta`, `piston-data`, `launcher`, `launchermeta`,
  `libraries.minecraft.net`, `resources.download.minecraft.net`), Maven Forge (`maven.minecraftforge.net`)
  et les releases GitHub de ce dépôt. Toute autre adresse, y compris après une redirection, est refusée.
- Chaque fichier est vérifié : SHA-1 publié par Mojang ou par Maven (`.sha1`), SHA-256 pour le mod.
  Un fichier au mauvais hash est supprimé.
- L'installateur Forge est **lu comme une archive ZIP** (on y prend `install_profile.json` et le jar
  universal) : il n'est **jamais exécuté**.
- Fenêtre Electron isolée : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, politique CSP stricte,
  et la page ne parle au processus principal que par une liste fixe d'appels nommés.

## Développement

Prérequis : Node.js 22.12 ou plus récent.

```bash
npm install
```

```bash
npm start
```

| Commande | Rôle |
| --- | --- |
| `npm test` | tests unitaires (`node:test`) : manifestes, install_profile, chemins Maven, fusion des profils, téléchargements |
| `npm run install-test` | installation **réelle** complète dans un dossier temporaire, puis contre-vérification de tous les hash |
| `npm run screenshot -- <dossier>` | ouvre l'app dans des dossiers isolés et capture chaque page |
| `npm run icons` | régénère les icônes PNG à partir des polygones du logo |
| `npm run dist` | construit `dist/ATTACK-Launcher-Setup-*.exe` (NSIS) et `dist/ATTACK-Launcher-Portable-*.exe` |

La logique (`src/main/*.js` sauf `main.js` et `preload.js`) n'utilise pas Electron : elle se teste avec Node seul.

### Mode développeur

Tant qu'aucune release du mod n'est publiée, active **Réglages → Mode développeur** : le launcher copie le
dernier `attack-client-*.jar` du dossier indiqué (par défaut `Documents\pvp-essentials\build\libs`,
ou la variable d'environnement `ATTACK_DEV_JAR_DIR`).

### Publier le mod

Le launcher prend le jar `attack-client*.jar` de la **dernière release** GitHub de ce dépôt et exige son
SHA-256 : celui que GitHub calcule pour chaque fichier de release, ou à défaut un fichier
`attack-client-x.y.z.jar.sha256` joint à la release. Sans SHA-256, l'installation est refusée.

## Dépendances

Aucune dépendance à l'exécution. Outils de développement : `electron` et `electron-builder`.

## Licences et mentions

- Polices **Inter** et **Montserrat** : SIL Open Font License 1.1 (`src/renderer/fonts/OFL-*.txt`).
- Minecraft est une marque de Mojang AB / Microsoft. ATTACK Launcher est un projet indépendant, ni approuvé
  ni affilié à Mojang ou Microsoft. Les fichiers du jeu sont téléchargés depuis les serveurs officiels de Mojang ;
  il faut posséder Minecraft Java Edition pour jouer.
