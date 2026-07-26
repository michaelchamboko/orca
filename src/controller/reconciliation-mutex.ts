/**
 * A simple serialized mutex used to order ingress, polling, and SSE-driven
 * reconciliation cycles. The controller-local mutex guarantees that two
 * concurrent reconcilers cannot both observe the same durable state and emit
 * overlapping transitions, which is the primary safeguard against
 * double-dispatch and double-approval races inside the same process.
 */
export class ReconciliationMutex {
  private chain: Promise<unknown> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(operation);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}