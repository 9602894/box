// src/main/util/configBackup.ts
// ★ 2026-11-15（用户要求）：user-config.json 被外部程序误删时，自动从备份恢复。
//   - backupUserConfig(dir)：启动时把有内容的 user-config.json 复制到 config-backup/，
//     文件名 user-config.<ISO时间戳>.json，保留最近 5 份；
//   - tryRecoverFromBackup(dir)：当前 user-config.json 不存在 / 解析失败 / sources 和 lives 都为空时，
//     从 config-backup/ 最新一份恢复。
//   ★ 必须在 new SpiderHost() 之前调用，否则 UserConfigManager 已经用空配置初始化。
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  copyFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileLogger } from './logger';

const KEEP = 5;
const BAK_DIR = 'config-backup';
const RE = /^user-config\..*\.json$/;

function isValidConfig(text: string): boolean {
  try {
    const obj = JSON.parse(text) as { sources?: unknown; lives?: unknown };
    return (
      (Array.isArray(obj?.sources) && obj.sources.length > 0) ||
      (Array.isArray(obj?.lives) && obj.lives.length > 0)
    );
  } catch {
    return false;
  }
}

export function backupUserConfig(dir: string): void {
  const file = join(dir, 'user-config.json');
  if (!existsSync(file)) return;
  try {
    const text = readFileSync(file, 'utf-8');
    if (!isValidConfig(text)) return; // 空配置不备份，避免污染备份链
    const bakDir = join(dir, BAK_DIR);
    mkdirSync(bakDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = join(bakDir, `user-config.${stamp}.json`);
    writeFileSync(dst, text, 'utf-8');
    // 只保留最近 KEEP 份
    const files = readdirSync(bakDir)
      .filter((n) => RE.test(n))
      .map((n) => ({ n, m: statSync(join(bakDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const f of files.slice(KEEP)) {
      try { unlinkSync(join(bakDir, f.n)); } catch { /* ignore */ }
    }
    fileLogger.i(`[config] 已备份当前配置 → ${dst}`);
  } catch (e) {
    fileLogger.w(`[config] 备份失败：${(e as Error).message}`);
  }
}

export function tryRecoverFromBackup(dir: string): boolean {
  const file = join(dir, 'user-config.json');
  if (existsSync(file)) {
    try {
      if (isValidConfig(readFileSync(file, 'utf-8'))) return false; // 当前有内容，不需要恢复
    } catch { /* 解析失败，继续尝试恢复 */ }
  }
  const bakDir = join(dir, BAK_DIR);
  if (!existsSync(bakDir)) return false;
  try {
    const files = readdirSync(bakDir)
      .filter((n) => RE.test(n))
      .map((n) => ({ n, m: statSync(join(bakDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length === 0) return false;
    const latest = join(bakDir, files[0].n);
    copyFileSync(latest, file);
    fileLogger.i(`[config] 已从备份恢复配置：${latest} → ${file}`);
    return true;
  } catch (e) {
    fileLogger.w(`[config] 恢复失败：${(e as Error).message}`);
    return false;
  }
}
