// Scrubs identification and account numbers from imported text, which
// Apocrypha excludes wherever stored. Errs toward redacting.
function luhn(digits) {
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  return sum % 10 === 0;
}

const RULES = [
  // US Social Security numbers.
  ['id', /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, () => true],
  // Payment card numbers (13–19 digits, optional space/dash groups, Luhn-valid).
  ['account', /\b\d(?:[ -]?\d){12,18}\b/g, m => luhn(m.replace(/\D/g, ''))],
  // IBANs.
  ['account', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, m => /\d{6}/.test(m.replace(/ /g, ''))],
  // Numbers labelled as account, routing, member, policy or card numbers.
  ['account', /\b(?:account|acct|routing|aba|member|policy|card)(?:\s*(?:number|no\.?|num|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{4,22}[0-9])\b/gi, m => /\d{5}/.test(m.replace(/\D/g, ''))],
  // Numbers labelled as passport, driver's licence, tax or national IDs.
  ['id', /\b(?:passport|driver'?s? licen[cs]e|licen[cs]e (?:no|number)|DL|SSN|ITIN|EIN|TIN|national id|tax id)(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,15})\b/gi, m => /\d{3}/.test(m)],
];

export function redact(text) {
  const found = new Set();
  let output = text;
  for (const [kind, pattern, accept] of RULES) {
    output = output.replace(pattern, (match) => {
      if (!accept(match)) return match;
      found.add(kind);
      return `[redacted ${kind} number]`;
    });
  }
  return { text: output, found: [...found] };
}
