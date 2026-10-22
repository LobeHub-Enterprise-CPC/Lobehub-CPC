import { describe, expect, it } from 'vitest';

import { resolveItemRights } from './itemRights';

describe('resolveItemRights', () => {
  describe('in an organization document', () => {
    it('follows what Market granted for the item', () => {
      expect(resolveItemRights({ canEdit: true, canUnpublish: false }, false, true)).toEqual({
        canEdit: true,
        canUnpublish: false,
      });
    });

    // The author's own page is "owned" by them, but the item may belong to
    // content they did not create.
    it('does not let the profile owner stand in for a grant', () => {
      expect(resolveItemRights({ canEdit: false, canUnpublish: false }, true, true)).toEqual({
        canEdit: false,
        canUnpublish: false,
      });
    });

    it('grants nothing when the fields are missing', () => {
      expect(resolveItemRights({}, true, true)).toEqual({ canEdit: false, canUnpublish: false });
    });

    it('does not read a non-boolean as a grant', () => {
      expect(
        resolveItemRights({ canEdit: 'true' as never, canUnpublish: 1 as never }, true, true),
      ).toEqual({ canEdit: false, canUnpublish: false });
    });
  });

  describe('without a tenant', () => {
    it('keeps the profile-owner rule', () => {
      expect(resolveItemRights({}, true, false)).toEqual({ canEdit: true, canUnpublish: true });
      expect(resolveItemRights({ canEdit: true }, false, false)).toEqual({
        canEdit: false,
        canUnpublish: false,
      });
    });
  });
});
