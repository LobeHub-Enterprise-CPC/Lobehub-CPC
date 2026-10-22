/** A provider adapter has verified rejection before remote work could be created. */
export class SubmissionRejectedError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SubmissionRejectedError';
  }
}
