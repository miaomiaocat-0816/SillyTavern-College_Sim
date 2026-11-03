/**
 * 物品系统（M2-1 ~ M2-2）
 *
 * 四种类型：consumable / unique / durable / durable_stack
 * 统一 ItemInstance 结构：{ id, templateId, durability, state }
 *
 * 铁律 R7：物品模板由 data/items/templates.json 声明式定义，代码无硬编码物品。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'items', 'templates.json');

/** 支持的类型 */
export const ITEM_TYPES = ['consumable', 'unique', 'durable', 'durable_stack'];

/** 必填字段 */
const REQUIRED_FIELDS = ['id', 'name', 'type', 'price'];

/** 模板缓存 */
let templates = null;

/**
 * 加载并校验物品模板库。
 * 缺必填字段 / 类型非法 → 抛错并指出是哪一条。
 */
export function loadTemplates() {
    if (templates) return templates;

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
    } catch (e) {
        throw new Error(`[items] 无法加载物品模板库 ${TEMPLATES_PATH}: ${e.message}`);
    }

    if (!Array.isArray(raw.items)) {
        throw new Error('[items] 模板库缺少 items 数组');
    }

    const map = new Map();
    for (const tpl of raw.items) {
        // 必填字段校验
        for (const f of REQUIRED_FIELDS) {
            if (tpl[f] === undefined || tpl[f] === null || tpl[f] === '') {
                throw new Error(`[items] 模板「${tpl.id || '(未知)'}」缺少必填字段 ${f}`);
            }
        }
        // 类型校验
        if (!ITEM_TYPES.includes(tpl.type)) {
            throw new Error(`[items] 模板「${tpl.id}」类型非法：${tpl.type}（支持 ${ITEM_TYPES.join('/')}）`);
        }
        // 价格非负
        if (typeof tpl.price !== 'number' || tpl.price < 0) {
            throw new Error(`[items] 模板「${tpl.id}」价格非法：${tpl.price}`);
        }
        map.set(tpl.id, tpl);
    }

    templates = map;
    return templates;
}

/** 获取单个模板 */
export function getTemplate(id) {
    return loadTemplates().get(id);
}

/** 获取全部模板（数组形式） */
export function getAllTemplates() {
    return [...loadTemplates().values()];
}

/**
 * 根据模板创建一个物品实例。
 * 返回 ItemInstance：{ id, templateId, durability, state }
 */
let instanceSeq = 0;
export function createInstance(templateId) {
    const tpl = getTemplate(templateId);
    if (!tpl) throw new Error(`[items] 模板不存在：${templateId}`);

    instanceSeq += 1;
    const inst = {
        id: `item_${Date.now()}_${instanceSeq}_${Math.random().toString(36).slice(2, 6)}`,
        templateId,
        state: 'normal',
    };

    // 耐久初始化：durable / durable_stack 有耐久
    if (tpl.type === 'durable' || tpl.type === 'durable_stack') {
        inst.durability = tpl.maxDurability ?? 1;
    }

    return inst;
}

/**
 * 校验一个物品实例是否合法（M2-1 验收：序列化→反序列化逐字段相等）。
 * 返回 { ok, error? }
 */
export function validateInstance(inst) {
    if (!inst || typeof inst !== 'object') {
        return { ok: false, error: 'instance 不是对象' };
    }
    if (typeof inst.id !== 'string' || !inst.id) {
        return { ok: false, error: 'instance.id 缺失' };
    }
    if (typeof inst.templateId !== 'string' || !inst.templateId) {
        return { ok: false, error: 'instance.templateId 缺失' };
    }
    if (!getTemplate(inst.templateId)) {
        return { ok: false, error: `instance 引用的模板不存在：${inst.templateId}` };
    }
    return { ok: true };
}
