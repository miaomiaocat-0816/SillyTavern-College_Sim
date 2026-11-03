/**
 * 快递系统（M2-8 ~ M2-11）
 *
 * 下单 → 包裹（物品挂在包裹下，不进背包）→ 到站广播 → 取件入库。
 * 未取件的包裹内物品不可用。
 */

import { getTemplate, createInstance } from './items.js';

/** 快递时效（RP 分钟），默认 120 分钟 = 2 小时 */
const DEFAULT_DELIVERY_TIME = 120;

/**
 * 下单：{ templateId, qty }
 * 扣钱 + 生成包裹。物品挂在包裹下，不进背包。
 */
export function order(state, { templateId, qty = 1 }) {
    const tpl = getTemplate(templateId);
    if (!tpl) return { ok: false, error: { code: 'UNKNOWN_ITEM', message: `物品模板不存在：${templateId}` } };
    if (!Number.isInteger(qty) || qty <= 0) {
        return { ok: false, error: { code: 'INVALID_QTY', message: '数量必须是正整数' } };
    }

    const total = tpl.price * qty;
    if (state.money < total) {
        return { ok: false, error: { code: 'INSUFFICIENT_FUNDS', message: `余额不足：需要 ${total}，当前 ${state.money}` } };
    }

    state.money -= total;

    // 生成包裹，物品挂在包裹下
    const items = [];
    for (let i = 0; i < qty; i++) {
        items.push(createInstance(templateId));
    }
    const delivery = {
        id: `delivery_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        status: 'in_transit',
        orderedAt: state.time.epochMinute,
        arriveAt: state.time.epochMinute + DEFAULT_DELIVERY_TIME,
        items,
    };
    state.deliveries.push(delivery);

    return { ok: true, data: { money: state.money, delivery } };
}

/**
 * 到站结算（由 tick 调用）：把所有 arriveAt <= 当前时间的包裹改为 arrived，并广播事件。
 * 返回本次到站的包裹列表。
 */
export function settleArrivals(state) {
    const now = state.time.epochMinute;
    const arrived = [];
    for (const d of state.deliveries) {
        if (d.status === 'in_transit' && d.arriveAt <= now) {
            d.status = 'arrived';
            arrived.push(d);
            // 广播事件（供 M3 事件仲裁消费）
            (state.events ||= []).push({
                id: `delivery_arrived_${d.id}`,
                type: 'delivery_arrived',
                ts: Date.now(),
                payload: { deliveryId: d.id },
            });
        }
    }
    return arrived;
}

/**
 * 取件入库：{ deliveryId }
 * 未到站 → NOT_ARRIVED；已到站 → 包裹内物品进背包，包裹移除。
 */
export function pickup(state, { deliveryId }) {
    const idx = state.deliveries.findIndex(d => d.id === deliveryId);
    if (idx === -1) {
        return { ok: false, error: { code: 'DELIVERY_NOT_FOUND', message: '包裹不存在' } };
    }
    const delivery = state.deliveries[idx];
    if (delivery.status !== 'arrived') {
        return { ok: false, error: { code: 'NOT_ARRIVED', message: '包裹未到站' } };
    }

    // 物品进背包
    const received = delivery.items;
    for (const item of received) {
        state.inventory.push(item);
    }
    // 移除包裹
    state.deliveries.splice(idx, 1);

    return { ok: true, data: { received } };
}
