'use strict';

/**
 * 单次排练的实况执行：
 * - 「开始排练」时冻结当前提示单与重算计划（此后修改提示单不影响本次排练）
 * - 按演出秒数逐条登记实际开始 / 实际结束，记录持久化，刷新后可继续
 * - 登记「开始」必须同时满足：
 *   1) 相对开始提示：前置提示已登记实际结束，且 演出秒数 >= 前置实际结束 + 延迟秒数；
 *      固定开始提示：演出秒数 >= 固定开始秒数；
 *   2) 本通道没有进行中（已开始、未结束）的提示；
 *   3) 演出秒数不早于本通道最后一次实际结束（首尾相接可用）。
 * - 登记「结束」：仅进行中的提示可登记，且结束秒数不得早于实际开始。
 * - 勘误：已登记的实际开始/结束秒数可改为另一个非负秒数（未登记字段不能借此补录或清空）；
 *   提交时基于冻结提示与全部当前记录整体重校验，任一记录失效则整次拒绝。
 * - 重置：清空本次排练记录，可开启新一轮；不修改原提示单。
 */

const crypto = require('crypto');
const { round, evaluate } = require('./scheduler');
const { cuesVersion } = require('./defer');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

const REASON_TEXT = {
  missing: '引用了不存在的前置提示',
  cycle: '处于循环依赖中',
  'dep-missing': '其前置引用了不存在的提示',
  'dep-cycle': '其前置处于循环依赖中',
};

function recOf(rehearsal, cueId) {
  const rec = rehearsal.records[cueId];
  if (!rec) return { actualStart: null, actualEnd: null };
  return {
    actualStart: rec.actualStart === undefined ? null : rec.actualStart,
    actualEnd: rec.actualEnd === undefined ? null : rec.actualEnd,
  };
}

/**
 * 开始一次排练：冻结当前提示单快照与重算计划。
 * 提示单为空或存在时间未定的提示时抛出 400。
 */
function createRehearsal(cues) {
  if (!cues.length) {
    throw httpError(400, '当前提示单为空，无法开始排练，请先新增提示');
  }
  const result = evaluate(cues);
  const byId = new Map(cues.map((c) => [c.id, c]));
  const unresolved = result.schedule.filter((s) => s.start === null);
  if (unresolved.length) {
    const errors = unresolved.map((s) => {
      const c = byId.get(s.id);
      return `提示${c ? `「${c.name}」` : `（${s.id}）`}时间未定（${REASON_TEXT[s.reason] || '无法排期'}）`;
    });
    throw httpError(400, '存在时间未定的提示，无法开始排练，请先解决引用或循环依赖问题', errors);
  }

  return {
    id: `run-${crypto.randomBytes(4).toString('hex')}`,
    startedAt: new Date().toISOString(),
    cuesVersion: cuesVersion(cues),
    cues: cues.map((c) => ({ ...c })),
    schedule: result.schedule.map((s) => ({ ...s })),
    records: {}, // { [cueId]: { actualStart, actualEnd } }
  };
}

function findCue(rehearsal, cueId) {
  const cue = rehearsal.cues.find((c) => c.id === cueId);
  if (!cue) {
    throw httpError(404, '该提示不在本次排练冻结的提示单中', [`提示 ${cueId} 不在本次排练中`]);
  }
  return cue;
}

/**
 * 校验在演出秒数 at 登记 cueId 实际开始是否允许。
 * 提示不在本次排练中抛 404；否则返回 { ok, reasons }（reasons 即逐条阻止原因）。
 */
function checkStart(rehearsal, cueId, at) {
  const cue = findCue(rehearsal, cueId);
  const reasons = [];
  const rec = recOf(rehearsal, cueId);

  if (rec.actualStart !== null) {
    reasons.push(
      rec.actualEnd !== null
        ? '该提示已完成，不能重复登记开始'
        : '该提示已在进行中，不能重复登记开始'
    );
  }

  // 条件 1：前置已实际结束且达到 实际结束 + 延迟；固定提示达到固定秒数
  if (cue.startType === 'after') {
    const pred = rehearsal.cues.find((c) => c.id === cue.afterCueId);
    const predRec = recOf(rehearsal, cue.afterCueId);
    if (predRec.actualEnd === null) {
      reasons.push(`前置提示${pred ? `「${pred.name}」` : ''}尚未登记实际结束`);
    } else {
      const earliest = round(predRec.actualEnd + cue.delayAfter);
      if (at < earliest - EPS) {
        reasons.push(
          `未达到前置实际结束 +${round(cue.delayAfter)}s 延迟（最早可于 ${earliest}s 开始）`
        );
      }
    }
  } else if (at < cue.fixedAt - EPS) {
    reasons.push(`未达到固定开始秒数（第 ${round(cue.fixedAt)}s）`);
  }

  // 条件 2 / 3：本通道无进行中提示；不早于本通道最后一次实际结束
  let busyName = null;
  let lastEnd = null;
  for (const other of rehearsal.cues) {
    if (other.id === cueId || other.channel !== cue.channel) continue;
    const r = recOf(rehearsal, other.id);
    if (r.actualStart !== null && r.actualEnd === null) busyName = other.name;
    if (r.actualEnd !== null && (lastEnd === null || r.actualEnd > lastEnd)) {
      lastEnd = r.actualEnd;
    }
  }
  if (busyName !== null) {
    reasons.push(`通道「${cue.channel}」上「${busyName}」正在进行中`);
  }
  if (lastEnd !== null && at < lastEnd - EPS) {
    reasons.push(`早于本通道最后一次实际结束（${lastEnd}s）`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 校验在演出秒数 at 登记 cueId 实际结束是否允许。
 */
function checkEnd(rehearsal, cueId, at) {
  findCue(rehearsal, cueId);
  const reasons = [];
  const rec = recOf(rehearsal, cueId);

  if (rec.actualStart === null) {
    reasons.push('该提示尚未登记实际开始，无法登记结束');
  } else if (rec.actualEnd !== null) {
    reasons.push('该提示已登记实际结束，不能重复登记');
  } else if (at < rec.actualStart - EPS) {
    reasons.push(`结束秒数（${at}s）不得早于实际开始（${rec.actualStart}s）`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 以本次冻结提示为基准，整体校验一组登记记录（勘误提交时使用）。
 * 返回失效原因列表（空数组 = 全部有效），每条原因都点名涉及的提示。
 * 规则：
 *  1) 已登记结束的记录：实际结束不得早于其实际开始；
 *  2) 已登记开始的记录：固定提示不早于固定开始秒数；相对提示的前置必须已登记实际结束，
 *     且不早于 前置实际结束 + 延迟秒数；
 *  3) 同通道已开始的实际区间 [开始, 结束) 互不重叠；进行中（未登记结束）视为开放区间
 *     [开始, +∞)；首尾相接（前一条结束 = 后一条开始）允许。
 */
function validateRecords(rehearsal, records) {
  const reasons = [];
  const byId = new Map(rehearsal.cues.map((c) => [c.id, c]));
  const nameOf = (id) => {
    const c = byId.get(id);
    return c ? `「${c.name}」` : `（${id}）`;
  };
  const recOf = (id) => {
    const r = records[id];
    if (!r) return { actualStart: null, actualEnd: null };
    return {
      actualStart: r.actualStart === undefined ? null : r.actualStart,
      actualEnd: r.actualEnd === undefined ? null : r.actualEnd,
    };
  };

  // 规则 1 / 2：逐条校验（按冻结提示单顺序，保证输出稳定）
  for (const cue of rehearsal.cues) {
    const rec = recOf(cue.id);
    if (rec.actualStart === null) continue;

    if (cue.startType === 'after') {
      const predRec = recOf(cue.afterCueId);
      if (predRec.actualEnd === null) {
        reasons.push(
          `${nameOf(cue.id)}已登记实际开始，但前置提示${nameOf(cue.afterCueId)}尚未登记实际结束`
        );
      } else {
        const earliest = round(predRec.actualEnd + cue.delayAfter);
        if (rec.actualStart < earliest - EPS) {
          reasons.push(
            `${nameOf(cue.id)}实际开始 ${rec.actualStart}s 早于前置${nameOf(cue.afterCueId)}` +
              `实际结束 +${round(cue.delayAfter)}s 延迟（最早可于 ${earliest}s 开始）`
          );
        }
      }
    } else if (rec.actualStart < cue.fixedAt - EPS) {
      reasons.push(
        `${nameOf(cue.id)}实际开始 ${rec.actualStart}s 早于固定开始秒数（第 ${round(cue.fixedAt)}s）`
      );
    }

    if (rec.actualEnd !== null && rec.actualEnd < rec.actualStart - EPS) {
      reasons.push(`${nameOf(cue.id)}实际结束 ${rec.actualEnd}s 早于其实际开始 ${rec.actualStart}s`);
    }
  }

  // 规则 3：同通道已开始区间互不重叠（进行中 = 开放区间，首尾相接允许）
  const byChannel = new Map();
  for (const cue of rehearsal.cues) {
    const rec = recOf(cue.id);
    if (rec.actualStart === null) continue;
    if (!byChannel.has(cue.channel)) byChannel.set(cue.channel, []);
    byChannel.get(cue.channel).push({
      id: cue.id,
      start: rec.actualStart,
      end: rec.actualEnd === null ? Infinity : rec.actualEnd,
    });
  }
  const fmtEnd = (v) => (v === Infinity ? '进行中' : `${v}s`);
  for (const channel of [...byChannel.keys()].sort()) {
    const items = byChannel.get(channel).sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        // 左闭右开重叠：max(start) < min(end)；进行中 end = +∞
        if (Math.max(a.start, b.start) < Math.min(a.end, b.end) - EPS) {
          reasons.push(
            `通道「${channel}」上${nameOf(a.id)}（${a.start}s – ${fmtEnd(a.end)}）与` +
              `${nameOf(b.id)}（${b.start}s – ${fmtEnd(b.end)}）的实际区间重叠`
          );
        }
      }
    }
  }

  return reasons;
}

/**
 * 登记时间勘误：把已登记的实际开始/结束秒数（field 为 actualStart / actualEnd）
 * 改为另一个非负秒数 value。未登记的字段不能借此补录（接口只接受非负秒数，也无法清空）。
 * 改动先应用到全部当前记录的副本上，基于冻结提示整体重校验；
 * 任一记录失效则整次拒绝（原记录不变），通过才把副本写回 rehearsal.records。
 * 提示不在冻结提示单中抛 404；字段未登记抛 409。返回 { ok, reasons }。
 */
function correctRecord(rehearsal, cueId, field, value) {
  findCue(rehearsal, cueId);
  const label = field === 'actualStart' ? '实际开始' : '实际结束';
  const current = recOf(rehearsal, cueId);
  if (current[field] === null) {
    throw httpError(
      409,
      `该提示的${label}尚未登记，勘误不能补录未登记字段（也不能清空已登记字段），请先正常登记`,
      [`该提示的${label}尚未登记，不能通过勘误补录`]
    );
  }

  // 在全部当前记录的副本上应用本次改动
  const next = {};
  for (const id of Object.keys(rehearsal.records)) {
    const r = recOf(rehearsal, id);
    next[id] = { actualStart: r.actualStart, actualEnd: r.actualEnd };
  }
  if (!next[cueId]) next[cueId] = { actualStart: null, actualEnd: null };
  next[cueId][field] = value;

  const reasons = validateRecords(rehearsal, next);
  if (reasons.length) return { ok: false, reasons };

  rehearsal.records = next; // 校验通过，整体写回（调用方负责原子持久化）
  return { ok: true, reasons: [] };
}

/**
 * 排练视图：冻结计划 + 逐条状态（未开始 / 进行中 / 已完成）与计划-实际偏差，按计划开始时间排序。
 */
function rehearsalView(rehearsal) {
  const schedMap = new Map(rehearsal.schedule.map((s) => [s.id, s]));

  const items = rehearsal.cues.map((c) => {
    const t = schedMap.get(c.id) || { start: null, end: null };
    const rec = recOf(rehearsal, c.id);
    const status =
      rec.actualStart === null ? 'pending' : rec.actualEnd === null ? 'running' : 'done';
    return {
      cueId: c.id,
      name: c.name,
      channel: c.channel,
      plannedStart: t.start,
      plannedEnd: t.end,
      actualStart: rec.actualStart,
      actualEnd: rec.actualEnd,
      status,
      startDelta:
        rec.actualStart !== null && t.start !== null ? round(rec.actualStart - t.start) : null,
      endDelta: rec.actualEnd !== null && t.end !== null ? round(rec.actualEnd - t.end) : null,
    };
  });

  items.sort(
    (a, b) =>
      a.plannedStart - b.plannedStart ||
      a.plannedEnd - b.plannedEnd ||
      a.name.localeCompare(b.name)
  );

  const counts = { total: items.length, done: 0, running: 0, pending: 0 };
  for (const it of items) counts[it.status] += 1;

  return {
    id: rehearsal.id,
    startedAt: rehearsal.startedAt,
    cuesVersion: rehearsal.cuesVersion,
    cues: rehearsal.cues,
    schedule: rehearsal.schedule,
    records: rehearsal.records,
    items,
    counts,
  };
}

module.exports = { createRehearsal, checkStart, checkEnd, correctRecord, validateRecords, rehearsalView };
