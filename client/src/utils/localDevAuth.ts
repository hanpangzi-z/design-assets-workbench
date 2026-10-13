/** The server still confirms a real existing user; this only enables local bootstrap. */
export function isLocalDevNoLogin(): boolean {
  if (!import.meta.env.DEV || import.meta.env.VITE_LOCAL_DEV_NO_LOGIN === '0' || typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname.toLowerCase());
}
