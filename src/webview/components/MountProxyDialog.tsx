import React from 'react';
import { t } from '../i18n';
import type { Colors } from '../types';
import { FOCUSABLE_SELECTOR, currentFocusIndex, nextFocusIndex } from './focusTrap';

/**
 * 挂载代理部署对话框（specs/051 FR-003 / FR-004）。
 *
 * 唯一的「部署走到哪一步」事实来自宿主的 `mountProxyDeployState`：本组件只渲染，
 * 不自己推断进度、不自己判 ready（FR-005「自检归属唯一」）。
 *
 * 三类人机界面共用一个模态层，由 `phase` 判别：
 * - `confirm`：确认部署（四要素文案，AC-8）；
 * - `needsCredential`：三选一（sudo 密码 / root 密码 / 显示命令自己执行，AC-11）；
 * - `running` / `failed`：进度与失败。
 *
 * `done` 不在本组件渲染：部署成功不打断用户，宿主直接把被拦消息接着发出去（FR-008），
 * 对话框由 `App` 在收到 `done` 时收起。只有失败才留在界面上说明原因。
 *
 * 选择器契约见 [plan.md 的「选择器契约」](../../specs/051-overlay-root-mount-proxy/plan.md#e2e-测试计划)：
 * `data-mount-proxy-dialog` / `data-fact` / `data-mount-proxy-action` /
 * `data-mount-proxy-secret` / `data-mount-proxy-phase` / `data-mount-proxy-command`。
 * E2E 只按这些属性定位，不按文案。
 */

/** 宿主的部署状态（与 wire 消息 `mountProxyDeployState` 同形，去掉本组件不渲染的终态） */
export interface MountProxyDeployState {
  phase: 'confirm' | 'running' | 'needsCredential' | 'failed';
  failure: string | null;
  manualCommand: string | null;
  targetHost: string | null;
  installPath: string;
}

interface MountProxyDialogProps {
  colors: Colors;
  state: MountProxyDeployState;
  /** 用户在确认框点「部署」（FR-003） */
  onDeploy: () => void;
  /** 用户选择一条提权来源（FR-004 三选一） */
  onChooseMethod: (method: 'sudoPassword' | 'rootPassword' | 'manualCommand') => void;
  /** 提交密码（只在这里短暂经过，密码不清进 state） */
  onSubmitSecret: (method: 'sudoPassword' | 'rootPassword', secret: string) => void;
  /** 取消（确认框取消 / Escape / 点遮罩，FR-003） */
  onCancel: () => void;
}

/** 卡片按钮的统一样式（三种按钮共用，避免各写一份漂移） */
function buttonStyle(colors: Colors, kind: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  return {
    padding: '5px 14px',
    fontSize: 12,
    borderRadius: 4,
    cursor: 'pointer',
    border: kind === 'primary' ? 'none' : `1px solid ${colors.border}`,
    backgroundColor:
      kind === 'primary' ? colors.bgTertiary : kind === 'danger' ? colors.timelineStatusFail : 'transparent',
    color: kind === 'primary' || kind === 'danger' ? '#ffffff' : colors.textPrimary,
  };
}

export const MountProxyDialog: React.FC<MountProxyDialogProps> = ({
  colors,
  state,
  onDeploy,
  onChooseMethod,
  onSubmitSecret,
  onCancel,
}) => {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  /**
   * 密码只存在于这个 ref（FR-004 第 3 条：不进 `useState`）。
   *
   * `useState` 的值会进 React DevTools 与渲染树快照；ref 不会。提交后立刻置空。
   */
  const secretRef = React.useRef<HTMLInputElement | null>(null);
  // `null` = 用户还没选密码来源；选了才渲染遮蔽输入（AC-11 的三选一先呈现）
  const [secretMethod, setSecretMethod] = React.useState<'sudoPassword' | 'rootPassword' | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    // 确认框默认焦点在「取消」：这是要提权的不可逆操作，误按 Enter 不该开始装
    if (state.phase === 'confirm') cancelRef.current?.focus();
  }, [state.phase]);

  React.useEffect(() => {
    if (state.phase !== 'needsCredential' || state.manualCommand !== null) return;
    if (secretMethod === null) return;
    // 需要密码时把焦点放到输入框（用户刚选完来源）
    secretRef.current?.focus();
  }, [state.phase, state.manualCommand, secretMethod]);

  /**
   * 模态层的键盘纪律（specs/059 FR-007）：
   * - `Escape` 等价于取消（沿用既有语义，所有态一致）；
   * - `Tab` / `Shift+Tab` 只在框内控件之间循环，不逃到被遮罩的界面（焦点圈定）。
   *
   * 圈定的算术在 `focusTrap.ts` 的纯函数里（可单测），这里只负责读写 DOM 焦点。
   */
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  /**
   * 只读浏览保留（specs/059 FR-007 的 AC-18）：遮罩层不吞滚轮，把它转发到消息区。
   *
   * 模态锁的是**动作**（点击、切换、提交），不是「看上下文」——用户要读上面几轮对话
   * 才能判断这个代理该不该装。转发只在滚轮落在遮罩上时发生（框内滚动由框自己处理），
   * 且只改滚动位置，不改任何状态。
   */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    // 滚轮落在框内（内容溢出时）交给框自己滚
    if (event.target instanceof Element && event.target.closest('[data-mount-proxy-body]')) return;
    const scroller = document.querySelector<HTMLElement>('.messages-container, .messages-container-empty');
    if (!scroller) return;
    scroller.scrollTop += event.deltaY;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const container = containerRef.current;
    if (!container) return;
    // 阻止浏览器默认的 Tab：它会走出框外。循环由纯函数算出的下标决定
    event.preventDefault();
    const next = nextFocusIndex(
      currentFocusIndex(container, document.activeElement),
      container.querySelectorAll(FOCUSABLE_SELECTOR).length,
      event.shiftKey,
    );
    if (next < 0) return;
    const items = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    items[next]?.focus();
  };

  /** 提交密码：直接从 DOM 读值，读完立刻清空输入框 */
  const submitSecret = (): void => {
    if (secretMethod === null) return;
    const value = secretRef.current?.value ?? '';
    if (secretRef.current) secretRef.current.value = '';
    if (value.length === 0) return;
    onSubmitSecret(secretMethod, value);
  };

  const copyCommand = (): void => {
    if (state.manualCommand === null) return;
    void navigator.clipboard.writeText(state.manualCommand).then(() => {
      setCopied(true);
      // 2 秒后恢复按钮文案（不引定时器清理逻辑：单次部署界面，卸载即无意义）
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999]"
      data-mount-proxy-dialog="confirm"
      data-mount-proxy-phase={state.phase}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={onCancel}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      role="dialog"
      aria-modal="true"
      aria-label={t('mountProxyDialog.title')}
    >
      <div
        data-mount-proxy-body=""
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 48px)',
          borderRadius: 8,
          padding: '18px 20px',
          backgroundColor: colors.bgSecondary,
          color: colors.textPrimary,
          border: `1px solid ${colors.border}`,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          {t('mountProxyDialog.title')}
        </div>

        {state.phase === 'confirm' ? (
          <ConfirmBody colors={colors} state={state} />
        ) : null}

        {state.phase === 'needsCredential' || state.phase === 'failed' ? (
          <CredentialBody
            colors={colors}
            state={state}
            secretRef={secretRef}
            secretMethod={secretMethod}
            copied={copied}
            onChooseMethod={onChooseMethod}
            onSelectSecretMethod={setSecretMethod}
            onSubmitSecret={submitSecret}
            onCopyCommand={copyCommand}
          />
        ) : null}

        {state.phase === 'running' ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
            {t('mountProxyDialog.running')}
          </div>
        ) : null}

        {state.phase === 'failed' ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
            <div style={{ color: colors.timelineStatusFail, marginBottom: 8 }}>
              {t('mountProxyDialog.failed', { reason: state.failure ?? '' })}
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {state.phase === 'confirm' ? (
            <>
              <button
                ref={cancelRef}
                type="button"
                data-mount-proxy-action="cancel"
                onClick={onCancel}
                style={buttonStyle(colors, 'secondary')}
              >
                {t('mountProxyDialog.cancel')}
              </button>
              <button
                type="button"
                data-mount-proxy-action="deploy"
                onClick={onDeploy}
                style={buttonStyle(colors, 'primary')}
              >
                {t('mountProxyDialog.deploy')}
              </button>
            </>
          ) : null}

          {state.phase === 'failed' ? (
            <button
              type="button"
              data-mount-proxy-action="deploy"
              onClick={onDeploy}
              style={buttonStyle(colors, 'primary')}
            >
              {t('mountProxyDialog.retry')}
            </button>
          ) : null}

          {state.phase === 'failed' ? (
            <button
              type="button"
              data-mount-proxy-action="cancel"
              onClick={onCancel}
              style={buttonStyle(colors, 'secondary')}
            >
              {t('mountProxyDialog.close')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** 确认态：四要素文案（AC-8） */
const ConfirmBody: React.FC<{ colors: Colors; state: MountProxyDeployState }> = ({ colors, state }) => (
  <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>
    <div data-fact="root-setuid" style={{ marginBottom: 6 }}>
      {t('mountProxyDialog.factRootSetuid')}
    </div>
    <div data-fact="install-path" style={{ marginBottom: 6 }}>
      {t('mountProxyDialog.factInstallPath', { path: state.installPath })}
    </div>
    {state.targetHost !== null ? (
      <div data-fact="target-host" style={{ marginBottom: 6 }}>
        {t('mountProxyDialog.factTargetHost', { host: state.targetHost })}
      </div>
    ) : null}
    <div data-fact="userns" style={{ color: colors.textSystem }}>
      {t('mountProxyDialog.factUserns')}
    </div>
  </div>
);

/** 三选一态（AC-11 / AC-12） */
const CredentialBody: React.FC<{
  colors: Colors;
  state: MountProxyDeployState;
  secretRef: React.MutableRefObject<HTMLInputElement | null>;
  secretMethod: 'sudoPassword' | 'rootPassword' | null;
  copied: boolean;
  onChooseMethod: (method: 'sudoPassword' | 'rootPassword' | 'manualCommand') => void;
  onSelectSecretMethod: (method: 'sudoPassword' | 'rootPassword') => void;
  onSubmitSecret: () => void;
  onCopyCommand: () => void;
}> = ({
  colors,
  state,
  secretRef,
  secretMethod,
  copied,
  onChooseMethod,
  onSelectSecretMethod,
  onSubmitSecret,
  onCopyCommand,
}) => (
  <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>
    {/* 失败态的原因由外层统一渲染（`mountProxyDialog.failed`），这里只写三选一的引导，
        且只在「免密不可用」时出现——失败后仍给同一组来源，换一条来源就能继续重试。 */}
    {state.phase === 'needsCredential' ? (
      <div style={{ marginBottom: 10 }}>{t('mountProxyDialog.needCredential')}</div>
    ) : null}

    {state.manualCommand !== null ? (
      // 零密码通道（AC-12）：完整命令 + 复制按钮，没有密码框经过宿主
      <>
        <div style={{ marginBottom: 6 }}>{t('mountProxyDialog.manualHint')}</div>
        <pre
          data-mount-proxy-command
          style={{
            margin: '0 0 10px',
            padding: '8px 10px',
            fontSize: 11,
            borderRadius: 4,
            backgroundColor: colors.bg,
            border: `1px solid ${colors.border}`,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {state.manualCommand}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCopyCommand} style={buttonStyle(colors, 'secondary')}>
            {copied ? t('mountProxyDialog.copied') : t('mountProxyDialog.copyCommand')}
          </button>
          <button
            type="button"
            data-mount-proxy-action="sudo-password"
            onClick={() => onChooseMethod('sudoPassword')}
            style={buttonStyle(colors, 'secondary')}
          >
            {t('mountProxyDialog.useSudoPassword')}
          </button>
        </div>
      </>
    ) : (
      <>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-mount-proxy-action="sudo-password"
            onClick={() => {
              onSelectSecretMethod('sudoPassword');
              onChooseMethod('sudoPassword');
            }}
            style={buttonStyle(colors, secretMethod === 'sudoPassword' ? 'primary' : 'secondary')}
          >
            {t('mountProxyDialog.useSudoPassword')}
          </button>
          <button
            type="button"
            data-mount-proxy-action="root-password"
            onClick={() => {
              onSelectSecretMethod('rootPassword');
              onChooseMethod('rootPassword');
            }}
            style={buttonStyle(colors, secretMethod === 'rootPassword' ? 'primary' : 'secondary')}
          >
            {t('mountProxyDialog.useRootPassword')}
          </button>
          <button
            type="button"
            data-mount-proxy-action="manual-command"
            onClick={() => onChooseMethod('manualCommand')}
            style={buttonStyle(colors, 'secondary')}
          >
            {t('mountProxyDialog.showCommand')}
          </button>
        </div>

        {/*
          遮蔽输入（AC-13）：`type=password` 且值不经 React state——只从 DOM 读一次后
          立刻清空，避免进渲染树 / DevTools 快照。只在用户**选了某个密码来源之后**渲染：
          三选一先呈现，选完才给输入框（AC-11）。
        */}
        {secretMethod === null ? null : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={secretRef}
            type="password"
            data-mount-proxy-secret
            aria-label={secretMethod === 'sudoPassword' ? t('mountProxyDialog.useSudoPassword') : t('mountProxyDialog.useRootPassword')}
            placeholder={
              secretMethod === 'sudoPassword'
                ? t('mountProxyDialog.sudoPasswordPlaceholder')
                : t('mountProxyDialog.rootPasswordPlaceholder')
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitSecret();
              }
            }}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              borderRadius: 4,
              backgroundColor: colors.bg,
              color: colors.textPrimary,
              border: `1px solid ${colors.border}`,
            }}
          />
          <button type="button" onClick={onSubmitSecret} style={buttonStyle(colors, 'primary')}>
            {t('mountProxyDialog.submitSecret')}
          </button>
        </div>
        )}
      </>
    )}
  </div>
);
