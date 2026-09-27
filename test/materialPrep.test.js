'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

const BASE = { totalPages: 16, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const PREP = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };

test('未启用备料：响应不含 materialPrep 字段（原响应完全不变）', () => {
  const r = computeImposition({ ...BASE });
  assert.equal(r.materialPrep, undefined);
  const explicitOff = computeImposition({ ...BASE, materialPrep: false });
  assert.equal(explicitOff.materialPrep, undefined);
  const nullOff = computeImposition({ ...BASE, materialPrep: null });
  assert.equal(nullOff.materialPrep, undefined);
  const disabledObj = computeImposition({ ...BASE, materialPrep: { enabled: false, ...PREP } });
  assert.equal(disabledObj.materialPrep, undefined);
});

test('逐帖净用纸 / 需领纸：固定分帖 2 帖各 2 张，份数 1000，开机 10，损耗率 3%', () => {
  const r = computeImposition({ ...BASE, materialPrep: PREP });
  const mp = r.materialPrep;
  assert.equal(mp.enabled, true);
  assert.equal(mp.signatures.length, 2);
  mp.signatures.forEach((row) => {
    assert.equal(row.actualSheetCount, 2);
    assert.equal(row.netSheets, 2000);
    assert.equal(row.makereadySheets, 10);
    // ceil(2010 / 0.97) = ceil(2072.16) = 2073
    assert.equal(row.requiredSheets, 2073);
    assert.equal(row.processWaste, 63); // 2073 - 2000 - 10
    assert.equal(row.totalWaste, 73);
  });
  // 汇总逐帖取整后的值：4146 张，禁止先合并各帖再算损耗
  // （若先合并：ceil((4000 + 10)/0.97) = ceil(4134.02) = 4135，结果不同）
  const t = mp.totals;
  assert.equal(t.netSheets, 4000);
  assert.equal(t.makereadySheets, 20);
  assert.equal(t.processWaste, 126);
  assert.equal(t.totalWaste, 146);
  assert.equal(t.requiredSheets, 4146);
  // 整包向上采购：ceil(4146 / 500) = 9 包 = 4500 张，包余 354
  assert.equal(t.purchasePacks, 9);
  assert.equal(t.sheetsPerPack, 500);
  assert.equal(t.purchaseSheets, 4500);
  assert.equal(t.packRemainder, 354);
});

test('禁止先合并各帖：每帖不同张数时逐帖取整与合并取整结果明确不同', () => {
  // 17 页、每帖上限 2 张、均衡分帖 -> 各帖实际 [2, 2, 1] 张
  const prep = { copies: 10, makereadySheets: 0, processWasteRate: 0.1, sheetsPerPack: 100 };
  const r = computeImposition({ ...BASE, totalPages: 17, balancedSplit: true, materialPrep: prep });
  const rows = r.materialPrep.signatures;
  assert.deepEqual(rows.map((x) => x.actualSheetCount), [2, 2, 1]);
  // 净用纸：20 / 20 / 10；ceil(20/0.9)=23、ceil(20/0.9)=23、ceil(10/0.9)=12
  assert.deepEqual(rows.map((x) => x.netSheets), [20, 20, 10]);
  assert.deepEqual(rows.map((x) => x.requiredSheets), [23, 23, 12]);
  // 逐帖汇总 = 58；若先合并：ceil(50/0.9) = ceil(55.56) = 56
  assert.equal(r.materialPrep.totals.requiredSheets, 58);
  // ceil(58 / 100) = 1 包
  assert.equal(r.materialPrep.totals.purchasePacks, 1);
  assert.equal(r.materialPrep.totals.purchaseSheets, 100);
  assert.equal(r.materialPrep.totals.packRemainder, 42);
});

test('开机损耗每帖分别加一次：帖数越多开机损耗合计越大', () => {
  // 16 页、每帖 1 张 -> 4 帖，每帖 4 页（1 张）
  const prep = { copies: 100, makereadySheets: 5, processWasteRate: 0, sheetsPerPack: 50 };
  const r = computeImposition({ ...BASE, sheetsPerSignature: 1, materialPrep: prep });
  assert.equal(r.materialPrep.signatures.length, 4);
  r.materialPrep.signatures.forEach((row) => {
    assert.equal(row.netSheets, 100);
    assert.equal(row.makereadySheets, 5);
    assert.equal(row.requiredSheets, 105); // 损耗率 0 时净用纸 + 开机损耗
    assert.equal(row.processWaste, 0);
  });
  const t = r.materialPrep.totals;
  assert.equal(t.makereadySheets, 20); // 4 帖 × 5
  assert.equal(t.netSheets, 400);
  assert.equal(t.requiredSheets, 420);
  assert.equal(t.purchasePacks, 9); // ceil(420/50)
  assert.equal(t.purchaseSheets, 450);
});

test('恰好整包：包余为 0', () => {
  const prep = { copies: 100, makereadySheets: 0, processWasteRate: 0, sheetsPerPack: 200 };
  const r = computeImposition({ ...BASE, materialPrep: prep });
  // 2 帖 × 2 张 × 100 = 400 张
  assert.equal(r.materialPrep.totals.requiredSheets, 400);
  assert.equal(r.materialPrep.totals.purchasePacks, 2);
  assert.equal(r.materialPrep.totals.purchaseSheets, 400);
  assert.equal(r.materialPrep.totals.packRemainder, 0);
});

test('浮点边界：可整除的过程损耗率不产生多取一张', () => {
  // 97 页、每帖 1 张 -> 25 帖各 1 张；份数 97 -> 每帖净用纸 97。
  // 97 / 0.97 在浮点下为 100.00000000000001，朴素 ceil 会错取 101，ceilInt 须归整为 100。
  const prep = { copies: 97, makereadySheets: 0, processWasteRate: 0.03, sheetsPerPack: 500 };
  const r = computeImposition({
    totalPages: 97, sheetsPerSignature: 1, binding: 'left', flip: 'short',
    materialPrep: prep,
  });
  assert.equal(r.signatureCount, 25);
  r.materialPrep.signatures.forEach((row) => {
    assert.equal(row.actualSheetCount, 1);
    assert.equal(row.netSheets, 97);
    assert.equal(row.requiredSheets, 100);
  });
  assert.equal(r.materialPrep.totals.requiredSheets, 2500);
});

test('章节优先分帖：按各帖实际张数备料', () => {
  // 20 页、上限 2 张、章节 [1, 9, 14, 18] -> [2, 2, 2] 张（含章末补白）
  const prep = { copies: 10, makereadySheets: 2, processWasteRate: 0.05, sheetsPerPack: 100 };
  const r = computeImposition({
    ...BASE,
    totalPages: 20,
    chapterSplit: true,
    chapterStarts: [1, 9, 14, 18],
    materialPrep: prep,
  });
  const mp = r.materialPrep;
  assert.deepEqual(mp.signatures.map((x) => x.actualSheetCount), [2, 2, 2]);
  mp.signatures.forEach((row) => {
    assert.equal(row.netSheets, 20);
    // ceil((20 + 2) / 0.95) = ceil(23.16) = 24
    assert.equal(row.requiredSheets, 24);
  });
  assert.equal(mp.totals.requiredSheets, 72);
});

test('备料参数非法返回明确错误', () => {
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 } }),
    /成品份数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { copies: 0, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 } }),
    /成品份数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { copies: 10, makereadySheets: -1, processWasteRate: 0.03, sheetsPerPack: 500 } }),
    /开机损耗/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: 1, sheetsPerPack: 500 } }),
    /过程损耗率/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: -0.01, sheetsPerPack: 500 } }),
    /过程损耗率/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: 0.03, sheetsPerPack: 0 } }),
    /每包张数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, materialPrep: 'x' }),
    /materialPrep 必须为对象/
  );
});

test('过程损耗率接受数字字符串（表单风格）', () => {
  const r = computeImposition({
    ...BASE,
    materialPrep: { copies: 1000, makereadySheets: '10', processWasteRate: '0.03', sheetsPerPack: '500' },
  });
  assert.equal(r.materialPrep.enabled, true);
  assert.equal(r.materialPrep.totals.requiredSheets, 4146);
});

test('极小损耗率不预舍入：净用纸 1 张、开机 0、率 1e-10 时须向上取整为 2 张', () => {
  // 旧实现先按 9 位小数归整：(1/0.9999999999) 被抹成 1，ceil 错误得到 1 张；
  // 正确公式 ceil(1 / 0.9999999999) = 2（必须多领 1 张才能覆盖过程损耗）。
  // 4 页、每帖 1 张 -> 恰好 1 帖 1 张，份数 1 -> 净用纸 1。
  const prep = { copies: 1, makereadySheets: 0, processWasteRate: 1e-10, sheetsPerPack: 10 };
  const r = computeImposition({
    totalPages: 4, sheetsPerSignature: 1, binding: 'left', flip: 'short',
    materialPrep: prep,
  });
  const row = r.materialPrep.signatures[0];
  assert.equal(row.netSheets, 1);
  assert.equal(row.requiredSheets, 2);
  assert.equal(row.processWaste, 1);
  assert.equal(r.materialPrep.totals.requiredSheets, 2);
  // 整包采购同样向上取整：ceil(2/10) = 1 包 = 10 张
  assert.equal(r.materialPrep.totals.purchasePacks, 1);
  assert.equal(r.materialPrep.totals.purchaseSheets, 10);
  assert.equal(r.materialPrep.totals.packRemainder, 8);
});

test('极小损耗率下整包采购不少算：2 帖各需领 2 张、每包 3 张须采购 2 包', () => {
  // 8 页、每帖 1 张 -> 2 帖；份数 1、开机 0、率 1e-10 -> 每帖需领 2 张，合计 4 张。
  // 旧实现各帖误算为 1（合计 2 张），ceil(2/3) 仅 1 包；正确为 ceil(4/3) = 2 包。
  const prep = { copies: 1, makereadySheets: 0, processWasteRate: 1e-10, sheetsPerPack: 3 };
  const r = computeImposition({
    totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short',
    materialPrep: prep,
  });
  assert.deepEqual(r.materialPrep.signatures.map((x) => x.requiredSheets), [2, 2]);
  const t = r.materialPrep.totals;
  assert.equal(t.requiredSheets, 4);
  assert.equal(t.purchasePacks, 2);
  assert.equal(t.purchaseSheets, 6);
  assert.equal(t.packRemainder, 2);
});

test('科学计数法与普通小数按同一十进制值精确计算，结果完全一致', () => {
  const variants = [0.03, 3e-2, 0.00003e3, '0.03', '3e-2', '30e-3', '0.030', '3000e-5'];
  const required = variants.map((rate) => {
    const r = computeImposition({
      ...BASE,
      materialPrep: { copies: 1000, makereadySheets: 10, processWasteRate: rate, sheetsPerPack: 500 },
    });
    return r.materialPrep.signatures[0].requiredSheets;
  });
  // ceil(2010 / 0.97) = 2073，所有写法须一致
  assert.deepEqual(required, variants.map(() => 2073));

  // 极小率的数字 / 字符串 / 科学计数法写法同样一致（净用纸 1 -> 需领 2）
  const tiny = [1e-10, 0.0000000001, 10e-11, '1e-10', '0.0000000001', '100e-12'];
  const tinyRequired = tiny.map((rate) => {
    const r = computeImposition({
      totalPages: 4, sheetsPerSignature: 1, binding: 'left', flip: 'short',
      materialPrep: { copies: 1, makereadySheets: 0, processWasteRate: rate, sheetsPerPack: 100 },
    });
    return r.materialPrep.signatures[0].requiredSheets;
  });
  assert.deepEqual(tinyRequired, tiny.map(() => 2));
});

test('精确十进制计算：可整除率不再因浮点尾数多取一张（97 / 0.03 仍为 100）', () => {
  // 与既有「浮点边界」用例一致，精确分数计算下自然成立，不依赖 9 位预舍入。
  const prep = { copies: 97, makereadySheets: 0, processWasteRate: 0.03, sheetsPerPack: 500 };
  const r = computeImposition({
    totalPages: 97, sheetsPerSignature: 1, binding: 'left', flip: 'short',
    materialPrep: prep,
  });
  r.materialPrep.signatures.forEach((row) => assert.equal(row.requiredSheets, 100));
});

test('需领纸超出安全整数范围：抛出明确错误而非输出失真数量', () => {
  // 1 帖净用纸 1e8（份数上限）、率 0.9999999999 -> 需领纸 1e18 > Number.MAX_SAFE_INTEGER
  assert.throws(
    () => computeImposition({
      totalPages: 4, sheetsPerSignature: 1, binding: 'left', flip: 'short',
      materialPrep: { copies: 100000000, makereadySheets: 0, processWasteRate: '0.9999999999', sheetsPerPack: 500 },
    }),
    /需领纸.*安全整数/
  );
  // 科学计数法（数字形式）同值同样拒绝
  assert.throws(
    () => computeImposition({
      totalPages: 4, sheetsPerSignature: 1, binding: 'left', flip: 'short',
      materialPrep: { copies: 100000000, makereadySheets: 0, processWasteRate: 9.999999999e-1, sheetsPerPack: 500 },
    }),
    /安全整数/
  );
});

test('安全范围内的大数量正常计算且数值精确', () => {
  // 1e8 份、率 0.5 -> 每帖需领 2e8 张（安全整数内）
  const r = computeImposition({
    totalPages: 4, sheetsPerSignature: 1, binding: 'left', flip: 'short',
    materialPrep: { copies: 100000000, makereadySheets: 0, processWasteRate: 0.5, sheetsPerPack: 1 },
  });
  assert.equal(r.materialPrep.totals.requiredSheets, 200000000);
  assert.equal(r.materialPrep.totals.purchasePacks, 200000000);
  assert.equal(r.materialPrep.totals.purchaseSheets, 200000000);
});

test('损耗率字符串为精度 / 量级越界写法时返回明确错误', () => {
  // 101 位有效数字超出解析边界：拒绝而不是悄悄失真
  const longRate = `0.${'1'.repeat(101)}`;
  assert.throws(
    () => computeImposition({
      ...BASE,
      materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: longRate, sheetsPerPack: 100 },
    }),
    /过程损耗率/
  );
  // 数量级越界（10^101）：Number 为 Infinity，正常拒绝
  assert.throws(
    () => computeImposition({
      ...BASE,
      materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: '1e101', sheetsPerPack: 100 },
    }),
    /过程损耗率/
  );
});
