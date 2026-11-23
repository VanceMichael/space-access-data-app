// 交接资料的 CSV 读取：UTF-8、逗号分隔、无引号、无内嵌换行（见 README 数据说明）。
import { readFile } from 'node:fs/promises';

export async function readCsv(path, fields) {
  const content = await readFile(path, 'utf8');
  return parseTable(content, fields, path);
}

export function parseTable(content, fields, table = '交接资料') {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',').map(cell => cell.replace(/\r$/, ''));
  if (header.length !== fields.length || header.some((field, i) => field !== fields[i])) {
    throw new Error(`${table} 的表头与格式约定不一致：期望 ${fields.join(',')}`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, i) => [field, cells[i]]));
  });
}

export function splitList(value) {
  return value === '' || value === '-' ? [] : value.split('|');
}

// 关系值 `-` 表示不适用，空字符串表示未提供。
export const NA = '-';
