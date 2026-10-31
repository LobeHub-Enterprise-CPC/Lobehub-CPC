// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHatchetDeliveryProbe, type DeliveryCheckpoint } from './probe';

const getHatchetClientMock = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ getHatchetClient: getHatchetClientMock }));

const OPERATION = 'op_1';
const CREATED_AT = new Date('2026-10-30T10:00:00.000Z');

const checkpointWith = (extra: Partial<DeliveryCheckpoint> = {}): DeliveryCheckpoint => ({
  createdAt: CREATED_AT,
  stepCount: 7,
  ...extra,
});

/** Metadata as the publisher writes it on `cpc-agent-step` runs and schedules. */
const delivery = (purpose: string | undefined, stepIndex: number, operationId = OPERATION) => ({
  additionalMetadata: {
    kind: 'step',
    operationId,
    stepIndex: String(stepIndex),
    tenantId: 'acme',
    ...(purpose === undefined ? {} : { purpose }),
  },
});

type Row = ReturnType<typeof delivery>;

/** Serves `pages[offset / limit]`, like the REST list endpoints. */
const buildClient = ({
  runs = [],
  schedules = [],
}: { runs?: Row[][]; schedules?: Row[][] } = {}) => {
  const page = (pages: Row[][]) =>
    vi.fn(async (query: { limit: number; offset?: number }) => {
      const index = Math.floor((query.offset ?? 0) / query.limit);
      return { pagination: {}, rows: pages[index] ?? [] };
    });
  return { runs: { list: page(runs) }, schedules: { list: page(schedules) } };
};

const probeWith = (client: ReturnType<typeof buildClient>) =>
  createHatchetDeliveryProbe(client as never);

describe('createHatchetDeliveryProbe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successor rules', () => {
    it.each([
      ['a step delivery at the checkpoint', delivery('step', 7), {}],
      ['a step delivery past the checkpoint', delivery('step', 9), {}],
      ['a resume delivery at the checkpoint', delivery('resume', 7), {}],
      // A plain delivery for an older step resumes from the parked envelope.
      [
        'a stale step delivery behind a current envelope',
        delivery('step', 3),
        { envelopeStepIndex: 7 },
      ],
    ])('counts %s', async (_, row, checkpoint) => {
      const probe = probeWith(buildClient({ runs: [[row]] }));
      await expect(probe(OPERATION, checkpointWith(checkpoint))).resolves.toBe('active');
    });

    it.each([
      ['a step delivery behind the checkpoint', delivery('step', 6), {}],
      [
        'a stale step delivery behind a stale envelope',
        delivery('step', 3),
        { envelopeStepIndex: 6 },
      ],
      // A resume carries its own payload and runs at its own index, never the envelope's.
      [
        'a stale resume delivery behind a current envelope',
        delivery('resume', 6),
        { envelopeStepIndex: 9 },
      ],
      ['a control delivery', delivery('control', 9), { envelopeStepIndex: 9 }],
      ['a job delivery', delivery('job', 9), { envelopeStepIndex: 9 }],
      ['a delivery without a purpose', delivery(undefined, 9), { envelopeStepIndex: 9 }],
      ['another operation’s delivery', delivery('step', 9, 'op_other'), {}],
    ])('does not count %s', async (_, row, checkpoint) => {
      const probe = probeWith(buildClient({ runs: [[row]], schedules: [[row]] }));
      await expect(probe(OPERATION, checkpointWith(checkpoint))).resolves.toBe('none');
    });

    it('applies the same rules to schedules that have not fired yet', async () => {
      await expect(
        probeWith(buildClient({ schedules: [[delivery('step', 7)]] }))(OPERATION, checkpointWith()),
      ).resolves.toBe('active');
      await expect(
        probeWith(buildClient({ schedules: [[delivery('control', 7)]] }))(
          OPERATION,
          checkpointWith(),
        ),
      ).resolves.toBe('none');
    });
  });

  describe('queries', () => {
    it('asks for in-flight cpc-agent-step runs and unfired schedules of this operation', async () => {
      const client = buildClient();
      await probeWith(client)(OPERATION, checkpointWith());

      // A run waiting out a RetryAfter backoff, a worker or a concurrency slot all
      // report QUEUED. A multi-key metadata filter is OR on runs, so only the
      // operation id is sent and the rest is checked on the rows.
      expect(client.runs.list).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalMetadata: { operationId: OPERATION },
          includePayloads: false,
          statuses: ['QUEUED', 'RUNNING'],
          workflowNames: ['cpc-agent-step'],
        }),
      );
      // A one-time schedule is deleted when it fires, so SCHEDULED is "not fired yet".
      expect(client.schedules.list).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalMetadata: [`operationId:${OPERATION}`],
          statuses: ['SCHEDULED'],
          workflow: 'cpc-agent-step',
        }),
      );
    });

    it('looks runs up from the operation’s creation, less a minute of clock skew', async () => {
      // Without `since` the SDK looks one hour back, and a run that keeps being
      // re-queued keeps its creation time, so only the operation's own age bounds it.
      const client = buildClient();
      await probeWith(client)(OPERATION, checkpointWith());

      expect(client.runs.list).toHaveBeenCalledWith(
        expect.objectContaining({ since: new Date('2026-10-30T09:59:00.000Z') }),
      );
    });

    it.each([
      ['missing', undefined],
      ['invalid', new Date('not a date')],
    ])('answers unknown without asking when the creation time is %s', async (_, createdAt) => {
      const client = buildClient({ runs: [[delivery('step', 7)]] });

      await expect(probeWith(client)(OPERATION, checkpointWith({ createdAt }))).resolves.toBe(
        'unknown',
      );
      expect(client.runs.list).not.toHaveBeenCalled();
      expect(client.schedules.list).not.toHaveBeenCalled();
    });

    describe('paging', () => {
      const filler = delivery('control', 9);
      /** A first page filled to the requested limit, then `rest`. */
      const fullThen = (rest: Row[]) => async (query: { limit: number; offset?: number }) => ({
        pagination: {},
        rows: (query.offset ?? 0) === 0 ? Array.from({ length: query.limit }, () => filler) : rest,
      });

      it('finds a successor on a later page', async () => {
        const client = buildClient();
        client.runs.list.mockImplementation(fullThen([delivery('step', 7)]));

        await expect(probeWith(client)(OPERATION, checkpointWith())).resolves.toBe('active');
        const [first, second] = client.runs.list.mock.calls.map(([query]) => query);
        expect(second.offset).toBe((first.offset ?? 0) + first.limit);
      });

      it('answers unknown rather than none when the deliveries span pages', async () => {
        // A delivery finishing between two page reads shifts an unread row past
        // the next offset, so only a single complete read proves absence.
        const client = buildClient();
        client.runs.list.mockImplementation(fullThen([filler]));

        await expect(probeWith(client)(OPERATION, checkpointWith())).resolves.toBe('unknown');
        expect(client.runs.list).toHaveBeenCalledTimes(2);
      });

      it.each(['runs', 'schedules'] as const)(
        'answers unknown when a %s page comes back without rows',
        async (which) => {
          const client = buildClient();
          client[which].list.mockResolvedValue({ pagination: {} } as never);

          await expect(probeWith(client)(OPERATION, checkpointWith())).resolves.toBe('unknown');
        },
      );
    });
  });

  describe('failures', () => {
    it.each(['runs', 'schedules'] as const)(
      'answers unknown when the %s query fails',
      async (which) => {
        const client = buildClient();
        client[which].list.mockRejectedValue(new Error('Request failed with status code 503'));
        await expect(probeWith(client)(OPERATION, checkpointWith())).resolves.toBe('unknown');
      },
    );

    it('answers unknown when Hatchet does not answer in time', async () => {
      vi.useFakeTimers();
      const client = buildClient();
      client.schedules.list.mockReturnValue(new Promise(() => {}));
      const answer = probeWith(client)(OPERATION, checkpointWith());

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(answer).resolves.toBe('unknown');
    });

    it('answers unknown when the client cannot be built', async () => {
      getHatchetClientMock.mockImplementationOnce(() => {
        throw new Error('HATCHET_CLIENT_TOKEN is not set');
      });
      await expect(createHatchetDeliveryProbe()(OPERATION, checkpointWith())).resolves.toBe(
        'unknown',
      );
    });
  });

  describe('client lifecycle', () => {
    beforeEach(() => {
      getHatchetClientMock.mockReset();
    });

    it('builds the shared client on the first probe, not when created', async () => {
      const client = buildClient();
      getHatchetClientMock.mockReturnValue(client);

      const probe = createHatchetDeliveryProbe();
      expect(getHatchetClientMock).not.toHaveBeenCalled();

      await expect(probe(OPERATION, checkpointWith())).resolves.toBe('none');
      expect(getHatchetClientMock).toHaveBeenCalled();
      expect(client.runs.list).toHaveBeenCalled();
    });
  });
});
