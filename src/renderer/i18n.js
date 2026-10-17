// Textes de l'interface en français et en anglais. t('cle', { var }) remplace {var}.
(function () {
  'use strict';
  const STRINGS = {
    fr: {
      'nav.home': 'Accueil',
      'nav.mods': 'Mods',
      'nav.settings': 'Réglages',
      'nav.account': 'Compte',
      'common.soon': 'Bientôt',
      'common.change': 'Changer',
      'common.reset': 'Par défaut',
      'common.browse': 'Parcourir',
      'window.minimize': 'Réduire',
      'window.maximize': 'Agrandir',
      'window.close': 'Fermer',
      'home.play': 'JOUER',
      'home.install': 'INSTALLER',
      'home.installing': 'INSTALLATION',
      'home.playHint': 'Ouvre le launcher officiel sur le profil ATTACK',
      'home.installHint': 'Minecraft 1.8.9, Forge et ATTACK Client',
      'home.checking': 'Vérification…',
      'home.repair': "Vérifier / réparer l'installation",
      'home.openDir': 'Ouvrir le dossier de jeu',
      'home.changelog': 'Nouveautés',
      'home.repo': 'Voir le projet sur GitHub',
      'home.done': 'Installation terminée. Clique sur JOUER.',
      'home.launched': 'Launcher officiel ouvert : le profil « ATTACK Client » est en tête de liste.',
      'home.launchedUnknown': "Launcher officiel introuvable à l'emplacement habituel : ouvre-le toi-même, le profil « ATTACK Client » est prêt.",
      'home.profileNote': 'Ferme le launcher officiel pendant l’installation : il peut réécrire ses profils.',
      'status.minecraft': 'Minecraft 1.8.9',
      'status.forge': 'Forge 11.15.1.2318',
      'status.mod': 'ATTACK Client',
      'status.profile': 'Profil du launcher',
      'status.missing': 'à installer',
      'status.ok': 'prêt',
      'status.dev': 'build local',
      'step.minecraft': 'Minecraft 1.8.9',
      'step.libraries': 'Bibliothèques',
      'step.assets': 'Ressources du jeu',
      'step.forge': 'Forge',
      'step.mod': 'ATTACK Client',
      'step.profile': 'Profil du launcher',
      'error.NO_RELEASE': "Aucune version d'ATTACK Client n'est encore publiée. Réessaie plus tard (ou active le mode développeur dans Réglages si tu compiles le mod).",
      'error.NO_DEV_JAR': 'Mode développeur : aucun attack-client-*.jar trouvé dans le dossier indiqué. Compile le mod ou change le dossier.',
      'error.BUSY': 'Une installation est déjà en cours.',
      'error.generic': 'Échec : {message}',
      'mods.title': 'Mods inclus',
      'mods.subtitle': 'Tout est déjà dans ATTACK Client : active et règle chaque mod en jeu, depuis le menu ATTACK.',
      'mods.count': '{n} mods',
      'mods.all': 'Tous',
      'settings.title': 'Réglages',
      'settings.subtitle': 'Enregistrés automatiquement, appliqués au profil au prochain clic sur JOUER.',
      'settings.saved': 'Enregistré',
      'settings.ram': 'Mémoire allouée',
      'settings.ramHelp': "2 à 3 Go suffisent pour la 1.8.9. Plus n'augmente pas les FPS.",
      'settings.ramWarn': 'Plus de la moitié de la mémoire de ce PC : Windows risque de ralentir.',
      'settings.gameDir': 'Dossier de jeu',
      'settings.gameDirHelp': "Mods, réglages, captures et mondes d'ATTACK Client, séparés de ton .minecraft.",
      'settings.javaHelp': 'Le launcher officiel fournit Java 8 pour la 1.8.9 : garde ce choix sauf besoin précis.',
      'settings.javaBundled': 'Fourni par Minecraft',
      'settings.javaCustom': 'Personnalisé',
      'settings.javaPlaceholder': 'Chemin de javaw.exe',
      'settings.lang': 'Langue',
      'settings.dev': 'Mode développeur',
      'settings.devHelp': 'Installe le dernier jar compilé localement (attack-client-*.jar) au lieu de la release GitHub.',
      'settings.about': 'ATTACK Launcher {version} · fichiers Minecraft : {dir}',
      'account.title': 'Connexion Microsoft',
      'account.text': "La connexion intégrée arrive bientôt. En attendant, connecte-toi dans le launcher Minecraft officiel : JOUER l'ouvre avec le profil ATTACK Client déjà sélectionné.",
      'account.button': 'Se connecter (bientôt)',
    },
    en: {
      'nav.home': 'Home',
      'nav.mods': 'Mods',
      'nav.settings': 'Settings',
      'nav.account': 'Account',
      'common.soon': 'Soon',
      'common.change': 'Change',
      'common.reset': 'Default',
      'common.browse': 'Browse',
      'window.minimize': 'Minimize',
      'window.maximize': 'Maximize',
      'window.close': 'Close',
      'home.play': 'PLAY',
      'home.install': 'INSTALL',
      'home.installing': 'INSTALLING',
      'home.playHint': 'Opens the official launcher on the ATTACK profile',
      'home.installHint': 'Minecraft 1.8.9, Forge and ATTACK Client',
      'home.checking': 'Checking…',
      'home.repair': 'Verify / repair installation',
      'home.openDir': 'Open game folder',
      'home.changelog': "What's new",
      'home.repo': 'View the project on GitHub',
      'home.done': 'Installation complete. Click PLAY.',
      'home.launched': 'Official launcher opened: the “ATTACK Client” profile is at the top of the list.',
      'home.launchedUnknown': 'Official launcher not found in its usual place: open it yourself, the “ATTACK Client” profile is ready.',
      'home.profileNote': 'Close the official launcher while installing: it may rewrite its profiles.',
      'status.minecraft': 'Minecraft 1.8.9',
      'status.forge': 'Forge 11.15.1.2318',
      'status.mod': 'ATTACK Client',
      'status.profile': 'Launcher profile',
      'status.missing': 'not installed',
      'status.ok': 'ready',
      'status.dev': 'local build',
      'step.minecraft': 'Minecraft 1.8.9',
      'step.libraries': 'Libraries',
      'step.assets': 'Game resources',
      'step.forge': 'Forge',
      'step.mod': 'ATTACK Client',
      'step.profile': 'Launcher profile',
      'error.NO_RELEASE': 'No ATTACK Client version has been published yet. Try again later (or enable developer mode in Settings if you build the mod).',
      'error.NO_DEV_JAR': 'Developer mode: no attack-client-*.jar found in that folder. Build the mod or change the folder.',
      'error.BUSY': 'An installation is already running.',
      'error.generic': 'Failed: {message}',
      'mods.title': 'Included mods',
      'mods.subtitle': 'Everything ships with ATTACK Client: enable and tweak each mod in game, from the ATTACK menu.',
      'mods.count': '{n} mods',
      'mods.all': 'All',
      'settings.title': 'Settings',
      'settings.subtitle': 'Saved automatically, applied to the profile the next time you click PLAY.',
      'settings.saved': 'Saved',
      'settings.ram': 'Allocated memory',
      'settings.ramHelp': '2 to 3 GB is enough for 1.8.9. More does not raise FPS.',
      'settings.ramWarn': "More than half of this PC's memory: Windows may slow down.",
      'settings.gameDir': 'Game folder',
      'settings.gameDirHelp': "ATTACK Client's mods, settings, screenshots and worlds, kept apart from your .minecraft.",
      'settings.javaHelp': 'The official launcher ships Java 8 for 1.8.9: keep this unless you have a specific need.',
      'settings.javaBundled': 'Provided by Minecraft',
      'settings.javaCustom': 'Custom',
      'settings.javaPlaceholder': 'Path to javaw.exe',
      'settings.lang': 'Language',
      'settings.dev': 'Developer mode',
      'settings.devHelp': 'Installs the latest locally built jar (attack-client-*.jar) instead of the GitHub release.',
      'settings.about': 'ATTACK Launcher {version} · Minecraft files: {dir}',
      'account.title': 'Microsoft sign-in',
      'account.text': 'Built-in sign-in is coming soon. Meanwhile, sign in from the official Minecraft launcher: PLAY opens it with the ATTACK Client profile already selected.',
      'account.button': 'Sign in (soon)',
    },
  };

  let lang = 'fr';

  function t(key, vars) {
    const text = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.fr[key] || key;
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`)) : text;
  }

  function apply(root = document) {
    document.documentElement.lang = lang;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }

  window.I18n = {
    t,
    apply,
    setLang(value) {
      lang = STRINGS[value] ? value : 'fr';
      apply();
    },
    get lang() {
      return lang;
    },
  };
})();
