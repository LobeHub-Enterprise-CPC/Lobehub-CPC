const prefix = 'first-compression-hint:';
const changed = 'first-compression-hint-changed';
const fallback = new Map<string, string>();

function getPreference(topicId: string) {
  try {
    return localStorage.getItem(prefix + topicId) ?? fallback.get(topicId);
  } catch {
    return fallback.get(topicId);
  }
}

function setPreference(topicId: string, value: string) {
  try {
    localStorage.setItem(prefix + topicId, value);
  } catch {
    fallback.set(topicId, value);
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(changed));
}

export function rememberFirstCompression(topicId: string, groupId: string) {
  if (getPreference(topicId) === undefined) setPreference(topicId, groupId);
}

export function dismissFirstCompression(topicId: string) {
  setPreference(topicId, '');
}

export function shouldShowFirstCompression(firstGroup: string | undefined, groupId: string) {
  return !!firstGroup && firstGroup === groupId;
}

export function isFirstCompressionVisible(topicId: string | null | undefined, groupId: string) {
  return !!topicId && shouldShowFirstCompression(getPreference(topicId), groupId);
}

export function subscribeFirstCompression(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener('storage', listener);
  };
}
