import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Test and end-to-end helper only: approves a PayPal sandbox order as the sandbox test buyer,
 * the same way a person would on PayPal's sandbox checkout pages. Never used on the product path,
 * where the buyer approves in their own browser. Refuses any host other than PayPal sandbox.
 */
export interface SandboxApproval {
  /** The browser flow ran to the end. Whether the order is approved is decided only by GET /v2/checkout/orders/{id}. */
  completed: boolean;
  steps: string[];
  finalHost?: string;
}

const SANDBOX_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com']);

async function clickFirst(page: Page, selectors: string[], timeout = 4000): Promise<string | undefined> {
  for (const s of selectors) {
    const el = page.locator(s).first();
    try {
      await el.waitFor({ state: 'visible', timeout });
      await el.click();
      return s;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

export async function approveWithSandboxBuyer(
  approveUrl: string,
  opts: { env?: Record<string, string | undefined>; headless?: boolean; timeoutMs?: number; debugDir?: string } = {},
): Promise<SandboxApproval> {
  const env = opts.env ?? process.env;
  const url = new URL(approveUrl);
  if (url.protocol !== 'https:' || !SANDBOX_HOSTS.has(url.hostname)) throw new Error('approveWithSandboxBuyer only opens PayPal sandbox checkout pages.');
  const email = env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error('PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD must be set.');

  const steps: string[] = [];
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 45000);
  const shot = async (name: string) => {
    if (!opts.debugDir) return;
    mkdirSync(opts.debugDir, { recursive: true });
    await page.screenshot({ path: join(opts.debugDir, `${Date.now()}-${name}.png`) }).catch(() => undefined);
  };
  try {
    await page.goto(approveUrl, { waitUntil: 'domcontentloaded' });
    steps.push('checkout-opened');
    await clickFirst(page, ['#acceptAllButton', 'button#accept-cookies'], 3000);

    if (!(await visible(page, '#email', 15000))) {
      await clickFirst(page, ['a:has-text("Log In")', 'button:has-text("Log In")', '[data-testid="login-button"]'], 5000);
    }
    await page.locator('#email').first().fill(email);
    steps.push('email-entered');
    const split = await clickFirst(page, ['#btnNext', 'button:has-text("Next")'], 5000);
    if (split) steps.push('next');
    await page.locator('#password').first().waitFor({ state: 'visible' });
    await page.locator('#password').first().fill(password);
    await clickFirst(page, ['#btnLogin', 'button:has-text("Log In")'], 8000);
    steps.push('logged-in');
    await clickFirst(page, ['#acceptAllButton'], 2000);
    await shot('after-login');

    const payButtons = [
      '[data-testid="submit-button-initial"]',
      '#payment-submit-btn',
      'button:has-text("Complete Purchase")',
      'button:has-text("Pay Now")',
      'button:has-text("Continue to Review Order")',
      'button:has-text("Continue")',
      'button:has-text("Agree & Pay")',
    ];
    const clicked = await clickFirst(page, payButtons, 20000);
    if (!clicked) {
      await shot('no-pay-button');
      throw new Error('Could not find the approval button on PayPal sandbox checkout.');
    }
    steps.push('pay-clicked');
    await page
      .waitForURL((u) => !SANDBOX_HOSTS.has(u.hostname), { timeout: opts.timeoutMs ?? 45000 })
      .then(() => steps.push('left-paypal'))
      .catch(() => steps.push('still-on-paypal'));
    await shot('done');
    return { completed: true, steps, finalHost: safeHost(page.url()) };
  } catch (e) {
    await shot('error');
    const msg = (e as Error).message.split('\n')[0]!.split(email).join('[redacted]').split(password).join('[redacted]').slice(0, 160);
    return { completed: false, steps: [...steps, `error:${msg}`], finalHost: safeHost(page.url()) };
  } finally {
    await browser.close();
  }
}

function safeHost(u: string): string | undefined {
  try {
    return new URL(u).hostname;
  } catch {
    return undefined;
  }
}
