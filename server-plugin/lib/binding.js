/**
 * 多 API 连接绑定（M5-1）
 *
 * 两种绑定并存：
 *  - 按用途（use）：main_event（主事件）/ intent（意图判定）/ summary（摘要）
 *  - 按角色（role）：每个 NPC 单独指定一个连接配置
 *
 * 解析优先级（从高到低）：
 *  1. 角色级绑定（该角色发言时）
 *  2. 用途级绑定（该任务类型）
 *  3. ST 主连接（兜底，返回 null）
 *
 * 铁律：绑定关系是「规则配置」，存 state.bindings，由前端面板读写。
 *      本模块只做解析，不真正调用 API（真正调用在浏览器端 generateQuietPrompt 的 profile 参数）。
 */

/** 用途类型 */
export const USE_TYPES = {
    MAIN_EVENT: 'main_event',   // 主事件（强模型）
    INTENT: 'intent',           // 意图判定（轻模型）
    SUMMARY: 'summary',         // 摘要生成
};

/**
 * 解析某个（角色 + 用途）的最终连接配置 id。
 * @param {object} bindings 绑定关系 { byUse: {useType: profileId}, byRole: {role: profileId} }
 * @param {string} role 角色名（如 roommate_a、self）
 * @param {string} useType 用途类型（USE_TYPES 之一）
 * @returns {{profileId: string|null, resolvedBy: 'role'|'use'|'default'}}
 */
export function resolveBinding(bindings, role, useType) {
    const byRole = bindings?.byRole || {};
    const byUse = bindings?.byUse || {};

    // 1. 角色级绑定（最高优先级）
    if (role && byRole[role]) {
        return { profileId: byRole[role], resolvedBy: 'role' };
    }
    // 2. 用途级绑定
    if (useType && byUse[useType]) {
        return { profileId: byUse[useType], resolvedBy: 'use' };
    }
    // 3. ST 主连接（兜底）
    return { profileId: null, resolvedBy: 'default' };
}

/**
 * 设置绑定关系（幂等）。
 * @param {object} state
 * @param {'byUse'|'byRole'} dim 维度
 * @param {string} key useType 或 role
 * @param {string|null} profileId 连接配置 id（null 表示解绑，回退上一级）
 * @returns {object} 更新后的 bindings
 */
export function setBinding(state, dim, key, profileId) {
    if (!state.bindings) state.bindings = { byUse: {}, byRole: {} };
    if (dim === 'byUse') {
        if (profileId === null) delete state.bindings.byUse[key];
        else state.bindings.byUse[key] = profileId;
    } else if (dim === 'byRole') {
        if (profileId === null) delete state.bindings.byRole[key];
        else state.bindings.byRole[key] = profileId;
    } else {
        throw new Error(`未知绑定维度：${dim}`);
    }
    return state.bindings;
}

/**
 * 获取全部绑定关系。
 * @param {object} state
 * @returns {{byUse: object, byRole: object}}
 */
export function getBindings(state) {
    return state.bindings || { byUse: {}, byRole: {} };
}

/**
 * 校验绑定引用的 profile 是否仍存在（被删除则回退上一级并告警）。
 * @param {object} bindings 绑定关系
 * @param {string[]} validProfileIds 当前 ST 里有效的 profile id 列表
 * @returns {{bindings: object, warnings: string[]}}
 */
export function validateBindings(bindings, validProfileIds) {
    const warnings = [];
    const validSet = new Set(validProfileIds);
    const result = { byUse: {}, byRole: {} };

    for (const [k, pid] of Object.entries(bindings?.byUse || {})) {
        if (validSet.has(pid)) {
            result.byUse[k] = pid;
        } else {
            warnings.push(`用途「${k}」绑定的连接配置 ${pid} 已删除，已回退`);
        }
    }
    for (const [k, pid] of Object.entries(bindings?.byRole || {})) {
        if (validSet.has(pid)) {
            result.byRole[k] = pid;
        } else {
            warnings.push(`角色「${k}」绑定的连接配置 ${pid} 已删除，已回退`);
        }
    }
    return { bindings: result, warnings };
}
