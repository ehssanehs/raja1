/**
 * Pure validation helpers shared by API, bot and web.
 * These are *shape* validators; anything security-sensitive (authorization, entitlement,
 * compliance) is enforced server-side in the domain services.
 */

/** Iranian national id (کد ملی) check-digit algorithm. */
export function isValidIranianNationalId(input: string): boolean {
  const value = normalizeDigits(input).replace(/[^0-9]/g, '');
  if (!/^\d{10}$/.test(value)) return false;
  if (/^(\d)\1{9}$/.test(value)) return false; // 1111111111 etc. are invalid
  const check = Number(value[9]);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(value[i]) * (10 - i);
  const remainder = sum % 11;
  return check === (remainder < 2 ? remainder : 11 - remainder);
}

/** Convert Persian/Arabic-Indic digits to ASCII digits. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Iranian mobile number → E.164 (`+989XXXXXXXXX`). */
export function normalizeIranianMobile(input: string): string | null {
  const digits = normalizeDigits(input).replace(/[()\s-]/g, '');
  const match = /^(?:\+?98|0098|0)?(9\d{9})$/.exec(digits);
  if (!match) return null;
  return `+98${match[1]}`;
}

export function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(input.trim());
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isPassportNumber(input: string): boolean {
  return /^[A-Z0-9]{5,20}$/i.test(input.trim());
}

export function isDateOnly(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const date = new Date(`${input}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === input;
}

export function isTimeOfDay(input: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(input);
}

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  rejectCommon: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: false,
  rejectCommon: true,
};

/** Small built-in deny list; a deployment can supply a longer one (breach-check hook, TM-04). */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'passw0rd',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'iloveyou',
  'admin1234',
  'welcome123',
  'changeme123',
  '1qaz2wsx3edc',
  'password123',
]);

export interface PasswordCheck {
  valid: boolean;
  reasons: string[];
}

export function checkPasswordStrength(input: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): PasswordCheck {
  const reasons: string[] = [];
  if (input.length < policy.minLength) reasons.push(`minLength:${policy.minLength}`);
  if (policy.requireUppercase && !/[A-Z]/.test(input)) reasons.push('uppercase');
  if (policy.requireLowercase && !/[a-z]/.test(input)) reasons.push('lowercase');
  if (policy.requireDigit && !/\d/.test(input)) reasons.push('digit');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(input)) reasons.push('symbol');
  if (policy.rejectCommon && COMMON_PASSWORDS.has(input.toLowerCase())) reasons.push('common');
  // A single repeated character or a pure sequence is rejected regardless of policy.
  if (/^(.)\1+$/.test(input)) reasons.push('repeated');
  if (/^(?:0123|1234|abcd|qwerty)/i.test(input) && input.length < 14) reasons.push('sequence');
  return { valid: reasons.length === 0, reasons };
}

/** Iranian bank card Luhn check — used only for *format* validation, never to store cards. */
export function isValidCardNumber(input: string): boolean {
  const digits = normalizeDigits(input).replace(/\D/g, '');
  if (!/^\d{16}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i += 1) {
    const digit = Number(digits[15 - i]);
    const transformed = i % 2 === 1 ? ((digit * 2) % 10) + Math.floor((digit * 2) / 10) : digit;
    sum += transformed;
  }
  return sum % 10 === 0;
}

/** Iranian IBAN / SHEBA (IR + 24 digits). */
export function isValidSheba(input: string): boolean {
  const value = normalizeDigits(input).replace(/\s|-/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(value)) return false;
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  const expanded = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

export function truncate(input: string, max = 200): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

/** Password reset / linking codes: treat as sensitive, compare in constant time at the service. */
export function isNumericCode(input: string, length = 6): boolean {
  return new RegExp(`^\\d{${length}}$`).test(normalizeDigits(input).trim());
}
