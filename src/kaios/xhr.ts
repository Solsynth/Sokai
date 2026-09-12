const DEFAULT_TIMEOUT_MS = 10000;

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface HttpError extends Error {
  status: number;
  code?: string;
  error?: string;
}

/**
 * `systemXHR` (see manifest.webapp) only applies to `XMLHttpRequest` objects
 * created with `mozSystem: true`. `fetch()` has no equivalent, which is why
 * every remote call in this app goes through here — the privilege is what lets
 * a privileged app talk to servers that send no CORS headers.
 */
function createSystemXHR(): XMLHttpRequest {
  // The options object is a Gecko extension; the DOM lib's constructor knows
  // nothing of it, so the constructor type is widened locally.
  const SystemXHR = XMLHttpRequest as unknown as {
    new (options?: Record<string, unknown>): XMLHttpRequest;
  };
  try {
    return new SystemXHR({ mozSystem: true });
  } catch (error) {
    // Hosts without the privilege (or without Gecko) reject the options object.
    // The request still goes out; it just falls back to normal CORS rules.
    return new XMLHttpRequest();
  }
}

/**
 * Response headers as a plain object with lowercased names.
 *
 * `getAllResponseHeaders()` is the FF48-safe accessor: reading a header that is
 * not CORS-safelisted (`x-total`, for instance) through `getResponseHeader()`
 * is the same API, but the whole map is what the API client needs and it avoids
 * one round of per-name allowlisting.
 */
function responseHeaders(xhr: XMLHttpRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = typeof xhr.getAllResponseHeaders === 'function' ? xhr.getAllResponseHeaders() : '';
  if (!raw) return headers;

  const lines = raw.split('\r\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  return headers;
}

/**
 * The API's error envelope is `{ code, message, ... }`; Stargate's auth
 * endpoints answer `{ error: 'authorization_pending' | ... }` while a device
 * flow is pending or terminal. Anything else that comes back with a failure
 * status is reported as a bare HTTP status.
 */
function httpError(xhr: XMLHttpRequest): HttpError {
  const error = new Error('HTTP ' + xhr.status) as HttpError;
  error.status = xhr.status;

  const detail = xhr.response;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    if (typeof detail.code === 'string') error.code = detail.code;
    if (typeof detail.message === 'string') error.message = detail.message;
    if (typeof detail.error === 'string') error.error = detail.error;
  }

  return error;
}

/**
 * One remote call. `body`, when a string, is sent verbatim (the device flow
 * posts form-encoded data, so the caller owns the `Content-Type`); any other
 * value is serialised as JSON. `User-Agent` is never set: browsers forbid it
 * and send the platform's own.
 */
export function request(
  url: string,
  { method = 'GET', headers = {}, body = null, timeout = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<ApiResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<ApiResponse>();
  const xhr = createSystemXHR();

  xhr.open(method, url, true);
    // The API answers JSON for every endpoint, including its errors.
    xhr.responseType = 'json';
    xhr.timeout = timeout;

    const outgoing: Record<string, string> = {};
    let hasContentType = false;
    const names = Object.keys(headers);

    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      outgoing[name] = headers[name];
    }
    // JSON is the default body type this app sends; callers should not have to
    // remember the header. FormData is sent as-is (the browser adds the
    // multipart boundary), and string bodies are pre-encoded and carry their
    // own Content-Type.
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== null && body !== undefined && typeof body !== 'string' && !isFormData && !hasContentType) {
      outgoing['Content-Type'] = 'application/json';
    }

    const outgoingNames = Object.keys(outgoing);
    for (let index = 0; index < outgoingNames.length; index += 1) {
      xhr.setRequestHeader(outgoingNames[index], outgoing[outgoingNames[index]]);
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ status: xhr.status, headers: responseHeaders(xhr), data: xhr.response });
      } else {
        reject(httpError(xhr));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Timeout'));

    xhr.send(
      body === null || body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : typeof FormData !== 'undefined' && body instanceof FormData
            ? body
            : JSON.stringify(body),
    );

  return promise;
}
