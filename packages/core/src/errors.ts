export class FiberPaidHttpError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FiberPaidHttpError";
    this.code = code;
    this.status = status;
  }
}

/**
 * @deprecated Use `FiberPaidHttpError`. Kept so older Fiber MPP callers can
 * upgrade packages before renaming their imports.
 */
export { FiberPaidHttpError as FiberMppError };

export function toProblemJson(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof FiberPaidHttpError) {
    return {
      status: error.status,
      body: {
        type: `https://fiber-paid-http.local/problems/${error.code}`,
        title: error.code,
        status: error.status,
        detail: error.message
      }
    };
  }
  return {
    status: 500,
    body: {
      type: "https://fiber-paid-http.local/problems/internal-error",
      title: "internal-error",
      status: 500,
      detail: "Internal error"
    }
  };
}
