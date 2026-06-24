import type { StripeMethodChallenge } from "@fiber-mpp/core";

export class StripeMockMethod {
  public readonly mode = "mock" as const;

  public createChallenge(input: {
    amount: string;
    currency: string;
    networkId?: string;
  }): StripeMethodChallenge {
    return {
      method: "stripe",
      intent: "charge",
      networkId: input.networkId ?? "mock",
      amount: input.amount,
      currency: input.currency,
      paymentMethodTypes: ["mock"],
      sandboxOnly: true
    };
  }

  public verifyProof(proof: unknown): { status: "simulated"; provider: "stripe-mock" } {
    if (!proof || typeof proof !== "object" || (proof as { status?: unknown }).status !== "settled") {
      throw new Error("Stripe mock proof must declare status=settled");
    }
    return { status: "simulated", provider: "stripe-mock" };
  }
}
