/**
 * university-sim 前端 UI 扩展（M1-7 ~ M1-8）
 *
 * 职责：
 *  - 可拖动侧边面板（dragElement + loadMovingUIState）
 *  - 「时间」tab：显示 RP 时间 + 暂停/继续/倍率控件
 *  - 无状态：所有真值从后端 GET，写操作 POST（自动带 CSRF token）
 *
 * 关键 API（M0 实测）：
 *  - getContext().getRequestHeaders()  → 自动带 X-CSRF-Token
 *  - dragElement($el)                  → 可拖动，需 <id>header 子元素
 *  - loadMovingUIState()               → 恢复面板位置
 */

import { dragElement } from '../../../RossAscends-mods.js';

const MODULE_NAME = 'university-sim';
const PANEL_ID = 'university-sim-panel';
const API_BASE = '/api/plugins/university-sim';

let context = null;

/** 轮询定时器 */
let pollTimer = null;

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

/** 更新「时间」tab 显示 */
async function refreshTimeTab() {
    try {
        const result = await api('GET', '/state');
        if (!result.ok) return;
        const d = result.data;
        $('#us-time-label').text(d.timeLabel || '--');
        $('#us-time-raw').text(`${d.time.epochMinute} 分钟（倍率 ×${d.time.rate}${d.time.paused ? '，已暂停' : ''}）`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 刷新时间失败`, e);
    }
}

/** 时间控制 */
async function setRate(rate) {
    await api('POST', '/time', { action: 'setRate', value: rate });
    refreshTimeTab();
}
async function pause() {
    await api('POST', '/time', { action: 'pause' });
    refreshTimeTab();
}
async function resume() {
    await api('POST', '/time', { action: 'resume' });
    refreshTimeTab();
}

/** 构建面板 DOM */
function buildPanel() {
    // 避免重复创建
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
            <div class="us-tab" data-tab="affinity">好感</div>
            <div class="us-tab" data-tab="roster">角色</div>
        </div>
        <div class="us-tab-content">
            <!-- 时间 tab（M1-8） -->
            <div class="us-pane" data-pane="time">
                <div class="us-time-big" id="us-time-label">--</div>
                <div class="us-time-sub" id="us-time-raw">--</div>
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
            <!-- 其他 tab 占位（M2+ 填充） -->
            <div class="us-pane" data-pane="inventory" style="display:none;">背包（M2 实现）</div>
            <div class="us-pane" data-pane="delivery" style="display:none;">快递（M2 实现）</div>
            <div class="us-pane" data-pane="affinity" style="display:none;">好感（M4 实现）</div>
            <div class="us-pane" data-pane="roster" style="display:none;">角色池（M4 实现）</div>
        </div>
    </div>
    `);

    $('body').append($panel);

    // 可拖动
    dragElement($panel);

    // tab 切换
    $('.us-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('.us-tab').removeClass('active');
        $(this).addClass('active');
        $('.us-pane').hide();
        $(`.us-pane[data-pane="${tab}"]`).show();
    });

    // 控件事件
    $('#us-btn-pause').on('click', pause);
    $('#us-btn-resume').on('click', resume);
    $('#us-rate-select').on('change', function () {
        setRate(Number($(this).val()));
    });
}

/** 初始化 */
async function init() {
    context = getContext();

    buildPanel();

    // 通知后端启动时间引擎
    try {
        await api('POST', '/time/start', {});
    } catch (e) {
        console.error(`[${MODULE_NAME}] 启动时间引擎失败`, e);
    }

    // 初始刷新 + 每秒轮询
    refreshTimeTab();
    pollTimer = setInterval(refreshTimeTab, 1000);

    console.log(`[${MODULE_NAME}] UI 扩展 init() 完成，面板已就绪`);
}

export { init };
