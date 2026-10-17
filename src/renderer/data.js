// Contenu vitrine : mods inclus dans ATTACK Client et historique des versions.
(function () {
  'use strict';

  const CATEGORIES = [
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
    { name: 'Éditeur de HUD', en_name: 'HUD editor', icon: 'HU', cat: 'hud', fr: 'Coordonnées, mémoire, objets… à placer et styliser librement.', en: 'Coordinates, memory, items… place and style them freely.' },
    { name: 'Combo Counter', icon: 'CC', cat: 'combat', fr: 'Compte tes coups enchaînés sans en prendre.', en: 'Counts hits landed in a row without taking one.' },
    { name: 'Hit Color', icon: 'HC', cat: 'combat', fr: 'Couleur personnalisée quand une cible est touchée.', en: 'Custom tint when a target is hit.' },
    { name: 'Animations 1.7', en_name: '1.7 animations', icon: '17', cat: 'combat', fr: 'Blocage, coup et pose à l’ancienne, plusieurs styles.', en: 'Old-school block, swing and pose, several styles.' },
    { name: 'Mouse Delay Fix', icon: 'MD', cat: 'combat', fr: 'Supprime le délai de clic de la 1.8.', en: 'Removes the 1.8 click delay.' },
    { name: 'Low Health Warning', icon: 'LH', cat: 'combat', fr: 'Alerte visuelle quand ta vie est basse.', en: 'Visual alert when your health is low.' },
    { name: 'Hurt Cam', icon: 'HT', cat: 'visual', fr: 'Règle ou coupe la secousse quand tu prends un coup.', en: 'Tune or remove the camera shake when hit.' },
    { name: 'Zoom', icon: 'ZM', cat: 'visual', fr: 'Zoom fluide à la molette.', en: 'Smooth scroll-wheel zoom.' },
    { name: 'Crosshair', icon: 'CH', cat: 'visual', fr: 'Viseur personnalisé : forme, couleur, taille.', en: 'Custom crosshair: shape, colour, size.' },
    { name: 'Block Overlay', icon: 'BO', cat: 'visual', fr: 'Contour et remplissage du bloc visé.', en: 'Outline and fill for the targeted block.' },
    { name: 'Motion Blur', icon: 'MB', cat: 'visual', fr: 'Flou de mouvement réglable.', en: 'Adjustable motion blur.' },
    { name: 'Fullbright', icon: 'FB', cat: 'visual', fr: 'Voir clair partout, même de nuit.', en: 'See clearly everywhere, even at night.' },
    { name: 'FOV', icon: 'FO', cat: 'visual', fr: 'Champ de vision fixe, sans effet de vitesse.', en: 'Fixed field of view, no speed effect.' },
    { name: 'View Bobbing', icon: 'VB', cat: 'visual', fr: 'Balancement de la caméra à ton goût.', en: 'Camera bobbing to your taste.' },
    { name: 'Nametags', icon: 'NT', cat: 'visual', fr: 'Pseudos plus lisibles, avec ton écusson.', en: 'Clearer nametags, with your badge.' },
    { name: 'Capes ATTACK', en_name: 'ATTACK capes', icon: 'CA', cat: 'visual', fr: 'Capes animées avec physique.', en: 'Animated capes with physics.' },
    { name: 'FPS Boost', icon: 'FB', cat: 'perf', fr: 'Réglages de rendu pour plus d’images par seconde.', en: 'Rendering tweaks for higher frame rates.' },
    { name: 'Scoreboard', icon: 'SB', cat: 'utility', fr: 'Tableau des scores déplaçable et allégé.', en: 'Movable, cleaner scoreboard.' },
    { name: 'Chat', icon: 'CT', cat: 'utility', fr: 'Messages répétés regroupés et chat plus propre.', en: 'Stacks repeated messages, cleaner chat.' },
    { name: 'Nick Hider', icon: 'NH', cat: 'utility', fr: 'Masque ton pseudo à l’écran (enregistrements).', en: 'Hides your name on screen (recordings).' },
  ];

  const CHANGELOG = [
    {
      version: 'Launcher 0.1.0', date: '2026-10-17',
      fr: 'Premier launcher : installe Minecraft 1.8.9, Forge et ATTACK Client en un clic, dans un dossier de jeu séparé, et ajoute le profil au launcher officiel.',
      en: 'First launcher: installs Minecraft 1.8.9, Forge and ATTACK Client in one click, in a separate game folder, and adds the profile to the official launcher.',
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

  window.AttackData = { CATEGORIES, MODS, CHANGELOG };
})();
