import { isElectron, isWindows } from '../../utils/environment';

/** Dedicated Bailian workspace mode is supported in the Windows desktop app only in this release. */
export function isBailianWorkspaceAvailable(): boolean {
  return isElectron() && isWindows();
}
