/**
 * university-sim 前端 UI 扩展（M1-7~8 面板 + M3 叙事接入）
 *
 * 职责：
 *  - 可拖动侧边面板（时间/背包/快递/好感/角色 + 审计 tab）
 *  - Prompt 注入器（监听生成前事件，注入 /summary + 世界书约束，两段式）
 *  - 斜杠命令（/us-state /us-buy /us-use /us-deliver /us-advance）
 *  - 数值不进叙事检测（扫描 LLM 输出，命中数值标注黄色警示）
 *
 * 关键 API（M0 实测）：
 *  - getContext().getRequestHeaders()  → 自动带 X-CSRF-Token
 *  - dragElement($el)                  → 可拖动，需 <id>header 子元素
 *  - setExtensionPrompt(key,value,position,depth,scan,role,filter)
 *  - eventSource.on(event_types.X, cb) → 事件监听
 *  - SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))
 */

import { dragElement } from '../../../../RossAscends-mods.js';
import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { SlashCommandParser } from '../../../../scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../scripts/slash-commands/SlashCommand.js';
import { SlashCommandArgument } from '../../../../scripts/slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'university-sim';
const PANEL_ID = 'university-sim-panel';
const API_BASE = '/api/plugins/university-sim';

let context = null;
let pollTimer = null;

/** Prompt 注入 key（固定，供 ST 管理） */
const PROMPT_KEY = 'university-sim-state';

/** 数值检测正则：数字 + 单位（元/块/分钟/小时/个） */
const NUMERIC_PATTERN = /\d+\s*(?:元|块钱|块|分钟|小时|个|点|分)/g;

/** 统一 API 请求 */
async function api(method, path, body) {
    const headers = context.getRequestHeaders();
    const opts = { method, headers };
    if (body !== undefined) {
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    return res.json();
}

// ============ Prompt 注入器（M3-4 + M3-20 两段式）============

/** 当前缓存的摘要与世界书文本 */
let cachedSummary = '';
let cachedLoreText = '';

/**
 * 构建两段式注入块：
 * 【世界设定】（世界书约束剥离后的原文）
 * 【当前状态】（/summary 逐字一致）
 * 【叙事规则】（三条铁律）
 */
function buildInjectionText() {
    const worldSection = cachedLoreText ? `【世界设定】\n${cachedLoreText}` : '';
    const stateSection = cachedSummary ? `【当前状态】\n${cachedSummary}` : '';
    const rulesSection = `【叙事规则】\n1. 叙述中的数字仅为模糊表述，禁止写出具体金额、数量、时间。\n2. 数值以系统面板为准，叙事不得臆造与状态矛盾的数值。\n3. 若叙事与设定冲突，以世界设定为准。`;

    return [worldSection, stateSection, rulesSection].filter(Boolean).join('\n\n');
}

/** 刷新摘要与世界书缓存，并更新注入 */
async function refreshInjection() {
    try {
        const [sumRes, loreRes] = await Promise.all([
            api('GET', '/summary'),
            api('GET', '/lore'),
        ]);
        if (sumRes.ok) cachedSummary = sumRes.data.summary;
        if (loreRes.ok) cachedLoreText = loreRes.data.text || '';
        applyInjection();
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新注入失败`, e);
    }
}

/** 调用 setExtensionPrompt 应用注入 */
function applyInjection() {
    const text = buildInjectionText();
    if (!text) return;
    // position=IN_PROMPT(0)，depth=0，scan=true（让注入块可被 ST 检测），role=SYSTEM
    setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_PROMPT, 0, true, extension_prompt_roles.SYSTEM);
}

/** 关闭注入（关闭扩展时移除） */
function clearInjection() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, 0, false, extension_prompt_roles.SYSTEM);
}

// ============ 数值偏差检测（M3-5~6）============

/**
 * 扫描 LLM 输出的消息文本，检测具体数值。
 * 命中则在消息上标注黄色警示（不修改原文）。
 */
function scanNumericLeak(messageText, messageEl) {
    if (!messageText || typeof messageText !== 'string') return;
    const matches = messageText.match(NUMERIC_PATTERN);
    if (matches && matches.length > 0) {
        // 在消息元素上追加黄色警示标记
        if (messageEl && !messageEl.querySelector('.us-numeric-warning')) {
            const $warn = $(`<div class="us-numeric-warning" title="检测到具体数值，可能违反「数值不进叙事」规则"></div>`);
            $(messageEl).append($warn);
        }
        console.warn(`[${MODULE_NAME}] 检测到数值泄露：${matches.join(', ')}`);
    }
}

// ============ 面板（M1-7~8 + M3 审计 tab）============

async function refreshTimeTab() {
    try {
        const result = await api('GET', '/state');
        if (!result.ok) return;
        const d = result.data;
        $('#us-time-label').text(d.timeLabel || '--');
        $('#us-time-raw').text(`${d.time.epochMinute} 分钟（倍率 ×${d.time.rate}${d.time.paused ? '，已暂停' : ''}）`);
        $('#us-money-label').text(`${d.money} 元`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新时间失败`, e);
    }
}

async function refreshInventoryTab() {
    try {
        const result = await api('GET', '/inventory');
        if (!result.ok) return;
        const groups = result.data.aggregate;
        const $el = $('#us-inventory-list');
        $el.empty();
        if (groups.length === 0) {
            $el.append('<div class="us-empty">背包为空</div>');
            return;
        }
        for (const g of groups) {
            $el.append(`<div class="us-item-row"><span>${g.name}</span><span class="us-item-count">×${g.count}</span></div>`);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新背包失败`, e);
    }
}

async function refreshAuditTab() {
    try {
        const result = await api('GET', '/audit?limit=20');
        if (!result.ok) return;
        const $el = $('#us-audit-list');
        $el.empty();
        if (result.data.length === 0) {
            $el.append('<div class="us-empty">暂无裁决记录</div>');
            return;
        }
        for (const a of result.data) {
            const statusText = a.status === 'applied' ? '✓ 落地' : a.status === 'clamped' ? '⚠ 裁剪' : '✗ 驳回';
            const cls = a.status === 'applied' ? 'applied' : a.status === 'clamped' ? 'clamped' : 'rejected';
            $el.append(`<div class="us-audit-row ${cls}"><span>${statusText}</span><span>${a.target || ''}</span><span>${a.code || ''}</span></div>`);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新审计失败`, e);
    }
}

async function setRate(rate) { await api('POST', '/time', { action: 'setRate', value: rate }); refreshTimeTab(); }
async function pause() { await api('POST', '/time', { action: 'pause' }); refreshTimeTab(); }
async function resume() { await api('POST', '/time', { action: 'resume' }); refreshTimeTab(); }

function buildPanel() {
    if ($(`#${PANEL_ID}`).length) return;

    const $panel = $(`
    <div id="${PANEL_ID}" class="drawer-content us-panel">
        <div id="${PANEL_ID}header" class="drawer-header" style="cursor: move;">
            <span class="us-panel-title">大学模拟</span>
        </div>
        <div class="us-tabs">
            <div class="us-tab active" data-tab="time">时间</div>
            <div class="us-tab" data-tab="inventory">背包</div>
            <div class="us-tab" data-tab="delivery">快递</div>
            <div class="us-tab" data-tab="audit">裁决</div>
        </div>
        <div class="us-tab-content">
            <div class="us-pane" data-pane="time">
                <div class="us-time-big" id="us-time-label">--</div>
                <div class="us-time-sub" id="us-time-raw">--</div>
                <div class="us-money" id="us-money-label">--</div>
                <div class="us-controls">
                    <button id="us-btn-pause" class="us-btn">暂停</button>
                    <button id="us-btn-resume" class="us-btn">继续</button>
                    <select id="us-rate-select" class="us-select">
                        <option value="1">×1</option>
                        <option value="5">×5</option>
                        <option value="30" selected>×30</option>
                        <option value="60">×60</option>
                    </select>
                </div>
            </div>
            <div class="us-pane" data-pane="inventory" style="display:none;">
                <div id="us-inventory-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="delivery" style="display:none;">
                <div class="us-empty">快递（M3 后续完善）</div>
            </div>
            <div class="us-pane" data-pane="audit" style="display:none;">
                <div id="us-audit-list" class="us-list"></div>
            </div>
        </div>
    </div>
    `);

    $('body').append($panel);
    dragElement($panel);

    $('.us-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('.us-tab').removeClass('active');
        $(this).addClass('active');
        $('.us-pane').hide();
        $(`.us-pane[data-pane="${tab}"]`).show();
        if (tab === 'inventory') refreshInventoryTab();
        if (tab === 'audit') refreshAuditTab();
    });

    $('#us-btn-pause').on('click', pause);
    $('#us-btn-resume').on('click', resume);
    $('#us-rate-select').on('change', function () { setRate(Number($(this).val())); });
}

// ============ 斜杠命令（M3-7）============

function registerCommands() {
    const chatId = () => (getContext().chatId || 'default');

    // /us-state
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-state',
        helpString: '输出当前大学模拟状态摘要（系统消息样式）',
        returns: '状态摘要文本',
        callback: async () => {
            const result = await api('GET', `/summary?chatId=${chatId()}`);
            if (!result.ok) return `查询失败：${result.error?.message || '未知错误'}`;
            const summary = result.data.summary;
            // 以系统消息样式输出
            getContext().sendSystemMessage('system', summary);
            return summary;
        },
    }));

    // /us-buy
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-buy',
        helpString: '购买物品：/us-buy <模板id> [数量]',
        returns: '购买结果',
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 2,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '物品模板 id', typeList: ['string'], isRequired: true }),
            SlashCommandArgument.fromProps({ description: '数量（默认 1）', typeList: ['number'], isRequired: false }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const [templateId, qtyStr] = Array.isArray(unnamedArgs) ? unnamedArgs : [unnamedArgs];
            if (!templateId) return '用法：/us-buy <模板id> [数量]，例如 /us-buy instant_noodle 2';
            const result = await api('POST', '/action', { chatId: chatId(), type: 'buy', templateId: String(templateId), qty: Number(qtyStr || 1) });
            if (!result.ok) return `购买失败：${result.error?.message || '未知错误'}`;
            return `已购买，余额 ${result.data.money} 元`;
        },
    }));

    // /us-use
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-use',
        helpString: '使用物品：/us-use <实例id>',
        returns: '使用结果',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '物品实例 id', typeList: ['string'], isRequired: true }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const instanceId = Array.isArray(unnamedArgs) ? unnamedArgs[0] : unnamedArgs;
            if (!instanceId) return '用法：/us-use <实例id>，实例 id 见背包 tab';
            const result = await api('POST', '/action', { chatId: chatId(), type: 'use', instanceId: String(instanceId) });
            if (!result.ok) return `使用失败：${result.error?.message || '未知错误'}`;
            return '已使用';
        },
    }));

    // /us-deliver
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-deliver',
        helpString: '查看快递或取最近快递：/us-deliver [pickup]',
        returns: '快递状态',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'pickup 表示取最近到站快递', typeList: ['string'], isRequired: false }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const arg = Array.isArray(unnamedArgs) ? unnamedArgs[0] : unnamedArgs;
            if (arg === 'pickup') {
                const list = await api('GET', `/deliveries?chatId=${chatId()}`);
                const arrived = (list.data || []).find(d => d.status === 'arrived');
                if (!arrived) return '没有到站的快递';
                const result = await api('POST', '/action', { chatId: chatId(), type: 'pickup', deliveryId: arrived.id });
                if (!result.ok) return `取件失败：${result.error?.message || '未知错误'}`;
                return `取件成功，收到 ${result.data.received.length} 件物品`;
            }
            const list = await api('GET', `/deliveries?chatId=${chatId()}`);
            const inTransit = (list.data || []).filter(d => d.status === 'in_transit').length;
            const arrived = (list.data || []).filter(d => d.status === 'arrived').length;
            return `快递：${inTransit} 件在途，${arrived} 件待取（/us-deliver pickup 取最近快递）`;
        },
    }));

    // /us-advance
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-advance',
        helpString: '推进 RP 时间：/us-advance <分钟数>',
        returns: '推进后的时间',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '推进的 RP 分钟数', typeList: ['number'], isRequired: true }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const minutes = Number(Array.isArray(unnamedArgs) ? unnamedArgs[0] : unnamedArgs);
            if (!Number.isFinite(minutes) || minutes <= 0) return '用法：/us-advance <分钟数>（正整数）';
            // 通过临时设倍率 + tick 实现精确推进
            const result = await api('POST', '/time', { action: 'setRate', value: minutes });
            if (!result.ok) return `推进失败：${result.error?.message || '未知错误'}`;
            const tickRes = await api('POST', '/tick', { chatId: chatId() });
            if (!tickRes.ok) return `推进失败：${tickRes.error?.message || '未知错误'}`;
            return `时间已推进到 ${tickRes.data.timeLabel}`;
        },
    }));
}

// ============ 初始化 ============

async function init() {
    context = getContext();

    buildPanel();
    registerCommands();

    // 启动时间引擎
    try { await api('POST', '/time/start', {}); } catch (e) {
        console.error(`[${MODULE_NAME}] 启动时间引擎失败`, e);
    }

    // 初始刷新 + 注入
    await refreshInjection();
    refreshTimeTab();

    // 每秒轮询时间
    pollTimer = setInterval(() => { refreshTimeTab(); }, 1000);

    // 每 5 秒刷新注入（时间推进后摘要更新）
    setInterval(refreshInjection, 5000);

    // 监听生成前事件：注入 prompt（M3-4）
    context.eventSource.on(context.event_types.GENERATION_STARTED, () => {
        applyInjection();
    });

    // 监听消息接收事件：数值偏差检测（M3-6）
    context.eventSource.on(context.event_types.MESSAGE_RECEIVED, (messageId) => {
        const chat = context.chat;
        if (!chat || messageId === undefined) return;
        const msg = chat[messageId];
        if (msg && msg.mes) {
            const $el = $(`.mes[mesid="${messageId}"]`);
            scanNumericLeak(msg.mes, $el[0]);
        }
    });

    console.log(`[${MODULE_NAME}] UI 扩展 init() 完成，面板 + prompt 注入 + 命令已就绪`);
}

export { init };
