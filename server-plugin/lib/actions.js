/**
 * 动作系统（M2-4 ~ M2-7）
 *
 * 玩家动作：buy / use / discard / lend / return / lose
 *
 * 铁律 R2：所有动作通过 bus.mutate() 落地（由 routes 层调用本模块的纯函数）。
 * 每个动作返回 { ok, data?, error? }，失败时状态零变化。
 */

import { getTemplate, createInstance } from './items.js';
import { addItem, removeItem, findItem } from './inventory.js';

/**
 * 购买动作：{ templateId, qty }
 * 钱够 → 扣款 + 加物品；钱不够 → INSUFFICIENT_FUNDS，状态零变化。
 */
export function buy(state, { templateId, qty = 1 }) {
    const tpl = getTemplate(templateId);
    if (!tpl) return { ok: false, error: { code: 'UNKNOWN_ITEM', message: `物品模板不存在：${templateId}` } };
    if (!Number.isInteger(qty) || qty <= 0) {
        return { ok: false, error: { code: 'INVALID_QTY', message: '数量必须是正整数' } };
    }

    const total = tpl.price * qty;
    if (state.money < total) {
        return { ok: false, error: { code: 'INSUFFICIENT_FUNDS', message: `余额不足：需要 ${total}，当前 ${state.money}` } };
    }

    // 原子性：先校验后执行（在 mutate 内同步完成，无并发窗口）
    state.money -= total;
    const added = [];
    for (let i = 0; i < qty; i++) {
        added.push(addItem(state, templateId));
    }

    return { ok: true, data: { money: state.money, added } };
}

/**
 * 使用动作：{ instanceId }
 * consumable → 数量减 1，减到 0 移除；
 * durable/durable_stack → 耐久减 1，到 0 变 broken。
 */
export function use(state, { instanceId }) {
    const inst = findItem(state, instanceId);
    if (!inst) {
        return { ok: false, error: { code: 'ITEM_NOT_IN_INVENTORY', message: '物品不在背包中' } };
    }

    const tpl = getTemplate(inst.templateId);
    if (tpl.type === 'consumable') {
        // 消耗品：用完即移除
        removeItem(state, instanceId);
        return { ok: true, data: { consumed: true, instanceId } };
    }

    if (tpl.type === 'durable' || tpl.type === 'durable_stack') {
        inst.durability = Math.max(0, (inst.durability ?? 0) - 1);
        if (inst.durability === 0) {
            inst.state = 'broken';
        }
        return { ok: true, data: { durability: inst.durability, state: inst.state, instanceId } };
    }

    // unique 类型：不可消耗
    return { ok: false, error: { code: 'NOT_USABLE', message: '该物品不可使用' } };
}

/**
 * 丢弃动作：{ instanceId }
 */
export function discard(state, { instanceId }) {
    const removed = removeItem(state, instanceId);
    if (!removed) {
        return { ok: false, error: { code: 'ITEM_NOT_IN_INVENTORY', message: '物品不在背包中' } };
    }
    return { ok: true, data: { discarded: removed } };
}

/**
 * 借出动作：{ instanceId, borrower, dueAtMinute }
 * 物品标记 borrowed，借出期间本人物品栏不可用（use 被拒）。
 */
export function lend(state, { instanceId, borrower, dueAtMinute }) {
    const inst = findItem(state, instanceId);
    if (!inst) {
        return { ok: false, error: { code: 'ITEM_NOT_IN_INVENTORY', message: '物品不在背包中' } };
    }
    if (!borrower) {
        return { ok: false, error: { code: 'INVALID_BORROWER', message: '缺少借入方' } };
    }
    inst.state = 'borrowed';
    inst.borrowedBy = borrower;
    inst.dueAt = dueAtMinute;
    return { ok: true, data: { instanceId, borrower, dueAt: dueAtMinute } };
}

/**
 * 归还动作：{ instanceId }
 */
export function returnItem(state, { instanceId }) {
    const inst = findItem(state, instanceId);
    if (!inst) {
        return { ok: false, error: { code: 'ITEM_NOT_IN_INVENTORY', message: '物品不在背包中' } };
    }
    if (inst.state !== 'borrowed') {
        return { ok: false, error: { code: 'NOT_BORROWED', message: '该物品未被借出' } };
    }
    inst.state = 'normal';
    delete inst.borrowedBy;
    delete inst.dueAt;
    return { ok: true, data: { instanceId } };
}

/**
 * 遗失动作：{ instanceId }（彻底移除）
 */
export function lose(state, { instanceId }) {
    return discard(state, { instanceId });
}
