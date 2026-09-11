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

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 1 in the API's `content_type` enum. */
const CONTENT_TYPE_HTML = 1;

const IMG_TAG = /<\/?img\b[^>]*>/g;
const ANCHOR_OPEN = /<a\b[^>]*>/g;
const ANCHOR_CLOSE = /<\/a>/g;

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_MARKERS = /[#*_`~]/g;
const MARKDOWN_RULE = /^\s*[-*_]{3,}\s*$/gm;
const HTML_TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;
const TRAILING_WHITESPACE = /\s+$/;

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
 * send them, so neither may look or behave like a control.
 */
function neutralize(html) {
  return html
    .replace(IMG_TAG, '<span class="kai-md__image">[image]</span>')
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
 * collapsed, clipped at a character budget.
 *
 * Character clipping is deliberate — `-webkit-line-clamp` needs
 * `display: -webkit-box`, which Gecko 48 does not have.
 *
 * @param {object} post normalised post
 * @param {number} [limit]
 * @returns {string}
 */
export function excerpt(post, limit = 150) {
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

  if (text.length > limit) text = text.slice(0, limit).replace(TRAILING_WHITESPACE, '') + '…';

  return text;
}
