// These suites use migrations owned by the enclosing enterprise distribution.
// Keep exact paths: other Channel-related tests may be standalone. The parent
// database check restores these suites and verifies that every case ran.
export const enterpriseTestFiles = [
  'src/models/channel.test.ts',
  'src/models/channelEnvironment.test.ts',
  'src/models/channelMigration.test.ts',
  'src/models/channelNative.test.ts',
  'src/models/channelWorker.test.ts',
  'src/models/__tests__/channelDiscussion.test.ts',
  'src/models/__tests__/channelRead.test.ts',
];

// Enterprise migrations those suites apply, in order. The parent gate requires each
// one in its journal, so a fixture can never silently run against a partial schema.
export const enterpriseChannelMigrations = [
  '0009_channel_mvp',
  '0010_channel_attachments',
  '0017_channel_revision',
];
