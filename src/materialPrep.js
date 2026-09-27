'use strict';

/**
 * 印刷备料（printing material preparation）。
 *
 * 在拼版结果（各帖实际张数）基础上，按成品份数估算用纸采购量。
 *
 * 输入（API 字段 materialPrep，缺省 / null / false 时整个模块不启用）：
 * - copies               成品份数（≥1 的整数，每份成品需用每帖全部纸张一次）；
 * - makereadySheets      每帖开机损耗张数（≥0 的整数，各帖分别加一次）；
 * - processWasteRate     过程损耗率（0 ≤ r < 1，小数表示，如 0.03 = 3%）；
 * - sheetsPerPack        每包张数（≥1 的整数，采购按整包向上取整）。
 *
 * 计算规则（必须逐帖取整后再汇总，禁止先合并各帖再算损耗）：
 * - 净用纸（帖）   = 该帖实际张数 × 成品份数；
 * - 需领纸（帖）   = ceil((净用纸 + 开机损耗) / (1 − 过程损耗率))；
 * - 过程损耗（帖） = 需领纸 − 净用纸 − 开机损耗（≥ 0，含取整余量）；
 * - 汇总           = 各帖净用纸 / 开机损耗 / 需领纸分别求和；
 * - 采购包数       = ceil(需领纸合计 / 每包张数)，采购张数 = 采购包数 × 每包张数，
 *                    包余 = 采购张数 − 需领纸合计。
 *
 * 过程损耗率按输入十进制字面量**精确**参与计算：不再做任何浮点预舍入。
 * 例如净用纸 1 张、开机损耗 0、损耗率 1e-10 时，
 * ceil(1 / 0.9999999999) = 2（而不是被预舍入成 1）。
 * 普通小数（0.03）与科学计数法（3e-2 / "1e-10"）按同一十进制值解析，结果一致。
 * 所有张数一旦无法表示为安全整数（超过 Number.MAX_SAFE_INTEGER），抛出明确错误
 * （由调用方转为 400），绝不输出失真数量。
 *
 * 未启用（materialPrep 缺省 / null / { enabled: false }）时 parse 返回
 * { enabled: false }，attachMaterialPrep 不向结果写入任何字段，原响应完全不变。
 */

const MAX_COPIES = 100000000;       // 成品份数上限 1 亿
const MAX_MAKEREADY = 1000000;      // 每帖开机损耗上限 100 万张
const MAX_SHEETS_PER_PACK = 100000000; // 每包张数上限 1 亿

// 十进制字面量解析的防 DoS 边界（远超业务需要的精度 / 量级）：
const MAX_SIGNIFICANT_DIGITS = 100; // 有效数字最多 100 位
const MAX_DECIMAL_SCALE = 324;      // 最小 10^-324（保证 Number(字面量) 仍可表示）
const MAX_EXPONENT = 100;           // 最大 10^100

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 把十进制字面量（普通小数 / 科学计数法）解析为精确分数 { num, den }，
 * den 恒为 10 的非负整数次幂。number 入参先取最短往返字符串，因此
 * 0.03、"0.03"、3e-2、"3e-2" 解析出完全相同的分数，计算结果一致。
 * 非法语法或超出精度 / 量级边界时返回 null。
 */
function parseDecimalFraction(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const intDigits = m[2] || '';
  const fracDigits = m[3] || '';
  if (intDigits === '' && fracDigits === '') return null; // 纯符号 / 空 / "1." 之外的非法写法
  const exponent = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_EXPONENT) return null;

  let digits = (intDigits + fracDigits).replace(/^0+/, '');
  if (digits.length === 0) return { num: 0n, den: 1n }; // 各种写法的 0
  if (digits.length > MAX_SIGNIFICANT_DIGITS) return null;

  // 规格化为 num × 10^exp / 10^fracLen，再消去末尾 0，den 始终为 10 的幂。
  let scale = exponent - fracDigits.length;
  if (scale >= 0) {
    return { num: sign * BigInt(digits) * 10n ** BigInt(scale), den: 1n };
  }
  let trailingZeros = 0;
  while (trailingZeros < digits.length - 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    trailingZeros += 1;
  }
  scale += trailingZeros;
  if (scale < -MAX_DECIMAL_SCALE) return null;
  return { num: sign * BigInt(digits), den: 10n ** BigInt(-scale) };
}

/** 精确向上取整：ceil(n / d)，n ≥ 0、d > 0（BigInt，结果为非负整数 BigInt）。 */
function ceilDiv(n, d) {
  return n === 0n ? 0n : (n - 1n) / d + 1n;
}

/**
 * 解析并校验备料输入。
 * @returns {{enabled: false} | {enabled: true, copies, makereadySheets, processWasteRate, rateFraction, sheetsPerPack}}
 */
function parseMaterialPrepInput(input) {
  const raw = input && input.materialPrep;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('印刷备料参数 materialPrep 必须为对象（含 copies / makereadySheets / processWasteRate / sheetsPerPack）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('印刷备料开关 enabled 必须为布尔值（true / false）');
  }

  const copies = toInteger(raw.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    throw new Error(`成品份数 copies 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const makereadySheets = toInteger(raw.makereadySheets);
  if (!Number.isInteger(makereadySheets) || makereadySheets < 0 || makereadySheets > MAX_MAKEREADY) {
    throw new Error(`每帖开机损耗张数 makereadySheets 必须为 0 ~ ${MAX_MAKEREADY.toLocaleString('en-US')} 的整数`);
  }
  // 过程损耗率：接受数字或纯数字字符串（含科学计数法）；0 ≤ r < 1（100% 损耗时公式无意义）。
  // 同时取得 Number 形式（用于回显）与精确十进制分数（用于 ceil 计算），
  // 不再依赖可能产生 0.9999999999999999 这一类浮点尾数的除法。
  let rateNumber = raw.processWasteRate;
  if (typeof rateNumber === 'string') {
    rateNumber = rateNumber.trim() === '' ? NaN : Number(rateNumber);
  }
  if (typeof rateNumber !== 'number' || !Number.isFinite(rateNumber) || rateNumber < 0 || rateNumber >= 1) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%，支持科学计数法如 1e-10）');
  }
  const rateFraction = parseDecimalFraction(raw.processWasteRate);
  // Number 校验已通过但精确解析失败：语法超出解析边界（如精度位数 / 量级超限），拒绝而非失真计算。
  if (!rateFraction) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%，支持科学计数法如 1e-10）');
  }
  // 精确分数复核 [0, 1)：防止极端写法经 Number 舍入后落在范围内、实际十进制值越界。
  if (rateFraction.num < 0n || rateFraction.num >= rateFraction.den) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%，支持科学计数法如 1e-10）');
  }
  const sheetsPerPack = toInteger(raw.sheetsPerPack);
  if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1 || sheetsPerPack > MAX_SHEETS_PER_PACK) {
    throw new Error(`每包张数 sheetsPerPack 必须为 1 ~ ${MAX_SHEETS_PER_PACK.toLocaleString('en-US')} 的整数`);
  }

  return {
    enabled: true,
    copies,
    makereadySheets,
    processWasteRate: rateNumber,
    rateFraction,
    sheetsPerPack,
  };
}

/**
 * BigInt 张数转安全整数 Number；超出安全整数范围时抛出明确错误
 * （调用方转为 400），绝不返回失真数量。
 * @param {bigint} value 张数（≥ 0）
 * @param {string} what  出错时指明是哪一项数量
 */
function toSafeSheets(value, what) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${what}已超出安全整数范围（> ${Number.MAX_SAFE_INTEGER.toLocaleString('en-US')} 张），无法精确表示，请降低成品份数或过程损耗率后重试`);
  }
  return Number(value);
}

/**
 * 依据拼版结果逐帖计算备料并附加汇总。
 * 仅在 parseMaterialPrepInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取各帖 actualSheetCount）
 * @param {{enabled:true, copies:number, makereadySheets:number, processWasteRate:number, rateFraction:{num:bigint,den:bigint}, sheetsPerPack:number}} prep
 * @returns {object} 备料结果（materialPrep 段）
 */
function attachMaterialPrep(result, prep) {
  if (!prep.enabled) return undefined;
  const { copies, makereadySheets, processWasteRate, rateFraction, sheetsPerPack } = prep;

  // 良品率 1 − r 的精确分数表示（与 r 的十进制分母相同）：
  // r = num / den，1 − r = (den − num) / den，恒为正数（r < 1 已在解析时保证）。
  const yieldNum = rateFraction.den - rateFraction.num;
  const yieldDen = rateFraction.den;
  const makeready = BigInt(makereadySheets);
  const perPack = BigInt(sheetsPerPack);

  const totals = { netSheets: 0n, makereadySheets: 0n, processWaste: 0n, totalWaste: 0n, requiredSheets: 0n };

  const signatures = result.signatures.map((sig) => {
    const netSheets = BigInt(sig.actualSheetCount) * BigInt(copies);
    // 精确逐帖 ceil：ceil((净用纸 + 开机损耗) × den / (den − num))，全程 BigInt。
    const requiredSheets = ceilDiv((netSheets + makeready) * yieldDen, yieldNum);
    const totalWaste = requiredSheets - netSheets; // 全部多领的纸
    const processWaste = requiredSheets - netSheets - makeready; // 过程损耗（含取整余量，≥ 0）

    totals.netSheets += netSheets;
    totals.makereadySheets += makeready;
    totals.processWaste += processWaste;
    totals.totalWaste += totalWaste;
    totals.requiredSheets += requiredSheets;

    return {
      signature: sig.index,
      actualSheetCount: sig.actualSheetCount,
      copies,
      netSheets: toSafeSheets(netSheets, `第 ${sig.index} 帖净用纸`),
      makereadySheets,
      requiredSheets: toSafeSheets(requiredSheets, `第 ${sig.index} 帖需领纸`),
      processWaste: toSafeSheets(processWaste, `第 ${sig.index} 帖过程损耗`),
      totalWaste: toSafeSheets(totalWaste, `第 ${sig.index} 帖损耗合计`),
    };
  });

  const totalRequired = totals.requiredSheets;
  // 汇总后再按整包向上采购（不在逐帖阶段按包取整），同样用精确 BigInt ceil。
  const purchasePacks = ceilDiv(totalRequired, perPack);
  const purchaseSheets = purchasePacks * perPack;

  return {
    enabled: true,
    copies,
    makereadySheets,
    processWasteRate,
    sheetsPerPack,
    formula: 'requiredSheets = ceil((netSheets + makereadySheets) / (1 - processWasteRate))，逐帖取整后汇总',
    signatures,
    totals: {
      signatureCount: signatures.length,
      netSheets: toSafeSheets(totals.netSheets, '净用纸合计'),
      makereadySheets: toSafeSheets(totals.makereadySheets, '开机损耗合计'),
      processWaste: toSafeSheets(totals.processWaste, '过程损耗合计'),
      totalWaste: toSafeSheets(totals.totalWaste, '损耗合计'),
      requiredSheets: toSafeSheets(totalRequired, '需领纸合计'),
      purchasePacks: toSafeSheets(purchasePacks, '采购包数'),
      sheetsPerPack,
      purchaseSheets: toSafeSheets(purchaseSheets, '采购张数'),
      packRemainder: toSafeSheets(purchaseSheets - totalRequired, '包余张数'),
    },
  };
}

module.exports = {
  parseMaterialPrepInput,
  attachMaterialPrep,
  parseDecimalFraction,
};
