'use client';

import { memo, type ReactNode, useCallback } from 'react';

import { PageEditor } from '@/features/PageEditor';
import { pageActions, pageSelectors, usePageStore } from '@/store/page';

interface PageExplorerProps {
  /** Forwarded to PageEditor. */
  fullWidthHeader?: boolean;
  /**
   * Custom header slot. `null` hides the editor header entirely; any node
   * replaces the built-in `<Header />`. Forwarded to PageEditor.
   */
  header?: ReactNode | null;
  pageId: string;
  /** Forwarded to PageEditor. Mobile has no room for the copilot / comments panel. */
  rightPanel?: boolean;
}

/**
 * Dedicated for the /page route
 *
 * Work together with a sidebar @/features/Pages/PageLayout/Body
 */
const PageExplorer = memo<PageExplorerProps>(({ pageId, header, fullWidthHeader, rightPanel }) => {
  const { revalidate: refreshPageDetail } = pageActions.useFetchPageDetail(pageId);
  const handleMetadataSaved = useCallback(() => {
    void Promise.all([refreshPageDetail(), pageActions.refreshDocuments()]).catch(() => {
      // The store reports read errors; a failed refresh must not reject a completed save.
    });
  }, [refreshPageDetail]);

  // Get document title and emoji from PageStore
  const document = usePageStore(pageSelectors.getDocumentById(pageId));
  const title = document?.title;
  const emoji = document?.metadata?.emoji as string | undefined;

  return (
    <PageEditor
      emoji={emoji}
      fullWidthHeader={fullWidthHeader}
      header={header}
      key={pageId}
      pageId={pageId}
      rightPanel={rightPanel}
      title={title}
      onEmojiChange={handleMetadataSaved}
      onTitleChange={handleMetadataSaved}
    />
  );
});

export default PageExplorer;
