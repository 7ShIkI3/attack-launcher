// Logique de l'interface : navigation, état d'installation, bouton JOUER, vitrine des mods, réglages.
(function () {
  'use strict';
  const api = window.attack;
  const { t } = window.I18n;
  const { CATEGORIES, MODS, CHANGELOG } = window.AttackData;
  const $ = (id) => document.getElementById(id);

  let info = null;
  let settings = null;
  let status = null;
  let busy = false;
  let modFilter = 'all';

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

  function renderStatus() {
    const list = $('status-list');
    list.replaceChildren();
    const items = [
      ['minecraft', status?.minecraft],
      ['forge', status?.forge],
      ['mod', status?.mod, status?.modVersion ? `v${status.modVersion}${status.modSource === 'dev' ? ` · ${t('status.dev')}` : ''}` : null],
      ['profile', status?.profile],
    ];
    for (const [key, ok, detail] of items) {
      list.append(el('li', { class: ok ? 'ok' : '' }, [
        el('span', { class: 'state', text: ok ? '✓' : '·' }),
        el('span', {}, [t(`status.${key}`), el('small', { text: ok ? detail || t('status.ok') : t('status.missing') })]),
      ]));
    }
    const button = $('play-button');
    button.disabled = busy || !status;
    $('play-label').textContent = busy ? t('home.installing') : status?.installed ? t('home.play') : t('home.install');
    $('play-hint').textContent = busy ? '' : status?.installed ? t('home.playHint') : t('home.installHint');
  }

  async function refreshStatus() {
    status = await api.status();
    renderStatus();
  }

  function errorText(result) {
    const key = `error.${result.code}`;
    const text = t(key);
    return text === key ? t('error.generic', { message: result.message }) : text;
  }

  async function runInstall() {
    busy = true;
    setMessage(t('home.profileNote'));
    $('progress').classList.remove('hidden');
    renderStatus();
    const result = await api.install();
    busy = false;
    if (result.ok) {
      $('progress-bar').style.width = '100%';
      setMessage(t('home.done'), 'ok');
    } else {
      setMessage(errorText(result), 'error');
    }
    await refreshStatus();
    setTimeout(() => $('progress').classList.add('hidden'), result.ok ? 1500 : 0);
    return result.ok;
  }

  api.onProgress((p) => {
    $('progress-bar').style.width = `${p.percent}%`;
    $('progress-percent').textContent = `${Math.floor(p.percent)} %`;
    $('progress-step').textContent = `${t(`step.${p.step}`)}${p.total > 1 ? ` · ${p.done}/${p.total}` : ''}`;
  });

  $('play-button').addEventListener('click', async () => {
    if (busy) return;
    if (!status?.installed) {
      await runInstall();
      return;
    }
    $('play-button').disabled = true;
    const result = await api.play();
    $('play-button').disabled = false;
    if (result.ok) setMessage(result.detected ? t('home.launched') : t('home.launchedUnknown'), 'ok');
    else if (result.code === 'NOT_INSTALLED') await refreshStatus();
    else setMessage(errorText(result), 'error');
  });
  $('repair-button').addEventListener('click', () => !busy && runInstall());
  $('open-dir-button').addEventListener('click', () => api.openGameDir());
  $('repo-button').addEventListener('click', () => api.openRepo());

  function renderChangelog() {
    const list = $('changelog');
    list.replaceChildren(...CHANGELOG.map((entry) => el('li', {}, [
      el('div', { class: 'version' }, [
        el('b', { text: entry[`version_${window.I18n.lang}`] || entry.version }),
        el('time', { text: entry.date }),
      ]),
      el('p', { text: entry[window.I18n.lang] || entry.fr }),
    ])));
  }

  // --- mods ---
  function renderMods() {
    const lang = window.I18n.lang;
    const filters = $('mods-filters');
    const chips = [{ id: 'all', fr: t('mods.all'), en: t('mods.all') }, ...CATEGORIES].map((c) => {
      const chip = el('button', { class: `chip${modFilter === c.id ? ' active' : ''}`, text: c[lang] || c.fr });
      chip.addEventListener('click', () => {
        modFilter = c.id;
        renderMods();
      });
      return chip;
    });
    filters.replaceChildren(...chips);
    const visible = MODS.filter((m) => modFilter === 'all' || m.cat === modFilter);
    const category = (id) => CATEGORIES.find((c) => c.id === id)[lang];
    $('mods-grid').replaceChildren(...visible.map((m) => el('article', { class: 'card mod' }, [
      el('div', { class: 'mod-icon', text: m.icon }),
      el('div', {}, [
        el('h3', { text: (lang === 'en' && m.en_name) || m.name }),
        el('p', { text: m[lang] || m.fr }),
        el('span', { class: 'tag', text: category(m.cat) }),
      ]),
    ])));
    $('mods-count').textContent = t('mods.count', { n: MODS.length });
  }

  // --- réglages ---
  let savedTimer = null;
  async function save(patch) {
    settings = await api.setSettings(patch);
    renderSettings();
    $('saved').classList.remove('hidden');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.add('hidden'), 1600);
    if ('gameDir' in patch || 'devMode' in patch || 'devJarDir' in patch) refreshStatus();
  }

  function formatRam(mb) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(2).replace(/0$/, '')} ${window.I18n.lang === 'en' ? 'GB' : 'Go'}`;
  }

  function renderSettings() {
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
    $('lang').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.lang));
    $('dev-mode').checked = settings.devMode;
    $('dev-dir-row').classList.toggle('hidden', !settings.devMode);
    $('dev-dir').value = settings.devJarDir;
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
  $('lang').addEventListener('click', async (e) => {
    const value = e.target.dataset?.value;
    if (!value) return;
    await save({ lang: value });
    applyLanguage();
  });
  $('dev-mode').addEventListener('change', (e) => save({ devMode: e.target.checked }));
  $('dev-dir-change').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.devJarDir);
    if (dir) save({ devJarDir: dir });
  });

  function applyLanguage() {
    window.I18n.setLang(settings.lang);
    renderStatus();
    renderChangelog();
    renderMods();
    renderSettings();
  }

  api.onWindowState(({ maximized }) => document.body.classList.toggle('maximized', maximized));

  async function init() {
    [info, settings] = await Promise.all([api.info(), api.getSettings()]);
    $('hero-sub').textContent = `Minecraft ${info.mcVersion} · Forge ${info.forgeVersion.split('-')[1]}`;
    applyLanguage();
    await refreshStatus();
  }

  init().catch((error) => setMessage(t('error.generic', { message: error.message }), 'error'));
})();
