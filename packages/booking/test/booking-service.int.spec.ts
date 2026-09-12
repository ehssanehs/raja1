/**
 * Integration test: BookingService against real PostgreSQL (PGlite/WASM) with the real schema.
 *
 * These tests exercise the claims that only a database can prove:
 *  - every state change is recorded in `booking_transitions` + `booking_timeline_events`;
 *  - an illegal transition rolls back completely (no half-written state, no orphan history);
 *  - tenant isolation holds at the SQL level (another tenant's request is a NOT_FOUND, not a leak);
 *  - a booking request can never end up with two live reservations;
 *  - a successful booking cancels only the *lower-priority* requests of the same journey.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, PGliteClient, migrateUp, type DbClient } from '@raja/database';
import { BookingService } from '../src/service';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_A2 = '00000000-0000-4000-8000-0000000000a2';
const USER_B = '00000000-0000-4000-8000-0000000000b1';

let db: DbClient;
let booking: BookingService;

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    userId: USER_A,
    providerCode: 'mock',
    originCode: 'THR',
    destinationCode: 'MHD',
    departureDate: '2026-04-01',
    passengerCount: 2,
    maxPriceMinor: 3_000_000,
    idempotencyKey: `key-${randomUUID()}`,
    ...overrides,
  } as Parameters<BookingService['createRequest']>[0];
}

async function authCount(requestId: string): Promise<{ transitions: number; timeline: number }> {
  const transitions = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM booking_transitions WHERE booking_request_id = $1',
    [requestId],
  );
  const timeline = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM booking_timeline_events WHERE booking_request_id = $1',
    [requestId],
  );
  return { transitions: Number(transitions[0]!.count), timeline: Number(timeline[0]!.count) };
}

beforeAll(async () => {
  db = await PGliteClient.create();
  await migrateUp(db, MIGRATIONS);
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await db.query(
    `INSERT INTO users (id, tenant_id, email, role, status, full_name)
     VALUES ($1, $2, 'owner-a@example.test', 'USER', 'ACTIVE', 'Owner A'),
            ($3, $4, 'second-a@example.test', 'USER', 'ACTIVE', 'Second A'),
            ($5, $6, 'owner-b@example.test', 'USER', 'ACTIVE', 'Owner B')`,
    [USER_A, TENANT_A, USER_A2, TENANT_A, USER_B, TENANT_B],
  );
  booking = new BookingService(db);
});

afterAll(async () => {
  await db.close();
});

describe('createRequest', () => {
  it('creates the request in CREATED and records the first timeline event', async () => {
    const created = await booking.createRequest(requestInput());
    expect(created.status).toBe('CREATED');
    expect(created.replayed).toBe(false);

    const rows = await db.query<{ status: string; passenger_count: number; min_availability: number }>(
      'SELECT status, passenger_count, min_availability FROM booking_requests WHERE id = $1',
      [created.id],
    );
    expect(rows[0]).toMatchObject({ status: 'CREATED', passenger_count: 2, min_availability: 2 });

    const timeline = await booking.timeline(TENANT_A, created.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ event_type: 'request_created', state_to: 'CREATED' });
  });

  it('is idempotent: the same key returns the same request instead of creating a second one', async () => {
    const input = requestInput();
    const first = await booking.createRequest(input);
    const second = await booking.createRequest(input);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);

    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_requests WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    expect(count[0]!.count).toBe('1');
  });

  it('scopes idempotency keys per tenant (another tenant may use the same key)', async () => {
    const key = `shared-${randomUUID()}`;
    const mine = await booking.createRequest(requestInput({ idempotencyKey: key }));
    const theirs = await booking.createRequest(
      requestInput({ tenantId: TENANT_B, userId: USER_B, idempotencyKey: key }),
    );
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.replayed).toBe(false);
  });
});

describe('transition', () => {
  it('walks the happy path and appends history for every step', async () => {
    const { id } = await booking.createRequest(requestInput());
    await booking.transition(id, TENANT_A, 'VALIDATING', { reason: 'validator start', correlationId: 'corr-1' });
    await booking.transition(id, TENANT_A, 'SCHEDULED', { reason: 'monitors created', correlationId: 'corr-1' });
    await booking.transition(id, TENANT_A, 'QUEUED');
    await booking.transition(id, TENANT_A, 'SEARCHING');
    await booking.transition(id, TENANT_A, 'AVAILABLE', { reason: 'match found' });

    const status = await booking.mustExist(TENANT_A, id);
    expect(status.status).toBe('AVAILABLE');

    const history = await db.query<{ from_state: string; to_state: string; reason: string }>(
      'SELECT from_state, to_state, reason FROM booking_transitions WHERE booking_request_id = $1 ORDER BY id',
      [id],
    );
    expect(history.map((row) => `${row.from_state}->${row.to_state}`)).toEqual([
      'CREATED->VALIDATING',
      'VALIDATING->SCHEDULED',
      'SCHEDULED->QUEUED',
      'QUEUED->SEARCHING',
      'SEARCHING->AVAILABLE',
    ]);
    expect(history[0]!.reason).toBe('validator start');

    // 1 creation event + 1 event per transition.
    expect(await authCount(id)).toEqual({ transitions: 5, timeline: 6 });
  });

  it('rejects an illegal transition and leaves no trace behind (transaction rollback)', async () => {
    const { id } = await booking.createRequest(requestInput());
    const before = await authCount(id);

    await expect(booking.transition(id, TENANT_A, 'BOOKED')).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await booking.mustExist(TENANT_A, id)).status).toBe('CREATED');
    expect(await authCount(id)).toEqual(before);
  });

  it('refuses to touch another tenant’s request (NOT_FOUND, never FORBIDDEN-with-details)', async () => {
    const { id } = await booking.createRequest(requestInput());
    await expect(booking.transition(id, TENANT_B, 'VALIDATING')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(booking.mustExist(TENANT_B, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await booking.mustExist(TENANT_A, id)).status).toBe('CREATED');
  });

  it('stamps completed_at exactly once a terminal state is reached', async () => {
    const { id } = await booking.createRequest(requestInput());
    await booking.transition(id, TENANT_A, 'CANCELLED', { reason: 'user cancelled' });
    const rows = await db.query<{ completed_at: string | null; canceled_at: string | null; cancel_reason: string }>(
      'SELECT completed_at, canceled_at, cancel_reason FROM booking_requests WHERE id = $1',
      [id],
    );
    expect(rows[0]!.completed_at).not.toBeNull();
    // Cancel bookkeeping happens in the same statement as the transition — never a bare status flip.
    expect(rows[0]!.canceled_at).not.toBeNull();
    expect(rows[0]!.cancel_reason).toBe('user cancelled');

    // A terminal request refuses further movement.
    await expect(booking.transition(id, TENANT_A, 'SEARCHING')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('duplicate-booking protection', () => {
  it('detects a live reservation and refuses a second one at the database level', async () => {
    const { id } = await booking.createRequest(requestInput());
    expect(await booking.findLiveReservation(id, TENANT_A)).toBeNull();
    await expect(booking.assertNoLiveReservation(id, TENANT_A)).resolves.toBeUndefined();

    await db.query(
      `INSERT INTO reservations (id, tenant_id, booking_request_id, provider_code, status, currency)
       VALUES ($1, $2, $3, 'mock', 'HOLD', 'IRR')`,
      [randomUUID(), TENANT_A, id],
    );

    await expect(booking.assertNoLiveReservation(id, TENANT_A)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await booking.findLiveReservation(id, TENANT_A)).not.toBeNull();

    // The partial unique index is the last line of defence: even a buggy caller cannot insert two.
    await expect(
      db.query(
        `INSERT INTO reservations (id, tenant_id, booking_request_id, provider_code, status, currency)
         VALUES ($1, $2, $3, 'mock', 'RESERVED', 'IRR')`,
        [randomUUID(), TENANT_A, id],
      ),
    ).rejects.toThrow();

    // A released reservation frees the slot again.
    await db.query(`UPDATE reservations SET status = 'EXPIRED' WHERE booking_request_id = $1`, [id]);
    await expect(booking.assertNoLiveReservation(id, TENANT_A)).resolves.toBeUndefined();
  });
});

describe('monitors', () => {
  it('creates one monitor per leg and date and is idempotent on the same triple', async () => {
    const { id } = await booking.createRequest(requestInput());
    const nextSearchAt = new Date('2026-03-01T08:00:00.000Z');
    const first = await booking.addMonitor({
      tenantId: TENANT_A,
      bookingRequestId: id,
      leg: 'OUTBOUND',
      travelDate: '2026-04-01',
      intervalSeconds: 60,
      nextSearchAt,
    });
    const again = await booking.addMonitor({
      tenantId: TENANT_A,
      bookingRequestId: id,
      leg: 'OUTBOUND',
      travelDate: '2026-04-01',
      intervalSeconds: 90,
      nextSearchAt,
    });
    expect(again).toBe(first);

    const returnLeg = await booking.addMonitor({
      tenantId: TENANT_A,
      bookingRequestId: id,
      leg: 'RETURN',
      travelDate: '2026-04-05',
      intervalSeconds: 60,
      nextSearchAt,
    });
    expect(returnLeg).not.toBe(first);

    const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM booking_monitors WHERE booking_request_id = $1', [
      id,
    ]);
    expect(rows[0]!.count).toBe('2');
  });

  it('refuses a monitor interval below the global minimum (schema-level protection)', async () => {
    const { id } = await booking.createRequest(requestInput());
    await expect(
      booking.addMonitor({
        tenantId: TENANT_A,
        bookingRequestId: id,
        leg: 'OUTBOUND',
        travelDate: '2026-04-02',
        intervalSeconds: 5,
        nextSearchAt: new Date(),
      }),
    ).rejects.toThrow(/interval_seconds|check/i);
  });
});

describe('selectResult', () => {
  async function addResult(requestId: string, fingerprint: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO booking_results
         (id, tenant_id, booking_request_id, provider_code, departure_at, availability_fingerprint, score, currency)
       VALUES ($1, $2, $3, 'mock', '2026-04-01T05:00:00.000Z', $4, 80, 'IRR')`,
      [id, TENANT_A, requestId, fingerprint],
    );
    return id;
  }

  it('keeps exactly one selected result per request', async () => {
    const { id } = await booking.createRequest(requestInput());
    const first = await addResult(id, `fp-${randomUUID()}`);
    const second = await addResult(id, `fp-${randomUUID()}`);

    await booking.selectResult({ tenantId: TENANT_A, bookingRequestId: id, resultId: first });
    await booking.selectResult({ tenantId: TENANT_A, bookingRequestId: id, resultId: second });

    const selected = await db.query<{ id: string }>(
      'SELECT id FROM booking_results WHERE booking_request_id = $1 AND is_selected = true',
      [id],
    );
    expect(selected.map((row) => row.id)).toEqual([second]);
  });

  it('cannot select another tenant’s result', async () => {
    const { id } = await booking.createRequest(requestInput());
    const resultId = await addResult(id, `fp-${randomUUID()}`);
    await expect(
      booking.selectResult({ tenantId: TENANT_B, bookingRequestId: id, resultId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const selected = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_results WHERE booking_request_id = $1 AND is_selected = true',
      [id],
    );
    expect(selected[0]!.count).toBe('0');
  });
});

describe('tenant integrity enforced by the schema (migration 0005)', () => {
  it('cannot attach a result of one tenant to another tenant\u2019s request', async () => {
    const { id } = await booking.createRequest(requestInput());
    await expect(
      db.query(
        `INSERT INTO booking_results
           (id, tenant_id, booking_request_id, provider_code, departure_at, availability_fingerprint)
         VALUES ($1, $2, $3, 'mock', '2026-04-01T05:00:00.000Z', $4)`,
        [randomUUID(), TENANT_B, id, `fp-${randomUUID()}`],
      ),
    ).rejects.toThrow(/foreign key|tenant/i);
  });

  it('cannot attach a monitor of one tenant to another tenant\u2019s request', async () => {
    const { id } = await booking.createRequest(requestInput());
    await expect(
      db.query(
        `INSERT INTO booking_monitors (id, tenant_id, booking_request_id, leg, travel_date, interval_seconds)
         VALUES ($1, $2, $3, 'OUTBOUND', '2026-04-01', 60)`,
        [randomUUID(), TENANT_B, id],
      ),
    ).rejects.toThrow(/foreign key|tenant/i);
  });
});

describe('cancelLowerPriorities', () => {
  it('cancels only strictly lower-priority active requests on the same journey', async () => {
    // A journey code unique to this test keeps the assertion exact even though the suite shares one
    // database (the auto-cancel query is deliberately journey-wide, not id-wide).
    const journey = `MHD-${randomUUID().slice(0, 8)}`;
    const winner = await booking.createRequest(requestInput({ priority: 1, destinationCode: journey }));
    const lower = await booking.createRequest(requestInput({ priority: 4, destinationCode: journey }));
    // Same journey, lower priority — but a different user. The auto-cancel must never reach across
    // users, let alone tenants.
    const otherUser = await booking.createRequest(
      requestInput({ userId: USER_A2, priority: 5, destinationCode: journey }),
    );
    const samePriority = await booking.createRequest(requestInput({ priority: 1, destinationCode: journey }));
    const otherJourney = await booking.createRequest(requestInput({ priority: 5, destinationCode: 'SHZ' }));
    const otherTenant = await booking.createRequest(
      requestInput({ tenantId: TENANT_B, userId: USER_B, priority: 5, destinationCode: journey }),
    );

    // Two of them are already searching, one is still waiting for the scheduler.
    await booking.transition(lower.id, TENANT_A, 'VALIDATING');
    await booking.transition(lower.id, TENANT_A, 'SCHEDULED');
    await booking.transition(otherJourney.id, TENANT_A, 'VALIDATING');

    await booking.addMonitor({
      tenantId: TENANT_A,
      bookingRequestId: lower.id,
      leg: 'OUTBOUND',
      travelDate: '2026-04-01',
      intervalSeconds: 60,
      nextSearchAt: new Date(),
    });

    const cancelled = await booking.cancelLowerPriorities({
      tenantId: TENANT_A,
      userId: USER_A,
      winnerRequestId: winner.id,
      winnerPriority: 1,
      originCode: 'THR',
      destinationCode: journey,
    });

    expect(cancelled).toEqual([lower.id]);
    expect((await booking.mustExist(TENANT_A, lower.id)).status).toBe('CANCELLED');
    expect((await booking.mustExist(TENANT_A, otherUser.id)).status).toBe('CREATED');
    expect((await booking.mustExist(TENANT_A, samePriority.id)).status).toBe('CREATED');
    expect((await booking.mustExist(TENANT_A, otherJourney.id)).status).toBe('VALIDATING');
    expect((await booking.mustExist(TENANT_B, otherTenant.id)).status).toBe('CREATED');
    expect((await booking.mustExist(TENANT_A, winner.id)).status).toBe('CREATED');

    const reason = await db.query<{ cancel_reason: string }>(
      'SELECT cancel_reason FROM booking_requests WHERE id = $1',
      [lower.id],
    );
    expect(reason[0]!.cancel_reason).toBe('auto_cancelled_lower_priority');

    const monitors = await db.query<{ status: string }>('SELECT status FROM booking_monitors WHERE booking_request_id = $1', [
      lower.id,
    ]);
    expect(monitors.every((row) => row.status === 'CANCELED')).toBe(true);
  });

  it('is a no-op when nothing is lower priority', async () => {
    const winner = await booking.createRequest(requestInput({ priority: 3 }));
    const cancelled = await booking.cancelLowerPriorities({
      tenantId: TENANT_A,
      userId: USER_A,
      winnerRequestId: winner.id,
      winnerPriority: 3,
      originCode: 'THR',
      destinationCode: 'MHD',
    });
    expect(cancelled).toEqual([]);
  });
});
