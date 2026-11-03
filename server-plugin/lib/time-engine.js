/**
 * 时间引擎（Time Engine）
 *
 * 职责：按 RP 倍率推进时间，tick 事件供子系统监听。
 *
 * 设计（M1 最小实现）：
 *  - setInterval 每 60 秒现实时间触发一次 tick
 *  - 每次 tick：若未暂停，则 epochMinute += rate
 *  - 暂停/倍率通过 mutate 修改 state.time
 *  - 定时器在 exit() 统一清理
 *
 * 注意：倍率是「每现实分钟推进多少 RP 分钟」。tick 间隔可配置，
 *       但 M1 先用 60s 现实 = rate RP 分钟的简单模型。
 */

import { getState, mutate } from './bus.js';

const TICK_INTERVAL_MS = 60_000; // 现实 60 秒 tick 一次

/** @type {Map<string, NodeJS.Timeout>} chatId -> interval */
const timers = new Map();

/**
 * 启动某 chat 的时间引擎（幂等，重复调用不叠加）。
 */
export function start(chatId) {
    if (timers.has(chatId)) return;
    const timer = setInterval(async () => {
        try {
            await tick(chatId);
        } catch (e) {
            console.error(`[university-sim] tick 异常 (${chatId})`, e);
        }
    }, TICK_INTERVAL_MS);
    timers.set(chatId, timer);
}

/**
 * 执行一次 tick：未暂停则推进时间。
 * 推进量 = rate（倍率）。即 60s 现实 = rate RP 分钟。
 * 同时结算：快递到站、课程状态、属性衰减。
 */
import { settleArrivals } from './delivery.js';
import { updateClassState } from './schedule.js';

export async function tick(chatId) {
    await mutate(chatId, (state) => {
        const t = state.time;
        if (t.paused) return; // 暂停则时间不动
        const before = t.epochMinute;
        t.epochMinute += Math.max(0, t.rate || 0);
        const after = t.epochMinute;
        // 记录 tick 事件
        (state.events ||= []).push({
            id: `tick_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'tick',
            ts: Date.now(),
            payload: { from: before, to: after, elapsed: after - before },
        });
        // 快递到站结算（M2-9）
        settleArrivals(state);
        // 课程状态判定（M2-13）
        updateClassState(state);
    });
}

/** 停止某 chat 的时间引擎 */
export function stop(chatId) {
    const timer = timers.get(chatId);
    if (timer) {
        clearInterval(timer);
        timers.delete(chatId);
    }
}

/** 停止所有 */
export function stopAll() {
    for (const chatId of [...timers.keys()]) {
        stop(chatId);
    }
}

/** 将 epochMinute 转为人类可读的 RP 时间字符串（起点假设为周一 00:00） */
export function formatRpTime(epochMinute) {
    const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const day = Math.floor(epochMinute / 1440);
    const minuteOfDay = epochMinute % 1440;
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    const week = Math.floor(day / 7) + 1;
    const dow = days[day % 7];
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return { day, week, dow, time: `${hh}:${mm}`, label: `第${week}周 ${dow} ${hh}:${mm}` };
}
