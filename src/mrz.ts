/**
 * OCR-tolerant parsing of passport machine-readable zones (ICAO 9303 TD3) and
 * UK photocard driving licence dates.
 *
 * Input is plain text from any OCR engine (for example Tesseract.js running in
 * the browser). The parsers soften common OCR confusions (O/0, I/1, S/5, ...)
 * only in fields that must be numeric, and accept the MRZ as separate lines or
 * as one run-together blob.
 *
 * @packageDocumentation
 */

/** Which MRZ date is being read; decides the century for two-digit years. */
export type MrzDateKind = "birth" | "expiry";

const CHECK_WEIGHTS = [7, 3, 1] as const;

function characterValue(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 90) return code - 55; // A-Z -> 10-35
  return 0; // "<" and anything unexpected
}

/** ICAO 9303 check digit (weights 7, 3, 1; `<` counts as 0). */
export function mrzCheckDigit(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    total += characterValue(value[index]!) * CHECK_WEIGHTS[index % 3]!;
  }
  return total % 10;
}

/** True when `expected` is a single digit equal to the check digit of `value`. */
export function mrzChecksum(value: string, expected: string | undefined): boolean {
  return expected !== undefined && /^\d$/.test(expected) && mrzCheckDigit(value) === Number(expected);
}

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0", o: "0", Q: "0", q: "0", D: "0", d: "0",
  I: "1", i: "1", L: "1", l: "1",
  Z: "2", z: "2",
  S: "5", s: "5",
  B: "8", b: "8",
  G: "6", g: "6",
};

/** Replace letters OCR commonly confuses with digits (O to 0, I/L to 1, Z to 2, S to 5, B to 8, G to 6). */
export function digitizeMrz(value: string): string {
  let output = "";
  for (const character of value) output += DIGIT_LOOKALIKES[character] ?? character;
  return output;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > daysInMonth) return null;
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function localIsoDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Parse a `YYMMDD` MRZ date to ISO `YYYY-MM-DD`.
 *
 * Birth dates whose two-digit year is after this year are put in the 1900s;
 * everything else (and every expiry date) is in the 2000s.
 *
 * @param today - Reference date for the century rule. Default: now.
 * @returns The ISO date, or null when it is not a real calendar date.
 */
export function mrzDate(value: string, kind: MrzDateKind, today: Date = new Date()): string | null {
  const digits = digitizeMrz(value);
  if (!/^\d{6}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const current = today.getFullYear() % 100;
  const century = kind === "birth" && year > current ? 1900 : 2000;
  return isoDate(century + year, month, day);
}

/**
 * Clean one candidate passport MRZ line 2: keep only `A-Z 0-9 <`, pad or cut
 * to 44 characters, and digitize the fields that must be numeric (document
 * number and its check digit, date of birth, sex, expiry, final check digit).
 * Lines shorter than 40 characters are returned cleaned but unpadded.
 */
export function softMrzLine(line: string): string {
  const cleaned = line.toUpperCase().replace(/[^A-Z0-9<]/g, "");
  if (cleaned.length < 40) return cleaned;
  const padded = (cleaned + "<".repeat(44)).slice(0, 44);
  return (
    padded.slice(0, 9) // document number: letters are legitimate here (ICAO 9303), so not digitized
    + digitizeMrz(padded.slice(9, 10))
    + padded.slice(10, 13)
    + digitizeMrz(padded.slice(13, 28))
    + padded.slice(28, 43)
    + digitizeMrz(padded.slice(43, 44))
  );
}

const PASSPORT_LINE_2 = /^[A-Z0-9<]{9}\d[A-Z]{3}\d{7}[MF<X0-9]\d{7}/;
// Same line boundaries as Python's str.splitlines().
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/**
 * Find the second (data) line of a passport MRZ in OCR text.
 *
 * Looks at each text line and, because OCR often returns the MRZ as one blob
 * without line breaks, at every 44-character window of the text with
 * non-MRZ characters removed. Returns the first candidate shaped like a TD3
 * line 2, otherwise the candidate with the most fillers and digits, otherwise null.
 */
export function findPassportMrzLine(text: string): string | null {
  const compact = text.toUpperCase().replace(/[^A-Z0-9<]/g, "");
  const sources = text.split(LINE_BREAKS);
  if (compact.length >= 44) {
    for (let index = 0; index < compact.length - 43; index += 1) {
      const window = softMrzLine(compact.slice(index, index + 44));
      if (countMatches(window, /</g) >= 2 || countMatches(window, /\d/g) >= 12) sources.push(window);
    }
  }

  let best: { line: string; key: [number, number, number] } | null = null;
  for (const raw of sources) {
    const line = softMrzLine(raw);
    if (line.length < 44) continue;
    if (PASSPORT_LINE_2.test(line)) return line;
    const key: [number, number, number] = [countMatches(line, /</g), countMatches(line, /\d/g), line.length];
    if (!best || compareKeys(key, best.key) > 0) best = { line, key };
  }
  return best?.line ?? null;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Individual check-digit results for a passport MRZ line 2. */
export interface PassportChecks {
  documentNumber: boolean;
  dateOfBirth: boolean;
  expiryDate: boolean;
  /** False when the personal-number check digit is `<` or wrong. */
  personalNumber: boolean;
  composite: boolean;
}

/** Result of {@link parsePassport}. */
export interface PassportResult {
  /** See {@link ParsePassportOptions.strict} for what this means. */
  valid: boolean;
  /** ISO `YYYY-MM-DD`, or null. */
  dateOfBirth: string | null;
  /** ISO `YYYY-MM-DD`, or null. Not compared with today. */
  expiryDate: string | null;
  /** Null when valid. */
  error: "passport_mrz_not_found" | "passport_mrz_checksum" | null;
  /** The cleaned 44-character line 2 that was parsed, or null. */
  line: string | null;
  checks: PassportChecks | null;
  /** How many of the five check digits passed. */
  checksumsPassed: number;
}

/** Options for {@link parsePassport}. */
export interface ParsePassportOptions {
  /**
   * When true (default), every check digit must pass (the personal-number one
   * may instead be all fillers). When false the parser is OCR-tolerant: the
   * result is `valid` when both dates parse and at least two check digits pass,
   * or when both dates parse and the line has the TD3 shape (OCR often flips a
   * digit) — useful for live "we can read it" feedback while framing, never as
   * a final check.
   */
  strict?: boolean;
  /** Reference date for the birth-year century rule. Default: now. */
  today?: Date;
}

/**
 * Parse the dates out of a passport MRZ found anywhere in OCR text.
 *
 * Check digits only catch misreads; they don't prove a document is genuine
 * (anyone can compute them). Always re-check on your server.
 *
 * @example
 * ```ts
 * const result = parsePassport(ocrText);
 * if (result.valid) console.log(result.dateOfBirth, result.expiryDate);
 * ```
 */
export function parsePassport(text: string, options: ParsePassportOptions = {}): PassportResult {
  const line = findPassportMrzLine(text);
  if (!line) {
    return { valid: false, dateOfBirth: null, expiryDate: null, error: "passport_mrz_not_found", line: null, checks: null, checksumsPassed: 0 };
  }
  const at = (index: number) => line[index] ?? "<";
  const checks: PassportChecks = {
    // Document numbers may contain letters; accept the raw value or its OCR-corrected digit form.
    documentNumber: mrzChecksum(line.slice(0, 9), at(9)) || mrzChecksum(digitizeMrz(line.slice(0, 9)), at(9)),
    dateOfBirth: mrzChecksum(line.slice(13, 19), at(19)),
    expiryDate: mrzChecksum(line.slice(21, 27), at(27)),
    personalNumber: /\d/.test(at(42)) && mrzChecksum(line.slice(28, 42), at(42)),
    composite: /\d/.test(at(43)) && (
      mrzChecksum(line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43), at(43))
      || mrzChecksum(digitizeMrz(line.slice(0, 9)) + line.slice(9, 10) + line.slice(13, 20) + line.slice(21, 43), at(43))
    ),
  };
  const checksumsPassed = Object.values(checks).filter(Boolean).length;
  const dateOfBirth = mrzDate(line.slice(13, 19), "birth", options.today);
  const expiryDate = mrzDate(line.slice(21, 27), "expiry", options.today);
  const datesOk = dateOfBirth !== null && expiryDate !== null;

  let valid: boolean;
  if (options.strict ?? true) {
    const personalOk = checks.personalNumber || /^<+$/.test(line.slice(28, 43));
    valid = datesOk && checks.documentNumber && checks.dateOfBirth && checks.expiryDate && checks.composite && personalOk;
  } else {
    valid = datesOk && (checksumsPassed >= 2 || /^[A-Z0-9<]{9}.[A-Z]{3}/.test(line));
  }
  return { valid, dateOfBirth, expiryDate, error: valid ? null : "passport_mrz_checksum", line, checks, checksumsPassed };
}

/** Result of {@link parseDrivingLicence}. */
export interface DrivingLicenceResult {
  /** Both a past date (birth) and a future date (expiry) were found. */
  valid: boolean;
  /** Earliest date before today, as ISO `YYYY-MM-DD`. */
  dateOfBirth: string | null;
  /** Latest date on or after today, as ISO `YYYY-MM-DD`. */
  expiryDate: string | null;
  /** Null when valid. */
  error: "licence_fields_not_verified" | null;
  /** Text mentions DVLA, "DRIVING LICENCE", "UNITED KINGDOM", "GBR" or "UK ". */
  hasUkMarkers: boolean;
}

/** Options for {@link parseDrivingLicence}. */
export interface ParseDrivingLicenceOptions {
  /** Reference date for past/future. Default: now. */
  today?: Date;
}

const UK_MARKERS = ["DRIVING LICENCE", "DRIVING LICENSE", "DVLA", "UNITED KINGDOM", "GBR", "UK "];

/**
 * Read date of birth and expiry from OCR text of a UK photocard driving
 * licence. All `DD.MM.YYYY` (or `/`, `-`) dates are collected; the earliest
 * past date is taken as the birth date and the latest date from today on as
 * the expiry.
 */
export function parseDrivingLicence(text: string, options: ParseDrivingLicenceOptions = {}): DrivingLicenceResult {
  const upper = text.toUpperCase();
  const normalised = upper.replace(/O/g, "0");
  const today = localIsoDate(options.today ?? new Date());
  const dates: string[] = [];
  for (const match of normalised.matchAll(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/g)) {
    const iso = isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (iso) dates.push(iso);
  }
  const hasUkMarkers = UK_MARKERS.some((marker) => upper.includes(marker));
  const past = dates.filter((value) => value < today).sort();
  const future = dates.filter((value) => value >= today).sort();
  const dateOfBirth = past[0] ?? null;
  const expiryDate = future[future.length - 1] ?? null;
  // Prefer UK markers, but accept a clear birth + expiry pair from photocard OCR.
  const valid = dateOfBirth !== null && expiryDate !== null && (hasUkMarkers || dates.length >= 2);
  return { valid, dateOfBirth, expiryDate, error: valid ? null : "licence_fields_not_verified", hasUkMarkers };
}
