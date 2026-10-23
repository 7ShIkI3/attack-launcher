// Contenu vitrine : mods inclus dans ATTACK Client et historique des versions.
(function () {
  'use strict';

  const CATEGORIES = [
    { id: 'attack', fr: 'ATTACK', en: 'ATTACK' },
    { id: 'combat', fr: 'Combat', en: 'Combat' },
    { id: 'hud', fr: 'HUD', en: 'HUD' },
    { id: 'visual', fr: 'Visuel', en: 'Visual' },
    { id: 'perf', fr: 'Performance', en: 'Performance' },
    { id: 'utility', fr: 'Utilitaire', en: 'Utility' },
  ];

  const MODS = [
    { name: 'ToggleSprint', icon: 'TS', cat: 'combat', fr: 'Sprint automatique, avec indicateur à l’écran.', en: 'Automatic sprint, with an on-screen indicator.' },
    { name: 'Keystrokes', icon: 'KS', cat: 'hud', fr: 'Touches ZQSD, clics et CPS affichés en direct.', en: 'Movement keys, clicks and CPS shown live.' },
    { name: 'CPS', icon: 'CP', cat: 'hud', fr: 'Clics par seconde, gauche et droit.', en: 'Left and right clicks per second.' },
    { name: 'FPS', icon: 'FP', cat: 'hud', fr: 'Compteur d’images par seconde.', en: 'Frames-per-second counter.' },
    { name: 'Armor Status', icon: 'AS', cat: 'hud', fr: 'Ton armure et l’objet en main, avec leur durabilité.', en: 'Your armor and held item, with durability.' },
    { name: 'Potion Effects', icon: 'PF', cat: 'hud', fr: 'Effets actifs avec leur temps restant.', en: 'Active effects with time left.' },
    { name: 'Coordinates', icon: 'XY', cat: 'hud', fr: 'Ta position X, Y, Z.', en: 'Your X, Y, Z position.' },
    { name: 'Direction', icon: 'DI', cat: 'hud', fr: 'Point cardinal et angle de ton regard.', en: 'Cardinal direction and view angle.' },
    { name: 'Ping', icon: 'PI', cat: 'hud', fr: 'Ta latence avec le serveur, en millisecondes.', en: 'Your latency to the server, in milliseconds.' },
    { name: 'Clock', icon: 'CL', cat: 'hud', fr: 'L’heure réelle à l’écran.', en: 'Real-world time on screen.' },
    { name: 'Memory Usage', icon: 'ME', cat: 'hud', fr: 'Mémoire utilisée par le jeu.', en: 'Memory used by the game.' },
    { name: 'Saturation', icon: 'SU', cat: 'hud', fr: 'Saturation de ta faim, cachée en vanilla.', en: 'Your hunger saturation, hidden in vanilla.' },
    { name: 'Reach Display', icon: 'RD', cat: 'combat', fr: 'Distance de ton dernier coup.', en: 'Distance of your last hit.' },
    { name: 'No Jump Delay', icon: 'NJ', cat: 'combat', fr: 'Sauts sans délai, pour t’entraîner en solo et sur tes serveurs autorisés.', en: 'No jump delay, for practice in singleplayer and on your allowed servers.' },
    { name: 'No Hit Delay', icon: 'ND', cat: 'combat', fr: 'Coups sans délai, pour t’entraîner en solo et sur tes serveurs autorisés.', en: 'No hit delay, for practice in singleplayer and on your allowed servers.' },
    { name: 'Personnalisation', en_name: 'Customization', icon: 'UI', cat: 'utility', fr: '22 polices, thèmes, couleur d’accent, flou et éditeur de HUD.', en: '22 fonts, themes, accent color, blur and HUD editor.' },
    { name: 'Combo Counter', icon: 'CC', cat: 'combat', fr: 'Compte tes coups enchaînés sans en prendre.', en: 'Counts hits landed in a row without taking one.' },
    { name: 'Hit Color', icon: 'HC', cat: 'combat', fr: 'Couleur personnalisée quand une cible est touchée.', en: 'Custom tint when a target is hit.' },
    { name: 'Animations 1.7', en_name: '1.7 animations', icon: '17', cat: 'combat', fr: 'Blocage, coup et pose à l’ancienne, plusieurs styles.', en: 'Old-school block, swing and pose, several styles.' },
    { name: 'Mouse Delay Fix', icon: 'MD', cat: 'combat', fr: 'Corrige le regard en retard d’un tick de la 1.8 : tu vises là où tu regardes.', en: 'Fixes the 1.8 one-tick look delay: you aim where you look.' },
    { name: 'Low Health Warning', icon: 'LH', cat: 'combat', fr: 'Alerte visuelle quand ta vie est basse.', en: 'Visual alert when your health is low.' },
    { name: 'Hurt Cam', icon: 'HT', cat: 'visual', fr: 'Règle ou coupe la secousse quand tu prends un coup.', en: 'Tune or remove the camera shake when hit.' },
    { name: 'Zoom', icon: 'ZM', cat: 'visual', fr: 'Zoom fluide à la molette.', en: 'Smooth scroll-wheel zoom.' },
    { name: 'Crosshair', icon: 'CH', cat: 'visual', fr: 'Viseur personnalisé : forme, couleur, taille.', en: 'Custom crosshair: shape, colour, size.' },
    { name: 'Block Overlay', icon: 'BO', cat: 'visual', fr: 'Contour et remplissage du bloc visé.', en: 'Outline and fill for the targeted block.' },
    { name: 'Clear Glass', icon: 'CG', cat: 'visual', fr: 'Verre sans bordure : le verre blanc devient invisible, le verre teinté une couleur unie.', en: 'Borderless glass: clear glass becomes invisible, stained glass a flat colour.' },
    { name: 'Motion Blur', icon: 'MB', cat: 'visual', fr: 'Flou de mouvement réglable.', en: 'Adjustable motion blur.' },
    { name: 'Fullbright', icon: 'FB', cat: 'visual', fr: 'Voir clair partout, même de nuit.', en: 'See clearly everywhere, even at night.' },
    { name: 'FOV', icon: 'FO', cat: 'visual', fr: 'Champ de vision fixe, sans effet de vitesse.', en: 'Fixed field of view, no speed effect.' },
    { name: 'View Bobbing', icon: 'VB', cat: 'visual', fr: 'Balancement de la caméra à ton goût.', en: 'Camera bobbing to your taste.' },
    { name: 'Nametags', icon: 'NT', cat: 'visual', fr: 'Pseudos plus lisibles, avec ton écusson.', en: 'Clearer nametags, with your badge.' },
    { name: 'Capes ATTACK', en_name: 'ATTACK capes', icon: 'CA', cat: 'visual', fr: '19 capes animées avec physique (dont 12 « Ciné culte ») et 7 paires d’ailes, visibles par tous les joueurs ATTACK.', en: '19 animated capes with physics (12 of them “Cult cinema”) and 7 pairs of wings, seen by every ATTACK player.' },
    { name: 'FPS Boost', icon: 'FX', cat: 'perf', fr: 'Réglages de rendu pour plus d’images par seconde.', en: 'Rendering tweaks for higher frame rates.' },
    { name: 'Scoreboard', icon: 'SB', cat: 'utility', fr: 'Tableau des scores déplaçable et allégé.', en: 'Movable, cleaner scoreboard.' },
    { name: 'Chat', icon: 'CT', cat: 'utility', fr: 'Messages répétés regroupés et chat plus propre.', en: 'Stacks repeated messages, cleaner chat.' },
    { name: 'Amis', en_name: 'Friends', icon: 'AM', cat: 'utility', fr: 'Ajoute tes amis ATTACK par pseudo et discute en privé (touche N) ; messages effacés après 24 h.', en: 'Add your ATTACK friends by name and chat privately (N key); messages erased after 24 h.' },
    { name: 'Nick Hider', icon: 'NH', cat: 'utility', fr: 'Masque ton pseudo à l’écran (enregistrements).', en: 'Hides your name on screen (recordings).' },
    // ATTACK Client 2.1
    { name: 'Perspective', icon: 'PE', cat: 'visual', fr: 'Tourne la caméra autour de toi sans changer ta direction (interdit sur Hypixel).', en: 'Turn the camera around you without changing direction (banned on Hypixel).' },
    { name: 'Minimap', icon: 'MM', cat: 'utility', fr: 'Carte du terrain, carrée ou ronde, avec tes waypoints. Aucun joueur affiché.', en: 'Terrain map, square or round, with your waypoints. No players shown.' },
    { name: 'Waypoints', icon: 'WP', cat: 'utility', fr: 'Points avec faisceau et distance, par serveur ; touche ou /wp.', en: 'Points with a beam and distance, per server; key or /wp.' },
    { name: 'Hitboxes', icon: 'HB', cat: 'visual', fr: 'Hitboxes en couleur, hauteur des yeux et direction du regard.', en: 'Colored hitboxes, eye height and look direction.' },
    { name: 'Item Physics', icon: 'IP', cat: 'visual', fr: 'Les objets au sol tombent à plat au lieu de flotter.', en: 'Dropped items lie flat instead of floating.' },
    { name: 'Enchant Glint', icon: 'EG', cat: 'visual', fr: 'Couleur et vitesse de la brillance des objets enchantés.', en: 'Color and speed of the enchantment shine.' },
    { name: 'Environment Changer', icon: 'EC', cat: 'visual', fr: 'Heure et météo à ton goût, sur ton écran seulement.', en: 'Time of day and weather of your choice, on your screen only.' },
    { name: 'Particles', icon: 'PA', cat: 'visual', fr: 'Plus de particules de critique et d’aiguisage à chaque coup.', en: 'More critical and sharpness particles on each hit.' },
    { name: 'Container Blur', icon: 'CB', cat: 'visual', fr: 'Flou derrière l’inventaire et les coffres.', en: 'Blur behind the inventory and chests.' },
    { name: 'Color Saturation', icon: 'CS', cat: 'visual', fr: 'Couleurs plus vives ou plus ternes.', en: 'More vivid or duller colors.' },
    { name: 'Clean View', icon: 'CV', cat: 'visual', fr: 'Cache les particules de tes propres potions.', en: 'Hides your own potion particles.' },
    { name: 'Titles', icon: 'TI', cat: 'visual', fr: 'Réduit ou cache les grands titres au centre de l’écran.', en: 'Shrink or hide the big titles in the middle of the screen.' },
    { name: 'Tab List', icon: 'TL', cat: 'utility', fr: 'Ping en chiffres colorés dans la liste des joueurs.', en: 'Ping as colored numbers in the player list.' },
    { name: 'Potion Counter', icon: 'PC', cat: 'hud', fr: 'Potions de soin (et soupes) qu’il te reste.', en: 'Healing potions (and soups) you have left.' },
    { name: 'Item Counter', icon: 'IC', cat: 'hud', fr: 'Flèches, pommes d’or, perles et blocs dans ton inventaire.', en: 'Arrows, golden apples, pearls and blocks in your inventory.' },
    { name: 'Cooldowns', icon: 'CD', cat: 'combat', fr: 'Temps avant de relancer une perle ou remanger une pomme d’or.', en: 'Time before your next pearl or golden apple.' },
    { name: 'W-Tap Counter', icon: 'WT', cat: 'combat', fr: 'Compte tes W-taps réussis pendant un combo.', en: 'Counts your successful W-taps during a combo.' },
    { name: 'Speed', icon: 'SP', cat: 'hud', fr: 'Ta vitesse en blocs par seconde.', en: 'Your speed in blocks per second.' },
    { name: 'Session Timer', icon: 'ST', cat: 'hud', fr: 'Temps de jeu de la session et chronomètre.', en: 'Session playtime and a stopwatch.' },
    { name: 'Day Counter', icon: 'DC', cat: 'hud', fr: 'Numéro du jour dans le monde.', en: 'Current day number in the world.' },
    { name: 'Pack Display', icon: 'PD', cat: 'hud', fr: 'Pack de ressources actif, avec son icône.', en: 'Active resource pack, with its icon.' },
    { name: 'Server Address', icon: 'SA', cat: 'hud', fr: 'Adresse et icône du serveur.', en: 'Server address and icon.' },
    { name: 'Boss Bar', icon: 'BB', cat: 'hud', fr: 'Déplace, réduis ou cache la barre de boss.', en: 'Move, shrink or hide the boss bar.' },
    { name: 'Auto Text', icon: 'AT', cat: 'utility', fr: '6 touches qui envoient un message ou une commande.', en: '6 keys that send a message or a command.' },
    { name: 'Sound Changer', icon: 'SC', cat: 'utility', fr: 'Volume des coups, pas, explosions, ambiance, XP et arc.', en: 'Volume of hits, steps, explosions, ambience, XP and bow.' },
  ];

  const CHANGELOG = [
    {
      version: 'Launcher 0.5.10', date: '2026-10-23',
      fr: 'La connexion Microsoft abandonne au bout de 30 secondes si un serveur ne répond plus, au lieu de rester bloquée. En anglais, les erreurs courantes (Java introuvable, fichiers manquants, mémoire) sont enfin traduites.',
      en: 'Microsoft sign-in now gives up after 30 seconds if a server stops answering, instead of hanging. In English, common errors (Java not found, missing files, memory) are now translated.',
    },
    {
      version: 'ATTACK Client 3.3', date: '2026-10-23',
      fr: 'En 1.21.1 et 26.3 : les Amis (touche N) : ajoute un joueur ATTACK, vois qui est en ligne et discute en privé. Aussi : écran titre ATTACK, bouton « ATTACK Mods » dans le menu Échap, vue libre (Alt gauche), minuteurs de la perle et de la pomme d’or, et force du flou des menus réglable.',
      en: 'On 1.21.1 and 26.3: Friends (N key): add an ATTACK player, see who is online and chat privately. Also: ATTACK title screen, “ATTACK Mods” button in the Escape menu, free look (left Alt), ender pearl and golden apple timers, and adjustable menu blur strength.',
    },
    {
      version: 'ATTACK Client 3.2.1', date: '2026-10-23',
      fr: 'En 1.21.1 et 26.3 : le logo ATTACK s’affiche à gauche du pseudo des joueurs ATTACK, comme en 1.8.9, de ta couleur d’accent et doré pour les admins. Réglage « Logo à côté du pseudo » dans les Cosmétiques.',
      en: 'On 1.21.1 and 26.3: the ATTACK logo shows left of the name of ATTACK players, as on 1.8.9, in your accent colour and gold for admins. “Logo next to names” setting in Cosmetics.',
    },
    {
      version: 'Launcher 0.5.7', date: '2026-10-23',
      fr: 'Plus fiable : une coupure réseau ou l’antivirus ne font plus échouer l’installation, le jeu se lance hors ligne si Java est déjà là, et un double clic sur JOUER ne lance plus deux parties. Corrigé : comptes qui réapparaissaient après suppression, parties non reconnues dans un dossier avec accents, erreurs de réglages affichées au mauvais endroit.',
      en: 'More reliable: a network drop or the antivirus no longer breaks the installation, the game starts offline when Java is already there, and a double click on PLAY no longer starts two games. Fixed: accounts coming back after removal, games not recognised in a folder with accents, settings errors shown in the wrong place.',
    },
    {
      version: 'ATTACK Client 3.2', date: '2026-10-22',
      fr: 'En 1.21.1 et 26.3 : nouveau réglage Taille des ailes (onglet Ailes des Cosmétiques, de 50 à 150 %), vu par tous les joueurs ATTACK, en 1.8.9 comme en Fabric. Corrigé : le bout des ailes Ange et Phénix n’est plus coupé.',
      en: 'On 1.21.1 and 26.3: new Wing size setting (Wings tab of Cosmetics, 50 to 150%), seen by every ATTACK player, on 1.8.9 and Fabric alike. Fixed: the tips of the Angel and Phoenix wings are no longer cut off.',
    },
    {
      version: 'ATTACK Client 3.1.1', date: '2026-10-22',
      fr: 'En 26.3, les clics de souris sont bien reconnus : le CPS et les Keystrokes comptent le bon bouton, et le clic gauche active à nouveau les mods dans le menu. L’écran Cosmétiques (1.21.1 et 26.3) prend le style du menu.',
      en: 'On 26.3, mouse clicks are read correctly: CPS and Keystrokes count the right button, and a left click toggles mods in the menu again. The Cosmetics screen (1.21.1 and 26.3) now matches the menu style.',
    },
    {
      version: 'ATTACK Client 2.5.1', date: '2026-10-22',
      fr: 'Nouveau réglage Taille des ailes (Cosmétiques, de 50 à 150 %) : les autres joueurs ATTACK te voient à ta taille. Corrigé : le bout des ailes Ange et Phénix n’est plus coupé.',
      en: 'New Wing size setting (Cosmetics, 50 to 150%): other ATTACK players see you at your size. Fixed: the tips of the Angel and Phoenix wings are no longer cut off.',
    },
    {
      version: 'ATTACK Client 2.5', date: '2026-10-22',
      fr: 'Nouveau module Clear Glass (Visuel, 62e) : verre sans bordure ni traits, le verre blanc devient invisible et le verre teinté une couleur unie, sans pack de ressources. Corrigé : décimales du Speed HUD, ailes avec la cape physique, réglages qui perdaient leurs commentaires, messages d’amis parfois cachés, petites fuites de mémoire graphique.',
      en: 'New Clear Glass module (Visual, 62nd): borderless glass, clear glass becomes invisible and stained glass a flat colour, no resource pack needed. Fixed: Speed HUD decimals, wings with the physics cape, settings losing their comments, friend messages sometimes hidden, small graphics memory leaks.',
    },
    {
      version: 'Launcher 0.5.3', date: '2026-10-22',
      fr: 'Réglage Arguments Java par profil (Réglages). Pack 1.21.1 à jour : Sodium 0.8.13 et Iris 1.8.14 (bêta). Corrigé : un dossier de jeu déplacé pouvait être oublié au redémarrage ; mise à jour du launcher et lancement plus robustes, messages d’erreur plus clairs.',
      en: 'Per-profile Java arguments setting (Settings). Updated 1.21.1 pack: Sodium 0.8.13 and Iris 1.8.14 (beta). Fixed: a moved game folder could be forgotten on restart; sturdier launcher updates and game launch, clearer error messages.',
    },
    {
      version: 'ATTACK Client 2.4', date: '2026-10-21',
      fr: 'Menu Amis (touche N, ou l’onglet Amis du menu) : ajoute un ami par son pseudo s’il utilise ATTACK Client, accepte les demandes, vois qui est en ligne et discute en privé. Les messages sont effacés 24 h après leur envoi ; rien n’est envoyé avant ta première ouverture du menu.',
      en: 'Friends menu (N key, or the Friends tab of the menu): add a friend by name if they use ATTACK Client, accept requests, see who is online and chat privately. Messages are erased 24 h after they are sent; nothing is sent before you first open the menu.',
    },
    {
      version: 'ATTACK Client 3.1', date: '2026-10-20',
      fr: 'En 1.21.1 et 26.3, Maj droite ouvre le même menu qu’en 1.8.9 : onglets, recherche, 39 mods à activer et régler (HUD complet, viseur, FOV, Fullbright, ToggleSprint, Auto Text…), éditeur de HUD par glisser-déposer et écran Personnaliser. Tes réglages FPS, CPS et touches sont repris.',
      en: 'On 1.21.1 and 26.3, Right Shift opens the same menu as on 1.8.9: tabs, search, 39 mods to toggle and tune (full HUD, crosshair, FOV, Fullbright, ToggleSprint, Auto Text…), drag-and-drop HUD editor and Customize screen. Your FPS, CPS and keystrokes settings are kept.',
    },
    {
      version: 'ATTACK Client 2.3.1', date: '2026-10-20',
      fr: 'Moins de saccades en combat : minimap calculée par petits morceaux, capes et pseudos sans déchets mémoire à chaque image, FPS Boost plus léger, Motion Blur qui ne se recharge plus à chaque menu.',
      en: 'Fewer stutters in combat: minimap computed in small steps, capes and nametags without per-frame garbage, lighter FPS Boost, Motion Blur no longer reloaded with every menu.',
    },
    {
      version: 'Launcher 0.5.0', date: '2026-10-20',
      fr: 'Trois profils au choix sur l’accueil : 1.8.9 (Forge, comme avant), 1.21.1 et 26.3 (Fabric). Chacun a son dossier de jeu et son Java officiel (8, 21 ou 25). Les profils Fabric installent un pack de mods de performance figé, vérifié par SHA-512 : Fabric API, Sodium, Lithium, FerriteCore, ImmediatelyFast, Mod Menu, et Iris pour les shaders en option.',
      en: 'Three profiles to pick from on the home page: 1.8.9 (Forge, as before), 1.21.1 and 26.3 (Fabric). Each has its own game folder and official Java (8, 21 or 25). Fabric profiles install a pinned performance mod pack, checked by SHA-512: Fabric API, Sodium, Lithium, FerriteCore, ImmediatelyFast, Mod Menu, and Iris for optional shaders.',
    },
    {
      version: 'Launcher 0.4.0', date: '2026-10-19',
      fr: 'Page Compte : ton skin en 3D (il marche, court ou se repose), et change-le sans quitter le launcher : aperçu, bras classiques ou fins, ou retour au skin par défaut.',
      en: 'Account page: your skin in 3D (walking, running or idle), and change it without leaving the launcher: preview, classic or slim arms, or back to the default skin.',
    },
    {
      version: 'ATTACK Client 2.3', date: '2026-10-19',
      fr: 'Des ailes en plus des capes : Ange, Démon, Dragon, Papillon, Phénix, Cristal et ATTACK, qui battent au repos et s’ouvrent en l’air. Avec les 12 capes « Ciné culte », tous les joueurs ATTACK les voient sur toi, quel que soit le serveur.',
      en: 'Wings on top of capes: Angel, Demon, Dragon, Butterfly, Phoenix, Crystal and ATTACK, flapping at rest and opening in the air. Like the 12 “Cult cinema” capes, every ATTACK player sees them on you, on any server.',
    },
    {
      version: 'Launcher 0.3.3', date: '2026-10-18',
      fr: 'Accueil plus net : les nouveautés tiennent sans faire défiler la page, et « Tout voir » ouvre l’historique complet des versions.',
      en: 'Cleaner home page: what’s new fits without scrolling the page, and “See all” opens the full version history.',
    },
    {
      version: 'ATTACK Client 2.2', date: '2026-10-18',
      fr: 'Nouvelle cape animée N2T-48, réservée aux admins ATTACK et aux joueurs choisis : tout le monde la voit dans le menu Cosmétiques, et les joueurs ATTACK la voient sur ceux qui la portent. Livrée avec le launcher 0.3.2.',
      en: 'New animated N2T-48 cape, reserved for ATTACK admins and chosen players: everyone sees it in the Cosmetics menu, and ATTACK players see it on those who wear it. Shipped with launcher 0.3.2.',
    },
    {
      version: 'Launcher 0.3.1', date: '2026-10-18',
      fr: 'L’accueil affiche la bonne version du mod (v2.1.0) et le README indique les bons dossiers. Première mise à jour livrée automatiquement aux launchers 0.3.0.',
      en: 'The home page shows the right mod version (v2.1.0) and the README lists the right folders. First update delivered automatically to 0.3.0 launchers.',
    },
    {
      version: 'Launcher 0.3.0', date: '2026-10-17',
      fr: 'Mise à jour automatique : le launcher télécharge ses nouvelles versions en arrière-plan (jamais pendant une partie) et les installe au redémarrage. Version portable : un simple avis.',
      en: 'Automatic updates: the launcher downloads new versions in the background (never during a game) and installs them on restart. Portable version: a simple notice.',
    },
    {
      version: 'Launcher 0.2.0', date: '2026-10-17',
      fr: 'Connexion Microsoft intégrée (plusieurs comptes) et lancement direct du jeu avec Java 8 officiel, sans passer par le launcher Minecraft.',
      en: 'Built-in Microsoft sign-in (multiple accounts) and direct game launch with official Java 8, without the Minecraft launcher.',
    },
    {
      version: 'Launcher 0.1.0', date: '2026-10-17',
      fr: 'Premier launcher : installe Minecraft 1.8.9, Forge et ATTACK Client en un clic, dans un dossier de jeu séparé, et ajoute le profil au launcher officiel.',
      en: 'First launcher: installs Minecraft 1.8.9, Forge and ATTACK Client in one click, in a separate game folder, and adds the profile to the official launcher.',
    },
    {
      version: 'ATTACK Client 2.1', date: '2026-10-17',
      fr: '25 nouveaux modules : Perspective, Minimap, Waypoints, Hitboxes, Item Physics, compteurs de potions et d’objets, Cooldowns, Tab List, Sound Changer… soit 60 modules au total.',
      en: '25 new modules: Perspective, Minimap, Waypoints, Hitboxes, Item Physics, potion and item counters, Cooldowns, Tab List, Sound Changer… 60 modules in total.',
    },
    {
      version: 'ATTACK Client 2.0', date: '',
      fr: 'Personnalisation complète (thèmes, couleur d’accent, arrondis, flou), nouvelles polices, animations de coup et de pose.',
      en: 'Full customisation (themes, accent colour, roundness, blur), new fonts, swing and pose animations.',
    },
    {
      version: 'FPS Boost', date: '',
      fr: 'Nouveau module de performances.',
      en: 'New performance module.',
    },
    {
      version: 'Logo et capes', version_en: 'Logo & capes', date: '',
      fr: 'Logo ATTACK, capes animées avec physique et menu Cosmétiques.',
      en: 'ATTACK logo, animated capes with physics and a Cosmetics menu.',
    },
    {
      version: 'Interface', date: '',
      fr: 'Interface façon Lunar, menu Mods à cartes, Nametags et animations 1.7.',
      en: 'Lunar-style interface, card-based Mods menu, Nametags and 1.7 animations.',
    },
  ];

  // Mods du pack Fabric (src/main/packs/) : icône, catégorie et description. La version vient du pack figé.
  const PACK_INFO = {
    'fabric-api': { icon: 'FA', cat: 'utility', fr: 'Bibliothèque commune dont dépendent presque tous les mods Fabric.', en: 'Shared library almost every Fabric mod depends on.' },
    sodium: { icon: 'SO', cat: 'perf', fr: 'Moteur de rendu optimisé : beaucoup plus d’images par seconde.', en: 'Optimized renderer: many more frames per second.' },
    lithium: { icon: 'LI', cat: 'perf', fr: 'Accélère la logique du jeu (entités, physique, génération) sans rien changer au gameplay.', en: 'Speeds up game logic (entities, physics, generation) without changing gameplay.' },
    'ferrite-core': { icon: 'FC', cat: 'perf', fr: 'Réduit la mémoire utilisée par le jeu.', en: 'Cuts the memory the game uses.' },
    immediatelyfast: { icon: 'IF', cat: 'perf', fr: 'Accélère l’affichage de l’interface, du texte et des objets.', en: 'Speeds up drawing of the interface, text and items.' },
    modmenu: { icon: 'MM', cat: 'utility', fr: 'Liste les mods installés et ouvre leurs réglages depuis le menu du jeu.', en: 'Lists installed mods and opens their settings from the game menu.' },
    iris: { icon: 'IR', cat: 'visual', fr: 'Packs de shaders, avec la version faite pour le Sodium du pack. Option « Shaders » des Réglages.', en: 'Shader packs, using the version made for the pack’s Sodium. “Shaders” option in Settings.' },
  };

  window.AttackData = { CATEGORIES, MODS, CHANGELOG, PACK_INFO };
})();
