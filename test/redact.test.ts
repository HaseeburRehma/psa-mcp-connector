import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, luhnValid, redact, type Policy } from "../src/redact.js";

const types = (s: string, p: Policy = DEFAULT_POLICY) => redact(s, p).findings.map((f) => f.type).sort();

describe("luhnValid", () => {
  it("accepts public test card numbers", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("5555555555554444")).toBe(true);
    expect(luhnValid("378282246310005")).toBe(true);
  });
  it("rejects numbers that fail the checksum or are too short", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("123456789012")).toBe(false);
  });
});

describe("redact: things that must be caught", () => {
  it.each([
    ["Email me at jane.doe@client.example.com", "email"],
    ["Call (555) 010-4421 please", "phone"],
    ["Call 555-010-4421 please", "phone"],
    ["Mobile +1 555 010 7788", "phone"],
    ["UK office +44 20 7946 0958", "phone"],
    ["Card 4111 1111 1111 1111 exp 12/28", "card"],
    ["Card 4111-1111-1111-1111", "card"],
    ["Card 4111111111111111", "card"],
    ["SSN 123-45-6789 on file", "ssn"],
    ["key AKIAIOSFODNN7EXAMPLE", "secret"],
    ["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx123456", "secret"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", "secret"],
    ["slack xoxb-1234567890-abcdefghij", "secret"],
    ["Temporary password: Welcome2026!", "secret"],
    ["the passcode is 908172", "secret"],
    ["pw=hunter22", "secret"],
  ])("%s", (input, type) => {
    expect(types(input)).toContain(type);
  });

  it("masks only the value of a password, not the word", () => {
    expect(redact("Temporary password: Welcome2026!").text).toBe("Temporary password: [SECRET]");
  });

  it("removes a private key block entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(`key:\n${pem}\nthanks`).text).toBe("key:\n[SECRET]\nthanks");
  });

  it("counts every occurrence", () => {
    const r = redact("a@x.example.com and b@y.example.com");
    expect(r.findings).toEqual([{ type: "email", count: 2 }]);
    expect(r.text).toBe("[EMAIL] and [EMAIL]");
  });
});

describe("redact: things that must be left alone", () => {
  it.each([
    "Order ref 4111-2026-118",
    "Serial 4111111111111112 fails the checksum",
    "Ticket #1001 opened 2026-11-24 at 09:12",
    "Server 10.0.12.45 on port 3389",
    "Invoice 2026-000123",
    "SSN-shaped but invalid: 000-12-3456 and 666-12-3456 and 900-12-3456",
    "Version 1.32.2 released",
    "Reset the password for Jordan",
    "The passcode policy is 12 characters",
  ])("%s", (input) => {
    const r = redact(input);
    expect(r.findings).toEqual([]);
    expect(r.text).toBe(input);
  });
});

describe("redact: policy", () => {
  it("block reports the type and still masks the text", () => {
    const r = redact("key AKIAIOSFODNN7EXAMPLE");
    expect(r.blocked).toEqual(["secret"]);
    expect(r.text).not.toContain("AKIA");
  });
  it("allow leaves the value in place and reports nothing", () => {
    const r = redact("mail a@x.example.com", { ...DEFAULT_POLICY, email: "allow" });
    expect(r.text).toBe("mail a@x.example.com");
    expect(r.findings).toEqual([]);
  });
  it("a card is masked by default, blocked when the client's policy says so", () => {
    expect(redact("4111 1111 1111 1111").blocked).toEqual([]);
    expect(redact("4111 1111 1111 1111", { ...DEFAULT_POLICY, card: "block" }).blocked).toEqual(["card"]);
  });
});
