/**
 * 背包系统（M2-3）
 *
 * 职责：加/减物品；同 templateId 的 durable_stack 聚合显示。
 *
 * 铁律 R2：所有写操作通过 bus.mutate()，本模块只提供纯函数，由 routes 层调用。
 */

import { createInstance, getTemplate } from './items.js';

/**
 * 往背包加物品（纯函数，直接改 state.inventory）。
 * 返回新增的实例（或 null）。
 */
export function addItem(state, templateId) {
    const tpl = getTemplate(templateId);
    if (!tpl) return null;
    const inst = createInstance(templateId);
    state.inventory.push(inst);
    return inst;
}

/**
 * 从背包移除指定 id 的实例（纯函数）。
 * 返回被移除的实例（或 null）。
 */
export function removeItem(state, instanceId) {
    const idx = state.inventory.findIndex(i => i.id === instanceId);
    if (idx === -1) return null;
    const [removed] = state.inventory.splice(idx, 1);
    return removed;
}

/** 查找实例 */
export function findItem(state, instanceId) {
    return state.inventory.find(i => i.id === instanceId);
}

/**
 * 生成背包聚合视图（前端展示用）。
 * 同 templateId 的 durable_stack 合并为一条，含 count 与 instances[]。
 */
export function aggregateInventory(state) {
    const groups = new Map();
    for (const inst of state.inventory) {
        const tpl = getTemplate(inst.templateId);
        if (!groups.has(inst.templateId)) {
            groups.set(inst.templateId, {
                templateId: inst.templateId,
                name: tpl?.name || inst.templateId,
                type: tpl?.type || 'unknown',
                count: 0,
                instances: [],
            });
        }
        const g = groups.get(inst.templateId);
        g.count += 1;
        g.instances.push(inst);
    }
    return [...groups.values()];
}

/**
 * 堆叠合并：取件入库时，同 templateId 的物品若可堆叠则合并。
 * M2 简化实现：物品实例始终独立，聚合仅在展示层。取件时直接 push 实例即可。
 */
