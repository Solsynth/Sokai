/**
 * Markdown rendering for post bodies.
 *
 * `markdown-it` rather than a hand-rolled renderer: posts are user content, and
 * getting the escaping wrong is the one bug class that turns a text field into a
 * script injection. `html: false` is what keeps raw HTML inside a post from ever
 * reaching the DOM — markdown-it escapes it, so it renders as visible text.
 *
 * Two outputs, matching how the Flutter client reads the same API:
 *  - a feed row gets `excerpt`, pre-rendered text clipped to a character budget;
 *  - the detail screen gets `bodyHtml`, the full markdown.
 */

import MarkdownIt from 'markdown-it';

import { fileUrl } from '../api/solian.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 1 in the API's `content_type` enum. */
const CONTENT_TYPE_HTML = 1;

/* Images that point at a Solar Network file (`![alt](solian://files/<id>)` — the
   form the clients insert inline) are the one kind this app can actually show.
   Everything else in an image slot is replaced by a marker below. */
const BODY_FILE_PREFIX = 'solian://files/';
const BODY_FILE_ID = /^[A-Za-z0-9_-]+$/;

const IMG_TAG = /<img\b(?![^>]*class="kai-md__photo")[^>]*>/g;
const ANCHOR_OPEN = /<a\b[^>]*>/g;
const ANCHOR_CLOSE = /<\/a>/g;

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_MARKERS = /[#*_`~]/g;
const MARKDOWN_RULE = /^\s*[-*_]{3,}\s*$/gm;
const HTML_TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;
const TRAILING_WHITESPACE = /\s+$/;

/**
 * @param {string} src
 * @returns {string} the file id, or `''` when the source is not a Solar file
 */
function bodyFileId(src) {
  if (src.slice(0, BODY_FILE_PREFIX.length) !== BODY_FILE_PREFIX) return '';

  const id = src.slice(BODY_FILE_PREFIX.length).replace(/[?#].*$/, '');
  return BODY_FILE_ID.test(id) ? id : '';
}

// markdown-it has already dropped the `src` of anything outside its scheme
// allowlist by the time a renderer rule runs, so `solian://` has to be admitted
// here — and only that scheme; every other image is meant to be discarded.
const defaultValidateLink = md.validateLink;
md.validateLink = (url) =>
  url.slice(0, BODY_FILE_PREFIX.length) === BODY_FILE_PREFIX ? true : defaultValidateLink(url);

const defaultImage = md.renderer.rules.image;

/**
 * Renders an inline file image as a real `<img>`, and leaves every other image
 * to `neutralize`: a body can point at any host on the internet, and a feature
 * phone has no way to show, open or leave one.
 */
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const id = bodyFileId(token.attrGet('src') || '');
  if (!id) return defaultImage(tokens, index, options, env, self);

  const src = md.utils.escapeHtml(fileUrl(id));
  const alt = md.utils.escapeHtml(token.content || '');
  return '<img class="kai-md__photo" src="' + src + '" alt="' + alt + '">';
};

/** Three lines at the 1.7rem body size on a 240px screen. */
const DEFAULT_EXCERPT_UNITS = 70;

/** Full-width ranges: CJK, Hangul, kana, and the full-width forms. */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {string} text
 * @param {number} budget width units
 * @returns {string} `text`, or a prefix of it ending in an ellipsis
 */
function clipToUnits(text, budget) {
  let units = 0;
  let index = 0;

  for (; index < text.length; index += 1) {
    const width = isWide(text.charCodeAt(index)) ? 2 : 1;
    if (units + width > budget) break;
    units += width;
  }

  if (index >= text.length) return text;
  // Never leave half of a surrogate pair behind.
  if (index > 0 && isHighSurrogate(text.charCodeAt(index - 1))) index -= 1;

  return text.slice(0, index).replace(TRAILING_WHITESPACE, '') + '…';
}

/** HTML bodies are flattened to text first; they are the other legal content type. */
function plainText(post) {
  if (post.contentType !== CONTENT_TYPE_HTML) return post.content || '';
  // Text extraction, not sanitising: nothing from this string is ever inserted
  // as markup — it is escaped by the markdown renderer that consumes it.
  return new DOMParser().parseFromString(post.content || '', 'text/html').body.textContent || '';
}

/**
 * Post-processes rendered markdown. These replacements run on markdown-it's
 * own output, where every byte of user text has already been escaped, so they
 * can only match markup the renderer itself emitted.
 *
 * Images and links both point off-device, and a feature phone has nowhere to
 * send them, so neither may look or behave like a control — except an inline
 * file image, which `renderImage` already turned into a `kai-md__photo` and this
 * leaves alone.
 */
function neutralize(html) {
  return html
    // An image that cannot be shown has no text to carry: it renders as
    // nothing, so the body stays pure content. (Solar file images render as
    // real `<img>`s and never reach this pass.)
    .replace(IMG_TAG, '')
    .replace(ANCHOR_OPEN, '<span class="kai-md__link">')
    .replace(ANCHOR_CLOSE, '</span>');
}

/**
 * @param {object} post normalised post
 * @returns {string} HTML for `v-html`
 */
export function bodyHtml(post) {
  const text = plainText(post);
  return neutralize(md.render(text));
}

/**
 * Feed-row text: markdown syntax stripped rather than rendered, whitespace
 * collapsed, clipped to a visual-width budget.
 *
 * The budget is in *width units*, not characters — a wide (CJK/full-width) glyph
 * costs two. Character clipping is length-agnostic, and on a 240px screen that
 * is the difference between three lines and ten: 150 characters of CJK fills
 * nine lines, 150 of Latin five. `-webkit-line-clamp` cannot help here — it needs
 * `display: -webkit-box`, which Gecko 48 does not have.
 *
 * @param {object} post normalised post
 * @param {number} [budget] width units to keep (a Latin glyph is 1, CJK is 2)
 * @returns {string}
 */
export function excerpt(post, budget = DEFAULT_EXCERPT_UNITS) {
  const isHtml = post.contentType === CONTENT_TYPE_HTML;
  let text = isHtml ? plainText(post) : post.content || '';

  if (isHtml) text = text.replace(HTML_TAG, ' ');
  text = text
    .replace(MARKDOWN_IMAGE, ' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(MARKDOWN_RULE, ' ')
    .replace(MARKDOWN_MARKERS, '')
    .replace(WHITESPACE, ' ')
    .trim();

  return clipToUnits(text, budget);
}
