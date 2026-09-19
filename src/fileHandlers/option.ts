export interface FileHandleOption {
  ignore?: ((filepath: string) => boolean) | null;
  /**
   * Applied to files only, never to the folders on the way to them, so a
   * folder whose name has a dot in it is not mistaken for a file.
   */
  fileFilter?: ((filepath: string) => boolean) | null;
}
