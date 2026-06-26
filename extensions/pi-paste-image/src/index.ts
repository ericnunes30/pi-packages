/**
 * pi-paste-image — Paste images from clipboard into Pi conversations.
 *
 * Registers /pasteimage command that reads clipboard image data,
 * resizes it to fit within provider limits, and sends as a user message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { hasImage, getImageBinary } from "@mariozechner/clipboard";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pasteimage", {
    description: "Paste image from clipboard and send as user message",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Clipboard paste only works in interactive TUI mode", "warning");
        return;
      }

      if (!hasImage()) {
        ctx.ui.notify("No image found in clipboard", "warning");
        return;
      }

      try {
        const imageData = await getImageBinary();
        if (!imageData || imageData.length === 0) {
          ctx.ui.notify("Failed to read image from clipboard", "error");
          return;
        }

        const bytes = imageData instanceof Uint8Array
          ? imageData
          : Uint8Array.from(imageData);

        const resized = await resizeImage(bytes, "image/png");
        if (!resized) {
          ctx.ui.notify("Failed to resize image for sending", "error");
          return;
        }

        ctx.ui.notify(`Image: ${resized.mimeType}, base64 length: ${resized.data.length}`, "info");

        const content = [
          {
            type: "image" as const,
            data: resized.data,
            mimeType: resized.mimeType,
          },
        ];

        if (args.trim()) {
          content.unshift({
            type: "text" as const,
            text: args.trim(),
          });
        }

        pi.sendUserMessage(content);
      } catch (err: any) {
        ctx.ui.notify(`Clipboard error: ${err.message ?? err}`, "error");
      }
    },
  });
}
