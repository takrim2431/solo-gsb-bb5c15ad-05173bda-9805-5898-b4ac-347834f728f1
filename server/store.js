'use strict';

const fs = require('fs');
const path = require('path');

// 首次启动时写入的示例数据（包含同通道重叠场景，便于排练时直接看到冲突标记）
const SEED_CUES = [
  {
    id: 'cue-a1',
    name: '开场灯光暖场',
    channel: '灯光控制台 A',
    duration: 30,
    startType: 'fixed',
    fixedAt: 0,
    afterCueId: null,
    delayAfter: 0,
  },
  {
    id: 'cue-b1',
    name: '主角上场追光',
    channel: '追光 B',
    duration: 20,
    startType: 'after',
    fixedAt: null,
    afterCueId: 'cue-a1',
    delayAfter: 0,
  },
  {
    id: 'cue-a2',
    name: '第一幕场景光',
    channel: '灯光控制台 A',
    duration: 45,
    startType: 'after',
    fixedAt: null,
    afterCueId: 'cue-b1',
    delayAfter: 5,
  },
  {
    id: 'cue-m1',
    name: '背景音乐淡入',
    channel: '调音台 M',
    duration: 60,
    startType: 'fixed',
    fixedAt: 40,
    afterCueId: null,
    delayAfter: 0,
  },
  {
    id: 'cue-b2',
    name: '双人对话补光',
    channel: '追光 B',
    duration: 15,
    // 与「主角上场追光」(30-50s) 在 45-50s 同通道重叠，演示冲突标记（可保留待排练调整）
    startType: 'fixed',
    fixedAt: 45,
    afterCueId: null,
    delayAfter: 0,
  },
];

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cues = [];
  }

  /** 首次启动若数据文件不存在则创建目录并写入示例（初始化） */
  init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.cues = SEED_CUES.map((c) => ({ ...c }));
      this.persist();
      return true;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`数据文件 ${this.filePath} 不是合法 JSON：${e.message}`);
    }
    if (!Array.isArray(parsed.cues)) {
      throw new Error(`数据文件 ${this.filePath} 缺少 cues 数组`);
    }
    this.cues = parsed.cues;
    return false;
  }

  persist() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cues: this.cues }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

/**
 * 单次排练实况记录的存取（与提示单分离的独立 JSON 文件）。
 * 结构：{ rehearsal: null | { id, startedAt, cuesVersion, cues, schedule, records } }
 */
class RehearsalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.rehearsal = null;
  }

  /** 首次启动若文件不存在则创建目录并写入空记录（初始化） */
  init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.rehearsal = null;
      this.persist();
      return true;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`排练记录文件 ${this.filePath} 不是合法 JSON：${e.message}`);
    }
    const r = parsed.rehearsal;
    if (r && typeof r === 'object') {
      if (!Array.isArray(r.cues) || !Array.isArray(r.schedule) || typeof r.records !== 'object') {
        throw new Error(`排练记录文件 ${this.filePath} 结构不完整（需要 cues / schedule / records）`);
      }
      this.rehearsal = r;
    } else {
      this.rehearsal = null;
    }
    return false;
  }

  persist() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rehearsal: this.rehearsal }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { JsonStore, RehearsalStore, SEED_CUES };
