/// <reference types="vite/client" />

/**
 * Build-time `define` values, replaced by Vite (see vite.config.js). Declared
 * so vue-tsc can type-check the modules that read them.
 */
declare const __APP_VERSION__: string;
declare const __KAIOS_TARGET__: string;

/**
 * The vendored QR encoder is CJS with no shipped types; this is the surface
 * the app uses (see `src/kaios/qrcode.ts`).
 */
declare module 'qrcode-generator' {
  interface QRCode {
    addData(data: string, mode?: string): void;
    make(): void;
    createSvgTag(cellSize?: number, margin?: number): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: string): QRCode;
  export default qrcode;
}
