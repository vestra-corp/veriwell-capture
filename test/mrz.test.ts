import { describe, expect, it } from "vitest";
import {
  digitizeMrz,
  findPassportMrzLine,
  mrzCheckDigit,
  mrzChecksum,
  mrzDate,
  parseDrivingLicence,
  parsePassport,
  softMrzLine,
} from "../src/mrz.js";

// ICAO Doc 9303 specimen (fictional state "Utopia", holder ERIKSSON).
const ICAO_LINE_1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const ICAO_LINE_2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
// Made-up passport with a numeric document number and an empty personal number.
const FAKE_LINE_1 = "P<UTOSAMPLE<<ALEX<<<<<<<<<<<<<<<<<<<<<<<<<<<";
const FAKE_LINE_2 = "1234567897UTO9001158M3507201<<<<<<<<<<<<<<06";
const TODAY = new Date(2026, 9, 14);

describe("mrz check digits", () => {
  it("computes ICAO 9303 check digits", () => {
    expect(mrzCheckDigit("L898902C3")).toBe(6);
    expect(mrzCheckDigit("740812")).toBe(2);
    expect(mrzCheckDigit("120415")).toBe(9);
    expect(mrzCheckDigit("ZE184226B<<<<<")).toBe(1);
    expect(mrzCheckDigit("<<<<")).toBe(0);
  });

  it("only accepts a single matching digit", () => {
    expect(mrzChecksum("740812", "2")).toBe(true);
    expect(mrzChecksum("740812", "3")).toBe(false);
    expect(mrzChecksum("740812", "<")).toBe(false);
    expect(mrzChecksum("740812", undefined)).toBe(false);
  });
});

describe("mrz helpers", () => {
  it("digitizes OCR look-alikes", () => {
    expect(digitizeMrz("O1IL2Z5S8B6GQD")).toBe("01112255886600");
    expect(digitizeMrz("ANMR<")).toBe("ANMR<");
  });

  it("parses dates with the century rule", () => {
    expect(mrzDate("740812", "birth", TODAY)).toBe("1974-08-12");
    expect(mrzDate("100101", "birth", TODAY)).toBe("2010-01-01");
    expect(mrzDate("260101", "birth", TODAY)).toBe("2026-01-01");
    expect(mrzDate("270101", "birth", TODAY)).toBe("1927-01-01");
    expect(mrzDate("740812", "expiry", TODAY)).toBe("2074-08-12");
    expect(mrzDate("74O8I2", "birth", TODAY)).toBe("1974-08-12");
    expect(mrzDate("740231", "birth", TODAY)).toBeNull();
    expect(mrzDate("000229", "expiry", TODAY)).toBe("2000-02-29");
    expect(mrzDate("010229", "expiry", TODAY)).toBeNull();
    expect(mrzDate("74081", "birth", TODAY)).toBeNull();
  });

  it("cleans and pads candidate lines", () => {
    expect(softMrzLine("short line")).toBe("SHORTLINE");
    const padded = softMrzLine(FAKE_LINE_2.slice(0, 40));
    expect(padded).toHaveLength(44);
    expect(padded.endsWith("<<<<")).toBe(true);
    expect(softMrzLine(`${FAKE_LINE_2}EXTRA`)).toBe(FAKE_LINE_2);
    // Letters in numeric fields become digits; nationality letters and the
    // (alphanumeric) document number stay as read.
    const ocrNoise = "I23456789" + "7" + "UTO" + "9OOII5" + "B" + "M" + "35O72O" + "I" + "<".repeat(14) + "0" + "G";
    expect(softMrzLine(ocrNoise)).toBe("I" + FAKE_LINE_2.slice(1));
    // ...and the check digit still accepts the OCR-corrected document number.
    expect(parsePassport(ocrNoise, { today: TODAY })).toMatchObject({ valid: true, checksumsPassed: 5 });
  });
});

describe("findPassportMrzLine", () => {
  it("finds line 2 among other OCR lines", () => {
    const text = ["PASSPORT", "UTOPIA", ICAO_LINE_1, ICAO_LINE_2].join("\n");
    expect(findPassportMrzLine(text)).toBe(softMrzLine(ICAO_LINE_2));
  });

  it("finds line 2 when OCR returns the MRZ as one blob", () => {
    expect(findPassportMrzLine(`${FAKE_LINE_1} ${FAKE_LINE_2}`)).toBe(FAKE_LINE_2);
  });

  it("returns null when nothing is long enough", () => {
    expect(findPassportMrzLine("no machine readable zone here")).toBeNull();
  });
});

describe("parsePassport", () => {
  it("reads a clean passport MRZ with every check digit passing", () => {
    const result = parsePassport(`${FAKE_LINE_1}\n${FAKE_LINE_2}`, { today: TODAY });
    expect(result).toMatchObject({
      valid: true,
      dateOfBirth: "1990-01-15",
      expiryDate: "2035-07-20",
      error: null,
      line: FAKE_LINE_2,
      checksumsPassed: 5,
      checks: { documentNumber: true, dateOfBirth: true, expiryDate: true, personalNumber: true, composite: true },
    });
    expect(parsePassport(`${FAKE_LINE_1}\n${FAKE_LINE_2}`, { today: TODAY, strict: true }).valid).toBe(true);
  });

  it("reads the ICAO specimen, keeping letters in the document number", () => {
    const result = parsePassport(`${ICAO_LINE_1}\n${ICAO_LINE_2}`, { today: TODAY });
    expect(result).toMatchObject({ valid: true, dateOfBirth: "1974-08-12", expiryDate: "2012-04-15", checksumsPassed: 5 });
    expect(result.line?.slice(0, 9)).toBe("L898902C3");
    expect(result.checks).toMatchObject({ documentNumber: true, dateOfBirth: true, expiryDate: true, personalNumber: true, composite: true });
  });

  it("rejects an OCR-flipped digit by default, tolerates it with strict: false", () => {
    const flipped = FAKE_LINE_2.slice(0, 3) + "9" + FAKE_LINE_2.slice(4);
    expect(parsePassport(flipped, { today: TODAY })).toMatchObject({ valid: false, error: "passport_mrz_checksum" });
    const tolerant = parsePassport(flipped, { today: TODAY, strict: false });
    expect(tolerant.valid).toBe(true);
    expect(tolerant.checks?.documentNumber).toBe(false);
  });

  it("rejects impossible dates", () => {
    const badDate = FAKE_LINE_2.slice(0, 13) + "901315" + FAKE_LINE_2.slice(19);
    expect(parsePassport(badDate, { today: TODAY })).toMatchObject({ valid: false, dateOfBirth: null, error: "passport_mrz_checksum" });
  });

  it("reports when no MRZ is present", () => {
    expect(parsePassport("Hello world", { today: TODAY })).toMatchObject({ valid: false, error: "passport_mrz_not_found", line: null });
  });
});

describe("parseDrivingLicence", () => {
  // Fictional holder; licence number follows the DVLA 16-character layout.
  const ocr = [
    "DRIVING LICENCE",
    "UK",
    "1. SAMPLE",
    "2. MR ALEX BEN",
    "3. 14.07.1985 UNITED KINGDOM",
    "4a. 01.03.2019 4c. DVLA",
    "4b. 28.02.2029",
    "5. SAMPL807145AB9XY",
  ].join("\n");

  it("reads birth and expiry dates", () => {
    expect(parseDrivingLicence(ocr, { today: TODAY })).toEqual({
      valid: true,
      dateOfBirth: "1985-07-14",
      expiryDate: "2029-02-28",
      error: null,
      hasUkMarkers: true,
    });
  });

  it("treats O as 0 in dates and skips impossible dates", () => {
    const result = parseDrivingLicence("3. 14.O7.1985 4b. 31.02.2030 4b. 28/02/2O29", { today: TODAY });
    expect(result).toMatchObject({ valid: true, dateOfBirth: "1985-07-14", expiryDate: "2029-02-28", hasUkMarkers: false });
  });

  it("needs both a past and a future date", () => {
    expect(parseDrivingLicence("DVLA 14.07.1985", { today: TODAY })).toMatchObject({
      valid: false,
      dateOfBirth: "1985-07-14",
      expiryDate: null,
      error: "licence_fields_not_verified",
    });
  });
});
