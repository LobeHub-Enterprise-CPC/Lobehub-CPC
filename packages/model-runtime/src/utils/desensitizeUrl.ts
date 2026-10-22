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
        // super-linear backtracking shape. The prefix is everything up to the
        // last non-word character, so `api-example` keeps `api-` and
        // `example` keeps nothing.
        const label = hostnameParts[secondLevelDomainIndex];
        let lastNonWord = -1;
        for (let i = 0; i < label.length; i++) if (!/\w/.test(label[i])) lastNonWord = i;

        const tail = label.slice(lastNonWord + 1);
        if (tail.length >= 5) {
          hostnameParts[secondLevelDomainIndex] =
            `${label.slice(0, lastNonWord + 1)}${tail.slice(0, 2)}****${tail.slice(-2)}`;
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
