/**
 * 测试专用的 daemon 控制通道建链器（`docs/core-daemon.md` 第 12 节）。
 *
 * 生产代码里 Host 只有一条建链路径（SSH，`sshTransport.ts`）。单测要在一个进程里跑
 * 真实 socket 与真实帧编解码，因此需要一个直连假 daemon 的建链器——它只存在于测试
 * 目录，不进任何产物。
 */

import { connect } from 'net';
import type { CoreDaemonLink, CoreDaemonLinkOpener } from '../../host/standalone/CoreDaemon.js';

/** TCP 直连参数 */
export interface TcpDaemonTransport {
  host: string;
  port: number;
}

/** TCP 直连建链器：socket 连上即就绪 */
export function tcpDaemonOpener(transport: TcpDaemonTransport): CoreDaemonLinkOpener {
  return {
    open: () => openTcpLink(transport),
    dispose: () => undefined,
  };
}

/** 建一条 TCP 控制通道链路；`connect` 之前失败即 reject */
function openTcpLink(transport: TcpDaemonTransport): Promise<CoreDaemonLink> {
  return new Promise<CoreDaemonLink>((resolve, reject) => {
    const socket = connect({ host: transport.host, port: transport.port });
    socket.setEncoding('utf8');
    let connected = false;
    const link: CoreDaemonLink = {
      write: (line) => socket.write(line),
      onceDrain: (listener) => {
        socket.once('drain', listener);
      },
      end: () => {
        socket.end();
      },
      kill: () => {
        socket.destroy();
      },
      onData: (listener) => {
        socket.on('data', (chunk: string | Buffer) => {
          listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        });
      },
      onClose: (listener) => {
        socket.on('close', listener);
      },
    };
    socket.once('connect', () => {
      connected = true;
      resolve(link);
    });
    socket.once('error', (error: Error) => {
      // 连接失败：等待者不能永远挂着（连上之后的错误由 `close` 收尾）
      if (!connected) reject(error);
    });
  });
}
