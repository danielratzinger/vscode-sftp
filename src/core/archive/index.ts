/**
 * How many files make an archive worth asking for.
 *
 * Below this the round trips it saves are not worth the two commands it costs.
 * It can only be applied where the number is known before anything moves,
 * which is an upload: the folder is on this machine and walking it costs
 * nothing. A download has no listing to count - that the server does the
 * recursion is the whole saving - so a folder download always asks, and a small
 * folder pays a few hundred milliseconds for it.
 */
export const ARCHIVE_FILE_THRESHOLD = 50;

export { default as ArchiveDownloadTask } from './archiveDownloadTask';
export { default as ArchiveUploadTask } from './archiveUploadTask';
export { LocalTree, walkLocal } from './localTree';
export { canExec, serverTar } from './serverTar';
