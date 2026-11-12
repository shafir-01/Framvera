import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const patterns = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{40,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['PayPal client credential', /\b(?:PAYPAL_CLIENT_(?:ID|SECRET)|FRAMVERA_(?:ADMIN_TOKEN|APPROVAL_SECRET)|ANTHROPIC_API_KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/],
  ['PayPal Basic auth literal', /Basic\s+[A-Za-z0-9+/]{40,}={0,2}/],
];

const skip = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|db)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !skip.test(f));

const hits = [];
for (const f of files) {
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of patterns) if (re.test(line)) hits.push(`${f}:${i + 1}  ${name}`);
  });
}

if (hits.length) {
  console.error(`Secret scan failed: ${hits.length} match(es). Values are not printed.`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`Secret scan clean (${files.length} tracked files).`);
