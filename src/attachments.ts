/** A file attachment converted for the model (data URI), independent of where it came from. */
export interface ConvertedFile {
  mime: string;
  filename: string;
  dataUri: string;
  sizeBytes: number;
}
