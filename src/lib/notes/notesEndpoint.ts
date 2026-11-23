/** A loopback, LAN or address in the shared-address range used by private VPNs. */
function privateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  const [first, second] = host.split('.').map(Number);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return first === 127 || first === 10 || (first === 192 && second === 168)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 100 && second >= 64 && second <= 127);
  }
  return /^\[f[cd][0-9a-f]{2}:/i.test(host);
}

export function notesEndpointOf(baseUrl: string): string | null {
  if (!baseUrl.trim() || baseUrl.length > 2048) return null;
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost(url.hostname))) return null;
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
    return url.href;
  } catch {
    return null;
  }
}
