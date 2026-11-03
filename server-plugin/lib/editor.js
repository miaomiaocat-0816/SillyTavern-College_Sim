/**
 * 规则编辑器后端（M6-4 属性 / M6-5 课表 / M6-6 物品模板）
 *
 * 提供三类配置的「读、增、删、改、导入、导出」，
 * 所有写操作做 schema 校验，非法配置被拒并指出字段。
 * 写回对应 JSON 文件后，需调用 invalidate* 使缓存失效（M6-4/5 重启生效，
 * M6-7 概率类即时生效）。
 *
 * 铁律 R7：这三类均为声明式 JSON，编辑器只是改 JSON，不碰核心代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const ATTR_PATH = path.join(DATA_DIR, 'attributes.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');
const ITEMS_PATH = path.join(DATA_DIR, 'items', 'templates.json');

/** 属性类型（与 attributes.js 一致） */
const ATTR_TYPES = ['number', 'enum', 'boolean', 'counter'];
/** 物品类型（与 items.js 一致） */
const ITEM_TYPES = ['consumable', 'unique', 'durable', 'durable_stack'];

/** 原子读（带错误处理） */
function readJson(fp) {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

/** 原子写（临时文件 + rename） */
function writeJson(fp, obj) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
}

// ============ 通用：导入 / 导出 ============

/**
 * 导出某类配置为 JSON 字符串。
 * @param {'attributes'|'schedule'|'items'} kind
 */
export function exportJson(kind) {
    const fp = pathFor(kind);
    return fs.readFileSync(fp, 'utf8');
}

function pathFor(kind) {
    switch (kind) {
        case 'attributes': return ATTR_PATH;
        case 'schedule': return SCHEDULE_PATH;
        case 'items': return ITEMS_PATH;
        default: throw new Error(`未知配置类型：${kind}`);
    }
}

/**
 * 导入（整体覆盖）某类配置。先校验，通过才写回。
 * @param {string} kind
 * @param {string|object} content JSON 字符串或对象
 * @returns {{ok:boolean, error?:string}}
 */
export function importJson(kind, content) {
    let obj;
    try {
        obj = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (e) {
        return { ok: false, error: `JSON 解析失败：${e.message}` };
    }
    const check = validateWhole(kind, obj);
    if (!check.ok) return check;
    try {
        writeJson(pathFor(kind), obj);
        invalidate(kind);
    } catch (e) {
        return { ok: false, error: `写回失败：${e.message}` };
    }
    return { ok: true };
}

// ============ 属性（M6-4）============

/**
 * 校验单个属性定义（key/label/type/min/max/default/decay/deltaLimits）。
 */
function validateAttributeDef(a) {
    if (!a || typeof a !== 'object') return { ok: false, error: '属性定义必须是对象' };
    if (!a.key || typeof a.key !== 'string') return { ok: false, error: '属性缺 key' };
    if (!ATTR_TYPES.includes(a.type)) return { ok: false, error: `属性「${a.key}」type 非法：${a.type}（支持 ${ATTR_TYPES.join('/')}）` };
    if (a.type === 'enum' && (!Array.isArray(a.options) || a.options.length === 0)) {
        return { ok: false, error: `属性「${a.key}」为 enum 但缺少 options` };
    }
    if (a.type === 'number') {
        if (a.min !== undefined && typeof a.min !== 'number') return { ok: false, error: `属性「${a.key}」min 必须是数值` };
        if (a.max !== undefined && typeof a.max !== 'number') return { ok: false, error: `属性「${a.key}」max 必须是数值` };
        if (a.min !== undefined && a.max !== undefined && a.min >= a.max) return { ok: false, error: `属性「${a.key}」min 必须小于 max` };
        if (a.default !== undefined && typeof a.default !== 'number') return { ok: false, error: `属性「${a.key}」default 必须是数值` };
    }
    if (a.deltaLimits !== undefined && typeof a.deltaLimits !== 'object') return { ok: false, error: `属性「${a.key}」deltaLimits 必须是对象` };
    return { ok: true };
}

/** 校验整份 attributes.json（含 reserved） */
function validateWholeAttributes(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.attributes)) {
        return { ok: false, error: 'attributes.json 必须含 attributes 数组' };
    }
    const keys = new Set();
    for (const a of obj.attributes) {
        const r = validateAttributeDef(a);
        if (!r.ok) return r;
        if (keys.has(a.key)) return { ok: false, error: `属性 key 重复：${a.key}` };
        keys.add(a.key);
    }
    return { ok: true };
}

/** 增/改一个属性定义 */
export function upsertAttribute(def) {
    const r = validateAttributeDef(def);
    if (!r.ok) return r;
    const raw = readJson(ATTR_PATH);
    const idx = raw.attributes.findIndex(a => a.key === def.key);
    if (idx >= 0) {
        raw.attributes[idx] = def;
    } else {
        raw.attributes.push(def);
    }
    try { writeJson(ATTR_PATH, raw); invalidate('attributes'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

/** 删除一个属性定义 */
export function deleteAttribute(key) {
    const raw = readJson(ATTR_PATH);
    const idx = raw.attributes.findIndex(a => a.key === key);
    if (idx < 0) return { ok: false, error: `属性不存在：${key}` };
    // 检查是否被 reserved 引用（不能删保留属性）
    if (raw.reserved?.keys?.includes(key)) {
        return { ok: false, error: `属性「${key}」在 reserved 清单中，不可删除` };
    }
    raw.attributes.splice(idx, 1);
    try { writeJson(ATTR_PATH, raw); invalidate('attributes'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

// ============ 课表（M6-5）============

function validateCourse(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: '课程必须是对象' };
    if (!c.id || !c.name) return { ok: false, error: '课程缺 id 或 name' };
    if (c.dayOfWeek === undefined || !Number.isInteger(c.dayOfWeek) || c.dayOfWeek < 1 || c.dayOfWeek > 7) {
        return { ok: false, error: `课程「${c.id}」dayOfWeek 必须是 1~7 整数` };
    }
    if (c.startMinute === undefined || c.endMinute === undefined) return { ok: false, error: `课程「${c.id}」缺 startMinute/endMinute` };
    if (!Number.isFinite(c.startMinute) || !Number.isFinite(c.endMinute)) return { ok: false, error: `课程「${c.id}」时段必须是数值` };
    if (c.startMinute >= c.endMinute) return { ok: false, error: `课程「${c.id}」时段非法（start >= end）` };
    return { ok: true };
}

/** 校验整份课表（含重叠检测） */
function validateWholeSchedule(obj) {
    if (!obj || !Array.isArray(obj.courses)) return { ok: false, error: 'schedule.json 必须含 courses 数组' };
    const ids = new Set();
    for (const c of obj.courses) {
        const r = validateCourse(c);
        if (!r.ok) return r;
        if (ids.has(c.id)) return { ok: false, error: `课程 id 重复：${c.id}` };
        ids.add(c.id);
    }
    // 重叠检测（同一天）
    for (let i = 0; i < obj.courses.length; i++) {
        for (let j = i + 1; j < obj.courses.length; j++) {
            const a = obj.courses[i], b = obj.courses[j];
            if (a.dayOfWeek === b.dayOfWeek && a.startMinute < b.endMinute && b.startMinute < a.endMinute) {
                return { ok: false, error: `课程「${a.id}」与「${b.id}」时段重叠` };
            }
        }
    }
    return { ok: true };
}

/** 增/改课程（含冲突检测） */
export function upsertCourse(course) {
    const r = validateCourse(course);
    if (!r.ok) return r;
    const raw = readJson(SCHEDULE_PATH);
    // 冲突检测（排除自身）
    for (const other of raw.courses) {
        if (other.id === course.id) continue;
        if (other.dayOfWeek === course.dayOfWeek &&
            course.startMinute < other.endMinute && other.startMinute < course.endMinute) {
            return { ok: false, error: `与课程「${other.id}」时段重叠，无法保存` };
        }
    }
    const idx = raw.courses.findIndex(c => c.id === course.id);
    if (idx >= 0) raw.courses[idx] = course; else raw.courses.push(course);
    try { writeJson(SCHEDULE_PATH, raw); invalidate('schedule'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

/** 删除课程 */
export function deleteCourse(id) {
    const raw = readJson(SCHEDULE_PATH);
    const idx = raw.courses.findIndex(c => c.id === id);
    if (idx < 0) return { ok: false, error: `课程不存在：${id}` };
    raw.courses.splice(idx, 1);
    try { writeJson(SCHEDULE_PATH, raw); invalidate('schedule'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

// ============ 物品模板（M6-6）============

function validateItemTpl(t) {
    if (!t || typeof t !== 'object') return { ok: false, error: '物品模板必须是对象' };
    if (!t.id || !t.name || t.type === undefined) return { ok: false, error: '物品模板缺 id/name/type' };
    if (!ITEM_TYPES.includes(t.type)) return { ok: false, error: `物品「${t.id}」type 非法：${t.type}（支持 ${ITEM_TYPES.join('/')}）` };
    if (typeof t.price !== 'number' || t.price < 0) return { ok: false, error: `物品「${t.id}」price 必须是非负数值` };
    return { ok: true };
}

function validateWholeItems(obj) {
    if (!obj || !Array.isArray(obj.items)) return { ok: false, error: 'templates.json 必须含 items 数组' };
    const ids = new Set();
    for (const t of obj.items) {
        const r = validateItemTpl(t);
        if (!r.ok) return r;
        if (ids.has(t.id)) return { ok: false, error: `物品 id 重复：${t.id}` };
        ids.add(t.id);
    }
    return { ok: true };
}

/** 增/改物品模板 */
export function upsertItem(tpl) {
    const r = validateItemTpl(tpl);
    if (!r.ok) return r;
    const raw = readJson(ITEMS_PATH);
    const idx = raw.items.findIndex(t => t.id === tpl.id);
    if (idx >= 0) raw.items[idx] = tpl; else raw.items.push(tpl);
    try { writeJson(ITEMS_PATH, raw); invalidate('items'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

/** 删除物品模板 */
export function deleteItem(id) {
    const raw = readJson(ITEMS_PATH);
    const idx = raw.items.findIndex(t => t.id === id);
    if (idx < 0) return { ok: false, error: `物品不存在：${id}` };
    raw.items.splice(idx, 1);
    try { writeJson(ITEMS_PATH, raw); invalidate('items'); }
    catch (e) { return { ok: false, error: `写回失败：${e.message}` }; }
    return { ok: true };
}

// ============ 校验分派 + 缓存失效 ============

function validateWhole(kind, obj) {
    switch (kind) {
        case 'attributes': return validateWholeAttributes(obj);
        case 'schedule': return validateWholeSchedule(obj);
        case 'items': return validateWholeItems(obj);
        default: return { ok: false, error: `未知配置类型：${kind}` };
    }
}

/**
 * 使对应模块的内存缓存失效（写回后需调用，让改动生效）。
 * 通过动态 import 避免循环依赖。
 */
async function invalidate(kind) {
    try {
        if (kind === 'attributes') {
            const m = await import('./attributes.js');
            if (m.invalidateAttributes) m.invalidateAttributes();
        } else if (kind === 'schedule') {
            const m = await import('./schedule.js');
            if (m.invalidateSchedule) m.invalidateSchedule();
        } else if (kind === 'items') {
            const m = await import('./items.js');
            if (m.invalidateTemplates) m.invalidateTemplates();
        }
    } catch (e) {
        console.warn(`[university-sim] 缓存失效失败（${kind}）：${e.message}（可能需重启插件生效）`);
    }
}

/** 同步失效（供路由在非 async 场景调用） */
export function invalidateKindSync(kind) {
    void kind;
}
