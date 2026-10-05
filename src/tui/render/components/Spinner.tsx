/**
 * 简易转圈指示（ink 5 不内置 Spinner，ink-spinner 未引入——避免为一个字符动画加依赖）。
 * braille 帧序列 80ms 轮转；卸载时清理计时器。
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

export function Spinner(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return <Text color="cyan">{FRAMES[frame]}</Text>;
}
