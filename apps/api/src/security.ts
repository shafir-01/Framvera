import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Money } from '@framvera/contracts';

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs = 60_000) {}
  allow(key: string, limit: number, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export class AiBudget {
  private day = '';
  private used = 0;
  constructor(public enabled: boolean, public limit: number) {}
  private roll() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }
  /** True and counts the call when live AI may be used right now. */
  take(): boolean {
    this.roll();
    if (!this.enabled || this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
  get usedToday() {
    this.roll();
    return this.used;
  }
}

export interface ApprovalClaim {
  kind: 'pay' | 'refund';
  /** The buyer session the approval was given in; agreement ids can repeat across sessions of the same market template. */
  market?: string;
  agreement: string;
  subject: string; // payee actor for pay, payment id for refund
  termsHash: string;
  amount: Money;
  nonce: string;
  exp: number;
}

export class Approvals {
  private secret: Buffer;
  constructor(secret: string) {
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
  }
  private sign(payload: string) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
  issue(c: Omit<ApprovalClaim, 'nonce' | 'exp'>, ttlMs = 15 * 60_000, now = Date.now()) {
    const claim: ApprovalClaim = { ...c, nonce: randomBytes(12).toString('hex'), exp: now + ttlMs };
    const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, claim };
  }
  verify(token: unknown, now = Date.now()): ApprovalClaim | null {
    if (typeof token !== 'string' || token.length > 2000) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const good = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
    try {
      const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ApprovalClaim;
      return c.exp > now ? c : null;
    } catch {
      return null;
    }
  }
}
