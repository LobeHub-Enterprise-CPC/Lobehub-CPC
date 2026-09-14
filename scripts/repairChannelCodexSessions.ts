import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { repairLegacyChannelCodexSessions } from '../packages/heterogeneous-agents/src/channel/repairCodexSessions.ts';

// Preview: node scripts/repairChannelCodexSessions.ts
// Apply:   node scripts/repairChannelCodexSessions.ts --apply
// Requires Node with node:sqlite and lsof. No model requests or turn replay.
const { values } = parseArgs({
  options: {
    'apply': { type: 'boolean', default: false },
    'codex-home': { type: 'string' },
  },
});
const result = await repairLegacyChannelCodexSessions({
  apply: values.apply,
  codexHome: values['codex-home'] || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
});
console.log(JSON.stringify(result, null, 2));
