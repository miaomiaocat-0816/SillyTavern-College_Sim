/**
 * 生理状态组件（M6-2）
 *
 * 每个角色有 cycle: { phase, dayInCycle, cycleLength }，
 * 随 RP 时间推进自动演化，快照可读可恢复。
 *
 * 铁律 R1：真值存后端 state（bus 持有），本模块只提供纯计算 + 演化逻辑。
 *
 * phase 枚举（普通健康模拟，中性）：
 *  - follicular 卵泡期（周期第 1~13 天，默认 14 天周期）
 *  - ovulatory   排卵期（周期第 14 天）
 *  - luteal      黄体期（周期第 15~28 天）
 *
 * 简化模型：cycleLength 默认 28 天，phase 由 dayInCycle 推导。
 * 受孕概率查表在 lib/fertilization.js（M6-3）按 phase 读取。
 */

/** phase 枚举与判定阈值（dayInCycle 从 1 开始） */
export const CYCLE_PHASES = ['follicular', 'ovulatory', 'luteal'];

/** 默认周期长度（天） */
export const DEFAULT_CYCLE_LENGTH = 28;

/** 排卵日（周期内第几天，1 起算） */
export const OVULATION_DAY = 14;

/**
 * 根据 dayInCycle 推导 phase。
 * @param {number} dayInCycle 周期内第几天（1 起算）
 * @param {number} cycleLength 周期长度
 * @returns {string} phase
 */
export function phaseForDay(dayInCycle, cycleLength = DEFAULT_CYCLE_LENGTH) {
    const day = ((dayInCycle - 1) % cycleLength) + 1;
    if (day === OVULATION_DAY) return 'ovulatory';
    if (day < OVULATION_DAY) return 'follicular';
    return 'luteal';
}

/**
 * 创建一个角色的初始生理状态快照。
 * @param {object} [seed] 初始种子（可指定 phase/dayInCycle/cycleLength）
 * @returns {{phase:string, dayInCycle:number, cycleLength:number}}
 */
export function createCycle(seed = {}) {
    const cycleLength = seed?.cycleLength || DEFAULT_CYCLE_LENGTH;
    const dayInCycle = seed?.dayInCycle || 1;
    return {
        phase: phaseForDay(dayInCycle, cycleLength),
        dayInCycle,
        cycleLength,
    };
}

/**
 * 推进某角色的生理周期（随 RP 天数前进）。
 * @param {object} cycle 当前 cycle（原地修改）
 * @param {number} rpDays 推进的 RP 天数（可小数，内部按整天累计）
 * @returns {object} 推进后的 cycle
 */
export function advanceCycle(cycle, rpDays) {
    if (!cycle || typeof cycle !== 'object') return cycle;
    if (typeof rpDays !== 'number' || !Number.isFinite(rpDays) || rpDays < 0) return cycle;

    const length = cycle.cycleLength || DEFAULT_CYCLE_LENGTH;
    // 累计天数（保留小数，取整时按整天演化 phase）
    let day = (cycle.dayInCycle || 1) + rpDays;
    // 取模回 1..length 区间（dayInCycle 从 1 起算）
    while (day > length) day -= length;
    if (day < 1) day = 1;

    cycle.dayInCycle = Math.round(day);
    cycle.phase = phaseForDay(cycle.dayInCycle, length);
    return cycle;
}

/**
 * 序列化（快照可读可恢复）。cycle 本身即为纯数据，可直接 JSON 序列化。
 * 此函数用于显式保证「快照可恢复」语义。
 */
export function serializeCycle(cycle) {
    return cycle ? JSON.parse(JSON.stringify(cycle)) : null;
}

/**
 * 从快照恢复（校验 + 补齐字段）。
 */
export function restoreCycle(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return createCycle();
    return createCycle({
        dayInCycle: Number.isFinite(snapshot.dayInCycle) ? snapshot.dayInCycle : 1,
        cycleLength: Number.isFinite(snapshot.cycleLength) ? snapshot.cycleLength : DEFAULT_CYCLE_LENGTH,
    });
}
