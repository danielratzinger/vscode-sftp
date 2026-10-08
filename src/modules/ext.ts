import { getUserSetting } from '../host';
import { EXTENSION_NAME } from '../constants';

export function getExtensionSetting() {
  return getUserSetting(EXTENSION_NAME);
}

/** Whether `sftp.debug` (or its old name, `printDebugLog`) is on. Read per call. */
export function wantsDebug(): boolean {
  try {
    const setting = getExtensionSetting();
    return Boolean(setting.debug || setting.printDebugLog);
  } catch (error) {
    return false;
  }
}
