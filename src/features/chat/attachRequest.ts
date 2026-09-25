/**
 * A one-shot request to stage a gallery image in the chat composer, raised by
 * the full image view ("Chat with this image", docs/17 row 17).
 *
 * WHY it has to travel through a value: the lightbox lives in `GenerateArea`
 * and the composer in `ChatArea`, and the tab that decides which of them is
 * mounted lives in `App`. `App` therefore owns the request; the gallery fills
 * it in, `ChatArea` consumes it.
 *
 * `nonce` is monotonic per click, so choosing the SAME image twice in a row is
 * still a NEW request, and the consumer CLEARS the request once it has staged
 * it — a consumed request can never attach later by surprise (for example when
 * the Chat tab is re-entered and `ChatArea` remounts with the same value).
 */
export interface ChatAttachRequest {
  imageId: string;
  nonce: number;
}
