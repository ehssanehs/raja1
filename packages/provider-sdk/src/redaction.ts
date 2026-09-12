/**
 * Redaction of provider payloads before they are logged or stored as diagnostics (TM-06, TM-07).
 *
 * Provider pages contain cookies, CSRF tokens, captcha payloads and passenger PII. None of it may
 * reach logs, metrics labels, error reports or the diagnostics bucket. Adapters call these helpers
 * before emitting anything outward.
 */
import { truncate } from '@raja/shared';

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]'],
  // Bearer/basic credentials first: "Authorization=Bearer abc.def" must lose the whole value.
  [/(?:\bBearer\b|\bBasic\b)\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/(?:password|passwd|pwd|token|csrf|xsrf|session|authorization|cookie)\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[redacted]'],
  [/\b(?:\d[ -]?){15,16}\b/g, '[card]'],
  [/\b\d{10}\b/g, '[national-id]'],
  [/\b(?:\+?98|0098|0)?9\d{9}\b/g, '[mobile]'],
];

/** Scrub free text (provider error strings, HTML fragments) of secrets and identifiers. */
export function redactProviderText(input: string, maxLength = 500): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return truncate(output.replace(/\s+/g, ' ').trim(), maxLength);
}

/**
 * Keep only the origin and path of a provider URL: query strings carry session ids, tokens and
 * tracking parameters that must not be persisted.
 */
export function scrubProviderUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/** Redact an arbitrary JSON-ish payload (provider request/response snapshots). */
export function redactProviderPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactProviderText(value, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactProviderPayload(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/cookie|token|password|secret|authorization|otp|captcha|national|passport|card/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = redactProviderPayload(item, depth + 1);
      }
    }
    return output;
  }
  return '[unsupported]';
}

/** HTML snapshot safety: strip inline scripts, form values and inputs before storing. */
export function redactHtmlSnapshot(html: string, maxLength = 50_000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '<!-- script removed -->')
    .replace(/<input[^>]*value="[^"]*"[^>]*>/gi, '<input value="[redacted]">')
    .replace(/<input[^>]*value='[^']*'[^>]*>/gi, '<input value="[redacted]">')
    .replace(/value\s*=\s*"[^"]{8,}"/gi, 'value="[redacted]"')
    .slice(0, maxLength);
}
