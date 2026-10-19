/** Request and resource pins live only in this process. Heartbeats publish drained generations. */
export class TenantClaims {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly admit: () => Promise<void> = async () => {},
    private readonly check: () => void = () => {},
  ) {}

  isHeld(tenantId: string) {
    return (this.counts.get(tenantId) ?? 0) > 0;
  }

  async assertValid() {
    await this.admit();
    this.check();
  }

  async enter(tenantId: string): Promise<() => Promise<void>> {
    await this.admit();
    return this.pin(tenantId);
  }

  bind(tenantId: string): () => Promise<void> {
    if (!this.isHeld(tenantId)) throw new Error('TENANT_WORK_NOT_ADMITTED');
    return this.pin(tenantId);
  }

  private pin(tenantId: string) {
    this.check();
    this.counts.set(tenantId, (this.counts.get(tenantId) ?? 0) + 1);
    let completed = false;
    return async () => {
      if (completed) return;
      completed = true;
      const remaining = this.counts.get(tenantId)! - 1;
      if (remaining === 0) this.counts.delete(tenantId);
      else this.counts.set(tenantId, remaining);
    };
  }
}
