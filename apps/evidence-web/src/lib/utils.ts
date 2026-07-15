export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]!);
}

export function formatTime(value?: string): string {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 23);
}

export function short(value?: string | null): string {
  if (!value) return "pending";
  const text = String(value);
  return text.length > 26 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

export function formatCheckValue(value: unknown): string {
  if (value === null || typeof value === "undefined" || value === "") return "missing";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return text.length > 34 ? `${text.slice(0, 18)}...${text.slice(-10)}` : text;
}

export function sanitizeAmountInput(value: string, decimal: boolean): string {
  const text = String(value ?? "").trim();
  const sanitized = decimal ? text.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1") : text.replace(/\D/g, "");
  if (!decimal) return sanitized.replace(/^0+(?=\d)/, "");
  const [whole, fraction] = sanitized.split(".");
  const normalizedWhole = (whole || "0").replace(/^0+(?=\d)/, "");
  if (typeof fraction === "undefined") return normalizedWhole;
  return `${normalizedWhole}.${fraction.slice(0, 8)}`;
}

export function ckbToShannons(value: string): string {
  const [whole, fraction = ""] = String(value).split(".");
  return (BigInt(whole || "0") * 100000000n + BigInt(fraction.padEnd(8, "0"))).toString();
}

export function shannonsToCkb(value: string): string {
  const amount = BigInt(value || "0");
  const whole = amount / 100000000n;
  const fraction = (amount % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function normalizeApiBase(value: string): string {
  let text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function boundedInteger(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeConsoleSessionId(value: string | null): string {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._:-]{0,80}$/i.test(text) ? text : "";
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") === true;
  textarea.remove();
  return copied;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage optional
  }
}

export function booleanSummary(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unavailable";
}

export function readinessSummary(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "not claimed";
  return "unavailable";
}

export function vectorSummary(canonical: Record<string, unknown>): string {
  const passed = canonical.shared_vectors_passed_rust;
  const total = canonical.shared_vectors_total;
  if (typeof passed === "number" && typeof total === "number") {
    return `${passed} / ${total} passed`;
  }
  return "unavailable";
}

export function channelEvidenceText(network: Record<string, unknown>): string {
  const channelCount = network.channelCount;
  if (typeof channelCount === "number") {
    const suffix = network.channelCountSource === "fiber-local-e2e-report" ? " from report" : " configured";
    return `${channelCount}${suffix}`;
  }
  if (network.channelCountSource === "not-polled") return "not polled";
  return "unavailable";
}
