import { canonicalize as canonicalizeJcs } from "json-canonicalize";

export function canonicalJson(value: unknown): string {
  return canonicalizeJcs(value);
}
