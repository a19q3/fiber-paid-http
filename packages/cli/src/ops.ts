const DEFAULT_REDACTED_KEYS = [
  "authorization",
  "cookie",
  "secret",
  "secret_env",
  "previous_secret",
  "rpc_auth",
  "payee_rpc_auth",
  "payer_rpc_auth",
  "token",
  "password",
  "private_key"
];

const SENSITIVE_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bBasic\s+[A-Za-z0-9+/=-]+/gi, "Basic [REDACTED]"],
  [/(authorization=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(rpc_auth=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(secret=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(token=)[^&\s]+/gi, "$1[REDACTED]"]
];

export type LogRedactionPolicy = {
  enabled: boolean;
  extraKeys?: string[];
};

export function redactForLog(value: unknown, policy: LogRedactionPolicy = { enabled: true }): unknown {
  if (!policy.enabled) {
    return value;
  }
  const redactedKeys = new Set([...DEFAULT_REDACTED_KEYS, ...(policy.extraKeys ?? [])].map((key) => key.toLowerCase()));
  return redactValue(value, redactedKeys);
}

function redactValue(value: unknown, redactedKeys: Set<string>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactedKeys));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactedKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactValue(entry, redactedKeys);
  }
  return redacted;
}

function redactString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
