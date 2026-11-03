/**
 * 路由注册（M1-6 + M2 全部子系统）
 *
 * 统一约定：所有响应 { ok, data?, error? }
 * 统一错误处理：未找到路由 404、异常 500（不泄露堆栈）
 */

import { getState, mutate } from '../lib/bus.js';
import { start, tick, formatRpTime } from '../lib/time-engine.js';
import { getAllTemplates } from '../lib/items.js';
import { aggregateInventory } from '../lib/inventory.js';
import * as actions from '../lib/actions.js';
import * as delivery from '../lib/delivery.js';
import { getSchedule, getClassAt, isBlockedAction } from '../lib/schedule.js';
import { getAllAttributeDefs, createAttributeValues, getRoleValues, parsePath, coerceValue } from '../lib/attributes.js';
import { buildSummary } from '../lib/summary.js';
import { parseProposal, normalizeEffect, PROPOSAL_PROMPT_TEMPLATE } from '../lib/proposal.js';
import { applyEffects, getAudit } from '../lib/arbiter.js';
import { loadAllConstraints, getActiveLoreText, applyLoreConstraints } from '../lib/lore.js';
import { pushEvent, sortQueue, arbitrate } from '../lib/events.js';
import { scanPool, filterPoolByScene, shouldTrigger, markTriggered } from '../lib/pool.js';
import { activateEncounter, deactivateEncounter, isEncounterExpired, promoteToResident } from '../lib/encounter.js';
import { parseIntent, buildIntentPrompt, buildNpcSpeechPrompt } from '../lib/intent.js';

/** 从请求中提取 chatId */
function extractChatId(req) {
    return req.body?.chatId || req.query?.chatId || req.headers['x-chat-id'] || 'default';
}

function ok(res, data) {
    res.json({ ok: true, data });
}
function fail(res, status, code, message) {
    res.status(status).json({ ok: false, error: { code, message } });
}
function wrap(handler) {
    return async (req, res, next) => {
        try {
            await handler(req, res, next);
        } catch (e) {
            console.error('[university-sim] 路由异常', e);
            if (!res.headersSent) {
                fail(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
            } else {
                next(e);
            }
        }
    };
}

/** 确保玩家属性实例已初始化 */
function ensureAttributes(state) {
    if (!state.attributes) state.attributes = {};
    if (!state.attributes.self || Object.keys(state.attributes.self).length === 0) {
        state.attributes.self = createAttributeValues('self');
    }
}

/** @param {import('express').Router} router */
export function registerRoutes(router) {
    // ===== 基础 =====
    router.get('/ping', (req, res) => ok(res, { pong: true, plugin: 'university-sim' }));

    router.get('/state', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        ok(res, {
            chatId,
            ...state,
            timeLabel: formatRpTime(state.time.epochMinute).label,
        });
    }));

    // ===== 时间 =====
    router.post('/time', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { action, value } = req.body || {};
        if (action === 'setRate') {
            const rate = Number(value);
            if (!Number.isFinite(rate) || rate <= 0) {
                return fail(res, 400, 'INVALID_RATE', '倍率必须是正数');
            }
            const s = await mutate(chatId, (state) => { state.time.rate = rate; });
            return ok(res, { time: s.time });
        }
        if (action === 'pause') {
            const s = await mutate(chatId, (state) => { state.time.paused = true; });
            return ok(res, { time: s.time });
        }
        if (action === 'resume') {
            const s = await mutate(chatId, (state) => { state.time.paused = false; });
            return ok(res, { time: s.time });
        }
        return fail(res, 400, 'INVALID_ACTION', 'action 必须是 setRate/pause/resume');
    }));

    router.post('/tick', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        await tick(chatId);
        const state = await getState(chatId);
        ok(res, { time: state.time, timeLabel: formatRpTime(state.time.epochMinute).label });
    }));

    router.post('/time/start', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        start(chatId);
        ok(res, { started: true, chatId });
    }));

    // ===== 物品模板 =====
    router.get('/items/templates', wrap(async (req, res) => {
        ok(res, getAllTemplates());
    }));

    // ===== 背包 =====
    router.get('/inventory', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        ok(res, {
            aggregate: aggregateInventory(state),
            raw: state.inventory,
        });
    }));

    // ===== 动作（buy/use/discard/lend/return/lose）=====
    router.post('/action', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { type, ...args } = req.body || {};

        // 上课时段动作限制（M2-14）
        const state = await getState(chatId);
        if (isBlockedAction(state, type)) {
            return fail(res, 409, 'BLOCKED_IN_CLASS', '上课中，该动作被限制');
        }

        // 世界书 L0 约束（M3-19）：先于一切属性规则
        const loreCheck = applyLoreConstraints(state, type, null);
        if (loreCheck.blocked) {
            return fail(res, 409, loreCheck.code, loreCheck.reason);
        }

        // 映射动作类型到处理函数
        const handlerMap = {
            buy: actions.buy,
            use: actions.use,
            discard: actions.discard,
            lend: actions.lend,
            return: actions.returnItem,
            lose: actions.lose,
            order: delivery.order,
            pickup: delivery.pickup,
        };
        const handler = handlerMap[type];
        if (!handler) {
            return fail(res, 400, 'INVALID_ACTION', `未知动作类型：${type}`);
        }

        const result = await mutate(chatId, (st) => {
            ensureAttributes(st);
            return handler(st, args);
        });

        if (!result.ok) {
            return fail(res, 400, result.error.code, result.error.message);
        }
        ok(res, result.data);
    }));

    // ===== 快递 =====
    router.get('/deliveries', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        ok(res, state.deliveries);
    }));

    // ===== 课程 =====
    router.get('/schedule', wrap(async (req, res) => {
        ok(res, getSchedule());
    }));

    router.get('/schedule/now', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        const cls = getClassAt(state.time.epochMinute);
        ok(res, { inClass: !!cls, course: cls });
    }));

    // ===== 属性 =====
    router.get('/attributes', wrap(async (req, res) => {
        ok(res, getAllAttributeDefs());
    }));

    router.get('/attributes/:path', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        const pathStr = req.params.path;
        const parsed = parsePath(pathStr);
        if (!parsed) return fail(res, 400, 'INVALID_PATH', '属性路径格式错误（应为 self.xxx 或 <角色>.xxx）');
        const values = getRoleValues(state, parsed.roleKey);
        if (values === null) return fail(res, 404, 'UNKNOWN_ROLE', `未知角色：${parsed.roleKey}`);
        ok(res, { [parsed.attrKey]: values[parsed.attrKey] });
    }));

    // ===== M3：状态摘要 =====
    router.get('/summary', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        ok(res, { summary: buildSummary(state) });
    }));

    // ===== M3：效果提议（LLM 提议入口）=====
    router.get('/proposal/prompt', wrap(async (req, res) => {
        ok(res, { prompt: PROPOSAL_PROMPT_TEMPLATE });
    }));

    router.post('/proposal', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { raw, effects, narrate, source, apiId } = req.body || {};

        // 解析提议：优先用结构化 effects，否则解析 raw 文本
        let parsed;
        if (Array.isArray(effects)) {
            parsed = { narrate: narrate || '', effects, warnings: [] };
        } else if (raw !== undefined) {
            parsed = parseProposal(raw);
        } else {
            return fail(res, 400, 'INVALID_PROPOSAL', '缺少 effects 或 raw 字段');
        }

        // 规范化每个 effect
        const normalized = [];
        for (const eff of parsed.effects) {
            const r = normalizeEffect(eff);
            if (r.ok) {
                normalized.push(r.effect);
            } else {
                console.warn(`[university-sim] effect 规范化失败：${r.error}`, eff);
            }
        }

        // 裁决并落地
        const result = await mutate(chatId, (st) => {
            ensureAttributes(st);
            return applyEffects(st, normalized, { source: source || 'llm', apiId });
        });

        ok(res, {
            narrate: parsed.narrate,
            applied: result.applied,
            rejected: result.rejected,
            clamped: result.clamped,
            warnings: parsed.warnings,
        });
    }));

    // ===== M3：裁决审计 =====
    router.get('/audit', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        const limit = Number(req.query?.limit) || 20;
        ok(res, getAudit(state, { limit }));
    }));

    // ===== M3：世界书 =====
    router.get('/lore', wrap(async (req, res) => {
        const { constraints, warnings } = loadAllConstraints();
        ok(res, { constraints, warnings, text: getActiveLoreText() });
    }));

    // ===== M3：事件队列 =====
    router.get('/events', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        const queue = sortQueue(state.events || []);
        ok(res, { pending: queue.length, events: queue });
    }));

    router.post('/events/consume', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const result = await mutate(chatId, async (st) => {
            // 叙事处理器：M3 阶段仅做记录（真实叙事由前端 prompt 注入完成）
            const handler = async (event) => {
                // 记录到已消费事件（真实叙事在 M4 NPC 自主时接入 LLM）
                return { ok: true };
            };
            return arbitrate(st, handler);
        });
        ok(res, result);
    }));

    // ===== M4：角色池 =====
    router.get('/pool', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const scene = req.query?.scene || null;
        // 扫描磁盘上的角色卡，同步进 state.pool
        const { cards, warnings } = scanPool();
        const state = await getState(chatId);
        // 合并磁盘卡与运行时状态（保留 enabled/cooldown 等运行时字段）
        const merged = mergePool(state.pool, cards);
        const result = await mutate(chatId, (st) => { st.pool = merged; });
        const filtered = filterPoolByScene(result.pool || merged, scene);
        ok(res, { cards: filtered, total: (result.pool || merged).length, warnings });
    }));

    // 刷新角色池（重新扫描磁盘）
    router.post('/pool/refresh', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { cards, warnings } = scanPool();
        const result = await mutate(chatId, (st) => {
            st.pool = mergePool(st.pool, cards);
            return st.pool;
        });
        ok(res, { cards: result, warnings });
    }));

    // 手动移出/恢复某张卡
    router.post('/pool/toggle', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { cardId, enabled } = req.body || {};
        if (!cardId) return fail(res, 400, 'INVALID_CARD', '缺少 cardId');
        const result = await mutate(chatId, (st) => {
            const card = (st.pool || []).find(c => c.id === cardId);
            if (!card) return { ok: false, error: { code: 'CARD_NOT_FOUND' } };
            card.enabled = (enabled === undefined) ? !card.enabled : !!enabled;
            return { ok: true, card };
        });
        if (!result.ok) return fail(res, 404, result.error.code, '卡片不存在');
        ok(res, result.card);
    }));

    // 立即尝试触发陌生人（场景 + 概率 + 冷却判定）
    router.post('/pool/trigger', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { scene, cardId } = req.body || {};
        if (!scene) return fail(res, 400, 'INVALID_SCENE', '缺少 scene');
        const state = await getState(chatId);
        const now = Date.now();

        // 先刷新池
        const { cards } = scanPool();
        const merged = mergePool(state.pool, cards);

        const result = await mutate(chatId, (st) => {
            st.pool = merged;
            const candidates = cardId
                ? st.pool.filter(c => c.id === cardId)
                : st.pool;
            for (const card of candidates) {
                const decision = shouldTrigger(card, scene, now);
                if (decision.triggered) {
                    markTriggered(card, now, 5 * 60 * 1000); // 注入持续 5 分钟
                    activateEncounter(st, card, scene, now, 5 * 60 * 1000);
                    return { ok: true, triggered: true, card: card.name, reason: decision.reason };
                }
            }
            return { ok: true, triggered: false, reason: 'no_candidate' };
        });

        ok(res, result);
    }));

    // ===== M4：当前活跃相遇 =====
    router.get('/encounter', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        ok(res, {
            active: state.activeEncounter,
            log: state.encounterLog || [],
        });
    }));

    // 结束当前相遇
    router.post('/encounter/end', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { summary } = req.body || {};
        const result = await mutate(chatId, (st) => {
            return deactivateEncounter(st, summary);
        });
        ok(res, result);
    }));

    // ===== M4：转常驻 =====
    router.post('/pool/promote', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { cardId } = req.body || {};
        if (!cardId) return fail(res, 400, 'INVALID_CARD', '缺少 cardId');
        const result = await mutate(chatId, (st) => {
            return promoteToResident(st, cardId);
        });
        if (!result.converted) {
            return fail(res, 400, result.reason, '无法转常驻');
        }
        ok(res, { converted: true, cardId });
    }));

    // ===== M4：意图判定 =====
    router.post('/intent/parse', wrap(async (req, res) => {
        const { raw } = req.body || {};
        ok(res, parseIntent(raw));
    }));

    router.get('/intent/prompt', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const state = await getState(chatId);
        const role = req.query?.role || 'npc';
        const aff = state.attributes?.[role]?.affinity ?? 0;
        ok(res, { prompt: buildIntentPrompt({ name: role, affinity: aff }, state) });
    }));

    // 记录意图判定结果（前端调 generateQuietPrompt 后回传，只入事件队列，不直接写状态）
    router.post('/intent/record', wrap(async (req, res) => {
        const chatId = extractChatId(req);
        const { role, intent, raw } = req.body || {};
        const parsed = parseIntent(raw || intent);
        const result = await mutate(chatId, (st) => {
            if (!st.intent) st.intent = {};
            st.intent[role || 'npc'] = { intent: parsed.intent, parsed: parsed.parsed, at: Date.now() };
            // 判定为 talk → 入事件队列（发言由仲裁器/前端消费）
            if (parsed.intent === 'talk') {
                pushEvent(st, {
                    type: 'npc_speak',
                    priority: 10,
                    payload: { role: role || 'npc', intent: parsed.intent },
                    narrativeHint: `${role || 'npc'} 想主动搭话`,
                });
            }
            return st.intent[role || 'npc'];
        });
        ok(res, { role: role || 'npc', ...result });
    }));

    // ===== 404 兜底 =====
    router.use((req, res) => {
        fail(res, 404, 'NOT_FOUND', '路由不存在');
    });
}

/**
 * 合并磁盘卡与运行时状态：以磁盘卡为准更新静态字段，保留运行时字段
 * （enabled/active/lastTriggered/cooldownMs/lastInteraction）。
 */
function mergePool(existing, diskCards) {
    const map = new Map();
    for (const c of existing || []) map.set(c.id, c);
    return diskCards.map(c => {
        const prev = map.get(c.id);
        if (prev) {
            // 保留运行时字段
            return {
                ...c,
                enabled: prev.enabled,
                active: prev.active,
                activeUntil: prev.activeUntil,
                lastTriggered: prev.lastTriggered,
                cooldownMs: prev.cooldownMs,
                lastInteraction: prev.lastInteraction,
            };
        }
        return c;
    });
}
