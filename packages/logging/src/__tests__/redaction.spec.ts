/**
 * TM-06 regression suite: no PII or secret may reach the log stream, even for payloads whose
 * shape we did not anticipate.
 */
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  configureRootLogger,
  createLogger,
  getLogContext,
  isSensitiveKey,
  loggerFor,
  redactSecretsInString,
  runWithLogContext,
  sanitize,
} from '../index';

interface Capture {
  logger: ReturnType<typeof createLogger>;
  lines: () => string[];
  text: () => string;
}

function capture(): Capture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  }) as unknown as pino.DestinationStream;
  const logger = pino({ level: 'trace', redact: { paths: ['password', 'accessToken', 'nationalId', '*.nationalId'], censor: '[REDACTED]' } }, stream);
  return {
    logger: logger as unknown as ReturnType<typeof createLogger>,
    lines: () => chunks.join('').split('\n').filter(Boolean),
    text: () => chunks.join(''),
  };
}

describe('log redaction', () => {
  it('detects sensitive key names in any casing or separator style', () => {
    for (const key of [
      'password',
      'passwordHash',
      'refreshToken',
      'Authorization',
      'national_id',
      'nationalId',
      'passportNumber',
      'cardNumber',
      'cookies',
      'storage_state',
      'storageState',
      'TELEGRAM_ID',
      'mobile',
      'phoneNumber',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    expect(isSensitiveKey('bookingId')).toBe(false);
    expect(isSensitiveKey('stationName')).toBe(false);
  });

  it('scrubs nested payloads by key pattern, regardless of shape', () => {
    const payload = {
      bookingId: 'bkr_1',
      passenger: {
        firstName: 'Sara',
        nationalId: '0499370899',
        passportNumber: 'X1234567',
        contact: { phone: '+989123456789', email: 'sara@example.com' },
      },
      nested: [{ refreshToken: 'abc.def.ghi' }],
    };
    const output = JSON.stringify(sanitize(payload));
    expect(output).toContain('bkr_1');
    expect(output).toContain('Sara');
    expect(output).not.toContain('0499370899');
    expect(output).not.toContain('X1234567');
    expect(output).not.toContain('+989123456789');
    expect(output).not.toContain('abc.def.ghi');
  });

  it('redacts secrets embedded in strings, URLs and JWTs', () => {
    expect(redactSecretsInString('Authorization: Bearer abc123def456')).not.toContain('abc123def456');
    expect(redactSecretsInString('https://x.test/cb?token=deadbeef&code=1234')).not.toContain('deadbeef');
    expect(redactSecretsInString('https://x.test/cb?token=deadbeef')).toContain('[REDACTED]');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    expect(redactSecretsInString(`token=${jwt}`)).not.toContain(jwt);
    expect(redactSecretsInString('card 4111111111111111')).toContain('[card:1111]');
  });

  it('limits depth so huge objects cannot be dumped', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    const output = JSON.stringify(sanitize(deep));
    expect(output).not.toContain('too deep');
    expect(output).toContain('[object]');
  });

  it('converts errors without exposing secret-bearing messages', () => {
    const error = new Error('provider call failed with token=supersecret');
    const sanitized = sanitize(error) as Record<string, unknown>;
    expect(sanitized['name']).toBe('Error');
    expect(String(sanitized['message'])).not.toContain('supersecret');
  });

  it('propagates correlation context to log lines', () => {
    const { logger, lines } = capture();
    runWithLogContext({ correlationId: 'cor_1', tenantId: 'tnt_1', userId: 'usr_1' }, () => {
      logger.info({ ...getLogContext(), event: 'booking.created' }, 'created');
    });
    const entry = JSON.parse(lines()[0]!) as Record<string, unknown>;
    expect(entry['correlationId']).toBe('cor_1');
    expect(entry['tenantId']).toBe('tnt_1');
    expect(entry['event']).toBe('booking.created');
  });

  it('applies pino redaction paths as a second line of defense', () => {
    const { logger, text } = capture();
    logger.info({ password: 'hunter2', accessToken: 'tok', nationalId: '1234567890' }, 'msg');
    expect(text()).not.toContain('hunter2');
    expect(text()).not.toContain('tok');
    expect(text()).toContain('[REDACTED]');
  });

  it('never leaks PII passed through loggerFor, even with unanticipated key names', () => {
    const { logger, text } = capture();
    configureRootLogger(logger);
    const log = loggerFor('booking-orchestrator');
    runWithLogContext({ correlationId: 'cor_2', tenantId: 'tnt_9' }, () => {
      log.info({ event: 'booking.passenger_submitted', passenger: { nationalId: '0499370899', phone: '+989120000000' } }, 'submitted');
    });
    log.error(new Error('failed for national id 0499370899'), 'boom');
    const output = text();
    expect(output).toContain('booking.passenger_submitted');
    expect(output).not.toContain('0499370899');
    expect(output).not.toContain('+989120000000');
    expect(output).toContain('cor_2');
  });

  it('supports child loggers with additional bindings', () => {
    const { logger, lines } = capture();
    configureRootLogger(logger);
    const child = loggerFor('worker').child({ queueName: 'availability' });
    child.info({ event: 'job.completed' }, 'done');
    const entry = JSON.parse(lines()[0]!) as Record<string, unknown>;
    expect(entry['queueName']).toBe('availability');
    expect(entry['module']).toBe('worker');
  });

  beforeEach(() => {
    // keep the root logger deterministic between tests
    configureRootLogger(createLogger({ level: 'silent' }));
  });
});
