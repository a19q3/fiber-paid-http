import type { TempoMethodChallenge } from "@fiber-mpp/core";

export class TempoMockMethod {
  public readonly mode = "mock" as const;

  public createChallenge(input: {
    amount: string;
    currency: string;
    recipient?: string;
  }): TempoMethodChallenge {
    return {
      method: "tempo",
      intent: "charge",
      network: "mock",
      currency: input.currency,
      recipient: input.recipient,
      amount: input.amount
    };
  }

  public verifyProof(proof: unknown): { status: "simulated"; provider: "tempo-mock" } {
    if (!proof || typeof proof !== "object" || (proof as { status?: unknown }).status !== "settled") {
      throw new Error("Tempo mock proof must declare status=settled");
    }
    return { status: "simulated", provider: "tempo-mock" };
  }
}
