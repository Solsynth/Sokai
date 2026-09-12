import { decode } from 'blurhash';

/**
 * Renders a BlurHash as a data-URL PNG, for use as the placeholder behind a
 * picture that is still loading. The server answers with a `blurhash` string
 * on roughly one image attachment in ten, so most pictures just keep the plain
 * tinted box — this is the calm upgrade for the ones that have it.
 *
 * The hash is decoded at a fraction of the display size: a BlurHash is a soft
 * wash, and a 32×32 PNG upscales cleanly behind the loading image without the
 * cost of decoding (or storing) the full box. The caller stretches that single
 * decode over the box (`.kai-attachment__image` sets `background-size: cover`),
 * because a background image tiles by default. Gecko 48 has canvas 2D and
 * `toDataURL`, so a real `data:` URL comes out — the smoke gate stands a canvas
 * in for the one jsdom lacks — and where a host truly has none, the function
 * degrades to `''` and the reserved box keeps its plain tint. Decoded URLs are
 * cached per hash, so a feed page full of the same picture pays for the decode
 * once.
 */
const CACHE = new Map<string, string>();
const DECODE_SIZE = 32;

/**
 * @param hash a BlurHash string from the wire, or '' when the server has none
 * @returns a `data:image/png` URL, or '' when there is no hash, no canvas, or
 *   the hash will not decode
 */
export function placeholderDataUrl(hash: string): string {
  if (!hash) return '';
  if (CACHE.has(hash)) return CACHE.get(hash) as string;

  let dataUrl = '';
  try {
    const pixels = decode(hash, DECODE_SIZE, DECODE_SIZE);
    const canvas = document.createElement('canvas');
    canvas.width = DECODE_SIZE;
    canvas.height = DECODE_SIZE;
    const context = canvas.getContext('2d');
    if (context) {
      const image = context.createImageData(DECODE_SIZE, DECODE_SIZE);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      dataUrl = canvas.toDataURL('image/png');
    }
  } catch (error) {
    // A hash that will not decode, or a host without canvas: no placeholder.
    dataUrl = '';
  }

  CACHE.set(hash, dataUrl);
  return dataUrl;
}
