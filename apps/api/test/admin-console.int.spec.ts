/**
 * Integration test: the admin console page is served (outside the bearer guard, static HTML,
 * no secrets embedded) while every data route stays guarded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig, resetConfigCache } from '@raja/config';
import { startAdminApi } from '../src/index';

describe('admin console page', () => {
  let api: Awaited<ReturnType<typeof startAdminApi>>;
  let base: string;
  const token = 'console-test-token';

  beforeAll(async () => {
    process.env['MASTER_KEYS'] = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    resetConfigCache();
    getConfig();
    api = await startAdminApi({ adminToken: token, port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${api.port}`;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    resetConfigCache();
  });

  it('serves the RTL admin console with no secrets embedded', async () => {
    const response = await fetch(`${base}/admin`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('استخر پروکسی خروجی');
    expect(html).toContain('/api/v1/admin/proxies');
    // The page ships no credentials and no default token baked into markup.
    expect(html).not.toContain(token);
    expect(html).not.toContain('Bearer dev');
  });

  it('keeps the data routes bearer-guarded (console cannot bypass auth)', async () => {
    const unauthenticated = await fetch(`${base}/api/v1/admin/proxies/pool`);
    expect(unauthenticated.status).toBe(401);
    const wrongToken = await fetch(`${base}/api/v1/admin/proxies/pool`, { headers: { authorization: 'Bearer nope' } });
    expect(wrongToken.status).toBe(401);
  });
});
