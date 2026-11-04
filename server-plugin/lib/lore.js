/**
 * 世界书约束层（M3-15 ~ M3-19，v4 新增）
 *
 * v4 核心设计：世界书升格为「最高优先级规则层」（R0：数据唯一、规则分层）。
 *  - 总线持有数据（data）
 *  - 世界书持有规则（rules）
 *  - 规则内嵌在世界书条目 content 的 <!--us ... us--> 约束块中
 *
 * 约束块格式（M0-8 决定，这里用 <!--us ... us-->）：
 *   <!--us
 *   { "type": "block", "action": "study", "during": "23:30-06:00" }
 *   us-->
 *
 * 本模块职责：
 *  1. 提取约束块（extractConstraintBlocks）
 *  2. 加载世界书条目（loadLore）
 *  3. 剥离约束块（stripConstraintBlocks，注入 prompt 时用）
 *  4. L0 约束裁决（applyLoreConstraints，先于属性规则）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LORE_PATH = path.join(__dirname, '..', 'data', 'lore.json');
const ACTIONS_PATH = path.join(__dirname, '..', 'data', 'actions.json');

const BLOCK_OPEN = '<!--us';
const BLOCK_CLOSE = 'us-->';

/** 动作别名缓存：Map<alias(小写), 标准动作id> */
let actionAliasMap = null;

/**
 * 加载动作别名映射（data/actions.json）。
 * 把「上课/自习/图书馆自习/学习」等表述统一归一化到标准动作标签（study/go_out/order）。
 * 铁律 R7：动作语义由 data/actions.json 声明式定义，加词只改 JSON。
 */
export function loadActionAliases() {
    if (actionAliasMap) return actionAliasMap;

    actionAliasMap = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(ACTIONS_PATH, 'utf8'));
        for (const a of raw.actions || []) {
            if (!a.id) continue;
            // 标准 id 本身也作为匹配词（大小写不敏感）
            actionAliasMap.set(String(a.id).toLowerCase(), a.id);
            for (const alias of a.aliases || []) {
                actionAliasMap.set(String(alias).toLowerCase(), a.id);
            }
        }
    } catch (e) {
        console.warn(`[lore] 动作别名文件加载失败（降级为精确匹配）：${e.message}`);
        actionAliasMap = new Map();
    }
    return actionAliasMap;
}

/** 使动作别名缓存失效（规则编辑器写回后调用） */
export function invalidateActionAliases() {
    actionAliasMap = null;
}

/**
 * 动作归一化：把任意动作词（可能是中文、英文、带场景前缀）归一化到标准动作标签。
 * 例：'去图书馆自习' → 'study'，'study' → 'study'，'上课' → 'study'。
 * 匹配策略：优先「完整别名」精确命中；其次「子串包含」命中（如「去图书馆自习」包含别名「图书馆」「自习」）。
 * 未命中则原样返回（降级为精确匹配行为，不误伤未知动作）。
 *
 * @param {string} action 原始动作词
 * @returns {string} 归一化后的标准动作 id（或原词）
 */
export function normalizeAction(action) {
    if (typeof action !== 'string' || !action) return action;
    const map = loadActionAliases();
    const key = action.toLowerCase();

    // 1. 完整精确命中
    if (map.has(key)) return map.get(key);

    // 2. 子串包含命中（处理「去图书馆自习」这类组合词）
    //    按别名长度降序，优先匹配更长的别名，避免「图书馆」抢在「图书馆自习」前面
    const aliases = [...map.keys()].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
        if (key.includes(alias)) return map.get(alias);
    }

    // 3. 未命中，原样返回
    return action;
}


/**
 * 从文本中提取所有 <!--us ... us--> 约束块。
 * 返回 { blocks: Array<object>, warnings: Array<string> }。
 *
 * 验收（M3-15）：
 *  - 正常条目 → 提取出 JSON 对象
 *  - 无约束块 → 返回空数组，原文完整保留
 *  - JSON 语法错误 → 跳过并警告（含 uid），不抛异常
 *  - 多个块 → 全部提取，按出现顺序
 */
export function extractConstraintBlocks(content, uid = '(未知)') {
    const blocks = [];
    const warnings = [];

    if (typeof content !== 'string') {
        return { blocks, warnings };
    }

    let idx = 0;
    while (true) {
        const start = content.indexOf(BLOCK_OPEN, idx);
        if (start === -1) break;
        const end = content.indexOf(BLOCK_CLOSE, start + BLOCK_OPEN.length);
        if (end === -1) {
            warnings.push(`[lore] 条目「${uid}」约束块未闭合（找到 ${BLOCK_OPEN} 但缺 ${BLOCK_CLOSE}）`);
            break;
        }

        const jsonStr = content.slice(start + BLOCK_OPEN.length, end).trim();
        try {
            const obj = JSON.parse(jsonStr);
            blocks.push(obj);
        } catch (e) {
            warnings.push(`[lore] 条目「${uid}」约束块 JSON 语法错误：${e.message}`);
        }
        idx = end + BLOCK_CLOSE.length;
    }

    return { blocks, warnings };
}

/**
 * 剥离约束块，返回纯文本（注入 prompt 时 LLM 看不到原始 JSON）。
 */
export function stripConstraintBlocks(content) {
    if (typeof content !== 'string') return content;
    return content
        .replace(new RegExp(`${escapeRegExp(BLOCK_OPEN)}[\\s\\S]*?${escapeRegExp(BLOCK_CLOSE)}`, 'g'), '')
        .trim();
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 世界书缓存 */
let lore = null;

/**
 * 加载世界书（data/lore.json）。
 * 结构：{ entries: [ { uid, content, constant, ... } ] }
 */
export function loadLore() {
    if (lore) return lore;
    try {
        const raw = JSON.parse(fs.readFileSync(LORE_PATH, 'utf8'));
        lore = raw.entries || [];
    } catch (e) {
        // 世界书文件不存在时降级为空（不报错，框架仍可运行）
        console.warn(`[lore] 世界书加载失败（降级为空）：${e.message}`);
        lore = [];
    }
    return lore;
}

/**
 * 提取所有世界书条目的约束块（合并）。
 * @returns {{ constraints: Array, warnings: Array }}
 */
export function loadAllConstraints() {
    const constraints = [];
    const warnings = [];
    for (const entry of loadLore()) {
        const { blocks, warnings: w } = extractConstraintBlocks(entry.content, entry.uid);
        for (const b of blocks) {
            constraints.push({ uid: entry.uid, ...b });
        }
        warnings.push(...w);
    }
    return { constraints, warnings };
}

/**
 * 获取激活的世界书条目文本（剥离约束块后），供 prompt 注入。
 * @param {Array<string>} activeUids 激活的条目 uid 列表（空则全部）
 * @returns {string} 拼接后的世界设定文本
 */
export function getActiveLoreText(activeUids = null) {
    const entries = loadLore();
    const selected = activeUids
        ? entries.filter(e => activeUids.includes(e.uid))
        : entries;
    return selected
        .map(e => stripConstraintBlocks(e.content))
        .filter(Boolean)
        .join('\n\n');
}

/**
 * L0 约束裁决（v4 两段式第一段）：先于属性规则执行。
 * 检查世界书约束是否 block 某个动作，或 constrain 某个数值上限。
 *
 * 约束块类型：
 *  - { type: "block", action: "study", during: "23:30-06:00" }  时间段禁止动作
 *  - { type: "block", action: "go_out", when: "inClass" }        状态时禁止
 *  - { type: "constraint", target: "self.health", max: 10 }      单次改动上限
 *
 * @param {object} state
 * @param {string} actionType 动作类型（study/go_out/order/...）
 * @param {string} target 提议的 target 路径（约束用）
 * @returns {{ blocked: boolean, code?: string, reason?: string, maxDelta?: number }}
 */
export function applyLoreConstraints(state, actionType, target) {
    const { constraints } = loadAllConstraints();

    for (const c of constraints) {
        // block 类型：动作禁止
        if (c.type === 'block') {
            // 动作归一化：把「上课/自习/图书馆自习」等统一映射到标准动作标签（如 study），
            // 实现模糊匹配（constraint 块里写 study，玩家说「去自习」也能被拦截）
            const normalizedAction = normalizeAction(actionType);
            const actionMatch = c.action ? c.action === normalizedAction : true;
            if (!actionMatch) continue;

            // during 时间段判断
            if (c.during) {
                if (isInTimeRange(state.time.epochMinute, c.during)) {
                    return { blocked: true, code: 'BLOCKED_BY_LORE', reason: `世界书规则禁止「${actionType}」（时段 ${c.during}）` };
                }
            }

            // when 状态判断
            if (c.when) {
                if (state.flags?.[c.when]) {
                    return { blocked: true, code: 'BLOCKED_BY_LORE', reason: `世界书规则禁止「${actionType}」（状态 ${c.when}）` };
                }
            }
        }

        // constraint 类型：数值上限
        if (c.type === 'constraint' && c.target === target) {
            if (c.max !== undefined) {
                return { blocked: false, maxDelta: c.max };
            }
        }
    }

    return { blocked: false };
}

/**
 * 判断当前 RP 时间是否在 "HH:MM-HH:MM" 范围内（支持跨天）。
 */
export function isInTimeRange(epochMinute, range) {
    const m = String(range).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const [, h1, m1, h2, m2] = m;
    const startMin = Number(h1) * 60 + Number(m1);
    const endMin = Number(h2) * 60 + Number(m2);

    const minuteOfDay = epochMinute % 1440;

    if (startMin <= endMin) {
        // 不跨天
        return minuteOfDay >= startMin && minuteOfDay < endMin;
    } else {
        // 跨天（如 23:30 - 06:00）
        return minuteOfDay >= startMin || minuteOfDay < endMin;
    }
}
