/**
 * 事件队列 + 事件仲裁器（M3-1 ~ M3-2）
 *
 * 铁律 R8：所有子系统只往队列 push 事件，不直接发言。
 * 叙事层只有一个入口：仲裁器串行消费事件。
 *
 * 设计：
 *  - 事件结构 { id, type, priority, ts, payload, narrativeHint }
 *  - 队列持久化在 state.events（bus 落盘），重启不丢
 *  - 仲裁器按 {priority 降序, ts 升序} 串行消费
 *  - 幂等：已消费事件标记 consumed，不会重复消费
 *  - 消费失败：事件回队（标记 retry 次数），不阻塞后续事件
 */

/** 事件优先级（数字越大越优先） */
export const PRIORITY = {
    CRITICAL: 100,   // 系统级、世界书强约束（如熄灯、规则触发）
    HIGH: 50,        // 快递到站、课程开始等需要玩家注意的
    NORMAL: 10,      // 普通叙事事件
    LOW: 0,          // 背景性事件
};

let eventSeq = 0;

/**
 * 生成事件 id（唯一）。
 */
function genId() {
    eventSeq += 1;
    return `evt_${Date.now()}_${eventSeq}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 往事件队列 push 一个事件（纯函数，直接改 state.events）。
 * 事件结构符合 M3-1 验收：{ id, type, priority, ts, payload, narrativeHint }
 *
 * @param {object} state
 * @param {object} event { type, priority?, payload?, narrativeHint? }
 * @returns {object} 生成的事件
 */
export function pushEvent(state, { type, priority = PRIORITY.NORMAL, payload = {}, narrativeHint = '' }) {
    const event = {
        id: genId(),
        type,
        priority,
        ts: Date.now(),
        payload,
        narrativeHint,
        consumed: false,   // M3-2 幂等标记
        retries: 0,        // 消费失败重试计数
    };
    if (!state.events) state.events = [];
    state.events.push(event);
    return event;
}

/**
 * 排序事件队列：priority 降序，同优先级按 ts 升序（先到先处理）。
 * 只返回未消费事件。
 */
export function sortQueue(events) {
    return events
        .filter(e => e && e.consumed !== true)
        .sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.ts - b.ts;
        });
}

/**
 * 取出下一个待消费事件（不标记消费）。
 * @returns {object|null}
 */
export function peekNext(state) {
    const queue = sortQueue(state.events || []);
    return queue.length > 0 ? queue[0] : null;
}

/**
 * 标记事件已消费（幂等）。
 * @returns {boolean} 是否成功标记（false 表示事件不存在或已消费）
 */
export function markConsumed(state, eventId) {
    const event = (state.events || []).find(e => e.id === eventId);
    if (!event) return false;
    if (event.consumed === true) return false; // 已消费，幂等拒绝
    event.consumed = true;
    event.consumedAt = Date.now();
    return true;
}

/**
 * 消费失败回队：增加重试计数，超过上限则标记 consumed（丢弃）避免死循环。
 * @param {object} state
 * @param {string} eventId
 * @param {string} error 错误信息
 * @returns {object} { requeued: boolean, dropped: boolean }
 */
export function requeueOnFailure(state, eventId, error) {
    const event = (state.events || []).find(e => e.id === eventId);
    if (!event) return { requeued: false, dropped: false };

    const MAX_RETRIES = 3;
    event.retries = (event.retries || 0) + 1;
    event.lastError = error;

    if (event.retries > MAX_RETRIES) {
        // 超过重试上限：丢弃（标记消费），记录错误，不阻塞后续
        event.consumed = true;
        event.dropped = true;
        event.droppedAt = Date.now();
        console.error(`[university-sim][events] 事件 ${eventId} 重试超限，已丢弃：${error}`);
        return { requeued: false, dropped: true };
    }

    // 回队：将 ts 后移一点，避免再次抢占（仍然按优先级排序）
    event.ts = Date.now();
    console.warn(`[university-sim][events] 事件 ${eventId} 消费失败回队（第 ${event.retries} 次）：${error}`);
    return { requeued: true, dropped: false };
}

/**
 * 事件仲裁器：串行消费队列，逐条交给叙事处理器。
 *
 * @param {object} state 当前状态
 * @param {Function} narrativeHandler async (event, state) => { ok, error? }
 *        叙事处理器：返回 ok:true 表示消费成功，ok:false 表示失败（触发回队）
 * @param {object} options { maxPerCycle } 单轮最多消费事件数（防一次 tick 消费过多）
 * @returns {object} { consumed: number, failed: number }
 */
export async function arbitrate(state, narrativeHandler, options = {}) {
    const maxPerCycle = options.maxPerCycle ?? 20;
    let consumed = 0;
    let failed = 0;

    // 循环消费：每次取优先级最高的未消费事件
    for (let i = 0; i < maxPerCycle; i++) {
        const event = peekNext(state);
        if (!event) break; // 队列空

        try {
            const result = await narrativeHandler(event, state);
            if (result && result.ok === false) {
                // 叙事处理失败 → 回队
                requeueOnFailure(state, event.id, result.error || 'narrative handler failed');
                failed += 1;
                // 若回队后仍在队首且重试超限被丢弃，则继续下一轮
                continue;
            }
            markConsumed(state, event.id);
            consumed += 1;
        } catch (e) {
            // 异常 → 回队，不阻塞后续
            requeueOnFailure(state, event.id, e.message);
            failed += 1;
        }
    }

    return { consumed, failed };
}
