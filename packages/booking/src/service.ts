/**
 * BookingService — the only writer of booking state.
 *
 * Everything that changes a booking goes through `transition()`, which in one transaction:
 *   1. locks the request row (`FOR UPDATE`) so two workers cannot race,
 *   2. validates the transition against the state machine,
 *   3. writes the new status,
 *   4. appends the `booking_transitions` and `booking_timeline_events` rows (both append-only),
 *   5. checks the invariants before committing.
 *
 * Duplicate-booking protection lives here too: `assertNoLiveReservation()` is the database half of
 * the Redis lock (TM-11).
 */
import { AppError, BOOKING_STATES, conflict, notFound, uuid, type BookingState } from '@raja/shared';
import type { DbClient } from '@raja/database';
import { assertInvariants, assertTransition, sideEffectsFor } from './state-machine';

export interface BookingRequestInput {
  tenantId: string;
  userId: string;
  providerCode: string;
  originCode: string;
  destinationCode: string;
  departureDate: string;
  departureDateEnd?: string | null;
  returnEnabled?: boolean;
  returnDate?: string | null;
  returnDateEnd?: string | null;
  passengerCount: number;
  coachClass?: string;
  seatPreference?: string;
  maxPriceMinor?: number | null;
  currency?: string;
  minAvailability?: number;
  priority?: number;
  automationMode?: string;
  matchingMode?: string;
  monitoringStrategy?: string;
  providerAccountId?: string | null;
  idempotencyKey?: string | null;
  preferredDepartureFrom?: string | null;
  preferredDepartureTo?: string | null;
  trainPreference?: Record<string, unknown>;
}

export interface CreatedRequest {
  id: string;
  status: BookingState;
  replayed: boolean;
}

export interface TransitionOptions {
  actorType?: 'SYSTEM' | 'USER' | 'ADMIN' | 'PROVIDER';
  actorId?: string | null;
  reason?: string;
  correlationId?: string;
  messageParams?: Record<string, unknown>;
}

const LIVE_RESERVATION_STATES = ['PENDING', 'HOLD', 'RESERVED', 'BOOKED'] as const;

/** Agents: terminal-by-success vs terminal-by-other for the auto-cancel rule. */
const ACTIVE_REQUEST_STATES: BookingState[] = [
  'CREATED',
  'VALIDATING',
  'SCHEDULED',
  'QUEUED',
  'SEARCHING',
  'WAITING',
  'AVAILABLE',
  'LOCKED',
  'RESERVING',
  'HUMAN_VERIFICATION_REQUIRED',
  'PASSENGER_FORM',
  'READY_FOR_CHECKOUT',
  'AWAITING_USER_APPROVAL',
  'RESERVED',
];

export class BookingService {
  constructor(
    private readonly db: DbClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createRequest(input: BookingRequestInput): Promise<CreatedRequest> {
    if (input.idempotencyKey) {
      const existing = await this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM booking_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (existing[0]) {
        return { id: existing[0].id, status: existing[0].status as BookingState, replayed: true };
      }
    }

    const id = uuid();
    const rows = await this.db.query<{ id: string; status: string }>(
      `INSERT INTO booking_requests
         (id, tenant_id, user_id, status, provider_code, origin_code, destination_code, departure_date,
          departure_date_end, return_enabled, return_date, return_date_end, passenger_count, coach_class,
          seat_preference, max_price_minor, currency, min_availability, priority, automation_mode,
          matching_mode, monitoring_strategy, provider_account_id, idempotency_key,
          preferred_departure_from, preferred_departure_to, train_preference)
       VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING id, status`,
      [
        id,
        input.tenantId,
        input.userId,
        input.providerCode,
        input.originCode,
        input.destinationCode,
        input.departureDate,
        input.departureDateEnd ?? null,
        input.returnEnabled ?? false,
        input.returnDate ?? null,
        input.returnDateEnd ?? null,
        input.passengerCount,
        input.coachClass ?? 'ANY',
        input.seatPreference ?? 'ANY',
        input.maxPriceMinor ?? null,
        input.currency ?? 'IRR',
        input.minAvailability ?? input.passengerCount,
        input.priority ?? 3,
        input.automationMode ?? 'MONITOR_ONLY',
        input.matchingMode ?? 'FLEXIBLE',
        input.monitoringStrategy ?? 'JITTERED',
        input.providerAccountId ?? null,
        input.idempotencyKey ?? null,
        input.preferredDepartureFrom ?? null,
        input.preferredDepartureTo ?? null,
        JSON.stringify(input.trainPreference ?? {}),
      ],
    );

    await this.appendTimeline(id, input.tenantId, null, 'CREATED', {
      phase: 'REQUEST',
      eventType: 'request_created',
      messageKey: 'booking.timeline.request_created',
      correlationId: '',
    });

    return { id, status: 'CREATED', replayed: false };
  }

  /**
   * Move a request to a new state. Returns the new state; throws on an illegal transition or a
   * broken invariant (the transaction rolls back, so a failed transition leaves no trace).
   */
  async transition(
    requestId: string,
    tenantId: string,
    to: BookingState,
    options: TransitionOptions = {},
  ): Promise<BookingState> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM booking_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, requestId],
      );
      const request = rows[0];
      if (!request) throw notFound('booking request', requestId);

      const from = request.status as BookingState;
      assertTransition(from, to);

      // Terminal bookkeeping is written by the same statement as the status: a CANCELLED row must
      // never exist without its cancellation timestamp and reason, and no caller has to remember.
      await tx.query(
        `UPDATE booking_requests SET status = $3, updated_at = now(),
           completed_at = CASE WHEN $3 IN ('BOOKED','FAILED','EXPIRED','CANCELLED') THEN now() ELSE completed_at END,
           canceled_at  = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE canceled_at END,
           cancel_reason = CASE WHEN $3 = 'CANCELLED' THEN COALESCE(NULLIF($4, ''), cancel_reason, '') ELSE cancel_reason END
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId, to, options.reason ?? ''],
      );

      await tx.query(
        `INSERT INTO booking_transitions
           (tenant_id, booking_request_id, from_state, to_state, reason, actor_type, actor_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          requestId,
          from,
          to,
          options.reason ?? '',
          options.actorType ?? 'SYSTEM',
          options.actorId ?? null,
          options.correlationId ?? '',
        ],
      );

      await tx.query(
        `INSERT INTO booking_timeline_events
           (tenant_id, booking_request_id, phase, event_type, message_key, message_params, actor_type, actor_id,
            state_from, state_to, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenantId,
          requestId,
          to === 'BOOKED' ? 'COMPLETE' : 'STATE',
          `state.${to.toLowerCase()}`,
          `booking.timeline.state.${to.toLowerCase()}`,
          JSON.stringify({ ...(options.messageParams ?? {}), sideEffects: sideEffectsFor(from, to) }),
          options.actorType ?? 'SYSTEM',
          options.actorId ?? null,
          from,
          to,
          options.correlationId ?? '',
        ],
      );

      const liveReservations = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM reservations
          WHERE tenant_id = $1 AND booking_request_id = $2 AND status = ANY($3::text[])`,
        [tenantId, requestId, [...LIVE_RESERVATION_STATES]],
      );
      assertInvariants(to, { liveReservationCount: Number(liveReservations[0]?.count ?? 0) });

      return to;
    });
  }

  /** Duplicate-booking protection, layer 4 (TM-11): never two live reservations for one request. */
  async findLiveReservation(requestId: string, tenantId: string): Promise<{ id: string; status: string } | null> {
    const rows = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM reservations
        WHERE tenant_id = $1 AND booking_request_id = $2 AND status = ANY($3::text[])
        LIMIT 1`,
      [tenantId, requestId, [...LIVE_RESERVATION_STATES]],
    );
    return rows[0] ?? null;
  }

  async assertNoLiveReservation(requestId: string, tenantId: string): Promise<void> {
    const live = await this.findLiveReservation(requestId, tenantId);
    if (live) {
      throw conflict('this booking request already has a live reservation', {
        bookingRequestId: requestId,
        reservationId: live.id,
        reservationStatus: live.status,
      });
    }
  }

  async addMonitor(input: {
    tenantId: string;
    bookingRequestId: string;
    leg: 'OUTBOUND' | 'RETURN';
    travelDate: string;
    priority?: number;
    strategy?: string;
    intervalSeconds: number;
    nextSearchAt: Date;
  }): Promise<string> {
    const id = uuid();
    await this.db.query(
      `INSERT INTO booking_monitors
         (id, tenant_id, booking_request_id, leg, travel_date, priority, strategy, interval_seconds, next_search_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (booking_request_id, leg, travel_date) DO NOTHING`,
      [
        id,
        input.tenantId,
        input.bookingRequestId,
        input.leg,
        input.travelDate,
        input.priority ?? 3,
        input.strategy ?? 'JITTERED',
        input.intervalSeconds,
        input.nextSearchAt,
      ],
    );
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM booking_monitors WHERE booking_request_id = $1 AND leg = $2 AND travel_date = $3`,
      [input.bookingRequestId, input.leg, input.travelDate],
    );
    return rows[0]?.id ?? id;
  }

  /**
   * A successful booking auto-cancels the user's *lower-priority* monitoring requests on the same
   * journey (spec § 10). They are cancelled — never silently deleted — and each one gets a timeline
   * entry explaining why.
   */
  async cancelLowerPriorities(input: {
    tenantId: string;
    userId: string;
    winnerRequestId: string;
    winnerPriority: number;
    originCode: string;
    destinationCode: string;
  }): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `SELECT id FROM booking_requests
          WHERE tenant_id = $1 AND user_id = $2 AND id <> $3
            AND origin_code = $4 AND destination_code = $5
            AND priority > $6
            AND status = ANY($7::text[])
          FOR UPDATE`,
        [
          input.tenantId,
          input.userId,
          input.winnerRequestId,
          input.originCode,
          input.destinationCode,
          input.winnerPriority,
          ACTIVE_REQUEST_STATES,
        ],
      );

      const cancelled: string[] = [];
      for (const row of rows) {
        const current = await tx.query<{ status: string }>(
          'SELECT status FROM booking_requests WHERE id = $1',
          [row.id],
        );
        const from = current[0]?.status as BookingState | undefined;
        if (!from || !BOOKING_STATES.includes(from)) continue;
        // WAITING/QUEUED/SCHEDULED and friends all allow CANCELLED; the state machine is the judge.
        if (!['SCHEDULED', 'QUEUED', 'SEARCHING', 'WAITING', 'AVAILABLE', 'CREATED', 'VALIDATING'].includes(from)) {
          continue;
        }
        await tx.query(
          `UPDATE booking_requests SET status = 'CANCELLED', canceled_at = now(),
             cancel_reason = 'auto_cancelled_lower_priority', updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, row.id],
        );
        await tx.query(
          `INSERT INTO booking_transitions
             (tenant_id, booking_request_id, from_state, to_state, reason, actor_type, actor_id)
           VALUES ($1, $2, $3, 'CANCELLED', 'auto_cancelled_lower_priority', 'SYSTEM', NULL)`,
          [input.tenantId, row.id, from],
        );
        await tx.query(
          `INSERT INTO booking_timeline_events
             (tenant_id, booking_request_id, phase, event_type, message_key, message_params, state_from, state_to)
           VALUES ($1, $2, 'STATE', 'state.cancelled', 'booking.timeline.auto_cancelled', $3, $4, 'CANCELLED')`,
          [input.tenantId, row.id, JSON.stringify({ winnerRequestId: input.winnerRequestId }), from],
        );
        await tx.query(
          `UPDATE booking_monitors SET status = 'CANCELED', updated_at = now()
            WHERE tenant_id = $1 AND booking_request_id = $2 AND status = 'ACTIVE'`,
          [input.tenantId, row.id],
        );
        cancelled.push(row.id);
      }
      return cancelled;
    });
  }

  async selectResult(input: {
    tenantId: string;
    bookingRequestId: string;
    resultId: string;
  }): Promise<void> {
    // The partial unique index `booking_results_selected_uq` makes this atomic: a second selection
    // fails instead of silently producing two "chosen" offers.
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE booking_results SET is_selected = false
          WHERE tenant_id = $1 AND booking_request_id = $2 AND is_selected = true`,
        [input.tenantId, input.bookingRequestId],
      );
      const rows = await tx.query<{ id: string }>(
        `UPDATE booking_results SET is_selected = true
          WHERE tenant_id = $1 AND booking_request_id = $2 AND id = $3 RETURNING id`,
        [input.tenantId, input.bookingRequestId, input.resultId],
      );
      if (rows.length === 0) throw notFound('booking result', input.resultId);
    });
  }

  async timeline(tenantId: string, bookingRequestId: string): Promise<Array<Record<string, unknown>>> {
    return this.db.query(
      `SELECT at, phase, event_type, message_key, message_params, state_from, state_to, actor_type
         FROM booking_timeline_events
        WHERE tenant_id = $1 AND booking_request_id = $2
        ORDER BY at ASC, id ASC`,
      [tenantId, bookingRequestId],
    );
  }

  /** Guard used by the API before any write: the request must belong to the calling tenant. */
  async mustExist(tenantId: string, bookingRequestId: string): Promise<{ id: string; status: BookingState }> {
    const rows = await this.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM booking_requests WHERE tenant_id = $1 AND id = $2',
      [tenantId, bookingRequestId],
    );
    const row = rows[0];
    if (!row) throw notFound('booking request', bookingRequestId);
    return { id: row.id, status: row.status as BookingState };
  }

  private async appendTimeline(
    requestId: string,
    tenantId: string,
    from: BookingState | null,
    to: BookingState,
    event: { phase: string; eventType: string; messageKey: string; correlationId: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO booking_timeline_events
         (tenant_id, booking_request_id, phase, event_type, message_key, state_from, state_to, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, requestId, event.phase, event.eventType, event.messageKey, from, to, event.correlationId],
    );
  }
}

export function assertBookingStateConsistency(state: string): BookingState {
  if (!BOOKING_STATES.includes(state as BookingState)) {
    throw new AppError('INTERNAL_ERROR', `unknown booking state in database: ${state}`, {
      userMessageKey: 'error.internal',
    });
  }
  return state as BookingState;
}

export { ACTIVE_REQUEST_STATES, LIVE_RESERVATION_STATES };
