import * as output from '../ui/output';
import logger from '../logger';
import { showErrorMessage } from '../host';
import { forLog } from '../core/explainedError';
import { wantsDebug } from '../modules/ext';

export function reportError(err: Error | string, ctx?: string) {
  let errorString: string;
  if (err instanceof Error) {
    errorString = err.message;
    logger.error(forLog(err, wantsDebug()), ctx);
  } else {
    errorString = err;
    logger.error(errorString, ctx);
  }

  showErrorMessage(errorString, 'Detail').then(result => {
    if (result === 'Detail') {
      output.show();
    }
  });
  return;
}
