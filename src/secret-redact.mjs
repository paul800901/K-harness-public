// One redaction boundary for text that leaves K's Colab control path: errors,
// diagnostics, tool results and the native Responses history. It covers Google
// access tokens (ya29.), refresh tokens (1//), OAuth client secrets (GOCSPX-),
// ID tokens (JWT), bearer headers, the Colab runtime proxy token header and OAuth
// query/JSON fields. `known` adds exact in-memory values (e.g. a proxy token whose
// format is not documented). Callers should still prefer safe classifications over
// echoing external text; this is the backstop, not permission to forward secrets.

const PATTERNS = [
  [/Bearer\s+[^\s"',;]+/giu, 'Bearer [redacted]'],
  [/ya29\.[\w.-]+/gu, '[redacted]'],
  [/\b1\/\/[\w.-]{8,}/gu, '[redacted]'],
  [/GOCSPX-[\w-]+/gu, '[redacted]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]+/gu, '[redacted]'],
  [/(X-Colab-Runtime-Proxy-Token["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu, '$1[redacted]'],
  [
    /((?:access_token|refresh_token|id_token|client_secret|accessToken|refreshToken|clientSecret|token)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gu,
    '$1[redacted]'
  ],
  [/([?&](?:code|state|code_verifier)=)[^&\s"']+/giu, '$1[redacted]']
];

export function redactSecrets(value, known = []) {
  let text = String(value ?? '');
  for (const secret of known)
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[redacted]');
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

// Structured values (diagnostics) are redacted through their JSON form.
export function redactValue(value, known) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), known));
  } catch {
    return {error: '[redacted]'};
  }
}
