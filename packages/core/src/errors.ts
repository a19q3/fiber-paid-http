export class FiberMppError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FiberMppError";
    this.code = code;
    this.status = status;
  }
}

export function toProblemJson(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof FiberMppError) {
    return {
      status: error.status,
      body: {
        type: `https://fiber-mpp.local/problems/${error.code}`,
        title: error.code,
        status: error.status,
        detail: error.message
      }
    };
  }
  return {
    status: 500,
    body: {
      type: "https://fiber-mpp.local/problems/internal-error",
      title: "internal-error",
      status: 500,
      detail: "Internal error"
    }
  };
}
