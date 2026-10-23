// Logique de l'interface : navigation, état d'installation, bouton JOUER, vitrine des mods, réglages.
(function () {
  'use strict';
  const api = window.attack;
  const { t } = window.I18n;
  const { CATEGORIES, MODS, CHANGELOG, PACK_INFO } = window.AttackData;
  const $ = (id) => document.getElementById(id);

  let info = null;
  let settings = null;
  let status = null;
  let busy = false;
  let playing = false; // lancement du jeu en cours
  let statusToken = 0; // ignore une lecture d'état arrivée après un changement de profil
  let modFilter = 'all';
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

  // --- navigation ---
  function showPage(page) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    // la vue 3D du skin ne dessine que sur la page Compte (sinon WebGL tourne en continu, même pendant une partie)
    document.dispatchEvent(new CustomEvent('attack:page', { detail: page }));
  }
  window.showPage = showPage;
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

  // --- fenêtre ---
  $('wc-min').addEventListener('click', () => api.window.minimize());
  $('wc-max').addEventListener('click', () => api.window.maximize());
  $('wc-close').addEventListener('click', () => api.window.close());
  // SVG constant généré par logo.js (aucune donnée externe)
  $('titlebar-logo').innerHTML = window.AttackLogo.svg({ id: 'tb', size: 18 });
  $('hero-logo').innerHTML = window.AttackLogo.svg({ id: 'hero', size: 132, glow: true });

  // --- accueil ---
  function setMessage(text, kind = '') {
    const node = $('message');
    node.textContent = text || '';
    node.className = `message ${kind}`;
    node.classList.toggle('hidden', !text);
  }

  // --- profils (version de Minecraft + chargeur de mods) ---
  const profileList = () => (info && info.profiles) || [];
  const currentProfile = () => profileList().find((p) => p.id === (settings && settings.profileId)) || profileList()[0] || null;
  const loaderName = (profile) => (profile.loaderType === 'fabric' ? 'Fabric' : 'Forge');
  const isFabric = (profile) => Boolean(profile) && profile.loaderType === 'fabric';

  /** Sous-titre de l'accueil et sélecteur de profil (désactivé pendant une installation ou un lancement). */
  function renderProfiles() {
    const profile = currentProfile();
    if (!profile) return;
    $('hero-sub').textContent = `Minecraft ${profile.mc} · ${loaderName(profile)} ${profile.loaderVersion}`;
    $('profile-select').replaceChildren(...profileList().map((p) => {
      const button = el('button', { type: 'button', class: p.id === profile.id ? 'active' : '', 'data-profile': p.id }, [
        el('b', { text: p.label }),
        el('small', { text: loaderName(p) }),
      ]);
      button.disabled = busy || playing;
      button.addEventListener('click', () => switchProfile(p.id));
      return button;
    }));
  }

  async function switchProfile(id) {
    if (busy || playing || !settings || id === settings.profileId) return;
    setMessage('');
    $('progress').classList.add('hidden');
    statusToken++; // une lecture d'état déjà partie pour l'ancien profil sera ignorée
    status = null; // l'état du profil précédent ne doit pas rester affiché
    renderStatus();
    // changement refusé (disque plein, antivirus) : le profil revient en arrière, on le dit ici, sur l'accueil
    const failure = await save({ profileId: id }, { showError: false });
    if (failure) setMessage(t('error.generic', { message: failure }), 'error');
  }

  /** Mods du pack qui seront installés : tous, plus Iris seulement avec l'option Shaders. */
  function packSize(profile) {
    return profile.pack.filter((m) => !m.optional || (settings && settings.shaders)).length;
  }

  function renderStatus() {
    const list = $('status-list');
    list.replaceChildren();
    const profile = currentProfile();
    if (!profile) return;
    const modDetail = status?.modVersion ? `v${status.modVersion}${status.modSource === 'dev' ? ` · ${t('status.dev')}` : ''}` : null;
    const rows = [
      [t('status.minecraft', { mc: profile.mc }), status?.minecraft],
      [t(`status.loader.${profile.loaderType}`, { version: profile.loaderVersion }), status?.loader],
    ];
    if (profile.hasPack) {
      rows.push([t('status.pack'), status?.pack, t(settings.shaders ? 'status.packShaders' : 'status.packCount', { n: packSize(profile) })]);
    }
    rows.push([t('status.mod'), status?.mod, modDetail], [t('status.profile'), status?.profile]);
    for (const [label, ok, detail] of rows) {
      list.append(el('li', { class: ok ? 'ok' : '' }, [
        el('span', { class: 'state', text: ok ? '✓' : '·' }),
        el('span', {}, [label, el('small', { text: ok ? detail || t('status.ok') : t('status.missing') })]),
      ]));
    }
    const button = $('play-button');
    button.disabled = busy || playing || !status;
    $('play-label').textContent = busy ? t('home.installing') : status?.installed ? t('home.play') : t('home.install');
    const player = launchAccount();
    const installHint = t(isFabric(profile) ? 'home.installHintFabric' : 'home.installHintForge', { mc: profile.mc });
    $('play-hint').textContent = busy ? '' : !status?.installed ? installHint
      : player ? t('home.playAs', { name: player.name }) : t('home.playHint', { name: profile.name });
    renderProfiles();
  }

  async function refreshStatus() {
    const token = ++statusToken;
    const next = await api.status();
    if (token !== statusToken) return;
    status = next;
    renderStatus();
    renderMods(); // la carte ATTACK de la page Mods affiche la version installée
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

  // masquage différé de la barre de progression : annulé si une nouvelle installation ou un lancement commence
  let hideProgressTimer = null;
  function showProgress() {
    clearTimeout(hideProgressTimer);
    $('progress-bar').style.width = '0%';
    $('progress').classList.remove('hidden');
  }
  function hideProgress(delay) {
    clearTimeout(hideProgressTimer);
    hideProgressTimer = setTimeout(() => $('progress').classList.add('hidden'), delay);
  }

  async function runInstall() {
    busy = true;
    setMessage(t('home.profileNote'));
    showProgress();
    renderStatus();
    const result = await call(() => api.install());
    busy = false;
    if (result.ok) {
      $('progress-bar').style.width = '100%';
      setMessage(t('home.done'), 'ok');
    } else {
      setMessage(errorText(result), 'error');
    }
    await refreshStatus();
    hideProgress(result.ok ? 1500 : 0);
    return result.ok;
  }

  api.onProgress((p) => {
    $('progress-bar').style.width = `${p.percent}%`;
    $('progress-percent').textContent = `${Math.floor(p.percent)} %`;
    const profile = currentProfile();
    $('progress-step').textContent = `${t(`step.${p.step}`, { mc: profile ? profile.mc : '' })}${p.total > 1 ? ` · ${p.done}/${p.total}` : ''}`;
  });

  $('play-button').addEventListener('click', async () => {
    if (busy || playing) return;
    if (!status?.installed) {
      await runInstall();
      return;
    }
    $('play-button').disabled = true;
    playing = true;
    renderProfiles();
    const profile = currentProfile();
    const direct = Boolean(launchAccount());
    if (direct) {
      setMessage('');
      showProgress();
    }
    const result = await call(() => api.play());
    playing = false;
    renderProfiles();
    $('play-button').disabled = false;
    if (direct) hideProgress(result.ok ? 1200 : 0);
    if (result.ok && result.mode === 'direct') setMessage(t('home.launchedDirect', { name: result.name }), 'ok');
    else if (result.ok) setMessage(t(result.detected ? 'home.launched' : 'home.launchedUnknown', { name: profile.name }), 'ok');
    else if (result.code === 'NOT_INSTALLED') await refreshStatus();
    else setMessage(errorText(result), 'error');
  });
  $('repair-button').addEventListener('click', () => !busy && !playing && runInstall());
  $('open-dir-button').addEventListener('click', () => guarded(() => api.openGameDir()));
  $('repo-button').addEventListener('click', () => api.openRepo());
  $('logs-button').addEventListener('click', () => guarded(() => api.openLogs()));

  /** Accueil : les dernières versions (texte coupé à 3 lignes) ; « Tout voir » ouvre l'historique complet. */
  const CHANGELOG_ON_HOME = 3;
  function changelogItem(entry) {
    return el('li', {}, [
      el('div', { class: 'version' }, [
        el('b', { text: entry[`version_${window.I18n.lang}`] || entry.version }),
        el('time', { text: entry.date }),
      ]),
      el('p', { text: entry[window.I18n.lang] || entry.fr }),
    ]);
  }
  function renderChangelog() {
    $('changelog').replaceChildren(...CHANGELOG.slice(0, CHANGELOG_ON_HOME).map(changelogItem));
    $('changelog-full').replaceChildren(...CHANGELOG.map(changelogItem));
    $('changelog-all').classList.toggle('hidden', CHANGELOG.length <= CHANGELOG_ON_HOME);
  }
  const changelogDialog = $('changelog-dialog');
  $('changelog-all').addEventListener('click', () => {
    changelogDialog.showModal();
    $('changelog-full').scrollTop = 0;
  });
  $('changelog-close').addEventListener('click', () => changelogDialog.close());
  // clic sur le fond assombri (hors de la fenêtre) : fermer ; Échap ferme aussi (comportement natif de <dialog>)
  changelogDialog.addEventListener('click', (event) => {
    if (event.target === changelogDialog) changelogDialog.close();
  });

  // --- mods ---
  /**
   * Cartes de la page Mods : les modules d'ATTACK Client pour Forge 1.8.9 ; pour un profil Fabric, le mod ATTACK
   * (avec sa version installée) et les mods du pack figé avec leur version.
   */
  function modItems(profile, lang) {
    if (!isFabric(profile)) {
      return MODS.map((m) => ({ name: (lang === 'en' && m.en_name) || m.name, icon: m.icon, cat: m.cat, text: m[lang] || m.fr, tags: [] }));
    }
    const attackVersion = status && status.mod && status.modVersion ? t('mods.attackVersion', { version: status.modVersion }) : t('mods.attackMissing');
    const items = [{ name: 'ATTACK Client', icon: 'AT', cat: 'attack', text: t('mods.attackDesc', { mc: profile.mc }), tags: [attackVersion] }];
    for (const mod of profile.pack) {
      const known = PACK_INFO[mod.slug] || { icon: mod.name.slice(0, 2).toUpperCase(), cat: 'utility', fr: '', en: '' };
      items.push({
        name: mod.name,
        icon: known.icon,
        cat: known.cat,
        text: known[lang] || known.fr,
        tags: [t('mods.version', { version: mod.version }), ...(mod.optional ? [t('mods.optional')] : [])],
      });
    }
    return items;
  }

  function renderMods() {
    const lang = window.I18n.lang;
    const profile = currentProfile();
    if (!profile) return;
    const fabricMode = isFabric(profile);
    $('mods-title').textContent = fabricMode ? t('mods.titleFabric', { label: profile.label }) : t('mods.title');
    $('mods-subtitle').textContent = fabricMode ? t('mods.subtitleFabric') : t('mods.subtitle');
    const items = modItems(profile, lang);
    const used = CATEGORIES.filter((c) => items.some((item) => item.cat === c.id));
    if (modFilter !== 'all' && !used.some((c) => c.id === modFilter)) modFilter = 'all';
    const chips = [{ id: 'all', fr: t('mods.all'), en: t('mods.all') }, ...used].map((c) => {
      const chip = el('button', { class: `chip${modFilter === c.id ? ' active' : ''}`, text: c[lang] || c.fr });
      chip.addEventListener('click', () => {
        modFilter = c.id;
        renderMods();
      });
      return chip;
    });
    $('mods-filters').replaceChildren(...chips);
    const visible = items.filter((m) => modFilter === 'all' || m.cat === modFilter);
    const category = (id) => CATEGORIES.find((c) => c.id === id)[lang];
    $('mods-grid').replaceChildren(...visible.map((m) => el('article', { class: 'card mod' }, [
      el('div', { class: 'mod-icon', text: m.icon }),
      el('div', {}, [
        el('h3', { text: m.name }),
        el('p', { text: m.text }),
        el('div', { class: 'tags' }, [m.cat, ...m.tags].map((tag, i) => el('span', { class: 'tag', text: i === 0 ? category(tag) : tag }))),
      ]),
    ])));
    $('mods-count').textContent = t('mods.count', { n: items.length });
  }

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
    // « Enregistré », ou l'erreur au même endroit : sur la page Réglages, pas sur l'accueil
    const saved = $('saved');
    clearTimeout(savedTimer);
    saved.classList.toggle('error', Boolean(failure));
    if (failure && !showError) {
      saved.classList.add('hidden');
    } else {
      saved.textContent = failure ? t('error.generic', { message: failure }) : t('settings.saved');
      saved.classList.remove('hidden');
      savedTimer = setTimeout(() => saved.classList.add('hidden'), failure ? 6000 : 1600);
    }
    if (['profileId', 'gameDir', 'devMode', 'devJarDir', 'shaders'].some((key) => key in patch)) refreshStatus();
    if ('devMode' in patch || 'msClientId' in patch) refreshAccounts();
    return failure;
  }

  function formatRam(mb) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(2).replace(/0$/, '')} ${window.I18n.lang === 'en' ? 'GB' : 'Go'}`;
  }

  function renderSettings() {
    const profile = currentProfile();
    if (profile) {
      $('settings-profile').textContent = `${profile.label} · ${loaderName(profile)}`;
      $('ram-help').textContent = isFabric(profile) ? t('settings.ramHelpModern', { mc: profile.mc }) : t('settings.ramHelp');
      $('java-help').textContent = t('settings.javaHelp', { java: profile.javaMajor, mc: profile.mc });
      $('jvm-args-help').textContent = t('settings.jvmArgsHelp', { java: profile.javaMajor });
      $('dev-help').textContent = t('settings.devHelp', { glob: profile.jarGlob });
      $('shaders-card').classList.toggle('hidden', !isFabric(profile));
      $('shaders').checked = Boolean(settings.shaders);
    }
    const ram = $('ram');
    const max = info ? Math.max(4096, Math.min(16384, Math.floor(info.totalRamMb / 1024) * 1024)) : 8192;
    ram.max = String(max);
    ram.value = String(settings.ramMb);
    $('ram-value').textContent = formatRam(settings.ramMb);
    $('ram-warn').classList.toggle('hidden', !info || settings.ramMb <= info.totalRamMb / 2);
    $('game-dir').value = settings.gameDir;
    const custom = settings.javaPath !== '' || $('java-mode').dataset.forceCustom === '1';
    $('java-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.value === 'custom') === custom));
    $('java-custom').classList.toggle('hidden', !custom);
    $('java-path').value = settings.javaPath;
    // texte en cours de saisie gardé, sauf si le profil a changé : on affiche alors celui du nouveau profil
    const jvmField = $('jvm-args');
    const otherProfile = jvmField.dataset.profile !== settings.profileId;
    if (otherProfile || document.activeElement !== jvmField) jvmField.value = settings.jvmArgs || '';
    if (otherProfile) $('jvm-args-warn').classList.add('hidden');
    jvmField.dataset.profile = settings.profileId;
    $('lang').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.lang));
    $('dev-mode').checked = settings.devMode;
    $('dev-dir-row').classList.toggle('hidden', !settings.devMode);
    $('dev-dir').value = settings.devJarDir;
    $('client-id').value = settings.msClientId;
    $('client-id').placeholder = settings.msClientId ? '00000000-0000-0000-0000-000000000000'
      : accountsView.clientIdFromEnv ? t('settings.clientIdEnv') : t('settings.clientIdDefault');
    if (info) $('about').textContent = t('settings.about', { version: info.version, dir: info.minecraftDir });
  }

  $('ram').addEventListener('input', (e) => {
    $('ram-value').textContent = formatRam(Number(e.target.value));
  });
  $('ram').addEventListener('change', (e) => save({ ramMb: Number(e.target.value) }));
  $('game-dir-change').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.gameDir);
    if (dir) save({ gameDir: dir });
  });
  $('game-dir-reset').addEventListener('click', () => save({ gameDir: '' }));
  $('java-mode').addEventListener('click', (e) => {
    const value = e.target.dataset?.value;
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
  $('jvm-args').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveJvmArgs(e.target.value);
  });
  $('jvm-args-reset').addEventListener('click', () => saveJvmArgs(''));
  $('lang').addEventListener('click', async (e) => {
    const value = e.target.dataset?.value;
    if (!value) return;
    await save({ lang: value });
    applyLanguage();
  });
  $('dev-mode').addEventListener('change', (e) => save({ devMode: e.target.checked }));
  $('shaders').addEventListener('change', (e) => save({ shaders: e.target.checked }));
  $('dev-dir-change').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.devJarDir);
    if (dir) save({ devJarDir: dir });
  });

  // --- comptes ---
  /** Compte utilisé par JOUER : le compte actif (hors ligne seulement en mode développeur). */
  function launchAccount() {
    const active = accountsView.accounts.find((a) => a.active);
    return active && (active.type === 'msa' || settings?.devMode) ? active : null;
  }

  /** Tête du joueur (visage + calque du chapeau) dessinée depuis la skin, en pixels nets. */
  function avatar(account) {
    const box = el('div', { class: 'avatar', text: account.name.slice(0, 1).toUpperCase() });
    if (!account.skin) return box;
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
    return box;
  }

  function accountMessage(text, kind = '') {
    const node = $('account-message');
    node.textContent = text || '';
    node.className = `message ${kind}`;
    node.classList.toggle('hidden', !text);
  }

  function renderAccounts() {
    const view = accountsView;
    $('azure-setup').classList.toggle('hidden', view.hasClientId);
    $('login-button').disabled = !view.hasClientId || loggingIn;
    $('offline-card').classList.toggle('hidden', !view.devMode);
    const list = $('accounts-list');
    if (view.accounts.length === 0) {
      list.replaceChildren(el('p', { class: 'empty', text: t('account.none') }));
    } else {
      list.replaceChildren(...view.accounts.map((account) => {
        const actions = [];
        if (!account.active) {
          const use = el('button', { class: 'btn', text: t('account.use') });
          use.addEventListener('click', async () => {
            const view = await guarded(() => api.accounts.select(account.id), (text) => accountMessage(text, 'error'));
            if (view) accountsView = view;
            renderAccounts();
            renderStatus();
          });
          actions.push(use);
        }
        const remove = el('button', { class: 'btn ghost danger', text: t('account.remove') });
        remove.addEventListener('click', async () => {
          const view = await guarded(() => api.accounts.remove(account.id), (text) => accountMessage(text, 'error'));
          if (view) accountsView = view;
          renderAccounts();
          renderStatus();
        });
        actions.push(remove);
        return el('div', { class: `card account-card${account.active ? ' active' : ''}` }, [
          avatar(account),
          el('div', { class: 'account-info' }, [
            el('b', { text: account.name }),
            el('span', { class: 'badge', text: t(account.type === 'msa' ? 'account.msa' : 'account.offline') }),
            ...(account.active ? [' ', el('span', { class: 'badge on', text: t('account.active') })] : []),
          ]),
          el('div', { class: 'setup-actions' }, actions),
        ]);
      }));
    }
    document.dispatchEvent(new CustomEvent('attack:accounts', { detail: view }));
  }

  // skin.js (vue 3D du skin) suit le compte actif et reutilise la traduction des erreurs
  window.AttackUI = { errorText, view: () => accountsView };

  async function refreshAccounts() {
    accountsView = await api.accounts.list();
    renderAccounts();
    renderStatus();
    renderSettings();
  }

  let loggingIn = false;
  $('login-button').addEventListener('click', async () => {
    if (loggingIn) return;
    loggingIn = true;
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
  });
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

  api.onUpdateState((state) => {
    if (state.phase !== update.phase || state.version !== update.version) updateNote = '';
    update = state;
    renderUpdate();
  });
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
    renderProfiles();
    renderStatus();
    renderChangelog();
    renderMods();
    renderSettings();
    renderAccounts();
    renderUpdate();
  }

  api.onWindowState(({ maximized }) => document.body.classList.toggle('maximized', maximized));

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
