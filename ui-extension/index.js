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

import { dragElement } from '../../../RossAscends-mods.js';
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
    headers['x-chat-id'] = context.chatId || 'default';
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
            const $row = $(`<div class="us-item-group"></div>`);
            // 头部：名称 + 数量
            const $head = $(`<div class="us-item-row"><span>${g.name}</span><span class="us-item-count">×${g.count}</span></div>`);
            $row.append($head);

            // 每个实例的耐久条 + 操作按钮（可展开）
            for (const inst of g.instances) {
                if (inst.durability !== undefined) {
                    const tpl = g; // 聚合里没有 maxDurability，用相对比例（默认满耐久视为 100%）
                    // 这里用实例自身耐久显示，进度条宽度按 (durability / 已知上限) 估算，上限未知则用耐久值本身
                    const durPct = Math.max(0, Math.min(100, inst.durability * 10));
                    $row.append(`
                        <div class="us-item-instance" data-instance="${inst.id}">
                            <div class="us-item-durability">
                                <div class="us-durability-bar"><div class="us-durability-fill" style="width:${durPct}%"></div></div>
                                <span class="us-durability-val">耐久 ${inst.durability}</span>
                            </div>
                            <div class="us-pool-actions">
                                <button class="us-btn us-btn-use" data-instance="${inst.id}">使用</button>
                                <button class="us-btn us-btn-discard" data-instance="${inst.id}">丢弃</button>
                            </div>
                        </div>
                    `);
                } else {
                    // 无耐久物品（consumable 等）
                    $row.append(`
                        <div class="us-item-instance" data-instance="${inst.id}">
                            <div class="us-pool-actions">
                                <button class="us-btn us-btn-use" data-instance="${inst.id}">使用</button>
                                <button class="us-btn us-btn-discard" data-instance="${inst.id}">丢弃</button>
                            </div>
                        </div>
                    `);
                }
            }
            $el.append($row);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新背包失败`, e);
    }
}

async function refreshDeliveryTab() {
    try {
        const result = await api('GET', '/deliveries');
        if (!result.ok) return;
        const list = result.data || [];
        const $el = $('#us-delivery-list');
        $el.empty();
        if (list.length === 0) {
            $el.append('<div class="us-empty">暂无快递</div>');
            return;
        }
        // 分组：在途 / 已到站
        const inTransit = list.filter(d => d.status === 'in_transit');
        const arrived = list.filter(d => d.status === 'arrived');

        const renderDelivery = (d) => {
            const name = d.items?.[0]?.templateId || d.templateId || '未知物品';
            const qty = d.items?.length || d.qty || 1;
            if (d.status === 'in_transit') {
                return `<div class="us-delivery-row in-transit"><span>${name} ×${qty}</span><span class="us-delivery-countdown">剩余 ${d.arriveAt ? formatRemain(d.arriveAt) : '--'}</span></div>`;
            }
            return `<div class="us-delivery-row arrived"><span>${name} ×${qty}</span><button class="us-btn us-btn-pickup" data-delivery="${d.id}">取件</button></div>`;
        };

        if (inTransit.length > 0) {
            $el.append('<div class="us-delivery-section">在途</div>');
            inTransit.forEach(d => $el.append(renderDelivery(d)));
        }
        if (arrived.length > 0) {
            $el.append('<div class="us-delivery-section">已到站</div>');
            arrived.forEach(d => $el.append(renderDelivery(d)));
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新快递失败`, e);
    }
}

// 格式化剩余 RP 时间（arriveAt 是 epochMinute，需对比当前时间）
async function formatRemain(arriveAt) {
    try {
        const st = await api('GET', '/state');
        if (!st.ok) return '--';
        const now = st.data.time.epochMinute;
        const diff = arriveAt - now;
        if (diff <= 0) return '已到站';
        const hours = Math.floor(diff / 60);
        const mins = diff % 60;
        if (hours > 0) return `${hours}小时${mins}分`;
        return `${mins}分钟`;
    } catch (e) {
        return '--';
    }
}

async function refreshAttributesTab() {
    try {
        const result = await api('GET', '/attributes/display?role=self');
        if (!result.ok) return;
        const $el = $('#us-attributes-list');
        $el.empty();
        if (result.data.length === 0) {
            $el.append('<div class="us-empty">无属性</div>');
            return;
        }
        for (const a of result.data) {
            const widget = a.display.widget || 'number';
            if (widget === 'bar') {
                const pct = a.def?.max ? Math.round((a.value / a.def.max) * 100) : a.value;
                $el.append(`
                    <div class="us-attr-row">
                        <span class="us-attr-label">${a.label}</span>
                        <div class="us-durability-bar"><div class="us-durability-fill" style="width:${pct}%;background:${a.display.color || '#7fa'}"></div></div>
                        <span class="us-attr-value">${a.value}</span>
                    </div>
                `);
            } else if (widget === 'tag') {
                $el.append(`
                    <div class="us-attr-row">
                        <span class="us-attr-label">${a.label}</span>
                        <span class="us-attr-tag" style="border-color:${a.display.color || '#7fa'}">${a.value ?? '—'}</span>
                    </div>
                `);
            } else {
                $el.append(`
                    <div class="us-attr-row">
                        <span class="us-attr-label">${a.label}</span>
                        <span class="us-attr-value">${a.value}</span>
                    </div>
                `);
            }
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新属性失败`, e);
    }
}

async function refreshAffinityTab() {
    try {
        const result = await api('GET', '/state');
        if (!result.ok) return;
        const $el = $('#us-affinity-list');
        $el.empty();
        const attrs = result.data.attributes || {};
        // 收集各 NPC 的 affinity，降序
        const list = [];
        for (const roleKey of Object.keys(attrs)) {
            if (roleKey === 'self') continue;
            const aff = attrs[roleKey]?.affinity;
            if (aff !== undefined) {
                list.push({ role: roleKey, affinity: aff, lastInteraction: attrs[roleKey].lastInteraction || 0 });
            }
        }
        list.sort((a, b) => b.affinity - a.affinity);
        if (list.length === 0) {
            $el.append('<div class="us-empty">暂无 NPC 好感数据</div>');
            return;
        }
        for (const n of list) {
            const lastText = n.lastInteraction ? ` | 上次互动 ${formatTimeAgo(n.lastInteraction)}` : '';
            $el.append(`
                <div class="us-affinity-row">
                    <span class="us-affinity-name">${n.role}</span>
                    <div class="us-durability-bar"><div class="us-durability-fill" style="width:${Math.max(0, Math.min(100, n.affinity))}%;background:#e84393"></div></div>
                    <span class="us-affinity-value">${n.affinity}</span>
                    <span class="us-affinity-last">${lastText}</span>
                </div>
            `);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新好感失败`, e);
    }
}

// 距上次互动的时长（RP 分钟 → 可读）
function formatTimeAgo(rpMinute) {
    const diff = Math.max(0, rpMinute);
    if (diff < 60) return `${diff}分钟前`;
    const hours = Math.floor(diff / 60);
    if (hours < 24) return `${hours}小时前`;
    return `${Math.floor(hours / 24)}天前`;
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

// ============ 角色池（M4-3）============

async function refreshPoolTab() {
    try {
        const [poolRes, encRes] = await Promise.all([
            api('GET', '/pool'),
            api('GET', '/encounter'),
        ]);
        const $el = $('#us-pool-list');
        $el.empty();
        if (!poolRes.ok) return;

        const cards = poolRes.data.cards;
        const active = encRes.data?.active;

        // 活跃相遇提示
        if (active) {
            $el.append(`<div class="us-encounter-active">偶遇中：${active.name}</div>`);
        }

        if (cards.length === 0) {
            $el.append('<div class="us-empty">陌生人池为空（无角色卡或卡无场景标签）</div>');
        }
        for (const c of cards) {
            const scenes = (c.scenes || []).join('、') || '无场景';
            const status = c.active ? '● 活跃' : (c.enabled ? '○' : '✕ 禁用');
            $el.append(`
                <div class="us-pool-row" data-card="${c.id}">
                    <div class="us-pool-head">
                        <span class="us-pool-name">${c.name}</span>
                        <span class="us-pool-status">${status}</span>
                    </div>
                    <div class="us-pool-scenes">场景：${scenes} | 概率：${c.probability}</div>
                    <div class="us-pool-actions">
                        <button class="us-btn us-btn-trigger" data-card="${c.id}">触发</button>
                        <button class="us-btn us-btn-promote" data-card="${c.id}">转常驻</button>
                    </div>
                </div>
            `);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新角色池失败`, e);
    }
}

// 触发陌生人（用当前时间推断场景，简化：默认 campus 场景）
async function triggerEncounter(cardId) {
    const scene = 'campus';
    const result = await api('POST', '/pool/trigger', { scene, cardId });
    if (result.ok && result.data.triggered) {
        toastr?.info(`偶遇了 ${result.data.card}`);
    } else {
        toastr?.warning('未触发（场景不匹配或冷却中）');
    }
    refreshPoolTab();
}

// 转常驻
async function promoteCard(cardId) {
    const result = await api('POST', '/pool/promote', { cardId });
    if (result.ok) {
        toastr?.success(`已将 ${cardId} 转为常驻角色`);
    } else {
        toastr?.warning(`转常驻失败：${result.error?.code || ''}（好感需达阈值）`);
    }
    refreshPoolTab();
}

async function setRate(rate) { await api('POST', '/time', { action: 'setRate', value: rate }); refreshTimeTab(); }
async function pause() { await api('POST', '/time', { action: 'pause' }); refreshTimeTab(); }
async function resume() { await api('POST', '/time', { action: 'resume' }); refreshTimeTab(); }

// 使用物品
async function useItem(instanceId) {
    const result = await api('POST', '/action', { type: 'use', instanceId });
    if (result.ok) {
        toastr?.info('已使用');
    } else {
        toastr?.warning(`使用失败：${result.error?.message || '未知错误'}`);
    }
    refreshInventoryTab();
}

// 丢弃物品
async function discardItem(instanceId) {
    const result = await api('POST', '/action', { type: 'discard', instanceId });
    if (result.ok) {
        toastr?.info('已丢弃');
    } else {
        toastr?.warning(`丢弃失败：${result.error?.message || '未知错误'}`);
    }
    refreshInventoryTab();
}

// 取快递
async function pickupDelivery(deliveryId) {
    const result = await api('POST', '/action', { type: 'pickup', deliveryId });
    if (result.ok) {
        toastr?.success(`取件成功，收到 ${result.data.received?.length || 0} 件物品`);
    } else {
        toastr?.warning(`取件失败：${result.error?.message || '未知错误'}`);
    }
    refreshDeliveryTab();
    refreshInventoryTab();
}

// ============ M6 配置 tab ============

async function refreshSettingsTab() {
    try {
        const result = await api('GET', '/settings');
        if (!result.ok) return;
        const s = result.data;
        // 成人开关
        $('#us-adult-toggle').prop('checked', s.enable_adult_events === true);
        // 概率字段
        const prob = s.probability || {};
        const fields = [
            { key: 'durable_break', label: '破损概率' },
            { key: 'stranger_trigger', label: '陌生人触发' },
            { key: 'affinity_decay_per_rp24h_no_interaction', label: '好感衰减/天' },
        ];
        const $el = $('#us-probability-fields');
        $el.empty();
        for (const f of fields) {
            const val = prob[f.key] !== undefined ? prob[f.key] : '';
            $el.append(`
                <div class="us-field-row">
                    <label>${f.label}</label>
                    <input class="us-input us-prob-input" data-key="${f.key}" type="number" step="0.05" value="${val}">
                </div>
            `);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新配置失败`, e);
    }
}

async function toggleAdult(enabled) {
    const result = await api('POST', '/settings', { enable_adult_events: enabled });
    if (result.ok) {
        toastr?.success(`成人事件已${enabled ? '开启' : '关闭'}（物品/事件列表需刷新）`);
    } else {
        toastr?.warning(`设置失败：${result.error?.message || '未知错误'}`);
    }
}

async function saveProbability() {
    const patch = { probability: {} };
    $('.us-prob-input').each(function () {
        const key = $(this).data('key');
        const val = Number($(this).val());
        if (Number.isFinite(val)) patch.probability[key] = val;
    });
    const result = await api('POST', '/settings', patch);
    if (result.ok) {
        toastr?.success('概率参数已保存（即时生效）');
    } else {
        toastr?.warning(`保存失败：${result.error?.message || '未知错误'}`);
    }
}

async function doSkip() {
    const days = Number($('#us-skip-days').val());
    if (!Number.isFinite(days) || days <= 0) {
        toastr?.warning('请输入正数天数');
        return;
    }
    const result = await api('POST', '/skip', { days });
    if (result.ok) {
        $('#us-skip-result').text(result.data.summary).show();
        refreshTimeTab();
    } else {
        toastr?.warning(`快进失败：${result.error?.message || '未知错误'}`);
    }
}

// ============ M6 规则编辑器 tab ============

let editorKind = 'attributes'; // 当前编辑的配置类型

async function refreshEditorTab() {
    try {
        const result = await api('GET', `/editor/export/${editorKind}`);
        if (!result.ok) return;
        const obj = JSON.parse(result.data.json);
        const $el = $('#us-editor-list');
        $el.empty();
        // 根据类型渲染列表
        if (editorKind === 'attributes') {
            const list = obj.attributes || [];
            for (const a of list) {
                $el.append(`
                    <div class="us-editor-item">
                        <span>${a.key}（${a.label || ''}）</span>
                        <button class="us-btn us-btn-edit" data-kind="attributes" data-id="${a.key}">编辑</button>
                    </div>
                `);
            }
        } else if (editorKind === 'schedule') {
            const list = obj.courses || [];
            for (const c of list) {
                $el.append(`
                    <div class="us-editor-item">
                        <span>${c.name}（周${c.dayOfWeek} ${fmtMinute(c.startMinute)}-${fmtMinute(c.endMinute)}）</span>
                        <button class="us-btn us-btn-del" data-kind="schedule" data-id="${c.id}">删除</button>
                    </div>
                `);
            }
        } else {
            const list = obj.items || [];
            for (const t of list) {
                $el.append(`
                    <div class="us-editor-item">
                        <span>${t.name}（${t.type} ¥${t.price}）</span>
                        <button class="us-btn us-btn-del" data-kind="items" data-id="${t.id}">删除</button>
                    </div>
                `);
            }
        }
        if (obj.attributes?.length === 0 && obj.courses?.length === 0 && obj.items?.length === 0) {
            $el.append('<div class="us-empty">暂无条目</div>');
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新规则编辑器失败`, e);
    }
}

function fmtMinute(m) {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

async function exportEditor() {
    const result = await api('GET', `/editor/export/${editorKind}`);
    if (!result.ok) return;
    // 显示 JSON 到 textarea，供复制
    $('#us-editor-json').val(result.data.json).show();
    toastr?.info('已载入导出 JSON（可复制）');
}

async function importEditor() {
    const json = $('#us-editor-json').val();
    if (!json.trim()) {
        $('#us-editor-json').show();
        toastr?.info('请先粘贴要导入的 JSON');
        return;
    }
    const result = await api('POST', `/editor/import/${editorKind}`, { content: json });
    if (result.ok) {
        toastr?.success('导入成功');
        $('#us-editor-json').hide();
        refreshEditorTab();
    } else {
        toastr?.warning(`导入失败：${result.error?.message || '未知错误'}`);
    }
}

async function deleteEditorItem(id) {
    const result = await api('DELETE', `/editor/${editorKind === 'attributes' ? 'attribute' : editorKind === 'schedule' ? 'course' : 'item'}/${id}`);
    if (result.ok) {
        toastr?.success('已删除');
        refreshEditorTab();
    } else {
        toastr?.warning(`删除失败：${result.error?.message || '未知错误'}`);
    }
}

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
            <div class="us-tab" data-tab="attributes">属性</div>
            <div class="us-tab" data-tab="affinity">好感</div>
            <div class="us-tab" data-tab="pool">角色池</div>
            <div class="us-tab" data-tab="audit">裁决</div>
            <div class="us-tab" data-tab="settings">配置</div>
            <div class="us-tab" data-tab="editor">规则</div>
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
                <div id="us-delivery-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="attributes" style="display:none;">
                <div id="us-attributes-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="affinity" style="display:none;">
                <div id="us-affinity-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="pool" style="display:none;">
                <div id="us-pool-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="audit" style="display:none;">
                <div id="us-audit-list" class="us-list"></div>
            </div>
            <div class="us-pane" data-pane="settings" style="display:none;">
                <div class="us-section-title">成人事件开关</div>
                <div class="us-switch-row">
                    <span class="us-switch-label">启用成人事件</span>
                    <label class="us-toggle">
                        <input type="checkbox" id="us-adult-toggle">
                        <span class="us-toggle-slider"></span>
                    </label>
                </div>
                <div class="us-section-title">概率与触发（即时生效）</div>
                <div id="us-probability-fields"></div>
                <div class="us-section-title">时间跳跃</div>
                <div class="us-skip-row">
                    <input class="us-input" id="us-skip-days" type="number" min="0.5" step="0.5" value="1" style="flex:1">
                    <button class="us-btn" id="us-btn-skip">快进(天)</button>
                </div>
                <div id="us-skip-result" class="us-empty" style="display:none;"></div>
            </div>
            <div class="us-pane" data-pane="editor" style="display:none;">
                <div class="us-editor-subtabs">
                    <div class="us-editor-subtab active" data-kind="attributes">属性</div>
                    <div class="us-editor-subtab" data-kind="schedule">课表</div>
                    <div class="us-editor-subtab" data-kind="items">物品</div>
                </div>
                <div id="us-editor-list" class="us-list" style="max-height:220px;"></div>
                <div class="us-editor-actions">
                    <button class="us-btn" id="us-btn-editor-export">导出</button>
                    <button class="us-btn" id="us-btn-editor-import">导入</button>
                </div>
                <textarea id="us-editor-json" class="us-input" style="width:100%;height:80px;margin-top:6px;display:none;" placeholder="粘贴 JSON 导入"></textarea>
                <button class="us-btn" id="us-btn-editor-apply-import" style="display:none;width:100%;margin-top:4px;">确认导入</button>
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
        if (tab === 'pool') refreshPoolTab();
        if (tab === 'delivery') refreshDeliveryTab();
        if (tab === 'attributes') refreshAttributesTab();
        if (tab === 'affinity') refreshAffinityTab();
        if (tab === 'settings') refreshSettingsTab();
        if (tab === 'editor') refreshEditorTab();
    });

    $('#us-btn-pause').on('click', pause);
    $('#us-btn-resume').on('click', resume);
    $('#us-rate-select').on('change', function () { setRate(Number($(this).val())); });

    // 角色池按钮（事件委托）
    $panel.on('click', '.us-btn-trigger', function () {
        triggerEncounter($(this).data('card'));
    });
    $panel.on('click', '.us-btn-promote', function () {
        promoteCard($(this).data('card'));
    });

    // 背包操作按钮（事件委托）
    $panel.on('click', '.us-btn-use', function () {
        useItem($(this).data('instance'));
    });
    $panel.on('click', '.us-btn-discard', function () {
        discardItem($(this).data('instance'));
    });

    // 快递取件按钮（事件委托）
    $panel.on('click', '.us-btn-pickup', function () {
        pickupDelivery($(this).data('delivery'));
    });

    // M6 配置：成人开关
    $('#us-adult-toggle').on('change', function () {
        toggleAdult($(this).prop('checked'));
    });

    // M6 配置：概率字段失焦即保存
    $panel.on('change', '.us-prob-input', saveProbability);

    // M6 配置：时间跳跃
    $('#us-btn-skip').on('click', doSkip);

    // M6 规则编辑器：子 tab 切换
    $panel.on('click', '.us-editor-subtab', function () {
        editorKind = $(this).data('kind');
        $('.us-editor-subtab').removeClass('active');
        $(this).addClass('active');
        $('#us-editor-json').hide();
        refreshEditorTab();
    });

    // M6 规则编辑器：删除条目
    $panel.on('click', '.us-btn-del', function () {
        deleteEditorItem($(this).data('id'));
    });

    // M6 规则编辑器：导出/导入
    $('#us-btn-editor-export').on('click', exportEditor);
    $('#us-btn-editor-import').on('click', importEditor);
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

    // /us-skip 批量时间跳跃（M6-8）
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-skip',
        helpString: '批量快进 RP 时间：/us-skip <天数>（如 2d、2、0.5）',
        returns: '跳跃摘要',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '跳跃天数（支持 2d 写法）', typeList: ['string'], isRequired: true }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const raw = String(Array.isArray(unnamedArgs) ? unnamedArgs[0] : unnamedArgs).trim();
            const days = Number(raw.replace(/d$/i, ''));
            if (!Number.isFinite(days) || days <= 0) return '用法：/us-skip <天数>，例如 /us-skip 2d 或 /us-skip 0.5';
            const result = await api('POST', '/skip', { chatId: chatId(), days });
            if (!result.ok) return `快进失败：${result.error?.message || '未知错误'}`;
            getContext().sendSystemMessage('system', result.data.summary);
            return result.data.summary;
        },
    }));

    // /us-settings 查看配置（M6-1/7）
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'us-settings',
        helpString: '查看/修改大学模拟配置：/us-settings 或 /us-settings adult on|off',
        returns: '配置信息',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '可选的子命令（adult on/off）', typeList: ['string'], isRequired: false }),
        ],
        callback: async (namedArgs, unnamedArgs) => {
            const args = Array.isArray(unnamedArgs) ? unnamedArgs : [unnamedArgs];
            // 处理 /us-settings adult on|off
            if (args.length >= 2 && args[0] === 'adult') {
                const on = args[1] === 'on' || args[1] === 'true';
                const result = await api('POST', '/settings', { enable_adult_events: on });
                if (!result.ok) return `设置失败：${result.error?.message || '未知错误'}`;
                return `成人事件已${on ? '开启' : '关闭'}`;
            }
            const result = await api('GET', '/settings');
            if (!result.ok) return `查询失败：${result.error?.message || '未知错误'}`;
            const s = result.data;
            const p = s.probability || {};
            return `成人事件：${s.enable_adult_events ? '开' : '关'} | 破损概率 ${p.durable_break} | 陌生人触发 ${p.stranger_trigger} | 好感衰减 ${p.affinity_decay_per_rp24h_no_interaction}/天`;
        },
    }));
}

// ============ NPC 主动发言（M4-8）============

/**
 * 消费事件队列里的 npc_speak 事件：
 * 对判定为 talk 的 NPC，用 generateQuietPrompt 生成发言，
 * 再以系统消息形式发出（不污染主对话上下文）。
 */
let speakingInProgress = false;

async function processNpcSpeakEvents() {
    if (speakingInProgress) return; // 防并发
    speakingInProgress = true;
    try {
        const result = await api('GET', '/events');
        if (!result.ok) return;
        const speakEvents = (result.data.events || []).filter(e => e.type === 'npc_speak');
        if (speakEvents.length === 0) return;

        for (const evt of speakEvents) {
            const role = evt.payload?.role || 'npc';
            // 静默调用 LLM 生成发言（不污染聊天记录）
            let speech = '';
            try {
                const prompt = `你是群聊中的角色「${role}」，请以第一人称主动说一句话（不要带动作描写前缀，直接说内容，不超过40字）。`;
                speech = await context.generateQuietPrompt({ quietPrompt: prompt, quietName: role });
            } catch (e) {
                console.error(`[${MODULE_NAME}] NPC 发言生成失败`, e);
            }

            // 发出系统消息（NPC 发言）
            if (speech && typeof speech === 'string' && speech.trim()) {
                context.sendSystemMessage('user', `${role}：${speech.trim()}`);
                console.log(`[${MODULE_NAME}] NPC「${role}」主动发言：${speech.trim()}`);
            }

            // 消费事件（幂等，避免重复发言）
            await api('POST', '/events/consume', {});
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] NPC 发言事件处理失败`, e);
    } finally {
        speakingInProgress = false;
    }
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

    // 每 10 秒检查 NPC 发言事件（M4-8）
    setInterval(processNpcSpeakEvents, 10000);

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
