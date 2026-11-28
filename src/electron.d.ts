interface ElectronAPI {
  osInfo?: { platform: string; arch: string; systemVersion: string };
  send: (channel: string, data?: any) => void;
  receive: (channel: string, func: (...args: any[]) => void) => void;
  removeListener: (channel: string, func: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
  invoke: (channel: string, data?: any) => Promise<any>;
}

declare interface Window {
  electron: ElectronAPI;
}
