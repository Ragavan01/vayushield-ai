/**
 * @fileoverview Security utilities, strict input validation, and zero-XSS DOM helpers.
 */

const DANGEROUS_PROTOCOL_RE = /^\s*(javascript|data|vbscript):/i;
const SAFE_TEXT_STRIP_RE = /[\u0000-\u001F\u007F<>]/g;

/**
 * Sanitizes free-form user text by trimming, removing control/angle-bracket characters,
 * and enforcing a strict maximum character budget.
 * @param {unknown} value
 * @param {number} [maxLength=240]
 * @returns {string}
 */
export function sanitizeText(value, maxLength = 240) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(SAFE_TEXT_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Clamps a numeric input within safe inclusive bounds.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

/**
 * Validates that a value belongs to an explicit allowlist.
 * @template T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export function validateEnum(value, allowed, fallback) {
  return allowed.includes(/** @type {T} */ (value))
    ? /** @type {T} */ (value)
    : fallback;
}

/**
 * Validates that a URL uses http/https and never a dangerous script protocol.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || DANGEROUS_PROTOCOL_RE.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validates basic format of an optional user-supplied Gemini API key without logging it.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isPlausibleApiKey(key) {
  if (typeof key !== 'string') {
    return false;
  }
  const trimmed = key.trim();
  return /^AIza[0-9A-Za-z_-]{20,60}$/.test(trimmed);
}

/**
 * Creates a DOM element safely using textContent and explicit attributes only (never innerHTML).
 * @param {Document} doc
 * @param {string} tag
 * @param {{ className?: string, text?: string, attrs?: Record<string, string>, children?: Array<Node | string | null | undefined> }} [options]
 * @returns {HTMLElement}
 */
export function createSafeElement(doc, tag, options = {}) {
  const el = doc.createElement(tag);

  if (options.className) {
    el.className = options.className;
  }
  if (options.text !== undefined) {
    el.textContent = String(options.text);
  }
  if (options.attrs) {
    for (const [key, val] of Object.entries(options.attrs)) {
      if (key.toLowerCase().startsWith('on')) {
        continue;
      }
      if ((key === 'href' || key === 'src') && DANGEROUS_PROTOCOL_RE.test(val)) {
        continue;
      }
      el.setAttribute(key, String(val));
    }
  }
  if (Array.isArray(options.children)) {
    for (const child of options.children) {
      if (child === null || child === undefined) {
        continue;
      }
      if (typeof child === 'string') {
        el.appendChild(doc.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }

  return el;
}

/**
 * Removes all child nodes from a container without touching innerHTML.
 * @param {Element | null} node
 */
export function clearNode(node) {
  if (!node) return;
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}