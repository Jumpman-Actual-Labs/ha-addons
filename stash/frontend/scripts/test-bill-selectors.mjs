import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const output = mkdtempSync(join(tmpdir(), 'stash-selectors-'));
try {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    'src/bill-selectors.ts', '--module', 'commonjs', '--target', 'ES2022',
    '--skipLibCheck', '--outDir', output], { stdio: 'inherit' });
  const { remainingForBill, isOverdue, dueOrder, compareBills, lastPaymentDate, groupBillSeries, outstandingInSeries, recentSeriesPayments, seriesPayTo } = createRequire(import.meta.url)(join(output, 'bill-selectors.js'));
  const bill = { name: 'Internet', amount: 125, status: 'partially_paid', dueDate: '2026-09-10', payments: [{ total: 40 }] };
  assert.equal(remainingForBill(bill), 85, 'partial payment is deducted from fee-inclusive total');
  assert.equal(remainingForBill({ ...bill, status: 'paid' }), 0);
  assert.equal(remainingForBill({ ...bill, payments: [{ total: 200 }] }), 0);
  assert.equal(remainingForBill({ ...bill, amount: 0.3, payments: [{ total: 0.1 }] }), 0.2);
  assert.equal(isOverdue(bill, '2026-09-11'), true);
  assert.equal(isOverdue(bill, '2026-09-10'), false, 'due today is not overdue');
  assert.equal(isOverdue({ ...bill, status: 'deferred' }, '2026-09-11'), false);
  assert.equal(isOverdue({ ...bill, status: 'paid' }, '2026-09-11'), false);
  assert.equal(isOverdue({ ...bill, payments: [{ total: 125 }] }, '2026-09-11'), false);
  assert.equal(isOverdue({ ...bill, dueDate: '2026-08-10' }, '2026-09-11'), true, 'old unpaid bills remain visible');
  const sorted = [{ ...bill, name: 'Z' }, { ...bill, name: 'A' }, { ...bill, name: 'Old', dueDate: '2026-08-10' }].sort(dueOrder);
  assert.deepEqual(sorted.map(b => b.name), ['Old', 'A', 'Z']);
  console.log('11 payment selector regression checks passed.');
  const fixtures = [
    {...bill,billId:'a',name:'alpha',payTo:'Zeta',payments:[{date:'2026-09-20',total:30},{date:'2026-09-05',total:10}]},
    {...bill,billId:'b',name:'Beta',payTo:'acme',amount:200,status:'paid',payments:[{date:'2026-09-15',total:200}]},
    {...bill,billId:'c',name:'gamma',payTo:'',amount:100,payments:[],dueDate:'2026-09-01'},
  ];
  const order = (key,direction) => [...fixtures].sort((a,b)=>compareBills(a,b,key,direction)).map(b=>b.billId);
  assert.equal(lastPaymentDate(fixtures[0]),'2026-09-20');
  assert.deepEqual(order('paidDate','desc'),['a','b','c']);
  assert.deepEqual(order('paidDate','asc'),['b','a','c']);
  assert.deepEqual(order('dueDate','asc'),['c','a','b']);
  assert.deepEqual(order('dueDate','desc'),['a','b','c']);
  assert.deepEqual(order('name','asc'),['a','b','c']);
  assert.deepEqual(order('name','desc'),['c','b','a']);
  assert.deepEqual(order('payTo','asc'),['b','a','c']);
  assert.deepEqual(order('payTo','desc'),['a','b','c']);
  assert.deepEqual(order('amountDue','asc'),['b','a','c']);
  assert.deepEqual(order('amountDue','desc'),['c','a','b']);
  assert.equal(lastPaymentDate({...fixtures[1],payments:[]}), '');
  assert.deepEqual(fixtures.map(b=>b.billId),['a','b','c']);
  console.log('All five bill sort keys, both directions, partial payments and missing dates/payees passed.');
  const occ = (id, dueDate, status, extra = {}) => ({ billId: id, name: 'Power', payTo: '', categoryId: 'util', amount: 100, status,
    dueDate, month: dueDate.slice(0, 7), recurringParentId: 'p1', payments: [], ...extra });
  const pay = (date, total) => ({ date, total });
  const power = [
    occ('p1', '2026-07-22', 'paid', { recurringParentId: null, payTo: 'Duke Energy', payments: [pay('2026-07-20', 100)] }),
    occ('p2', '2026-08-22', 'paid', { payments: [pay('2026-08-21', 100)] }),
    occ('p3', '2026-09-22', 'paid', { payments: [pay('2026-09-25', 100)] }),
    occ('p4', '2026-10-22', 'unpaid'),
    occ('p5', '2026-11-22', 'unpaid'),
    // Re-entered by hand: new lineage, same name and category.
    occ('dup', '2026-10-31', 'unpaid', { recurringParentId: null, name: ' power ', payTo: 'Duke Energy' }),
  ];
  const water = occ('w1', '2026-10-30', 'unpaid', { name: 'Water', recurringParentId: null });
  const otherCat = occ('o1', '2026-10-22', 'unpaid', { categoryId: 'other', recurringParentId: null });
  const series = groupBillSeries([...power, water, otherCat], '2026-10');
  assert.equal(series.length, 3, 'one series per bill, same name in another category stays separate');
  const p = series.find(s => s.bills.some(b => b.billId === 'p1'));
  assert.equal(p.bills.length, 6);
  assert.equal(p.focus.billId, 'p4', 'overdue occurrence is the row, not the next one');
  assert.deepEqual(outstandingInSeries(p).map(b => b.billId), ['p4', 'dup', 'p5']);
  assert.deepEqual(recentSeriesPayments(p).map(x => x.bill.billId), ['p3', 'p2', 'p1'], 'last 3 payments, newest first');
  assert.equal(seriesPayTo(p), 'Duke Energy', 'payee falls back to another occurrence');
  const caughtUp = groupBillSeries(power.slice(0, 3).concat(occ('p4', '2026-10-22', 'paid'), occ('p5', '2026-11-22', 'unpaid')), '2026-10')[0];
  assert.equal(caughtUp.focus.billId, 'p4', 'all paid this month: show this month, not next');
  console.log('Bill series grouping checks passed.');
} finally {
  rmSync(output, { recursive: true, force: true });
}
