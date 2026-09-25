/** Pixel size of an encoded image, decoded by the browser. A decode failure
 * THROWS — a stored image never carries placeholder dimensions (rule 1). */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
