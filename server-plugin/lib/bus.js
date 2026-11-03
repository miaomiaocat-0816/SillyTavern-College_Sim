/**
 * 状态总线（State Bus）—— 唯一真值持有者
 *
 * 铁律 R1：真值只存在后端内存 + JSON，前端不持有可写副本
 * 铁律 R2：所有写操作走 bus.mutate()，函数内加锁
 *
 * 设计：
 *  - 内存态按 chatId 分片，每个 chat 一份 state
 *  - 每次 mutate 后异步落盘到 data/<chatId>.json
 *  - 同一 chat 的写操作串行化（简单互斥），避免并发脏写
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

/** @type {Map<string, object>} chatId -> state */
const states = new Map();

/** @type {Map<string, Promise<void>>} chatId -> 当前落盘链（串行化写盘） */
const writeChains = new Map();

/** @type {Map<string, object>} chatId -> 简单互斥锁标记（当前用 Promise 链替代，保留扩展位） */
const locks = new Map();

function dataPath(chatId) {
    // 防路径穿越
    const safe = String(chatId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(DATA_DIR, `${safe}.json`);
}

/** 创建默认状态（M1 最小：时间 + 金钱 + 空背包 + 空快递） */
export function createDefaultState() {
    return {
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        time: {
            // RP 时间，从某固定起点开始，单位：分钟
            // epochMinute: 从起点累计的 RP 分钟数
            epochMinute: 0,
            rate: 1,          // 倍率（1 现实分钟 = rate RP 分钟）
            paused: false,
        },
        money: 200,           // 初始余额（M2 购买用）
        inventory: [],        // 物品实例
        deliveries: [],       // 在途快递
        flags: {},            // 运行时标记（inClass 等）
        attributes: {         // 人物属性（M2：self + NPC）
            self: {},
        },
        events: [],           // 事件队列（M3 消费）
        audit: [],            // 裁决审计日志（M3-13）
        _dailyDeltas: {},     // 当日属性累计变化（M3-11 裁决器用，运行时字段）
        pool: [],             // 陌生人池（M4：角色卡快照）
        encounterLog: [],     // 相遇记录（M4-4：<100字摘要）
        activeEncounter: null,// 当前活跃陌生人注入（M4-4）
        intent: {},           // NPC 意图判定结果（M4-7，key=role）
    };
}

/** 读取某 chat 的状态（不存在则创建默认并落盘） */
export async function getState(chatId) {
    if (states.has(chatId)) {
        return states.get(chatId);
    }
    // 尝试从磁盘加载
    const fp = dataPath(chatId);
    let state;
    if (fs.existsSync(fp)) {
        try {
            state = JSON.parse(fs.readFileSync(fp, 'utf8'));
            state = migrate(state); // 旧存档补齐新字段
        } catch (e) {
            console.error(`[university-sim] 状态文件损坏，重建默认：${fp}`, e);
            state = createDefaultState();
        }
    } else {
        state = createDefaultState();
    }
    states.set(chatId, state);
    return state;
}

/**
 * 状态迁移/补齐：旧存档缺少新字段时，用默认值补齐（不报错）。
 * M2-19 验收：旧存档（无 hunger 等）加载后自动补齐 default。
 */
function migrate(state) {
    const defaults = createDefaultState();
    for (const key of Object.keys(defaults)) {
        if (state[key] === undefined) {
            state[key] = defaults[key];
        }
    }
    // 嵌套补齐
    if (!state.flags) state.flags = {};
    if (!state.attributes) state.attributes = {};
    if (!state.attributes.self) state.attributes.self = {};
    if (!state.audit) state.audit = [];
    if (!state._dailyDeltas) state._dailyDeltas = {};
    if (!state.pool) state.pool = [];
    if (!state.encounterLog) state.encounterLog = [];
    if (!state.intent) state.intent = {};
    return state;
}

/**
 * 唯一写入入口：bus.mutate(chatId, mutator)
 * mutator 同步修改 state（内存态），本函数负责落盘与串行化。
 * mutator 可以有返回值（如动作处理结果），本函数会透传该返回值；
 * 若无返回值则返回修改后的 state（深拷贝，防外部持有可写引用）。
 */
export async function mutate(chatId, mutator) {
    const state = await getState(chatId);

    // 串行化：同一 chat 的写操作按序执行
    const prev = writeChains.get(chatId) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    writeChains.set(chatId, prev.then(() => gate));

    await prev;

    try {
        // 执行写入（mutator 内直接改 state，符合计划书「函数内加锁」语义）
        const result = mutator(state);
        state.updatedAt = Date.now();
        // 落盘
        await persist(chatId, state);
        // 透传 mutator 返回值；无返回值则返回 state 快照
        return result !== undefined ? result : clone(state);
    } finally {
        release();
    }
}

async function persist(chatId, state) {
    const fp = dataPath(chatId);
    // 原子写：先写临时文件再 rename，避免写一半损坏
    const tmp = `${fp}.tmp`;
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tmp, fp);
}

/** 深拷贝（简单实现，状态均为 JSON 可序列化） */
function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/** 导出数据目录路径（供测试/外部查看） */
export function getDataDir() {
    return DATA_DIR;
}
