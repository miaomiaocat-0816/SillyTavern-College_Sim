/**
 * 状态摘要生成器（M3-3）
 *
 * 生成固定格式的状态文本块，供 prompt 注入器使用。
 *
 * 验收要求：
 *  - 含时间、金钱、背包条数、在途快递数、好感 top3
 *  - 同一状态多次调用结果完全一致（无随机、无时间戳）
 *  - 输出长度 < 500 字符（超出则裁剪背包，只留摘要行）
 */

import { formatRpTime } from './time-engine.js';
import { getTemplate } from './items.js';
import { getRoleValues } from './attributes.js';

const MAX_LENGTH = 500;

/**
 * 生成状态摘要文本块（确定性，无随机/时间戳）。
 * @param {object} state
 * @returns {string} 摘要文本
 */
export function buildSummary(state) {
    const t = formatRpTime(state.time.epochMinute);
    const lines = [];

    // 时间
    lines.push(`时间：${t.label}`);
    lines.push(`金钱：${state.money} 元`);

    // 背包
    const invCount = (state.inventory || []).length;
    lines.push(`背包：${invCount} 件物品`);

    // 在途快递
    const inTransit = (state.deliveries || []).filter(d => d.status === 'in_transit').length;
    const arrived = (state.deliveries || []).filter(d => d.status === 'arrived').length;
    lines.push(`快递：${inTransit} 件在途，${arrived} 件待取`);

    // 好感 top3（affinity 属性，按 NPC 值降序）
    const affinities = collectAffinities(state);
    if (affinities.length > 0) {
        const top3 = affinities.slice(0, 3).map(a => `${a.role}(${a.value})`).join('、');
        lines.push(`好感：${top3}`);
    }

    // 玩家关键属性（health/stamina/mood）
    const self = getRoleValues(state, 'self');
    if (self) {
        const keys = ['health', 'stamina', 'mood'];
        const parts = [];
        for (const k of keys) {
            if (self[k] !== undefined) parts.push(`${label(k)}=${self[k]}`);
        }
        if (parts.length > 0) lines.push(`状态：${parts.join(' ')}`);
    }

    // 上课状态
    if (state.flags?.inClass) {
        lines.push('当前：上课中');
    }

    // 拼接并裁剪到 < 500 字符
    let summary = lines.join('；') + '。';
    if (summary.length > MAX_LENGTH) {
        // 裁剪：去掉背包细节，只保留摘要行
        summary = lines.slice(0, 3).join('；') + '。';
    }
    return summary;
}

/** 属性 key 的中文标签（硬编码仅用于摘要展示，非逻辑） */
function label(key) {
    const map = { health: '健康', stamina: '体力', mood: '心情' };
    return map[key] || key;
}

/**
 * 收集各 NPC 的好感值，降序排列。
 * @returns {Array<{role, value}>}
 */
function collectAffinities(state) {
    const result = [];
    for (const roleKey of Object.keys(state.attributes || {})) {
        if (roleKey === 'self') continue;
        const vals = state.attributes[roleKey];
        if (vals && vals.affinity !== undefined) {
            result.push({ role: roleKey, value: vals.affinity });
        }
    }
    result.sort((a, b) => b.value - a.value);
    return result;
}
