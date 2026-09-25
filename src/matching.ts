// Identity and category matching. Works locally from confirmed history — no external AI.
import { Category, Receipt, Rule, State, id, norm } from './model';

/** Words that never identify anyone on their own. */
const GENERIC = new Set([
  'UPI', 'PAYMENT', 'PAID', 'PAID VIA', 'BANK', 'NEFT', 'IMPS', 'RTGS', 'TRANSFER', 'SAHHO', 'CREDIT', 'DEBIT',
  'NULL', 'ATTN', 'CASH', 'DEPOSIT', 'SBI', 'FEDERAL BANK', 'HDFC', 'ICICI', 'AXIS', 'CANARA', 'MR', 'MRS', 'MS',
  'GIFT', 'SENT', 'SENT FROM PAYTM', 'NA', 'N A',
]);

const cleanName = (s: string) =>
  norm(s).replace(/^(MR|MRS|MS|DR)\.?\s+/, '').replace(/[^A-Z0-9 .&]/g, ' ').replace(/\s+/g, ' ').trim();

const usefulName = (s: string) => s.length >= 4 && !GENERIC.has(s) && /[A-Z]{3}/.test(s);

/** Extract identity signals from a bank narration. */
export function signals(narration: string): string[] {
  const n = norm(narration);
  const tokens: string[] = [];
  const upi = n.match(/UPI\/(?:CR|DR)\/[^/]*\/([^/]*)\/([^/]*)\/([^/]*)/);
  if (upi) {
    const vpa = upi[3].trim();
    if (vpa.includes('@') && vpa.replace(/[^A-Z0-9]/g, '').length >= 5) tokens.push(`UPI:${vpa}`);
    const name = cleanName(upi[1]);
    if (usefulName(name)) tokens.push(`SENDER:${name}`);
  }
  const neft = n.match(/NEFT\s*CR-[^-]*-[^-]*-([^-/]+)/);
  if (neft) { const name = cleanName(neft[1]); if (usefulName(name)) tokens.push(`SENDER:${name}`); }
  const imps = n.match(/IMPS-CREDIT([^-]+)-/) ?? n.match(/IMPS\/P2A\/[^/]*\/([^/]+)/);
  if (imps) { const name = cleanName(imps[1]); if (usefulName(name)) tokens.push(`SENDER:${name}`); }
  const acct = n.match(/\b(?:A\/C|ACCT|AC NO)\.?\s*(?:NO\.?)?\s*[X*]*(\d{4,})/);
  if (acct) tokens.push(`ACCT:${acct[1]}`);
  return [...new Set(tokens)];
}

export const senderOf = (narration: string) =>
  signals(narration).find(t => t.startsWith('SENDER:'))?.slice(7) ?? '';

export function ruleMatches(rule: Rule, narration: string, tokens = signals(narration)) {
  if (rule.token.startsWith('TEXT:')) return norm(narration).includes(rule.token.slice(5));
  return tokens.includes(rule.token);
}

/** Is a manual rule token specific enough to identify someone? */
export function validateToken(token: string): string | undefined {
  const t = norm(token);
  const body = t.replace(/^(TEXT|UPI|SENDER|ACCT):/, '');
  if (!/^(TEXT|UPI|SENDER|ACCT):/.test(t)) return 'Start the rule with UPI:, SENDER:, ACCT: or TEXT:.';
  if (body.length < 4 || GENERIC.has(body)) return 'Use a specific sender identifier, not a generic word.';
  return undefined;
}

/** Build candidate rules from confirmed history (identity for credits, category for debits). */
export function trainRules(s: State) {
  const identity = new Map<string, Map<string, string[]>>();
  const category = new Map<string, Map<Category, string[]>>();
  for (const r of s.receipts) {
    if (r.status !== 'confirmed') continue;
    for (const token of signals(r.narration)) {
      if (r.credit > 0 && r.memberId && (r.category === 'Member contribution' || r.category === 'Joining contribution')) {
        const byMember = identity.get(token) ?? new Map<string, string[]>();
        byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r.id]);
        identity.set(token, byMember);
      } else if (r.debit > 0 && r.category !== 'Unclassified' && r.category !== 'Refund / reversal') {
        const byCat = category.get(token) ?? new Map<Category, string[]>();
        byCat.set(r.category, [...(byCat.get(r.category) ?? []), r.id]);
        category.set(token, byCat);
      }
    }
  }
  const upsert = (token: string, target: { memberId?: string; category?: Category }, evidence: string[], validated: boolean, note: string) => {
    const existing = s.rules.find(r => r.token === token && r.memberId === target.memberId && r.category === target.category);
    if (existing) {
      existing.evidence = [...new Set([...existing.evidence, ...evidence])];
      if (existing.origin === 'history') { existing.validated = validated; existing.note = note; }
      return;
    }
    s.rules.push({ id: id(), token, ...target, enabled: true, evidence, validated, origin: 'history', note });
  };
  for (const [token, byMember] of identity) {
    const unique = byMember.size === 1;
    const strong = token.startsWith('UPI:') || token.startsWith('ACCT:');
    for (const [memberId, evidence] of byMember) {
      const validated = unique && evidence.length >= (strong ? 1 : 2);
      upsert(token, { memberId }, evidence, validated,
        unique ? `${evidence.length} confirmed payment(s) for this member only` : `Conflict: this sender has paid for ${byMember.size} members`);
    }
  }
  for (const [token, byCat] of category) {
    const unique = byCat.size === 1;
    for (const [cat, evidence] of byCat) {
      upsert(token, { category: cat }, evidence, unique && evidence.length >= 2,
        unique ? `${evidence.length} confirmed debit(s) with this category` : 'Conflict: payee used for several categories');
    }
  }
}

export interface MatchResult {
  memberId?: string;
  candidates: string[];
  reason: string;
  rules: string[];
}

/** Similarity between two person names (0..1), based on shared name tokens. */
export function nameSimilarity(a: string, b: string) {
  const ta = cleanName(a).split(' ').filter(x => x.length > 1);
  const tb = cleanName(b).split(' ').filter(x => x.length > 1);
  if (!ta.length || !tb.length) return 0;
  let hits = 0;
  for (const x of ta) if (tb.some(y => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y))))) hits++;
  return hits / Math.max(ta.length, tb.length);
}

export function fuzzyCandidates(s: State, narration: string): string[] {
  const n = norm(narration);
  const sender = senderOf(narration);
  const scored = s.members.map(m => {
    const names = [m.name, ...m.aliases];
    let score = 0;
    for (const name of names) {
      const nn = cleanName(name);
      if (nn.length >= 4 && new RegExp(`(^|[^A-Z])${nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z]|$)`).test(n)) score = Math.max(score, 0.9);
      if (sender) score = Math.max(score, nameSimilarity(sender, nn));
    }
    return { id: m.id, score };
  }).filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(x => x.id);
}

/** Identify the member a credit is for. Only a unique, validated, enabled rule auto-confirms. */
export function matchMember(s: State, r: Receipt): MatchResult {
  const tokens = signals(r.narration);
  const hits = s.rules.filter(x => x.enabled && x.memberId && ruleMatches(x, r.narration, tokens));
  const members = [...new Set(hits.map(x => x.memberId!))];
  const validated = hits.filter(x => x.validated);
  if (members.length === 1 && validated.length) {
    const evidence = new Set(hits.flatMap(x => x.evidence)).size;
    return {
      memberId: members[0], candidates: members, rules: hits.map(x => x.id),
      reason: `Matched by rule ${validated.map(x => x.token).join(', ')} (${evidence} supporting record${evidence === 1 ? '' : 's'})`,
    };
  }
  if (members.length > 1) {
    return { candidates: members, rules: hits.map(x => x.id), reason: 'Ambiguous third-party payment: this sender is linked to several members' };
  }
  if (members.length === 1) {
    return { candidates: members, rules: hits.map(x => x.id), reason: 'Sender seen before but the rule is not yet validated; please confirm' };
  }
  const candidates = fuzzyCandidates(s, r.narration);
  return { candidates, rules: [], reason: candidates.length ? 'Unknown sender; name similarity suggests a member — please confirm' : 'Unknown contributor' };
}

/** Pattern-based category for well-known bank entries. */
export function patternCategory(r: Pick<Receipt, 'narration' | 'credit' | 'debit'>, extra = ''): Category | undefined {
  const n = norm(`${r.narration} ${extra}`);
  if (/\bREFUND\b|\bREVERSAL\b|\bREVERSED\b|\bREV\b|\bRETURN(ED)?\b/.test(n)) return 'Refund / reversal';
  if (r.credit > 0 && /\bSBINT\b|INT\.?\s*PD|\bINTEREST\b|INT CREDIT/.test(n)) return 'Bank interest';
  if (r.debit > 0) {
    if (/\bRECHARGE\b/.test(n)) return 'Phone recharge';
    if (/\bCHARGES?\b|\bCHGS\b|\bSMS\b|\bGST\b|\bCESS\b|\bAMC\b|\bFEE\b|SHORT COLLECTION/.test(n)) return 'Bank charges';
    if (/\bCHARITY\b|\bMEDICINE|\bHOSPITAL\b/.test(n)) return 'Charity expenditure';
  }
  return undefined;
}

export function matchCategory(s: State, r: Receipt): { category?: Category; validated: boolean; rules: string[] } {
  const tokens = signals(r.narration);
  const hits = s.rules.filter(x => x.enabled && x.category && ruleMatches(x, r.narration, tokens));
  const cats = [...new Set(hits.map(x => x.category!))];
  if (cats.length === 1) return { category: cats[0], validated: hits.some(x => x.validated), rules: hits.map(x => x.id) };
  return { validated: false, rules: hits.map(x => x.id) };
}

/** Receipts a rule would match, and whether each agrees with the current assignment. */
export function testRule(s: State, rule: Rule) {
  return s.receipts
    .filter(r => (rule.memberId ? r.credit > 0 : r.debit > 0) && ruleMatches(rule, r.narration))
    .map(r => ({
      receipt: r,
      agrees: rule.memberId ? r.memberId === rule.memberId : r.category === rule.category,
      confirmed: r.status === 'confirmed',
    }));
}
