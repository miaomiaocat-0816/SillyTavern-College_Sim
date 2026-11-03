/**
 * 角色卡扫描 + 角色池（M4-1 ~ M4-3, M4-5）
 *
 * M4-1：扫描角色卡目录的 PNG，读 chara chunk（tEXt），解析为 JSON
 * M4-2：解析 university_sim 扩展字段（scenes[]/probability/conditions[]），缺失视为可选
 * M4-3：角色池 + 场景筛选（getPool(scene)）
 * M4-5：触发判定（场景匹配 + 概率 + 冷却）
 *
 * 设计约束（铁律 R6）：只读 ST 角色卡目录，不写回；兼容无扩展字段的标准 ST 卡。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** ST 角色卡目录（default-user/characters） */
const DEFAULT_CHAR_DIR = path.join(__dirname, '..', '..', '..', 'data', 'default-user', 'characters');

/** 场景常量 */
export const SCENES = {
    CANTEEN: 'canteen',       // 食堂
    CLASSROOM: 'classroom',   // 教室
    LIBRARY: 'library',       // 图书馆
    DORM: 'dorm',             // 宿舍
    CAMPUS: 'campus',         // 校园
    STREET: 'street',         // 街道
};

/**
 * 从 PNG 缓冲区提取 chara chunk 里的角色卡 JSON。
 * 复刻 ST 的 extractDataFromPng 逻辑（tEXt chunk，identifier=chara，base64）。
 *
 * @param {Buffer|Uint8Array} data PNG 文件字节
 * @returns {object|null} 角色卡 JSON，失败返回 null
 */
export function extractCharacterFromPng(data) {
    const identifier = 'chara';
    // 校验 PNG 头
    if (!data || data.length < 8) return null;
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) {
        if (data[i] !== sig[i]) return null; // 非 PNG
    }

    let idx = 8;
    const chunks = [];
    let ended = false;
    const uint8 = new Uint8Array(4);
    const uint32 = new Uint32Array(uint8.buffer);

    while (idx < data.length) {
        // 读 chunk 长度（4 字节，大端）
        uint8[3] = data[idx++];
        uint8[2] = data[idx++];
        uint8[1] = data[idx++];
        uint8[0] = data[idx++];
        let length = uint32[0];

        // 读 chunk type（4 字节 ASCII）
        const type = String.fromCharCode(data[idx++], data[idx++], data[idx++], data[idx++]);

        if (type === 'IEND') { ended = true; break; }

        // 读 chunk data
        const chunkData = new Uint8Array(length);
        for (let i = 0; i < length; i++) chunkData[i] = data[idx++];

        // 跳过 CRC（4 字节）
        idx += 4;

        if (type === 'tEXt') chunks.push(chunkData);
    }

    if (!ended) return null; // 文件不完整

    // 找 chara 标识的 tEXt chunk
    for (const chunk of chunks) {
        if (chunk.length <= identifier.length) continue;
        let match = true;
        for (let i = 0; i < identifier.length; i++) {
            if (chunk[i] !== identifier.charCodeAt(i)) { match = false; break; }
        }
        if (!match) continue;

        // 跳过 "chara\0" 前缀，读取 base64
        let b64 = '';
        for (let i = identifier.length + 1; i < chunk.length; i++) {
            b64 += String.fromCharCode(chunk[i]);
        }
        try {
            return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        } catch (e) {
            return null;
        }
    }
    return null;
}

/**
 * 解析角色卡的 university_sim 扩展字段。
 * @param {object} chara 角色卡 JSON
 * @returns {{scenes:string[], probability:number, conditions:string[]}}
 */
export function parseUniSimMeta(chara) {
    const meta = chara?.extensions?.university_sim || chara?.university_sim;
    if (!meta || typeof meta !== 'object') {
        return { scenes: [], probability: 0, conditions: [] };
    }
    const scenes = Array.isArray(meta.scenes) ? meta.scenes.filter(s => typeof s === 'string') : [];
    const probability = typeof meta.probability === 'number' ? meta.probability : 0;
    const conditions = Array.isArray(meta.conditions) ? meta.conditions.filter(c => typeof c === 'string') : [];
    return { scenes, probability, conditions };
}

/**
 * 扫描角色卡目录，返回池中所有卡片记录。
 * 非 PNG、损坏 PNG、无 chara chunk 的 PNG 跳过并告警（不中断）。
 *
 * @param {string} [charDir] 角色卡目录，默认 ST default-user/characters
 * @returns {{cards: Array, warnings: string[]}}
 */
export function scanPool(charDir = DEFAULT_CHAR_DIR) {
    const cards = [];
    const warnings = [];

    let files = [];
    try {
        files = fs.readdirSync(charDir);
    } catch (e) {
        warnings.push(`角色卡目录不可读：${charDir}（${e.message}）`);
        return { cards, warnings };
    }

    for (const file of files) {
        if (!file.toLowerCase().endsWith('.png')) continue;
        const fp = path.join(charDir, file);
        let buf;
        try {
            buf = fs.readFileSync(fp);
        } catch (e) {
            warnings.push(`跳过 ${file}：读取失败（${e.message}）`);
            continue;
        }

        const chara = extractCharacterFromPng(buf);
        if (!chara) {
            warnings.push(`跳过 ${file}：无 chara 数据或损坏 PNG`);
            continue;
        }

        const meta = parseUniSimMeta(chara);
        cards.push({
            id: chara.name ? String(chara.name).replace(/[^a-zA-Z0-9_.-]/g, '_') : path.basename(file, '.png'),
            name: chara.name || path.basename(file, '.png'),
            file,
            description: chara.description || '',
            first_mes: chara.first_mes || '',
            personality: chara.personality || '',
            scenario: chara.scenario || '',
            scenes: meta.scenes,
            probability: meta.probability,
            conditions: meta.conditions,
            // 运行时字段（M4-4/6/10 用）
            enabled: true,
            active: false,          // 是否正在临时注入中
            activeUntil: 0,         // 注入结束时间戳
            lastTriggered: 0,       // 上次触发时间戳（冷却用）
            cooldownMs: 0,          // 冷却时长
            affinityThreshold: 60,  // 转常驻好感阈值
            lastInteraction: 0,
        });
    }

    return { cards, warnings };
}

/**
 * 按场景筛选角色池（始终排除 disabled 的卡）。
 * @param {Array} cards 池中卡片
 * @param {string|null} scene 场景（null 返回全部启用的卡）
 * @returns {Array}
 */
export function filterPoolByScene(cards, scene) {
    const enabled = cards.filter(c => c.enabled);
    if (!scene) return enabled;
    return enabled.filter(c => (c.scenes || []).includes(scene));
}

/**
 * 触发判定（M4-5）：场景匹配 + 概率 + 冷却。
 *
 * @param {object} card 卡片
 * @param {string} scene 当前场景
 * @param {number} now 当前时间戳
 * @returns {{triggered:boolean, reason:string}}
 */
export function shouldTrigger(card, scene, now) {
    if (!card.enabled) return { triggered: false, reason: 'disabled' };
    if (!(card.scenes || []).includes(scene)) return { triggered: false, reason: 'scene_mismatch' };

    // 冷却检查
    if (card.cooldownMs > 0 && now - card.lastTriggered < card.cooldownMs) {
        return { triggered: false, reason: 'cooldown' };
    }

    // 概率判定（probability=1.0 必触发，0 永不触发）
    const p = card.probability;
    if (p <= 0) return { triggered: false, reason: 'probability_zero' };
    if (p >= 1) return { triggered: true, reason: 'certain' };
    if (Math.random() < p) return { triggered: true, reason: 'probability_hit' };
    return { triggered: false, reason: 'probability_miss' };
}

/**
 * 标记卡片已触发（更新 lastTriggered 与 active 状态）。
 */
export function markTriggered(card, now, activeDurationMs) {
    card.lastTriggered = now;
    card.active = true;
    card.activeUntil = now + (activeDurationMs || 0);
}

/**
 * 判断卡片注入是否超时（应卸载）。
 */
export function isActiveExpired(card, now) {
    return card.active && card.activeUntil > 0 && now > card.activeUntil;
}

/**
 * 导出默认角色卡目录（供测试/外部查看）。
 */
export function getDefaultCharDir() {
    return DEFAULT_CHAR_DIR;
}
