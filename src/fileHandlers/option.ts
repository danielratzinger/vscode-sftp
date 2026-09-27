export interface FileHandleOption {
  ignore?: ((filepath: string) => boolean) | null;
  /**
   * Where a download should land instead of where this connection maps it to.
   *
   * For `Download As`, which is a one-off answer to "I want this, but not
   * there" - a copy to compare against, a file fetched into a scratch folder.
   * It changes nothing about which files are chosen, only where they are put.
   */
  saveAs?: string;
  /**
   * Applied to files only, never to the folders on the way to them, so a
   * folder whose name has a dot in it is not mistaken for a file.
   */
  fileFilter?: ((filepath: string) => boolean) | null;
}
