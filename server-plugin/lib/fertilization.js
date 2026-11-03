/**
 * 受孕判定（M6-3）
 *
 * 铁律 R5：开关关闭时本代码路径完全不执行（调用方用 isAdultEnabled() 门控）。
 * 铁律 R3：pregnant 属 reserved 禁区字段，LLM 无权提议，只由本模块（代码通道）改动。
 *
 * 判定规则：
 *  - 物品完好时：概率固定 BASE_RATE（默认 1%）
 *  - 物品破损时：按角色 phase 查表（PHASE_RATE_TABLE）
 *  - 命中后：state 打标 pregnant: true，并推入事件钩子（adult_pregnant）
 *
 * 纯概率逻辑，不包含任何露骨内容。
 */

/** 物品完好时的固定概率 */
export const BASE_RATE = 0.01;

/** 破损时按 phase 查表的概率（可覆盖） */
export const PHASE_RATE_TABLE = {
    follicular: 0.02,   // 卵泡期：低
    ovulatory: 0.20,    // 排卵期：高
    luteal: 0.03,       // 黄体期：低
};

/**
 * 判定是否受孕。
 * @param {object} args
 * @param {boolean} args.itemIntact 物品是否完好（true=完好，false=破损）
 * @param {string} args.phase 角色当前 phase
 * @returns {{pregnant:boolean, probability:number}}
 */
export function rollFertilization({ itemIntact = true, phase = 'follicular' }) {
    if (itemIntact) {
        return { pregnant: Math.random() < BASE_RATE, probability: BASE_RATE };
    }
    const rate = PHASE_RATE_TABLE[phase] ?? BASE_RATE;
    return { pregnant: Math.random() < rate, probability: rate };
}

/**
 * 在 state 上落地受孕结果。
 * 命中 → state.attributes.<role>.pregnant = true（若该角色用 attributes 存），
 *        并在 state 顶层打标 flags.pregnant 便于跨系统读取。
 * 同时推入事件钩子（type: adult_pregnant），供叙事/后续事件消费。
 *
 * @param {object} state 状态对象（在 bus.mutate 内）
 * @param {string} role 角色 key（'self' 或 NPC）
 * @param {boolean} pregnant 是否命中
 * @returns {{pregnant:boolean, eventId?:string}}
 */
export function applyFertilization(state, role, pregnant) {
    if (!state.flags) state.flags = {};
    if (!state.attributes) state.attributes = {};

    if (!state.attributes[role]) state.attributes[role] = {};
    state.attributes[role].pregnant = !!pregnant;
    // 顶层打标（reserved 字段，仅代码通道可改）
    state.flags.pregnant = !!pregnant;

    let eventId = null;
    if (pregnant) {
        eventId = `adult_pregnant_${role}_${Date.now()}`;
        (state.events ||= []).push({
            id: eventId,
            type: 'adult_pregnant',
            ts: Date.now(),
            priority: 50, // 较高优先级，重要事件
            payload: { role },
            narrativeHint: `「${role}」出现妊娠事件`,
        });
    }

    return { pregnant: !!pregnant, eventId };
}
