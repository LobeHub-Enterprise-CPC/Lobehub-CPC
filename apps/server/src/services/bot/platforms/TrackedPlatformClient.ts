import { currentTenantScope } from '@lobechat/database/tenant';

/** Serializes listener startup/teardown and retains the tenant pin until teardown succeeds. */
export class TrackedPlatformClient {
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private releaseTenant?: () => void;
  private settleTenant?: () => void;

  async start(run: () => Promise<void>, stop: () => Promise<void>) {
    if (this.closing) throw new Error('BOT_STOP_IN_PROGRESS');
    if (this.starting) return this.starting;
    if (!this.releaseTenant) {
      const track = currentTenantScope()?.trackWork;
      if (track) {
        const settled = new Promise<void>((resolve) => {
          this.settleTenant = resolve;
        });
        this.releaseTenant = track({ close: stop, settled });
      }
    }
    const work = run();
    this.starting = work;
    try {
      await work;
    } finally {
      if (this.starting === work) this.starting = undefined;
    }
  }

  async waitForStart() {
    try {
      await this.starting;
    } catch {
      /* Teardown must also run after a failed start. */
    }
  }

  async stop(run: () => Promise<void>) {
    if (this.closing) return this.closing;
    // Schedule teardown after publishing the closing guard, including reentrant calls.
    const work = Promise.resolve()
      .then(run)
      .then(() => {
        this.settleTenant?.();
        this.releaseTenant?.();
        this.settleTenant = undefined;
        this.releaseTenant = undefined;
      });
    this.closing = work;
    try {
      await work;
    } finally {
      if (this.closing === work) this.closing = undefined;
    }
  }
}
