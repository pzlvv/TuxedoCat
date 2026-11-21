import { formatElapsedTime, type ElapsedTimeLabels } from '../webview/elapsedTime';
import { createChecker, runTests } from './helpers/harness';

/**
 * abort 悬停明细的已执行时长格式化（specs/054 FR-005）。
 *
 * 锁定口径：从「天」到「秒」逐级拼接、零单位连同单位一起省略、全部为零显示「0秒」、
 * 负值与非法值钳 0、只看整秒。单位文案由调用方注入（组件从 i18n 取），因此本测试
 * 用中文单位验证拼接规则，另用英文单位确认没有写死字面量。
 *
 * 运行方式：npm run test:unit -- elapsedTime
 */

const zh: ElapsedTimeLabels = { day: '天', hour: '小时', minute: '分', second: '秒' };
const en: ElapsedTimeLabels = { day: 'd', hour: 'h', minute: 'm', second: 's' };

const seconds = (value: number): number => value * 1000;

runTests('elapsedTime', () => {
  const { check, finish } = createChecker();

  check('不满 1 分钟只显示秒数',
    formatElapsedTime(seconds(5), zh) === '5秒'
    && formatElapsedTime(seconds(45), zh) === '45秒');

  check('不满 1 小时显示分与秒（零秒省略、分钟不补零）',
    formatElapsedTime(seconds(65), zh) === '1分5秒'
    && formatElapsedTime(seconds(600), zh) === '10分'
    && formatElapsedTime(seconds(61), zh) === '1分1秒');

  check('不满 1 天显示小时 / 分 / 秒',
    formatElapsedTime(seconds(3725), zh) === '1小时2分5秒'
    && formatElapsedTime(seconds(3600), zh) === '1小时'
    && formatElapsedTime(seconds(3660), zh) === '1小时1分');

  check('1 天以上显示天 / 小时 / 分 / 秒（零单位省略）',
    formatElapsedTime(seconds(93784), zh) === '1天2小时3分4秒'
    && formatElapsedTime(seconds(86400), zh) === '1天'
    && formatElapsedTime(seconds(86400 + 3600), zh) === '1天1小时'
    && formatElapsedTime(seconds(86400 * 2 + 60), zh) === '2天1分');

  check('全部为零显示 0秒（0 本身不省略）',
    formatElapsedTime(0, zh) === '0秒'
    && formatElapsedTime(999, zh) === '0秒');

  check('负值（时钟偏差）钳到 0，不出现负号',
    formatElapsedTime(-5000, zh) === '0秒'
    && formatElapsedTime(-86400_000, zh) === '0秒');

  check('非法值按 0 处理，不抛错',
    formatElapsedTime(Number.NaN, zh) === '0秒'
    && formatElapsedTime(Number.POSITIVE_INFINITY, zh) === '0秒');

  check('只看整秒（毫秒向下取整）',
    formatElapsedTime(seconds(5) + 999, zh) === '5秒'
    && formatElapsedTime(seconds(59) + 999, zh) === '59秒');

  check('单位文案由调用方注入（没有写死中文字面量）',
    formatElapsedTime(seconds(93784), en) === '1d2h3m4s'
    && formatElapsedTime(seconds(65), en) === '1m5s'
    && formatElapsedTime(0, en) === '0s');

  finish();
});
