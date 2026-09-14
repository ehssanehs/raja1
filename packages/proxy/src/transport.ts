/**
 * Proxy-aware HTTP transport built on undici.
 *
 * One `ProxyAgent` per proxy, created lazily and cached by proxy id. Callers pass an absolute
 * URL plus optional per-call timeout; the agent performs CONNECT tunneling for HTTPS targets.
 * HTTP basic-proxy auth is applied from the decrypted lease material (never logged, never stored).
 */
import { request, ProxyAgent, type Dispatcher } from 'undici';
import { ProxyProtocolUnsupportedError } from './errors';
import type { ResolvedProxy } from './types';

export interface ProxiedRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Wall-clock duration of the whole request (ms). */
  durationMs: number;
}

type ProxiedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

export class ProxiedHttpClient {
  private readonly agents = new Map<string, { agent: ProxyAgent; key: string }>();

  /**
   * Perform an HTTP request through the given proxy.
   * `targetUrl` must be absolute (http/https).
   */
  async request(resolved: ResolvedProxy, targetUrl: string, options: { method?: ProxiedMethod; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<ProxiedRequestResult> {
    if (resolved.protocol === 'SOCKS5') throw new ProxyProtocolUnsupportedError(resolved.protocol);
    const agent = this.agentFor(resolved);
    const started = Date.now();
    const response = await request(targetUrl, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      dispatcher: agent,
      headersTimeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      bodyTimeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRedirections: 0,
    });
    const text = await response.body.text();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    void response.body.destroy();
    return { status: response.statusCode, headers, body: text.slice(0, MAX_BODY_BYTES), durationMs: Date.now() - started };
  }

  /** A lightweight connectivity probe through the proxy (used by ProxyProber). */
  async probe(resolved: ResolvedProxy, targetUrl: string, timeoutMs = 8000): Promise<ProxiedRequestResult> {
    return this.request(resolved, targetUrl, { method: 'GET', timeoutMs });
  }

  /** Drop cached agents whose credentials/endpoints changed, and close idle sockets. */
  invalidate(proxyId: string): void {
    const entry = this.agents.get(proxyId);
    if (entry) {
      entry.agent.close().catch(() => undefined);
      this.agents.delete(proxyId);
    }
  }

  async close(): Promise<void> {
    for (const [id] of this.agents) this.invalidate(id);
  }

  private agentFor(resolved: ResolvedProxy): ProxyAgent {
    const key = `${resolved.protocol}://${resolved.host}:${resolved.port}:${resolved.username ?? ''}:${resolved.password ? 'set' : ''}`;
    const existing = this.agents.get(resolved.id);
    if (existing && existing.key === key) return existing.agent;
    if (existing) this.invalidate(resolved.id);
    const uri = `${resolved.protocol.toLowerCase()}://${resolved.host}:${resolved.port}`;
    const agent = new ProxyAgent({
      uri,
      token: resolved.username !== null ? `Basic ${Buffer.from(`${resolved.username}:${resolved.password ?? ''}`).toString('base64')}` : undefined,
      requestTls: { timeout: 10_000 },
    } as ConstructorParameters<typeof ProxyAgent>[0]);
    this.agents.set(resolved.id, { agent, key });
    return agent;
  }
}

/** Undici dispatcher type re-export for callers that need to pass agents around. */
export type { Dispatcher };
