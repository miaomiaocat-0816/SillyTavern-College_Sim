/**
 * 陌生人交互（M4-4 临时注入 + encounterLog，M4-10 转常驻）
 *
 * M4-4：命中时把卡内容拼进注入块，出场后卸载；只保留 <100 字摘要进 encounterLog
 * M4-10：好感达阈值后可转常驻（加入群聊成员、移出陌生人池）
 *
 * 铁律：本模块只改 state.pool / state.activeEncounter / state.encounterLog，
 *      不直接写属性或发言（走 bus.mutate / 事件仲裁）。
 */

/** 注入块最大长度（人设文本，防止过长） */
const MAX_INJECT = 600;
/** encounterLog 单条摘要最大长度 */
const MAX_LOG = 100;

/**
 * 组装陌生人临时注入块（人设 + 场景 + 首句）。
 * @param {object} card
 * @returns {string}
 */
export function buildEncounterInjection(card) {
    const parts = [];
    parts.push(`【偶遇角色】${card.name}`);
    if (card.description) parts.push(card.description);
    if (card.personality) parts.push(`性格：${card.personality}`);
    if (card.scenario) parts.push(`背景：${card.scenario}`);
    if (card.first_mes) parts.push(`开场：${card.first_mes}`);
    let text = parts.join('\n');
    if (text.length > MAX_INJECT) text = text.slice(0, MAX_INJECT) + '…';
    return text;
}

/**
 * 激活一次陌生人相遇（写 state.activeEncounter）。
 * @param {object} state
 * @param {object} card
 * @param {string} scene
 * @param {number} now
 * @param {number} durationMs 注入持续时间
 */
export function activateEncounter(state, card, scene, now, durationMs) {
    state.activeEncounter = {
        cardId: card.id,
        name: card.name,
        scene,
        startedAt: now,
        activeUntil: now + durationMs,
        injection: buildEncounterInjection(card),
    };
    // 同步池内卡片的 active 标记
    const poolCard = (state.pool || []).find(c => c.id === card.id);
    if (poolCard) {
        poolCard.active = true;
        poolCard.activeUntil = now + durationMs;
        poolCard.lastTriggered = now;
    }
    return state.activeEncounter;
}

/**
 * 结束一次相遇：卸载注入，写 <100 字摘要进 encounterLog。
 * @param {object} state
 * @param {string|null} summary 摘要文本（可选，缺省自动从 card 生成）
 * @returns {object|null} 被卸载的相遇
 */
export function deactivateEncounter(state, summary) {
    const enc = state.activeEncounter;
    if (!enc) return null;

    const logEntry = {
        cardId: enc.cardId,
        name: enc.name,
        scene: enc.scene,
        endedAt: Date.now(),
        summary: (summary || `${enc.name} 与你短暂相遇`).slice(0, MAX_LOG),
    };
    if (!state.encounterLog) state.encounterLog = [];
    state.encounterLog.push(logEntry);
    // 只保留最近 50 条
    if (state.encounterLog.length > 50) state.encounterLog = state.encounterLog.slice(-50);

    // 清除池内 active 标记
    const poolCard = (state.pool || []).find(c => c.id === enc.cardId);
    if (poolCard) { poolCard.active = false; poolCard.activeUntil = 0; }

    state.activeEncounter = null;
    return logEntry;
}

/**
 * 判断活跃相遇是否超时。
 */
export function isEncounterExpired(state, now) {
    const enc = state.activeEncounter;
    return enc && enc.activeUntil > 0 && now > enc.activeUntil;
}

/**
 * 陌生人转常驻（M4-10）：好感达阈值后，把卡移出陌生人池，加入常驻角色。
 * @param {object} state
 * @param {string} cardId
 * @returns {{converted:boolean, reason:string}}
 */
export function promoteToResident(state, cardId) {
    const poolCard = (state.pool || []).find(c => c.id === cardId);
    if (!poolCard) return { converted: false, reason: 'NOT_FOUND' };

    // 检查好感阈值（affinity 存在且达阈值）
    const aff = state.attributes?.[cardId]?.affinity;
    const threshold = poolCard.affinityThreshold || 60;
    if (aff === undefined || aff < threshold) {
        return { converted: false, reason: 'AFFINITY_BELOW_THRESHOLD' };
    }

    // 移出陌生人池（标记 disabled + 从池中移除）
    state.pool = (state.pool || []).filter(c => c.id !== cardId);

    // 加入常驻角色列表
    if (!state.residents) state.residents = [];
    if (!state.residents.includes(cardId)) {
        state.residents.push(cardId);
    }

    // 若正处于活跃相遇，卸载
    if (state.activeEncounter && state.activeEncounter.cardId === cardId) {
        deactivateEncounter(state, `${poolCard.name} 已成为常驻角色`);
    }

    return { converted: true, reason: 'OK' };
}
