let imagemagickCommand: string | null | undefined;

/**
 * Detect available ImageMagick command.
 * Returns "magick" (IM7) or "convert" (IM6) or null if unavailable.
 */
async function detectImageMagick(): Promise<string | null> {
   if (imagemagickCommand !== undefined) {
      return imagemagickCommand;
   }

   for (const cmd of ["magick", "convert"]) {
      try {
         const proc = Bun.spawn([cmd, "-version"], { stdout: "ignore", stderr: "ignore" });
         const code = await proc.exited;
         if (code === 0) {
            imagemagickCommand = cmd;
            return cmd;
         }
      } catch {
         continue;
      }
   }

   imagemagickCommand = null;
   return null;
}

/**
 * Run ImageMagick command with buffer input/output.
 */
async function runImageMagick(cmd: string, args: string[], input: Buffer): Promise<Buffer> {
   const proc = Bun.spawn([cmd, ...args], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
   });

   const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
   ]);

   if (exitCode !== 0) {
      throw new Error(`ImageMagick exited with code ${exitCode}: ${stderr}`);
   }

   return Buffer.from(stdout);
}

/**
 * Convert image to PNG using ImageMagick.
 * Returns null if ImageMagick is unavailable or conversion fails.
 */
export async function convertToPngWithImageMagick(
   base64Data: string,
   _mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
   const cmd = await detectImageMagick();
   if (!cmd) {
      return null;
   }

   try {
      const input = Buffer.from(base64Data, "base64");
      // "-" reads from stdin, "png:-" writes PNG to stdout
      const output = await runImageMagick(cmd, ["-", "png:-"], input);
      return {
         data: output.toString("base64"),
         mimeType: "image/png",
      };
   } catch {
      return null;
   }
}

export interface ImageMagickResizeResult {
   data: string; // base64
   mimeType: string;
   width: number;
   height: number;
}

/**
 * Get image dimensions using ImageMagick identify.
 */
async function getImageDimensions(
   cmd: string,
   buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
   try {
      // Use identify to get dimensions
      const identifyCmd = cmd === "magick" ? "magick" : "identify";
      const args = cmd === "magick" ? ["identify", "-format", "%w %h", "-"] : ["-format", "%w %h", "-"];

      const output = await runImageMagick(identifyCmd, args, buffer);
      const [w, h] = output.toString().trim().split(" ").map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) {
         return { width: w, height: h };
      }
   } catch {
      // Fall through
   }
   return null;
}

/**
 * Resize image using ImageMagick.
 * Returns null if ImageMagick is unavailable or operation fails.
 */
export async function resizeWithImageMagick(
   base64Data: string,
   _mimeType: string,
   maxWidth: number,
   maxHeight: number,
   maxBytes: number,
   jpegQuality: number,
): Promise<ImageMagickResizeResult | null> {
   const cmd = await detectImageMagick();
   if (!cmd) {
      return null;
   }

   try {
      const input = Buffer.from(base64Data, "base64");

      // Get original dimensions
      const dims = await getImageDimensions(cmd, input);
      if (!dims) {
         return null;
      }

      // Check if already within limits
      if (dims.width <= maxWidth && dims.height <= maxHeight && input.length <= maxBytes) {
         return null; // Signal caller to use original
      }

      // Calculate target dimensions maintaining aspect ratio
      let targetWidth = dims.width;
      let targetHeight = dims.height;

      if (targetWidth > maxWidth) {
         targetHeight = Math.round((targetHeight * maxWidth) / targetWidth);
         targetWidth = maxWidth;
      }
      if (targetHeight > maxHeight) {
         targetWidth = Math.round((targetWidth * maxHeight) / targetHeight);
         targetHeight = maxHeight;
      }

      // Try PNG first, then JPEG with decreasing quality
      const attempts: Array<{ args: string[]; mimeType: string }> = [
         { args: ["-", "-resize", `${targetWidth}x${targetHeight}>`, "png:-"], mimeType: "image/png" },
         {
            args: ["-", "-resize", `${targetWidth}x${targetHeight}>`, "-quality", String(jpegQuality), "jpeg:-"],
            mimeType: "image/jpeg",
         },
      ];

      // Add lower quality JPEG attempts
      for (const q of [70, 55, 40]) {
         attempts.push({
            args: ["-", "-resize", `${targetWidth}x${targetHeight}>`, "-quality", String(q), "jpeg:-"],
            mimeType: "image/jpeg",
         });
      }

      let best: { buffer: Buffer; mimeType: string } | null = null;

      for (const attempt of attempts) {
         try {
            const output = await runImageMagick(cmd, attempt.args, input);
            if (output.length <= maxBytes) {
               return {
                  data: output.toString("base64"),
                  mimeType: attempt.mimeType,
                  width: targetWidth,
                  height: targetHeight,
               };
            }
            if (!best || output.length < best.buffer.length) {
               best = { buffer: output, mimeType: attempt.mimeType };
            }
         } catch {
            continue;
         }
      }

      // Try progressively smaller dimensions
      const scaleSteps = [0.75, 0.5, 0.35, 0.25];
      for (const scale of scaleSteps) {
         const scaledWidth = Math.round(targetWidth * scale);
         const scaledHeight = Math.round(targetHeight * scale);

         if (scaledWidth < 100 || scaledHeight < 100) break;

         for (const q of [85, 70, 55, 40]) {
            try {
               const output = await runImageMagick(
                  cmd,
                  ["-", "-resize", `${scaledWidth}x${scaledHeight}>`, "-quality", String(q), "jpeg:-"],
                  input,
               );
               if (output.length <= maxBytes) {
                  return {
                     data: output.toString("base64"),
                     mimeType: "image/jpeg",
                     width: scaledWidth,
                     height: scaledHeight,
                  };
               }
               if (!best || output.length < best.buffer.length) {
                  best = { buffer: output, mimeType: "image/jpeg" };
               }
            } catch {
               continue;
            }
         }
      }

      // Return best attempt even if over limit
      if (best) {
         return {
            data: best.buffer.toString("base64"),
            mimeType: best.mimeType,
            width: targetWidth,
            height: targetHeight,
         };
      }

      return null;
   } catch {
      return null;
   }
}

/**
 * Get image dimensions using ImageMagick.
 * Returns null if ImageMagick is unavailable.
 */
export async function getImageDimensionsWithImageMagick(
   base64Data: string,
): Promise<{ width: number; height: number } | null> {
   const cmd = await detectImageMagick();
   if (!cmd) {
      return null;
   }

   try {
      const buffer = Buffer.from(base64Data, "base64");
      return await getImageDimensions(cmd, buffer);
   } catch {
      return null;
   }
}
