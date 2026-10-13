import type { Request } from 'express';

const LOOPBACK_AUTHORITY = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i;

function isLoopbackAuthority(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = LOOPBACK_AUTHORITY.exec(value);
  return !!match && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535));
}

function isLoopbackOrigin(value: unknown) {
  if (typeof value !== 'string') return false;
  const match = /^https?:\/\/([^/?#]+)\/?$/i.exec(value);
  if (!match || !isLoopbackAuthority(match[1])) return false;
  try {
    const origin = new URL(value);
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && !origin.username && !origin.password;
  } catch {
    return false;
  }
}

export function canUseLocalDevelopmentAuth(req: Pick<Request, 'headers' | 'socket'>) {
  if (process.env.NODE_ENV !== 'development' || process.env.LOCAL_DEV_NO_LOGIN !== '1') return false;
  const address = req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (!isLoopbackAuthority(req.headers.host)) return false;
  return req.headers.origin === undefined || isLoopbackOrigin(req.headers.origin);
}
