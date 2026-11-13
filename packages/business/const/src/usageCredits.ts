/**
 * How a distribution states usage cost to its own users.
 *
 * The runtime prices every call in USD (`usage.cost`). A distribution that
 * sells usage as credits sets this, and every place a user reads a cost, a
 * price or a budget states it in credits instead of dollars. The ledger itself
 * stays in USD — this is a presentation rate, not a second currency.
 *
 * `undefined` keeps amounts in dollars.
 */
export interface UsageCreditsConfig {
  /** Credits charged for 1 USD of model cost, with any markup already folded in. */
  creditsPerUsd: number;
  /**
   * Credits per 1M input tokens that the model list counts as 1×. A model's
   * relative price is its input rate divided by this.
   */
  inputCreditsAt1x: number;
}

export const USAGE_CREDITS: UsageCreditsConfig | undefined = undefined;
