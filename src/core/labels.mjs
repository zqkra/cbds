/**
 * Human-facing labels for panes and tabs.
 *
 * With a wave of workers the tab bar is the only overview a person gets, and it is
 * only useful if the labels are *distinguishable*. Sibling tasks in one run almost
 * always share a prefix ("Curiozy ...", "Fix ..."), and a naive truncation spends the
 * few visible characters on the part every tab has in common — so thirty tabs all
 * read the same and the bar becomes decoration.
 */

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

/** Longest prefix, in whole words, shared by every title. */
export const commonWordPrefix = (titles) => {
  const lists = titles.map(words).filter((w) => w.length);
  if (lists.length < 2) return '';
  const first = lists[0];
  let n = 0;
  while (n < first.length - 1) {
    const w = first[n];
    if (!lists.every((l) => l.length > n + 1 && l[n] === w)) break;
    n += 1;
  }
  return n ? `${first.slice(0, n).join(' ')} ` : '';
};

/** Trim to `max`, never mid-word, never leaving dangling punctuation. */
export const clipWords = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,.;:·—–-]+$/, '')}…`;
};

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Words shared by most siblings carry no information here.
 *
 * A shared *prefix* is not the whole problem: thirty titles about the same person
 * repeat that name in the middle too, and it still eats the handful of characters a
 * tab bar shows. Dropping words that appear in more than half the siblings leaves
 * exactly the part that identifies this one. The result reads slightly clipped, which
 * is the right trade for something scanned rather than read.
 */
export const dropSharedWords = (title, siblings, { threshold = 0.5, minSiblings = 5 } = {}) => {
  if (siblings.length < minSiblings) return title;
  const counts = new Map();
  for (const s of siblings) {
    for (const w of new Set(words(s).map(norm).filter(Boolean))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const limit = siblings.length * threshold;
  const kept = words(title).filter((w) => {
    const key = norm(w);
    return !key || (counts.get(key) ?? 0) <= limit;
  });
  // Never strip a title down to nothing: an empty tab is worse than a repetitive one.
  return kept.length ? kept.join(' ') : title;
};

/**
 * A label that says what makes THIS task different from its siblings.
 * Falls back to the plain title whenever stripping would leave nothing useful.
 */
export const distinctiveLabel = (title, siblings = [], max = 22) => {
  const prefix = commonWordPrefix(siblings.length > 1 ? siblings : []);
  const stripped = prefix && title.startsWith(prefix) ? title.slice(prefix.length) : title;
  const trimmed = dropSharedWords(stripped.trim() || title, siblings);
  return clipWords(trimmed.replace(/^[\s,.;:·—–-]+/, '') || stripped || title, max);
};

/**
 * Labels for a whole set at once, guaranteed distinct.
 *
 * Trimming to the distinctive part can still collide — two titles that differ only
 * past the cut produce the same label, and two identical tabs are no more useful than
 * two repetitive ones. Collisions are therefore widened until they separate, and only
 * numbered if the full titles really are identical.
 */
export const distinctiveLabels = (titles, max = 24) => {
  const base = titles.map((t) => distinctiveLabel(t, titles, max));
  const groups = new Map();
  base.forEach((label, i) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  });

  const out = [...base];
  for (const [, idx] of groups) {
    if (idx.length < 2) continue;
    // Widen the cut until the clashing labels separate.
    for (let width = max + 6; width <= max + 40; width += 6) {
      const widened = idx.map((i) => distinctiveLabel(titles[i], titles, width));
      if (new Set(widened).size === idx.length) {
        idx.forEach((i, k) => { out[i] = widened[k]; });
        break;
      }
    }
    // Still identical: the titles themselves are, so number them.
    const check = new Set(idx.map((i) => out[i]));
    if (check.size < idx.length) {
      idx.forEach((i, k) => { out[i] = `${clipWords(out[i], max - 4)} (${k + 1})`; });
    }
  }
  return out;
};
