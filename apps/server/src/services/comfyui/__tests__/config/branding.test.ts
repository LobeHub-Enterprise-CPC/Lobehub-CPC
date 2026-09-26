// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { getWorkflowFilenamePrefix } from '../../utils/workflowUtils';

vi.mock('@lobechat/business-const', () => ({ BRANDING_NAME: 'Private Workspace' }));
it.each(['buildFluxDevWorkflow', 'buildSimpleSDWorkflow', 'unknown'])(
  'brands new output filenames for %s',
  (workflow) => {
    const prefix = getWorkflowFilenamePrefix(workflow);
    expect(prefix).toMatch(/^Private Workspace\//);
    expect(prefix).not.toMatch(/LobeChat|LobeHub/);
  },
);
