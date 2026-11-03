/**
 * 课程系统（M2-12 ~ M2-14）
 *
 * 课表配置 + 上课状态判定 + 上课时段动作限制。
 * 铁律 R7：课表由 data/schedule.json 声明式定义。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = path.join(__dirname, '..', 'data', 'schedule.json');

/** 可配置的受限动作 */
const DEFAULT_BLOCKED_ACTIONS = ['go_out', 'order'];

let schedule = null;

/**
 * 加载并校验课表。
 * 时段重叠 → 报错并指出冲突项。
 */
export function loadSchedule() {
    if (schedule) return schedule;

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    } catch (e) {
        throw new Error(`[schedule] 无法加载课表 ${SCHEDULE_PATH}: ${e.message}`);
    }

    if (!Array.isArray(raw.courses)) {
        throw new Error('[schedule] 课表缺少 courses 数组');
    }

    // 校验字段 + 检测重叠
    const seen = [];
    for (const c of raw.courses) {
        if (!c.id || !c.name || c.dayOfWeek === undefined || c.startMinute === undefined || c.endMinute === undefined) {
            throw new Error(`[schedule] 课程「${c.id || '(未知)'}」缺必填字段`);
        }
        if (c.startMinute >= c.endMinute) {
            throw new Error(`[schedule] 课程「${c.id}」时段非法（start >= end）`);
        }
        // 重叠检测（同一天）
        for (const other of seen) {
            if (other.dayOfWeek === c.dayOfWeek &&
                c.startMinute < other.endMinute && other.startMinute < c.endMinute) {
                throw new Error(`[schedule] 课程「${c.id}」与「${other.id}」时段重叠`);
            }
        }
        seen.push(c);
    }

    schedule = raw;
    return schedule;
}

/** 获取全部课程 */
export function getSchedule() {
    return loadSchedule().courses;
}

/**
 * 判断某 RP 分钟是否在上课中。
 * @param {number} epochMinute 累计 RP 分钟
 * @returns {object|null} 命中的课程，或 null
 */
export function getClassAt(epochMinute) {
    const day = Math.floor(epochMinute / 1440);
    const minuteOfDay = epochMinute % 1440;
    const dayOfWeek = (day % 7) + 1; // 1=周一 ... 7=周日
    const week = Math.floor(day / 7) + 1;
    const isOddWeek = week % 2 === 1;

    for (const c of getSchedule()) {
        if (c.dayOfWeek !== dayOfWeek) continue;
        // 单双周判断
        if (c.weeks === 'odd' && !isOddWeek) continue;
        if (c.weeks === 'even' && isOddWeek) continue;
        if (minuteOfDay >= c.startMinute && minuteOfDay < c.endMinute) {
            return c;
        }
    }
    return null;
}

/**
 * 上课状态判定（由 tick 调用）。
 * 对比前后 inClass 状态，进出时广播事件。
 */
export function updateClassState(state) {
    const cls = getClassAt(state.time.epochMinute);
    const wasInClass = state.flags?.inClass === true;
    const isInClass = !!cls;

    if (!state.flags) state.flags = {};

    if (isInClass && !wasInClass) {
        state.flags.inClass = true;
        (state.events ||= []).push({
            id: `class_start_${cls.id}_${Date.now()}`,
            type: 'class_start',
            ts: Date.now(),
            payload: { courseId: cls.id, name: cls.name },
        });
    } else if (!isInClass && wasInClass) {
        state.flags.inClass = false;
        (state.events ||= []).push({
            id: `class_end_${Date.now()}`,
            type: 'class_end',
            ts: Date.now(),
            payload: {},
        });
    }
    return cls;
}

/**
 * 判断动作是否被上课时段限制。
 */
export function isBlockedAction(state, actionType) {
    if (state.flags?.inClass !== true) return false;
    return DEFAULT_BLOCKED_ACTIONS.includes(actionType);
}
