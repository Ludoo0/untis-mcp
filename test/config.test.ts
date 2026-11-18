import { describe, expect, test } from "bun:test";
import { base32Decode, totp } from "../src/auth/totp";
import { ConfigError, loadConfig, normalizeBaseUrl, parseQrUrl } from "../src/config";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"

describe("TOTP (RFC 6238 test vectors)", () => {
  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("t=%d", async (t, expected) => {
    expect(await totp(RFC_SECRET, t * 1000, 30, 8)).toBe(expected);
  });

  test("6 digits by default, Base32 is case-insensitive", async () => {
    expect(await totp(RFC_SECRET.toLowerCase(), 59_000)).toBe("287082");
    expect(base32Decode("MZXW6===").length).toBe(3);
    expect(() => base32Decode("not base32!")).toThrow();
  });
});

describe("config", () => {
  const QR = "untis://setschool?url=example.webuntis.com&school=example&user=jonas.b&key=ABCDEFGHIJKLMNOP&schoolNumber=1";

  test("QR code sets server, school, user and secret", () => {
    const c = loadConfig({ UNTIS_QR_URL: QR });
    expect(c).toMatchObject({
      baseUrl: "https://example.webuntis.com",
      school: "example",
      username: "jonas.b",
      login: { kind: "secret", secret: "ABCDEFGHIJKLMNOP" },
    });
    expect(c.redactionLanguage).toBe("de");
    expect(c.transport).toBe("stdio");
  });

  test("secret from a file (Docker secret)", () => {
    const c = loadConfig({ UNTIS_QR_URL_FILE: "/run/secrets/qr" }, () => `${QR}\n`);
    expect(c.login.kind).toBe("secret");
  });

  test("explicit values with password", () => {
    const c = loadConfig({
      UNTIS_BASE_URL: "example.webuntis.com/WebUntis/",
      UNTIS_SCHOOL: "example",
      UNTIS_USERNAME: "u",
      UNTIS_PASSWORD: "pw",
    });
    expect(c.baseUrl).toBe("https://example.webuntis.com");
    expect(c.login).toEqual({ kind: "password", password: "pw" });
  });

  test("exactly one login variant", () => {
    expect(() => loadConfig({ UNTIS_BASE_URL: "x.webuntis.com", UNTIS_SCHOOL: "x", UNTIS_USERNAME: "u" })).toThrow(ConfigError);
    expect(() => loadConfig({ UNTIS_QR_URL: QR, UNTIS_PASSWORD: "pw" })).toThrow(/exactly one/);
  });

  test("validation errors never print secrets", () => {
    try {
      loadConfig({ UNTIS_BASE_URL: "x.webuntis.com", UNTIS_SCHOOL: "x", UNTIS_USERNAME: "u", UNTIS_APP_SECRET: "geheim!!1" });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain("geheim");
      expect((e as Error).message).toContain("Base32");
    }
  });

  test("http needs an API key; time zone is validated", () => {
    expect(() => loadConfig({ UNTIS_QR_URL: QR, MCP_TRANSPORT: "http" })).toThrow(/MCP_API_KEY/);
    expect(() => loadConfig({ UNTIS_QR_URL: QR, TIMEZONE: "Mars/Olympus" })).toThrow(/TIMEZONE/);
  });

  test("QR parsing errors", () => {
    expect(() => parseQrUrl("untis://setschool?url=a.webuntis.com&school=a")).toThrow(/user, key/);
    expect(normalizeBaseUrl("https://a.webuntis.com/")).toBe("https://a.webuntis.com");
  });
});
