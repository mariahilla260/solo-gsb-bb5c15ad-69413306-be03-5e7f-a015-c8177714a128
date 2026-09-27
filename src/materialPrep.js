'use strict';

/**
 * 印刷备料（printing material preparation）。
 *
 * 在拼版结果（各帖实际张数）基础上，按成品份数估算用纸采购量。
 *
 * 输入（API 字段 materialPrep，缺省 / null / false 时整个模块不启用）：
 * - copies               成品份数（≥1 的整数，每份成品需用每帖全部纸张一次）；
 * - makereadySheets      每帖开机损耗张数（≥0 的整数，各帖分别加一次）；
 * - processWasteRate     过程损耗率（0 ≤ r < 1，小数表示，如 0.03 = 3%；
 *                        普通小数与科学计数法（如 1e-10、0.0000000001）等价处理，
 *                        一律按其十进制字面值精确计算，不引入浮点误差）；
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
 * 取整必须严格按输入损耗率的十进制值执行：例如净用纸 1 张、开机损耗 0、
 * 损耗率 1e-10 时，(1 + 0) / (1 − 1e-10) = 1.0000000001…，须向上取整为 2 张。
 * 早期实现先按 9 位小数预舍入，会把该值抹成 1（少领 1 张，整包采购也可能少算）。
 * 现把损耗率的十进制字面值解析为精确有理数（BigInt 分子 / 分母），ceil 全程
 * 用整数运算完成，普通小数与科学计数法结果一致。任一张数结果超出 JS 安全整数
 * 范围（Number.MAX_SAFE_INTEGER）时抛出明确错误（HTTP 400），不输出失真数量。
 *
 * 未启用（materialPrep 缺省 / null / { enabled: false }）时 parse 返回
 * { enabled: false }，attachMaterialPrep 不向结果写入任何字段，原响应完全不变。
 */

const MAX_COPIES = 100000000;       // 成品份数上限 1 亿
const MAX_MAKEREADY = 1000000;      // 每帖开机损耗上限 100 万张
const MAX_SHEETS_PER_PACK = 100000000; // 每包张数上限 1 亿

/** 张数结果允许的最大值：超过即无法在 JSON number 中精确表示，必须报错。 */
const MAX_SAFE_SHEETS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 求两个非负 BigInt 的最大公约数（Euclid 算法），用于把有理数约为最简分数。
 */
function bigGcd(a, b) {
  while (b > 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * 把一个有限十进制数（数字或字符串，普通小数 / 科学计数法均可）精确解析为
 * 最简正有理数（BigInt 分子 / 分母，恒为正数；0 单独返回 { zero: true }）。
 *
 * 关键：按十进制「字面值」解析而非 Number()，因此 0.03、"0.03"、3e-2 得到
 * 完全相同的分子 / 分母（3 / 100），与 1e-10、"0.0000000001" 得到 1 / 1e10。
 * 不按字面值接受的输入（空串 / Infinity / NaN / 十六进制等）抛出明确错误。
 *
 * @returns {{zero:true} | {numerator:bigint, denominator:bigint}}
 */
function parseDecimalFraction(rawValue) {
  let text;
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) {
      throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
    }
    // 最短往返字符串即为该 double 的十进制值（科学计数法也按其字面值解析）
    text = String(rawValue);
  } else if (typeof rawValue === 'string') {
    text = rawValue.trim();
  } else {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }

  const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2] || '';
  const fracPart = match[3] !== undefined ? match[3] : (match[4] || '');
  const exponent = match[5] === undefined ? 0n : BigInt(match[5]);

  // 限制规模，防止构造超大 BigInt（合法损耗率远低于此：小数 100 位 / 指数 ±1000）
  if (intPart.length + fracPart.length > 200 || exponent > 1000n || exponent < -1000n) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }

  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  const rawMantissa = digits === '' ? 0n : BigInt(digits);
  // 小数点相对数字末尾的位置：科学计数法指数把该位置整体平移
  const decimalShift = BigInt(fracPart.length) - exponent;

  let numerator = rawMantissa;
  let denominator = 1n;
  if (decimalShift > 0n) {
    denominator = 10n ** decimalShift;
  } else if (decimalShift < 0n) {
    numerator *= 10n ** (-decimalShift);
  }
  numerator *= sign;

  if (numerator === 0n) return { zero: true };
  const gcd = bigGcd(numerator < 0n ? -numerator : numerator, denominator);
  return { numerator: numerator / gcd, denominator: denominator / gcd };
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
  // 过程损耗率：接受数字或纯数字字符串；0 ≤ r < 1（100% 损耗时公式无意义）。
  // 同时解析其十进制字面值为精确有理数（普通小数与科学计数法一致）。
  let rateValue = raw.processWasteRate;
  if (typeof rateValue === 'string' && rateValue.trim() === '') {
    rateValue = NaN;
  }
  if (typeof rateValue !== 'number' && typeof rateValue !== 'string') {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }
  if (typeof rateValue === 'number' && (!Number.isFinite(rateValue) || rateValue < 0 || rateValue >= 1)) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }
  const rateFraction = parseDecimalFraction(rateValue);
  if (!rateFraction.zero) {
    // 精确比较 r < 1：分子 < 分母（r 非负，负数已在上面拦截）
    if (rateFraction.numerator < 0n || rateFraction.numerator >= rateFraction.denominator) {
      throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
    }
  }
  // 回显仍用 JS number（与旧响应字段一致）
  const processWasteRate = typeof rateValue === 'number' ? rateValue : Number(rateValue.trim());
  const sheetsPerPack = toInteger(raw.sheetsPerPack);
  if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1 || sheetsPerPack > MAX_SHEETS_PER_PACK) {
    throw new Error(`每包张数 sheetsPerPack 必须为 1 ~ ${MAX_SHEETS_PER_PACK.toLocaleString('en-US')} 的整数`);
  }

  return {
    enabled: true,
    copies,
    makereadySheets,
    processWasteRate,
    rateFraction,
    sheetsPerPack,
  };
}

/**
 * 精确向上取整：ceil(amount / yieldRate)。
 *
 * 损耗率 r = p / q（最简分数）时，良品率 1 − r = (q − p) / q，故
 *   ceil(amount / ((q − p) / q)) = ceil(amount × q / (q − p))，
 * 全程 BigInt 整数运算，严格按输入损耗率的十进制值取整，无浮点尾数。
 *
 * @param {bigint} amount 净用纸 + 开机损耗（张）
 * @param {{zero:true}|{numerator:bigint, denominator:bigint}} rateFraction 损耗率
 * @returns {bigint} 需领纸（张）
 */
function ceilRequiredSheets(amount, rateFraction) {
  if (rateFraction.zero) return amount;
  const { numerator: p, denominator: q } = rateFraction;
  const yieldNumerator = q - p; // 1 − p/q = (q − p)/q
  const numerator = amount * q;
  return (numerator + yieldNumerator - 1n) / yieldNumerator;
}

/** 把非负 BigInt 张数转为 JS number；超出安全整数范围则抛出明确错误（由调用方转 400）。 */
function toSafeSheets(value, label) {
  if (value > MAX_SAFE_SHEETS) {
    throw new Error(
      `${label} ${value.toString()} 张已超过 JavaScript 安全整数上限（${Number.MAX_SAFE_INTEGER.toLocaleString('en-US')} 张），` +
      '无法精确表示，请降低成品份数 / 开机损耗 / 过程损耗率后重试'
    );
  }
  return Number(value);
}

/**
 * 依据拼版结果逐帖计算备料并附加汇总。
 * 仅在 parseMaterialPrepInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取各帖 actualSheetCount）
 * @param {{enabled:true, copies:number, makereadySheets:number, processWasteRate:number, rateFraction:object, sheetsPerPack:number}} prep
 * @returns {object} 备料结果（materialPrep 段）
 */
function attachMaterialPrep(result, prep) {
  if (!prep.enabled) return undefined;
  const { copies, makereadySheets, processWasteRate, rateFraction, sheetsPerPack } = prep;
  const makereadyBig = BigInt(makereadySheets);
  const packBig = BigInt(sheetsPerPack);

  // 逐帖精确取整（BigInt），禁止先合并各帖再算损耗。
  const signatureRows = result.signatures.map((sig) => {
    const netBig = BigInt(sig.actualSheetCount) * BigInt(copies);
    const requiredBig = ceilRequiredSheets(netBig + makereadyBig, rateFraction);
    return {
      signature: sig.index,
      actualSheetCount: sig.actualSheetCount,
      copies,
      netBig,
      makereadyBig,
      processWasteBig: requiredBig - netBig - makereadyBig, // 过程损耗（含取整余量，≥ 0）
      totalWasteBig: requiredBig - netBig, // 全部多领的纸
      requiredBig,
    };
  });

  const totalsBig = signatureRows.reduce(
    (acc, row) => {
      acc.netSheets += row.netBig;
      acc.makereadySheets += row.makereadyBig;
      acc.processWaste += row.processWasteBig;
      acc.totalWaste += row.totalWasteBig;
      acc.requiredSheets += row.requiredBig;
      return acc;
    },
    { netSheets: 0n, makereadySheets: 0n, processWaste: 0n, totalWaste: 0n, requiredSheets: 0n }
  );

  // 汇总后再按整包向上采购（不在逐帖阶段按包取整）。
  const purchasePacksBig = (totalsBig.requiredSheets + packBig - 1n) / packBig;
  const purchaseSheetsBig = purchasePacksBig * packBig;

  // 任一张数无法表示为安全整数时给出明确错误，不输出失真的数量。
  signatureRows.forEach((row) => {
    toSafeSheets(row.requiredBig, `第 ${row.signature} 帖需领纸`);
  });
  toSafeSheets(totalsBig.requiredSheets, '需领纸合计');
  toSafeSheets(purchaseSheetsBig, '整包采购张数');

  const signatures = signatureRows.map((row) => ({
    signature: row.signature,
    actualSheetCount: row.actualSheetCount,
    copies,
    netSheets: Number(row.netBig),
    makereadySheets: Number(row.makereadyBig),
    processWaste: Number(row.processWasteBig),
    totalWaste: Number(row.totalWasteBig),
    requiredSheets: Number(row.requiredBig),
  }));

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
      netSheets: Number(totalsBig.netSheets),
      makereadySheets: Number(totalsBig.makereadySheets),
      processWaste: Number(totalsBig.processWaste),
      totalWaste: Number(totalsBig.totalWaste),
      requiredSheets: Number(totalsBig.requiredSheets),
      purchasePacks: Number(purchasePacksBig),
      sheetsPerPack,
      purchaseSheets: Number(purchaseSheetsBig),
      packRemainder: Number(purchaseSheetsBig - totalsBig.requiredSheets),
    },
  };
}

module.exports = {
  parseMaterialPrepInput,
  attachMaterialPrep,
};
