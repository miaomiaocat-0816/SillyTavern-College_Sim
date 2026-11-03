/**
 * 效果裁决器（M3-11 ~ M3-13）
 *
 * 铁律 R3：LLM 不能直接写任何数值，只能提交「效果提议」，由裁决器校验后落地。
 * 铁律 R8：所有写路径必须经过 arbiter.apply()。
 *
 * 裁决规则（按顺序，任一不通过即驳回该条）——§1.5.2：
 *  1. target 路径可解析且属性已定义 → UNKNOWN_TARGET
 *  2. target 不在 reserved 内 → RESERVED_TARGET
 *  3. 属性 llmAdjustable === true → NOT_LLM_ADJUSTABLE
 *  4. delta 数值合法 → INVALID_DELTA
 *  5. delta 未超单次上限（超则裁剪，记 CLAMPED）→ 裁剪优先于驳回
 *  6. 当日累计未超上限（超则裁剪，记 DAILY_CLAMPED）
 *  7. 结果未超 [min,max]（超则裁剪，记 OUT_OF_RANGE）
 *  8. 前置条件 requires 满足 → PRECONDITION_FAILED
 *
 * v4 两段式：先过 L0 世界书约束，再过 L1 属性规则（见 lore.js 的 applyLoreConstraints）。
 */

import { getAttributeDef, getByPath, getRoleValues, coerceValue, parsePath } from './attributes.js';

/** reserved 清单：LLM 永不触碰的字段（D12） */
export const RESERVED_KEYS = ['money', 'pregnant', 'inventory', 'inClass'];

/** 审计日志（内存环形缓冲 + 落盘在 state.audit） */
const MAX_AUDIT = 200;

/**
 * 裁决器核心：对一批 effects 提议做校验并落地。
 *
 * @param {object} state 当前状态（在 mutate 内，直接改）
 * @param {Array} effects 提议数组（已 normalize）
 * @param {object} ctx 上下文 { source?, apiId? }
 * @returns {object} {
 *   applied: Array,   // 成功落地的 effect（含实际值）
 *   rejected: Array,  // 被驳回的 effect（含 code）
 *   clamped: Array,   // 被裁剪的 effect（含 from/to）
 *   audit: Array,     // 审计记录
 * }
 */
export function applyEffects(state, effects, ctx = {}) {
    const applied = [];
    const rejected = [];
    const clamped = [];
    const audit = [];

    for (const rawEffect of effects) {
        const record = adjudicateOne(state, rawEffect, ctx);
        audit.push(record.audit);
        if (record.status === 'applied') {
            applied.push(record.effect);
        } else if (record.status === 'clamped') {
            clamped.push(record.effect);
        } else {
            rejected.push(record.effect);
        }
    }

    // 写入审计日志
    appendAudit(state, audit.filter(Boolean));

    return { applied, rejected, clamped, audit: audit.filter(Boolean) };
}

/**
 * 裁决单条 effect。
 * @returns {object} { status: 'applied'|'clamped'|'rejected', effect, audit }
 */
function adjudicateOne(state, eff, ctx) {
    const target = eff.target;
    const base = {
        target,
        source: ctx.source || 'llm',
        apiId: ctx.apiId,
        reason: eff.reason,
        ts: Date.now(),
    };

    // 规则 1：target 可解析
    const parsed = parsePath(target);
    if (!parsed) {
        return reject(base, 'UNKNOWN_TARGET', '路径格式错误');
    }

    // 规则 2：不在 reserved 内（先于属性定义检查，因为 money 等保留字段不是属性）
    if (RESERVED_KEYS.includes(parsed.attrKey)) {
        return reject(base, 'RESERVED_TARGET', `保留字段不可修改：${parsed.attrKey}`);
    }

    // 规则 1b：属性已定义
    const def = getAttributeDef(parsed.attrKey);
    if (!def) {
        return reject(base, 'UNKNOWN_TARGET', `未知属性：${parsed.attrKey}`);
    }

    // 规则 3：llmAdjustable === true
    if (def.llmAdjustable !== true) {
        return reject(base, 'NOT_LLM_ADJUSTABLE', `属性不允许 LLM 修改：${parsed.attrKey}`);
    }

    // 规则 4：delta 合法
    let delta;
    if (eff.delta !== undefined) {
        delta = Number(eff.delta);
        if (!Number.isFinite(delta)) {
            return reject(base, 'INVALID_DELTA', `delta 非法：${eff.delta}`);
        }
        if (def.type !== 'number' && def.type !== 'counter') {
            return reject(base, 'INVALID_DELTA', `属性 ${parsed.attrKey} 类型为 ${def.type}，不接受 delta`);
        }
    } else if (eff.set !== undefined) {
        // set 用于 enum/boolean
        if (def.type !== 'enum' && def.type !== 'boolean') {
            return reject(base, 'INVALID_DELTA', `属性 ${parsed.attrKey} 类型为 ${def.type}，不接受 set`);
        }
    }

    // 获取当前值
    const roleValues = getRoleValues(state, parsed.roleKey);
    if (roleValues === null) {
        return reject(base, 'UNKNOWN_TARGET', `未知角色：${parsed.roleKey}`);
    }
    const current = roleValues[parsed.attrKey];

    // 处理 set（enum/boolean）
    if (eff.set !== undefined) {
        const coerced = coerceValue(def, eff.set);
        if (!coerced.ok) {
            return reject(base, 'INVALID_DELTA', `set 值非法：${coerced.error}`);
        }
        roleValues[parsed.attrKey] = coerced.value;
        return applied(base, { ...eff, actual: coerced.value });
    }

    // 处理 delta（number/counter）
    let finalDelta = delta;
    const clampRecords = [];

    // 规则 5：单次上限（裁剪）
    if (def.deltaLimits?.single !== undefined && Math.abs(finalDelta) > def.deltaLimits.single) {
        const sign = Math.sign(finalDelta);
        finalDelta = sign * def.deltaLimits.single;
        clampRecords.push({ type: 'CLAMPED', from: delta, to: finalDelta, reason: '超过单次上限' });
    }

    // 规则 6：当日累计上限（裁剪）
    if (def.deltaLimits?.perRp24h !== undefined) {
        const dailyKey = `_daily_${parsed.attrKey}`;
        const dailySoFar = Math.abs(state._dailyDeltas?.[dailyKey] || 0);
        const remaining = def.deltaLimits.perRp24h - dailySoFar;
        if (Math.abs(finalDelta) > remaining) {
            const sign = Math.sign(finalDelta);
            finalDelta = sign * Math.max(0, remaining);
            clampRecords.push({ type: 'DAILY_CLAMPED', from: delta, to: finalDelta, reason: '超过当日累计上限' });
        }
    }

    // 规则 7：结果超 [min,max]（裁剪到边界）
    const candidate = Number(current) + finalDelta;
    let resultValue = candidate;
    if (def.min !== undefined && candidate < def.min) {
        resultValue = def.min;
        finalDelta = resultValue - Number(current);
        clampRecords.push({ type: 'OUT_OF_RANGE', from: delta, to: finalDelta, reason: '低于下限' });
    }
    if (def.max !== undefined && candidate > def.max) {
        resultValue = def.max;
        finalDelta = resultValue - Number(current);
        clampRecords.push({ type: 'OUT_OF_RANGE', from: delta, to: finalDelta, reason: '超过上限' });
    }

    // 规则 8：前置条件（在落地前校验，用裁剪后的 delta 判断）
    if (def.requires && def.requires.length > 0) {
        for (const req of def.requires) {
            if (!checkRequirement(state, req)) {
                return reject(base, 'PRECONDITION_FAILED', `前置条件不满足：${req}`);
            }
        }
    }

    // 落地
    roleValues[parsed.attrKey] = resultValue;

    // 累计当日 delta
    if (!state._dailyDeltas) state._dailyDeltas = {};
    const dailyKey = `_daily_${parsed.attrKey}`;
    state._dailyDeltas[dailyKey] = (state._dailyDeltas[dailyKey] || 0) + Math.abs(finalDelta);

    const finalEffect = { ...eff, actual: resultValue, from: current, to: resultValue };
    if (clampRecords.length > 0) {
        return {
            status: 'clamped',
            effect: { ...finalEffect, clamps: clampRecords },
            audit: { ...base, status: 'clamped', from: current, to: resultValue, clamps: clampRecords },
        };
    }
    return applied(base, finalEffect);
}

function applied(base, effect) {
    return { status: 'applied', effect, audit: { ...base, status: 'applied', ...effect } };
}

function reject(base, code, message) {
    return {
        status: 'rejected',
        effect: { target: base.target, reason: base.reason, code, message },
        audit: { ...base, status: 'rejected', code, message },
    };
}

/**
 * 校验前置条件字符串，如 "stamina>=10"。
 */
function checkRequirement(state, req) {
    const m = String(req).match(/^([\w.]+)\s*(>=|<=|==|>|<)\s*(-?\d+)$/);
    if (!m) return false;
    const [, pathStr, op, valStr] = m;
    const { value } = getByPath(state, pathStr);
    const current = Number(value);
    const expected = Number(valStr);
    switch (op) {
        case '>=': return current >= expected;
        case '<=': return current <= expected;
        case '==': return current === expected;
        case '>': return current > expected;
        case '<': return current < expected;
        default: return false;
    }
}

/**
 * 写入审计日志（内存 + state.audit，环形缓冲）。
 */
function appendAudit(state, records) {
    if (!state.audit) state.audit = [];
    for (const r of records) {
        state.audit.push(r);
    }
    if (state.audit.length > MAX_AUDIT) {
        state.audit = state.audit.slice(-MAX_AUDIT);
    }
}

/**
 * 查询审计日志。
 * @param {object} state
 * @param {object} opts { limit }
 * @returns {Array}
 */
export function getAudit(state, opts = {}) {
    const limit = opts.limit || 20;
    const log = state.audit || [];
    return log.slice(-limit).reverse(); // 最新的在前
}
