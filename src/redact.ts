/**
 * Finds sensitive values in text before it reaches a model, and decides per
 * data type whether to mask them, block the whole response, or let them pass.
 *
 * Detectors are deliberately conservative: a false positive hides a harmless
 * value, a false negative leaks a client's data, so ambiguous number formats
 * are checked (Luhn for cards, valid ranges for SSNs) rather than matched loosely.
 */

export type DataType = "email" | "phone" | "card" | "ssn" | "secret";
export type Action = "redact" | "block" | "allow";
export type Policy = Record<DataType, Action>;

/** Mask contact details and card numbers; withhold anything with an SSN or a credential. */
export const DEFAULT_POLICY: Policy = {
  email: "redact",
  phone: "redact",
  card: "redact",
  ssn: "block",
  secret: "block",
};

export interface Finding {
  type: DataType;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: Finding[];
  blocked: DataType[];
}

const LABEL: Record<DataType, string> = {
  email: "[EMAIL]",
  phone: "[PHONE]",
  card: "[CARD]",
  ssn: "[SSN]",
  secret: "[SECRET]",
};

/** Luhn checksum, so order numbers and serials are not mistaken for cards. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

interface Detector {
  type: DataType;
  pattern: RegExp;
  accept?: (match: string, groups: string[]) => boolean;
  /** Part of the match to replace; defaults to the whole match. */
  group?: number;
}

const DETECTORS: Detector[] = [
  // Secrets first, so a key that contains digits is not half-eaten by the card detector.
  { type: "secret", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "secret", pattern: /\b(?:sk|rk)-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "secret", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "secret", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { type: "secret", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // "password: hunter2", "pw = ...", "passcode is 1234": mask only the value.
  {
    type: "secret",
    pattern: /\b(pass(?:word|code|phrase)?|pwd|pw)(\s*(?:[:=]|is)\s*)(\S{4,})/gi,
    group: 3,
  },
  { type: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    type: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => luhnValid(m.replace(/[ -]/g, "")),
  },
  {
    type: "ssn",
    pattern: /\b(\d{3})-(\d{2})-(\d{4})\b/g,
    accept: (_m, g) => g[0] !== "000" && g[0] !== "666" && g[0][0] !== "9" && g[1] !== "00" && g[2] !== "0000",
  },
  // North American and international numbers written as phone numbers (with
  // separators or a leading +), not bare digit runs, which are usually IDs.
  {
    type: "phone",
    pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b|\+\d{1,3}(?:[ .-]?\d{2,4}){2,4}\b/g,
  },
];

export function redact(input: string, policy: Policy = DEFAULT_POLICY): RedactionResult {
  let text = input;
  const counts = new Map<DataType, number>();
  for (const d of DETECTORS) {
    if (policy[d.type] === "allow") continue;
    text = text.replace(d.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((x): x is string => typeof x === "string");
      if (d.accept && !d.accept(match, groups)) return match;
      counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
      if (d.group) {
        const keep = groups.slice(0, d.group - 1).join("");
        return keep + LABEL[d.type];
      }
      return LABEL[d.type];
    });
  }
  const findings = [...counts].map(([type, count]) => ({ type, count }));
  const blocked = findings.filter((f) => policy[f.type] === "block").map((f) => f.type);
  return { text, findings, blocked };
}
