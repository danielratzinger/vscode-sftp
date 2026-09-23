import * as path from 'path';
import { FileService } from '../core';

/**
 * Copies of a server's file opened from the temp directory, and where each
 * one came from.
 *
 * No connection covers the temp directory, so nothing else could say where a
 * save of one belongs. Plain data, for as long as the document is open:
 * nothing here is worth remembering across a reload.
 */

export interface RemoteCopy {
  service: FileService;
  remotePath: string;
}

const copies = new Map<string, RemoteCopy>();

function key(file: string): string {
  return path.resolve(file);
}

export function trackRemoteCopy(file: string, copy: RemoteCopy): void {
  copies.set(key(file), copy);
}

export function remoteCopyAt(file: string): RemoteCopy | undefined {
  return copies.get(key(file));
}

/** The document was closed. */
export function forgetRemoteCopy(file: string): void {
  copies.delete(key(file));
}
