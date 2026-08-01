// board.js — builds the clickable dartboard SVG.
// Fires: document.dispatchEvent(new CustomEvent('dart-segment', {detail:{segment, multiplier}}))

(function () {
  const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const CX = 400, CY = 400;
  const S = 2.0; // px per mm

  const R = {
    bullseye: 6.35 * S,
    outerBull: 15.9 * S,
    tripleIn: 99 * S,
    tripleOut: 107 * S,
    doubleIn: 162 * S,
    doubleOut: 170 * S,
    rim: 190 * S,
    // Was 200*S (=400), sitting exactly on the SVG's own edge (CX/CY=400 in
    // an 800x800 viewBox) - text glyphs there got clipped by the boundary,
    // and worse, that radius is outside the cream rim circle (190*S=380)
    // entirely, so labels sat directly on the page background with no
    // contrasting backdrop at all. 181*S sits comfortably inside the cream
    // margin band between the black outer ring and the rim's own edge.
    label: 181 * S,
  };

  function polar(r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
  }

  function annularSectorPath(r1, r2, a1, a2) {
    const [x1, y1] = polar(r1, a1);
    const [x2, y2] = polar(r2, a1);
    const [x3, y3] = polar(r2, a2);
    const [x4, y4] = polar(r1, a2);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M ${x1} ${y1} L ${x2} ${y2} A ${r2} ${r2} 0 ${large} 1 ${x3} ${y3} ` +
           `L ${x4} ${y4} A ${r1} ${r1} 0 ${large} 0 ${x1} ${y1} Z`;
  }

  function ns(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

  function el(tag, attrs) {
    const e = ns(tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  // `ring` is purely informational (used only by Snakes & Ladders to map the
  // 6 real dartboard zones to a 1-6 dice-like movement value) - it never
  // affects scoring in other modes, where inner-single and outer-single are
  // both just "single" (multiplier 1), same as always.
  function addWedge(svg, path, segment, multiplier, fill, ring) {
    const p = el('path', { d: path, class: 'wedge', fill, stroke: '#0a0a0a', 'stroke-width': 1 });
    p.dataset.segment = segment;
    p.dataset.multiplier = multiplier;
    p.addEventListener('click', () => {
      p.classList.add('tapped');
      setTimeout(() => p.classList.remove('tapped'), 120);
      document.dispatchEvent(new CustomEvent('dart-segment', {
        detail: { segment: segment === 'BULL' ? 'BULL' : Number(segment), multiplier, ring },
      }));
    });
    svg.appendChild(p);
  }

  function build() {
    const svg = document.getElementById('board-svg');
    svg.innerHTML = '';

    // background rim
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R.rim, fill: '#efe6d0' }));
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R.doubleOut + 4, fill: '#0d0d0d' }));

    ORDER.forEach((num, i) => {
      const a1 = i * 18 - 9;
      const a2 = i * 18 + 9;
      const dark = i % 2 === 0;
      const single = dark ? '#0d0d0d' : '#efe6d0';
      const accent = dark ? '#b3282d' : '#1f7a4d';

      addWedge(svg, annularSectorPath(R.outerBull, R.tripleIn, a1, a2), num, 1, single, 'inner-single');
      addWedge(svg, annularSectorPath(R.tripleIn, R.tripleOut, a1, a2), num, 3, accent, 'treble');
      addWedge(svg, annularSectorPath(R.tripleOut, R.doubleIn, a1, a2), num, 1, single, 'outer-single');
      addWedge(svg, annularSectorPath(R.doubleIn, R.doubleOut, a1, a2), num, 2, accent, 'double');

      // number label
      const [lx, ly] = polar(R.label, i * 18);
      const t = el('text', {
        x: lx, y: ly, fill: '#4a2f1c', 'font-size': 22, 'font-weight': 800,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      t.textContent = num;
      svg.appendChild(t);
    });

    // bulls
    addWedge(svg, `M ${CX - R.outerBull} ${CY} A ${R.outerBull} ${R.outerBull} 0 1 1 ${CX + R.outerBull} ${CY} A ${R.outerBull} ${R.outerBull} 0 1 1 ${CX - R.outerBull} ${CY} Z`, 'BULL', 1, '#1f7a4d', 'outer-bull');
    addWedge(svg, `M ${CX - R.bullseye} ${CY} A ${R.bullseye} ${R.bullseye} 0 1 1 ${CX + R.bullseye} ${CY} A ${R.bullseye} ${R.bullseye} 0 1 1 ${CX - R.bullseye} ${CY} Z`, 'BULL', 2, '#b3282d', 'inner-bull');
  }

  document.addEventListener('DOMContentLoaded', build);
})();
