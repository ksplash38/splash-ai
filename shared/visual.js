/* Splash AI - draws the simple pictures the brain can attach to an answer
 * (steps, flow, cards, compare) as plain HTML. Used by both apps' chat.
 * Everything from the model is escaped; no model HTML is ever inserted.
 */
(function (root) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function item(i, n, numbered) {
    const badge = i.emoji ? `<span class="vz-emoji" aria-hidden="true">${esc(i.emoji)}</span>`
      : numbered ? `<span class="vz-num" aria-hidden="true">${n}</span>` : '';
    return `<div class="vz-item">${badge}<div>${i.title ? `<strong>${numbered ? n + '. ' : ''}${esc(i.title)}</strong>` : ''}${i.text ? `<p>${esc(i.text)}</p>` : ''}</div></div>`;
  }

  function render(v) {
    if (!v || !v.type) return '';
    const title = v.title ? `<div class="vz-title">${esc(v.title)}</div>` : '';
    if (v.type === 'compare') {
      const rows = v.rows.map(r => `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.left)}</td><td>${esc(r.right)}</td></tr>`).join('');
      return `<figure class="vz vz-compare">${title}<table><thead><tr><th></th><th scope="col">${esc(v.left)}</th><th scope="col">${esc(v.right)}</th></tr></thead><tbody>${rows}</tbody></table></figure>`;
    }
    const items = v.items || [];
    if (v.type === 'flow') {
      const parts = items.map((i, k) => item(i, k + 1, false) + (k < items.length - 1 ? '<div class="vz-arrow" aria-hidden="true">↓</div>' : '')).join('');
      return `<figure class="vz vz-flow">${title}${parts}</figure>`;
    }
    if (v.type === 'cards') return `<figure class="vz vz-cards">${title}<div class="vz-grid">${items.map(i => item(i, 0, false)).join('')}</div></figure>`;
    return `<figure class="vz vz-steps">${title}${items.map((i, k) => item(i, k + 1, true)).join('')}</figure>`; // steps
  }

  // The on-screen part of an answer below the spoken line: the fuller explanation, then the picture.
  function answerExtras(m) {
    return (m.explain ? `<div class="explain">${esc(m.explain)}</div>` : '') + render(m.visual);
  }

  root.SplashVisual = { render, answerExtras };
})(typeof window !== 'undefined' ? window : this);
