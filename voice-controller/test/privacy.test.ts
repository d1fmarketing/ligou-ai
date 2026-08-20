import { describe, expect, test } from "bun:test";
import {
  canonicalContact,
  hashCanonicalContact,
  minimizeAndRedact,
} from "../../supabase/functions/_shared/privacy.ts";
import { extractAllowedSipHeaders } from "../../supabase/functions/_shared/sip-headers.ts";

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("PII minimization and redaction", () => {
  test("redacts formatted phones, emails, addresses, payment/account identifiers, and short access codes", () => {
    const samples = [
      ["Call +1 (949) 555-0101 or 949.555.0101", "[phone-redacted]"],
      ["Email Owner.Name+jobs@example.com", "[email-redacted]"],
      ["Come to 1234 West Oak Street, Irvine CA 92614", "[address-redacted]"],
      ["Card 4111 1111 1111 1111 routing number 021000021 account # 99887766", "[payment-redacted]"],
      ["The gate code is 4321 and alarm PIN 7788", "[access-code-redacted]"],
    ];
    for (const [input, marker] of samples) {
      const redacted = minimizeAndRedact(input, 600);
      expect(redacted).toContain(marker);
      expect(redacted).not.toMatch(/Owner\.Name|4321|7788|4111|021000021|99887766|1234 West Oak|949[). -]/i);
    }
  });

  test("minimizes before redaction and never emits more than the field budget", () => {
    const input = `${"safe ".repeat(300)} card 4111 1111 1111 1111`;
    const out = minimizeAndRedact(input, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toContain("4111");
  });
});

describe("keyed canonical contacts", () => {
  test("normalizes phone and email representations before HMAC-SHA256", async () => {
    expect(canonicalContact(" +1 (949) 555-0101 ")).toBe("9495550101");
    expect(await hashCanonicalContact("+1 (949) 555-0101", TEST_KEY))
      .toBe("0ef920170b268511f40049ca4118bad5ee324d24c4eff1f6366d958b6c6f4699");
    expect(await hashCanonicalContact("949-555-0101", TEST_KEY))
      .toBe(await hashCanonicalContact("+19495550101", TEST_KEY));
    expect(await hashCanonicalContact(" Owner@Example.COM ", TEST_KEY))
      .toBe("3f0134845a1dadba06907128b3f0104a3dc31ddf938a802f260f47a6a16ffbc7");
  });

  test("a different key changes identity and a missing key fails closed", async () => {
    const other = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";
    expect(await hashCanonicalContact("9495550101", other))
      .not.toBe(await hashCanonicalContact("9495550101", TEST_KEY));
    await expect(hashCanonicalContact("9495550101", "")).rejects.toThrow("contact_hash_key_missing");
  });
});

test("SIP parsing allowlists only routing inputs and never persists raw caller identity", () => {
  const parsed = extractAllowedSipHeaders([
    { name: "To", value: "+19495550100" },
    { name: "From", value: "+1 (949) 555-0101" },
    { name: "Authorization", value: "Bearer secret" },
    { name: "Contact", value: "sip:private@example.com" },
    { name: "P-Asserted-Identity", value: "+19495550999" },
    { name: "X-Gate-Code", value: "4321" },
  ]);
  expect(parsed).toEqual({
    calledNumber: "+19495550100",
    callerContact: "+1 (949) 555-0101",
    storedHeaders: { to: "+19495550100" },
  });
  expect(JSON.stringify(parsed.storedHeaders)).not.toMatch(/secret|private|5550999|4321|from/i);
});
