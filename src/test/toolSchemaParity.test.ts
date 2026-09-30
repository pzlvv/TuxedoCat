/**
 * 工具定义对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/toolSchemaParity.json`：
 * - 本文件断言「对照表 == `toolToLlmFormat` 的真实输出」（防对照表腐化）；
 * - `core-rs/src/tools_tests.rs` 的 `schema_parity_tests` 断言
 *   「`definitions()` == 对照表」（`divergences` 列出的已知缺口豁免）。
 *
 * 任一侧偏离对照表都会失败，从而保证「同一份 system prompt + 同一份 tools」
 * 在两套实现里对 LLM 呈现同一个契约。
 *
 * 运行方式：npm run test:all -- tool-schema-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAllTools } from '../core/tools/index';
import { convertToolsToLlmFormat } from '../core/tools/toolSchema';
import type { Tool } from '../core/tools/Tool';
import { createChecker, runTests } from './helpers/harness';

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/toolSchemaParity.json');

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
}

interface FixtureTool {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, SchemaProperty>;
}

interface Fixture {
  tools: FixtureTool[];
  divergences: Array<{ tool: string; property: string; reason: string }>;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;
  check('对照表非空', fixture.tools.length > 0);
  check('已知缺口已登记', fixture.divergences.length > 0);

  const converted = await convertToolsToLlmFormat(getAllTools() as Tool[]);
  const byName = new Map(converted.map((tool) => [tool.name, tool]));

  for (const expected of fixture.tools) {
    const actual = byName.get(expected.name);
    check(`${expected.name}: 工具存在`, !!actual);
    if (!actual) continue;

    check(`${expected.name}: description 一致`, actual.description === expected.description);
    check(
      `${expected.name}: required 一致`,
      JSON.stringify(actual.input_schema.required) === JSON.stringify(expected.required),
    );

    const actualProperties = actual.input_schema.properties as Record<string, SchemaProperty>;
    for (const [key, property] of Object.entries(expected.properties)) {
      const actualProperty = actualProperties[key];
      check(`${expected.name}.${key}: 参数存在`, !!actualProperty);
      if (!actualProperty) continue;
      check(
        `${expected.name}.${key}: type 一致`,
        actualProperty.type === property.type,
      );
      check(
        `${expected.name}.${key}: description 一致`,
        actualProperty.description === property.description,
      );
      if (property.enum) {
        check(
          `${expected.name}.${key}: enum 一致`,
          JSON.stringify(actualProperty.enum) === JSON.stringify(property.enum),
        );
      }
    }

    // 对照表里没有的参数：必须登记在 divergences 里（未迁入的参数）
    const registered = new Set(
      fixture.divergences
        .filter((item) => item.tool === expected.name)
        .map((item) => item.property),
    );
    for (const key of Object.keys(actualProperties)) {
      check(
        `${expected.name}.${key}: 未登记的多余参数`,
        Object.prototype.hasOwnProperty.call(expected.properties, key) || registered.has(key),
      );
    }
  }

  finish();
}

runTests('tool-schema-parity', run);
