// Page Comptes : skin du compte actif en 3D (skinview3d), changement de skin et retour au skin par défaut.
// Les images arrivent en data: URL depuis le processus principal ; la page ne contacte aucun serveur.
(function () {
  'use strict';
  const api = window.attack;
  const { t } = window.I18n;
  const $ = (id) => document.getElementById(id);

  let viewer = null;
  let shownSkin = null; // image affichée (skin du compte ou aperçu)
  let pending = null; // { dataUrl, legacy } choisi mais pas encore envoyé
  let model = 'classic';
  let busy = false;
  let anim = 'walk';

  function message(text, kind = '') {
    const node = $('skin-message');
    node.textContent = text || '';
    node.className = `message ${kind}`;
    node.classList.toggle('hidden', !text);
  }

  function activeAccount() {
    return (window.AttackUI?.view().accounts || []).find((a) => a.active) || null;
  }

  function ensureViewer() {
    if (viewer || !window.skinview3d) return viewer;
    try {
      viewer = new window.skinview3d.SkinViewer({ canvas: $('skin-canvas'), width: 240, height: 320 });
      viewer.zoom = 0.85;
      viewer.fov = 50;
      viewer.autoRotate = true;
      viewer.autoRotateSpeed = 0.6;
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
      setAnimation(anim);
    } catch {
      viewer = null; // pas de WebGL : on garde la tête 2D de la liste des comptes
    }
    return viewer;
  }

  function setAnimation(name) {
    anim = name;
    document.querySelectorAll('#skin-anim .chip').forEach((b) => b.classList.toggle('active', b.dataset.anim === name));
    if (!viewer) return;
    const S = window.skinview3d;
    viewer.animation = name === 'run' ? new S.RunningAnimation() : name === 'idle' ? new S.IdleAnimation() : new S.WalkingAnimation();
    if (viewer.animation && name === 'run') viewer.animation.speed = 0.7;
  }

  function show(dataUrl, variant) {
    const v = ensureViewer();
    $('skin-empty').classList.toggle('hidden', Boolean(dataUrl));
    $('skin-canvas').classList.toggle('hidden', !dataUrl || !v);
    if (!v || !dataUrl) return;
    if (dataUrl !== shownSkin || v.playerObject.skin.modelType !== (variant === 'slim' ? 'slim' : 'default')) {
      v.loadSkin(dataUrl, { model: variant === 'slim' ? 'slim' : 'default' });
      shownSkin = dataUrl;
    }
  }

  function render() {
    const account = activeAccount();
    const card = $('skin-card');
    card.classList.toggle('hidden', !account);
    if (!account) return;
    const msa = account.type === 'msa';
    const variant = pending ? model : account.skinVariant;
    $('skin-variant-badge').textContent = t(variant === 'slim' ? 'skin.slim' : 'skin.classic');
    $('skin-help').textContent = t(msa ? 'skin.help' : 'skin.offline');
    $('skin-actions').classList.toggle('hidden', !msa || Boolean(pending));
    $('skin-pending').classList.toggle('hidden', !pending);
    $('skin-legacy').classList.toggle('hidden', !pending?.legacy);
    $('skin-preview-badge').classList.toggle('hidden', !pending);
    document.querySelectorAll('#skin-model .chip').forEach((b) => b.classList.toggle('active', b.dataset.model === model));
    for (const id of ['skin-pick', 'skin-refresh', 'skin-reset', 'skin-apply', 'skin-cancel']) $(id).disabled = busy;
    show(pending ? pending.dataUrl : account.skin, variant);
  }

  async function run(action, okText) {
    if (busy) return;
    busy = true;
    message(t('skin.working'));
    render();
    const result = await action();
    busy = false;
    if (result?.ok) {
      pending = null;
      message(okText, 'ok');
    } else if (result && result.code !== 'CANCELLED') {
      message(window.AttackUI.errorText(result), 'error');
    } else {
      message('');
    }
    render();
  }

  $('skin-pick').addEventListener('click', async () => {
    const result = await api.skins.pick();
    if (!result.ok) {
      if (result.code !== 'CANCELLED') message(window.AttackUI.errorText(result), 'error');
      return;
    }
    pending = { dataUrl: result.dataUrl, legacy: result.legacy };
    model = activeAccount()?.skinVariant || 'classic';
    message(t('skin.previewHelp'));
    render();
  });
  $('skin-cancel').addEventListener('click', async () => {
    pending = null;
    await api.skins.discard();
    message('');
    render();
  });
  $('skin-apply').addEventListener('click', () => run(() => api.skins.apply(model), t('skin.applied')));
  $('skin-reset').addEventListener('click', () => {
    if (!window.confirm(t('skin.resetConfirm'))) return;
    run(() => api.skins.reset(), t('skin.resetDone'));
  });
  $('skin-refresh').addEventListener('click', () => run(() => api.skins.refresh(), t('skin.refreshed')));
  document.querySelectorAll('#skin-model .chip').forEach((button) => button.addEventListener('click', () => {
    model = button.dataset.model;
    render();
  }));
  document.querySelectorAll('#skin-anim .chip').forEach((button) => button.addEventListener('click', () => setAnimation(button.dataset.anim)));

  // la liste des comptes vient d'être redessinée (connexion, changement de compte, skin mis à jour)
  document.addEventListener('attack:accounts', () => {
    const account = activeAccount();
    if (pending && (!account || account.type !== 'msa')) pending = null;
    render();
  });
  render();
})();
