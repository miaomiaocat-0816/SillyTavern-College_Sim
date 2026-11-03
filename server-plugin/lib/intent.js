/**
 * NPC 意图判定（M4-7）+ 主动发言触发（M4-8）
 *
 * M4-7：对活跃 NPC 调 generateQuietPrompt，要求返回 JSON {intent:'talk'|'silent'|'interject'|'leave'}
 * M4-8：判定为 talk 时，NPC 在无玩家输入情况下发出消息
 *
 * 关键约束（铁律 R3/R8）：
 *  - 意图判定结果不直接写状态，只入事件队列
 *  - 发言走事件仲裁器，不直接 addOneMessage
 *
 * 本模块是「桥接层」：后端提供判定结果与提示词，前端负责真正调用 generateQuietPrompt
 * 并消费事件队列触发发言（因为 generateQuietPrompt 是浏览器端 API）。
 */

/** 意图枚举 */
export const INTENT = {
    TALK: 'talk',           // 主动搭话
    SILENT: 'silent',       // 保持沉默
    INTERJECT: 'interject', // 插话（对当前对话评论）
    LEAVE: 'leave',         // 离开当前场景
};

/**
 * 解析意图判定结果（LLM 输出），失败按 silent 处理。
 * @param {string} raw LLM 返回的文本
 * @returns {{intent:string, parsed:boolean}}
 */
export function parseIntent(raw) {
    if (!raw) return { intent: INTENT.SILENT, parsed: false };
    const text = String(raw).trim();

    // 尝试剥离 markdown 代码块
    let jsonStr = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) jsonStr = fence[1].trim();

    // 尝试 JSON 解析
    try {
        const obj = JSON.parse(jsonStr);
        if (obj && typeof obj.intent === 'string') {
            const intent = obj.intent.toLowerCase();
            if (Object.values(INTENT).includes(intent)) {
                return { intent, parsed: true };
            }
        }
    } catch (e) {
        // 非 JSON，降级为关键词匹配
    }

    // 降级：直接匹配枚举关键词
    const lower = text.toLowerCase();
    if (lower.includes('talk') || lower.includes('搭话') || lower.includes('主动')) return { intent: INTENT.TALK, parsed: true };
    if (lower.includes('interject') || lower.includes('插话')) return { intent: INTENT.INTERJECT, parsed: true };
    if (lower.includes('leave') || lower.includes('离开')) return { intent: INTENT.LEAVE, parsed: true };
    if (lower.includes('silent') || lower.includes('沉默')) return { intent: INTENT.SILENT, parsed: true };

    return { intent: INTENT.SILENT, parsed: false };
}

/**
 * 构建意图判定提示词（给 generateQuietPrompt 用）。
 * @param {object} npc NPC 信息 { name, affinity, ... }
 * @param {object} state 当前状态
 * @returns {string}
 */
export function buildIntentPrompt(npc, state) {
    const name = npc.name || 'NPC';
    const affinity = npc.affinity ?? 0;
    return [
        `你是群聊中的角色「${name}」。`,
        `当前与玩家的好感度为 ${affinity}。`,
        `请判断你此刻的意图，只返回一个 JSON 对象，格式：{"intent":"talk|silent|interject|leave"}`,
        `含义：talk=主动搭话，silent=保持沉默，interject=对当前对话插话，leave=离开场景。`,
        `不要输出任何解释，只输出 JSON。`,
    ].join('\n');
}

/**
 * 构建 NPC 主动发言的提示词（M4-8）。
 * @param {object} npc
 * @param {object} state
 * @returns {string}
 */
export function buildNpcSpeechPrompt(npc, state) {
    const name = npc.name || 'NPC';
    return `你是群聊中的角色「${name}」，请以第一人称主动说一句话（不要带动作描写前缀，直接说内容）。`;
}

/**
 * 判断是否应该对某 NPC 做意图判定（节流：每 N tick 一次）。
 * @param {object} npc
 * @param {number} now
 * @param {number} intervalMs 判定间隔
 * @returns {boolean}
 */
export function shouldJudgeIntent(npc, now, intervalMs) {
    if (!npc) return false;
    return !npc.lastIntentAt || (now - npc.lastIntentAt) >= intervalMs;
}
