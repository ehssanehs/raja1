/**
 * @raja/booking — the booking domain.
 *
 * Responsibilities: the state machine, matching/scoring, monitoring strategy maths, submission
 * guards and the single writer of booking state. It depends on `provider-sdk`, `queue`, `billing`,
 * `notifications`, `database`, `config` and `shared`.
 */
export * from './state-machine';
export * from './matching';
export * from './monitoring';
export * from './guards';
export * from './service';
