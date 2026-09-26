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

module.exports = { createRehearsal, checkStart, checkEnd, rehearsalView };
