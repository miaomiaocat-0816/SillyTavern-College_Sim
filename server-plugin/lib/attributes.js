/**
 * 属性系统（M2-15 ~ M2-19）
 *
 * 铁律 R7：属性全部由 data/attributes.json 声明式定义，
 *          本模块是「通用加载器 + 类型处理器」，不含任何具体属性硬编码。
 *
 * 四种类型：number / enum / boolean / counter
 * 点分路径寻址：self.* / <charId>.*
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTRIBUTES_PATH = path.join(__dirname, '..', 'data', 'attributes.json');

/** 支持的属性类型 */
export const ATTR_TYPES = ['number', 'enum', 'boolean', 'counter'];

let attrDefs = null;   // Map<key, def>
let attrGroups = null;

/** 加载并校验属性定义 */
export function loadAttributes() {
    if (attrDefs) return attrDefs;

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(ATTRIBUTES_PATH, 'utf8'));
    } catch (e) {
        throw new Error(`[attributes] 无法加载 ${ATTRIBUTES_PATH}: ${e.message}`);
    }

    if (!Array.isArray(raw.attributes)) {
        throw new Error('[attributes] 缺少 attributes 数组');
    }

    attrGroups = raw.groups || {};
    attrDefs = new Map();

    for (const a of raw.attributes) {
        // 必填字段
        if (!a.key || !a.type) {
            throw new Error(`[attributes] 属性定义缺 key 或 type：${JSON.stringify(a)}`);
        }
        // 类型校验
        if (!ATTR_TYPES.includes(a.type)) {
            throw new Error(`[attributes] 属性「${a.key}」类型非法：${a.type}（支持 ${ATTR_TYPES.join('/')}）`);
        }
        // enum 必须有 options
        if (a.type === 'enum' && (!Array.isArray(a.options) || a.options.length === 0)) {
            throw new Error(`[attributes] 属性「${a.key}」为 enum 但缺少 options`);
        }
        attrDefs.set(a.key, a);
    }

    return attrDefs;
}

/** 使属性缓存失效（M6-4 规则编辑器写回后调用） */
export function invalidateAttributes() {
    attrDefs = null;
    attrGroups = null;
}

/** 获取单个属性定义 */
export function getAttributeDef(key) {
    return loadAttributes().get(key);
}

/** 获取全部属性定义（数组） */
export function getAllAttributeDefs() {
    return [...loadAttributes().values()];
}

/**
 * 获取按 display.order 排序的属性定义（M5-4 面板驱动）。
 * 无 display.order 的属性排最后（按 key 字典序）。
 * @returns {Array} 属性定义数组
 */
export function getDisplayOrderedDefs() {
    return getAllAttributeDefs().sort((a, b) => {
        const oa = a.display?.order ?? 9999;
        const ob = b.display?.order ?? 9999;
        if (oa !== ob) return oa - ob;
        return a.key.localeCompare(b.key);
    });
}

/**
 * 组装某角色属性的渲染数据（M5-4）：{ key, label, type, value, def, display }。
 * @param {object} state
 * @param {string} roleKey
 * @returns {Array}
 */
export function getRoleDisplayData(state, roleKey) {
    const values = getRoleValues(state, roleKey);
    if (!values) return [];
    return getDisplayOrderedDefs().map(def => ({
        key: def.key,
        label: def.label || def.key,
        type: def.type,
        value: values[def.key] !== undefined ? values[def.key] : (def.default ?? defaultForType(def.type)),
        def,
        display: def.display || { widget: def.type === 'number' ? 'bar' : def.type === 'enum' ? 'tag' : 'number', order: 9999 },
    }));
}

/**
 * 创建某角色的属性实例（值按 default 初始化）。
 * @returns {object} key -> current 值
 */
export function createAttributeValues(roleKey) {
    const values = {};
    for (const a of loadAttributes().values()) {
        values[a.key] = a.default ?? defaultForType(a.type);
    }
    return values;
}

function defaultForType(type) {
    switch (type) {
        case 'number': return 0;
        case 'enum': return null;
        case 'boolean': return false;
        case 'counter': return 0;
        default: return null;
    }
}

/**
 * 类型处理器：对给定值做校验/钳制。
 * @returns {object} { ok, value, error? } value 为处理后的合法值
 */
export function coerceValue(def, value) {
    switch (def.type) {
        case 'number': {
            let n = Number(value);
            if (!Number.isFinite(n)) return { ok: false, error: `非数值` };
            if (def.min !== undefined) n = Math.max(def.min, n);
            if (def.max !== undefined) n = Math.min(def.max, n);
            return { ok: true, value: n };
        }
        case 'enum': {
            if (!def.options.includes(value)) return { ok: false, error: `不在允许值内` };
            return { ok: true, value };
        }
        case 'boolean': {
            if (typeof value !== 'boolean') return { ok: false, error: `非布尔值` };
            return { ok: true, value };
        }
        case 'counter': {
            let n = Number(value);
            if (!Number.isInteger(n) || n < 0) return { ok: false, error: `计数器不接受负数` };
            return { ok: true, value: n };
        }
        default:
            return { ok: false, error: `未知类型 ${def.type}` };
    }
}

/**
 * 点分路径解析：'self.health' / 'roommate_a.affinity'
 * 返回 { roleKey, attrKey }，无法解析返回 null。
 */
export function parsePath(pathStr) {
    if (typeof pathStr !== 'string') return null;
    const parts = pathStr.split('.');
    if (parts.length < 2) return null;
    const roleKey = parts[0];
    const attrKey = parts.slice(1).join('.');
    return { roleKey, attrKey };
}

/**
 * 从 state 读取点分路径的值。
 * @returns {object} { ok, value?, error? }
 */
export function getByPath(state, pathStr) {
    const parsed = parsePath(pathStr);
    if (!parsed) return { ok: false, error: '路径格式错误' };

    const def = getAttributeDef(parsed.attrKey);
    if (!def) return { ok: false, error: `未知属性：${parsed.attrKey}` };

    const roleValues = getRoleValues(state, parsed.roleKey);
    if (roleValues === null) return { ok: false, error: `未知角色：${parsed.roleKey}` };

    return { ok: true, value: roleValues[parsed.attrKey] };
}

/**
 * 获取某角色的属性值对象（含 self 映射到玩家）。
 */
export function getRoleValues(state, roleKey) {
    if (roleKey === 'self') {
        // 玩家属性存在 state.attributes（self）
        if (!state.attributes.self) state.attributes.self = {};
        return state.attributes.self;
    }
    // NPC 属性
    if (!state.attributes[roleKey]) return null;
    return state.attributes[roleKey];
}

/**
 * 属性自然衰减（由 tick / skip 调用）。
 * 按 decay 规则扣减 number 类型属性。
 * @param {object} state 状态对象（在 mutate 内）
 * @param {number} elapsedMinutes 本次经过的 RP 分钟数
 */
export function applyDecay(state, elapsedMinutes) {
    const rpDays = (Number(elapsedMinutes) || 0) / 1440;
    if (rpDays <= 0) return;
    const now = state.time?.epochMinute ?? 0;

    for (const def of loadAttributes().values()) {
        if (def.type !== 'number' || !def.decay) continue;

        for (const roleKey of Object.keys(state.attributes || {})) {
            const vals = state.attributes[roleKey];
            if (!vals || typeof vals !== 'object') continue;
            if (vals[def.key] === undefined) continue;

            const current = Number(vals[def.key]);
            let delta = 0;

            if (def.decay.perRp24h !== undefined) {
                // 固定速率衰减（如健康/体力随时间自然下降）
                delta = def.decay.perRp24h * rpDays;
            } else if (def.decay.perRp24hNoInteraction !== undefined) {
                // 仅当距上次互动超过 24 RP 小时才衰减（好感）
                const last = Number(vals.lastInteraction || 0);
                if (now - last > 1440) {
                    delta = def.decay.perRp24hNoInteraction * rpDays;
                }
            }

            if (!delta) continue;

            let next = current + delta;
            const floor = def.decay.floor ?? def.min;
            if (floor !== undefined) next = Math.max(floor, next);
            if (def.max !== undefined) next = Math.min(def.max, next);
            vals[def.key] = Math.round(next * 10) / 10;
        }
    }
}
