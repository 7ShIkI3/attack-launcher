// Logique de l'interface : navigation, état d'installation, bouton JOUER, vitrine des mods, réglages, comptes, historique et crédits.
// Aucun innerHTML ni style en ligne (CSP stricte) : tout le DOM est construit avec el() / textContent.
(function () {
  'use strict';
  const api = window.attack;
  const { t } = window.I18n;
  const { CATEGORIES, MODS, CHANGELOG, PACK_INFO, LICENSE_NAMES } = window.AttackData;
  const $ = (id) => document.getElementById(id);
  const NBSP = ' ';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let info = null;
  let settings = null;
  let status = null;
  let busy = false;
  let playing = false; // lancement du jeu en cours
  let statusToken = 0; // ignore une lecture d'état arrivée après un changement de profil
  let modFilter = 'all';
  let modState = 'all'; // filtre Activés / Désactivés
  let modQuery = '';
  const DENSITIES = ['comfortable', 'compact', 'list'];
  const DENSITY_KEY = 'attack.modsDensity';
  /** Densité des cartes de la page Mods, retenue d'une session à l'autre quand le stockage de la page le permet. */
  function readDensity() {
    try {
      const value = window.localStorage.getItem(DENSITY_KEY);
      return DENSITIES.includes(value) ? value : 'comfortable';
    } catch {
      return 'comfortable';
    }
  }
  let modDensity = readDensity();
  let historyKind = 'all';
  let progress = { percent: 0, step: '', done: 0, total: 0 };
  let accountsView = { accounts: [], hasClientId: false, devMode: false };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  /** Icône du sprite de index.html (<use href="#i-…">). */
  function icon(name, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `ic ${className}`.trim());
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const nb = (text) => String(text).replace(/ /g, NBSP);

  /**
   * Groupe à choix unique (profils, onglets, boutons segmentés, filtres) : UN SEUL arrêt de tabulation (l'élément choisi ; le premier si
   * aucun ne l'est), les autres sont atteints aux flèches. `radio` : pose aussi role="radio" et aria-checked (les onglets ont déjà leur
   * aria-selected dans le HTML).
   */
  function syncRoving(container, isCurrent, { radio = false } = {}) {
    const items = [...container.querySelectorAll('button')];
    const current = items.find(isCurrent) || items[0];
    for (const item of items) {
      item.tabIndex = item === current ? 0 : -1;
      if (radio) {
        item.setAttribute('role', 'radio');
        item.setAttribute('aria-checked', String(isCurrent(item)));
      }
    }
  }
  /**
   * Flèches (et Début / Fin) dans un groupe à choix unique : le focus et le choix passent à l'élément voisin, comme avec des boutons
   * radio. Le clic est celui de l'élément, donc il refait le rendu comme une souris le ferait (le focus est repris par data-focus-key).
   */
  function enableArrows(container) {
    container.addEventListener('keydown', (event) => {
      const items = [...container.querySelectorAll('button')].filter((button) => !button.disabled);
      const index = items.indexOf(document.activeElement);
      if (index === -1 || event.altKey || event.ctrlKey || event.metaKey) return;
      let next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = items[(index + 1) % items.length];
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
      else if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items[items.length - 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.click();
    });
  }
  const isActive = (button) => button.classList.contains('active');

  /** Le titre d'une page prend le focus (focalisable par programme seulement, hors de l'ordre de tabulation) : Tab mène ensuite à sa première commande. */
  function focusHeading(page) {
    const heading = page && page.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  /**
   * Remplace le contenu d'un conteneur en gardant le focus clavier : si l'élément qui l'a (un bouton, un interrupteur) est recréé, le
   * nouvel élément de même `data-focus-key` le reprend. Sans cela le focus retombait sur <body> après chaque interrupteur ou puce.
   * Si l'élément a disparu (carte sortie du filtre, compte retiré, bouton sans clé…), `fallback(clé)` donne une cible stable de la page ;
   * à défaut, la première commande du conteneur, puis le titre de la page : le focus ne retombe jamais sur <body>.
   * Il n'est jamais touché quand il n'était pas dans le conteneur.
   */
  function replaceKeepingFocus(container, nodes, fallback) {
    const active = document.activeElement;
    const inside = Boolean(active && active.dataset && container.contains(active));
    const key = inside ? active.dataset.focusKey || '' : '';
    container.replaceChildren(...nodes);
    if (!inside) return;
    let next = key ? [...container.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === key) : null;
    // assistant OptiFine : le bouton activé disparaît avec l'état (Annuler, Utiliser ce fichier…) ; le titre du nouvel état prend le focus
    if (!next && key.startsWith('assist:')) next = container.querySelector(`[data-focus-key="${key.split(':', 2).join(':')}:title"]`);
    // page Mods : la copie est devenue utilisable, la carte OptiFine remplace l'assistant par son interrupteur, qui prend le focus
    if (!next && key.startsWith('assist:mods:')) next = container.querySelector('[data-focus-key="mod:optifine"]');
    const free = (node) => (node && !node.disabled ? node : null); // une commande grisée ne prend pas le focus
    // jamais une commande destructive (Déconnecter…) : avec Entrée maintenue, la répétition de la touche la déclencherait aussitôt
    const safe = (node) => !node.disabled && !node.classList.contains('danger');
    next = free(next) || (fallback && free(fallback(key))) || [...container.querySelectorAll('button, input')].find(safe) || null;
    if (next) next.focus({ preventScroll: true });
    else focusHeading([...document.querySelectorAll('.page')].find((page) => page.contains(container)));
  }

  // --- navigation ---
  function closeReady() {
    $('ready-pop').hidden = true;
    $('ready-btn').setAttribute('aria-expanded', 'false');
  }
  function showPage(page) {
    // le focus est dans une page qui va être masquée (bouton de l'alerte, lien de l'accueil…) : il ne doit pas retomber sur <body>
    const leaving = [...document.querySelectorAll('.page')].some((p) => p.id !== `page-${page}` && p.contains(document.activeElement));
    document.querySelectorAll('.nav-item').forEach((b) => {
      const on = b.dataset.page === page;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    if (leaving) focusHeading($(`page-${page}`)); // le titre de la page affichée reprend le focus
    closeReady();
    // la vue 3D du skin ne dessine que sur la page Compte (sinon WebGL tourne en continu, même pendant une partie)
    document.dispatchEvent(new CustomEvent('attack:page', { detail: page }));
  }
  window.showPage = showPage;
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

  // --- fenêtre ---
  $('wc-min').addEventListener('click', () => api.window.minimize());
  $('wc-max').addEventListener('click', () => api.window.maximize());
  $('wc-close').addEventListener('click', () => api.window.close());
  // SVG constant généré par logo.js (aucune donnée externe), lu comme un document SVG plutôt qu'injecté en HTML
  function mountSvg(node, text) {
    node.replaceChildren(document.importNode(new DOMParser().parseFromString(text, 'image/svg+xml').documentElement, true));
  }
  mountSvg($('titlebar-logo'), window.AttackLogo.svg({ id: 'tb', size: 18 }));
  mountSvg($('hero-logo'), window.AttackLogo.svg({ id: 'hero', size: 104, glow: true }));
  mountSvg($('empty-logo'), window.AttackLogo.svg({ id: 'empty', size: 120, glow: true }));

  // --- notification et message ---
  let toastTimer = null;
  function showToast(text, kind = 'ok') {
    const toast = $('toast');
    $('toast-text').textContent = text;
    toast.classList.toggle('ok', kind === 'ok');
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }
  /**
   * Erreurs de l'accueil : action proposée selon le code (le texte dit déjà quoi faire, le bouton le fait).
   * Les autres erreurs n'ont que « Copier » (pour un rapport de bug) et la croix.
   */
  const toAccount = { label: 'home.connect', run: () => showPage('account') };
  const toSettings = { label: 'alert.settings', run: () => { showPage('settings'); selectTab('profile'); } };
  const toRepair = { label: 'home.repairShort', run: () => !busy && !playing && runInstall() };
  const ALERT_ACTIONS = {
    LAUNCHER_NOT_FOUND: toAccount, NO_ACCOUNT: toAccount, SESSION_EXPIRED: toAccount,
    JAVA_NOT_FOUND: toSettings, JAVA_UNAVAILABLE: toSettings, HEAP_TOO_BIG: toSettings, GAMEDIR_IN_USE: toSettings,
    FILES_MISSING: toRepair, PACK_CLEANUP: toRepair,
  };
  let alertAction = null;

  /** Copie un texte dans le presse-papiers (API moderne, sinon sélection d'un champ caché). */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = el('textarea', { class: 'offscreen', readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
        area.value = text;
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  /**
   * Réussite : notification ; erreur : bloc d'alerte posé sur la ligne « prêt » et les outils (il ne décale plus la page) ; vide : efface
   * tout. `code` : code d'erreur du processus principal, qui décide du bouton d'action.
   */
  function setMessage(text, kind = '', code = '') {
    const inline = Boolean(text) && kind !== 'ok';
    const focusInAlert = !inline && $('alert').contains(document.activeElement); // l'alerte se ferme avec le focus dedans (croix, bouton d'action)
    const focusInLower = inline && $('lower').contains(document.activeElement); // l'alerte s'ouvre sur la commande qui a le focus (Dossier de jeu, Journaux…)
    $('message').textContent = inline ? text : '';
    $('alert').classList.toggle('hidden', !inline);
    $('lower').inert = inline; // les commandes recouvertes par l'alerte ne sont plus atteignables au clavier
    if (focusInAlert) $('ready-btn').focus({ preventScroll: true }); // le bouton disparaît avec l'alerte : la ligne « prêt », qu'elle recouvrait, le reprend
    alertAction = inline ? ALERT_ACTIONS[code] || null : null;
    $('alert-action').classList.toggle('hidden', !alertAction);
    if (alertAction) $('alert-action').textContent = t(alertAction.label);
    // ces commandes viennent de devenir inertes avec le focus dedans : l'alerte, annoncée aux lecteurs d'écran, le prend au lieu de <body>
    if (focusInLower) (alertAction ? $('alert-action') : $('alert-copy')).focus({ preventScroll: true });
    if (text && kind === 'ok') showToast(text);
    if (!text) $('toast').classList.remove('show');
  }
  $('alert-action').addEventListener('click', () => {
    const action = alertAction;
    setMessage('');
    if (action) action.run();
  });
  $('alert-close').addEventListener('click', () => setMessage(''));
  $('alert-copy').addEventListener('click', async () => {
    const copied = await copyText($('message').textContent);
    $('alert-copy').textContent = t(copied ? 'alert.copied' : 'alert.copyFailed');
    setTimeout(() => {
      $('alert-copy').textContent = t('alert.copy');
    }, 1500);
  });

  // --- profils (version de Minecraft + chargeur de mods) ---
  const profileList = () => (info && info.profiles) || [];
  const currentProfile = () => profileList().find((p) => p.id === (settings && settings.profileId)) || profileList()[0] || null;
  const loaderName = (profile) => (profile.loaderType === 'fabric' ? 'Fabric' : 'Forge');
  const isFabric = (profile) => Boolean(profile) && profile.loaderType === 'fabric';

  /** Sous-titre de l'accueil et cartes de profil (désactivées pendant une installation ou un lancement). */
  function renderProfiles() {
    const profile = currentProfile();
    if (!profile) return;
    $('hero-sub').textContent = `Minecraft ${profile.mc} · ${loaderName(profile)} ${profile.loaderVersion}`;
    replaceKeepingFocus($('profile-select'), profileList().map((p) => {
      const button = el('button', { type: 'button', class: `profile${p.id === profile.id ? ' active' : ''}`, role: 'radio', 'aria-checked': String(p.id === profile.id), 'data-profile': p.id, 'data-focus-key': `profile:${p.id}` }, [
        el('span', { class: 'pv' }, [el('b', { text: p.label }), el('em', { text: loaderName(p) })]),
        el('span', { class: 'ps', text: t(`home.tag.${p.id}`) }),
      ]);
      button.disabled = busy || playing;
      button.addEventListener('click', () => switchProfile(p.id));
      return button;
    }));
    syncRoving($('profile-select'), isActive, { radio: true });
  }
  enableArrows($('profile-select'));

  async function switchProfile(id) {
    if (busy || playing || !settings || id === settings.profileId) return;
    setMessage('');
    progress = { percent: 0, step: '', done: 0, total: 0 };
    statusToken++; // une lecture d'état déjà partie pour l'ancien profil sera ignorée
    status = null; // l'état du profil précédent ne doit pas rester affiché
    renderStatus();
    // changement refusé (disque plein, antivirus) : le profil revient en arrière, on le dit ici, sur l'accueil
    const failure = await save({ profileId: id }, { showError: false });
    if (failure) setMessage(t('error.generic', { message: failure }), 'error');
  }

  // --- groupes du pack : un réglage par profil chacun ---
  /**
   * Groupes de mods du pack avec leur réglage. `match` : les mods du pack concernés ; `on()` : réglage actuel ;
   * `tag` : étiquette des cartes de la page Mods. Un groupe sans mod dans le pack du profil n'apparaît pas (Fabric : les 4, 1.8.9 : Replay Mod).
   */
  const PACK_GROUPS = [
    { id: 'shaders', setting: 'shaders', match: (m) => m.optional, on: () => Boolean(settings.shaders), title: 'settings.shaders', help: 'settings.shadersHelp', tag: 'mods.optional' },
    { id: 'pvp', setting: 'pvpMods', match: (m) => m.group === 'pvp', on: () => settings.pvpMods !== false, title: 'settings.pvp', help: 'settings.pvpHelp', tag: 'mods.pvp' },
    { id: 'optifine', setting: 'optifinePacks', match: (m) => m.group === 'optifine', on: () => settings.optifinePacks !== false, title: 'settings.optifinePacks', help: 'settings.optifinePacksHelp', tag: 'mods.optifinePacks' },
    { id: 'replay', setting: 'replayMod', match: (m) => m.group === 'replay', on: () => Boolean(settings.replayMod), title: 'settings.replay', help: 'settings.replayHelp', tag: 'mods.replay' },
  ];
  const groupOf = (mod) => PACK_GROUPS.find((g) => g.match(mod)) || null;
  const groupsOf = (profile) => PACK_GROUPS.filter((g) => profile.pack.some(g.match));
  const modSelected = (mod) => {
    const group = groupOf(mod);
    return !group || group.on();
  };

  /** Mods du pack qui seront installés avec les réglages actuels. */
  const selectedPack = (profile) => profile.pack.filter(modSelected);

  /** OptiFine du joueur (profil 1.8.9) : la copie sera-t-elle dans le jeu ? (copiée par le launcher, déjà mise là par le joueur, ou gardée dans mods alors que son origine a disparu) */
  function optifineInGame() {
    const of = status && status.optifine;
    return Boolean(of && ((of.enabled && of.found) || of.own || of.kept));
  }

  /** Nombre de mods installés : le pack choisi, plus l'OptiFine du joueur. Le même nombre partout (accueil, rail, page Mods). */
  function modCount(profile) {
    return selectedPack(profile).length + (profile.hasOptifine && optifineInGame() ? 1 : 0);
  }

  const modsText = (n) => t('home.mods', { n });

  /** Variante d'OptiFine lisible : « OptiFine HD U M5 ». */
  const optifineLabel = (of) => `OptiFine${of && of.version ? ` ${of.version.replace(/_/g, ' ')}` : ''}`;

  // --- accueil : état, JOUER, ligne « prêt » ---
  const launchAccount = () => {
    const active = accountsView.accounts.find((a) => a.active);
    return active && (active.type === 'msa' || (settings && settings.devMode)) ? active : null;
  };

  /** Lignes du détail : { label, state: 'ok' | 'bad' | 'info', detail, remove? }. `bad` = travail en attente ; `remove` : c'est un retrait, pas une installation. */
  function statusRows(profile) {
    const rows = [];
    const ok = (label, good, detail, badDetail) => rows.push({ label, state: good ? 'ok' : 'bad', detail: good ? detail || t('status.ok') : badDetail || t('status.missing') });
    ok(t('status.minecraft', { mc: profile.mc }), status && status.minecraft);
    ok(t(`status.loader.${profile.loaderType}`, { version: profile.loaderVersion }), status && status.loader);
    if (profile.hasPack) {
      const tags = [];
      if (settings.shaders && profile.pack.some((m) => m.optional)) tags.push('Iris');
      if (isFabric(profile) && settings.pvpMods !== false) tags.push('PvP');
      if (isFabric(profile) && settings.optifinePacks !== false) tags.push('OptiFine');
      if (settings.replayMod) tags.push('Replay');
      ok(t('status.pack'), status && status.pack, [modsText(selectedPack(profile).length), ...tags].join(' · '));
    }
    if (profile.hasOptifine && status && status.optifine) {
      const of = status.optifine;
      let state = 'ok';
      let detail;
      const remove = Boolean(of.pending && !of.wantCopy); // copie du launcher à retirer (option coupée, OptiFine du joueur arrivé dans mods)
      if (remove) { state = 'bad'; detail = t('optifine.stateToRemove'); }
      else if (of.own) detail = t('optifine.stateOwn');
      else if (of.kept) detail = t('optifine.stateKept');
      else if (!of.enabled) { state = 'info'; detail = t('optifine.stateOff'); }
      else if (!of.found) { state = 'info'; detail = t('optifine.stateMissing'); }
      else if (of.pending) { state = 'bad'; detail = t('optifine.stateToCopy'); }
      else detail = optifineLabel(of);
      rows.push({ label: 'OptiFine', state, detail, remove });
    }
    const modDetail = status && status.modVersion ? `v${status.modVersion}${status.modSource === 'dev' ? ` · ${t('status.dev')}` : ''}` : null;
    ok(t('status.mod'), status && status.mod, modDetail);
    ok(t('status.profile'), status && status.profile);
    return rows;
  }

  /** « Ressources du jeu 358/5147 » : l'étape en cours (le pourcentage global est déjà dans le bouton JOUER). */
  function progressSummary(profile) {
    return progress.step ? t(`step.${progress.step}`, { mc: profile.mc }) + (progress.total > 1 ? ` ${progress.done}/${progress.total}` : '') : '';
  }

  /** Chaque évènement de progression ne met à jour que le bouton et la ligne « prêt » (pas toute la page : il y en a des milliers). */
  function renderProgress() {
    const profile = currentProfile();
    if (!profile) return;
    if (busy) {
      $('play-fill').style.width = `${progress.percent}%`;
      $('play-label').textContent = t('home.installingPct', { n: Math.floor(progress.percent) });
    }
    if (busy || playing) $('ready-sum').textContent = progressSummary(profile);
  }

  function renderStatus() {
    const profile = currentProfile();
    if (!profile) return;
    const rows = statusRows(profile);
    const bad = rows.filter((r) => r.state === 'bad');
    const checking = !status;
    const needs = !checking && (!status.installed || bad.length > 0);
    const mode = busy ? 'installing' : checking ? 'checking' : needs ? 'missing' : 'ready';
    document.body.dataset.install = mode;
    document.body.dataset.launch = playing ? '1' : '';

    // ligne « prêt » : une phrase à la place de 4 ou 5 tuiles, le détail s'ouvre à la demande
    const stateIcon = busy ? 'refresh' : needs ? 'info' : 'check';
    $('ready-icon').replaceChildren(...icon(stateIcon).childNodes);
    // peu d'éléments à installer : on les nomme ; sinon leur nombre (le détail les liste) ; rien à installer (seulement un retrait, ou
    // un état inattendu) : texte générique, jamais « À installer : » sans rien derrière
    const toInstall = bad.filter((r) => !r.remove);
    const needsText = toInstall.length === 0 ? t('home.needsUpdate') : toInstall.length > 2 ? t('home.needsMany', { n: toInstall.length }) : t('home.needs', { items: toInstall.map((r) => r.label).join(', ') });
    $('ready-main').textContent = busy ? t('home.installingNow') : checking ? t('home.checking') : needs ? needsText : t('home.ready');
    let summary = '';
    if (busy || playing) summary = progressSummary(profile);
    else if (!checking && !needs) summary = [profile.hasPack || profile.hasOptifine ? modsText(modCount(profile)) : null, status.modVersion ? t('home.clientVersion', { version: status.modVersion }) : 'ATTACK Client'].filter(Boolean).join(' · ');
    $('ready-sum').textContent = summary;
    $('ready-pop').replaceChildren(...rows.map((r) => el('div', { class: `pop-row${r.state === 'bad' ? ' bad' : r.state === 'info' ? ' info' : ''}` }, [
      el('span', { class: 'r-ico' }, [icon(r.state === 'ok' ? 'check' : 'info')]),
      el('span', {}, [el('b', { text: r.label }), el('small', { text: r.detail })]),
    ])));

    // JOUER : même bouton, même taille ; la progression est dans le bouton, la phrase dessous garde sa hauteur
    const button = $('play-button');
    const account = launchAccount();
    button.disabled = busy || playing || checking;
    button.classList.toggle('busy', busy || playing);
    $('play-fill').style.width = busy ? `${progress.percent}%` : '0%';
    $('play-label').textContent = playing ? t('home.launching') : busy ? t('home.installingPct', { n: Math.floor(progress.percent) }) : checking ? '…' : status.installed ? t('home.play') : t('home.install');
    const caption = $('play-caption');
    if (playing) {
      caption.replaceChildren(account ? el('span', {}, [t('home.launchingAsPre'), el('b', { text: account.name }), '…']) : t('home.launchingOfficial'));
    } else if (busy) {
      caption.replaceChildren(t('home.profileNote'));
    } else if (checking) {
      caption.replaceChildren();
    } else if (!status.installed) {
      caption.replaceChildren(t(isFabric(profile) ? 'home.installHintFabric' : 'home.installHintForge', { mc: profile.mc }));
    } else if (account) {
      const offline = account.type !== 'msa';
      caption.replaceChildren(
        el('span', { class: 'mini-avatar' }, [avatarCanvas(account, 18)]),
        el('span', {}, [t('home.playAsPre'), el('b', { text: account.name }), offline ? t('home.playAsOffline') : '']),
      );
    } else {
      const connect = el('button', { class: 'link accent', type: 'button', text: t('home.connect') });
      connect.addEventListener('click', () => showPage('account'));
      caption.replaceChildren(`${t('home.playOfficial', { name: nb(profile.name) })}${NBSP}· `, connect);
    }
    renderProfiles();
    renderProfileCard(profile);
    renderPending();
  }

  /** Carte « Profil actuel » du rail : mémoire, Java et ce que le profil installe. */
  function renderProfileCard(profile) {
    $('pc-sub').textContent = t('pc.sub', { name: nb(profile.name) });
    const java = el('dd', { text: `${profile.javaMajor} ` }, [el('small', { text: settings.javaPath ? t('pc.custom') : t('pc.minecraft') })]);
    const cells = [
      [t('pc.ram'), el('dd', { text: formatRam(settings.ramMb) })],
      ['Java', java],
      [t('pc.pack'), el('dd', { text: status || !profile.hasOptifine ? modsText(modCount(profile)) : '…' })],
    ];
    if (isFabric(profile)) cells.push([t('pc.pvp'), el('dd', { text: settings.pvpMods !== false ? t('pc.on') : t('pc.off') })]);
    else cells.push(['OptiFine', el('dd', { text: !status || !status.optifine ? '…' : optifineInGame() ? (status.optifine.version ? status.optifine.version.replace(/_/g, ' ') : t('pc.onOne')) : status.optifine.enabled ? t('optifine.stateMissing') : t('pc.offOne') })]);
    $('pc-grid').replaceChildren(...cells.map(([label, value]) => el('div', {}, [el('dt', { text: label }), value])));
  }

  $('ready-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    const open = $('ready-pop').hidden;
    $('ready-pop').hidden = !open;
    $('ready-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!$('ready-pop').contains(event.target)) closeReady();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeReady();
  });

  async function refreshStatus() {
    const token = ++statusToken;
    const next = await api.status();
    if (token !== statusToken) return;
    status = next;
    renderStatus();
    renderMods(); // la carte ATTACK de la page Mods affiche la version installée
    renderSettings();
  }

  function errorText(result) {
    const key = `error.${result.code}`;
    const text = t(key, { message: result.message || '' });
    if (text !== key) return text;
    // messages d'erreur du processus principal : déjà rédigés en français
    return window.I18n.lang === 'fr' && result.message ? result.message : t('error.generic', { message: result.message });
  }

  /** Appel au processus principal qui peut rejeter (disque, compte inconnu) : l'erreur s'affiche au lieu de figer la page. */
  async function guarded(action, show = (text) => setMessage(text, 'error')) {
    try {
      return await action();
    } catch (error) {
      show(errorText({ code: error?.code || 'ERROR', message: String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
      return null;
    }
  }

  /** Appel au processus principal qui renvoie { ok, ... } : un rejet (IPC refusé) devient un échec affichable. */
  async function call(action) {
    try {
      return await action();
    } catch (error) {
      return { ok: false, code: error?.code || 'ERROR', message: String(error?.message || error) };
    }
  }

  async function runInstall() {
    busy = true;
    progress = { percent: 0, step: '', done: 0, total: 0 };
    setMessage('');
    renderStatus();
    const result = await call(() => api.install());
    busy = false;
    if (result.ok) {
      progress.percent = 100;
      setMessage(t('home.done'), 'ok');
    } else {
      setMessage(errorText(result), 'error', result.code);
    }
    await refreshStatus();
    return result.ok;
  }

  api.onProgress((p) => {
    progress = { percent: p.percent, step: p.step, done: p.done, total: p.total };
    // pendant le lancement direct (Java, connexion) la progression ne change que le texte : le bouton reste à « LANCEMENT »
    renderProgress();
  });

  $('play-button').addEventListener('click', async () => {
    if (busy || playing) return;
    if (!status || !status.installed) {
      await runInstall();
      return;
    }
    playing = true;
    setMessage('');
    renderStatus();
    const profile = currentProfile();
    const result = await call(() => api.play());
    playing = false;
    renderStatus();
    if (result.ok && result.mode === 'direct') setMessage(t('home.launchedDirect', { name: result.name }), 'ok');
    else if (result.ok) setMessage(t('home.launched', { name: profile.name }), 'ok');
    else if (result.code === 'NOT_INSTALLED') await refreshStatus();
    else setMessage(errorText(result), 'error', result.code);
  });
  $('repair-button').addEventListener('click', () => !busy && !playing && runInstall());
  $('open-dir-button').addEventListener('click', () => guarded(() => api.openGameDir()));
  $('repo-button').addEventListener('click', () => api.openRepo());
  $('about-repo').addEventListener('click', () => api.openRepo());
  $('logs-button').addEventListener('click', () => guarded(() => api.openLogs()));
  $('profile-settings').addEventListener('click', () => {
    showPage('settings');
    selectTab('profile');
  });

  // --- Nouveautés et historique ---
  const entryKind = (entry) => entry.kind || (/^Launcher/.test(entry.version) ? 'launcher' : /^ATTACK Client/.test(entry.version) ? 'client' : 'other');
  const entryText = (entry) => entry[window.I18n.lang] || entry.fr;
  /** Phrases du texte (une puce chacune). */
  const entryBullets = (entry) => entryText(entry).split(/(?<=[.!?])\s+(?=[A-ZÉÈÀ«“"(])/).filter(Boolean);
  /** Titre court (celui de l'entrée, sinon sa première phrase) et détail (le reste du texte, en puces). */
  function entryParts(entry) {
    const lines = entryBullets(entry);
    const own = entry[`title_${window.I18n.lang}`] || entry.title_fr;
    if (own) {
      // la première phrase qui répète le titre (« Plus de FPS en 1.21.1 et 26.3 : Entity Culling… ») garde seulement la suite
      if (lines[0] && lines[0].toLowerCase().startsWith(own.toLowerCase())) {
        const rest = lines[0].slice(own.length).replace(/^[\s:,–-]+/, '');
        if (rest) lines[0] = rest.charAt(0).toUpperCase() + rest.slice(1);
        else lines.shift();
      }
      return { title: own, lines };
    }
    const [first = '', ...rest] = lines;
    return { title: first.length > 80 ? `${first.slice(0, 77)}…` : first, lines: rest };
  }
  const entryTag = (entry) => entry.tag && ['perf', 'new', 'fix', 'tweak'].includes(entry.tag) ? entry.tag : null;
  const parseDate = (text) => (/^\d{4}-\d{2}-\d{2}$/.test(text || '') ? new Date(`${text}T12:00:00`) : null);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  /** « 30 oct. » ; « Aujourd'hui » le jour même, sauf dans le rail des Nouveautés (today: false) où la date courte garde la place du titre. */
  function dateLabel(text, long = false, { today = true } = {}) {
    const date = parseDate(text);
    if (!date) return '';
    const now = new Date();
    if (today && sameDay(date, now)) return t('home.today');
    return new Intl.DateTimeFormat(window.I18n.lang === 'en' ? 'en-GB' : 'fr-FR', {
      day: 'numeric', month: long ? 'long' : 'short', ...(date.getFullYear() !== now.getFullYear() || long ? { year: 'numeric' } : {}),
    }).format(date);
  }

  const NEWS_ON_HOME = 3;
  function renderNews() {
    $('changelog').replaceChildren(...CHANGELOG.slice(0, NEWS_ON_HOME).map((entry) => {
      const tag = entryTag(entry);
      const date = dateLabel(entry.date, false, { today: false });
      const { title, lines } = entryParts(entry);
      return el('li', { class: 'news-item' }, [
        el('div', { class: 'n-top' }, [
          el('span', { class: 'n-who', text: entry[`version_${window.I18n.lang}`] || entry.version }, date ? [el('em', { class: 'nd', text: ` · ${date}` })] : []),
          ...(tag ? [el('span', { class: `tag ${tag}`, text: t(`tag.${tag}`) })] : []),
        ]),
        el('h4', { class: 'n-title', text: title }),
        ...(lines.length > 0 ? [el('p', { class: 'n-text', text: lines.join(' ') })] : []),
      ]);
    }));
    $('changelog-all').classList.toggle('hidden', CHANGELOG.length <= NEWS_ON_HOME);
  }

  const changelogDialog = $('changelog-dialog');
  function renderHistory() {
    const kinds = [['all', t('history.all')], ['launcher', 'Launcher'], ['client', 'ATTACK Client']];
    replaceKeepingFocus($('changelog-filters'), kinds.map(([id, label]) => {
      const chip = el('button', { class: `chip${historyKind === id ? ' active' : ''}`, type: 'button', text: label, 'data-focus-key': `history:${id}` });
      chip.addEventListener('click', () => {
        historyKind = id;
        renderHistory();
        $('changelog-full').scrollTop = 0;
      });
      return chip;
    }));
    syncRoving($('changelog-filters'), isActive, { radio: true });
    const list = $('changelog-full');
    list.replaceChildren();
    let month = null;
    for (const entry of CHANGELOG.filter((e) => historyKind === 'all' || entryKind(e) === historyKind)) {
      const key = entry.date ? entry.date.slice(0, 7) : '';
      if (key !== month) {
        month = key;
        const label = key ? new Intl.DateTimeFormat(window.I18n.lang === 'en' ? 'en-GB' : 'fr-FR', { month: 'long', year: 'numeric' }).format(parseDate(`${key}-15`)) : t('history.older');
        list.append(el('div', { class: 'month', text: label }));
      }
      const tag = entryTag(entry);
      const fresh = parseDate(entry.date) && Date.now() - parseDate(entry.date).getTime() < 3 * 86400000;
      const kind = entryKind(entry);
      const { title, lines } = entryParts(entry);
      list.append(el('article', { class: 'h-item' }, [
        el('div', { class: 'h-meta' }, [
          el('b', { text: entry[`version_${window.I18n.lang}`] || entry.version }),
          ...(entry.date ? [el('time', { text: dateLabel(entry.date, true) })] : []),
          ...(kind !== 'other' ? [el('span', { class: 'kind', text: kind === 'launcher' ? 'Launcher' : 'Client' })] : []),
        ]),
        el('div', { class: 'h-body' }, [
          el('h4', {}, [title, ...(tag ? [el('span', { class: `tag ${tag}`, text: t(`tag.${tag}`) })] : []), ...(fresh ? [el('span', { class: 'fresh', text: t('history.new') })] : [])]),
          ...(lines.length > 0 ? [el('ul', {}, lines.map((line) => el('li', { text: line })))] : []),
        ]),
      ]));
    }
  }
  enableArrows($('changelog-filters'));
  $('changelog-all').addEventListener('click', () => {
    historyKind = 'all';
    renderHistory();
    changelogDialog.showModal();
    $('changelog-full').scrollTop = 0;
  });
  $('changelog-close').addEventListener('click', () => changelogDialog.close());
  // clic sur le fond assombri (hors de la fenêtre) : fermer ; Échap ferme aussi (comportement natif de <dialog>)
  changelogDialog.addEventListener('click', (event) => {
    if (event.target === changelogDialog) changelogDialog.close();
  });

  // --- mods ---
  /** Nom lisible d'une licence Modrinth (SPDX ou LicenseRef-…). */
  function licenseName(id) {
    if (!id) return t('credits.unknown');
    return (LICENSE_NAMES[id] && (LICENSE_NAMES[id][window.I18n.lang] || LICENSE_NAMES[id].fr)) || id.replace(/^LicenseRef-/, '').replace(/-/g, ' ');
  }

  /**
   * Cartes de la page Mods : le mod ATTACK (avec sa version installée), l'OptiFine du joueur en 1.8.9, les mods du pack figé avec leur
   * version et, pour chaque mod d'un groupe réglable, son interrupteur ; en 1.8.9, les modules d'ATTACK Client (réglés en jeu).
   * `on` : true (actif), false (coupé ou absent), null (le launcher ne le sait pas : un module se règle en jeu).
   */
  function modItems(profile, lang) {
    const attackInstalled = Boolean(status && status.mod && status.modVersion);
    const items = [{
      key: 'attack',
      name: 'ATTACK Client',
      icon: 'AT',
      cat: 'attack',
      text: t(isFabric(profile) ? 'mods.attackDesc' : 'mods.attackDescForge', { mc: profile.mc }),
      meta: attackInstalled ? t('mods.attackVersion', { version: status.modVersion }) : t('mods.attackMissing'),
      on: attackInstalled ? true : null,
    }];
    if (profile.hasOptifine) {
      const of = status && status.optifine;
      const usable = Boolean(of && (of.found || of.own || of.kept));
      items.push({
        key: 'optifine',
        optifine: true,
        name: 'OptiFine',
        icon: 'OF',
        cat: 'visual',
        text: t('mods.optifineDesc'),
        meta: of ? (of.own ? t('optifine.stateOwn') : of.kept ? t('optifine.stateKept') : of.found ? optifineLabel(of) : '') : '…',
        on: of ? optifineInGame() : null,
        wide: Boolean(of && !usable), // sans copie : la carte porte l'action (assistant) et prend deux colonnes
        stateText: of && !optifineInGame() ? (usable ? t('state.disabled') : t('optifine.badgeMissing')) : '',
        // pas d'interrupteur tant qu'aucune copie n'est utilisable : le bouton de l'assistant prend sa place
        option: usable ? { label: t('mods.optifineOption'), checked: of.enabled, change: (value) => save({ optifine: value }), hint: t('mods.optifineHint') } : null,
      });
    }
    for (const mod of profile.pack) {
      const known = PACK_INFO[mod.slug] || { icon: mod.name.slice(0, 2).toUpperCase(), cat: 'utility', fr: '', en: '' };
      const group = groupOf(mod);
      const on = group ? group.on() : true;
      items.push({
        key: mod.slug,
        name: mod.name,
        icon: known.icon,
        cat: known.cat,
        text: known[lang] || known.fr,
        meta: t('mods.version', { version: mod.version }),
        on,
        stateText: on ? '' : t('state.disabled'),
        option: group ? { label: t(group.tag), checked: on, change: (value) => save({ [group.setting]: value }), hint: t('mods.linked', { name: t(group.title) }) } : null,
      });
    }
    if (!isFabric(profile)) {
      for (const m of MODS) items.push({ key: `module:${m.name}`, name: (lang === 'en' && m.en_name) || m.name, icon: m.icon, cat: m.cat, text: m[lang] || m.fr, meta: '', module: true, on: null });
    }
    return items;
  }

  /** Bandeau « le pack a changé » : le pack ou OptiFine attend une installation alors que le reste est en place. */
  function pendingApply() {
    return Boolean(status && status.minecraft && status.loader && status.mod && status.profile && !busy && (status.pack === false || (status.optifine && status.optifine.pending)));
  }
  function renderPending() {
    const on = pendingApply();
    for (const [id, key] of [['mods-pending', 'pending.mods'], ['pack-pending', 'pending.pack']]) {
      const node = $(id);
      node.classList.toggle('hidden', !on);
      if (!on) continue;
      const action = el('button', { class: 'btn small accent', type: 'button', text: t('pending.install') });
      action.addEventListener('click', () => !busy && !playing && runInstall());
      node.replaceChildren(icon('info'), el('span', { text: t(key) }), action);
    }
  }

  /** Les boutons d'un groupe segmenté : celui de `value` est actif (classe et aria-pressed). */
  function syncSegmented(group, value) {
    for (const button of group.querySelectorAll('button')) button.classList.toggle('active', button.dataset.value === value);
    syncRoving(group, isActive, { radio: true });
  }

  function renderMods() {
    const lang = window.I18n.lang;
    const profile = currentProfile();
    if (!profile || !settings) return;
    const fabricMode = isFabric(profile);
    $('mods-title').textContent = fabricMode ? t('mods.titleFabric', { label: profile.label }) : t('mods.title');
    const installed = modCount(profile);
    const off = profile.pack.length - selectedPack(profile).length;
    $('mods-subtitle').textContent = fabricMode
      ? `${t('mods.subtitleFabric', { n: installed })}${off > 0 ? ` · ${t(off === 1 ? 'mods.off1' : 'mods.off', { n: off })}` : ''}`
      : `${t('mods.subtitleForge', { modules: MODS.length, n: installed })}${off > 0 ? ` · ${t(off === 1 ? 'mods.off1' : 'mods.off', { n: off })}` : ''}`;
    const items = modItems(profile, lang);
    const query = modQuery.trim().toLowerCase();
    // état et recherche d'abord : les compteurs des catégories disent combien de cartes restent dans chacune
    const base = items.filter((m) => (!query || `${m.name} ${m.text}`.toLowerCase().includes(query)) && (modState === 'all' || (modState === 'on' ? m.on === true : m.on === false)));
    const used = CATEGORIES.filter((c) => items.some((item) => item.cat === c.id));
    if (modFilter !== 'all' && !used.some((c) => c.id === modFilter)) modFilter = 'all';
    const countOf = (id) => (id === 'all' ? base.length : base.filter((i) => i.cat === id).length);
    replaceKeepingFocus($('mods-filters'), [{ id: 'all', fr: t('mods.all'), en: t('mods.all') }, ...used].map((c) => {
      const chip = el('button', { class: `chip${modFilter === c.id ? ' active' : ''}`, type: 'button', 'data-focus-key': `chip:${c.id}` }, [c[lang] || c.fr, el('i', { text: String(countOf(c.id)) })]);
      chip.addEventListener('click', () => {
        modFilter = c.id;
        renderMods();
      });
      return chip;
    }));
    syncRoving($('mods-filters'), isActive, { radio: true });
    syncSegmented($('mods-state'), modState);
    syncSegmented($('mods-density'), modDensity);
    const grid = $('mods-grid');
    // cible stable quand l'élément focalisé quitte la grille (carte sortie du filtre, « Tout afficher ») : le filtre d'état actif, hors de la grille
    const stableTarget = () => [...$('mods-state').querySelectorAll('button')].find(isActive);
    grid.dataset.density = modDensity;
    const visible = base.filter((m) => modFilter === 'all' || m.cat === modFilter);
    // compteurs séparés : les mods (ATTACK Client, OptiFine, pack) et les modules d'ATTACK Client réglés en jeu
    const moduleCount = items.filter((m) => m.module).length;
    $('mods-count').textContent = [
      t('mods.countMods', { n: items.length - moduleCount }),
      moduleCount > 0 ? t('mods.countModules', { n: moduleCount }) : '',
      visible.length !== items.length ? t('mods.shown', { n: visible.length }) : '',
    ].filter(Boolean).join(' · ');
    const category = (id) => CATEGORIES.find((c) => c.id === id)[lang];
    if (visible.length === 0) {
      const clear = el('button', { class: 'btn small', type: 'button', text: t('mods.clear') });
      clear.addEventListener('click', () => {
        modQuery = '';
        modFilter = 'all';
        modState = 'all';
        $('mods-q').value = '';
        renderMods();
      });
      replaceKeepingFocus(grid, [el('div', { class: 'mods-empty' }, [el('p', { text: modQuery.trim() ? t('mods.none', { q: modQuery.trim() }) : t('mods.noneFilters') }), clear])], stableTarget);
      return;
    }
    replaceKeepingFocus(grid, visible.map((m) => {
      const top = [el('div', { class: `mod-icon cat-${m.cat}`, 'aria-hidden': 'true', text: m.icon }), el('h3', { text: m.name, title: m.name })];
      const foot = [el('span', { class: 'meta', text: [category(m.cat), m.meta].filter(Boolean).join(' · ') })];
      if (m.stateText) foot.push(el('span', { class: 'badge', text: m.stateText }));
      const children = [];
      if (m.option) {
        const input = el('input', { type: 'checkbox', 'aria-label': `${m.name} : ${m.option.label}`, 'data-focus-key': `mod:${m.key}` });
        input.checked = m.option.checked;
        input.addEventListener('change', () => m.option.change(input.checked));
        top.push(el('label', { class: 'switch', title: m.option.hint || '' }, [input, el('span')]));
      } else if (m.optifine && status && status.optifine) {
        // OptiFine introuvable : pas d'interrupteur actif sur une carte sans copie, l'assistant à la place
        children.push(assistNode('mods'));
      }
      return el('article', { class: `card mod${m.on === false ? ' off' : ''}${m.wide ? ' wide' : ''}` }, [
        el('div', { class: 'mod-top' }, top),
        el('p', { text: m.text, title: m.text }),
        ...children,
        el('div', { class: 'mod-foot' }, foot),
      ]);
    }), stableTarget);
  }
  $('mods-q').addEventListener('input', (event) => {
    modQuery = event.target.value;
    renderMods();
  });
  enableArrows($('mods-filters'));
  enableArrows($('mods-state'));
  enableArrows($('mods-density'));
  $('mods-state').addEventListener('click', (event) => {
    const value = event.target.dataset && event.target.dataset.value;
    if (!['all', 'on', 'off'].includes(value)) return;
    modState = value;
    renderMods();
  });
  $('mods-density').addEventListener('click', (event) => {
    const value = event.target.dataset && event.target.dataset.value;
    if (!DENSITIES.includes(value)) return;
    modDensity = value;
    try {
      window.localStorage.setItem(DENSITY_KEY, value);
    } catch {
      // stockage indisponible : la densité vaut pour cette session
    }
    renderMods();
  });

  // --- réglages ---
  let savedTimer = null;
  /**
   * Enregistre `patch` ; renvoie le message d'erreur du processus principal, ou null si tout est enregistré.
   * `showError` : l'échec s'affiche en haut de la page Réglages (sinon l'appelant l'affiche).
   */
  async function save(patch, { showError = true } = {}) {
    let failure = null;
    try {
      settings = await api.setSettings(patch);
    } catch (error) {
      // enregistrement refusé : on reprend les réglages réellement en vigueur côté processus principal
      settings = await api.getSettings();
      // Electron préfixe le message (« Error invoking remote method … Error: ») : on ne garde que le nôtre
      failure = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    }
    renderSettings();
    renderProfiles();
    renderMods();
    if ('profileId' in patch) renderStatus();
    flashSaved(failure, showError);
    if (['profileId', 'gameDir', 'devMode', 'devJarDir', 'shaders', 'pvpMods', 'optifinePacks', 'replayMod', 'optifine', 'optifineJar'].some((key) => key in patch)) refreshStatus();
    else renderStatus();
    if ('devMode' in patch || 'msClientId' in patch) refreshAccounts();
    return failure;
  }

  /**
   * « Enregistré » en notification (visible partout, même quand l'interrupteur est tout en bas de la page) ; l'erreur, elle, reste en haut de
   * la page Réglages, au même endroit qu'avant.
   */
  function flashSaved(failure, showError = true) {
    const saved = $('saved');
    clearTimeout(savedTimer);
    saved.classList.toggle('error', Boolean(failure));
    if (!failure) {
      saved.classList.remove('show');
      showToast(t('settings.saved'));
      return;
    }
    if (!showError) {
      saved.classList.remove('show');
      return;
    }
    $('saved-text').textContent = failure ? t('error.generic', { message: failure }) : t('settings.saved');
    saved.classList.add('show');
    savedTimer = setTimeout(() => saved.classList.remove('show'), failure ? 6000 : 1600);
  }

  function formatRam(mb) {
    const gb = mb / 1024;
    const text = Number.isInteger(gb) ? String(gb) : gb.toFixed(2).replace(/0$/, '');
    return window.I18n.lang === 'en' ? `${text} GB` : `${text.replace('.', ',')} Go`;
  }

  // onglets des réglages
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === name);
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
      tab.tabIndex = tab.dataset.tab === name ? 0 : -1; // un seul arrêt de tabulation : l'onglet choisi
    });
    document.querySelectorAll('.tabpanel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
  }
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
  enableArrows($('settings-tabs'));
  window.selectSettingsTab = selectTab;

  // Mémoire : curseur avec zone recommandée, graduations en Go et raccourcis
  const RECOMMENDED = { 'forge-1.8.9': [2, 3] };
  function ramMaxMb() {
    return info ? Math.max(4096, Math.min(16384, Math.floor(info.totalRamMb / 1024) * 1024)) : 8192;
  }
  function setRamVisual(mb) {
    const max = ramMaxMb();
    $('ram-range').style.setProperty('--r', String(Math.min(1, Math.max(0, (mb - 1024) / (max - 1024)))));
    $('ram-value').textContent = formatRam(mb);
  }
  function renderRam() {
    const max = ramMaxMb();
    const ratio = (mb) => (mb - 1024) / (max - 1024);
    const input = $('ram');
    input.max = String(max);
    input.value = String(settings.ramMb);
    setRamVisual(settings.ramMb);
    const [from, to] = RECOMMENDED[settings.profileId] || [3, 4];
    const zone = $('ram-zone');
    zone.style.left = `calc(9px + (100% - 18px) * ${ratio(from * 1024)})`;
    zone.style.width = `calc((100% - 18px) * ${ratio(to * 1024) - ratio(from * 1024)})`;
    const maxGb = max / 1024;
    const every = maxGb > 8 ? 2 : 1;
    const unit = window.I18n.lang === 'en' ? 'GB' : 'Go';
    // une graduation par Go (une sur deux au-delà de 8 Go), l'unité sur la dernière
    const marks = Array.from({ length: maxGb }, (_, i) => i + 1).filter((g) => g === 1 || g % every === 0);
    $('ram-ticks').replaceChildren(...marks.map((g) => {
      const tick = el('span', { text: g === marks[marks.length - 1] ? `${g} ${unit}` : String(g) });
      tick.style.left = `calc(9px + (100% - 18px) * ${ratio(g * 1024)})`;
      return tick;
    }));
    replaceKeepingFocus($('ram-presets'), [
      ...[2, 3, 4, 6].filter((g) => g <= maxGb).map((g) => {
        const chip = el('button', { class: `chip${settings.ramMb === g * 1024 ? ' active' : ''}`, type: 'button', text: `${g} ${unit}`, 'aria-pressed': String(settings.ramMb === g * 1024), 'data-focus-key': `ram:${g}` });
        chip.addEventListener('click', () => save({ ramMb: g * 1024 }));
        return chip;
      }),
      el('span', { class: 'note', text: info ? t('settings.pcRam', { n: Math.round(info.totalRamMb / 1024) }) : '' }),
    ]);
    $('ram-warn').classList.toggle('hidden', !info || settings.ramMb <= info.totalRamMb / 2);
  }

  /** « Appliqué », « À appliquer » ou « Désactivé » pour un groupe du pack, d'après les jars réellement présents. */
  function groupBadge(group) {
    const on = group.on();
    const counts = status && status.packGroups && status.packGroups[group.id];
    if (!counts || !status.minecraft || !status.loader) return { cls: '', text: t('state.toInstall') };
    if (on) return counts.present === counts.total ? { cls: 'good', text: t('state.applied') } : { cls: 'warn', text: t('state.pending') };
    return counts.present === 0 ? { cls: 'good', text: t('state.disabled') } : { cls: 'warn', text: t('state.pending') };
  }

  function renderPackRows(profile) {
    replaceKeepingFocus($('pack-rows'), groupsOf(profile).map((group) => {
      const badge = groupBadge(group);
      const input = el('input', { type: 'checkbox', id: `group-${group.id}`, 'aria-label': t(group.title), 'data-focus-key': `group:${group.id}` });
      input.checked = group.on();
      input.addEventListener('change', () => save({ [group.setting]: input.checked }));
      return el('div', { class: 'pack-row' }, [
        el('div', {}, [el('h4', { text: t(group.title) }), el('p', { text: t(group.help) }), el('span', { class: `badge st ${badge.cls}`, text: badge.text })]),
        el('label', { class: 'switch' }, [input, el('span')]),
      ]);
    }));
  }

  // --- assistant OptiFine : le joueur télécharge lui-même, le launcher repère le fichier, le vérifie et le range ---
  // (la licence d'OptiFine interdit au launcher de le récupérer à la place du joueur : il ouvre seulement optifine.net)
  let assist = { state: 'idle', downloadsDir: '' };
  const ASSIST_ACTIVE = ['waiting', 'seen', 'checking'];

  /** Les trois raisons, en puces (rien d'autre : ni les autres launchers, ni les capes). */
  function whyNode() {
    return el('details', { class: 'why' }, [
      el('summary', { text: t('optifine.why') }),
      el('ul', {}, [el('li', { text: t('optifine.why1') }), el('li', { text: t('optifine.why2') }), el('li', { text: t('optifine.why3') })]),
    ]);
  }

  async function assistStart(openBrowser = true) {
    const result = await call(() => api.optifineAssist.start({ browser: openBrowser }));
    if (result.ok === false) {
      flashSaved(errorText(result));
      return;
    }
    assist = result;
    renderAssists();
    announceAssist();
  }
  async function assistUse() {
    const result = await call(() => api.optifineAssist.use());
    if (result.ok === false && result.code && result.code !== 'NO_FILE') flashSaved(errorText(result));
  }
  async function assistCancel() {
    await call(() => api.optifineAssist.cancel());
  }

  /**
   * Titre, texte (ou étapes) et boutons de l'assistant pour son état courant ; null quand il n'y a rien à dire. Chaque bouton a un
   * rôle (start, cancel, use, install, pick) : sa clé de focus ne dépend ni du libellé ni de la langue.
   */
  function assistModel() {
    const a = assist;
    const dir = a.downloadsDir || '';
    const file = a.file || '';
    const button = (role, label, run, kind = '') => ({ role, label, run, kind });
    const pick = button('pick', t('optifine.pick'), pickOptifine);
    switch (a.state) {
      case 'waiting':
        return {
          title: t('optifine.assist.waitingTitle'), busy: true,
          steps: [t('optifine.assist.step1'), t('optifine.assist.step2'), t('optifine.assist.step3', { dir })],
          actions: [button('cancel', t('optifine.assist.cancel'), assistCancel, 'ghost')],
        };
      case 'seen':
        return {
          title: t('optifine.assist.seenTitle'), text: t('optifine.assist.seenText', { file, dir }),
          actions: [button('use', t('optifine.assist.use'), assistUse, 'accent'), button('cancel', t('optifine.assist.cancel'), assistCancel, 'ghost')],
        };
      case 'checking':
        return { title: t('optifine.assist.checkingTitle'), text: t('optifine.assist.checkingText', { file }), busy: true, actions: [] };
      case 'imported':
        return {
          title: t(a.version ? 'optifine.assist.importedTitle' : 'optifine.assist.importedTitleNoVersion', { version: String(a.version || '').replace(/_/g, ' ') }),
          text: t('optifine.assist.importedText'), good: true,
          actions: busy || playing ? [] : [button('install', t('pending.install'), () => !busy && !playing && runInstall(), 'accent')],
        };
      case 'refused':
        return {
          title: t('optifine.assist.refusedTitle'), warn: true,
          text: t('optifine.assist.refusedText', { file, reason: t(`error.OPTIFINE_${a.reason}`) }),
          actions: [button('start', t('optifine.assist.retry'), () => assistStart(true), 'accent'), pick],
        };
      case 'timeout':
        return {
          title: t('optifine.assist.timeoutTitle'), text: t('optifine.assist.timeoutText', { dir }),
          actions: [button('start', t('optifine.assist.waitMore'), () => assistStart(false), 'accent'), pick],
        };
      case 'cancelled':
        return {
          title: t('optifine.assist.cancelledTitle'), text: t('optifine.assist.cancelledText'),
          actions: [button('start', t('optifine.assist.restart'), () => assistStart(true), 'accent'), pick],
        };
      case 'error':
        return {
          title: t('optifine.assist.errorTitle'), warn: true,
          text: a.reason === 'DIR_UNREADABLE' ? t('optifine.assist.dirUnreadable', { dir }) : errorText({ code: a.reason, message: a.message }),
          actions: [button('start', t('optifine.assist.retry'), () => assistStart(true), 'accent'), pick],
        };
      default:
        return null;
    }
  }

  const assistTone = (model) => (model.warn ? 'warn' : model.good ? 'good' : model.busy ? 'busy' : 'info');

  /**
   * Bloc de l'assistant. variant : 'settings' (rien tant qu'il est au repos : les boutons sont dans la carte) ou 'mods' (au repos, il
   * propose de l'obtenir). Les changements d'état sont annoncés par la zone aria-live (announceAssist), pas par ce bloc, qui est refait
   * à chaque rendu de la page. Le titre peut prendre le focus (tabindex -1) : il le reçoit quand le bouton activé disparaît avec l'état.
   */
  function assistNode(variant) {
    const model = assistModel();
    if (!model && variant === 'settings') return null;
    const children = [];
    if (model) {
      const title = el('b', { text: model.title, tabindex: '-1', 'data-focus-key': `assist:${variant}:title` });
      children.push(el('div', { class: 'assist-head' }, [el('span', { class: 'assist-dot', 'aria-hidden': 'true' }), title]));
      if (model.steps) children.push(el('ol', { class: 'assist-steps' }, model.steps.map((step) => el('li', { text: step }))));
      if (model.text) children.push(el('p', { class: 'assist-text', text: model.text }));
    } else {
      children.push(el('p', { class: 'assist-text', text: t('optifine.assist.idle') }));
    }
    const actions = (model ? model.actions : [
      { role: 'start', label: t('optifine.get'), run: () => assistStart(true), kind: 'accent' },
      { role: 'pick', label: t('optifine.pick'), run: pickOptifine, kind: '' },
    ]).map((a) => {
      const node = el('button', { type: 'button', class: `btn small${a.kind ? ` ${a.kind}` : ''}`, text: a.label, 'data-focus-key': `assist:${variant}:${a.role}` });
      node.addEventListener('click', a.run);
      return node;
    });
    if (actions.length > 0) children.push(el('div', { class: 'assist-actions' }, actions));
    if (variant === 'mods') children.push(whyNode());
    return el('div', { class: `assist-box tone-${model ? assistTone(model) : 'info'}` }, children);
  }

  /** Annonce le nouvel état aux lecteurs d'écran (une seule zone aria-live, hors de tout rendu). */
  function announceAssist() {
    const model = assistModel();
    $('optifine-live').textContent = model ? [model.title.replace(/[….]+$/, ''), model.text || (model.steps || []).join(' ')].filter(Boolean).join('. ') : '';
  }
  function renderAssists() {
    const profile = currentProfile();
    if (profile) renderOptifine(profile);
    renderMods();
  }

  api.onOptifineAssist(async (state) => {
    assist = state;
    renderAssists();
    announceAssist();
    if (state.state === 'imported') {
      // le processus principal a rangé la copie et réglé le fichier choisi : la page relit les réglages et l'état
      settings = await api.getSettings();
      await refreshStatus();
    }
  });

  const OPTIFINE_REASONS = ['NOT_JAR', 'WRONG_NAME', 'BAD_ZIP', 'NO_TWEAK', 'TOO_BIG', 'UNREADABLE'];
  /** Carte OptiFine du profil 1.8.9 : copie trouvée ou non, interrupteur, choix du fichier, lien officiel. */
  function renderOptifine(profile) {
    const card = $('optifine-card');
    card.classList.toggle('hidden', !profile.hasOptifine);
    if (!profile.hasOptifine) return;
    const of = status && status.optifine;
    const badge = $('optifine-badge');
    let text;
    if (!of) {
      badge.className = 'badge';
      badge.textContent = '…';
      text = t('optifine.checking');
    } else if (of.own) {
      badge.className = 'badge good';
      badge.textContent = t('optifine.badgeOwn');
      text = t('optifine.textOwn', { name: of.own });
    } else if (of.kept) {
      badge.className = 'badge good';
      badge.textContent = t('optifine.badgeKept');
      text = t('optifine.textKept', { name: of.kept });
    } else if (of.found) {
      badge.className = 'badge good';
      badge.textContent = t('optifine.badgeFound');
      text = t('optifine.textFound', { name: optifineLabel(of), source: t(`optifine.source.${of.source}`) });
    } else {
      badge.className = 'badge warn';
      badge.textContent = t('optifine.badgeMissing');
      text = t('optifine.textMissing');
    }
    $('optifine-text').textContent = text;
    const refused = of && of.chosenError && OPTIFINE_REASONS.includes(of.chosenError);
    $('optifine-warn').textContent = refused ? t('optifine.chosenRefused', { reason: t(`error.OPTIFINE_${of.chosenError}`) }) : '';
    $('optifine-warn').classList.toggle('hidden', !refused);
    $('optifine-enabled').checked = settings.optifine !== false;
    $('optifine-use-help').textContent = t('optifine.useHelp');
    $('optifine-clear').classList.toggle('hidden', !settings.optifineJar);
    // assistant : son bloc (états), et le bouton qui le lance (en rouge quand rien n'est trouvé, grisé pendant qu'il surveille)
    replaceKeepingFocus($('optifine-assist'), [assistNode('settings')].filter(Boolean));
    const running = ASSIST_ACTIVE.includes(assist.state);
    if (running && document.activeElement === $('optifine-download')) {
      // le bouton qui a lancé l'assistant va être grisé : le focus passe au titre de l'assistant plutôt que de retomber sur <body>
      const head = $('optifine-assist').querySelector('[data-focus-key="assist:settings:title"]');
      if (head) head.focus({ preventScroll: true });
    }
    $('optifine-download').disabled = running;
    $('optifine-download').classList.toggle('accent', Boolean(of) && !of.found && !of.own && !of.kept && !running);
  }

  function renderSettings() {
    const profile = currentProfile();
    if (!profile || !settings) return;
    $('settings-profile').textContent = `${profile.label} · ${loaderName(profile)}`;
    $('ram-help').textContent = isFabric(profile) ? t('settings.ramHelpModern', { mc: profile.mc }) : t('settings.ramHelp');
    $('java-help').textContent = t('settings.javaHelp', { java: profile.javaMajor, mc: profile.mc });
    $('jvm-args-help').textContent = t('settings.jvmArgsHelp', { java: profile.javaMajor });
    $('dev-help').textContent = t('settings.devHelp', { glob: profile.jarGlob });
    renderRam();
    renderPackRows(profile);
    renderOptifine(profile);
    $('game-dir').value = settings.gameDir;
    $('game-dir').title = settings.gameDir;
    const custom = settings.javaPath !== '' || $('java-mode').dataset.forceCustom === '1';
    $('java-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.value === 'custom') === custom));
    syncRoving($('java-mode'), isActive, { radio: true });
    $('java-custom').classList.toggle('hidden', !custom);
    $('java-path').value = settings.javaPath;
    $('java-path').title = settings.javaPath;
    // texte en cours de saisie gardé, sauf si le profil a changé : on affiche alors celui du nouveau profil
    const jvmField = $('jvm-args');
    const otherProfile = jvmField.dataset.profile !== settings.profileId;
    if (otherProfile || document.activeElement !== jvmField) jvmField.value = settings.jvmArgs || '';
    if (otherProfile) $('jvm-args-warn').classList.add('hidden');
    jvmField.dataset.profile = settings.profileId;
    $('lang').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.lang));
    syncRoving($('lang'), isActive, { radio: true });
    $('dev-mode').checked = settings.devMode;
    $('dev-dir-row').classList.toggle('hidden', !settings.devMode);
    $('dev-dir').value = settings.devJarDir;
    $('dev-dir').title = settings.devJarDir;
    $('client-id').value = settings.msClientId;
    $('client-id').placeholder = settings.msClientId ? '00000000-0000-0000-0000-000000000000'
      : accountsView.clientIdFromEnv ? t('settings.clientIdEnv') : t('settings.clientIdDefault');
    if (info) $('about').textContent = t('settings.about', { version: info.version, dir: info.minecraftDir });
    renderUpdateCard();
    renderPending();
  }

  $('ram').addEventListener('input', (event) => setRamVisual(Number(event.target.value)));
  $('ram').addEventListener('change', (event) => save({ ramMb: Number(event.target.value) }));
  $('game-dir-open').addEventListener('click', () => guarded(() => api.openGameDir(), (text) => flashSaved(text)));
  $('game-dir-change').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.gameDir);
    if (dir) save({ gameDir: dir });
  });
  $('game-dir-reset').addEventListener('click', () => save({ gameDir: '' }));
  enableArrows($('java-mode'));
  enableArrows($('lang'));
  $('java-mode').addEventListener('click', (event) => {
    const value = event.target.dataset?.value;
    if (!value) return;
    $('java-mode').dataset.forceCustom = value === 'custom' ? '1' : '';
    if (value === 'bundled') save({ javaPath: '' });
    else renderSettings();
  });
  $('java-browse').addEventListener('click', async () => {
    const file = await api.pickJava();
    if (file) save({ javaPath: file });
  });
  async function saveJvmArgs(value) {
    const typed = value.trim();
    const failure = await save({ jvmArgs: typed }, { showError: false });
    // refusé : le texte tapé reste dans le champ pour être corrigé
    $('jvm-args').value = failure ? typed : settings.jvmArgs || '';
    $('jvm-args-warn').textContent = failure || '';
    $('jvm-args-warn').classList.toggle('hidden', !failure);
  }
  $('jvm-args-save').addEventListener('click', () => saveJvmArgs($('jvm-args').value));
  $('jvm-args').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveJvmArgs(event.target.value);
  });
  $('jvm-args-reset').addEventListener('click', () => saveJvmArgs(''));
  $('lang').addEventListener('click', async (event) => {
    const value = event.target.dataset?.value;
    if (!value) return;
    await save({ lang: value });
    applyLanguage();
  });
  $('dev-mode').addEventListener('change', (event) => save({ devMode: event.target.checked }));
  $('optifine-enabled').addEventListener('change', (event) => save({ optifine: event.target.checked }));
  /** « Choisir le fichier… » : le joueur désigne lui-même son OptiFine 1.8.9 (validé par le processus principal). */
  async function pickOptifine() {
    const result = await call(() => api.pickOptifine());
    if (result.ok) {
      settings = await api.getSettings();
      flashSaved(null);
      renderSettings();
      await refreshStatus();
    } else if (result.code !== 'CANCELLED') {
      flashSaved(errorText(result));
    }
  }
  $('optifine-pick').addEventListener('click', pickOptifine);
  $('optifine-clear').addEventListener('click', () => save({ optifineJar: '' }));
  $('optifine-download').addEventListener('click', () => assistStart(true));
  $('dev-dir-change').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.devJarDir);
    if (dir) save({ devJarDir: dir });
  });

  // --- crédits : mods du pack avec auteur, version et licence ---
  const creditsDialog = $('credits-dialog');
  function renderCredits() {
    const profile = currentProfile();
    if (!profile) return;
    $('credits-dialog-title').textContent = `${t('credits.title')} · ${profile.label}`;
    $('credits-credit').textContent = t('credits.credit');
    const list = $('credits-list');
    list.replaceChildren(
      el('div', { class: 'credit-section', text: t('credits.packSection', { label: profile.label }) }),
      el('div', { class: 'credit-row credit-head' }, [el('span', { text: t('credits.mod') }), el('span', { text: t('credits.author') }), el('span', { text: t('credits.license') })]),
      ...profile.pack.map((mod) => el('div', { class: 'credit-row' }, [
        el('span', {}, [el('b', { text: mod.name }), el('small', { text: `v${mod.version}` })]),
        el('span', { text: mod.author || t('credits.unknown') }),
        el('span', { text: licenseName(mod.license) }),
      ])),
      el('div', { class: 'credit-section', text: t('credits.otherSection') }),
      el('div', { class: 'credit-row' }, [el('span', {}, [el('b', { text: 'ATTACK Client' })]), el('span', { text: '7ShIkI3' }), el('span', { text: t('credits.attackLicense') })]),
      ...(profile.hasOptifine ? [el('div', { class: 'credit-row' }, [el('span', {}, [el('b', { text: 'OptiFine' })]), el('span', { text: 'sp614x' }), el('span', { text: t('credits.optifineLicense') })])] : []),
      el('p', { class: 'credit-note', text: t('credits.note') }),
    );
  }
  $('credits-open').addEventListener('click', () => {
    renderCredits();
    creditsDialog.showModal();
    $('credits-list').scrollTop = 0;
  });
  $('credits-close').addEventListener('click', () => creditsDialog.close());
  creditsDialog.addEventListener('click', (event) => {
    if (event.target === creditsDialog) creditsDialog.close();
  });

  // --- comptes ---
  /** Tête du joueur (visage + calque du chapeau) dessinée depuis la skin, en pixels nets ; l'initiale tant que la skin n'est pas là. */
  function avatarCanvas(account, size) {
    const box = el('span', { class: 'avatar-fill' });
    box.textContent = account.name.slice(0, 1).toUpperCase();
    if (account.skin) {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8);
        ctx.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8);
        box.replaceChildren(canvas);
      };
      image.src = account.skin;
    }
    return box;
  }
  const avatar = (account) => el('div', { class: 'avatar' }, [avatarCanvas(account, 56)]);

  function accountMessage(text, kind = '') {
    const node = $('account-message');
    node.textContent = text || '';
    node.className = `message ${kind}`;
    node.classList.toggle('hidden', !text);
  }

  /** Bouton Compte de la barre latérale : tête du joueur et point de présence, ou icône et point rouge sans compte. */
  function renderNavAccount() {
    const active = accountsView.accounts.find((a) => a.active);
    $('nav-account').dataset.account = !active ? 'none' : active.type === 'msa' ? 'msa' : 'offline';
    $('nav-avatar').replaceChildren(...(active ? [avatarCanvas(active, 28)] : []));
    // la pastille rouge n'a pas de texte : le bouton dit lui-même s'il y a un compte
    const label = active ? t('nav.accountOf', { name: active.name }) : t('nav.accountNone');
    $('nav-account').setAttribute('aria-label', label);
    $('nav-account').title = label;
  }

  function renderAccounts() {
    const view = accountsView;
    const none = view.accounts.length === 0;
    $('azure-setup').classList.toggle('hidden', view.hasClientId);
    $('account-empty').classList.toggle('hidden', !none || !view.hasClientId);
    for (const button of document.querySelectorAll('.js-login')) button.disabled = !view.hasClientId || loggingIn;
    $('login-button').classList.toggle('hidden', none);
    $('offline-card').classList.toggle('hidden', !view.devMode);
    const active = view.accounts.find((a) => a.active);
    $('skin-offline-actions').classList.toggle('hidden', !active || active.type === 'msa');
    // « Utiliser » ou « Déconnecter » retire le bouton focalisé : le nom du même compte, sinon celui du premier compte restant.
    // Jamais un autre bouton : posé sur un « Déconnecter », le focus laisserait Entrée maintenue retirer les comptes l'un après l'autre.
    const accountTarget = (key) => {
      const own = key.slice(0, key.lastIndexOf(':') + 1); // « account:<id>: »
      const names = [...$('accounts-list').querySelectorAll('[data-focus-key]')].filter((node) => node.dataset.focusKey.endsWith(':name'));
      return (own && names.find((node) => node.dataset.focusKey === `${own}name`)) || names[0] || null;
    };
    replaceKeepingFocus($('accounts-list'), view.accounts.map((account) => {
      const actions = [];
      if (!account.active) {
        const use = el('button', { class: 'btn', text: t('account.use'), 'data-focus-key': `account:${account.id}:use` });
        use.addEventListener('click', async () => {
          const next = await guarded(() => api.accounts.select(account.id), (text) => accountMessage(text, 'error'));
          if (next) accountsView = next;
          renderAccounts();
          renderStatus();
        });
        actions.push(use);
      }
      const remove = el('button', { class: 'btn ghost danger', text: t('account.remove'), 'data-focus-key': `account:${account.id}:remove` });
      remove.addEventListener('click', async () => {
        const next = await guarded(() => api.accounts.remove(account.id), (text) => accountMessage(text, 'error'));
        if (next) accountsView = next;
        renderAccounts();
        renderStatus();
      });
      actions.push(remove);
      return el('div', { class: `card account-card${account.active ? ' active' : ''}` }, [
        avatar(account),
        el('div', { class: 'account-info' }, [
          // cible du focus après « Utiliser » ou « Déconnecter » (focalisable par programme, hors de l'ordre de tabulation)
          el('div', { class: 'name', text: account.name, tabindex: '-1', 'data-focus-key': `account:${account.id}:name` }),
          el('div', { class: 'badges' }, [
            el('span', { class: 'badge', text: t(account.type === 'msa' ? 'account.msa' : 'account.offline') }),
            ...(account.active ? [el('span', { class: 'badge on', text: t('account.active') })] : []),
          ]),
          ...(account.active ? [el('p', { class: 'sub', text: t(account.type === 'msa' ? 'account.subMsa' : 'account.subOffline') })] : []),
        ]),
        el('div', { class: 'setup-actions' }, actions),
      ]);
    }), accountTarget);
    renderNavAccount();
    document.dispatchEvent(new CustomEvent('attack:accounts', { detail: view }));
  }

  // skin.js (vue 3D du skin) suit le compte actif et réutilise la traduction des erreurs
  // showError : montre l'alerte de l'accueil pour un code d'erreur (essais et captures d'écran : scripts/screenshot.js, ATTACK_SCREENSHOT_ERROR)
  window.AttackUI = {
    errorText,
    view: () => accountsView,
    showError: (code, message = '') => setMessage(errorText({ code, message }), 'error', code),
  };

  async function refreshAccounts() {
    accountsView = await api.accounts.list();
    renderAccounts();
    renderStatus();
    renderSettings();
  }

  let loggingIn = false;
  async function startLogin() {
    if (loggingIn) return;
    loggingIn = true;
    showPage('account');
    accountMessage('');
    $('device-code').textContent = '--------';
    $('device-uri').textContent = '';
    $('device-stage').textContent = t('login.starting');
    $('device').classList.remove('hidden');
    renderAccounts();
    const result = await api.accounts.login();
    loggingIn = false;
    $('device').classList.add('hidden');
    if (result.ok) accountMessage(t('login.done', { name: result.name }), 'ok');
    else if (result.code !== 'CANCELLED') accountMessage(errorText(result), 'error');
    await refreshAccounts();
  }
  document.querySelectorAll('.js-login').forEach((button) => button.addEventListener('click', startLogin));
  api.onAuthEvent((event) => {
    if (event.stage === 'code') {
      $('device-code').textContent = event.userCode;
      $('device-uri').textContent = event.verificationUri;
      $('device-stage').textContent = t('login.waiting');
    } else if (event.stage === 'xbox') {
      $('device-stage').textContent = t('login.xbox');
    }
  });
  function showRefreshError(view) {
    if (!view?.refreshError) return;
    const key = view.refreshError.code === 'NETWORK' ? 'account.refreshOffline' : 'account.refreshError';
    accountMessage(t(key, { message: errorText(view.refreshError) }), 'error');
  }
  api.onAccountsChanged((view) => {
    accountsView = view;
    renderAccounts();
    renderStatus();
    showRefreshError(view);
  });
  $('device-copy').addEventListener('click', async () => {
    await api.accounts.copyCode();
    $('device-copy').textContent = t('login.copied');
    setTimeout(() => {
      $('device-copy').textContent = t('login.copy');
    }, 1500);
  });
  $('device-open').addEventListener('click', () => api.accounts.openVerification());
  $('device-cancel').addEventListener('click', () => api.accounts.cancel());
  $('azure-portal').addEventListener('click', () => api.openAzureHelp(0));
  $('azure-form').addEventListener('click', () => api.openAzureHelp(1));
  $('azure-settings').addEventListener('click', () => {
    showPage('settings');
    selectTab('advanced');
    $('client-id').focus();
  });
  $('offline-add').addEventListener('click', async () => {
    const result = await api.accounts.addOffline($('offline-name').value.trim());
    if (result.ok) {
      $('offline-name').value = '';
      accountMessage('');
      accountsView = result;
      renderAccounts();
      renderStatus();
    } else {
      accountMessage(errorText(result), 'error');
    }
  });
  $('client-id-save').addEventListener('click', () => {
    const value = $('client-id').value.trim();
    const valid = value === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    $('client-id-warn').classList.toggle('hidden', valid);
    if (valid) save({ msClientId: value });
  });

  // --- mise à jour du launcher ---
  let update = { phase: 'off' };
  let updateNote = ''; // message affiché à la place du texte (ex. partie en cours)
  let dismissedVersion = null;

  function renderUpdate() {
    const banner = $('update-banner');
    banner.dataset.phase = update.phase;
    const shown = ['ready', 'available'].includes(update.phase) && update.version !== dismissedVersion;
    banner.classList.toggle('hidden', !shown);
    if (!shown) return;
    const ready = update.phase === 'ready';
    $('update-text').textContent = updateNote || t(ready ? 'update.ready' : 'update.available', { version: update.version });
    $('update-action').textContent = t(ready ? 'update.restart' : 'update.releases');
  }

  /** Onglet Launcher : où en sont les mises à jour du launcher (la bannière, elle, n'apparaît que pour une version prête ou à télécharger). */
  function renderUpdateCard() {
    const version = info ? info.version : '';
    const key = ['off', 'none', 'checking', 'downloading', 'ready', 'available', 'error'].includes(update.phase) ? update.phase : 'idle';
    const text = t(`update.help.${key}`, { version: update.version || version, percent: Math.floor(update.percent || 0) });
    $('update-help').textContent = `${t('update.current', { version })} ${text}`;
  }

  api.onUpdateState((state) => {
    if (state.phase !== update.phase || state.version !== update.version) updateNote = '';
    update = state;
    renderUpdate();
    renderUpdateCard();
  });
  $('update-releases').addEventListener('click', () => api.update.openReleases());
  $('folders-game').addEventListener('click', () => guarded(() => api.openGameDir(), (text) => flashSaved(text)));
  $('folders-logs').addEventListener('click', () => guarded(() => api.openLogs(), (text) => flashSaved(text)));
  $('update-action').addEventListener('click', async () => {
    if (update.phase === 'available') {
      api.update.openReleases();
      return;
    }
    $('update-action').disabled = true;
    let result;
    try {
      result = await api.update.install();
    } catch (error) {
      result = { ok: false, code: 'INSTALL_FAILED', message: String(error?.message || error) };
    } finally {
      $('update-action').disabled = false;
    }
    if (!result.ok) {
      updateNote = t(`update.${result.code}`, { message: result.message || '' });
      renderUpdate();
    }
  });
  $('update-dismiss').addEventListener('click', () => {
    dismissedVersion = update.version;
    renderUpdate();
  });

  function applyLanguage() {
    window.I18n.setLang(settings.lang);
    if (alertAction) $('alert-action').textContent = t(alertAction.label);
    renderProfiles();
    renderStatus();
    renderNews();
    renderMods();
    renderSettings();
    renderAccounts();
    renderUpdate();
    if (changelogDialog.open) renderHistory();
    if (creditsDialog.open) renderCredits();
  }

  api.onWindowState(({ maximized }) => document.body.classList.toggle('maximized', maximized));
  // retour sur la fenêtre (après avoir téléchargé ou installé OptiFine, par exemple) : l'état est relu
  window.addEventListener('focus', () => {
    if (!busy && !playing && info && settings) refreshStatus();
  });

  async function init() {
    [info, settings] = await Promise.all([api.info(), api.getSettings()]);
    accountsView = await api.accounts.list();
    update = await api.update.state();
    applyLanguage();
    showRefreshError(accountsView);
    await refreshStatus();
  }

  init().catch((error) => setMessage(t('error.generic', { message: error.message }), 'error'));
})();
