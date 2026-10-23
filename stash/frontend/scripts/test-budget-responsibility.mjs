import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const output = mkdtempSync(join(tmpdir(), 'stash-budget-'));
try {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    'src/ha-api.ts', '--module', 'commonjs', '--target', 'ES2022',
    '--skipLibCheck', '--outDir', output], { stdio: 'inherit' });
  const { parseFinanceState } = createRequire(import.meta.url)(join(output, 'ha-api.js'));
  const parse = (attributes) => parseFinanceState({ states: {
    'sensor.finance_member': { entity_id: 'sensor.finance_member', state: '0', attributes: {
      member_id: 'alice', responsibility_pct: 60, responsible_amount: 300,
      responsible_amount_excluding_repayments: 250, ...attributes,
    } },
  } }).members[0];
  const budget = parse({ budget_responsible_amount: 600, budget_responsible_amount_excluding_repayments: 550 });
  assert.equal(budget.budgetResponsibleAmount, 600);
  assert.equal(budget.budgetResponsibleAmountExcludingRepayments, 550);
  assert.equal(budget.responsibleAmount, 300, 'bill responsibility stays separate');
  assert.equal(budget.responsibleAmountExcludingRepayments, 250);
  const zero = parse({ budget_responsible_amount: 0, budget_responsible_amount_excluding_repayments: 0 });
  assert.equal(zero.budgetResponsibleAmount, 0, 'a zero budget must not fall back to bills');
  assert.equal(zero.budgetResponsibleAmountExcludingRepayments, 0);
  const legacy = parse({});
  assert.equal(legacy.budgetResponsibleAmount, 300, 'older backend remains compatible');
  assert.equal(legacy.budgetResponsibleAmountExcludingRepayments, 250);
  console.log('Budget sensor parsing, bill separation, zero values and legacy compatibility passed.');
} finally {
  rmSync(output, { recursive: true, force: true });
}
