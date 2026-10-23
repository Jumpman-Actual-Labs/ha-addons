import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const output = mkdtempSync(join(tmpdir(), 'stash-period-'));
try {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), 'src/pay-period.ts', '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', '--outDir', output], { stdio: 'inherit' });
  const { payDates, balanceResponsibilities, periodPlan, cushionFlow, incomeBetween, budgetFunding, periodPayments } = createRequire(import.meta.url)(join(output, 'pay-period.js'));
  const member = { memberId:'m1', name:'Jordan', income: 6000, payFrequency: 'semi_monthly', payDays: [1, 15], payAnchorDate: null };
  const fundingMember = {...member, income:10195.98, budgetResponsibleAmount:10432.62};
  const funding = budgetFunding(fundingMember, '2026-10-15', '2026-11-01');
  assert.equal(funding.deposit,5097.99);
  assert.equal(funding.target,5216.31);
  assert.equal(funding.shortfall,118.32);
  assert.equal(funding.monthlyShortfall,236.64);
  assert.equal(budgetFunding(fundingMember,'2026-10-15','2026-11-01',1000).deposit,4097.99);
  assert.equal(budgetFunding({...member,budgetResponsibleAmount:3000},'2026-10-15','2026-11-01').deposit,1500);
  assert.equal(budgetFunding({...member,income:0,budgetResponsibleAmount:3000},'2026-10-15','2026-11-01').shortfall,1500);
  assert.equal(budgetFunding({...member,budgetResponsibleAmount:3000},'2026-10-02','2026-10-14').deposit,0);
  for (const [payFrequency, multiplier] of [['weekly',52/12],['biweekly',26/12],['monthly',1]]) {
    const scheduled = {...member,payFrequency,payAnchorDate:'2026-10-01',budgetResponsibleAmount:3000};
    assert.equal(budgetFunding(scheduled,'2026-10-01','2026-10-02').deposit,Math.round(3000/multiplier*100)/100);
  }
  const paymentBills = [{payments:[{date:'2026-10-01',contributions:[{memberId:'m1',amount:900}]},{date:'2026-10-15',contributions:[{memberId:'m1',amount:100},{memberId:'m2',amount:500}]}]}];
  assert.equal(periodPayments(member,paymentBills,'2026-10-15','2026-11-01'),100,'credit only own contributions dated within viewed period');
  assert.deepEqual(payDates(member, '2026-09-01', '2026-10-01'), ['2026-09-01', '2026-09-15']);
  assert.deepEqual(payDates({...member,payFrequency:'monthly',payDays:[31]}, '2026-02-01', '2026-03-01'), ['2026-02-28']);
  assert.deepEqual(payDates({...member,payFrequency:'biweekly',payAnchorDate:'2026-09-11'}, '2026-09-01', '2026-10-01'), ['2026-09-11','2026-09-25']);
  assert.deepEqual(payDates({...member,payFrequency:'monthly',payDays:[]}, '2026-09-01', '2026-10-01'), ['2026-09-01']);
  assert.deepEqual(balanceResponsibilities(1000,2000), {current:1000,next:2000,transfer:500,currentAfter:1500,nextAfter:1500});
  assert.equal(balanceResponsibilities(2000,1000).transfer,0);
  assert.equal(balanceResponsibilities(1000,1000).transfer,0);
  assert.equal(balanceResponsibilities(0,200).transfer,100);
  const bill = (id, dueDate, amount, status='unpaid', payments=[]) => ({billId:id,name:id,dueDate,amount,status,payments,responsibility:{m1:amount},responsibleMemberId:null});
  const data = { members:[member], cashInfusions:[], bills:[bill('old-paid','2026-09-05',500,'paid'),bill('carry','2026-09-06',100),bill('partial','2026-09-20',125,'partially_paid',[{total:40}]),bill('paid','2026-09-16',300,'paid'),bill('next','2026-10-01',1500),{...bill('deferred','2026-09-07',200,'deferred'),deferredUntil:'2026-10-04'}] };
  const plan = periodPlan(data,'2026-09-24');
  assert.equal(plan.start,'2026-09-15'); assert.equal(plan.end,'2026-10-01'); assert.equal(plan.nextEnd,'2026-10-15');
  assert.equal(plan.total,525); assert.equal(plan.paid,340); assert.equal(plan.remaining,185);
  assert.equal(plan.carryoverTotal,100); assert.equal(plan.nextTotal,1700);
  assert.equal(plan.balance.transfer,587.5);
  assert.equal(periodPlan(data,'2026-10-01').start,'2026-10-01','payday belongs to new period');
  assert.equal(periodPlan({...data,members:[]},'2026-09-24'),null);
  const staggered = periodPlan({...data,members:[member,{...member,memberId:'m2',payDays:[5,20]}]},'2026-09-24');
  assert.equal(staggered.start,'2026-09-15'); assert.equal(staggered.end,'2026-10-01');
  const extra = periodPlan({...data,cashInfusions:[{date:'2026-09-20',amount:200}]},'2026-09-24');
  assert.deepEqual(extra.balance,plan.balance,'cash infusions do not fund a cushion');
  const rich = periodPlan({...data,members:[{...member,income:600000}],savings:{amount:90000,depositedMonth:50000}},'2026-09-24');
  assert.equal(rich.balance.transfer,plan.balance.transfer,'even income and savings/Stash changes do not move the cushion');
  const other = {...member,memberId:'m2',name:'Alex'};
  const owned = {...bill('personal','2026-10-01',1000),responsibleMemberId:'m1',responsibility:{m1:500,m2:500}};
  const personalPlan = periodPlan({...data,members:[member,other],bills:[owned]},'2026-09-24');
  assert.equal(personalPlan.cushionMembers[0].transfer,500);
  assert.equal(personalPlan.cushionMembers[1].next,0);
  assert.equal(personalPlan.cushionMembers[1].transfer,0,'another member never funds a personal bill');
  const opposing = periodPlan({...data,members:[member,other],bills:[owned,{...bill('other','2026-09-20',2000),responsibleMemberId:'m2'}]},'2026-09-24');
  assert.equal(opposing.balance.transfer,500,'one member surplus cannot cancel another member cushion');
  assert.equal(opposing.cushionMembers[1].transfer,0);
  const flowData = { members:[member], cashInfusions:[], bills:[bill('p1','2026-09-05',400,'paid'),bill('c1','2026-09-20',1000,'paid'),bill('n1','2026-10-05',1800)] };
  const flowPlan = periodPlan(flowData,'2026-09-24');
  const flow = cushionFlow(flowData,flowPlan);
  assert.equal(flowPlan.balance.transfer,400,'to save this period');
  assert.equal(flow.previous.balance.transfer,300,'cushion carried in from last period');
  assert.equal(flow.following.balance.transfer,0,'next period has nothing heavier ahead');
  // Uneven income: primary pays 1st+15th, a second source pays only on the 1st,
  // so the 1st-14th period has more money coming in than the 15th-end period.
  const uneven = { ...member, income: 10000, incomeSources: [
    { id:'a', name:'Primary', amount:6000, payFrequency:'semi_monthly', payDays:[1,15], payAnchorDate:null },
    { id:'b', name:'VA', amount:2800, payFrequency:'monthly', payDays:[1], payAnchorDate:null },
  ] };
  const unevenData = { members:[uneven], cashInfusions:[], bills:[bill('x','2026-10-05',3000),bill('y','2026-10-20',3000)] };
  const sourceFunding = budgetFunding({...uneven,income:8800,budgetResponsibleAmount:4400},'2026-10-01','2026-10-15');
  assert.equal(sourceFunding.deposit,2900,'all sources landing in the period fund the target');
  const mixed = {...member,incomeSources:[
    {amount:4000,payFrequency:'weekly',payDays:[],payAnchorDate:'2026-10-02'},
    {amount:2000,payFrequency:'monthly',payDays:[1],payAnchorDate:null},
  ]};
  const mixedPlan = periodPlan({...data,members:[mixed]},'2026-10-03');
  assert.equal(mixedPlan.start,'2026-10-02');
  assert.equal(mixedPlan.end,'2026-10-09','monthly source must not stretch weekly member periods');
  const missingSourceSchedule = {...member,incomeSources:[{amount:6000,payFrequency:'weekly',payDays:[],payAnchorDate:null}]};
  assert.equal(periodPlan({...data,members:[missingSourceSchedule]},'2026-10-20').start,'2026-10-15','member schedule fallback remains usable');
  const early = periodPlan(unevenData,'2026-10-05');
  assert.equal(early.cushionMembers[0].currentIncome,5800,'both paychecks land on the 1st');
  assert.equal(early.cushionMembers[0].nextIncome,3000,'only the primary pays on the 15th');
  assert.equal(early.balance.transfer,1400,'equal bills, but the later period has 2800 less income: save half');
  assert.equal(periodPlan(unevenData,'2026-10-20').balance.transfer,0,'tighter period has nothing to set aside');
  assert.equal(incomeBetween(uneven,'2026-10-01','2026-11-01'),8800,'a month of paychecks');
  console.log('Pay-period boundaries, partial payments, carryover, deferrals, schedules, individual ownership and responsibility-only cushion checks passed.');
} finally { rmSync(output, { recursive:true, force:true }); }
