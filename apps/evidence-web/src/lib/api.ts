import { DEFAULT_API_BASE, API_REQUEST_TIMEOUT_MS } from "../constants.js";

export class ApiClient {
  private apiBase: string;
  private sessionId: string;

  constructor(apiBase: string, sessionId: string) {
    this.apiBase = apiBase;
    this.sessionId = sessionId;
  }

  setApiBase(base: string) {
    this.apiBase = base;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const response = await this.requestJson(path, { cache: "no-store" });
    if (!response.ok) throw await this.responseError(response);
    return response.json();
  }

  async postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
    const response = await this.requestJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = payload as Record<string, string>;
      throw new Error(err.message || err.error || `${response.status} ${response.statusText}`);
    }
    return payload as T;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        ...((init.headers as Record<string, string>) || {}),
        "x-fiber-mpp-session": this.sessionId,
      };
      return await fetch(`${this.apiBase}${path}`, {
        ...init,
        headers,
        cache: init.cache || "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`request timed out after ${API_REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async responseError(response: Response): Promise<Error> {
    const payload = await response.clone().json().catch(() => ({}));
    const err = payload as Record<string, string>;
    return new Error(err.message || err.error || `${response.status} ${response.statusText}`);
  }
}

export function readConsoleSessionId(routeParams: URLSearchParams): string {
  const key = "fiberMppConsoleSessionId";
  try {
    const requested = normalizeConsoleSessionId(routeParams.get("sessionId"));
    if (requested) {
      sessionStorage.setItem(key, requested);
      return requested;
    }
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const next = `web-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    sessionStorage.setItem(key, next);
    return next;
  } catch {
    return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function normalizeConsoleSessionId(value: string | null): string {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._:-]{0,80}$/i.test(text) ? text : "";
}

export function getInitialApiBase(savedApiBase?: string | null): string {
  try {
    const metaApiBase = document.querySelector('meta[name="api-base"]')?.getAttribute("content");
    if (metaApiBase) return metaApiBase.replace(/\/+$/, "");
    if (savedApiBase) return savedApiBase.replace(/\/+$/, "");
    const localStorageApi = localStorage.getItem("fiberMppApi");
    if (localStorageApi) return localStorageApi.replace(/\/+$/, "");
    return DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}
