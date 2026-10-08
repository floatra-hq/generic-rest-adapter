import { JSONPath } from 'jsonpath-plus';

// CVE-2024-21506: jsonpath-plus <10 allowed JSONPath script-block filters
// (`?(...)`) to execute arbitrary code in the host process. v10+ disables
// `eval` by default; we also pass it explicitly here and reject the
// script-block characters from the path string before evaluation. The
// path string in a field-mapping config is operator-supplied, but a
// compromised or malformed config should not be able to escalate to RCE
// in the adapter process.
const DISALLOWED_PATH_CHARS = /[();={}<>!&|]/;

/**
 * Extract the first match for a JSONPath against a payload. Returns
 * `undefined` if the path doesn't match anything or contains characters
 * outside the safe alphabet.
 */
export function extractFirst(path: string, payload: unknown): unknown {
  if (!path || !path.startsWith('$')) return undefined;
  if (DISALLOWED_PATH_CHARS.test(path.slice(1))) return undefined;
  try {
    const matches = JSONPath({
      path,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: payload as any,
      wrap: true,
      eval: false,
    });
    if (!Array.isArray(matches) || matches.length === 0) return undefined;
    return matches[0];
  } catch {
    return undefined;
  }
}
