import qrcode from 'qrcode-generator';

/**
 * Encodes `text` as a QR code and returns it as a data-SVG URL, ready for an
 * `<img>`. Local generation — nothing to fetch, and the payload (the
 * verification URI with the user code prefilled) never leaves the device.
 *
 * The watch's vendored encoder draws the same thing: black modules on a white
 * background (the lib's SVG carries the white rect), no smoothing. `type 0`
 * picks the smallest matrix that fits; error-correction level M is the usual
 * on-screen choice, and the SVG keeps it crisp at any CSS size.
 */
export function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag(5, 2);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
