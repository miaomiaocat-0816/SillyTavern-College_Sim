/**
 * 配置加载器（M6-1 + M6-7）
 *
 * 统一读取 data/settings.json，提供：
 *  - enable_adult_events 成人事件开关（M6-1，单一开关，铁律 R5）
 *  - probability.* 概率与触发参数（M6-7，破损/陌生人触发/好感衰减）
 *
 * 铁律 R5：成人模块由 enable_adult_events 单一开关控制，
 *          关闭时该模块的 require 都不执行。
 *
 * 注意：settings 属于「配置」而非「运行时状态」，存 data/settings.json
 *       进版本库（与 attributes/schedule/items 一致），运行时按需读写。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

/** 默认配置（文件缺失/字段缺失时兜底） */
const DEFAULT_SETTINGS = {
    version: 1,
    enable_adult_events: false,
    probability: {
        durable_break: 0.2,
        stranger_trigger: 0.3,
        affinity_decay_per_rp24h_no_interaction: -1,
    },
};

/** 内存缓存 */
let cache = null;

/** 深合并默认值（补齐缺失字段，不覆盖已有值） */
function withDefaults(raw) {
    const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
            if (raw[k] !== undefined) {
                if (k === 'probability' && typeof raw.probability === 'object') {
                    merged.probability = { ...merged.probability, ...raw.probability };
                } else {
                    merged[k] = raw[k];
                }
            }
        }
    }
    return merged;
}

/** 加载配置（带缓存）。文件损坏/缺失时回退默认，不崩溃。 */
export function loadSettings() {
    if (cache) return cache;
    let raw = null;
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn(`[university-sim] settings 读取失败，回退默认：${e.message}`);
    }
    cache = withDefaults(raw);
    return cache;
}

/** 读取单个配置值（点分路径，如 'probability.durable_break'） */
export function getSetting(pathStr) {
    const s = loadSettings();
    const parts = String(pathStr).split('.');
    let cur = s;
    for (const p of parts) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[p];
    }
    return cur;
}

/** 成人事件开关（M6-1） */
export function isAdultEnabled() {
    return loadSettings().enable_adult_events === true;
}

/**
 * 写回配置（M6-7 规则编辑器用）。
 * 只允许修改白名单字段，防止误写。
 * @param {object} patch 要合并的配置片段
 * @returns {{ok:boolean, settings:object, error?:string}}
 */
export function updateSettings(patch) {
    const s = loadSettings();
    // 白名单：只允许改 enable_adult_events 与 probability 子字段
    const allowedTop = ['enable_adult_events', 'probability'];
    const allowedProb = ['durable_break', 'stranger_trigger', 'affinity_decay_per_rp24h_no_interaction'];

    if (!patch || typeof patch !== 'object') {
        return { ok: false, error: 'patch 必须是对象' };
    }

    for (const k of Object.keys(patch)) {
        if (!allowedTop.includes(k)) {
            return { ok: false, error: `不允许修改字段：${k}` };
        }
    }

    // 校验 enable_adult_events 类型
    if (patch.enable_adult_events !== undefined && typeof patch.enable_adult_events !== 'boolean') {
        return { ok: false, error: 'enable_adult_events 必须是布尔值' };
    }

    // 校验 probability 字段
    if (patch.probability !== undefined) {
        if (typeof patch.probability !== 'object') {
            return { ok: false, error: 'probability 必须是对象' };
        }
        for (const k of Object.keys(patch.probability)) {
            if (!allowedProb.includes(k)) {
                return { ok: false, error: `不允许修改概率字段：${k}` };
            }
            const v = patch.probability[k];
            if (k === 'affinity_decay_per_rp24h_no_interaction') {
                if (typeof v !== 'number' || !Number.isFinite(v)) {
                    return { ok: false, error: `${k} 必须是有限数值` };
                }
            } else {
                if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
                    return { ok: false, error: `${k} 必须是 0~1 之间的数值` };
                }
            }
        }
        s.probability = { ...s.probability, ...patch.probability };
    }

    if (patch.enable_adult_events !== undefined) {
        s.enable_adult_events = patch.enable_adult_events;
    }

    // 落盘
    try {
        fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
        const tmp = `${SETTINGS_PATH}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
        fs.renameSync(tmp, SETTINGS_PATH);
    } catch (e) {
        return { ok: false, error: `写回失败：${e.message}` };
    }

    cache = s;
    return { ok: true, settings: s };
}

/** 强制失效缓存（外部修改后重新读取） */
export function invalidateSettings() {
    cache = null;
}
