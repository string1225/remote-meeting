import { timingSafeEqual } from 'node:crypto';

export function authenticateAgent(authorization, key) {
  const expected = `Bearer ${key}`;
  return typeof authorization === 'string' && Buffer.byteLength(authorization) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}
