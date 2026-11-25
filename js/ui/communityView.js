/**
 * @fileoverview Community Clean-Air Board (explicitly separating Illustrative Examples
 * from device-local pledges) and global city autocomplete combobox renderer.
 */

import { ACTION_CATEGORIES } from '../core/communityModeration.js';
import { clearNode, createSafeElement } from '../core/security.js';
import { loadJson, saveJson, showToast, STORAGE_KEYS } from './domHelpers.js';

/** @type {ReadonlyArray<Record<string, any>>} */
export const DEFAULT_DEMO_PLEDGES = Object.freeze([
  {
    id: 'seed-1',
    origin: 'demo',
    area: 'Dwarka District, Delhi',
    category: 'zero-burning',
    action: 'Resident association adopted damp morning courtyard sweeping and composting for winter leaf litter.',
    supporters: 28,
    status: 'active'
  },
  {
    id: 'seed-2',
    origin: 'demo',
    area: 'Indiranagar East, Bengaluru',
    category: 'mobility',
    action: 'Coordinated 4 shared school-run carpools across neighborhood families to cut morning corridor idling.',
    supporters: 19,
    status: 'active'
  },
  {
    id: 'seed-3',
    origin: 'demo',
    area: 'Salt Lake Zone, Kolkata',
    category: 'indoor-care',
    action: 'Assembled low-cost MERV-13/HEPA fan boxes for the community senior reading room during peak winter haze.',
    supporters: 15,
    status: 'active'
  }
]);

/**
 * Loads community pledges from storage while tagging illustrative demo vs. local entries.
 * @returns {Array<Record<string, any>>}
 */
export function loadPledgesWithOrigin() {
  const stored = loadJson(STORAGE_KEYS.PLEDGES, DEFAULT_DEMO_PLEDGES);
  if (!Array.isArray(stored)) return DEFAULT_DEMO_PLEDGES.map((p) => ({ ...p }));
  return stored.map((item) => ({
    ...item,
    origin: item.origin === 'demo' || String(item.id || '').startsWith('seed-') ? 'demo' : 'local'
  }));
}

function buildPledgeCard(pledge, categoryLabels, state) {
  const isDemo = pledge.origin === 'demo';
  const upvoteBtn = createSafeElement(document, 'button', {
    className: 'btn btn-secondary btn-sm',
    text: isDemo ? `Demo (${pledge.supporters})` : `Support (${pledge.supporters})`,
    attrs: { type: 'button', 'aria-label': `Support clean-air initiative in ${pledge.area}, ${pledge.supporters} supporters` }
  });
  upvoteBtn.addEventListener('click', () => {
    pledge.supporters += 1;
    saveJson(STORAGE_KEYS.PLEDGES, state.pledges);
    renderCommunity(state);
    showToast(`Recorded local support for ${pledge.area}.`);
  });

  return createSafeElement(document, 'li', {
    className: 'pledge-card',
    children: [
      createSafeElement(document, 'div', {
        children: [
          createSafeElement(document, 'div', {
            className: 'provenance-row',
            children: [
              createSafeElement(document, 'span', { className: 'badge badge-teal', text: categoryLabels[pledge.category] || 'Community' }),
              createSafeElement(document, 'span', {
                className: isDemo ? 'badge badge-neutral' : 'badge badge-good',
                text: isDemo ? 'Illustrative Example' : 'Saved on This Device'
              }),
              createSafeElement(document, 'span', { className: 'mono-meta', text: pledge.area })
            ]
          }),
          createSafeElement(document, 'p', { className: 'routine-action', text: pledge.action })
        ]
      }),
      upvoteBtn
    ]
  });
}

/**
 * Renders community board provenance counters, category filters, and initiative cards.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderCommunity(state) {
  const localCount = state.pledges.filter((p) => p.origin === 'local').length;
  const demoCount = state.pledges.length - localCount;

  const statsRow = document.getElementById('community-stats-badges');
  clearNode(statsRow);
  statsRow.appendChild(createSafeElement(document, 'span', { className: 'badge badge-teal', text: `${localCount} Saved on This Device` }));
  statsRow.appendChild(createSafeElement(document, 'span', { className: 'badge badge-neutral', text: `${demoCount} Illustrative Examples` }));

  const filterRow = document.getElementById('pledge-filter-row');
  clearNode(filterRow);
  for (const f of [{ id: 'all', label: 'All Categories' }, ...ACTION_CATEGORIES]) {
    const active = state.activePledgeFilter === f.id;
    const btn = createSafeElement(document, 'button', {
      className: `chip-btn${active ? ' is-active' : ''}`,
      text: f.label,
      attrs: { type: 'button', 'aria-pressed': String(active) }
    });
    btn.addEventListener('click', () => { state.activePledgeFilter = f.id; renderCommunity(state); });
    filterRow.appendChild(btn);
  }

  const list = document.getElementById('pledge-list');
  clearNode(list);
  const categoryLabels = Object.fromEntries(ACTION_CATEGORIES.map((c) => [c.id, c.label]));
  const visible = state.activePledgeFilter === 'all'
    ? state.pledges
    : state.pledges.filter((p) => p.category === state.activePledgeFilter);

  if (visible.length === 0) {
    list.appendChild(createSafeElement(document, 'li', { className: 'subpanel muted-text', text: 'No initiatives logged in this category yet.' }));
    return;
  }
  for (const pledge of visible) list.appendChild(buildPledgeCard(pledge, categoryLabels, state));
}

/**
 * Collapses and clears the city autocomplete suggestion listbox.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function closeSuggestions(state) {
  const list = document.getElementById('search-suggestions');
  state.suggestions = [];
  state.highlightedSuggestion = -1;
  if (list) { clearNode(list); list.hidden = true; }
  document.getElementById('city-search-input')?.setAttribute('aria-expanded', 'false');
}

/**
 * Renders autocomplete city suggestions with keyboard selection highlighting.
 * @param {Record<string, any>} state
 * @param {Array<Record<string, any>>} items
 * @param {(loc: Record<string, any>) => void} onChoose
 * @param {string | null} [emptyMessage=null]
 * @returns {void}
 */
export function renderSuggestions(state, items, onChoose, emptyMessage = null) {
  const list = document.getElementById('search-suggestions');
  const input = document.getElementById('city-search-input');
  clearNode(list);

  if (!items.length) {
    if (!emptyMessage) { closeSuggestions(state); return; }
    list.appendChild(createSafeElement(document, 'li', { className: 'muted-text', attrs: { role: 'option', 'aria-disabled': 'true' }, text: emptyMessage }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    return;
  }

  items.forEach((loc, idx) => {
    const selected = idx === state.highlightedSuggestion;
    const btn = createSafeElement(document, 'button', {
      className: `suggestion-item${selected ? ' is-highlighted' : ''}`,
      attrs: { type: 'button', role: 'option', 'aria-selected': String(selected) },
      children: [createSafeElement(document, 'strong', { text: loc.name }), createSafeElement(document, 'span', { className: 'muted-text', text: loc.region })]
    });
    btn.addEventListener('click', () => onChoose(loc));
    list.appendChild(createSafeElement(document, 'li', { children: [btn] }));
  });

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}