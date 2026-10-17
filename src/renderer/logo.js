// Logo ATTACK : un « A » taillé comme une lame (deux lames + une entaille), redessiné d'après LogoPainter
// du mod, sur une grille 100 × 100. Utilisé par l'interface (SVG) et par scripts/make-icons.js (PNG).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttackLogo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEFT_BLADE = [3, 96, 50, 1, 59, 20, 22, 96];
  const RIGHT_BLADE = [50, 1, 97, 96, 78, 96, 41, 20];
  const SLASH = [17, 71, 83, 55, 86, 62, 20, 78];

  // Couleurs calculées comme LogoPainter avec l'accent rouge #E53935 (mélanges vers le blanc / le noir)
  const COLORS = {
    leftTop: '#F19290', // accent + 45 % de blanc
    leftBottom: '#E53935', // accent
    rightTop: '#EC6B68', // accent + 25 % de blanc
    rightBottom: '#AC2B28', // accent + 25 % de noir
    slashTop: '#FFFFFF',
    slashBottom: '#D8D8E0',
  };

  function points(xy) {
    const out = [];
    for (let i = 0; i < xy.length; i += 2) out.push(`${xy[i]},${xy[i + 1]}`);
    return out.join(' ');
  }

  /** Code SVG du logo ; `id` rend les identifiants de dégradés uniques quand le logo apparaît plusieurs fois. */
  function svg({ id = 'logo', size = 40, glow = false, title = 'ATTACK' } = {}) {
    const g = (name) => `${id}-${name}`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${title}">` +
      '<defs>' +
      `<linearGradient id="${g('l')}" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${COLORS.leftTop}"/><stop offset="1" stop-color="${COLORS.leftBottom}"/></linearGradient>` +
      `<linearGradient id="${g('r')}" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${COLORS.rightTop}"/><stop offset="1" stop-color="${COLORS.rightBottom}"/></linearGradient>` +
      `<linearGradient id="${g('s')}" x1="0" y1="50" x2="0" y2="85" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${COLORS.slashTop}"/><stop offset="1" stop-color="${COLORS.slashBottom}"/></linearGradient>` +
      (glow
        ? `<filter id="${g('glow')}" x="-30%" y="-30%" width="160%" height="160%">` +
          '<feGaussianBlur in="SourceAlpha" stdDeviation="4"/><feFlood flood-color="#E53935" flood-opacity="0.55"/>' +
          '<feComposite operator="in" in2="SourceAlpha"/><feGaussianBlur stdDeviation="3"/>' +
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
        : '') +
      '</defs>' +
      `<g${glow ? ` filter="url(#${g('glow')})"` : ''}>` +
      `<polygon points="${points(RIGHT_BLADE)}" fill="url(#${g('r')})"/>` +
      `<polygon points="${points(LEFT_BLADE)}" fill="url(#${g('l')})"/>` +
      `<polygon points="${points(SLASH)}" fill="#000" fill-opacity="0.35" transform="translate(0 2.5)"/>` +
      `<polygon points="${points(SLASH)}" fill="url(#${g('s')})"/>` +
      '</g></svg>'
    );
  }

  return { LEFT_BLADE, RIGHT_BLADE, SLASH, COLORS, svg };
});
