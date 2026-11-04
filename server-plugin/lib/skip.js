/**
 * 批量时间跳跃（M6-8）
 *
 * /us-skip 2d 快进 N 天，中间所有 tick 事件按序结算：
 *  - 快递到站（settleArrivals）
 *  - 课程状态（updateClassState）
 *  - 属性衰减（applyDecay）
 *  - 生理周期演化（advanceCycle，M6-2）
 *  - 生活费发放（lore monthStart，M6 接入）
 *
 * 生成一段摘要，含这段时间发生的事。
 * 分片处理：大跨度按「天」为单位迭代，避免单次循环卡死。
 */

import { settleArrivals } from './delivery.js';
import { updateClassState } from './schedule.js';
import { formatRpTime } from './time-engine.js';
import { advanceCycle } from './cycle.js';
import { buildSummary } from './summary.js';
import { applyDecay } from './attributes.js';
import { loadAllConstraints } from './lore.js';

/** 单次 skip 的最大天数（超出报错，防止误操作/卡死） */
const MAX_SKIP_DAYS = 30;
/** 每日分钟数 */
const MIN_PER_DAY = 1440;

/**
 * 执行时间跳跃。
 * @param {object} state 状态对象（在 bus.mutate 内）
 * @param {number} days 跳跃天数（可小数）
 * @returns {{ok:boolean, summary:string, events:Array, error?:string}}
 */
export function skipDays(state, days) {
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        return { ok: false, error: '跳跃天数必须是正数' };
    }
    if (days > MAX_SKIP_DAYS) {
        return { ok: false, error: `单次最多快进 ${MAX_SKIP_DAYS} 天（请求 ${days} 天）` };
    }

    const from = state.time.epochMinute;
    const totalMinutes = Math.round(days * MIN_PER_DAY);
    const collected = {  // 结算事件收集（用于摘要）
        deliveryArrived: 0,
        classTransitions: [],
        monthAllowance: 0,
        cycleAdvanced: [],
    };

    // 分片：按「每片最多 1 天」迭代，逐片结算
    const CHUNK_MINUTES = MIN_PER_DAY;
    let remaining = totalMinutes;
    while (remaining > 0) {
        const step = Math.min(CHUNK_MINUTES, remaining);
        state.time.epochMinute += step;
        remaining -= step;

        // 快递到站
        const arrived = settleArrivals(state);
        collected.deliveryArrived += arrived.length;

        // 课程状态（跨过上课/下课点成对触发）
        updateClassState(state);

        // 属性衰减（与真实 tick 同一逻辑）
        applyDecay(state, step);

        // 生理周期演化（每片按天推进）
        stepCycles(state, step, collected);

        // 生活费发放（monthStart，每月 1 号）
        applyAllowance(state, collected);
    }

    // 记录一次 skip 事件
    (state.events ||= []).push({
        id: `skip_${Date.now()}`,
        type: 'skip',
        ts: Date.now(),
        payload: { from, to: state.time.epochMinute, days },
    });

    const summary = buildSkipSummary(from, state.time.epochMinute, collected, state);

    return { ok: true, summary, events: collected, from, to: state.time.epochMinute };
}

/** 生理周期演化（每个角色的 cycle 按天推进） */
function stepCycles(state, stepMinutes, collected) {
    const rpDays = stepMinutes / MIN_PER_DAY;
    for (const roleKey of Object.keys(state.attributes || {})) {
        const vals = state.attributes[roleKey];
        if (!vals || typeof vals !== 'object' || !vals.cycle) continue;
        const before = vals.cycle.phase;
        advanceCycle(vals.cycle, rpDays);
        if (vals.cycle.phase !== before) {
            collected.cycleAdvanced.push({ role: roleKey, phase: vals.cycle.phase });
        }
    }
}

/** 从世界书约束块读取生活费金额（type=allowance），无则兜底 2000 */
function getAllowanceAmount() {
    const { constraints } = loadAllConstraints();
    const c = constraints.find(x => x.type === 'allowance');
    return c?.amount ?? 2000;
}

/** 生活费发放（每月 1 号，月首跨过时发放一次） */
function applyAllowance(state, collected) {
    // 检测是否跨过「月首」（每 30 天为一个月，简化：day % 30 === 0 视为月首）
    // 用 RP 天数判断：month = floor(day / 30)，跨过月首即发放
    const day = Math.floor(state.time.epochMinute / MIN_PER_DAY);
    const monthIndex = Math.floor(day / 30);
    if (!state.flags) state.flags = {};
    const lastMonth = state.flags._lastAllowanceMonth ?? -1;
    if (monthIndex > lastMonth) {
        const amount = getAllowanceAmount();
        state.money += amount;
        state.flags._lastAllowanceMonth = monthIndex;
        collected.monthAllowance += amount;
        (state.events ||= []).push({
            id: `allowance_${Date.now()}`,
            type: 'allowance',
            ts: Date.now(),
            payload: { amount },
        });
    }
}

/** 生成跳跃摘要（含这段时间发生的事） */
function buildSkipSummary(from, to, collected, state) {
    const fromLabel = formatRpTime(from).label;
    const toLabel = formatRpTime(to).label;
    const lines = [`从 ${fromLabel} 快进到 ${toLabel}`];

    if (collected.deliveryArrived > 0) lines.push(`${collected.deliveryArrived} 件快递到站`);
    if (collected.monthAllowance > 0) lines.push(`发放生活费 ${collected.monthAllowance} 元`);
    if (collected.cycleAdvanced.length > 0) {
        const names = collected.cycleAdvanced.map(c => `${c.role}(${c.phase})`).join('、');
        lines.push(`生理周期变化：${names}`);
    }
    // 附当前状态摘要
    const stateSummary = buildSummary(state);
    lines.push(stateSummary);

    return lines.join('；') + '。';
}
