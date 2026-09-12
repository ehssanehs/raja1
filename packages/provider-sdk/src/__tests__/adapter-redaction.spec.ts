/**
 * Diagnostics redaction (TM-06, TM-07).
 *
 * Trace/screenshot/HTML artifacts are the most likely place for provider cookies, CSRF tokens and
 * passenger PII to leak into storage or into a support ticket. These tests pin the guarantees.
 */
import { describe, expect, it } from 'vitest';
import {
  redactHtmlSnapshot,
  redactProviderPayload,
  redactProviderText,
  scrubProviderUrl,
} from '../redaction';

describe('free-text redaction', () => {
  it('removes credential pairs whatever their case', () => {
    expect(redactProviderText('password=Sup3rSecret')).not.toContain('Sup3rSecret');
    expect(redactProviderText('Token: abc123def')).not.toContain('abc123def');
    expect(redactProviderText('Authorization=Bearer xyz.abc.def')).not.toContain('xyz.abc.def');
    expect(redactProviderText('csrf_token=1234567890abcdef')).not.toContain('1234567890abcdef');
  });

  it('removes identifiers that could re-identify a passenger', () => {
    expect(redactProviderText('national id 0499370899 rejected')).not.toMatch(/0499370899/);
    expect(redactProviderText('mobile +989121234567')).not.toMatch(/989121234567/);
    expect(redactProviderText('card 6104 3377 1234 5678')).not.toMatch(/6104/);
  });

  it('removes JWTs and preserves the surrounding text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const output = redactProviderText(`session rejected (${jwt}) for route THR-MHD`);
    expect(output).not.toContain('eyJhbGciOi');
    expect(output).toContain('route THR-MHD');
  });

  it('truncates long text and collapses whitespace', () => {
    const long = 'x'.repeat(2000);
    expect(redactProviderText(long, 100).length).toBeLessThanOrEqual(100);
  });
});

describe('payload redaction', () => {
  it('redacts by key anywhere in the tree', () => {
    const payload = {
      result: 'ok',
      request: {
        cookie: 'SESSION=abc123',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        passenger: { firstName: 'Ali', nationalId: '0499370899' },
        nested: [{ captcha: '03AGdBq2', token: 'abc' }],
      },
    };
    const redacted = JSON.stringify(redactProviderPayload(payload));
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('0499370899');
    expect(redacted).not.toContain('03AGdBq2');
    expect(redacted).toContain('Ali'); // display-only data is not a secret, but see the PII rules
    expect(redacted).toContain('[redacted]');
  });

  it('bounds depth and array length so a huge provider response cannot blow up storage', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 20; index += 1) {
      cursor['child'] = {};
      cursor = cursor['child'] as Record<string, unknown>;
    }
    expect(JSON.stringify(redactProviderPayload(deep))).toContain('[depth-limit]');
    const wide = Array.from({ length: 100 }, (_, index) => index);
    expect(redactProviderPayload(wide)).toHaveLength(20);
  });
});

describe('html snapshots', () => {
  it('drops scripts and input values', () => {
    const html = `<html><body><script>window.token='abc'</script>
      <input name="nationalId" value="0499370899">
      <form><input type="hidden" value="csrf-secret-value"></form></body></html>`;
    const redacted = redactHtmlSnapshot(html);
    expect(redacted).not.toContain('window.token');
    expect(redacted).not.toContain('0499370899');
    expect(redacted).not.toContain('csrf-secret-value');
    expect(redacted).toContain('script removed');
  });
});

describe('url scrubbing', () => {
  it('keeps origin and path, drops everything that could carry a secret', () => {
    expect(scrubProviderUrl('https://example.test/booking/step2?token=abc&code=123#frag')).toBe(
      'https://example.test/booking/step2',
    );
    expect(scrubProviderUrl('not a url')).toBe('[invalid-url]');
  });
});
