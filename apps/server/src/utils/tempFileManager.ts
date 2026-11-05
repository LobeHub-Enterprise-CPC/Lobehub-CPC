import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * Utility class for safely storing temporary files. Callers clean up in `finally`.
 *
 * It installs no process hooks: an exiting SIGTERM listener would cut short the
 * tenant lease's drain (the pod dies at once and Hatchet re-runs the tasks it
 * held), and an exiting `uncaughtException` listener turns any later stray
 * error into a crash. Files a killed process leaves behind go with the container.
 */
export class TempFileManager {
  private readonly tempDir: string;
  private filePaths: Set<string> = new Set();

  constructor(dirname: string) {
    // Create unique temporary directory (cross-platform safe)
    this.tempDir = mkdtempSync(join(tmpdir(), dirname));
  }

  /**
   * Write Uint8Array data to a temporary file

   */
  async writeTempFile(data: Uint8Array, name: string): Promise<string> {
    // Sanitize filename to prevent path traversal (GHSA-2g9j-v25c-4j97)
    const safeName = basename(name);
    const filePath = resolve(this.tempDir, safeName);

    try {
      writeFileSync(filePath, data);
      this.filePaths.add(filePath);
      return filePath;
    } catch (error) {
      this.cleanup(); // Immediately cleanup on write failure
      throw new Error(`Failed to write temp file: ${(error as Error).message}`, { cause: error });
    }
  }

  /**
   * Safely cleanup temporary resources
   */
  cleanup(): void {
    if (existsSync(this.tempDir)) {
      // Recursively delete directory and its contents
      rmSync(this.tempDir, { force: true, recursive: true });
      this.filePaths.clear();
    }
  }
}
