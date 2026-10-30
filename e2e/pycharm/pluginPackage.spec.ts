import { test, expect } from '@playwright/test';
import AdmZip from 'adm-zip';
import path from 'node:path';
import { CORE_BINARY_NAME, EXTENSION_NAME, PRODUCT_NAME } from '../../src/config/project';
import packageJson from '../../package.json';

/**
 * 插件分发 zip 的结构核验（US-68 / FR-007 / FR-008 / FR-010）：
 * 前置产物由 e2e/playwright.config.ts 的 assertArtifact 把关（缺失报构建命令），
 * 本文件只做解压后的内容断言——无 IDE 依赖，是 pycharm-plugin 车道的第一层。
 */
const pkgVersion = packageJson.version as string;
const zipPath = path.join(__dirname, '..', '..', 'release', 'pycharm', `${EXTENSION_NAME}-pycharm-${pkgVersion}.zip`);
const zip = new AdmZip(zipPath);
const entries = zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'));

test.describe('FR-008 自包含分发 zip 结构', () => {
  test('FR-008 插件 jar 与 webview 静态资源在位', () => {
    expect(entries.some((e) => /^pycharm-plugin\/lib\/pycharm-plugin-.*\.jar$/.test(e))).toBe(true);
    expect(entries).toContain('pycharm-plugin/webview/index.html');
    expect(entries.some((e) => /^pycharm-plugin\/webview\/assets\/.*\.js$/.test(e))).toBe(true);
    // KaTeX 字体等 vite 带出的静态资源随渲染实现一起内置
    expect(entries.some((e) => /\.woff2?$/.test(e))).toBe(true);
  });

  test('FR-008 四平台 Core 产物（二进制 + fingerprint + ripgrep）齐全', () => {
    const platforms = ['x64-win32', 'arm64-win32', 'x64-linux', 'arm64-linux'];
    for (const platform of platforms) {
      const prefix = `pycharm-plugin/core/${platform}`;
      expect(entries.some((e) => e.startsWith(`${prefix}/${CORE_BINARY_NAME}`))).toBe(true);
      expect(entries).toContain(`${prefix}/fingerprint`);
      expect(entries.some((e) => e.startsWith(`${prefix}/ripgrep/rg`))).toBe(true);
    }
  });

  test('FR-010 plugin.xml 身份由 src/config/project.json 派生', () => {
    const pluginXmlEntry = zip.getEntry('pycharm-plugin/lib/pycharm-plugin-0.0.1.jar');
    expect(pluginXmlEntry).toBeTruthy();
    // plugin.xml 在 jar 内：解出再读
    const jar = new AdmZip(pluginXmlEntry!.getData());
    const xml = jar.readAsText('META-INF/plugin.xml');
    // id / name 由 project.json 派生（extensionName + .pycharm / productName）
    expect(xml).toContain(`<id>${EXTENSION_NAME}.pycharm</id>`);
    expect(xml).toContain(`<name>${PRODUCT_NAME}</name>`);
    expect(xml).toContain('<depends>com.intellij.modules.jcef</depends>');
    // 令牌未被展开的残留（构建期展开失败 = 残包）
    expect(xml).not.toContain('${');
  });

  test('FR-007 插件图标与工具窗口图标在位（jar 内，源出 assets）', () => {
    const jar = new AdmZip(zip.getEntry('pycharm-plugin/lib/pycharm-plugin-0.0.1.jar')!.getData());
    const jarEntries = jar.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'));
    expect(jarEntries.some((e) => e.endsWith('META-INF/pluginIcon.svg'))).toBe(true);
    expect(jarEntries.some((e) => e.endsWith('icons/toolWindow.svg'))).toBe(true);
  });

  test('FR-008 zip 内无外部运行时依赖引用', () => {
    // 插件 lib 里只有自身 jar 与自带的 kotlin/serialization 运行时，不引用 Node/Python
    const libEntries = entries.filter((e) => e.startsWith('pycharm-plugin/lib/'));
    for (const entry of libEntries) {
      expect(entry).not.toMatch(/node|python/i);
    }
    // webview 的 index.html 引用的资源全部是相对路径（scheme 内解析，无 file:// / http 依赖）
    const indexEntry = zip.getEntry('pycharm-plugin/webview/index.html');
    const html = indexEntry!.getData().toString('utf8');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});
