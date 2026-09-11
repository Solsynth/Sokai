const DEFAULT_TIMEOUT_MS = 10000;

/**
 * `systemXHR` (see manifest.webapp) only applies to `XMLHttpRequest` objects
 * created with `mozSystem: true`. `fetch()` has no equivalent, which is why
 * every remote call in this app goes through here — the privilege is what lets
 * a privileged app talk to servers that send no CORS headers.
 */
function createSystemXHR() {
  try {
    return new XMLHttpRequest({ mozSystem: true });
  } catch (error) {
    // Hosts without the privilege (or without Gecko) reject the options object.
    // The request still goes out; it just falls back to normal CORS rules.
    return new XMLHttpRequest();
  }
}

/**
 * @param {string} url
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<unknown>} parsed JSON body
 */
export function requestJSON(url, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = createSystemXHR();

    xhr.open('GET', url, true);
    xhr.responseType = 'json';
    xhr.timeout = timeout;

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        reject(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Timeout'));

    xhr.send();
  });
}
