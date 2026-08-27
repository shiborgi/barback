import { GatewayError } from "../core/errors.ts";

export class CircuitBreaker {
  #failures = 0;
  #openedAt?: number;

  constructor(
    private readonly failureThreshold: number,
    private readonly openDuration: number,
  ) {}

  assertAvailable(now = Date.now()) {
    if (this.#openedAt === undefined) return;
    if (now - this.#openedAt >= this.openDuration) {
      this.#openedAt = undefined;
      this.#failures = 0;
      return;
    }
    throw new GatewayError(
      "Provider circuit is open",
      503,
      "provider_unavailable_error",
      "circuit_open",
    );
  }

  success() {
    this.#failures = 0;
    this.#openedAt = undefined;
  }

  failure(now = Date.now()) {
    this.#failures += 1;
    if (this.#failures >= this.failureThreshold) this.#openedAt = now;
  }

  get state(): "closed" | "open" {
    return this.#openedAt === undefined ? "closed" : "open";
  }
}
