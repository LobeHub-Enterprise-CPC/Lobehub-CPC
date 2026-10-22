export const desensitizeUrl = (url: string) => {
  try {
    const urlObj = new URL(url);
    const hostnameParts = urlObj.hostname.split('.');
    const port = urlObj.port;

    // Desensitize domain only if there are at least two parts (example.com)
    if (hostnameParts.length > 1) {
      // Desensitize the second level domain (second part from the right)
      // Special case for short domain names
      const secondLevelDomainIndex = hostnameParts.length - 2;
      if (hostnameParts[secondLevelDomainIndex].length < 5) {
        hostnameParts[secondLevelDomainIndex] = '***';
      } else {
        // Slice rather than match: a lazy prefix next to `\w+` is a
        // super-linear backtracking shape, and the shape here is fixed.
        const label = hostnameParts[secondLevelDomainIndex];
        const tail = label.slice(-4);
        if (/^\w{4}$/.test(tail)) {
          hostnameParts[secondLevelDomainIndex] =
            `${label.slice(0, -4)}${tail.slice(0, 2)}****${tail.slice(2)}`;
        }
      }
    }

    // Join the hostname parts back together
    const desensitizedHostname = hostnameParts.join('.');

    // Desensitize port if present
    const desensitizedPort = port ? ':****' : '';

    // Reconstruct the URL with the desensitized parts
    return `${urlObj.protocol}//${desensitizedHostname}${desensitizedPort}${urlObj.pathname}${urlObj.search}`;
  } catch {
    // If the URL is invalid, return the original URL
    return url;
  }
};
