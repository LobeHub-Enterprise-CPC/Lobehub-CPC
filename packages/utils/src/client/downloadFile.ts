export const downloadFile = async (
  url: string,
  fileName: string,
  fallbackToOpen: boolean = true,
) => {
  try {
    // Use better CORS handling similar to download-image.ts
    const response = await fetch(url, {
      // Avoid image disk cache which can cause incorrect CORS headers
      cache: 'no-store',

      // Same-origin links (the authenticated `/f/:id` proxy) need the session;
      // cross-origin storage URLs stay credential-free so wildcard CORS still works.
      credentials: 'same-origin',

      mode: 'cors',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();

    // Create download link
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    link.style.display = 'none';

    // Trigger download
    document.body.append(link);
    link.click();

    // Cleanup
    link.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (error) {
    console.warn('Download failed:', error);

    // Fallback: open in new tab if enabled
    if (fallbackToOpen) {
      window.open(url);
    } else {
      // Re-throw the error if fallback is disabled
      throw error;
    }
  }
};
