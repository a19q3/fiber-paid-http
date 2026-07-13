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

export function toProblemJson(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof FiberPaidHttpError && error.status < 500) {
    return {
      status: error.status,
      body: {
        type: `https://paymentauth.org/problems/${error.code}`,
        title: error.code,
        status: error.status,
        detail: error.message
      }
    };
  }
  const status = error instanceof FiberPaidHttpError && error.status >= 500 ? error.status : 500;
  return {
    status,
    body: {
      type: "https://paymentauth.org/problems/internal-error",
      title: "internal-error",
      status,
      detail: "Internal error"
    }
  };
}
