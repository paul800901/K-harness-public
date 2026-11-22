export function mobileLoginUrl(provider, value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const allowed =
      provider === 'gemini'
        ? url.hostname === 'accounts.google.com' && ['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname)
        : provider === 'grok'
          ? url.hostname === 'accounts.x.ai' && url.pathname === '/oauth2/device'
          : provider === 'codex' && url.hostname === 'auth.openai.com' && url.pathname === '/codex/device';
    return allowed ? url.href : null;
  } catch {
    return null;
  }
}
